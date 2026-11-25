import type { LlmDebugProviderError } from "@/debug/llmDebugStore";

/**
 * What the OpenAI client library says of a request that its provider refused (`APIError`: the HTTP status, and the `type`, `param` and `code` of the provider's error), for the debug entry of an image,
 * speech or transcription request, which the engine's client does not make. The history keeps only the short words (the store checks them again) and never the message.
 */
export function providerErrorOf(error: unknown): LlmDebugProviderError | undefined {
  if (!error || typeof error !== "object") return undefined;
  const { status, type, param, code } = error as Record<string, unknown>;
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined);
  const found: LlmDebugProviderError = { ...(typeof status === "number" ? { status } : {}), ...(text(type) ? { type: text(type) } : {}), ...(text(param) ? { param: text(param) } : {}), ...(text(code) ? { code: text(code) } : {}) };
  return Object.keys(found).length ? found : undefined;
}
