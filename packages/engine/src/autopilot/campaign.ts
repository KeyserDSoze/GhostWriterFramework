import { inRevision, startedReview } from "./chapter-state.js";
import { beginOutlineRewrite, campaignGoesOn, isFrozenQuestion, withDeferral, withoutDeferrals, type FrozenStatus, type FrozenWorkItem, type PlannerFrozen } from "./frozen.js";
import type { PlanNote } from "./planner.js";
import { CAMPAIGN_NOTE_CHARACTERS, MAX_BOOK_CHAPTERS, MAX_CAMPAIGN_CHAPTERS } from "./state.js";
import {
  REVISION_CHAPTER_MODES,
  REVISION_REASONS,
  type AutopilotState,
  type PlannedChapter,
  type RevisionCampaign,
  type RevisionCampaignChapter,
  type RevisionChapterMode,
  type RevisionReason,
} from "./types.js";
import { randomId } from "../util/hash.js";
import { clipText, isItalian } from "../util/text.js";

/**
 * Campaigns: «revise THESE chapters now, for THIS reason, in order, then go on with the plan», one mechanism for every reason (`RevisionReason`).
 *
 * The author names the chapters and, for each, what to do (`follow`: work it now; `keep`: keep it as it is; `later`: decide later), with their own words for
 * the director (a `note` for all of them, an `instruction` for one). The campaign is saved in the state at once, also while a run goes on
 * (`AutopilotSession.reviseChapters`), and the run carries it out before the plan: one chapter at a time, in the order of the book, each started when nothing
 * else is in progress and finished when the chapter is closed again; a chapter whose reason is gone is skipped and said. It survives a restart (it is in the
 * state), is cancelled by the author (`cancelRevisionCampaign`: the chapters that wait end, the one being worked finishes), and is taken away once no chapter
 * waits or is being worked, with what it did told once. While it goes on no question about a change is asked, and the autopilot decides nothing for its chapters.
 *
 * What a reason does is its handler (`REVISION_REASON_HANDLERS`): how it checks the chapters against the book (`check`), what recording does at once
 * (`record`), how a chapter begins and when it is over (`start`, `finished`), what keeping one does (`keep`), what cancelling does (`cancel`), when the campaign
 * stops before the next chapter (`stop`) and what it does after the last (`complete`), and how it words what it did (`texts`).
 *
 * - `outline-change` (the author applied the Synopsis to the book): the chapters are the written chapters whose entry changed (`frozenWork`, kind
 *   `outline`); `follow` rewrites the chapter to follow its new entry (`beginOutlineRewrite`, and no later chapter is checked: the author chose each chapter
 *   that changes), `keep` keeps the text and the plan follows the entry, `later` leaves the change for the author (`DeferredChange`). A chapter the author
 *   wrote is rewritten only because the author chose it here: the autopilot never does it on its own.
 */

export type RevisionCampaignErrorCode = "invalid_request" | "campaign_active" | "not_changed" | "stale";

/** The codes of `RevisionCampaignError`, which the personal server answers with as they are. */
export const REVISION_CAMPAIGN_ERROR_CODES: readonly RevisionCampaignErrorCode[] = ["invalid_request", "campaign_active", "not_changed", "stale"];

/** Whether a code is one of `RevisionCampaignError`'s. A host that sent a campaign reads the refusal of the server with it. */
export function isRevisionCampaignErrorCode(code: unknown): code is RevisionCampaignErrorCode {
  return typeof code === "string" && (REVISION_CAMPAIGN_ERROR_CODES as readonly string[]).includes(code);
}

/** A campaign that cannot be recorded: what was asked is not one (`invalid_request`), one goes on (`campaign_active`), a chapter has no such change (`not_changed`), or it changed since the author saw it (`stale`). */
export class RevisionCampaignError extends Error {
  constructor(readonly code: RevisionCampaignErrorCode, message: string) {
    super(message);
    this.name = "RevisionCampaignError";
  }
}

export interface ReviseChaptersInput {
  reason: RevisionReason;
  /** Each chapter once; the campaign works them in the order of the book. */
  chapters: ReadonlyArray<{ number: number; mode: RevisionChapterMode; instruction?: string; fingerprint?: string }>;
  note?: string;
}

/** What `AutopilotSession.reviseChapters` and `cancelRevisionCampaign` answer: the campaign as it is saved (`null`: none goes on), and the changes after it. */
export interface RevisionCampaignResult {
  campaign: RevisionCampaign | null;
  frozen: FrozenStatus;
}

