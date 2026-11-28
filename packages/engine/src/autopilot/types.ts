import type { AiRouteStep, AiRoutingBudgetDetail, AiStreamEnd, AiTimeoutPhase, AiUsage } from "../ai/types.js";
import type { AiStreamMode } from "../ai/config.js";
import type { AiModelLearning, AiNoThinkingLearning, AiPromptCachingLearning } from "../ai/memory.js";
import type { AiErrorBody } from "../ai/provider-error.js";
import type { AiAttemptThinking, AiThinkingWhy } from "../ai/request.js";
import type { AiCallDropReason, AiCallStatus } from "./calls/types.js";
import type { ChapterFreezeAuthor, FrozenChapterChanges } from "../book/freeze.js";
import type { DesignAlternatives, DesignChapterReview, DesignCoherence, DesignRubrics } from "./design-review-types.js";
import type { OutlineDesignKey } from "../book/design.js";

/** Lifecycle of the autopilot of one book. */
export type AutopilotStatus = "idle" | "running" | "paused" | "waiting-author" | "error" | "completed";

/** Macro stage shown in the UI (Concept → Plan → Writing → Review → Completed). */
export type AutopilotPhase = "concept" | "plan" | "write" | "review" | "final" | "completed";

export const AUTOPILOT_PHASES: AutopilotPhase[] = ["concept", "plan", "write", "review", "final", "completed"];

export type AutopilotTaskKind =
  | "concept"
  | "summarize-imported"
  | "plan"
  | "plan-reader"
  | "plan-review"
  | "design-chapter-review"
  | "design-pitches"
  | "design-pitch-review"
  | "design-coherence"
  | "replan"
  | "scenes"
  | "write"
  | "reader"
  | "readers-summary"
  | "specialists"
  | "director-review"
  | "repair"
  | "consolidate"
  | "impact"
  | "revise"
  | "final"
  /** The director's corrections of the whole book, asked when every chapter of a review has its targets and the book has not (`BookRound`). */
  | "book-corrections"
  /** The room of the wildcards consulted on the plan of a design run, before its first review, the director triaging their ideas (`WildcardsPolicy.design`). */
  | "wildcards"
  /** «Review and complete» (`AutopilotDesign.mode`): the missing design fields, the findings and the canon to create of a batch of the author's chapters, as proposals. */
  | "design-complete"
  /** A simulated reader reads the author's chapters with what «Review and complete» proposes for them. */
  | "design-complete-reader"
  /** The director reviews the author's chapters with what «Review and complete» proposes for them. */
  | "design-complete-review"
  /** Freezing, without the model: the chapters an older engine approved (once), and the changes the author marked as reviewed. */
  | "freeze";

/**
 * The brief of the book, read from `outline/_brief.md` (see `OutlineBrief`): the chapters are the chapter entries of the outline, and the
 * planner decides the scenes of each chapter (`scenesForChapter`); `wordsPerScene` is the target of every scene.
 */
export interface AutopilotBrief {
  /** The idea, premise or pitch. One sentence is enough. */
  idea: string;
  /**
   * Optional chapter-by-chapter synopsis: binding when present. The outline (`outline/`) takes its place when the author wrote one:
   * the synopsis then still applies where the outline says nothing.
   */
  synopsis: string;
  wordsPerScene: number;
  genre: string;
  audience: string;
}

/**
 * What the autopilot does when the author changed a chapter that is frozen (or the outline entry of a chapter already written): `ask`
 * (the default) stops and asks, every time; `auto` reviews and updates the book from the change without asking, and says so; `notify`
 * only says it, once for every change.
 */
export type FrozenEditsMode = "ask" | "auto" | "notify";

export const FROZEN_EDITS_MODES: readonly FrozenEditsMode[] = ["ask", "auto", "notify"];

/** What changed that the author decides about: the text of a frozen chapter, or the outline entry of a chapter already written. */
export type FrozenChangeKind = "frozen" | "outline";

/**
 * What can be done with a change. Of a frozen chapter: `review-and-update` (the director reviews the chapter, then the later chapters
 * are checked and rewritten where the change requires it), `review-only` (only the director's review of the chapter), `mark-reviewed`
 * (freeze it again as it is). Of the outline entry of a written chapter: `rewrite-to-outline` (rewrite the chapter to follow the new entry,
 * then check the later chapters), `keep-text` (the plan follows the new entry, the text stays), `mark-reviewed` (the same as `keep-text`).
 */
export type FrozenAction = "review-and-update" | "review-only" | "mark-reviewed" | "rewrite-to-outline" | "keep-text";

export const FROZEN_ACTIONS: readonly FrozenAction[] = ["review-and-update", "review-only", "mark-reviewed", "rewrite-to-outline", "keep-text"];

/** The actions of each kind of change, in the order the question offers them. */
export const FROZEN_CHANGE_ACTIONS: Readonly<Record<FrozenChangeKind, readonly FrozenAction[]>> = {
  frozen: ["review-and-update", "review-only", "mark-reviewed"],
  outline: ["rewrite-to-outline", "keep-text", "mark-reviewed"],
};

/** What the autopilot knew of a chapter: before a change (when it was frozen) and after it (its new closing). */
export interface FrozenChapterView {
  title: string;
  summary: string;
  keyEvents: string[];
  /** The story so far as it was saved when the chapter closed (the plan keeps it only for the newest chapters). */
  storySoFar?: string;
}

/**
 * A decision about a change that waits to be carried out, or is being carried out: the author's (an answer, `resolveFrozenChange`) or the
 * autopilot's (`frozenEdits: "auto"`). The author's part of the state, like the interventions: saved at once, also while a run goes on.
 */
export interface PendingFrozenReview {
  id: string;
  kind: FrozenChangeKind;
  /** The chapter. */
  number: number;
  action: FrozenAction;
  /** The change it is about: `FrozenChapterChange.fingerprint`, or the digest of the new outline entry. */
  fingerprint: string;
  /** When it was decided. */
  at: string;
  /** The author's own words, for the director. */
  note?: string;
  /** Decided by the autopilot (`frozenEdits: "auto"`): the chapters the author wrote are never rewritten for it. */
  auto?: boolean;
  /** The work began: since when, in which phase (`review` of the changed chapter, or its `rewrite` to follow the outline), and the chapter as it was before. */
  started?: {
    at: string;
    phase: "review" | "rewrite";
    before: FrozenChapterView;
    /** For a `rewrite`: whether its revision rewrote any scene (a rewrite that changed nothing has no impact on the later chapters). */
    rewritten?: boolean;
  };
}

/**
 * Why chapters are revised now, in order, before the plan goes on (`RevisionCampaign`): `outline-change`, the author applied the Synopsis to the book,
 * and each chapter the author chose is rewritten to follow its new entry; `review-target`, the author asked to review the finished book again until it
 * reaches a target score, round after round (`AutopilotSession.reviewBook`); `annotations`, the author asked to rewrite the passages they marked while reading
 * (`AutopilotSession.reviseAnnotations`, the notes of `annotations/`). A reason is a word of `REVISION_REASONS` and an entry of the handlers of the
 * campaigns (`REVISION_REASON_HANDLERS`, `campaign.ts`), which say how its chapters are checked, started, finished, stopped and cancelled.
 */
export type RevisionReason = "outline-change" | "review-target" | "annotations";

export const REVISION_REASONS: readonly RevisionReason[] = ["outline-change", "review-target", "annotations"];

/** What the author chose for a chapter of a campaign: work it now (`follow`), keep it as it is (`keep`), or decide later (`later`). */
export type RevisionChapterMode = "follow" | "keep" | "later";

export const REVISION_CHAPTER_MODES: readonly RevisionChapterMode[] = ["follow", "keep", "later"];

/** Where a chapter of a campaign is: waiting for its turn, being worked, done, skipped (there was nothing left to do: `why`), or cancelled by the author. */
export type RevisionChapterStatus = "waiting" | "working" | "done" | "skipped" | "cancelled";

export const REVISION_CHAPTER_STATUSES: readonly RevisionChapterStatus[] = ["waiting", "working", "done", "skipped", "cancelled"];

export interface RevisionCampaignChapter {
  number: number;
  mode: RevisionChapterMode;
  /** The author's words for this chapter: the director reads them after the instruction of the reason. */
  instruction?: string;
  /** What the author saw when choosing: for `outline-change`, the digest of the new entry of the chapter. */
  fingerprint?: string;
  status: RevisionChapterStatus;
  startedAt?: string;
  endedAt?: string;
  /**
   * Why it was skipped: its change is not there any more (`gone`), the chapter is not in the plan any more (`not-in-plan`), or the author has it (`author`: frozen by
   * the author, or changed since it was frozen, which its own rules decide about first).
   */
  why?: "gone" | "not-in-plan" | "author";
}

/**
 * Chapters the author asked to revise now, for one reason, one after the other in the order of the book, before the plan goes on
 * (`AutopilotSession.reviseChapters`). The author's part of the state while it waits (saved at once, also while a run goes on); the run
 * starts, finishes and skips its chapters, and takes it away once none waits or is being worked. Cancelling it ends the chapters that wait.
 */
export interface RevisionCampaign {
  id: string;
  reason: RevisionReason;
  /** The author's words for every chapter: what changed, and why. */
  note?: string;
  createdAt: string;
  /** In the order they are worked: the order of the book. For a campaign of rounds (`review`), the chapters of the round in progress. */
  chapters: RevisionCampaignChapter[];
  /**
   * The campaign waits for the author before it goes on (its reason held it: the rounds the author allowed are done). The run stops, paused, with
   * these words; starting it again releases the campaign, which goes on. Absent while it goes on.
   */
  held?: { at: string; message: string };
  /** The author cancelled it while a chapter was being worked: once that chapter is over, the campaign ends (a campaign of rounds begins no other). */
  cancelledAt?: string;
  /** A review of the book to a target (`review-target`): its policy, the round in progress and what each round over came to. */
  review?: ReviewCampaign;
  /** The notes of the author this campaign answers (`annotations`). */
  annotations?: AnnotationsCampaign;
}

/** One annotation of the author as a campaign works it: where its passage is in the plan and what to ask of the ghostwriter. */
export interface AnnotationWork {
  id: string;
  chapterNumber: number;
  sceneNumber: number;
  /** The tag, the passage and the author's note, in words the ghostwriter reads. */
  instruction: string;
}

/**
 * The annotations a campaign of reason `annotations` answers, chapter by chapter in the order of the book. The chapters of the author's (written by hand, or frozen
 * by the author) are held back unless the author included them (`include`): the autopilot never rewrites them by its own decision. `unplaced` counts the notes whose
 * scene is not in the plan any more, and `notYet` those of chapters the autopilot has not closed.
 */
export interface AnnotationsCampaign {
  notes: AnnotationWork[];
  include?: number[];
  heldBack?: number[];
  unplaced?: number;
  notYet?: number;
}

/** What a campaign of annotations did, as the state remembers it once it is over. */
export interface AnnotationsRecord {
  campaignId: string;
  startedAt: string;
  endedAt: string;
  /** The notes the campaign had, and how many of them were answered (their chapter was rewritten and closed again). */
  notes: number;
  handled: number;
  chapters: number[];
  cancelled?: boolean;
}

