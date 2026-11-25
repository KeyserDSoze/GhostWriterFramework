import { abortError, isAbortError } from "../util/abort.js";
import { randomId } from "../util/hash.js";
import { discardBody, release } from "./body.js";
import { likelyTextTokens } from "./budget.js";
import type { AiPricingConfig, AiRuntimeConfig, AiStreamMode } from "./config.js";
import { resolveDeadlines, startClock, timeoutMessage, type DeadlineClock, type ExpiredDeadline, type ResolvedDeadlines } from "./deadlines.js";
import { redactSecrets } from "./redact.js";
import type { AiModelLearning, AiModelMemory } from "./memory.js";
import { describeErrorBody, errorBodyOfObject, parseErrorBody, refusesThinkingWithTools, suggestsResponsesApi, type AiErrorBody } from "./provider-error.js";
import { ResponsesStreamReader, responseAsChat } from "./responses.js";
import { attemptThinking, buildChatRequest, canSendNone, effectiveAiBase, endpointOrigin, type AiAttemptThinking, type AiReasoningEffort, type AiThinkingWhy, type ChatRequest } from "./request.js";
import type { AiCandidate } from "./router.js";
import { candidateBoundary, leftOutStep, planAttempts, sortedRoute, type PlannedAttempt } from "./routing.js";
import { isEmptyToolArguments, splitReasoningBlock, structuredFromReply } from "./structured.js";
import { AiFallbackBlockedError, AiProviderError, AiReplyRejectedError, AiStreamInterruptedError, MAX_PARTIAL_CHARACTERS, TRANSPORT_TAIL_CHARACTERS, type AiMessage, type AiPort, type AiProviderErrorDetails, type AiRequest, type AiResponse, type AiRouteStep, type AiStreamEnd, type AiTimeoutPhase, type AiTransportDiagnostics, type AiUsage } from "./types.js";

// The deadlines of a call: how long a provider has to begin answering, the least it is given, and the most a call may take.
export { DEFAULT_REQUEST_TIMEOUT_MS, MIN_REQUEST_TIMEOUT_MS, TOTAL_REQUEST_CAP_MS } from "./deadlines.js";

/**
 * Raw bytes of a stream include the JSON envelope of every piece (a few hundred bytes for a few characters), so a long reasoning phase is
 * far larger than its text. A stream over this many bytes is a model that loops, and is stopped.
 */
export const MAX_STREAM_TRANSPORT_BYTES = 256_000_000;
/** The characters of reasoning a stream may carry before it is taken for a loop and stopped. */
export const MAX_STREAM_REASONING_CHARACTERS = 16_000_000;
/** A host's progress listener is called at most this often. */
const PROGRESS_INTERVAL_MS = 250;
const MAX_RETRY_AFTER_MS = 300_000;

/** A message of an attempt, as it is reported: its role and its content, which is text or parts (text and images, with their data URLs). */
export type FetchAiMessage = AiMessage;

/**
 * The messages of an attempt for its hook: what the request sends, read back into the engine's form, so that they are always copies (a listener can never change
 * a word of what is sent). An attempt that could not be built reports what the request would have sent.
 */
function reportedMessages(built: ChatRequest | null, request: Pick<AiRequest, "system" | "user" | "messages">): FetchAiMessage[] {
  const wire = built?.messages;
  if (wire) {
    return wire.map((message) => ({
      role: message.role,
      content: typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? { type: "text" as const, text: part.text } : { type: "image" as const, dataUrl: part.image_url.url })),
    }));
  }
  const planned: FetchAiMessage[] = request.messages?.length ? request.messages : [{ role: "system", content: request.system }, { role: "user", content: request.user }];
  return planned.map((message) => ({ role: message.role, content: typeof message.content === "string" ? message.content : message.content.map((part) => ({ ...part })) }));
}

/** The three deadlines of an attempt, in milliseconds, as they are applied (the routing time that is left included). */
export interface FetchAiTimeouts {
  /** How long the provider has to begin answering: the connection and the headers. For a request that does not stream it is the whole call. */
  startMs: number;
  /** The longest silence between two pieces of a stream (it applies to streamed replies only). */
  idleMs: number;
  /** The most the attempt may take, whatever the provider keeps sending. */
  capMs: number;
  /** The provider timeout the integration asked for, when the minimum raised it to `startMs`. */
  raised?: { from: number };
}

