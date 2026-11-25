import type { AnnotationTagDefinition } from "./model";

/**
 * The tags for every book, kept in the account data that syncs (`settings.annotations`), and the rules shared with the tags of a book: a deleted tag
 * stays as a tombstone (`deletedAt`) so that a copy of the account data that still has it does not bring it back when two copies are reconciled.
 * No YAML and nothing of the model but its types here: the account sync loads this, early.
 */

export interface AnnotationAccountSettings {
  /** The tags for every book, in the order of Settings; deleted ones are tombstones and are not shown. */
  tags?: AnnotationTagDefinition[];
  /** The GitHub books (`owner/repo`, lower case) whose notice about a public repository was shown. */
  publicNoticeSeen?: string[];
}

/**
 * The tags of the account data as they are stored, whatever is in them: what a change in Settings starts from, so that an entry of a newer app (or one
 * this app cannot use) is written back as it was.
 */
export function storedAccountTags(settings: AnnotationAccountSettings | undefined): AnnotationTagDefinition[] {
  const tags = settings && typeof settings === "object" ? settings.tags : undefined;
  return Array.isArray(tags) ? tags : [];
}

function usable(tag: unknown): tag is AnnotationTagDefinition {
  if (!tag || typeof tag !== "object") return false;
  const record = tag as Record<string, unknown>;
  return typeof record.id === "string" && Boolean(record.id) && typeof record.name === "string" && Boolean(record.name.trim());
}

/**
 * The tags for every book that are shown and used: not deleted, with an id and a name, as they are stored (`tagCatalog` and the mark samples show a mark
 * this app does not know as the stand-in's; the form of a tag keeps it while it is not changed).
 */
export function liveAccountTags(tags: readonly unknown[] | undefined): AnnotationTagDefinition[] {
  return (Array.isArray(tags) ? tags : []).filter(usable).filter((tag) => !tag.deletedAt);
}

/** The GitHub books whose notice about a public repository was shown. */
export function publicNoticesSeen(settings: AnnotationAccountSettings | undefined): string[] {
  const seen = settings && typeof settings === "object" ? settings.publicNoticeSeen : undefined;
  return Array.isArray(seen) ? seen.filter((entry): entry is string => typeof entry === "string") : [];
}

function timeOf(value: string | undefined): number {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => (inner && typeof inner === "object" && !Array.isArray(inner)
    ? Object.fromEntries(Object.keys(inner as Record<string, unknown>).sort().map((key) => [key, (inner as Record<string, unknown>)[key]]))
    : inner));
}

/** The newer of two versions of a tag: the later `updatedAt`; at the same moment a deletion wins, then a fixed order of their content. */
export function newerTagDefinition(left: AnnotationTagDefinition, right: AnnotationTagDefinition): AnnotationTagDefinition {
  const leftTime = timeOf(left.updatedAt);
  const rightTime = timeOf(right.updatedAt);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  if (Boolean(left.deletedAt) !== Boolean(right.deletedAt)) return left.deletedAt ? left : right;
  return canonical(left) >= canonical(right) ? left : right;
}

/** The book's key in `publicNoticeSeen`: its repository, lower case. */
export function publicNoticeKey(book: { owner: string; repo: string }): string {
  return `${book.owner}/${book.repo}`.toLowerCase();
}

/**
 * The annotations data of the account after two or more copies diverged: the chosen copy's order of the tags, every tag of any copy, of a tag in more
 * copies its newest version; the notices shown on any copy.
 */
export function mergeAccountAnnotations(chosen: AnnotationAccountSettings | undefined, ...others: Array<AnnotationAccountSettings | undefined>): AnnotationAccountSettings | undefined {
  const copies = [chosen, ...others].filter((copy): copy is AnnotationAccountSettings => Boolean(copy && typeof copy === "object"));
  if (!copies.length) return undefined;
  const order: string[] = [];
  const newest = new Map<string, AnnotationTagDefinition>();
  for (const copy of copies) {
    for (const tag of Array.isArray(copy.tags) ? copy.tags : []) {
      if (!tag || typeof tag.id !== "string") continue;
      const current = newest.get(tag.id);
      if (!current) order.push(tag.id);
      newest.set(tag.id, current ? newerTagDefinition(current, tag) : tag);
    }
  }
  const seen = [...new Set(copies.flatMap((copy) => (Array.isArray(copy.publicNoticeSeen) ? copy.publicNoticeSeen : [])))].sort();
  const merged: AnnotationAccountSettings = { ...copies[0] };
  if (order.length) merged.tags = order.map((id) => newest.get(id)!);
  if (seen.length) merged.publicNoticeSeen = seen;
  return merged;
}

/** The tombstones older than `days` are dropped when the settings are saved. */
export function pruneAccountTagTombstones(tags: readonly AnnotationTagDefinition[], now: Date, days = 90): AnnotationTagDefinition[] {
  const limit = now.getTime() - days * 24 * 60 * 60 * 1000;
  // An entry this app cannot read is left as it is.
  return tags.filter((tag) => !tag || typeof tag !== "object" || !tag.deletedAt || timeOf(tag.deletedAt) >= limit);
}