/**
 * A review of the finished book to a target score (`review-target`, `AutopilotSession.reviewBook`): round after round, the chapters whose vote is under the target are
 * reviewed again (in the order of the book, each with up to `maxRounds` rounds of review), then the director judges the whole book again; it ends when the target is
 * reached, when no chapter is under it any more, or when two rounds in a row raised neither the lowest vote of a chapter nor the vote of the book (a plateau); it waits for
 * the author when the rounds allowed since the run began are done (`options.review.campaignMaxRounds`); the money cap (`options.budgetLimit`) stops the run as it
 * always does. The caps are the options' own: the configuration and the review launched later write the same fields.
 */
export interface ReviewCampaign {
  /** The vote a chapter and the book must reach. */
  targetScore: number;
  /** Rounds of review of a chapter of this campaign (absent: the run's policy, else the director's). */
  maxRounds?: number;
  /** In how many of the first rounds of a chapter the simulated readers read it again (0: not at all; absent: the run's policy, else 1). */
  readerRounds?: number;
  /** The target of the readers' average, the target of each reader and the readers that do not count, for this review (absent: the run's policy; see `ReviewPolicy`). */
  readersTarget?: number;
  readerTargets?: Record<string, number>;
  readersExcluded?: string[];
  /** Chapters of the author's (written before the autopilot, or frozen by the author) that the author chose to have reviewed too. */
  include?: number[];
  /** What this review does when every chapter has its targets and the book does not (`BookRoundMode`); absent: the run's policy (`ReviewPolicy.bookRound`), else `off`. */
  bookRound?: BookRoundMode;
  /** The chapters the review may revise, in the order of the book: the autopilot's, and the author's the author included. Its votes are of these chapters. */
  scope: number[];
  /** The round in progress, from 1. */
  round: number;
  /** The round the current run began with: the rounds the cap counts are `round - windowStart + 1`. A start moves it to the round in progress. */
  windowStart: number;
  /**
   * The chapters of the round are reviewed (`chapters`), the book is judged again (`verdict`), or the round is a book-level one and the director is asked for the corrections of
   * the whole book, or the author for the decision about them (`book`, with `book`).
   */
  phase: "chapters" | "verdict" | "book";
  /** The votes before the campaign. */
  start: ReviewVotes;
  /** The rounds over, oldest first (at most `MAX_REVIEW_ROUNDS_KEPT`). */
  history: ReviewRoundRecord[];
  /** Rounds over in a row that raised neither the lowest vote of a chapter nor the vote of the book. */
  stalled: number;
  /** The book-level round in progress (`bookRound`), from the moment it is asked for until its round is over. */
  book?: BookRound;
  /** How many times a plateau breaker (`ReviewPlateauBreaker`) took the review on after a plateau: at most `PLATEAU_BREAKS_MAX`. */
  broken?: number;
}

/**
 * What a review of the book does when every chapter has its targets and the director's vote of the whole book does not (`ReviewPolicy.bookRound`): nothing more (`off`: the review
 * ends, as it always did), carry out the corrections of the whole book that the director asks for (`apply`), or show them to the author first and carry out those the author chooses (`ask`).
 */
export type BookRoundMode = "off" | "apply" | "ask";

export const BOOK_ROUND_MODES: readonly BookRoundMode[] = ["off", "apply", "ask"];

/** The most corrections a book-level round keeps, and the characters of each part of one, of a point of the verdict and of what a plateau breaker gives the director. */
export const BOOK_CORRECTIONS_MAX = 12;
export const BOOK_CORRECTION_CHANGE_CHARACTERS = 700;
export const BOOK_CORRECTION_REASON_CHARACTERS = 500;
export const BOOK_POINT_CHARACTERS = 400;
export const BOOK_POINTS_MAX = 20;
export const BOOK_MATERIAL_CHARACTERS = 6000;
/** The rounds of the history of a review that keep what was asked of the book, and the times a plateau breaker may take a review on. */
export const BOOK_ROUNDS_KEPT = 10;
export const PLATEAU_BREAKS_MAX = 3;

/** Where a correction of the book is: waiting (to be decided, then for its chapter's turn), applied (its chapter was revised and reviewed again), or left out (`why`). */
export type BookCorrectionStatus = "waiting" | "applied" | "left-out";

/** Why a correction was left out: the chapter is the author's (and the author did not choose it), the author did not choose it, or its chapter is no longer in the plan. */
export type BookCorrectionWhy = "author" | "declined" | "gone";

/**
 * One cross-chapter correction the director asked for after judging the whole book: the chapter to change, what to change in it and why, and the points of the verdict it answers
 * (their numbers in `BookRound.verdict.points`, from 1).
 */
export interface BookCorrection {
  chapter: number;
  change: string;
  reason: string;
  cites: number[];
  /** The chapter is the author's (frozen by the author, or written before the autopilot): the correction is carried out only when the author chooses it. */
  held?: "author";
  status: BookCorrectionStatus;
  why?: BookCorrectionWhy;
}

/** Where a book-level round is: the director is asked (`asking`), the author decides (`proposed`), the chapters are revised (`applying`), or it ended without a correction to carry out (`declined`, `stopped`). */
export type BookRoundStatus = "asking" | "proposed" | "applying" | "declined" | "stopped";

/**
 * A book-level round of a review (#113): the director judged the whole book under the target while every chapter has its targets, so it lists what to change across the chapters.
 * The corrections are asked once the round begins, shown to the author first when the review asks it (`ask`), and then carried out chapter by chapter (a revision of the chapter, which
 * is reviewed again), after which the director judges the book again: the round is over like any other, and what it asked is kept in `ReviewRoundRecord.book`.
 */
export interface BookRound {
  /** The round of the review it is. */
  round: number;
  status: BookRoundStatus;
  /** The judgement of the book that the round answers: its vote, and its points as it said them (what the corrections cite, from 1). */
  verdict: { score: number | null; points: string[] };
  corrections: BookCorrection[];
  /** The director's words on what it asks, in short. */
  summary?: string;
  /** What a plateau breaker gave the director to read with the request. */
  material?: string;
  /** A plateau made this round: the breakers (`ReviewPlateauBreaker`) are consulted before the director is, once. */
  plateau?: { consulted: boolean };
  /** Why a round that ended with nothing to carry out did: a plateau (the breakers had nothing), the director asked nothing, or what it asked is the author's. */
  stop?: "plateau" | "none" | "author";
}

/** What a book-level round came to, as the history of a review keeps it. */
export interface BookRoundRecord {
  score: number | null;
  points: string[];
  corrections: BookCorrection[];
  summary?: string;
}

/**
 * The votes a round of a review is judged by: the lowest vote of a chapter of the review, the book's, and how many chapters are under a target (the director's, and the
 * readers' when the review has them, a chapter whose readers have no current vote counting as under it). `readers` is the lowest average of the readers that count among
 * the chapters that have a current vote of theirs; absent when the review has no target for the readers.
 */
export interface ReviewVotes {
  lowest: number | null;
  book: number | null;
  below: number;
  readers?: number | null;
}

export interface ReviewRoundRecord extends ReviewVotes {
  round: number;
  /** The chapters the round reviewed. */
  chapters: number[];
  endedAt: string;
  /** A book-level round: what the director asked of the book, and what became of it (only the latest `BOOK_ROUNDS_KEPT` rounds keep it). */
  bookRound?: BookRoundRecord;
}

/** How a review of the book ended: the target reached, no chapter under it (the book's own vote is not), a plateau, or the author cancelled it. */
export type ReviewOutcome = "target" | "chapters" | "plateau" | "cancelled";

/** A review of the book that is over, as the state remembers it (`AutopilotState.reviews`): what the author asked, how many rounds, and what it came to. */
export interface ReviewRecord {
  targetScore: number;
  rounds: number;
  outcome: ReviewOutcome;
  from: ReviewVotes;
  to: ReviewVotes;
  startedAt: string;
  endedAt: string;
  /** What the director asked of the whole book in the book-level rounds of the review (#113), the latest `BOOK_ROUNDS_KEPT`, with what became of each correction. Absent when there was none. */
  bookRounds?: Array<BookRoundRecord & { round: number }>;
}

/**
 * A limit stopped the run (paused): the money cap (`options.budgetLimit`, compared with the book's cumulative cost `stats.cost`, in the currency of the prices),
 * the token cap (`options.budgetTokens`), or the rounds of a review allowed since the run began (`options.review.campaignMaxRounds`). The numbers are what
 * the stop compared. A start takes it away (a limit that is still reached stops the run again).
 */
export interface AutopilotLimitReached {
  kind: "money" | "tokens" | "review-rounds";
  used: number;
  limit: number;
  currency?: string;
  at: string;
}

/**
 * A change the author chose to decide later (`later`): while it stays as it is, it is neither asked nor decided by the autopilot nor said again
 * (`frozenEdits` does not apply to it), and it still waits for the author. A new change of the same chapter is a change like any other.
 */
export interface DeferredChange {
  kind: FrozenChangeKind;
  number: number;
  /** The change: `FrozenChapterChange.fingerprint`, or the digest of the new outline entry. */
  fingerprint: string;
  at: string;
}

/** Where the book is published to GitHub: after every committed step (and again when a chapter is closed), after every chapter that is closed, or never. */
export type AutopilotPublishMode = "off" | "chapter" | "step";

export const AUTOPILOT_PUBLISH_MODES: readonly AutopilotPublishMode[] = ["off", "chapter", "step"];

export interface AutopilotOptions {
  /** Simulated readers evaluate every finished chapter. */
  readers: boolean;
  /** Maximum simulated readers per panel (the enabled ones, in order). */
  maxReaders: number;
  /** Simulated readers react to the concept and plan before writing starts. */
  readersOnPlan: boolean;
  /** Continuity / canon / style specialists review every chapter. */
  specialists: boolean;
  /** Stop when the plan is ready so the author can read it. */
  pauseAfterPlan: boolean;
  /** Stop after every approved chapter. */
  pauseAfterEachChapter: boolean;
  /** Stop after this many chapters are completed in a single run (0 = no limit). */
  chaptersPerRun: number;
  /** Stop before the next AI call once the tracked cost reaches this amount (0 = no limit). */
  budgetLimit: number;
  /**
   * Stop before the next AI call once this many tokens (input and output) have been used (0 = no limit). A limit that
   * also works for models without a price, and with providers that report no tokens (their use is estimated).
   */
  budgetTokens?: number;
  /**
   * Publish to GitHub after every approved chapter (browser host; the server publishes after every step). Older than
   * `publishEvery`, which wins when it is set; it stays what decides for a host that says nothing, and in the files of older engines.
   */
  syncAfterChapter: boolean;
  /**
   * Where the book is published: after every committed step, after every chapter that is closed, or never. Chosen by the author, and
   * it can change while a run goes on (`AutopilotSession.updateOptions`). Absent: the host decides (`defaultPublish`), and a host that
   * says nothing publishes after every step when it is a server, and as `syncAfterChapter` says when it is a browser.
   */
  publishEvery?: AutopilotPublishMode;
  /**
   * After every plan (and every revision of it) the autopilot writes in the outline (`outline/`) the chapters that have no entry
   * yet, and the description of the book when it has none, as its own (`origin: autopilot`), so that the author can correct them.
   * It never touches an entry of the author. On unless the author turns it off; saved with the other options.
   */
  fillOutline?: boolean;
  /**
   * What to do when the author changes a frozen chapter, or the outline entry of a chapter already written (`FrozenEditsMode`): `ask`
   * unless the author chose otherwise. Saved with the other options, and it can change while a run goes on.
   */
  frozenEdits?: FrozenEditsMode;
  /**
   * «Retry later»: when a step keeps failing with a transient provider failure after the quick retries, wait `everyMinutes` and try it
   * again with a new group of quick retries, up to `cycles` times (see `AutopilotLongRetry`). Absent: off, the default (also for the books
   * of older engines). Saved with the other options, and it can change while a run goes on, also while the run waits.
   */
  longRetry?: AutopilotLongRetry;
  /**
   * «Resume after a restart»: a personal server that stopped while the run went on (Ctrl+C, a service stop: the run was paused with
   * `stoppedBy: "server-shutdown"`), or that ended without pausing it, resumes it by itself when it starts again, at most three times a day.
   * A run the author paused is never resumed. Absent: off, the default (also for the books of older engines); only a server reads it. Saved
   * with the other options, and it can change while a run goes on.
   */
  resumeAfterRestart?: boolean;
  /** How the chapters and the book are reviewed (`ReviewPolicy`): the target, the rounds, the readers' rounds, the rounds of a review of the book. Absent: the director's. */
  review?: ReviewPolicy;
}

