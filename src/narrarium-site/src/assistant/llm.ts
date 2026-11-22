import OpenAI, { AzureOpenAI } from "openai";
import { completionTokenLimit, forcedToolChoice, isEmptyToolArguments, parseStructuredText, splitReasoningBlock } from "narrarium-engine";
import type { AIIntegration, AIPricing, AppSettings, ChatCapability, ChatModel } from "@/types/settings";
import { chatDelta, useCostsStore } from "@/costs/costsStore";
import { flattenLlmContent, useLlmDebugStore, type LlmDebugMessage } from "@/debug/llmDebugStore";
import { GITHUB_MODELS_INFERENCE_URL } from "@/config/githubModels";
import { CandidateTimeoutError } from "@/assistant/executionLimits";
import { beginAccountScopedAiOperation } from "@/assistant/accountScopedOperation";
import { currentRequest } from "@/assistant/promptTrust";

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string };

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | LlmContentPart[];
}

export interface LlmRunMetadata {
  requestId: string;
  task: ChatCapability;
  provider: AIIntegration["provider"];
  integrationId: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost?: number;
  currency?: string;
}

export interface LlmResult<T> {
  output: T;
  metadata: LlmRunMetadata;
}

export interface ForcedToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const CONFIRMATION_TOOL_DEFINITION: ForcedToolDefinition = {
  name: "confirm",
  description: "Report whether the user is confirming, rejecting, or being unclear.",
  parameters: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["yes", "no", "unclear"], description: "yes = confirms/accepts, no = rejects/cancels, unclear = neither" },
    },
    required: ["decision"],
  },
};

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

export function modelSupportsCapability(model: ChatModel, capability: ChatCapability): boolean {
  return model.capabilities?.includes(capability) || model.capabilities?.includes("default");
}

