import { isValidGhostwriterSlug } from "../book/paths.js";
import { asArray, asBoolean, asInteger, asNumber, asOneOf, asRecord, asString, asStringList } from "../util/json.js";
import { clipText, countWords } from "../util/text.js";
import { normalizeErrorDetail, normalizeErrorKind } from "./errors.js";
import { AUTOPILOT_PUBLISH_MODES, FROZEN_CHANGE_ACTIONS, FROZEN_EDITS_MODES } from "./types.js";
import type {
  AutopilotActivity,
  AutopilotBrief,
  AutopilotFinalReview,
  AutopilotLastErrorSummary,
  AutopilotLimitsSummary,
  AutopilotOptions,
  AutopilotPausePending,
  AutopilotPhase,
  AutopilotPlan,
  AutopilotProgress,
  AutopilotPublishMode,
  AutopilotRetryInfo,
  AutopilotRunLimits,
  AutopilotState,
  AutopilotStateSummary,
  AutopilotStatus,
  AutopilotTaskKind,
  AuthorIntervention,
  ChapterReview,
  ChapterRound,
  ConceptSecret,
  DirectorQuestion,
  FrozenAction,
  FrozenChangeKind,
  FrozenChapterView,
  FrozenEditsMode,
  FrozenQuestionContext,
  PendingFrozenReview,
  PlannedChapter,
  PlannedScene,
  QuestionChoice,
  RevisionRequest,
  RevisionSource,
} from "./types.js";

export const MAX_ACTIVITIES = 200;
export const MAX_INTERVENTIONS = 100;
export const MAX_DIRECTOR_NOTES = 12;
export const MAX_CONSTRAINTS = 80;
/** A rule goes into every request the autopilot makes: longer text is refused, never cut. */
export const MAX_RULE_CHARACTERS = 800;
export const MAX_REVISION_NOTES = 40;
/** The rounds of review a chapter keeps in the plan (`PlannedChapter.rounds`): when there are more, the oldest leave. */
export const MAX_CHAPTER_ROUNDS = 8;
/** Characters of the text of the final review in the state, and in the summary the live events carry. */
export const FINAL_REVIEW_TEXT_CHARACTERS = 1200;
export const FINAL_REVIEW_SUMMARY_CHARACTERS = 400;
/** Characters of the logline of the concept the state keeps (it becomes the description of the book in the outline). */
export const CONCEPT_LOGLINE_CHARACTERS = 600;
/** The changes of frozen chapters already said (`frozenEdits: "notify"`) that the state remembers: the newest. */
export const MAX_FROZEN_SEEN = 200;
/** Decisions about changes that the state keeps at most (one per chapter and kind is the most there can usefully be). */
export const MAX_PENDING_REVIEWS = 500;
/**
 * Upper bound for any chapter number or chapter count read from a file or a reply. It only guards against typos and
 * garbage: a book has no maximum length, and nothing below this value is ever clamped.
 */
export const MAX_BOOK_CHAPTERS = 100_000;

/** A capped list keeps its newest entries: the author's latest rules matter most. */
function newestList(value: unknown, max: number): string[] {
  return asStringList(value, Number.MAX_SAFE_INTEGER).slice(-max);
}

/** Permanent author rules, newest kept when the cap is reached. */
export function capConstraints(constraints: string[]): string[] {
  return newestList(constraints, MAX_CONSTRAINTS);
}

/**
 * The codes of `AutopilotRuleError`, which are also the codes of the personal server's answers to the routes that edit the rules
 * (see the README, "The personal server client"): one list the engine, the server and a host agree on.
 */
export const AUTOPILOT_RULE_ERROR_CODES = ["rule_empty", "rule_too_long", "rule_not_found", "rule_changed", "rule_duplicate"] as const;

export type AutopilotRuleErrorCode = (typeof AUTOPILOT_RULE_ERROR_CODES)[number];

/** Whether a code (of a `ServerRequestError`, say) is one the rules can be refused with. Never throws. */
export function isAutopilotRuleErrorCode(code: unknown): code is AutopilotRuleErrorCode {
  return typeof code === "string" && (AUTOPILOT_RULE_ERROR_CODES as readonly string[]).includes(code);
}

/** A rule that cannot be saved as asked. The message says why; `code` lets a host say it in the author's language. */
export class AutopilotRuleError extends Error {
  constructor(readonly code: AutopilotRuleErrorCode, message: string, readonly limit?: number) {
    super(message);
    this.name = "AutopilotRuleError";
  }
}

/** The text of a rule without the spaces around it. An empty rule, or one over `MAX_RULE_CHARACTERS`, is refused. */
export function normalizeRuleText(text: string): string {
  const rule = (text ?? "").trim();
  if (!rule) throw new AutopilotRuleError("rule_empty", "The rule is empty.");
  if (rule.length > MAX_RULE_CHARACTERS) {
    throw new AutopilotRuleError("rule_too_long", `The rule is ${rule.length} characters long: a rule is at most ${MAX_RULE_CHARACTERS} characters, because it goes into every request. Shorten it or split it into several rules.`, MAX_RULE_CHARACTERS);
  }
  return rule;
}

export const DEFAULT_BRIEF: AutopilotBrief = {
  idea: "",
  synopsis: "",
  targetChapters: 12,
  scenesPerChapter: 3,
  wordsPerScene: 1400,
  genre: "",
  audience: "",
};