/**
 * How the chapters and the book are reviewed in a run (`AutopilotOptions.review`): the director's profile gives the defaults (its approval score and its rounds),
 * and a review of the book launched later can ask for others (`ReviewBookInput`). What is not said is the profile's (or today's for the readers).
 */
export interface ReviewPolicy {
  /** The vote a chapter and the book must reach to be approved: from 1 to 10, to a tenth. Absent: the director's approval score. The plan keeps the director's. */
  targetScore?: number;
  /** Rounds of review of a chapter before it is closed anyway: 1 to `REVIEW_MAX_ROUNDS`. Absent: the director's `maxReviewRounds`. */
  maxRounds?: number;
  /** In how many of the first rounds of a chapter the simulated readers read it (when they read at all): 1 to `REVIEW_MAX_ROUNDS`. Absent: 1, the first round only. */
  readerRounds?: number;
  /** The most rounds a review of the book makes since the run began, before it waits for the author (absent or 0: no limit); a start allows as many again. */
  campaignMaxRounds?: number;
  /**
   * The vote the average of the readers that count must reach for a chapter to be closed, from 1 to 10, to a tenth. Absent: the readers' average has no target. With it (or
   * with `readerTargets`) the readers read the chapter again at the end of its review, so that the vote the gate compares is the one of the text as it is, and the chapter
   * is closed only when the director's target, this average and the target of each reader are all reached, or the rounds of review (or a plateau) say otherwise. Only
   * when the readers read (`options.readers`).
   */
  readersTarget?: number;
  /** The vote each reader must reach (by the reader's slug, from 1 to 10, to a tenth); a reader that is not named has no target of its own. */
  readerTargets?: Record<string, number>;
  /** The readers that do not count (their slugs): they still read, and what they say is shown, but they are left out of the readers' average and of the gate. */
  readersExcluded?: string[];
  /**
   * What a review of the book does when every chapter has its targets and the director's vote of the whole book does not (`BookRoundMode`): absent or `off`, it ends there, as it
   * always did; `apply`, the director lists the corrections of the whole book (which chapters to change, what in each, and why) and the review carries them out; `ask`, the author
   * looks at them first. A review of the book launched later can say otherwise for itself.
   */
  bookRound?: BookRoundMode;
  /**
   * The room of the wildcards («Fuori dal coro») in the autopilot (`WildcardsPolicy`): consulted before the review of a design, and when a review of the book stalls (with a
   * book-level round), the director triaging what it gives. Absent: never.
   */
  wildcards?: WildcardsPolicy;
}

/**
 * When the autopilot consults the room of the wildcards, and how much: never a score, never a gate. The director triages their ideas (adopted, adapted or rejected, with the
 * reason, in the journal of the room) and only the accepted ones go on, as material for the review of the design or for the corrections of the book.
 */
export interface WildcardsPolicy {
  /** Before the first review of the plan of a design run (the pre-mortem: why the book would fail). */
  design?: boolean;
  /** When a review of the book stalls and it has a book-level round: the creative room instead of another identical round. */
  plateau?: boolean;
  /** Voices of a consultation: 1 to 8 (absent: 4). */
  voices?: number;
  /** Consultations at a plateau in one review of the book: 1 to `PLATEAU_BREAKS_MAX` (absent: 1). */
  rounds?: number;
  /** The money one consultation may spend, in the currency of the prices (absent or 0: no cap of its own; the run's caps still hold). */
  moneyCap?: number;
}

/** The most rounds of review of a chapter, of the readers' and of a review of the book that the policy accepts. */
export const REVIEW_MAX_ROUNDS = 10;
export const REVIEW_MAX_CAMPAIGN_ROUNDS = 100;
/** The most readers a policy keeps a target of, or leaves out of the average. */
export const REVIEW_MAX_READER_ENTRIES = 100;

/**
 * A change of the review policy (`StartOptions.options.review`): a value sets it, `null` takes it back (the director's again); `null` for the whole policy takes all of it back.
 * `readerTargets` and `readersExcluded` are given whole: they replace what the policy had, and `null` (or nothing left) takes them back.
 */
export interface ReviewPolicyUpdate {
  targetScore?: number | null;
  maxRounds?: number | null;
  readerRounds?: number | null;
  campaignMaxRounds?: number | null;
  readersTarget?: number | null;
  readerTargets?: Record<string, number> | null;
  readersExcluded?: string[] | null;
  /** Given whole: it replaces what the policy had; `null` takes it back. */
  wildcards?: WildcardsPolicy | null;
}

/** The longest wait of «Retry later», in minutes (a week), and the most cycles that are not "unlimited". */
export const LONG_RETRY_MAX_MINUTES = 10_080;
export const LONG_RETRY_MAX_CYCLES = 1000;

/**
 * «Retry later» (`options.longRetry`). After the quick retries of a step that failed with a transient provider failure (rate limit, overload,
 * a server error, the network, an empty or broken reply) the run waits `everyMinutes` (a whole number from 1 to `LONG_RETRY_MAX_MINUTES`) and
 * tries the step again, as the book is then, with all its quick retries; `cycles` is how many times (a whole number from 1 to
 * `LONG_RETRY_MAX_CYCLES`), or `"unlimited"`, said in words: a policy without it is no policy. The cycles start from zero again after
 * every step that works.
 */
export interface AutopilotLongRetry {
  everyMinutes: number;
  cycles: number | "unlimited";
}

/**
 * The options that can change while a run goes on: the run reads them again at the end of every step and of every chapter (and `longRetry` when
 * a step has failed); `resumeAfterRestart` is read by the server when it starts again.
 */
export const LIVE_AUTOPILOT_OPTIONS = ["publishEvery", "pauseAfterEachChapter", "frozenEdits", "longRetry", "resumeAfterRestart"] as const;

/**
 * What the author can change while a run goes on. `publishEvery: null` takes the choice back, so that the host decides again; `longRetry: null`
 * turns «Retry later» off (a run that is waiting for it stops, with the failure it was waiting to try again).
 */
export interface AutopilotLiveOptions {
  publishEvery?: AutopilotPublishMode | null;
  pauseAfterEachChapter?: boolean;
  frozenEdits?: FrozenEditsMode;
  longRetry?: AutopilotLongRetry | null;
  resumeAfterRestart?: boolean;
}

/** What `AutopilotSession.updateOptions` takes: the settings above at any time, and any other option when no run is active. */
export type AutopilotOptionsUpdate = Partial<Omit<AutopilotOptions, "publishEvery" | "longRetry">> & AutopilotLiveOptions;

export type SceneStatus = "planned" | "written" | "reviewed";
export type ChapterStatus = "planned" | "writing" | "review" | "done";

export interface PlannedScene {
  number: number;
  title: string;
  goal: string;
  beats: string[];
  pov?: string;
  location?: string;
  characters: string[];
  summary?: string;
  status: SceneStatus;
  slug?: string;
  path?: string;
  words?: number;
  revisions: number;
}

export interface PlannedChapter {
  number: number;
  title: string;
  slug: string;
  summary: string;
  goal: string;
  pov: string[];
  keyEvents: string[];
  reveals: string[];
  status: ChapterStatus;
  /** Chapter written before the autopilot took over: never rewritten automatically. */
  imported?: boolean;
  /** Re-review after an author revision: skip the simulated readers this time. */
  skipReaders?: boolean;
  scenes: PlannedScene[];
  /** Final director score once the chapter is approved. */
  score?: number;
  /**
   * The story so far up to and including this chapter, written when the chapter closed. It is the
   * "before" synopsis of the next chapter; a later re-consolidation of an earlier chapter clears it.
   */
  storySoFarAtClose?: string;
  /**
   * The rounds of review of this chapter that closed, oldest first, at most `MAX_CHAPTER_ROUNDS`: a compact history that outlives the
   * chapter's review (`AutopilotState.review` is the round in progress, and is cleared when the chapter closes). A chapter that is
   * rewritten adds the rounds of its new review; the oldest leave when there are too many. Absent for a chapter that was never reviewed.
   */
  rounds?: ChapterRound[];
  /**
   * The ghostwriter of the chapter, from its entry in the outline (the slug of `ghostwriters/<slug>.md`). Written in the chapter's
   * `chapter.md` when the folder is made, if it is not the book's: the chain scene → chapter → book then picks it as ever. Absent:
   * the book's (an outline that names one that does not exist is said, and the book's writes).
   */
  ghostwriter?: string;
  /**
   * The digest of the outline entry the chapter comes from (`outlineEntryDigest`), as it was when the plan followed it (or wrote it).
   * When the entry no longer matches it, the author changed it: a chapter not written yet is planned again before its scenes.
   */
  outlineDigest?: string;
}

/**
 * One round of review that closed, as the director judged it. Every field is optional: a round whose readers did not read has no
 * `readers`. The votes are on the 0-10 scale with one decimal at most, the counters are whole numbers. A round is told by its numbers: a
 * `verdict` with no number is no round.
 */
export interface ChapterRound {
  /** The director's vote. */
  director?: number;
  /**
   * The average of the simulated readers' votes (of the readers that count, when the review policy leaves some out). They read a chapter in the first round of its
   * review, and again in the next rounds the review policy says (`ReviewPolicy.readerRounds`): the other rounds have none. With a target for the readers they read it
   * again at the end of its review too, and that reading is a round of its own (`reading`).
   */
  readers?: number;
  /**
   * The vote of each reader of the round, by the reader's slug (0-10, one decimal): the review policy's targets are for each reader, and the ones that do not count are
   * only known by it. Recorded only when the review policy has a target for the readers or leaves some out; an older round has the average alone.
   */
  readerVotes?: Record<string, number>;
  /**
   * The number of the round of the chapter's review the entry belongs to (from 1): for a reading it is the round whose corrections it read. Recorded with `readerVotes`
   * (and in a reading of its own); a round of an older engine, or of a policy without targets for the readers, has none.
   */
  round?: number;
  /**
   * The readers read the chapter outside a round of the director, to have a vote of the text as it is: `end`, after the last corrections of its review; `check`, because
   * a review of the book needed to know the vote of a chapter the director has no more to say about. Such an entry has no vote of the director, no verdict and no counters.
   */
  reading?: "end" | "check";
  /**
   * What the round decided: `approve` closed the chapter, `revise` sent it back for fixes. It is the verdict the plan acted on, which is
   * not always the one the model gave (an approval under the director's approval score is withheld, and is a `revise`). Absent from a round
   * saved by an engine that did not say it.
   */
  verdict?: "approve" | "revise";
  /** Findings the director accepted (and fixes it added) in this round. */
  accepted?: number;
  /** Findings the director rejected. */
  rejected?: number;
}

