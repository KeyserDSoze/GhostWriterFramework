import { emptyWildcard, parseWildcard, serializeWildcard, WILDCARD_CANON_RESPECT, WILDCARD_OUTPUT_FORMATS, type WildcardCanonRespect, type WildcardGroup, type WildcardOutputFormat, type WildcardProfile } from "narrarium-engine";
import { slugifyAny } from "@/narrarium/canon";
import { matchKey } from "@/lib/matchText";
import type { PageChangeRow } from "@/assistant/store";

/**
 * A batch of changes to the wildcards of a book, as one proposal: wildcards created, edited, turned on or off, and removed, with the resulting state of every
 * wildcard. The Copilot changes the book's room: a built-in wildcard, or one of the author's account, is changed in the book with a file of its own (and
 * removing one turns it off in the book); only a wildcard the book itself made is deleted. Pure: the files are computed from the files it was given.
 */

/** The fields of a wildcard a change may set. */
export const WILDCARD_FIELDS = ["name", "group", "mandate", "temperament", "audacity", "canonRespect", "outputFormat", "domain", "body"] as const;
export type WildcardField = (typeof WILDCARD_FIELDS)[number];
export type WildcardFieldChanges = Partial<Pick<WildcardProfile, WildcardField>>;

/** A new wildcard, as the model writes it. */
export interface WildcardDraft {
  name: string;
  group: WildcardGroup;
  mandate: string;
  temperament: string;
  audacity: number;
  canonRespect: WildcardCanonRespect;
  outputFormat: WildcardOutputFormat;
  domain: string;
  prompt: string;
}

export interface WildcardBatch {
  create?: readonly WildcardDraft[];
  update?: ReadonlyArray<{ wildcard: string; set: WildcardFieldChanges }>;
  /** By id, slug or name, or a group: `@all`, `@builtin`, `@custom`, `@provocateurs`, `@sentinels`. */
  enable?: readonly string[];
  disable?: readonly string[];
  remove?: readonly string[];
}

export const WILDCARD_GROUPS = ["@all", "@builtin", "@custom", "@provocateurs", "@sentinels"] as const;

export interface WildcardPlan {
  rows: PageChangeRow[];
  /** The wildcards to write into the book: created, edited, turned on or off. */
  write: WildcardProfile[];
  /** The book's own wildcards to delete. */
  remove: WildcardProfile[];
  problems: string[];
}

const isGroup = (selector: string) => selector.trim().startsWith("@");

