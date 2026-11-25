import type { FetchAiAttempt, FetchAiAttemptEnd } from "./fetch-client.js";

/** Function-calling schema used to request structured output. */
export interface AiJsonSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/**
 * What has arrived of a streamed reply, for a host that wants to say "the model is answering (12 KB)". Only numbers, never the
 * reply itself: `bytes` are the bytes received (comments that keep the connection open included), `events` the events of the stream,
 * `characters` the characters of the reply so far (its text and the arguments of its function call, not the reasoning).
 */
export interface AiProgress {
  bytes: number;
  events: number;
  characters: number;
}

/** A part of the content of a message: text, or an image given as a data URL. */
export type AiContentPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string };

/** One message of a conversation: its role and its content, which is text or a list of parts (text and images). */
export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string | AiContentPart[];
}

export interface AiRequest {
  /** Router capability, e.g. `autopilot`, `director`, `reader-evaluation`, `review`, `simple-tasks`. */
  capability: string;
  /** Short label shown in logs and debug panels. */
  label: string;
  system: string;
  user: string;
  /**
   * The conversation to send, for a host that has one (the web app's Copilot: its history, and the images the author attached). When it is there (and is not empty) it is what
   * is sent, with its roles and its parts, in place of `system` and `user`, which are then not read (give empty text). A part of text goes out as it is and an image as an
   * `image_url` with its data URL. With a structured request, the JSON instruction that a model without tool calls receives is added to the first system message (to a
   * system message of its own when there is none). The engine never changes the messages it is given.
   */
  messages?: AiMessage[];
  /**
   * When present the reply must be one JSON object matching this schema, delivered as the forced call of a function. With "Tools only" off
   * (`AiRuntimeConfig.toolsOnly`), a model marked as without tool calls gets the schema in the message instead, and a JSON in the text is read.
   */
  json?: AiJsonSchema;
  maxOutputTokens?: number;
  /** Multiplies the output limit (after the structured floor and the reasoning margin, up to the model's own maximum). */
  outputBoost?: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Receives the cumulative text while a plain-text reply streams (and once, whole, when it arrives as one JSON body). Never called for a
   * structured request: its progress is `onProgress`.
   */
  onText?: (text: string) => void;
  /**
   * Called while a reply streams, at most every 250 ms, with how much has arrived and no content (see `AiProgress`). It is how a
   * structured reply shows that the model is answering. A listener that throws never breaks the call.
   */
  onProgress?: (progress: AiProgress) => void;
  /**
   * Receives the cumulative JSON of a structured reply while it streams: the arguments of the function the model calls, or its text when it answers in
   * text. It follows the same rule as `onText`: a shorter value, or `""`, starts a new attempt (after a failed candidate). Never called for a plain-text
   * request, and never part of what is sent. Only the providers whose stream the client reads send it (the OpenAI-compatible ones).
   */
  onStructuredText?: (text: string) => void;
  /** An attempt of this call is about to be sent (the client's `onAttempt`, for this call only). Never part of what is sent. */
  onAttempt?: (attempt: FetchAiAttempt) => void;
  /** An attempt of this call ended, worked or not (the client's `onAttemptEnd`, for this call only). Never part of what is sent. */
  onAttemptEnd?: (end: FetchAiAttemptEnd) => void;
}

export interface AiResponse {
  text: string;
  json?: unknown;
  usage?: AiUsage;
  /** `false` when the provider reported no tokens and `usage` is the engine's estimate. */
  usageKnown?: boolean;
  model?: string;
  provider?: string;
  integrationId?: string;
  cost?: number;
  /** `false` when `cost` is missing because the model has no price, or is an estimate built on estimated tokens. */
  costKnown?: boolean;
  currency?: string;
  /** The provider stopped because of the output token limit. */
  truncated?: boolean;
}

/** The engine's only door to language models. Hosts adapt their own routing to it. */
export interface AiPort {
  complete(request: AiRequest): Promise<AiResponse>;
}

export class AiUnavailableError extends Error {
  /** The targets of the route that cannot be called, when the author wrote one and none of them can (see `AiRouteStep`). */
  route?: AiRouteStep[];

  constructor(readonly capability: string, message?: string) {
    super(message ?? `No AI model is configured for the "${capability}" task. Configure an integration in the AI router.`);
    this.name = "AiUnavailableError";
  }
}

