import { likelyMessageTokens, likelyTextTokens, resolveModelTokenBudgets } from "./budget.js";
import type { AiNoThinkingWithTools, AiRuntimeConfig } from "./config.js";
import { redactSecrets } from "./redact.js";
import { buildChatRequest, candidateDestination, effectiveAiBase, endpointOrigin, type ChatRequest } from "./request.js";
import { describeAiRoute, type AiCandidate, type AiRouteEntry } from "./router.js";
import { AiPromptTooLargeError, AiProviderError, AiRoutingBudgetError, AiToolsRequiredError, AiUnavailableError, type AiLeftOutReason, type AiRequest, type AiRouteStep } from "./types.js";

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
  /** Position in the route as the author wrote it: 0 is the primary (a target that cannot be called keeps its place). */
  index: number;
  /** `null` when the integration cannot be called (the attempt fails with `buildError`). */
  built: ChatRequest | null;
  buildError?: AiProviderError;
  /** Tokens of the prompt, tool schema included, as estimated before sending. */
  inputTokens: number;
  estimate: AttemptEstimate;
}

/** A candidate that will not be asked, and why: with "Tools only" on, a structured request skips a model marked as without tool calls. */
export interface SkippedAttempt {
  candidate: AiCandidate;
  /** Position in the route as the author wrote it: 0 is the primary. */
  index: number;
  reason: "no-tool-calls";
}

export interface AttemptPlan {
  attempts: PlannedAttempt[];
  /** The first candidate of the route: the boundary content is meant to stay in (also when "Tools only" skips it). */
  primary: AiCandidate;
  limits: RoutingLimits;
  /** Candidates left out because `sameBoundaryOnly` keeps content inside the primary's account. */
  excludedByBoundary: number;
  /** Candidates left out because "Tools only" is on and they are marked as without tool calls; empty for a request without a function. */
  skipped: SkippedAttempt[];
  /**
   * Everything of the route that the plan leaves out, each with its place in the route and why (see `AiRouteStep`): the targets that cannot be called, the fallbacks the privacy policy
   * keeps back, the models "Tools only" skips, the ones whose context window cannot hold the prompt and the ones the routing limits cut. In the order of the route.
   */
  leftOut: AiRouteStep[];
}

/** The step that says a candidate was left out: who it is, and why (`extra` has the numbers). Names are cleaned of the credentials of the configuration. */
export function leftOutStep(candidate: AiCandidate, position: number, reason: AiLeftOutReason, secrets: readonly string[], githubModelsBaseUrl?: string, extra: Partial<AiRouteStep> = {}): AiRouteStep {
  const { endpoint, path, protocol } = candidateDestination(candidate, githubModelsBaseUrl);
  return {
    position,
    integrationId: redactSecrets(candidate.integration.id, secrets),
    integrationName: redactSecrets(candidate.integration.name, secrets),
    provider: candidate.integration.provider,
    model: redactSecrets(candidate.model, secrets),
    outcome: "left-out",
    ...(endpoint ? { endpoint } : {}),
    ...(path ? { path: redactSecrets(path, secrets) } : {}),
    ...(protocol ? { protocol } : {}),
    leftOut: reason,
    ...extra,
  };
}

/** The route of a failed plan, in the order the author wrote it: what a host puts on the error it ends with. */
export function sortedRoute(steps: readonly AiRouteStep[]): AiRouteStep[] {
  return [...steps].sort((left, right) => left.position - right.position);
}

