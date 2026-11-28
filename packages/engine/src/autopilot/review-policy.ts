import type { DirectorProfile } from "../profiles/director.js";
import { WILDCARD_DEFAULT_VOICES, WILDCARD_MAX_VOICES } from "../profiles/wildcards.js";
import { clampNumber, numericValue } from "../profiles/read.js";
import { PLATEAU_BREAKS_MAX, REVIEW_MAX_CAMPAIGN_ROUNDS, REVIEW_MAX_READER_ENTRIES, REVIEW_MAX_ROUNDS, type AutopilotState, type BookRoundMode, type ReviewPolicy, type WildcardsPolicy } from "./types.js";

/**
 * How the chapters and the book are reviewed (`ReviewPolicy`): the vote they must reach, the rounds of review of a chapter, the rounds the simulated readers
 * read in, the rounds a review of the book makes before it waits for the author. The director's profile gives the defaults (its approval score, its rounds);
 * the run's options (`options.review`) say otherwise for a run, and a review of the book launched later (`state.campaign.review`) for itself. One place says
 * which wins, for the planner and the tasks alike. Pure.
 */

/** A reader as the policy names it: its slug, a short text without control characters; anything else is no reader. */
function readerSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const slug = value.trim();
  return slug && slug.length <= 120 && !/[\u0000-\u001f\u007f]/.test(slug) ? slug : undefined;
}

/**
 * The target of each reader as the options keep it (the slugs that are readers, each vote from 1 to 10 to a tenth, at most `REVIEW_MAX_READER_ENTRIES`): a vote that is not a
 * number leaves the reader without a target. Given whole, it replaces what there was; a value that is not a mapping leaves what there was.
 */
