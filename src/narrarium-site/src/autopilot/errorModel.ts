import { AUTOPILOT_ERROR_KINDS, redactSecrets, type AutopilotActivity, type AutopilotErrorDetail, type AutopilotErrorKind, type AutopilotRetryInfo, type AutopilotStateSummary, type AutopilotTaskKind } from "narrarium-engine";
import { filesInError } from "@/autopilot/stopReason";

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

/** The step the error of a run came from: the newest one that failed (of the kind the error says, when it says), if it ended around the time the run did. */
function stepOfError(activities: readonly AutopilotActivity[], at: string | undefined, task: AutopilotTaskKind | undefined): { step: AutopilotActivity | null; repeats: number } {
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
    const { step, repeats } = stepOfError(activities, error.at, error.task);
    return { kind: errorKindOf(told, error.message), classified: isKind(told), detail: error.detail ?? error.errorDetail ?? {}, message: error.message ?? "", at: error.at ?? null, task: error.task, ended: true, retry: null, repeats, step };
  }
  if (summary.status === "running" && summary.retry) {
    const { step, repeats } = stepOfRetry(activities);
    return { kind: errorKindOf(step?.errorKind, step?.error), classified: isKind(step?.errorKind), detail: step?.errorDetail ?? {}, message: step?.error ?? "", at: step?.endedAt ?? null, task: step?.task, ended: false, retry: summary.retry, repeats, step };
  }
  return null;
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

/** "12 s", and "1 min 05 s" from a minute on (the runner never waits longer than five). */
export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, "0")} s`;
}
