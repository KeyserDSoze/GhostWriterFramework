import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { NPM_SERVER_PACKAGE, isExactSemver, trustedNpmReleaseMetadata } from "./npm-release.js";

export const PACKAGE_NAME = NPM_SERVER_PACKAGE;
export const MINIMUM_NODE: readonly [number, number, number] = [22, 14, 0];
/** Set in the server process started by the supervisor: only then can a client request an update. */
export const SUPERVISED_ENV = "NARRARIUM_SUPERVISED";
const MAX_CONTROL_FILE_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UpdateOutcome = "completed" | "failed" | "limited" | "stopping";
export const UPDATE_MESSAGES: Record<UpdateOutcome, string> = {
  completed: "Update completed.",
  failed: "The update did not succeed. The previous version is still active.",
  limited: "Limit of three supervised updates per hour reached. The active version stays; restart the supervisor when you can.",
  stopping: "The server did not stop cleanly. The active version was not replaced.",
};

export interface UpdateRequest {
  schemaVersion: 1;
  packageName: typeof PACKAGE_NAME;
  version: string;
  requestedAt: string;
  requestId: string;
  source: "client" | "admin";
}

export interface UpdateResult {
  schemaVersion: 1;
  requestId: string;
  state: "completed" | "failed";
  outcome: UpdateOutcome;
  version: string;
  fromVersion: string;
  at: string;
  message: string;
}

export interface InstallerState {
  schemaVersion: 1;
  packageName: typeof PACKAGE_NAME;
  channel: "latest";
  activeVersion: string;
  installedAt: string;
}

export interface ActiveRuntime {
  schemaVersion: 1;
  packageName: typeof PACKAGE_NAME;
  version: string;
  activatedAt: string;
  packageRoot: string;
  serverPath: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type CommandRunner = (command: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

export interface InstallOptions {
  /** Accept the hand-published bootstrap version, which has a registry signature but no provenance. */
  bootstrapRegistryRelease?: boolean;
}

export interface RuntimeInstallerOptions {
  dataRoot: string;
  npmBinary?: string;
  runner?: CommandRunner;
  now?: () => Date;
  uuid?: () => string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

export function assertExactSemver(value: unknown): asserts value is string {
  if (!isExactSemver(value)) throw new Error("Not a valid version: an exact semver version is required.");
}

export function assertSupportedNode(version = process.versions.node): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const parsed = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  let ok = Boolean(parsed);
  if (parsed) {
    for (let index = 0; index < 3; index += 1) {
      if (parsed[index] !== MINIMUM_NODE[index]) {
        ok = parsed[index] > MINIMUM_NODE[index];
        break;
      }
    }
  }
  if (!ok) throw new Error(`Node.js ${MINIMUM_NODE.join(".")} or newer is required (this is ${version}).`);
}

/** Where the server keeps its data unless `--data-root` or NARRARIUM_SERVER_HOME says otherwise. */
export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (env.NARRARIUM_SERVER_HOME?.trim()) return paths.resolve(env.NARRARIUM_SERVER_HOME.trim());
  if (platform === "win32") return paths.resolve(env.APPDATA ?? paths.join(homedir(), "AppData", "Roaming"), "Narrarium", "server");
  if (platform === "darwin") return paths.resolve(env.HOME ?? homedir(), "Library", "Application Support", "Narrarium Server");
  const xdg = env.XDG_DATA_HOME;
  return paths.resolve(xdg && xdg.startsWith("/") ? xdg : paths.join(env.HOME ?? homedir(), ".local", "share"), "narrarium-server");
}

const NETWORK_AND_SYSTEM_VARIABLES = [
  "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];

/** npm runs with a minimal environment: no tokens, no install scripts. */
export function sanitizedNpmEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_UPDATE_NOTIFIER: "false" };
  for (const name of NETWORK_AND_SYSTEM_VARIABLES) if (source[name] !== undefined) env[name] = source[name];
  return env;
}

export function parseUpdateRequest(value: unknown): UpdateRequest {
  if (!isPlainObject(value) || !exactKeys(value, ["schemaVersion", "packageName", "version", "requestedAt", "requestId", "source"])) throw new Error("Not a valid update request.");
  assertExactSemver(value.version);
  if (value.schemaVersion !== 1 || value.packageName !== PACKAGE_NAME || (value.source !== "client" && value.source !== "admin") || !validIso(value.requestedAt) || typeof value.requestId !== "string" || !UUID.test(value.requestId)) {
    throw new Error("Not a valid update request.");
  }
  return value as unknown as UpdateRequest;
}