export const DEFAULT_OPTIONS: AutopilotOptions = {
  readers: true,
  maxReaders: 5,
  readersOnPlan: true,
  specialists: true,
  pauseAfterPlan: true,
  pauseAfterEachChapter: false,
  chaptersPerRun: 0,
  budgetLimit: 0,
  budgetTokens: 0,
  syncAfterChapter: true,
  fillOutline: true,
  frozenEdits: "ask",
};

const STATUSES: AutopilotStatus[] = ["idle", "running", "paused", "waiting-author", "error", "completed"];
const PHASES: AutopilotPhase[] = ["concept", "plan", "write", "review", "final", "completed"];

export function normalizeBrief(value: unknown, base: AutopilotBrief = DEFAULT_BRIEF): AutopilotBrief {
  const source = asRecord(value);
  return {
    idea: asString(source.idea, base.idea),
    synopsis: asString(source.synopsis, base.synopsis),
    targetChapters: asInteger(source.targetChapters, base.targetChapters, 1, MAX_BOOK_CHAPTERS),
    scenesPerChapter: asInteger(source.scenesPerChapter, base.scenesPerChapter, 1, 20),
    wordsPerScene: asInteger(source.wordsPerScene, base.wordsPerScene, 200, 8000),
    genre: asString(source.genre, base.genre),
    audience: asString(source.audience, base.audience),
  };
}

/** What to do with a change of a frozen chapter, read like every word of the options is (any case, spaces around); `undefined` for anything else. */
function frozenEditsModeOf(value: unknown): FrozenEditsMode | undefined {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (FROZEN_EDITS_MODES as readonly string[]).includes(text) ? text as FrozenEditsMode : undefined;
}

/** The way of publishing a value names, read like every word of the options is (any case, spaces around); `undefined` for anything else. */
function publishModeOf(value: unknown): AutopilotPublishMode | undefined {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (AUTOPILOT_PUBLISH_MODES as readonly string[]).includes(text) ? text as AutopilotPublishMode : undefined;
}

/**
 * Where the book is published now: the author's choice (`options.publishEvery`), else the host's default, else what the older option
 * `syncAfterChapter` says (every chapter when it is on, never when it is off). A value nobody knows is no choice.
 */
export function effectivePublish(options: Partial<Pick<AutopilotOptions, "publishEvery" | "syncAfterChapter">> | null | undefined, defaultPublish?: AutopilotPublishMode): AutopilotPublishMode {
  return publishModeOf(options?.publishEvery) ?? publishModeOf(defaultPublish) ?? (options?.syncAfterChapter ? "chapter" : "off");
}

/**
 * The default of a host that did not say where it publishes: a server publishes after every step, as its hook has always been called
 * (and as `syncAfterChapter` documents: "the server publishes after every step"); a browser has none, so the option `syncAfterChapter`
 * decides, as it always did.
 */
export function hostDefaultPublish(host: "browser" | "server", defaultPublish?: AutopilotPublishMode): AutopilotPublishMode | undefined {
  return publishModeOf(defaultPublish) ?? (host === "server" ? "step" : undefined);
}

/** The limits of a run as the engine takes them: only a whole number above zero is a limit; anything else (also `null`, a string, `0`) is none. `undefined` when there is no limit at all. */
export function normalizeRunLimits(value: unknown): AutopilotRunLimits | undefined {
  const source = asRecord(value);
  const limit = (entry: unknown): number | undefined => (typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0 ? entry : undefined);
  const steps = limit(source.steps);
  const chapters = limit(source.chapters);
  return steps || chapters ? { ...(steps ? { steps } : {}), ...(chapters ? { chapters } : {}) } : undefined;
}

export function normalizeOptions(value: unknown, base: AutopilotOptions = DEFAULT_OPTIONS): AutopilotOptions {
  const source = asRecord(value);
  // `null` takes the author's choice back, so that the host decides again; a value nobody knows leaves it as it was.
  const publishEvery = source.publishEvery === null ? undefined : publishModeOf(source.publishEvery) ?? base.publishEvery;
  return {
    readers: asBoolean(source.readers, base.readers),
    maxReaders: asInteger(source.maxReaders, base.maxReaders, 1, 20),
    readersOnPlan: asBoolean(source.readersOnPlan, base.readersOnPlan),
    specialists: asBoolean(source.specialists, base.specialists),
    pauseAfterPlan: asBoolean(source.pauseAfterPlan, base.pauseAfterPlan),
    pauseAfterEachChapter: asBoolean(source.pauseAfterEachChapter, base.pauseAfterEachChapter),
    chaptersPerRun: asInteger(source.chaptersPerRun, base.chaptersPerRun, 0, MAX_BOOK_CHAPTERS),
    budgetLimit: asNumber(source.budgetLimit, base.budgetLimit, 0, 1_000_000),
    budgetTokens: asInteger(source.budgetTokens, base.budgetTokens ?? 0, 0, Number.MAX_SAFE_INTEGER),
    syncAfterChapter: asBoolean(source.syncAfterChapter, base.syncAfterChapter),
    fillOutline: asBoolean(source.fillOutline, base.fillOutline ?? true),
    frozenEdits: frozenEditsModeOf(source.frozenEdits) ?? base.frozenEdits ?? "ask",
    ...(publishEvery ? { publishEvery } : {}),
  };
}

