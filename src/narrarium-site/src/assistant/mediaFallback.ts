import { runWithCandidateTimeout } from "./executionLimits.ts";

export interface MediaFallbackCandidate {
  browser?: boolean;
  integration?: unknown;
  model?: string;
}

export class BrowserSpeechFallbackRequired extends Error {
  readonly nextCandidateIndex: number;

  constructor(nextCandidateIndex: number) {
    super("Browser speech recognition is the next configured fallback.");
    this.name = "BrowserSpeechFallbackRequired";
    this.nextCandidateIndex = nextCandidateIndex;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export async function executeMediaFallback<T, C extends MediaFallbackCandidate = MediaFallbackCandidate>(input: {
  candidates: C[];
  signal?: AbortSignal;
  runAi: (candidate: C, signal: AbortSignal | undefined, candidateIndex: number) => Promise<T>;
  runBrowser?: (candidateIndex: number) => Promise<T>;
  /** TTS manages a timeout per synthesized chunk after returning its playback controller. */
  timeoutAi?: boolean;
  beforeCandidate?: (candidate: C, candidateIndex: number) => void;
}): Promise<T> {
  throwIfAborted(input.signal);
  let lastError: unknown = null;
  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index];
    throwIfAborted(input.signal);
    input.beforeCandidate?.(candidate, index);
    try {
      if (candidate.browser) {
        if (!input.runBrowser) continue;
        return await input.runBrowser(index);
      }
      if (!candidate.integration || !candidate.model) continue;
       const timeoutMs = (candidate.integration as { requestTimeoutMs?: number }).requestTimeoutMs;
       return input.timeoutAi === false
         ? await input.runAi(candidate, input.signal, index)
         : await runWithCandidateTimeout((signal) => input.runAi(candidate, signal, index), input.signal, timeoutMs);
    } catch (error) {
      if (error instanceof BrowserSpeechFallbackRequired) throw error;
      throwIfAborted(input.signal);
      lastError = error;
    }
  }
  throw lastError ?? new Error("All configured media candidates failed.");
}
