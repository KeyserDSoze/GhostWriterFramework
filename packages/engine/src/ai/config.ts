export type AiProviderKind = "azure_openai" | "openai" | "github_models" | "m365_copilot";

/**
 * How a model is asked without thinking when the request carries function tools (`AiChatModelConfig.noThinkingWithTools`): `true` leaves the level out of the request (a model of the GPT-5.6 family still
 * reasons then), `"none"` sends `reasoning_effort: "none"` (the GPT-6 models that take function tools on Chat Completions refuse a request that leaves the level out, and take `none`).
 */
export type AiNoThinkingWithTools = true | "none";

/** The Azure OpenAI API version used when an integration does not name one. */
export const DEFAULT_AZURE_API_VERSION = "2024-10-21";

/** Whether an endpoint is the v1 API of Azure OpenAI (`https://<resource>.openai.azure.com/openai/v1`), which takes no `api-version` in its address. */
export function isAzureV1Endpoint(endpoint: string | undefined): boolean {
  return /\/openai\/v1$/i.test((endpoint ?? "").trim().replace(/\/+$/, ""));
}

/**
 * The API version a request to a model is sent with, and the one place that says it (the client, the diagnostics, the editor and the configuration of a personal server all ask here): the
 * model's own (`AiChatModelConfig.apiVersion`), else its integration's, else `DEFAULT_AZURE_API_VERSION`. `v1` for the v1 API of Azure OpenAI, which has none in its address, and
 * `undefined` for a provider that has no API version. Whitespace is no version: an empty field inherits. `model` is the model's entry, or a candidate that carries its `apiVersion`.
 */
export function effectiveApiVersion(integration: Pick<AiIntegrationConfig, "provider" | "endpoint" | "apiVersion">, model?: { apiVersion?: string } | null): string | undefined {
  if (integration.provider !== "azure_openai") return undefined;
  if (isAzureV1Endpoint(integration.endpoint)) return "v1";
  const own = typeof model?.apiVersion === "string" ? model.apiVersion.trim() : "";
  const inherited = typeof integration.apiVersion === "string" ? integration.apiVersion.trim() : "";
  return own || inherited || DEFAULT_AZURE_API_VERSION;
}

export interface AiPricingConfig {
  inputPerMTok?: number;
  cachedPerMTok?: number;
  outputPerMTok?: number;
}

export interface AiChatModelConfig {
  id: string;
  name: string;
  underlyingModel?: string;
  capabilities: string[];
  /** The model can be asked to answer through a function. Only `false` has an effect: with "Tools only" on, a structured request skips the model. */
  supportsToolCalls?: boolean;
  /** The model streams its replies. Only `false` has an effect: the model is then called without `stream`, whatever the integration's `streamMode` says. */
  supportsStreaming?: boolean;
  /**
   * The model reasons. `true`: it gets the margin of output for its reasoning (as a model known to reason by its name), a reply cut before it wrote a
   * word is a reply cut while reasoning, and a thinking level may be sent. `false`: a thinking level is not sent to it. The name of a model that is known
   * to reason is not undone by `false`.
   */
  supportsReasoning?: boolean;
  /** The model reads images. Data only: nothing in a request depends on it. */
  supportsVision?: boolean;
  /**
   * How the thinking level reaches this model ("Thinking parameter"): `reasoning_effort` (the OpenAI field; also what an absent value means, and the requests
   * of a model that does not say are exactly the ones they always were), `chat_template_kwargs.reasoning_strength` (the level as an argument of the chat
   * template: Muse Glimmer takes it so, and does not take `reasoning_effort`) or `none` (no level is sent, even when the task or the integration asks for one).
   * `suggestedReasoningParameter` says what the documented sources know of a model name; the engine never applies it by itself.
   */
  reasoningParameter?: AiReasoningParameter;
  /**
   * The model refuses a thinking level when the request carries function tools («Function tools with reasoning_effort are not supported for gpt-6-luna…»): a request with tools is asked without thinking,
   * and a request without tools keeps its level. `true` leaves the level out of the request; `"none"` sends `reasoning_effort: "none"`, for a model that refuses a request with tools that leaves it out
   * (the GPT-6 models that take function tools on Chat Completions do). The author sets it, and the engine learns it from the refusal (`AiModelMemory`) when the provider says so. Any other value is no value.
   */
  noThinkingWithTools?: AiNoThinkingWithTools;
  /**
   * The API version this model's requests carry (Azure OpenAI's `api-version`): each deployment may need its own. Absent or empty: the integration's `apiVersion`, else
   * `DEFAULT_AZURE_API_VERSION`. `effectiveApiVersion` is the one place that says which is used; it only has an effect for an Azure OpenAI integration.
   */
  apiVersion?: string;
  /** The context window of the model: what a prompt and its answer may be together. The engine subtracts the answer and a margin itself. */
  maxInputTokens?: number;
  /** The largest answer that can be asked of the model. */
  maxOutputTokens?: number;
  pricing?: AiPricingConfig;
}

