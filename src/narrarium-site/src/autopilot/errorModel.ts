import { AUTOPILOT_ERROR_KINDS, redactSecrets, type AutopilotActivity, type AutopilotErrorDetail, type AutopilotErrorKind, type AutopilotRetryInfo, type AutopilotStateSummary, type AutopilotTaskKind } from "narrarium-engine";
import { filesInError } from "@/autopilot/stopReason";

export { formatLimit } from "@/lib/formatLimit";

/**
 * What went wrong in a run, as the page tells it: the kind of failure the engine says (`errorKind`), where it happened (`errorDetail`), the failure that the
 * runner is going to try again (`summary.retry`), and, for a state that an older engine wrote, what can be read from the words of the message. Pure: the
 * components draw what is here.
 */

/** The kinds of failure the engine tells, in the order it lists them. */
export const ERROR_KINDS: readonly AutopilotErrorKind[] = AUTOPILOT_ERROR_KINDS;

/** Whether a value is one of the kinds this version knows: an engine newer than the site may say another, and it is not made into a key. */
export const isErrorKind = (value: unknown): value is AutopilotErrorKind => typeof value === "string" && (ERROR_KINDS as readonly string[]).includes(value);
const isKind = isErrorKind;

/**
 * The kind of a failure: the one the engine said. A state that an older engine wrote has none, and then the one thing that can be read from the words is the
 * refusal to rewrite a file whose front matter cannot be read (a problem with a file of the book); anything else is `unknown`.
 */
export function errorKindOf(kind: unknown, message?: string | null): AutopilotErrorKind {
  if (isKind(kind)) return kind;
  return filesInError(message).some((file) => file.frontmatter) ? "profile" : "unknown";
}

export interface FailureSource {
  kind: AutopilotErrorKind;
  /** The engine said the kind (false: it was read from the words, or there is none to read). */
  classified: boolean;
  detail: AutopilotErrorDetail;
  /** The words of the failure as the engine kept them (with no key in them). */
  message: string;
  at: string | null;
  task: AutopilotTaskKind | undefined;
  /** The run ended with it; false when the runner waits to try again. */
  ended: boolean;
  retry: AutopilotRetryInfo | null;
  /** How many attempts of the step failed in a row with the same words, this one included. */
  repeats: number;
  /** The step that failed, from the log. */
  step: AutopilotActivity | null;
}

type SummaryLike = Pick<AutopilotStateSummary, "status" | "lastError" | "retry">;

/** How far from the end of the run the step that failed ended: the step ends, and the run with it. */
const BEFORE_END_MS = 60_000;
const AFTER_END_MS = 5_000;

const sameStep = (left: AutopilotActivity, right: AutopilotActivity): boolean =>
  left.task === right.task && left.chapterNumber === right.chapterNumber && left.sceneNumber === right.sceneNumber && left.reader === right.reader;

/** The attempts that failed in a row with the same words, ending at `index`. */
function repeatsAt(activities: readonly AutopilotActivity[], index: number): number {
  const failed = activities[index];
  let count = 0;
  for (let position = index; position >= 0; position -= 1) {
    const attempt = activities[position];
    if (attempt.status !== "failed" || !sameStep(attempt, failed) || (attempt.error ?? "") !== (failed.error ?? "")) break;
    count += 1;
  }
  return count;
}

/**
 * The step the error of a run came from: the activity whose id the engine gives (`activityId`), when it does, and no step if the log does not have it (none is guessed from
 * the clock then); else, for a state that an older engine wrote, the newest step that failed (of the kind the error says, when it says), if it ended around the time the run did.
 */
function stepOfError(activities: readonly AutopilotActivity[], error: { at?: string; task?: AutopilotTaskKind; activityId?: unknown }): { step: AutopilotActivity | null; repeats: number } {
  const { at, task } = error;
  if (typeof error.activityId === "string" && error.activityId.trim()) {
    const found = activities.findIndex((attempt) => attempt.id === error.activityId);
    return found >= 0 ? { step: activities[found], repeats: repeatsAt(activities, found) } : { step: null, repeats: 1 };
  }
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const attempt = activities[index];
    if (attempt.status !== "failed" || (task && attempt.task !== task)) continue;
    const end = Date.parse(at ?? "");
    const ended = Date.parse(attempt.endedAt ?? attempt.startedAt);
    if (Number.isFinite(end) && Number.isFinite(ended) && (ended < end - BEFORE_END_MS || ended > end + AFTER_END_MS)) break;
    return { step: attempt, repeats: repeatsAt(activities, index) };
  }
  return { step: null, repeats: 1 };
}

/** The failure the runner waits to try again is the last step of the log: nothing has started since. */
function stepOfRetry(activities: readonly AutopilotActivity[]): { step: AutopilotActivity | null; repeats: number } {
  const index = activities.length - 1;
  if (index < 0 || activities[index].status !== "failed") return { step: null, repeats: 1 };
  return { step: activities[index], repeats: repeatsAt(activities, index) };
}

