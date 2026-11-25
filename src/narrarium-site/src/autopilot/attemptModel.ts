import type { AutopilotAttemptInfo } from "narrarium-engine";

type Say = (key: string, options?: Record<string, unknown>) => string;

/**
 * What the pages say of the candidate of the AI Router that the call of the running step asks now (`AutopilotLive.trying`): which one it is (the primary, or the fallback of that
 * number), how it thinks and which request of the call this is. Pure: the words are the caller's `t`, and nothing here reads the store.
 */

/** «Primary», or «Fallback 1»: the place of the candidate in the route as the author wrote it, in words (the colour of the badge only helps). */
export function candidateWords(t: Say, trying: Pick<AutopilotAttemptInfo, "fallback" | "candidateIndex">): string {
  return trying.fallback ? t("autopilot.band.attempt.fallback", { number: trying.candidateIndex }) : t("autopilot.band.attempt.primary");
}

/** What it says of the place of the candidate when the words are not enough: the fallback is what the call goes on to when the primary does not answer or is left out. */
export function candidateHint(t: Say, trying: Pick<AutopilotAttemptInfo, "fallback" | "candidateIndex">): string {
  return trying.fallback ? t("autopilot.band.attempt.fallbackHint", { number: trying.candidateIndex }) : t("autopilot.band.attempt.primaryHint");
}

/** «Thinking: High»: the level the request carries; «Thinking: automatic» when none is chosen, «Thinking: not sent» when the model does not take the one that was. A level that is not known is said as it is. */
export function thinkingWords(t: Say, thinking: AutopilotAttemptInfo["thinking"]): string {
  if (thinking === "automatic") return t("autopilot.band.attempt.thinkingAutomatic");
  if (thinking === "not-sent") return t("autopilot.band.attempt.thinkingNotSent");
  return t("autopilot.band.attempt.thinking", { level: t(`autopilot.band.attempt.level.${thinking}`, { defaultValue: thinking }) });
}

/** «attempt 2/3», for a call that went on to another request; nothing for the first. */
export function attemptWords(t: Say, trying: Pick<AutopilotAttemptInfo, "attempt" | "attempts">): string | null {
  return trying.attempt > 1 ? t("autopilot.band.attempt.count", { attempt: trying.attempt, attempts: trying.attempts }) : null;
}

/** The candidate as a key: the same candidate twice is the same words. */
export const candidateKey = (trying: Pick<AutopilotAttemptInfo, "integrationId" | "model" | "candidateIndex">): string => `${trying.integrationId}\n${trying.model}\n${trying.candidateIndex}`;

/**
 * What the polite status says when a call goes on to a fallback: «Trying Fallback 1: muse-glimmer-30b (LlmProxy).» Said once for a fallback in a step, not each time a call
 * asks its primary first and goes on: the primary is the usual, and a status that said it at every call would never stop.
 */
export function fallbackSentence(t: Say, trying: Pick<AutopilotAttemptInfo, "candidateIndex" | "model" | "integrationName">): string {
  return t("autopilot.liveText.say.fallback", { number: trying.candidateIndex, model: trying.model, integration: trying.integrationName });
}
