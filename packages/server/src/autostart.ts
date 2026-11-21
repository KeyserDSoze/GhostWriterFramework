import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ActiveRuntime } from "./runtime-install.js";

export interface AutostartResult {
  kind: "systemd-user" | "launchd";
  servicePath: string;
  activeVersion: string;
  message: string;
}

export const SYSTEMD_UNIT = "narrarium-server.service";
export const LAUNCHD_LABEL = "net.narrarium.server";

/**
 * Every value written into a unit or a plist goes through here: a control character (a line break above all) would start a new
 * directive, and a character that XML 1.0 does not allow (U+FFFE, U+FFFF, half of a surrogate pair) would make a plist that launchd
 * does not read.
 */
function plain(value: string, what: string): string {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) throw new Error(`The ${what} contains a control character, so it cannot be written into the autostart file.`);
  if (/[\uFFFE\uFFFF]/u.test(value) || (value as { isWellFormed?: () => boolean }).isWellFormed?.() === false) throw new Error(`The ${what} contains a character that cannot be written into the autostart file.`);
  return value;
}

/** A word of `ExecStart=`: quoted, with `\`, `"`, `%` (specifiers) and `$` (variables) written the way systemd reads them literally. */
function systemdQuote(value: string): string {
  return `"${value.replace(/([%$\\"])/g, (char) => (char === "%" ? "%%" : char === "$" ? "$$" : `\\${char}`))}"`;
}

/** A whole `Environment=` assignment: quoted, `\`, `"` and `%` escaped; `$` has no meaning there. */
function systemdAssignment(name: string, value: string): string {
  return `Environment="${name}=${value.replace(/([%\\"])/g, (char) => (char === "%" ? "%%" : `\\${char}`))}"`;
}

/**
 * The PATH of the shell that ran `setup` (npm, git and cloudflared installed through nvm or Homebrew are found there and
 * nowhere else), led by the folder of the node that runs the supervisor. Only absolute entries are kept: a relative one (`.`, `bin`)
 * would be looked up in whatever folder the service happens to start in.
 */
function supervisorSearchPath(nodeBinary: string, searchPath: string | undefined): string {
  const nodeDirectory = path.dirname(nodeBinary);
  const entries = plain(searchPath ?? "", "PATH").split(":").filter((entry) => entry.startsWith("/"));
  return (entries.includes(nodeDirectory) ? entries : [nodeDirectory, ...entries]).join(":");
}

/** The command that runs the supervisor of one data folder, with every part checked. */
function supervisorCommand(active: ActiveRuntime, dataRoot: string, nodeBinary: string): string[] {
  return [plain(path.resolve(nodeBinary), "node binary"), plain(path.resolve(active.packageRoot, "dist", "cli.mjs"), "runtime folder"), "start", "--data-root", plain(path.resolve(dataRoot), "data folder")];
}

/** systemd user unit running the supervisor of this data folder. */
export function renderUserService(active: ActiveRuntime, dataRoot: string, nodeBinary = process.execPath, searchPath: string | undefined = process.env.PATH): string {
  const [node, cli, start, flag, data] = supervisorCommand(active, dataRoot, nodeBinary);
  const exec = [systemdQuote(node), systemdQuote(cli), start, flag, systemdQuote(data)].join(" ");
  return `[Unit]
Description=Narrarium personal server
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
${systemdAssignment("PATH", supervisorSearchPath(node, searchPath))}
ExecStart=${exec}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** launchd agent running the supervisor at login (macOS). */
export function renderLaunchAgent(active: ActiveRuntime, dataRoot: string, nodeBinary = process.execPath, searchPath: string | undefined = process.env.PATH): string {
  const args = supervisorCommand(active, dataRoot, nodeBinary);
  const log = path.join(args[4], "server.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(supervisorSearchPath(args[0], searchPath))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { shell: false, windowsHide: true, encoding: "utf8", env, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * Start the server automatically for this user and this data folder: a systemd user unit on Linux,
 * a launchd agent on macOS. It never touches another service.
 */
export async function configureAutostart(active: ActiveRuntime, dataRoot: string, environment: NodeJS.ProcessEnv = process.env): Promise<AutostartResult> {
  const uid = process.getuid?.();
  if (uid === 0) throw new Error("Do not install autostart as root: run the command as the user who owns the server and its data.");
  const home = environment.HOME ?? homedir();
  if (process.platform === "linux") {
    const runtimeDir = environment.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : "");
    const env = { ...environment, HOME: home, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS ?? (runtimeDir ? `unix:path=${path.join(runtimeDir, "bus")}` : "") };
    const systemctl = environment.NARRARIUM_SYSTEMCTL || "systemctl";
    const configDir = path.join(home, ".config", "systemd", "user");
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    const servicePath = path.join(configDir, SYSTEMD_UNIT);
    await fs.writeFile(servicePath, renderUserService(active, dataRoot, process.execPath, environment.PATH), { mode: 0o600 });
    if (!run(systemctl, ["--user", "daemon-reload"], env).ok) throw new Error("The service was written, but systemd --user does not answer. Run the command from a real user session or set XDG_RUNTIME_DIR.");
    if (!run(systemctl, ["--user", "enable", "--now", SYSTEMD_UNIT], env).ok) throw new Error(`The service was written but could not be enabled. Check: systemctl --user status ${SYSTEMD_UNIT}`);
    const user = environment.USER ?? String(uid);
    const linger = spawnSync("loginctl", ["show-user", user, "-p", "Linger", "--value"], { shell: false, encoding: "utf8", env }).stdout?.trim();
    return {
      kind: "systemd-user",
      servicePath,
      activeVersion: active.version,
      message: linger === "yes"
        ? "User service enabled and started; it also starts after a reboot."
        : `User service started. To start it after a reboot without logging in, an administrator must run: sudo loginctl enable-linger ${user}`,
    };
  }
  if (process.platform === "darwin") {
    const agents = path.join(home, "Library", "LaunchAgents");
    await fs.mkdir(agents, { recursive: true });
    const servicePath = path.join(agents, `${LAUNCHD_LABEL}.plist`);
    await fs.writeFile(servicePath, renderLaunchAgent(active, dataRoot, process.execPath, environment.PATH), { mode: 0o644 });
    const launchctl = environment.NARRARIUM_LAUNCHCTL || "launchctl";
    const domain = `gui/${uid ?? ""}`;
    run(launchctl, ["bootout", `${domain}/${LAUNCHD_LABEL}`], environment);
    if (!run(launchctl, ["bootstrap", domain, servicePath], environment).ok) throw new Error(`The launch agent was written but could not be loaded. Try: launchctl bootstrap ${domain} "${servicePath}"`);
    return { kind: "launchd", servicePath, activeVersion: active.version, message: "Launch agent loaded: the server starts at every login." };
  }
  throw new Error("Automatic start is available on Linux (systemd) and macOS (launchd). On Windows, add `npx narrarium-server start` to Task Scheduler at logon.");
}

/** Where the autostart file of this user is, if any. */
export async function autostartStatus(home = homedir(), platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const file = platform === "darwin" ? path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`) : path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
  try {
    await fs.stat(file);
    return file;
  } catch {
    return undefined;
  }
}