export function parseUpdateResult(value: unknown): UpdateResult {
  if (!isPlainObject(value) || !exactKeys(value, ["schemaVersion", "requestId", "state", "outcome", "version", "fromVersion", "at", "message"])) throw new Error("Not a valid update result.");
  assertExactSemver(value.version);
  assertExactSemver(value.fromVersion);
  const outcome = value.outcome as UpdateOutcome;
  const consistent = value.state === "completed" ? outcome === "completed" : value.state === "failed" && (outcome === "failed" || outcome === "limited" || outcome === "stopping");
  if (value.schemaVersion !== 1 || typeof value.requestId !== "string" || !UUID.test(value.requestId) || !consistent || !validIso(value.at) || value.message !== UPDATE_MESSAGES[outcome]) {
    throw new Error("Not a valid update result.");
  }
  return value as unknown as UpdateResult;
}

export const UPDATE_REQUEST_FILE = path.join("private", "update-request.json");
export const UPDATE_RESULT_FILE = path.join("private", "update-result.json");

async function readBoundedJson(file: string, maxBytes = MAX_CONTROL_FILE_BYTES): Promise<unknown | undefined> {
  let handle: fs.FileHandle;
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw new Error("Control file is not regular or too large.");
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size > maxBytes) throw new Error("Control file changed while it was read.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) throw new Error("Control file over the limit.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    await handle.close();
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 12 || process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await new Promise((done) => setTimeout(done, 15 * (attempt + 1)));
    }
  }
}

async function writeControlJson(file: string, value: unknown): Promise<void> {
  const parent = path.dirname(file);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(parent, 0o700);
  const data = Buffer.from(`${JSON.stringify(value)}\n`);
  if (data.byteLength > MAX_CONTROL_FILE_BYTES) throw new Error("Control file over the limit.");
  const temporary = `${file}.new-${randomUUID()}`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await renameWithRetry(temporary, file);
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function regularFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function ensureDataRoot(dataRoot: string): Promise<string> {
  const root = path.resolve(dataRoot);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The data folder must be a regular directory.");
  if (process.platform !== "win32") await fs.chmod(root, 0o700);
  const privateDir = path.join(root, "private");
  await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });
  const privateStat = await fs.lstat(privateDir);
  if (!privateStat.isDirectory() || privateStat.isSymbolicLink()) throw new Error("The private folder of the server is not safe.");
  if (process.platform !== "win32") await fs.chmod(privateDir, 0o700);
  return root;
}

/** Quote one argument for cmd.exe (only used when npm's JavaScript entry point cannot be found). */
function cmdQuote(value: string): string {
  return /^[A-Za-z0-9_@=:.,/\\+-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}

function spawnCommand(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((accept, reject) => {
    const limits = { stdout: 1024 * 1024, stderr: 64 * 1024 };
    let stdout = "";
    let stderr = "";
    let settled = false;
    // A Windows .cmd script cannot be spawned without a shell: quote every argument for cmd.exe then.
    const viaShell = process.platform === "win32" && /\.cmd$/i.test(command);
    const child = viaShell
      ? spawn([command, ...args].map(cmdQuote).join(" "), { cwd: options.cwd, env: options.env, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(command, [...args], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      action();
    };
    child.once("error", () => finish(() => reject(new Error(`Could not run ${command}.`))));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) + chunk.byteLength > limits.stdout) {
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) + chunk.byteLength > limits.stderr) return;
      stderr += chunk.toString("utf8");
    });
    child.once("close", (code) => finish(() => accept({ code: code ?? 1, stdout, stderr })));
  });
}

/** How to run npm without a shell: on Windows, npm's JavaScript entry point next to node.exe. */
export function npmInvocation(platform: NodeJS.Platform = process.platform, execPath = process.execPath): { command: string; prefix: string[] } {
  if (platform !== "win32") return { command: "npm", prefix: [] };
  const cli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(cli) ? { command: execPath, prefix: [cli] } : { command: "npm.cmd", prefix: [] };
}

/**
 * Installs exact, verified versions of the server package under `<data>/private/npm-runtime`:
 * staging install without scripts, registry signature audit, content digest, atomic activation.
 */
export class RuntimeInstaller {
  readonly dataRoot: string;
  readonly runtimeRoot: string;
  private readonly runner: CommandRunner;
  private readonly npm: string;
  private readonly npmPrefix: string[];
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(options: RuntimeInstallerOptions) {
    this.dataRoot = path.resolve(options.dataRoot);
    this.runtimeRoot = path.join(this.dataRoot, "private", "npm-runtime");
    this.runner = options.runner ?? spawnCommand;
    const npm = options.npmBinary ? { command: options.npmBinary, prefix: [] } : npmInvocation();
    this.npm = npm.command;
    this.npmPrefix = npm.prefix;
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
  }