export interface ReaderReaction {
  slug: string;
  name: string;
  interest: number;
  reaction: string;
  concerns: string[];
  wishes: string[];
}

export interface ConceptSecret {
  slug: string;
  title: string;
  revealChapter?: number;
}

export interface AutopilotPlan {
  chapters: PlannedChapter[];
  approved: boolean;
  /** Plan revisions requested by the director. */
  rounds: number;
  /** Director (or author) notes the next plan revision must apply. */
  revisionNotes: string[];
  /**
   * First chapter of every batch (of `PLAN_BATCH_CHAPTERS` chapters) the current revision still has to regenerate, in
   * order. Absent or empty with notes pending, as older versions wrote it, means every batch.
   */
  revisionBatches?: number[];
  readerReactions: ReaderReaction[];
  readersDone: boolean;
  /** Readers whose reaction stayed incomplete after a retry: they are not asked again. */
  skippedReaders?: string[];
  /** Approved plan waiting for the author because of `pauseAfterPlan` or the director's autonomy. */
  awaitingAuthor: boolean;
  /**
   * Chapters taken out of the plan, before they were written, because the author deleted their entry of the outline. The next
   * chapters keep their numbers, and these count among the chapters of the book, so that it is not extended to replace them.
   */
  removedChapters?: number[];
  /** The room of the wildcards was consulted on this design (`WildcardsPolicy.design`): once before its first review. */
  wildcardsDone?: boolean;
  /** The ideas of the room the director accepted (`wildcardIdeasMaterial`), read with the review of the design. */
  wildcardsMaterial?: string;
}

export interface ReviewFinding {
  id: string;
  source: "specialist" | "reader";
  category: string;
  severity: "critical" | "major" | "minor";
  sceneNumber?: number;
  evidence?: string;
  /** Whether the evidence was found verbatim in the scene. */
  anchored: boolean;
  problem: string;
  remediation: string;
  reader?: string;
}

export interface ReviewDecision {
  findingId: string;
  action: "accept" | "reject";
  rationale: string;
  remediation: string;
  sceneNumber?: number;
}

export interface ChapterReview {
  chapterNumber: number;
  round: number;
  readersPending: string[];
  readerScores: Array<{ slug: string; name: string; score: number; mainProblem: string; prioritySuggestion: string; path: string }>;
  readersSummaryDone: boolean;
  findings: ReviewFinding[];
  specialistsDone: boolean;
  directorDone: boolean;
  verdict?: "approve" | "revise";
  score?: number;
  summary?: string;
  decisions: ReviewDecision[];
  repairQueue: number[];
  /** Fixes accepted and applied in the previous round, verified by the next one. */
  previousFixes: string[];
  history: Array<{ round: number; verdict: "approve" | "revise"; score: number; accepted: number; rejected: number }>;
  /** The round the simulated readers read the chapter in (their scores are of that round): the first, and again in the rounds the review policy says. */
  readersRound?: number;
  /**
   * The readers' targets (`ReviewPolicy.readersTarget`, `readerTargets`) and the readers' votes of the text as it is. `repairs` is how many scenes were repaired in this review;
   * `readText` is how many there were when the readers began their last reading: they read the text as it is while the two are equal. `reading` says that the reading
   * in progress is one of its own (`end`: the closing reading, after the last corrections; `check`: a review of the book needs the vote of a chapter the director is
   * content with), `readRecorded` that the votes held are already a round of the chapter (`ChapterRound.reading`), and `reads` is how far each closing reading was from the
   * targets (the sum of what each vote lacked), to tell whether another round of corrections got closer. `gateStop` says why a chapter closes with a target of the readers
   * not reached: the rounds were used (`rounds`) or the corrections stopped getting closer (`plateau`).
   */
  repairs?: number;
  readText?: number;
  reading?: "end" | "check";
  readRecorded?: boolean;
  reads?: number[];
  gateStop?: "rounds" | "plateau";
  /**
   * The review of a change the author made to a frozen chapter: one round of the director (and of the specialists), whose fixes are
   * advice for the author and are never applied (the author's text stays as it is); then the chapter is closed and frozen again.
   */
  authorEdit?: boolean;
}

export type InterventionScope = "next_step" | "from_now" | "rewrite";

export interface AuthorIntervention {
  id: string;
  scope: InterventionScope;
  text: string;
  createdAt: string;
  /** Human label of the step running or due when the intervention was recorded. */
  during: string;
  status: "pending" | "applied";
  appliedAt?: string;
  appliedBy?: string;
}

export type DirectorQuestionKind = "plan-approval" | "chapter-approval" | "round-limit" | "director" | "frozen-change" | "outline-change";

/** One of the choices of a question: `id` is what an answer names (`QuestionAnswer.choice`, or its `answer`), `label` what the author reads. */
export interface QuestionChoice {
  id: string;
  label: string;
}

/** What a question about a change is about (`frozen-change`: a frozen chapter's text; `outline-change`: the outline entry of a written chapter). */
export interface FrozenQuestionContext {
  kind: FrozenChangeKind;
  number: number;
  slug: string;
  /** The change asked about: an answer is about this one. */
  fingerprint: string;
  title?: string;
  /** For a frozen chapter: who froze it and when, and what changed since. */
  by?: ChapterFreezeAuthor;
  frozenAt?: string;
  changed?: FrozenChapterChanges;
  /** The other chapters whose change waits for the author, after this one (asked one at a time, in order). */
  others?: number[];
}

export interface DirectorQuestion {
  id: string;
  kind: DirectorQuestionKind;
  question: string;
  context: string;
  /** What the author can answer, as text. For a question with `choices`, their labels in the same order. */
  options: string[];
  /** Typed choices: an answer names one by its `id` (or its label). Absent from a question of free text. */
  choices?: QuestionChoice[];
  /** What a `frozen-change` or `outline-change` question is about. */
  frozen?: FrozenQuestionContext;
  chapterNumber?: number;
  askedAt: string;
}

export interface RevisionRequest {
  id: string;
  instruction: string;
  createdAt: string;
  /** `null` until the director has analyzed the impact. */
  targets: Array<{ chapterNumber: number; sceneNumber: number; instruction: string; /** The annotations this rewrite answers: closed as handled by the autopilot once the scene is written. */ noteIds?: string[] }> | null;
  cursor: number;
  /** Chapters already rewritten by a revision this one replaced: they are reviewed again too. */
  revisedChapters?: number[];
  /** Only the scenes of the chapters after this one may be rewritten: the impact of a change of this chapter on the later ones. */
  afterChapter?: number;
  /** Only the scenes of this chapter may be rewritten: a written chapter rewritten to follow its new outline entry. */
  onlyChapter?: number;
  /** What the revision comes from when it is not an instruction of the author: a change of a frozen chapter, or of the outline of a written one. */
  source?: RevisionSource;
}

/** The change a revision comes from: the chapter, what the autopilot knew of it BEFORE and what it knows AFTER, and the author's words. */
export interface RevisionSource {
  kind: FrozenChangeKind;
  chapterNumber: number;
  note?: string;
  /** Decided by the autopilot (`frozenEdits: "auto"`): the chapters the author wrote are left alone. */
  auto?: boolean;
  before?: FrozenChapterView;
  after?: FrozenChapterView;
}

