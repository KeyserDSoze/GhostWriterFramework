import { normalizeApiProtocol, normalizeEndpointUrl, normalizePromptCaching, normalizeReasoningParameter, normalizeThinking, type AiChatModelConfig, type AiNoThinkingWithTools, type AiPromptCaching, type AiIntegrationConfig, type AiPricingConfig, type AiReasoningParameter, type AiRouteTarget, type AiRuntimeConfig, type AiTaskRoute, type AiThinking } from "./config.js";
import { AI_CAPABILITY_FOLLOWS, type AiUnusableWhy } from "./types.js";

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
  /** The model refuses thinking when the request carries tools, and how it is asked then (see `AiChatModelConfig.noThinkingWithTools`): configured, or learned by a call of this host. */
  noThinkingWithTools?: AiNoThinkingWithTools;
  /** Whether the model caches the start of its prompts (see `AiChatModelConfig.promptCaching`): declared, or learned by a call of this host; absent: unknown. */
  promptCaching?: Exclude<AiPromptCaching, "unknown">;
  /** The provider refused the cache hints for this model, as far as this host has learned (`AiModelMemory`): none is sent again. */
  promptCacheHintsRefused?: boolean;
  /** The model's own API version (see `AiChatModelConfig.apiVersion`); absent: its integration's. `effectiveApiVersion(candidate.integration, candidate)` says which is used. */
  apiVersion?: string;
  /** The model is asked through the Responses API (see `AiChatModelConfig.apiProtocol`); absent: Chat Completions. */
  apiProtocol?: "responses";
  /** The address the model's requests go to, as it was written (see `AiChatModelConfig.endpointUrl`); absent: the one the engine builds from the integration. */
  endpointUrl?: string;
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

/**
 * The task, then the task it follows (`AI_CAPABILITY_FOLLOWS`): the order in which a task takes a route and a tag. Brainstorming takes its own route, else the
 * Copilot's; a model tagged for it, else one tagged for the Copilot.
 */
function followOrder(capability: string): string[] {
  const follows = Object.prototype.hasOwnProperty.call(AI_CAPABILITY_FOLLOWS, capability) ? AI_CAPABILITY_FOLLOWS[capability] : undefined;
  return follows === undefined ? [capability] : [capability, follows];
}

function supports(model: AiChatModelConfig, capability: string): boolean {
  return [...followOrder(capability), "default"].some((tag) => model.capabilities.includes(tag));
}

/** The route a task has, or, while it has none, the route of the task it follows. */
function routeOf(config: AiRuntimeConfig, capability: string): AiTaskRoute | undefined {
  const written = (route: AiTaskRoute | undefined) => Boolean(route && (route.primary || route.fallbacks?.length));
  return followOrder(capability).map((task) => config.taskRouting?.[task]).find(written) ?? config.taskRouting?.[capability];
}

