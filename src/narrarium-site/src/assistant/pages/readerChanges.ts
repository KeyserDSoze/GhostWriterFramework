import { parseDocument, stringify } from "yaml";
import { emptyReaderPersona, serializeReaderPersona, type ReaderPersonaProfile } from "@/narrarium/readerPersona";
import { slugifyAny } from "@/narrarium/canon";
import { matchKey } from "@/lib/matchText";
import type { PageChangeRow } from "@/assistant/store";

/**
 * A batch of changes to the simulated readers of a book, as one proposal: readers created, edited, turned on or off, and removed, with the resulting state of
 * every reader. A built-in reader is never deleted: removing one turns it off. Pure: the files it writes are computed from the files it was given.
 */

/** The fields of a reader a change may set (the rest is the reader's own: its id, its type, its origin, its order). */
export const READER_FIELDS = ["name", "description", "profile", "aspects", "preferredGenres", "dislikedGenres", "experienceLevel", "severity", "audienceAge", "interests", "appreciatedElements", "frequentCriticisms", "customPrompt"] as const;
export type ReaderField = (typeof READER_FIELDS)[number];
export type ReaderFieldChanges = Partial<Pick<ReaderPersonaProfile, ReaderField>>;

/** A new reader, as the model writes it (the reader schema of the Copilot: `readerOutputSchema`). */
export type ReaderDraft = Pick<ReaderPersonaProfile, ReaderField>;

export interface ReaderBatch {
  create?: readonly ReaderDraft[];
  update?: ReadonlyArray<{ reader: string; set: ReaderFieldChanges }>;
  /** Readers to turn on and off, and to remove: by id, slug or name, or a group: `@all`, `@builtin` (the defaults), `@standard`, `@genre`, `@custom`. */
  enable?: readonly string[];
  disable?: readonly string[];
  remove?: readonly string[];
}

export const READER_GROUPS = ["@all", "@builtin", "@default", "@standard", "@genre", "@custom"] as const;

export interface ReaderPlan {
  /** Every reader of the book with its resulting state: what changes first (created, edited, turned on or off, removed), then the rest. */
  rows: PageChangeRow[];
  /** The readers to write: created, edited, turned on or off. */
  write: ReaderPersonaProfile[];
  /** The readers of the author to delete. */
  remove: ReaderPersonaProfile[];
  /** What could not be done: a reader that does not exist, a name taken twice. */
  problems: string[];
}

const isGroup = (selector: string) => selector.trim().startsWith("@");