/**
 * Whether requests ask for a streamed reply: `auto` (the default) streams every chat request, the forced function of a structured one
 * included, so that a provider that answers slowly is never silent; `off` never streams, for a provider or a proxy that cannot.
 */
export type AiStreamMode = "auto" | "off";

/**
 * How hard a model is asked to think, per integration and per route target. `low`, `medium`, `high` and `xhigh` are sent to the provider as
 * `reasoning_effort` (or as the argument of the chat template that the model's `reasoningParameter` says); `automatic` sends nothing (the provider's
 * own default), even when the integration sets a level. Absent means nothing was chosen: a route target takes the level of its integration, and an
 * integration without one sends nothing.
 */
export const AI_THINKING_LEVELS = ["automatic", "low", "medium", "high", "xhigh"] as const;
export type AiThinking = (typeof AI_THINKING_LEVELS)[number];

/** A thinking level as the engine keeps it: one of `AI_THINKING_LEVELS`, spelled exactly; anything else is no value. */
export function normalizeThinking(value: unknown): AiThinking | undefined {
  return typeof value === "string" && (AI_THINKING_LEVELS as readonly string[]).includes(value) ? value as AiThinking : undefined;
}

/**
 * How a thinking level reaches a model: the setting of the model (`AiChatModelConfig.reasoningParameter`, "Thinking parameter"). `reasoning_effort` is the
 * OpenAI field, and what is sent when a model says nothing; `chat_template_kwargs.reasoning_strength` sends the level as an argument of the model's chat
 * template (`chat_template_kwargs: { reasoning_strength: <level> }`), which is how Muse Glimmer takes it; `none` sends no level to the model at all.
 */
export const AI_REASONING_PARAMETERS = ["reasoning_effort", "chat_template_kwargs.reasoning_strength", "none"] as const;
export type AiReasoningParameter = (typeof AI_REASONING_PARAMETERS)[number];

/** A thinking parameter as the engine keeps it: one of `AI_REASONING_PARAMETERS`, spelled exactly; anything else is no value. */
export function normalizeReasoningParameter(value: unknown): AiReasoningParameter | undefined {
  return typeof value === "string" && (AI_REASONING_PARAMETERS as readonly string[]).includes(value) ? value as AiReasoningParameter : undefined;
}

/** The longest silence the engine waits for between two pieces of a streamed reply, unless the integration says otherwise. */
export const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
/** An integration's idle timeout is kept within these limits. */
export const MIN_IDLE_TIMEOUT_MS = 30_000;
export const MAX_IDLE_TIMEOUT_MS = 3_600_000;

