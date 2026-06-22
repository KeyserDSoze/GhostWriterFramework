import OpenAI, { AzureOpenAI } from "openai";
import type { AIIntegration, AppSettings } from "@/types/settings";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
): Promise<string> {
  const model = purpose === "review"
    ? integration.modelReview || integration.modelWriting || "gpt-4o"
    : integration.modelWriting || integration.modelReview || "gpt-4o";

  if (integration.provider === "azure_openai") {
    const client = new AzureOpenAI({
      endpoint: integration.endpoint ?? "",
      apiKey: integration.apiKey,
      apiVersion: integration.apiVersion || "2024-10-21",
      dangerouslyAllowBrowser: true,
    });
    const response = await client.chat.completions.create({ model, messages });
    return response.choices[0]?.message?.content ?? "";
  }

  if (integration.provider === "openai") {
    const client = new OpenAI({
      apiKey: integration.apiKey,
      baseURL: integration.endpoint || "https://api.openai.com/v1",
      dangerouslyAllowBrowser: true,
    });
    const response = await client.chat.completions.create({ model, messages });
    return response.choices[0]?.message?.content ?? "";
  }

  throw new Error("Microsoft 365 Copilot is not yet wired into the in-browser assistant.");
}
