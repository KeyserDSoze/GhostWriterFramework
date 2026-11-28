import { CHAT_CAPABILITIES, type AIIntegration, type AIPricing, type AppSettings, type ChatCapability, type ReasoningParameter, type RoutingTarget, type RoutingTaskKind, type TaskRoute, type ThinkingLevel } from "@/types/settings";
import { AiProviderError, splitReasoningBlock, type FetchAiAttemptEnd } from "narrarium-engine";
import { effectiveThinking } from "@/router/thinking";
import { followOrder, integrationChatModels, modelSupportsCapability, pickModelFor, resolveReviewIntegration, resolveWritingIntegration, CONFIRMATION_TOOL_DEFINITION, type ForcedToolDefinition, type LlmFinishReport, type LlmMessage, type LlmResult, type LlmUsageReport } from "@/assistant/llm";
import { executeCompletionFallback } from "@/assistant/completionFallback";
import { fallbackBudgetNote } from "narrarium-engine";
import { DEFAULT_MAX_INPUT_TOKENS, UPPER_BOUND_MEASURE, budgetLlmMessages, likelyMeasure, likelyMessageTokens, modelWindow, resolveModelTokenBudgets, type TokenMeasure } from "@/assistant/promptBudget";
import { recordTokenUsage, requestShape, shapeTotal, tokenRatio } from "@/assistant/contextBudget";
import { announceTurnRequest, announceTurnUsage } from "@/assistant/turnContext";
import { announceRetry } from "@/assistant/retryNotice";
import { announcePromptCut, promptCutOf } from "@/assistant/promptCut";
import { usageTaskOf } from "@/costs/usageTasks";
import { engineOutputLimit, jsonInstructionTokens, requestedOutput, runCopilotAttempt, runMetadata, startRoutingClock, toolsOnly, toolsRequiredError, toolTokens, usageReport, type ChatCandidate, type SkippedModels } from "@/assistant/copilotAi";
import { acknowledgeCrossBoundaryFallback, applySameBoundaryPolicy } from "@/assistant/fallbackDisclosure";
import { beginAccountScopedAiOperation } from "@/assistant/accountScopedOperation";
import { currentRequest } from "@/assistant/promptTrust";
import type { RoutingAttemptEstimate, RoutingBudgetDetail } from "@/assistant/routingExecutionBudget";

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
 * With `overflow: "fail"` a prompt is never cut in the middle (an autopilot prompt would silently lose part of its data, such as findings). It is refused when it exceeds the
 * context window of every routed model: the model's own, or the default for a model whose window is not set (`modelWindow`), as the engine judges it.
 */
