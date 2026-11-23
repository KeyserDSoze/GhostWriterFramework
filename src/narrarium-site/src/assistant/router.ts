import type { AIIntegration, AIPricing, AppSettings, ChatCapability, ReasoningParameter, RoutingTarget, RoutingTaskKind, TaskRoute, ThinkingLevel } from "@/types/settings";
import { AiProviderError, splitReasoningBlock, type FetchAiAttemptEnd } from "narrarium-engine";
import { effectiveThinking } from "@/router/thinking";
import { integrationChatModels, modelSupportsCapability, resolveReviewIntegration, resolveWritingIntegration, CONFIRMATION_TOOL_DEFINITION, type ForcedToolDefinition, type LlmFinishReport, type LlmMessage, type LlmResult, type LlmUsageReport } from "@/assistant/llm";
import { executeCompletionFallback } from "@/assistant/completionFallback";
import { budgetLlmMessages, likelyMessageTokens, resolveModelTokenBudgets } from "@/assistant/promptBudget";
import { announceRetry } from "@/assistant/retryNotice";
import { engineOutputLimit, jsonInstructionTokens, requestedOutput, runCopilotAttempt, runMetadata, startRoutingClock, toolsOnly, toolsRequiredError, toolTokens, usageReport, type ChatCandidate, type SkippedModels } from "@/assistant/copilotAi";
import { acknowledgeCrossBoundaryFallback, applySameBoundaryPolicy } from "@/assistant/fallbackDisclosure";
import { beginAccountScopedAiOperation } from "@/assistant/accountScopedOperation";
import { currentRequest } from "@/assistant/promptTrust";
import { RoutingExecutionBudgetError } from "@/assistant/routingExecutionBudget";

export { RoutingExecutionBudgetError } from "@/assistant/routingExecutionBudget";

export type RoutedLlmRunMetadata = LlmResult<unknown>["metadata"] & { routeCandidateIndex: number; usedFallback: boolean };

/** Reserved integrationId meaning "use the browser engine" (TTS/STT only). */
export const BROWSER_ROUTING_ID = "__browser__";

export interface TaskCandidate {
  /** Present for real AI integrations; absent when browser === true. */
  integration?: AIIntegration;
  model?: string;
  pricing?: AIPricing;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  underlyingModel?: string;
  supportsToolCalls?: boolean;
  /** Chat only: the level this attempt goes out with (the target's own, else the integration's); only an explicit level is sent. */
  thinking?: ThinkingLevel;
  /** Chat only: how that level is sent to this model (the "Thinking parameter" of the model); absent: `reasoning_effort`. */
  reasoningParameter?: ReasoningParameter;
  /** True for the browser TTS/STT engine (no integration). */
  browser?: boolean;
}

export class NoCompletionCandidatesError extends Error {
  constructor() {
    super("No AI integration configured for this task.");
    this.name = "NoCompletionCandidatesError";
  }
}

export class StaleRoutingConfigurationError extends Error {
  constructor(task: RoutingTaskKind) {
    super(`The configured ${task} route no longer references an available compatible model.`);
    this.name = "StaleRoutingConfigurationError";
  }
}

export class CandidateInputBudgetError extends Error {
  constructor() {
    super("Candidate input budget exhausted: the forced-tool schema and required message do not fit.");
    this.name = "CandidateInputBudgetError";
  }
}

/**
 * With `overflow: "fail"` a prompt is never cut in the middle (an autopilot prompt would silently
 * lose part of its data, such as findings). It is refused only when it clearly exceeds the context
 * window configured for every routed model; a model with no configured window gets it whole and the
 * provider answers if it is too long.
 */
export class PromptBudgetExceededError extends Error {
  constructor(readonly estimatedTokens: number, readonly largestBudget: number) {
    super(`The prompt (about ${estimatedTokens} tokens) is larger than the context window configured for every model routed to this task (largest input budget: ${largestBudget} tokens). Nothing was sent. Raise the models' "Context window tokens" in the AI settings if they support more, or route this task to a model with a larger context window.`);
    this.name = "PromptBudgetExceededError";
  }
}

/** How routed calls treat a prompt larger than a candidate's input budget. */
export type PromptOverflow = "truncate" | "fail";

/** The input a candidate has room for once the engine's limit for the reply (not the Copilot's own, which the engine raises) and the reserve are taken out of its window. */
function inputRoom(candidate: TaskCandidate, outputTokens: number, reservedTokens = 0): number {
  return resolveModelTokenBudgets(candidate.maxInputTokens, outputTokens).inputTokens - reservedTokens;
}

