import { appendFile, chmod, readFile, stat } from "node:fs/promises";
import { atomicWrite, unsafeKeys } from "./files.js";
import { KeyedMutex } from "./fs-store.js";

/**
 * The admin panel's action log: what the owner and the clients change on this server, one JSON line each in `admin-log.jsonl` of the data folder (private to the user that
 * runs the server). It is bounded like the MCP audit: the file is cut back when it grows past its limit, and each entry has a number that goes up and is never reused, so a
 * page of the log can say where it ends.
 *
 * It holds who (the owner, a client by the name its owner gave it, a device that asked to pair, nobody known), when, what (one of the actions below), on what (an id, never a
 * text), whether it worked and the short code of why not. It never holds a secret, a token, a prompt, the answer of a model or a text of a book: what is written is picked
 * field by field, and a text that a user wrote (a label) is cleaned and shortened as the MCP audit does.
 */

/** The kinds the panel's filter offers; every action belongs to one. */
export const ADMIN_ACTION_TYPES = ["access", "clients", "updates", "apps", "ai", "spend", "network", "books"] as const;
export type AdminActionType = (typeof ADMIN_ACTION_TYPES)[number];

/** Every action the log can hold, with the kind it is filtered under. An action that is not here is never written. */
export const ADMIN_ACTIONS = {
  "admin.login": "access",
  "admin.code.set": "access",
  "admin.code.rotate": "access",
  "admin.device.remember": "access",
  "admin.device.revoke": "access",
  "pairing.start": "clients",
  "pairing.request": "clients",
  "pairing.approve": "clients",
  "pairing.reject": "clients",
  "pairing.attempt": "clients",
  "token.issue": "clients",
  "token.replace": "clients",
  "token.revoke": "clients",
  "client.disconnect": "clients",
  "update.request": "updates",
  "update.finish": "updates",
  "mcp.on": "apps",
  "mcp.off": "apps",
  "mcp.address": "apps",
  "mcp.change": "apps",
  "oauth.approve": "apps",
  "oauth.deny": "apps",
  "oauth.revoke": "apps",
  "passkey.link": "apps",
  "passkey.add": "apps",
  "passkey.rename": "apps",
  "passkey.remove": "apps",
  "ai.approve": "ai",
  "ai.revoke": "ai",
  "ai.dismiss": "ai",
  "ai.config": "ai",
  "ai-calls.toggle": "ai",
  "spend.pause": "spend",
  "spend.resume": "spend",
  "spend.limits": "spend",
  "network.change": "network",
  "network.remote": "network",
  "tunnel.start": "network",
  "tunnel.restart": "network",
  "tunnel.remove": "network",
  "github.connect": "network",
  "github.disconnect": "network",
  "book.register": "books",
  "book.remove": "books",
  "run.start": "books",
  "run.pause": "books",
  "run.reset": "books",
  "run.autoResume": "books",
  "ai-calls.delete": "books",
} as const satisfies Record<string, AdminActionType>;
export type AdminAction = keyof typeof ADMIN_ACTIONS;

/** Who did it: the owner at the panel, a client token (by its id and label), a device that asked to pair, somebody who proved nothing, or the server itself. */
export type AdminActor = { kind: "admin" | "anonymous" | "system" } | { kind: "client" | "device"; id?: string; label?: string };

export interface AdminLogInput {
  action: AdminAction;
  actor: AdminActor;
  /** Whether it worked (default: yes). */
  ok?: boolean;
  /** What it was done to: an id (of a book, a client, a passkey…), a version, an address. Never a text. */
  object?: string;
  /** The name of the object as its owner wrote it (a client's label, an app's name): cleaned and cut. */
  label?: string;
  /** A few words from a closed vocabulary, or numbers: `on`, `read,write`, `maxTokensPerDay 0->1000`. */
  detail?: string;
  /** Why it did not work, as a short code. */
  code?: string;
  /** Where it came from: an address, or `local`. */
  source?: string;
}

export interface AdminLogEntry {
  /** The number of the entry: it goes up by one with every new entry and is never reused. */
  seq: number;
  /** The first time (for a group of the same failure: the first failure). */
  at: string;
  /** The last time, for an entry that counts a repeat. */
  last?: string;
  /** How many times the same thing happened, for an entry that counts a repeat. */
  count?: number;
  actor: AdminActor;
  action: AdminAction;
  object?: string;
  label?: string;
  detail?: string;
  ok: boolean;
  code?: string;
  source?: string;
}