export interface AiIntegrationConfig {
  id: string;
  name: string;
  provider: AiProviderKind;
  endpoint?: string;
  apiKey: string;
  /** The API version of the integration's models that do not name their own (`AiChatModelConfig.apiVersion`): Azure OpenAI's `api-version`. Absent: `DEFAULT_AZURE_API_VERSION`. */
  apiVersion?: string;
  /**
   * How long the provider has to begin answering (the connection and the headers), as the author wrote it. A call raises a value
   * under `MIN_REQUEST_TIMEOUT_MS` to that minimum and says so; the configuration is never changed.
   */
  requestTimeoutMs?: number;
  /** The longest silence between two pieces of a streamed reply (`DEFAULT_IDLE_TIMEOUT_MS`; kept within 30 s and an hour). */
  idleTimeoutMs?: number;
  /** Absent: `auto`. */
  streamMode?: AiStreamMode;
  /** The thinking level of every model of this integration, unless a route target says another. Absent: none is sent. */
  thinking?: AiThinking;
  chatModels?: AiChatModelConfig[];
  /** @deprecated legacy single-model fields, still honored. */
  modelWriting?: string;
  modelReview?: string;
  pricing?: AiPricingConfig;
}

export interface AiRouteTarget {
  integrationId: string;
  model: string;
  /** The thinking level for this task with this model. Absent: the integration's; `automatic`: none, even when the integration has one. */
  thinking?: AiThinking;
}

export interface AiTaskRoute {
  primary?: AiRouteTarget;
  fallbacks?: AiRouteTarget[];
}

/** Privacy of fallbacks: what may leave the primary integration's account (the boundary is the integration). */
export interface AiFallbackDisclosure {
  /** Never send content to a fallback outside the primary's integration. */
  sameBoundaryOnly: boolean;
  /** Ask the host before sending content to a fallback outside the boundary the content already went to. */
  requireAcknowledgement: boolean;
}

/** Limits of one routed call: candidates tried, time, estimated tokens and estimated cost across attempts. */
export interface AiRoutingExecution {
  maxCandidates: number;
  maxTotalDurationMs: number;
  maxTokenAttempts: number;
  maxEstimatedCost: number;
}

/** The web app's defaults for the routing limits. */
export const DEFAULT_ROUTING_EXECUTION: Readonly<AiRoutingExecution> = Object.freeze({
  maxCandidates: 4,
  maxTotalDurationMs: 180_000,
  maxTokenAttempts: 200_000,
  maxEstimatedCost: 5,
});

/**
 * The subset of the web app's AI router settings needed to run chat tasks.
 * The same JSON is configured in the browser and, with consent, sent to a personal server.
 */
export interface AiRuntimeConfig {
  aiIntegrations: AiIntegrationConfig[];
  taskRouting?: Record<string, AiTaskRoute | undefined>;
  defaultWritingIntegrationId?: string;
  defaultReviewIntegrationId?: string;
  costCurrency?: string;
  maxCandidates?: number;
  /** Absent (a configuration saved before this existed): fallbacks are not restricted. */
  fallbackDisclosure?: AiFallbackDisclosure;
  /** Absent fields are not limited: a call has no total time, token or cost limit. A configuration sent by the web app has them all. */
  routingExecution?: Partial<AiRoutingExecution>;
  /**
   * "Tools only" (the settings call it `aiToolsOnly`): a structured reply must be the call of its function, and a model marked as without tool
   * calls is not used for one. Absent or true: on. False: a model without tool calls gets the schema in the message, and a JSON in the reply's text is read.
   */
  toolsOnly?: boolean;
}

const PROVIDERS: AiProviderKind[] = ["azure_openai", "openai", "github_models", "m365_copilot"];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function streamMode(value: unknown): AiStreamMode | undefined {
  return value === "auto" || value === "off" ? value : undefined;
}

/** An idle timeout as the engine keeps it: a whole number of milliseconds within 30 s and an hour. What is not a number is no value. */
function idleTimeout(value: unknown): number | undefined {
  const milliseconds = positive(value);
  return milliseconds === undefined ? undefined : Math.min(MAX_IDLE_TIMEOUT_MS, Math.max(MIN_IDLE_TIMEOUT_MS, Math.round(milliseconds)));
}

