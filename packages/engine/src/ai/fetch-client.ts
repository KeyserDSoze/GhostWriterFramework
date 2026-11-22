import { isAbortError, linkedSignal } from "../util/abort.js";
import { randomId } from "../util/hash.js";
import { likelyTextTokens } from "./budget.js";
import type { AiPricingConfig, AiRuntimeConfig } from "./config.js";
import { redactSecrets } from "./redact.js";
import { effectiveAiBase, type ChatRequest } from "./request.js";
import type { AiCandidate } from "./router.js";
import { candidateBoundary, planAttempts, type PlannedAttempt } from "./routing.js";
import { splitReasoningBlock, structuredFromReply } from "./structured.js";
import { AiFallbackBlockedError, AiProviderError, AiReplyRejectedError, type AiPort, type AiProviderErrorDetails, type AiRequest, type AiResponse, type AiUsage } from "./types.js";

/** How long one candidate may take before it is given up, for every host (an integration's own timeout wins). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const MAX_RETRY_AFTER_MS = 300_000;

export interface FetchAiMessage {
  role: "system" | "user";
  content: string;
}

export interface FetchAiAttempt {
  label: string;
  capability: string;
  provider: string;
  model: string;
  integrationId: string;
  /** Position of the candidate in the route's order: 0 is the primary. */
  index: number;
  /** Identifies this attempt: the `onAttemptEnd` call that closes it carries the same id. */
  attemptId: string;
  /** The messages actually sent: a model without tools gets the JSON instruction in the system prompt. */
  messages: FetchAiMessage[];
  /** The output token limit sent, when there is one. */
  maxOutputTokens?: number;
  stream: boolean;
  /** The structured reply is requested as a forced function call. */
  tools: boolean;
  /** The origin and path every request of this integration starts with (never a key). */
  endpoint: string | null;
  /** How long this attempt may take. */
  timeoutMs: number;
}

export interface FetchAiAttemptEnd {
  attemptId: string;
  label: string;
  capability: string;
  provider: string;
  model: string;
  integrationId: string;
  index: number;
  /** `cancelled`: the caller aborted the request. */
  outcome: "ok" | "failed" | "cancelled";
  /** What the attempt used, also when it failed after the model had started to answer. */
  usage?: AiUsage;
  /** `false` when `usage` is an estimate or missing because the provider reported no tokens. */
  usageKnown: boolean;
  cost?: number;
  /** `false` when the model has no price or the usage was estimated. */
  costKnown: boolean;
  currency?: string;
  /** The reply, when the attempt succeeded. */
  text?: string;
  /** Why the attempt failed: the provider's message, already cleaned of credentials. */
  error?: string;
  failureKind?: "timeout" | "cancelled" | "provider";
  status?: number;
  retryAfterMs?: number;
  /** The limit that ran out, for a timeout. */
  timeoutMs?: number;
  durationMs: number;
}

/** One side of a fallback that crosses a privacy boundary. */
export interface FetchAiFallbackTarget {
  integrationId: string;
  integrationName: string;
  provider: string;
  model: string;
  /** What the policy compares: `integration:<id>`. */
  boundary: string;
}

export interface FetchAiFallbackInfo {
  capability: string;
  label: string;
}

export interface FetchAiOptions {
  fetch?: typeof fetch;
  /** Origin of GitHub Models (or of a proxy forwarding `/inference`). */
  githubModelsBaseUrl?: string;
  /** Used when an integration has no request timeout (default `DEFAULT_REQUEST_TIMEOUT_MS`). */
  defaultTimeoutMs?: number;
  /** An attempt is about to be sent. Never breaks the call. */
  onAttempt?: (attempt: FetchAiAttempt) => void;
  /** An attempt ended, whether it worked or not: for costs and debug panels. Never breaks the call. */
  onAttemptEnd?: (end: FetchAiAttemptEnd) => void;
  /**
   * With `fallbackDisclosure.requireAcknowledgement`, asked before content goes to a fallback in another account than
   * the one it went to so far. Return `true` to allow it; anything else, or a host without this hook, keeps the content
   * where it is. Throw to cancel the whole call.
   */
  acknowledgeFallback?: (from: FetchAiFallbackTarget, to: FetchAiFallbackTarget, info: FetchAiFallbackInfo) => boolean | Promise<boolean>;
}

