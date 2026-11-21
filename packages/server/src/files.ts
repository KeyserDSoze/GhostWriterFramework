import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { processAlive, processIdentity } from "./process-identity.js";

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

/** Flush a directory (what was created, renamed or removed in it) to disk. Windows cannot open a directory: nothing to do there. */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    // Some file systems (network and FUSE mounts) cannot flush a folder: there is nothing more to ask of them. A real I/O error is raised.
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
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

const HELD_LOCKS = new Set<string>();

/** What a lock file says: who holds it, and when that process started (so that a reused number is not mistaken for the holder). */
interface LockRecord {
  pid: number;
  /** The start of the holder's process (see `processIdentity`); absent in the lock files of earlier versions, which held the number only. */
  start?: string;
  token?: string;
  /** The file holds a bare number (an earlier version). */
  legacy?: boolean;
  /** The file is empty, cut short or not a lock file: it is judged by its age. */
  damaged?: boolean;
}

export interface LockOptions {
  /** `kernel`: a `flock` (Linux) or a named mutex (Windows) that a crashed process cannot leave behind. `pidfile`: a lock file (macOS, anywhere else). Default: by system. */
  method?: "kernel" | "pidfile";
  /** How often a pid-file lock checks that it is still its own (default two seconds). */
  checkMs?: number;
  /** How old an unreadable lock file must be before it is taken over (default ten seconds): a fresh one may be being written. */
  damagedAfterMs?: number;
}

async function readLockRecord(file: string): Promise<LockRecord | undefined> {
  let text: string;
  try {
    text = (await fs.readFile(file, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (/^\d{1,10}$/.test(text)) return { pid: Number(text), legacy: true };
  try {
    const value = JSON.parse(text) as { version?: unknown; pid?: unknown; start?: unknown; token?: unknown };
    if (value.version === 1 && Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.token === "string") {
      return { pid: value.pid as number, token: value.token, ...(typeof value.start === "string" && value.start ? { start: value.start } : {}) };
    }
  } catch {
    // Not JSON: damaged.
  }
  return { pid: 0, damaged: true };
}

/**
 * Whether the process a lock names is still the one that wrote it. A number that is alive proves nothing (numbers are given again);
 * the process must have started when the lock says. When the system cannot say who a process is, a live number is believed.
 */
async function holderIsRunning(record: LockRecord): Promise<boolean> {
  if (!record.pid || !processAlive(record.pid)) return false;
  const current = await processIdentity(record.pid).catch(() => undefined);
  if (!current) return true;
  if (record.start) return current.start === record.start;
  // An earlier version's file has the number only: a program that is not node cannot be a narrarium-server.
  return /node/i.test(current.name);
}

/**
 * Hard-link `from` to `to`: the lock appears with its whole content or not at all, and only one of several that try wins.
 * Where links are not available a plain exclusive create is the next best thing.
 */
async function createLock(lock: string, record: Required<Pick<LockRecord, "pid" | "token">> & { start?: string }): Promise<boolean> {
  const content = `${JSON.stringify({ version: 1, pid: record.pid, ...(record.start ? { start: record.start } : {}), token: record.token })}\n`;
  const temporary = `${lock}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    try {
      await fs.link(temporary, lock);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (!["EPERM", "ENOSYS", "EXDEV", "EOPNOTSUPP", "EMLINK"].includes(code ?? "")) throw error;
    }
    try {
      await fs.writeFile(lock, content, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Lock file with the owner's pid and the time that process started, for systems that have no kernel lock to use. The lock is created
 * whole (never an empty file another server could take for a stale one), a lock whose holder is gone or is another program with the
 * same number is taken over by one server at a time (a second lock, a folder, guards the taking over), and the holder looks at its
 * own lock every few seconds: if it is gone or is somebody else's, `onLost` says so.
 */
async function pidLock(root: string, onLost: () => void, options: LockOptions): Promise<() => Promise<void>> {
  const lock = path.join(root, "server.lock");
  const guard = `${lock}.takeover`;
  const token = randomUUID();
  const start = (await processIdentity(process.pid).catch(() => undefined))?.start;
  const mine = { pid: process.pid, token, ...(start ? { start } : {}) };
  const damagedAfterMs = options.damagedAfterMs ?? 10_000;
  const alreadyUsed = (holder: LockRecord) => new Error(`Another narrarium-server (pid ${holder.pid}) is already using ${root}.`);

  const acquire = async (): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await createLock(lock, mine)) return;
      const holder = await readLockRecord(lock).catch(() => undefined);
      if (!holder) continue;
      if (holder.damaged) {
        const age = Date.now() - (await fs.stat(lock).then((info) => info.mtimeMs, () => 0));
        if (age < damagedAfterMs) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
      } else if (await holderIsRunning(holder)) {
        throw alreadyUsed(holder);
      }
      // The holder is gone (or never was one). One server at a time takes the lock over, and looks again inside: what it found
      // may have been replaced by a server that started a moment ago.
      try {
        await fs.mkdir(guard, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = Date.now() - (await fs.stat(guard).then((info) => info.mtimeMs, () => Date.now()));
        if (age > 10_000) await fs.rmdir(guard).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 60)));
        continue;
      }
      let wait = false;
      try {
        const current = await readLockRecord(lock).catch(() => undefined);
        if (current?.damaged && Date.now() - (await fs.stat(lock).then((info) => info.mtimeMs, () => 0)) < damagedAfterMs) {
          // Replaced by a file that is being written right now: not ours to take.
          wait = true;
        } else {
          if (current && !current.damaged && await holderIsRunning(current)) throw alreadyUsed(current);
          if (current) await fs.rm(lock, { force: true });
          if (await createLock(lock, mine)) return;
        }
      } finally {
        await fs.rmdir(guard).catch(() => undefined);
      }
      if (wait) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Could not lock ${root}.`);
  };
  await acquire();

  let released = false;
  let lost = false;
  const check = async () => {
    if (released || lost) return;
    let holder: LockRecord | undefined;
    try {
      holder = await readLockRecord(lock);
    } catch {
      return;
    }
    if (holder?.token === token || released || lost) return;
    lost = true;
    clearInterval(timer);
    onLost();
  };
  const timer = setInterval(() => void check(), options.checkMs ?? 2_000);
  timer.unref();
  return async () => {
    released = true;
    clearInterval(timer);
    const holder = await readLockRecord(lock).catch(() => undefined);
    if (holder?.token === token) await fs.rm(lock, { force: true });
  };
}

/**
 * One server per data folder. Linux uses a kernel `flock`, Windows a named mutex, so a crashed
 * process never leaves a stale lock; other systems use a pid lock file.
 */
export async function lockDataRoot(root: string, onLost: () => void = () => { process.exitCode = 1; }, options: LockOptions = {}): Promise<() => Promise<void>> {
  const resolved = await ensurePrivateDirectory(root);
  const real = await fs.realpath(resolved);
  if (HELD_LOCKS.has(real)) throw new Error(`Another narrarium-server in this process is already using ${root}.`);
  let release: () => Promise<void>;
  const method = options.method ?? (process.platform === "win32" || process.platform === "linux" ? "kernel" : "pidfile");
  if (method === "kernel" && (process.platform === "win32" || process.platform === "linux")) {
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
      // A helper that was killed (a signal, not an exit code) is gone too: its exit event has passed, so waiting for it would never end.
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((done) => {
        child.once("exit", () => done());
        child.stdin?.end();
      });
    };
  } else {
    release = await pidLock(real, onLost, options);
  }
  HELD_LOCKS.add(real);
  return async () => {
    HELD_LOCKS.delete(real);
    await release();
  };
}
