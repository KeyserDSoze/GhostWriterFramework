import type { BookSnapshot } from "../book/snapshot.js";
import { inRevision, startedReview } from "./chapter-state.js";
import { authorHeldChapters, beginOutlineRewrite, campaignGoesOn, isFrozenQuestion, withDeferral, withoutDeferrals, type FrozenStatus, type FrozenWorkItem, type PlannerFrozen } from "./frozen.js";
import type { PlanNote } from "./planner.js";
import { gateFor, normalizeReviewPolicy, readerGate, type ReaderTargets } from "./review-policy.js";
import { blockerText, chapterStanding } from "./review-readers.js";
import { CAMPAIGN_NOTE_CHARACTERS, MAX_BOOK_CHAPTERS, MAX_CAMPAIGN_CHAPTERS, MAX_REVIEW_RECORDS, MAX_REVIEW_ROUNDS_KEPT } from "./state.js";
import {
  REVIEW_MAX_CAMPAIGN_ROUNDS,
  REVIEW_MAX_ROUNDS,
  REVISION_CHAPTER_MODES,
  REVISION_REASONS,
  type AutopilotInsightFigures,
  type AutopilotMessageCode,
  type AutopilotState,
  type PlannedChapter,
  type ReviewOutcome,
  type ReviewRecord,
  type ReviewVotes,
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

export type RevisionCampaignErrorCode = "invalid_request" | "campaign_active" | "not_changed" | "stale" | "not_finished" | "nothing_to_review";

/** The codes of `RevisionCampaignError`, which the personal server answers with as they are. */
export const REVISION_CAMPAIGN_ERROR_CODES: readonly RevisionCampaignErrorCode[] = ["invalid_request", "campaign_active", "not_changed", "stale", "not_finished", "nothing_to_review"];

/** Whether a code is one of `RevisionCampaignError`'s. A host that sent a campaign reads the refusal of the server with it. */
export function isRevisionCampaignErrorCode(code: unknown): code is RevisionCampaignErrorCode {
  return typeof code === "string" && (REVISION_CAMPAIGN_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * A campaign that cannot be recorded: what was asked is not one (`invalid_request`), one goes on (`campaign_active`), a chapter has no such change (`not_changed`), or it
 * changed since the author saw it (`stale`); a review of the book asked of a book that is not finished (`not_finished`), or whose chapters all have the target already
 * (`nothing_to_review`).
 */
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

/** What a reason does once the chapters of its campaign are over: the campaign ends (`end`), waits (`wait`), or goes on with the chapters of another round (`again`). */
export type CampaignNext = "end" | "wait" | "again";

/** What the words of a chapter done know: the chapter as it is now, and the campaign. */
export interface CampaignChapterContext {
  chapter: PlannedChapter;
  campaign: RevisionCampaign;
}

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
  /**
   * Once no chapter waits or is being worked (and the author did not cancel the campaign): what comes next (`CampaignNext`; without this hook the campaign ends,
   * said with `texts.done`). A reason with this hook says how it ended itself. Mutates `state` and `campaign`; every moment comes from `frozen.now`.
   */
  afterChapters?(state: AutopilotState, campaign: RevisionCampaign, frozen: PlannerFrozen, report: (note: PlanNote) => void, language: string): CampaignNext;
  /** A run starts: the campaign held for the author goes on, and what the reason counts since a run began starts again (mutates the campaign). */
  resume?(state: AutopilotState, campaign: RevisionCampaign, at: string): void;
  /** The codes of its insights about a chapter, when they are not the campaigns' (`campaignChapterDone`, `campaignSkipped`). */
  codes?: { chapterDone: AutopilotMessageCode; skipped: AutopilotMessageCode };
  /** The numbers of the insight about a chapter done. */
  figures?(chapter: PlannedChapter, campaign: RevisionCampaign): AutopilotInsightFigures | undefined;
  texts: {
    chapterDone(number: number, done: number, total: number, language: string, context?: CampaignChapterContext): string;
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

// ─── A review of the book to a target (`review-target`) ─────────────────────

/** The vote of a chapter: the director's when it was last closed (`score`), else the last vote of its rounds; `null` for a chapter nobody voted. */
export function chapterVote(chapter: Pick<PlannedChapter, "score" | "rounds">): number | null {
  if (typeof chapter.score === "number" && Number.isFinite(chapter.score)) return chapter.score;
  const rounds = chapter.rounds ?? [];
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const vote = rounds[index]?.director;
    if (typeof vote === "number" && Number.isFinite(vote)) return vote;
  }
  return null;
}

/**
 * The votes of a review of the book now: over the chapters it may revise (`scope`), the lowest vote and the chapters under the target (a chapter nobody voted is
 * under it: it has never been judged), and the vote of the book (the director's last judgement of the whole book). With targets for the readers (`gate`) a chapter is also
 * under them when the readers' vote of its text, as it is, is under one (or has to be asked of them: they never read it, or it was corrected since), and the lowest
 * average of the readers that count is among the votes.
 */
export function reviewVotes(state: Pick<AutopilotState, "plan" | "finalReview">, scope: readonly number[], target: number, gate?: ReaderTargets): ReviewVotes & { chapters: number[] } {
  const inScope = new Set(scope);
  let lowest: number | null = null;
  let readers: number | null = null;
  const chapters: number[] = [];
  for (const chapter of state.plan?.chapters ?? []) {
    if (!inScope.has(chapter.number)) continue;
    const vote = chapterVote(chapter);
    if (vote !== null) lowest = lowest === null ? vote : Math.min(lowest, vote);
    let below = vote === null || vote < target;
    if (gate) {
      const { standing, needsReading } = chapterStanding(chapter.rounds, gate);
      if (standing?.average != null) readers = readers === null ? standing.average : Math.min(readers, standing.average);
      if (needsReading || standing?.blockers.length) below = true;
    }
    if (below) chapters.push(chapter.number);
  }
  chapters.sort((left, right) => left - right);
  return { lowest, book: state.finalReview?.score ?? null, below: chapters.length, ...(gate ? { readers } : {}), chapters };
}

const plainVotes = (votes: ReviewVotes): ReviewVotes => ({ lowest: votes.lowest, book: votes.book, below: votes.below, ...(votes.readers !== undefined ? { readers: votes.readers } : {}) });

/** What keeps the chapters of a review from the targets of the readers, in numbers: the chapters under the average, those with a reader under its own target, those not read yet. */
function readersBlocking(state: Pick<AutopilotState, "plan">, scope: readonly number[], gate: ReaderTargets): { average: number; reader: number; unread: number } {
  const inScope = new Set(scope);
  const found = { average: 0, reader: 0, unread: 0 };
  for (const chapter of state.plan?.chapters ?? []) {
    if (!inScope.has(chapter.number)) continue;
    const { standing, needsReading } = chapterStanding(chapter.rounds, gate);
    if (needsReading) found.unread += 1;
    else if (standing) {
      if (standing.blockers.some((blocker) => blocker.subject === "average")) found.average += 1;
      if (standing.blockers.some((blocker) => blocker.subject === "reader")) found.reader += 1;
    }
  }
  return found;
}
const vote = (value: number | null | undefined): string => (value === null || value === undefined ? "—" : `${value}/10`);

/** The review that is over, as the state remembers it, with how it ended. Mutates `state`. */
function rememberReview(state: AutopilotState, campaign: RevisionCampaign, outcome: ReviewOutcome, at: string): void {
  const review = campaign.review;
  if (!review) return;
  const last = review.history[review.history.length - 1];
  const to = outcome === "cancelled" || !last ? plainVotes(reviewVotes(state, review.scope, review.targetScore, readerGate({ options: state.options, campaign }))) : plainVotes(last);
  const record: ReviewRecord = { targetScore: review.targetScore, rounds: review.history.length, outcome, from: plainVotes(review.start), to, startedAt: campaign.createdAt, endedAt: at };
  state.reviews = [...(state.reviews ?? []), record].slice(-MAX_REVIEW_RECORDS);
}

const reviewTarget: RevisionReasonHandler = {
  check() {
    throw new RevisionCampaignError("invalid_request", "A review of the book is asked with reviewBook (its target and its rounds), not as a list of chapters.");
  },
  record(state, campaign) {
    return { ...state, campaign };
  },
  start(state, chapter, _item, campaign, frozen) {
    if (!state.plan?.approved || chapter.status !== "done") return { outcome: "wait" };
    const review = campaign.review;
    // The author's chapters keep their rules: one the author froze is reviewed only when the author included it, and one changed since it was frozen waits for the
    // decision about that change. The review leaves them out, and its votes are of the others from now on.
    const authors = (frozen.authorFrozen?.has(chapter.slug) && !review?.include?.includes(chapter.number)) || frozen.changedFrozen?.has(chapter.slug);
    if (authors) {
      if (review) review.scope = review.scope.filter((number) => number !== chapter.number);
      return { outcome: "skip", why: "author" };
    }
    // Reviewed again from its first round, with the target of the review; the simulated readers read it again only when the review asks for it.
    chapter.status = "review";
    if ((campaign.review?.readerRounds ?? 1) > 0) delete chapter.skipReaders;
    else chapter.skipReaders = true;
    if (state.review?.chapterNumber === chapter.number) state.review = null;
    // The book changes: the director judges it again at the end of the round.
    state.finalDone = false;
    delete state.finalReview;
    return { outcome: "started" };
  },
  finished(state, chapter) {
    return chapter.status === "done" && !inRevision(state, chapter.number) && state.review?.chapterNumber !== chapter.number;
  },
  keep() {
    // A review has no chapter to keep.
  },
  cancel(input, _cancelled, at) {
    // Remembered now when nothing is being worked; else when the chapter being worked is over (`complete`), which ends the campaign.
    const campaign = input.campaign;
    if (!campaign?.review || campaign.chapters.some((item) => item.status === "working")) return input;
    const state = structuredClone(input);
    rememberReview(state, campaign, "cancelled", at);
    return state;
  },
  complete(state, campaign) {
    if (campaign.cancelledAt) rememberReview(state, campaign, "cancelled", campaign.cancelledAt);
  },
  afterChapters(state, campaign, frozen, report, language) {
    const review = campaign.review;
    if (!review) return "end";
    if (review.phase === "chapters") {
      // The round's chapters are over: the director judges the whole book again (the run's last step), and the round is judged by it. A round that reviewed
      // nothing (the author has its chapters) left the book as it was judged: it is judged at once by the votes there are.
      const reviewedAny = campaign.chapters.some((item) => item.mode === "follow" && item.status === "done");
      if (reviewedAny || !state.finalDone) {
        review.phase = "verdict";
        state.finalDone = false;
        delete state.finalReview;
        return "wait";
      }
    } else if (!state.finalDone) return "wait";
    const target = review.targetScore;
    // The targets for the readers, when this review has them and one that counts reads: the chapters are also judged by what the readers say of their text as it is.
    const gate = readerGate(state, frozen.readers);
    const now = reviewVotes(state, review.scope, target, gate);
    const previous = review.history[review.history.length - 1] ?? review.start;
    const raised = (current: number | null, before: number | null) => current !== null && (before === null || current > before);
    // Closer to the targets of the readers also counts: their lowest average rose, or fewer chapters are under a target.
    const closer = Boolean(gate) && (raised(now.readers ?? null, previous.readers ?? null) || now.below < previous.below);
    review.stalled = raised(now.lowest, previous.lowest) || raised(now.book, previous.book) || closer ? 0 : review.stalled + 1;
    const reviewed = campaign.chapters.filter((item) => item.mode === "follow" && item.status === "done").map((item) => item.number);
    review.history = [...review.history, { round: review.round, chapters: reviewed, ...plainVotes(now), endedAt: frozen.now }].slice(-MAX_REVIEW_ROUNDS_KEPT);
    const figures = { round: review.round, target, ...(now.lowest !== null ? { lowest: now.lowest } : {}), ...(now.book !== null ? { book: now.book } : {}), below: now.below, ...(now.readers != null ? { readers: now.readers } : {}), ...(gate?.average !== undefined ? { readersTarget: gate.average } : {}) };
    // What the readers' targets keep the chapters from, in words (empty without them): the first thing a plateau or a round says about them.
    const blocking = gate ? readersBlocking(state, review.scope, gate) : undefined;
    const blockedText = (): string => {
      if (!gate || !blocking) return "";
      const italian = isItalian(language);
      const chapters = (count: number) => (italian ? (count === 1 ? "1 capitolo" : `${count} capitoli`) : count === 1 ? "1 chapter" : `${count} chapters`);
      const parts: string[] = [];
      if (blocking.average && gate.average !== undefined) {
        parts.push(italian
          ? `la media dei lettori è sotto ${vote(gate.average)} in ${chapters(blocking.average)}${now.readers != null ? ` (la più bassa: ${vote(now.readers)})` : ""}`
          : `the readers' average is under ${vote(gate.average)} in ${chapters(blocking.average)}${now.readers != null ? ` (the lowest: ${vote(now.readers)})` : ""}`);
      }
      if (blocking.reader) parts.push(italian ? `un lettore è sotto il proprio obiettivo in ${chapters(blocking.reader)}` : `a reader is under its own target in ${chapters(blocking.reader)}`);
      if (blocking.unread) parts.push(italian ? `${chapters(blocking.unread)} senza un voto attuale dei lettori` : `${chapters(blocking.unread)} without a current vote of the readers`);
      return parts.join("; ");
    };
    report({
      key: `review-round:${campaign.id}:${review.round}`,
      tone: "info",
      code: "reviewRoundDone",
      title: text(language, `Round ${review.round} of the review is over: the lowest chapter ${vote(now.lowest)}, the book ${vote(now.book)} (target ${target}/10)`, `Il giro ${review.round} della revisione è finito: il capitolo più basso ${vote(now.lowest)}, il libro ${vote(now.book)} (obiettivo ${target}/10)`),
      figures,
    });
    const finish = (outcome: ReviewOutcome, tone: PlanNote["tone"], code: AutopilotMessageCode, title: string, detail?: string): CampaignNext => {
      rememberReview(state, campaign, outcome, frozen.now);
      report({ key: `review-end:${campaign.id}`, tone, code, title, ...(detail ? { detail } : {}), figures: { ...figures, rounds: review.history.length, outcome } });
      return "end";
    };
    const rounds = review.history.length;
    if (now.below === 0 && now.book !== null && now.book >= target) {
      return finish("target", "ok", "reviewDone", text(language, `The book reached the target: ${vote(now.book)}, every chapter at ${target}/10 or more${gate ? " and with the readers at their targets" : ""} (${rounds === 1 ? "1 round" : `${rounds} rounds`})`, `Il libro ha raggiunto l'obiettivo: ${vote(now.book)}, ogni capitolo a ${target}/10 o più${gate ? " e con i lettori ai loro obiettivi" : ""} (${rounds === 1 ? "1 giro" : `${rounds} giri`})`));
    }
    if (now.below === 0) {
      return finish("chapters", "info", "reviewStopped", text(language, `Every chapter reached ${target}/10${gate ? " with its readers at their targets" : ""}, the book as a whole got ${vote(now.book)}: the review ends here`, `Ogni capitolo ha raggiunto ${target}/10${gate ? " con i suoi lettori ai loro obiettivi" : ""}, il libro nel suo insieme ha ${vote(now.book)}: la revisione finisce qui`), text(language, "What the director asks of the whole book is in its last judgement: the chapters have nothing left under the target to review.", "Ciò che il direttore chiede al libro intero è nel suo ultimo giudizio: nei capitoli non resta nulla sotto l'obiettivo da rivedere."));
    }
    if (review.stalled >= 2) {
      const readersSaid = gate && now.readers != null ? text(language, ` nor the readers (${vote(now.readers)})`, ` né i lettori (${vote(now.readers)})`) : "";
      const blockedBy = blockedText();
      return finish("plateau", "warning", "reviewStopped", text(language, `The review stopped: two rounds in a row raised neither the lowest chapter (${vote(now.lowest)}) nor the book (${vote(now.book)})${readersSaid}`, `La revisione si è fermata: due giri di fila non hanno alzato né il capitolo più basso (${vote(now.lowest)}) né il libro (${vote(now.book)})${readersSaid}`), `${blockedBy ? `${blockedBy.charAt(0).toUpperCase()}${blockedBy.slice(1)}. ` : ""}${text(language, "Another round would spend without getting closer to the target: change the target, the director or the chapters, then review the book again.", "Un altro giro spenderebbe senza avvicinarsi all'obiettivo: cambia l'obiettivo, il direttore o i capitoli, poi rivedi di nuovo il libro.")}`);
    }
    // Another round, with the chapters still under the target.
    review.round += 1;
    review.phase = "chapters";
    campaign.chapters = now.chapters.map((number) => ({ number, mode: "follow" as const, status: "waiting" as const }));
    const cap = state.options.review?.campaignMaxRounds ?? 0;
    if (cap > 0 && review.round - review.windowStart + 1 > cap) {
      const done = review.round - review.windowStart;
      const message = text(language, `${done === 1 ? "1 round" : `${done} rounds`} of the review done, as many as you allowed: start the autopilot again to go on for ${cap === 1 ? "1 more" : `${cap} more`}`, `${done === 1 ? "1 giro" : `${done} giri`} della revisione fatti, quanti ne hai permessi: riavvia l'autopilot per continuare per altri ${cap}`);
      campaign.held = { at: frozen.now, message };
      state.limitReached = { kind: "review-rounds", used: done, limit: cap, at: frozen.now };
      report({ key: `review-held:${campaign.id}:${review.round}`, tone: "warning", code: "reviewHeld", title: message, figures: { ...figures, rounds: done, limit: cap } });
      return "wait";
    }
    return "again";
  },
  resume(_state, campaign) {
    // The rounds allowed are counted again from the round in progress.
    if (campaign.review) campaign.review.windowStart = campaign.review.round;
  },
  codes: { chapterDone: "reviewChapterDone", skipped: "reviewChapterSkipped" },
  figures(chapter, campaign) {
    const score = chapterVote(chapter);
    return { ...(score !== null ? { score } : {}), ...(campaign.review ? { target: campaign.review.targetScore, round: campaign.review.round } : {}) };
  },
  texts: {
    chapterDone: (number, _done, _total, language, context) => {
      const score = context ? chapterVote(context.chapter) : null;
      const target = context?.campaign.review?.targetScore;
      return text(language, `Chapter ${number} reviewed again: ${vote(score)}${target !== undefined ? ` (target ${target}/10)` : ""}`, `Capitolo ${number} rivisto di nuovo: ${vote(score)}${target !== undefined ? ` (obiettivo ${target}/10)` : ""}`);
    },
    skipped: (number, why, language) => why === "author"
      ? text(language, `Chapter ${number} is yours now (you froze it, or changed it since it was frozen): the review leaves it out`, `Il capitolo ${number} ora è tuo (l'hai congelato, o modificato dopo il congelamento): la revisione lo lascia fuori`)
      : text(language, `Chapter ${number} is no longer in the plan: the review leaves it out`, `Il capitolo ${number} non è più nel piano: la revisione lo lascia fuori`),
    done: () => "",
  },
};

/** The handlers of the reasons: the extension point of the campaigns. */
export const REVISION_REASON_HANDLERS: Readonly<Record<RevisionReason, RevisionReasonHandler>> = { "outline-change": outlineChange, "review-target": reviewTarget };

/**
 * What the author asks when the book is reviewed again (`AutopilotSession.reviewBook`): the target score (from 1 to 10), and what else the review is allowed:
 * the rounds of review of a chapter (`maxRounds`, 1 to `REVIEW_MAX_ROUNDS`), the rounds the readers read again (`readerRounds`, 0 to `REVIEW_MAX_ROUNDS`: 0, they
 * do not), the chapters of the author's to review too (`include`), and words for the director (`note`): these are the review's own. The caps are the options'
 * own fields, which the review writes as the configuration would: the rounds of a review since a run began (`campaignMaxRounds`, `options.review`; 0: no limit),
 * the money and token caps of the book (`budgetLimit`, `budgetTokens`; 0: none).
 */
export interface ReviewBookInput {
  targetScore: number;
  maxRounds?: number;
  readerRounds?: number;
  /** The vote the readers' average must reach, the vote each reader must reach (by slug), and the readers that do not count: this review's own (see `ReviewPolicy`). */
  readersTarget?: number;
  readerTargets?: Record<string, number>;
  readersExcluded?: string[];
  campaignMaxRounds?: number;
  budgetLimit?: number;
  budgetTokens?: number;
  include?: number[];
  note?: string;
}

/** Whether the book is finished: an approved plan whose chapters are all closed, and the director's judgement of the whole book. */
export function bookFinished(state: Pick<AutopilotState, "plan" | "finalDone">): boolean {
  return Boolean(state.plan?.approved && state.plan.chapters.length && state.plan.chapters.every((chapter) => chapter.status === "done") && state.finalDone);
}

/**
 * The chapters of the author's in a book: frozen by the author by hand, or written before the autopilot (`imported`, and not frozen by the autopilot: once the
 * book grows, the plan made again counts every written chapter as imported, and the freeze record still tells which the autopilot approved). A review of the
 * book leaves them out unless the author includes them: the autopilot never rewrites them by its own decision.
 */
export function authorChapters(state: Pick<AutopilotState, "plan">, snapshot: Pick<BookSnapshot, "chapters">): Set<number> {
  const frozenBy = new Map(snapshot.chapters.map((chapter) => [chapter.slug, chapter.frozen?.by]));
  return new Set((state.plan?.chapters ?? []).filter((chapter) => frozenBy.get(chapter.slug) === "author" || (chapter.imported && frozenBy.get(chapter.slug) !== "autopilot")).map((chapter) => chapter.number));
}

/** A review of the book from what the author asked, checked against the book now. Throws a `RevisionCampaignError`. */
export function createReviewCampaign(input: ReviewBookInput, state: AutopilotState, snapshot: BookSnapshot, now: Date, id: string = randomId("review")): RevisionCampaign {
  const refuse = (problem: string): never => {
    throw new RevisionCampaignError("invalid_request", problem);
  };
  if (!input || typeof input !== "object") refuse("A review is { targetScore, maxRounds?, readerRounds?, campaignMaxRounds?, budgetLimit?, budgetTokens?, include?, note? }.");
  const whole = (value: unknown, min: number, max: number): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
  if (typeof input.targetScore !== "number" || !Number.isFinite(input.targetScore) || input.targetScore < 1 || input.targetScore > 10) refuse("The target is a vote from 1 to 10.");
  if (input.maxRounds !== undefined && !whole(input.maxRounds, 1, REVIEW_MAX_ROUNDS)) refuse(`The rounds of a chapter are a whole number from 1 to ${REVIEW_MAX_ROUNDS}.`);
  if (input.readerRounds !== undefined && !whole(input.readerRounds, 0, REVIEW_MAX_ROUNDS)) refuse(`The readers' rounds are a whole number from 0 to ${REVIEW_MAX_ROUNDS}.`);
  const isVote = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 10;
  if (input.readersTarget !== undefined && !isVote(input.readersTarget)) refuse("The readers' target is a vote from 1 to 10.");
  if (input.readerTargets !== undefined && (!input.readerTargets || typeof input.readerTargets !== "object" || Array.isArray(input.readerTargets) || Object.values(input.readerTargets).some((value) => !isVote(value)))) refuse("The target of each reader is a vote from 1 to 10, given by the reader's name.");
  if (input.readersExcluded !== undefined && (!Array.isArray(input.readersExcluded) || input.readersExcluded.some((slug) => typeof slug !== "string"))) refuse("The readers that do not count are a list of the readers' names.");
  if (input.campaignMaxRounds !== undefined && !whole(input.campaignMaxRounds, 0, REVIEW_MAX_CAMPAIGN_ROUNDS)) refuse(`The rounds of the review are a whole number from 0 to ${REVIEW_MAX_CAMPAIGN_ROUNDS}.`);
  if (input.budgetLimit !== undefined && (typeof input.budgetLimit !== "number" || !Number.isFinite(input.budgetLimit) || input.budgetLimit < 0 || input.budgetLimit > 1_000_000)) refuse("The money cap is an amount from 0 (none).");
  if (input.budgetTokens !== undefined && !whole(input.budgetTokens, 0, Number.MAX_SAFE_INTEGER)) refuse("The token cap is a whole number from 0 (none).");
  if (input.include !== undefined && (!Array.isArray(input.include) || input.include.length > MAX_CAMPAIGN_CHAPTERS || input.include.some((number) => !whole(number, 1, MAX_BOOK_CHAPTERS)))) refuse("The chapters to include are chapter numbers.");
  if (input.note !== undefined && typeof input.note !== "string") refuse("The note of a review is a text.");
  if (!bookFinished(state)) throw new RevisionCampaignError("not_finished", "The book is not finished: a review of the whole book comes after its last chapter and the director's judgement of it.");
  if (campaignGoesOn(state)) throw new RevisionCampaignError("campaign_active", "Chapters are being revised already: wait until they are done, or cancel what waits.");
  const targetScore = Math.round(input.targetScore * 10) / 10;
  const include = [...new Set(input.include ?? [])].sort((left, right) => left - right);
  const authors = authorChapters(state, snapshot);
  // A chapter changed since it was frozen waits for the decision about that change, included or not.
  const { changedFrozen } = authorHeldChapters(snapshot);
  const scope = state.plan!.chapters.filter((chapter) => !changedFrozen.has(chapter.slug) && (!authors.has(chapter.number) || include.includes(chapter.number))).map((chapter) => chapter.number);
  // The readers' targets of this review (soft: the names are cleaned, the votes brought to a tenth); with them the chapters are judged by the readers too.
  const readerPolicy = normalizeReviewPolicy({ readersTarget: input.readersTarget, readerTargets: input.readerTargets, readersExcluded: input.readersExcluded });
  const gate = gateFor(state.options, readerPolicy);
  const votes = reviewVotes(state, scope, targetScore, gate);
  if (!votes.below) throw new RevisionCampaignError("nothing_to_review", gate ? `Every chapter of the review has ${targetScore}/10 already, and the readers' targets are met: there is nothing under a target to review.` : `Every chapter of the review has ${targetScore}/10 already: there is nothing under the target to review.`);
  const note = input.note?.trim() ? clipText(input.note.trim(), CAMPAIGN_NOTE_CHARACTERS) : undefined;
  return {
    id,
    reason: "review-target",
    createdAt: now.toISOString(),
    ...(note ? { note } : {}),
    chapters: votes.chapters.map((number) => ({ number, mode: "follow" as const, status: "waiting" as const })),
    review: {
      targetScore,
      ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
      ...(input.readerRounds !== undefined ? { readerRounds: input.readerRounds } : {}),
      ...(readerPolicy?.readersTarget !== undefined ? { readersTarget: readerPolicy.readersTarget } : {}),
      ...(readerPolicy?.readerTargets ? { readerTargets: readerPolicy.readerTargets } : {}),
      ...(readerPolicy?.readersExcluded ? { readersExcluded: readerPolicy.readersExcluded } : {}),
      ...(include.length ? { include } : {}),
      scope,
      round: 1,
      windowStart: 1,
      phase: "chapters",
      start: plainVotes(votes),
      history: [],
      stalled: 0,
    },
  };
}

/** A run starts: a campaign held for the author goes on, and what its reason counts since a run began starts again (pure). */
export function resumeCampaign(state: AutopilotState, at: string): AutopilotState {
  if (!state.campaign) return state;
  const campaign = structuredClone(state.campaign);
  REVISION_REASON_HANDLERS[campaign.reason].resume?.(state, campaign, at);
  delete campaign.held;
  return { ...state, campaign };
}

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

/**
 * The state with the chapters of the campaign that wait cancelled (the one being worked finishes, and then the campaign ends: a campaign of rounds begins no other);
 * the campaign goes once nothing of it is left to do. A limit it held the run for goes with it.
 */
export function cancelRevisionCampaign(state: AutopilotState, at: string): AutopilotState {
  const campaign = state.campaign;
  if (!campaign) return state;
  const cancelled = campaign.chapters.filter((item) => item.status === "waiting");
  const chapters = campaign.chapters.map((item) => (item.status === "waiting" ? { ...item, status: "cancelled" as const, endedAt: at } : item));
  const { held: _held, ...rest } = campaign;
  const next = REVISION_REASON_HANDLERS[campaign.reason].cancel({ ...state, campaign: { ...rest, chapters, cancelledAt: at } }, cancelled, at);
  const limit = next.limitReached?.kind === "review-rounds" ? (({ limitReached: _limit, ...others }) => others)(next) : next;
  if (chapters.some((item) => item.status === "working")) return limit;
  const { campaign: _gone, ...without } = limit;
  return without;
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
  // A campaign of rounds says a chapter once in each round.
  const roundKey = (): string => (campaign.review ? `:${campaign.review.round}` : "");

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
    if (chapter) {
      const figures = handler.figures?.(chapter, campaign);
      report({
        key: `campaign-chapter:${campaign.id}:${working.number}${roundKey()}`,
        tone: "ok",
        code: handler.codes?.chapterDone ?? "campaignChapterDone",
        chapterNumber: working.number,
        title: handler.texts.chapterDone(working.number, over, worked().filter((item) => item.status !== "cancelled").length, language, { chapter, campaign }),
        ...(figures ? { figures } : {}),
      });
    }
  }

  const idle = !state.question && !state.revision && !state.review && !startedReview(state);
  let stopped: string | null = null;
  /** Begin the next chapter that waits, in the order of the book: `true` when one began. Not while the campaign waits for the author, or was cancelled. */
  const startNext = (): boolean => {
    if (campaign.held || campaign.cancelledAt) return false;
    for (const item of campaign.chapters) {
      if (item.status !== "waiting" || item.mode !== "follow") continue;
      const chapter = chapterOf(item.number);
      if (!chapter) {
        end(item, "skipped", "not-in-plan");
        report({ key: `campaign-skipped:${campaign.id}:${item.number}${roundKey()}`, tone: "info", code: handler.codes?.skipped ?? "campaignSkipped", chapterNumber: item.number, title: handler.texts.skipped(item.number, "not-in-plan", language) });
        continue;
      }
      const started = handler.start(state, chapter, item, campaign, frozen);
      if (started.outcome === "wait") return false;
      if (started.outcome === "skip") {
        end(item, "skipped", started.why);
        report({ key: `campaign-skipped:${campaign.id}:${item.number}${roundKey()}`, tone: "info", code: handler.codes?.skipped ?? "campaignSkipped", chapterNumber: item.number, title: handler.texts.skipped(item.number, started.why, language) });
        continue;
      }
      Object.assign(item, { status: "working", startedAt: frozen.now });
      return true;
    }
    return false;
  };
  if (idle) {
    stopped = handler.stop?.(state, campaign, language) ?? null;
    if (stopped) {
      // The chapters that wait end as if the author cancelled them: what becomes of them is the reason's (`cancel`).
      const left = campaign.chapters.filter((item) => item.status === "waiting");
      for (const item of left) end(item, "cancelled");
      Object.assign(state, handler.cancel(state, left, frozen.now));
      report({ key: `campaign-stopped:${campaign.id}`, tone: "warning", code: "campaignStopped", title: text(language, "The revision of the chosen chapters stopped before its end: the chapters that waited are left to you", "La revisione dei capitoli scelti si è fermata prima della fine: i capitoli che aspettavano restano a te"), detail: stopped });
    } else if (startNext()) {
      return;
    }
  }

  if (campaign.chapters.some((item) => item.status === "waiting" || item.status === "working")) return;
  // A reason that goes on in rounds says what comes next, unless the author cancelled the campaign: then it ends with its chapter.
  if (handler.afterChapters && !campaign.cancelledAt && !stopped) {
    const next = handler.afterChapters(state, campaign, frozen, report, language);
    if (next === "wait") return;
    if (next === "again") {
      if (idle) startNext();
      return;
    }
    delete state.campaign;
    return;
  }
  handler.complete?.(state, campaign);
  const rewritten = worked().filter((item) => item.status === "done").length;
  if (!stopped && !handler.afterChapters && (rewritten || worked().some((item) => item.status === "skipped"))) report({ key: `campaign-done:${campaign.id}`, tone: "ok", code: "campaignDone", title: handler.texts.done(rewritten, language) });
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
  // The author cancelled it while this step ran: it ends with the chapter being worked.
  return { ...working, chapters, ...(stored.cancelledAt && !working.cancelledAt ? { cancelledAt: stored.cancelledAt } : {}) };
}