function readerTargetsOf(value: unknown, base: ReviewPolicy["readerTargets"]): ReviewPolicy["readerTargets"] {
  if (value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const targets: Record<string, number> = {};
  for (const [name, vote] of Object.entries(value as Record<string, unknown>)) {
    const slug = readerSlug(name);
    const read = numericValue(vote);
    if (slug && read !== undefined && Object.keys(targets).length < REVIEW_MAX_READER_ENTRIES) targets[slug] = clampNumber(read, 1, 10, 1);
  }
  return Object.keys(targets).length ? targets : undefined;
}

/** The readers that do not count as the options keep them (each once, at most `REVIEW_MAX_READER_ENTRIES`); a value that is not a list leaves what there was. */
function readersExcludedOf(value: unknown, base: ReviewPolicy["readersExcluded"]): ReviewPolicy["readersExcluded"] {
  if (value === null) return undefined;
  if (!Array.isArray(value)) return base;
  const slugs = [...new Set(value.map(readerSlug).filter((slug): slug is string => slug !== undefined))].slice(0, REVIEW_MAX_READER_ENTRIES);
  return slugs.length ? slugs : undefined;
}

/**
 * The book-level round as the policy keeps it: `apply` or `ask`; `off` and `null` take it back (the policy keeps none), and a value that is not a mode leaves what there was.
 * Read softly, as the rest of the policy.
 */
function bookRoundOf(value: unknown, base: ReviewPolicy["bookRound"]): Exclude<BookRoundMode, "off"> | undefined {
  if (value === null || value === "off") return undefined;
  if (value === "apply" || value === "ask") return value;
  return base === "apply" || base === "ask" ? base : undefined;
}

/**
 * The room of the wildcards as the policy keeps it (`WildcardsPolicy`): given whole, it replaces what there was; `null` takes it back; a value that is not a mapping leaves
 * what there was. Each number in its range, a switch only when it is on; nothing usable is no room.
 */
function wildcardsOf(value: unknown, base: ReviewPolicy["wildcards"]): WildcardsPolicy | undefined {
  if (value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const source = value as Record<string, unknown>;
  const policy: WildcardsPolicy = {};
  if (source.design === true) policy.design = true;
  if (source.plateau === true) policy.plateau = true;
  const voices = numericValue(source.voices);
  if (voices !== undefined) policy.voices = clampNumber(voices, 1, WILDCARD_MAX_VOICES, 0);
  const rounds = numericValue(source.rounds);
  if (rounds !== undefined) policy.rounds = clampNumber(rounds, 1, PLATEAU_BREAKS_MAX, 0);
  const moneyCap = numericValue(source.moneyCap);
  if (moneyCap !== undefined && moneyCap > 0) policy.moneyCap = clampNumber(moneyCap, 0, 1_000_000, 4);
  return Object.keys(policy).length ? policy : undefined;
}

/** The room of the wildcards of a run as the planner and the tasks read it: off unless the policy turns it on, 4 voices, 1 consultation at a plateau, no cap of its own. */
export function reviewWildcards(state: Pick<AutopilotState, "options">): { design: boolean; plateau: boolean; voices: number; rounds: number; moneyCap: number } {
  const policy = state.options.review?.wildcards;
  return { design: policy?.design === true, plateau: policy?.plateau === true, voices: policy?.voices ?? WILDCARD_DEFAULT_VOICES, rounds: policy?.rounds ?? 1, moneyCap: policy?.moneyCap ?? 0 };
}

/**
 * The policy as the options keep it: each value in its range, a value that is not a number left out; `null` (or nothing usable) is no policy. The targets of the readers
 * are read softly, as the rest: a vote out of range is brought into it, a reader or a vote that cannot be read is left out, and nothing makes the whole policy fail.
 */
export function normalizeReviewPolicy(value: unknown, base?: ReviewPolicy): ReviewPolicy | undefined {
  if (value === null) return undefined;
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const pick = (key: "targetScore" | "maxRounds" | "readerRounds" | "campaignMaxRounds" | "readersTarget", min: number, max: number, decimals: number): number | undefined => {
    if (source[key] === null) return undefined;
    const read = numericValue(source[key]);
    if (read !== undefined) return clampNumber(read, min, max, decimals);
    return base?.[key];
  };
  const policy: ReviewPolicy = {};
  const targetScore = pick("targetScore", 1, 10, 1);
  const maxRounds = pick("maxRounds", 1, REVIEW_MAX_ROUNDS, 0);
  const readerRounds = pick("readerRounds", 1, REVIEW_MAX_ROUNDS, 0);
  const campaignMaxRounds = pick("campaignMaxRounds", 0, REVIEW_MAX_CAMPAIGN_ROUNDS, 0);
  const readersTarget = pick("readersTarget", 1, 10, 1);
  const readerTargets = readerTargetsOf(source.readerTargets, base?.readerTargets);
  const readersExcluded = readersExcludedOf(source.readersExcluded, base?.readersExcluded);
  const bookRound = bookRoundOf(source.bookRound, base?.bookRound);
  const wildcards = wildcardsOf(source.wildcards, base?.wildcards);
  if (targetScore !== undefined) policy.targetScore = targetScore;
  if (maxRounds !== undefined) policy.maxRounds = maxRounds;
  if (readerRounds !== undefined) policy.readerRounds = readerRounds;
  if (campaignMaxRounds) policy.campaignMaxRounds = campaignMaxRounds;
  if (readersTarget !== undefined) policy.readersTarget = readersTarget;
  if (readerTargets) policy.readerTargets = readerTargets;
  if (readersExcluded) policy.readersExcluded = readersExcluded;
  if (bookRound) policy.bookRound = bookRound;
  if (wildcards) policy.wildcards = wildcards;
  return Object.keys(policy).length ? policy : undefined;
}

/** The readers' targets of a policy, as a review reads them. */
export interface ReaderTargets {
  /** The vote the average of the readers that count must reach. */
  average?: number;
  /** The vote each reader must reach, by slug. */
  each: Readonly<Record<string, number>>;
  /** The readers that do not count. */
  excluded: ReadonlySet<string>;
}

/** The targets for the readers a policy (or a review of the book) names; `undefined` when it names none. Pure. */
export function readerTargetsFrom(policy: Pick<ReviewPolicy, "readersTarget" | "readerTargets" | "readersExcluded"> | undefined, fallback?: Pick<ReviewPolicy, "readersTarget" | "readerTargets" | "readersExcluded">): ReaderTargets | undefined {
  const average = policy?.readersTarget ?? fallback?.readersTarget;
  const each = policy?.readerTargets ?? fallback?.readerTargets ?? {};
  const excluded = policy?.readersExcluded ?? fallback?.readersExcluded ?? [];
  if (average === undefined && !Object.keys(each).length && !excluded.length) return undefined;
  return { ...(average !== undefined ? { average } : {}), each, excluded: new Set(excluded) };
}

/** Whether the targets ask something of the readers (a vote for their average, or for one of them): leaving some out asks nothing, it only changes the average. */
export function readersGated(targets: ReaderTargets | undefined): targets is ReaderTargets {
  return Boolean(targets && (targets.average !== undefined || Object.keys(targets.each).length > 0));
}

type PolicyState = Pick<AutopilotState, "options"> & Partial<Pick<AutopilotState, "campaign">>;

/** The review of the book in progress, when there is one: its policy wins over the run's. */
function reviewInProgress(state: PolicyState) {
  return state.campaign?.reason === "review-target" ? state.campaign.review : undefined;
}

/** The vote a chapter and the book must reach: the review of the book in progress, else the run's policy, else the director's approval score. */
export function reviewTarget(state: PolicyState, director: Pick<DirectorProfile, "approvalScore">): number {
  return reviewInProgress(state)?.targetScore ?? state.options.review?.targetScore ?? director.approvalScore;
}

/** The rounds of review of a chapter before it is closed anyway: the review of the book in progress, else the run's policy, else the director's. */
export function reviewMaxRounds(state: PolicyState, director: Pick<DirectorProfile, "maxReviewRounds">): number {
  return reviewInProgress(state)?.maxRounds ?? state.options.review?.maxRounds ?? director.maxReviewRounds;
}

/**
 * In how many of the first rounds of a chapter's review the simulated readers read it (when they read at all, `options.readers`): the review of the book in
 * progress (0: they do not read again), else the run's policy, else 1 (the first round only, as it always was).
 */
export function reviewReaderRounds(state: PolicyState): number {
  return reviewInProgress(state)?.readerRounds ?? state.options.review?.readerRounds ?? 1;
}

/**
 * What the review does when every chapter has its targets and the book does not: the review of the book in progress's own (it may say `off` for itself), else the run's policy,
 * else `off`, the review that ends there as it always did.
 */
export function reviewBookRound(state: PolicyState): BookRoundMode {
  return reviewInProgress(state)?.bookRound ?? state.options.review?.bookRound ?? "off";
}

/** The readers' targets in force: the review of the book in progress's, else the run's; `undefined` when neither names any. */
export function reviewReaderTargets(state: PolicyState): ReaderTargets | undefined {
  return readerTargetsFrom(reviewInProgress(state), state.options.review);
}

/**
 * The targets the readers must meet in a review: `own` (what the review itself names, when it is a review of the book) over the run's policy, when they ask something
 * (`readersGated`), the readers read in this run (`options.readers`) and one of those that read counts (`active` are the readers that read, by slug; absent: the host does
 * not say, and any does). `undefined` otherwise: a review without it is the one the engine always made.
 */
export function gateFor(options: Pick<AutopilotState["options"], "readers" | "review">, own: Pick<ReviewPolicy, "readersTarget" | "readerTargets" | "readersExcluded"> | undefined, active?: readonly string[]): ReaderTargets | undefined {
  if (!options.readers) return undefined;
  const targets = readerTargetsFrom(own, options.review);
  if (!readersGated(targets)) return undefined;
  if (active && !active.some((slug) => !targets.excluded.has(slug))) return undefined;
  return targets;
}

/** The targets the readers must meet in the review that goes on (see `gateFor`): the review of the book in progress's own over the run's. */
export function readerGate(state: PolicyState, active?: readonly string[]): ReaderTargets | undefined {
  return gateFor(state.options, reviewInProgress(state), active);
}
