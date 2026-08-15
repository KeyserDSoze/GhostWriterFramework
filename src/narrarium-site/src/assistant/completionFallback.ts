export interface CompletionCandidate { label: string; }

export function isValidTextCompletion(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return !/^\s*(?:\[?content filtered\]?|\[?response filtered\]?|blocked by (?:the )?safety filter)\s*[.!]?\s*$/i.test(value);
}

function diagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]").replace(/((?:api[_ -]?key|authorization|token|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]").replace(/[\r\n]+/g, " ").slice(0, 240);
}

export class CompletionFallbackError extends Error {
  readonly failures: string[];
  constructor(failures: string[]) {
    super(`All configured completion candidates failed: ${failures.join("; ")}`);
    this.name = "CompletionFallbackError";
    this.failures = failures;
  }
}

export async function executeCompletionFallback<T extends CompletionCandidate>(input: { candidates: T[]; run: (candidate: T) => Promise<string>; resetPartial?: () => void; signal?: AbortSignal }): Promise<string> {
  input.signal?.throwIfAborted();
  const failures: string[] = [];
  for (const candidate of input.candidates) {
    input.signal?.throwIfAborted();
    input.resetPartial?.();
    try {
      const value = await input.run(candidate);
      input.signal?.throwIfAborted();
      if (!isValidTextCompletion(value)) throw new Error(value.trim() ? "filtered or invalid response" : "empty response");
      return value;
    } catch (error) {
      input.resetPartial?.();
      if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      failures.push(`${diagnostic(candidate.label)}: ${diagnostic(error)}`);
    }
  }
  throw new CompletionFallbackError(failures.length ? failures : ["no executable candidates"]);
}
