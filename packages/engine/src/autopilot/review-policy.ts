import type { DirectorProfile } from "../profiles/director.js";
import { clampNumber, numericValue } from "../profiles/read.js";
import { REVIEW_MAX_CAMPAIGN_ROUNDS, REVIEW_MAX_ROUNDS, type AutopilotState, type ReviewPolicy } from "./types.js";

/**
 * How the chapters and the book are reviewed (`ReviewPolicy`): the vote they must reach, the rounds of review of a chapter, the rounds the simulated readers
 * read in, the rounds a review of the book makes before it waits for the author. The director's profile gives the defaults (its approval score, its rounds);
 * the run's options (`options.review`) say otherwise for a run. One place says which wins, for the planner and the tasks alike. Pure.
 */

/** The policy as the options keep it: each value in its range, a value that is not a number left out; `null` (or nothing usable) is no policy. */
export function normalizeReviewPolicy(value: unknown, base?: ReviewPolicy): ReviewPolicy | undefined {
  if (value === null) return undefined;
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const pick = (key: keyof ReviewPolicy, min: number, max: number, decimals: number): number | undefined => {
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
  if (targetScore !== undefined) policy.targetScore = targetScore;
  if (maxRounds !== undefined) policy.maxRounds = maxRounds;
  if (readerRounds !== undefined) policy.readerRounds = readerRounds;
  if (campaignMaxRounds) policy.campaignMaxRounds = campaignMaxRounds;
  return Object.keys(policy).length ? policy : undefined;
}

type PolicyState = Pick<AutopilotState, "options">;

/** The vote a chapter and the book must reach: the run's policy, else the director's approval score. */
export function reviewTarget(state: PolicyState, director: Pick<DirectorProfile, "approvalScore">): number {
  return state.options.review?.targetScore ?? director.approvalScore;
}

/** The rounds of review of a chapter before it is closed anyway: the run's policy, else the director's. */
export function reviewMaxRounds(state: PolicyState, director: Pick<DirectorProfile, "maxReviewRounds">): number {
  return state.options.review?.maxRounds ?? director.maxReviewRounds;
}

/** In how many of the first rounds of a chapter's review the simulated readers read it (when they read at all, `options.readers`): the run's policy, else 1 (the first round only, as it always was). */
export function reviewReaderRounds(state: PolicyState): number {
  return state.options.review?.readerRounds ?? 1;
}