  private async runNpm(args: readonly string[]): Promise<CommandResult> {
    const result = await this.runner(this.npm, [...this.npmPrefix, ...args, "--registry=https://registry.npmjs.org"], { cwd: this.dataRoot, env: sanitizedNpmEnvironment(), timeoutMs: 10 * 60_000 });
    if (result.code !== 0) throw new Error(`npm ${args[0]} did not succeed.`);
    return result;
  }

  async latestVersion(): Promise<string> {
    await ensureDataRoot(this.dataRoot);
    const result = await this.runNpm(["view", PACKAGE_NAME, "version", "--json"]);
    let version: unknown;
    try {
      version = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error("npm returned an invalid version list.");
    }
    if (Array.isArray(version) && version.length === 1) version = version[0];
    assertExactSemver(version);
    return version;
  }

  private async assertTrustedRelease(version: string, allowRegistryBootstrap = false): Promise<void> {
    const result = await this.runNpm(["view", `${PACKAGE_NAME}@${version}`, "--json"]);
    let metadata: unknown;
    try {
      metadata = JSON.parse(result.stdout);
    } catch {
      throw new Error("npm returned invalid package metadata.");
    }
    trustedNpmReleaseMetadata(metadata, version, allowRegistryBootstrap);
  }

  async installVersion(requested: string | "latest" = "latest", options: InstallOptions = {}): Promise<ActiveRuntime> {
    assertSupportedNode();
    await ensureDataRoot(this.dataRoot);
    const version = requested === "latest" ? await this.latestVersion() : requested;
    assertExactSemver(version);
    await this.assertTrustedRelease(version, options.bootstrapRegistryRelease === true);
    await fs.mkdir(path.join(this.runtimeRoot, "versions"), { recursive: true, mode: 0o700 });
    const staging = path.join(this.runtimeRoot, `staging-${this.uuid()}`);
    const destination = path.join(this.runtimeRoot, "versions", version);
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await this.runNpm(["install", "--prefix", staging, "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--package-lock=true", `${PACKAGE_NAME}@${version}`]);
      await this.runNpm(["audit", "signatures", "--prefix", staging]);
      const stagedPackage = path.join(staging, "node_modules", PACKAGE_NAME);
      await this.validateInstalledPackage(stagedPackage, version);
      if (await regularFile(path.join(destination, "package.json"))) {
        await this.validateInstalledPackage(destination, version);
        if (await this.packageDigest(destination) !== await this.packageDigest(stagedPackage)) throw new Error("A different copy of this version is already installed: it was not replaced.");
      } else {
        await renameWithRetry(stagedPackage, destination);
      }
      await this.activate(version);
      const active = await this.activeRuntime();
      if (!active) throw new Error("The activated runtime cannot be read.");
      return active;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  private async packageDigest(root: string): Promise<string> {
    const hash = createHash("sha256");
    let files = 0;
    let bytes = 0;
    const walk = async (directory: string, relative = ""): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("npm package with links: refused.");
        if (entry.isDirectory()) {
          await walk(file, name);
          continue;
        }
        if (!entry.isFile()) throw new Error("npm package with irregular files: refused.");
        const stat = await fs.lstat(file);
        files += 1;
        bytes += stat.size;
        if (stat.size > 20 * 1024 * 1024 || files > 5000 || bytes > 80 * 1024 * 1024) throw new Error("npm package over the safety limits.");
        hash.update(JSON.stringify(name));
        hash.update("\0");
        hash.update(await fs.readFile(file));
        hash.update("\0");
      }
    };
    await walk(root);
    return hash.digest("hex");
  }

  private async validateInstalledPackage(root: string, expectedVersion: string): Promise<void> {
    const value = await readBoundedJson(path.join(root, "package.json"));
    if (!isPlainObject(value) || value.name !== PACKAGE_NAME || value.version !== expectedVersion) throw new Error("The installed npm package does not match.");
    if (!await regularFile(path.join(root, "dist", "cli.mjs")) || !await regularFile(path.join(root, "dist", "server.mjs"))) throw new Error("The installed npm package is incomplete.");
  }

  private async activate(version: string): Promise<void> {
    const at = this.now().toISOString();
    await this.validateInstalledPackage(path.join(this.runtimeRoot, "versions", version), version);
    await writeControlJson(path.join(this.runtimeRoot, "active.json"), { schemaVersion: 1, packageName: PACKAGE_NAME, version, activatedAt: at });
    const state: InstallerState = { schemaVersion: 1, packageName: PACKAGE_NAME, channel: "latest", activeVersion: version, installedAt: at };
    await writeControlJson(path.join(this.dataRoot, "private", "npm-install.json"), state);
  }

  async activeRuntime(): Promise<ActiveRuntime | undefined> {
    const value = await readBoundedJson(path.join(this.runtimeRoot, "active.json"));
    if (value === undefined) return undefined;
    if (!isPlainObject(value) || !exactKeys(value, ["schemaVersion", "packageName", "version", "activatedAt"]) || value.schemaVersion !== 1 || value.packageName !== PACKAGE_NAME || !validIso(value.activatedAt)) {
      throw new Error("The runtime state is not valid.");
    }
    assertExactSemver(value.version);
    const packageRoot = path.join(this.runtimeRoot, "versions", value.version);
    await this.validateInstalledPackage(packageRoot, value.version);
    return { ...(value as unknown as Omit<ActiveRuntime, "packageRoot" | "serverPath">), packageRoot, serverPath: path.join(packageRoot, "dist", "server.mjs") };
  }

  async installerState(): Promise<InstallerState | undefined> {
    const value = await readBoundedJson(path.join(this.dataRoot, "private", "npm-install.json"));
    if (value === undefined) return undefined;
    if (!isPlainObject(value) || !exactKeys(value, ["schemaVersion", "packageName", "channel", "activeVersion", "installedAt"]) || value.schemaVersion !== 1 || value.packageName !== PACKAGE_NAME || value.channel !== "latest" || !validIso(value.installedAt)) {
      throw new Error("The installation state is not valid.");
    }
    assertExactSemver(value.activeVersion);
    return value as unknown as InstallerState;
  }

  async writeUpdateRequest(request: UpdateRequest): Promise<void> {
    await writeControlJson(path.join(this.dataRoot, UPDATE_REQUEST_FILE), parseUpdateRequest(request));
  }

  async writeUpdateResult(result: UpdateResult): Promise<void> {
    await writeControlJson(path.join(this.dataRoot, UPDATE_RESULT_FILE), parseUpdateResult(result));
  }

  async readUpdateRequest(): Promise<UpdateRequest | undefined> {
    const value = await readBoundedJson(path.join(this.dataRoot, UPDATE_REQUEST_FILE));
    return value === undefined ? undefined : parseUpdateRequest(value);
  }

  async readUpdateResult(): Promise<UpdateResult | undefined> {
    const value = await readBoundedJson(path.join(this.dataRoot, UPDATE_RESULT_FILE));
    return value === undefined ? undefined : parseUpdateResult(value);
  }

  async deleteMatchingUpdateRequest(expected: UpdateRequest): Promise<boolean> {
    const current = await this.readUpdateRequest();
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
    await fs.unlink(path.join(this.dataRoot, UPDATE_REQUEST_FILE));
    return true;
  }
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ServerChildHandle {
  kill(signal: NodeJS.Signals): boolean;
  exited: Promise<ChildExit>;
}