export interface AdminLogView extends Omit<AdminLogEntry, "action"> {
  /** An action this version does not know (a log written by a newer one) is shown as it is, under `other`. */
  action: string;
  type: AdminActionType | "other";
}

export interface AdminLogOptions {
  now?: () => Date;
  /** Where a log that cannot be written says so (it never fails what it records). */
  log?: (line: string) => void;
  /** The file is cut back when it reaches this size (default 512 KiB)... */
  maxBytes?: number;
  /** ...to the newest this many entries (default 1000), or fewer when they do not fit in half of that size. */
  keepEntries?: number;
  /** The same failure again within this time of the last entry is counted in that entry (default ten minutes). */
  failureGroupMs?: number;
  /** The same action that worked, again at once (a double click), within this time (default one minute). */
  successGroupMs?: number;
}

export const ADMIN_LOG_MAX_BYTES = 512 * 1024;
export const ADMIN_LOG_KEEP_ENTRIES = 1000;
const FAILURE_GROUP_MS = 10 * 60_000;
const SUCCESS_GROUP_MS = 60_000;

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu;

/** What a user wrote, as it may be kept and shown: no control or direction-changing character, one line, one space between words, cut short. */
export function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(UNSAFE_TEXT, " ").replace(/\s+/gu, " ").trim();
  return text ? Array.from(text).slice(0, max).join("").trim() || undefined : undefined;
}

/** An id, a version, an address: printable ASCII with no space, cut. */
function cleanId(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[^\x21-\x7e]/g, "").slice(0, max);
  return text || undefined;
}

/** A few words the server composes: printable ASCII, single spaces, cut. */
function cleanDetail(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[^\x20-\x7e]/g, "").replace(/ {2,}/g, " ").trim().slice(0, max).trim();
  return text || undefined;
}

/** A short code: one word. */
function cleanCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 40);
  return text.replace(/^_+|_+$/g, "") || undefined;
}

function cleanActor(value: unknown): AdminActor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, id, label } = value as Record<string, unknown>;
  if (kind === "admin" || kind === "anonymous" || kind === "system") return { kind };
  if (kind === "client" || kind === "device") {
    const cleanedId = cleanId(id, 80);
    const cleanedLabel = cleanText(label, 80);
    return { kind, ...(cleanedId ? { id: cleanedId } : {}), ...(cleanedLabel ? { label: cleanedLabel } : {}) };
  }
  return undefined;
}

const isAction = (value: unknown): value is AdminAction => typeof value === "string" && Object.hasOwn(ADMIN_ACTIONS, value);
const typeOf = (action: string): AdminActionType | "other" => (isAction(action) ? ADMIN_ACTIONS[action] : "other");
const isTime = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));

type Fields = Omit<AdminLogEntry, "seq" | "at" | "last" | "count">;

/** What is written for an input: only the fields that are known, each cleaned. Nothing for an input that is not an action of somebody. */
function normalize(input: unknown): Fields | undefined {
  if (!input || typeof input !== "object") return undefined;
  const source = input as Record<string, unknown>;
  if (!isAction(source.action)) return undefined;
  const actor = cleanActor(source.actor);
  if (!actor) return undefined;
  const object = cleanId(source.object, 200);
  const label = cleanText(source.label, 80);
  const detail = cleanDetail(source.detail, 120);
  const code = cleanCode(source.code);
  const origin = cleanId(source.source, 64);
  return {
    actor,
    action: source.action,
    ...(object ? { object } : {}),
    ...(label ? { label } : {}),
    ...(detail ? { detail } : {}),
    ok: source.ok !== false,
    ...(code ? { code } : {}),
    ...(origin ? { source: origin } : {}),
  };
}

/** The line of an entry, with its fields in one order. */
function serialize(entry: AdminLogEntry): string {
  return JSON.stringify({
    seq: entry.seq,
    at: entry.at,
    ...(entry.last ? { last: entry.last } : {}),
    ...(entry.count && entry.count > 1 ? { count: entry.count } : {}),
    actor: entry.actor,
    action: entry.action,
    ...(entry.object ? { object: entry.object } : {}),
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.detail ? { detail: entry.detail } : {}),
    ok: entry.ok,
    ...(entry.code ? { code: entry.code } : {}),
    ...(entry.source ? { source: entry.source } : {}),
  });
}

