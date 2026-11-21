import { isAbortError, linkedSignal } from "../util/abort.js";
import { parseJsonReply, StructuredReplyError } from "../util/json.js";
import type { AiIntegrationConfig, AiPricingConfig, AiRuntimeConfig } from "./config.js";
import { resolveAiCandidates, type AiCandidate } from "./router.js";
import { completionTokenLimit, isReasoningModel } from "./token-limit.js";
import { AiProviderError, AiUnavailableError, type AiJsonSchema, type AiPort, type AiRequest, type AiResponse, type AiUsage } from "./types.js";

export const GITHUB_MODELS_BASE_URL = "https://models.github.ai";
const DEFAULT_TIMEOUT_MS = 600_000;

export interface FetchAiAttempt {
  label: string;
  capability: string;
  provider: string;
  model: string;
  integrationId: string;
  index: number;
}

export interface FetchAiOptions {
  fetch?: typeof fetch;
  /** Origin of GitHub Models (or of a proxy forwarding `/inference`). */
  githubModelsBaseUrl?: string;
  /** Used when an integration has no request timeout. */
  defaultTimeoutMs?: number;
  onAttempt?: (attempt: FetchAiAttempt) => void;
}

/**
 * OpenAI-compatible chat client built on `fetch`, usable from Node and browsers.
 * Supports OpenAI and compatible endpoints, Azure OpenAI and GitHub Models, streaming text,
 * forced function calls for structured output, and ordered fallbacks between candidates.
 */
export function createFetchAi(config: AiRuntimeConfig, options: FetchAiOptions = {}): AiPort {
  return {
    async complete(request: AiRequest): Promise<AiResponse> {
      const candidates = resolveAiCandidates(config, request.capability);
      if (!candidates.length) throw new AiUnavailableError(request.capability);
      let lastError: unknown = null;
      for (const [index, candidate] of candidates.entries()) {
        request.signal?.throwIfAborted();
        options.onAttempt?.({ label: request.label, capability: request.capability, provider: candidate.integration.provider, model: candidate.model, integrationId: candidate.integration.id, index });
        try {
          return await callCandidate(config, candidate, request, options);
        } catch (error) {
          if (request.signal?.aborted && isAbortError(error)) throw error;
          lastError = error;
          request.onText?.("");
        }
      }
      throw lastError instanceof Error ? lastError : new AiProviderError("All AI candidates failed.");
    },
  };
}

interface RequestTarget {
  url: string;
  headers: Record<string, string>;
}

function requestTarget(integration: AiIntegrationConfig, model: string, githubModelsBaseUrl: string): RequestTarget {
  const key = integration.apiKey.trim();
  if (integration.provider === "azure_openai") {
    const base = (integration.endpoint ?? "").trim().replace(/\/+$/, "");
    if (!base) throw new AiProviderError(`Azure OpenAI integration "${integration.name}" has no endpoint.`);
    const url = /\/openai\/v1$/i.test(base)
      ? `${base}/chat/completions`
      : `${base}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(integration.apiVersion || "2024-10-21")}`;
    return { url, headers: key ? { "api-key": key } : {} };
  }
  if (integration.provider === "github_models") {
    return { url: `${githubModelsBaseUrl.replace(/\/+$/, "")}/inference/chat/completions`, headers: key ? { authorization: `Bearer ${key}` } : {} };
  }
  if (integration.provider === "openai") {
    const base = (integration.endpoint || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    return { url: `${base}/chat/completions`, headers: key ? { authorization: `Bearer ${key}` } : {} };
  }
  throw new AiProviderError(`Provider ${integration.provider} cannot run chat tasks outside Microsoft 365.`);
}

function jsonInstruction(schema: AiJsonSchema): string {
  return `Reply with ONLY one JSON object, without code fences or commentary, matching this JSON schema (${schema.name}: ${schema.description}):\n${JSON.stringify(schema.parameters)}`;
}

function normalizeUsage(value: unknown): AiUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

/** Same formula as the web app's cost tracker: prices are per million tokens. */
export function estimateCost(usage: AiUsage | undefined, pricing: AiPricingConfig | undefined): number | undefined {
  if (!usage || !pricing) return undefined;
  const billedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (billedInput / 1_000_000) * (pricing.inputPerMTok ?? 0)
    + (usage.cachedInputTokens / 1_000_000) * (pricing.cachedPerMTok ?? 0)
    + (usage.outputTokens / 1_000_000) * (pricing.outputPerMTok ?? 0);
}

async function providerError(response: Response, provider: string, model: string): Promise<AiProviderError> {
  let detail = "";
  try {
    const raw = (await response.text()).slice(0, 2000);
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown };
      const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
      detail = typeof message === "string" ? message : raw;
    } catch {
      detail = raw;
    }
  } catch {
    detail = response.statusText;
  }
  const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
  return new AiProviderError(`${provider} ${model}: HTTP ${response.status}${detail ? ` — ${detail.replace(/\s+/g, " ").slice(0, 400)}` : ""}`, response.status, retryable);
}