export interface SupervisorOptions {
  installer: RuntimeInstaller;
  currentVersion: string;
  spawnChild?: (serverPath: string, dataRoot: string) => ServerChildHandle;
  /** Extra arguments for the server process (only fixed, validated flags). */
  childArgs?: readonly string[];
  pollMs?: number;
  stopTimeoutMs?: number;
  hourMs?: number;
  forwardSignals?: boolean;
  log?: (line: string) => void;
}

function childHandle(child: ChildProcess): ServerChildHandle {
  return {
    kill: (signal) => child.kill(signal),
    exited: new Promise((accept) => {
      let finished = false;
      const done = (code: number | null, signal: NodeJS.Signals | null) => {
        if (finished) return;
        finished = true;
        accept({ code, signal });
      };
      child.once("error", () => done(1, null));
      child.once("exit", done);
    }),
  };
}

export function supervisedChildEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { [SUPERVISED_ENV]: "1", NPM_CONFIG_UPDATE_NOTIFIER: "false" };
  for (const name of [...NETWORK_AND_SYSTEM_VARIABLES, "XDG_DATA_HOME", "NARRARIUM_SERVER_HOME"]) if (environment[name] !== undefined) clean[name] = environment[name];
  return clean;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultChild(childArgs: readonly string[]): (serverPath: string, dataRoot: string) => ServerChildHandle {
  return (serverPath, dataRoot) => childHandle(spawn(process.execPath, [serverPath, "--data-root", dataRoot, ...childArgs], {
    shell: false,
    windowsHide: false,
    stdio: "inherit",
    env: supervisedChildEnvironment(),
  } satisfies SpawnOptions));
}

