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

export async function executeMediaFallback<T>(input: {
  candidates: MediaFallbackCandidate[];
  signal?: AbortSignal;
  runAi: (candidate: MediaFallbackCandidate) => Promise<T>;
  runBrowser?: (candidateIndex: number) => Promise<T>;
}): Promise<T> {
  throwIfAborted(input.signal);
  let lastError: unknown = null;
  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index];
    throwIfAborted(input.signal);
    try {
      if (candidate.browser) {
        if (!input.runBrowser) continue;
        return await input.runBrowser(index);
      }
      if (!candidate.integration || !candidate.model) continue;
      return await input.runAi(candidate);
    } catch (error) {
      if (error instanceof BrowserSpeechFallbackRequired || (error instanceof Error && error.name === "AbortError")) throw error;
      throwIfAborted(input.signal);
      lastError = error;
    }
  }
  throw lastError ?? new Error("All configured media candidates failed.");
}
