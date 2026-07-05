import OpenAI, { AzureOpenAI } from "openai";
import type { AIIntegration, AIPricing, AppSettings, ChatCapability, ChatModel } from "@/types/settings";
import { chatDelta, useCostsStore } from "@/costs/costsStore";
import { flattenLlmContent, useLlmDebugStore, type LlmDebugMessage } from "@/debug/llmDebugStore";
import { GITHUB_MODELS_INFERENCE_URL } from "@/config/githubModels";

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string };

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | LlmContentPart[];
}

export function resolveWritingIntegration(settings: AppSettings): AIIntegration | null {
  const integrations = settings.aiIntegrations ?? [];
  if (integrations.length === 0) return null;
  // Honor the configurable router's "default" primary integration when set.
  const routed = settings.taskRouting?.default?.primary?.integrationId;
  if (routed) {
    const match = integrations.find((entry) => entry.id === routed);
    if (match) return match;
  }
  return integrations.find((entry) => entry.id === settings.defaultWritingIntegrationId) ?? integrations[0] ?? null;
}

export function resolveReviewIntegration(settings: AppSettings): AIIntegration | null {
  const integrations = settings.aiIntegrations ?? [];
  if (integrations.length === 0) return null;
  const routed = settings.taskRouting?.review?.primary?.integrationId;
  if (routed) {
    const match = integrations.find((entry) => entry.id === routed);
    if (match) return match;
  }
  return integrations.find((entry) => entry.id === settings.defaultReviewIntegrationId) ?? integrations[0] ?? null;
}

/** The concrete model chosen to run a task, with the pricing to bill it against. */
export interface ResolvedChatModel {
  integration: AIIntegration;
  model: string;
  pricing?: AIPricing;
}

/** All chat models declared by an integration (new field), tolerant of the legacy shape. */
export function integrationChatModels(integration: AIIntegration): ChatModel[] {
  if (Array.isArray(integration.chatModels) && integration.chatModels.length) return integration.chatModels;
  // Legacy fallback: synthesise from the old single fields.
  const models: ChatModel[] = [];
  if (integration.modelWriting) models.push({ id: "legacy-writing", name: integration.modelWriting, capabilities: ["default", "copilot"] });
  if (integration.modelReview && integration.modelReview !== integration.modelWriting) {
    models.push({ id: "legacy-review", name: integration.modelReview, capabilities: ["review"] });
  }
  return models;
}

/** Pick the model inside one integration that serves a capability (or its default fallback). */
function pickModelInIntegration(integration: AIIntegration, capability: ChatCapability): ChatModel | null {
  const models = integrationChatModels(integration);
  if (!models.length) return null;
  return (
    models.find((m) => m.capabilities?.includes(capability)) ??
    models.find((m) => m.capabilities?.includes("default")) ??
    models[0] ??
    null
  );
}

/**
 * Resolve the best chat model across all integrations for a capability.
 * Order: a model tagged with the capability anywhere → the default-writing integration's
 * fallback → any default model → the first model found. Pricing prefers the model's own
 * pricing, then the integration pricing.
 */
export function resolveChatModel(settings: AppSettings, capability: ChatCapability): ResolvedChatModel | null {
  const integrations = settings.aiIntegrations ?? [];
  if (!integrations.length) return null;

  // 1) Exact capability match anywhere.
  for (const integration of integrations) {
    const exact = integrationChatModels(integration).find((m) => m.capabilities?.includes(capability));
    if (exact) return { integration, model: exact.name, pricing: exact.pricing ?? integration.pricing };
  }

  // 2) Default-writing integration fallback (keeps existing behaviour for unmapped tasks).
  const preferred = resolveWritingIntegration(settings);
  if (preferred) {
    const fallback = pickModelInIntegration(preferred, capability);
    if (fallback) return { integration: preferred, model: fallback.name, pricing: fallback.pricing ?? preferred.pricing };
  }

  // 3) Any default model anywhere.
  for (const integration of integrations) {
    const anyDefault = pickModelInIntegration(integration, capability);
    if (anyDefault) return { integration, model: anyDefault.name, pricing: anyDefault.pricing ?? integration.pricing };
  }
  return null;
}

