import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";

// The other pages with the Copilot, through the real AI router and the engine's client, with a fake OpenAI-compatible provider: a model that calls tools
// proposes the Ghostwriters page's batch from its page, and the director's from a chapter (the tools of every page stay available everywhere); a model that
// cannot gets to the change of an entry of the canon through the page's keyword rule, for an Italian request. Nothing is written before the author applies it.

const files = vi.hoisted(() => ({ store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore> }));

vi.mock("@/narrarium/readerPanel", () => ({ loadReaderPersonas: async () => [] }));
vi.mock("@/github/githubClient", async (importOriginal) => {
  const { RepositoryError } = await import("@/repository/repositoryError");
  return {
    ...(await importOriginal<typeof import("@/github/githubClient")>()),
    readFileWithSha: vi.fn(async (_token: string, _owner: string, _repo: string, _branch: string, path: string) => {
      const file = await files.store.read(path);
      if (!file) throw new RepositoryError(`${path} was not found.`, "not-found", "read", 404);
      return { content: file.content, sha: file.hash };
    }),
  };
});

import { runAssistantPrompt } from "@/assistant/service";
import { parseAppRoute, type LoadedWriterContext } from "@/assistant/context";
import { DEFAULT_SETTINGS, type AppSettings, type BookEntry, type ChatModel } from "@/types/settings";

type Answer = (body: { system: string; user: string }) => unknown;
const provider = { answers: {} as Record<string, Answer[]>, requests: [] as Array<{ tool: string; system: string; user: string }> };

function stubProvider(): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
    const text = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "");
    const tool = body.tools?.[0]?.function.name;
    const system = text(body.messages.find((message) => message.role === "system")?.content);
    const user = text([...body.messages].reverse().find((message) => message.role === "user")?.content);
    const named = /into the arguments of the tool (\w+)/.exec(system)?.[1];
    const kind = tool ?? named ?? "prose";
    provider.requests.push({ tool: kind, system, user });
    const answer = provider.answers[kind]?.shift()?.({ system, user }) ?? { reply: "", calls: [] };
    const message = tool
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool, arguments: JSON.stringify(answer) } }] }
      : { role: "assistant", content: JSON.stringify(answer) };
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

function context(pathname: string): LoadedWriterContext {
  return {
    route: parseAppRoute(pathname), book, branchReady: true, branch: "main",
    structure: {
      title: "The Glass Harbor", language: "en", ghostwriter: "noir", ghostwriters: [{ slug: "noir", path: "ghostwriters/noir.md", name: "Noir" }],
      chapters: [], characters: [{ path: "characters/mara.md", sha: "x", size: 1, name: "Mara Vell" }], locations: [], factions: [], items: [], secrets: [], timelines: [], readerPersonas: [], researchFiles: [], readerEvaluationFiles: [],
    },
    chapter: null, paragraph: null, title: "Page", summary: "", relevantFiles: [], availableFiles: [], loadedFilePaths: [], noteTargetPath: "notes.md",
  } as unknown as LoadedWriterContext;
}

function ask(prompt: string, pathname: string, settings = settingsWith()) {
  return runAssistantPrompt({ prompt, context: context(pathname), settings, book, branch: "main", token: "local", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
}

type Proposal = { kind: string; toolId: string; updates: Array<{ path: string; content: string | null }>; review: { page: string; rows: Array<{ id: string; name: string; change: string }> } };

beforeEach(() => {
  files.store = new MemoryBookStore({
    "ghostwriters/noir.md": "---\ntype: ghostwriter\nid: ghostwriter:noir\nname: Noir\ntone: dry\n---\n\nShort sentences.\n",
    "characters/mara.md": "---\ntype: character\nid: character:mara\nname: Mara Vell\nage: 34\nsecret_refs:\n  - secret:mara-sold-the-maps\n---\n\nA pilot.\n",
  });
  provider.answers = {};
  provider.requests = [];
  stubProvider();
});

afterEach(() => vi.unstubAllGlobals());

describe("the Copilot on the other pages of a book", () => {
  it("proposes the ghostwriters' batch on their page, which it sees first", async () => {
    provider.answers.copilot_turn = [() => ({ reply: "A gothic voice, next to Noir.", calls: [{ tool: "propose_ghostwriter_changes", args: { create: [{ name: "Gothic", tone: "ornate", avoid: ["modern slang"] }] } }] })];
    const message = await ask("add a gothic ghostwriter", "/app/books/book-1/ghostwriters");
    expect(provider.requests[0].system).toContain("CURRENT PAGE. The author is on the Ghostwriters page");
    expect(provider.requests[0].user).toContain("- Noir · noir · the book's default · dry");
    expect(provider.requests[0].system).toMatch(/The tools of this page, first:\n- read_ghostwriters/);
    expect(message.text).toBe("A gothic voice, next to Noir.\n\nProposed changes to the ghostwriters: 1 created. Nothing changes until you apply the proposal.");
    const action = message.action as unknown as Proposal;
    expect(action).toMatchObject({ kind: "apply-file-updates", toolId: "edit-page", review: { page: "ghostwriters" } });
    expect(action.review.rows.map((row) => [row.name, row.change])).toEqual([["Gothic", "created"], ["Noir", "unchanged"]]);
    expect(action.updates.map((update) => update.path)).toEqual(["ghostwriters/gothic.md"]);
    expect([...files.store.files.keys()]).not.toContain("ghostwriters/gothic.md");
  });

  it("keeps the tools of every page available elsewhere: the director's batch from a chapter", async () => {
    provider.answers.copilot_turn = [() => ({ reply: "A stricter director.", calls: [{ tool: "propose_director_changes", args: { set: { strictness: 9 } } }] })];
    const message = await ask("make the director stricter", "/app/books/book-1/chapters/001-dawn");
    expect(provider.requests[0].system).not.toContain("CURRENT PAGE.");
    expect(provider.requests[0].system).toMatch(/The tools of the other pages of the book, for a request about them:\n[\s\S]*- propose_director_changes/);
    const action = message.action as unknown as Proposal;
    expect(action.review.page).toBe("director");
    expect(action.updates.map((update) => update.path)).toEqual(["director.md"]);
  });

  it("changes the entry of the canon with a model that cannot call tools, for an Italian request, and never shows it what points to a secret", async () => {
    provider.answers.propose_canon_entry_changes = [() => ({ set: { age: "35" } })];
    const message = await ask("cambia l'età del personaggio: ha 35 anni", "/app/books/book-1/canon/characters/mara", settingsWith({ supportsToolCalls: false }));
    expect(provider.requests.map((request) => request.tool)).toEqual(["propose_canon_entry_changes"]);
    expect(provider.requests[0].user).toContain("- age: 34");
    expect(provider.requests[0].user).not.toContain("mara-sold-the-maps");
    expect(message.text).toBe("Modifiche proposte a «Mara Vell»: 1 modificato. Nulla cambia finché non applichi la proposta.");
    const action = message.action as unknown as Proposal;
    expect(action.review.page).toBe("canon");
    expect(action.updates[0].content).toContain("age: 35\n");
    expect(action.updates[0].content).toContain("secret_refs:\n  - secret:mara-sold-the-maps");
  });
});