/**
 * What went wrong now, or `null` when nothing did: the last error of a run that ended with an error, or the failure that a run waits to try again (it is a retry only
 * while the run runs). `activities` is the log of the steps, oldest first, with the steps the page heard of that the log does not have yet.
 */
export function failureSource(summary: SummaryLike | null | undefined, activities: readonly AutopilotActivity[]): FailureSource | null {
  if (!summary) return null;
  if (summary.status === "error") {
    const error = summary.lastError;
    if (!error) return null;
    const told = error.kind ?? error.errorKind;
    const { step, repeats } = stepOfError(activities, error);
    return { kind: errorKindOf(told, error.message), classified: isKind(told), detail: error.detail ?? error.errorDetail ?? {}, message: error.message ?? "", at: error.at ?? null, task: error.task, ended: true, retry: null, repeats, step };
  }
  if (summary.status === "running" && summary.retry) {
    const { step, repeats } = stepOfRetry(activities);
    return { kind: errorKindOf(step?.errorKind, step?.error), classified: isKind(step?.errorKind), detail: step?.errorDetail ?? {}, message: step?.error ?? "", at: step?.endedAt ?? null, task: step?.task, ended: false, retry: summary.retry, repeats, step };
  }
  return null;
}

/** What the panel of an error offers to do about a kind of failure. */
export interface ErrorActions {
  /** The button that resumes the run: the main action, a second one (the configuration comes first), or not offered at all. */
  retry: "main" | "secondary" | "hidden";
  /** «Open AI Integrations». */
  integrations: boolean;
  /** «Open the AI Router», at the «Tools only» switch. */
  router: boolean;
  /** Which is the main action of the panel: resuming, the configuration, or settling a conflict with GitHub (the panel offers that one itself). */
  first: "retry" | "integrations" | "resolve";
}

/** The failures that come from the provider or from how it is set up: where a person can change the model, the key, the address or the limits. */
const IN_INTEGRATIONS: ReadonlySet<AutopilotErrorKind> = new Set(["network", "auth", "rate_limit", "timeout", "truncated", "refused", "budget", "limit", "provider", "config"]);
/** The failures that the integrations are the first thing to correct: retrying does nothing until they are. */
const CONFIGURATION_FIRST: ReadonlySet<AutopilotErrorKind> = new Set(["auth", "refused", "budget", "limit"]);

/**
 * What can be done about a failure. A configuration error is repeated by the same configuration, so the retry is not offered while the configuration still gives it
 * (`configurationBlocks`, which is assumed when it is not said); once it does not, retrying is the main action. A conflict with GitHub (`githubConflict`) is settled before the
 * run is resumed: resuming would only meet it again, so resuming comes second.
 */
export function errorActions(kind: AutopilotErrorKind, { configurationBlocks = true, githubConflict = false }: { configurationBlocks?: boolean; githubConflict?: boolean } = {}): ErrorActions {
  if (kind === "conflict" && githubConflict) return { retry: "secondary", integrations: false, router: false, first: "resolve" };
  if (kind === "config") return configurationBlocks ? { retry: "hidden", integrations: true, router: true, first: "integrations" } : { retry: "main", integrations: true, router: true, first: "retry" };
  const configurationFirst = CONFIGURATION_FIRST.has(kind);
  return { retry: configurationFirst ? "secondary" : "main", integrations: IN_INTEGRATIONS.has(kind), router: false, first: configurationFirst ? "integrations" : "retry" };
}

/**
 * The failures that a check of the connection can say something about: an endpoint that is off or cannot be reached (`network`), that refuses the key (`auth`), that does not answer in time
 * (`timeout`) or that fails (`provider`). The others (a limit, an answer that was cut, a file of the book, the configuration) are not about the connection, and a check would tell nothing.
 */
const CONNECTION_CHECK: ReadonlySet<AutopilotErrorKind> = new Set(["network", "auth", "timeout", "provider"]);

export const offersConnectionCheck = (kind: AutopilotErrorKind): boolean => CONNECTION_CHECK.has(kind);

export interface TimeoutNote {
  /** Which deadline ran out: the provider did not begin answering, it went silent while it answered, or the call took longer than any call may. */
  phase: "start" | "idle" | "total";
  /** How long the deadline was, in milliseconds, when the engine says it. */
  ms?: number;
}

const TIMEOUT_PHASES = ["start", "idle", "total"] as const;

/** The deadline that ran out, as the engine says it: the phase, and how long it was when that is said too. A length alone does not say which limit it was. */
export function timeoutOf(detail: AutopilotErrorDetail): TimeoutNote | null {
  const phase = TIMEOUT_PHASES.find((entry) => entry === detail.timeoutPhase);
  if (!phase) return null;
  const ms = detail.timeoutMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? { phase, ms } : { phase };
}

/** How many whole seconds the provider asked to wait (`Retry-After`), rounded up so that it never reads shorter than what was asked; `null` when it asked for nothing. */
export function retryAfterSeconds(detail: AutopilotErrorDetail): number | null {
  const ms = detail.retryAfterMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : null;
}

export type ErrorFact =
  | { key: "endpoint" | "model" | "provider" | "integration" | "status"; value: string }
  | { key: "attempt"; attempt: number; retries: number };

