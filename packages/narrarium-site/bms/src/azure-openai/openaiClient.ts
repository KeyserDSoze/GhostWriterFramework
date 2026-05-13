import { AzureOpenAI } from "openai";
import type { AzureOpenAIConfig } from "@/types/settings";

/**
 * Create an AzureOpenAI client from the stored settings.
 * Returns null if the endpoint or apiKey are not yet configured.
 */
export function createOpenAIClient(
  config: AzureOpenAIConfig,
): AzureOpenAI | null {
  if (!config.endpoint || !config.apiKey) return null;
  return new AzureOpenAI({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    apiVersion: config.apiVersion || "2024-10-21",
    dangerouslyAllowBrowser: true,
  });
}

/** Simple chat completion helper. */
export async function chatComplete(
  client: AzureOpenAI,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });
  return response.choices[0]?.message.content ?? "";
}
