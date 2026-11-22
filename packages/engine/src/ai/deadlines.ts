import { abortError } from "../util/abort.js";
import { DEFAULT_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS, type AiIntegrationConfig } from "./config.js";
import type { AiTimeoutPhase } from "./types.js";

/** How long the provider has to begin answering (the connection and the headers) when nobody says, for every host. An integration's own timeout wins. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
/** The shortest time a provider is given to begin answering: a smaller value is raised to it when a call is made, and the call says so. */
export const MIN_REQUEST_TIMEOUT_MS = 30_000;
/** The most one attempt may take, whatever the provider keeps sending: four hours. It is not configurable. */
export const TOTAL_REQUEST_CAP_MS = 4 * 60 * 60 * 1000;

/** The deadlines one attempt runs under, already limited by the routing time that is left. */
export interface AttemptDeadlines {
  /** How long the provider has to begin answering: the connection and the headers. */
  startMs: number;
  /** The longest silence between two pieces of a streamed reply. */
  idleMs: number;
  /** The most the attempt may take, whatever the provider keeps sending. */
  capMs: number;
}

/** The deadlines of an attempt and what is needed to explain them in an error. */
export interface ResolvedDeadlines extends AttemptDeadlines {
  /** The shortest start or idle deadline an attempt is given. */
  minimumMs: number;
  /** The provider timeout the integration asked for, when the minimum raised it (and the raise is what the attempt runs for). */
  raisedFrom?: number;
  /** Whether the start and the idle deadline are the integration's own, or the defaults. */
  startOwn: boolean;
  idleOwn: boolean;
  /** The routing time that was left, when it is what limits this attempt (a later candidate of a routed call). */
  routingMs?: number;
}