const clean = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Where it happened, as the engine says it, in the order a person looks for it. The integration is named by what the settings call it, and by its id when they do not know it. */
export function errorFacts(detail: AutopilotErrorDetail, integrationName?: (id: string) => string | undefined): ErrorFact[] {
  const facts: ErrorFact[] = [];
  const endpoint = clean(detail.endpoint);
  if (endpoint) facts.push({ key: "endpoint", value: endpoint });
  const model = clean(detail.model);
  if (model) facts.push({ key: "model", value: model });
  const provider = clean(detail.provider);
  if (provider) facts.push({ key: "provider", value: provider });
  const integration = clean(detail.integration);
  if (integration) facts.push({ key: "integration", value: integrationName?.(integration) ?? integration });
  if (typeof detail.status === "number" && Number.isFinite(detail.status)) facts.push({ key: "status", value: String(detail.status) });
  if (typeof detail.attempt === "number" && typeof detail.retries === "number") facts.push({ key: "attempt", attempt: detail.attempt, retries: detail.retries });
  return facts;
}

export interface DiagnosticsInput {
  source: FailureSource;
  appVersion: string;
  engineVersion: string;
  host: "browser" | "server";
  at: Date;
  /** What the settings call the integration, when they know it. */
  integrationName?: string;
}

const MESSAGE_CHARACTERS = 600;
/** A path that starts at the root of a disk (`/var/lib/…`, `C:\Users\…`) says where the files of a computer are: it is taken out. A path inside the book is not. */
const DISK_PATH = /(^|[\s"'(=])(\/(?:[\w.@~+-]+\/){2,}[\w.@~+-]+|[A-Za-z]:\\[^\s"']+)/g;

function scrub(text: string): string {
  const clear = redactSecrets(text).replace(DISK_PATH, "$1[path]").replace(/\s+/g, " ").trim();
  return clear.length > MESSAGE_CHARACTERS ? `${clear.slice(0, MESSAGE_CHARACTERS - 1).trimEnd()}…` : clear;
}

/**
 * What a person can copy to say what went wrong: short, in English whatever the language of the app (it is for whoever helps), with no key, no path of a disk, and no
 * text of a prompt or of the book: the category, where it happened, the words of the failure, the versions and the time.
 */
export function diagnosticsText({ source, appVersion, engineVersion, host, at, integrationName }: DiagnosticsInput): string {
  const { detail, step } = source;
  const lines = [
    "Narrarium autopilot diagnostics",
    `Time: ${at.toISOString()}`,
    `App: ${appVersion}`,
    `Engine: ${engineVersion}`,
    `Runs on: ${host}`,
    `Problem: ${source.kind}${source.classified ? "" : " (the engine did not say)"}`,
    `State: ${source.ended ? "the run stopped" : "the autopilot is waiting to try again"}`,
  ];
  const task = step?.task ?? source.task;
  if (task) lines.push(`Step: ${[task, step?.chapterNumber !== undefined ? `chapter ${step.chapterNumber}` : "", step?.sceneNumber !== undefined ? `scene ${step.sceneNumber}` : ""].filter(Boolean).join(", ")}`);
  if (source.repeats > 1) lines.push(`Failed in a row: ${source.repeats}`);
  if (typeof detail.status === "number") lines.push(`HTTP status: ${detail.status}`);
  if (clean(detail.endpoint)) lines.push(`Endpoint: ${clean(detail.endpoint)}`);
  if (clean(detail.model)) lines.push(`Model: ${clean(detail.model)}`);
  if (clean(detail.provider)) lines.push(`Provider: ${clean(detail.provider)}`);
  const integration = clean(detail.integration);
  if (integration) lines.push(`Integration: ${integrationName ? `${integrationName} (${integration})` : integration}`);
  if (typeof detail.attempt === "number" && typeof detail.retries === "number") lines.push(`Retry: ${detail.attempt} of ${detail.retries}`);
  if (source.retry) lines.push(`Next attempt: ${source.retry.at}`);
  if (source.message) lines.push(`Message: ${scrub(source.message)}`);
  return lines.join("\n");
}

/** How many whole seconds are left to a moment, rounded up so that it never says 0 before the moment has come; `null` for a moment that is not a date. */
export function secondsLeft(at: string, now: number): number | null {
  const target = Date.parse(at);
  return Number.isFinite(target) ? Math.max(0, Math.ceil((target - now) / 1000)) : null;
}

/** "12 s", "1 min 05 s" from a minute on, "2 h 05 min" from an hour on, and the days in the words of the language from a day on (a wait of «Retry later» can last a week). */
export function formatCountdown(seconds: number, language?: string): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total} s`;
  if (total < 3600) return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, "0")} s`;
  if (total < 86_400) return `${Math.floor(total / 3600)} h ${String(Math.floor((total % 3600) / 60)).padStart(2, "0")} min`;
  const days = new Intl.NumberFormat(language, { style: "unit", unit: "day", unitDisplay: "long" }).format(Math.floor(total / 86_400));
  return `${days} ${Math.floor((total % 86_400) / 3600)} h`;
}
