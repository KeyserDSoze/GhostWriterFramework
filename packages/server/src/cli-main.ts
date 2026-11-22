import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ADMIN_PORT, DEFAULT_SERVER_PORT } from "narrarium-engine";
import { readAdminCode, readAdminCodeFile, readLocalSpend, requestLocalClientToken, rotateLocalAdminCode, setLocalAdminCode, updateLocalSpend } from "./admin-client.js";
import { autostartStatus, configureAutostart } from "./autostart.js";
import { loadServerConfig } from "./config.js";
import { compareSemver } from "./npm-release.js";
import { resolveDataRoot } from "./data-root.js";
import { PACKAGE_NAME, RollbackRefusedError, RuntimeInstaller, assertExactSemver, assertSupportedNode, sanitizedNpmEnvironment, superviseServer } from "./runtime-install.js";
import { MAX_SPEND_COST, MAX_SPEND_TOKENS, describeSpend, type SpendSettings } from "./spend.js";
import { parseCloudflaredVersion } from "./tunnel.js";
import { SERVER_VERSION } from "./version.js";

export const HELP = `Narrarium personal server ${SERVER_VERSION}

Usage:
  npx ${PACKAGE_NAME} [start] [--data-root DIR] [--port N] [--admin-port N] [--label NAME] [--origin URL] [--direct] [--verbose]
  npx ${PACKAGE_NAME} setup [--data-root DIR] [--autostart] [--port N] [--admin-port N] [--label NAME]
  npx ${PACKAGE_NAME} status [--data-root DIR]
  npx ${PACKAGE_NAME} doctor [--data-root DIR]
  npx ${PACKAGE_NAME} admin-code [--data-root DIR]
  npx ${PACKAGE_NAME} rotate-admin-code [--data-root DIR]
  npx ${PACKAGE_NAME} set-admin-code [--data-root DIR] [--code-file FILE-0600]
  npx ${PACKAGE_NAME} client-token [--data-root DIR] [--label NAME] [--scope read,write,run[,update]]
  npx ${PACKAGE_NAME} spend [--data-root DIR] [--pause | --resume] [--max-tokens-per-day N] [--max-cost-per-day N] [--max-tokens-per-run N] [--max-cost-per-run N]
  npx ${PACKAGE_NAME} update [--data-root DIR] [--to VERSION]
  npx ${PACKAGE_NAME} rollback [--data-root DIR] --to VERSION
  npx ${PACKAGE_NAME} --version

start         Run the server under the update supervisor (default). --direct runs it without the supervisor.
setup         Install the verified runtime in the data folder; --autostart also starts it at login (Linux, macOS).
admin-code    Show the code that opens the admin panel (${"http://127.0.0.1:" + DEFAULT_ADMIN_PORT}).
client-token  Create a client token to paste in Narrarium → Settings → Personal server.
spend         Show what this server spent on AI today and the owner's limits, or set them (0 is no limit): --pause switches every
              AI call off at once, --resume switches them on again. Talks to the running server, like client-token.
update        Install the latest verified version (or --to VERSION); a running server keeps its version until restarted.
              A version older than the highest ever installed in the data folder is refused.
rollback      Go back to a version that is already installed on this computer (nothing is downloaded). Updates from npm
              stay as strict as before: nothing below the highest version is installed.

The data folder is ${resolveDataRoot()} unless --data-root or NARRARIUM_SERVER_HOME says otherwise.
`;

const COMMANDS = ["start", "setup", "status", "doctor", "admin-code", "rotate-admin-code", "set-admin-code", "client-token", "spend", "update", "rollback"] as const;
type Command = (typeof COMMANDS)[number];

export interface ParsedCommand {
  command: Command | "help" | "version";
  dataRoot?: string;
  apiPort?: number;
  adminPort?: number;
  label?: string;
  origins: string[];
  direct?: boolean;
  verbose?: boolean;
  autostart?: boolean;
  codeFile?: string;
  scopes?: string[];
  requestedVersion?: string;
  /** `spend`: what to change (absent: just show it). */
  spend?: Partial<SpendSettings>;
}