/**
 * The integration a failed request was sent to (the last candidate tried), so that a client can say where it failed. Never a key, and the
 * endpoint is only the origin of its address. It is separate from `model`, `provider` and `integrationId` of the error, whose presence
 * means that the model had started to answer (and is billed).
 */
export interface AiErrorTarget {
  provider: string;
  model: string;
  integrationId: string;
  /** The origin (`https://api.openai.com`) of the integration's address: never its path or its query. */
  endpoint?: string;
  /** The API version the request carried (Azure OpenAI's `api-version`, or `v1`), as `effectiveApiVersion` says it for the model that was asked. Absent for a provider that has none. */
  apiVersion?: string;
}

/** Which deadline of a call ran out: the provider did not start answering (`start`), went silent while it answered (`idle`), or the call took longer than any call may (`total`). */
export type AiTimeoutPhase = "start" | "idle" | "total";

/** Which deadline ran out and how long it was, on the error of a call that timed out. Never a secret. */
export interface AiTimeoutDetails {
  phase: AiTimeoutPhase;
  /** The limit that ran out, in milliseconds. */
  ms: number;
  /** The provider timeout the integration asked for, when the call raised it to the minimum (`MIN_REQUEST_TIMEOUT_MS`). */
  raisedFrom?: number;
  /**
   * The limit was not the call's own but the routing time that was left (`maxTotalDurationMs`, the author's «Maximum total duration», less what the earlier candidates of the call took):
   * only a candidate after the first is held to it, and only it makes the deadline `total` shorter than the four hours that no call may pass.
   */
  routing?: boolean;
}

/**
 * Why a candidate of a route was not asked: its target cannot be called at all (`unusable`), "Tools only" skips a model without tool calls (`no-tool-calls`), the privacy policy keeps content in the
 * primary's account (`boundary`), the prompt does not fit the model's context window (`context-window`), the routing limits of tokens or cost were reached (`budget`), the author did not acknowledge
 * sending content to another account (`not-acknowledged`) or the routing time was used up (`out-of-time`).
 */
export type AiLeftOutReason = "unusable" | "no-tool-calls" | "boundary" | "context-window" | "budget" | "not-acknowledged" | "out-of-time";

/** Why a target the author wrote in a route cannot be called: its integration is gone, its provider cannot run chat here, its model is not in the integration, or the model is not allowed this task. */
export type AiUnusableWhy = "integration-missing" | "provider-unsupported" | "model-missing" | "task-not-allowed";

/**
 * What became of one candidate of the route of a call: it was asked (and how it ended) or it was left out (and why). The route is the author's, in the order they wrote it: `position` 0 is the
 * primary, and a candidate that the router could not use or the plan left out has its place in it, so that the primary that did not answer is never taken for the one that did. Names are the author's
 * and are cleaned of credentials; nothing here is a key or the text of a request or a reply. A host keeps it on the error of a call that failed (`AiProviderError.route`) and in its records.
 */
export interface AiRouteStep {
  position: number;
  integrationId: string;
  integrationName: string;
  provider: string;
  model: string;
  outcome: "ok" | "failed" | "timeout" | "cancelled" | "left-out";
  /** The origin of the integration's address (never a path or a query). */
  endpoint?: string;
  /** The API version the attempt carried (Azure OpenAI's `api-version`, or `v1`), when the provider has one: the model's own, else its integration's. */
  apiVersion?: string;
  /** The HTTP status the provider answered, when it did. */
  status?: number;
  /** How long the attempt took, in milliseconds. Absent for a candidate that was left out. */
  durationMs?: number;
  /** What the provider or the engine said, cleaned of credentials and cut short. Absent for a candidate that was left out. */
  message?: string;
  /** For a timeout: which deadline ran out and how long it was, and whether it was the routing time that was left. */
  timeoutPhase?: AiTimeoutPhase;
  timeoutMs?: number;
  routing?: boolean;
  /** For a candidate that was left out: why, and the numbers that say it. */
  leftOut?: AiLeftOutReason;
  why?: AiUnusableWhy;
  /** `context-window`: the tokens the prompt needs (as estimated before sending) and what the model's window leaves for it. */
  promptTokens?: number;
  windowTokens?: number;
}