export interface FetchAiAttempt {
  label: string;
  capability: string;
  provider: string;
  model: string;
  integrationId: string;
  /** The integration's name as the author wrote it (cleaned of credentials): what a panel calls the one that is asked. */
  integrationName: string;
  /** Position of the candidate in the route's order: 0 is the primary. */
  index: number;
  /** How many candidates the route has as written, the ones this call leaves out included (`index` is the place of this one in it). */
  candidates: number;
  /** Which request of this call this is, from 1: every request counts, the ones that failed before it too. */
  attempt: number;
  /** The most requests this call can make: the candidates of the route that its plan did not leave out. */
  attempts: number;
  /** Identifies this attempt: the `onAttemptEnd` call that closes it carries the same id. */
  attemptId: string;
  /** The messages actually sent, as copies: a model without tools gets the JSON instruction in the system prompt, and a conversation (`AiRequest.messages`) is reported whole, with its roles and parts. */
  messages: FetchAiMessage[];
  /** The output token limit sent, when there is one. */
  maxOutputTokens?: number;
  /** The API version this request carries, for a provider that has one (Azure OpenAI's `api-version`, or `v1`): the model's own, else its integration's (`effectiveApiVersion`). */
  apiVersion?: string;
  stream: boolean;
  /** The structured reply is requested as a forced function call. */
  tools: boolean;
  /** The origin and path every request of this integration starts with (never a key). */
  endpoint: string | null;
  /** How long the provider has to begin answering (`timeouts.startMs`). */
  timeoutMs: number;
  /** The three deadlines of this attempt. */
  timeouts: FetchAiTimeouts;
  /** What the integration says about streaming (`auto` unless it says `off`). */
  streamMode: AiStreamMode;
  /** "Tools only" was in force for this call: `false` only when the configuration turned it off. */
  toolsOnly: boolean;
  /** The thinking level the request carries: as `reasoning_effort`, or as the chat-template argument when `reasoningParameter` says so. Absent when none is sent (`automatic` sends nothing). */
  thinking?: AiReasoningEffort | "none";
  /** What the request does of the thinking level in three words: the level that is sent, `automatic` (none chosen: the model decides) or `not-sent` (a level is chosen and the model does not take it). */
  thinkingMode: AiAttemptThinking;
  /** Why a level that was chosen is not sent, when this request is what decided it: `tools`, the request carries function tools and the model refuses a level with them (set, or learned). Absent otherwise. */
  thinkingWhy?: AiThinkingWhy;
  /** Where the level went, when it went in the chat-template argument (`chat_template_kwargs.reasoning_strength`, the model's "Thinking parameter"). Absent: it went as `reasoning_effort`, or no level was sent. */
  reasoningParameter?: "chat_template_kwargs.reasoning_strength";
  /**
   * The candidates of the route that this call does not ask, and why: with "Tools only" on, a structured request skips every model
   * marked as without tool calls. Absent when none was skipped; the same list on every attempt of the call.
   */
  skipped?: Array<{ model: string; reason: "no-tool-calls" }>;
  /**
   * Every candidate of the route that this call does not ask, each with its place in the route and why (see `AiRouteStep`): the targets that cannot be called, the fallbacks the
   * privacy policy keeps back, the models whose context window cannot hold the prompt, the ones the routing limits cut, and the models "Tools only" skips. What is known when this attempt is sent
   * (a fallback that the author did not acknowledge is added to the attempts after it). Absent when nothing was left out.
   */
  leftOut?: AiRouteStep[];
  /**
   * What this attempt does not do that the configuration asked, because of what the model declares or says: a thinking level that is not sent to a
   * model that does not reason or whose thinking parameter is `none`, a stream that is not asked of a model that does not stream. In English, for a debug panel; absent when there is nothing to say.
   */
  notes?: string[];
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
  /** What the provider answered when it refused the request, in its own words: the status and the message, type, param and code of its error (see `AiErrorBody`). Absent for a failure that is not an answer. */
  errorBody?: AiErrorBody;
  failureKind?: "timeout" | "cancelled" | "provider";
  status?: number;
  retryAfterMs?: number;
  /** The limit that ran out, for a timeout. */
  timeoutMs?: number;
  /** Which deadline ran out, for a timeout. */
  timeoutPhase?: AiTimeoutPhase;
  /** The reply was read as a stream of events (and not as one JSON body). */
  streamed: boolean;
  /** Milliseconds from the start of the attempt to the first byte of the reply: of its body for a stream, of the response for a JSON body. Absent when nothing arrived. */
  firstByteMs?: number;
  /** For a structured request: whether the model delivered the result as a function call. Absent for any other request and when nothing arrived. */
  toolCalled?: boolean;
  /**
   * How the provider ended the reply that was read, in its own word (`stop`, `length`, `content_filter`...), empty when it said none: also for an attempt that the engine then
   * refused (a reply that was cut, or filtered). Absent when no reply was read (a refusal, a connection that failed, a deadline that ran out first).
   */
  finishReason?: string;
  /** Characters of the reply that was read: its text without the reasoning, and the arguments of its function (`{}` is none). Present with `finishReason`. */
  replyCharacters?: number;
  /** Characters of reasoning that came with it (the reasoning field of the provider, and a `<think>` block in the text). Only the count, never the words. Present with `finishReason`. */
  reasoningCharacters?: number;
  /**
   * What the transport saw of the call: the HTTP status, the bytes and chunks that arrived, when the last one did and what the end of them said, how the provider ended the reply, whether it reported
   * the tokens, and how the stream ended. It is what tells a stream that was cut from one that was slow. Absent when no response arrived (the connection failed first). Never a key.
   */
  transport?: AiTransportDiagnostics;
  /**
   * For an attempt that failed after the model had started to answer: the reply that had arrived (its text, or the arguments of its function call), at most `MAX_PARTIAL_CHARACTERS` characters, cleaned of
   * credentials. The engine does not apply it; this is where a host finds it. Absent when none had arrived.
   */
  partialText?: string;
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
  /**
   * The shortest start or idle deadline an attempt is given (default `MIN_REQUEST_TIMEOUT_MS`, 30 s). It exists for tests that count in
   * milliseconds: a host has no reason to lower it.
   */
  minimumTimeoutMs?: number;
  /** An attempt is about to be sent. Never breaks the call. */
  onAttempt?: (attempt: FetchAiAttempt) => void;
  /** An attempt ended, whether it worked or not: for costs and debug panels. Never breaks the call. */
  onAttemptEnd?: (end: FetchAiAttemptEnd) => void;
  /** What this client's host remembers of its models between calls (see `AiModelMemory`); a call may bring its own (`AiRequest.memory`), which wins. */
  memory?: AiModelMemory;
  /** A call of this client learned something about a model (see `AiModelLearning`): said once, when it is learned. Never breaks the call. */
  onLearned?: (learning: AiModelLearning) => void;
  /**
   * Whether the host is ending (a browser page that is being reloaded or closed). A request that fails while it is true failed because its host went away, not because its provider did: the
   * attempt is closed as cancelled and the call ends with that failure, and the next candidate is not asked (it would be sent the whole prompt, and billed, by a host that is no longer there).
   */
  interrupted?: () => boolean;
  /**
   * With `fallbackDisclosure.requireAcknowledgement`, asked before content goes to a fallback in another account than
   * the one it went to so far. Return `true` to allow it; anything else, or a host without this hook, keeps the content
   * where it is. Throw to cancel the whole call.
   */
  acknowledgeFallback?: (from: FetchAiFallbackTarget, to: FetchAiFallbackTarget, info: FetchAiFallbackInfo) => boolean | Promise<boolean>;
  /**
   * Where the client remembers the requests that a provider refused because of `stream_options` (`include_usage`), so that they are sent without it from then on: the key is the address of the
   * request. The option is asked of every provider (it is how a stream reports its tokens), and a provider that answers 400 or 422 naming it is asked again, at once, without it and not again after
   * (its replies then carry no token count, and say so: their usage is an estimate). The default is one set for each client, so a call asks every address once, whatever came before it: the
   * app's hosts leave it at that, so that the same configuration builds the same requests in every host, at the price of one refusal (which costs nothing: it is answered before any work) per call
   * to a provider that refuses. An embedder that wants to ask once for all its calls shares one set between its clients. The same set remembers which output-limit parameter
   * (`max_tokens` or `max_completion_tokens`) a model refused, by address and model.
   */
  usageOptionRefusals?: Set<string>;
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
  const refusals = options.usageOptionRefusals ?? new Set<string>();
  return {
    async complete(request: AiRequest): Promise<AiResponse> {
      let startedAt = Date.now();
      const secrets = config.aiIntegrations.map((integration) => integration.apiKey);
      // What the client's host remembers of its models applies to every call it makes, unless the call brings its own memory.
      if (options.memory && !request.memory) request = { ...request, memory: options.memory };
      const plan = planAttempts(config, request, options.githubModelsBaseUrl);
      const skipped = plan.skipped.map((entry) => ({ model: entry.candidate.model, reason: entry.reason }));
      const decisions = new Map<string, boolean>();
      const blocked: Array<{ candidate: AiCandidate; from: AiCandidate; asked: boolean }> = [];
      const spent: Spent = {};
      let lastError: unknown = null;
      /** The candidate content went to last: the primary until something is sent. */
      let lastSent = plan.primary;
      let tried = 0;
      let outOfTime = false;
      /** What became of every candidate of the route, as far as this call has gone: what the plan left out, and each attempt as it ends. */
      const steps: AiRouteStep[] = [...plan.leftOut];
      /** The candidates asked so far: a candidate that is asked again (without a thinking level) is still one. */
      let askedCandidates = 0;
      for (const [at, planned] of plan.attempts.entries()) {
        request.signal?.throwIfAborted();
        let attempt = planned;
        const integration = planned.candidate.integration;
        const maxTotal = plan.limits.maxTotalDurationMs;
        // The first candidate runs for its own timeout whatever the total; the others start only while time remains.
        if (askedCandidates > 0 && maxTotal !== undefined && maxTotal - (Date.now() - startedAt) <= 0) {
          outOfTime = true;
          for (const rest of plan.attempts.slice(at)) steps.push(leftOutStep(rest.candidate, rest.index, "out-of-time", secrets, options.githubModelsBaseUrl));
          break;
        }
        if (config.fallbackDisclosure?.requireAcknowledgement && candidateBoundary(planned.candidate) !== candidateBoundary(lastSent)) {
          const pair = `${candidateBoundary(lastSent)}>${candidateBoundary(planned.candidate)}`;
          let accepted = decisions.get(pair);
          if (accepted === undefined) {
            const asking = Date.now();
            accepted = options.acknowledgeFallback ? (await options.acknowledgeFallback(fallbackTarget(lastSent), fallbackTarget(planned.candidate), { capability: request.capability, label: request.label })) === true : false;
            // The time a person takes to decide is not the call's time.
            startedAt += Date.now() - asking;
            decisions.set(pair, accepted);
          }
          if (!accepted) {
            blocked.push({ candidate: planned.candidate, from: lastSent, asked: Boolean(options.acknowledgeFallback) });
            steps.push(leftOutStep(planned.candidate, planned.index, "not-acknowledged", secrets, options.githubModelsBaseUrl));
            continue;
          }
        }
        // The first candidate runs for its own deadlines whatever the total; a later one runs for the routing time that is left (and the same candidate asked again runs for what its first request had).
        const routingLeft = askedCandidates > 0 && maxTotal !== undefined ? () => maxTotal - (Date.now() - startedAt) : undefined;
        /** The ways this candidate was asked without thinking, in order, because the provider refuses a level when the request carries function tools (see `nextWithoutThinking`). */
        const withoutThinking: Array<"omit" | "none"> = [];
        /** What its requests carried of the thinking, so far: the level (`level`), none of it (`omit`) or `none`: a way is never asked twice. */
        const sent = new Set<string>();
        /** What the provider said the first time it refused: what a model that then answers is learned from. */
        let refusedWith: AiErrorBody | undefined;
        for (;;) {
          const { candidate } = attempt;
          const deadlines = resolveDeadlines(integration, options, routingLeft?.());

          const identity = { attemptId: randomId("attempt"), label: request.label, capability: request.capability, provider: integration.provider, model: candidate.model, integrationId: integration.id, index: attempt.index };
          const attemptReport: FetchAiAttempt = {
            ...identity,
            integrationName: redactSecrets(integration.name, secrets),
            candidates: plan.attempts.length + plan.leftOut.length,
            attempt: tried + 1,
            attempts: plan.attempts.length,
            // Copies: a listener can never change what is sent.
            messages: reportedMessages(attempt.built, request),
            ...(attempt.built?.outputLimit ? { maxOutputTokens: attempt.built.outputLimit } : {}),
            ...(attempt.built?.apiVersion ? { apiVersion: attempt.built.apiVersion } : {}),
            stream: attempt.built?.stream ?? false,
            tools: attempt.built?.useTools ?? false,
            endpoint: effectiveAiBase(integration, options.githubModelsBaseUrl),
            timeoutMs: deadlines.startMs,
            timeouts: { startMs: deadlines.startMs, idleMs: deadlines.idleMs, capMs: deadlines.capMs, ...(deadlines.raisedFrom !== undefined ? { raised: { from: deadlines.raisedFrom } } : {}) },
            streamMode: integration.streamMode === "off" ? "off" : "auto",
            toolsOnly: config.toolsOnly !== false,
            ...(attempt.built?.thinking ? { thinking: attempt.built.thinking } : {}),
            thinkingMode: attemptThinking(candidate, attempt.built?.useTools ?? false),
            ...(attempt.built?.thinkingWhy ? { thinkingWhy: attempt.built.thinkingWhy } : {}),
            ...(attempt.built?.reasoningParameter ? { reasoningParameter: attempt.built.reasoningParameter } : {}),
            ...(skipped.length ? { skipped: skipped.map((entry) => ({ ...entry })) } : {}),
            ...(steps.some((step) => step.outcome === "left-out") ? { leftOut: sortedRoute(steps.filter((step) => step.outcome === "left-out")).map((step) => ({ ...step })) } : {}),
            ...(attempt.built?.notes?.length ? { notes: [...attempt.built.notes] } : {}),
          };
          notify(options.onAttempt, attemptReport);
          notify(request.onAttempt, attemptReport);
          const attemptStarted = Date.now();
          const trace: AttemptTrace = { startedAt: attemptStarted, streamed: false, toolSeen: false };
          lastSent = candidate;
          tried += 1;
          if (withoutThinking.length === 0) askedCandidates += 1;
          sent.add(attempt.built?.thinking === "none" ? "none" : attempt.built?.thinking ? "level" : "omit");
          try {
            if (!attempt.built) throw attempt.buildError;
            const response = await callCandidate(config, attempt, attempt.built, request, options, deadlines, secrets, trace, refusals);
            const endReport: FetchAiAttemptEnd = {
              ...identity,
              outcome: "ok",
              usage: response.usage,
              usageKnown: response.usageKnown ?? false,
              cost: response.cost,
              costKnown: response.costKnown ?? false,
              currency: response.currency,
              text: response.text,
              ...replyTrace(trace, Boolean(request.json)),
              ...(trace.transport ? { transport: trace.transport } : {}),
              durationMs: Date.now() - attemptStarted,
            };
            notify(options.onAttemptEnd, endReport);
            notify(request.onAttemptEnd, endReport);
            // The model answered when it was asked without thinking: that is what is learned of it, once. A model that no way answered is learned nothing of.
            if (refusedWith && withoutThinking.length) {
              const learning: AiModelLearning = { kind: "no-thinking-with-tools", integrationId: integration.id, integrationName: redactSecrets(integration.name, secrets), model: candidate.model, off: withoutThinking[withoutThinking.length - 1], body: refusedWith };
              try {
                request.memory?.learn(learning);
              } catch {
                // A host's memory must never break a call.
              }
              notify(request.onLearned, learning);
              notify(options.onLearned, learning);
            }
            return withSpent(response, spent);
          } catch (error) {
            // A host that is ending (a page that is reloaded) cancelled the request as much as the author did: its failure is not the provider's, and the prompt goes to no other candidate.
            const interrupted = options.interrupted?.() === true;
            const cancelled = (Boolean(request.signal?.aborted) && isAbortError(error)) || interrupted;
            const failedReport = failedAttempt(identity, error, cancelled, deadlines.startMs, Date.now() - attemptStarted, secrets, replyTrace(trace, Boolean(request.json)));
            notify(options.onAttemptEnd, failedReport);
            notify(request.onAttemptEnd, failedReport);
            if (cancelled) throw error;
            const origin = endpointOrigin(effectiveAiBase(integration, options.githubModelsBaseUrl));
            if (error instanceof AiProviderError && !error.target) {
              error.target = { provider: integration.provider, model: candidate.model, integrationId: integration.id, ...(origin ? { endpoint: origin } : {}), ...(attempt.built?.apiVersion ? { apiVersion: attempt.built.apiVersion } : {}) };
            }
            steps.push(triedStep(attempt, failedReport, error, origin, secrets));
            addSpent(spent, error);
            lastError = error;
            notify(request.onText, "");
            notify(request.onStructuredText, "");
            // A provider that refuses a thinking level because the request carries function tools is asked again without it, and if that is refused too, with `none` (the GPT-6 models take no request with
            // tools that leaves the level out): each way once. The model is remembered by the way that answers, so that every later request with tools is asked that way (a request without tools keeps its
            // level). Every request stays in the trail as the failed attempt it was, with the provider's words.
            const next = nextWithoutThinking(candidate, attempt.built, error, sent);
            if (next) {
              const asked = { ...candidate, noThinkingWithTools: next === "none" ? ("none" as const) : (true as const) };
              try {
                attempt = { ...attempt, candidate: asked, built: buildChatRequest(asked, request, { githubModelsBaseUrl: options.githubModelsBaseUrl }) };
              } catch {
                break;
              }
              withoutThinking.push(next);
              if (!refusedWith) refusedWith = (error as AiProviderError).body;
              continue;
            }
            // Asked every way, and refused every time: the provider's last words are the error, with what was tried, and where the provider says function tools are taken.
            if (withoutThinking.length && error instanceof AiProviderError) error.message = redactSecrets(`${error.message}${/[.!?]$/.test(error.message) ? "" : "."} ${refusedEveryWay(withoutThinking, refusedWith)}`, secrets);
            break;
          }
        }
      }
      const notes: string[] = [];
      if (plan.excludedByBoundary > 0) notes.push(`Fallbacks in other accounts were not tried because "Never send fallback content outside the primary account" (fallbackDisclosure.sameBoundaryOnly) is on.`);
      for (const entry of plan.skipped) notes.push(redactSecrets(`Skipped "${entry.candidate.model}" in "${entry.candidate.integration.name}": it is marked as without tool calls and "Tools only" is on.`, secrets));
      for (const step of plan.leftOut) {
        if (step.leftOut === "context-window") notes.push(`Skipped "${step.model}" in "${step.integrationName}": the prompt (about ${step.promptTokens} tokens) does not fit its context window (${step.windowTokens} tokens are left for the prompt).`);
        else if (step.leftOut === "budget") notes.push(`Not tried: "${step.model}" in "${step.integrationName}": the routing limits of tokens or cost (maxTokenAttempts, maxEstimatedCost) were reached.`);
        else if (step.leftOut === "unusable") notes.push(`Not tried: "${step.model}" in "${step.integrationName}" cannot be called (${UNUSABLE_WORDS[step.why ?? "model-missing"]}).`);
      }
      if (blocked.length) {
        const names = [...new Set(blocked.map((entry) => `"${entry.candidate.integration.name}"`))].join(", ");
        const from = `"${blocked[0].from.integration.name}"`;
        notes.push(blocked[0].asked
          ? `The fallback ${names} was not used: sending content from ${from} to another account was not acknowledged (fallbackDisclosure.requireAcknowledgement).`
          : `The fallback ${names} was not used: it is in another account than ${from}, "Ask before sending content to another account" (fallbackDisclosure.requireAcknowledgement) is on and this host cannot ask. To change it, open the AI settings and turn it off, or add a fallback in the same account as the primary.`);
      }
      if (outOfTime) notes.push(`Fallbacks were not tried: the total routing time (maxTotalDurationMs, ${Math.round((plan.limits.maxTotalDurationMs ?? 0) / 1000)} s) was used up.`);
      const route = sortedRoute(steps);
      if (lastError instanceof AiProviderError) {
        lastError.usage = spent.usage ?? lastError.usage;
        lastError.cost = spent.cost ?? lastError.cost;
        if (spent.usageKnown === false) lastError.usageKnown = false;
        if (spent.costKnown === false) lastError.costKnown = false;
        if (spent.retryAfterMs !== undefined) lastError.retryAfterMs = Math.max(lastError.retryAfterMs ?? 0, spent.retryAfterMs);
        if (notes.length) lastError.message = `${lastError.message}${/[.!?]$/.test(lastError.message) ? "" : "."} ${notes.join(" ")}`;
        lastError.route = route;
        throw lastError;
      }
      if (lastError instanceof Error) throw Object.assign(lastError, { route });
      const none = notes.length ? new AiFallbackBlockedError(notes.join(" ")) : new AiProviderError("All AI candidates failed.");
      none.route = route;
      throw none;
    },
  };
}

