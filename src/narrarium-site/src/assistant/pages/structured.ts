import { z } from "zod";
import { completeTextRouted, completeToolRouted } from "@/assistant/router";
import { routeCallsTools } from "@/assistant/copilotLoop";
import { currentRequest, untrustedData } from "@/assistant/promptTrust";
import { parseStructuredOutput } from "@/assistant/structuredOutput";
import type { LlmMessage } from "@/assistant/llm";
import type { PageEnv } from "@/assistant/pages/types";
import type { ChatCapability } from "@/types/settings";

/**
 * A call of the model that must give one JSON object, for the tools of the pages: a forced function for a route that calls tools (the engine's client, with what
 * a refusal teaches), the JSON in the text otherwise. A reply that does not match the schema, or that `check` refuses, is sent to the next candidate of the route.
 */
export async function structuredCall<T>(env: Pick<PageEnv, "settings" | "accountScope" | "signal">, input: { messages: LlmMessage[]; name: string; description: string; parameters: Record<string, unknown>; schema: z.ZodType<T>; check?: (value: T) => string[]; label: string; capability?: ChatCapability }): Promise<T> {
  const capability = input.capability ?? "copilot";
  const validate = (value: unknown): T => {
    const parsed = input.schema.safeParse(value);
    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; "));
    const problems = input.check?.(parsed.data) ?? [];
    if (problems.length) throw new Error(problems.join("; "));
    return parsed.data;
  };
  if (routeCallsTools(env.settings)) {
    const result = await completeToolRouted<T>(env.settings, input.messages, capability, { name: input.name, description: input.description, parameters: input.parameters }, { accountScope: env.accountScope, signal: env.signal, label: input.label, validate });
    return result.output;
  }
  const json = `Return ONLY one JSON object with this shape (no Markdown): ${JSON.stringify(input.parameters)}`;
  const messages = input.messages.map((message, index) => (index === 0 && message.role === "system" ? { ...message, content: `${String(message.content)}\n\n${json}` } : message));
  const raw = await completeTextRouted(env.settings, messages, capability, { accountScope: env.accountScope, signal: env.signal, label: input.label, validateText: (text) => { validate(parseStructuredOutput(text, z.unknown() as z.ZodType<unknown>)); } });
  return validate(parseStructuredOutput(raw, z.unknown() as z.ZodType<unknown>));
}

/** The messages of a call about a page: what it is for, then the author's request and what the page holds, as data. */
export function pageMessages(system: string, prompt: string, data: string, dataNote: string): LlmMessage[] {
  return [
    { role: "system", content: system },
    { role: "user", content: [currentRequest(prompt), untrustedData("repository_content", data, dataNote)].join("\n\n") },
  ];
}