/** How beginning a chapter went: begun, skipped (nothing to do: `why`), or not yet (`wait`). */
export type CampaignStart = { outcome: "started" } | { outcome: "skip"; why: NonNullable<RevisionCampaignChapter["why"]> } | { outcome: "wait" };

/** What a reason does with its chapters (see the module). The extension point of the campaigns: a reason is one entry of `REVISION_REASON_HANDLERS`. */
export interface RevisionReasonHandler {
  /** The chapters as the campaign keeps them, checked against what the author decides about now (`items`, from `frozenWork`). Throws a `RevisionCampaignError`. */
  check(input: ReviseChaptersInput, items: readonly FrozenWorkItem[]): RevisionCampaignChapter[];
  /** What recording the campaign does at once (pure). `running`: the plan is the run's, and what changes it waits for the run's next step. */
  record(state: AutopilotState, campaign: RevisionCampaign, at: string, running: boolean): AutopilotState;
  /** Begin the work of a chapter (mutates `state`). */
  start(state: AutopilotState, chapter: PlannedChapter, item: RevisionCampaignChapter, campaign: RevisionCampaign, frozen: PlannerFrozen): CampaignStart;
  /** Whether the work of a chapter that began is over. */
  finished(state: AutopilotState, chapter: PlannedChapter): boolean;
  /** Keep a chapter as it is, when the run does it (mutates). */
  keep(state: AutopilotState, chapter: PlannedChapter, item: RevisionCampaignChapter): void;
  /** What becomes of the chapters the author cancelled before they began (pure). */
  cancel(state: AutopilotState, cancelled: readonly RevisionCampaignChapter[], at: string): AutopilotState;
  /** A reason to stop the campaign before its next chapter (`null`: go on). The chapters that wait end as cancelled (and `cancel` says what becomes of them), and the words say why (`campaignStopped`'s detail). */
  stop?(state: AutopilotState, campaign: RevisionCampaign, language: string): string | null;
  /** After the last chapter (mutates). */
  complete?(state: AutopilotState, campaign: RevisionCampaign): void;
  texts: {
    chapterDone(number: number, done: number, total: number, language: string): string;
    skipped(number: number, why: NonNullable<RevisionCampaignChapter["why"]>, language: string): string;
    done(worked: number, language: string): string;
  };
}

function text(language: string, en: string, it: string): string {
  return isItalian(language) ? it : en;
}

/** The decisions of the author that a campaign replaces for its chapters: the ones that wait (not begun), the ones to decide later, the question about them. */
function withoutDecisionsFor(state: AutopilotState, numbers: ReadonlySet<number>, kind: "outline" | "frozen"): AutopilotState {
  let next = state;
  for (const number of numbers) next = withoutDeferrals(next, number, kind);
  const pendingReviews = (next.pendingReviews ?? []).filter((entry) => entry.started || entry.kind !== kind || !numbers.has(entry.number));
  const { pendingReviews: _before, ...rest } = next;
  next = pendingReviews.length ? { ...rest, pendingReviews } : rest;
  if (isFrozenQuestion(next.question) && next.question.frozen.kind === kind && numbers.has(next.question.frozen.number)) {
    next = { ...next, question: null, message: null, status: next.status === "waiting-author" ? "paused" : next.status };
  }
  return next;
}

