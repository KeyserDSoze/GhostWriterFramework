import { isAbortError, linkedSignal } from "../util/abort.js";
import type { AiIntegrationConfig, AiPricingConfig, AiRuntimeConfig } from "./config.js";
import { resolveAiCandidates, type AiCandidate } from "./router.js";
import { forcedToolChoice, splitReasoningBlock, structuredFromReply } from "./structured.js";
import { completionTokenLimit, isReasoningModel } from "./token-limit.js";
import { AiProviderError, AiReplyRejectedError, AiUnavailableError, type AiJsonSchema, type AiPort, type AiProviderErrorDetails, type AiRequest, type AiResponse, type AiUsage } from "./types.js";

export const GITHUB_MODELS_BASE_URL = "https://models.github.ai";
const DEFAULT_TIMEOUT_MS = 600_000;
/** Reasoning models spend output tokens before replying: small structured tasks get at least this limit. */
export const STRUCTURED_OUTPUT_FLOOR = 4096;

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
 * What failed attempts cost is added to the final response (or error), so budgets never under-count.
 */
export function createFetchAi(config: AiRuntimeConfig, options: FetchAiOptions = {}): AiPort {
  return {
    async complete(request: AiRequest): Promise<AiResponse> {
      const candidates = resolveAiCandidates(config, request.capability);
      if (!candidates.length) throw new AiUnavailableError(request.capability);
      let lastError: unknown = null;
      const spent: Spent = {};
      for (const [index, candidate] of candidates.entries()) {
        request.signal?.throwIfAborted();
        options.onAttempt?.({ label: request.label, capability: request.capability, provider: candidate.integration.provider, model: candidate.model, integrationId: candidate.integration.id, index });
        try {
          return withSpent(await callCandidate(config, candidate, request, options), spent);
        } catch (error) {
          if (request.signal?.aborted && isAbortError(error)) throw error;
          addSpent(spent, error);
          lastError = error;
          request.onText?.("");
        }
      }
      if (lastError instanceof AiProviderError) {
        lastError.usage = spent.usage ?? lastError.usage;
        lastError.cost = spent.cost ?? lastError.cost;
        throw lastError;
      }
      throw lastError instanceof Error ? lastError : new AiProviderError("All AI candidates failed.");
    },
  };
}

interface Spent {
  usage?: AiUsage;
  cost?: number;
}

function sumUsage(left: AiUsage | undefined, right: AiUsage | undefined): AiUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  };
}

function addSpent(spent: Spent, error: unknown): void {
  if (!(error instanceof AiProviderError)) return;
  spent.usage = sumUsage(spent.usage, error.usage);
  if (error.cost !== undefined) spent.cost = (spent.cost ?? 0) + error.cost;
}

