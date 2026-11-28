/**
 * The wildcards of the author's account (`settings.wildcards`), for every book: each the text of its file, as a book keeps one (`wildcards/<slug>.md`), and
 * when it changed. A deleted one stays as a tombstone (`deletedAt`, without its text) so that a copy of the account data that still has it does not bring
 * it back when two copies are reconciled. No YAML and nothing of the engine here: the account sync loads this, early.
 */

export interface WildcardAccountEntry {
  /** The id of the wildcard (`wildcard:<slug>` changes a built-in one, `wildcard:custom:<…>` is the author's own). */
  id: string;
  slug: string;
  /** The file of the wildcard, as a book keeps it. Empty for a tombstone. */
  text: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface WildcardAccountSettings {
  version?: 1;
  /** In the order they were added; deleted ones are tombstones and are not shown. */
  entries?: WildcardAccountEntry[];
}

/** Tombstones older than this many days are dropped when the account's wildcards are written. */
export const WILDCARD_TOMBSTONE_DAYS = 90;

function usable(entry: unknown): entry is WildcardAccountEntry {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  return typeof record.id === "string" && Boolean(record.id) && typeof record.slug === "string" && Boolean(record.slug) && typeof record.text === "string" && typeof record.updatedAt === "string";
}

/** The entries as they are stored, whatever is in them: what a change starts from, so that an entry of a newer app is written back as it was. */
export function storedAccountWildcards(settings: WildcardAccountSettings | undefined): WildcardAccountEntry[] {
  const entries = settings && typeof settings === "object" ? settings.entries : undefined;
  return Array.isArray(entries) ? entries : [];
}

/** The wildcards of the account that are in force: not deleted, with an id, a slug and a text. */
export function liveAccountWildcards(settings: WildcardAccountSettings | undefined): WildcardAccountEntry[] {
  return storedAccountWildcards(settings).filter(usable).filter((entry) => !entry.deletedAt && entry.text.trim());
}

function timeOf(value: string | undefined): number {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/** The newer of two versions of a wildcard: the later `updatedAt`; at the same moment a deletion wins, then the longer text, then the text itself. */
export function newerWildcardEntry(left: WildcardAccountEntry, right: WildcardAccountEntry): WildcardAccountEntry {
  const leftTime = timeOf(left.updatedAt);
  const rightTime = timeOf(right.updatedAt);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  if (Boolean(left.deletedAt) !== Boolean(right.deletedAt)) return left.deletedAt ? left : right;
  if (left.text.length !== right.text.length) return left.text.length > right.text.length ? left : right;
  return left.text >= right.text ? left : right;
}

/** The wildcards of the account after two or more copies diverged: every wildcard of any copy, of one in more copies its newest version, in the chosen copy's order. */
export function mergeAccountWildcards(chosen: WildcardAccountSettings | undefined, ...others: Array<WildcardAccountSettings | undefined>): WildcardAccountSettings | undefined {
  const copies = [chosen, ...others].filter((copy): copy is WildcardAccountSettings => Boolean(copy && typeof copy === "object"));
  if (!copies.length) return undefined;
  const order: string[] = [];
  const newest = new Map<string, WildcardAccountEntry>();
  for (const copy of copies) {
    for (const entry of storedAccountWildcards(copy)) {
      if (!usable(entry)) continue;
      const current = newest.get(entry.id);
      if (!current) order.push(entry.id);
      newest.set(entry.id, current ? newerWildcardEntry(current, entry) : entry);
    }
  }
  const merged: WildcardAccountSettings = { ...copies[0] };
  if (order.length) merged.entries = order.map((id) => newest.get(id)!);
  return merged;
}

/** The entries without the tombstones older than `days`; an entry this app cannot read is left as it is. */
export function pruneAccountWildcardTombstones(entries: readonly WildcardAccountEntry[], now: Date, days = WILDCARD_TOMBSTONE_DAYS): WildcardAccountEntry[] {
  const limit = now.getTime() - days * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => !entry || typeof entry !== "object" || !entry.deletedAt || timeOf(entry.deletedAt) >= limit);
}

/** The account's wildcards with `entry` written in (a new one at the end, a changed one in its place), the old tombstones dropped. */
export function upsertAccountWildcard(settings: WildcardAccountSettings | undefined, entry: Omit<WildcardAccountEntry, "updatedAt" | "deletedAt">, now = new Date()): WildcardAccountSettings {
  const stored = storedAccountWildcards(settings);
  const next: WildcardAccountEntry = { ...entry, updatedAt: now.toISOString() };
  const index = stored.findIndex((current) => usable(current) && current.id === entry.id);
  const entries = index >= 0 ? stored.map((current, position) => (position === index ? next : current)) : [...stored, next];
  return { ...(settings ?? {}), version: 1, entries: pruneAccountWildcardTombstones(entries, now) };
}

/** The account's wildcards with one removed: it stays as a tombstone, so that another copy does not bring it back. */
export function removeAccountWildcard(settings: WildcardAccountSettings | undefined, id: string, now = new Date()): WildcardAccountSettings {
  const at = now.toISOString();
  const entries = storedAccountWildcards(settings).map((entry) => (usable(entry) && entry.id === id ? { id: entry.id, slug: entry.slug, text: "", updatedAt: at, deletedAt: at } : entry));
  return { ...(settings ?? {}), version: 1, entries: pruneAccountWildcardTombstones(entries, now) };
}