/** The messages of a forced call, cut to what the window of the candidate holds after the schema: the engine sends it as the only tool of the request. */
function budgetForcedToolMessages(messages: LlmMessage[], candidate: TaskCandidate, outputTokens: number, tool: ForcedToolDefinition, extraReserve = 0): LlmMessage[] {
  const inputTokens = resolveModelTokenBudgets(candidate.maxInputTokens, outputTokens).inputTokens;
  const reserve = toolTokens(tool).atMost + extraReserve;
  if (reserve > inputTokens) throw new CandidateInputBudgetError();
  const budgeted = budgetLlmMessages(messages, candidate.maxInputTokens, outputTokens, reserve);
  if (messages.length > 0 && budgeted.length === 0) throw new CandidateInputBudgetError();
  return budgeted;
}

const CHAT_CAPABILITIES_SET = new Set<RoutingTaskKind>(["default", "editor-actions", "copilot", "simple-tasks", "review", "chat-resume", "reader-evaluation", "reader-evaluation-summary", "rewrite-from-reader-feedback", "deep-research", "create-from-research", "audit", "autopilot", "director"]);

function isChatTask(task: RoutingTaskKind): task is ChatCapability {
  return CHAT_CAPABILITIES_SET.has(task);
}

function findIntegration(settings: AppSettings, id: string): AIIntegration | undefined {
  return (settings.aiIntegrations ?? []).find((i) => i.id === id);
}

function mediaModel(integration: AIIntegration, task: RoutingTaskKind): string | undefined {
  return task === "tts" ? integration.modelTextToSpeech?.trim()
    : task === "stt" ? integration.modelSpeechToText?.trim()
    : task === "image" ? integration.modelImageGeneration?.trim()
    : undefined;
}

/** Return why a saved target is unusable, or null when it is executable. */
export function routingTargetIssue(integrations: AIIntegration[], task: RoutingTaskKind, target: RoutingTarget): string | null {
  if (target.integrationId === BROWSER_ROUTING_ID) {
    if (task !== "tts" && task !== "stt") return "The browser engine only supports speech tasks.";
    return target.model === "browser" ? null : "The browser route has an invalid model.";
  }
  const integration = integrations.find((entry) => entry.id === target.integrationId);
  if (!integration) return "The selected integration no longer exists.";
  if (!target.model?.trim()) return "The selected model is empty.";
  if (isChatTask(task)) {
    if (integration.provider === "m365_copilot") return "This integration cannot run browser chat tasks.";
    return integrationChatModels(integration).some((model) => model.name === target.model.trim() && modelSupportsCapability(model, task))
      ? null
      : "The selected chat model no longer exists in this integration.";
  }
  if (integration.provider !== "openai" && integration.provider !== "azure_openai") return "This integration does not support media tasks.";
  return mediaModel(integration, task) === target.model.trim()
    ? null
    : "The selected media model no longer exists in this integration.";
}

export function routingIssues(routing: AppSettings["taskRouting"], integrations: AIIntegration[]): Array<{ task: RoutingTaskKind; target: RoutingTarget; message: string }> {
  const issues: Array<{ task: RoutingTaskKind; target: RoutingTarget; message: string }> = [];
  for (const [task, route] of Object.entries(routing ?? {}) as Array<[RoutingTaskKind, TaskRoute]>) {
    for (const target of [...(route.primary ? [route.primary] : []), ...(route.fallbacks ?? [])]) {
      const message = routingTargetIssue(integrations, task, target);
      if (message) issues.push({ task, target, message });
    }
  }
  return issues;
}