function pricing(value: unknown): AiPricingConfig | undefined {
  const source = record(value);
  const output: AiPricingConfig = {};
  for (const key of ["inputPerMTok", "cachedPerMTok", "outputPerMTok"] as const) {
    const amount = source[key];
    if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) output[key] = amount;
  }
  return Object.keys(output).length ? output : undefined;
}

function target(value: unknown): AiRouteTarget | undefined {
  const source = record(value);
  const integrationId = text(source.integrationId);
  const model = text(source.model);
  const thinking = normalizeThinking(source.thinking);
  return integrationId && model ? { integrationId, model, ...(thinking ? { thinking } : {}) } : undefined;
}

/** The routing limits with the web app's normalization: whole numbers within the same bounds, the same defaults. */
export function normalizeRoutingExecution(raw: unknown): AiRoutingExecution {
  const source = record(raw);
  const bounded = (key: keyof AiRoutingExecution, min: number, max: number): number => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : DEFAULT_ROUTING_EXECUTION[key];
  };
  return {
    maxCandidates: Math.floor(bounded("maxCandidates", 1, 8)),
    maxTotalDurationMs: Math.floor(bounded("maxTotalDurationMs", 1_000, 600_000)),
    maxTokenAttempts: Math.floor(bounded("maxTokenAttempts", 1_000, 2_000_000)),
    maxEstimatedCost: bounded("maxEstimatedCost", 0.01, 1_000),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Extract and sanitize the AI configuration from a web-app settings object (or a server config file). */
export function pickAiRuntimeConfig(settings: unknown): AiRuntimeConfig {
  const source = record(settings);
  const integrations: AiIntegrationConfig[] = [];
  for (const entry of Array.isArray(source.aiIntegrations) ? source.aiIntegrations : []) {
    const item = record(entry);
    const id = text(item.id);
    const provider = PROVIDERS.includes(item.provider as AiProviderKind) ? item.provider as AiProviderKind : undefined;
    if (!id || !provider) continue;
    const chatModels: AiChatModelConfig[] = [];
    for (const modelEntry of Array.isArray(item.chatModels) ? item.chatModels : []) {
      const model = record(modelEntry);
      const name = text(model.name);
      if (!name) continue;
      chatModels.push({
        id: text(model.id) ?? name,
        name,
        underlyingModel: text(model.underlyingModel),
        capabilities: Array.isArray(model.capabilities) ? model.capabilities.filter((capability): capability is string => typeof capability === "string") : [],
        supportsToolCalls: typeof model.supportsToolCalls === "boolean" ? model.supportsToolCalls : undefined,
        ...(typeof model.supportsStreaming === "boolean" ? { supportsStreaming: model.supportsStreaming } : {}),
        ...(typeof model.supportsReasoning === "boolean" ? { supportsReasoning: model.supportsReasoning } : {}),
        ...(typeof model.supportsVision === "boolean" ? { supportsVision: model.supportsVision } : {}),
        ...reasoningParameterOf(model.reasoningParameter),
        ...(model.noThinkingWithTools === true || model.noThinkingWithTools === "none" ? { noThinkingWithTools: model.noThinkingWithTools } : {}),
        ...(text(model.apiVersion) ? { apiVersion: text(model.apiVersion) } : {}),
        maxInputTokens: positive(model.maxInputTokens),
        maxOutputTokens: positive(model.maxOutputTokens),
        pricing: pricing(model.pricing),
      });
    }
    const idleTimeoutMs = idleTimeout(item.idleTimeoutMs);
    const mode = streamMode(item.streamMode);
    const thinking = normalizeThinking(item.thinking);
    integrations.push({
      id,
      name: text(item.name) ?? provider,
      provider,
      endpoint: text(item.endpoint),
      apiKey: typeof item.apiKey === "string" ? item.apiKey.trim() : "",
      apiVersion: text(item.apiVersion),
      requestTimeoutMs: positive(item.requestTimeoutMs),
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      ...(mode ? { streamMode: mode } : {}),
      ...(thinking ? { thinking } : {}),
      chatModels,
      modelWriting: text(item.modelWriting),
      modelReview: text(item.modelReview),
      pricing: pricing(item.pricing),
    });
  }
  const taskRouting: Record<string, AiTaskRoute> = {};
  for (const [task, routeValue] of Object.entries(record(source.taskRouting))) {
    const route = record(routeValue);
    const primary = target(route.primary);
    const fallbacks = (Array.isArray(route.fallbacks) ? route.fallbacks : []).map(target).filter((entry): entry is AiRouteTarget => Boolean(entry));
    if (primary || fallbacks.length) taskRouting[task] = { primary, fallbacks };
  }
  const routingExecution = isObject(source.routingExecution) ? normalizeRoutingExecution(source.routingExecution) : undefined;
  const disclosure = isObject(source.fallbackDisclosure) ? source.fallbackDisclosure : undefined;
  // The settings say `aiToolsOnly`; a configuration that was already picked (what a personal server stores and reads back) says `toolsOnly`.
  const toolsOnly = typeof source.aiToolsOnly === "boolean" ? source.aiToolsOnly : typeof source.toolsOnly === "boolean" ? source.toolsOnly : undefined;
  return {
    aiIntegrations: integrations,
    taskRouting,
    defaultWritingIntegrationId: text(source.defaultWritingIntegrationId),
    defaultReviewIntegrationId: text(source.defaultReviewIntegrationId),
    costCurrency: text(source.costCurrency),
    maxCandidates: routingExecution?.maxCandidates ?? positive(source.maxCandidates),
    ...(disclosure ? { fallbackDisclosure: { sameBoundaryOnly: disclosure.sameBoundaryOnly === true, requireAcknowledgement: disclosure.requireAcknowledgement === true } } : {}),
    ...(routingExecution ? { routingExecution } : {}),
    ...(toolsOnly !== undefined ? { toolsOnly } : {}),
  };
}

export interface RedactedAiIntegration {
  id: string;
  name: string;
  provider: AiProviderKind;
  endpoint?: string;
  hasApiKey: boolean;
  /** The longest silence between two pieces of a streamed reply, when the integration sets one. */
  idleTimeoutMs?: number;
  /** Whether replies stream, when the integration says (absent: `auto`). */
  streamMode?: AiStreamMode;
  /** The thinking level of the integration, when it sets one. */
  thinking?: AiThinking;
  /** The API version of the integration (Azure OpenAI), when it names one: the default of its models that do not name their own. */
  apiVersion?: string;
  models: RedactedAiModel[];
}

/** A model as the safe view shows it: its name and routes, and what its configuration declares of it (only what it declares). */
export interface RedactedAiModel {
  name: string;
  capabilities: string[];
  supportsToolCalls?: boolean;
  supportsStreaming?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  /** How the thinking level reaches the model, when the model says (absent: `reasoning_effort`). */
  reasoningParameter?: AiReasoningParameter;
  /** Whether the model refuses thinking when the request carries tools, and how it is asked then (see `AiChatModelConfig.noThinkingWithTools`); absent: it does not, as far as is known. */
  noThinkingWithTools?: AiNoThinkingWithTools;
  /** The API version of the model, when it names its own (Azure OpenAI): absent, it takes the integration's. */
  apiVersion?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

/** A route target as the safe view shows it: which model of which integration, and its thinking level when it sets one. */
export interface RedactedAiRouteTarget {
  integrationId: string;
  model: string;
  thinking?: AiThinking;
}

export interface RedactedAiTaskRoute {
  primary?: RedactedAiRouteTarget;
  fallbacks: RedactedAiRouteTarget[];
}

/** What `redactAiRuntimeConfig` says: nothing in it is a secret. */
export interface RedactedAiRuntimeConfig {
  integrations: RedactedAiIntegration[];
  routedTasks: string[];
  /** The route of every routed task (`{}` when none is), primary first, then the fallbacks in order. */
  taskRouting: Record<string, RedactedAiTaskRoute>;
  /** Whether "Tools only" is in force: true unless the configuration turned it off. */
  toolsOnly: boolean;
  fallbackDisclosure?: AiFallbackDisclosure;
  routingExecution?: Partial<AiRoutingExecution>;
}

/** The field for a model that says how its thinking level is sent, and nothing for one that does not (or whose word is not one of the three). */
function reasoningParameterOf(value: unknown): { reasoningParameter?: AiReasoningParameter } {
  const parameter = normalizeReasoningParameter(value);
  return parameter ? { reasoningParameter: parameter } : {};
}

function redactedModel(model: AiChatModelConfig): RedactedAiModel {
  const flag = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
  const supportsToolCalls = flag(model.supportsToolCalls);
  const supportsStreaming = flag(model.supportsStreaming);
  const supportsReasoning = flag(model.supportsReasoning);
  const supportsVision = flag(model.supportsVision);
  const maxInputTokens = positive(model.maxInputTokens);
  const maxOutputTokens = positive(model.maxOutputTokens);
  return {
    name: model.name,
    capabilities: model.capabilities,
    ...(supportsToolCalls !== undefined ? { supportsToolCalls } : {}),
    ...(supportsStreaming !== undefined ? { supportsStreaming } : {}),
    ...(supportsReasoning !== undefined ? { supportsReasoning } : {}),
    ...(supportsVision !== undefined ? { supportsVision } : {}),
    ...reasoningParameterOf(model.reasoningParameter),
    ...(model.noThinkingWithTools === true || model.noThinkingWithTools === "none" ? { noThinkingWithTools: model.noThinkingWithTools } : {}),
    ...(text(model.apiVersion) ? { apiVersion: text(model.apiVersion) } : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

function redactedTarget(entry: AiRouteTarget): RedactedAiRouteTarget {
  const thinking = normalizeThinking(entry.thinking);
  return { integrationId: entry.integrationId, model: entry.model, ...(thinking ? { thinking } : {}) };
}

/** Safe view of a configuration: never exposes API keys. */
export function redactAiRuntimeConfig(config: AiRuntimeConfig): RedactedAiRuntimeConfig {
  const taskRouting: Record<string, RedactedAiTaskRoute> = {};
  for (const [task, route] of Object.entries(config.taskRouting ?? {})) {
    if (!route || (!route.primary && !route.fallbacks?.length)) continue;
    taskRouting[task] = { ...(route.primary ? { primary: redactedTarget(route.primary) } : {}), fallbacks: (route.fallbacks ?? []).map(redactedTarget) };
  }
  return {
    integrations: config.aiIntegrations.map((integration) => {
      const thinking = normalizeThinking(integration.thinking);
      return {
        id: integration.id,
        name: integration.name,
        provider: integration.provider,
        endpoint: integration.endpoint,
        hasApiKey: Boolean(integration.apiKey),
        ...(integration.idleTimeoutMs !== undefined ? { idleTimeoutMs: integration.idleTimeoutMs } : {}),
        ...(integration.streamMode ? { streamMode: integration.streamMode } : {}),
        ...(thinking ? { thinking } : {}),
        ...(text(integration.apiVersion) ? { apiVersion: text(integration.apiVersion) } : {}),
        models: (integration.chatModels ?? []).map(redactedModel),
      };
    }),
    routedTasks: Object.keys(config.taskRouting ?? {}).sort(),
    taskRouting,
    toolsOnly: config.toolsOnly !== false,
    ...(config.fallbackDisclosure ? { fallbackDisclosure: config.fallbackDisclosure } : {}),
    ...(config.routingExecution ? { routingExecution: config.routingExecution } : {}),
  };
}
