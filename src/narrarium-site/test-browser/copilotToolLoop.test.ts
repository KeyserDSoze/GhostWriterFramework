import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAssistantPrompt } from "@/assistant/service";
import { copilotTurnTool, routeCallsTools, runCopilotLoop, turnReplySoFar } from "@/assistant/copilotLoop";
import { toolData } from "@/assistant/scopedTools";
import type { LoadedWriterContext } from "@/assistant/context";
import type { LoadedPage, PageCapability, PageEnv } from "@/assistant/pages/types";
import { DEFAULT_SETTINGS, type AppSettings, type BookEntry, type ChatModel } from "@/types/settings";

// The Copilot's tool loop, with a fake provider behind the real AI router and the engine's client: an OpenAI-compatible endpoint that answers the forced
// function `copilot_turn` with the turns of each test. A model marked as without tool calls never gets the loop: the keyword rules choose for it.

type Turn = { reply?: string; calls?: Array<{ tool: string; args?: unknown }> } | { status: number };
const provider = { turns: [] as Turn[], requests: [] as Array<{ tool?: string; enum?: string[]; system: string; user: string }> };

function stubProvider(): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string; parameters: { properties: { calls: { items: { properties: { tool: { enum: string[] } } } } } } } }> };
    const text = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "");
    const tool = body.tools?.[0]?.function;
    provider.requests.push({ tool: tool?.name, enum: tool?.parameters.properties.calls?.items.properties.tool.enum, system: text(body.messages.find((message) => message.role === "system")?.content), user: text([...body.messages].reverse().find((message) => message.role === "user")?.content) });
    const turn = provider.turns.shift() ?? { reply: "", calls: [] };
    if ("status" in turn) return new Response(JSON.stringify({ error: { message: "Bad request", type: "invalid_request_error" } }), { status: turn.status, headers: { "content-type": "application/json" } });
    const message = tool
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool.name, arguments: JSON.stringify({ reply: turn.reply ?? "", calls: turn.calls ?? [] }) } }] }
      : { role: "assistant", content: turn.reply ?? "" };
    return new Response(JSON.stringify({ id: "x", object: "chat.completion", model: "fake-model", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop", message }] }), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

function settingsWith(model: Partial<ChatModel> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ui: { ...DEFAULT_SETTINGS.ui, language: "en" },
    aiIntegrations: [{ id: "fake", name: "Fake", provider: "openai", endpoint: "https://fake.test/v1", apiKey: "sk-fake-0123456789abcdef", streamMode: "off", chatModels: [{ id: "fake-model", name: "fake-model", capabilities: ["default", "copilot"], supportsToolCalls: true, ...model }] }],
    taskRouting: { copilot: { primary: { integrationId: "fake", model: "fake-model" }, fallbacks: [] } },
  } as AppSettings;
}

const book = { id: "book-1", name: "The Glass Harbor", owner: "local", repo: "book-1", tokenIndex: null, addedAt: "now" } as BookEntry;
const context = {
  route: { kind: "book", bookId: "book-1" }, book, branchReady: true, branch: "main",
  structure: { title: "The Glass Harbor", language: "en", chapters: [], characters: [], locations: [], factions: [], items: [], secrets: [], timelines: [], readerPersonas: [], researchFiles: [], readerEvaluationFiles: [] },
  chapter: null, paragraph: null, title: "The Glass Harbor", summary: "Book context for The Glass Harbor.", relevantFiles: [{ path: "book.md", content: "A harbor town built on glass." }], availableFiles: [], loadedFilePaths: ["book.md"], noteTargetPath: "notes.md",
} as unknown as LoadedWriterContext;

function ask(prompt: string, settings = settingsWith()) {
  return runAssistantPrompt({ prompt, context, settings, book, branch: "main", token: "local", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
}

beforeEach(() => {
  provider.turns = [];
  provider.requests = [];
  stubProvider();
});

afterEach(() => vi.unstubAllGlobals());

describe("the Copilot with a model that calls tools", () => {
  it("answers a question with the turn itself: one forced call of copilot_turn, whose reply is the answer, with the context of the book", async () => {
    provider.turns = [{ reply: "It is about a harbor town built on glass.", calls: [] }];
    const message = await ask("What is this book about?");
    expect(message.text).toBe("It is about a harbor town built on glass.");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].tool).toBe("copilot_turn");
    expect(provider.requests[0].system).toContain("YOUR TOOLS. Every round you call the function copilot_turn once");
    expect(provider.requests[0].user).toContain("A harbor town built on glass.");
    // Every tool of the catalogue that can run is there, but the plain answer, which is the reply.
    expect(provider.requests[0].enum).toContain("open-reader");
    expect(provider.requests[0].enum).not.toContain("answer-from-context");
  });

  it("runs a tool of the catalogue with the author's own words when the model calls it, and its result answers the author", async () => {
    provider.turns = [{ reply: "Opening the reader.", calls: [{ tool: "open-reader" }] }];
    const message = await ask("Show me the book as a reader sees it");
    expect(message.action).toMatchObject({ kind: "navigate", to: "/app/books/book-1/reader" });
    expect(provider.requests).toHaveLength(1);
  });

  it("refuses in code a tool it does not have, and says so", async () => {
    provider.turns = [{ reply: "Deleting everything.", calls: [{ tool: "delete-everything" }] }];
    const message = await ask("Delete everything");
    expect(message.text).toContain("Deleting everything.");
    expect(message.text).toContain("There is no «delete-everything»: nothing of it was run.");
  });

  it("goes back to the keyword rules when the turn fails before any tool ran, and when the model gives nothing at all", async () => {
    provider.turns = [{ status: 400 }];
    expect((await ask("open reader")).action).toMatchObject({ kind: "navigate", to: "/app/books/book-1/reader" });
    provider.turns = [{ reply: "", calls: [] }];
    expect((await ask("open reader")).action).toMatchObject({ kind: "navigate", to: "/app/books/book-1/reader" });
  });
});

describe("the Copilot with a model that cannot call tools", () => {
  it("never gets the loop: the keyword rules choose, as they always did", async () => {
    const settings = settingsWith({ supportsToolCalls: false });
    expect(routeCallsTools(settings)).toBe(false);
    expect(routeCallsTools(settingsWith())).toBe(true);
    const message = await ask("open reader", settings);
    expect(message.action).toMatchObject({ kind: "navigate", to: "/app/books/book-1/reader" });
    expect(provider.requests.filter((request) => request.tool === "copilot_turn")).toEqual([]);
  });
});

describe("the tools of a page in the loop", () => {
  const readTool = {
    id: "read_harbor",
    description: "what the harbor page shows",
    args: '{"part":"…"}',
    schema: z.object({ part: z.string() }).strict(),
    run: vi.fn(async (args: { part: string }) => toolData("read_harbor", `The ${args.part} of the harbor is made of glass.`)),
  };
  const capability: PageCapability = { id: "readers", prompt: "The harbor page.", state: async () => "", tools: [readTool as never] };

  it("come first, run on what the page shows, and give the model what they read in the next round", async () => {
    provider.turns = [{ reply: "Let me look.", calls: [{ tool: "read_harbor", args: { part: "wall" } }] }, { reply: "The wall is made of glass.", calls: [] }];
    const env = { book, view: { selected: "wall" } } as unknown as PageEnv;
    const page = { id: "readers", capability, env, state: "", instruction: "" } as LoadedPage;
    const message = await runCopilotLoop({
      settings: settingsWith(), accountScope: null, italian: false, page, env, prompt: "What is the wall made of?", target: null,
      catalogue: [{ id: "open-reader", name: "Open Reader", description: "Navigates to the reader." }],
      messages: (instruction, request) => [{ role: "system", content: instruction }, { role: "user", content: request }],
      runCatalogueTool: vi.fn(),
    });
    expect(message?.text).toBe("The wall is made of glass.");
    expect(readTool.run).toHaveBeenCalledWith({ part: "wall" }, env);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0].system).toMatch(/The tools of this page, first:\n- read_harbor \{"part":"…"\}: what the harbor page shows\./);
    expect(provider.requests[0].enum?.[0]).toBe("read_harbor");
    expect(provider.requests[1].user).toContain("TOOL RESULTS:\nread_harbor: The wall of the harbor is made of glass.");
  });

  it("are told to the model with their arguments, and arguments that are not valid are refused before anything runs", async () => {
    provider.turns = [{ reply: "Reading.", calls: [{ tool: "read_harbor", args: { part: 3 } }] }, { reply: "I could not read it.", calls: [] }];
    const env = { book, view: null } as unknown as PageEnv;
    const message = await runCopilotLoop({
      settings: settingsWith(), accountScope: null, italian: false, page: { id: "readers", capability, env, state: "", instruction: "" }, env, prompt: "?", target: null, catalogue: [],
      messages: (instruction, request) => [{ role: "system", content: instruction }, { role: "user", content: request }],
      runCatalogueTool: vi.fn(),
    });
    expect(message?.text).toBe("I could not read it.");
    expect(provider.requests[1].user).toContain("read_harbor (refused): read_harbor: the arguments are not valid (part: Invalid input: expected string, received number)");
  });
});

describe("the reply of a turn while it streams", () => {
  it("is read from the JSON of the call as it grows, escapes and all", () => {
    expect(turnReplySoFar('{"reply":"Hel')).toBe("Hel");
    expect(turnReplySoFar('{"reply":"Line\\none \\"quoted\\" \\u00e8 done","calls":[]}')).toBe('Line\none "quoted" è done');
    expect(turnReplySoFar('{"reply":"Half an escape \\')).toBe("Half an escape ");
    expect(turnReplySoFar('{"reply":"Half a code \\u00')).toBe("Half a code ");
    expect(turnReplySoFar('{"calls":[]')).toBe("");
  });

  it("has a function whose tools are the ones the Copilot can run, in order", () => {
    const tool = copilotTurnTool(["read_readers", "open-reader"]);
    expect(tool.name).toBe("copilot_turn");
    expect((tool.parameters as { properties: { calls: { items: { properties: { tool: { enum: string[] } } } } } }).properties.calls.items.properties.tool.enum).toEqual(["read_readers", "open-reader"]);
  });
});