async function writeUpdateFailure(installer: RuntimeInstaller, request: UpdateRequest, fromVersion: string, outcome: Exclude<UpdateOutcome, "completed">): Promise<void> {
  await installer.writeUpdateResult({ schemaVersion: 1, requestId: request.requestId, state: "failed", outcome, version: request.version, fromVersion, at: new Date().toISOString(), message: UPDATE_MESSAGES[outcome] });
}

/**
 * Supervises the one server process owned by this CLI. A valid, bounded update request file is the
 * only trigger that can replace the active runtime; the supervisor never runs arbitrary commands
 * and never stops another process. At most three update restarts per hour.
 */
export async function superviseServer(options: SupervisorOptions): Promise<ChildExit> {
  assertSupportedNode();
  const installer = options.installer;
  const pollMs = options.pollMs ?? 500;
  const stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
  const hourMs = options.hourMs ?? 60 * 60_000;
  const spawnChild = options.spawnChild ?? defaultChild(options.childArgs ?? []);
  const log = options.log ?? (() => undefined);
  const updateRestarts: number[] = [];
  const ignoredRequests = new Set<string>();
  let stopping = false;
  let currentChild: ServerChildHandle | undefined;
  const onSigint = () => {
    stopping = true;
    currentChild?.kill("SIGINT");
  };
  const onSigterm = () => {
    stopping = true;
    currentChild?.kill("SIGTERM");
  };
  if (options.forwardSignals !== false) {
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  }
  const prune = () => {
    const cutoff = Date.now() - hourMs;
    while (updateRestarts[0] !== undefined && updateRestarts[0] < cutoff) updateRestarts.shift();
  };
  try {
    if (!await installer.activeRuntime()) await installer.installVersion(options.currentVersion, { bootstrapRegistryRelease: true });
    for (;;) {
      const active = await installer.activeRuntime();
      if (!active) throw new Error("No active runtime is available.");
      currentChild = spawnChild(active.serverPath, installer.dataRoot);
      let updateRequest: UpdateRequest | undefined;
      for (;;) {
        const exited = await withTimeout(currentChild.exited, pollMs);
        if (exited !== undefined) {
          try {
            updateRequest = await installer.readUpdateRequest();
          } catch {
            updateRequest = undefined;
          }
          if (stopping || !updateRequest || ignoredRequests.has(updateRequest.requestId)) return exited;
          break;
        }
        try {
          const request = await installer.readUpdateRequest();
          if (!request || ignoredRequests.has(request.requestId)) continue;
          updateRequest = request;
          prune();
          if (updateRestarts.length >= 3) {
            await writeUpdateFailure(installer, request, active.version, "limited");
            ignoredRequests.add(request.requestId);
            continue;
          }
          log(`Update to ${request.version} requested: stopping the server.`);
          currentChild.kill("SIGTERM");
          const childExit = await withTimeout(currentChild.exited, stopTimeoutMs);
          if (!childExit) {
            ignoredRequests.add(request.requestId);
            await writeUpdateFailure(installer, request, active.version, "stopping");
            continue;
          }
          break;
        } catch {
          // A hostile or unreadable request never stops the running server.
        }
      }
      if (!updateRequest || stopping) return await currentChild.exited;
      prune();
      if (updateRestarts.length >= 3) {
        await writeUpdateFailure(installer, updateRequest, active.version, "limited");
        ignoredRequests.add(updateRequest.requestId);
        return await spawnChild(active.serverPath, installer.dataRoot).exited;
      }
      let installed: ActiveRuntime | undefined;
      try {
        installed = await installer.installVersion(updateRequest.version);
      } catch (error) {
        log(`Update to ${updateRequest.version} failed: ${error instanceof Error ? error.message : String(error)}`);
        await writeUpdateFailure(installer, updateRequest, active.version, "failed").catch(() => undefined);
        ignoredRequests.add(updateRequest.requestId);
      }
      if (installed) {
        log(`Updated from ${active.version} to ${installed.version}.`);
        await installer.writeUpdateResult({ schemaVersion: 1, requestId: updateRequest.requestId, state: "completed", outcome: "completed", version: updateRequest.version, fromVersion: active.version, at: new Date().toISOString(), message: UPDATE_MESSAGES.completed }).catch(() => undefined);
        await installer.deleteMatchingUpdateRequest(updateRequest).catch(() => false);
        updateRestarts.push(Date.now());
      }
      // Restart the newly activated version, or the previous one kept by a failed install.
    }
  } finally {
    if (options.forwardSignals !== false) {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  }
}
