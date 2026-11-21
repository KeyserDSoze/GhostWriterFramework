import { runWithCandidateTimeout } from "./executionLimits.ts";

export interface CompletionCandidate { label: string; }

export function isValidTextCompletion(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return !/^\s*(?:\[?content filtered\]?|\[?response filtered\]?|blocked by (?:the )?safety filter)\s*[.!]?\s*$/i.test(value);
}

function diagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]").replace(/((?:api[_ -]?key|authorization|token|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]").replace(/[\r\n]+/g, " ").slice(0, 240);
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
  constructor(failures: string[], causes: CompletionFailureCause[] = []) {
    super(`All configured completion candidates failed: ${failures.join("; ")}`);
    this.name = "CompletionFallbackError";
    this.failures = failures;
    this.causes = causes;
  }
}

export async function executeCompletionFallback<T extends CompletionCandidate>(input: { candidates: T[]; run: (candidate: T, signal: AbortSignal) => Promise<string>; beforeCandidate?: (candidate: T, index: number) => void; resetPartial?: () => void; signal?: AbortSignal; timeoutMs?: number | ((candidate: T) => number | undefined) }): Promise<string> {
  input.signal?.throwIfAborted();
  const failures: string[] = [];
  const causes: CompletionFailureCause[] = [];
  for (const [index, candidate] of input.candidates.entries()) {
    input.signal?.throwIfAborted();
    input.beforeCandidate?.(candidate, index);
    input.resetPartial?.();
    try {
      const configuredTimeout = typeof input.timeoutMs === "function" ? input.timeoutMs(candidate) : input.timeoutMs;
      const value = await runWithCandidateTimeout((signal) => input.run(candidate, signal), input.signal, configuredTimeout);
      input.signal?.throwIfAborted();
      if (!isValidTextCompletion(value)) throw new Error(value.trim() ? "filtered or invalid response" : "empty response");
      return value;
    } catch (error) {
      input.resetPartial?.();
      if (input.signal?.aborted) throw error;
      failures.push(`${diagnostic(candidate.label)}: ${diagnostic(error)}`);
      causes.push(failureCause(error));
    }
  }
  throw new CompletionFallbackError(failures.length ? failures : ["no executable candidates"], causes);
}
