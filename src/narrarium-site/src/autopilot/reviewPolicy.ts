import { REVIEW_MAX_CAMPAIGN_ROUNDS, REVIEW_MAX_ROUNDS, serverSupportsReviewBook, serverSupportsReviewBookRound, serverSupportsReviewPolicy, serverSupportsReviewTargets, type AutopilotOptions, type BookRoundMode, type ReviewPolicy, type ReviewPolicyUpdate, type ServerInfo } from "narrarium-engine";

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

/** The release of the personal server that knows the targets for the readers (`autopilot-review-targets`): the readers' average, each reader, the readers that do not count. */
export const REVIEW_TARGETS_SERVER_VERSION = "0.1.21";

/** Whether the personal server takes the targets for the readers. An older one drops them without a word, and the engine's client refuses to send them there. */
export function serverHasReviewTargets(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverSupportsReviewTargets(info);
}

/** The release of the personal server that knows the book-level round of a review (`autopilot-review-book-round`): the director's corrections of the whole book. */
export const REVIEW_BOOK_ROUND_SERVER_VERSION = "0.1.23";

/** Whether the personal server takes the book-level round. An older one drops it without a word, and the engine's client refuses to send it there. */
export function serverHasReviewBookRound(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverSupportsReviewBookRound(info);
}

/** Whether the personal server reviews a finished book again. An older one answers 404 to `POST …/autopilot/review`. */
export function serverHasReviewBook(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverSupportsReviewBook(info);
}

/** The id of the panel of the limit that stopped a run, on the page of the autopilot: a link from the dock brings it into view. */
export const LIMIT_PANEL_ID = "autopilot-limit";

/** The target the configuration and the review offer: from 5 to 10, by halves (the engine takes any tenth from 1). */
export const TARGET_MIN = 5;
export const TARGET_MAX = 10;
export const TARGET_STEP = 0.5;
/** The guards of the caps: a typo stays a typo (the engine takes the same). */
export const MAX_MONEY_CAP = 1_000_000;
export const MAX_TOKEN_CAP = 1_000_000_000_000;

/** The votes the readers' targets take: from 1 to 10, to a tenth (the engine takes the same). */
export const READER_TARGET_MIN = 1;
export const READER_TARGET_MAX = 10;

/** The fields of the form, as they were typed. Blank: the default (the director's, the first round only, no cap). */
export interface ReviewForm {
  target: string;
  rounds: string;
  readerRounds: string;
  campaignRounds: string;
  money: string;
  tokens: string;
  /** The targets for the readers, typed: their average (blank: none), the vote each reader must reach by its slug (blank or absent: none), and the readers that do not count. */
  readersTarget?: string;
  readerTargets?: Readonly<Record<string, string>>;
  readersExcluded?: readonly string[];
  /** What the review does when every chapter has its targets and the book does not (absent: `off`). */
  bookRound?: BookRoundMode;
}

/** The fields that are one text each. */
export type ReviewField = "target" | "rounds" | "readerRounds" | "campaignRounds" | "money" | "tokens" | "readersTarget";
/** What is wrong with a field: not a number, out of its range, a target that is not on a half point, or a vote with more than one decimal. */
export type ReviewProblem = "number" | "range" | "step" | "tenth";

export interface ReviewReading {
  /** The policy as the form says it: only what is not left to the default. */
  policy: ReviewPolicy;
  /** The money cap and the token cap: 0 for none. */
  budgetLimit: number;
  budgetTokens: number;
  problems: Partial<Record<ReviewField, ReviewProblem>>;
  /** What is wrong with the target of a reader, by its slug. */
  readerProblems: Record<string, ReviewProblem>;
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
    readersTarget: text(policy.readersTarget),
    readerTargets: Object.fromEntries(Object.entries(policy.readerTargets ?? {}).map(([slug, vote]) => [slug, String(vote)])),
    readersExcluded: [...(policy.readersExcluded ?? [])],
    bookRound: policy.bookRound ?? "off",
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
    const value = typedNumber(form[field] ?? "");
    if (value === null) return undefined;
    if (!Number.isFinite(value)) problems[field] = "number";
    else if (value < min || value > max) problems[field] = "range";
    else if (whole && !Number.isInteger(value)) problems[field] = "number";
    else return value;
    return undefined;
  };
  // A vote for the readers: from 1 to 10 and to a tenth.
  const voteProblem = (vote: number): ReviewProblem | null => (!Number.isFinite(vote) ? "number" : vote < READER_TARGET_MIN || vote > READER_TARGET_MAX ? "range" : Math.abs(vote * 10 - Math.round(vote * 10)) > 1e-9 ? "tenth" : null);
  const readVote = (field: ReviewField): number | undefined => {
    const vote = typedNumber(form[field] ?? "");
    if (vote === null) return undefined;
    const problem = voteProblem(vote);
    if (problem) {
      problems[field] = problem;
      return undefined;
    }
    return vote;
  };
  const target = read("target", TARGET_MIN, TARGET_MAX, false);
  if (target !== undefined && Math.abs(target / TARGET_STEP - Math.round(target / TARGET_STEP)) > 1e-9) problems.target = "step";
  const rounds = read("rounds", 1, REVIEW_MAX_ROUNDS, true);
  const readerRounds = read("readerRounds", 1, REVIEW_MAX_ROUNDS, true);
  const campaignRounds = typedNumber(form.campaignRounds) === 0 ? undefined : read("campaignRounds", 1, REVIEW_MAX_CAMPAIGN_ROUNDS, true);
  const money = read("money", 0, MAX_MONEY_CAP, false);
  const tokens = read("tokens", 0, MAX_TOKEN_CAP, true);
  const readersTarget = readVote("readersTarget");
  // The target of each reader: a vote from 1 to 10, to a tenth; a blank one is none.
  const readerProblems: ReviewReading["readerProblems"] = {};
  const readerTargets: Record<string, number> = {};
  for (const [slug, raw] of Object.entries(form.readerTargets ?? {})) {
    const vote = typedNumber(raw);
    if (vote === null) continue;
    const problem = voteProblem(vote);
    if (problem) readerProblems[slug] = problem;
    else readerTargets[slug] = vote;
  }
  const excluded = [...new Set(form.readersExcluded ?? [])];
  const policy: ReviewPolicy = {
    ...(target !== undefined && !problems.target ? { targetScore: target } : {}),
    ...(rounds !== undefined ? { maxRounds: rounds } : {}),
    ...(readerRounds !== undefined ? { readerRounds } : {}),
    ...(campaignRounds !== undefined ? { campaignMaxRounds: campaignRounds } : {}),
    ...(readersTarget !== undefined ? { readersTarget } : {}),
    ...(Object.keys(readerTargets).length ? { readerTargets } : {}),
    ...(excluded.length ? { readersExcluded: excluded } : {}),
    ...(form.bookRound === "apply" || form.bookRound === "ask" ? { bookRound: form.bookRound } : {}),
  };
  return { policy, budgetLimit: money ?? 0, budgetTokens: tokens ?? 0, problems, readerProblems, valid: Object.keys(problems).length === 0 && Object.keys(readerProblems).length === 0 };
}

