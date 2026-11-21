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
  temperature?: number;
  signal?: AbortSignal;
  /** Receives the cumulative text while a plain-text reply streams. */
  onText?: (text: string) => void;
}

export interface AiResponse {
  text: string;
  json?: unknown;
  usage?: AiUsage;
  model?: string;
  provider?: string;
  integrationId?: string;
  cost?: number;
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

/** What a failed attempt already cost: the provider may bill a reply the engine rejects. */
export interface AiProviderErrorDetails {
  usage?: AiUsage;
  cost?: number;
  currency?: string;
  model?: string;
  provider?: string;
  integrationId?: string;
  /** The provider stopped because of the output token limit. */
  truncated?: boolean;
}

export class AiProviderError extends Error {
  usage?: AiUsage;
  cost?: number;
  currency?: string;
  model?: string;
  provider?: string;
  integrationId?: string;
  truncated?: boolean;

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

/** Router capabilities used by the autopilot and the director. Missing routes fall back to `default` models. */
export const AI_CAPABILITIES = {
  writer: "autopilot",
  director: "director",
  reader: "reader-evaluation",
  readerSummary: "reader-evaluation-summary",
  specialist: "review",
  summary: "simple-tasks",
} as const;