const outlineChange: RevisionReasonHandler = {
  check(input, items) {
    return input.chapters.map((chapter) => {
      const item = items.find((entry) => entry.kind === "outline" && entry.inPlan && entry.number === chapter.number);
      if (!item) throw new RevisionCampaignError("not_changed", `Chapter ${chapter.number} has no change of its synopsis entry to apply: it is not written, the autopilot has it in its hands, or its entry is the one it follows.`);
      if (chapter.fingerprint !== undefined && chapter.fingerprint !== item.fingerprint) throw new RevisionCampaignError("stale", `The synopsis entry of chapter ${chapter.number} changed again since it was looked at: look at it again.`);
      const instruction = chapter.instruction?.trim() ? clipText(chapter.instruction.trim(), CAMPAIGN_NOTE_CHARACTERS) : undefined;
      return { number: chapter.number, mode: chapter.mode, fingerprint: item.fingerprint, status: "waiting" as const, ...(instruction ? { instruction } : {}) };
    });
  },
  record(input, campaign, at, running) {
    let state = withoutDecisionsFor(input, new Set(campaign.chapters.map((chapter) => chapter.number)), "outline");
    state = structuredClone(state);
    const chapters = campaign.chapters.map((item) => ({ ...item }));
    for (const item of chapters) {
      if (item.mode === "later") {
        state = withDeferral(state, { kind: "outline", number: item.number, fingerprint: item.fingerprint ?? "" }, at);
        Object.assign(item, { status: "done", endedAt: at });
      } else if (item.mode === "keep" && !running) {
        // Nobody runs: the plan follows the entry now, in the same commit. While a run goes on the plan is its own, and it keeps it at its next step.
        const planned = state.plan?.chapters.find((chapter) => chapter.number === item.number);
        if (planned && item.fingerprint) planned.outlineDigest = item.fingerprint;
        Object.assign(item, { status: "done", endedAt: at });
      }
    }
    const next = { ...campaign, chapters };
    return chapters.some((item) => item.status === "waiting") ? { ...state, campaign: next } : state;
  },
  start(state, chapter, item, campaign, frozen) {
    // The outline is compared with an approved plan only, and a chapter the autopilot has in its hands is not taken from it.
    if (!state.plan?.approved || chapter.status !== "done") return { outcome: "wait" };
    const outline = frozen.outlineWritten.get(item.number);
    if (!outline) return { outcome: "skip", why: "gone" };
    const note = [campaign.note, item.instruction].filter(Boolean).join("\n");
    beginOutlineRewrite(state, chapter, outline, { id: `${campaign.id}-${item.number}`, createdAt: frozen.now, ...(note ? { note } : {}) });
    // The book is rewritten: nobody has judged it as it is going to be.
    state.finalDone = false;
    delete state.finalReview;
    return { outcome: "started" };
  },
  finished(state, chapter) {
    return chapter.status === "done" && !inRevision(state, chapter.number) && state.review?.chapterNumber !== chapter.number;
  },
  keep(_state, chapter, item) {
    if (item.fingerprint) chapter.outlineDigest = item.fingerprint;
  },
  cancel(input, cancelled, at) {
    // What the author did not see through is left for the author: decided later, so that nothing rewrites it, and nothing asks about it, until they decide.
    let state = input;
    for (const item of cancelled) if (item.fingerprint) state = withDeferral(state, { kind: "outline", number: item.number, fingerprint: item.fingerprint }, at);
    return state;
  },
  texts: {
    chapterDone: (number, done, total, language) => text(language, `Chapter ${number} now follows the new synopsis (${done} of ${total})`, `Il capitolo ${number} ora segue la nuova Sinossi (${done} di ${total})`),
    skipped: (number, why, language) => why === "gone"
      ? text(language, `Chapter ${number}: its synopsis entry is again the one it follows, nothing to rewrite`, `Capitolo ${number}: la sua voce della Sinossi è di nuovo quella che segue, non c'è nulla da riscrivere`)
      : text(language, `Chapter ${number} is no longer in the plan: it is left out`, `Il capitolo ${number} non è più nel piano: viene lasciato fuori`),
    done: (worked, language) => text(
      language,
      `The synopsis is applied to the book: ${worked === 1 ? "1 chapter" : `${worked} chapters`} rewritten to follow it. The plan goes on.`,
      `La Sinossi è applicata al libro: ${worked === 1 ? "1 capitolo riscritto" : `${worked} capitoli riscritti`} per seguirla. Il piano prosegue.`,
    ),
  },
};

/** The handlers of the reasons: the extension point of the campaigns. */
export const REVISION_REASON_HANDLERS: Readonly<Record<RevisionReason, RevisionReasonHandler>> = { "outline-change": outlineChange };

