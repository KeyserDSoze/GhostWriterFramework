import {
  OUTLINE_BOOK_FILE,
  OUTLINE_DESIGN_FIELDS,
  OUTLINE_DESIGN_KEYS,
  designMaxRounds,
  normalizeDesignPatch,
  parseMarkdown,
  renderMarkdown,
  serializeOutlineBook,
  type AutopilotState,
  type BookFileChange,
  type DesignOutcome,
  type DesignRound,
  type DesignStartInput,
  type OutlineChapterDesign,
  type OutlineDesignKey,
  type OutlineDesignPatch,
} from "narrarium-engine";
import { readReviewForm, type ReviewForm } from "@/autopilot/reviewPolicy";

/**
 * The design of the book in the Synopsis: the design of an entry as its card edits it, how far the design run of the autopilot got (`state.design`), and the
 * author's approval of a design. Pure.
 */

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

// ─── The design run of the autopilot ──────────────────────────────────────────

export type DesignStatus =
  /** The book was never designed by the autopilot. */
  | { kind: "none" }
  /** A design goes on (a run designs it now, or it is paused, or waits for an answer). */
  | { kind: "active"; startedAt: string; chapters: number; rounds: DesignRound[]; maxRounds: number; target?: number }
  /** The director approved the design: it waits for the author. */
  | { kind: "ready"; startedAt: string; chapters: number; rounds: DesignRound[]; maxRounds: number; target?: number; endedAt: string; outcome: Exclude<DesignOutcome, "author"> }
  /** The author ended the design and the autopilot went on to write. */
  | { kind: "ended"; startedAt: string; endedAt: string };

export function designStatusOf(state: Pick<AutopilotState, "design"> | null | undefined): DesignStatus {
  const design = state?.design;
  if (!design) return { kind: "none" };
  const common = { startedAt: design.startedAt, chapters: design.chapters, rounds: design.rounds, maxRounds: designMaxRounds(design), ...(design.review?.targetScore !== undefined ? { target: design.review.targetScore } : {}) };
  if (!design.endedAt) return { kind: "active", ...common };
  if (design.outcome === "author" || !design.outcome) return { kind: "ended", startedAt: design.startedAt, endedAt: design.endedAt };
  return { kind: "ready", ...common, endedAt: design.endedAt, outcome: design.outcome };
}

/** The release of the personal server that designs a book (`autopilot-design`: `design` in the start of a run). */
export const DESIGN_SERVER_VERSION = "0.1.20";

/** Why the design of the book cannot begin now, or `null`: a book needs a description, and no chapter written by the autopilot. */
export type DesignBlock = "description" | "written" | "server";

export function designBlockOf(input: { description: string; state: Pick<AutopilotState, "plan"> | null | undefined; serverWithoutDesign?: boolean }): DesignBlock | null {
  if (!input.description.trim()) return "description";
  if ((input.state?.plan?.chapters ?? []).some((chapter) => !chapter.imported && chapter.scenes.some((scene) => scene.status !== "planned"))) return "written";
  if (input.serverWithoutDesign) return "server";
  return null;
}

/** The form of the dialog «Design the book»: the chapters, the readers, and the review fields of a run (the money cap is the book's). */
export interface DesignForm extends ReviewForm {
  chapters: string;
  readers: boolean;
}

/** The chapters the dialog offers first: the entries the Synopsis has, else the length of a new book of the default size. */
export function defaultDesignChapters(entries: number): number {
  return entries > 0 ? entries : 12;
}

/** What the form says, checked: the chapters (whole, from the entries the Synopsis has to 500) and the review. */
export function readDesignForm(form: DesignForm, entries: number): { input: DesignStartInput; budgetLimit: number; readers: boolean; valid: boolean; chaptersProblem: "number" | "range" | null; review: ReturnType<typeof readReviewForm> } {
  const review = readReviewForm(form);
  const typed = Number(form.chapters.trim());
  const chaptersProblem = !form.chapters.trim() || !Number.isInteger(typed) ? "number" : typed < Math.max(1, entries) || typed > 500 ? "range" : null;
  const policy = { ...(review.policy.targetScore !== undefined ? { targetScore: review.policy.targetScore } : {}), ...(review.policy.maxRounds !== undefined ? { maxRounds: review.policy.maxRounds } : {}), ...(review.policy.readerRounds !== undefined ? { readerRounds: review.policy.readerRounds } : {}) };
  return {
    input: { ...(chaptersProblem ? {} : { chapters: typed }), review: Object.keys(policy).length ? policy : null },
    budgetLimit: review.budgetLimit,
    readers: form.readers,
    valid: review.valid && !chaptersProblem,
    chaptersProblem,
    review,
  };
}

// ─── The author's approval ────────────────────────────────────────────────────

/** The key of `outline/book.md` that keeps the author's approval of a design: when, and which design run it approves (`state.design.startedAt`). */
export const DESIGN_APPROVED_KEY = "design_approved";

export interface DesignApproval {
  at: string;
  /** The design run it approves; another run (the design made again) is not approved by it. */
  run: string;
}

export function designApprovalOf(bookFile: string | undefined): DesignApproval | null {
  if (!bookFile) return null;
  const value = parseMarkdown(bookFile).frontmatter[DESIGN_APPROVED_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.at === "string" && typeof record.run === "string" ? { at: record.at, run: record.run } : null;
}

/**
 * The change that records the approval of the design run `run` in `outline/book.md` (the description and its fingerprint do not change: the key is beside them). A
 * book without the file gets one with an empty description.
 */
export function approveDesignChange(bookFile: { content: string; hash: string } | undefined, run: string, now: Date): BookFileChange {
  const approval = { at: now.toISOString(), run };
  if (!bookFile) return { path: OUTLINE_BOOK_FILE, content: serializeOutlineBook({ body: "", origin: "author", frontmatter: { [DESIGN_APPROVED_KEY]: approval } }), expectedHash: null };
  const document = parseMarkdown(bookFile.content);
  // A frontmatter that cannot be read is never rewritten from what could be read of it: its keys would be lost.
  if (document.error) throw new Error(`${OUTLINE_BOOK_FILE}: ${document.error}`);
  return { path: OUTLINE_BOOK_FILE, content: renderMarkdown({ ...document.frontmatter, [DESIGN_APPROVED_KEY]: approval }, document.body), expectedHash: bookFile.hash };
}
