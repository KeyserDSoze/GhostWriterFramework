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

/**
 * AES-256-GCM vault for AI keys, GitHub tokens and the server's identity key. The 32-byte key lives
 * in `private/master.key` (0600; DPAPI-protected on Windows) and is never regenerated silently.
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
    let key: Buffer;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
        throw new Error("The vault key file is not private (it must be a 0600 regular file).");
      }
      const stored = await fs.readFile(file);
      key = process.platform === "win32" ? await dpapi(stored, false) : stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      key = randomBytes(32);
      await fs.writeFile(file, process.platform === "win32" ? await dpapi(key, true) : key, { flag: "wx", mode: 0o600, flush: true });
      if (process.platform !== "win32") {
        const handle = await fs.open(directory, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
    if (key.length !== 32) throw new Error("The vault key is damaged; it is never regenerated automatically.");
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
