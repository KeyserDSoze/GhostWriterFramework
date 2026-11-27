import type { AiProviderKind, AiPromptCaching } from "./config.js";
import type { AiErrorBody } from "./provider-error.js";

/**
 * Prompt caching, as the providers do it. OpenAI and Azure OpenAI cache the start of a prompt on their own once it holds 1,024 tokens, and serve what repeats in steps of 128 tokens after that (GPT-5.6 and later
 * have no step); DeepSeek and Gemini cache on their own too; an Anthropic model caches what a `cache_control` block marks. What the engine can do about it is two things: keep the start of a prompt
 * the same from one call to the next (the order of the prompts, which is the hosts' to keep) and, for the providers that take one, tell them where to look (`prompt_cache_key`, `cache_control`). A
 * provider that refuses a hint is never sent it again (`AiModelMemory`), and a model the author declared as not caching gets none.
 */

/** The shortest prompt that a provider caches (OpenAI, Azure OpenAI, Gemini 2.5 Flash; Anthropic's is 1,024 for most models and 4,096 for the smallest). Below it nothing is served from the cache. */
export const PROMPT_CACHE_MIN_TOKENS = 1024;
/** The granularity of the part of a prompt that OpenAI serves from its cache once the minimum is met. */
export const PROMPT_CACHE_STEP_TOKENS = 128;

/** The tokens of a prompt that a provider like OpenAI serves from its cache when the start of the prompt that repeats is `prefixTokens` long: nothing below the minimum, then whole steps. */
export function servedFromCache(prefixTokens: number, totalTokens = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(prefixTokens) || prefixTokens < PROMPT_CACHE_MIN_TOKENS) return 0;
  const served = PROMPT_CACHE_MIN_TOKENS + Math.floor((prefixTokens - PROMPT_CACHE_MIN_TOKENS) / PROMPT_CACHE_STEP_TOKENS) * PROMPT_CACHE_STEP_TOKENS;
  return Math.max(0, Math.min(served, totalTokens));
}

/** What the hint that helps a provider find its cache is called: the field of OpenAI and Azure OpenAI (Chat Completions and Responses), or the block of Anthropic (`cache_control`). */
export type PromptCacheHint = "prompt_cache_key" | "cache_control";

function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The key a request carries as `prompt_cache_key`: a short name that is the same for every request of one scope (a book and a task), made from the host's own words for it and not those words: what is
 * sent to the provider names neither the book nor the author. The same scope is always the same key (two FNV-1a hashes of 32 bits), so that the requests that share a prompt start are routed to one cache.
 */
export function promptCacheKey(scope: string): string {
  const hex = (value: number): string => value.toString(16).padStart(8, "0");
  return `narrarium-${hex(fnv1a(scope, 0x811c9dc5))}${hex(fnv1a(scope, 0x9747b28c))}`;
}

/** The hosts whose models are Anthropic's, and the gateways that pass an Anthropic `cache_control` block on to them. */
const ANTHROPIC_HOSTS = /(?:^|\.)(?:anthropic\.com|openrouter\.ai)$/i;
const OFFICIAL_OPENAI_HOSTS = /(?:^|\.)(?:openai\.com|openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/i;

interface HintCandidate {
  integration: { provider: AiProviderKind };
  model: string;
  underlyingModel?: string;
  promptCaching?: Exclude<AiPromptCaching, "unknown">;
  promptCacheHintsRefused?: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * The hint a request to this model carries, or none. `prompt_cache_key` goes to the providers that document it: OpenAI and Azure OpenAI, at their own addresses, or at a gateway that the author declared (or that
 * was learned) to cache, over Chat Completions and over the Responses API. `cache_control` goes to an Anthropic model, at an Anthropic address or a gateway that passes the block on (OpenRouter), or at a
 * gateway that the author declared to cache: never to another model, because a provider that does not know the block refuses it. Nothing for a model declared as not caching, for a provider that
 * has no caching to speak of (GitHub Models, whose catalog the engine only reads through Chat Completions) and for one that refused the hint before.
 */
export function promptCacheHintFor(candidate: HintCandidate, url: string, protocol: "chat-completions" | "responses"): PromptCacheHint | undefined {
  if (candidate.promptCaching === "unsupported" || candidate.promptCacheHintsRefused) return undefined;
  const provider = candidate.integration.provider;
  if (provider !== "openai" && provider !== "azure_openai") return undefined;
  const host = hostOf(url);
  const declared = candidate.promptCaching === "supported" || candidate.promptCaching === "learned";
  const name = candidate.underlyingModel || candidate.model;
  if (/(?:^|[/:.])claude/i.test(name)) {
    // Only Chat Completions has content blocks to put it on.
    return protocol === "chat-completions" && provider === "openai" && (ANTHROPIC_HOSTS.test(host) || declared) ? "cache_control" : undefined;
  }
  if (provider === "azure_openai" || OFFICIAL_OPENAI_HOSTS.test(host) || declared) return "prompt_cache_key";
  return undefined;
}

/** What a provider says when it does not take a cache hint: the name of the field or the block, in its message or in the `param` of its error. */
const CACHE_HINT_WORDS = /prompt[\s._-]?cache[\s._-]?(?:key|retention)|cache[\s._-]?control/i;

/** Whether a refusal is of the cache hint: a 400 or a 422 whose words name it (`Unrecognized request argument supplied: prompt_cache_key`, `Extra inputs are not permitted: cache_control`). */
export function refusesCacheHint(body: AiErrorBody | undefined): boolean {
  if (!body || (body.status !== 400 && body.status !== 422)) return false;
  return CACHE_HINT_WORDS.test(`${body.message ?? ""} ${body.raw ?? ""} ${body.param ?? ""}`);
}