/** Pick the model inside one integration that serves a capability (or its default fallback). */
function pickModelInIntegration(integration: AIIntegration, capability: ChatCapability): ChatModel | null {
  const models = integrationChatModels(integration);
  if (!models.length) return null;
  return (
    models.find((m) => m.capabilities?.includes(capability)) ??
    models.find((m) => m.capabilities?.includes("default")) ??
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

export class ContentFilteredCompletionError extends Error {
  constructor() {
    super("The provider filtered the completion content.");
    this.name = "ContentFilteredCompletionError";
  }
}

export { completionTokenLimit };

function debugFailure(error: unknown, signal?: AbortSignal): { status: "error"; error: string; failureKind: "timeout" | "cancelled" | "provider"; timeoutMs?: number } {
  const converted = signal?.reason instanceof CandidateTimeoutError ? signal.reason : error;
  if (converted instanceof CandidateTimeoutError) return { status: "error", error: converted.message, failureKind: "timeout", timeoutMs: converted.timeoutMs };
  const cancelled = signal?.aborted === true;
  return { status: "error", error: converted instanceof Error ? converted.message : String(converted), failureKind: cancelled ? "cancelled" : "provider" };
}

export interface LlmUsageReport {
  model: string;
  provider: AIIntegration["provider"];
  integrationId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost?: number;
}

/**
 * How one provider attempt ended, reported only to callers that ask for it (the autopilot):
 * the finish reason, how much reply text arrived and how many reasoning characters preceded it.
 * The reasoning itself is never kept.
 */
export interface LlmFinishReport extends LlmUsageReport {
  finishReason: string;
  replyCharacters: number;
  reasoningCharacters: number;
}

/** Characters of reasoning in a message or stream delta (`reasoning_content` or `reasoning`). */
function reasoningLength(source: unknown): number {
  if (!source || typeof source !== "object") return 0;
  const { reasoning_content: content, reasoning } = source as { reasoning_content?: unknown; reasoning?: unknown };
  return (typeof content === "string" ? content.length : 0) + (typeof reasoning === "string" ? reasoning.length : 0);
}

/** The deployed API version decides which `tool_choice` forms Azure OpenAI accepts. */
function toolChoiceFor(integration: AIIntegration, toolName: string) {
  return forcedToolChoice(integration.provider, integration.provider === "azure_openai" ? integration.apiVersion || "2024-10-21" : undefined, toolName);
}

/** JSON in a text reply, or undefined: models that ignore the forced tool often answer in the content. */
function structuredTextOrUndefined(text: string, tool: ForcedToolDefinition): unknown {
  try {
    return parseStructuredText(text, tool);
  } catch {
    return undefined;
  }
}

type ToolReplyMessage = { content?: unknown; tool_calls?: Array<{ function?: { arguments?: string } }> };

/** The forced tool's arguments, else the JSON written in the content (also when the arguments are `{}`). */
function forcedToolOutput(message: ToolReplyMessage | undefined, tool: ForcedToolDefinition): { output: unknown; raw: string } {
  const args = message?.tool_calls?.find((call) => typeof call.function?.arguments === "string")?.function?.arguments;
  const content = typeof message?.content === "string" ? message.content : "";
  if (args && !isEmptyToolArguments(args)) {
    try {
      return { output: JSON.parse(args) as unknown, raw: args };
    } catch (error) {
      const recovered = structuredTextOrUndefined(args, tool);
      if (recovered === undefined) throw error;
      return { output: recovered, raw: args };
    }
  }
  const fromContent = content.trim() ? structuredTextOrUndefined(content, tool) : undefined;
  if (fromContent !== undefined) return { output: fromContent, raw: content };
  if (args) return { output: JSON.parse(args) as unknown, raw: args };
  throw new Error(`Model did not call forced tool ${tool.name}.`);
}

export async function completeText(
  integration: AIIntegration,
  messages: LlmMessage[],
  purpose: "writing" | "review" = "writing",
  options: { accountScope: string | null; signal?: AbortSignal; capability?: ChatCapability; modelName?: string; label?: string; onText?: (text: string) => void; onUsage?: (usage: LlmUsageReport) => void; onFinish?: (report: LlmFinishReport) => void; routeCandidateIndex?: number; usedFallback?: boolean; maxOutputTokens?: number; underlyingModel?: string },
): Promise<string> {
  const operation = beginAccountScopedAiOperation(options.signal, options.accountScope);
  let debugId = "";
  try {
  const { model, pricing } = resolveModelForCall(integration, purpose, options);
  const usageReport = (usage: unknown): LlmUsageReport => {
    const normalized = normalizeUsage(usage);
    return { model, provider: integration.provider, integrationId: integration.id, ...normalized, cost: pricing ? chatDelta({ inputTokens: normalized.inputTokens, cachedTokens: normalized.cachedInputTokens, outputTokens: normalized.outputTokens }, pricing).chatCost : undefined };
  };
  const reportUsage = (usage: unknown) => {
    if (options.onUsage) options.onUsage(usageReport(usage));
  };
  const reportFinish = (usage: unknown, finishReason: string, text: string, reasoningCharacters: number) => {
    if (!options.onFinish) return;
    const inline = splitReasoningBlock(text);
    options.onFinish({ ...usageReport(usage), finishReason, replyCharacters: inline.reply.trim().length, reasoningCharacters: reasoningCharacters + inline.reasoningCharacters });
  };

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
  const contentKinds = messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image")) ? ["text", "image"] as const : ["text"] as const;
  debugId = useLlmDebugStore.getState().begin({ kind: "chat", contentKinds: [...contentKinds], label: options?.label ?? purpose, model, provider: integration.provider, integrationId: integration.id, routeCandidateIndex: options?.routeCandidateIndex, usedFallback: options?.usedFallback, messages: debugMessages });

    if (integration.provider === "azure_openai") {
      const client = new AzureOpenAI({
        endpoint: integration.endpoint ?? "",
        apiKey: integration.apiKey,
        apiVersion: integration.apiVersion || "2024-10-21",
        dangerouslyAllowBrowser: true,
      });
      if (options?.onText) {
        const stream = await client.chat.completions.create({ model, messages: normalizedMessages as never, stream: true, stream_options: { include_usage: true }, ...completionTokenLimit(integration.provider, model, options.maxOutputTokens, options.underlyingModel, integration.apiVersion) } as never, { signal: operation.signal }) as unknown as AsyncIterable<{ choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>; usage?: unknown }>;
        let text = "";
        let usage: unknown;
        let filtered = false;
        let finishReason = "";
        let reasoning = 0;
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          reasoning += reasoningLength(chunk.choices?.[0]?.delta);
          if (delta) {
            text += delta;
            options.onText(text);
          }
          if (chunk.usage) usage = chunk.usage;
          if (chunk.choices?.some((choice) => choice.finish_reason === "content_filter")) filtered = true;
          finishReason = chunk.choices?.find((choice) => choice.finish_reason)?.finish_reason ?? finishReason;
        }
        recordChatUsage(model, pricing, usage);
        reportUsage(usage);
        finishChatDebug(debugId, pricing, usage, text);
        reportFinish(usage, finishReason, text, reasoning);
        if (filtered) throw new ContentFilteredCompletionError();
        return text;
      }
      const response = await client.chat.completions.create({ model, messages: normalizedMessages as never, ...completionTokenLimit(integration.provider, model, options?.maxOutputTokens, options?.underlyingModel, integration.apiVersion) }, { signal: operation.signal });
      recordChatUsage(model, pricing, response.usage);
      reportUsage(response.usage);
      const text = response.choices[0]?.message?.content ?? "";
      finishChatDebug(debugId, pricing, response.usage, text);
      reportFinish(response.usage, response.choices[0]?.finish_reason ?? "", text, reasoningLength(response.choices[0]?.message));
      if (response.choices[0]?.finish_reason === "content_filter") throw new ContentFilteredCompletionError();
      return text;
    }

    if (integration.provider === "openai" || integration.provider === "github_models") {
      const client = new OpenAI({
        apiKey: integration.apiKey,
        baseURL: openAiBaseUrl(integration),
        dangerouslyAllowBrowser: true,
      });
      if (options?.onText) {
        const stream = await client.chat.completions.create({ model, messages: normalizedMessages as never, stream: true, stream_options: { include_usage: true }, ...completionTokenLimit(integration.provider, model, options.maxOutputTokens, options.underlyingModel, integration.apiVersion) } as never, { signal: operation.signal }) as unknown as AsyncIterable<{ choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>; usage?: unknown }>;
        let text = "";
        let usage: unknown;
        let filtered = false;
        let finishReason = "";
        let reasoning = 0;
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          reasoning += reasoningLength(chunk.choices?.[0]?.delta);
          if (delta) {
            text += delta;
            options.onText(text);
          }
          if (chunk.usage) usage = chunk.usage;
          if (chunk.choices?.some((choice) => choice.finish_reason === "content_filter")) filtered = true;
          finishReason = chunk.choices?.find((choice) => choice.finish_reason)?.finish_reason ?? finishReason;
        }
        recordChatUsage(model, pricing, usage);
        reportUsage(usage);
        finishChatDebug(debugId, pricing, usage, text);
        reportFinish(usage, finishReason, text, reasoning);
        if (filtered) throw new ContentFilteredCompletionError();
        return text;
      }
      const response = await client.chat.completions.create({ model, messages: normalizedMessages as never, ...completionTokenLimit(integration.provider, model, options?.maxOutputTokens, options?.underlyingModel, integration.apiVersion) }, { signal: operation.signal });
      recordChatUsage(model, pricing, response.usage);
      reportUsage(response.usage);
      const text = response.choices[0]?.message?.content ?? "";
      finishChatDebug(debugId, pricing, response.usage, text);
      reportFinish(response.usage, response.choices[0]?.finish_reason ?? "", text, reasoningLength(response.choices[0]?.message));
      if (response.choices[0]?.finish_reason === "content_filter") throw new ContentFilteredCompletionError();
      return text;
    }

    useLlmDebugStore.getState().finish(debugId, { status: "error", error: "Microsoft 365 Copilot is not wired into the in-browser assistant." });
    throw new Error("Microsoft 365 Copilot is not yet wired into the in-browser assistant.");
  } catch (err) {
    if (integration.provider !== "m365_copilot") {
      useLlmDebugStore.getState().finish(debugId, debugFailure(err, operation.signal));
    }
    throw err;
  } finally {
    operation.dispose();
  }
}

