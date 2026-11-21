import { spawn, type ChildProcess, type SpawnOptions as NodeSpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { atomicJson, readJson } from "./files.js";

export type TunnelProcessState = "stopped" | "running" | "failed";
export type TunnelErrorCode = "invalid_state" | "invalid_token" | "missing" | "version" | "launch" | "exited" | "previous";

export interface CloudflareTunnelStatus {
  enabled: boolean;
  configured: boolean;
  process: TunnelProcessState;
  binaryAvailable: boolean;
  /** Another `cloudflared` runs on this machine (it is never touched). */
  otherConnectorDetected: boolean;
  lastError?: string;
  lastErrorCode?: TunnelErrorCode;
  hostname?: string;
}

export interface CloudflareTunnelConfiguration {
  token: string;
  hostname?: string;
}

type SpawnFunction = (command: string, args: readonly string[], options: NodeSpawnOptions) => ChildProcess;
type OtherConnectorDetector = (dedicatedPid?: number) => Promise<number[] | boolean>;

export interface CloudflareTunnelManagerOptions {
  root: string;
  /** Tests and controlled installations may supply a resolved command. No shell is used. */
  findBinary?: () => Promise<string | undefined> | string | undefined;
  spawn?: SpawnFunction;
  detectOtherConnectors?: OtherConnectorDetector;
}

interface PersistedTunnelState {
  version: 1;
  enabled: boolean;
  hostname?: string;
  pid?: number;
}

interface RunningChild {
  child: ChildProcess;
  pid: number | undefined;
  stopping: boolean;
}

const STATE_FILE = "cloudflare-tunnel.json";
const TOKEN_FILE = "cloudflare-tunnel-token";
/** First version supporting `--token-file`. */
const MIN_VERSION: readonly [number, number, number] = [2025, 4, 0];
const MAX_TOKEN_CHARS = 4096;
const MAX_CAPTURE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
export const TUNNEL_ERRORS: Record<TunnelErrorCode, string> = {
  invalid_state: "The saved Cloudflare connector settings are not valid. No connector was started.",
  invalid_token: "The Cloudflare tunnel token is missing, not valid or not private. No connector was started.",
  missing: "cloudflared is not installed or not in PATH. Install it and restart the connector.",
  version: "cloudflared is too old: version 2025.4.0 or newer is required.",
  launch: "The dedicated Cloudflare connector did not start. Check the local installation and try again.",
  exited: "The dedicated Cloudflare connector stopped. Narrarium does not restart it automatically: use Restart.",
  previous: "A dedicated connector from a previous Narrarium start is still running. Stop that process first; no duplicate was started.",
};
const FORWARDED_NETWORK_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;

export function validTunnelHostname(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password && !url.hash && !url.search;
  } catch {
    return false;
  }
}

function parseStoredState(value: unknown): PersistedTunnelState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => ["version", "enabled", "hostname", "pid"].includes(key))) throw new Error("invalid");
  if (record.version !== 1 || typeof record.enabled !== "boolean") throw new Error("invalid");
  if (record.hostname !== undefined && !validTunnelHostname(record.hostname)) throw new Error("invalid");
  if (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0)) throw new Error("invalid");
  return {
    version: 1,
    enabled: record.enabled,
    ...(record.hostname !== undefined ? { hostname: record.hostname as string } : {}),
    ...(record.pid !== undefined ? { pid: record.pid as number } : {}),
  };
}

function compareVersion(actual: readonly [number, number, number], minimum: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = actual[index] - minimum[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function parseCloudflaredVersion(text: string): readonly [number, number, number] | undefined {
  const match = /(?:^|\s)cloudflared version\s+(\d+)\.(\d+)\.(\d+)(?:\s|$)/i.exec(text);
  if (!match) return undefined;
  const parsed = match.slice(1).map(Number) as [number, number, number];
  return parsed.every(Number.isSafeInteger) ? parsed : undefined;
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM/EACCES: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** cloudflared runs with an environment rebuilt from scratch and its own private home. */
export function buildCloudflaredEnvironment(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  const inherited = process.platform === "win32" ? ["PATH", "SystemRoot", "PATHEXT", "TEMP", "TMP", "ComSpec"] : ["PATH"];
  for (const name of inherited) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of FORWARDED_NETWORK_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const noProxy = [process.env.NO_PROXY, process.env.no_proxy].filter(Boolean).flatMap((value) => value!.split(",")).map((value) => value.trim()).filter(Boolean);
  for (const value of ["127.0.0.1", "localhost"]) if (!noProxy.includes(value)) noProxy.push(value);
  const home = path.join(root, "private", "cloudflared-home");
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: home,
    ...(process.platform === "win32" ? { USERPROFILE: home } : {}),
    NO_PROXY: noProxy.join(","),
    no_proxy: noProxy.join(","),
    LC_ALL: "C",
    LANG: "C",
  });
  return env;
}

async function captureProcess(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  let child: ChildProcess;
  try {
    child = spawn(command, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
  return new Promise((resolve) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(text);
    };
    child.once("error", () => finish(""));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (bytes >= MAX_CAPTURE_BYTES) return;
      const part = chunk.subarray(0, MAX_CAPTURE_BYTES - bytes);
      bytes += part.length;
      chunks.push(part);
    });
    child.stderr?.resume();
    child.once("close", () => finish(Buffer.concat(chunks).toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("");
    }, timeoutMs);
  });
}

