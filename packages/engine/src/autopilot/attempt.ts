import type { FetchAiAttempt } from "../ai/fetch-client.js";
import type { AutopilotAttemptInfo } from "./types.js";

/** The longest name a client keeps of an integration, a model or a thinking level: a configuration that a person wrote, never a place for text. */
const NAME_CHARACTERS = 160;

const whole = (value: unknown, least: number): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= least ? value : undefined);
const word = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.slice(0, NAME_CHARACTERS) : undefined);

/**
 * The attempt in flight as a client may keep it, from something read from elsewhere (an event, the snapshot of a host that is not this one): its fields as `AutopilotAttemptInfo` has them, or
 * `undefined` when it does not say which candidate it is. Names are cut at a sane length, `fallback` is always `candidateIndex` above 0, and a thinking level this engine does not know is kept as it
 * is (a newer host may have one): a client shows the word.
 */
export function normalizeAttempt(value: unknown): AutopilotAttemptInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const attempt = whole(source.attempt, 1);
  const candidateIndex = whole(source.candidateIndex, 0);
  const integrationId = word(source.integrationId);
  const integrationName = word(source.integrationName) ?? integrationId;
  const model = word(source.model);
  const thinking = word(source.thinking);
  if (attempt === undefined || candidateIndex === undefined || !integrationId || !integrationName || !model || !thinking) return undefined;
  return {
    attempt,
    attempts: Math.max(attempt, whole(source.attempts, 1) ?? attempt),
    candidateIndex,
    candidateCount: Math.max(candidateIndex + 1, whole(source.candidateCount, 1) ?? candidateIndex + 1),
    fallback: candidateIndex > 0,
    integrationId,
    integrationName,
    provider: word(source.provider) ?? "",
    model,
    thinking: thinking as AutopilotAttemptInfo["thinking"],
    streamMode: source.streamMode === "off" ? "off" : "auto",
  };
}

/** What the client says of the attempt it is about to send (the `call-attempt` event), without the prompt it carries, and nothing of the key: names and numbers. `undefined` when the report says too little. */
export function attemptInfoOf(report: FetchAiAttempt): AutopilotAttemptInfo | undefined {
  return normalizeAttempt({
    attempt: report.attempt,
    attempts: report.attempts,
    candidateIndex: report.index,
    candidateCount: report.candidates,
    integrationId: report.integrationId,
    integrationName: report.integrationName,
    provider: report.provider,
    model: report.model,
    thinking: report.thinkingMode,
    streamMode: report.streamMode,
  });
}