/** What a target of the route that cannot be called says of itself, in the words of the notes of a failed call. */
const UNUSABLE_WORDS: Record<NonNullable<AiRouteStep["why"]>, string> = {
  "integration-missing": "its integration is no longer there",
  "provider-unsupported": "its provider cannot run chat tasks here",
  "model-missing": "the model is not in the integration",
  "task-not-allowed": "the model is not allowed for this task",
};

/** The most characters of what a provider said that a step of a route keeps. */
const MAX_STEP_MESSAGE_CHARACTERS = 240;

/** The step that says how an attempt ended, from the report of its end (whose words are already cleaned of credentials). */
/**
 * How a candidate is asked next, when its provider refused the request because it carries function tools together with a thinking level («Function tools with reasoning_effort are not supported…»), or
 * `undefined` when there is no way left: without a level first (a model of the GPT-5.6 family still reasons then), then with `none` (the GPT-6 models refuse a request with tools that leaves the level out,
 * and take `none`), each way once (`sent` says which were put on the wire, the first request included), and `none` only for a model that takes its level in `reasoning_effort`. A refusal of the value of the
 * level («does not support 'none' with this model») is not this: that model takes function tools on the Responses API only.
 */
function nextWithoutThinking(candidate: AiCandidate, built: ChatRequest | null, error: unknown, sent: ReadonlySet<string>): "omit" | "none" | undefined {
  // The Responses API takes function tools with a thinking level: a refusal there is no refusal of this kind, and asking again without the level would be the same request.
  if (!(error instanceof AiProviderError) || !built?.useTools || built.protocol === "responses" || !refusesThinkingWithTools(error.body)) return undefined;
  return (["omit", "none"] as const).find((way) => !sent.has(way) && (way !== "none" || canSendNone(candidate)));
}

