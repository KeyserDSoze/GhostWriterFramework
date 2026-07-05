import type { AIIntegration, AIPricing, AppSettings, ChatCapability, RoutingTarget, RoutingTaskKind } from "@/types/settings";
import { integrationChatModels, resolveWritingIntegration, completeText, classifyConfirmationWith, type LlmMessage } from "@/assistant/llm";

export interface TaskCandidate {
  integration: AIIntegration;
  model: string;
  pricing?: AIPricing;
}

const CHAT_CAPABILITIES_SET = new Set<RoutingTaskKind>(["default", "copilot", "simple-tasks", "review"]);

function isChatTask(task: RoutingTaskKind): task is ChatCapability {
  return CHAT_CAPABILITIES_SET.has(task);
}

function findIntegration(settings: AppSettings, id: string): AIIntegration | undefined {
  return (settings.aiIntegrations ?? []).find((i) => i.id === id);
}

/** Chat: pricing = model's own price, else integration price. */
function chatCandidateFromTarget(settings: AppSettings, target: RoutingTarget): TaskCandidate | null {
  const integration = findIntegration(settings, target.integrationId);
  if (!integration || integration.provider === "m365_copilot") return null;
  const model = target.model?.trim();
  if (!model) return null;
  const modelEntry = integrationChatModels(integration).find((m) => m.name === model);
  return { integration, model, pricing: modelEntry?.pricing ?? integration.pricing };
}

/** Media (tts/stt/image): only OpenAI/Azure; pricing = integration price. */
function mediaCandidateFromTarget(settings: AppSettings, target: RoutingTarget): TaskCandidate | null {
  const integration = findIntegration(settings, target.integrationId);
  if (!integration) return null;
  if (integration.provider !== "openai" && integration.provider !== "azure_openai") return null;
  const model = target.model?.trim();
  if (!model) return null;
  return { integration, model, pricing: integration.pricing };
}

function dedupe(candidates: TaskCandidate[]): TaskCandidate[] {
  const seen = new Set<string>();
  const out: TaskCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.integration.id}::${c.model}`;
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
  const map = isChatTask(task) ? chatCandidateFromTarget : mediaCandidateFromTarget;
  return targets.map((t) => map(settings, t)).filter((c): c is TaskCandidate => Boolean(c));
}

/** Legacy chat resolution tiers (capability match anywhere → default-writing → any default). */
function legacyChatCandidates(settings: AppSettings, capability: ChatCapability): TaskCandidate[] {
  const integrations = settings.aiIntegrations ?? [];
  const out: TaskCandidate[] = [];
  const push = (integration: AIIntegration, model?: string, pricing?: AIPricing) => {
    if (!model || integration.provider === "m365_copilot") return;
    out.push({ integration, model, pricing });
  };
  // 1) exact capability match anywhere
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
  const legacy = isChatTask(task)
    ? legacyChatCandidates(settings, task)
    : legacyMediaCandidates(settings, task as "tts" | "stt" | "image");
  return dedupe([...router, ...legacy]);
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

/**
 * Run a chat completion for a capability using the configured router (primary + fallbacks),
 * then the legacy resolution, trying each candidate in order until one succeeds.
 */
export async function completeTextRouted(
  settings: AppSettings,
  messages: LlmMessage[],
  capability: ChatCapability,
  options?: { signal?: AbortSignal; label?: string },
): Promise<string> {
  const candidates = resolveTaskCandidates(settings, capability);
  if (!candidates.length) throw new Error("No AI integration configured for this task.");
  const purpose = capability === "review" ? "review" : "writing";
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return await completeText(candidate.integration, messages, purpose, {
        modelName: candidate.model,
        capability,
        signal: options?.signal,
        label: options?.label,
      });
    } catch (err) {
      if (isAbort(err) || options?.signal?.aborted) throw err;
      lastError = err;
      // Move on to the next candidate (fallback).
    }
  }
  throw lastError ?? new Error("All AI candidates failed for this task.");
}

/** Confirmation classification with router (simple-tasks) + fallbacks. Returns "unclear" if all fail. */
export async function classifyConfirmationRouted(settings: AppSettings, utterance: string): Promise<"yes" | "no" | "unclear"> {
  const candidates = resolveTaskCandidates(settings, "simple-tasks");
  for (const candidate of candidates) {
    try {
      return await classifyConfirmationWith(candidate.integration, candidate.model, candidate.pricing, utterance);
    } catch {
      // try next fallback
    }
  }
  return "unclear";
}