function port(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${flag} needs a port between 1 and 65535.`);
  return parsed;
}

const SPEND_LIMIT_FLAGS = {
  "--max-tokens-per-day": "maxTokensPerDay",
  "--max-cost-per-day": "maxCostPerDay",
  "--max-tokens-per-run": "maxTokensPerRun",
  "--max-cost-per-run": "maxCostPerRun",
} as const;

/** A whole number of tokens, or an amount of money, from 0 (no limit) up to what the server believes. */
function spendLimit(flag: keyof typeof SPEND_LIMIT_FLAGS, text: string): number {
  const tokens = flag.includes("tokens");
  const value = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(value)) throw new Error(`${flag} needs ${tokens ? "a whole number of tokens" : "an amount"} from 0 (no limit), not "${text}".`);
  if (tokens && !Number.isInteger(value)) throw new Error(`${flag} needs a whole number of tokens, not "${text}".`);
  if (value > (tokens ? MAX_SPEND_TOKENS : MAX_SPEND_COST)) throw new Error(`${flag} is too large: at most ${tokens ? MAX_SPEND_TOKENS : MAX_SPEND_COST}.`);
  return value;
}

export function parseCommand(argv: readonly string[]): ParsedCommand {
  const first = argv[0];
  if (first === "--help" || first === "-h" || first === "help") return { command: "help", origins: [] };
  if (first === "--version" || first === "-v" || first === "version") return { command: "version", origins: [] };
  const explicit = first !== undefined && !first.startsWith("--");
  if (explicit && !(COMMANDS as readonly string[]).includes(first)) throw new Error(`Unknown command: ${first}\n\n${HELP}`);
  const parsed: ParsedCommand = { command: explicit ? first as Command : "start", origins: [] };
  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (!next || next.startsWith("--")) throw new Error(`${flag} needs a value.`);
    return next;
  };
  for (let index = explicit ? 1 : 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const allowed = (commands: readonly string[]) => commands.includes(parsed.command);
    if ((flag === "--data-root" || flag === "--data") && allowed(COMMANDS)) parsed.dataRoot = value(++index, flag);
    else if (flag === "--port" && allowed(["start", "setup"])) parsed.apiPort = port(argv[++index], flag);
    else if (flag === "--admin-port" && allowed(["start", "setup"])) parsed.adminPort = port(argv[++index], flag);
    else if (flag === "--label" && allowed(["start", "setup", "client-token"])) {
      const label = value(++index, flag);
      if (label.length > 80) throw new Error("--label must have at most 80 characters.");
      parsed.label = label;
    } else if (flag === "--origin" && allowed(["start"])) parsed.origins.push(value(++index, flag));
    else if (flag === "--direct" && allowed(["start"])) parsed.direct = true;
    else if (flag === "--verbose" && allowed(["start"])) parsed.verbose = true;
    else if (flag === "--autostart" && allowed(["setup"])) parsed.autostart = true;
    else if (flag === "--code-file" && allowed(["set-admin-code"])) parsed.codeFile = value(++index, flag);
    else if (flag === "--scope" && allowed(["client-token"])) parsed.scopes = value(++index, flag).split(",").map((scope) => scope.trim());
    else if ((flag === "--pause" || flag === "--resume") && allowed(["spend"])) {
      const paused = flag === "--pause";
      if (parsed.spend?.paused !== undefined && parsed.spend.paused !== paused) throw new Error("Use either --pause or --resume, not both.");
      parsed.spend = { ...parsed.spend, paused };
    } else if (flag in SPEND_LIMIT_FLAGS && allowed(["spend"])) {
      parsed.spend = { ...parsed.spend, [SPEND_LIMIT_FLAGS[flag as keyof typeof SPEND_LIMIT_FLAGS]]: spendLimit(flag as keyof typeof SPEND_LIMIT_FLAGS, value(++index, flag)) };
    } else if (flag === "--to" && allowed(["update", "rollback"])) {
      const version = value(++index, flag);
      assertExactSemver(version);
      parsed.requestedVersion = version;
    } else throw new Error(`Option not allowed for ${parsed.command}: ${flag}`);
  }
  if (parsed.command === "rollback" && !parsed.requestedVersion) throw new Error("rollback needs --to VERSION: the installed version to go back to.");
  return parsed;
}

function probe(command: string, args: readonly string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, [...args], { shell: process.platform === "win32" && /\.cmd$/i.test(command), windowsHide: true, encoding: "utf8", env: sanitizedNpmEnvironment(), timeout: 15_000 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() };
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export function doctorChecks(dataRoot: string, platform: NodeJS.Platform = process.platform, run = probe): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  try {
    assertSupportedNode();
    checks.push({ name: "Node.js", ok: true, required: true, detail: process.versions.node });
  } catch (error) {
    checks.push({ name: "Node.js", ok: false, required: true, detail: error instanceof Error ? error.message : "not supported" });
  }
  const npm = run(platform === "win32" ? "npm.cmd" : "npm", ["--version"]);
  checks.push({ name: "npm (supervised updates)", ok: npm.ok, required: false, detail: npm.ok ? npm.output.split("\n")[0] : "npm is not available: updates cannot be installed" });
  const git = run("git", ["--version"]);
  checks.push({ name: "git (GitHub books)", ok: git.ok, required: false, detail: git.ok ? git.output.split("\n")[0] : "git is not available: only local books" });
  if (platform === "linux") {
    const flock = run("flock", ["--version"]);
    checks.push({ name: "flock (data folder lock)", ok: flock.ok, required: true, detail: flock.ok ? flock.output.split("\n")[0] : "install util-linux (flock)" });
  } else if (platform === "win32") {
    const powershell = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
    checks.push({ name: "PowerShell (lock and vault)", ok: powershell.ok, required: true, detail: powershell.ok ? powershell.output.split("\n")[0] : "PowerShell is not available" });
  }
  const cloudflared = run(platform === "win32" ? "cloudflared.exe" : "cloudflared", ["--version"]);
  const version = cloudflared.ok ? parseCloudflaredVersion(cloudflared.output) : undefined;
  checks.push({ name: "cloudflared (optional remote access)", ok: Boolean(version), required: false, detail: version ? version.join(".") : "not installed (needed only for a Cloudflare tunnel)" });
  let writable = false;
  try {
    if (existsSync(dataRoot)) accessSync(dataRoot, constants.W_OK);
    else accessSync(path.dirname(dataRoot), constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  checks.push({ name: "Data folder", ok: writable, required: true, detail: `${dataRoot}${writable ? "" : " is not writable"}` });
  return checks;
}

async function serverRunning(apiPort: number): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1/info`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return undefined;
    const info = await response.json() as { name?: unknown; serverVersion?: unknown };
    return info.name === PACKAGE_NAME && typeof info.serverVersion === "string" ? info.serverVersion : undefined;
  } catch {
    return undefined;
  }
}

