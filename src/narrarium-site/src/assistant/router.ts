import type { AIIntegration, AIPricing, AppSettings, ChatCapability, RoutingTarget, RoutingTaskKind, TaskRoute } from "@/types/settings";
import { integrationChatModels, resolveReviewIntegration, resolveWritingIntegration, completeText, completeToolWith, classifyConfirmationWith, CONFIRMATION_TOOL_DEFINITION, type ForcedToolDefinition, type LlmMessage, type LlmResult } from "@/assistant/llm";
import { executeCompletionFallback } from "@/assistant/completionFallback";
import { runWithCandidateTimeout } from "@/assistant/executionLimits";
import { budgetLlmMessages, resolveModelTokenBudgets, textTokenUpperBound } from "@/assistant/promptBudget";
import { acknowledgeCrossBoundaryFallback, applySameBoundaryPolicy } from "@/assistant/fallbackDisclosure";
import { beginAccountScopedAiOperation } from "@/assistant/accountScopedOperation";
import { currentRequest } from "@/assistant/promptTrust";

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

function budgetForcedToolMessages(messages: LlmMessage[], candidate: TaskCandidate, tool: ForcedToolDefinition): LlmMessage[] {
  const inputTokens = resolveModelTokenBudgets(candidate.maxInputTokens, candidate.maxOutputTokens).inputTokens;
  const toolTokens = textTokenUpperBound(JSON.stringify(tool)) + 8;
  if (toolTokens > inputTokens) throw new CandidateInputBudgetError();
  const budgeted = budgetLlmMessages(messages, candidate.maxInputTokens, candidate.maxOutputTokens, toolTokens);
  if (messages.length > 0 && budgeted.length === 0) throw new CandidateInputBudgetError();
  return budgeted;
}

const CHAT_CAPABILITIES_SET = new Set<RoutingTaskKind>(["default", "copilot", "simple-tasks", "review", "chat-resume", "reader-evaluation", "reader-evaluation-summary", "rewrite-from-reader-feedback", "deep-research", "create-from-research", "audit"]);

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
    return integrationChatModels(integration).some((model) => model.name === target.model.trim())
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
function chatCandidateFromTarget(settings: AppSettings, target: RoutingTarget): TaskCandidate | null {
  const integration = findIntegration(settings, target.integrationId);
  if (!integration || integration.provider === "m365_copilot") return null;
  const model = target.model?.trim();
  if (!model) return null;
  const modelEntry = integrationChatModels(integration).find((m) => m.name === model);
  if (!modelEntry) return null;
  return { integration, model, pricing: modelEntry.pricing ?? integration.pricing, maxInputTokens: modelEntry.maxInputTokens, maxOutputTokens: modelEntry.maxOutputTokens, underlyingModel: modelEntry.underlyingModel };
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
  const route = settings.taskRouting?.[task];
  if (!route) return [];
  const targets: RoutingTarget[] = [...(route.primary ? [route.primary] : []), ...(route.fallbacks ?? [])];
  const mapped = targets.map((target) => isChatTask(task)
    ? chatCandidateFromTarget(settings, target)
    : mediaCandidateFromTarget(settings, target, task));
  return mapped.filter((c): c is TaskCandidate => Boolean(c));
}

function hasConfiguredRoute(settings: AppSettings, task: RoutingTaskKind): boolean {
  const route = settings.taskRouting?.[task];
  return Boolean(route?.primary || route?.fallbacks?.length);
}

