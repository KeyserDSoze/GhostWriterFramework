import type { PromptInputLike } from "@/assistant/promptTypes";
import { resolveDeepResearchRequest } from "@/assistant/deepResearchRequest";
import { runDeepResearch, type RunDeepResearchInput, type RunDeepResearchResult } from "@/research/engine";
import type { BookEntry } from "@/types/settings";

export async function executeDeepResearchFromCopilot(
  input: PromptInputLike & { book: BookEntry; branch: string; token: string },
  runner: (input: RunDeepResearchInput) => Promise<RunDeepResearchResult> = runDeepResearch,
): Promise<RunDeepResearchResult | null> {
  const request = resolveDeepResearchRequest(input.prompt);
  if (!request) return null;
  return runner({ settings: input.settings, book: input.book, branch: input.branch, token: input.token, query: request.query, depth: request.depth, intents: request.intents, language: input.structureLanguage ?? input.settings.ui.language, accountScope: input.accountScope, signal: input.signal, onProgress: input.onText, expectedRemoteHeadSha: input.expectedRemoteHeadSha });
}