/** A campaign from what the author asked, checked against what the book is now (`items`: `frozenWork`). Throws a `RevisionCampaignError`. */
export function createRevisionCampaign(input: ReviseChaptersInput, items: readonly FrozenWorkItem[], now: Date, id: string = randomId("campaign")): RevisionCampaign {
  if (!input || typeof input !== "object") throw new RevisionCampaignError("invalid_request", "A campaign is { reason, chapters: [{ number, mode }], note? }.");
  if (!(REVISION_REASONS as readonly string[]).includes(input.reason)) throw new RevisionCampaignError("invalid_request", `The reason is one of: ${REVISION_REASONS.join(", ")}.`);
  if (!Array.isArray(input.chapters) || !input.chapters.length || input.chapters.length > MAX_CAMPAIGN_CHAPTERS) throw new RevisionCampaignError("invalid_request", `A campaign has from 1 to ${MAX_CAMPAIGN_CHAPTERS} chapters.`);
  const seen = new Set<number>();
  for (const chapter of input.chapters) {
    if (!chapter || !Number.isSafeInteger(chapter.number) || chapter.number < 1 || chapter.number > MAX_BOOK_CHAPTERS) throw new RevisionCampaignError("invalid_request", "A chapter of a campaign has a number from 1.");
    if (seen.has(chapter.number)) throw new RevisionCampaignError("invalid_request", `Chapter ${chapter.number} is named twice.`);
    seen.add(chapter.number);
    if (!(REVISION_CHAPTER_MODES as readonly string[]).includes(chapter.mode)) throw new RevisionCampaignError("invalid_request", `What to do with chapter ${chapter.number} is one of: ${REVISION_CHAPTER_MODES.join(", ")}.`);
    if (chapter.instruction !== undefined && typeof chapter.instruction !== "string") throw new RevisionCampaignError("invalid_request", `The instruction of chapter ${chapter.number} is a text.`);
    if (chapter.fingerprint !== undefined && typeof chapter.fingerprint !== "string") throw new RevisionCampaignError("invalid_request", `The fingerprint of chapter ${chapter.number} is a text.`);
  }
  if (input.note !== undefined && typeof input.note !== "string") throw new RevisionCampaignError("invalid_request", "The note of a campaign is a text.");
  const chapters = REVISION_REASON_HANDLERS[input.reason].check(input, items).sort((left, right) => left.number - right.number);
  const note = input.note?.trim() ? clipText(input.note.trim(), CAMPAIGN_NOTE_CHARACTERS) : undefined;
  return { id, reason: input.reason, createdAt: now.toISOString(), ...(note ? { note } : {}), chapters };
}

/** The state with a campaign recorded (pure): refused while another one goes on. */
export function recordRevisionCampaign(state: AutopilotState, campaign: RevisionCampaign, at: string, running: boolean): AutopilotState {
  if (campaignGoesOn(state)) throw new RevisionCampaignError("campaign_active", "Chapters are being revised already: wait until they are done, or cancel what waits.");
  const { campaign: _done, ...rest } = state;
  return REVISION_REASON_HANDLERS[campaign.reason].record(rest, campaign, at, running);
}

/** The state with the chapters of the campaign that wait cancelled (the one being worked finishes); the campaign goes once nothing of it is left to do. */
export function cancelRevisionCampaign(state: AutopilotState, at: string): AutopilotState {
  const campaign = state.campaign;
  if (!campaign) return state;
  const cancelled = campaign.chapters.filter((item) => item.status === "waiting");
  const chapters = campaign.chapters.map((item) => (item.status === "waiting" ? { ...item, status: "cancelled" as const, endedAt: at } : item));
  const next = REVISION_REASON_HANDLERS[campaign.reason].cancel({ ...state, campaign: { ...campaign, chapters } }, cancelled, at);
  if (chapters.some((item) => item.status === "working")) return next;
  const { campaign: _gone, ...rest } = next;
  return rest;
}

/**
 * What advancing the state does with the campaign (`advanceState` calls it, after the decisions about changes): the chapters kept by the author while a run
 * went on, the end of the chapter being worked, and, when the planner may start one (`frozen` is given) and nothing else is in progress, the next chapter
 * that waits, in the order of the book (unless the reason says to stop). Once nothing waits or is being worked, the campaign is done, said once, and goes.
 * Mutates `state`; deterministic (every moment comes from `frozen.now`).
 */
