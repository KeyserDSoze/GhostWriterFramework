const MESSAGE_OVERHEAD_TOKENS = 4;
export const DEFAULT_MAX_INPUT_TOKENS = 32_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
/** What an image in a message weighs, whatever its size: the web app has always counted this much for one. */
export const IMAGE_TOKEN_ESTIMATE = 4_096;

const encoder = new TextEncoder();

/** The content of a message as the estimates read it: text, or parts of text and images, as a host has them or as they go on the wire (`image_url`). */
type CountedContent = string | ReadonlyArray<{ type: "text"; text: string } | { type: "image"; dataUrl: string } | { type: "image_url"; image_url: { url: string } }>;

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

function contentTokens(content: CountedContent, ofText: (text: string) => number): number {
  if (typeof content === "string") return ofText(content);
  return content.reduce((total, part) => total + (part.type === "text" ? ofText(part.text) : IMAGE_TOKEN_ESTIMATE), 0);
}

export function likelyMessageTokens(messages: ReadonlyArray<{ content: CountedContent }>): number {
  return messages.reduce((total, message) => total + MESSAGE_OVERHEAD_TOKENS + contentTokens(message.content, likelyTextTokens), 0);
}

export function estimateMessageTokens(messages: ReadonlyArray<{ content: CountedContent }>): number {
  return messages.reduce((total, message) => total + MESSAGE_OVERHEAD_TOKENS + contentTokens(message.content, textTokenUpperBound), 0);
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
