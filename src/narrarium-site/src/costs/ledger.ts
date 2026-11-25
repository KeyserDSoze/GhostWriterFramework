/**
 * The usage ledger: what every AI call used and cost, by day, book, source, capability, integration, model and currency. It lives inside the costs of
 * the account data (`CostsFile.ledger`), so it travels with them to every replica, and it never replaces the legacy per-book totals of the same file,
 * which older clients still read and add to (see `legacyCosts.ts`).
 *
 * Bounded: a row is a day; the days of the months before the last `DAILY_MONTHS` are summed into a row of their month by the writer that owns them
 * (`compactWriter`). A row is one line of text in the synced file (`encodeKey`, `encodeCounters`).
 *
 * THE MERGE RULE: why two devices never count a call twice and never lose one, whatever the order of their syncs.
 * The ledger is split by writer. A writer is one local account store of one device (`ledgerWriterId`): a device that starts from a new store is a new
 * writer, so it never reuses the numbering of the one before it. Only a writer changes its own part, and it raises the part's `seq` at every change.
 * Two copies of the ledger merge writer by writer (`mergeLedgers`): the part with the higher `seq` is the newer state of that writer and holds all of
 * the older one (a writer only adds to its rows; compaction moves amounts from days to their month without changing a sum), so it is taken whole.
 * - Never twice: an amount is in the part of the one writer that recorded it, and a merge takes each part from one copy only.
 * - Never lost: the part taken is the newest any copy has; the device that wrote a part keeps its newest state in its own store and merges it into
 *   every copy it receives (a pull, a reconciliation, even a copy that an older client chose whole), so a part a merge missed comes back at that
 *   device's next sync.
 * - The merge is commutative, associative and idempotent (each part is the maximum of a single writer's sequence): the order of the syncs, and a
 *   merge made twice, change nothing. Two parts of one writer with the same `seq` and different rows cannot come from that writer; should they meet,
 *   every device keeps the same one (`newerPart`).
 */

import { localMonth } from "@/costs/period";

export const LEDGER_VERSION = 1 as const;

/** How many months keep their days: the current one and the two before it. The days before them are summed into their months. */
export const DAILY_MONTHS = 3;

/**
 * Where a call came from, for the totals of the person: the autopilot (every call of a run, whatever its capability), the Copilot, the actions of the
 * editor, the audit, the readers' evaluations, research, images and voice, and anything else. Decided once, by `usageSource`.
 */