async function detectSystemCloudflaredPids(): Promise<number[]> {
  if (process.platform === "linux") {
    const pids: number[] = [];
    let entries: string[] = [];
    try {
      entries = await fs.readdir("/proc");
    } catch {
      return pids;
    }
    await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
      const pid = Number(entry);
      if (pid === process.pid || !Number.isSafeInteger(pid)) return;
      try {
        const command = (await fs.readFile(path.join("/proc", entry, "comm"), "utf8")).trim().toLowerCase();
        if (command === "cloudflared") pids.push(pid);
      } catch {
        // The process may exit while /proc is scanned.
      }
    }));
    return pids.sort((a, b) => a - b);
  }
  if (process.platform === "win32") {
    const output = await captureProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name = 'cloudflared.exe'\" | Select-Object -ExpandProperty ProcessId"], 5000);
    return [...new Set(output.split(/\s+/).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  }
  const output = await captureProcess("ps", ["-axo", "pid=,comm=,args="], 5000);
  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s+(.+)$/.exec(line);
    if (!match || Number(match[1]) === process.pid) continue;
    const command = path.basename(match[2].trim()).toLowerCase();
    const firstArgument = match[3].trim().split(/\s+/)[0] ?? "";
    if (command === "cloudflared" || path.basename(firstArgument).toLowerCase() === "cloudflared") pids.push(Number(match[1]));
  }
  return pids;
}

/**
 * Manages one `cloudflared tunnel run --token-file` child started by this server (a remotely-managed
 * Cloudflare tunnel). It never installs a service and never touches another connector.
 */
export class CloudflareTunnelManager {
  private readonly root: string;
  private readonly privateDir: string;
  private readonly statePath: string;
  private readonly tokenPath: string;
  private readonly findBinary: () => Promise<string | undefined> | string | undefined;
  private readonly spawn: SpawnFunction;
  private readonly detectOtherConnectors: OtherConnectorDetector;
  private persisted: PersistedTunnelState | undefined;
  private child: RunningChild | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private current: CloudflareTunnelStatus = { enabled: false, configured: false, process: "stopped", binaryAvailable: false, otherConnectorDetected: false };

  constructor(options: CloudflareTunnelManagerOptions) {
    this.root = options.root;
    this.privateDir = path.join(this.root, "private");
    this.statePath = path.join(this.privateDir, STATE_FILE);
    this.tokenPath = path.join(this.privateDir, TOKEN_FILE);
    this.findBinary = options.findBinary ?? (() => (process.platform === "win32" ? "cloudflared.exe" : "cloudflared"));
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
    this.detectOtherConnectors = options.detectOtherConnectors ?? (async () => detectSystemCloudflaredPids());
  }

  status(): CloudflareTunnelStatus {
    return { ...this.current };
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(action);
    this.tail = next;
    return next;
  }

  private setError(code: TunnelErrorCode, enabled = this.current.enabled): void {
    this.current = { ...this.current, enabled, process: "failed", lastError: TUNNEL_ERRORS[code], lastErrorCode: code };
  }

  private clearError(): void {
    const { lastError: _lastError, lastErrorCode: _code, ...state } = this.current;
    this.current = state;
  }

  private async loadState(): Promise<boolean> {
    try {
      const value = await readJson(this.statePath, 16 * 1024);
      this.persisted = value === undefined ? undefined : parseStoredState(value);
      this.current = { ...this.current, enabled: this.persisted?.enabled ?? false, process: "stopped", ...(this.persisted?.hostname ? { hostname: this.persisted.hostname } : {}) };
      if (!this.persisted?.hostname) delete (this.current as Partial<CloudflareTunnelStatus>).hostname;
      this.clearError();
      return true;
    } catch {
      this.persisted = undefined;
      this.current.enabled = false;
      delete this.current.hostname;
      this.setError("invalid_state", false);
      return false;
    }
  }