export interface AutopilotRunnerInfo {
  host: "browser" | "server";
  label: string;
  /** Stable identity of the host (browser device or server id); the label is only for display. */
  hostId?: string;
  runId: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface AutopilotStats {
  tasks: number;
  aiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  currency?: string;
  failures: number;
  /** Calls whose tokens the provider did not report: `inputTokens` and `outputTokens` hold the engine's estimate for them. */
  usageUnknownCalls?: number;
  /** Calls whose cost could not be measured (the model has no price, or the tokens were estimated): `cost` leaves them out or estimates them. */
  costUnknownCalls?: number;
  /**
   * Milliseconds the autopilot worked, over every run: the sum of the durations of the steps that were saved (each from its start to its end,
   * as its activity shows). Not the wait for the author, not the pauses between runs, not the attempts that failed or the waits between
   * retries. Whole and not negative; absent from the state of an engine that did not count it, and then it counts from zero.
   */
  workedMs?: number;
  /**
   * ISO time of the start of the first step that `workedMs` counted: written when the count is born, and never changed after. Absent from a
   * state whose count began before it was written (a book started with an engine that did not say), and the engine does not make one up.
   */
  workedMsSince?: string;
  /**
   * `true` when the count began on a book that had already saved steps (an engine that did not count wrote them): `workedMs` is then the time of
   * the steps since `workedMsSince`, not of the whole book. Absent when the count was born with the book, and from the states of older engines.
   */
  workedMsPartial?: true;
}
/** The director's judgement of the whole book, as data: what the final step saved. */
export interface AutopilotFinalReview {
  /** `approve`, or `revise` for anything else (a withheld approval, a rewrite). */
  verdict: "approve" | "revise";
  /** 0-10, normalized like the score of a chapter. */
  score: number;
  /** The director's judgement in words (at most `FINAL_REVIEW_TEXT_CHARACTERS`; the summary of the state carries `FINAL_REVIEW_SUMMARY_CHARACTERS`). */
  text: string;
  /** When the director gave it. */
  at: string;
  /**
   * What the judgement said that a correction can answer, numbered from 1 when it is cited: its concerns (severity, issue, suggestion) and its next steps, each cut to
   * `BOOK_POINT_CHARACTERS` (at most `BOOK_POINTS_MAX`). Absent from a state whose judgement an older engine made.
   */
  points?: string[];
}

/**
 * What went wrong, in a closed list a client can act on: `network` (the provider could not be reached), `auth` (401, 403: a key or a
 * permission), `rate_limit` (429), `timeout` (the request ran out of time, 408), `truncated` (the reply was cut by the output limit),
 * `refused` (nothing was called: the privacy setting for fallbacks, or no model for the task), `conflict` (a file changed under the step),
 * `budget` (the routing limits leave nothing to call), `limit` (a limit of the run or of the context window), `profile` (a file of the book,
 * a profile or a chapter, that cannot be read: the author fixes it), `config` (the AI configuration has to change: with "Tools only" on, no
 * model of the task can call a function), `provider` (any other failure of the provider or of its reply) and `unknown` (everything else).
 */
export type AutopilotErrorKind = "network" | "auth" | "rate_limit" | "timeout" | "truncated" | "refused" | "conflict" | "budget" | "limit" | "profile" | "config" | "provider" | "unknown";

export const AUTOPILOT_ERROR_KINDS: readonly AutopilotErrorKind[] = ["network", "auth", "rate_limit", "timeout", "truncated", "refused", "conflict", "budget", "limit", "profile", "config", "provider", "unknown"];

/**
 * What the transport saw of the call that failed (`AiTransportDiagnostics`, kept short), so that a stream that was cut can be told from one that was slow: the HTTP status of the response, how much
 * arrived (bytes, chunks, events) and when the last chunk did, how the stream ended, how the provider said the reply ended, whether it reported the tokens, the last characters that arrived
 * (at most 300, with credentials replaced) and the request id the provider or its gateway gave. Every field is optional: a failure keeps those it has.
 */
export interface AutopilotTransportDetail {
  /** The HTTP status of the response (a stream that is cut still began with a 200). */
  status?: number;
  bytes?: number;
  chunks?: number;
  events?: number;
  /** Milliseconds from the start of the attempt to the last chunk, and from the last chunk to the end of the attempt (the silence before the end). */
  lastChunkAfterMs?: number;
  silentMs?: number;
  /** How the stream ended: `done` (`[DONE]`), `closed` (closed without it), `reset` (the connection broke), `error` (the provider reported a failure in it), `timeout` (a deadline ran out). */
  end?: AiStreamEnd;
  /** How the provider said the reply ended (`stop`, `length`, `abort`...), when it said. */
  finishReason?: string;
  /** The provider reported the tokens of the call, and whether the request asked for them (`stream_options.include_usage`). */
  usageReceived?: boolean;
  usageRequested?: boolean;
  /** The last characters that arrived (at most 300). */
  tail?: string;
  requestId?: string;
  /** Characters of the reply that had arrived when it failed: the engine keeps it on its error and never applies it. */
  partialCharacters?: number;
}

/**
 * What became of one candidate of the route of the call that failed, as the detail of an error keeps it (`AiRouteStep`): the ones that were asked, with how each ended and how long it took, and the
 * ones that were left out, with why. In the order the author wrote the route, the primary first.
 */
export type AutopilotRouteStep = AiRouteStep;

/** The most steps of a route that the detail of an error keeps: far above what a route has (`maxCandidates` is at most 8), so that a detail read from a file is never bigger. */
export const MAX_ROUTE_STEPS = 12;

/** Where an error happened. Short, and never a secret: `endpoint` is the origin of the provider's address, never a path or a query (`path` is the path of an address that a model has of its own, and nothing of its query). */
export interface AutopilotErrorDetail {
  /** The HTTP status the provider answered, when it answered. */
  status?: number;
  /** The origin (`https://api.openai.com`) of the integration that was called, or of the model's own address. */
  endpoint?: string;
  /** The path of the model's own address (`/openai/responses`), when it has one: with `endpoint`, where the request went. Never its query. */
  path?: string;
  /** The request was made through the Responses API (absent: Chat Completions, and a detail from an engine that did not say). */
  protocol?: "responses";
  /**
   * What the provider answered when it refused the request, in its own words (see `AiErrorBody`): the status, the message, the type, the parameter and the code of its error, or its text when it was no known shape.
   * That of the last candidate that was asked; `route[].body` has each one's. Absent when no provider answered, and from an engine that did not say.
   */
  body?: AiErrorBody;
  /** The API version the request carried (Azure OpenAI's `api-version`, or `v1`): the model's own, else its integration's. Absent for a provider that has none, and from an engine that did not say. */
  apiVersion?: string;
  model?: string;
  provider?: string;
  /** The id of the integration. */
  integration?: string;
  /** What the provider asked for with `Retry-After` (a 429 or a 503), in milliseconds: the engine's client keeps at most five minutes of it. Present only when the provider said. */
  retryAfterMs?: number;
  /** The retry this failure belongs to: the one that followed it, or the last one when the run gave up. Present only for a failure that is retried. */
  attempt?: number;
  /** How many retries this kind of failure gets. */
  retries?: number;
  /** For a timeout: how long the deadline that ran out was, in milliseconds. */
  timeoutMs?: number;
  /**
   * For a timeout: which deadline ran out. `start`: the provider did not begin answering (the connection and the headers) within its provider
   * timeout; `idle`: it went silent for the idle timeout while it answered; `total`: the call took longer than any call may (four hours).
   */
  timeoutPhase?: AiTimeoutPhase;
  /**
   * For a conflict with GitHub (kind `conflict`, code `github_conflict` of the personal server): how many files changed both on the server and on
   * GitHub, so that the author has to choose a version of each (`GET …/github-conflicts` lists them). Absent for any other failure.
   */
  githubConflicts?: number;
  /** For a call to a model that failed after the provider answered: what the transport saw of it (see `AutopilotTransportDetail`). Absent when no response arrived. */
  transport?: AutopilotTransportDetail;
  /**
   * Every candidate of the route of the call that failed, in the order the author wrote it (see `AutopilotRouteStep`). `model`, `provider`, `integration` and `endpoint` above are those of the
   * last candidate that was asked, which is not the only one: the primary may have failed at once and the fallback after it. Absent from an engine that did not say.
   */
  route?: AutopilotRouteStep[];
  /** For a routing limit's refusal (kind `budget`): which limit stopped the call, what it needed and what the limit allows (see `AiRoutingBudgetDetail`). Absent from an engine that did not say. */
  budget?: AiRoutingBudgetDetail;
}

/**
 * The codes that say, in the state, why a run ended with an error: the `code` of its `run-ended` event, when that code is one of these. «Retry later»
 * stopped the run after its last cycle (`longRetryExhausted`), or was turned off while the run waited for it (`longRetryOff`). A closed list: a code
 * that is not in it is dropped when a file is read.
 */
export const LAST_ERROR_CODES = ["longRetryExhausted", "longRetryOff"] as const satisfies readonly AutopilotMessageCode[];
export type AutopilotLastErrorCode = (typeof LAST_ERROR_CODES)[number];

/** A failure the run could not get past: what it said, when, in which step, and what kind it was. */
export interface AutopilotLastError {
  message: string;
  at: string;
  task?: AutopilotTaskKind;
  /** The id of the activity (in the activity log) that failed. Absent for a failure that belongs to no step, and for one saved by an engine that did not say. */
  activityId?: string;
  errorKind?: AutopilotErrorKind;
  errorDetail?: AutopilotErrorDetail;
  /**
   * Why the run ended, when «Retry later» did it (see `LAST_ERROR_CODES`): what the `run-ended` event said, kept in the state so that a page opened after the
   * run, or another device, can say it too. Absent for any other failure, and for an error saved by an engine that did not say it.
   */
  code?: AutopilotLastErrorCode;
}

/** The last error as the summary says it: the state's own fields, and the same kind and detail under their short names. */
export interface AutopilotLastErrorSummary extends AutopilotLastError {
  kind?: AutopilotErrorKind;
  detail?: AutopilotErrorDetail;
}

/** While the run waits to try a failed step again: when the next attempt is, which retry it is and how many there are. Never saved. */
export interface AutopilotRetryInfo {
  /** ISO time of the next attempt. */
  at: string;
  /** The quick retries: the one about to happen (or, in a wait of «Retry later», the last one made) and how many there are. */
  attempt: number;
  retries: number;
  /**
   * Only in a wait of «Retry later» (`options.longRetry`): which cycle it is, from 1, and how many there are (`null`: no limit). When it is over
   * the step is tried again with all its quick retries.
   */
  longTerm?: { cycle: number; cycles: number | null };
}

/**
 * Why a run paused when neither the author nor the run itself paused it (`AutopilotState.stoppedBy`): `server-shutdown`, the personal server
 * that ran it was stopping (`AutopilotSession.stopForShutdown`: Ctrl+C, a service stop). A server that starts again resumes such a run by
 * itself when the author asked for it (`options.resumeAfterRestart`).
 */
export type AutopilotStopCause = "server-shutdown";

/**
 * What a host that has just started finds of a run it may resume by itself (`AutopilotSession.restartResumeCause`): `interrupted`, the state
 * still says that the run goes on, with this host's runner (its process ended without pausing it) or with one silent for too long;
 * `server-shutdown`, the run was paused because the server stopped.
 */
export type AutopilotRestartCause = "interrupted" | AutopilotStopCause;

/**
 * How a design run ended (`AutopilotDesign.outcome`): the director approved the design at the target (`target`), or with nothing left to change (`unchanged`); the
 * rounds allowed were used (`rounds`); two reviews in a row did not raise its vote (`plateau`); or the author ended it and started writing (`author`).
 */
export type DesignOutcome = "target" | "unchanged" | "rounds" | "plateau" | "author";

/** One review of the design by the director (`AutopilotDesign.rounds`). */
export interface DesignRound {
  round: number;
  /** The director's vote, from 0 to 10. */
  score: number;
  /** What the round decided: `approve` ended the design, `revise` sent it back. */
  verdict: "approve" | "revise";
  /** The average vote of the simulated readers who read the design before this review. */
  readers?: number;
  /** Critical inconsistencies the director found. */
  critical: number;
  /** Findings of the deterministic checks (`designChecks`) when the review was made. */
  findings: number;
  /** The mean of the director's twelve criteria (`DesignWorkflow.rubric`), when it scored them. */
  rubric?: number;
  at: string;
  /** What the reviewers said in this review, in their words (`DesignRoundTexts`): the Studio shows it. Absent in the reviews of an engine before it. */
  texts?: DesignRoundTexts;
}

/** A simulated reader's reading of a design before a review: its vote, its reaction and its counter-proposal. */
export interface DesignRoundReading {
  slug: string;
  name: string;
  score: number;
  text: string;
  counterProposal?: string;
}

/**
 * The words of a review of a design (`DesignRound.texts`): the director's judgement, the devil's advocate (the strongest alternative to the weakest part), the changes it
 * asked chapter by chapter, the critical inconsistencies it found, and what each simulated reader said before it. Cut to the limits of `DESIGN_ROUND_TEXT_LIMITS`.
 */
export interface DesignRoundTexts {
  summary?: string;
  counterProposal?: string;
  changes?: string[];
  critical?: string[];
  readers?: DesignRoundReading[];
}

/** The most characters of each text of a review, and the items of its lists, that the state keeps. */
export const DESIGN_ROUND_TEXT_LIMITS = { summary: 1500, counterProposal: 1000, item: 500, items: 24, readers: 12, reading: 1000 } as const;

/** How the design is reviewed (`AutopilotDesign.review`): the review policy's fields that apply to a plan. Absent: the director's approval score, three reviews, readers before the first. */
export type DesignPolicy = Pick<ReviewPolicy, "targetScore" | "maxRounds" | "readerRounds">;

/**
 * What a design run does besides what every one does (`AutopilotDesign.workflow`): each part is off while it is absent, so that a design run asked without it is the
 * one of every engine before it. `rubric`: the director and the readers score the twelve criteria of the rubric (`DESIGN_CRITERIA`), and what falls short is what a
 * round rewrites.
 */
export interface DesignWorkflow {
  rubric?: boolean;
  /** The design of every chapter is reviewed with the chapters beside it (`design-chapter-review`), and a chapter that changed is reviewed again. */
  chapterReview?: boolean;
  /**
   * Alternative pitches proposed before the design, from 2 to 6 (`DESIGN_ALTERNATIVES_MIN`…): the Brainstormer proposes them from the idea, the readers and the
   * director judge them on the rubric, and one is chosen, with its reason: the design is made of it. Absent: the design is made of the idea.
   */
  alternatives?: number;
  /** Who chooses among the alternatives: the director (absent) or the author, who is asked and the run waits. */
  pitchChoice?: "author";
  /**
   * The whole structure of the design is analysed for what does not hold together (`design-coherence`): contradictions, plot holes, timeline incongruences, characters
   * who act against themselves, repeated events, abandoned subplots, what is revealed too early. A critical finding blocks the approval of the design.
   */
  coherence?: boolean;
}

/** The reviews of a design when the policy says nothing: the director looks at it up to three times, as at a plan. */
export const DESIGN_DEFAULT_ROUNDS = 3;

/** Chapters one call of a design plans: a design says much more of a chapter than a plan, and its reply must fit the output of a modest model. */
export const DESIGN_BATCH_CHAPTERS = 6;

/**
 * A design run (`StartOptions.design`): the autopilot designs the book, from its description, and writes no prose. The concept, the plan of every chapter with its
 * design (`OutlineChapterDesign`, in the chapter entries of the Synopsis), the ledger of the secrets (`SecretLedger`) and the world (`bible/`), reviewed by the
 * simulated readers and the director for the rounds of its policy; the run stops when the director approves it (`endedAt`), and waits for the author. Kept after
 * it ends, for what it says; a start with `design` begins another (the plan is reviewed again).
 */
export interface AutopilotDesign {
  startedAt: string;
  /** The chapters the design was asked for (the Synopsis got an empty entry, the autopilot's, for each one it lacked). */
  chapters: number;
  review?: DesignPolicy;
  /** The director's reviews of this design, oldest first. */
  rounds: DesignRound[];
  /** When it ended, and why. While it is absent the design run goes on: the plan never goes past its approval. */
  endedAt?: string;
  outcome?: DesignOutcome;
  /** A critical inconsistency left at the last review was asked to the author, once. */
  escalated?: boolean;
  /**
   * `options.pauseAfterPlan` as it was when the design began: the design turns it on while it goes on, so that an engine that does not know designs and resumes
   * the run stops at the plan and writes no prose, and gives it back when it ends.
   */
  pauseAfterPlan?: boolean;
  /** The fingerprint of the ledger (`secretLedgerDigest`) of every secret whose ledger the design wrote, by path: a ledger that changed since is the author's. */
  ledgers?: Record<string, string>;
  /** What the run does besides the plain design (`DesignWorkflow`). Absent: nothing more. */
  workflow?: DesignWorkflow;
  /** The rubric of the subjects that were judged, with how their scores went (`DesignRubrics`). */
  rubric?: DesignRubrics;
  /** The latest review of every chapter, by its number (`DesignChapterReview`). */
  reviewed?: Record<string, DesignChapterReview>;
  /**
   * A review of the design on request (`DesignStartInput.reviewOnly`): the chapters it looks at (absent: the whole design), and when it began. While it is there the run
   * does only the review, and stops; any other start takes it away.
   */
  reviewing?: { chapters?: number[]; startedAt: string };
  /** The alternative pitches of the design, and the choice (`DesignAlternatives`). */
  alternatives?: DesignAlternatives;
  /** The findings of the analysis of the whole structure (`DesignCoherence`). */
  coherence?: DesignCoherence;
  /** «Review and complete» (`DesignMode`): the design run reviews the author's chapters and proposes what they lack. Absent: the design run plans the book. */
  mode?: "complete";
  /** What «Review and complete» proposes (`mode: complete`). */
  completion?: DesignCompletion;
}

/**
 * What a design run does (#125): `plan` designs the book, chapter by chapter, around the entries of the author (the design run as it always was); `complete` («Review and
 * complete») does not plan the book again: it reads every chapter the author wrote in the Synopsis and proposes what is missing (`DesignCompletion`), for the author to apply.
 */
export type DesignMode = "plan" | "complete";

/** What became of a proposal of «Review and complete»: it waits for the author, the author applied it, or left it out. */
export type DesignProposalStatus = "waiting" | "applied" | "skipped";

/** A design field of an author's chapter that «Review and complete» proposes: only a field the entry lacks, and only ever written where it is still missing. */
export interface DesignFieldProposal {
  id: string;
  key: OutlineDesignKey;
  value: string | string[] | boolean;
  status: DesignProposalStatus;
}

/** Who found a finding of «Review and complete»: the architect who proposed the fields, a simulated reader, or the director. */
export type DesignFindingSource = "architect" | "reader" | "director";

/** How much a finding of «Review and complete» weighs: an inconsistency that breaks the book, a real weakness, a detail. */
export type DesignFindingSeverity = "critical" | "major" | "minor";

/** An inconsistency or a weak point of an author's chapter. Applied, it is a note for the ghostwriter of the chapter (`design.notes`), after what is there. */
export interface DesignCompletionFinding {
  id: string;
  source: DesignFindingSource;
  /** The simulated reader who found it (its slug, and its name as the book calls it). */
  reader?: string;
  by?: string;
  severity: DesignFindingSeverity;
  /** The criterion it is about, in the words of the twelve of a design (originality, engagement, coherence, pace, tension…), when it says one. */
  criterion?: string;
  text: string;
  /** What to do about it, in a line. */
  suggestion?: string;
  status: DesignProposalStatus;
}

/** What «Review and complete» proposes for one chapter of the author. */
export interface DesignCompletionChapter {
  number: number;
  title: string;
  /** The fingerprint of the entry when its proposals were made (`OutlineChapterEntry.contentDigest`): a field the entry has now is never written. */
  digest: string;
  fields: DesignFieldProposal[];
  findings: DesignCompletionFinding[];
}

/** A canon entry (of the world, or a secret) that the author's chapters need and the book lacks, proposed: applied, it is created as a draft of the canon. */
export interface DesignCanonProposal {
  id: string;
  kind: "character" | "location" | "faction" | "item" | "secret";
  name: string;
  description: string;
  /** The chapters that need it. */
  chapters: number[];
  status: DesignProposalStatus;
}

/** A chapter the director sent back to be proposed again, with the director's words. */
export interface DesignCompletionRedo {
  chapter: number;
  notes: string[];
}

/** What a simulated reader made of the chapters and their proposals, in the review it read them for. */
export interface DesignCompletionReading {
  slug: string;
  name: string;
  /** The review (the director's, from 1) the reading came before. */
  round: number;
  /** Its vote, from 0 to 10. */
  score: number;
  summary: string;
}

/**
 * The proposals of «Review and complete» (`AutopilotDesign.completion`, #125): for every chapter of the author (an entry of the Synopsis with its text), the design fields
 * it lacks, the inconsistencies and weak points found by the architect, the readers and the director, and the canon entries the chapters need. Nothing of it is written
 * until the author applies it (`AutopilotSession.applyDesignProposals`): an entry of the author is never overwritten, and what happens in it is never changed.
 */
export interface DesignCompletion {
  /** The chapters it reviews: the author's entries with their text when the run began, in order. */
  chapters: number[];
  /** What it proposes for each, by its number. */
  entries: Record<string, DesignCompletionChapter>;
  canon: DesignCanonProposal[];
  /** Chapters the director sent back, to be proposed again before the next review. */
  redo?: DesignCompletionRedo[];
  readings: DesignCompletionReading[];
  /** The readers left out of the reading of this review (their reply stayed incomplete): the review goes on without them. */
  skippedReaders?: string[];
  /** The run that made the proposals stops once, there, for the author: the next start goes on past them. */
  awaitingAuthor?: boolean;
  /** When the author applied what they chose: how many proposals, and how many they left out. */
  decided?: { at: string; applied: number; skipped: number };
}

/** A design run asked with a start (`StartOptions.design`). */
export interface DesignStartInput {
  /** The chapters of the book: the Synopsis gets an empty entry for every one it lacks (never fewer than the entries it has). Absent: the entries it has, else 12. */
  chapters?: number;
  /** How the design is reviewed: a value sets it, `null` takes it back (`ReviewPolicyUpdate`). */
  review?: ReviewPolicyUpdate | null;
  /**
   * A review of the design that exists, on request, instead of a design run: the chapters of the Synopsis that are not written are judged chapter by chapter and, for the
   * whole design, its structure is analysed; nothing is designed, nothing is written, and the run stops. `chapters`: only those (absent: the whole design). It stands alone.
   */
  reviewOnly?: { chapters?: number[] };
  /** What the run does besides the plain design: a value sets it, `null` takes it back (`DesignWorkflow`). */
  workflow?: DesignWorkflow | null;
  /** `complete`: «Review and complete» the chapters the author wrote (`DesignMode`). Absent or `plan`: the design run as it always was. */
  mode?: DesignMode;
}

/** What a summary says of the design run (`AutopilotStateSummary.design`). */
export interface AutopilotDesignSummary {
  /** The design run goes on. */
  active: boolean;
  chapters: number;
  /** The reviews done, and the most the policy allows. */
  rounds: number;
  maxRounds: number;
  /** The vote it must reach; absent: the director's approval score. */
  targetScore?: number;
  /** The director's last vote. */
  lastScore?: number;
  endedAt?: string;
  outcome?: DesignOutcome;
  /** The run waits for the author to choose the pitch the book is designed from (the design asks for her choice and the director has recommended one): it stops without a question. */
  choosePitch?: boolean;
  /** «Review and complete»: the run reviews the author's chapters (`DesignMode`). */
  mode?: "complete";
  /** «Review and complete»: the proposals that wait for the author, and the chapters they are in. */
  proposals?: { waiting: number; chapters: number };
}

export interface AutopilotState {
  schemaVersion: 1;
  status: AutopilotStatus;
  phase: AutopilotPhase;
  brief: AutopilotBrief;
  options: AutopilotOptions;
  /** `done` once the book has a usable foundation; `generated` when the autopilot wrote it. `logline`: the one-sentence pitch of the concept it wrote (it describes the book in the outline). */
  concept: { done: boolean; generated: boolean; secrets: ConceptSecret[]; logline?: string };
  plan: AutopilotPlan | null;
  review: ChapterReview | null;
  revision: RevisionRequest | null;
  /** The director's final review of the whole book has been written. */
  finalDone: boolean;
  /**
   * What the director said of the whole book when the final step was done. Absent until then, and again when the book is not complete
   * any more (its chapters were extended, or a rewrite reopened it): nobody has judged it as it is now.
   */
  finalReview?: AutopilotFinalReview;
  /** Permanent author rules ("from now on"). */
  constraints: string[];
  interventions: AuthorIntervention[];
  /** Guidance the director carries forward to the next chapters. */
  directorNotes: string[];
  question: DirectorQuestion | null;
  /**
   * Decisions about changes of frozen chapters (and of the outline of written ones) that wait to be carried out, or are being carried out:
   * the next run does them before it goes on with the plan (a run in progress, at its next step). Absent when there is none.
   */
  pendingReviews?: PendingFrozenReview[];
  /**
   * Since when the state knows frozen chapters: a new state, from its start. A state saved by an older engine has none: its first run
   * freezes the chapters the autopilot approved (never the author's), once, and sets it.
   */
  frozenSince?: string;
  /** The changes already said with `frozenEdits: "notify"` (their fingerprints), so that each is said once. The newest are kept. */
  frozenSeen?: string[];
  /** The chapters the author asked to revise now, for one reason, in order, before the plan goes on (`RevisionCampaign`). Absent when none is going on. */
  campaign?: RevisionCampaign;
  /** The changes the author chose to decide later (`DeferredChange`). Absent when there is none. */
  deferredChanges?: DeferredChange[];
  /** A limit stopped the run (`AutopilotLimitReached`): the money cap, the token cap, the rounds of a review. Absent otherwise; a start takes it away. */
  limitReached?: AutopilotLimitReached;
  /** The reviews of the book that are over, oldest first (at most `MAX_REVIEW_RECORDS`). Absent when there was none. */
  reviews?: ReviewRecord[];
  /** The campaigns of annotations that are over, oldest first (at most `MAX_ANNOTATION_RECORDS`). Absent when there was none. */
  annotationRuns?: AnnotationsRecord[];
  /** The design run of the book (`AutopilotDesign`): going on until `endedAt`, then kept for what it says. Absent when the book was never designed by the autopilot. */
  design?: AutopilotDesign;
  runner: AutopilotRunnerInfo | null;
  stats: AutopilotStats;
  /** Short human message about the current status ("Plan ready for review"). */
  message: string | null;
  lastError: AutopilotLastError | null;
  /**
   * Why the run is paused, when the server that ran it paused it because the server was stopping (`AutopilotStopCause`). Absent (null) for any
   * other pause, and in the files of older engines. Only a `paused` state has it: any start, and a pause of the author, take it away.
   */
  stoppedBy?: AutopilotStopCause;
  createdAt: string;
  updatedAt: string;
  /** Incremented at every saved change of this file. */
  version: number;
}

export type ActivityStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface AutopilotActivity {
  id: string;
  runId: string;
  task: AutopilotTaskKind;
  phase: AutopilotPhase;
  /** What it is doing. */
  title: string;
  /** Why it is doing it. */
  reason: string;
  /** What comes next. */
  next: string;
  chapterNumber?: number;
  sceneNumber?: number;
  reader?: string;
  status: ActivityStatus;
  startedAt: string;
  endedAt?: string;
  /** Result in plain words. */
  summary?: string;
  changedPaths?: string[];
  model?: string;
  provider?: string;
  usage?: AiUsage;
  cost?: number;
  error?: string;
  /** What kind of failure `error` is (set with it, never on a step the author cancelled). */
  errorKind?: AutopilotErrorKind;
  /** Where it happened, and how far the retries got. */
  errorDetail?: AutopilotErrorDetail;
  interventionIds?: string[];
  host?: "browser" | "server";
}

export type InsightTone = "info" | "ok" | "warning" | "critical";

/** Stable codes of the runner's own messages, so clients can show them in their language. */
export type AutopilotMessageCode =
  | "conflictRetry"
  | "failureRetry"
  | "takenOver"
  | "interventionQueued"
  | "interventionInterrupt"
  | "reset"
  | "unexpectedStop"
  | "syncFailed"
  | "publishFailed"
  | "finalStateFailed"
  | "budgetNotApplicable"
  | "profileProblems"
  | "chapterPause"
  | "stepLimit"
  | "chapterLimit"
  | "outlineGhostwriter"
  | "outlineChanged"
  | "outlineRemoved"
  | "outlineWrittenChanged"
  | "outlineChangedWhileWriting"
  | "outlineRemovedWritten"
  | "outlineWarnings"
  | "outlineWrittenAuto"
  | "frozenMigrated"
  | "frozenChanged"
  | "frozenAuto"
  | "frozenInvalid"
  | "frozenReviewed"
  | "frozenCleared"
  | "campaignChapterDone"
  | "campaignSkipped"
  | "campaignDone"
  | "campaignStopped"
  | "reviewChapterDone"
  | "reviewChapterSkipped"
  | "reviewRoundDone"
  | "reviewDone"
  | "reviewStopped"
  | "reviewHeld"
  | "bookRoundAsked"
  | "bookRoundProposed"
  | "bookRoundApplied"
  | "bookRoundNone"
  | "bookRoundAuthor"
  | "plateauBroken"
  | "readersTargetMissed"
  | "budgetReached"
  | "tokenBudgetReached"
  | "longRetryWait"
  | "longRetryExhausted"
  | "longRetryOff"
  | "retrySkipped"
  | "serverShutdown"
  | "resumedAfterRestart"
  | "callsStoreFailed"
  | "modelLearned"
  | "designReady"
  | "designRound"
  | "designChecks"
  | "designAuthorEntries"
  | "designEscalated"
  | "wildcardsTriaged"
  | "wildcardsNone"
  | "designChapterReview"
  | "designPitches"
  | "designPitchChosen"
  | "designPitchChoice"
  | "designCoherence"
  | "designProposals"
  | "designReviewed"
  | "designCompletionReady";

/**
 * Which candidate of the route a call asks now, and how: what the `call-attempt` event says and `AutopilotLive.trying` keeps, so that a client shows it as the request is sent. Only
 * names and numbers: never a prompt, a reply or a key (the names are cleaned of the credentials of the configuration).
 */
export interface AutopilotAttemptInfo {
  /** Which request of the call this is, from 1: every request counts, the ones that failed before it too. */
  attempt: number;
  /** The most requests the call can make: the candidates of the route that its plan did not leave out. */
  attempts: number;
  /** The place of the candidate in the route as the author wrote it: 0 is the primary, 1 the first fallback. */
  candidateIndex: number;
  /** How many candidates the route has as written. */
  candidateCount: number;
  /** The candidate is a fallback (`candidateIndex` above 0): the primary was not asked, or failed. */
  fallback: boolean;
  integrationId: string;
  integrationName: string;
  /** The kind of provider (`azure_openai`, `openai`, `github_models`). */
  provider: string;
  model: string;
  /** What the request does of the thinking level: the level that is sent, `automatic` (none is chosen, the model decides) or `not-sent` (one is chosen and the model does not take it). */
  thinking: AiAttemptThinking;
  /** Why a level that was chosen is not sent, when the request decided it: `tools`, the request carries function tools and the model refuses a level with them (set, or learned). Absent otherwise, and from a host that does not say it. */
  thinkingWhy?: AiThinkingWhy;
  /** What the integration says about streaming. */
  streamMode: AiStreamMode;
}

/**
 * Live events: everything the autopilot does, as it happens. `run-ended` carries a `code` when the run ended for a
 * reason a client can translate (`takenOver`: another runner owns the book now, so this run stopped without saving;
 * `chapterPause`: the author asked to pause at the end of the chapter and the chapter is closed; `stepLimit` and
 * `chapterLimit`: the steps or the chapters the run was limited to are done; `longRetryExhausted`: the step failed again after
 * every cycle of «Retry later»; `longRetryOff`: «Retry later» was turned off while the run waited for it; `serverShutdown`: the
 * server that ran it was stopping, and the state says so in `stoppedBy`). A `resumedAfterRestart` insight, right after `run-started`,
 * says that the server resumed the run by itself when it started again (`options.resumeAfterRestart`).
 * A `failureRetry` insight carries `attempt` (the retry about to happen), `retries` (how many this kind of failure
 * allows) and `waitMs` (how long the runner waits first); while it waits, the `state` events carry the same in `summary.retry`
 * (with the time of the next attempt), and one more `state` event says that nothing waits any more. A `longRetryWait` insight (a wait of
 * «Retry later») carries `cycle` (from 1), `cycles` (`null`: no limit) and `waitMs`, and `summary.retry.longTerm` says the same while it
 * waits; `longRetryExhausted` carries the last `cycle` and `cycles`. A `retrySkipped` insight («Retry now» ended a wait) carries the `waitMs`
 * that was left, and is followed at once by a `state` event without `retry`.
 * `task-progress` says that the model of the running step is answering. A step that writes prose says it with its text so far (`preview`,
 * the tail of it, and the `characters` so far, at most about three times a second); a step that answers with a structured value says it with
 * numbers (`bytes` of the reply that arrived, `characters` of its text or arguments, and the `preview` of the JSON so far, empty until it streams), at most once a second. It is never saved
 * and never replayed to a client that connects later; `snapshot().live` carries the last one.
 * A structured step that streams its JSON (the arguments of its function, as they arrive) says it with its tail: `task-progress` with `kind: "json"`,
 * `preview` (the last 700 characters of the JSON so far) and `characters`, and no `bytes`; its numbers event says the same `characters` (the JSON so
 * far, once it streams). A shorter text or JSON than the one before (`""` included) is a new attempt of the call, said at once. `callSeq` says which
 * call of the step it is (from 1), and `callId` names it when the book keeps AI call records (`call-started` and `call-ended`, see
 * `AutopilotSessionConfig.calls`); those two events carry ids, sizes and times, never text. A client follows the events with `applyLiveProgress`, as
 * `snapshot().live` does: the shown text of a call never goes back to nothing until the call ends, and nothing of a call is shown as another's.
 * `call-attempt` says which candidate of the AI Router the call of the running step asks now, as its request is sent (see `AutopilotAttemptInfo`): which request of the call it is (`attempt` of `attempts`),
 * its place in the route as written (`candidateIndex` of `candidateCount`: 0 is the primary, above that a `fallback`), the integration and the `model`, the `thinking` the request carries and the integration's
 * `streamMode`. It names its call as `task-progress` does and is said whether or not the book keeps records; a call that goes on to its fallback says the next one, which replaces it. Never a prompt, a reply or
 * a key. A client follows it with `applyLiveAttempt`, as `snapshot().live` does (`live.trying`): it stays until the next call says its own or the step ends, and a host older than this one never says it, so a
 * client shows nothing for it. It is kept in the replay of the session, like `call-started`.
 * `model-learned` says what a call learned about a model from the way its provider refused it, and what the engine now remembers for the session (see `AiModelLearning`): `learned` is `no-thinking-with-tools` (the provider
 * refuses a thinking level when the request carries function tools: the call was asked again without the level, or with `none` when that is refused too, and every later request with tools to that model is asked the way
 * that answered), the integration and the model, `off` (`omit`: the level is left out; `none`: `reasoning_effort: "none"` is sent), `body` (what the provider said the first time, in its own words) and `responses` (its
 * words tell to use the Responses API, `/v1/responses`, instead). A host that keeps settings persists it as the model's `noThinkingWithTools` (`true` for `omit`, `"none"` for `none`); a
 * `modelLearned` insight says it in words, with the two ways out, and `snapshot().learned` lists what the session has learned, for a client that connects later. It is kept in the replay of the session.
 * `prompt-caching-learned` says what a call learned about a model's prompt caching (see `AiPromptCachingLearning`), with no insight, because it is no trouble: `learned` is `cached` (a response reported tokens served from
 * the provider's cache, `cachedInputTokens` of its `inputTokens`: a host that keeps settings sets the model's `promptCaching` to `learned` unless the author said it already) or `hints-rejected` (the provider refused the
 * `hint` that helps it find its cache, with its `body`, and the call was asked again without it: the engine does not send it to that model again, for as long as the session lives). It is kept in the replay of the session.
 * A `callsStoreFailed` insight says that the records of the AI calls could not be kept (the store is full or failed): the run goes on without them.
 * The insights about the outline carry the chapter they are about (`chapterNumber`) and, for a ghostwriter the outline names that does
 * not exist, its slug (`ghostwriter`), so that a client can say them in its language.
 */
export type AutopilotEventBody =
  | { type: "run-started"; runId: string; host: "browser" | "server" }
  | { type: "run-ended"; runId: string; status: AutopilotStatus; message?: string | null; code?: AutopilotMessageCode }
  | { type: "task-started"; activity: AutopilotActivity }
  | { type: "task-progress"; activityId: string; characters: number; preview: string; bytes?: number; callId?: string; callSeq?: number; kind?: "json" }
  | { type: "model-learned"; activityId?: string; learned: AiNoThinkingLearning["kind"]; integrationId: string; integrationName: string; model: string; off: AiNoThinkingLearning["off"]; body: AiErrorBody; responses: boolean }
  | { type: "prompt-caching-learned"; activityId?: string; integrationId: string; integrationName: string; model: string; learned: AiPromptCachingLearning["learned"]; inputTokens?: number; cachedInputTokens?: number; hint?: AiPromptCachingLearning["hint"]; body?: AiErrorBody }
  | { type: "call-started"; activityId: string; callId: string; seq: number; label: string; capability: string; structured: boolean; systemBytes: number; userBytes: number }
  | ({ type: "call-attempt"; activityId: string; callId?: string; callSeq?: number } & AutopilotAttemptInfo)
  | { type: "call-ended"; activityId: string; callId: string; status: AiCallStatus; attempts: number; characters: number; storedBytes: number; partial: boolean; durationMs: number; dropped: AiCallDropReason | null }
  | { type: "task-finished"; activity: AutopilotActivity }
  | { type: "insight"; activityId?: string; tone: InsightTone; title: string; detail?: string; code?: AutopilotMessageCode; attempt?: number; retries?: number; waitMs?: number; cycle?: number; cycles?: number | null; chapterNumber?: number; ghostwriter?: string; model?: string; figures?: AutopilotInsightFigures }
  | { type: "state"; state: AutopilotStateSummary }
  | { type: "sync"; activityId?: string; tone: InsightTone; title: string; detail?: string; code?: AutopilotMessageCode };

export type AutopilotEvent = AutopilotEventBody & { bookId: string; at: string; seq: number };

export interface AutopilotProgress {
  chapters: number;
  chaptersDone: number;
  scenes: number;
  scenesWritten: number;
  words: number;
}

/** A pause the author asked for that has not happened yet. `now` is not one: it abandons the request in flight and is over at once. */
export type AutopilotPausePending = "after-step" | "after-chapter";

/**
 * How a run is asked to pause: `now` abandons the request in flight; `after-step` lets the step finish and save, then pauses;
 * `after-chapter` goes on to the end of the chapter in progress (its closing and its publishing included), then pauses.
 */
export type AutopilotPauseMode = "now" | AutopilotPausePending;

/** What bounds one run. Not saved: it is for this run only. A value that is not a whole number above zero is no limit. */
export interface AutopilotRunLimits {
  /** Pause after this many steps were saved by this run. */
  steps?: number;
  /** Pause after this many chapters were completed by this run (`options.chaptersPerRun` is the same limit, saved; the stricter counts). */
  chapters?: number;
}

/** The limits of the run in progress and how far it got. */
export interface AutopilotLimitsSummary extends AutopilotRunLimits {
  stepsDone: number;
  chaptersDone: number;
}

export interface AutopilotStateSummary {
  status: AutopilotStatus;
  phase: AutopilotPhase;
  message: string | null;
  progress: AutopilotProgress;
  question: DirectorQuestion | null;
  /** The last error with its kind and detail, the state's `errorKind` and `errorDetail` also under the names `kind` and `detail`. */
  lastError: AutopilotLastErrorSummary | null;
  runner: AutopilotRunnerInfo | null;
  stats: AutopilotStats;
  pendingNotes: number;
  constraints: number;
  updatedAt: string;
  /** What the director said of the whole book (the text at most `FINAL_REVIEW_SUMMARY_CHARACTERS` long). Absent until the final step is done, and when the book was reopened. */
  finalReview?: AutopilotFinalReview;
  /**
   * Not saved: what only a live session knows, so it is absent from a summary made from the state file alone. The pause the author
   * asked for that the run has not reached yet; `null` when none waits. It changes without the state being written, so `updatedAt`
   * does not move: a `state` event is emitted whenever it does.
   */
  pausePending?: AutopilotPausePending | null;
  /** Not saved, and absent like `pausePending`: the limits of the run in progress and how far it got; `null` when the run has none, or is over. */
  limits?: AutopilotLimitsSummary | null;
  /** Derived, not saved: where the book is published now (`effectivePublish` of the options and of the host's default). */
  publish?: AutopilotPublishMode;
  /**
   * Not saved, and absent when no change waits (and until a live session looked): how many chapters have a change that waits for the
   * author's decision (a frozen chapter whose text changed, or a written chapter whose outline entry changed), as the run found it before its
   * last step, or as the last `frozenStatus()` did. A change that has a decision recorded (`state.pendingReviews`) is not counted.
   */
  frozenChanges?: number;
  /** The chapters revised now for one reason (`state.campaign`), as far as they got. Absent when none is going on. */
  campaign?: AutopilotCampaignSummary;
  /** The limit that stopped the run (`state.limitReached`), with its numbers. Absent otherwise. */
  limitReached?: AutopilotLimitReached;
  /** The design run (`state.design`), going on or ended. Absent when the book was never designed by the autopilot. */
  design?: AutopilotDesignSummary;
  /**
   * Not saved, and absent when nothing waits: while the run waits to try a failed step again, when the next attempt is and which retry it
   * is, so that a client can count down. Every change of it is a `state` event: it appears when the wait begins and goes when the attempt
   * starts (or the run ends, or «Retry now» ends the wait). In a wait of «Retry later» it has `longTerm` (the cycle, and how many). Absent
   * from a summary made from the state file alone.
   */
  retry?: AutopilotRetryInfo;
}

/**
 * The numbers an insight is about, for a client that says it in its own words: the vote and the target of a chapter or of the book, the round and the rounds of a review,
 * the lowest vote of a chapter and the book's, the outcome of a review, what a limit compared. Only what the insight is about is there.
 */
export interface AutopilotInsightFigures {
  score?: number;
  target?: number;
  round?: number;
  rounds?: number;
  lowest?: number;
  book?: number;
  below?: number;
  /** The readers' vote that a closing or a round says, with the target it is compared with (`ReviewPolicy.readersTarget`). */
  readers?: number;
  readersTarget?: number;
  /** How many readers were under their own target when a chapter was closed with a target of the readers missed. */
  readersUnder?: number;
  outcome?: ReviewOutcome;
  used?: number;
  limit?: number;
  currency?: string;
  /** A design run: how it ended, the findings of its checks, the critical inconsistencies of a review, its chapters. */
  designOutcome?: DesignOutcome;
  findings?: number;
  critical?: number;
  /** The chapters of a design run, or the chapters a book-level round of a review asks changes of. */
  chapters?: number;
  /** A book-level round of a review: how many corrections the director asked for. */
  corrections?: number;
  /** A consultation of the room of the wildcards: the voices that answered, the ideas they gave, the ones the director accepted. */
  voices?: number;
  ideas?: number;
  accepted?: number;
  /** A review of the chapters of a design: the chapters it covers (`from` to `to`) and how many of their criteria fell short. */
  from?: number;
  to?: number;
  weak?: number;
}

/** A campaign as a summary says it: the chapters it works (`follow`), how many are over, the one being worked, and the ones that wait. */
export interface AutopilotCampaignSummary {
  id: string;
  reason: RevisionReason;
  total: number;
  /** Done, or skipped: over either way. */
  done: number;
  current: number | null;
  waiting: number[];
  /** The campaign waits for the author (`RevisionCampaign.held`): starting the run releases it. */
  held?: boolean;
  /** A campaign of annotations: the notes it answers, how many are answered so far (their chapter is done), and the chapters held back for the author. */
  annotations?: { notes: number; handled: number; heldBack: number[] };
  /**
   * A review of the book: the round in progress and the rounds allowed since the run began (`maxRounds`: absent, no limit), the target, whether the book is
   * being judged, the latest votes (the lowest vote of a chapter of the review, the book's), and the money cap of the book (`options.budgetLimit`; 0: none). In a book-level
   * round (`bookRound`): where it is, how many corrections the director asked for and how many are carried out.
   */
  review?: { round: number; roundsThisRun: number; maxRounds?: number; targetScore: number; phase: "chapters" | "verdict" | "book"; lowest: number | null; book: number | null; budgetLimit: number; readers?: number | null; readersTarget?: number; bookRound?: { status: BookRoundStatus; corrections: number; applied: number } };
}

/**
 * What a client shows of the step that runs while its model answers: the text of the call that answers now, how much there is, and which candidate of the route the call asks (`trying`). It
 * changes only through `applyLiveProgress` and `applyLiveAttempt` (the session for `snapshot().live`, the web app for its panels), so that it says the same everywhere.
 */
export interface AutopilotLive {
  activity: AutopilotActivity;
  /** The characters of the call's text so far: its prose, or the JSON of a structured reply. Never fewer within an attempt of the call. */
  characters: number;
  /** The end of that text (at most 700 characters); empty until the call has written something. */
  preview: string;
  /** The text is the JSON of a structured reply (the arguments of its function, or its JSON), not prose. */
  json?: boolean;
  /** A structured reply: how many bytes of it have arrived, as a number only. Once said, it stays until the call, its attempt or the step changes. */
  bytes?: number;
  /** Which call of the step the text belongs to (from 1), and its id when the book keeps the records of its calls. */
  callSeq?: number;
  callId?: string;
  /**
   * The candidate of the route the call asks now, from its `call-attempt` (see `AutopilotAttemptInfo`). The next attempt of the call replaces it; another call's text takes it away until that call says its own.
   * Absent until the call's first request is sent, and from a host that does not say it.
   */
  trying?: AutopilotAttemptInfo;
}

/** What a client needs to render the autopilot of one book. */
export interface AutopilotSnapshot {
  bookId: string;
  state: AutopilotState | null;
  /**
   * The summary of `state` with what only the live session knows (the pause that waits, the limits of the run, how the book is
   * published): what the `state` events say, for a client that connects later. Absent from an older host.
   */
  summary?: AutopilotStateSummary | null;
  activities: AutopilotActivity[];
  /** Activity currently running with what its model is writing, if any (see `AutopilotLive` and `task-progress`). */
  live: AutopilotLive | null;
  /** What this session has learned about its models (see `AiModelLearning`), in the order it learned it: a client that connects later persists what it did not hear. Absent from an older host. */
  learned?: AiModelLearning[];
  running: boolean;
  host: "browser" | "server" | null;
  /**
   * Set when `autopilot/state.json` exists but cannot be read: `state` is then null, and the autopilot leaves the file
   * alone until it is restored from the book's history or the autopilot is reset (which deletes it).
   */
  stateError?: { code: "state_corrupt"; message: string };
}

export interface InterventionInput {
  scope: InterventionScope;
  text: string;
  /** Interrupt the running step and repeat it with the new instruction. */
  interrupt?: boolean;
}

export interface QuestionAnswer {
  questionId: string;
  /** One of the proposed options (for a question with choices, the `id` or the label of one), or free text. */
  answer: string;
  /** The `id` of one of the question's `choices`: it wins over `answer`. A client of an older server sends the id as `answer`. */
  choice?: string;
  /** Accept the work as it is and continue. */
  accept?: boolean;
  /** Keep the answer as a permanent rule instead of a note used once. Never the default. */
  asRule?: boolean;
}

export interface StartOptions {
  brief?: Partial<AutopilotBrief>;
  /**
   * `longRetry: null` turns «Retry later» off, as the engine has always read it (the policy the book had is taken back: `normalizeOptions`); `review` changes the review
   * policy field by field (`ReviewPolicyUpdate`), and `null` takes it back.
   */
  options?: Partial<Omit<AutopilotOptions, "longRetry" | "review">> & { longRetry?: AutopilotLongRetry | null; review?: ReviewPolicyUpdate | null };
  /** Limits of this run only: they are not saved. See `AutopilotRunLimits`. */
  limits?: AutopilotRunLimits;
  /**
   * A design run (`AutopilotDesign`): `true` or the chapters and the review policy begin one (a design that was over is reviewed again); `false` ends the one that goes
   * on, and the run goes on to write. Absent: a design that goes on goes on (a resume, a restart), and any other run is what it always was.
   */
  design?: DesignStartInput | boolean;
}
