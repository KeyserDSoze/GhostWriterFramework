import { AzureOpenAI } from "openai";
import type { AzureOpenAIConfig } from "@/types/settings";
import { beginAccountScopedAiOperation } from "@/assistant/accountScopedOperation";
import { currentRequest, untrustedData } from "@/assistant/promptTrust";

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
  input: {
    trustedInstruction: string;
    request: string;
    untrustedPayload: string;
    payloadKind?: Parameters<typeof untrustedData>[0];
    signal?: AbortSignal;
    accountScope: string | null;
  },
): Promise<string> {
  const operation = beginAccountScopedAiOperation(input.signal, input.accountScope);
  operation.signal.throwIfAborted();
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: input.trustedInstruction },
        { role: "user", content: `${currentRequest(input.request)}\n\n${untrustedData(input.payloadKind ?? "external_content", input.untrustedPayload)}` },
      ],
    }, { signal: operation.signal });
    return response.choices[0]?.message.content ?? "";
  } finally {
    operation.dispose();
  }
}
