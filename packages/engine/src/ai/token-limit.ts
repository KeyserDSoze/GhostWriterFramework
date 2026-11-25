import { DEFAULT_AZURE_API_VERSION } from "./config.js";
import type { AiCandidate } from "./router.js";
import type { AiRequest } from "./types.js";

const MODERN_REASONING_MODEL = /(?:^|[/_.-])(?:o[134](?:[-_.]|$)|gpt-[5-9](?:[-_.]|$)|codex-mini(?:[-_.]|$))/i;

/** Reasoning models spend output tokens before replying: small structured tasks get at least this limit. */
export const STRUCTURED_OUTPUT_FLOOR = 4096;

/**
 * Reasoning models count their reasoning inside `max_completion_tokens`: a prose limit sized for the reply alone is
 * used up before the first word. Models known by name get this much on top of the limit requested.
 */
export const REASONING_OUTPUT_MARGIN = 12_000;

/** The API version from which Azure OpenAI accepts `max_completion_tokens` for every model. */
const AZURE_COMPLETION_LIMIT_FROM = "2024-09-01";

/** Reasoning model families reject `max_tokens` and custom temperatures. */
export function isReasoningModel(provider: string, model: string, underlyingModel?: string): boolean {
  const identity = provider === "azure_openai" ? (underlyingModel?.trim() || model.trim()) : model.trim();
  return Boolean(identity) && MODERN_REASONING_MODEL.test(identity);
}

function acceptsCompletionLimit(apiVersion: string | undefined): boolean {
  const version = (apiVersion ?? "").trim() || DEFAULT_AZURE_API_VERSION;
  return /^\d{4}-\d{2}-\d{2}/.test(version) ? version.slice(0, 10) >= AZURE_COMPLETION_LIMIT_FROM : true;
}

/**
 * The output-limit parameter each model family expects (same rule as the web app). A model that the name rules do not know yet is not left to guess: the client
 * sends the classic parameter, and when the provider refuses it, asks again with the other and remembers it (see `refusedLimitParameter` in the fetch client). An Azure deployment whose model is
 * not declared is recognized by its name; one that stays unknown gets `max_completion_tokens` (every model accepts it
 * from API version 2024-09-01) or, on an older API, `max_tokens`.
 */
export function completionTokenLimit(provider: string, model: string, maxOutputTokens?: number, underlyingModel?: string, apiVersion?: string): Record<string, number> {
  if (!maxOutputTokens || maxOutputTokens <= 0) return {};
  const modern = { max_completion_tokens: maxOutputTokens };
  const classic = { max_tokens: maxOutputTokens };
  if (provider === "azure_openai") {
    const declared = underlyingModel?.trim();
    if (declared) return MODERN_REASONING_MODEL.test(declared) ? modern : classic;
    if (MODERN_REASONING_MODEL.test(model.trim())) return modern;
    return acceptsCompletionLimit(apiVersion) ? modern : classic;
  }
  const identity = model.trim();
  if (!identity) return {};
  return MODERN_REASONING_MODEL.test(identity) ? modern : classic;
}

/**
 * The request's output limit for a candidate: structured tasks get a floor, models known to reason (by their name, or because their configuration
 * declares it: `supportsReasoning`) get a margin for their reasoning, a boost (the autopilot's second try after a reply cut while the model only
 * reasoned) multiplies the result, and the model's own maximum is never exceeded. What a model declares does not undo what its name says.
 */
export function requestOutputLimit(
  request: Pick<AiRequest, "json" | "maxOutputTokens" | "outputBoost">,
  candidate: Partial<Pick<AiCandidate, "maxOutputTokens" | "underlyingModel" | "model" | "integration" | "supportsReasoning">>,
): number | undefined {
  const requested = request.maxOutputTokens;
  if (!requested) return candidate.maxOutputTokens;
  let limit = request.json ? Math.max(requested, STRUCTURED_OUTPUT_FLOOR) : requested;
  const reasons = candidate.supportsReasoning === true || Boolean(candidate.integration && candidate.model && isReasoningModel(candidate.integration.provider, candidate.model, candidate.underlyingModel));
  if (reasons) limit += REASONING_OUTPUT_MARGIN;
  if (request.outputBoost && request.outputBoost > 1) limit = Math.ceil(limit * request.outputBoost);
  return candidate.maxOutputTokens ? Math.min(limit, candidate.maxOutputTokens) : limit;
}