/** A number read from a file or a reply: a number, or text that is one. `undefined` for anything else (an empty text is not zero). */
function readNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A vote on the 0-10 scale with one decimal at most; `undefined` for what is not a number. */
function readVote(value: unknown): number | undefined {
  const number = readNumber(value);
  return number === undefined ? undefined : Math.round(Math.min(10, Math.max(0, number)) * 10) / 10;
}

/** A counter: a whole number from 0 to 999, as the history of a review has them. */
function readCount(value: unknown): number | undefined {
  const number = readNumber(value);
  return number === undefined ? undefined : Math.round(Math.min(999, Math.max(0, number)));
}

/** A duration in milliseconds: whole, not negative, and a number the engine can add to. */
function readDuration(value: unknown): number | undefined {
  const number = readNumber(value);
  return number === undefined ? undefined : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(number)));
}

/** A verdict as a round keeps it: `approve` or `revise` (case and surrounding spaces do not matter); anything else is no verdict. */
function readVerdict(value: unknown): ChapterRound["verdict"] | undefined {
  const verdict = typeof value === "string" ? value.trim().toLowerCase() : "";
  return verdict === "approve" || verdict === "revise" ? verdict : undefined;
}

/** A date (`2026-02-01`) or a date and time with its zone (`2026-02-01T10:00:00Z`, `...+02:00`): the shapes of an ISO 8601 moment that read the same anywhere. */
const MOMENT_SHAPE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** A moment as the state keeps it: ISO 8601 in UTC (`toISOString`), whatever zone the file wrote it in; anything that is not one is no value. */
function readMoment(value: unknown): string | undefined {
  if (typeof value !== "string" || !MOMENT_SHAPE.test(value.trim())) return undefined;
  const time = Date.parse(value.trim());
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** The id of an activity as a file says it: what the engine's own ids are made of, and short. Anything else is no value. */
function readActivityId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : undefined;
}

/** One round as a plan keeps it: the four numbers and the verdict, valid. `null` when the entry holds no number (a verdict alone is no round). */
function normalizeRound(value: unknown): ChapterRound | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const director = readVote(source.director);
  const readers = readVote(source.readers);
  const verdict = readVerdict(source.verdict);
  const accepted = readCount(source.accepted);
  const rejected = readCount(source.rejected);
  if (director === undefined && readers === undefined && accepted === undefined && rejected === undefined) return null;
  return {
    ...(director !== undefined ? { director } : {}),
    ...(readers !== undefined ? { readers } : {}),
    ...(verdict ? { verdict } : {}),
    ...(accepted !== undefined ? { accepted } : {}),
    ...(rejected !== undefined ? { rejected } : {}),
  };
}

/** The rounds of a chapter as a file says them: the valid ones, at most the newest `MAX_CHAPTER_ROUNDS`; `undefined` when there is none. */
function normalizeRounds(value: unknown): ChapterRound[] | undefined {
  const rounds = asArray(value).map(normalizeRound).filter((round): round is ChapterRound => round !== null).slice(-MAX_CHAPTER_ROUNDS);
  return rounds.length ? rounds : undefined;
}

/**
 * The record of a round the director has just judged: its vote, the average of the readers' votes when they read the chapter in this round
 * (they read it once, in the first round of its review), the verdict the plan acted on and what the director decided. Made with the rules a
 * file is read with, so that it is the same before and after it is saved.
 */
export function closedRound(input: { director: number; readers?: number[]; verdict?: ChapterRound["verdict"]; accepted: number; rejected: number }): ChapterRound {
  const readers = input.readers?.length ? input.readers.reduce((sum, vote) => sum + vote, 0) / input.readers.length : undefined;
  return normalizeRound({ director: input.director, readers, verdict: input.verdict, accepted: input.accepted, rejected: input.rejected }) ?? {};
}

/** Add a round to the history of a chapter, which keeps at most `MAX_CHAPTER_ROUNDS`: the oldest leave first. */
export function recordChapterRound(chapter: PlannedChapter, round: ChapterRound): void {
  chapter.rounds = [...(chapter.rounds ?? []), round].slice(-MAX_CHAPTER_ROUNDS);
}

/** The final review as the state keeps it (the text at most `FINAL_REVIEW_TEXT_CHARACTERS`). Anything that is not a verdict with a score is no final review. */
export function normalizeFinalReview(value: unknown): AutopilotFinalReview | undefined {
  const source = asRecord(value);
  const verdict = typeof source.verdict === "string" ? source.verdict.trim().toLowerCase() : "";
  const score = readVote(source.score);
  if ((verdict !== "approve" && verdict !== "revise") || score === undefined) return undefined;
  return {
    verdict,
    score,
    text: clipText(typeof source.text === "string" ? source.text.trim() : "", FINAL_REVIEW_TEXT_CHARACTERS),
    at: typeof source.at === "string" ? source.at.trim() : "",
  };
}

function normalizeScene(value: unknown, index: number): PlannedScene {
  const source = asRecord(value);
  return {
    number: asInteger(source.number, index + 1, 1, 999),
    title: asString(source.title) || `Scene ${index + 1}`,
    goal: asString(source.goal),
    beats: asStringList(source.beats, 20),
    pov: asString(source.pov) || undefined,
    location: asString(source.location) || undefined,
    characters: asStringList(source.characters, 20),
    summary: asString(source.summary) || undefined,
    status: asOneOf(source.status, ["planned", "written", "reviewed"] as const, "planned"),
    slug: asString(source.slug) || undefined,
    path: asString(source.path) || undefined,
    words: typeof source.words === "number" ? source.words : undefined,
    revisions: asInteger(source.revisions, 0, 0, 999),
  };
}