function notify<T>(hook: ((value: T) => void) | undefined, value: T): void {
  try {
    hook?.(value);
  } catch {
    // A host's listener must never break a call.
  }
}

function fallbackTarget(candidate: AiCandidate): FetchAiFallbackTarget {
  return { integrationId: candidate.integration.id, integrationName: candidate.integration.name, provider: candidate.integration.provider, model: candidate.model, boundary: candidateBoundary(candidate) };
}

/**
 * OpenAI-compatible chat client built on `fetch`, usable from Node and browsers.
 * Supports OpenAI and compatible endpoints, Azure OpenAI and GitHub Models, streaming text,
 * forced function calls for structured output, and ordered fallbacks between candidates.
 * It is the one client of every host, so the same book and configuration produce the same requests and the same
 * outcomes: requests come from `buildChatRequest`, the routing limits and the privacy policy of the configuration are
 * applied here, and a prompt is never cut to fit a window.
 * What failed attempts cost is added to the final response (or error), so budgets never under-count.
 */
export function createFetchAi(config: AiRuntimeConfig, options: FetchAiOptions = {}): AiPort {
  return {
    async complete(request: AiRequest): Promise<AiResponse> {
      let startedAt = Date.now();
      const secrets = config.aiIntegrations.map((integration) => integration.apiKey);
      const plan = planAttempts(config, request, options.githubModelsBaseUrl);
      const decisions = new Map<string, boolean>();
      const blocked: Array<{ candidate: AiCandidate; from: AiCandidate; asked: boolean }> = [];
      const spent: Spent = {};
      let lastError: unknown = null;
      /** The candidate content went to last: the primary until something is sent. */
      let lastSent = plan.primary;
      let tried = 0;
      let outOfTime = false;
      for (const attempt of plan.attempts) {
        request.signal?.throwIfAborted();
        const { candidate } = attempt;
        const integration = candidate.integration;
        const maxTotal = plan.limits.maxTotalDurationMs;
        // The first candidate runs for its own timeout whatever the total; the others start only while time remains.
        if (tried > 0 && maxTotal !== undefined && maxTotal - (Date.now() - startedAt) <= 0) {
          outOfTime = true;
          break;
        }
        if (config.fallbackDisclosure?.requireAcknowledgement && candidateBoundary(candidate) !== candidateBoundary(lastSent)) {
          const pair = `${candidateBoundary(lastSent)}>${candidateBoundary(candidate)}`;
          let accepted = decisions.get(pair);
          if (accepted === undefined) {
            const asking = Date.now();
            accepted = options.acknowledgeFallback ? (await options.acknowledgeFallback(fallbackTarget(lastSent), fallbackTarget(candidate), { capability: request.capability, label: request.label })) === true : false;
            // The time a person takes to decide is not the call's time.
            startedAt += Date.now() - asking;
            decisions.set(pair, accepted);
          }
          if (!accepted) {
            blocked.push({ candidate, from: lastSent, asked: Boolean(options.acknowledgeFallback) });
            continue;
          }
        }
        let timeoutMs = integration.requestTimeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        if (tried > 0 && maxTotal !== undefined) timeoutMs = Math.max(1, Math.min(timeoutMs, Math.ceil(maxTotal - (Date.now() - startedAt))));

        const identity = { attemptId: randomId("attempt"), label: request.label, capability: request.capability, provider: integration.provider, model: candidate.model, integrationId: integration.id, index: attempt.index };
        const sent = (attempt.built?.body.messages as FetchAiMessage[] | undefined) ?? [{ role: "system", content: request.system }, { role: "user", content: request.user }];
        notify(options.onAttempt, {
          ...identity,
          // Copies: a listener can never change what is sent.
          messages: sent.map((message) => ({ role: message.role, content: message.content })),
          ...(attempt.built?.outputLimit ? { maxOutputTokens: attempt.built.outputLimit } : {}),
          stream: attempt.built?.stream ?? false,
          tools: attempt.built?.useTools ?? false,
          endpoint: effectiveAiBase(integration, options.githubModelsBaseUrl),
          timeoutMs,
        });
        const attemptStarted = Date.now();
        lastSent = candidate;
        tried += 1;
        try {
          if (!attempt.built) throw attempt.buildError;
          const response = await callCandidate(config, attempt, attempt.built, request, options, timeoutMs, secrets);
          notify(options.onAttemptEnd, {
            ...identity,
            outcome: "ok",
            usage: response.usage,
            usageKnown: response.usageKnown ?? false,
            cost: response.cost,
            costKnown: response.costKnown ?? false,
            currency: response.currency,
            text: response.text,
            durationMs: Date.now() - attemptStarted,
          });
          return withSpent(response, spent);
        } catch (error) {
          const cancelled = Boolean(request.signal?.aborted) && isAbortError(error);
          notify(options.onAttemptEnd, failedAttempt(identity, error, cancelled, timeoutMs, Date.now() - attemptStarted, secrets));
          if (cancelled) throw error;
          addSpent(spent, error);
          lastError = error;
          request.onText?.("");
        }
      }
      const notes: string[] = [];
      if (plan.excludedByBoundary > 0) notes.push(`Fallbacks in other accounts were not tried because "Never send fallback content outside the primary account" (fallbackDisclosure.sameBoundaryOnly) is on.`);
      if (blocked.length) {
        const names = [...new Set(blocked.map((entry) => `"${entry.candidate.integration.name}"`))].join(", ");
        const from = `"${blocked[0].from.integration.name}"`;
        notes.push(blocked[0].asked
          ? `The fallback ${names} was not used: sending content from ${from} to another account was not acknowledged (fallbackDisclosure.requireAcknowledgement).`
          : `The fallback ${names} was not used: it is in another account than ${from}, "Ask before sending content to another account" (fallbackDisclosure.requireAcknowledgement) is on and this host cannot ask. To change it, open the AI settings and turn it off, or add a fallback in the same account as the primary.`);
      }
      if (outOfTime) notes.push(`Fallbacks were not tried: the total routing time (maxTotalDurationMs, ${Math.round((plan.limits.maxTotalDurationMs ?? 0) / 1000)} s) was used up.`);
      if (lastError instanceof AiProviderError) {
        lastError.usage = spent.usage ?? lastError.usage;
        lastError.cost = spent.cost ?? lastError.cost;
        if (spent.usageKnown === false) lastError.usageKnown = false;
        if (spent.costKnown === false) lastError.costKnown = false;
        if (spent.retryAfterMs !== undefined) lastError.retryAfterMs = Math.max(lastError.retryAfterMs ?? 0, spent.retryAfterMs);
        if (notes.length) lastError.message = `${lastError.message}${/[.!?]$/.test(lastError.message) ? "" : "."} ${notes.join(" ")}`;
        throw lastError;
      }
      if (lastError instanceof Error) throw lastError;
      throw notes.length ? new AiFallbackBlockedError(notes.join(" ")) : new AiProviderError("All AI candidates failed.");
    },
  };
}