export function advanceRevisionCampaign(state: AutopilotState, report: (note: PlanNote) => void, language: string, frozen?: PlannerFrozen): void {
  const campaign = state.campaign;
  const plan = state.plan;
  if (!campaign || !plan || !frozen) return;
  const handler = REVISION_REASON_HANDLERS[campaign.reason];
  const chapterOf = (number: number) => plan.chapters.find((chapter) => chapter.number === number);
  const worked = () => campaign.chapters.filter((item) => item.mode === "follow");
  const end = (item: RevisionCampaignChapter, status: "done" | "skipped" | "cancelled", why?: RevisionCampaignChapter["why"]) => Object.assign(item, { status, endedAt: frozen.now, ...(why ? { why } : {}) });

  for (const item of campaign.chapters) {
    if (item.mode !== "keep" || item.status !== "waiting") continue;
    const chapter = chapterOf(item.number);
    if (chapter) handler.keep(state, chapter, item);
    end(item, "done");
  }

  const working = campaign.chapters.find((item) => item.status === "working");
  if (working) {
    const chapter = chapterOf(working.number);
    if (chapter && !handler.finished(state, chapter)) return;
    end(working, chapter ? "done" : "skipped", chapter ? undefined : "not-in-plan");
    const over = worked().filter((item) => item.status === "done" || item.status === "skipped").length;
    if (chapter) report({ key: `campaign-chapter:${campaign.id}:${working.number}`, tone: "ok", code: "campaignChapterDone", chapterNumber: working.number, title: handler.texts.chapterDone(working.number, over, worked().filter((item) => item.status !== "cancelled").length, language) });
  }

  const idle = !state.question && !state.revision && !state.review && !startedReview(state);
  let stopped: string | null = null;
  if (idle) {
    stopped = handler.stop?.(state, campaign, language) ?? null;
    if (stopped) {
      // The chapters that wait end as if the author cancelled them: what becomes of them is the reason's (`cancel`).
      const left = campaign.chapters.filter((item) => item.status === "waiting");
      for (const item of left) end(item, "cancelled");
      Object.assign(state, handler.cancel(state, left, frozen.now));
      report({ key: `campaign-stopped:${campaign.id}`, tone: "warning", code: "campaignStopped", title: text(language, "The revision of the chosen chapters stopped before its end: the chapters that waited are left to you", "La revisione dei capitoli scelti si è fermata prima della fine: i capitoli che aspettavano restano a te"), detail: stopped });
    } else {
      for (const item of campaign.chapters) {
        if (item.status !== "waiting" || item.mode !== "follow") continue;
        const chapter = chapterOf(item.number);
        if (!chapter) {
          end(item, "skipped", "not-in-plan");
          report({ key: `campaign-skipped:${campaign.id}:${item.number}`, tone: "info", code: "campaignSkipped", chapterNumber: item.number, title: handler.texts.skipped(item.number, "not-in-plan", language) });
          continue;
        }
        const started = handler.start(state, chapter, item, campaign, frozen);
        if (started.outcome === "wait") break;
        if (started.outcome === "skip") {
          end(item, "skipped", started.why);
          report({ key: `campaign-skipped:${campaign.id}:${item.number}`, tone: "info", code: "campaignSkipped", chapterNumber: item.number, title: handler.texts.skipped(item.number, started.why, language) });
          continue;
        }
        Object.assign(item, { status: "working", startedAt: frozen.now });
        return;
      }
    }
  }

  if (campaign.chapters.some((item) => item.status === "waiting" || item.status === "working")) return;
  handler.complete?.(state, campaign);
  const rewritten = worked().filter((item) => item.status === "done").length;
  if (!stopped && (rewritten || worked().some((item) => item.status === "skipped"))) report({ key: `campaign-done:${campaign.id}`, tone: "ok", code: "campaignDone", title: handler.texts.done(rewritten, language) });
  delete state.campaign;
}

/** The chapter the campaign works now, while it is not closed again: it comes before the plan. */
export function campaignChapter(state: AutopilotState): PlannedChapter | undefined {
  const number = state.campaign?.chapters.find((item) => item.status === "working")?.number;
  const chapter = number === undefined ? undefined : state.plan?.chapters.find((entry) => entry.number === number);
  return chapter && chapter.status !== "done" ? chapter : undefined;
}

/** The campaigns' half of what the run merges when the author wrote the state during a step: the author's new campaign, and the chapters the author cancelled that had not begun. */
export function mergeCampaign(working: RevisionCampaign | undefined, base: RevisionCampaign | undefined, stored: RevisionCampaign | undefined): RevisionCampaign | undefined {
  if (JSON.stringify(base ?? null) === JSON.stringify(stored ?? null)) return working;
  if (stored && stored.id !== working?.id) return stored;
  if (!stored) {
    // Cancelled and taken away by the author: what this step began finishes, the rest is over.
    if (!working) return undefined;
    const chapters = working.chapters.map((item) => (item.status === "waiting" ? { ...item, status: "cancelled" as const } : item));
    return chapters.some((item) => item.status === "working") ? { ...working, chapters } : undefined;
  }
  if (!working) return stored;
  const chapters = working.chapters.map((item) => {
    const theirs = stored.chapters.find((entry) => entry.number === item.number);
    return item.status === "waiting" && theirs?.status === "cancelled" ? { ...item, status: "cancelled" as const, ...(theirs.endedAt ? { endedAt: theirs.endedAt } : {}) } : item;
  });
  return { ...working, chapters };
}