function normalizeChapter(value: unknown, index: number): PlannedChapter {
  const source = asRecord(value);
  const number = asInteger(source.number, index + 1, 1, MAX_BOOK_CHAPTERS);
  const rounds = normalizeRounds(source.rounds);
  const ghostwriter = asString(source.ghostwriter);
  const outlineDigest = asString(source.outlineDigest);
  return {
    number,
    title: asString(source.title) || `Chapter ${number}`,
    slug: asString(source.slug),
    summary: asString(source.summary),
    goal: asString(source.goal),
    pov: asStringList(source.pov, 10),
    keyEvents: asStringList(source.keyEvents, 20),
    reveals: asStringList(source.reveals, 20),
    status: asOneOf(source.status, ["planned", "writing", "review", "done"] as const, "planned"),
    imported: source.imported === true ? true : undefined,
    skipReaders: source.skipReaders === true ? true : undefined,
    scenes: asArray(source.scenes).map(normalizeScene),
    score: typeof source.score === "number" ? source.score : undefined,
    storySoFarAtClose: asString(source.storySoFarAtClose) || undefined,
    ...(rounds ? { rounds } : {}),
    ...(ghostwriter && isValidGhostwriterSlug(ghostwriter) ? { ghostwriter } : {}),
    ...(OUTLINE_DIGEST_SHAPE.test(outlineDigest) ? { outlineDigest } : {}),
  };
}

/** A digest as the outline writes it: a short token of letters and digits. Anything else is no digest. */
const OUTLINE_DIGEST_SHAPE = /^[A-Za-z0-9:_-]{4,128}$/;

/** The chapters the outline took out of the plan: whole numbers of chapters, once each, in order. */
function normalizeRemovedChapters(value: unknown): number[] {
  return [...new Set(asArray(value).map((entry) => asInteger(entry, 0, 0, MAX_BOOK_CHAPTERS)).filter((entry) => entry > 0))].sort((left, right) => left - right);
}

function normalizePlan(value: unknown): AutopilotPlan | null {
  if (!value || typeof value !== "object") return null;
  const source = asRecord(value);
  const revisionBatches = [...new Set(asArray(source.revisionBatches).map((entry) => asInteger(entry, 0, 0, MAX_BOOK_CHAPTERS)).filter((entry) => entry > 0))].sort((left, right) => left - right);
  const skippedReaders = asStringList(source.skippedReaders, 40);
  const removedChapters = normalizeRemovedChapters(source.removedChapters);
  return {
    chapters: asArray(source.chapters).map(normalizeChapter).sort((left, right) => left.number - right.number),
    approved: asBoolean(source.approved, false),
    rounds: asInteger(source.rounds, 0, 0, 99),
    revisionNotes: newestList(source.revisionNotes, MAX_REVISION_NOTES),
    ...(revisionBatches.length ? { revisionBatches } : {}),
    readerReactions: asArray(source.readerReactions).map((entry) => {
      const reaction = asRecord(entry);
      return {
        slug: asString(reaction.slug),
        name: asString(reaction.name),
        interest: asNumber(reaction.interest, 5, 1, 10),
        reaction: asString(reaction.reaction),
        concerns: asStringList(reaction.concerns, 12),
        wishes: asStringList(reaction.wishes, 12),
      };
    }).filter((reaction) => reaction.slug),
    readersDone: asBoolean(source.readersDone, false),
    ...(skippedReaders.length ? { skippedReaders } : {}),
    awaitingAuthor: asBoolean(source.awaitingAuthor, false),
    ...(removedChapters.length ? { removedChapters } : {}),
  };
}

function normalizeSecrets(value: unknown): ConceptSecret[] {
  return asArray(value).map((entry) => {
    const secret = asRecord(entry);
    const revealChapter = asInteger(secret.revealChapter, 0, 0, MAX_BOOK_CHAPTERS);
    return { slug: asString(secret.slug), title: asString(secret.title), revealChapter: revealChapter || undefined };
  }).filter((secret) => secret.slug);
}

