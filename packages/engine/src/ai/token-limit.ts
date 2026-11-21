const MODERN_REASONING_MODEL = /(?:^|[/_.-])(?:o[134](?:[-_.]|$)|gpt-5(?:[-_.]|$)|codex-mini(?:[-_.]|$))/i;

/** Reasoning model families reject `max_tokens` and custom temperatures. */
export function isReasoningModel(provider: string, model: string, underlyingModel?: string): boolean {
  const identity = provider === "azure_openai" ? (underlyingModel?.trim() || model.trim()) : model.trim();
  return Boolean(identity) && MODERN_REASONING_MODEL.test(identity);
}

/** The output-limit parameter each model family expects (same rule as the web app). */
export function completionTokenLimit(provider: string, model: string, maxOutputTokens?: number, underlyingModel?: string): Record<string, number> {
  if (!maxOutputTokens || maxOutputTokens <= 0) return {};
  const identity = provider === "azure_openai" ? underlyingModel?.trim() : model.trim();
  if (!identity) return {};
  return MODERN_REASONING_MODEL.test(identity) ? { max_completion_tokens: maxOutputTokens } : { max_tokens: maxOutputTokens };
}