/** Run the server process of this package directly (no supervisor, no remote updates). */
function runDirect(dataRoot: string, verbose: boolean): Promise<number> {
  const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.NARRARIUM_SUPERVISED;
    const child = spawn(process.execPath, [serverPath, "--data-root", dataRoot, ...(verbose ? ["--verbose"] : [])], { stdio: "inherit", env, windowsHide: false });
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    child.once("exit", (code, signal) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(code ?? (signal ? 1 : 0));
    });
    child.once("error", () => resolve(1));
  });
}

/**
 * What `start` does before it supervises: a verified runtime must exist, and this CLI's own version replaces an older
 * active one. It never installs an older version than the data folder has run: that is refused (`RollbackRefusedError`),
 * not hidden behind the direct mode. Any other failure keeps the runtime that exists, or falls back to the direct mode.
 */
export async function prepareRuntime(installer: RuntimeInstaller, version: string, say: (line: string) => void): Promise<"supervised" | "direct"> {
  try {
    const active = await installer.activeRuntime().catch(() => undefined);
    if (!active || compareSemver(version, active.version) > 0) {
      say(active ? `Installing the verified runtime ${version} (was ${active.version})…` : `Preparing the verified runtime ${version} in ${installer.dataRoot}…`);
      await installer.installVersion(version, { bootstrapRegistryRelease: true });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (await installer.activeRuntime().catch(() => undefined)) {
      say(`Keeping the installed runtime: ${reason}`);
      return "supervised";
    }
    if (error instanceof RollbackRefusedError) throw error;
    say(`The verified runtime could not be prepared (${reason}).`);
    say("Starting directly instead: everything works, but the server cannot be updated remotely.");
    return "direct";
  }
  return "supervised";
}

/** What `main` is given besides the command line (tests give it a fake npm, a fake registry and a place to read the output). */
export interface CliDependencies {
  createInstaller?: (dataRoot: string) => RuntimeInstaller;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** The refusal to install something older, with what to do when the CLI itself is the older one. */
function olderCli(error: unknown, command: string): unknown {
  if (!(error instanceof RollbackRefusedError)) return error;
  return new Error(`${error.message} This command is ${SERVER_VERSION}: run \`npx ${PACKAGE_NAME}@latest ${command}\` for the newest version${command === "start" ? ", or add --direct to run this copy without the supervisor" : ""}.`);
}

export async function main(argv: readonly string[] = process.argv.slice(2), environment: NodeJS.ProcessEnv = process.env, dependencies: CliDependencies = {}): Promise<number> {
  const write = dependencies.stdout ?? ((text: string) => void process.stdout.write(text));
  const writeError = dependencies.stderr ?? ((text: string) => void process.stderr.write(text));
  const say = (line = "") => write(`${line}\n`);
  let parsed: ParsedCommand;
  try {
    parsed = parseCommand(argv);
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : "Invalid command."}\n`);
    return 2;
  }
  if (parsed.command === "help") {
    say(HELP.trimEnd());
    return 0;
  }
  if (parsed.command === "version") {
    say(SERVER_VERSION);
    return 0;
  }
  const dataRoot = path.resolve(parsed.dataRoot ?? resolveDataRoot(environment));
  const installer = dependencies.createInstaller?.(dataRoot) ?? new RuntimeInstaller({ dataRoot });
  try {
    if (parsed.command === "start") {
      const required = doctorChecks(dataRoot).filter((check) => check.required && !check.ok);
      if (required.length) throw new Error(required.map((check) => `${check.name}: ${check.detail}`).join("; "));
      const config = await loadServerConfig(dataRoot, { label: parsed.label, apiPort: parsed.apiPort, adminPort: parsed.adminPort, origins: parsed.origins });
      const running = await serverRunning(config.apiPort);
      if (running) throw new Error(`A narrarium-server ${running} already answers on port ${config.apiPort}. Stop it first or use --port.`);
      if (parsed.direct) return await runDirect(dataRoot, Boolean(parsed.verbose));
      let mode: "supervised" | "direct";
      try {
        mode = await prepareRuntime(installer, SERVER_VERSION, say);
      } catch (error) {
        throw olderCli(error, "start");
      }
      if (mode === "direct") return await runDirect(dataRoot, Boolean(parsed.verbose));
      const exit = await superviseServer({ installer, currentVersion: SERVER_VERSION, childArgs: parsed.verbose ? ["--verbose"] : [], forwardSignals: true, log: (line) => say(`[supervisor] ${line}`) });
      if (exit.code !== null) return exit.code;
      return exit.signal ? 1 : 0;
    }
    if (parsed.command === "setup") {
      assertSupportedNode();
      const config = await loadServerConfig(dataRoot, { label: parsed.label, apiPort: parsed.apiPort, adminPort: parsed.adminPort });
      const active = await installer.installVersion(SERVER_VERSION, { bootstrapRegistryRelease: true }).catch((error) => {
        throw olderCli(error, "setup");
      });
      say(`Narrarium personal server ${active.version} installed in ${dataRoot}.`);
      if (parsed.autostart) {
        const configured = await configureAutostart(active, dataRoot, environment);
        say(configured.message);
        say(`Service file: ${configured.servicePath}`);
      } else {
        say(`Start it with: npx ${PACKAGE_NAME} start${parsed.dataRoot ? ` --data-root "${dataRoot}"` : ""}`);
      }
      say(`API: http://127.0.0.1:${config.apiPort} · admin panel: http://127.0.0.1:${config.adminPort} (open it on this computer).`);
      say(`Admin code: npx ${PACKAGE_NAME} admin-code${parsed.dataRoot ? ` --data-root "${dataRoot}"` : ""}`);
      return 0;
    }
    if (parsed.command === "status") {
      const config = await loadServerConfig(dataRoot);
      const state = await installer.installerState().catch(() => undefined);
      const active = await installer.activeRuntime().catch(() => undefined);
      const highest = await installer.highestVersion().catch(() => null);
      const running = await serverRunning(config.apiPort);
      say(`Package:        ${PACKAGE_NAME} ${SERVER_VERSION}`);
      say(`Data folder:    ${dataRoot}`);
      say(`Active runtime: ${active?.version ?? state?.activeVersion ?? "not installed (run setup or start)"}`);
      say(`Highest ever:   ${highest === null ? "unreadable (see private/npm-highest.json)" : highest ? `${highest} (nothing older is installed from npm)` : "none yet"}`);
      say(`Running:        ${running ? `yes, version ${running} on port ${config.apiPort}` : "no"}`);
      say(`API:            http://127.0.0.1:${config.apiPort}`);
      say(`Admin panel:    http://127.0.0.1:${config.adminPort}`);
      say(`Autostart:      ${await autostartStatus(environment.HOME) ?? "not configured"}`);
      return 0;
    }
    if (parsed.command === "doctor") {
      const checks = doctorChecks(dataRoot);
      for (const check of checks) say(`${check.ok ? "OK  " : check.required ? "FAIL" : "WARN"} ${check.name}: ${check.detail}`);
      const active = await installer.activeRuntime().catch(() => undefined);
      say(`${active ? "OK  " : "WARN"} Runtime: ${active?.version ?? "not installed yet (start installs it)"}`);
      return checks.every((check) => check.ok || !check.required) ? 0 : 1;
    }
    if (parsed.command === "admin-code") {
      const config = await loadServerConfig(dataRoot);
      say(`Admin code (local secret): ${await readAdminCode(dataRoot)}`);
      say(`Open http://127.0.0.1:${config.adminPort} on this computer and sign in with it. Never paste it in public places.`);
      return 0;
    }
    if (parsed.command === "rotate-admin-code") {
      const config = await loadServerConfig(dataRoot);
      const code = await rotateLocalAdminCode({ dataRoot, adminPort: config.adminPort });
      say("The previous admin code no longer works.");
      say(`New admin code: ${code}`);
      return 0;
    }
    if (parsed.command === "set-admin-code") {
      const config = await loadServerConfig(dataRoot);
      const code = parsed.codeFile ? await readAdminCodeFile(path.resolve(parsed.codeFile)) : await readSecretFromTerminal("New admin code (32-200 characters): ");
      await setLocalAdminCode({ dataRoot, adminPort: config.adminPort, code });
      say("The new admin code is active; previous admin sessions ended.");
      return 0;
    }
    if (parsed.command === "client-token") {
      const config = await loadServerConfig(dataRoot);
      const result = await requestLocalClientToken({ dataRoot, adminPort: config.adminPort, label: parsed.label ?? "Narrarium", scopes: parsed.scopes ?? ["read", "write", "run"] });
      say(`Client token (shown once): ${result.token}`);
      say(`Paste it in Narrarium → Settings → Personal server with the address http://127.0.0.1:${config.apiPort}. Never share it.`);
      return 0;
    }
    if (parsed.command === "spend") {
      const config = await loadServerConfig(dataRoot);
      const options = { dataRoot, adminPort: config.adminPort };
      for (const line of describeSpend(parsed.spend ? await updateLocalSpend(options, parsed.spend) : await readLocalSpend(options))) say(line);
      return 0;
    }
    if (parsed.command === "update") {
      assertSupportedNode();
      const previous = await installer.activeRuntime().catch(() => undefined);
      const active = await installer.installVersion(parsed.requestedVersion ?? "latest");
      say(`Runtime ${previous?.version ?? "(none)"} → ${active.version}. A running server keeps its version until it restarts; under the supervisor, update from Narrarium or the admin panel instead.`);
      return 0;
    }
    if (parsed.command === "rollback") {
      assertSupportedNode();
      const previous = await installer.activeRuntime().catch(() => undefined);
      const active = await installer.rollbackTo(parsed.requestedVersion as string);
      const highest = await installer.highestVersion().catch(() => undefined);
      say(`Runtime ${previous?.version ?? "(none)"} → ${active.version}: a copy that was already installed (nothing was downloaded). A running server keeps its version until it restarts.`);
      if (highest && compareSemver(highest, active.version) > 0) {
        say(`Nothing below ${highest} is installed from npm. Until a fixed release exists, start the server with \`npx ${PACKAGE_NAME}@${active.version} start\`: the CLI of a newer version installs itself at start.`);
      }
      return 0;
    }
    return 2;
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : "Unexpected error."}\n`);
    return 1;
  }
}

/** Read a secret from the terminal without echoing it. */
async function readSecretFromTerminal(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) throw new Error("An interactive terminal is needed; otherwise use --code-file with a private (0600) file.");
  const chunks: number[] = [];
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    for await (const chunk of process.stdin) {
      for (const byte of Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))) {
        if (byte === 3) throw new Error("Cancelled.");
        if (byte === 10 || byte === 13) {
          process.stdout.write("\n");
          return Buffer.from(chunks).toString("utf8");
        }
        if (byte === 8 || byte === 127) {
          if (chunks.length) {
            chunks.pop();
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (byte < 32) continue;
        chunks.push(byte);
        process.stdout.write("*");
        if (chunks.length > 200) throw new Error("The code is longer than 200 characters.");
      }
    }
    throw new Error("The input ended before Enter.");
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export { DEFAULT_SERVER_PORT };
