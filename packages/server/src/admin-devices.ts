import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { atomicJson, readJson, renameReplacing } from "./files.js";

/**
 * "Remember this device" for the admin panel. When the owner asks for it at sign-in, the server makes a random device token (256 bits), says it once, and keeps only its SHA-256, a
 * label made of the browser and the system (never the user agent itself), the time it was made and the time it was last used, in `private/admin-devices.json`. The page keeps the token
 * and signs in with it when its session ends; the admin code itself is never kept anywhere but the server's own file. The owner can revoke one device or all of them, and changing the
 * admin code revokes them all.
 */

export const DEVICES_FILE = "admin-devices.json";
/** Devices remembered at most: past this, a sign-in works but remembers nothing, and the owner revokes one first. */
export const MAX_ADMIN_DEVICES = 20;
export const DEVICE_TOKEN_PREFIX = "nrd_";
const MAX_DEVICE_FILE_BYTES = 1024 * 1024;
const MAX_LABEL_CHARACTERS = 60;
const MAX_TOKEN_CHARACTERS = 200;

export interface DeviceRecord {
  id: string;
  hash: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
}

/** What may be shown: never the hash, and the token is not kept at all. */
export type PublicDevice = Omit<DeviceRecord, "hash">;

/** A device that was just made: the only time its token exists outside the device. */
export interface DeviceGrant extends PublicDevice {
  token: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sameDigest = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

const BROWSERS: Array<[RegExp, string]> = [
  [/\b(?:Edg|EdgA|EdgiOS|Edge)\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:CriOS|Chrome|Chromium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

// An iPhone says "like Mac OS X" and an Android phone says "Linux": the more specific word comes first.
const SYSTEMS: Array<[RegExp, string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\b(?:Macintosh|Mac OS X)\b/, "macOS"],
  [/\b(?:Linux|X11)\b/, "Linux"],
];

/**
 * What the owner sees next to a remembered device: the browser and the system, in a few words chosen from a closed list ("Chrome · Windows"). Nothing else of the user agent is kept,
 * so what a client sends cannot reach the page or the file.
 */
export function deviceLabel(userAgent: unknown): string {
  const text = typeof userAgent === "string" ? userAgent.slice(0, 512) : "";
  const browser = BROWSERS.find(([pattern]) => pattern.test(text))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(text))?.[1];
  if (browser && system) return `${browser} · ${system}`;
  if (browser) return browser;
  return system ? `Unknown browser · ${system}` : "Unknown browser";
}

const isTime = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));

/** The devices of a file that this server wrote; anything else is a damaged file. */
function parseDevices(value: unknown): DeviceRecord[] {
  const record = value as { version?: unknown; devices?: unknown } | null;
  if (!record || typeof record !== "object" || record.version !== 1 || !Array.isArray(record.devices) || record.devices.length > MAX_ADMIN_DEVICES) throw new Error(`${DEVICES_FILE} is not valid.`);
  const seen = new Set<string>();
  return record.devices.map((entry: unknown) => {
    const device = entry as Partial<DeviceRecord> | null;
    if (!device || typeof device !== "object" || typeof device.id !== "string" || !device.id || device.id.length > 64 || seen.has(device.id) || typeof device.hash !== "string" || !/^[0-9a-f]{64}$/.test(device.hash)
      || typeof device.label !== "string" || device.label.length > MAX_LABEL_CHARACTERS || !isTime(device.createdAt) || !isTime(device.lastUsedAt)) {
      throw new Error(`${DEVICES_FILE} contains an invalid device.`);
    }
    seen.add(device.id);
    return { id: device.id, hash: device.hash, label: device.label, createdAt: device.createdAt, lastUsedAt: device.lastUsedAt };
  });
}

const publicOf = ({ hash: _hash, ...device }: DeviceRecord): PublicDevice => device;

/**
 * The remembered devices, in `private/admin-devices.json`. Every change is written before it is believed, so what the server holds is what the file holds. Callers serialize the changes (the
 * file is rewritten whole). A file that cannot be read never stops the server: the devices are forgotten (nobody is let in on a doubtful record), the file is kept aside as `.damaged`,
 * and `warning` says so.
 */
export class DeviceStore {
  private constructor(private readonly file: string, private records: DeviceRecord[], readonly warning?: string) {}

  static async open(root: string): Promise<DeviceStore> {
    const file = path.join(root, "private", DEVICES_FILE);
    try {
      const stored = await readJson(file, MAX_DEVICE_FILE_BYTES);
      return new DeviceStore(file, stored === undefined ? [] : parseDevices(stored));
    } catch {
      let kept = false;
      try {
        await renameReplacing(file, `${file}.damaged`);
        kept = true;
      } catch {
        await fs.unlink(file).catch(() => undefined);
      }
      const warning = `${DEVICES_FILE} could not be read, so no device is remembered any more${kept ? ` (the file was kept as ${DEVICES_FILE}.damaged)` : ""}.`;
      return new DeviceStore(file, [], warning);
    }
  }

  get count(): number {
    return this.records.length;
  }

  list(): PublicDevice[] {
    return this.records.map(publicOf);
  }

  /** The device that holds this token, if any: the digests are compared in constant time. */
  find(token: string): PublicDevice | undefined {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARACTERS) return undefined;
    const digest = sha256(token);
    let found: DeviceRecord | undefined;
    for (const record of this.records) if (sameDigest(record.hash, digest)) found = record;
    return found ? publicOf(found) : undefined;
  }

  private async save(next: DeviceRecord[]): Promise<void> {
    await atomicJson(this.file, { version: 1, devices: next });
    this.records = next;
  }

  /** A new device, or `undefined` when there are `MAX_ADMIN_DEVICES` already. */
  async add(label: string, now: number): Promise<DeviceGrant | undefined> {
    if (this.records.length >= MAX_ADMIN_DEVICES) return undefined;
    const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const at = new Date(now).toISOString();
    const record: DeviceRecord = { id: randomUUID(), hash: sha256(token), label: label.slice(0, MAX_LABEL_CHARACTERS), createdAt: at, lastUsedAt: at };
    await this.save([...this.records, record]);
    return { ...publicOf(record), token };
  }

  async touch(id: string, now: number): Promise<void> {
    const at = new Date(now).toISOString();
    if (!this.records.some((record) => record.id === id)) return;
    await this.save(this.records.map((record) => (record.id === id ? { ...record, lastUsedAt: at } : record)));
  }

  async remove(id: string): Promise<PublicDevice | undefined> {
    const removed = this.records.find((record) => record.id === id);
    if (!removed) return undefined;
    await this.save(this.records.filter((record) => record.id !== id));
    return publicOf(removed);
  }

  /** Forget every device; how many there were. */
  async clear(): Promise<number> {
    const count = this.records.length;
    if (count) await this.save([]);
    return count;
  }
}