export interface DeadlineOptions {
  /** Used when an integration has no provider timeout. */
  defaultTimeoutMs?: number;
  /** Replaces the minimum of the start and of the idle deadline (`MIN_REQUEST_TIMEOUT_MS`): for tests that count in milliseconds. */
  minimumTimeoutMs?: number;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The deadlines of one attempt. The start deadline is the integration's provider timeout, else the host's default, else 600 s, and never
 * under the minimum (30 s). The idle deadline is the integration's, else 600 s, kept between the minimum and an hour. The cap is four hours.
 * What is left of the routing time (`maxTotalDurationMs`) limits all three of a later candidate, and no minimum raises that.
 */
export function resolveDeadlines(integration: Pick<AiIntegrationConfig, "requestTimeoutMs" | "idleTimeoutMs">, options: DeadlineOptions = {}, routingLeftMs?: number): ResolvedDeadlines {
  const minimumMs = positiveNumber(options.minimumTimeoutMs) ?? MIN_REQUEST_TIMEOUT_MS;
  const ownStart = positiveNumber(integration.requestTimeoutMs);
  const written = ownStart ?? positiveNumber(options.defaultTimeoutMs) ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const ownIdle = positiveNumber(integration.idleTimeoutMs);
  let capMs = TOTAL_REQUEST_CAP_MS;
  let routingMs: number | undefined;
  if (routingLeftMs !== undefined) {
    const left = Math.max(1, Math.ceil(routingLeftMs));
    if (left < capMs) {
      capMs = left;
      routingMs = left;
    }
  }
  const startMs = Math.min(Math.max(minimumMs, written), capMs);
  const idleMs = Math.min(Math.min(MAX_IDLE_TIMEOUT_MS, Math.max(minimumMs, ownIdle ?? DEFAULT_IDLE_TIMEOUT_MS)), capMs);
  return {
    startMs,
    idleMs,
    capMs,
    minimumMs,
    startOwn: ownStart !== undefined,
    idleOwn: ownIdle !== undefined,
    ...(written < minimumMs && startMs > written ? { raisedFrom: written } : {}),
    ...(routingMs !== undefined ? { routingMs } : {}),
  };
}

/** The deadline that ran out: which one, and how long it was. */
export interface ExpiredDeadline {
  phase: AiTimeoutPhase;
  ms: number;
}

/** A duration as a person says it: `150 ms`, `30 s`, `1.5 s`, `4 h`. */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds >= 3_600_000 && milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000} h`;
  const seconds = milliseconds / 1000;
  return `${Number.isInteger(seconds) ? seconds : Math.round(seconds * 10) / 10} s`;
}

/**
 * What a timeout says: which deadline ran out, how long it was and where it is changed, without a key or an address.
 * `label` is `provider model`, and `integration` the name the author gave the integration.
 */
export function timeoutMessage(label: string, expired: ExpiredDeadline, deadlines: ResolvedDeadlines, integration: string): string {
  const ms = formatDuration(expired.ms);
  const named = `"${integration}"`;
  if (deadlines.routingMs !== undefined && expired.ms === deadlines.routingMs) {
    return `${label}: request timed out: the provider did not finish within the ${ms} left of the total routing time (maxTotalDurationMs)`;
  }
  if (expired.phase === "start") {
    const raised = deadlines.raisedFrom !== undefined ? ` was ${formatDuration(deadlines.raisedFrom)} and was raised to the ${formatDuration(deadlines.minimumMs)} minimum` : "";
    const where = deadlines.startOwn
      ? `the "Provider timeout" of the integration ${named}${raised}`
      : `the default provider timeout${raised ? `, which${raised}` : ""}; the integration ${named} can change it with its "Provider timeout"`;
    return `${label}: the provider did not start answering within ${ms} (${where})`;
  }
  if (expired.phase === "idle") {
    const where = deadlines.idleOwn ? `the "Idle timeout" of the integration ${named}` : `the default idle timeout; the integration ${named} can change it with its "Idle timeout"`;
    return `${label}: the provider sent nothing for ${ms} while answering (${where})`;
  }
  return `${label}: the provider did not finish within ${ms} (the longest one request may take: it cannot be changed)`;
}

/** What watches one attempt: the author's signal and the three deadlines. */
export interface DeadlineClock {
  /** For `fetch`: it aborts when the author cancels or a deadline runs out. */
  readonly signal: AbortSignal;
  /**
   * Settles as `promise` does, unless the author cancels or a deadline runs out first: then it rejects at once, whatever `promise` does
   * (a `fetch` or a stream that ignores its signal cannot hold the call).
   */
  guard<T>(promise: Promise<T>): Promise<T>;
  /** The reply began as a stream: the start deadline is over, and from now on the silence between two pieces is what is watched. */
  streaming(): void;
  /** Bytes arrived: the silence begins again. */
  activity(): void;
  /** The deadline that ran out, when one did (and the author had not cancelled first). */
  expired(): ExpiredDeadline | undefined;
  /** The call was cancelled, or ran out of time, or is over: a reply that arrives now is to be dropped. */
  interrupted(): boolean;
  /** Clears every timer and lets the connection go. Always to be called. */
  dispose(): void;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Starts watching an attempt. The cap and the start deadline run from now; the idle deadline from the moment `streaming()` is called,
 * and again from every `activity()`. The author's signal wins over every deadline: when both happen, the call is cancelled, never timed out.
 */
export function startClock(parent: AbortSignal | undefined, deadlines: AttemptDeadlines): DeadlineClock {
  const controller = new AbortController();
  let expired: ExpiredDeadline | undefined;
  let over = false;
  let watching = false;
  let reject: (reason: unknown) => void = () => undefined;
  const interruption = new Promise<never>((_resolve, rejectIt) => {
    reject = rejectIt;
  });
  // Nobody may be racing it when it rejects: that is not an unhandled rejection.
  interruption.catch(() => undefined);
  let capTimer: Timer | undefined;
  let startTimer: Timer | undefined;
  let idleTimer: Timer | undefined;

  const interrupt = (reason: unknown): void => {
    if (over || controller.signal.aborted) return;
    controller.abort(reason);
    reject(reason);
  };
  const expire = (phase: AiTimeoutPhase, ms: number) => (): void => {
    if (over || controller.signal.aborted) return;
    expired = { phase, ms };
    interrupt(new DOMException(`The request ran out of time (${phase}, ${ms} ms).`, "TimeoutError"));
  };
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(expire("idle", deadlines.idleMs), deadlines.idleMs);
  };
  const onAbort = (): void => interrupt(parent?.reason instanceof Error ? parent.reason : abortError());

  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  if (!controller.signal.aborted) {
    // The cap first: when the routing time left is all the three have, the call ends as the total it is.
    capTimer = setTimeout(expire("total", deadlines.capMs), deadlines.capMs);
    startTimer = setTimeout(expire("start", deadlines.startMs), deadlines.startMs);
  }

  return {
    signal: controller.signal,
    guard: <T>(promise: Promise<T>): Promise<T> => Promise.race([interruption, promise]),
    streaming(): void {
      if (over || controller.signal.aborted) return;
      if (startTimer !== undefined) clearTimeout(startTimer);
      startTimer = undefined;
      watching = true;
      armIdle();
    },
    activity(): void {
      if (watching && !over && !controller.signal.aborted) armIdle();
    },
    expired: () => expired,
    interrupted: () => over || controller.signal.aborted,
    dispose(): void {
      over = true;
      for (const timer of [capTimer, startTimer, idleTimer]) if (timer !== undefined) clearTimeout(timer);
      capTimer = startTimer = idleTimer = undefined;
      parent?.removeEventListener("abort", onAbort);
      if (!controller.signal.aborted) controller.abort(abortError("The request is over."));
    },
  };
}