async function readEventStream(response: Response, onData: (data: string) => void): Promise<void> {
  if (!response.body) throw new AiProviderError("The provider returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flushLine = (line: string): boolean => {
    const clean = line.replace(/\r$/, "");
    if (!clean.startsWith("data:")) return false;
    const data = clean.slice(5).trimStart();
    if (data === "[DONE]") return true;
    if (data) onData(data);
    return false;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (flushLine(line)) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flushLine(buffer);
}

async function callCandidate(config: AiRuntimeConfig, candidate: AiCandidate, request: AiRequest, options: FetchAiOptions): Promise<AiResponse> {
  const { integration, model } = candidate;
  const target = requestTarget(integration, model, options.githubModelsBaseUrl ?? GITHUB_MODELS_BASE_URL);
  const useTools = Boolean(request.json) && candidate.supportsToolCalls !== false;
  const stream = Boolean(request.onText) && !request.json;
  const system = request.json && !useTools ? `${request.system}\n\n${jsonInstruction(request.json)}` : request.system;
  const requested = request.maxOutputTokens;
  const outputLimit = requested && candidate.maxOutputTokens ? Math.min(requested, candidate.maxOutputTokens) : requested ?? candidate.maxOutputTokens;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: request.user },
    ],
    ...completionTokenLimit(integration.provider, model, outputLimit, candidate.underlyingModel),
  };
  if (request.temperature !== undefined && !isReasoningModel(integration.provider, model, candidate.underlyingModel)) body.temperature = request.temperature;
  if (useTools && request.json) {
    body.tools = [{ type: "function", function: request.json }];
    body.tool_choice = { type: "function", function: { name: request.json.name } };
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  const fetchImpl = options.fetch ?? fetch;
  const timer = linkedSignal(request.signal, integration.requestTimeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(target.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", ...target.headers },
        body: JSON.stringify(body),
        signal: timer.signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw new AiProviderError(`${integration.provider} ${model}: ${timer.timedOut() ? "request timed out" : error instanceof Error ? error.message : String(error)}`, undefined, true);
    }
    if (!response.ok) throw await providerError(response, integration.provider, model);

    let text = "";
    let toolArguments = "";
    let usage: AiUsage | undefined;
    let finishReason = "";
    if (stream) {
      await readEventStream(response, (data) => {
        let chunk: { choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>; usage?: unknown };
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          request.onText?.(text);
        }
        const reason = chunk.choices?.find((choice) => choice.finish_reason)?.finish_reason;
        if (reason) finishReason = reason;
        if (chunk.usage) usage = normalizeUsage(chunk.usage);
      });
    } else {
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { arguments?: string } }> }; finish_reason?: string | null }>;
        usage?: unknown;
      };
      const choice = payload.choices?.[0];
      text = choice?.message?.content ?? "";
      toolArguments = choice?.message?.tool_calls?.[0]?.function?.arguments ?? "";
      finishReason = choice?.finish_reason ?? "";
      usage = normalizeUsage(payload.usage);
    }
    if (finishReason === "content_filter") throw new AiProviderError(`${integration.provider} ${model}: the provider filtered the reply content.`);

    let json: unknown;
    if (request.json) {
      const source = toolArguments || text;
      try {
        json = toolArguments ? JSON.parse(toolArguments) : parseJsonReply(text);
      } catch {
        try {
          json = parseJsonReply(source);
        } catch (error) {
          throw new AiProviderError(`${integration.provider} ${model}: ${error instanceof StructuredReplyError ? error.message : "invalid structured reply"}${finishReason === "length" ? " (output token limit reached)" : ""}`, undefined, true);
        }
      }
      if (!text) text = source;
    }
    return {
      text,
      json,
      usage,
      model,
      provider: integration.provider,
      integrationId: integration.id,
      cost: estimateCost(usage, candidate.pricing),
      currency: config.costCurrency,
      truncated: finishReason === "length",
    };
  } finally {
    timer.dispose();
  }
}