/** Legacy chat resolution tiers. Review honors its configured default before capability tags. */
function legacyChatCandidates(settings: AppSettings, capability: ChatCapability): TaskCandidate[] {
  const integrations = settings.aiIntegrations ?? [];
  const out: TaskCandidate[] = [];
  const push = (integration: AIIntegration, model?: string, pricing?: AIPricing) => {
    if (!model || integration.provider === "m365_copilot") return;
    const entry = integrationChatModels(integration).find((candidate) => candidate.name === model);
    out.push({ integration, model, pricing, maxInputTokens: entry?.maxInputTokens, maxOutputTokens: entry?.maxOutputTokens, underlyingModel: entry?.underlyingModel });
  };
  // Review precedence: explicit route (handled by the caller) → default review integration
  // → capability tags → default writing integration → any remaining integration.
  if (capability === "review") {
    const review = resolveReviewIntegration(settings);
    if (review) {
      const models = integrationChatModels(review);
      const picked = models.find((m) => m.capabilities?.includes("review")) ?? models.find((m) => m.capabilities?.includes("default")) ?? models[0];
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
    const picked = models.find((m) => m.capabilities?.includes(capability)) ?? models.find((m) => m.capabilities?.includes("default")) ?? models[0];
    if (picked) push(preferred, picked.name, picked.pricing ?? preferred.pricing);
  }
  // 3) any default model anywhere
  for (const integration of integrations) {
    const models = integrationChatModels(integration);
    const picked = models.find((m) => m.capabilities?.includes(capability)) ?? models.find((m) => m.capabilities?.includes("default")) ?? models[0];
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
  if (hasConfiguredRoute(settings, task)) return dedupe(router);
  const legacy = isChatTask(task)
    ? legacyChatCandidates(settings, task)
    : legacyMediaCandidates(settings, task as "tts" | "stt" | "image");
  return dedupe([...router, ...legacy]);
}

/** The candidates execution can actually use after disclosure policy is applied. */
export function resolveEffectiveTaskCandidates(settings: AppSettings, task: RoutingTaskKind): TaskCandidate[] {
  return applySameBoundaryPolicy(settings, resolveTaskCandidates(settings, task));
}

/**
 * Run a chat completion for a capability using the configured router (primary + fallbacks),
 * then the legacy resolution, trying each candidate in order until one succeeds.
 */
export async function completeTextRouted(
  settings: AppSettings,
  messages: LlmMessage[],
  capability: ChatCapability,
  options: { accountScope: string | null; signal?: AbortSignal; label?: string; onText?: (text: string) => void; preferred?: RoutingTarget },
): Promise<string> {
  const operation = beginAccountScopedAiOperation(options?.signal, options?.accountScope);
  try {
  const preferred = options?.preferred ? chatCandidateFromTarget(settings, options.preferred) : null;
  const candidates = applySameBoundaryPolicy(settings, dedupe([...(preferred ? [preferred] : []), ...resolveTaskCandidates(settings, capability)]));
  if (!candidates.length) {
    if (hasConfiguredRoute(settings, capability)) throw new StaleRoutingConfigurationError(capability);
    throw new NoCompletionCandidatesError();
  }
  const purpose = capability === "review" ? "review" : "writing";
  const executable = candidates.map((candidate, routeCandidateIndex) => ({ ...candidate, routeCandidateIndex })).filter((candidate) => candidate.integration && candidate.model).map((candidate) => ({ ...candidate, integration: candidate.integration!, model: candidate.model!, label: `${candidate.integration!.provider}/${candidate.model!}` }));
  if (!executable.length) throw new NoCompletionCandidatesError();
  return await executeCompletionFallback({ candidates: executable, signal: operation.signal, timeoutMs: (candidate) => candidate.integration.requestTimeoutMs, beforeCandidate: (candidate, index) => { if (index > 0) acknowledgeCrossBoundaryFallback({ settings, kind: "text", from: executable[index - 1], to: candidate, accountScope: operation.accountScope }); }, resetPartial: () => options?.onText?.(""), run: (candidate, signal) => completeText(candidate.integration, budgetLlmMessages(messages, candidate.maxInputTokens, candidate.maxOutputTokens), purpose, {
        modelName: candidate.model,
        capability,
        signal,
        label: options?.label,
        onText: options?.onText,
        routeCandidateIndex: candidate.routeCandidateIndex,
        usedFallback: candidate.routeCandidateIndex > 0,
        maxOutputTokens: resolveModelTokenBudgets(candidate.maxInputTokens, candidate.maxOutputTokens).outputTokens,
        underlyingModel: candidate.underlyingModel,
        accountScope: operation.accountScope,
      }) });
  } finally {
    operation.dispose();
  }
}

export async function completeToolRouted<T>(
  settings: AppSettings,
  messages: LlmMessage[],
  capability: ChatCapability,
  tool: ForcedToolDefinition,
  options: { accountScope: string | null; signal?: AbortSignal; label?: string; validate?: (output: unknown) => T },
): Promise<LlmResult<T> & { metadata: RoutedLlmRunMetadata }> {
  const operation = beginAccountScopedAiOperation(options?.signal, options?.accountScope);
  try {
  const candidates = applySameBoundaryPolicy(settings, resolveTaskCandidates(settings, capability));
  if (!candidates.length) {
    if (hasConfiguredRoute(settings, capability)) throw new StaleRoutingConfigurationError(capability);
    throw new NoCompletionCandidatesError();
  }
  let lastError: unknown = null;
  for (const [candidateIndex, candidate] of candidates.entries()) {
    operation.signal.throwIfAborted();
    if (!candidate.integration || !candidate.model) continue;
    if (candidateIndex > 0) acknowledgeCrossBoundaryFallback({ settings, kind: "text", from: candidates[candidateIndex - 1], to: candidate, accountScope: operation.accountScope });
    try {
      const budgetedMessages = budgetForcedToolMessages(messages, candidate, tool);
      const result = await runWithCandidateTimeout((signal) => completeToolWith<T>(candidate.integration!, candidate.model!, candidate.pricing, budgetedMessages, capability, tool, { accountScope: operation.accountScope, signal, label: options.label, currency: settings.costCurrency, validate: options.validate, routeCandidateIndex: candidateIndex, usedFallback: candidateIndex > 0, maxOutputTokens: resolveModelTokenBudgets(candidate.maxInputTokens, candidate.maxOutputTokens).outputTokens, underlyingModel: candidate.underlyingModel }), operation.signal, candidate.integration.requestTimeoutMs);
      return {
        ...result,
        output: options?.validate ? options.validate(result.output) : result.output as T,
        metadata: { ...result.metadata, routeCandidateIndex: candidateIndex, usedFallback: candidateIndex > 0 },
      };
    } catch (err) {
      if (operation.signal.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error("All AI candidates failed for this task.");
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

/** Confirmation classification with router (simple-tasks) + fallbacks. Returns "unclear" if all fail. */
export async function classifyConfirmationRouted(settings: AppSettings, utterance: string, operationSignal: AbortSignal | undefined, accountScope: string | null): Promise<"yes" | "no" | "unclear"> {
  const operation = beginAccountScopedAiOperation(operationSignal, accountScope);
  try {
  const candidates = applySameBoundaryPolicy(settings, resolveTaskCandidates(settings, "simple-tasks"));
  for (const [candidateIndex, candidate] of candidates.entries()) {
    operation.signal.throwIfAborted();
    if (!candidate.integration || !candidate.model) continue;
    if (candidateIndex > 0) acknowledgeCrossBoundaryFallback({ settings, kind: "text", from: candidates[candidateIndex - 1], to: candidate, accountScope: operation.accountScope });
    try {
      const budgetedMessages = budgetForcedToolMessages([{ role: "user", content: currentRequest(utterance) }], candidate, CONFIRMATION_TOOL_DEFINITION);
      const budgetedUtterance = budgetedMessages[0]?.content;
      if (typeof budgetedUtterance !== "string") throw new CandidateInputBudgetError();
      return await runWithCandidateTimeout(
        (signal) => classifyConfirmationWith(candidate.integration!, candidate.model!, candidate.pricing, budgetedUtterance, { accountScope: operation.accountScope, signal, maxOutputTokens: Math.min(32, resolveModelTokenBudgets(candidate.maxInputTokens, candidate.maxOutputTokens).outputTokens), routeCandidateIndex: candidateIndex, usedFallback: candidateIndex > 0, underlyingModel: candidate.underlyingModel }),
        operation.signal,
        candidate.integration.requestTimeoutMs,
      );
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