  private async tokenConfigured(): Promise<boolean> {
    try {
      const info = await fs.lstat(this.tokenPath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 4 * MAX_TOKEN_CHARS) throw new Error("invalid token");
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("invalid token mode");
      const handle = await fs.open(this.tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error("changed token");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
        if (text.length < 1 || text.length > MAX_TOKEN_CHARS || /[\r\n\0]/.test(text)) throw new Error("invalid token");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async persistState(pid?: number): Promise<void> {
    if (!this.persisted) return;
    this.persisted = { ...this.persisted, ...(pid ? { pid } : {}) };
    if (!pid) delete this.persisted.pid;
    await atomicJson(this.statePath, this.persisted);
  }

  private async refreshOtherConnectors(): Promise<void> {
    const dedicatedPid = this.child?.pid ?? this.persisted?.pid;
    try {
      const detected = await this.detectOtherConnectors(dedicatedPid);
      this.current.otherConnectorDetected = typeof detected === "boolean" ? detected : detected.some((pid) => pid > 0 && pid !== dedicatedPid && pid !== this.child?.pid);
    } catch {
      this.current.otherConnectorDetected = false;
    }
  }

  private markUnexpectedExit(record: RunningChild): void {
    if (this.child !== record) return;
    this.child = undefined;
    if (!record.stopping) this.setError("exited");
    else if (this.current.process === "running") this.current.process = "stopped";
    void this.serial(async () => {
      if (this.persisted) await this.persistState().catch(() => undefined);
    });
  }

  private async startInternal(): Promise<CloudflareTunnelStatus> {
    if (this.closed) return this.status();
    if (this.child) {
      this.current.process = "running";
      return this.status();
    }
    if (!await this.loadState()) return this.status();
    await this.refreshOtherConnectors();
    let configured = false;
    try {
      configured = await this.tokenConfigured();
    } catch {
      this.current.configured = true;
      this.setError("invalid_token");
      return this.status();
    }
    this.current.configured = configured;
    const enabled = this.persisted?.enabled === true;
    this.current.enabled = enabled;
    if (!enabled) {
      this.current.process = "stopped";
      this.clearError();
    }
    const previousPid = this.persisted?.pid;
    if (enabled && pidAlive(previousPid)) {
      this.current.process = "failed";
      this.current.lastError = TUNNEL_ERRORS.previous;
      this.current.lastErrorCode = "previous";
      return this.status();
    }
    if (previousPid && !pidAlive(previousPid)) await this.persistState();
    const binary = await this.findBinaryPath();
    const version = binary ? await this.probeVersionFor(binary) : undefined;
    this.current.binaryAvailable = Boolean(version);
    if (!enabled) return this.status();
    if (!configured) {
      this.setError("invalid_token");
      return this.status();
    }
    if (!binary || !version) {
      this.setError("missing");
      return this.status();
    }
    if (compareVersion(version, MIN_VERSION) < 0) {
      this.setError("version");
      return this.status();
    }
    await fs.mkdir(path.join(this.privateDir, "cloudflared-home"), { recursive: true, mode: 0o700 });
    let child: ChildProcess;
    try {
      child = this.spawn(binary, ["tunnel", "run", "--no-autoupdate", "--token-file", this.tokenPath], { cwd: this.root, env: buildCloudflaredEnvironment(this.root), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      this.setError("launch");
      return this.status();
    }
    const record: RunningChild = { child, pid: child.pid, stopping: false };
    this.child = record;
    // Output is discarded (it can contain the tunnel id); only its size is bounded.
    child.stdout?.resume();
    child.stderr?.resume();
    child.once("error", () => this.markUnexpectedExit(record));
    child.once("exit", () => this.markUnexpectedExit(record));
    this.current.process = "running";
    this.clearError();
    await this.persistState(child.pid).catch(() => {
      record.stopping = true;
      child.kill("SIGTERM");
      if (this.child === record) this.child = undefined;
      this.setError("launch");
    });
    return this.status();
  }

  private async findBinaryPath(): Promise<string | undefined> {
    try {
      return await this.findBinary();
    } catch {
      return undefined;
    }
  }

  private async probeVersionFor(binary: string): Promise<readonly [number, number, number] | undefined> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawn(binary, ["--version"], { cwd: this.root, env: buildCloudflaredEnvironment(this.root), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        resolve(undefined);
        return;
      }
      let settled = false;
      let bytes = 0;
      const chunks: Buffer[] = [];
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code === 0 ? parseCloudflaredVersion(Buffer.concat(chunks).toString("utf8")) : undefined);
      };
      child.once("error", () => finish(-1));
      child.once("close", (code) => finish(code));
      child.stderr?.resume();
      child.stdout?.on("data", (chunk: Buffer) => {
        if (bytes >= MAX_CAPTURE_BYTES) return;
        const part = chunk.subarray(0, MAX_CAPTURE_BYTES - bytes);
        bytes += part.length;
        chunks.push(part);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(-1);
      }, PROBE_TIMEOUT_MS);
    });
  }

  async start(): Promise<CloudflareTunnelStatus> {
    try {
      return await this.serial(() => this.startInternal());
    } catch {
      this.setError("launch");
      return this.status();
    }
  }

  private async stopInternal(): Promise<void> {
    const record = this.child;
    if (!record) {
      if (this.current.process === "running") this.current.process = "stopped";
      return;
    }
    record.stopping = true;
    if (record.child.exitCode === null) {
      await new Promise<void>((done) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          record.child.removeListener("exit", finish);
          record.child.removeListener("close", finish);
          done();
        };
        record.child.once("exit", finish);
        record.child.once("close", finish);
        try {
          record.child.kill("SIGTERM");
        } catch {
          finish();
        }
        const timer = setTimeout(() => {
          try {
            record.child.kill("SIGKILL");
          } catch {
            // The child may have exited between the checks.
          }
          setTimeout(finish, 1000).unref();
        }, STOP_TIMEOUT_MS);
      });
    }
    if (this.child === record) this.child = undefined;
    if (this.current.process === "running") this.current.process = "stopped";
    await this.persistState().catch(() => undefined);
  }

  static validateConfiguration(configuration: CloudflareTunnelConfiguration): { token: string; hostname?: string } {
    const token = typeof configuration.token === "string" ? configuration.token.trim() : "";
    if (token.length < 1 || token.length > MAX_TOKEN_CHARS || /[\r\n\0]/.test(token) || Buffer.byteLength(token, "utf8") > 4 * MAX_TOKEN_CHARS) throw new Error("The Cloudflare tunnel token is not valid.");
    if (configuration.hostname !== undefined && configuration.hostname !== "" && !validTunnelHostname(configuration.hostname)) throw new Error("The Cloudflare hostname must be an https:// URL.");
    return { token, ...(configuration.hostname ? { hostname: configuration.hostname } : {}) };
  }

  private async writeToken(token: string): Promise<void> {
    await fs.mkdir(this.privateDir, { recursive: true, mode: 0o700 });
    try {
      const existing = await fs.lstat(this.tokenPath);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error("The token file is not regular.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${this.tokenPath}.new-${randomUUID()}`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(token, "utf8");
      await handle.sync();
      await handle.close();
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.rename(temporary, this.tokenPath);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 12 || process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
          await new Promise((done) => setTimeout(done, 15 * (attempt + 1)));
        }
      }
      if (process.platform !== "win32") await fs.chmod(this.tokenPath, 0o600);
    } finally {
      await handle.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  async configure(configuration: CloudflareTunnelConfiguration): Promise<CloudflareTunnelStatus> {
    const validated = CloudflareTunnelManager.validateConfiguration(configuration);
    return this.serial(async () => {
      this.closed = false;
      await this.stopInternal();
      await this.writeToken(validated.token);
      this.persisted = { version: 1, enabled: true, ...(validated.hostname ? { hostname: validated.hostname } : {}) };
      await atomicJson(this.statePath, this.persisted);
      this.current = { ...this.current, enabled: true, configured: true, process: "stopped", ...(validated.hostname ? { hostname: validated.hostname } : {}) };
      if (!validated.hostname) delete (this.current as Partial<CloudflareTunnelStatus>).hostname;
      this.clearError();
      return this.status();
    });
  }

  async restart(): Promise<CloudflareTunnelStatus> {
    try {
      return await this.serial(async () => {
        this.closed = false;
        await this.stopInternal();
        return this.startInternal();
      });
    } catch {
      this.setError("launch");
      return this.status();
    }
  }

  async remove(): Promise<CloudflareTunnelStatus> {
    return this.serial(async () => {
      await this.stopInternal();
      await fs.rm(this.tokenPath, { force: true });
      await fs.rm(this.statePath, { force: true });
      this.persisted = undefined;
      this.current = { enabled: false, configured: false, process: "stopped", binaryAvailable: this.current.binaryAvailable, otherConnectorDetected: this.current.otherConnectorDetected };
      return this.status();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.serial(async () => {
      if (this.closed) return;
      this.closed = true;
      await this.stopInternal();
    });
  }
}