/** Map the legacy "writing | review" purpose onto a capability. */
function purposeCapability(purpose: "writing" | "review"): ChatCapability {
  return purpose === "review" ? "review" : "default";
}

/** Pick the model + pricing for an integration given a purpose/capability override. */
function resolveModelForCall(
  integration: AIIntegration,
  purpose: "writing" | "review",
  options?: { capability?: ChatCapability; modelName?: string },
): { model: string; pricing?: AIPricing } {
  if (options?.modelName) {
    const explicit = integrationChatModels(integration).find((m) => m.name === options.modelName);
    return { model: options.modelName, pricing: explicit?.pricing ?? integration.pricing };
  }
  const capability = options?.capability ?? purposeCapability(purpose);
  const picked = pickModelInIntegration(integration, capability);
  if (picked) return { model: picked.name, pricing: picked.pricing ?? integration.pricing };
  // Legacy fallback so existing integrations without chatModels keep working.
  const legacy = purpose === "review"
    ? integration.modelReview || integration.modelWriting || "gpt-4o"
    : integration.modelWriting || integration.modelReview || "gpt-4o";
  return { model: legacy, pricing: integration.pricing };
}

/** Base URL for OpenAI-compatible providers (openai, github_models). */
function openAiBaseUrl(integration: AIIntegration): string {
  if (integration.provider === "github_models") return GITHUB_MODELS_INFERENCE_URL;
  return integration.endpoint || "https://api.openai.com/v1";
}

export async function completeText(
  integration: AIIntegration,
  messages: LlmMessage[],
  purpose: "writing" | "review" = "writing",
  options?: { signal?: AbortSignal; capability?: ChatCapability; modelName?: string; label?: string },
): Promise<string> {
  const { model, pricing } = resolveModelForCall(integration, purpose, options);

  const normalizedMessages = messages.map((message) => ({
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : { type: "image_url", image_url: { url: part.dataUrl } },
        )
      : message.content,
  }));

  const debugMessages: LlmDebugMessage[] = messages.map((m) => ({ role: m.role, content: flattenLlmContent(m.content) }));
  const debugId = useLlmDebugStore.getState().begin({ kind: "chat", label: options?.label ?? purpose, model, messages: debugMessages });

  try {
    if (integration.provider === "azure_openai") {
      const client = new AzureOpenAI({
        endpoint: integration.endpoint ?? "",
        apiKey: integration.apiKey,
        apiVersion: integration.apiVersion || "2024-10-21",
        dangerouslyAllowBrowser: true,
      });
      const response = await client.chat.completions.create({ model, messages: normalizedMessages as never }, { signal: options?.signal });
      recordChatUsage(model, pricing, response.usage);
      const text = response.choices[0]?.message?.content ?? "";
      finishChatDebug(debugId, pricing, response.usage, text);
      return text;
    }

    if (integration.provider === "openai" || integration.provider === "github_models") {
      const client = new OpenAI({
        apiKey: integration.apiKey,
        baseURL: openAiBaseUrl(integration),
        dangerouslyAllowBrowser: true,
      });
      const response = await client.chat.completions.create({ model, messages: normalizedMessages as never }, { signal: options?.signal });
      recordChatUsage(model, pricing, response.usage);
      const text = response.choices[0]?.message?.content ?? "";
      finishChatDebug(debugId, pricing, response.usage, text);
      return text;
    }

    useLlmDebugStore.getState().finish(debugId, { status: "error", error: "Microsoft 365 Copilot is not wired into the in-browser assistant." });
    throw new Error("Microsoft 365 Copilot is not yet wired into the in-browser assistant.");
  } catch (err) {
    if (integration.provider !== "m365_copilot") {
      useLlmDebugStore.getState().finish(debugId, { status: "error", error: err instanceof Error ? err.message : String(err) });
    }
    throw err;
  }
}