interface Spent {
  usage?: AiUsage;
  cost?: number;
  usageKnown?: boolean;
  costKnown?: boolean;
  retryAfterMs?: number;
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
  if (error.usageKnown === false) spent.usageKnown = false;
  if (error.costKnown === false) spent.costKnown = false;
  if (error.retryAfterMs !== undefined) spent.retryAfterMs = Math.max(spent.retryAfterMs ?? 0, error.retryAfterMs);
}

function withSpent(response: AiResponse, spent: Spent): AiResponse {
  if (!spent.usage && spent.cost === undefined && spent.usageKnown === undefined && spent.costKnown === undefined) return response;
  return {
    ...response,
    usage: sumUsage(response.usage, spent.usage),
    cost: spent.cost === undefined ? response.cost : (response.cost ?? 0) + spent.cost,
    ...(spent.usageKnown === false ? { usageKnown: false } : {}),
    ...(spent.costKnown === false ? { costKnown: false } : {}),
  };
}

function failedAttempt(identity: Pick<FetchAiAttemptEnd, "attemptId" | "label" | "capability" | "provider" | "model" | "integrationId" | "index">, error: unknown, cancelled: boolean, timeoutMs: number, durationMs: number, secrets: readonly string[]): FetchAiAttemptEnd {
  const provider = error instanceof AiProviderError ? error : undefined;
  const timedOut = provider?.timedOut === true;
  return {
    ...identity,
    outcome: cancelled ? "cancelled" : "failed",
    usage: provider?.usage,
    usageKnown: provider?.usageKnown ?? false,
    cost: provider?.cost,
    costKnown: provider?.costKnown ?? false,
    currency: provider?.currency,
    error: redactSecrets(error instanceof Error ? error.message : String(error), secrets),
    failureKind: cancelled ? "cancelled" : timedOut ? "timeout" : "provider",
    ...(provider?.status !== undefined ? { status: provider.status } : {}),
    ...(provider?.retryAfterMs !== undefined ? { retryAfterMs: provider.retryAfterMs } : {}),
    ...(timedOut ? { timeoutMs } : {}),
    durationMs,
  };
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

/**
 * Same formula as the web app's cost tracker: prices are per million tokens. Tokens served from the cache cost like
 * normal input unless the model has its own cached price.
 */
export function estimateCost(usage: AiUsage | undefined, pricing: AiPricingConfig | undefined): number | undefined {
  if (!usage || !pricing) return undefined;
  const billedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cachedRate = pricing.cachedPerMTok ?? pricing.inputPerMTok ?? 0;
  return (billedInput / 1_000_000) * (pricing.inputPerMTok ?? 0)
    + (usage.cachedInputTokens / 1_000_000) * cachedRate
    + (usage.outputTokens / 1_000_000) * (pricing.outputPerMTok ?? 0);
}

/** `Retry-After` as milliseconds: whole or fractional seconds, or an HTTP date; never more than five minutes. */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  const text = (value ?? "").trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.min(MAX_RETRY_AFTER_MS, Math.round(Number(text) * 1000));
  if (!/[A-Za-z]{3}/.test(text) || !/\d/.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
}

const TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504]);

