import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

/** A secret encrypted by the server's vault. */
export interface EncryptedSecret {
  iv: string;
  data: string;
}

const AAD = Buffer.from("narrarium-server-v1");

export function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  const record = value as Partial<EncryptedSecret> | null;
  return Boolean(record && typeof record === "object" && typeof record.iv === "string" && typeof record.data === "string" && record.iv.length <= 64 && record.data.length <= 2_000_000);
}

/** Windows keeps the vault key protected by DPAPI for the current user. */
async function dpapi(value: Buffer, protect: boolean): Promise<Buffer> {
  const method = protect ? "Protect" : "Unprotect";
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadLine()); $o=[Security.Cryptography.ProtectedData]::${method}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
  return new Promise((accept, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let result = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The Windows vault (DPAPI) did not answer."));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      result += String(chunk);
      if (result.length > 4096) child.kill();
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("The Windows vault (DPAPI) is not available."));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) accept(Buffer.from(result, "base64"));
      else reject(new Error("The vault key cannot be read by this Windows user."));
    });
    child.stdin.end(`${value.toString("base64")}\n`);
  });
}

/** Files of `private/` that hold something this vault encrypted: without the key they can never be read again. */
const ENCRYPTED_FILES = ["identity.json", "ai.json", "book-tokens.json", "cloudflare-tunnel-token.json", "authorization.json"];

function holdsEncryptedSecret(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.iv === "string" && typeof record.data === "string") return true;
  return Object.values(record).some((entry) => holdsEncryptedSecret(entry, depth + 1));
}

/** The files of the private folder that hold encrypted secrets (one that cannot be read or understood is counted: when in doubt, it may). */
async function encryptedFilesIn(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of ENCRYPTED_FILES) {
    let text: string;
    try {
      text = await fs.readFile(path.join(directory, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") found.push(name);
      continue;
    }
    try {
      if (holdsEncryptedSecret(JSON.parse(text))) found.push(name);
    } catch {
      found.push(name);
    }
  }
  return found;
}

/**
 * AES-256-GCM vault for AI keys, GitHub tokens and the server's identity key. The 32-byte key lives
 * in `private/master.key` (0600; DPAPI-protected on Windows). It is never regenerated silently: a missing key is created only when
 * nothing encrypted exists, and a copy is kept next to it (`master.key.bak`, never overwritten) for the day the key file is lost.
 */
export class Vault {
  private constructor(private readonly key: Buffer) {}

  static async open(root: string): Promise<Vault> {
    const directory = path.join(root, "private");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (process.platform !== "win32" && (directoryStat.mode & 0o077) !== 0)) {
      throw new Error("The private folder of the server is not safe (it must be a 0700 directory).");
    }
    const file = path.join(directory, "master.key");
    const backup = `${file}.bak`;
    let key: Buffer;
    let stored: Buffer;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
        throw new Error("The vault key file is not private (it must be a 0600 regular file).");
      }
      stored = await fs.readFile(file);
      key = process.platform === "win32" ? await dpapi(stored, false) : stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A key that is gone while something encrypted with it is still here: a new one would make that unreadable for good.
      const locked = await encryptedFilesIn(directory);
      if (locked.length) {
        const copy = await fs.stat(backup).then(() => true, () => false);
        throw new Error(`The vault key (private/master.key) is missing, but encrypted secrets are still there (${locked.join(", ")}). The server will not create a new key: it would make them unreadable for good. ${copy ? "private/master.key.bak is a copy of the key: copy it over private/master.key and start again. " : "Put master.key back from a backup and start again. "}To start with no secrets instead, move those files out of the private folder first (devices must then pair again, and the AI configuration and the GitHub tokens must be sent again).`);
      }
      key = randomBytes(32);
      stored = process.platform === "win32" ? await dpapi(key, true) : key;
      await fs.writeFile(file, stored, { flag: "wx", mode: 0o600, flush: true });
    }
    if (key.length !== 32) throw new Error("The vault key is damaged; it is never regenerated automatically.");
    // The copy is made once and never replaced; losing it costs nothing, so a failure to write it does not stop the server.
    await fs.writeFile(backup, stored, { flag: "wx", mode: 0o600, flush: true }).catch(() => undefined);
    if (process.platform !== "win32") {
      const handle = await fs.open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return new Vault(key);
  }

  encrypt(text: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { iv: iv.toString("base64"), data: data.toString("base64") };
  }

  decrypt(value: EncryptedSecret): string {
    try {
      const data = Buffer.from(value.data, "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "base64"));
      decipher.setAAD(AAD);
      decipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("A secret stored by the server cannot be decrypted.");
    }
  }
}
