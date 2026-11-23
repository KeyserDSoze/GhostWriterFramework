import { serverSupportsAutopilotRetry, type AutopilotErrorDetail, type AutopilotErrorKind, type AutopilotEvent, type AutopilotLongRetry, type AutopilotStateSummary, type ServerInfo } from "narrarium-engine";
import i18n from "@/i18n";

export { waitWords } from "@/autopilot/format";

/**
 * «Retry now» and «Retry later» as the pages read them: the wait a run is in, when the next attempt is (in the time zone of the author), the failures
 * that a wait may cure, and the numbers the author types for «Retry later». Pure, but for the error a command throws for a server without them.
 */

/** The release of the personal server that has «Retry later» and «Retry now»: `longRetry` among the options, and `POST …/autopilot/retry-now`. */
export const RETRY_SERVER_VERSION = "0.1.10";

/** What «Use recommended values» puts back: every 10 minutes, at most 6 times. */
export const RECOMMENDED_LONG_RETRY: AutopilotLongRetry = { everyMinutes: 10, cycles: 6 };

/** Whether the personal server announces «Retry later» and «Retry now» (`autopilot-retry`). An older one answers 404 to the route and refuses `longRetry`. */
export function serverHasRetry(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverSupportsAutopilotRetry(info);
}

/** The personal server that runs the book predates «Retry later» and «Retry now»: nothing is sent to it, and the author is told to update it. */
export class AutopilotRetryUnsupportedError extends Error {
  constructor() {
    super(i18n.t("autopilot.retry.oldServer", { version: RETRY_SERVER_VERSION }));
    this.name = "AutopilotRetryUnsupportedError";
  }
}

/** The wait before the next attempt of a failed step: a quick retry, or a restart of «Retry later» (`long`) with its cycle and how many (`null`: no limit). */
export interface RetryWait {
  long: boolean;
  /** ISO time of the next attempt. */
  at: string;
  /** The quick retry about to happen, or, in a long wait, the last one made; and how many there are. */
  attempt: number;
  retries: number;
  cycle: number | null;
  cycles: number | null;
}

/** The wait the run is in, or `null`: a wait is only a wait while the run runs (a summary that a pause left behind says nothing). */
export function retryWaitOf(summary: Pick<AutopilotStateSummary, "status" | "retry"> | null | undefined): RetryWait | null {
  const retry = summary?.status === "running" ? summary.retry : undefined;
  if (!retry) return null;
  const { at, attempt, retries, longTerm } = retry;
  return longTerm ? { long: true, at, attempt, retries, cycle: longTerm.cycle, cycles: longTerm.cycles ?? null } : { long: false, at, attempt, retries, cycle: null, cycles: null };
}

export interface NotBefore {
  /** The day of the next attempt where the author is: today, tomorrow, or a later one (said with its date in words). */
  day: "today" | "tomorrow" | "later";
  /** The time, as the language writes it. */
  time: string;
  /** The day in words: "Tuesday, November 24", «martedì 24 novembre». */
  date: string;
}

