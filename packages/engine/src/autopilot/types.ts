import type { AiRouteStep, AiStreamEnd, AiTimeoutPhase, AiUsage } from "../ai/types.js";
import type { AiStreamMode } from "../ai/config.js";
import type { AiAttemptThinking } from "../ai/request.js";
import type { AiCallDropReason, AiCallStatus } from "./calls/types.js";
import type { ChapterFreezeAuthor, FrozenChapterChanges } from "../book/freeze.js";

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
  /** The average of the simulated readers' votes. They read a chapter once, in the first round of its review: later rounds have none. */
  readers?: number;
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
  targets: Array<{ chapterNumber: number; sceneNumber: number; instruction: string }> | null;
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

/** Where an error happened. Short, and never a secret: `endpoint` is the origin of the provider's address, never a path or a query. */
export interface AutopilotErrorDetail {
  /** The HTTP status the provider answered, when it answered. */
  status?: number;
  /** The origin (`https://api.openai.com`) of the integration that was called. */
  endpoint?: string;
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
  | "longRetryWait"
  | "longRetryExhausted"
  | "longRetryOff"
  | "retrySkipped"
  | "serverShutdown"
  | "resumedAfterRestart"
  | "callsStoreFailed";

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
 * A `callsStoreFailed` insight says that the records of the AI calls could not be kept (the store is full or failed): the run goes on without them.
 * The insights about the outline carry the chapter they are about (`chapterNumber`) and, for a ghostwriter the outline names that does
 * not exist, its slug (`ghostwriter`), so that a client can say them in its language.
 */
export type AutopilotEventBody =
  | { type: "run-started"; runId: string; host: "browser" | "server" }
  | { type: "run-ended"; runId: string; status: AutopilotStatus; message?: string | null; code?: AutopilotMessageCode }
  | { type: "task-started"; activity: AutopilotActivity }
  | { type: "task-progress"; activityId: string; characters: number; preview: string; bytes?: number; callId?: string; callSeq?: number; kind?: "json" }
  | { type: "call-started"; activityId: string; callId: string; seq: number; label: string; capability: string; structured: boolean; systemBytes: number; userBytes: number }
  | ({ type: "call-attempt"; activityId: string; callId?: string; callSeq?: number } & AutopilotAttemptInfo)
  | { type: "call-ended"; activityId: string; callId: string; status: AiCallStatus; attempts: number; characters: number; storedBytes: number; partial: boolean; durationMs: number; dropped: AiCallDropReason | null }
  | { type: "task-finished"; activity: AutopilotActivity }
  | { type: "insight"; activityId?: string; tone: InsightTone; title: string; detail?: string; code?: AutopilotMessageCode; attempt?: number; retries?: number; waitMs?: number; cycle?: number; cycles?: number | null; chapterNumber?: number; ghostwriter?: string }
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
  /**
   * Not saved, and absent when nothing waits: while the run waits to try a failed step again, when the next attempt is and which retry it
   * is, so that a client can count down. Every change of it is a `state` event: it appears when the wait begins and goes when the attempt
   * starts (or the run ends, or «Retry now» ends the wait). In a wait of «Retry later» it has `longTerm` (the cycle, and how many). Absent
   * from a summary made from the state file alone.
   */
  retry?: AutopilotRetryInfo;
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
  /** `longRetry: null` turns «Retry later» off, as the engine has always read it (the policy the book had is taken back: `normalizeOptions`). */
  options?: Partial<Omit<AutopilotOptions, "longRetry">> & { longRetry?: AutopilotLongRetry | null };
  /** Limits of this run only: they are not saved. See `AutopilotRunLimits`. */
  limits?: AutopilotRunLimits;
}
