import OpenAI, { AzureOpenAI } from "openai";
import type { AIIntegration, AppSettings } from "@/types/settings";
import { chatDelta, useCostsStore } from "@/costs/costsStore";

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string };

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | LlmContentPart[];
}

export function resolveWritingIntegration(settings: AppSettings): AIIntegration | null {
  const integrations = settings.aiIntegrations ?? [];
  if (integrations.length === 0) return null;
  return integrations.find((entry) => entry.id === settings.defaultWritingIntegrationId) ?? integrations[0] ?? null;
}

export function resolveReviewIntegration(settings: AppSettings): AIIntegration | null {
  const integrations = settings.aiIntegrations ?? [];
  if (integrations.length === 0) return null;
  return integrations.find((entry) => entry.id === settings.defaultReviewIntegrationId) ?? integrations[0] ?? null;
}

export async function completeText(
  integration: AIIntegration,
  messages: LlmMessage[],
  purpose: "writing" | "review" = "writing",
  options?: { signal?: AbortSignal },
): Promise<string> {
  const model = purpose === "review"
    ? integration.modelReview || integration.modelWriting || "gpt-4o"
    : integration.modelWriting || integration.modelReview || "gpt-4o";

  const normalizedMessages = messages.map((message) => ({
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : { type: "image_url", image_url: { url: part.dataUrl } },
        )
      : message.content,
  }));

  if (integration.provider === "azure_openai") {
    const client = new AzureOpenAI({
      endpoint: integration.endpoint ?? "",
      apiKey: integration.apiKey,
      apiVersion: integration.apiVersion || "2024-10-21",
      dangerouslyAllowBrowser: true,
    });
    const response = await client.chat.completions.create({ model, messages: normalizedMessages as never }, { signal: options?.signal });
    recordChatUsage(integration, response.usage);
    return response.choices[0]?.message?.content ?? "";
  }

  if (integration.provider === "openai") {
    const client = new OpenAI({
      apiKey: integration.apiKey,
      baseURL: integration.endpoint || "https://api.openai.com/v1",
      dangerouslyAllowBrowser: true,
    });
    const response = await client.chat.completions.create({ model, messages: normalizedMessages as never }, { signal: options?.signal });
    recordChatUsage(integration, response.usage);
    return response.choices[0]?.message?.content ?? "";
  }

  throw new Error("Microsoft 365 Copilot is not yet wired into the in-browser assistant.");
}

function recordChatUsage(integration: AIIntegration, usage: unknown): void {
  if (!integration.pricing) return;
  const u = usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
  if (!u) return;
  const inputTokens = u.prompt_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? 0;
  const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
  if (!inputTokens && !outputTokens) return;
  useCostsStore.getState().recordCurrent(chatDelta({ inputTokens, cachedTokens, outputTokens }, integration.pricing));
}