/**
 * How a streamed reply ended, as far as the engine could tell: `done` (the provider closed it with `[DONE]`), `closed` (the provider closed the connection without
 * it), `reset` (the connection broke while the stream was read), `error` (the provider reported a failure, or an abort, inside the stream) or `timeout` (a deadline ran out).
 */
export type AiStreamEnd = "done" | "closed" | "reset" | "error" | "timeout";

/** The most characters of the end of a stream that its diagnostics keep. */
export const TRANSPORT_TAIL_CHARACTERS = 300;

/**
 * What the transport saw of a call, to say where a reply stopped and why when it did: the numbers of the response, the end of what arrived and how the stream ended. Never a key:
 * the tail is cleaned of credentials before it is kept, and the request id is only what a gateway puts in a header to find the call in its logs.
 */
export interface AiTransportDiagnostics {
  /** The HTTP status of the response. Absent when none arrived (the connection failed first). */
  status?: number;
  /** The reply was read as a stream of events (and not as one JSON body). */
  streamed: boolean;
  /** Bytes of the body that arrived (comments that only keep the connection open included), the reads that brought them, and the events they held. */
  bytes: number;
  chunks: number;
  events: number;
  /** When the last chunk of the body arrived: the milliseconds from the start of the attempt, and the time. Absent when no chunk did. */
  lastChunkAfterMs?: number;
  lastChunkAt?: string;
  /** The milliseconds between the last chunk and the end of the attempt: the silence that came before the end. Absent when no chunk arrived. */
  silentMs?: number;
  /** The last `TRANSPORT_TAIL_CHARACTERS` characters that arrived, as they came (the end of the last event, usually), with credentials replaced. */
  tail?: string;
  /** How the provider said the reply ended (`stop`, `length`...), when it said. */
  finishReason?: string;
  /** The provider reported the tokens of the call (a usage object came in the stream or the body). */
  usageReceived: boolean;
  /** `stream_options.include_usage` was in the request that this response answers. `false` for a provider that refused it, and for a reply that is not a stream. */
  usageRequested: boolean;
  /** How the stream ended. Absent for a reply that was not a stream. */
  end?: AiStreamEnd;
  /** What the provider or its gateway calls this request (`X-LlmProxy-Request-Id`, `X-Request-Id`), to find it in their logs. */
  requestId?: string;
}

/** What a failed attempt already cost: the provider may bill a reply the engine rejects. */
export interface AiProviderErrorDetails {
  /** Where the request went. Set by the engine's client on the errors of the candidates it tried. */
  target?: AiErrorTarget;
  /** What the transport saw of the failed call (see `AiTransportDiagnostics`). */
  transport?: AiTransportDiagnostics;
  /**
   * The reply that had arrived when the call failed: its text, or the arguments of its function call. The engine never applies it, and does not lose it: it is here for a host
   * that wants to show or keep it. At most `MAX_PARTIAL_CHARACTERS` characters. Absent when nothing of the reply had arrived.
   */
  partialText?: string;
  usage?: AiUsage;
  /** `false` when the provider reported no tokens and `usage` is an estimate. */
  usageKnown?: boolean;
  cost?: number;
  costKnown?: boolean;
  currency?: string;
  model?: string;
  provider?: string;
  integrationId?: string;
  /** The provider stopped because of the output token limit. */
  truncated?: boolean;
  /** The reply was cut by the output limit while the model had only reasoned: none of the answer was written. */
  reasoningOnly?: boolean;
  /** The request already asked for the model's own maximum output: asking for more cannot help. */
  limitReached?: boolean;
  /** The provider's `Retry-After` on a 429 or 503, in milliseconds (at most five minutes). */
  retryAfterMs?: number;
  /** The failure depends on the moment (rate limit, overload, network): waiting and repeating may succeed. */
  transient?: boolean;
  /** The request ran out of time. */
  timedOut?: boolean;
  /** Which deadline ran out, for a request that timed out. */
  timeout?: AiTimeoutDetails;
  /**
   * Every candidate of the route of the call that failed, in the order the author wrote it: the ones that were asked and how each ended, the ones that were left out and why. Set by the engine's client
   * on the error it ends with, so that a host does not take the last candidate for the only one.
   */
  route?: AiRouteStep[];
}

