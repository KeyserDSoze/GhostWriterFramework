const MESSAGE_OVERHEAD_TOKENS = 4;
/**
 * The context window assumed for a model whose window is not set in AI Integrations (`maxInputTokens`): 128,000 tokens, the window of most of the chat models the providers serve
 * today (GPT-4o and GPT-4o mini, Mistral Large, Llama 3.1 and the open models of the OpenAI-compatible endpoints; Claude has 200,000, GPT-4.1 and Gemini 1,000,000 or more). A
 * prompt that fits it fits nearly every current model, and a model that holds less (a local one, an older one) is the exception to set. It used to be 32,000, which cut a text of
 * 60,000 characters in half for every model whose window was not set.
 */
export const DEFAULT_MAX_INPUT_TOKENS = 128_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

/** Where the context window of a model comes from: its own (`maxInputTokens`, set in AI Integrations) or the default (`DEFAULT_MAX_INPUT_TOKENS`). */
export type ModelWindowSource = "configured" | "default";

/** The context window of a model, in tokens (its prompt and its answer together), and where it comes from. */
export interface ModelWindow {
  tokens: number;
  source: ModelWindowSource;
}

/**
 * The context window of a model: its own when it is set (`maxInputTokens`), else the default. What every limit of a request follows: whether a prompt fits (the autopilot refuses
 * one that does not, the Copilot cuts it and says so), what the router estimates an attempt at, and how full a chat is.
 */
export function modelWindow(model?: { maxInputTokens?: number | null } | null): ModelWindow {
  const configured = model?.maxInputTokens;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? { tokens: Math.floor(configured), source: "configured" }
    : { tokens: DEFAULT_MAX_INPUT_TOKENS, source: "default" };
}
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
