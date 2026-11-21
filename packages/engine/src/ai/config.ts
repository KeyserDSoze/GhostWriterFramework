export type AiProviderKind = "azure_openai" | "openai" | "github_models" | "m365_copilot";

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
  supportsToolCalls?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  pricing?: AiPricingConfig;
}

export interface AiIntegrationConfig {
  id: string;
  name: string;
  provider: AiProviderKind;
  endpoint?: string;
  apiKey: string;
  apiVersion?: string;
  requestTimeoutMs?: number;
  chatModels?: AiChatModelConfig[];
  /** @deprecated legacy single-model fields, still honored. */
  modelWriting?: string;
  modelReview?: string;
  pricing?: AiPricingConfig;
}

export interface AiRouteTarget {
  integrationId: string;
  model: string;
}

export interface AiTaskRoute {
  primary?: AiRouteTarget;
  fallbacks?: AiRouteTarget[];
}

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
  return integrationId && model ? { integrationId, model } : undefined;
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
        maxInputTokens: positive(model.maxInputTokens),
        maxOutputTokens: positive(model.maxOutputTokens),
        pricing: pricing(model.pricing),
      });
    }
    integrations.push({
      id,
      name: text(item.name) ?? provider,
      provider,
      endpoint: text(item.endpoint),
      apiKey: typeof item.apiKey === "string" ? item.apiKey.trim() : "",
      apiVersion: text(item.apiVersion),
      requestTimeoutMs: positive(item.requestTimeoutMs),
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
  const execution = record(source.routingExecution);
  return {
    aiIntegrations: integrations,
    taskRouting,
    defaultWritingIntegrationId: text(source.defaultWritingIntegrationId),
    defaultReviewIntegrationId: text(source.defaultReviewIntegrationId),
    costCurrency: text(source.costCurrency),
    maxCandidates: positive(execution.maxCandidates) ?? positive(source.maxCandidates),
  };
}

export interface RedactedAiIntegration {
  id: string;
  name: string;
  provider: AiProviderKind;
  endpoint?: string;
  hasApiKey: boolean;
  models: Array<{ name: string; capabilities: string[] }>;
}

/** Safe view of a configuration: never exposes API keys. */
export function redactAiRuntimeConfig(config: AiRuntimeConfig): { integrations: RedactedAiIntegration[]; routedTasks: string[] } {
  return {
    integrations: config.aiIntegrations.map((integration) => ({
      id: integration.id,
      name: integration.name,
      provider: integration.provider,
      endpoint: integration.endpoint,
      hasApiKey: Boolean(integration.apiKey),
      models: (integration.chatModels ?? []).map((model) => ({ name: model.name, capabilities: model.capabilities })),
    })),
    routedTasks: Object.keys(config.taskRouting ?? {}).sort(),
  };
}