/** The readers a selector names: a group, or one reader by id, slug or name (exact first, then a single reader whose name contains it). */
export function selectReaders(selector: string, readers: readonly ReaderPersonaProfile[]): ReaderPersonaProfile[] | null {
  const wanted = selector.trim();
  switch (wanted.toLowerCase()) {
    case "@all": return [...readers];
    case "@builtin":
    case "@default": return readers.filter((reader) => reader.builtin);
    case "@standard": return readers.filter((reader) => reader.builtin && reader.readerType === "standard");
    case "@genre": return readers.filter((reader) => reader.readerType === "genre");
    case "@custom": return readers.filter((reader) => !reader.builtin);
  }
  if (isGroup(wanted)) return null;
  const exact = readers.filter((reader) => reader.id === wanted || reader.slug === wanted || matchKey(reader.name) === matchKey(wanted));
  if (exact.length) return exact.slice(0, 1);
  const key = matchKey(wanted);
  const containing = key ? readers.filter((reader) => matchKey(reader.name).includes(key)) : [];
  return containing.length === 1 ? containing : null;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cleanList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

/** The fields a change sets, as a reader holds them: lists without blanks or doubles, a severity from 1 to 10, texts trimmed. */
function normalizeFields(set: ReaderFieldChanges): ReaderFieldChanges {
  const fields: ReaderFieldChanges = {};
  for (const key of READER_FIELDS) {
    const value = set[key];
    if (value === undefined) continue;
    if (key === "severity") fields.severity = Math.min(10, Math.max(1, Math.round(Number(value) || 5)));
    else if (Array.isArray(value)) (fields as Record<string, unknown>)[key] = cleanList(value);
    else if (typeof value === "string") (fields as Record<string, unknown>)[key] = value.trim();
  }
  return fields;
}

/** A slug for a new reader that no reader and no file of the book has. */
function freeSlug(name: string, taken: Set<string>): string {
  const base = slugifyAny(name, "reader", true);
  let slug = base;
  for (let index = 2; taken.has(slug); index += 1) slug = `${base}-${index}`;
  taken.add(slug);
  return slug;
}

export function planReaderChanges(current: readonly ReaderPersonaProfile[], batch: ReaderBatch, options: { language: string; newId?: (slug: string) => string }): ReaderPlan {
  const problems: string[] = [];
  const next = new Map(current.map((reader) => [reader.id, { ...reader }]));
  const fields = new Map<string, Set<string>>();
  const touched = (id: string, field: string) => fields.set(id, new Set([...(fields.get(id) ?? []), field]));
  const kept = new Set<string>();
  const removed = new Set<string>();

  // New readers: names no reader has (nor another new one), slugs no file has. They are on unless the batch turns them off by name.
  const names = new Set(current.map((reader) => matchKey(reader.name)));
  const slugs = new Set(current.map((reader) => reader.slug));
  const created: ReaderPersonaProfile[] = [];
  let order = Math.max(999, ...current.map((reader) => reader.order));
  for (const draft of batch.create ?? []) {
    const name = draft.name.trim();
    if (!name) continue;
    if (names.has(matchKey(name))) {
      problems.push(`A reader named «${name}» already exists: it was not created again.`);
      continue;
    }
    names.add(matchKey(name));
    const slug = freeSlug(name, slugs);
    order += 1;
    created.push({
      ...emptyReaderPersona(options.language, order),
      ...normalizeFields(draft),
      id: options.newId ? options.newId(slug) : `reader:custom:${slug}`,
      slug,
      name,
      body: draft.description.trim(),
    });
  }
  for (const reader of created) next.set(reader.id, reader);

  const resolve = (selector: string, pool: readonly ReaderPersonaProfile[]): ReaderPersonaProfile[] => {
    const found = selectReaders(selector, pool);
    if (!found) problems.push(isGroup(selector) ? `«${selector}» is not a group of readers (the groups are ${READER_GROUPS.join(", ")}).` : `No reader is called «${selector}».`);
    return found ?? [];
  };
  // Groups name the readers the book has; a new reader is named by its own name.
  const existing = () => current.map((reader) => next.get(reader.id)!).filter((reader) => !removed.has(reader.id));
  const anyone = () => [...existing(), ...created];

  for (const change of batch.update ?? []) {
    const set = normalizeFields(change.set);
    for (const reader of resolve(change.reader, isGroup(change.reader) ? existing() : anyone())) {
      const target = next.get(reader.id)!;
      for (const [key, value] of Object.entries(set)) {
        if (key === "name" && typeof value === "string" && value && matchKey(value) !== matchKey(target.name) && [...next.values()].some((other) => other.id !== target.id && matchKey(other.name) === matchKey(value))) {
          problems.push(`«${target.name}» cannot be renamed «${value}»: another reader has that name.`);
          continue;
        }
        if (!value && key === "name") continue;
        if (same((target as unknown as Record<string, unknown>)[key], value)) continue;
        (target as unknown as Record<string, unknown>)[key] = value;
        if (!created.includes(target)) touched(target.id, key);
      }
    }
  }

  const setEnabled = (reader: ReaderPersonaProfile, enabled: boolean) => {
    next.get(reader.id)!.enabled = enabled;
  };
  // Groups first, then the readers named one by one, which win over a group; turning on wins over turning off when one reader is named in both.
  const switches = (selectors: readonly string[] | undefined, groups: boolean) => (selectors ?? []).filter((selector) => isGroup(selector) === groups);
  for (const selector of switches(batch.disable, true)) for (const reader of resolve(selector, existing())) setEnabled(reader, false);
  for (const selector of switches(batch.enable, true)) for (const reader of resolve(selector, existing())) setEnabled(reader, true);
  for (const selector of switches(batch.disable, false)) for (const reader of resolve(selector, anyone())) setEnabled(reader, false);
  for (const selector of switches(batch.enable, false)) for (const reader of resolve(selector, anyone())) setEnabled(reader, true);

  for (const selector of batch.remove ?? []) {
    for (const reader of resolve(selector, isGroup(selector) ? existing() : anyone())) {
      if (reader.builtin) {
        // A built-in reader stays: removing it turns it off.
        setEnabled(reader, false);
        kept.add(reader.id);
      } else if (created.some((entry) => entry.id === reader.id)) {
        created.splice(created.findIndex((entry) => entry.id === reader.id), 1);
        next.delete(reader.id);
      } else {
        removed.add(reader.id);
      }
    }
  }

  const rows: PageChangeRow[] = [];
  const write: ReaderPersonaProfile[] = [];
  const remove: ReaderPersonaProfile[] = [];
  for (const reader of current) {
    const after = next.get(reader.id)!;
    const changedFields = [...(fields.get(reader.id) ?? [])];
    const base = { id: reader.id, name: after.name, kind: reader.readerType, builtin: reader.builtin, before: reader.enabled };
    if (removed.has(reader.id)) {
      rows.push({ ...base, name: reader.name, after: null, change: "removed" });
      remove.push(reader);
      continue;
    }
    const switched = after.enabled !== reader.enabled;
    const change: PageChangeRow["change"] = changedFields.length ? "edited" : switched ? (after.enabled ? "turned-on" : "turned-off") : "unchanged";
    rows.push({ ...base, after: after.enabled, change, ...(changedFields.length ? { fields: changedFields } : {}), ...(kept.has(reader.id) ? { kept: true } : {}) });
    if (change !== "unchanged") write.push(after);
  }
  for (const reader of created) {
    rows.push({ id: reader.id, name: reader.name, kind: reader.readerType, builtin: false, before: null, after: reader.enabled, change: "created" });
    write.push(reader);
  }
  const rank: Record<PageChangeRow["change"], number> = { created: 0, edited: 1, "turned-on": 2, "turned-off": 3, removed: 4, unchanged: 5 };
  rows.sort((left, right) => rank[left.change] - rank[right.change]);
  return { rows, write, remove, problems: [...new Set(problems)] };
}

/** The file of a reader: what the reader says, over the keys of the file that only the file has (as the page saves it). */
export function readerFileContent(profile: ReaderPersonaProfile, existing: string | null): string {
  const path = profile.path ?? `personas/${profile.slug}.md`;
  const generated = serializeReaderPersona({ ...profile, path });
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(generated)!;
  const managed = (parseDocument(match[1]).toJSON() as Record<string, unknown>) ?? {};
  const current = existing ? /^---\r?\n([\s\S]*?)\r?\n---/.exec(existing) : null;
  let kept: Record<string, unknown> = {};
  if (current) {
    try {
      kept = (parseDocument(current[1]).toJSON() as Record<string, unknown>) ?? {};
    } catch {
      kept = {};
    }
  }
  const frontmatter = { ...Object.fromEntries(Object.entries(kept).filter(([key]) => !(key in managed))), ...managed };
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${match[2].trim()}\n`;
}

/** The path of a reader's file: its own, else `personas/<slug>.md` (a built-in reader gets one the first time it changes). */
export function readerFilePath(profile: ReaderPersonaProfile): string {
  return profile.path ?? `personas/${profile.slug}.md`;
}

/** How a plan reads in one line: «3 created, 8 turned off». */
export function readerPlanCounts(rows: readonly PageChangeRow[]): Record<Exclude<PageChangeRow["change"], "unchanged">, number> {
  const count = (change: PageChangeRow["change"]) => rows.filter((row) => row.change === change).length;
  return { created: count("created"), edited: count("edited"), "turned-on": count("turned-on"), "turned-off": count("turned-off"), removed: count("removed") };
}