/** What an error says after a model was asked every way without thinking and refused function tools each time: what was tried, and, when the provider says it, where the tools are taken. */
function refusedEveryWay(tried: readonly ("omit" | "none")[], first: AiErrorBody | undefined): string {
  const how = tried.includes("none") ? "without a thinking level and with \"none\"" : "without a thinking level";
  return `Narrarium asked again ${how}, and the model still refuses function tools on this endpoint${suggestsResponsesApi(first) ? ": the provider says to use /v1/responses for them" : ""}.`;
}

function triedStep(attempt: PlannedAttempt, end: FetchAiAttemptEnd, error: unknown, endpoint: string | undefined, secrets: readonly string[]): AiRouteStep {
  const integration = attempt.candidate.integration;
  const timeout = error instanceof AiProviderError ? error.timeout : undefined;
  const message = (end.error ?? "").replace(/\s+/g, " ").trim();
  return {
    position: attempt.index,
    integrationId: redactSecrets(integration.id, secrets),
    integrationName: redactSecrets(integration.name, secrets),
    provider: integration.provider,
    model: redactSecrets(attempt.candidate.model, secrets),
    outcome: end.outcome === "cancelled" ? "cancelled" : end.failureKind === "timeout" ? "timeout" : "failed",
    ...(endpoint ? { endpoint } : {}),
    ...(attempt.built?.apiVersion ? { apiVersion: attempt.built.apiVersion } : {}),
    ...(end.status !== undefined ? { status: end.status } : {}),
    ...(end.errorBody ? { body: end.errorBody } : {}),
    durationMs: end.durationMs,
    ...(message ? { message: message.length > MAX_STEP_MESSAGE_CHARACTERS ? `${message.slice(0, MAX_STEP_MESSAGE_CHARACTERS - 1)}…` : message } : {}),
    ...(end.failureKind === "timeout" && end.timeoutPhase ? { timeoutPhase: end.timeoutPhase } : {}),
    ...(end.failureKind === "timeout" && end.timeoutMs !== undefined ? { timeoutMs: end.timeoutMs } : {}),
    ...(timeout?.routing ? { routing: true } : {}),
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

/** What an attempt learned about its reply while it ran: the end hook says it, whether the attempt worked or not. */
interface AttemptTrace {
  startedAt: number;
  /** The reply was read as a stream of events. */
  streamed: boolean;
  /** Milliseconds to the first byte of the reply (see `FetchAiAttemptEnd.firstByteMs`). */
  firstByteMs?: number;
  /** The reply carried a function call. */
  toolSeen: boolean;
  /** Set once the reply has been read, before it is judged: how the provider ended it and how much of it there was (see `FetchAiAttemptEnd.finishReason`). */
  finishReason?: string;
  replyCharacters?: number;
  reasoningCharacters?: number;
  /** What the transport saw, for the attempt's end hook: set once the reply has been read, before it is judged. */
  transport?: AiTransportDiagnostics;
}

type ReplyTrace = Pick<FetchAiAttemptEnd, "streamed" | "firstByteMs" | "toolCalled" | "finishReason" | "replyCharacters" | "reasoningCharacters">;

function replyTrace(trace: AttemptTrace, structured: boolean): ReplyTrace {
  return {
    streamed: trace.streamed,
    ...(trace.firstByteMs !== undefined ? { firstByteMs: trace.firstByteMs } : {}),
    ...(structured && trace.firstByteMs !== undefined ? { toolCalled: trace.toolSeen } : {}),
    ...(trace.finishReason !== undefined ? { finishReason: trace.finishReason, replyCharacters: trace.replyCharacters ?? 0, reasoningCharacters: trace.reasoningCharacters ?? 0 } : {}),
  };
}

function failedAttempt(identity: Pick<FetchAiAttemptEnd, "attemptId" | "label" | "capability" | "provider" | "model" | "integrationId" | "index">, error: unknown, cancelled: boolean, timeoutMs: number, durationMs: number, secrets: readonly string[], reply: ReplyTrace): FetchAiAttemptEnd {
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
    ...(provider?.body ? { errorBody: provider.body } : {}),
    ...(timedOut ? { timeoutMs: provider?.timeout?.ms ?? timeoutMs } : {}),
    ...(timedOut && provider?.timeout ? { timeoutPhase: provider.timeout.phase } : {}),
    ...reply,
    ...(provider?.transport ? { transport: provider.transport } : {}),
    ...(provider?.partialText ? { partialText: provider.partialText } : {}),
    durationMs,
  };
}

/** A count of tokens: a number that is not negative. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The tokens a provider reports (`usage`): OpenAI's `prompt_tokens` and `completion_tokens`, or the `input_tokens` and `output_tokens` that other providers and the Responses API use; the tokens
 * served from the cache by whichever field says it (`prompt_tokens_details.cached_tokens`, `input_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`, `cache_read_input_tokens`).
 */
function normalizeUsage(value: unknown): AiUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const details = (usage.prompt_tokens_details ?? usage.input_tokens_details) as { cached_tokens?: unknown } | null | undefined;
  return {
    inputTokens: tokenCount(usage.prompt_tokens) ?? tokenCount(usage.input_tokens) ?? 0,
    outputTokens: tokenCount(usage.completion_tokens) ?? tokenCount(usage.output_tokens) ?? 0,
    cachedInputTokens: tokenCount(details?.cached_tokens) ?? tokenCount(usage.prompt_cache_hit_tokens) ?? tokenCount(usage.cache_read_input_tokens) ?? 0,
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

/** The statuses that depend on the moment: a timeout, a rate limit, a gateway that cannot reach the model or that gave up waiting for it, and the origin errors (520-524) that Cloudflare says for the same. */
const TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504, 520, 521, 522, 523, 524]);
/**
 * What a refusal of the thinking parameter says: the name of the one that the level travels in, in the provider's message or in the `param` of its error
 * object (some providers say only `"param": "reasoning_effort"`): the OpenAI field (`reasoning.effort` in the Responses API), or the chat-template argument (`chat_template_kwargs`, `reasoning_strength`).
 * Either name is a refusal of the level, whichever of the two was sent: a gateway may answer with the name of the one it translated it into, and the remedy is
 * the same setting.
 */
const THINKING_PARAMETER = /reasoning[\s._-]?effort|reasoning[\s_-]?strength|chat[\s_-]?template[\s_-]?kwargs/i;

/** Where a thinking level was sent, for the author who has to change it: the integration it was asked for, and the parameter it travelled in (`reasoning.effort` is the Responses API's). */
interface SentThinking {
  integration: string;
  parameter: "reasoning_effort" | "reasoning.effort" | "chat_template_kwargs.reasoning_strength";
}

/** What to change when a model refuses its level: the "Thinking parameter" of the model (to the other of the two, or to none), or the thinking of the task or of the integration. The Responses API has one field for the level, so there is no other to offer. */
function thinkingRemedy(model: string, sent: SentThinking): string {
  const other = sent.parameter === "reasoning_effort"
    ? `"chat_template_kwargs.reasoning_strength" (the level as an argument of the chat template, as Muse Glimmer takes it)`
    : `"reasoning_effort" (the OpenAI field)`;
  const choices = sent.parameter === "reasoning.effort" ? `"none" (no level is sent)` : `${other} or to "none" (no level is sent)`;
  return `Set "Thinking parameter" of the model "${model}" in AI Integrations to ${choices}, or set thinking to "Automatic" for this task in the AI Router, or for the integration "${sent.integration}" in AI Integrations.`;
}

/**
 * The error of a response that is not OK: what the provider answered, read as its words (`AiErrorBody`: the status, the message, the type, the parameter and the code of its error, or its text when it is no
 * known shape, or only the status when it said nothing), whole, and never cut but with an ellipsis. `sent` says where the level went when the request carried a thinking level: a refusal of that parameter is
 * then said in the author's words too.
 */