function withSpent(response: AiResponse, spent: Spent): AiResponse {
  if (!spent.usage && spent.cost === undefined) return response;
  return {
    ...response,
    usage: sumUsage(response.usage, spent.usage),
    cost: spent.cost === undefined ? response.cost : (response.cost ?? 0) + spent.cost,
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

/** Reads server-sent events; resolves `true` when the provider closed the stream with `[DONE]`. */
async function readEventStream(response: Response, onData: (data: string) => void): Promise<boolean> {
  if (!response.body) throw new AiProviderError("The provider returned an empty stream.", undefined, true);
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
  try {
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
          return true;
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    return buffer.trim() ? flushLine(buffer) : false;
  } catch (error) {
    // The reply was given up (an error chunk, a failing listener): release the connection instead of leaving it open.
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

const COMPLETE_REASONS = new Set(["stop", "tool_calls", "function_call", "end_turn", "stop_sequence", "tool_use", "eos"]);
const TRUNCATED_REASONS = new Set(["length", "max_tokens", "max_output_tokens", "model_length", "context_length_exceeded"]);
const FILTERED_REASONS = new Set(["content_filter", "safety", "blocked", "recitation", "prohibited_content"]);
const FAILED_REASONS = new Set(["error", "failed", "abort", "aborted", "cancelled", "canceled"]);

export type FinishOutcome = "complete" | "truncated" | "filtered" | "failed" | "unexpected" | "incomplete";

/**
 * What a provider's `finish_reason` says about a reply. A known reason decides by itself. A reason this client does
 * not know is trusted only when the response also ended properly (`ended`: the `[DONE]` marker of a stream); with no
 * reason at all, only that end marker makes the reply complete.
 */
export function classifyFinishReason(reason: string, ended: boolean): FinishOutcome {
  const key = reason.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!key) return ended ? "complete" : "incomplete";
  if (COMPLETE_REASONS.has(key)) return "complete";
  if (TRUNCATED_REASONS.has(key)) return "truncated";
  if (FILTERED_REASONS.has(key)) return "filtered";
  if (FAILED_REASONS.has(key)) return "failed";
  return ended ? "complete" : "unexpected";
}

const PERMANENT_STREAM_ERROR = /authenticat|unauthori[sz]ed|forbidden|permission|invalid[_ -]?(?:request|api[_ -]?key|argument|parameter)|bad[_ -]?request/i;

/**
 * A failure the provider reported inside the stream (`{"error": {...}}` or `{"error": "..."}`), or `null` when the
 * chunk carries none. It is retried unless its status or code says authentication or an invalid request.
 */
function streamError(value: unknown, label: string, details: AiProviderErrorDetails): AiProviderError | null {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const message = typeof value === "string" ? value.trim() : typeof source?.message === "string" ? source.message.trim() : "";
  if (!source && !message) return null;
  const status = [source?.status, source?.status_code, source?.code]
    .map((entry) => (typeof entry === "number" ? entry : typeof entry === "string" && /^\d{3}$/.test(entry.trim()) ? Number(entry) : Number.NaN))
    .find((entry) => Number.isInteger(entry) && entry >= 100 && entry < 600);
  const words = [source?.type, source?.code, source?.status].filter((entry): entry is string => typeof entry === "string").join(" ");
  const permanent = (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) || PERMANENT_STREAM_ERROR.test(words);
  const detail = (message || (source && Object.keys(source).length ? JSON.stringify(source) : "no details")).replace(/\s+/g, " ").slice(0, 400);
  return new AiProviderError(`${label}: the provider reported an error during the reply — ${detail}`, status, !permanent, details);
}

/** Characters of reasoning a reply carried. Only the count is kept, never the reasoning itself. */
function reasoningLength(source: unknown): number {
  if (!source || typeof source !== "object") return 0;
  const { reasoning_content: content, reasoning } = source as { reasoning_content?: unknown; reasoning?: unknown };
  return (typeof content === "string" ? content.length : 0) + (typeof reasoning === "string" ? reasoning.length : 0);
}

/** The request's output limit, never above the model's own limit; structured tasks get a floor. */
export function requestOutputLimit(request: Pick<AiRequest, "json" | "maxOutputTokens">, candidate: Pick<AiCandidate, "maxOutputTokens">): number | undefined {
  const requested = request.json && request.maxOutputTokens ? Math.max(request.maxOutputTokens, STRUCTURED_OUTPUT_FLOOR) : request.maxOutputTokens;
  return requested && candidate.maxOutputTokens ? Math.min(requested, candidate.maxOutputTokens) : requested ?? candidate.maxOutputTokens;
}

async function callCandidate(config: AiRuntimeConfig, candidate: AiCandidate, request: AiRequest, options: FetchAiOptions): Promise<AiResponse> {
  const { integration, model } = candidate;
  const label = `${integration.provider} ${model}`;
  const target = requestTarget(integration, model, options.githubModelsBaseUrl ?? GITHUB_MODELS_BASE_URL);
  const useTools = Boolean(request.json) && candidate.supportsToolCalls !== false;
  const stream = Boolean(request.onText) && !request.json;
  const system = request.json && !useTools ? `${request.system}\n\n${jsonInstruction(request.json)}` : request.system;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: request.user },
    ],
    ...completionTokenLimit(integration.provider, model, requestOutputLimit(request, candidate), candidate.underlyingModel),
  };
  if (request.temperature !== undefined && !isReasoningModel(integration.provider, model, candidate.underlyingModel)) body.temperature = request.temperature;
  if (useTools && request.json) {
    body.tools = [{ type: "function", function: request.json }];
    body.tool_choice = forcedToolChoice(integration.provider, integration.apiVersion, request.json.name);
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
      throw new AiProviderError(`${label}: ${timer.timedOut() ? "request timed out" : error instanceof Error ? error.message : String(error)}`, undefined, true);
    }
    if (!response.ok) throw await providerError(response, integration.provider, model);

    let text = "";
    let toolArguments = "";
    let usage: AiUsage | undefined;
    let finishReason = "";
    let reasoningCharacters = 0;
    /** The response ended properly: a stream that closed with `[DONE]`, or a complete JSON body. */
    let ended = true;
    const details = (extra: AiProviderErrorDetails = {}): AiProviderErrorDetails => ({
      usage,
      cost: estimateCost(usage, candidate.pricing),
      currency: config.costCurrency,
      model,
      provider: integration.provider,
      integrationId: integration.id,
      ...extra,
    });
    try {
      if (stream) {
        ended = await readEventStream(response, (data) => {
          let chunk: { choices?: Array<{ delta?: { content?: string | null; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: string | null }>; usage?: unknown; error?: unknown };
          try {
            chunk = JSON.parse(data);
          } catch {
            return;
          }
          if (!chunk || typeof chunk !== "object") return;
          if (chunk.error) {
            const failure = streamError(chunk.error, label, details());
            if (failure) throw failure;
          }
          const delta = chunk.choices?.[0]?.delta;
          reasoningCharacters += reasoningLength(delta);
          if (delta?.content) {
            text += delta.content;
            request.onText?.(text);
          }
          const reason = chunk.choices?.find((choice) => typeof choice?.finish_reason === "string" && choice.finish_reason)?.finish_reason;
          if (reason) finishReason = reason;
          if (chunk.usage) usage = normalizeUsage(chunk.usage);
        });
      } else {
        const payload = await response.json() as {
          choices?: Array<{ message?: { content?: string | null; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: Array<{ function?: { arguments?: string } }> }; finish_reason?: string | null }>;
          usage?: unknown;
        };
        const choice = payload.choices?.[0];
        text = typeof choice?.message?.content === "string" ? choice.message.content : "";
        toolArguments = choice?.message?.tool_calls?.find((call) => typeof call.function?.arguments === "string")?.function?.arguments ?? "";
        finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
        reasoningCharacters = reasoningLength(choice?.message);
        usage = normalizeUsage(payload.usage);
      }
    } catch (error) {
      if (request.signal?.aborted || error instanceof AiProviderError) throw error;
      throw new AiProviderError(`${label}: ${timer.timedOut() ? "request timed out" : "the reply could not be read"}.`, undefined, true, details());
    }
    const outcome = classifyFinishReason(finishReason, ended);
    const shown = finishReason.replace(/\s+/g, " ").trim().slice(0, 60);
    if (outcome === "incomplete") throw new AiProviderError(`${label}: the stream ended before the reply was complete.`, undefined, true, details());
    if (outcome === "unexpected") throw new AiProviderError(`${label}: unexpected finish reason "${shown}" and the stream did not end with [DONE]: the reply may be incomplete.`, undefined, true, details());
    if (outcome === "failed") throw new AiProviderError(`${label}: the provider ended the reply with the finish reason "${shown}".`, undefined, true, details());
    if (outcome === "filtered") throw new AiProviderError(`${label}: the provider filtered the reply content (${shown}).`, undefined, false, details());
    // Some local servers leave the reasoning in the content as a leading <think> block: it is not the reply.
    const inline = splitReasoningBlock(text);
    text = inline.reply;
    reasoningCharacters += inline.reasoningCharacters;
    const answered = Boolean(text.trim() || toolArguments.trim());
    if (outcome === "truncated") {
      throw new AiProviderError(
        `${label}: ${!answered && reasoningCharacters > 0 ? "the model used its output limit while reasoning, before writing the reply" : "the reply was cut by the output token limit"}. Nothing was applied.`,
        undefined,
        false,
        details({ truncated: true }),
      );
    }
    if (!answered) throw new AiProviderError(`${label}: ${reasoningCharacters > 0 ? "the model finished after reasoning without a reply" : "the provider returned an empty reply"}.`, undefined, true, details());

    let json: unknown;
    if (request.json) {
      try {
        json = structuredFromReply({ toolArguments, content: text, schema: request.json });
      } catch (error) {
        throw new AiReplyRejectedError(`${label}: ${error instanceof Error ? error.message : "invalid structured reply"}`, details());
      }
      if (!text) text = toolArguments;
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
    };
  } finally {
    timer.dispose();
  }
}
