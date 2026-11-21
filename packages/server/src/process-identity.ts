import { execFile, type ExecFileException } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";

/**
 * Who a process id belongs to, in a form that tells two processes with the same id apart: the id of a process that ended can be given
 * to another one, so "this id is alive" proves nothing about the process a file once recorded. `start` never repeats for one id (it
 * is the moment the process started, with the boot it started in); `name` is the program's own name; `command` its arguments.
 */
export interface ProcessIdentity {
  start: string;
  name: string;
  command: string;
}

/** Run a program without a shell and return what it printed (empty when it fails or takes longer than `timeoutMs`). */
function capture(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } }, (error: ExecFileException | null, stdout) => {
        resolve(error ? "" : String(stdout));
      });
    } catch {
      resolve("");
    }
  });
}

async function linuxIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  let stat: string;
  try {
    stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  // `pid (name) state ppid ...`: the name may hold spaces and parentheses, so it is everything between the first "(" and the last ")".
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const fields = stat.slice(close + 2).split(" ");
  const state = fields[0];
  const ticks = fields[19];
  // A zombie has ended: it only waits for its parent to collect it.
  if (!ticks || state === "Z" || state === "X") return undefined;
  const boot = await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8").then((text) => text.trim(), () => "");
  const command = await fs.readFile(`/proc/${pid}/cmdline`).then((bytes) => bytes.toString("utf8").split("\0").join(" ").trim(), () => "");
  return { start: `${boot}:${ticks}`, name: stat.slice(open + 1, close), command };
}

async function psIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  const column = (name: string) => capture("ps", ["-o", `${name}=`, "-p", String(pid)], 5_000).then((text) => text.trim());
  const [start, state, name, command] = await Promise.all([column("lstart"), column("stat"), column("comm"), column("args")]);
  if (!start || state.startsWith("Z")) return undefined;
  return { start, name: path.basename(name), command };
}

async function windowsIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { [pscustomobject]@{ start = $p.CreationDate.ToUniversalTime().ToString('o'); name = $p.Name; command = [string]$p.CommandLine } | ConvertTo-Json -Compress }`;
  const output = await capture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 15_000);
  try {
    const value = JSON.parse(output.trim()) as { start?: unknown; name?: unknown; command?: unknown };
    return typeof value.start === "string" && value.start && typeof value.name === "string" ? { start: value.start, name: value.name, command: typeof value.command === "string" ? value.command : "" } : undefined;
  } catch {
    return undefined;
  }
}

/** The identity of a running process, or `undefined` when there is none with this id (or this system cannot say). */
export async function processIdentity(pid: number, platform: NodeJS.Platform = process.platform): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform === "linux") return linuxIdentity(pid);
  if (platform === "win32") return windowsIdentity(pid);
  return psIdentity(pid);
}

/** Whether a process with this id exists (it says nothing about which program it is). */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
