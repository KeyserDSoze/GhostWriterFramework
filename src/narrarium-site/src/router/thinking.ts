import { THINKING_LEVELS, type ReasoningParameter, type ThinkingLevel } from "@/types/settings";

export { THINKING_LEVELS, type ReasoningParameter, type ThinkingLevel };

/** The levels a provider takes as `reasoning_effort`. `automatic` is not among them: it means "do not send". */
export type ReasoningEffort = Exclude<ThinkingLevel, "automatic">;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** A stored value that is a level, or nothing: whatever else was written there is not sent to a provider. */
export function normalizeThinking(value: unknown): ThinkingLevel | undefined {
  return isThinkingLevel(value) ? value : undefined;
}

/**
 * The level a call goes out with: the target's own, else the integration's. A target's `automatic` wins over the
 * integration's level, because it is the author's way of saying "do not send anything for this one".
 */
export function effectiveThinking(target: { thinking?: unknown } | undefined, integration: { thinking?: unknown } | undefined): ThinkingLevel | undefined {
  return normalizeThinking(target?.thinking) ?? normalizeThinking(integration?.thinking);
}

/** What goes on the wire: only an explicit level, never `automatic` and never a blank. The same rule as the engine's. */
export function reasoningEffortFor(level: ThinkingLevel | undefined): ReasoningEffort | undefined {
  return level === "low" || level === "medium" || level === "high" || level === "xhigh" ? level : undefined;
}

/**
 * The request field for a level, in the parameter the model takes it in, to be spread into a chat request: `{ reasoning_effort }` (the OpenAI field, and what a model that says nothing
 * gets), `{ chat_template_kwargs: { reasoning_strength } }` (the argument of the chat template, which Muse Glimmer takes and llama.cpp reads in place of `reasoning_effort`), or `{}`
 * (no level: `automatic`, no level at all, or a model whose parameter is `none`). A parameter this version does not know is read as the default, as the engine reads it.
 */
export function reasoningParams(level: ThinkingLevel | undefined, parameter?: ReasoningParameter): { reasoning_effort?: ReasoningEffort; chat_template_kwargs?: { reasoning_strength: ReasoningEffort } } {
  const effort = reasoningEffortFor(level);
  if (!effort || parameter === "none") return {};
  return parameter === "chat_template_kwargs.reasoning_strength" ? { chat_template_kwargs: { reasoning_strength: effort } } : { reasoning_effort: effort };
}
