import type { AiUsage } from "../ai/types.js";

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
  | "final";

export interface AutopilotBrief {
  /** The idea, premise or pitch. One sentence is enough. */
  idea: string;
  /** Optional chapter-by-chapter synopsis: binding when present. */
  synopsis: string;
  targetChapters: number;
  scenesPerChapter: number;
  wordsPerScene: number;
  genre: string;
  audience: string;
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
}

/** The options that can change while a run goes on: the run reads them again at the end of every step and of every chapter. */
export const LIVE_AUTOPILOT_OPTIONS = ["publishEvery", "pauseAfterEachChapter"] as const;

/** What the author can change while a run goes on. `publishEvery: null` takes the choice back, so that the host decides again. */
export interface AutopilotLiveOptions {
  publishEvery?: AutopilotPublishMode | null;
  pauseAfterEachChapter?: boolean;
}

/** What `AutopilotSession.updateOptions` takes: the settings above at any time, and any other option when no run is active. */
export type AutopilotOptionsUpdate = Partial<Omit<AutopilotOptions, "publishEvery">> & AutopilotLiveOptions;

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

export type DirectorQuestionKind = "plan-approval" | "chapter-approval" | "round-limit" | "director";

export interface DirectorQuestion {
  id: string;
  kind: DirectorQuestionKind;
  question: string;
  context: string;
  options: string[];
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
}

export interface AutopilotState {
  schemaVersion: 1;
  status: AutopilotStatus;
  phase: AutopilotPhase;
  brief: AutopilotBrief;
  options: AutopilotOptions;
  /** `done` once the book has a usable foundation; `generated` when the autopilot wrote it. */
  concept: { done: boolean; generated: boolean; secrets: ConceptSecret[] };
  plan: AutopilotPlan | null;
  review: ChapterReview | null;
  revision: RevisionRequest | null;
  /** The director's final review of the whole book has been written. */
  finalDone: boolean;
  /** Permanent author rules ("from now on"). */
  constraints: string[];
  interventions: AuthorIntervention[];
  /** Guidance the director carries forward to the next chapters. */
  directorNotes: string[];
  question: DirectorQuestion | null;
  runner: AutopilotRunnerInfo | null;
  stats: AutopilotStats;
  /** Short human message about the current status ("Plan ready for review"). */
  message: string | null;
  lastError: { message: string; at: string; task?: AutopilotTaskKind } | null;
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
  | "chapterLimit";

/**
 * Live events: everything the autopilot does, as it happens. `run-ended` carries a `code` when the run ended for a
 * reason a client can translate (`takenOver`: another runner owns the book now, so this run stopped without saving;
 * `chapterPause`: the author asked to pause at the end of the chapter and the chapter is closed; `stepLimit` and
 * `chapterLimit`: the steps or the chapters the run was limited to are done).
 * A `failureRetry` insight carries `attempt` (the retry about to happen), `retries` (how many this kind of failure
 * allows) and `waitMs` (how long the runner waits first).
 */
export type AutopilotEventBody =
  | { type: "run-started"; runId: string; host: "browser" | "server" }
  | { type: "run-ended"; runId: string; status: AutopilotStatus; message?: string | null; code?: AutopilotMessageCode }
  | { type: "task-started"; activity: AutopilotActivity }
  | { type: "task-progress"; activityId: string; characters: number; preview: string }
  | { type: "task-finished"; activity: AutopilotActivity }
  | { type: "insight"; activityId?: string; tone: InsightTone; title: string; detail?: string; code?: AutopilotMessageCode; attempt?: number; retries?: number; waitMs?: number }
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
  lastError: AutopilotState["lastError"];
  runner: AutopilotRunnerInfo | null;
  stats: AutopilotStats;
  pendingNotes: number;
  constraints: number;
  updatedAt: string;
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
  /** Activity currently running with its streamed preview, if any. */
  live: { activity: AutopilotActivity; characters: number; preview: string } | null;
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
  /** One of the proposed options, or free text. */
  answer: string;
  /** Accept the work as it is and continue. */
  accept?: boolean;
  /** Keep the answer as a permanent rule instead of a note used once. Never the default. */
  asRule?: boolean;
}

export interface StartOptions {
  brief?: Partial<AutopilotBrief>;
  options?: Partial<AutopilotOptions>;
  /** Limits of this run only: they are not saved. See `AutopilotRunLimits`. */
  limits?: AutopilotRunLimits;
}