async function providerError(response: Response, provider: string, model: string, redact: (text: string) => string, sent?: SentThinking): Promise<AiProviderError> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = response.statusText ?? "";
  }
  const status = response.status;
  const body = parseErrorBody(status, text, redact);
  const said = describeErrorBody(body);
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  const retryAfterMs = status === 429 || status === 503 ? parseRetryAfter(response.headers?.get?.("retry-after")) : undefined;
  // A level was sent and the provider refuses the parameter: the same request would be refused again, so it is no use to repeat it. (A level refused only because the request carries function tools is not
  // this: that request is asked again without it, and the provider's own words are all there is to say.)
  if (sent !== undefined && (status === 400 || status === 422) && THINKING_PARAMETER.test(`${body.message ?? body.raw ?? ""} ${body.param ?? ""}`) && !refusesThinkingWithTools(body)) {
    return new AiProviderError(
      redact(`${provider} ${model}: the model does not accept a thinking level (${said}). Nothing was applied. ${thinkingRemedy(model, sent)}`),
      status,
      false,
      { body },
    );
  }
  return new AiProviderError(
    redact(`${provider} ${model}: ${said}`),
    status,
    retryable,
    { body, ...(TRANSIENT_STATUSES.has(status) ? { transient: true } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  );
}

/** What a host of the stream reader hears: the events, the chunks (it may stop the stream by throwing) and the end of every piece. */
interface StreamHooks {
  /** An event arrived: its `data:` lines, joined, and the name its `event:` line gave it (lower case; empty when it had none). */
  onData: (data: string, event: string) => void;
  /** A chunk arrived: its bytes (comments that only keep the connection open included) and the text they decode to. */
  onChunk: (count: number, decoded: string) => void;
  /** A piece was read and every event in it delivered. */
  onPiece: () => void;
}

/** The connection failed while a stream was being read (as opposed to a deadline, the author's cancel, or what the engine itself found wrong). */
class StreamReadError extends Error {
  constructor(readonly reason: unknown) {
    super("The stream could not be read.");
    this.name = "StreamReadError";
  }
}

/**
 * Reads server-sent events; resolves `true` when the provider closed the stream with `[DONE]`. A line ends with a line feed, a carriage return or both (the specification allows
 * the three, and a pair cut between two chunks is one end). An event is its `data:` lines joined with a newline, ended by a blank line, and it may be named by an `event:` line;
 * a value that is complete as it stands (one JSON object, or `[DONE]`) is delivered at once, so servers that leave out the blank lines still stream. Lines that are
 * neither (`: keep-alive` comments, `id:`, `retry:`) are ignored, and the text of a character that a chunk cuts in two is kept until the rest comes.
 * Every piece that arrives starts the idle deadline again, a comment too, and no read can hold the call past
 * a deadline or the author's cancel. However it ends, but by the end of the stream, the reader is released.
 */
async function readEventStream(response: Response, clock: DeadlineClock, hooks: StreamHooks): Promise<boolean> {
  if (!response.body) throw new AiProviderError("The provider returned an empty stream.", undefined, true, { transient: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  /** The line that is being read: what has arrived of it. */
  let buffer = "";
  /** The last line ended with a carriage return: a line feed that opens the next chunk is the other half of the same end. */
  let skipLineFeed = false;
  let pending: string[] = [];
  /** The name that the `event:` line of the event being read gave it. */
  let named = "";
  let exhausted = false;
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
    const event = named;
    pending = [];
    named = "";
    if (!lines.length) {
      // An `event: error` with no data at all still says that the provider failed.
      if (event === "error") hooks.onData("", event);
      return false;
    }
    const joined = lines.join("\n").trim();
    if (joined === "[DONE]") return true;
    if (lines.length > 1 && !complete(joined)) {
      // Lines that do not make one value are separate events that came without a blank line between them.
      for (const line of lines) {
        const single = line.trim();
        if (single === "[DONE]") return true;
        if (single) hooks.onData(single, event);
      }
      return false;
    }
    if (joined || event === "error") hooks.onData(joined, event);
    return false;
  };
  const takeLine = (line: string): boolean => {
    if (!line) return flush();
    if (line.startsWith("event:")) {
      named = line.slice(6).trim().toLowerCase();
      return false;
    }
    if (!line.startsWith("data:")) return false;
    pending.push(line.slice(5).trimStart());
    return complete(pending.join("\n")) ? flush() : false;
  };
  /** Splits what arrived into lines and takes them; `true` when the end marker was among them. */
  const feed = (decoded: string): boolean => {
    let text = decoded;
    if (skipLineFeed) {
      skipLineFeed = false;
      if (text.charCodeAt(0) === 10) text = text.slice(1);
    }
    buffer += text;
    let start = 0;
    for (let at = 0; at < buffer.length; at += 1) {
      const code = buffer.charCodeAt(at);
      if (code !== 10 && code !== 13) continue;
      const line = buffer.slice(start, at);
      if (code === 13) {
        if (at + 1 < buffer.length) {
          if (buffer.charCodeAt(at + 1) === 10) at += 1;
        } else {
          skipLineFeed = true;
        }
      }
      start = at + 1;
      if (takeLine(line)) {
        buffer = "";
        return true;
      }
    }
    buffer = buffer.slice(start);
    return false;
  };
  try {
    for (;;) {
      let piece: ReadableStreamReadResult<Uint8Array>;
      try {
        piece = await clock.guard(reader.read());
      } catch (error) {
        // A deadline or the author's cancel is told by the call; anything else here is the connection.
        throw clock.interrupted() ? error : new StreamReadError(error);
      }
      if (piece.done) {
        exhausted = true;
        break;
      }
      clock.activity();
      const decoded = decoder.decode(piece.value, { stream: true });
      hooks.onChunk(piece.value.byteLength, decoded);
      if (feed(decoded)) return true;
      hooks.onPiece();
    }
    const rest = decoder.decode();
    if (rest && feed(rest)) return true;
    if (buffer.trim() && takeLine(buffer)) return true;
    return flush();
  } finally {
    // The provider closed the stream, or the reply is given up (the end marker, an error chunk, a deadline, the author): let the connection go.
    if (!exhausted) release(reader);
  }
}

/**
 * Reads the whole body of a reply that is one JSON value. Like the stream reader it starts the idle deadline again at every piece, cannot
 * be held past a deadline or the author's cancel, and releases the body however it ends (`response.json()` would keep it locked).
 */
async function readJsonBody(response: Response, clock: DeadlineClock, onChunk: (count: number, decoded: string) => void): Promise<unknown> {
  if (!response.body) return clock.guard(response.json());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let exhausted = false;
  try {
    for (;;) {
      let piece: ReadableStreamReadResult<Uint8Array>;
      try {
        piece = await clock.guard(reader.read());
      } catch (error) {
        throw clock.interrupted() ? error : new StreamReadError(error);
      }
      if (piece.done) {
        exhausted = true;
        break;
      }
      clock.activity();
      const decoded = decoder.decode(piece.value, { stream: true });
      onChunk(piece.value.byteLength, decoded);
      body += decoded;
    }
    body += decoder.decode();
    return JSON.parse(body);
  } finally {
    if (!exhausted) release(reader);
  }
}

const COMPLETE_REASONS = new Set(["stop", "tool_calls", "function_call", "end_turn", "stop_sequence", "tool_use", "eos"]);
const TRUNCATED_REASONS = new Set(["length", "max_tokens", "max_output_tokens", "model_length", "context_length_exceeded"]);
const FILTERED_REASONS = new Set(["content_filter", "safety", "blocked", "recitation", "prohibited_content", "refusal"]);
const FAILED_REASONS = new Set(["error", "failed", "abort", "aborted", "cancelled", "canceled", "incomplete"]);

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

const PERMANENT_STREAM_ERROR = /authenticat|unauthori[sz]ed|forbidden|permission|invalid[_ -]?(?:request|api[_ -]?key|argument|parameter)|bad[_ -]?request|user[_ -]?error/i;
const TRANSIENT_STREAM_ERROR = /overload|rate[_ -]?limit|too[_ ]many[_ ]requests|temporar|unavailable|busy|try again|time[ds]? ?out|capacity/i;

/**
 * A failure the provider reported inside the stream (`{"error": {...}}`, `{"error": "..."}`, or an `event: error`), or `null` when the
 * chunk carries none. It is retried unless its status or code says authentication or an invalid request. `started`: the model had already written something, so the provider was answering
 * when it failed and the reply stopped halfway: that is a failure of the moment (`AiStreamInterruptedError`, `transient`), whatever the runtime calls it (a 500, a crash, no status at all),
 * as long as it is not one of those that never change. A failure before any of the reply is the provider refusing or failing at the start: it is `transient` only when its status or
 * its words say it depends on the moment (a deterministic failure, `context too long`, would be the same every time).
 */
function streamError(value: unknown, label: string, details: AiProviderErrorDetails, redact: (text: string) => string, started: boolean): AiProviderError | null {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const message = typeof value === "string" ? value.trim() : typeof source?.message === "string" ? source.message.trim() : "";
  if (!source && !message) return null;
  const status = [source?.status, source?.status_code, source?.code]
    .map((entry) => (typeof entry === "number" ? entry : typeof entry === "string" && /^\d{3}$/.test(entry.trim()) ? Number(entry) : Number.NaN))
    .find((entry) => Number.isInteger(entry) && entry >= 100 && entry < 600);
  const words = [source?.type, source?.code, source?.status].filter((entry): entry is string => typeof entry === "string").join(" ");
  const permanent = (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) || PERMANENT_STREAM_ERROR.test(words);
  const transient = !permanent && ((status !== undefined && TRANSIENT_STATUSES.has(status)) || TRANSIENT_STREAM_ERROR.test(`${message} ${words}`));
  const body = errorBodyOfObject(value, status ?? 200, redact);
  const detail = body ? describeErrorBody(body).replace(/^HTTP \d+(?:, no body| — )?/, "") || "no details" : "no details";
  const said = redact(`${label}: the provider reported an error during the reply — ${detail}`);
  if (started && !permanent) return new AiStreamInterruptedError(said, "provider-error", status, { ...details, ...(body ? { body } : {}) });
  return new AiProviderError(said, status, !permanent, { ...details, ...(body ? { body } : {}), ...(transient ? { transient: true } : {}) });
}

/**
 * Characters of reasoning a reply carried. Only the count is kept, never the reasoning itself. The reasoning is in `reasoning_content` (llama.cpp, DeepSeek, older vLLM) or in `reasoning`
 * (newer vLLM, OpenRouter); a runtime that is moving from the first to the second sends the same words under both names, and they are counted once.
 */
function reasoningLength(source: unknown): number {
  if (!source || typeof source !== "object") return 0;
  const { reasoning_content: content, reasoning } = source as { reasoning_content?: unknown; reasoning?: unknown };
  const first = typeof content === "string" ? content : "";
  const second = typeof reasoning === "string" ? reasoning : "";
  return first === second ? first.length : first.length + second.length;
}

/** A function call of a reply: its name and its arguments, as text. */
interface FunctionCall {
  name: string;
  arguments: string;
}

/** The function calls of a message (`tool_calls`) whose arguments are text, in their order. */
function callsOf(value: unknown): FunctionCall[] {
  if (!Array.isArray(value)) return [];
  const calls: FunctionCall[] = [];
  for (const entry of value) {
    const fn = entry && typeof entry === "object" ? (entry as { function?: unknown }).function : undefined;
    if (!fn || typeof fn !== "object") continue;
    const { name, arguments: args } = fn as { name?: unknown; arguments?: unknown };
    if (typeof args === "string") calls.push({ name: typeof name === "string" ? name : "", arguments: args });
  }
  return calls;
}

/**
 * The arguments of the call that is the reply: the first call to the function that was asked for that carries arguments, else the first
 * that carries any, else the first. The other calls are ignored, never joined to it.
 */
function chosenArguments(calls: Iterable<FunctionCall>, wanted: string | undefined): string {
  let first: string | undefined;
  let firstWithArguments: string | undefined;
  for (const call of calls) {
    first ??= call.arguments;
    if (!call.arguments.trim()) continue;
    if (wanted && call.name === wanted) return call.arguments;
    firstWithArguments ??= call.arguments;
  }
  return firstWithArguments ?? first ?? "";
}

interface StreamedChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown };
    message?: { tool_calls?: unknown };
    finish_reason?: string | null;
  }>;
  usage?: unknown;
  error?: unknown;
  /** The Responses API only (see `ResponsesChunk`): what the model refused with, the characters of reasoning the piece shows and the tokens the model spent reasoning. */
  refusal?: string;
  reasoningCharacters?: number;
  reasoningTokens?: number;
}

