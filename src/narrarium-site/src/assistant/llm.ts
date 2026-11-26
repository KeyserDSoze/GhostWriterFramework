import { CAPABILITY_FOLLOWS, type AIIntegration, type AppSettings, type ChatCapability, type ChatModel } from "@/types/settings";

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string };

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | LlmContentPart[];
}

export interface LlmRunMetadata {
  requestId: string;
  task: ChatCapability;
  provider: AIIntegration["provider"];
  integrationId: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost?: number;
  currency?: string;
}

export interface LlmResult<T> {
  output: T;
  metadata: LlmRunMetadata;
}

export interface ForcedToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const CONFIRMATION_TOOL_DEFINITION: ForcedToolDefinition = {
  name: "confirm",
  description: "Report whether the user is confirming, rejecting, or being unclear.",
  parameters: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["yes", "no", "unclear"], description: "yes = confirms/accepts, no = rejects/cancels, unclear = neither" },
    },
    required: ["decision"],
  },
};

export function resolveWritingIntegration(settings: AppSettings): AIIntegration | null {
  const integrations = settings.aiIntegrations ?? [];
  if (integrations.length === 0) return null;
  // Honor the configurable router's "default" primary integration when set.
  const routed = settings.taskRouting?.default?.primary?.integrationId;
  if (routed) {
    const match = integrations.find((entry) => entry.id === routed);
    if (match) return match;
  }
  return integrations.find((entry) => entry.id === settings.defaultWritingIntegrationId) ?? integrations[0] ?? null;
}

export function resolveReviewIntegration(settings: AppSettings): AIIntegration | null {
  const integrations = settings.aiIntegrations ?? [];
  if (integrations.length === 0) return null;
  const routed = settings.taskRouting?.review?.primary?.integrationId;
  if (routed) {
    const match = integrations.find((entry) => entry.id === routed);
    if (match) return match;
  }
  return integrations.find((entry) => entry.id === settings.defaultReviewIntegrationId) ?? integrations[0] ?? null;
}

/** All chat models declared by an integration (new field), tolerant of the legacy shape. */
export function integrationChatModels(integration: AIIntegration): ChatModel[] {
  if (Array.isArray(integration.chatModels) && integration.chatModels.length) return integration.chatModels;
  // Legacy fallback: synthesise from the old single fields.
  const models: ChatModel[] = [];
  if (integration.modelWriting) models.push({ id: "legacy-writing", name: integration.modelWriting, capabilities: ["default", "copilot"] });
  if (integration.modelReview && integration.modelReview !== integration.modelWriting) {
    models.push({ id: "legacy-review", name: integration.modelReview, capabilities: ["review"] });
  }
  return models;
}

/**
 * The task, then the task it follows (`CAPABILITY_FOLLOWS`): the order in which a task takes a route and a tag, as in the engine. Brainstorming takes its own route,
 * else the Copilot's; a model tagged for it, else one tagged for the Copilot.
 */
export function followOrder(capability: ChatCapability): ChatCapability[] {
  const follows = Object.prototype.hasOwnProperty.call(CAPABILITY_FOLLOWS, capability) ? CAPABILITY_FOLLOWS[capability] : undefined;
  return follows ? [capability, follows] : [capability];
}

/** The model of a list for a task: the first tagged for it, else for the task it follows, else the first `default` one. */
export function pickModelFor(models: readonly ChatModel[], capability: ChatCapability): ChatModel | undefined {
  for (const tag of [...followOrder(capability), "default" as const]) {
    const model = models.find((entry) => entry.capabilities?.includes(tag));
    if (model) return model;
  }
  return undefined;
}

export function modelSupportsCapability(model: ChatModel, capability: ChatCapability): boolean {
  return [...followOrder(capability), "default" as const].some((tag) => Boolean(model.capabilities?.includes(tag)));
}

export interface LlmUsageReport {
  model: string;
  provider: AIIntegration["provider"];
  integrationId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost?: number;
}

/**
 * How one provider attempt ended, reported only to callers that ask for it (the autopilot):
 * the finish reason, how much reply text arrived and how many reasoning characters preceded it.
 * The reasoning itself is never kept.
 */
export interface LlmFinishReport extends LlmUsageReport {
  finishReason: string;
  replyCharacters: number;
  reasoningCharacters: number;
}