function candidate(integration: AiIntegrationConfig, model: AiChatModelConfig, target?: AiRouteTarget): AiCandidate {
  const thinking = normalizeThinking(target?.thinking) ?? normalizeThinking(integration.thinking);
  const reasoningParameter = normalizeReasoningParameter(model.reasoningParameter);
  const apiVersion = typeof model.apiVersion === "string" ? model.apiVersion.trim() : "";
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
    ...(model.noThinkingWithTools === true || model.noThinkingWithTools === "none" ? { noThinkingWithTools: model.noThinkingWithTools } : {}),
    ...(normalizePromptCaching(model.promptCaching) ? { promptCaching: normalizePromptCaching(model.promptCaching) } : {}),
    ...(apiVersion ? { apiVersion } : {}),
    ...(normalizeApiProtocol(model.apiProtocol) ? { apiProtocol: "responses" as const } : {}),
    ...(normalizeEndpointUrl(model.endpointUrl) ? { endpointUrl: normalizeEndpointUrl(model.endpointUrl) } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

/** What a target the author wrote is: a candidate that can be called, or the reason why it cannot (its integration is gone, its provider cannot chat here, its model is not in the integration, the model is not allowed the task). */
function resolveTarget(config: AiRuntimeConfig, target: AiRouteTarget, capability: string): { candidate: AiCandidate } | { unusable: AiUnusableWhy } {
  const integration = config.aiIntegrations.find((entry) => entry.id === target.integrationId);
  if (!integration) return { unusable: "integration-missing" };
  if (integration.provider === "m365_copilot") return { unusable: "provider-unsupported" };
  const model = integrationChatModels(integration).find((entry) => entry.name === target.model.trim());
  if (!model) return { unusable: "model-missing" };
  if (!supports(model, capability)) return { unusable: "task-not-allowed" };
  return { candidate: candidate(integration, model, target) };
}

function writingIntegration(config: AiRuntimeConfig): AiIntegrationConfig | undefined {
  const integrations = config.aiIntegrations;
  const routed = config.taskRouting?.default?.primary?.integrationId;
  return integrations.find((entry) => entry.id === routed)
    ?? integrations.find((entry) => entry.id === config.defaultWritingIntegrationId)
    ?? integrations[0];
}

/** The model of an integration for a task: the first tagged for it, else for the task it follows, else the first `default` one. */
function pick(integration: AiIntegrationConfig, capability: string): AiChatModelConfig | undefined {
  const models = integrationChatModels(integration);
  for (const tag of [...followOrder(capability), "default"]) {
    const model = models.find((entry) => entry.capabilities.includes(tag));
    if (model) return model;
  }
  return undefined;
}

/** One place of the route of a task: the candidate that stands in it, or the target of the author that cannot be called and why. */
export interface AiRouteEntry {
  /** The place in the route as the author wrote it: the primary is 0, then the fallbacks in order. A task with no route written has the order the router chose. */
  position: number;
  candidate?: AiCandidate;
  /** The target as the author wrote it, for a route that is written. */
  target?: AiRouteTarget;
  unusable?: AiUnusableWhy;
}

/**
 * The route of a task place by place, with the rules of the web app's router: an explicit route (primary + fallbacks) is used alone, and a target of it that cannot
 * be called keeps its place with the reason (`unusable`), so that the one that is called instead is never taken for the primary; a task with no route of its own that
 * follows another (`AI_CAPABILITY_FOLLOWS`: Brainstorming the Copilot) uses the route of that one; otherwise models tagged with the capability, then those tagged with
 * the one it follows, then the default writing integration, then any `default` model. At most `maxCandidates` candidates (the same one twice counts once), and the entries
 * that cannot be called do not count.
 */
export function describeAiRoute(config: AiRuntimeConfig, capability: string): AiRouteEntry[] {
  const limit = Math.max(1, Math.min(8, config.routingExecution?.maxCandidates ?? config.maxCandidates ?? 4));
  const route = routeOf(config, capability);
  const seen = new Set<string>();
  const entries: AiRouteEntry[] = [];
  let usable = 0;
  const push = (position: number, entry: AiCandidate | null, target?: AiRouteTarget) => {
    if (!entry || entry.integration.provider === "m365_copilot") return;
    const key = `${entry.integration.id}::${entry.model}`;
    if (seen.has(key) || usable >= limit) return;
    seen.add(key);
    usable += 1;
    entries.push({ position, candidate: entry, ...(target ? { target } : {}) });
  };
  if (route && (route.primary || route.fallbacks?.length)) {
    [...(route.primary ? [route.primary] : []), ...(route.fallbacks ?? [])].forEach((target, position) => {
      const found = resolveTarget(config, target, capability);
      if ("unusable" in found) entries.push({ position, target, unusable: found.unusable });
      else push(position, found.candidate, target);
    });
    return entries;
  }
  const chosen: AiCandidate[] = [];
  const add = (entry: AiCandidate | null) => {
    if (!entry || entry.integration.provider === "m365_copilot") return;
    if (chosen.some((other) => other.integration.id === entry.integration.id && other.model === entry.model)) return;
    chosen.push(entry);
  };
  if (capability === "review") {
    const review = config.aiIntegrations.find((entry) => entry.id === config.defaultReviewIntegrationId);
    const model = review ? pick(review, "review") : undefined;
    if (review && model) add(candidate(review, model));
  }
  for (const tag of followOrder(capability)) {
    for (const integration of config.aiIntegrations) {
      const exact = integrationChatModels(integration).find((model) => model.capabilities.includes(tag));
      if (exact) add(candidate(integration, exact));
    }
  }
  const preferred = writingIntegration(config);
  const preferredModel = preferred ? pick(preferred, capability) : undefined;
  if (preferred && preferredModel) add(candidate(preferred, preferredModel));
  for (const integration of config.aiIntegrations) {
    const model = pick(integration, capability);
    if (model) add(candidate(integration, model));
  }
  chosen.slice(0, limit).forEach((entry, position) => entries.push({ position, candidate: entry }));
  return entries;
}

/**
 * Ordered models to try for a capability (`describeAiRoute` without the targets that cannot be called): an explicit route (primary + fallbacks) is used alone, the
 * task's own or, while it has none, the one of the task it follows; otherwise models tagged with the capability (then with the one it follows), then the default writing
 * integration, then any `default` model.
 */
export function resolveAiCandidates(config: AiRuntimeConfig, capability: string): AiCandidate[] {
  return describeAiRoute(config, capability).flatMap((entry) => (entry.candidate ? [entry.candidate] : []));
}

export function hasAiCandidates(config: AiRuntimeConfig, capability: string): boolean {
  return resolveAiCandidates(config, capability).length > 0;
}