function withRoute<E extends Error>(error: E, steps: readonly AiRouteStep[]): E {
  if (steps.length) (error as E & { route?: AiRouteStep[] }).route = sortedRoute(steps);
  return error;
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

/** The step that says a target of the route cannot be called at all: who it is as far as the configuration knows it, and why. */
function unusableStep(entry: AiRouteEntry, config: AiRuntimeConfig, secrets: readonly string[], githubModelsBaseUrl?: string): AiRouteStep {
  const target = entry.target;
  const integration = config.aiIntegrations.find((candidate) => candidate.id === target?.integrationId);
  const endpoint = integration ? endpointOrigin(effectiveAiBase(integration, githubModelsBaseUrl)) : undefined;
  return {
    position: entry.position,
    integrationId: redactSecrets(target?.integrationId ?? "", secrets),
    integrationName: redactSecrets(integration?.name ?? target?.integrationId ?? "", secrets),
    provider: integration?.provider ?? "",
    model: redactSecrets(target?.model ?? "", secrets),
    outcome: "left-out",
    ...(endpoint ? { endpoint } : {}),
    leftOut: "unusable",
    ...(entry.unusable ? { why: entry.unusable } : {}),
  };
}

/** What the author reads when a route is written and none of its targets can be called. */
function unusableMessage(capability: string, steps: readonly AiRouteStep[]): string {
  const why: Record<NonNullable<AiRouteStep["why"]>, string> = {
    "integration-missing": "its integration is no longer there",
    "provider-unsupported": "its provider cannot run chat tasks here",
    "model-missing": "the model is not in the integration",
    "task-not-allowed": "the model is not allowed for this task",
  };
  const list = steps.map((step) => `"${step.model}" in "${step.integrationName}" (${step.why ? why[step.why] : "it cannot be called"})`).join("; ");
  return `No model of the route of the "${capability}" task can be called: ${list}. Fix the route in the AI router or the models in AI Integrations. Nothing was sent.`;
}

/**
 * The candidates a call will try, in order, with the request each would get: the route's order, minus the targets that cannot be called, minus the fallbacks the
 * privacy policy excludes, minus (for a structured request, with "Tools only" on, which is the default) the models marked as without
 * tool calls, minus the candidates whose context window cannot hold the prompt (a prompt is never cut),
 * kept while the estimated attempts stay within the token and cost limits. A prompt no window holds, a first attempt
 * that alone exceeds the limits, or a route where no model can call a function, is refused before anything is sent.
 * The privacy policy is applied to the whole route first, so a primary that is skipped is still the account content is meant to stay in.
 * Whatever is left out has its place in the route and its reason in `leftOut`, and in the `route` of the error when nothing is left to ask: a candidate is never dropped without a word.
 */
export function planAttempts(config: AiRuntimeConfig, request: AiRequest, githubModelsBaseUrl?: string): AttemptPlan {
  const entries = describeAiRoute(config, request.capability);
  const resolved = entries.flatMap((entry) => (entry.candidate ? [entry.candidate] : []));
  const secrets = config.aiIntegrations.map((integration) => integration.apiKey);
  const leftOut: AiRouteStep[] = entries.filter((entry) => entry.unusable).map((entry) => unusableStep(entry, config, secrets, githubModelsBaseUrl));
  if (!resolved.length) {
    const unavailable = new AiUnavailableError(request.capability, leftOut.length ? redactSecrets(unusableMessage(request.capability, leftOut), secrets) : undefined);
    throw withRoute(unavailable, leftOut);
  }
  const positions = new Map<AiCandidate, number>(entries.flatMap((entry) => (entry.candidate ? [[entry.candidate, entry.position] as [AiCandidate, number]] : [])));
  const place = (candidate: AiCandidate): number => positions.get(candidate) ?? 0;
  const limits = routingLimits(config);
  const inBoundary = applySameBoundaryPolicy(config, resolved);
  for (const candidate of resolved) if (!inBoundary.includes(candidate)) leftOut.push(leftOutStep(candidate, place(candidate), "boundary", secrets, githubModelsBaseUrl));
  const toolsOnly = config.toolsOnly !== false && Boolean(request.json);
  const skipped: SkippedAttempt[] = [];
  const allowed = inBoundary.filter((candidate) => {
    if (!toolsOnly || candidate.supportsToolCalls !== false) return true;
    skipped.push({ candidate, index: place(candidate), reason: "no-tool-calls" });
    leftOut.push(leftOutStep(candidate, place(candidate), "no-tool-calls", secrets, githubModelsBaseUrl));
    return false;
  });
  if (!allowed.length) {
    throw withRoute(new AiToolsRequiredError(
      redactSecrets(toolsRequiredMessage(skipped), secrets),
      skipped.map((entry) => redactSecrets(entry.candidate.model, secrets)),
      skipped.map((entry) => ({ integration: entry.candidate.integration.id, model: redactSecrets(entry.candidate.model, secrets) })),
    ), leftOut);
  }
  const planned: PlannedAttempt[] = allowed.map((entry) => {
    const index = place(entry);
    // What the host has learned of the model (see `AiModelMemory`) is applied as if the author had set it: a model known to refuse thinking with tools is not sent a level with them.
    const remembered = request.memory?.noThinkingWithTools(entry.integration.id, entry.model);
    const how: AiNoThinkingWithTools | undefined = remembered === "none" || entry.noThinkingWithTools === "none" ? "none" : entry.noThinkingWithTools ?? remembered;
    // The same for the prompt caching: a model that answered with tokens served from its cache is known to cache (unless the author said otherwise), and a provider that refused the hints is not sent them again.
    const learnedCaching = entry.promptCaching === undefined ? request.memory?.promptCaching?.(entry.integration.id, entry.model) : undefined;
    const hintsRefused = request.memory?.promptCacheHintsRefused?.(entry.integration.id, entry.model) === true;
    const candidate = how !== entry.noThinkingWithTools || learnedCaching || hintsRefused
      ? { ...entry, ...(how !== entry.noThinkingWithTools ? { noThinkingWithTools: how } : {}), ...(learnedCaching ? { promptCaching: learnedCaching } : {}), ...(hintsRefused ? { promptCacheHintsRefused: true } : {}) }
      : entry;
    try {
      const built = buildChatRequest(candidate, request, { githubModelsBaseUrl, promptCacheHints: config.promptCacheHints });
      const tools = built.useTools ? likelyTextTokens(JSON.stringify(built.body.tools)) + 8 : 0;
      const inputTokens = likelyMessageTokens(built.messages) + tools;
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
    leftOut.push(leftOutStep(attempt.candidate, attempt.index, "context-window", secrets, githubModelsBaseUrl, { promptTokens: attempt.inputTokens, windowTokens: available }));
    return false;
  });
  if (!fitting.length) {
    throw withRoute(new AiPromptTooLargeError(
      `The prompt (about ${estimated} tokens) is larger than the context window configured for every model routed to this task (largest input budget: ${largestBudget} tokens, after the output reserve and a 5% safety margin). Nothing was sent. Raise the models' context window ("maxInputTokens") if they support more, or route this task to a model with a larger context window.`,
      estimated,
      largestBudget,
    ), leftOut);
  }

  const attempts: PlannedAttempt[] = [];
  let tokens = 0;
  let cost = 0;
  for (const [at, attempt] of fitting.entries()) {
    const overTokens = limits.maxTokenAttempts !== undefined && tokens + attempt.estimate.tokens > limits.maxTokenAttempts;
    const overCost = limits.maxEstimatedCost !== undefined && cost + attempt.estimate.cost > limits.maxEstimatedCost;
    if (overTokens || overCost) {
      for (const rest of fitting.slice(at)) leftOut.push(leftOutStep(rest.candidate, rest.index, "budget", secrets, githubModelsBaseUrl));
      if (!attempts.length) throw withRoute(new AiRoutingBudgetError("The first routing candidate exceeds the configured token-attempt or estimated-cost budget (maxTokenAttempts, maxEstimatedCost). Nothing was sent."), leftOut);
      break;
    }
    attempts.push(attempt);
    tokens += attempt.estimate.tokens;
    cost += attempt.estimate.cost;
  }
  return { attempts, primary: resolved[0], limits, excludedByBoundary: resolved.length - inBoundary.length, skipped, leftOut: sortedRoute(leftOut) };
}

function toolsRequiredMessage(skipped: readonly SkippedAttempt[]): string {
  const models = skipped.map(({ candidate }) => `"${candidate.model}" in "${candidate.integration.name}"`).join(", ");
  return `"Tools only" is on, and every model this task can use is marked as without tool calls (${models}), so a structured answer has nowhere to go. Turn on "Forced tool calls" for the model in AI Integrations, or turn off "Tools only" in the AI Router. Nothing was sent.`;
}