function normalizeReview(value: unknown): ChapterReview | null {
  if (!value || typeof value !== "object") return null;
  const source = asRecord(value);
  return {
    chapterNumber: asInteger(source.chapterNumber, 1, 1, MAX_BOOK_CHAPTERS),
    round: asInteger(source.round, 1, 1, 99),
    readersPending: asStringList(source.readersPending, 40),
    readerScores: asArray(source.readerScores).map((entry) => {
      const score = asRecord(entry);
      return {
        slug: asString(score.slug),
        name: asString(score.name),
        score: asNumber(score.score, 5, 1, 10),
        mainProblem: asString(score.mainProblem),
        prioritySuggestion: asString(score.prioritySuggestion),
        path: asString(score.path),
      };
    }).filter((score) => score.slug),
    readersSummaryDone: asBoolean(source.readersSummaryDone, false),
    findings: asArray(source.findings).map((entry, index) => {
      const finding = asRecord(entry);
      const sceneNumber = asInteger(finding.sceneNumber, 0, 0, 999);
      return {
        id: asString(finding.id) || `F${index + 1}`,
        source: asOneOf(finding.source, ["specialist", "reader"] as const, "specialist"),
        category: asString(finding.category) || "general",
        severity: asOneOf(finding.severity, ["critical", "major", "minor"] as const, "minor"),
        sceneNumber: sceneNumber || undefined,
        evidence: asString(finding.evidence) || undefined,
        anchored: asBoolean(finding.anchored, false),
        problem: asString(finding.problem),
        remediation: asString(finding.remediation),
        reader: asString(finding.reader) || undefined,
      };
    }),
    specialistsDone: asBoolean(source.specialistsDone, false),
    directorDone: asBoolean(source.directorDone, false),
    verdict: source.verdict === "approve" || source.verdict === "revise" ? source.verdict : undefined,
    score: typeof source.score === "number" ? source.score : undefined,
    summary: asString(source.summary) || undefined,
    decisions: asArray(source.decisions).map((entry) => {
      const decision = asRecord(entry);
      const sceneNumber = asInteger(decision.sceneNumber, 0, 0, 999);
      return {
        findingId: asString(decision.findingId),
        action: asOneOf(decision.action, ["accept", "reject"] as const, "reject"),
        rationale: asString(decision.rationale),
        remediation: asString(decision.remediation),
        sceneNumber: sceneNumber || undefined,
      };
    }),
    repairQueue: asArray(source.repairQueue).map((entry) => asInteger(entry, 0, 0, 999)).filter((entry) => entry > 0),
    previousFixes: asStringList(source.previousFixes, 40),
    history: asArray(source.history).map((entry) => {
      const item = asRecord(entry);
      return {
        round: asInteger(item.round, 1, 1, 99),
        verdict: item.verdict === "approve" ? "approve" as const : "revise" as const,
        score: asNumber(item.score, 0, 0, 10),
        accepted: asInteger(item.accepted, 0, 0, 999),
        rejected: asInteger(item.rejected, 0, 0, 999),
      };
    }),
    ...(source.authorEdit === true ? { authorEdit: true } : {}),
  };
}

const FROZEN_CHANGE_KINDS: readonly FrozenChangeKind[] = ["frozen", "outline"];

function frozenKindOf(value: unknown): FrozenChangeKind | undefined {
  return typeof value === "string" && (FROZEN_CHANGE_KINDS as readonly string[]).includes(value) ? value as FrozenChangeKind : undefined;
}

/** Text a file says, as it is (only the spaces around go): `undefined` for anything that is not a text, or is empty. */
function readText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? clipText(value.trim(), max) : undefined;
}

/** Texts only (a number or anything else is no entry), without empty ones. */
function textList(value: unknown, max: number): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()).slice(-max);
}

/** What the autopilot knew of a chapter (before or after a change), as a file says it; `undefined` for what is not one. */
function normalizeFrozenView(value: unknown): FrozenChapterView | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const storySoFar = readText(source.storySoFar, 16_000);
  return {
    title: readText(source.title, 400) ?? "",
    summary: readText(source.summary, 4000) ?? "",
    keyEvents: asStringList(source.keyEvents, 20),
    ...(storySoFar ? { storySoFar } : {}),
  };
}

/** A decision about a change, as a file says it: one of the actions of its kind, about a chapter. Anything else is no decision. */
function normalizePendingReview(value: unknown): PendingFrozenReview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const kind = frozenKindOf(source.kind);
  const action = typeof source.action === "string" ? source.action as FrozenAction : undefined;
  const number = asInteger(source.number, 0, 0, MAX_BOOK_CHAPTERS);
  const id = readText(source.id, 120);
  const fingerprint = readText(source.fingerprint, 128);
  if (!kind || !action || !FROZEN_CHANGE_ACTIONS[kind].includes(action) || !number || !id || !fingerprint) return null;
  const note = readText(source.note, 8000);
  const startedSource = asRecord(source.started);
  const phase: "review" | "rewrite" | undefined = startedSource.phase === "review" || startedSource.phase === "rewrite" ? startedSource.phase : undefined;
  const before = normalizeFrozenView(startedSource.before);
  const started = phase && before
    ? { at: asString(startedSource.at), phase, before, ...(typeof startedSource.rewritten === "boolean" ? { rewritten: startedSource.rewritten } : {}) }
    : undefined;
  return {
    id,
    kind,
    number,
    action,
    fingerprint,
    at: asString(source.at),
    ...(note ? { note } : {}),
    ...(source.auto === true ? { auto: true } : {}),
    ...(started ? { started } : {}),
  };
}

/** The decisions that wait, as a file says them: the valid ones, at most `MAX_PENDING_REVIEWS`; `undefined` when there is none. */
function normalizePendingReviews(value: unknown): PendingFrozenReview[] | undefined {
  const entries = asArray(value).map(normalizePendingReview).filter((entry): entry is PendingFrozenReview => entry !== null).slice(-MAX_PENDING_REVIEWS);
  return entries.length ? entries : undefined;
}

function normalizeChanged(value: unknown): FrozenQuestionContext["changed"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  return { added: textList(source.added, 200), removed: textList(source.removed, 200), modified: textList(source.modified, 200), body: source.body === true };
}

