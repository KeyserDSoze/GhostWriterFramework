import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings, type ChatModel } from "@/types/settings";
import type { ProviderEndpoint } from "./fakeProvider";

export const SCHEMA = { name: "result", description: "A result", parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } };
export const PRICE = { inputPerMTok: 2, cachedPerMTok: 1, outputPerMTok: 8 };
/** In the settings, and in no request: it belongs to no AI provider. */
export const GITHUB_TOKEN = "ghp_NotForAnyProvider0123456789abcdefgh";

export interface Fixture {
  integration: AIIntegration;
  endpoint: ProviderEndpoint;
}

export const chatModel = (name: string, extra: Partial<ChatModel> = {}): ChatModel => ({ id: `id-${name}`, name, capabilities: ["default"], pricing: PRICE, ...extra });

/** An OpenAI-compatible integration whose host is its id, `https://<id>.example.test/v1`, with a key of its own. */
export function compatible(id: string, models: ChatModel[] = [chatModel(`model-${id}`)], extra: Partial<AIIntegration> = {}): Fixture {
  const apiKey = `sk-${id}-0123456789abcdef`;
  const base = `https://${id}.example.test/v1`;
  return {
    integration: { id, name: id.toUpperCase(), provider: "openai", endpoint: base, apiKey, chatModels: models, ...extra },
    endpoint: { id, apiKey, base, auth: "bearer" },
  };
}

export function settingsOf(fixtures: Fixture[], extra: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, aiIntegrations: fixtures.map((fixture) => fixture.integration), costCurrency: "EUR", defaultGitHubToken: GITHUB_TOKEN, ...extra };
}

/** An explicit route for the autopilot: the first integration is the primary, the others its fallbacks in order. */
export function routed(fixtures: Fixture[], extra: Partial<AppSettings> = {}): AppSettings {
  const [primary, ...fallbacks] = fixtures;
  const target = (fixture: Fixture) => ({ integrationId: fixture.integration.id, model: fixture.integration.chatModels![0].name });
  return settingsOf(fixtures, { taskRouting: { autopilot: { primary: target(primary), fallbacks: fallbacks.map(target) } }, ...extra });
}

export const endpointsOf = (fixtures: Fixture[]) => fixtures.map((fixture) => fixture.endpoint);