/**
 * The change of the policy to send: every field of the director's policy, with `null` for the ones left to the default (so that a value the book had is taken back); the targets
 * for the readers only when there is one, or the book had one to take back (a server that predates them is never sent a field it has nothing of).
 */
export function policyUpdate(policy: ReviewPolicy, previous?: ReviewPolicy): ReviewPolicyUpdate {
  const had = (key: "readersTarget" | "readerTargets" | "readersExcluded") => previous?.[key] !== undefined;
  return {
    targetScore: policy.targetScore ?? null,
    maxRounds: policy.maxRounds ?? null,
    readerRounds: policy.readerRounds ?? null,
    campaignMaxRounds: policy.campaignMaxRounds ?? null,
    ...(policy.readersTarget !== undefined || had("readersTarget") ? { readersTarget: policy.readersTarget ?? null } : {}),
    ...(policy.readerTargets || had("readerTargets") ? { readerTargets: policy.readerTargets ?? null } : {}),
    ...(policy.readersExcluded || had("readersExcluded") ? { readersExcluded: policy.readersExcluded ?? null } : {}),
    // The book-level round only when there is one, or the book had one to take back (a server that predates it is never sent a field it has nothing of).
    ...(policy.bookRound !== undefined || previous?.bookRound !== undefined ? { bookRound: policy.bookRound ?? null } : {}),
  };
}

/** The policy without the book-level round: what a server that predates it is sent (and what it is compared with). */
export function policyWithoutBookRound(policy: ReviewPolicy | undefined): ReviewPolicy | undefined {
  if (!policy) return policy;
  const { bookRound: _mode, ...rest } = policy;
  return rest;
}

/** The policy without the targets for the readers: what a server that predates them is sent (and what it is compared with). */
export function policyWithoutReaderTargets(policy: ReviewPolicy | undefined): ReviewPolicy | undefined {
  if (!policy) return policy;
  const { readersTarget: _target, readerTargets: _each, readersExcluded: _left, ...rest } = policy;
  return rest;
}

/** Whether a policy gives a value to one of the targets for the readers. */
export function hasReaderTargets(policy: ReviewPolicy | undefined): boolean {
  return policy?.readersTarget !== undefined || Object.keys(policy?.readerTargets ?? {}).length > 0 || (policy?.readersExcluded?.length ?? 0) > 0;
}

/** Whether two policies say the same: nothing and an empty policy are the same. */
export function samePolicy(left: ReviewPolicy | undefined, right: ReviewPolicy | undefined): boolean {
  const keys: Array<"targetScore" | "maxRounds" | "readerRounds" | "campaignMaxRounds" | "readersTarget"> = ["targetScore", "maxRounds", "readerRounds", "campaignMaxRounds", "readersTarget"];
  const targets = (policy: ReviewPolicy | undefined) => JSON.stringify(Object.entries(policy?.readerTargets ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const excluded = (policy: ReviewPolicy | undefined) => JSON.stringify([...(policy?.readersExcluded ?? [])].sort());
  return keys.every((key) => (left?.[key] ?? undefined) === (right?.[key] ?? undefined)) && targets(left) === targets(right) && excluded(left) === excluded(right) && (left?.bookRound ?? undefined) === (right?.bookRound ?? undefined);
}
