import type { LlmDebugEntry } from "@/debug/llmDebugStore";
import { formatLimit } from "@/lib/formatLimit";

/** One fact about how an attempt was asked, or what came back: a text of the app with its figures, which the panel says in words. */
export interface AttemptBadge {
  id: "request" | "stream" | "thinking" | "reasoningParameter" | "called" | "skipped" | "firstByte" | "toolsOnly" | "limits";
  key: string;
  params?: Record<string, string>;
}

/**
 * What the debug panel says of a chat request of the autopilot, from what the engine told about the attempt: how the answer was asked for (a function call or JSON in the message),
 * whether it streams, the level of thinking, whether the function was called, the models that «Tools only» left out, the time to the first byte, «Tools only» itself and the
 * deadlines. Every fact is there only when the entry has it, so an entry saved before they existed, or a request that is not a chat, says nothing. Pure: the figures are written
 * as the language does and the words are the panel's.
 */
export function attemptBadges(entry: LlmDebugEntry, language?: string): AttemptBadge[] {
  if (entry.kind !== "chat") return [];
  const badges: AttemptBadge[] = [];
  const structured = entry.structured === true;
  if (structured && entry.tools !== undefined) badges.push({ id: "request", key: entry.tools ? "debug.attempt.tools" : "debug.attempt.json" });
  // What was read once the reply is in; what was asked until then.
  const streaming = entry.streamed ?? entry.stream;
  if (streaming !== undefined) badges.push({ id: "stream", key: streaming ? "debug.attempt.streaming" : "debug.attempt.notStreaming" });
  if (entry.thinking) badges.push({ id: "thinking", key: "debug.attempt.thinking", params: { level: entry.thinking } });
  // Next to the level: where it went, when it went as the argument of the chat template.
  if (entry.reasoningParameter) badges.push({ id: "reasoningParameter", key: "debug.attempt.reasoningParameter", params: { parameter: entry.reasoningParameter } });
  if (structured && entry.toolCalled !== undefined) badges.push({ id: "called", key: entry.toolCalled ? "debug.attempt.calledYes" : "debug.attempt.calledNo" });
  if (entry.skipped?.length) badges.push({ id: "skipped", key: "debug.attempt.skipped", params: { models: entry.skipped.map((skipped) => skipped.model).join(", ") } });
  if (entry.firstByteMs !== undefined) badges.push({ id: "firstByte", key: "debug.attempt.firstByte", params: { time: formatLimit(entry.firstByteMs, language) } });
  if (structured && entry.toolsOnly !== undefined) badges.push({ id: "toolsOnly", key: entry.toolsOnly ? "debug.attempt.toolsOnlyOn" : "debug.attempt.toolsOnlyOff" });
  if (entry.timeouts) {
    const { startMs, idleMs, raisedFrom } = entry.timeouts;
    const figures = { start: formatLimit(startMs, language), idle: formatLimit(idleMs, language) };
    badges.push(raisedFrom !== undefined
      ? { id: "limits", key: "debug.attempt.limitsRaised", params: { ...figures, from: formatLimit(raisedFrom, language) } }
      : { id: "limits", key: "debug.attempt.limits", params: figures });
  }
  return badges;
}
