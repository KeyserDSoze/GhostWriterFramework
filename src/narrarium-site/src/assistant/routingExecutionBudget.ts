import type { AIPricing, AppSettings } from "@/types/settings";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { textTokenUpperBound } from "@/assistant/promptBudget";

/**
 * Which limit of the AI router stopped a call, and by how much (the engine's `AiRoutingBudgetDetail`, the same fields): `tokens` is `maxTokenAttempts`, `cost` is `maxEstimatedCost`;
 * `estimated` is what the call would have needed, `allowed` the limit. What the chat and the autopilot's panel offer to raise, in Settings > AI Router > Routing options.
 */
export interface RoutingBudgetDetail {
  limit: "tokens" | "cost";
  estimated: number;
  allowed: number;
}

export class RoutingExecutionBudgetError extends Error {
  readonly budget?: RoutingBudgetDetail;
  constructor(message: string, budget?: RoutingBudgetDetail) {
    super(message);
    this.name = "RoutingExecutionBudgetError";
    if (budget) this.budget = budget;
  }
}

/**
 * A failure the limits of the router or the window of the models made: a request no model can hold, a refusal of an older engine, or a call whose fallbacks a routing limit left
 * out (`budget`). The same for every call of the request, so it is told to the author, never answered around (the keyword rules would answer as if nothing had been asked). By
 * name and fields, for the engine's errors cross a module boundary.
 */
export function isRoutingLimitError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const budget = error && typeof error === "object" ? (error as { budget?: unknown }).budget : undefined;
  return name === "RoutingExecutionBudgetError" || name === "AiRoutingBudgetError" || name === "PromptBudgetExceededError" || name === "AiPromptTooLargeError" || Boolean(budget && typeof budget === "object");
}

export interface RoutingBudgetCandidate {
  pricing?: AIPricing;
}

export interface RoutingAttemptEstimate {
  tokens: number;
  cost: number;
}

export interface RoutingExecutionBudget {
  signal: AbortSignal;
  /**
   * Reserves an attempt. The first attempt of a call (`first`) is bounded by its model alone and is not counted; the limits are a safety for what the fallbacks after it add
   * together, and a fallback over them is refused with the limit and its numbers.
   */
  reserve(estimate: RoutingAttemptEstimate, options?: { first?: boolean }): void;
  dispose(): void;
}

export function createRoutingExecutionBudget(settings: AppSettings, parent?: AbortSignal): RoutingExecutionBudget {
  const limits = settings.routingExecution ?? DEFAULT_SETTINGS.routingExecution;
  const controller = new AbortController();
  let tokens = 0;
  let cost = 0;
  const abort = () => controller.abort(parent?.reason ?? new DOMException("Aborted", "AbortError"));
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new RoutingExecutionBudgetError("The total routing time budget was exhausted.")), limits.maxTotalDurationMs);
  return {
    signal: controller.signal,
    reserve(estimate, options) {
      controller.signal.throwIfAborted();
      if (options?.first) return;
      const nextTokens = tokens + Math.max(0, estimate.tokens);
      const nextCost = cost + Math.max(0, estimate.cost);
      if (nextTokens > limits.maxTokenAttempts || nextCost > limits.maxEstimatedCost) {
        const costOver = nextCost > limits.maxEstimatedCost;
        const error = new RoutingExecutionBudgetError(
          costOver
            ? `The fallbacks after the first attempt were not tried: they would be estimated at ${nextCost.toFixed(3)} together, and the limit is ${limits.maxEstimatedCost} ("Maximum estimated route cost" in Settings > AI Router > Routing options).`
            : `The fallbacks after the first attempt were not tried: they would use about ${nextTokens} tokens together, and the limit is ${limits.maxTokenAttempts} ("Maximum token attempts" in Settings > AI Router > Routing options).`,
          costOver ? { limit: "cost", estimated: nextCost, allowed: limits.maxEstimatedCost } : { limit: "tokens", estimated: nextTokens, allowed: limits.maxTokenAttempts },
        );
        controller.abort(error);
        throw error;
      }
      tokens = nextTokens;
      cost = nextCost;
    },
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export function estimateTtsAttempt(text: string, candidate: RoutingBudgetCandidate): RoutingAttemptEstimate {
  return {
    tokens: textTokenUpperBound(text),
    cost: text.length / 1_000_000 * (candidate.pricing?.ttsPerMChar ?? 0),
  };
}

export function estimateSttAttempt(blob: Blob, candidate: RoutingBudgetCandidate): RoutingAttemptEstimate {
  const estimatedHours = blob.size > 0 ? blob.size / (16_000 * 3_600) : 0;
  return {
    tokens: Math.max(1, Math.ceil(blob.size / 4)),
    cost: estimatedHours * (candidate.pricing?.sttPerHour ?? 0),
  };
}

export function estimateImageAttempt(prompt: string, candidate: RoutingBudgetCandidate): RoutingAttemptEstimate {
  const inputTokens = textTokenUpperBound(prompt);
  const outputTokens = 4_096;
  return {
    tokens: inputTokens + outputTokens,
    cost: inputTokens / 1_000_000 * (candidate.pricing?.imageInputTextPerMTok ?? 0)
      + outputTokens / 1_000_000 * (candidate.pricing?.imageOutputPerMTok ?? 0),
  };
}