export const USAGE_SOURCES = ["autopilot", "copilot", "editor-actions", "audit", "reader-evaluation", "research", "media", "other"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/** The numbers of a row. Every one only ever grows. */
export interface UsageCounters {
  /** Requests sent to a provider: every attempt, the fallbacks and the ones that failed included. */
  calls: number;
  /** Units of work: a step of the autopilot, or one request of a feature (an answer of the Copilot, an action, an image); counted at its first call. */
  tasks: number;
  /** Tokens the provider reported. Never an estimate. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Money measured: reported tokens at the price of the model, in the currency of the row. Never an estimate. */
  cost: number;
  /** Calls that used something on a model with no price. */
  unpricedCalls: number;
  /** Calls whose tokens the provider did not report: their tokens and cost are only in the estimated fields. */
  unknownUsageCalls: number;
  /** The engine's estimate of the tokens of the calls in `unknownUsageCalls`, and of their cost when the model has a price. Kept apart, never added to the measured ones. */
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCost: number;
}

export const COUNTER_FIELDS = [
  "calls", "tasks", "inputTokens", "cachedTokens", "outputTokens", "cost", "unpricedCalls", "unknownUsageCalls", "estimatedInputTokens", "estimatedOutputTokens", "estimatedCost",
] as const satisfies ReadonlyArray<keyof UsageCounters>;

const MONEY_FIELDS: ReadonlySet<string> = new Set(["cost", "estimatedCost"]);

/** What a row is about. `period` is a day (`2026-11-25`, the local calendar of the device that recorded it) or a month (`2026-11`) after compaction. */
export interface UsageKey {
  period: string;
  /** `""`: no book was open. */
  bookId: string;
  /** A `UsageSource`; kept as text, so that a source a newer version adds survives here. */
  source: string;
  /** The capability of the router the call was made for (`autopilot`, `copilot`, `review`…), or `image`, `tts`, `stt`. */
  capability: string;
  /** `""` when the call had none (the browser's own voice) or did not say. */
  integrationId: string;
  model: string;
  /** The currency the price was in when the call was made (the setting of the moment: prices are entered in it). `""`: the model had no price. */
  currency: string;
}

const KEY_FIELDS = ["period", "bookId", "source", "capability", "integrationId", "model", "currency"] as const satisfies ReadonlyArray<keyof UsageKey>;

/** One writer's part: only that writer changes it, and `seq` grows with every change. Rows map an encoded key to encoded counters. */
export interface LedgerWriter {
  seq: number;
  rows: Record<string, string>;
}

export interface UsageLedger {
  v: typeof LEDGER_VERSION;
  /** When the ledger began: what the legacy totals had before it is their «earlier» part (see `legacyCosts.ts`). */
  since: string;
  /** The currency of the setting when the ledger began: the currency the «earlier» part is counted in (the legacy totals never recorded one). */
  currency: string;
  writers: Record<string, LedgerWriter>;
}

export interface UsageDelta {
  key: UsageKey;
  counters: Partial<UsageCounters>;
}

export function emptyCounters(): UsageCounters {
  return { calls: 0, tasks: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0, unpricedCalls: 0, unknownUsageCalls: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedCost: 0 };
}

export function addCounters(target: UsageCounters, delta: Partial<UsageCounters>): UsageCounters {
  const next = { ...target };
  for (const field of COUNTER_FIELDS) {
    const value = delta[field];
    if (typeof value === "number" && Number.isFinite(value)) next[field] += value;
  }
  return next;
}

// ─── The text of a row ──────────────────────────────────────────────────────────────────────────────────────────────

/** `|` separates the parts of a key: in a part it is written `%7C`, and `%` is written `%25` so that the two never meet. */
const escapePart = (value: string): string => value.replace(/%/g, "%25").replace(/\|/g, "%7C");
const unescapePart = (value: string): string => value.replace(/%7C/gi, "|").replace(/%25/g, "%");

export function encodeKey(key: UsageKey): string {
  return KEY_FIELDS.map((field) => escapePart(key[field])).join("|");
}

/** The key of a row, or `null` for a text this version cannot read (it is kept as it is, never counted). */
export function decodeKey(text: string): UsageKey | null {
  const parts = text.split("|");
  if (parts.length !== KEY_FIELDS.length) return null;
  const [period, bookId, source, capability, integrationId, model, currency] = parts.map(unescapePart);
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(period)) return null;
  return { period, bookId, source, capability, integrationId, model, currency };
}

/** A number as a row keeps it: money to ten decimal places (sums of many small prices drift), counts as whole numbers. */
function plain(value: number, money: boolean): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  return String(money ? Number(value.toFixed(10)) : Math.round(value));
}

/** The counters in the order of `COUNTER_FIELDS`, separated by spaces, without the zeros at the end. Numbers past the known ones (a newer version's) are kept. */
export function encodeCounters(counters: UsageCounters, extra: readonly string[] = []): string {
  const values = COUNTER_FIELDS.map((field) => plain(counters[field], MONEY_FIELDS.has(field)));
  const all = [...values, ...extra];
  while (all.length > 1 && all[all.length - 1] === "0") all.pop();
  return all.join(" ");
}

export function decodeCounters(text: string): { counters: UsageCounters; extra: string[] } {
  const parts = typeof text === "string" ? text.trim().split(/\s+/).filter(Boolean) : [];
  const counters = emptyCounters();
  COUNTER_FIELDS.forEach((field, index) => {
    const value = Number(parts[index]);
    counters[field] = Number.isFinite(value) && value > 0 ? value : 0;
  });
  return { counters, extra: parts.slice(COUNTER_FIELDS.length) };
}

// ─── Days and months ──────────────────────────────────────────────────────────────────────────────────────────────

