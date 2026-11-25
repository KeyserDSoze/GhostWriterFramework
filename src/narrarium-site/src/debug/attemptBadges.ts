import { formatBytes } from "@/autopilot/format";
import type { LlmDebugEntry, LlmDebugTransport } from "@/debug/llmDebugStore";
import { formatLimit } from "@/lib/formatLimit";

/** One fact about how an attempt was asked, or what came back: a text of the app with its figures, which the panel says in words. */
export interface AttemptBadge {
  id: "request" | "stream" | "apiVersion" | "thinking" | "reasoningParameter" | "called" | "skipped" | "firstByte" | "toolsOnly" | "limits" | "received" | "lastChunk" | "streamEnd" | "finishReason" | "usage" | "requestId";
  key: string;
  params?: Record<string, string>;
}

/**
 * What the debug panel says of a chat request of the autopilot, from what the engine told about the attempt: how the answer was asked for (a function call or JSON in the message),
 * whether it streams, the level of thinking, whether the function was called, the models that «Tools only» left out, the time to the first byte, «Tools only» itself and the
 * deadlines; and, for an attempt that failed, what the transport saw of it (how much arrived, when the last chunk did, how the stream ended, the finish reason, whether the provider reported the
 * tokens, the id of the request), and for one that worked, only that the tokens were not reported (the figures are then an estimate). Every fact is there only when the entry has it, so an entry saved before they existed, or a request that is not a chat, says nothing. Pure: the figures are written
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
  if (entry.apiVersion) badges.push({ id: "apiVersion", key: "debug.attempt.apiVersion", params: { version: entry.apiVersion } });
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
  if (entry.transport) badges.push(...transportBadges(entry.transport, entry.status === "error", language));
  return badges;
}

/**
 * Where the texts of the transport facts are: the debug panel has them in its own catalogue (`debug.attempt`, bundled with the panel), and the error panel of the autopilot in the
 * catalogue of the autopilot (`autopilot.failure.transport`): the catalogue of the debug panel is imported by the panel alone, so that the app entry cannot pull it in.
 */
export type TransportTextScope = "debug.attempt" | "autopilot.failure.transport";

/**
 * What the transport saw of a call, in the facts the panels say: for a call that failed, how much arrived, when the last piece did, how the stream ended, how the provider ended the reply, whether it
 * reported the tokens and the id of the request; for one that worked, only that the tokens were not reported (its figures are then an estimate). The history of the debug panel and the error
 * panel of the autopilot say it the same way. Only what the transport has is there.
 */
export function transportBadges(transport: LlmDebugTransport, failed: boolean, language?: string, scope: TransportTextScope = "debug.attempt"): AttemptBadge[] {
  const badges: AttemptBadge[] = [];
  const status = String(transport.status ?? "—");
  if (failed && transport.bytes !== undefined) {
    badges.push(transport.bytes > 0 && transport.chunks
      ? { id: "received", key: `${scope}.received`, params: { size: formatBytes(transport.bytes), chunks: String(transport.chunks), status } }
      : { id: "received", key: `${scope}.receivedNothing`, params: { status } });
  }
  if (failed && transport.lastChunkAfterMs !== undefined && transport.silentMs !== undefined) {
    badges.push({ id: "lastChunk", key: `${scope}.lastChunk`, params: { after: formatLimit(transport.lastChunkAfterMs, language), silent: formatLimit(transport.silentMs, language) } });
  }
  if (failed && transport.end) badges.push({ id: "streamEnd", key: `${scope}.end.${transport.end}` });
  if (failed && transport.finishReason) badges.push({ id: "finishReason", key: `${scope}.finishReason`, params: { reason: transport.finishReason } });
  // The tokens say something when the provider did not report them: that is what makes the figures of the call an estimate.
  if (transport.usageReceived !== undefined && (failed || !transport.usageReceived)) {
    badges.push({ id: "usage", key: transport.usageReceived ? `${scope}.usageReported` : transport.usageRequested === false ? `${scope}.usageNotAsked` : `${scope}.usageMissing` });
  }
  if (failed && transport.requestId) badges.push({ id: "requestId", key: `${scope}.requestId`, params: { id: transport.requestId } });
  return badges;
}