/** An entry as the file holds it, or `undefined` for a line that is not one (it was cut, edited by hand, or written by something else). */
function parseEntry(value: unknown): AdminLogEntry | undefined {
  if (!value || typeof value !== "object" || unsafeKeys(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.seq !== "number" || !Number.isSafeInteger(source.seq) || source.seq < 1 || !isTime(source.at) || typeof source.action !== "string" || typeof source.ok !== "boolean") return undefined;
  const actor = cleanActor(source.actor);
  if (!actor) return undefined;
  const object = cleanId(source.object, 200);
  const label = cleanText(source.label, 80);
  const detail = cleanDetail(source.detail, 120);
  const code = cleanCode(source.code);
  const origin = cleanId(source.source, 64);
  const count = typeof source.count === "number" && Number.isSafeInteger(source.count) && source.count > 1 ? source.count : undefined;
  return {
    seq: source.seq,
    at: source.at,
    ...(isTime(source.last) ? { last: source.last } : {}),
    ...(count ? { count } : {}),
    actor,
    // An action of a newer version is kept as it is: this one shows it under `other`.
    action: (cleanCode(source.action) ?? "unknown") as AdminAction,
    ...(object ? { object } : {}),
    ...(label ? { label } : {}),
    ...(detail ? { detail } : {}),
    ok: source.ok,
    ...(code ? { code } : {}),
    ...(origin ? { source: origin } : {}),
  };
}

/** What makes two entries the same thing happening again: who, what, on what, how it ended. Not where it came from, or when. */
function groupKey(fields: Fields): string {
  const who = fields.actor.kind === "client" || fields.actor.kind === "device" ? `${fields.actor.id ?? ""}\u0001${fields.actor.label ?? ""}` : "";
  return [fields.action, fields.ok, fields.code ?? "", fields.actor.kind, who, fields.object ?? "", fields.label ?? "", fields.detail ?? ""].join("\u0000");
}

/** The log of what the owner and the clients change, in `admin-log.jsonl`. The admin panel shows it, a page at a time. */
export class AdminLog {
  private readonly mutex = new KeyedMutex();
  private readonly now: () => Date;
  private readonly report: (line: string) => void;
  private readonly maxBytes: number;
  private readonly keepEntries: number;
  private readonly failureGroupMs: number;
  private readonly successGroupMs: number;
  private lastSeq: number | undefined;
  /** The entry written last, with what makes another one the same: a repeat is counted in it while it is still the last line of the file. */
  private open: { key: string; entry: AdminLogEntry; lastMs: number } | undefined;
  private modeChecked = false;

  constructor(readonly file: string, options: AdminLogOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.report = options.log ?? (() => undefined);
    this.maxBytes = options.maxBytes ?? ADMIN_LOG_MAX_BYTES;
    this.keepEntries = options.keepEntries ?? ADMIN_LOG_KEEP_ENTRIES;
    this.failureGroupMs = options.failureGroupMs ?? FAILURE_GROUP_MS;
    this.successGroupMs = options.successGroupMs ?? SUCCESS_GROUP_MS;
  }

  /** Every entry that can be read, oldest first. */
  private async readAll(): Promise<AdminLogEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const entries: AdminLogEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // A line that was cut (a power failure in the middle of an append) is skipped.
        continue;
      }
      const entry = parseEntry(value);
      if (entry) entries.push(entry);
    }
    return entries.sort((left, right) => left.seq - right.seq);
  }

  /** The newest entries that fit: at most `keepEntries`, and at most half of the size at which the file is cut, so that a cut leaves room and is not done again at once. */
  private async cut(): Promise<void> {
    const entries = await this.readAll();
    const kept: string[] = [];
    let bytes = 0;
    for (let index = entries.length - 1; index >= 0 && kept.length < this.keepEntries; index -= 1) {
      const line = serialize(entries[index]);
      const size = Buffer.byteLength(line) + 1;
      if (kept.length > 0 && bytes + size > this.maxBytes / 2) break;
      kept.unshift(line);
      bytes += size;
    }
    await atomicWrite(this.file, kept.length ? `${kept.join("\n")}\n` : "");
  }

  /** Count a repeat in the entry that is the last line of the file. `false` when that is not so any more (the file was changed meanwhile): the repeat is then a new entry. */
  private async repeat(open: NonNullable<AdminLog["open"]>, at: string, fields: Fields, nowMs: number): Promise<boolean> {
    const lines = (await readFile(this.file, "utf8")).split("\n").filter(Boolean);
    let last: AdminLogEntry | undefined;
    try {
      last = parseEntry(JSON.parse(lines[lines.length - 1] ?? ""));
    } catch {
      last = undefined;
    }
    if (!last || last.seq !== open.entry.seq) return false;
    const entry: AdminLogEntry = { ...last, count: (last.count ?? 1) + 1, last: at, ...(fields.source ? { source: fields.source } : {}) };
    lines[lines.length - 1] = serialize(entry);
    await atomicWrite(this.file, `${lines.join("\n")}\n`);
    this.open = { key: open.key, entry, lastMs: nowMs };
    return true;
  }

  /** Write one entry. It never fails what it records: a log that cannot be written is told to the server's own log. */
  record(input: AdminLogInput): Promise<void> {
    // The time is the time of the event: not when the write gets its turn. The entry is queued now, so whoever asks for the log after this call sees it (in this order).
    const time = this.now();
    return this.mutex.run("log", async () => {
      try {
        const fields = normalize(input);
        if (!fields) return;
        const at = time.toISOString();
        if (this.lastSeq === undefined) this.lastSeq = (await this.readAll()).reduce((highest, kept) => Math.max(highest, kept.seq), 0);
        const key = groupKey(fields);
        const open = this.open;
        if (open && open.key === key && open.entry.seq === this.lastSeq && time.getTime() - open.lastMs <= (fields.ok ? this.successGroupMs : this.failureGroupMs) && (await this.repeat(open, at, fields, time.getTime()))) return;
        const size = await stat(this.file).then((info) => info.size, () => 0);
        if (size >= this.maxBytes) await this.cut();
        this.lastSeq += 1;
        const entry: AdminLogEntry = { seq: this.lastSeq, at, ...fields };
        await appendFile(this.file, `${serialize(entry)}\n`, { mode: 0o600 });
        if (!this.modeChecked) {
          this.modeChecked = true;
          // A file that was there before (made by hand, or by a copy) is made private too.
          if (process.platform !== "win32") await chmod(this.file, 0o600).catch(() => undefined);
        }
        this.open = { key, entry, lastMs: time.getTime() };
      } catch (error) {
        this.report(`The admin log could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** A page of the log, newest first: `limit` entries older than `before` (the number the last page ended at; none for the first page), of one kind of action, or only those that worked or failed. */
  page(options: { limit: number; before?: number; type?: AdminActionType; ok?: boolean }): Promise<{ entries: AdminLogView[]; nextBefore: number | null }> {
    return this.mutex.run("log", async () => {
      const wanted = (await this.readAll()).filter((entry) => (options.before === undefined || entry.seq < options.before) && (options.type === undefined || typeOf(entry.action) === options.type) && (options.ok === undefined || entry.ok === options.ok));
      const entries = options.limit > 0 ? wanted.slice(-options.limit).reverse() : [];
      return {
        entries: entries.map((entry) => ({ ...entry, type: typeOf(entry.action) })),
        nextBefore: wanted.length > entries.length && entries.length ? entries[entries.length - 1].seq : null,
      };
    });
  }

  /** How many times something happened since a time (in milliseconds since 1970): an entry that counts a repeat counts every time, when its last time is in the window. */
  count(match: { action: AdminAction; ok?: boolean; code?: string; since: number }): Promise<number> {
    return this.mutex.run("log", async () => (await this.readAll())
      .filter((entry) => entry.action === match.action && (match.ok === undefined || entry.ok === match.ok) && (match.code === undefined || entry.code === match.code) && Date.parse(entry.last ?? entry.at) >= match.since)
      .reduce((total, entry) => total + (entry.count ?? 1), 0));
  }

  /** Wait until what was recorded is written (the server closing). */
  flush(): Promise<void> {
    return this.mutex.run("log", async () => undefined);
  }
}