/** The most characters of a reply that stopped halfway that an error keeps (`AiProviderErrorDetails.partialText`). */
export const MAX_PARTIAL_CHARACTERS = 200_000;

export class AiProviderError extends Error {
  target?: AiErrorTarget;
  transport?: AiTransportDiagnostics;
  partialText?: string;
  usage?: AiUsage;
  usageKnown?: boolean;
  cost?: number;
  costKnown?: boolean;
  currency?: string;
  model?: string;
  provider?: string;
  integrationId?: string;
  truncated?: boolean;
  reasoningOnly?: boolean;
  limitReached?: boolean;
  retryAfterMs?: number;
  transient?: boolean;
  timedOut?: boolean;
  timeout?: AiTimeoutDetails;
  route?: AiRouteStep[];

  constructor(message: string, readonly status?: number, readonly retryable = false, details: AiProviderErrorDetails = {}) {
    super(message);
    this.name = "AiProviderError";
    Object.assign(this, details);
  }
}

/** How a reply that was being streamed stopped: the connection was lost (`lost`), the provider closed the stream too early (`ended`), reported a failure inside it (`provider-error`) or ended it with an abort (`provider-abort`). */
export type AiStreamInterruption = "lost" | "ended" | "provider-error" | "provider-abort";

/**
 * A reply that was being streamed stopped before it was complete: the connection was lost, the provider closed the stream early, reported a failure inside it or ended it with an abort.
 * The provider had accepted the request and was answering, so a stream that stops is a failure of the moment: it is always retryable and `transient`, and the run repeats the
 * step as it repeats any transient failure. What had arrived is not thrown away: `partialText` and `transport` say where it stopped. The engine never applies a reply that stopped halfway.
 */
export class AiStreamInterruptedError extends AiProviderError {
  constructor(message: string, readonly how: AiStreamInterruption, status?: number, details: AiProviderErrorDetails = {}) {
    super(message, status, true, { ...details, transient: true });
    this.name = "AiStreamInterruptedError";
  }
}

/**
 * The provider answered, but the reply cannot be used (missing fields, not JSON, empty prose...).
 * Always retryable: the retried request carries the reason, never the rejected reply.
 */
export class AiReplyRejectedError extends AiProviderError {
  constructor(message: string, details: AiProviderErrorDetails = {}) {
    super(message, undefined, true, details);
    this.name = "AiReplyRejectedError";
  }
}

/** No candidate's context window holds the prompt: nothing was sent, and the same request would end the same way. */
export class AiPromptTooLargeError extends AiProviderError {
  constructor(message: string, readonly estimatedTokens: number, readonly largestBudget: number) {
    super(message, undefined, false);
    this.name = "AiPromptTooLargeError";
  }
}

/** The routing limits (token attempts, estimated cost) leave no candidate to call, not even the first. */
export class AiRoutingBudgetError extends AiProviderError {
  constructor(message: string) {
    super(message, undefined, false);
    this.name = "AiRoutingBudgetError";
  }
}

/** The privacy policy for fallbacks left no candidate to call. */
export class AiFallbackBlockedError extends AiProviderError {
  constructor(message: string) {
    super(message, undefined, false);
    this.name = "AiFallbackBlockedError";
  }
}

/** A model that "Tools only" left out: its name, and the id of the integration it belongs to (two integrations may have models of the same name). */
export interface AiSkippedModel {
  integration: string;
  model: string;
}

/**
 * "Tools only" is on and no model of the route can call a function, so a structured request has nowhere to go: nothing was sent, and the same
 * configuration would end the same way. `models` are the names of the models that were left out, and `skippedModels` the same with the integration
 * of each (empty from a host that made the error without them). The message names them and says the two ways out.
 */
export class AiToolsRequiredError extends AiProviderError {
  constructor(message: string, readonly models: string[] = [], readonly skippedModels: AiSkippedModel[] = []) {
    super(message, undefined, false);
    this.name = "AiToolsRequiredError";
  }
}

/** Router capabilities used by the autopilot and the director. Missing routes fall back to `default` models. */
export const AI_CAPABILITIES = {
  writer: "autopilot",
  director: "director",
  reader: "reader-evaluation",
  readerSummary: "reader-evaluation-summary",
  specialist: "review",
  summary: "simple-tasks",
} as const;