/** What a question about a change is about, as a file says it; `undefined` for what is not one. */
function normalizeFrozenContext(value: unknown): FrozenQuestionContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const kind = frozenKindOf(source.kind);
  const number = asInteger(source.number, 0, 0, MAX_BOOK_CHAPTERS);
  const fingerprint = readText(source.fingerprint, 128);
  if (!kind || !number || !fingerprint) return undefined;
  const title = readText(source.title, 400);
  const by = source.by === "autopilot" || source.by === "author" ? source.by : undefined;
  const frozenAt = readMoment(source.frozenAt);
  const changed = normalizeChanged(source.changed);
  const others = [...new Set(asArray(source.others).map((entry) => asInteger(entry, 0, 0, MAX_BOOK_CHAPTERS)).filter((entry) => entry > 0))].slice(0, 200);
  return {
    kind,
    number,
    slug: asString(source.slug),
    fingerprint,
    ...(title ? { title } : {}),
    ...(by ? { by } : {}),
    ...(frozenAt ? { frozenAt } : {}),
    ...(changed ? { changed } : {}),
    ...(others.length ? { others } : {}),
  };
}

/** The change a revision comes from, as a file says it; `undefined` for what is not one. */
function normalizeRevisionSource(value: unknown): RevisionSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const kind = frozenKindOf(source.kind);
  const chapterNumber = asInteger(source.chapterNumber, 0, 0, MAX_BOOK_CHAPTERS);
  if (!kind || !chapterNumber) return undefined;
  const note = readText(source.note, 8000);
  const before = normalizeFrozenView(source.before);
  const after = normalizeFrozenView(source.after);
  return {
    kind,
    chapterNumber,
    ...(note ? { note } : {}),
    ...(source.auto === true ? { auto: true } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  };
}

function normalizeQuestion(value: unknown): DirectorQuestion | null {
  if (!value || typeof value !== "object") return null;
  const source = asRecord(value);
  const question = asString(source.question);
  if (!question) return null;
  const chapterNumber = asInteger(source.chapterNumber, 0, 0, MAX_BOOK_CHAPTERS);
  const choices: QuestionChoice[] = asArray(source.choices).map(asRecord).map((choice) => ({ id: asString(choice.id), label: asString(choice.label) })).filter((choice) => choice.id && choice.label).slice(0, 6);
  const frozen = normalizeFrozenContext(source.frozen);
  return {
    id: asString(source.id) || `question-${Date.now()}`,
    kind: asOneOf(source.kind, ["plan-approval", "chapter-approval", "round-limit", "director", "frozen-change", "outline-change"] as const, "director"),
    question,
    context: asString(source.context),
    options: asStringList(source.options, 6),
    ...(choices.length ? { choices } : {}),
    ...(frozen ? { frozen } : {}),
    chapterNumber: chapterNumber || undefined,
    askedAt: asString(source.askedAt) || new Date(0).toISOString(),
  };
}

function normalizeRevision(value: unknown): RevisionRequest | null {
  if (!value || typeof value !== "object") return null;
  const source = asRecord(value);
  const instruction = asString(source.instruction);
  if (!instruction) return null;
  const revisedChapters = [...new Set(asArray(source.revisedChapters).map((entry) => asInteger(entry, 0, 0, MAX_BOOK_CHAPTERS)).filter((entry) => entry > 0))].sort((left, right) => left - right);
  const afterChapter = asInteger(source.afterChapter, 0, 0, MAX_BOOK_CHAPTERS);
  const onlyChapter = asInteger(source.onlyChapter, 0, 0, MAX_BOOK_CHAPTERS);
  const revisionSource = normalizeRevisionSource(source.source);
  return {
    id: asString(source.id) || `revision-${Date.now()}`,
    instruction,
    createdAt: asString(source.createdAt) || new Date(0).toISOString(),
    targets: Array.isArray(source.targets)
      ? source.targets.map((entry) => {
        const target = asRecord(entry);
        return { chapterNumber: asInteger(target.chapterNumber, 1, 1, MAX_BOOK_CHAPTERS), sceneNumber: asInteger(target.sceneNumber, 1, 1, 999), instruction: asString(target.instruction) };
      })
      : null,
    cursor: asInteger(source.cursor, 0, 0, 1_000_000),
    ...(revisedChapters.length ? { revisedChapters } : {}),
    ...(afterChapter ? { afterChapter } : {}),
    ...(onlyChapter ? { onlyChapter } : {}),
    ...(revisionSource ? { source: revisionSource } : {}),
  };
}

function normalizeInterventions(value: unknown): AuthorIntervention[] {
  return asArray(value).map((entry) => {
    const source = asRecord(entry);
    return {
      id: asString(source.id),
      scope: asOneOf(source.scope, ["next_step", "from_now", "rewrite"] as const, "next_step"),
      text: asString(source.text),
      createdAt: asString(source.createdAt),
      during: asString(source.during),
      status: asOneOf(source.status, ["pending", "applied"] as const, "applied"),
      appliedAt: asString(source.appliedAt) || undefined,
      appliedBy: asString(source.appliedBy) || undefined,
    };
  }).filter((entry) => entry.id && entry.text).slice(-MAX_INTERVENTIONS);
}

export function createAutopilotState(now: Date, brief?: Partial<AutopilotBrief>, options?: Partial<AutopilotOptions>): AutopilotState {
  const at = now.toISOString();
  return {
    schemaVersion: 1,
    status: "idle",
    phase: "concept",
    brief: normalizeBrief(brief ?? {}),
    options: normalizeOptions(options ?? {}),
    concept: { done: false, generated: false, secrets: [] },
    plan: null,
    review: null,
    revision: null,
    finalDone: false,
    constraints: [],
    interventions: [],
    directorNotes: [],
    question: null,
    // A new state knows frozen chapters from its start: no chapter is frozen without asking but the ones the autopilot approves.
    frozenSince: at,
    runner: null,
    stats: { tasks: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, failures: 0 },
    message: null,
    lastError: null,
    createdAt: at,
    updatedAt: at,
    version: 0,
  };
}

