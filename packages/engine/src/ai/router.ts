import { normalizeReasoningParameter, normalizeThinking, type AiChatModelConfig, type AiIntegrationConfig, type AiPricingConfig, type AiReasoningParameter, type AiRouteTarget, type AiRuntimeConfig, type AiThinking } from "./config.js";

export interface AiCandidate {
  integration: AiIntegrationConfig;
  model: string;
  pricing?: AiPricingConfig;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  underlyingModel?: string;
  supportsToolCalls?: boolean;
  /** What the model's configuration declares (see `AiChatModelConfig`); absent when it does not say. */
  supportsStreaming?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  /** How the model's thinking level is sent (see `AiChatModelConfig.reasoningParameter`); absent when the model does not say: `reasoning_effort`. */
  reasoningParameter?: AiReasoningParameter;
  /**
   * The thinking level for this candidate: its route target's, else its integration's (`automatic` is a choice that sends nothing). Absent when
   * neither says: the request carries no level.
   */
  thinking?: AiThinking;
}

/** Chat models of an integration, tolerant of the legacy single-model fields. */
export function integrationChatModels(integration: AiIntegrationConfig): AiChatModelConfig[] {
  if (integration.chatModels?.length) return integration.chatModels;
  const models: AiChatModelConfig[] = [];
  if (integration.modelWriting) models.push({ id: "legacy-writing", name: integration.modelWriting, capabilities: ["default", "copilot"] });
  if (integration.modelReview && integration.modelReview !== integration.modelWriting) models.push({ id: "legacy-review", name: integration.modelReview, capabilities: ["review"] });
  return models;
}

function supports(model: AiChatModelConfig, capability: string): boolean {
  return model.capabilities.includes(capability) || model.capabilities.includes("default");
}

function candidate(integration: AiIntegrationConfig, model: AiChatModelConfig, target?: AiRouteTarget): AiCandidate {
  const thinking = normalizeThinking(target?.thinking) ?? normalizeThinking(integration.thinking);
  const reasoningParameter = normalizeReasoningParameter(model.reasoningParameter);
  return {
    integration,
    model: model.name,
    pricing: model.pricing ?? integration.pricing,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    underlyingModel: model.underlyingModel,
    supportsToolCalls: model.supportsToolCalls,
    ...(typeof model.supportsStreaming === "boolean" ? { supportsStreaming: model.supportsStreaming } : {}),
    ...(typeof model.supportsReasoning === "boolean" ? { supportsReasoning: model.supportsReasoning } : {}),
    ...(typeof model.supportsVision === "boolean" ? { supportsVision: model.supportsVision } : {}),
    ...(reasoningParameter ? { reasoningParameter } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

function fromTarget(config: AiRuntimeConfig, target: AiRouteTarget, capability: string): AiCandidate | null {
  const integration = config.aiIntegrations.find((entry) => entry.id === target.integrationId);
  if (!integration || integration.provider === "m365_copilot") return null;
  const model = integrationChatModels(integration).find((entry) => entry.name === target.model.trim());
  if (!model || !supports(model, capability)) return null;
  return candidate(integration, model, target);
}

function writingIntegration(config: AiRuntimeConfig): AiIntegrationConfig | undefined {
  const integrations = config.aiIntegrations;
  const routed = config.taskRouting?.default?.primary?.integrationId;
  return integrations.find((entry) => entry.id === routed)
    ?? integrations.find((entry) => entry.id === config.defaultWritingIntegrationId)
    ?? integrations[0];
}

function pick(integration: AiIntegrationConfig, capability: string): AiChatModelConfig | undefined {
  const models = integrationChatModels(integration);
  return models.find((model) => model.capabilities.includes(capability)) ?? models.find((model) => model.capabilities.includes("default"));
}

/**
 * Ordered models to try for a capability, with the same rules as the web app's router:
 * an explicit route (primary + fallbacks) is used alone; otherwise models tagged with the
 * capability, then the default writing integration, then any `default` model.
 */
export function resolveAiCandidates(config: AiRuntimeConfig, capability: string): AiCandidate[] {
  const limit = Math.max(1, Math.min(8, config.routingExecution?.maxCandidates ?? config.maxCandidates ?? 4));
  const route = config.taskRouting?.[capability];
  const seen = new Set<string>();
  const output: AiCandidate[] = [];
  const push = (entry: AiCandidate | null) => {
    if (!entry || entry.integration.provider === "m365_copilot") return;
    const key = `${entry.integration.id}::${entry.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    output.push(entry);
  };
  if (route && (route.primary || route.fallbacks?.length)) {
    for (const target of [...(route.primary ? [route.primary] : []), ...(route.fallbacks ?? [])]) push(fromTarget(config, target, capability));
    return output.slice(0, limit);
  }
  if (capability === "review") {
    const review = config.aiIntegrations.find((entry) => entry.id === config.defaultReviewIntegrationId);
    const model = review ? pick(review, "review") : undefined;
    if (review && model) push(candidate(review, model));
  }
  for (const integration of config.aiIntegrations) {
    const exact = integrationChatModels(integration).find((model) => model.capabilities.includes(capability));
    if (exact) push(candidate(integration, exact));
  }
  const preferred = writingIntegration(config);
  const preferredModel = preferred ? pick(preferred, capability) : undefined;
  if (preferred && preferredModel) push(candidate(preferred, preferredModel));
  for (const integration of config.aiIntegrations) {
    const model = pick(integration, capability);
    if (model) push(candidate(integration, model));
  }
  return output.slice(0, limit);
}

export function hasAiCandidates(config: AiRuntimeConfig, capability: string): boolean {
  return resolveAiCandidates(config, capability).length > 0;
}
