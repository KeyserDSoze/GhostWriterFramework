import type { AiNoThinkingWithTools, AiPromptCaching } from "./config.js";
import type { AiErrorBody } from "./provider-error.js";

/**
 * What a call learned about a model from the way a provider answered it, and what a host remembers between calls (the session of the autopilot, the page of the browser). Two things.
 *
 * `no-thinking-with-tools`: a provider that refuses a thinking level because the request carries function tools («Function tools with reasoning_effort are not supported for gpt-6-luna in
 * /v1/chat/completions…»). The call is then asked again without the level, and if that is refused too, with `none` (some models refuse a request with tools that leaves the level out); what answered is what
 * is learned, once, and every later request with tools to that model is asked that way, while a request without tools keeps the level the author configured. A model that no way answers is learned nothing of.
 *
 * `prompt-caching`: either a response that reports tokens served from the provider's cache (`learned: "cached"`: the model caches, which the engine remembers so that it says it once), or a provider
 * that refuses the hints that help it find its cache (`prompt_cache_key`, `cache_control`: `learned: "hints-rejected"`). The call is asked again without the hint and, when that answers, the hint is not sent
 * to that model again.
 */
export interface AiNoThinkingLearning {
  kind: "no-thinking-with-tools";
  integrationId: string;
  integrationName: string;
  model: string;
  /** How the model was asked when it answered: `omit` (the level left out of the request) or `none` (`reasoning_effort: "none"`). */
  off: "omit" | "none";
  /** What the provider said the first time it refused, in its own words (never a key, never the request). */
  body: AiErrorBody;
}

export interface AiPromptCachingLearning {
  kind: "prompt-caching";
  integrationId: string;
  integrationName: string;
  model: string;
  /** `cached`: a response reported tokens served from the cache; `hints-rejected`: the provider refused the cache hints and answered without them. */
  learned: "cached" | "hints-rejected";
  /** For `cached`: the input tokens of the response that showed it, and how many of them were served from the cache. */
  inputTokens?: number;
  cachedInputTokens?: number;
  /** For `hints-rejected`: the hint the provider refused, and what it said, in its own words. */
  hint?: "prompt_cache_key" | "cache_control";
  body?: AiErrorBody;
}

export type AiModelLearning = AiNoThinkingLearning | AiPromptCachingLearning;

/** What a host remembers of its models between two calls, and tells the client of. A host that keeps none gives none: the client then learns for the call that learned it, and the next call learns again. */
export interface AiModelMemory {
  /** How this model is to be asked when the request carries tools, when it is known to refuse thinking with them: learned by a call, or set in the model's configuration. */
  noThinkingWithTools(integrationId: string, model: string): AiNoThinkingWithTools | undefined;
  /** What the host knows of whether this model caches its prompts: `learned` once a response of it reported tokens served from the cache; absent when it has not. */
  promptCaching?(integrationId: string, model: string): Exclude<AiPromptCaching, "unknown"> | undefined;
  /** Whether the provider of this model refused the cache hints (`prompt_cache_key`, `cache_control`): they are not sent to it again. */
  promptCacheHintsRefused?(integrationId: string, model: string): boolean;
  /** Remembers what a call learned. Idempotent: `none` replaces `omit`, which a model that was learned to take it does not need again. */
  learn(learning: AiModelLearning): void;
  /** What was learned so far, in the order it was learned. */
  readonly learned: readonly AiModelLearning[];
}

const key = (integrationId: string, model: string): string => `${integrationId}\u0000${model}`;

/** A memory that keeps what its calls learn for as long as it lives. `initial` is what a host knows already (the flags of its settings), which are not learnings and are not listed. */
export function createModelMemory(initial: Iterable<{ integrationId: string; model: string; how?: AiNoThinkingWithTools }> = []): AiModelMemory {
  const known = new Map<string, AiNoThinkingWithTools>();
  for (const entry of initial) known.set(key(entry.integrationId, entry.model), entry.how ?? true);
  const learned: AiModelLearning[] = [];
  const caching = new Set<string>();
  const refused = new Set<string>();
  return {
    noThinkingWithTools: (integrationId, model) => known.get(key(integrationId, model)),
    promptCaching: (integrationId, model) => (caching.has(key(integrationId, model)) ? "learned" : undefined),
    promptCacheHintsRefused: (integrationId, model) => refused.has(key(integrationId, model)),
    learn(learning) {
      const at = key(learning.integrationId, learning.model);
      if (learning.kind === "prompt-caching") {
        const set = learning.learned === "cached" ? caching : refused;
        if (set.has(at)) return;
        set.add(at);
        learned.push(learning);
        return;
      }
      const how: AiNoThinkingWithTools = learning.off === "none" ? "none" : true;
      // What takes `none` is not asked without a level again, and a model that was learned as `omit` is not made to forget a better way.
      if (known.get(at) !== "none") known.set(at, how);
      const index = learned.findIndex((entry) => entry.kind === "no-thinking-with-tools" && key(entry.integrationId, entry.model) === at);
      const previous = learned[index];
      if (index < 0) learned.push(learning);
      else if (learning.off === "none" && previous.kind === "no-thinking-with-tools" && previous.off !== "none") learned[index] = learning;
    },
    get learned() {
      return learned;
    },
  };
}