async function providerError(response: Response, provider: string, model: string, redact: (text: string) => string): Promise<AiProviderError> {
  let detail = "";
  try {
    const text = await response.text();
    const raw = redact(text.length > 50_000 ? text.slice(0, 50_000) : text).slice(0, 2000);
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
  const status = response.status;
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  const retryAfterMs = status === 429 || status === 503 ? parseRetryAfter(response.headers?.get?.("retry-after")) : undefined;
  return new AiProviderError(
    redact(`${provider} ${model}: HTTP ${status}${detail ? ` — ${detail.replace(/\s+/g, " ").slice(0, 400)}` : ""}`),
    status,
    retryable,
    { ...(TRANSIENT_STATUSES.has(status) ? { transient: true } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  );
}

/**
 * Reads server-sent events; resolves `true` when the provider closed the stream with `[DONE]`. An event is its `data:`
 * lines joined with a newline, ended by a blank line; a value that is complete as it stands (one JSON object, or
 * `[DONE]`) is delivered at once, so servers that leave out the blank lines still stream.
 */
async function readEventStream(response: Response, onData: (data: string) => void): Promise<boolean> {
  if (!response.body) throw new AiProviderError("The provider returned an empty stream.", undefined, true, { transient: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: string[] = [];
  const complete = (value: string): boolean => {
    const text = value.trim();
    if (text === "[DONE]") return true;
    if (!text.startsWith("{") && !text.startsWith("[")) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  };
  const flush = (): boolean => {
    const lines = pending;
    pending = [];
    if (!lines.length) return false;
    const joined = lines.join("\n").trim();
    if (joined === "[DONE]") return true;
    if (lines.length > 1 && !complete(joined)) {
      // Lines that do not make one value are separate events that came without a blank line between them.
      for (const line of lines) {
        const single = line.trim();
        if (single === "[DONE]") return true;
        if (single) onData(single);
      }
      return false;
    }
    if (joined) onData(joined);
    return false;
  };
  const takeLine = (line: string): boolean => {
    const clean = line.replace(/\r$/, "");
    if (!clean) return flush();
    if (!clean.startsWith("data:")) return false;
    pending.push(clean.slice(5).trimStart());
    return complete(pending.join("\n")) ? flush() : false;
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
        if (takeLine(line)) {
          await reader.cancel().catch(() => undefined);
          return true;
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && takeLine(buffer)) return true;
    return flush();
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
const TRANSIENT_STREAM_ERROR = /overload|rate[_ -]?limit|too many requests|temporar|unavailable|busy|try again|time[ds]? ?out|capacity/i;

/**
 * A failure the provider reported inside the stream (`{"error": {...}}` or `{"error": "..."}`), or `null` when the
 * chunk carries none. It is retried unless its status or code says authentication or an invalid request.
 */
function streamError(value: unknown, label: string, details: AiProviderErrorDetails, redact: (text: string) => string): AiProviderError | null {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const message = typeof value === "string" ? value.trim() : typeof source?.message === "string" ? source.message.trim() : "";
  if (!source && !message) return null;
  const status = [source?.status, source?.status_code, source?.code]
    .map((entry) => (typeof entry === "number" ? entry : typeof entry === "string" && /^\d{3}$/.test(entry.trim()) ? Number(entry) : Number.NaN))
    .find((entry) => Number.isInteger(entry) && entry >= 100 && entry < 600);
  const words = [source?.type, source?.code, source?.status].filter((entry): entry is string => typeof entry === "string").join(" ");
  const permanent = (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) || PERMANENT_STREAM_ERROR.test(words);
  const transient = !permanent && ((status !== undefined && TRANSIENT_STATUSES.has(status)) || TRANSIENT_STREAM_ERROR.test(`${message} ${words}`));
  const detail = redact(message || (source && Object.keys(source).length ? JSON.stringify(source) : "no details")).replace(/\s+/g, " ").slice(0, 400);
  return new AiProviderError(redact(`${label}: the provider reported an error during the reply — ${detail}`), status, !permanent, { ...details, ...(transient ? { transient: true } : {}) });
}

/** Characters of reasoning a reply carried. Only the count is kept, never the reasoning itself. */
function reasoningLength(source: unknown): number {
  if (!source || typeof source !== "object") return 0;
  const { reasoning_content: content, reasoning } = source as { reasoning_content?: unknown; reasoning?: unknown };
  return (typeof content === "string" ? content.length : 0) + (typeof reasoning === "string" ? reasoning.length : 0);
}

async function callCandidate(config: AiRuntimeConfig, attempt: PlannedAttempt, built: ChatRequest, request: AiRequest, options: FetchAiOptions, timeoutMs: number, secrets: readonly string[]): Promise<AiResponse> {
  const { candidate } = attempt;
  const { integration, model } = candidate;
  const label = `${integration.provider} ${model}`;
  const redact = (text: string) => redactSecrets(text, secrets);
  const fetchImpl = options.fetch ?? fetch;
  const timer = linkedSignal(request.signal, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(built.url, {
        method: "POST",
        headers: built.headers,
        body: JSON.stringify(built.body),
        signal: timer.signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      const timedOut = timer.timedOut();
      throw new AiProviderError(redact(`${label}: ${timedOut ? "request timed out" : error instanceof Error ? error.message : String(error)}`), undefined, true, { transient: true, ...(timedOut ? { timedOut: true } : {}) });
    }
    if (!response.ok) throw await providerError(response, integration.provider, model, redact);

    let text = "";
    let toolArguments = "";
    let usage: AiUsage | undefined;
    let finishReason = "";
    let reasoningCharacters = 0;
    /** The response ended properly: a stream that closed with `[DONE]`, or a complete JSON body. */
    let ended = true;
    /** What the attempt used: the provider's count, else an estimate once the model has started to answer. */
    const measure = (): { usage?: AiUsage; usageKnown?: boolean } => {
      if (usage && usage.inputTokens + usage.outputTokens > 0) return { usage, usageKnown: true };
      if (!text && !toolArguments && !reasoningCharacters) return {};
      return {
        usage: { inputTokens: attempt.inputTokens, outputTokens: likelyTextTokens(text) + likelyTextTokens(toolArguments) + Math.ceil(reasoningCharacters / 4), cachedInputTokens: 0 },
        usageKnown: false,
      };
    };
    const details = (extra: AiProviderErrorDetails = {}): AiProviderErrorDetails => {
      const measured = measure();
      return {
        usage: measured.usage,
        cost: estimateCost(measured.usage, candidate.pricing),
        ...(measured.usageKnown === undefined ? {} : { usageKnown: measured.usageKnown, costKnown: measured.usageKnown && Boolean(candidate.pricing) }),
        currency: config.costCurrency,
        model,
        provider: integration.provider,
        integrationId: integration.id,
        ...extra,
      };
    };
    // A JSON body to a streaming request means the server ignored `stream`: its reply is read as a whole.
    const streamed = built.stream && !/\bjson\b/i.test(response.headers?.get?.("content-type") ?? "");
    try {
      if (streamed) {
        ended = await readEventStream(response, (data) => {
          let chunk: { choices?: Array<{ delta?: { content?: string | null; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: string | null }>; usage?: unknown; error?: unknown };
          try {
            chunk = JSON.parse(data);
          } catch {
            return;
          }
          if (!chunk || typeof chunk !== "object") return;
          if (chunk.error) {
            const failure = streamError(chunk.error, label, details(), redact);
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
          error?: unknown;
        } | null;
        if (payload?.error) {
          const failure = streamError(payload.error, label, details(), redact);
          if (failure) throw failure;
        }
        const choice = payload?.choices?.[0];
        text = typeof choice?.message?.content === "string" ? choice.message.content : "";
        toolArguments = choice?.message?.tool_calls?.find((call) => typeof call.function?.arguments === "string")?.function?.arguments ?? "";
        finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
        reasoningCharacters = reasoningLength(choice?.message);
        usage = normalizeUsage(payload?.usage);
        if (built.stream && text) request.onText?.(text);
      }
    } catch (error) {
      if (request.signal?.aborted || error instanceof AiProviderError) throw error;
      const timedOut = timer.timedOut();
      throw new AiProviderError(redact(`${label}: ${timedOut ? "request timed out" : "the reply could not be read"}.`), undefined, true, details({ transient: true, ...(timedOut ? { timedOut: true } : {}) }));
    }
    const outcome = classifyFinishReason(finishReason, ended);
    const shown = redact(finishReason).replace(/\s+/g, " ").trim().slice(0, 60);
    if (outcome === "incomplete") throw new AiProviderError(`${label}: the stream ended before the reply was complete.`, undefined, true, details({ transient: true }));
    if (outcome === "unexpected") throw new AiProviderError(`${label}: unexpected finish reason "${shown}" and the stream did not end with [DONE]: the reply may be incomplete.`, undefined, true, details());
    if (outcome === "failed") throw new AiProviderError(`${label}: the provider ended the reply with the finish reason "${shown}".`, undefined, true, details());
    if (outcome === "filtered") throw new AiProviderError(`${label}: the provider filtered the reply content (${shown}).`, undefined, false, details());
    // Some local servers leave the reasoning in the content as a leading <think> block: it is not the reply.
    const inline = splitReasoningBlock(text);
    text = inline.reply;
    reasoningCharacters += inline.reasoningCharacters;
    const answered = Boolean(text.trim() || toolArguments.trim());
    if (outcome === "truncated") {
      const reasoned = !answered && reasoningCharacters > 0;
      throw new AiProviderError(
        `${label}: ${reasoned ? "the model used its output limit while reasoning, before writing the reply" : "the reply was cut by the output token limit"}. Nothing was applied.`,
        undefined,
        false,
        details({ truncated: true, ...(reasoned ? { reasoningOnly: true, ...(candidate.maxOutputTokens && (built.outputLimit ?? 0) >= candidate.maxOutputTokens ? { limitReached: true } : {}) } : {}) }),
      );
    }
    if (!answered) throw new AiProviderError(`${label}: ${reasoningCharacters > 0 ? "the model finished after reasoning without a reply" : "the provider returned an empty reply"}.`, undefined, true, details());

    let json: unknown;
    if (request.json) {
      try {
        json = structuredFromReply({ toolArguments, content: text, schema: request.json });
      } catch (error) {
        throw new AiReplyRejectedError(redact(`${label}: ${error instanceof Error ? error.message : "invalid structured reply"}`), details());
      }
      if (!text) text = toolArguments;
    }
    const measured = measure();
    return {
      text,
      json,
      usage: measured.usage,
      usageKnown: measured.usageKnown ?? false,
      model,
      provider: integration.provider,
      integrationId: integration.id,
      cost: estimateCost(measured.usage, candidate.pricing),
      costKnown: measured.usageKnown === true && Boolean(candidate.pricing),
      currency: config.costCurrency,
    };
  } finally {
    timer.dispose();
  }
}