export async function completeToolWith<T>(
  integration: AIIntegration,
  model: string,
  pricing: AIPricing | undefined,
  messages: LlmMessage[],
  capability: ChatCapability,
  tool: ForcedToolDefinition,
  options: { accountScope: string | null; signal?: AbortSignal; label?: string; currency?: string; validate?: (output: unknown) => T; onFinish?: (report: LlmFinishReport) => void; routeCandidateIndex?: number; usedFallback?: boolean; maxOutputTokens?: number; underlyingModel?: string },
): Promise<LlmResult<T>> {
  const operation = beginAccountScopedAiOperation(options.signal, options.accountScope);
  let debugId = "";
  try {
  if (integration.provider === "m365_copilot") throw new Error("Microsoft 365 Copilot does not support browser tool calls.");
  const normalizedMessages = messages.map((message) => ({
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content.map((part) => part.type === "text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: part.dataUrl } })
      : message.content,
  }));
  const debugMessages: LlmDebugMessage[] = messages.map((message) => ({ role: message.role, content: flattenLlmContent(message.content) }));
  debugId = useLlmDebugStore.getState().begin({ kind: "chat", contentKinds: ["text"], label: options?.label ?? capability, model, provider: integration.provider, integrationId: integration.id, routeCandidateIndex: options?.routeCandidateIndex, usedFallback: options?.usedFallback, messages: debugMessages });
    const client = integration.provider === "azure_openai"
      ? new AzureOpenAI({ endpoint: integration.endpoint ?? "", apiKey: integration.apiKey, apiVersion: integration.apiVersion || "2024-10-21", dangerouslyAllowBrowser: true })
      : new OpenAI({ apiKey: integration.apiKey, baseURL: openAiBaseUrl(integration), dangerouslyAllowBrowser: true });
    const response = await client.chat.completions.create({
      model,
      messages: normalizedMessages as never,
      tools: [{ type: "function", function: tool }],
      // Only one tool is sent: "required" forces it on llama.cpp and LM Studio too, which ignore the named form.
      tool_choice: toolChoiceFor(integration, tool.name),
      ...completionTokenLimit(integration.provider, model, options?.maxOutputTokens, options?.underlyingModel, integration.apiVersion),
    } as never, { signal: operation.signal });
    const usage = response.usage;
    recordChatUsage(model, pricing, usage);
    const normalized = normalizeUsage(usage);
    const cost = pricing ? chatDelta({ inputTokens: normalized.inputTokens, cachedTokens: normalized.cachedInputTokens, outputTokens: normalized.outputTokens }, pricing).chatCost : undefined;
    const choice = (response as unknown as { choices?: Array<{ message?: ToolReplyMessage; finish_reason?: string | null }> }).choices?.[0];
    if (options.onFinish) {
      const toolText = choice?.message?.tool_calls?.map((call) => call.function?.arguments ?? "").join("") ?? "";
      const inline = splitReasoningBlock(typeof choice?.message?.content === "string" ? choice.message.content : "");
      options.onFinish({ model, provider: integration.provider, integrationId: integration.id, ...normalized, cost, finishReason: choice?.finish_reason ?? "", replyCharacters: (isEmptyToolArguments(toolText) ? "" : toolText).trim().length + inline.reply.trim().length, reasoningCharacters: reasoningLength(choice?.message) + inline.reasoningCharacters });
    }
    const { output: parsed, raw } = forcedToolOutput(choice?.message, tool);
    const output = options?.validate ? options.validate(parsed) : parsed as T;
    finishChatDebug(debugId, pricing, usage, raw);
    return {
      output,
      metadata: {
        requestId: debugId,
        task: capability,
        provider: integration.provider,
        integrationId: integration.id,
        model,
        inputTokens: normalized.inputTokens,
        cachedInputTokens: normalized.cachedInputTokens,
        outputTokens: normalized.outputTokens,
        cost,
        currency: options?.currency,
      },
    };
  } catch (err) {
    useLlmDebugStore.getState().finish(debugId, debugFailure(err, operation.signal));
    throw err;
  } finally {
    operation.dispose();
  }
}

/**
 * Minimal yes/no understanding for a short user utterance, using a forced tool call.
 * Picks the "simple-tasks" model (falling back to "default") and sends no system prompt
 * or history — just the utterance — so it costs as little as possible.
 * Returns "yes" | "no" | "unclear".
 */
export async function classifyConfirmation(settings: AppSettings, utterance: string, accountScope: string | null): Promise<"yes" | "no" | "unclear"> {
  const resolved = resolveChatModel(settings, "simple-tasks");
  if (!resolved) return "unclear";
  try {
    return await classifyConfirmationWith(resolved.integration, resolved.model, resolved.pricing, currentRequest(utterance), { accountScope });
  } catch {
    return "unclear";
  }
}

/** Single-attempt confirmation classification against one integration+model. Throws on error. */
export async function classifyConfirmationWith(
  integration: AIIntegration,
  model: string,
  pricing: AIPricing | undefined,
  framedRequest: string,
  options: { accountScope: string | null; signal?: AbortSignal; maxOutputTokens?: number; routeCandidateIndex?: number; usedFallback?: boolean; underlyingModel?: string },
): Promise<"yes" | "no" | "unclear"> {
  const operation = beginAccountScopedAiOperation(options.signal, options.accountScope);
  let debugId = "";
  try {
  if (integration.provider === "m365_copilot") return "unclear";

  const tools = [{ type: "function" as const, function: CONFIRMATION_TOOL_DEFINITION }];

  const body = {
    model,
    messages: [{ role: "user", content: framedRequest }],
    tools,
    tool_choice: toolChoiceFor(integration, CONFIRMATION_TOOL_DEFINITION.name),
    ...completionTokenLimit(integration.provider, model, options?.maxOutputTokens, options?.underlyingModel, integration.apiVersion),
  };

  debugId = useLlmDebugStore.getState().begin({ kind: "chat", contentKinds: ["text"], label: "confirm", model, provider: integration.provider, integrationId: integration.id, routeCandidateIndex: options?.routeCandidateIndex, usedFallback: options?.usedFallback, messages: [{ role: "user", content: framedRequest }] });
    const client = integration.provider === "azure_openai"
      ? new AzureOpenAI({ endpoint: integration.endpoint ?? "", apiKey: integration.apiKey, apiVersion: integration.apiVersion || "2024-10-21", dangerouslyAllowBrowser: true })
      : new OpenAI({ apiKey: integration.apiKey, baseURL: openAiBaseUrl(integration), dangerouslyAllowBrowser: true });
    const response = await client.chat.completions.create(body as never, { signal: operation.signal });
    recordChatUsage(model, pricing, (response as { usage?: unknown }).usage);
    const message = (response as { choices?: Array<{ message?: ToolReplyMessage }> }).choices?.[0]?.message;
    const call = message?.tool_calls?.[0];
    const args = (call?.function?.arguments
      ? JSON.parse(call.function.arguments)
      : typeof message?.content === "string" && message.content.trim() ? structuredTextOrUndefined(message.content, CONFIRMATION_TOOL_DEFINITION) : null) as { decision?: unknown } | null | undefined;
    const decision = args?.decision;
    const result = decision === "yes" || decision === "no" ? decision : "unclear";
    finishChatDebug(debugId, pricing, (response as { usage?: unknown }).usage, `decision: ${result}`);
    return result;
  } catch (err) {
    useLlmDebugStore.getState().finish(debugId, debugFailure(err, operation.signal));
    throw err;
  } finally {
    operation.dispose();
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

function normalizeUsage(usage: unknown): { inputTokens: number; cachedInputTokens: number; outputTokens: number } {
  const value = usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
  return {
    inputTokens: value?.prompt_tokens ?? 0,
    cachedInputTokens: value?.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: value?.completion_tokens ?? 0,
  };
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