export { localDay, localMonth } from "@/costs/period";

/** The first month whose days are kept as days at `now`: the months before it are kept as months. */
export function firstDailyMonth(now: Date): string {
  return localMonth(new Date(now.getFullYear(), now.getMonth() - (DAILY_MONTHS - 1), 1));
}

// ─── A writer's part ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Who writes: see `ledgerWriter.ts`.
 */
export { ledgerWriterId } from "@/costs/ledgerWriter";

/**
 * Sums the days of the months before `firstDailyMonth(now)` into rows of their month, with the rest of the key the same. The sums do not change, so
 * a writer may compact its own part at any time; it never compacts another's (that would make two states of a part with different rows).
 */
export function compactWriter(writer: LedgerWriter, now: Date): LedgerWriter {
  const cutoff = firstDailyMonth(now);
  const moved = Object.keys(writer.rows).filter((text) => text.length > 10 && text.charAt(7) === "-" && text.slice(0, 7) < cutoff && text.charAt(10) === "|");
  if (!moved.length) return writer;
  const rows = { ...writer.rows };
  for (const text of moved) {
    const key = decodeKey(text);
    if (!key) continue;
    const month = encodeKey({ ...key, period: key.period.slice(0, 7) });
    const day = decodeCounters(rows[text]);
    const sum = rows[month] ? decodeCounters(rows[month]) : { counters: emptyCounters(), extra: day.extra };
    rows[month] = encodeCounters(addCounters(sum.counters, day.counters), sum.extra);
    delete rows[text];
  }
  return { seq: writer.seq, rows };
}

/** A ledger this version can write in: version 1 with its writers. A ledger of a newer version is kept as it is and never written. */
export function isReadableLedger(value: unknown): value is UsageLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ledger = value as Partial<UsageLedger>;
  return ledger.v === LEDGER_VERSION && Boolean(ledger.writers) && typeof ledger.writers === "object" && !Array.isArray(ledger.writers);
}

function readableWriter(value: unknown): LedgerWriter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const writer = value as Partial<LedgerWriter>;
  if (typeof writer.seq !== "number" || !Number.isSafeInteger(writer.seq) || writer.seq < 0) return null;
  if (!writer.rows || typeof writer.rows !== "object" || Array.isArray(writer.rows)) return null;
  return writer as LedgerWriter;
}

export function newLedger(at: Date, currency: string): UsageLedger {
  return { v: LEDGER_VERSION, since: at.toISOString(), currency, writers: {} };
}

/**
 * The ledger with `deltas` added to the part of `writerId`, as one change of it (`seq` + 1), compacted at `at`. A ledger that does not exist yet begins
 * here, with `currency` as the currency of the «earlier» part. Returns a new ledger; the one given is not changed. A ledger of a newer version is
 * returned as it is: this version does not write in what it cannot read (the legacy totals still record the call).
 */
export function addToLedger(ledger: UsageLedger | undefined, writerId: string, deltas: readonly UsageDelta[], at: Date, currency: string): UsageLedger {
  if (ledger !== undefined && ledger !== null && !isReadableLedger(ledger)) return ledger;
  const base = ledger ?? newLedger(at, currency);
  if (!deltas.length) return base;
  const previous = readableWriter(base.writers[writerId]) ?? { seq: 0, rows: {} };
  const rows = { ...previous.rows };
  for (const delta of deltas) {
    const text = encodeKey(delta.key);
    const current = rows[text] ? decodeCounters(rows[text]) : { counters: emptyCounters(), extra: [] };
    rows[text] = encodeCounters(addCounters(current.counters, delta.counters), current.extra);
  }
  const writer = compactWriter({ seq: previous.seq + 1, rows }, at);
  return { ...base, writers: { ...base.writers, [writerId]: writer } };
}

// ─── The merge ──────────────────────────────────────────────────────────────────────────────────────────────

function callsOf(writer: LedgerWriter): number {
  let total = 0;
  for (const text of Object.values(writer.rows)) total += typeof text === "string" ? decodeCounters(text).counters.calls : 0;
  return total;
}

