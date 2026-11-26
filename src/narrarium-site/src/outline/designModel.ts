import { OUTLINE_DESIGN_FIELDS, OUTLINE_DESIGN_KEYS, normalizeDesignPatch, type OutlineChapterDesign, type OutlineDesignKey, type OutlineDesignPatch } from "narrarium-engine";

/** The design of the book in the Synopsis: the design of an entry as its card edits it. Pure. */

// ─── The design of an entry, as its card edits it ─────────────────────────────

/** The design of an entry as the form holds it: a text as it is typed, a list as its lines, the cliffhanger as a box. */
export type DesignDraft = Partial<Record<OutlineDesignKey, string | boolean>>;

const KINDS = new Map(OUTLINE_DESIGN_FIELDS.map((field) => [field.key, field.kind]));

export function designDraftOf(design: OutlineChapterDesign | undefined): DesignDraft {
  const draft: DesignDraft = {};
  for (const key of OUTLINE_DESIGN_KEYS) {
    const value = design?.[key];
    if (value === undefined) continue;
    draft[key] = Array.isArray(value) ? value.join("\n") : value;
  }
  return draft;
}

/** The change a draft makes, every field set or taken away (the keys of the design the engine does not know stay): what a save sends. */
export function designPatchOf(draft: DesignDraft): OutlineDesignPatch {
  const whole: Record<string, unknown> = {};
  for (const key of OUTLINE_DESIGN_KEYS) {
    const value = draft[key];
    whole[key] = KINDS.get(key) === "flag" ? (value === true ? true : null) : typeof value === "string" && value.trim() ? value : null;
  }
  return normalizeDesignPatch(whole).patch;
}

/** The design a draft says, as the engine would read it once saved. */
export function designOfDraft(draft: DesignDraft): OutlineChapterDesign {
  const patch = designPatchOf(draft);
  const design: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) if (value !== null && value !== undefined) design[key] = value;
  return design as OutlineChapterDesign;
}

const sameValue = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** Whether a draft says what the entry's design says (no draft says it too). */
export function sameDesign(draft: DesignDraft | undefined, design: OutlineChapterDesign | undefined): boolean {
  if (!draft) return true;
  const drafted = designOfDraft(draft);
  return OUTLINE_DESIGN_KEYS.every((key) => sameValue(drafted[key], design?.[key]));
}

/** How many fields of a design say something. */
export function filledDesignFields(design: OutlineChapterDesign | undefined): number {
  if (!design) return 0;
  return OUTLINE_DESIGN_KEYS.filter((key) => {
    const value = design[key];
    return value === true || (typeof value === "string" && value.trim()) || (Array.isArray(value) && value.length > 0);
  }).length;
}
