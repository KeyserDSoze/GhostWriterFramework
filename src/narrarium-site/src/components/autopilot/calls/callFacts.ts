import type { TFunction } from "i18next";
import type { AiCallAttempt, AiCallRecord } from "narrarium-engine";
import { formatBytes, formatCost, formatCount, formatDuration } from "@/autopilot/format";

/** What a call used, all its provider attempts together: the tokens the providers reported, and what is known of the cost. */
export interface CallUse {
  tokens: { input: number; output: number; cached: number } | null;
  cost: number | null;
  currency: string | undefined;
}

export function useOf(record: Pick<AiCallRecord, "attempts">): CallUse {
  let tokens: CallUse["tokens"] = null;
  let cost: number | null = null;
  let currency: string | undefined;
  for (const attempt of record.attempts) {
    if (attempt.usage) {
      tokens ??= { input: 0, output: 0, cached: 0 };
      tokens.input += attempt.usage.inputTokens;
      tokens.output += attempt.usage.outputTokens;
      tokens.cached += attempt.usage.cachedInputTokens;
    }
    if (typeof attempt.cost === "number") cost = (cost ?? 0) + attempt.cost;
    currency ??= attempt.currency ?? undefined;
  }
  return { tokens, cost, currency };
}

/** The model of a call: the one of its last attempt that says one, with its provider. */
export function modelOf(record: Pick<AiCallRecord, "attempts">): { model: string | null; provider: string | null } {
  for (let index = record.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = record.attempts[index];
    if (attempt.model) return { model: attempt.model, provider: attempt.provider };
  }
  return { model: null, provider: null };
}

const time = (iso: string | null | undefined) => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : null;
};

/** How long a call took (to now, while it runs), and how long before its first words. */
export function timesOf(record: Pick<AiCallRecord, "timing">, now: number): { tookMs: number | null; firstWordsMs: number | null } {
  const started = time(record.timing.startedAt);
  if (started === null) return { tookMs: null, firstWordsMs: null };
  const ended = time(record.timing.endedAt) ?? now;
  const first = time(record.timing.firstTextAt);
  return { tookMs: Math.max(0, ended - started), firstWordsMs: first === null ? null : Math.max(0, first - started) };
}

/** The attempts that did not work, whose transport is told in figures. */
export const failedAttempts = (record: Pick<AiCallRecord, "attempts">): AiCallAttempt[] => record.attempts.filter((attempt) => attempt.outcome !== "ok");

/** The responses of a call that have text, by the number the record gives their text, each with the attempt that wrote it. */
export function textAttemptsOf(record: Pick<AiCallRecord, "attempts">): Array<{ number: number; attempt: AiCallAttempt }> {
  const seen = new Map<number, AiCallAttempt>();
  for (const attempt of record.attempts) if (attempt.textAttempt !== null && attempt.text && attempt.text.storedBytes > 0) seen.set(attempt.textAttempt, attempt);
  return [...seen.entries()].sort(([left], [right]) => left - right).map(([number, attempt]) => ({ number, attempt }));
}

/** The figures of a failed attempt, in words: what its transport saw, how it ended, its error. */
export function transportFacts(t: TFunction, attempt: AiCallAttempt): string[] {
  const facts: string[] = [];
  const transport = attempt.transport;
  if (typeof transport?.status === "number") facts.push(t("autopilot.calls.attemptFacts.http", { status: transport.status }));
  if (typeof transport?.bytes === "number") facts.push(t("autopilot.calls.attemptFacts.bytes", { size: formatBytes(transport.bytes) }));
  if (typeof transport?.chunks === "number") facts.push(t("autopilot.calls.attemptFacts.chunks", { count: transport.chunks, value: formatCount(transport.chunks) }));
  if (typeof transport?.events === "number") facts.push(t("autopilot.calls.attemptFacts.events", { count: transport.events, value: formatCount(transport.events) }));
  if (typeof attempt.firstByteMs === "number") facts.push(t("autopilot.calls.attemptFacts.firstByte", { time: formatDuration(attempt.firstByteMs) }));
  if (typeof transport?.lastChunkAfterMs === "number") facts.push(t("autopilot.calls.attemptFacts.lastChunk", { time: formatDuration(transport.lastChunkAfterMs) }));
  if (typeof transport?.silentMs === "number") facts.push(t("autopilot.calls.attemptFacts.silent", { time: formatDuration(transport.silentMs) }));
  if (transport?.end) facts.push(t(`autopilot.calls.attemptFacts.end.${transport.end}`, { defaultValue: transport.end }));
  const finish = transport?.finishReason ?? attempt.finishReason;
  if (finish) facts.push(t("autopilot.calls.attemptFacts.finish", { reason: finish }));
  if (transport?.requestId) facts.push(t("autopilot.calls.attemptFacts.request", { id: transport.requestId }));
  const partial = transport?.partialCharacters ?? attempt.partialCharacters;
  if (typeof partial === "number") facts.push(t("autopilot.calls.attemptFacts.partial", { count: partial, value: formatCount(partial) }));
  if (typeof attempt.reasoningCharacters === "number" && attempt.reasoningCharacters > 0) facts.push(t("autopilot.calls.attemptFacts.reasoning", { count: attempt.reasoningCharacters, value: formatCount(attempt.reasoningCharacters) }));
  return facts;
}

/** The error of an attempt in words, with its status when the provider answered one. */
export function errorWords(t: TFunction, attempt: AiCallAttempt): string | null {
  const error = attempt.error;
  if (!error) return null;
  const flags = [error.timedOut ? t("autopilot.calls.attemptFacts.timedOut") : "", error.transient ? t("autopilot.calls.attemptFacts.transient") : ""].filter(Boolean);
  const message = flags.length ? `${error.message} (${flags.join(", ")})` : error.message;
  return typeof error.status === "number"
    ? t("autopilot.calls.attemptFacts.errorStatus", { name: error.name, status: error.status, message })
    : t("autopilot.calls.attemptFacts.error", { name: error.name, message });
}

/** The cost of a call in words: its figure (none is «—»), or that it is not known. */
export function costWords(t: TFunction, use: CallUse): string {
  return use.cost === null ? t("autopilot.calls.call.costUnknown") : formatCost(use.cost, use.currency);
}
