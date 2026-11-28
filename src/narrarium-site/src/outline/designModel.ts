import {
  DESIGN_APPROVED_KEY,
  OUTLINE_BOOK_FILE,
  OUTLINE_DESIGN_FIELDS,
  OUTLINE_DESIGN_KEYS,
  designMaxRounds,
  normalizeDesignPatch,
  parseMarkdown,
  readDesignApproval,
  renderMarkdown,
  serializeOutlineBook,
  type AutopilotState,
  type BookFileChange,
  type DesignApproval,
  type DesignMode,
  type DesignModeChoice,
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
  /** A design goes on (a run designs it now, or it is paused, or waits for an answer). `mode`: «Review and complete» (`complete`), else a design of the book. */
  | { kind: "active"; startedAt: string; chapters: number; rounds: DesignRound[]; maxRounds: number; target?: number; mode: DesignMode }
  /** The director approved the design: it waits for the author. */
  | { kind: "ready"; startedAt: string; chapters: number; rounds: DesignRound[]; maxRounds: number; target?: number; endedAt: string; outcome: Exclude<DesignOutcome, "author">; mode: DesignMode }
  /** The author ended the design and the autopilot went on to write. */
  | { kind: "ended"; startedAt: string; endedAt: string; mode: DesignMode };

export function designStatusOf(state: Pick<AutopilotState, "design"> | null | undefined): DesignStatus {
  const design = state?.design;
  if (!design) return { kind: "none" };
  const mode: DesignMode = design.mode === "complete" ? "complete" : "plan";
  const common = { startedAt: design.startedAt, chapters: design.chapters, rounds: design.rounds, maxRounds: designMaxRounds(design), ...(design.review?.targetScore !== undefined ? { target: design.review.targetScore } : {}), mode };
  if (!design.endedAt) return { kind: "active", ...common };
  if (design.outcome === "author" || !design.outcome) return { kind: "ended", startedAt: design.startedAt, endedAt: design.endedAt, mode };
  return { kind: "ready", ...common, endedAt: design.endedAt, outcome: design.outcome };
}

/** The release of the personal server that designs a book (`autopilot-design`: `design` in the start of a run). */
export const DESIGN_SERVER_VERSION = "0.1.20";

/**
 * Why the design of the book cannot begin now, or `null`: a book needs a description or chapters of the author's (the description for a design of the book, the
 * chapters for «Review and complete»), and no chapter written by the autopilot.
 */
export type DesignBlock = "description" | "written" | "server";

export function designBlockOf(input: { description: string; state: Pick<AutopilotState, "plan"> | null | undefined; serverWithoutDesign?: boolean; authorChapters?: number }): DesignBlock | null {
  if (!input.description.trim() && !input.authorChapters) return "description";
  if ((input.state?.plan?.chapters ?? []).some((chapter) => !chapter.imported && chapter.scenes.some((scene) => scene.status !== "planned"))) return "written";
  if (input.serverWithoutDesign) return "server";
  return null;
}

/**
 * Why a mode of the design cannot run now, or `null`: «Design the book» needs a description, «Review and complete» chapters of the author's and, on a personal server,
 * one that knows it.
 */
export type DesignModeBlock = "description" | "chapters" | "server";

export function designModeBlockOf(mode: DesignMode, input: { description: string; choice: Pick<DesignModeChoice, "written">; serverWithoutComplete?: boolean }): DesignModeBlock | null {
  if (mode === "plan") return input.description.trim() ? null : "description";
  if (!input.choice.written.length) return "chapters";
  return input.serverWithoutComplete ? "server" : null;
}

/** The mode the dialog offers first: the one the book's Synopsis suggests (`designModeChoice`), unless it cannot run while the other can. */
export function initialDesignMode(choice: DesignModeChoice, input: { description: string; serverWithoutComplete?: boolean }): DesignMode {
  const suggested = choice.mode;
  const other: DesignMode = suggested === "complete" ? "plan" : "complete";
  if (designModeBlockOf(suggested, { ...input, choice }) && !designModeBlockOf(other, { ...input, choice })) return other;
  return suggested;
}

/** The form of the dialog «Design the book»: the mode, the chapters, the readers, and the review fields of a run (the money cap is the book's). */
export interface DesignForm extends ReviewForm {
  mode?: DesignMode;
  chapters: string;
  readers: boolean;
}

/** The chapters the dialog offers first: the entries the Synopsis has, else the length of a new book of the default size. */
export function defaultDesignChapters(entries: number): number {
  return entries > 0 ? entries : 12;
}

/**
 * What the form says, checked: the chapters (whole, from the entries the Synopsis has to 500) and the review. «Review and complete» takes no chapters: it reviews the
 * ones the Synopsis has.
 */
export function readDesignForm(form: DesignForm, entries: number): { input: DesignStartInput; budgetLimit: number; readers: boolean; valid: boolean; chaptersProblem: "number" | "range" | null; review: ReturnType<typeof readReviewForm> } {
  const review = readReviewForm(form);
  const complete = form.mode === "complete";
  const typed = Number(form.chapters.trim());
  const chaptersProblem = complete ? null : !form.chapters.trim() || !Number.isInteger(typed) ? "number" : typed < Math.max(1, entries) || typed > 500 ? "range" : null;
  const policy = { ...(review.policy.targetScore !== undefined ? { targetScore: review.policy.targetScore } : {}), ...(review.policy.maxRounds !== undefined ? { maxRounds: review.policy.maxRounds } : {}), ...(review.policy.readerRounds !== undefined ? { readerRounds: review.policy.readerRounds } : {}) };
  return {
    input: { ...(complete ? { mode: "complete" as const } : chaptersProblem ? {} : { chapters: typed }), review: Object.keys(policy).length ? policy : null },
    budgetLimit: review.budgetLimit,
    readers: form.readers,
    valid: review.valid && !chaptersProblem,
    chaptersProblem,
    review,
  };
}

// ─── The author's approval ────────────────────────────────────────────────────

/** The key of `outline/book.md` that keeps the author's approval of a design (the engine's: the writing autopilot reads it, `readDesignApproval`). */
export { DESIGN_APPROVED_KEY };
export type { DesignApproval };

export function designApprovalOf(bookFile: string | undefined): DesignApproval | null {
  if (!bookFile) return null;
  return readDesignApproval(parseMarkdown(bookFile).frontmatter);
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