/** Remove incompatible targets while retaining every unaffected fallback. */
export function sanitizeTaskRouting(routing: AppSettings["taskRouting"], integrations: AIIntegration[]): AppSettings["taskRouting"] {
  const out: NonNullable<AppSettings["taskRouting"]> = {};
  for (const [task, route] of Object.entries(routing ?? {}) as Array<[RoutingTaskKind, TaskRoute]>) {
    const primary = route.primary && !routingTargetIssue(integrations, task, route.primary) ? route.primary : undefined;
    const fallbacks = (route.fallbacks ?? []).filter((target) => !routingTargetIssue(integrations, task, target));
    if (primary || fallbacks.length) out[task] = { primary, fallbacks };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Update model-name references by stable model id, then remove targets invalidated by integration edits. */
export function reconcileTaskRouting(
  routing: AppSettings["taskRouting"],
  previousIntegrations: AIIntegration[],
  nextIntegrations: AIIntegration[],
): AppSettings["taskRouting"] {
  const rewritten: NonNullable<AppSettings["taskRouting"]> = {};
  const rewrite = (task: RoutingTaskKind, target: RoutingTarget): RoutingTarget => {
    if (target.integrationId === BROWSER_ROUTING_ID) return target;
    const previous = previousIntegrations.find((entry) => entry.id === target.integrationId);
    const next = nextIntegrations.find((entry) => entry.id === target.integrationId);
    if (!previous || !next) return target;
    if (isChatTask(task)) {
      const previousModel = integrationChatModels(previous).find((model) => model.name === target.model);
      const renamed = previousModel && integrationChatModels(next).find((model) => model.id === previousModel.id);
      return renamed ? { ...target, model: renamed.name } : target;
    }
    const oldModel = mediaModel(previous, task);
    const nextModel = mediaModel(next, task);
    return oldModel === target.model && nextModel ? { ...target, model: nextModel } : target;
  };
  for (const [task, route] of Object.entries(routing ?? {}) as Array<[RoutingTaskKind, TaskRoute]>) {
    rewritten[task] = {
      primary: route.primary ? rewrite(task, route.primary) : undefined,
      fallbacks: (route.fallbacks ?? []).map((target) => rewrite(task, target)),
    };
  }
  return sanitizeTaskRouting(rewritten, nextIntegrations);
}

/** Chat: pricing = model's own price, else integration price. */
function chatCandidateFromTarget(settings: AppSettings, target: RoutingTarget, task: ChatCapability, ownThinking = true): TaskCandidate | null {
  const integration = findIntegration(settings, target.integrationId);
  if (!integration || integration.provider === "m365_copilot") return null;
  const model = target.model?.trim();
  if (!model) return null;
  const modelEntry = integrationChatModels(integration).find((m) => m.name === model);
  if (!modelEntry || !modelSupportsCapability(modelEntry, task)) return null;
  return { integration, model, pricing: modelEntry.pricing ?? integration.pricing, maxInputTokens: modelEntry.maxInputTokens, maxOutputTokens: modelEntry.maxOutputTokens, underlyingModel: modelEntry.underlyingModel, supportsToolCalls: modelEntry.supportsToolCalls, thinking: effectiveThinking(ownThinking ? target : undefined, integration), reasoningParameter: modelEntry.reasoningParameter };
}

/** Media (tts/stt/image): the browser engine, or an OpenAI/Azure integration. */
function mediaCandidateFromTarget(settings: AppSettings, target: RoutingTarget, task: RoutingTaskKind): TaskCandidate | null {
  if (target.integrationId === BROWSER_ROUTING_ID) {
    // Browser engine is only meaningful for tts/stt, never images.
    return task === "image" ? null : { browser: true };
  }
  const integration = findIntegration(settings, target.integrationId);
  if (!integration) return null;
  if (integration.provider !== "openai" && integration.provider !== "azure_openai") return null;
  const model = target.model?.trim();
  if (!model) return null;
  if (mediaModel(integration, task) !== model) return null;
  return { integration, model, pricing: integration.pricing };
}

function dedupe(candidates: TaskCandidate[]): TaskCandidate[] {
  const seen = new Set<string>();
  const out: TaskCandidate[] = [];
  for (const c of candidates) {
    const key = c.browser ? "browser" : `${c.integration?.id}::${c.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Router-configured targets (primary then fallbacks) for a task, mapped to candidates. */
function routerCandidates(settings: AppSettings, task: RoutingTaskKind): TaskCandidate[] {
  const inheritedDefault = task === "editor-actions" && !settings.taskRouting?.[task];
  const route = settings.taskRouting?.[task] ?? (inheritedDefault ? settings.taskRouting?.default : undefined);
  if (!route) return [];
  const targets: RoutingTarget[] = [...(route.primary ? [route.primary] : []), ...(route.fallbacks ?? [])];
  // The Default route only chooses where the tasks without a route go, whether they inherit it or it is asked for itself: its level of thinking is not used, the integration's is.
  const ownThinking = task !== "default" && !inheritedDefault;
  const mapped = targets.map((target) => isChatTask(task)
    ? chatCandidateFromTarget(settings, target, inheritedDefault ? "default" : task, ownThinking)
    : mediaCandidateFromTarget(settings, target, task));
  return mapped.filter((c): c is TaskCandidate => Boolean(c));
}

function hasConfiguredRoute(settings: AppSettings, task: RoutingTaskKind): boolean {
  const route = settings.taskRouting?.[task] ?? (task === "editor-actions" ? settings.taskRouting?.default : undefined);
  return Boolean(route?.primary || route?.fallbacks?.length);
}

/** Legacy chat resolution tiers. Review honors its configured default before capability tags. */
function legacyChatCandidates(settings: AppSettings, capability: ChatCapability): TaskCandidate[] {
  const integrations = settings.aiIntegrations ?? [];
  const out: TaskCandidate[] = [];
  const push = (integration: AIIntegration, model?: string, pricing?: AIPricing) => {
    if (!model || integration.provider === "m365_copilot") return;
    const entry = integrationChatModels(integration).find((candidate) => candidate.name === model);
    out.push({ integration, model, pricing, maxInputTokens: entry?.maxInputTokens, maxOutputTokens: entry?.maxOutputTokens, underlyingModel: entry?.underlyingModel, supportsToolCalls: entry?.supportsToolCalls, thinking: effectiveThinking(undefined, integration), reasoningParameter: entry?.reasoningParameter });
  };
  // Review precedence: explicit route (handled by the caller) → default review integration
  // → capability tags → default writing integration → any remaining integration.
  if (capability === "review") {
    const review = resolveReviewIntegration(settings);
    if (review) {
      const models = integrationChatModels(review);
      const picked = models.find((m) => m.capabilities?.includes("review")) ?? models.find((m) => m.capabilities?.includes("default"));
      if (picked) push(review, picked.name, picked.pricing ?? review.pricing);
    }
  }
  // Exact capability match anywhere.
  for (const integration of integrations) {
    const exact = integrationChatModels(integration).find((m) => m.capabilities?.includes(capability));
    if (exact) push(integration, exact.name, exact.pricing ?? integration.pricing);
  }
  // 2) default-writing integration's fallback model for this capability
  const preferred = resolveWritingIntegration(settings);
  if (preferred) {
    const models = integrationChatModels(preferred);
    const picked = models.find((m) => m.capabilities?.includes(capability)) ?? models.find((m) => m.capabilities?.includes("default"));
    if (picked) push(preferred, picked.name, picked.pricing ?? preferred.pricing);
  }
  // 3) any default model anywhere
  for (const integration of integrations) {
    const models = integrationChatModels(integration);
    const picked = models.find((m) => m.capabilities?.includes(capability)) ?? models.find((m) => m.capabilities?.includes("default"));
    if (picked) push(integration, picked.name, picked.pricing ?? integration.pricing);
  }
  return out;
}

/** Legacy media resolution: the default writing integration's media model. */
function legacyMediaCandidates(settings: AppSettings, task: "tts" | "stt" | "image"): TaskCandidate[] {
  const integration = resolveWritingIntegration(settings);
  if (!integration) return [];
  if (integration.provider !== "openai" && integration.provider !== "azure_openai") return [];
  const model = task === "tts" ? integration.modelTextToSpeech?.trim()
    : task === "stt" ? integration.modelSpeechToText?.trim()
    : (integration.modelImageGeneration?.trim() || "gpt-image-1");
  if (!model) return [];
  return [{ integration, model, pricing: integration.pricing }];
}

/**
 * Ordered list of {integration, model} candidates to try for a task:
 * router primary+fallbacks first (if configured), then the legacy resolution as a safety net.
 */
export function resolveTaskCandidates(settings: AppSettings, task: RoutingTaskKind): TaskCandidate[] {
  const router = routerCandidates(settings, task);
  // If the user explicitly configured a route for this task, use only that
  // route and its explicit fallbacks. Falling through to legacy integrations
  // would make the router feel ignored and can spend tokens on the wrong model.
  if (hasConfiguredRoute(settings, task)) return dedupe(router).slice(0, settings.routingExecution?.maxCandidates ?? 4);
  const legacy = isChatTask(task)
    ? legacyChatCandidates(settings, task)
    : legacyMediaCandidates(settings, task as "tts" | "stt" | "image");
  return dedupe([...router, ...legacy]).slice(0, settings.routingExecution?.maxCandidates ?? 4);
}

/** The candidates execution can actually use after disclosure policy is applied. */
export function resolveEffectiveTaskCandidates(settings: AppSettings, task: RoutingTaskKind): TaskCandidate[] {
  return applySameBoundaryPolicy(settings, resolveTaskCandidates(settings, task));
}

function estimatedCandidateTokens(candidate: TaskCandidate): number {
  const budget = resolveModelTokenBudgets(candidate.maxInputTokens, candidate.maxOutputTokens);
  return budget.inputTokens + budget.outputTokens;
}

function estimatedCandidateCost(candidate: TaskCandidate): number {
  if (!candidate.pricing) return 0;
  const budget = resolveModelTokenBudgets(candidate.maxInputTokens, candidate.maxOutputTokens);
  return budget.inputTokens / 1_000_000 * (candidate.pricing.inputPerMTok ?? 0) + budget.outputTokens / 1_000_000 * (candidate.pricing.outputPerMTok ?? 0);
}

function boundedCandidates(settings: AppSettings, candidates: TaskCandidate[], requireTools = false): TaskCandidate[] {
  const limits = settings.routingExecution ?? { maxCandidates: 4, maxTotalDurationMs: 180_000, maxTokenAttempts: 200_000, maxEstimatedCost: 5 };
  const out: TaskCandidate[] = [];
  let tokens = 0;
  let cost = 0;
  for (const candidate of candidates.slice(0, limits.maxCandidates)) {
    if (requireTools && candidate.supportsToolCalls === false) continue;
    const nextTokens = estimatedCandidateTokens(candidate);
    const nextCost = estimatedCandidateCost(candidate);
    if (out.length && (tokens + nextTokens > limits.maxTokenAttempts || cost + nextCost > limits.maxEstimatedCost)) break;
    if (!out.length && (nextTokens > limits.maxTokenAttempts || nextCost > limits.maxEstimatedCost)) throw new RoutingExecutionBudgetError("The first routing candidate exceeds the configured token-attempt or estimated-cost budget.");
    out.push(candidate);
    tokens += nextTokens;
    cost += nextCost;
  }
  return out;
}

/** A candidate of a chat task with the place it holds in the route and the name its failures are reported under. */
type RoutableCandidate = ChatCandidate & { routeCandidateIndex: number; label: string };

/** What a failed candidate is reported as when the client wrote the sentence: it names the provider and the model, so that the label of the Copilot is not put in front of it. */
function clientSentence(error: unknown): string | undefined {
  return error instanceof AiProviderError ? error.message : undefined;
}

/** What a reply that the output limit cut said, when it said something: the text, without the reasoning that came with it. A cut that held only reasoning said nothing. */
function cutReply(error: unknown, partial: string): string | undefined {
  if (!(error instanceof AiProviderError) || error.truncated !== true || error.reasoningOnly === true) return undefined;
  const { reply } = splitReasoningBlock(partial);
  return reply.trim() ? reply : undefined;
}

/** The notes that the engine adds to the end of a call that failed, for what it did not ask: the models "Tools only" left out, and the fallbacks the routing time did not allow. */
function addNotes(error: unknown, skipped: SkippedModels, candidates: ChatCandidate[], stopped: string | undefined): void {
  if (!(error instanceof AiProviderError)) return;
  const notes = [
    ...skipped.map(({ model }) => {
      const owner = candidates.find((candidate) => candidate.model === model)?.integration.name;
      return `Skipped "${model}"${owner ? ` in "${owner}"` : ""}: it is marked as without tool calls and "Tools only" is on.`;
    }),
    ...(stopped ? [stopped] : []),
  ];
  if (notes.length) error.message = `${error.message}${/[.!?]$/.test(error.message) ? "" : "."} ${notes.join(" ")}`;
}

/**
 * Run a chat completion for a capability using the configured router (primary + fallbacks),
 * then the legacy resolution, trying each candidate in order until one succeeds. Each attempt is a call of the engine's client to one candidate (see `copilotAi.ts`):
 * its request, its streaming, its three deadlines and its reading of the reply are the engine's, and what the Copilot decides is the route, the prompt of each candidate and
 * which replies it accepts.
 */
export async function completeTextRouted(
  settings: AppSettings,
  messages: LlmMessage[],
  capability: ChatCapability,
  options: { accountScope: string | null; signal?: AbortSignal; label?: string; onText?: (text: string) => void; onUsage?: (usage: LlmUsageReport) => void; onFinish?: (report: LlmFinishReport) => void; onAttempt?: (routeCandidateIndex: number) => void; overflow?: PromptOverflow; preferred?: RoutingTarget; validateText?: (text: string) => void; fallbackMaxOutputTokens?: number },
): Promise<string> {
  const operation = beginAccountScopedAiOperation(options?.signal, options?.accountScope);
  try {
  const preferred = options?.preferred ? chatCandidateFromTarget(settings, options.preferred, capability) : null;
  const candidates = boundedCandidates(settings, applySameBoundaryPolicy(settings, dedupe([...(preferred ? [preferred] : []), ...resolveTaskCandidates(settings, capability)])));
  if (!candidates.length) {
    if (hasConfiguredRoute(settings, capability)) throw new StaleRoutingConfigurationError(capability);
    throw new NoCompletionCandidatesError();
  }
  const purpose = capability === "review" ? "review" : "writing";
  const routable: RoutableCandidate[] = candidates.map((candidate, routeCandidateIndex) => ({ ...candidate, routeCandidateIndex })).filter((candidate) => candidate.integration && candidate.model).map((candidate) => ({ ...candidate, integration: candidate.integration!, model: candidate.model!, label: `${candidate.integration!.provider}/${candidate.model!}` }));
  if (!routable.length) throw new NoCompletionCandidatesError();
  const outputLimit = (candidate: RoutableCandidate) => engineOutputLimit(settings, candidate, capability, requestedOutput(candidate, options.fallbackMaxOutputTokens), false);
  const estimated = likelyMessageTokens(messages);
  const room = (candidate: RoutableCandidate) => inputRoom(candidate, outputLimit(candidate));
  const fits = (candidate: RoutableCandidate) => !candidate.maxInputTokens || estimated <= room(candidate);
  const executable = options.overflow === "fail" ? routable.filter(fits) : routable;
  if (!executable.length) throw new PromptBudgetExceededError(estimated, Math.max(...routable.map(room)));
  const clock = startRoutingClock(settings);
  /** The last text that arrived of the candidate that is being asked: the engine clears the listener when a candidate fails, and a reply that was cut is still the reply. */
  let partial = "";
  let shown: string | undefined;
  const show = (text: string) => {
    if (text === "" && shown === "") return;
    shown = text;
    options.onText?.(text);
  };
  return await executeCompletionFallback({
    candidates: executable,
    signal: operation.signal,
    stopBefore: () => clock.usedUp(),
    beforeCandidate: (candidate, index) => {
      if (index > 0) {
        const asked = Date.now();
        acknowledgeCrossBoundaryFallback({ settings, kind: "text", from: executable[index - 1], to: candidate, accountScope: operation.accountScope });
        clock.excuse(Date.now() - asked);
      }
      options.onAttempt?.(candidate.routeCandidateIndex);
    },
    resetPartial: () => {
      partial = "";
      show("");
    },
    describe: (_candidate, error) => clientSentence(error),
    run: async (candidate, signal) => {
      const prompt = options.overflow === "fail" ? messages : budgetLlmMessages(messages, candidate.maxInputTokens, outputLimit(candidate));
      let text: string;
      try {
        const response = await runCopilotAttempt({
          settings,
          accountScope: operation.accountScope,
          signal,
          capability,
          candidate,
          route: { index: candidate.routeCandidateIndex },
          label: options.label ?? purpose,
          messages: prompt,
          maxOutputTokens: requestedOutput(candidate, options.fallbackMaxOutputTokens),
          onText: (value) => {
            if (value) partial = value;
            show(value);
          },
          onEnd: (end) => {
            if (end.finishReason === undefined) return;
            const report = usageReport(candidate, end);
            options.onUsage?.(report);
            options.onFinish?.({ ...report, finishReason: end.finishReason, replyCharacters: end.replyCharacters ?? 0, reasoningCharacters: end.reasoningCharacters ?? 0 });
          },
          clock,
          onRestart: () => {
            partial = "";
          },
          onRetry: (notice) => announceRetry(options?.signal, notice),
        });
        text = response.text;
      } catch (error) {
        const cut = cutReply(error, partial);
        if (cut === undefined) throw error;
        text = cut;
      }
      options.validateText?.(text);
      return text;
    },
  });
  } finally {
    operation.dispose();
  }
}

export async function completeToolRouted<T>(
  settings: AppSettings,
  messages: LlmMessage[],
  capability: ChatCapability,
  tool: ForcedToolDefinition,
  options: { accountScope: string | null; signal?: AbortSignal; label?: string; validate?: (output: unknown) => T; fallbackMaxOutputTokens?: number; onFinish?: (report: LlmFinishReport) => void; onAttempt?: (routeCandidateIndex: number) => void; overflow?: PromptOverflow },
): Promise<LlmResult<T> & { metadata: RoutedLlmRunMetadata }> {
  const operation = beginAccountScopedAiOperation(options?.signal, options?.accountScope);
  try {
  const resolved = applySameBoundaryPolicy(settings, resolveTaskCandidates(settings, capability));
  if (!resolved.length) {
    if (hasConfiguredRoute(settings, capability)) throw new StaleRoutingConfigurationError(capability);
    throw new NoCompletionCandidatesError();
  }
  // "Tools only" is on unless the author turned it off, as for the run: a model marked as without tool calls is left out, and if none is left the call is refused before anything is sent.
  const strict = toolsOnly(settings);
  const candidates = boundedCandidates(settings, resolved, strict);
  const chatOf = (list: TaskCandidate[]) => list.filter((candidate): candidate is ChatCandidate => Boolean(candidate.integration && candidate.model));
  if (!candidates.length) {
    if (strict) throw await toolsRequiredError(settings, capability, chatOf(resolved), tool);
    throw new NoCompletionCandidatesError();
  }
  const skipped: SkippedModels = strict ? chatOf(resolved).filter((candidate) => candidate.supportsToolCalls === false).map((candidate) => ({ model: candidate.model, reason: "no-tool-calls" as const })) : [];
  let lastError: unknown = null;
  let skippedForBudget = false;
  let largestBudget = 0;
  let stopped: string | undefined;
  const estimated = likelyMessageTokens(messages);
  const schema = toolTokens(tool);
  const clock = startRoutingClock(settings);
  for (const [listIndex, candidate] of candidates.entries()) {
    operation.signal.throwIfAborted();
    if (!candidate.integration || !candidate.model) continue;
    const chat = candidate as ChatCandidate;
    const requested = requestedOutput(chat, options.fallbackMaxOutputTokens);
    const limit = engineOutputLimit(settings, chat, capability, requested, true);
    // With "Tools only" off a model without tool calls is asked for JSON in its message: the instruction takes room of its own.
    const instruction = strict || chat.supportsToolCalls !== false ? 0 : jsonInstructionTokens(tool);
    if (options.overflow === "fail" && chat.maxInputTokens) {
      const available = inputRoom(chat, limit, schema.about + instruction);
      if (estimated > available) {
        skippedForBudget = true;
        largestBudget = Math.max(largestBudget, available);
        continue;
      }
    }
    stopped = clock.usedUp();
    if (stopped) break;
    if (listIndex > 0) {
      const asked = Date.now();
      acknowledgeCrossBoundaryFallback({ settings, kind: "text", from: candidates[listIndex - 1], to: candidate, accountScope: operation.accountScope });
      clock.excuse(Date.now() - asked);
    }
    const position = resolved.indexOf(candidate);
    options.onAttempt?.(position);
    try {
      const prompt = options.overflow === "fail" ? messages : budgetForcedToolMessages(messages, chat, limit, tool, instruction);
      let ended: { end: FetchAiAttemptEnd; debugId: string | undefined } | undefined;
      const response = await runCopilotAttempt({
        settings,
        accountScope: operation.accountScope,
        signal: operation.signal,
        capability,
        candidate: chat,
        route: { index: position, ...(skipped.length ? { skipped } : {}) },
        label: options.label ?? capability,
        messages: prompt,
        json: tool,
        maxOutputTokens: requested,
        onEnd: (end, debugId) => {
          ended = { end, debugId };
          if (end.finishReason === undefined) return;
          options.onFinish?.({ ...usageReport(chat, end), finishReason: end.finishReason, replyCharacters: end.replyCharacters ?? 0, reasoningCharacters: end.reasoningCharacters ?? 0 });
        },
        clock,
        onRetry: (notice) => announceRetry(options?.signal, notice),
      });
      const output = options.validate ? options.validate(response.json) : response.json as T;
      return {
        output,
        metadata: { ...runMetadata({ candidate: chat, capability, end: ended?.end, debugId: ended?.debugId, settings }), routeCandidateIndex: position, usedFallback: position > 0 },
      };
    } catch (err) {
      if (operation.signal.aborted) throw err;
      lastError = err;
    }
  }
  addNotes(lastError, skipped, chatOf(resolved), stopped);
  throw lastError ?? (skippedForBudget ? new PromptBudgetExceededError(estimated, largestBudget) : new Error("All AI candidates failed for this task."));
  } finally {
    operation.dispose();
  }
}

/** True when TTS should use the browser engine as the first candidate. */
export function isBrowserTtsPreferred(settings: AppSettings): boolean {
  return resolveTaskCandidates(settings, "tts")[0]?.browser === true;
}

/** True when STT should use the browser recognition as the first candidate. */
export function isBrowserSttPreferred(settings: AppSettings): boolean {
  return resolveTaskCandidates(settings, "stt")[0]?.browser === true;
}

/**
 * How STT should run based on the first resolved candidate:
 * - "browser": use browser speech recognition
 * - "ai": use MediaRecorder → transcribeAudio
 * - "none": no candidate (fall back to browser recognition by default)
 */
export function sttMode(settings: AppSettings, candidateIndex = 0): "browser" | "ai" | "none" {
  const first = resolveTaskCandidates(settings, "stt")[candidateIndex];
  if (!first) return "none";
  if (first.browser) return "browser";
  return first.integration && first.model ? "ai" : "none";
}

/**
 * Confirmation classification with router (simple-tasks) + fallbacks. Returns "unclear" if all fail: it is a helper, and the flow that asks it goes on without an answer.
 * The utterance alone is sent, framed, and the model answers by calling the function of the confirmation.
 */
export async function classifyConfirmationRouted(settings: AppSettings, utterance: string, operationSignal: AbortSignal | undefined, accountScope: string | null): Promise<"yes" | "no" | "unclear"> {
  const operation = beginAccountScopedAiOperation(operationSignal, accountScope);
  try {
  const resolved = applySameBoundaryPolicy(settings, resolveTaskCandidates(settings, "simple-tasks"));
  const strict = toolsOnly(settings);
  const candidates = boundedCandidates(settings, resolved, strict);
  const skipped: SkippedModels = strict ? resolved.filter((candidate) => candidate.supportsToolCalls === false && candidate.model).map((candidate) => ({ model: candidate.model!, reason: "no-tool-calls" as const })) : [];
  const clock = startRoutingClock(settings);
  for (const [listIndex, candidate] of candidates.entries()) {
    operation.signal.throwIfAborted();
    if (!candidate.integration || !candidate.model) continue;
    const chat = candidate as ChatCandidate;
    if (clock.usedUp()) break;
    if (listIndex > 0) {
      const asked = Date.now();
      acknowledgeCrossBoundaryFallback({ settings, kind: "text", from: candidates[listIndex - 1], to: candidate, accountScope: operation.accountScope });
      clock.excuse(Date.now() - asked);
    }
    try {
      const requested = Math.min(32, resolveModelTokenBudgets(chat.maxInputTokens, chat.maxOutputTokens).outputTokens);
      const limit = engineOutputLimit(settings, chat, "simple-tasks", requested, true);
      const instruction = strict || chat.supportsToolCalls !== false ? 0 : jsonInstructionTokens(CONFIRMATION_TOOL_DEFINITION);
      const budgetedMessages = budgetForcedToolMessages([{ role: "user", content: currentRequest(utterance) }], chat, limit, CONFIRMATION_TOOL_DEFINITION, instruction);
      const budgetedUtterance = budgetedMessages[0]?.content;
      if (typeof budgetedUtterance !== "string") throw new CandidateInputBudgetError();
      const response = await runCopilotAttempt({
        settings,
        accountScope: operation.accountScope,
        signal: operation.signal,
        capability: "simple-tasks",
        candidate: chat,
        route: { index: resolved.indexOf(candidate), ...(skipped.length ? { skipped } : {}) },
        label: "confirm",
        messages: [{ role: "user", content: budgetedUtterance }],
        json: CONFIRMATION_TOOL_DEFINITION,
        maxOutputTokens: requested,
        clock,
        onRetry: (notice) => announceRetry(operationSignal, notice),
      });
      const decision = (response.json as { decision?: unknown } | undefined)?.decision;
      return decision === "yes" || decision === "no" ? decision : "unclear";
    } catch (error) {
      if (operation.signal.aborted) throw error;
      // try next fallback
    }
  }
  return "unclear";
  } finally {
    operation.dispose();
  }
}
