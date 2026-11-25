import type { AiNoThinkingWithTools } from "./config.js";
import type { AiErrorBody } from "./provider-error.js";

/**
 * What a call learned about a model from the way a provider refused it, and what a host remembers between calls (the session of the autopilot, the page of the browser). Today one thing: a provider
 * that refuses a thinking level because the request carries function tools («Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions…»). The call is then
 * asked again without the level, and if that is refused too, with `none` (some models refuse a request with tools that leaves the level out); what answered is what is learned, once, and every later
 * request with tools to that model is asked that way, while a request without tools keeps the level the author configured. A model that no way answers is learned nothing of.
 */
export interface AiModelLearning {
  kind: "no-thinking-with-tools";
  integrationId: string;
  integrationName: string;
  model: string;
  /** How the model was asked when it answered: `omit` (the level left out of the request) or `none` (`reasoning_effort: "none"`). */
  off: "omit" | "none";
  /** What the provider said the first time it refused, in its own words (never a key, never the request). */
  body: AiErrorBody;
}

/** What a host remembers of its models between two calls, and tells the client of. A host that keeps none gives none: the client then learns for the call that learned it, and the next call learns again. */
export interface AiModelMemory {
  /** How this model is to be asked when the request carries tools, when it is known to refuse thinking with them: learned by a call, or set in the model's configuration. */
  noThinkingWithTools(integrationId: string, model: string): AiNoThinkingWithTools | undefined;
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
  return {
    noThinkingWithTools: (integrationId, model) => known.get(key(integrationId, model)),
    learn(learning) {
      const at = key(learning.integrationId, learning.model);
      const how: AiNoThinkingWithTools = learning.off === "none" ? "none" : true;
      // What takes `none` is not asked without a level again, and a model that was learned as `omit` is not made to forget a better way.
      if (known.get(at) !== "none") known.set(at, how);
      const index = learned.findIndex((entry) => key(entry.integrationId, entry.model) === at);
      if (index < 0) learned.push(learning);
      else if (learning.off === "none" && learned[index].off !== "none") learned[index] = learning;
    },
    get learned() {
      return learned;
    },
  };
}
