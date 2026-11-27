import { vi } from "vitest";
import { chaptersAnswer } from "./longSynopsisAnswers";

export { chaptersAnswer, readBack } from "./longSynopsisAnswers";

/**
 * A fake OpenAI-compatible provider for the tests of #121: it records every request (the forced function it was asked for, the system and the last user message) and answers
 * `synopsis_chapters` by reading back the chapters it was sent, the way a model would (their titles, summaries and labelled fields). Any other request gets `answer`'s reply, or a
 * plain one. A model without tool calls is answered the same, in the text.
 */

export type ProviderCall = { tool: string; user: string; system: string };

export function stubLongPasteProvider() {
  const provider = { calls: [] as ProviderCall[], fail: new Set<number>(), failHosts: new Set<string>(), answer: null as null | ((call: ProviderCall) => unknown) };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
    const text = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "");
    const tool = body.tools?.[0]?.function.name ?? "prose";
    const call = { tool, system: text(body.messages.find((message) => message.role === "system")?.content), user: text([...body.messages].reverse().find((message) => message.role === "user")?.content) };
    provider.calls.push(call);
    // A host that refuses every request (a model that is not there): the router goes on to the next candidate, if the limits let it.
    if (provider.failHosts.has(new URL(String(url)).hostname)) return new Response(JSON.stringify({ error: { message: "The model is not available.", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
    const own = provider.answer?.(call);
    const imported = call.user.includes("Write the entries of chapters") ? chaptersAnswer(call.user, provider.fail) : undefined;
    const answer: unknown = own ?? imported ?? { reply: "Va bene.", calls: [] };
    const message = tool !== "prose"
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool, arguments: JSON.stringify(answer) } }] }
      : { role: "assistant", content: typeof answer === "string" ? answer : JSON.stringify(answer) };
    return new Response(JSON.stringify({ id: "x", object: "chat.completion", model: "big", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, choices: [{ index: 0, finish_reason: tool !== "prose" ? "tool_calls" : "stop", message }] }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return provider;
}
