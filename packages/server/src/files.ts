import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

export const MAX_DATA_FILE_BYTES = 64 * 1024 * 1024;

/** Objects whose keys could pollute prototypes are refused wherever JSON comes from disk or the network. */
export function unsafeKeys(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => key === "__proto__" || key === "constructor" || key === "prototype" || unsafeKeys(entry, depth + 1));
}

/** Read a regular JSON file (no links, bounded size); `undefined` when it does not exist. */
export async function readJson(file: string, max = MAX_DATA_FILE_BYTES): Promise<unknown | undefined> {
  let handle: fs.FileHandle;
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max) throw new Error(`${path.basename(file)} is not a regular file or is too large.`);
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) {
      await handle.close();
      throw new Error(`${path.basename(file)} changed while it was read.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const bytes = await handle.readFile();
    if (bytes.byteLength > max) throw new Error(`${path.basename(file)} is too large.`);
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (unsafeKeys(data)) throw new Error(`${path.basename(file)} contains keys that are not allowed.`);
    return data;
  } finally {
    await handle.close();
  }
}

/** Windows briefly refuses to replace a file another handle has open; the rename itself stays atomic. */
export async function renameReplacing(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 12 || process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      await new Promise((done) => setTimeout(done, 15 * (attempt + 1)));
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Write bytes through a private temporary file, fsync and rename: readers never see a partial file. */
export async function atomicWrite(file: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  if (bytes.byteLength > MAX_DATA_FILE_BYTES) throw new Error(`${path.basename(file)} would be larger than the safety limit; nothing was written.`);
  const parent = path.dirname(file);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error(`${parent} is not a safe directory.`);
  try {
    const existing = await fs.lstat(file);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error(`${path.basename(file)} is not a regular file.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${file}.new-${randomUUID()}`;
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await renameReplacing(temporary, file);
    await syncDirectory(parent);
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function atomicJson(file: string, value: unknown, mode = 0o600): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Create (or check) a directory readable only by the server's user. */
export async function ensurePrivateDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${resolved} must be a directory, not a link.`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) await fs.chmod(resolved, 0o700);
  return resolved;
}

/** Read a small private text file (mode 0600 on POSIX, no links). */
export async function readPrivateText(file: string, max = 4096): Promise<string | undefined> {
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error(`${path.basename(file)} must be a private regular file (mode 0600).`);
  }
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`${path.basename(file)} changed while it was read.`);
    return new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
  } finally {
    await handle.close();
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const HELD_LOCKS = new Set<string>();

/** Lock file with the owner's pid, taken over only from a dead process (macOS and other systems). */
async function pidLock(root: string): Promise<() => Promise<void>> {
  const lock = path.join(root, "server.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lock, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        await fs.rm(lock, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number((await fs.readFile(lock, "utf8").catch(() => "")).trim());
      if (pid && pid !== process.pid && processAlive(pid)) throw new Error(`Another narrarium-server (pid ${pid}) is already using ${root}.`);
      await fs.rm(lock, { force: true });
    }
  }
  throw new Error(`Could not lock ${root}.`);
}

/**
 * One server per data folder. Linux uses a kernel `flock`, Windows a named mutex, so a crashed
 * process never leaves a stale lock; other systems use a pid lock file.
 */
export async function lockDataRoot(root: string, onLost: () => void = () => { process.exitCode = 1; }): Promise<() => Promise<void>> {
  const resolved = await ensurePrivateDirectory(root);
  const real = await fs.realpath(resolved);
  if (HELD_LOCKS.has(real)) throw new Error(`Another narrarium-server in this process is already using ${root}.`);
  let release: () => Promise<void>;
  if (process.platform === "win32" || process.platform === "linux") {
    let child: ChildProcess;
    if (process.platform === "win32") {
      const name = `Global\\Narrarium-${createHash("sha256").update(real.toLowerCase()).digest("hex")}`;
      const script = `$m = New-Object System.Threading.Mutex($false, '${name}'); try { $ok=$m.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ok=$true }; if(-not $ok){exit 73}; [Console]::Out.WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null; $m.ReleaseMutex(); $m.Dispose()`;
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } else {
      child = spawn("flock", ["-n", "-E", "73", path.join(real, ".server.lock"), process.execPath, "-e", "process.stdout.write('LOCKED\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"], { stdio: ["pipe", "pipe", "ignore"] });
    }
    let released = false;
    let ready = false;
    child.once("exit", () => {
      if (ready && !released) onLost();
    });
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Could not lock the data folder in time."));
      }, 10_000);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error(process.platform === "win32" ? "Could not lock the data folder: PowerShell is not available." : "Could not lock the data folder: install `flock` (util-linux)."));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Another narrarium-server is already using ${root}.`));
      });
      let received = "";
      child.stdout?.on("data", (chunk) => {
        if (ready) return;
        received += String(chunk);
        if (!received.includes("\n") && received.length < 100) return;
        clearTimeout(timer);
        if (received.trim() !== "LOCKED") {
          child.kill();
          reject(new Error("The data folder lock was not confirmed."));
        } else {
          ready = true;
          accept();
        }
      });
    });
    release = async () => {
      released = true;
      if (child.exitCode !== null) return;
      await new Promise<void>((done) => {
        child.once("exit", () => done());
        child.stdin?.end();
      });
    };
  } else {
    release = await pidLock(real);
  }
  HELD_LOCKS.add(real);
  return async () => {
    HELD_LOCKS.delete(real);
    await release();
  };
}
