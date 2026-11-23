export interface CompletionCandidate { label: string; }

export function isValidTextCompletion(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return !/^\s*(?:\[?content filtered\]?|\[?response filtered\]?|blocked by (?:the )?safety filter)\s*[.!]?\s*$/i.test(value);
}

/** The most of an error that is kept for the author: its own message, or the sentence a failed candidate wrote (which says which deadline ran out and where it is changed). */
const MAX_MESSAGE_CHARACTERS = 240;
const MAX_SENTENCE_CHARACTERS = 600;

function diagnostic(error: unknown, limit = MAX_MESSAGE_CHARACTERS): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]").replace(/((?:api[_ -]?key|authorization|token|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]").replace(/[\r\n]+/g, " ").slice(0, limit);
}

/** What kind of error a candidate failed with: its class name and HTTP status, never its message. */
export interface CompletionFailureCause { name: string; status?: number }

function failureCause(error: unknown): CompletionFailureCause {
  const name = error instanceof Error ? error.name : typeof error;
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? { name, status } : { name };
}

export class CompletionFallbackError extends Error {
  readonly failures: string[];
  /** One entry per failed candidate, in order, for callers that classify the failure. */
  readonly causes: CompletionFailureCause[];
  /** What stopped the candidates that were not tried (the routing time was used up). */
  readonly notes: string[];
  constructor(failures: string[], causes: CompletionFailureCause[] = [], notes: string[] = []) {
    const list = failures.join("; ");
    super(`All configured completion candidates failed: ${list}${notes.length ? `${/[.!?]$/.test(list) ? "" : "."} ${notes.join(" ")}` : ""}`);
    this.name = "CompletionFallbackError";
    this.failures = failures;
    this.causes = causes;
    this.notes = notes;
  }
}

/** Settles as `promise` does, unless the signal aborts first: a provider that ignores its signal cannot hold a call that the author stopped. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (!signal.aborted) signal.addEventListener("abort", onAbort, { once: true });
    // Always followed, so that a promise that fails after the call was abandoned is not an unhandled rejection.
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
    if (signal.aborted) onAbort();
  });
}

const NEVER_ABORTED = new AbortController().signal;

export async function executeCompletionFallback<T extends CompletionCandidate>(input: {
  candidates: T[];
  /** Asks a candidate. The signal is the call's: the author's Stop. The deadlines of a request are the client's, which knows when a provider is silent and when it is only slow. */
  run: (candidate: T, signal: AbortSignal, index: number) => Promise<string>;
  beforeCandidate?: (candidate: T, index: number) => void;
  resetPartial?: () => void;
  signal?: AbortSignal;
  /** Asked before every candidate after the first: a text says that the others are not tried, and why. */
  stopBefore?: (candidate: T, index: number) => string | undefined;
  /** What a failed candidate is reported as, when the client wrote a sentence of its own that says which candidate it is (default: the label, then what the error said). */
  describe?: (candidate: T, error: unknown) => string | undefined;
}): Promise<string> {
  input.signal?.throwIfAborted();
  const failures: string[] = [];
  const causes: CompletionFailureCause[] = [];
  const notes: string[] = [];
  for (const [index, candidate] of input.candidates.entries()) {
    input.signal?.throwIfAborted();
    if (index > 0) {
      const reason = input.stopBefore?.(candidate, index);
      if (reason) {
        notes.push(reason);
        break;
      }
    }
    input.beforeCandidate?.(candidate, index);
    input.resetPartial?.();
    try {
      const value = await untilAborted(input.run(candidate, input.signal ?? NEVER_ABORTED, index), input.signal);
      input.signal?.throwIfAborted();
      if (!isValidTextCompletion(value)) throw new Error(value.trim() ? "filtered or invalid response" : "empty response");
      return value;
    } catch (error) {
      input.resetPartial?.();
      if (input.signal?.aborted) throw error;
      const sentence = input.describe?.(candidate, error);
      failures.push(sentence !== undefined ? diagnostic(sentence, MAX_SENTENCE_CHARACTERS) : `${diagnostic(candidate.label)}: ${diagnostic(error)}`);
      causes.push(failureCause(error));
    }
  }
  throw new CompletionFallbackError(failures.length ? failures : ["no executable candidates"], causes, notes);
}