/** The calendar day of a moment in a time zone, as a number of days, so that two of them can be told apart by one. */
function dayNumber(date: Date, timeZone?: string): number {
  const [year, month, day] = formatter("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }, timeZone).format(date).split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/** The dates of the language of the app in the author's time zone (the browser's, or `timeZone`); a language the browser does not know reads as English. */
function formatter(language: string, style: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  const options = timeZone ? { ...style, timeZone } : style;
  try {
    return new Intl.DateTimeFormat(language || "en", options);
  } catch {
    return new Intl.DateTimeFormat("en", options);
  }
}

/** When the next attempt is, in the time zone of the author (the browser's, or `timeZone`), in the language of the app; `null` for what is not a date. */
export function notBefore(at: string, language: string, { now = new Date(), timeZone }: { now?: Date; timeZone?: string } = {}): NotBefore | null {
  const target = new Date(at);
  if (Number.isNaN(target.getTime())) return null;
  const days = dayNumber(target, timeZone) - dayNumber(now, timeZone);
  return {
    day: days <= 0 ? "today" : days === 1 ? "tomorrow" : "later",
    time: formatter(language, { timeStyle: "short" }, timeZone).format(target),
    date: formatter(language, { weekday: "long", day: "numeric", month: "long" }, timeZone).format(target),
  };
}

/** "not before 2:35 PM", "not before tomorrow at 9:00 AM", «non prima di martedì 24 novembre alle 14:35». */
export function notBeforeText(t: (key: string, options?: Record<string, unknown>) => string, at: string, language: string, now?: Date): string | null {
  const when = notBefore(at, language, { now });
  if (!when) return null;
  return t("autopilot.retry.notBefore", { ...(when.day === "today" ? {} : { context: when.day }), time: when.time, date: when.date });
}

/** Which restart of how many, in words: «ripartenza 2 di 3», "restart 2 (unlimited)". */
export function restartText(t: (key: string, options?: Record<string, unknown>) => string, wait: Pick<RetryWait, "cycle" | "cycles">): string {
  return wait.cycles === null ? t("autopilot.retry.restart", { context: "unlimited", cycle: wait.cycle }) : t("autopilot.retry.restart", { cycle: wait.cycle, cycles: wait.cycles });
}

/** The wait in one line: «In attesa di riprovare · tentativo 2 di 3», "Waiting to retry · restart 2 of 3 · not before 2:35 PM". */
export function waitLineText(t: (key: string, options?: Record<string, unknown>) => string, wait: RetryWait, language: string, now?: Date): string {
  if (!wait.long) return [t("autopilot.retry.waiting"), t("autopilot.retry.quick", { attempt: wait.attempt, retries: wait.retries })].join(" · ");
  const when = notBeforeText(t, wait.at, language, now);
  return [t("autopilot.retry.waiting"), restartText(t, wait), ...(when ? [when] : [])].join(" · ");
}

/** How «Retry later» ended a run, as this browser heard it: its restarts used up (with how many, when the notice said it), or turned off while it waited. */
export interface RetryEnd {
  code: "longRetryExhausted" | "longRetryOff";
  count: number | null;
}

const isRetryEnd = (code: unknown): code is RetryEnd["code"] => code === "longRetryExhausted" || code === "longRetryOff";

/**
 * How the last run of a book ended, when «Retry later» ended it: the code of its `run-ended` event, which comes no earlier than the error it stopped
 * with (`since`, a little before it for the clocks of two machines), with how many restarts the notice before it told. When the feed does not say (a page
 * opened after the run, another device, or only the end of an earlier run) it is the code the state keeps of the error (`summary.lastError.code`), without
 * a count: the engine writes it there for this. `null` for a run that ended another way, and for a code this version does not know.
 */
export function retryEndOf(events: readonly AutopilotEvent[], since: string | null, stateCode?: string | null): RetryEnd | null {
  const from = Date.parse(since ?? "") - 5000;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "run-ended") continue;
    if (Number.isFinite(from) && Date.parse(event.at) < from) break;
    if (!isRetryEnd(event.code)) return null;
    if (event.code === "longRetryOff") return { code: event.code, count: null };
    const notice = events.slice(0, index).reverse().find((entry) => entry.type === "insight" && entry.code === "longRetryExhausted");
    const cycle = notice?.type === "insight" ? notice.cycle : undefined;
    return { code: event.code, count: typeof cycle === "number" ? cycle : null };
  }
  return isRetryEnd(stateCode) ? { code: stateCode, count: null } : null;
}

/** The kinds of failure that pass with time: an endpoint that cannot be reached, a limit of requests, an answer that is too slow. */
const PASSING: ReadonlySet<AutopilotErrorKind> = new Set(["network", "rate_limit", "timeout"]);

/**
 * Whether «Retry later» covers a failure: the transient failures of the provider the engine waits for (the network, a timeout, a rate limit, an overload
 * or a failure of its server: 408, 429, 5xx). A provider error that says no status is not guessed; a key, a reply that was discarded or cut, the
 * configuration, the budget or a file of the book never pass with time.
 */
export function mayPassWithTime(kind: AutopilotErrorKind, detail: Pick<AutopilotErrorDetail, "status"> = {}): boolean {
  if (PASSING.has(kind)) return true;
  if (kind !== "provider" || typeof detail.status !== "number") return false;
  return detail.status === 408 || detail.status === 429 || (detail.status >= 500 && detail.status <= 599);
}

export type WholeProblem = "empty" | "whole" | "min" | "max";
/** A whole number typed by the author, read only when it is one and in range: nothing is rounded or cut to fit, and an empty field is no number. */
export function readWhole(text: string, min: number, max: number): { value: number; problem: null } | { value: null; problem: WholeProblem } {
  const trimmed = text.trim();
  if (!trimmed) return { value: null, problem: "empty" };
  if (!/^\d+$/.test(trimmed)) return { value: null, problem: "whole" };
  const value = Number(trimmed);
  if (value < min) return { value: null, problem: "min" };
  if (value > max) return { value: null, problem: "max" };
  return { value, problem: null };
}