/**
 * Minimal yes/no understanding for a short user utterance, using a forced tool call.
 * Picks the "simple-tasks" model (falling back to "default") and sends no system prompt
 * or history — just the utterance — so it costs as little as possible.
 * Returns "yes" | "no" | "unclear".
 */
export async function classifyConfirmation(settings: AppSettings, utterance: string): Promise<"yes" | "no" | "unclear"> {
  const resolved = resolveChatModel(settings, "simple-tasks");
  if (!resolved) return "unclear";
  try {
    return await classifyConfirmationWith(resolved.integration, resolved.model, resolved.pricing, utterance);
  } catch {
    return "unclear";
  }
}

/** Single-attempt confirmation classification against one integration+model. Throws on error. */
export async function classifyConfirmationWith(
  integration: AIIntegration,
  model: string,
  pricing: AIPricing | undefined,
  utterance: string,
): Promise<"yes" | "no" | "unclear"> {
  if (integration.provider === "m365_copilot") return "unclear";

  const tools = [{
    type: "function" as const,
    function: {
      name: "confirm",
      description: "Report whether the user is confirming, rejecting, or being unclear.",
      parameters: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["yes", "no", "unclear"], description: "yes = confirms/accepts, no = rejects/cancels, unclear = neither" },
        },
        required: ["decision"],
      },
    },
  }];

  const body = {
    model,
    messages: [{ role: "user", content: utterance }],
    tools,
    tool_choice: { type: "function", function: { name: "confirm" } },
  };

  const debugId = useLlmDebugStore.getState().begin({ kind: "chat", label: "confirm", model, messages: [{ role: "user", content: utterance }] });
  try {
    const client = integration.provider === "azure_openai"
      ? new AzureOpenAI({ endpoint: integration.endpoint ?? "", apiKey: integration.apiKey, apiVersion: integration.apiVersion || "2024-10-21", dangerouslyAllowBrowser: true })
      : new OpenAI({ apiKey: integration.apiKey, baseURL: openAiBaseUrl(integration), dangerouslyAllowBrowser: true });
    const response = await client.chat.completions.create(body as never);
    recordChatUsage(model, pricing, (response as { usage?: unknown }).usage);
    const call = (response as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> }).choices?.[0]?.message?.tool_calls?.[0];
    const args = call?.function?.arguments ? JSON.parse(call.function.arguments) : null;
    const decision = args?.decision;
    const result = decision === "yes" || decision === "no" ? decision : "unclear";
    finishChatDebug(debugId, pricing, (response as { usage?: unknown }).usage, `decision: ${result}`);
    return result;
  } catch (err) {
    useLlmDebugStore.getState().finish(debugId, { status: "error", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

function recordChatUsage(model: string, pricing: AIPricing | undefined, usage: unknown): void {
  if (!pricing) return;
  const u = usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
  if (!u) return;
  const inputTokens = u.prompt_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? 0;
  const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
  if (!inputTokens && !outputTokens) return;
  useCostsStore.getState().recordCurrent(chatDelta({ inputTokens, cachedTokens, outputTokens }, pricing), model);
}

/** Complete a debug entry from a chat response, computing per-request cost. */
function finishChatDebug(id: string, pricing: AIPricing | undefined, usage: unknown, response: string): void {
  const u = usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
  const inputTokens = u?.prompt_tokens ?? 0;
  const outputTokens = u?.completion_tokens ?? 0;
  const cachedTokens = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const cost = pricing ? chatDelta({ inputTokens, cachedTokens, outputTokens }, pricing).chatCost : undefined;
  useLlmDebugStore.getState().finish(id, { status: "done", response, inputTokens, cachedTokens, outputTokens, cost });
}