/** A text that is the same for the same rows in any order: what decides between two parts with the same `seq`. */
function canonicalRows(writer: LedgerWriter): string {
  return JSON.stringify(Object.keys(writer.rows).sort().map((key) => [key, writer.rows[key]]));
}

/** Which of two parts of one writer is the newer: the higher `seq`; with the same `seq`, the one with more calls, then the larger text (the same choice on every device). */
export function newerPart(left: LedgerWriter, right: LedgerWriter): LedgerWriter {
  if (left.seq !== right.seq) return left.seq > right.seq ? left : right;
  if (left === right) return left;
  const calls = callsOf(left) - callsOf(right);
  if (calls !== 0) return calls > 0 ? left : right;
  return canonicalRows(left) >= canonicalRows(right) ? left : right;
}

/**
 * The merge of copies of the ledger (see THE MERGE RULE at the top): each writer's newest part, and the beginning (`since`, `currency`) of the copy that
 * began first. Copies without a ledger add nothing. A ledger of a newer version than this one cannot be merged here: when a copy has one it is returned
 * as it is (the newer client merges it), so that this version never writes over what it cannot read.
 */
export function mergeLedgers(...ledgers: ReadonlyArray<unknown>): UsageLedger | undefined {
  const present = ledgers.filter((ledger) => ledger !== undefined && ledger !== null);
  const unreadable = present.find((ledger) => !isReadableLedger(ledger));
  if (unreadable) return unreadable as UsageLedger;
  const readable = present as UsageLedger[];
  if (!readable.length) return undefined;
  if (readable.length === 1) return readable[0];
  const first = [...readable].sort((left, right) => (left.since === right.since ? (left.currency ?? "").localeCompare(right.currency ?? "") : left.since < right.since ? -1 : 1))[0];
  const writers: Record<string, LedgerWriter> = {};
  for (const ledger of readable) {
    for (const [id, value] of Object.entries(ledger.writers)) {
      const part = readableWriter(value);
      if (!part) {
        if (!(id in writers)) writers[id] = value as LedgerWriter;
        continue;
      }
      const known = readableWriter(writers[id]);
      writers[id] = known ? newerPart(known, part) : part;
    }
  }
  const sorted = Object.fromEntries(Object.keys(writers).sort().map((id) => [id, writers[id]]));
  return { v: LEDGER_VERSION, since: first.since, currency: first.currency, writers: sorted };
}

/** Whether two ledgers hold the same parts (the order of the keys aside). */
export function sameLedger(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right) return !left && !right;
  if (!isReadableLedger(left) || !isReadableLedger(right)) return JSON.stringify(left) === JSON.stringify(right);
  if (left.since !== right.since || left.currency !== right.currency) return false;
  const ids = new Set([...Object.keys(left.writers), ...Object.keys(right.writers)]);
  for (const id of ids) {
    const a = readableWriter(left.writers[id]);
    const b = readableWriter(right.writers[id]);
    if (!a || !b) {
      if (JSON.stringify(left.writers[id]) !== JSON.stringify(right.writers[id])) return false;
      continue;
    }
    if (a.seq !== b.seq || canonicalRows(a) !== canonicalRows(b)) return false;
  }
  return true;
}

// ─── Reading ──────────────────────────────────────────────────────────────────────────────────────────────

export interface UsageRow extends UsageKey, UsageCounters {
  /** The writer of the row; `earlier` for what the legacy totals held before the ledger (see `legacyCosts.ts`). */
  writer: string;
}

/** Every row of every writer that this version can read, as numbers. Rows it cannot read are left out (they stay in the file). */
export function ledgerRows(ledger: unknown): UsageRow[] {
  if (!isReadableLedger(ledger)) return [];
  const rows: UsageRow[] = [];
  for (const [writer, value] of Object.entries(ledger.writers)) {
    const part = readableWriter(value);
    if (!part) continue;
    for (const [text, counters] of Object.entries(part.rows)) {
      const key = decodeKey(text);
      if (!key || typeof counters !== "string") continue;
      rows.push({ ...key, ...decodeCounters(counters).counters, writer });
    }
  }
  return rows;
}
