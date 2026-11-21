import { spawn, type ChildProcess, type SpawnOptions as NodeSpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { atomicJson, readJson } from "./files.js";
import { processIdentity, type ProcessIdentity } from "./process-identity.js";
import { isEncryptedSecret, Vault, type EncryptedSecret } from "./vault.js";

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
  /** Where the connector token is kept, encrypted (default: the vault of the data folder, opened when it is first needed). */
  vault?: Vault;
  /** Which program a process id belongs to (default: ask the operating system). */
  identify?: (pid: number) => Promise<ProcessIdentity | undefined>;
  /** Send a signal to a process by id (default: `process.kill`). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

interface PersistedTunnelState {
  version: 1;
  enabled: boolean;
  hostname?: string;
  pid?: number;
}

/** The connector this server started, as it is written down for the next start: its number, and what the number meant then. */
interface ProcessRecord {
  version: 1;
  pid: number;
  identity: { start: string; name: string } | null;
}

interface RunningChild {
  child: ChildProcess;
  pid: number | undefined;
  stopping: boolean;
}

const STATE_FILE = "cloudflare-tunnel.json";
/** Where earlier versions kept the token in clear text: it is read once to be moved into the vault, then deleted. */
const TOKEN_FILE = "cloudflare-tunnel-token";
/** The token, encrypted by the vault. */
const SECRET_FILE = "cloudflare-tunnel-token.json";
/** The connector that is running (or was, if the server died): checked by identity before anything is done to it. */
const PROCESS_FILE = "cloudflared-process.json";
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

/** The longest the connector gets to stop after SIGTERM before it is killed. */
const GRACE_MS = STOP_TIMEOUT_MS;
const CLOUDFLARED_NAME = /^cloudflared(?:\.exe)?$/i;

/**
 * Manages one `cloudflared tunnel run` child started by this server (a remotely-managed Cloudflare tunnel). It never installs
 * a service and never touches another connector.
 *
 * The connector token is kept encrypted by the vault, and reaches the child only through its environment: no file holds it in clear,
 * and it is never on a command line. The child ends with the server: a clean stop ends it, so does any exit of the process, and a
 * connector that survived a server that was killed outright is recognised by what it is (its program and its start time, not only its
 * number) and stopped by the next start.
 */
export class CloudflareTunnelManager {
  private readonly root: string;
  private readonly privateDir: string;
  private readonly statePath: string;
  private readonly tokenPath: string;
  private readonly secretPath: string;
  private readonly processPath: string;
  private readonly findBinary: () => Promise<string | undefined> | string | undefined;
  private readonly spawn: SpawnFunction;
  private readonly detectOtherConnectors: OtherConnectorDetector;
  private readonly identify: (pid: number) => Promise<ProcessIdentity | undefined>;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private vault: Vault | undefined;
  private persisted: PersistedTunnelState | undefined;
  private child: RunningChild | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private current: CloudflareTunnelStatus = { enabled: false, configured: false, process: "stopped", binaryAvailable: false, otherConnectorDetected: false };
  /** When this process ends, whatever the way, the connector it started must not stay behind. */
  private readonly exitHook = () => {
    const record = this.child;
    if (!record) return;
    record.stopping = true;
    try {
      record.child.kill("SIGTERM");
    } catch {
      // It may be gone already.
    }
  };

  constructor(options: CloudflareTunnelManagerOptions) {
    this.root = options.root;
    this.privateDir = path.join(this.root, "private");
    this.statePath = path.join(this.privateDir, STATE_FILE);
    this.tokenPath = path.join(this.privateDir, TOKEN_FILE);
    this.secretPath = path.join(this.privateDir, SECRET_FILE);
    this.processPath = path.join(this.privateDir, PROCESS_FILE);
    this.vault = options.vault;
    this.findBinary = options.findBinary ?? (() => (process.platform === "win32" ? "cloudflared.exe" : "cloudflared"));
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
    this.detectOtherConnectors = options.detectOtherConnectors ?? (async () => detectSystemCloudflaredPids());
    this.identify = options.identify ?? ((pid) => processIdentity(pid));
    this.kill = options.kill ?? ((pid, signal) => {
      process.kill(pid, signal);
    });
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

  private async openVault(): Promise<Vault> {
    this.vault ??= await Vault.open(this.root);
    return this.vault;
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

  /** The text of a token that passes the same checks as one typed in the panel, or `undefined`. */
  private static acceptableToken(text: string): string | undefined {
    return text.length >= 1 && text.length <= MAX_TOKEN_CHARS && !/[\r\n\0]/.test(text) ? text : undefined;
  }

  /** The clear-text token file of an earlier version: a private regular file with one line. Throws when it is not one. */
  private async readLegacyToken(): Promise<string | undefined> {
    try {
      const info = await fs.lstat(this.tokenPath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 4 * MAX_TOKEN_CHARS) throw new Error("invalid token");
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("invalid token mode");
      const handle = await fs.open(this.tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error("changed token");
        const token = CloudflareTunnelManager.acceptableToken(new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile()));
        if (!token) throw new Error("invalid token");
        return token;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeSecret(token: string): Promise<void> {
    const vault = await this.openVault();
    await atomicJson(this.secretPath, { version: 1, encrypted: vault.encrypt(token) });
  }

  private async readSecret(): Promise<string | undefined> {
    const stored = await readJson(this.secretPath, 64 * 1024) as { version?: unknown; encrypted?: unknown } | undefined;
    if (stored === undefined) return undefined;
    if (stored.version !== 1 || !isEncryptedSecret(stored.encrypted)) throw new Error("invalid secret");
    const token = CloudflareTunnelManager.acceptableToken((await this.openVault()).decrypt(stored.encrypted as EncryptedSecret));
    if (!token) throw new Error("invalid secret");
    return token;
  }

  /**
   * The token, from the vault. A clear-text file left by an earlier version is moved into the vault first (and is always the newer of
   * the two: this server never writes one, so an older server did): the vault's copy is written and read back before the clear file
   * is deleted, so a crash in between leaves both and the next start does it again. `undefined`: no token. Throws: unusable token.
   */
  private async loadToken(): Promise<string | undefined> {
    const legacy = await this.readLegacyToken();
    if (legacy !== undefined) {
      await this.writeSecret(legacy);
      if (await this.readSecret() !== legacy) throw new Error("the vault could not keep the token");
      await fs.rm(this.tokenPath, { force: true }).catch(() => undefined);
      return legacy;
    }
    return this.readSecret();
  }

  private async persistState(pid?: number): Promise<void> {
    if (!this.persisted) return;
    this.persisted = { ...this.persisted, ...(pid ? { pid } : {}) };
    if (!pid) delete this.persisted.pid;
    await atomicJson(this.statePath, this.persisted);
  }

  private async readProcessRecord(): Promise<ProcessRecord | undefined> {
    try {
      const value = await readJson(this.processPath, 4 * 1024) as Partial<ProcessRecord> | undefined;
      const identity = value?.identity;
      if (value?.version !== 1 || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined;
      const known = identity && typeof identity === "object" && typeof identity.start === "string" && typeof identity.name === "string";
      return { version: 1, pid: value.pid as number, identity: known ? { start: identity.start, name: identity.name } : null };
    } catch {
      return undefined;
    }
  }

  /** Write down the connector that is running now, and what its number means (its program and start time). */
  private async recordProcess(pid: number): Promise<void> {
    const identity = await this.identify(pid).catch(() => undefined);
    const record: ProcessRecord = { version: 1, pid, identity: identity ? { start: identity.start, name: identity.name } : null };
    await atomicJson(this.processPath, record);
  }

  private async forgetProcess(): Promise<void> {
    await fs.rm(this.processPath, { force: true }).catch(() => undefined);
    if (this.persisted?.pid !== undefined) await this.persistState().catch(() => undefined);
  }

  /**
   * Stop the connector a previous run of this server left behind (the server was killed, or crashed, and a child does not die with
   * its parent). A process id says nothing by itself: the number may belong to another program by now, so the process is stopped only
   * if it is a `cloudflared` that started exactly when the recorded one did. A number that is gone, or that belongs to another program,
   * is forgotten. Returns `false` when a connector of ours is still running after the attempt.
   */
  private async reapLeftover(): Promise<boolean> {
    const record = await this.readProcessRecord();
    const pid = record?.pid ?? this.persisted?.pid;
    if (pid === undefined) return true;
    if (pid === process.pid || pid === this.child?.pid) {
      await this.forgetProcess();
      return true;
    }
    const current = await this.identify(pid).catch(() => undefined);
    if (!current) {
      await this.forgetProcess();
      return true;
    }
    // An earlier version recorded the number only: it launched `cloudflared tunnel run --token-file <this folder's token file>`.
    const ours = CLOUDFLARED_NAME.test(current.name) && (record ? record.identity !== null && record.identity.start === current.start && CLOUDFLARED_NAME.test(record.identity.name) : current.command.includes(this.tokenPath));
    if (!ours) {
      await this.forgetProcess();
      return true;
    }
    try {
      await this.terminate(pid, current);
    } catch {
      return false;
    }
    await this.forgetProcess();
    return true;
  }

  /** Ask a connector of ours to stop, and kill it if it has not within the grace period. Throws if it is still there. */
  private async terminate(pid: number, identity: ProcessIdentity): Promise<void> {
    const gone = async () => {
      const now = await this.identify(pid).catch(() => undefined);
      return !now || now.start !== identity.start;
    };
    this.kill(pid, "SIGTERM");
    const deadline = Date.now() + GRACE_MS;
    while (Date.now() < deadline) {
      if (await gone()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.kill(pid, "SIGKILL");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await gone()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The connector did not stop.");
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
    process.off("exit", this.exitHook);
    if (record.stopping) {
      // A stop in progress records the end itself.
      if (this.current.process === "running") this.current.process = "stopped";
      return;
    }
    this.setError("exited");
    void this.serial(async () => {
      // A connector that ended by itself leaves nothing that names a process; one that was replaced meanwhile keeps its record.
      if (this.child) return;
      await this.forgetProcess();
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
    let token: string | undefined;
    let tokenUsable = true;
    try {
      token = await this.loadToken();
    } catch {
      tokenUsable = false;
    }
    this.current.configured = token !== undefined || !tokenUsable;
    const enabled = this.persisted?.enabled === true;
    this.current.enabled = enabled;
    if (!enabled) {
      this.current.process = "stopped";
      this.clearError();
    }
    // Whatever the previous run left running is stopped now, also when nothing is going to be started: it must not outlive the server.
    if (!await this.reapLeftover()) {
      if (enabled) {
        this.current.process = "failed";
        this.current.lastError = TUNNEL_ERRORS.previous;
        this.current.lastErrorCode = "previous";
        return this.status();
      }
    }
    const binary = await this.findBinaryPath();
    const version = binary ? await this.probeVersionFor(binary) : undefined;
    this.current.binaryAvailable = Boolean(version);
    if (!enabled) return this.status();
    if (!tokenUsable || token === undefined) {
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
      // The flags of `tunnel` (here `--no-autoupdate`) go before `run`: cloudflared does not know them after it.
      child = this.spawn(binary, ["tunnel", "--no-autoupdate", "run"], { cwd: this.root, env: { ...buildCloudflaredEnvironment(this.root), TUNNEL_TOKEN: token }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
    process.off("exit", this.exitHook);
    process.once("exit", this.exitHook);
    this.current.process = "running";
    this.clearError();
    try {
      if (child.pid) await this.recordProcess(child.pid);
      await this.persistState(child.pid);
    } catch {
      record.stopping = true;
      child.kill("SIGTERM");
      if (this.child === record) this.child = undefined;
      process.off("exit", this.exitHook);
      this.setError("launch");
    }
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
    // A child that already ended by a signal has `exitCode` null and `signalCode` set: its exit event has come and gone.
    const ended = record.child.exitCode !== null || (record.child.signalCode ?? null) !== null;
    if (!ended) {
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
    process.off("exit", this.exitHook);
    if (this.current.process === "running") this.current.process = "stopped";
    await this.forgetProcess();
    await this.persistState().catch(() => undefined);
  }

  static validateConfiguration(configuration: CloudflareTunnelConfiguration): { token: string; hostname?: string } {
    const token = typeof configuration.token === "string" ? configuration.token.trim() : "";
    if (token.length < 1 || token.length > MAX_TOKEN_CHARS || /[\r\n\0]/.test(token) || Buffer.byteLength(token, "utf8") > 4 * MAX_TOKEN_CHARS) throw new Error("The Cloudflare tunnel token is not valid.");
    if (configuration.hostname !== undefined && configuration.hostname !== "" && !validTunnelHostname(configuration.hostname)) throw new Error("The Cloudflare hostname must be an https:// URL.");
    return { token, ...(configuration.hostname ? { hostname: configuration.hostname } : {}) };
  }

  async configure(configuration: CloudflareTunnelConfiguration): Promise<CloudflareTunnelStatus> {
    const validated = CloudflareTunnelManager.validateConfiguration(configuration);
    return this.serial(async () => {
      this.closed = false;
      await this.stopInternal();
      await this.loadState().catch(() => false);
      await this.reapLeftover();
      await fs.mkdir(this.privateDir, { recursive: true, mode: 0o700 });
      await this.writeSecret(validated.token);
      await fs.rm(this.tokenPath, { force: true }).catch(() => undefined);
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
      await this.loadState().catch(() => false);
      await this.reapLeftover();
      for (const file of [this.tokenPath, this.secretPath, this.statePath, this.processPath]) await fs.rm(file, { force: true });
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