export class PromptBudgetExceededError extends Error {
  constructor(readonly estimatedTokens: number, readonly largestBudget: number, assumedDefault = false) {
    super(`The prompt (about ${estimatedTokens} tokens) is larger than the context window of every model routed to this task (largest input budget: ${largestBudget} tokens). Nothing was sent.${assumedDefault ? ` A model whose window is not set is assumed to hold ${DEFAULT_MAX_INPUT_TOKENS} tokens.` : ""} Set the models' "Context window tokens" in AI Integrations if they hold more, or route this task to a model with a larger context window.`);
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
function budgetForcedToolMessages(messages: LlmMessage[], candidate: TaskCandidate, outputTokens: number, tool: ForcedToolDefinition, extraReserve = 0, measure: TokenMeasure = UPPER_BOUND_MEASURE): LlmMessage[] {
  const inputTokens = resolveModelTokenBudgets(candidate.maxInputTokens, outputTokens).inputTokens;
  const reserve = toolTokens(tool).atMost + extraReserve;
  if (reserve > inputTokens) throw new CandidateInputBudgetError();
  const budgeted = budgetLlmMessages(messages, candidate.maxInputTokens, outputTokens, reserve, measure);
  if (messages.length > 0 && budgeted.length === 0) throw new CandidateInputBudgetError();
  return budgeted;
}

/** The chats whose requests are measured as the chat measures its context (#122): the Copilot and Brainstorming. */
const CHAT_MEASURED: ReadonlySet<ChatCapability> = new Set<ChatCapability>(["copilot", "brainstorming"]);

/**
 * How a request is counted where it may be cut: the requests of the chats (and the summary of a compaction, `measure: "chat"`) by the chat's tokens times what the provider
 * counted for the requests of the model (`contextBudget.ts`), so that a request is cut where its window really ends (the UTF-8 upper bound cut the prose of a request at about a
 * quarter of the window) and the compaction of the chat comes first; every other task by the UTF-8 upper bound, as before.
 */
function measureFor(capability: ChatCapability, candidate: TaskCandidate, measure?: "chat"): TokenMeasure {
  return measure === "chat" || CHAT_MEASURED.has(capability) ? likelyMeasure(tokenRatio({ integrationId: candidate.integration?.id, model: candidate.model })) : UPPER_BOUND_MEASURE;
}

/**
 * A request that goes to a candidate, told to the chat that made it (`turnContext.ts`): its shape, part by part, as the chat composed it (before a cut: the ring says how much
 * the chat asks of the window). The result is the likely tokens of what is sent, that the provider's count is measured against.
 */
function tellRequest(signal: AbortSignal | undefined, capability: ChatCapability, candidate: TaskCandidate, messages: LlmMessage[], sent: LlmMessage[], toolTokensSent = 0): number {
  const shape = requestShape(messages, toolTokensSent);
  if (signal && candidate.integration && candidate.model) announceTurnRequest(signal, { capability, integrationId: candidate.integration.id, model: candidate.model, shape });
  return sent === messages ? shapeTotal(shape) : shapeTotal(requestShape(sent, toolTokensSent));
}

/** What the provider counted for a request: the ratio of its model learns from it, and the chat that sent it hears it. */
function tellUsage(signal: AbortSignal | undefined, capability: ChatCapability, report: LlmUsageReport, likely: number): void {
  recordTokenUsage({ integrationId: report.integrationId, model: report.model }, likely, report.inputTokens);
  if (report.inputTokens > 0) announceTurnUsage(signal, { capability, integrationId: report.integrationId, model: report.model, inputTokens: report.inputTokens, cachedInputTokens: report.cachedInputTokens, outputTokens: report.outputTokens });
}

/** A request cut to fit the window of the candidate is said to the chat that sent it (`promptCut.ts`): how much was sent, for which window (the model's own, or the default). */
function tellCut(signal: AbortSignal | undefined, candidate: TaskCandidate, messages: LlmMessage[], sent: LlmMessage[]): void {
  if (sent === messages || !signal || !candidate.model) return;
  const cut = promptCutOf({ model: candidate.model, integrationName: candidate.integration?.name ?? "" }, modelWindow(candidate), messages, sent);
  if (cut) announcePromptCut(signal, cut);
}

const CHAT_CAPABILITIES_SET = new Set<RoutingTaskKind>(CHAT_CAPABILITIES);

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

const writtenRoute = (route: TaskRoute | undefined): boolean => Boolean(route?.primary || route?.fallbacks?.length);

/**
 * The task whose route a task goes by now when it is not its own: the task it follows (`CAPABILITY_FOLLOWS`: Brainstorming the Copilot), while it has no route of its own
 * and that one has. Without either route it goes by none: it is resolved from the models tagged for it, then for the task it follows, then the Default route's endpoint.
 */
export function followedRoute(settings: AppSettings, task: RoutingTaskKind): ChatCapability | undefined {
  if (!isChatTask(task) || writtenRoute(settings.taskRouting?.[task])) return undefined;
  return followOrder(task).slice(1).find((other) => writtenRoute(settings.taskRouting?.[other]));
}

const routedTask = (settings: AppSettings, task: RoutingTaskKind): RoutingTaskKind => followedRoute(settings, task) ?? task;

/** Router-configured targets (primary then fallbacks) for a task, mapped to candidates. */
function routerCandidates(settings: AppSettings, task: RoutingTaskKind): TaskCandidate[] {
  const inheritedDefault = task === "editor-actions" && !settings.taskRouting?.[task];
  const route = settings.taskRouting?.[routedTask(settings, task)] ?? (inheritedDefault ? settings.taskRouting?.default : undefined);
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
  const route = settings.taskRouting?.[routedTask(settings, task)] ?? (task === "editor-actions" ? settings.taskRouting?.default : undefined);
  return writtenRoute(route);
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
  // Exact capability match anywhere: the models tagged for the task, then those tagged for the task it follows. The review's default integration comes first among
  // the review's models (for the wildcards, which follow the review, after their own), as in the engine.
  for (const tag of followOrder(capability)) {
    if (tag === "review") {
      const review = resolveReviewIntegration(settings);
      if (review) {
        const models = integrationChatModels(review);
        const picked = models.find((m) => m.capabilities?.includes("review")) ?? models.find((m) => m.capabilities?.includes("default"));
        if (picked) push(review, picked.name, picked.pricing ?? review.pricing);
      }
    }
    for (const integration of integrations) {
      const exact = integrationChatModels(integration).find((m) => m.capabilities?.includes(tag));
      if (exact) push(integration, exact.name, exact.pricing ?? integration.pricing);
    }
  }
  // 2) default-writing integration's fallback model for this capability
  const preferred = resolveWritingIntegration(settings);
  if (preferred) {
    const picked = pickModelFor(integrationChatModels(preferred), capability);
    if (picked) push(preferred, picked.name, picked.pricing ?? preferred.pricing);
  }
  // 3) any default model anywhere
  for (const integration of integrations) {
    const picked = pickModelFor(integrationChatModels(integration), capability);
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

/**
 * What one attempt of this request would use with a candidate: the likely tokens of its prompt (as the engine counts them, no more than the candidate's window takes: a longer prompt
 * is cut to it, and said) and the output the call asks of it, at the candidate's prices. Not its whole window: a model of 1,000,000 tokens asked a short question is a short attempt.
 */
function attemptEstimate(candidate: TaskCandidate, promptTokens: number, outputTokens: number): RoutingAttemptEstimate & { inputTokens: number } {
  const room = resolveModelTokenBudgets(candidate.maxInputTokens, outputTokens).inputTokens;
  const inputTokens = Math.max(0, Math.min(promptTokens, room));
  const output = Math.max(0, outputTokens);
  const cost = candidate.pricing ? inputTokens / 1_000_000 * (candidate.pricing.inputPerMTok ?? 0) + output / 1_000_000 * (candidate.pricing.outputPerMTok ?? 0) : 0;
  return { tokens: inputTokens + output, cost, inputTokens };
}

/** The candidates a call may try, and the fallbacks the routing limits leave out with which limit and its numbers (said on the error of a call whose candidates all failed). */
interface BoundedCandidates {
  candidates: TaskCandidate[];
  leftOut?: { candidates: TaskCandidate[]; budget: RoutingBudgetDetail };
}

/**
 * The candidates a call may try within the router's limits (Settings > AI Router > Routing options), with the engine's rule: the first is bounded by its model's window alone
 * (whether the prompt fits it, or what is cut to fit it), and the limits are a safety for what the fallbacks after it add together, `maxTokenAttempts` for their tokens and
 * `maxEstimatedCost` for their cost, each fallback estimated for this request (`estimate`, never the whole window of its model).
 */
function boundedCandidates(settings: AppSettings, candidates: TaskCandidate[], estimate: (candidate: TaskCandidate) => RoutingAttemptEstimate & { inputTokens: number }, requireTools = false): BoundedCandidates {
  const limits = settings.routingExecution ?? { maxCandidates: 4, maxTotalDurationMs: 180_000, maxTokenAttempts: 200_000, maxEstimatedCost: 5 };
  const pool = candidates.slice(0, limits.maxCandidates).filter((candidate) => !(requireTools && candidate.supportsToolCalls === false));
  const out: TaskCandidate[] = [];
  let fallbackTokens = 0;
  let fallbackCost = 0;
  for (const [at, candidate] of pool.entries()) {
    if (out.length) {
      const next = estimate(candidate);
      const tokens = fallbackTokens + next.tokens;
      const cost = fallbackCost + next.cost;
      const overCost = cost > limits.maxEstimatedCost;
      if (overCost || tokens > limits.maxTokenAttempts) {
        return { candidates: out, leftOut: { candidates: pool.slice(at), budget: overCost ? { limit: "cost", estimated: cost, allowed: limits.maxEstimatedCost } : { limit: "tokens", estimated: tokens, allowed: limits.maxTokenAttempts } } };
      }
      fallbackTokens = tokens;
      fallbackCost = cost;
    }
    out.push(candidate);
  }
  return { candidates: out };
}

/** The error of a call whose candidates all failed, when the routing limits left fallbacks out: it says which models were not tried, the limit and its numbers (`budget`), as the engine does. */
function withFallbackBudget(error: unknown, leftOut: BoundedCandidates["leftOut"], settings: AppSettings): unknown {
  if (!leftOut || !(error instanceof Error) || error.name === "AbortError") return error;
  const models = leftOut.candidates.flatMap((candidate) => (candidate.model ? [`"${candidate.model}" in "${candidate.integration?.name ?? ""}"`] : []));
  (error as Error & { budget?: RoutingBudgetDetail }).budget = leftOut.budget;
  if (models.length) error.message = `${error.message}${/[.!?]$/.test(error.message) ? "" : "."} ${fallbackBudgetNote(models, leftOut.budget, settings.costCurrency || "USD")}`;
  return error;
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
  options: { accountScope: string | null; signal?: AbortSignal; label?: string; onText?: (text: string) => void; onUsage?: (usage: LlmUsageReport) => void; onFinish?: (report: LlmFinishReport) => void; onAttempt?: (routeCandidateIndex: number) => void; overflow?: PromptOverflow; preferred?: RoutingTarget; validateText?: (text: string) => void; fallbackMaxOutputTokens?: number; measure?: "chat" },
): Promise<string> {
  const operation = beginAccountScopedAiOperation(options?.signal, options?.accountScope);
  try {
  const preferred = options?.preferred ? chatCandidateFromTarget(settings, options.preferred, capability) : null;
  const promptTokens = likelyMessageTokens(messages);
  const textOutput = (candidate: TaskCandidate) => (candidate.integration && candidate.model ? engineOutputLimit(settings, candidate as ChatCandidate, capability, requestedOutput(candidate as ChatCandidate, options.fallbackMaxOutputTokens), false) : 0);
  const bounded = boundedCandidates(settings, applySameBoundaryPolicy(settings, dedupe([...(preferred ? [preferred] : []), ...resolveTaskCandidates(settings, capability)])), (candidate) => attemptEstimate(candidate, promptTokens, textOutput(candidate)));
  const candidates = bounded.candidates;
  if (!candidates.length) {
    if (hasConfiguredRoute(settings, capability)) throw new StaleRoutingConfigurationError(routedTask(settings, capability));
    throw new NoCompletionCandidatesError();
  }
  const purpose = capability === "review" ? "review" : "writing";
  const routable: RoutableCandidate[] = candidates.map((candidate, routeCandidateIndex) => ({ ...candidate, routeCandidateIndex })).filter((candidate) => candidate.integration && candidate.model).map((candidate) => ({ ...candidate, integration: candidate.integration!, model: candidate.model!, label: `${candidate.integration!.provider}/${candidate.model!}` }));
  if (!routable.length) throw new NoCompletionCandidatesError();
  const outputLimit = (candidate: RoutableCandidate) => engineOutputLimit(settings, candidate, capability, requestedOutput(candidate, options.fallbackMaxOutputTokens), false);
  const estimated = likelyMessageTokens(messages);
  const room = (candidate: RoutableCandidate) => inputRoom(candidate, outputLimit(candidate));
  // Every model by its own window, or the default for one whose window is not set (`modelWindow`, as the engine judges it).
  const fits = (candidate: RoutableCandidate) => estimated <= room(candidate);
  const executable = options.overflow === "fail" ? routable.filter(fits) : routable;
  if (!executable.length) throw new PromptBudgetExceededError(estimated, Math.max(...routable.map(room)), routable.some((candidate) => modelWindow(candidate).source === "default"));
  const clock = startRoutingClock(settings);
  /** The last text that arrived of the candidate that is being asked: the engine clears the listener when a candidate fails, and a reply that was cut is still the reply. */
  let partial = "";
  let shown: string | undefined;
  const show = (text: string) => {
    if (text === "" && shown === "") return;
    shown = text;
    options.onText?.(text);
  };
  try {
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
      const prompt = options.overflow === "fail" ? messages : budgetLlmMessages(messages, candidate.maxInputTokens, outputLimit(candidate), 0, measureFor(capability, candidate, options.measure));
      tellCut(options.signal, candidate, messages, prompt);
      const likely = tellRequest(options.signal, capability, candidate, messages, prompt);
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
            tellUsage(options.signal, capability, report, likely);
            options.onUsage?.(report);
            options.onFinish?.({ ...report, finishReason: end.finishReason, replyCharacters: end.replyCharacters ?? 0, reasoningCharacters: end.reasoningCharacters ?? 0 });
          },
          clock,
          onRestart: () => {
            partial = "";
          },
          onRetry: (notice) => announceRetry(options?.signal, notice),
          usageTask: usageTaskOf(options?.signal),
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
  } catch (error) {
    throw operation.signal.aborted ? error : withFallbackBudget(error, bounded.leftOut, settings);
  }
  } finally {
    operation.dispose();
  }
}

export async function completeToolRouted<T>(
  settings: AppSettings,
  messages: LlmMessage[],
  capability: ChatCapability,
  tool: ForcedToolDefinition,
  options: { accountScope: string | null; signal?: AbortSignal; label?: string; validate?: (output: unknown) => T; fallbackMaxOutputTokens?: number; onFinish?: (report: LlmFinishReport) => void; onAttempt?: (routeCandidateIndex: number) => void; overflow?: PromptOverflow; onStructuredText?: (json: string) => void; measure?: "chat" },
): Promise<LlmResult<T> & { metadata: RoutedLlmRunMetadata }> {
  const operation = beginAccountScopedAiOperation(options?.signal, options?.accountScope);
  try {
  const resolved = applySameBoundaryPolicy(settings, resolveTaskCandidates(settings, capability));
  if (!resolved.length) {
    if (hasConfiguredRoute(settings, capability)) throw new StaleRoutingConfigurationError(routedTask(settings, capability));
    throw new NoCompletionCandidatesError();
  }
  // "Tools only" is on unless the author turned it off, as for the run: a model marked as without tool calls is left out, and if none is left the call is refused before anything is sent.
  const strict = toolsOnly(settings);
  const promptTokens = likelyMessageTokens(messages) + toolTokens(tool).about;
  const toolOutput = (candidate: TaskCandidate) => (candidate.integration && candidate.model ? engineOutputLimit(settings, candidate as ChatCandidate, capability, requestedOutput(candidate as ChatCandidate, options.fallbackMaxOutputTokens), true) : 0);
  const bounded = boundedCandidates(settings, resolved, (candidate) => attemptEstimate(candidate, promptTokens, toolOutput(candidate)), strict);
  const candidates = bounded.candidates;
  const chatOf = (list: TaskCandidate[]) => list.filter((candidate): candidate is ChatCandidate => Boolean(candidate.integration && candidate.model));
  if (!candidates.length) {
    if (strict) throw await toolsRequiredError(settings, capability, chatOf(resolved), tool);
    throw new NoCompletionCandidatesError();
  }
  const skipped: SkippedModels = strict ? chatOf(resolved).filter((candidate) => candidate.supportsToolCalls === false).map((candidate) => ({ model: candidate.model, reason: "no-tool-calls" as const })) : [];
  let lastError: unknown = null;
  let skippedForBudget = false;
  let largestBudget = 0;
  let assumedDefault = false;
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
    if (options.overflow === "fail") {
      // Every model by its own window, or the default for one whose window is not set (`modelWindow`, as the engine judges it).
      const available = inputRoom(chat, limit, schema.about + instruction);
      if (estimated > available) {
        skippedForBudget = true;
        largestBudget = Math.max(largestBudget, available);
        assumedDefault ||= modelWindow(chat).source === "default";
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
      const prompt = options.overflow === "fail" ? messages : budgetForcedToolMessages(messages, chat, limit, tool, instruction, measureFor(capability, chat, options.measure));
      tellCut(options.signal, chat, messages, prompt);
      const likely = tellRequest(options.signal, capability, chat, messages, prompt, schema.about + instruction);
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
        ...(options.onStructuredText ? { onStructuredText: options.onStructuredText } : {}),
        onEnd: (end, debugId) => {
          ended = { end, debugId };
          if (end.finishReason === undefined) return;
          const report = usageReport(chat, end);
          tellUsage(options.signal, capability, report, likely);
          options.onFinish?.({ ...report, finishReason: end.finishReason, replyCharacters: end.replyCharacters ?? 0, reasoningCharacters: end.reasoningCharacters ?? 0 });
        },
        clock,
        onRetry: (notice) => announceRetry(options?.signal, notice),
        usageTask: usageTaskOf(options?.signal),
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
  throw withFallbackBudget(lastError ?? (skippedForBudget ? new PromptBudgetExceededError(estimated, largestBudget, assumedDefault) : new Error("All AI candidates failed for this task.")), bounded.leftOut, settings);
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
  const utteranceTokens = likelyMessageTokens([{ role: "user", content: currentRequest(utterance) }]) + toolTokens(CONFIRMATION_TOOL_DEFINITION).about;
  const { candidates } = boundedCandidates(settings, resolved, (candidate) => attemptEstimate(candidate, utteranceTokens, candidate.integration && candidate.model ? engineOutputLimit(settings, candidate as ChatCandidate, "simple-tasks", 32, true) : 0), strict);
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
        usageTask: usageTaskOf(operationSignal),
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
