import { THINKING_LEVELS, type ReasoningParameter, type ThinkingLevel } from "@/types/settings";

export { THINKING_LEVELS, type ReasoningParameter, type ThinkingLevel };

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
