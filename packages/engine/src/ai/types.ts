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

export interface AiRequest {
  /** Router capability, e.g. `autopilot`, `director`, `reader-evaluation`, `review`, `simple-tasks`. */
  capability: string;
  /** Short label shown in logs and debug panels. */
  label: string;
  system: string;
  user: string;
  /** When present the reply must be one JSON object matching this schema (forced tool call when supported). */
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
  constructor(readonly capability: string) {
    super(`No AI model is configured for the "${capability}" task. Configure an integration in the AI router.`);
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
}

/** What a failed attempt already cost: the provider may bill a reply the engine rejects. */
export interface AiProviderErrorDetails {
  /** Where the request went. Set by the engine's client on the errors of the candidates it tried. */
  target?: AiErrorTarget;
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
}

export class AiProviderError extends Error {
  target?: AiErrorTarget;
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

  constructor(message: string, readonly status?: number, readonly retryable = false, details: AiProviderErrorDetails = {}) {
    super(message);
    this.name = "AiProviderError";
    Object.assign(this, details);
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

/** Router capabilities used by the autopilot and the director. Missing routes fall back to `default` models. */
export const AI_CAPABILITIES = {
  writer: "autopilot",
  director: "director",
  reader: "reader-evaluation",
  readerSummary: "reader-evaluation-summary",
  specialist: "review",
  summary: "simple-tasks",
} as const;
