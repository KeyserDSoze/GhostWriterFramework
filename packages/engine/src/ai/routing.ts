import { likelyMessageTokens, likelyTextTokens, resolveModelTokenBudgets } from "./budget.js";
import type { AiRuntimeConfig } from "./config.js";
import { buildChatRequest, type ChatRequest } from "./request.js";
import { resolveAiCandidates, type AiCandidate } from "./router.js";
import { AiPromptTooLargeError, AiProviderError, AiRoutingBudgetError, AiUnavailableError, type AiRequest } from "./types.js";

/** What a fallback's privacy boundary is: the integration (one provider account). Same as the web app's `candidateBoundary`. */
export function candidateBoundary(candidate: Pick<AiCandidate, "integration">): string {
  return `integration:${candidate.integration.id}`;
}

/** With `sameBoundaryOnly`, only the candidates in the primary's boundary remain. */
export function applySameBoundaryPolicy<C extends Pick<AiCandidate, "integration">>(config: Pick<AiRuntimeConfig, "fallbackDisclosure">, candidates: C[]): C[] {
  if (!config.fallbackDisclosure?.sameBoundaryOnly || candidates.length < 2) return candidates;
  const primary = candidateBoundary(candidates[0]);
  return candidates.filter((candidate) => candidateBoundary(candidate) === primary);
}

/** The limits of one routed call; a limit that is `undefined` does not apply. */
export interface RoutingLimits {
  maxTotalDurationMs?: number;
  maxTokenAttempts?: number;
  maxEstimatedCost?: number;
}

export interface AttemptEstimate {
  tokens: number;
  cost: number;
}

/** A candidate with the request it would be sent and what that attempt would use at most. */
export interface PlannedAttempt {
  candidate: AiCandidate;
  /** Position in the route's order: 0 is the primary. */
  index: number;
  /** `null` when the integration cannot be called (the attempt fails with `buildError`). */
  built: ChatRequest | null;
  buildError?: AiProviderError;
  /** Tokens of the prompt, tool schema included, as estimated before sending. */
  inputTokens: number;
  estimate: AttemptEstimate;
}

export interface AttemptPlan {
  attempts: PlannedAttempt[];
  /** The first candidate of the route: the boundary content is meant to stay in. */
  primary: AiCandidate;
  limits: RoutingLimits;
  /** Candidates left out because `sameBoundaryOnly` keeps content inside the primary's account. */
  excludedByBoundary: number;
}

export function routingLimits(config: AiRuntimeConfig): RoutingLimits {
  const execution = config.routingExecution;
  return { maxTotalDurationMs: execution?.maxTotalDurationMs, maxTokenAttempts: execution?.maxTokenAttempts, maxEstimatedCost: execution?.maxEstimatedCost };
}

function estimateAttempt(candidate: AiCandidate, inputTokens: number, outputLimit: number | undefined): AttemptEstimate {
  const output = resolveModelTokenBudgets(candidate.maxInputTokens, outputLimit).outputTokens;
  return {
    tokens: inputTokens + output,
    cost: candidate.pricing ? inputTokens / 1_000_000 * (candidate.pricing.inputPerMTok ?? 0) + output / 1_000_000 * (candidate.pricing.outputPerMTok ?? 0) : 0,
  };
}

/**
 * The candidates a call will try, in order, with the request each would get: the route's order, minus the fallbacks the
 * privacy policy excludes, minus the candidates whose context window cannot hold the prompt (a prompt is never cut),
 * kept while the estimated attempts stay within the token and cost limits. A prompt no window holds, or a first attempt
 * that alone exceeds the limits, is refused before anything is sent.
 */
export function planAttempts(config: AiRuntimeConfig, request: AiRequest, githubModelsBaseUrl?: string): AttemptPlan {
  const resolved = resolveAiCandidates(config, request.capability);
  if (!resolved.length) throw new AiUnavailableError(request.capability);
  const limits = routingLimits(config);
  const allowed = applySameBoundaryPolicy(config, resolved);
  const planned: PlannedAttempt[] = allowed.map((candidate) => {
    const index = resolved.indexOf(candidate);
    try {
      const built = buildChatRequest(candidate, request, { githubModelsBaseUrl });
      const tools = built.useTools ? likelyTextTokens(JSON.stringify(built.body.tools)) + 8 : 0;
      const inputTokens = likelyMessageTokens(built.body.messages as Array<{ content: string }>) + tools;
      return { candidate, index, built, inputTokens, estimate: estimateAttempt(candidate, inputTokens, built.outputLimit) };
    } catch (error) {
      return { candidate, index, built: null, buildError: error instanceof AiProviderError ? error : new AiProviderError(error instanceof Error ? error.message : String(error)), inputTokens: 0, estimate: { tokens: 0, cost: 0 } };
    }
  });

  let largestBudget = 0;
  let estimated = 0;
  const fitting = planned.filter((attempt) => {
    if (!attempt.built || !attempt.candidate.maxInputTokens) return true;
    const available = resolveModelTokenBudgets(attempt.candidate.maxInputTokens, attempt.built.outputLimit).inputTokens;
    if (attempt.inputTokens <= available) return true;
    largestBudget = Math.max(largestBudget, available);
    estimated = Math.max(estimated, attempt.inputTokens);
    return false;
  });
  if (!fitting.length) {
    throw new AiPromptTooLargeError(
      `The prompt (about ${estimated} tokens) is larger than the context window configured for every model routed to this task (largest input budget: ${largestBudget} tokens, after the output reserve and a 5% safety margin). Nothing was sent. Raise the models' context window ("maxInputTokens") if they support more, or route this task to a model with a larger context window.`,
      estimated,
      largestBudget,
    );
  }

  const attempts: PlannedAttempt[] = [];
  let tokens = 0;
  let cost = 0;
  for (const attempt of fitting) {
    const overTokens = limits.maxTokenAttempts !== undefined && tokens + attempt.estimate.tokens > limits.maxTokenAttempts;
    const overCost = limits.maxEstimatedCost !== undefined && cost + attempt.estimate.cost > limits.maxEstimatedCost;
    if (overTokens || overCost) {
      if (!attempts.length) throw new AiRoutingBudgetError("The first routing candidate exceeds the configured token-attempt or estimated-cost budget (maxTokenAttempts, maxEstimatedCost). Nothing was sent.");
      break;
    }
    attempts.push(attempt);
    tokens += attempt.estimate.tokens;
    cost += attempt.estimate.cost;
  }
  return { attempts, primary: resolved[0], limits, excludedByBoundary: resolved.length - allowed.length };
}