/** What of the end of a stream is kept to cut the reported tail from: longer than the tail, so that a credential that the cut would divide has been replaced whole before it is. */
const TAIL_WINDOW_CHARACTERS = TRANSPORT_TAIL_CHARACTERS * 3;
/** The most characters of what a model refused with that an error shows. */
const MAX_REFUSAL_CHARACTERS = 300;
/** The headers in which a provider or its gateway puts the id of a request: it is what they look a call up by in their logs. */
const REQUEST_ID_HEADERS = ["x-llmproxy-request-id", "x-request-id", "request-id", "x-ms-request-id", "apim-request-id"];
/** The most addresses a set of refusals of `stream_options` keeps. */
const MAX_REMEMBERED_REFUSALS = 200;

/** The id that a response carries for its request, when it is one (letters, digits and a few signs: never anything a key could be). */
function requestIdOf(headers: Headers | undefined): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers?.get?.(name)?.trim();
    if (value && /^[A-Za-z0-9._:-]{1,100}$/.test(value)) return value;
  }
  return undefined;
}

/** The text of a reasoning field in a piece of a stream, with the closing quote when the piece has it (a window of a stream may end, or begin, inside one). */
const REASONING_FIELD = /("(?:reasoning_content|reasoning)"\s*:\s*")(?:[^"\\]|\\.)*("?)/g;

/**
 * The end of a stream as the diagnostics keep it: what arrived, without the words of the model's reasoning (the engine never keeps them: only their count). `whole`: the window holds the
 * beginning of the stream. A window that begins somewhere inside the stream may begin inside a reasoning field, which cannot be told, so its first line (which may be cut) is dropped.
 */
function streamTail(window: string, whole: boolean): string {
  let text = window;
  if (!whole) {
    const at = text.search(/\r\n|\r|\n/);
    text = at < 0 ? "" : text.slice(at + (text.startsWith("\r\n", at) ? 2 : 1));
  }
  return text.replace(REASONING_FIELD, "$1…$2");
}

/** A refusal of `stream_options`: a 400 or a 422 whose message names the option (or `include_usage`). */
function refusesUsageOption(failure: AiProviderError, label: string): boolean {
  return (failure.status === 400 || failure.status === 422) && /stream[_ -]?options|include[_ -]?usage/i.test(failure.message.replace(label, ""));
}

function withoutUsageOption(body: Record<string, unknown>): Record<string, unknown> {
  const { stream_options: _refused, ...rest } = body;
  return rest;
}

type LimitParameter = "max_tokens" | "max_completion_tokens";

/**
 * The output-limit parameter that a 400 or a 422 says it refuses, when it does: «Unsupported parameter: 'max_tokens' is not supported with this model. Use
 * 'max_completion_tokens' instead.» (a reasoning model, or one that the name rules do not know yet) or the reverse («Unrecognized request argument: max_completion_tokens»,
 * an older API). `max_tokens` is looked for first: its refusal names the other parameter as the remedy.
 */
function refusedLimitParameter(failure: AiProviderError, label: string): LimitParameter | undefined {
  if (failure.status !== 400 && failure.status !== 422) return undefined;
  const said = failure.message.replace(label, "");
  if (!/unsupported|not supported|unrecognized|unknown|not permitted|extra inputs/i.test(said)) return undefined;
  if (/(?<![a-z_])max_tokens/i.test(said)) return "max_tokens";
  return /max_completion_tokens/i.test(said) ? "max_completion_tokens" : undefined;
}

function withLimitParameter(body: Record<string, unknown>, refused: LimitParameter): Record<string, unknown> {
  const used: LimitParameter = refused === "max_tokens" ? "max_completion_tokens" : "max_tokens";
  const { [refused]: limit, ...rest } = body;
  return typeof limit === "number" ? { ...rest, [used]: limit } : body;
}

/** What is remembered about a model that refused an output-limit parameter: the address and the model, since a gateway serves many models at one address. */
const limitRefusalKey = (refused: LimitParameter, url: string, model: string): string => `limit:${refused}:${url}#${model}`;

async function callCandidate(config: AiRuntimeConfig, attempt: PlannedAttempt, built: ChatRequest, request: AiRequest, options: FetchAiOptions, deadlines: ResolvedDeadlines, secrets: readonly string[], trace: AttemptTrace, refusals: Set<string>): Promise<AiResponse> {
  const { candidate } = attempt;
  const { integration, model } = candidate;
  const label = `${integration.provider} ${model}`;
  const redact = (text: string) => redactSecrets(text, secrets);
  const fetchImpl = options.fetch ?? fetch;
  const clock = startClock(request.signal, deadlines);
  const structured = Boolean(request.json);
  const wanted = request.json?.name;
  const elapsed = () => Date.now() - trace.startedAt;

  let text = "";
  let usage: AiUsage | undefined;
  let finishReason = "";
  let reasoningCharacters = 0;
  /** The tokens the provider says the model spent reasoning, for a reasoning that is not shown (the Responses API): the characters of it that were seen are none. */
  let reasoningTokens = 0;
  /** What the model said when it refused to answer (the Responses API). */
  let refusal = "";
  /** The reply is read as the Responses API tells it: one reader per attempt, whose events become the chunks that Chat Completions has. */
  const responsesReader = built.protocol === "responses" ? new ResponsesStreamReader() : undefined;
  /** The function calls of a streamed reply by their index, in the order they came. */
  const calls = new Map<number, FunctionCall>();
  /** The arguments of a call that came whole: in the message of a JSON reply, or in the last piece of a stream. */
  let wholeArguments = "";
  /** The response ended properly: a stream that closed with `[DONE]`, or a complete JSON body. */
  let ended = true;
  /** How the stream ended, once it has: what the diagnostics say unless a failure tells better. */
  let streamEnd: AiStreamEnd | undefined;
  let bytes = 0;
  let chunks = 0;
  let events = 0;
  let lastChunkAt: number | undefined;
  /** The end of what arrived, as it came (see `TAIL_WINDOW_CHARACTERS`), and how many characters arrived in all. */
  let tailWindow = "";
  let tailCharacters = 0;
  let status: number | undefined;
  let requestId: string | undefined;
  /** The request that is answered asks the provider for the tokens of the stream (`stream_options.include_usage`; the Responses API always ends its stream with them). */
  let usageRequested = Boolean(responsesReader) || Boolean(built.body.stream_options);
  let lastProgressAt: number | undefined;
  let response: Response | undefined;
  /** Where the call is, to say what went wrong when something does. */
  let stage: "send" | "stream" | "json" | "other" = "send";

  const callArguments = (): string => wholeArguments || chosenArguments(calls.values(), wanted);
  /** The cumulative value of a structured reply for `onStructuredText`: the arguments of the call, else the text. Sent only when it grew. */
  let structuredSent = 0;
  const reportStructured = (): void => {
    if (!request.onStructuredText) return;
    const value = callArguments() || text;
    if (value.length <= structuredSent) return;
    structuredSent = value.length;
    notify(request.onStructuredText, value);
  };
  /** The model has written something of the reply (its text, its reasoning or the call of its function): the provider is answering. */
  const started = (): boolean => Boolean(text || reasoningCharacters || calls.size || wholeArguments);
  /** What an attempt used: the provider's count, else an estimate once the model has started to answer. */
  const measure = (): { usage?: AiUsage; usageKnown?: boolean } => {
    if (usage && usage.inputTokens + usage.outputTokens > 0) return { usage, usageKnown: true };
    const args = callArguments();
    if (!text && !args && !reasoningCharacters) return {};
    return {
      usage: { inputTokens: attempt.inputTokens, outputTokens: likelyTextTokens(text) + likelyTextTokens(args) + Math.ceil(reasoningCharacters / 4), cachedInputTokens: 0 },
      usageKnown: false,
    };
  };
  /** What the transport saw: the numbers of the response, the end of what arrived and how it ended (`end`, else how the stream ended). Nothing of it is a key. */
  const transport = (end: AiStreamEnd | undefined = streamEnd, withTail = true): AiTransportDiagnostics => {
    const tail = withTail ? redact(streamTail(tailWindow, tailCharacters <= TAIL_WINDOW_CHARACTERS)).slice(-TRANSPORT_TAIL_CHARACTERS) : "";
    const shown = redact(finishReason).replace(/\s+/g, " ").trim().slice(0, 60);
    return {
      ...(status !== undefined ? { status } : {}),
      streamed: trace.streamed,
      bytes,
      chunks,
      events,
      ...(lastChunkAt !== undefined ? { lastChunkAfterMs: Math.max(0, lastChunkAt - trace.startedAt), lastChunkAt: new Date(lastChunkAt).toISOString(), silentMs: Math.max(0, Date.now() - lastChunkAt) } : {}),
      ...(tail ? { tail } : {}),
      ...(shown ? { finishReason: shown } : {}),
      usageReceived: Boolean(usage && usage.inputTokens + usage.outputTokens > 0),
      usageRequested,
      ...(end ? { end } : {}),
      ...(requestId ? { requestId } : {}),
    };
  };
  const details = (extra: AiProviderErrorDetails = {}, end?: AiStreamEnd): AiProviderErrorDetails => {
    const measured = measure();
    // The reply that had arrived: its text without a reasoning block, else the arguments of its function.
    const written = splitReasoningBlock(text).reply;
    const partial = written.trim() ? written : callArguments();
    return {
      usage: measured.usage,
      cost: estimateCost(measured.usage, candidate.pricing),
      ...(measured.usageKnown === undefined ? {} : { usageKnown: measured.usageKnown, costKnown: measured.usageKnown && Boolean(candidate.pricing) }),
      currency: config.costCurrency,
      model,
      provider: integration.provider,
      integrationId: integration.id,
      ...(status !== undefined || bytes > 0 ? { transport: transport(end) } : {}),
      ...(partial ? { partialText: redact(partial.slice(0, MAX_PARTIAL_CHARACTERS)) } : {}),
      ...extra,
    };
  };
  /** A stream that no model's answer explains: stopped, with what it used and what to do. */
  const runaway = (what: string): AiProviderError => new AiProviderError(
    redact(`${label}: ${what}. Nothing was applied: the provider may have used tokens. Lower the thinking effort of the model or choose another one.`),
    undefined,
    false,
    details(),
  );
  const timeoutError = (expired: ExpiredDeadline, answering: boolean): AiProviderError => new AiProviderError(
    redact(timeoutMessage(label, expired, deadlines, integration.name)),
    undefined,
    true,
    {
      ...(answering ? details({}, "timeout") : {}),
      transient: true,
      timedOut: true,
      timeout: { phase: expired.phase, ms: expired.ms, ...(expired.phase === "start" && deadlines.raisedFrom !== undefined ? { raisedFrom: deadlines.raisedFrom } : {}), ...(deadlines.routingMs !== undefined && expired.ms === deadlines.routingMs ? { routing: true } : {}) },
    },
  );
  const reportProgress = (): void => {
    if (!request.onProgress) return;
    const now = Date.now();
    if (lastProgressAt !== undefined && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    notify(request.onProgress, { bytes, events, characters: text.length + callArguments().length });
  };
  const addCalls = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const { index, function: fn } = entry as { index?: unknown; function?: { name?: unknown; arguments?: unknown } };
      if (!fn || typeof fn !== "object") continue;
      trace.toolSeen = true;
      // A piece without an index belongs to the only call there is.
      const key = typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : 0;
      let call = calls.get(key);
      if (!call) {
        call = { name: "", arguments: "" };
        calls.set(key, call);
      }
      if (typeof fn.name === "string" && fn.name) call.name = fn.name;
      if (typeof fn.arguments === "string") call.arguments += fn.arguments;
    }
  };
  const take = (data: string, event = ""): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = undefined;
    }
    let chunk: StreamedChunk;
    if (event === "error") {
      // An `event: error`: whatever its data is (an error object, a message, nothing), the provider is reporting a failure.
      const inner = parsed && typeof parsed === "object" && "error" in parsed ? (parsed as { error?: unknown }).error : parsed;
      chunk = { error: inner || data.trim() || "the provider sent an error event without details" };
    } else {
      if (parsed === undefined) return;
      // The Responses API tells its events by name, and a few of them are the reply: they become the chunks that the rest of this reads.
      const read = responsesReader ? responsesReader.read(parsed, event) : parsed as StreamedChunk;
      if (!read) return;
      chunk = read;
    }
    if (!chunk || typeof chunk !== "object") return;
    if (chunk.error) {
      const failure = streamError(chunk.error, label, details({}, "error"), redact, started());
      if (failure) throw failure;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const first = choices[0];
    const delta = first?.delta;
    reasoningCharacters += reasoningLength(delta) + (chunk.reasoningCharacters ?? 0);
    if (typeof chunk.reasoningTokens === "number") reasoningTokens = chunk.reasoningTokens;
    if (chunk.refusal) refusal = chunk.refusal;
    if (reasoningCharacters > MAX_STREAM_REASONING_CHARACTERS) throw runaway(`the model's reasoning passed the safety limit of ${MAX_STREAM_REASONING_CHARACTERS / 1_000_000} million characters (a reasoning loop is likely)`);
    if (delta?.content) {
      text += delta.content;
      // The text of a structured reply is no prose for the listener: its progress is `onProgress`.
      if (!structured) notify(request.onText, text);
    }
    addCalls(delta?.tool_calls);
    // Some providers end the stream with the whole message instead of (or after) the pieces.
    const whole = callsOf(first?.message?.tool_calls);
    if (whole.length) {
      trace.toolSeen = true;
      const args = chosenArguments(whole, wanted);
      if (args.trim()) wholeArguments = args;
    }
    const reason = choices.find((choice) => typeof choice?.finish_reason === "string" && choice.finish_reason)?.finish_reason;
    if (reason) finishReason = reason;
    if (structured) reportStructured();
    // The usage comes in whichever chunk the provider puts it (the last one with no choice, the one that finishes the reply, or every one); a count of zero does not replace one that was read.
    if (chunk.usage) {
      const next = normalizeUsage(chunk.usage);
      if (next && (next.inputTokens + next.outputTokens > 0 || !usage)) usage = next;
    }
  };
  const chunkArrived = (count: number, decoded: string, what: "stream" | "reply"): void => {
    bytes += count;
    chunks += 1;
    lastChunkAt = Date.now();
    tailCharacters += decoded.length;
    tailWindow = decoded.length >= TAIL_WINDOW_CHARACTERS ? decoded.slice(-TAIL_WINDOW_CHARACTERS) : (tailWindow + decoded).slice(-TAIL_WINDOW_CHARACTERS);
    trace.firstByteMs ??= elapsed();
    if (bytes > MAX_STREAM_TRANSPORT_BYTES) throw runaway(`the ${what} passed the safety limit of ${MAX_STREAM_TRANSPORT_BYTES / 1_000_000} MB (a model that loops while reasoning looks like this)`);
  };
  const hooks: StreamHooks = {
    onData: (data, event) => {
      events += 1;
      take(data, event);
    },
    onChunk: (count, decoded) => chunkArrived(count, decoded, "stream"),
    onPiece: reportProgress,
  };

  // What is sent: an address that refused `stream_options` before is not asked it again.
  let body = built.body;
  if (usageRequested && !responsesReader && refusals.has(built.url)) {
    body = withoutUsageOption(body);
    usageRequested = false;
  }
  // A model that refused an output-limit parameter before is sent the other one at once.
  for (const refused of ["max_tokens", "max_completion_tokens"] as const) {
    if (refusals.has(limitRefusalKey(refused, built.url, model))) body = withLimitParameter(body, refused);
  }
  const limitSwaps = new Set<LimitParameter>();
  const send = (): Promise<Response> => {
    const sent = Promise.resolve(fetchImpl(built.url, {
      method: "POST",
      headers: built.headers,
      body: JSON.stringify(body),
      signal: clock.signal,
    }));
    // A reply that comes after the call was given up is dropped, and its body let go.
    sent.then((late) => {
      if (clock.interrupted()) discardBody(late);
    }, () => undefined);
    return clock.guard(sent);
  };

  try {
    for (;;) {
      stage = "send";
      response = await send();
      stage = "other";
      status = response.status;
      requestId = requestIdOf(response.headers);
      if (response.ok) break;
      trace.firstByteMs ??= elapsed();
      const failure = await clock.guard(providerError(response, integration.provider, model, redact, built.thinking && built.thinkingWhy !== "tools" ? { integration: integration.name, parameter: built.protocol === "responses" ? "reasoning.effort" : built.reasoningParameter ?? "reasoning_effort" } : undefined));
      failure.transport = transport();
      // A provider that refuses `stream_options` is asked again, at once, without it, and is not asked it again: its replies carry no token count, which is then an estimate.
      if (usageRequested && !responsesReader && refusesUsageOption(failure, label)) {
        if (refusals.size >= MAX_REMEMBERED_REFUSALS) refusals.delete(refusals.values().next().value as string);
        refusals.add(built.url);
        usageRequested = false;
        body = withoutUsageOption(body);
        continue;
      }
      // A model that refuses the output-limit parameter it was sent is asked again, at once, with the other one, and is not asked the refused one again.
      const refusedLimit = refusedLimitParameter(failure, label);
      if (refusedLimit && !limitSwaps.has(refusedLimit) && refusedLimit in body) {
        limitSwaps.add(refusedLimit);
        if (refusals.size >= MAX_REMEMBERED_REFUSALS) refusals.delete(refusals.values().next().value as string);
        refusals.add(limitRefusalKey(refusedLimit, built.url, model));
        body = withLimitParameter(body, refusedLimit);
        continue;
      }
      // A provider that cannot stream says so with a 400: tell where to switch streaming off.
      if (built.stream && (failure.status === 400 || failure.status === 422) && /stream/i.test(failure.message.replace(label, ""))) {
        failure.message = redact(`${failure.message}${/[.!?]$/.test(failure.message) ? "" : "."} If this provider cannot stream its replies, set "Streaming" of the integration "${integration.name}" to "off".`);
      }
      throw failure;
    }
    // A streamed request: the start deadline is over, the silence between two pieces is what is watched now.
    if (built.stream) clock.streaming();
    // A JSON body to a streaming request means the server ignored `stream`: its reply is read as a whole.
    const streamed = built.stream && !/\bjson\b/i.test(response.headers?.get?.("content-type") ?? "");
    trace.streamed = streamed;
    if (streamed) {
      stage = "stream";
      // A stream of Chat Completions ends with `[DONE]`; the Responses API has no such marker: its last event (`response.completed`, `response.incomplete` or `response.failed`) is the end.
      ended = (await readEventStream(response, clock, hooks)) || Boolean(responsesReader?.finished);
      streamEnd = ended ? "done" : "closed";
    } else {
      stage = "json";
      trace.firstByteMs ??= elapsed();
      const raw = await readJsonBody(response, clock, (count, decoded) => chunkArrived(count, decoded, "reply"));
      const payload = (responsesReader ? responseAsChat(raw) : raw) as {
        choices?: Array<{ message?: { content?: string | null; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: Array<{ function?: { arguments?: string } }> }; finish_reason?: string | null }>;
        usage?: unknown;
        error?: unknown;
        refusal?: string;
        reasoningCharacters?: number;
        reasoningTokens?: number;
      } | null;
      if (payload?.error) {
        const failure = streamError(payload.error, label, details(), redact, false);
        if (failure) throw failure;
      }
      const choice = payload?.choices?.[0];
      text = typeof choice?.message?.content === "string" ? choice.message.content : "";
      wholeArguments = choice?.message?.tool_calls?.find((call) => typeof call.function?.arguments === "string")?.function?.arguments ?? "";
      if (Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length) trace.toolSeen = true;
      finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
      reasoningCharacters = reasoningLength(choice?.message) + (payload?.reasoningCharacters ?? 0);
      reasoningTokens = payload?.reasoningTokens ?? 0;
      refusal = payload?.refusal ?? "";
      usage = normalizeUsage(payload?.usage);
      // A plain reply that came whole still reaches the listener of the text, once.
      if (!structured && text) notify(request.onText, text);
      if (structured) reportStructured();
    }
    stage = "other";

    const outcome = classifyFinishReason(finishReason, ended);
    const shown = redact(finishReason).replace(/\s+/g, " ").trim().slice(0, 60);
    // What the reply is, for the hooks, before it is judged: how the provider ended it and how much of it there is, whether or not the engine then accepts it. Never its words.
    const read = splitReasoningBlock(text);
    const readArguments = callArguments();
    trace.finishReason = shown;
    trace.replyCharacters = read.reply.trim().length + (isEmptyToolArguments(readArguments) ? 0 : readArguments.trim().length);
    trace.reasoningCharacters = reasoningCharacters + read.reasoningCharacters;
    // The record of an attempt that worked carries numbers only: the end of the stream is for the one that failed.
    trace.transport = transport(undefined, false);
    // A reply that stops halfway (the stream closed too early, or the provider ended it with an error or an abort) is a failure of the moment, and what had arrived goes with it.
    if (outcome === "incomplete") throw new AiStreamInterruptedError(`${label}: the stream ended before the reply was complete.`, "ended", undefined, details());
    if (outcome === "unexpected") throw new AiStreamInterruptedError(`${label}: unexpected finish reason "${shown}" and the stream did not end with [DONE]: the reply may be incomplete.`, "ended", undefined, details());
    if (outcome === "failed") throw new AiStreamInterruptedError(`${label}: the provider ended the reply with the finish reason "${shown}".`, /abort|cancel/i.test(shown) ? "provider-abort" : "provider-error", undefined, details({}, "error"));
    if (outcome === "filtered") {
      // A model that refuses says so in words of its own (the Responses API gives them apart from the text); they are shown as they are, cut short.
      const said = redact(refusal).replace(/\s+/g, " ").trim();
      throw new AiProviderError(
        shown === "refusal" ? `${label}: the model refused to answer${said ? `: "${said.length > MAX_REFUSAL_CHARACTERS ? `${said.slice(0, MAX_REFUSAL_CHARACTERS)}…` : said}"` : ""}.` : `${label}: the provider filtered the reply content (${shown}).`,
        undefined,
        false,
        details(),
      );
    }
    // Some local servers leave the reasoning in the content as a leading <think> block: it is not the reply.
    const inline = splitReasoningBlock(text);
    text = inline.reply;
    reasoningCharacters += inline.reasoningCharacters;
    const toolArguments = callArguments();
    const answered = Boolean(text.trim() || toolArguments.trim());
    if (outcome === "truncated") {
      const seen = !answered && (reasoningCharacters > 0 || reasoningTokens > 0);
      // A model that is declared as reasoning and wrote nothing spent its limit on a reasoning that it does not show: the reply is cut the same way.
      const declared = !answered && !seen && candidate.supportsReasoning === true;
      const reasoned = seen || declared;
      throw new AiProviderError(
        `${label}: ${seen ? "the model used its output limit while reasoning, before writing the reply" : declared ? "the model, which is declared as reasoning, used its output limit before writing the reply (its reasoning counts in the limit)" : "the reply was cut by the output token limit"}. Nothing was applied.`,
        undefined,
        false,
        details({ truncated: true, ...(reasoned ? { reasoningOnly: true, ...(candidate.maxOutputTokens && (built.outputLimit ?? 0) >= candidate.maxOutputTokens ? { limitReached: true } : {}) } : {}) }),
      );
    }
    if (!answered) throw new AiProviderError(`${label}: ${reasoningCharacters > 0 || reasoningTokens > 0 ? "the model finished after reasoning without a reply" : "the provider returned an empty reply"}.`, undefined, true, details());

    // Measured before the arguments of a function become the text of the reply: they are counted once.
    const measured = measure();
    let json: unknown;
    if (request.json) {
      // With "Tools only" (on unless the configuration turned it off) the answer is the call of the function: the text of the reply is never
      // read, neither as the answer nor as a fallback to empty or wrong arguments. A reply with no call at all is refused and the next candidate is tried.
      const toolsOnly = config.toolsOnly !== false;
      if (toolsOnly && !toolArguments.trim()) {
        throw new AiReplyRejectedError(
          redact(`${label}: the model answered in text instead of calling the function "${request.json.name}": "Tools only" is on, so the text of a reply is never read as the answer. If this model cannot call functions, turn off "Tools only" in the AI Router.`),
          details(),
        );
      }
      try {
        json = structuredFromReply({ toolArguments, content: toolsOnly ? "" : text, schema: request.json });
      } catch (error) {
        throw new AiReplyRejectedError(redact(`${label}: ${error instanceof Error ? error.message : "invalid structured reply"}`), details());
      }
      if (!text) text = toolArguments;
    }
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
  } catch (error) {
    if (response && clock.interrupted()) discardBody(response);
    // The author's cancel wins over everything, and is never a timeout.
    if (request.signal?.aborted) throw request.signal.reason instanceof Error ? request.signal.reason : abortError();
    const expired = clock.expired();
    if (expired) throw timeoutError(expired, stage === "stream" || stage === "json");
    if (error instanceof AiProviderError) throw error;
    if (stage === "send") throw new AiProviderError(redact(`${label}: ${error instanceof Error ? error.message : String(error)}`), undefined, true, { transient: true });
    if (stage === "stream" && error instanceof StreamReadError) {
      throw new AiStreamInterruptedError(
        redact(`${label}: the connection with the provider was lost while it was answering, so the reply could not be read. Nothing was applied. If this happens every time, check the proxy or the tunnel between this app and the provider.`),
        "lost",
        undefined,
        details({}, "reset"),
      );
    }
    if (stage === "stream" || stage === "json") throw new AiProviderError(redact(`${label}: the reply could not be read.`), undefined, true, details({ transient: true }, stage === "stream" ? "reset" : undefined));
    throw error;
  } finally {
    clock.dispose();
  }
}