/** The wildcards a selector names: a group, or one wildcard by id, slug or name (exact first, then the single one whose name contains it). */
export function selectWildcards(selector: string, wildcards: readonly WildcardProfile[]): WildcardProfile[] | null {
  const wanted = selector.trim();
  switch (wanted.toLowerCase()) {
    case "@all": return [...wildcards];
    case "@builtin":
    case "@default": return wildcards.filter((profile) => profile.builtin);
    case "@custom": return wildcards.filter((profile) => !profile.builtin);
    case "@provocateurs": return wildcards.filter((profile) => profile.group === "provocateur");
    case "@sentinels": return wildcards.filter((profile) => profile.group === "sentinel");
  }
  if (isGroup(wanted)) return null;
  const exact = wildcards.filter((profile) => profile.id === wanted || profile.slug === wanted || matchKey(profile.name) === matchKey(wanted));
  if (exact.length) return exact.slice(0, 1);
  const key = matchKey(wanted);
  const containing = key ? wildcards.filter((profile) => matchKey(profile.name).includes(key)) : [];
  return containing.length === 1 ? containing : null;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The fields a change sets, as a wildcard holds them: an audacity from 1 to 10, known values for the choices, texts trimmed. */
function normalizeFields(set: WildcardFieldChanges): WildcardFieldChanges {
  const fields: WildcardFieldChanges = {};
  for (const key of WILDCARD_FIELDS) {
    const value = set[key];
    if (value === undefined) continue;
    if (key === "audacity") fields.audacity = Math.min(10, Math.max(1, Math.round(Number(value) || 5)));
    else if (key === "group") { if (value === "provocateur" || value === "sentinel") fields.group = value; }
    else if (key === "canonRespect") { if ((WILDCARD_CANON_RESPECT as readonly unknown[]).includes(value)) fields.canonRespect = value as WildcardCanonRespect; }
    else if (key === "outputFormat") { if ((WILDCARD_OUTPUT_FORMATS as readonly unknown[]).includes(value)) fields.outputFormat = value as WildcardOutputFormat; }
    else if (typeof value === "string") (fields as Record<string, unknown>)[key] = value.trim();
  }
  return fields;
}

function freeSlug(name: string, taken: Set<string>): string {
  const base = slugifyAny(name, "wildcard", true);
  let slug = base;
  for (let index = 2; taken.has(slug); index += 1) slug = `${base}-${index}`;
  taken.add(slug);
  return slug;
}

export function planWildcardChanges(current: readonly WildcardProfile[], batch: WildcardBatch, options: { language: string }): WildcardPlan {
  const problems: string[] = [];
  const next = new Map(current.map((profile) => [profile.id, { ...profile }]));
  const fields = new Map<string, Set<string>>();
  const touched = (id: string, field: string) => fields.set(id, new Set([...(fields.get(id) ?? []), field]));
  const kept = new Set<string>();
  const removed = new Set<string>();

  const names = new Set(current.map((profile) => matchKey(profile.name)));
  const slugs = new Set(current.map((profile) => profile.slug));
  const created: WildcardProfile[] = [];
  let order = Math.max(999, ...current.map((profile) => profile.order));
  for (const draft of batch.create ?? []) {
    const name = draft.name.trim();
    if (!name) continue;
    if (names.has(matchKey(name))) {
      problems.push(`A wildcard named «${name}» already exists: it was not created again.`);
      continue;
    }
    names.add(matchKey(name));
    const slug = freeSlug(name, slugs);
    order += 1;
    const group = draft.group === "sentinel" ? "sentinel" : "provocateur";
    created.push({
      ...emptyWildcard(options.language, group, order),
      ...normalizeFields({ name, group, mandate: draft.mandate, temperament: draft.temperament, audacity: draft.audacity, canonRespect: draft.canonRespect, outputFormat: draft.outputFormat, domain: draft.domain, body: draft.prompt }),
      id: `wildcard:custom:${slug}`,
      slug,
    });
  }
  for (const profile of created) next.set(profile.id, profile);

  const resolve = (selector: string, pool: readonly WildcardProfile[]): WildcardProfile[] => {
    const found = selectWildcards(selector, pool);
    if (!found) problems.push(isGroup(selector) ? `«${selector}» is not a group of wildcards (the groups are ${WILDCARD_GROUPS.join(", ")}).` : `No wildcard is called «${selector}».`);
    return found ?? [];
  };
  const existing = () => current.map((profile) => next.get(profile.id)!).filter((profile) => !removed.has(profile.id));
  const anyone = () => [...existing(), ...created];

  for (const change of batch.update ?? []) {
    const set = normalizeFields(change.set);
    for (const profile of resolve(change.wildcard, isGroup(change.wildcard) ? existing() : anyone())) {
      const target = next.get(profile.id)!;
      for (const [key, value] of Object.entries(set)) {
        if (key === "name" && typeof value === "string" && value && matchKey(value) !== matchKey(target.name) && [...next.values()].some((other) => other.id !== target.id && matchKey(other.name) === matchKey(value))) {
          problems.push(`«${target.name}» cannot be renamed «${value}»: another wildcard has that name.`);
          continue;
        }
        if (!value && key === "name") continue;
        if (same((target as unknown as Record<string, unknown>)[key], value)) continue;
        (target as unknown as Record<string, unknown>)[key] = value;
        // A provocateur never knows the secrets as the author does.
        if (key === "group" && value === "provocateur") target.secrets = "threshold";
        if (!created.includes(target)) touched(target.id, key);
      }
    }
  }

  const setEnabled = (profile: WildcardProfile, enabled: boolean) => {
    next.get(profile.id)!.enabled = enabled;
  };
  const switches = (selectors: readonly string[] | undefined, groups: boolean) => (selectors ?? []).filter((selector) => isGroup(selector) === groups);
  for (const selector of switches(batch.disable, true)) for (const profile of resolve(selector, existing())) setEnabled(profile, false);
  for (const selector of switches(batch.enable, true)) for (const profile of resolve(selector, existing())) setEnabled(profile, true);
  for (const selector of switches(batch.disable, false)) for (const profile of resolve(selector, anyone())) setEnabled(profile, false);
  for (const selector of switches(batch.enable, false)) for (const profile of resolve(selector, anyone())) setEnabled(profile, true);

  for (const selector of batch.remove ?? []) {
    for (const profile of resolve(selector, isGroup(selector) ? existing() : anyone())) {
      if (created.some((entry) => entry.id === profile.id)) {
        created.splice(created.findIndex((entry) => entry.id === profile.id), 1);
        next.delete(profile.id);
      } else if (profile.source === "book" && !profile.builtin) {
        removed.add(profile.id);
      } else {
        // A built-in wildcard, or one of the account, stays: removing it turns it off in this book.
        setEnabled(profile, false);
        kept.add(profile.id);
      }
    }
  }

  const rows: PageChangeRow[] = [];
  const write: WildcardProfile[] = [];
  const remove: WildcardProfile[] = [];
  for (const profile of current) {
    const after = next.get(profile.id)!;
    const changedFields = [...(fields.get(profile.id) ?? [])];
    const base = { id: profile.id, name: after.name, kind: after.group, builtin: profile.builtin, before: profile.enabled };
    if (removed.has(profile.id)) {
      rows.push({ ...base, name: profile.name, after: null, change: "removed" });
      remove.push(profile);
      continue;
    }
    const switched = after.enabled !== profile.enabled;
    const change: PageChangeRow["change"] = changedFields.length ? "edited" : switched ? (after.enabled ? "turned-on" : "turned-off") : "unchanged";
    rows.push({ ...base, after: after.enabled, change, ...(changedFields.length ? { fields: changedFields } : {}), ...(kept.has(profile.id) ? { kept: true } : {}) });
    if (change !== "unchanged") write.push(after);
  }
  for (const profile of created) {
    rows.push({ id: profile.id, name: profile.name, kind: profile.group, builtin: false, before: null, after: profile.enabled, change: "created" });
    write.push(profile);
  }
  const rank: Record<PageChangeRow["change"], number> = { created: 0, edited: 1, "turned-on": 2, "turned-off": 3, removed: 4, unchanged: 5 };
  rows.sort((left, right) => rank[left.change] - rank[right.change]);
  return { rows, write, remove, problems: [...new Set(problems)] };
}

/** The path of a wildcard's file in the book: its own file, else `wildcards/<slug>.md` (a built-in or account one gets one the first time the book changes it). */
export function wildcardFilePath(profile: WildcardProfile): string {
  return profile.source === "book" && profile.path?.startsWith("wildcards/") ? profile.path : `wildcards/${profile.slug}.md`;
}

/** The file of a wildcard: what the wildcard says, with the keys of the file now there that this version does not know kept. */
export function wildcardFileContent(profile: WildcardProfile, existing: string | null): string {
  const kept = existing ? parseWildcard(profile.slug, existing).extra ?? {} : {};
  return serializeWildcard({ ...profile, extra: { ...kept, ...(profile.extra ?? {}) } });
}
