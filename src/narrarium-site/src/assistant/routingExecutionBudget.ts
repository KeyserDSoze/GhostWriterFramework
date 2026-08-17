import type { AIPricing, AppSettings } from "@/types/settings";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { textTokenUpperBound } from "@/assistant/promptBudget";

export class RoutingExecutionBudgetError extends Error {
  constructor(message: string) { super(message); this.name = "RoutingExecutionBudgetError"; }
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
  reserve(estimate: RoutingAttemptEstimate): void;
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
    reserve(estimate) {
      controller.signal.throwIfAborted();
      const nextTokens = tokens + Math.max(0, estimate.tokens);
      const nextCost = cost + Math.max(0, estimate.cost);
      if (nextTokens > limits.maxTokenAttempts || nextCost > limits.maxEstimatedCost) {
        const error = new RoutingExecutionBudgetError("The total routing token-attempt or estimated-cost budget was exhausted.");
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
