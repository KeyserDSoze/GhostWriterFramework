import { REVIEW_MAX_CAMPAIGN_ROUNDS, REVIEW_MAX_ROUNDS, serverSupportsReviewBook, serverSupportsReviewPolicy, type AutopilotOptions, type ReviewPolicy, type ReviewPolicyUpdate, type ServerInfo } from "narrarium-engine";

/**
 * The review policy of a run (`options.review`) and the caps of the book (`options.budgetLimit`, `options.budgetTokens`) as the configuration edits them: one form of
 * texts, read as the engine reads them (`normalizeReviewPolicy`, `normalizeOptions`), with what is left blank meaning the default (the director's score and rounds, the
 * readers in the first round only, no cap). Pure, but for the personal server's features.
 */

/** The release of the personal server that knows the review policy of a run and reviews a finished book again (`autopilot-review-policy`, `autopilot-review-book`). */
export const REVIEW_SERVER_VERSION = "0.1.19";

/** Whether the personal server takes the review policy of a run. An older one drops `options.review`, and the engine's client refuses to send it there. */
export function serverHasReviewPolicy(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverSupportsReviewPolicy(info);
}

/** Whether the personal server reviews a finished book again. An older one answers 404 to `POST …/autopilot/review`. */
export function serverHasReviewBook(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverSupportsReviewBook(info);
}

/** The target the configuration and the review offer: from 5 to 10, by halves (the engine takes any tenth from 1). */
export const TARGET_MIN = 5;
export const TARGET_MAX = 10;
export const TARGET_STEP = 0.5;
/** The guards of the caps: a typo stays a typo (the engine takes the same). */
export const MAX_MONEY_CAP = 1_000_000;
export const MAX_TOKEN_CAP = 1_000_000_000_000;

/** The fields of the form, as they were typed. Blank: the default (the director's, the first round only, no cap). */
export interface ReviewForm {
  target: string;
  rounds: string;
  readerRounds: string;
  campaignRounds: string;
  money: string;
  tokens: string;
}

export type ReviewField = keyof ReviewForm;
/** What is wrong with a field: not a number, out of its range, or a target that is not on a half point. */
export type ReviewProblem = "number" | "range" | "step";

export interface ReviewReading {
  /** The policy as the form says it: only what is not left to the default. */
  policy: ReviewPolicy;
  /** The money cap and the token cap: 0 for none. */
  budgetLimit: number;
  budgetTokens: number;
  problems: Partial<Record<ReviewField, ReviewProblem>>;
  valid: boolean;
}

const text = (value: number | undefined): string => (value === undefined || value === 0 ? "" : String(value));

/** The form of what the options say. */
export function reviewFormOf(options: Pick<AutopilotOptions, "review" | "budgetLimit" | "budgetTokens">): ReviewForm {
  const policy = options.review ?? {};
  return {
    target: text(policy.targetScore),
    rounds: text(policy.maxRounds),
    readerRounds: text(policy.readerRounds),
    campaignRounds: text(policy.campaignMaxRounds),
    money: text(options.budgetLimit),
    tokens: text(options.budgetTokens),
  };
}

/** A number as a person types it, with a decimal comma too; `null` for a blank field, `NaN` for one that is not a number. */
export function typedNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (!trimmed) return null;
  const normalized = /^\d{1,3}(\.\d{3})+,\d+$/.test(trimmed) ? trimmed.replace(/\./g, "").replace(",", ".") : trimmed.replace(",", ".");
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(normalized) ? Number(normalized) : Number.NaN;
}

/** What the form says, checked as the engine checks it: each value in its range, the target on a half point, the rounds whole. */
export function readReviewForm(form: ReviewForm): ReviewReading {
  const problems: ReviewReading["problems"] = {};
  const read = (field: ReviewField, min: number, max: number, whole: boolean): number | undefined => {
    const value = typedNumber(form[field]);
    if (value === null) return undefined;
    if (!Number.isFinite(value)) problems[field] = "number";
    else if (value < min || value > max) problems[field] = "range";
    else if (whole && !Number.isInteger(value)) problems[field] = "number";
    else return value;
    return undefined;
  };
  const target = read("target", TARGET_MIN, TARGET_MAX, false);
  if (target !== undefined && Math.abs(target / TARGET_STEP - Math.round(target / TARGET_STEP)) > 1e-9) problems.target = "step";
  const rounds = read("rounds", 1, REVIEW_MAX_ROUNDS, true);
  const readerRounds = read("readerRounds", 1, REVIEW_MAX_ROUNDS, true);
  const campaignRounds = typedNumber(form.campaignRounds) === 0 ? undefined : read("campaignRounds", 1, REVIEW_MAX_CAMPAIGN_ROUNDS, true);
  const money = read("money", 0, MAX_MONEY_CAP, false);
  const tokens = read("tokens", 0, MAX_TOKEN_CAP, true);
  const policy: ReviewPolicy = {
    ...(target !== undefined && !problems.target ? { targetScore: target } : {}),
    ...(rounds !== undefined ? { maxRounds: rounds } : {}),
    ...(readerRounds !== undefined ? { readerRounds } : {}),
    ...(campaignRounds !== undefined ? { campaignMaxRounds: campaignRounds } : {}),
  };
  return { policy, budgetLimit: money ?? 0, budgetTokens: tokens ?? 0, problems, valid: Object.keys(problems).length === 0 };
}

/** The change of the policy to send: every field, with `null` for the ones left to the default (so that a value the book had is taken back). */
export function policyUpdate(policy: ReviewPolicy): ReviewPolicyUpdate {
  return {
    targetScore: policy.targetScore ?? null,
    maxRounds: policy.maxRounds ?? null,
    readerRounds: policy.readerRounds ?? null,
    campaignMaxRounds: policy.campaignMaxRounds ?? null,
  };
}

/** Whether two policies say the same: nothing and an empty policy are the same. */
export function samePolicy(left: ReviewPolicy | undefined, right: ReviewPolicy | undefined): boolean {
  const keys: Array<keyof ReviewPolicy> = ["targetScore", "maxRounds", "readerRounds", "campaignMaxRounds"];
  return keys.every((key) => (left?.[key] ?? undefined) === (right?.[key] ?? undefined));
}