/** Tolerant reader for `autopilot/state.json`, including hand edits and older files. */
export function normalizeAutopilotState(value: unknown, now = new Date()): AutopilotState {
  const source = asRecord(value);
  const base = createAutopilotState(now);
  const stats = asRecord(source.stats);
  const usageUnknownCalls = asInteger(stats.usageUnknownCalls, 0, 0, Number.MAX_SAFE_INTEGER);
  const costUnknownCalls = asInteger(stats.costUnknownCalls, 0, 0, Number.MAX_SAFE_INTEGER);
  const workedMs = readDuration(stats.workedMs);
  // The moment the count began means something only next to the count itself.
  const workedMsSince = workedMs === undefined ? undefined : readMoment(stats.workedMsSince);
  const finalReview = normalizeFinalReview(source.finalReview);
  const concept = asRecord(source.concept);
  const logline = clipText(asString(concept.logline), CONCEPT_LOGLINE_CHARACTERS);
  const lastError = asRecord(source.lastError);
  const activityId = readActivityId(lastError.activityId);
  const errorKind = normalizeErrorKind(lastError.errorKind);
  const errorDetail = normalizeErrorDetail(lastError.errorDetail);
  const runner = asRecord(source.runner);
  const pendingReviews = normalizePendingReviews(source.pendingReviews);
  const frozenSince = readMoment(source.frozenSince);
  const frozenSeen = textList(source.frozenSeen, MAX_FROZEN_SEEN);
  return {
    schemaVersion: 1,
    status: asOneOf(source.status, STATUSES, "idle"),
    phase: asOneOf(source.phase, PHASES, "concept"),
    brief: normalizeBrief(source.brief),
    options: normalizeOptions(source.options),
    concept: { done: asBoolean(concept.done, false), generated: asBoolean(concept.generated, false), secrets: normalizeSecrets(concept.secrets), ...(logline ? { logline } : {}) },
    plan: normalizePlan(source.plan),
    review: normalizeReview(source.review),
    revision: normalizeRevision(source.revision),
    finalDone: asBoolean(source.finalDone, false),
    ...(finalReview ? { finalReview } : {}),
    constraints: newestList(source.constraints, MAX_CONSTRAINTS),
    interventions: normalizeInterventions(source.interventions),
    directorNotes: newestList(source.directorNotes, MAX_DIRECTOR_NOTES),
    question: normalizeQuestion(source.question),
    ...(pendingReviews ? { pendingReviews } : {}),
    ...(frozenSince ? { frozenSince } : {}),
    ...(frozenSeen.length ? { frozenSeen } : {}),
    runner: asString(runner.runId)
      ? {
        host: runner.host === "server" ? "server" : "browser",
        label: asString(runner.label),
        ...(asString(runner.hostId) ? { hostId: asString(runner.hostId) } : {}),
        runId: asString(runner.runId),
        startedAt: asString(runner.startedAt),
        heartbeatAt: asString(runner.heartbeatAt),
      }
      : null,
    stats: {
      tasks: asInteger(stats.tasks, 0, 0, Number.MAX_SAFE_INTEGER),
      aiCalls: asInteger(stats.aiCalls, 0, 0, Number.MAX_SAFE_INTEGER),
      inputTokens: asInteger(stats.inputTokens, 0, 0, Number.MAX_SAFE_INTEGER),
      outputTokens: asInteger(stats.outputTokens, 0, 0, Number.MAX_SAFE_INTEGER),
      cost: asNumber(stats.cost, 0, 0, Number.MAX_SAFE_INTEGER),
      currency: asString(stats.currency) || undefined,
      failures: asInteger(stats.failures, 0, 0, Number.MAX_SAFE_INTEGER),
      ...(usageUnknownCalls ? { usageUnknownCalls } : {}),
      ...(costUnknownCalls ? { costUnknownCalls } : {}),
      ...(workedMs !== undefined ? { workedMs } : {}),
      ...(workedMsSince ? { workedMsSince } : {}),
    },
    message: asString(source.message) || null,
    lastError: asString(lastError.message)
      ? {
        message: asString(lastError.message),
        at: asString(lastError.at),
        task: (asString(lastError.task) || undefined) as AutopilotTaskKind | undefined,
        ...(activityId ? { activityId } : {}),
        ...(errorKind ? { errorKind } : {}),
        ...(errorDetail ? { errorDetail } : {}),
      }
      : null,
    createdAt: asString(source.createdAt) || base.createdAt,
    updatedAt: asString(source.updatedAt) || base.updatedAt,
    version: asInteger(source.version, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function parseAutopilotState(raw: string | null | undefined, now = new Date()): AutopilotState | null {
  if (!raw?.trim()) return null;
  try {
    return normalizeAutopilotState(JSON.parse(raw), now);
  } catch {
    return null;
  }
}

/**
 * Like `parseAutopilotState`, but it tells a file that is absent or blank (nothing to protect) from one that exists
 * with content that is not a JSON object, for example a merge's conflict markers: `unreadable` then says why, and
 * the file must not be overwritten.
 */
export function inspectAutopilotState(raw: string | null | undefined, now = new Date()): { state: AutopilotState | null; unreadable?: string } {
  if (!raw?.trim()) return { state: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    const conflicted = /^<{7}(?: |$)/m.test(raw) && /^>{7}(?: |$)/m.test(raw);
    return { state: null, unreadable: conflicted ? "it contains unresolved merge conflict markers" : "it is not valid JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: null, unreadable: "it does not hold a JSON object" };
  try {
    return { state: normalizeAutopilotState(value, now) };
  } catch {
    return { state: null, unreadable: "its content could not be interpreted" };
  }
}

/** An object made only of the numbers and the verdict of a round, as `JSON.stringify` indents it: one field to a line. */
const ROUND_OBJECT = /\{\n(?: +"(?:(?:director|readers|accepted|rejected)": -?\d+(?:\.\d+)?|verdict": "(?:approve|revise)"),?\n)+ *\}/g;

/**
 * The state file: JSON, indented, with every round of a chapter's history (four small numbers and a verdict) on one line, so that a book of thousands
 * of chapters does not spend the file on indentation. An engine that does not know the rounds reads the file all the same.
 */
export function serializeAutopilotState(state: AutopilotState): string {
  const text = JSON.stringify(state, null, 2);
  return `${text.includes("\"rounds\"") ? text.replace(ROUND_OBJECT, (round) => round.replace(/\n */g, " ")) : text}\n`;
}

export function parseActivityLog(raw: string | null | undefined): AutopilotActivity[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as { activities?: unknown };
    return asArray(parsed.activities)
      .filter((entry): entry is AutopilotActivity => Boolean(entry && typeof entry === "object" && typeof (entry as AutopilotActivity).id === "string"))
      .slice(-MAX_ACTIVITIES);
  } catch {
    return [];
  }
}

export function serializeActivityLog(activities: AutopilotActivity[]): string {
  return `${JSON.stringify({ schemaVersion: 1, activities: activities.slice(-MAX_ACTIVITIES) }, null, 2)}\n`;
}

/** A state saved as `running` by a runner that no longer exists is shown and resumed as paused. */
export function recoverInterruptedState(state: AutopilotState, message: string): AutopilotState {
  if (state.status !== "running") return state;
  return { ...state, status: "paused", runner: null, message };
}

export function autopilotProgress(state: AutopilotState | null): AutopilotProgress {
  const chapters = state?.plan?.chapters ?? [];
  const scenes = chapters.flatMap((chapter) => chapter.scenes);
  return {
    chapters: chapters.length,
    chaptersDone: chapters.filter((chapter) => chapter.status === "done").length,
    scenes: scenes.length,
    scenesWritten: scenes.filter((scene) => scene.status !== "planned").length,
    words: scenes.reduce((total, scene) => total + (scene.words ?? 0), 0),
  };
}

/** What only a live session knows, for the summary of a state: the pause that waits, the limits of the run, and the default of the host. */
export interface AutopilotSummaryContext {
  pausePending?: AutopilotPausePending | null;
  limits?: AutopilotLimitsSummary | null;
  /** Where the host publishes when the author has not chosen (see `hostDefaultPublish`). */
  defaultPublish?: AutopilotPublishMode;
  /** The retry the run is waiting for, when it is: the summary says it, and says nothing otherwise. */
  retry?: AutopilotRetryInfo | null;
  /** How many chapters have a change that waits for the author (`AutopilotStateSummary.frozenChanges`), when the session knows it. */
  frozenChanges?: number | null;
}

/** The last error as the summary says it: as the state has it, and with its kind and its detail also under the names `kind` and `detail`. */
function summarizeLastError(lastError: AutopilotState["lastError"]): AutopilotLastErrorSummary | null {
  if (!lastError || (!lastError.errorKind && !lastError.errorDetail)) return lastError;
  return { ...lastError, ...(lastError.errorKind ? { kind: lastError.errorKind } : {}), ...(lastError.errorDetail ? { detail: lastError.errorDetail } : {}) };
}

/**
 * The summary of a state, as the `state` events carry it. Made from the file alone it has no `pausePending` and no `limits`
 * (nothing there tells them); a live session adds them, `null` when nothing waits and no limit applies.
 */
export function summarizeAutopilotState(state: AutopilotState, context: AutopilotSummaryContext = {}): AutopilotStateSummary {
  return {
    status: state.status,
    phase: state.phase,
    message: state.message,
    progress: autopilotProgress(state),
    question: state.question,
    lastError: summarizeLastError(state.lastError),
    runner: state.runner,
    stats: state.stats,
    pendingNotes: state.interventions.filter((entry) => entry.scope === "next_step" && entry.status === "pending").length,
    constraints: state.constraints.length,
    updatedAt: state.updatedAt,
    ...(state.finalReview ? { finalReview: { ...state.finalReview, text: clipText(state.finalReview.text, FINAL_REVIEW_SUMMARY_CHARACTERS) } } : {}),
    ...(context.pausePending === undefined ? {} : { pausePending: context.pausePending }),
    ...(context.limits === undefined ? {} : { limits: context.limits }),
    publish: effectivePublish(state.options, context.defaultPublish),
    ...(context.retry ? { retry: context.retry } : {}),
    // Like `retry`, said only when something waits: a book with no change has the summary it always had.
    ...(typeof context.frozenChanges === "number" && context.frozenChanges > 0 ? { frozenChanges: context.frozenChanges } : {}),
  };
}

export function pendingNotes(state: AutopilotState): AuthorIntervention[] {
  return state.interventions.filter((entry) => entry.scope === "next_step" && entry.status === "pending");
}

export function wordsOf(text: string): number {
  return countWords(text);
}
