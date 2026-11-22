const MESSAGE_OVERHEAD_TOKENS = 4;
export const DEFAULT_MAX_INPUT_TOKENS = 32_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

const encoder = new TextEncoder();

/** Byte-level BPE tokenizers cannot emit more tokens than the UTF-8 bytes supplied: a safe upper bound. */
export function textTokenUpperBound(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * Likely token count, about four characters per token. Unlike the upper bound it can be lower than the provider's
 * count, so it only serves to refuse prompts that clearly cannot fit a known window and to estimate what a reply used.
 */
export function likelyTextTokens(value: string): number {
  return Math.ceil((value ?? "").length / 4);
}

export function likelyMessageTokens(messages: ReadonlyArray<{ content: string }>): number {
  return messages.reduce((total, message) => total + MESSAGE_OVERHEAD_TOKENS + likelyTextTokens(message.content), 0);
}

export function estimateMessageTokens(messages: ReadonlyArray<{ content: string }>): number {
  return messages.reduce((total, message) => total + MESSAGE_OVERHEAD_TOKENS + textTokenUpperBound(message.content), 0);
}

/**
 * What a model's context window leaves for the prompt once its output and a 5% safety margin are reserved
 * (same rule as the web app, so a prompt is judged the same way in every host).
 */
export function resolveModelTokenBudgets(maxContextTokens = DEFAULT_MAX_INPUT_TOKENS, configuredOutputTokens?: number): { contextTokens: number; inputTokens: number; outputTokens: number; safetyTokens: number } {
  const contextTokens = Math.max(3, Math.floor(maxContextTokens || DEFAULT_MAX_INPUT_TOKENS));
  const safetyTokens = Math.min(Math.max(32, Math.ceil(contextTokens * 0.05)), contextTokens - 2);
  const requestedOutput = configuredOutputTokens && configuredOutputTokens > 0
    ? Math.floor(configuredOutputTokens)
    : Math.min(DEFAULT_MAX_OUTPUT_TOKENS, Math.max(1, Math.floor(contextTokens * 0.25)));
  const outputTokens = Math.min(requestedOutput, Math.max(1, contextTokens - safetyTokens - 1));
  return { contextTokens, inputTokens: contextTokens - safetyTokens - outputTokens, outputTokens, safetyTokens };
}
