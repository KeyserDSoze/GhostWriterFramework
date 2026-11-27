import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeReaderPersonas, parseReaderPersona, type ReaderPersonaProfile } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

// The Simulated readers page with the Copilot, through the real AI router and the engine's client, with a fake OpenAI-compatible provider: a model that calls
// tools proposes the batch with one call for its turn and one for all the new readers; a model that cannot gets there through the page's keyword rule, with
// the same two calls in the text. Nothing is written: the proposal waits for the author.

const files = vi.hoisted(() => ({ store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore> }));

vi.mock("@/narrarium/readerPanel", async () => {
  const { mergeReaderPersonas: merge, parseReaderPersona: parse } = await import("narrarium-engine");
  return {
    loadReaderPersonas: async () => merge("en", [...files.store.files.entries()].filter(([path]) => path.startsWith("personas/")).map(([path, content]) => parse(path.slice("personas/".length, -3), content))),
  };
});
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
    // Without tools the call says what it wants by its words: the batch or the readers.
    const kind = tool ?? (system.includes("You design simulated readers") ? "reader_personas" : system.includes("into the arguments of the tool propose_reader_changes") ? "propose_reader_changes" : "prose");
    provider.requests.push({ tool: kind, system, user });
    const answer = provider.answers[kind]?.shift()?.({ system, user }) ?? { reply: "", calls: [] };
    const message = tool
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool, arguments: JSON.stringify(answer) } }] }
      : { role: "assistant", content: JSON.stringify(answer) };
    return new Response(JSON.stringify({ id: "x", object: "chat.completion", model: "fake-model", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop", message }] }), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

function settingsWith(model: Partial<ChatModel> = {}, extra: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ui: { ...DEFAULT_SETTINGS.ui, language: "en" },
    aiIntegrations: [{ id: "fake", name: "Fake", provider: "openai", endpoint: "https://fake.test/v1", apiKey: "sk-fake-0123456789abcdef", streamMode: "off", chatModels: [{ id: "fake-model", name: "fake-model", capabilities: ["default", "copilot"], supportsToolCalls: true, ...model }] }],
    taskRouting: { copilot: { primary: { integrationId: "fake", model: "fake-model" }, fallbacks: [] } },
    ...extra,
  } as AppSettings;
}

const book = { id: "book-1", name: "The Glass Harbor", owner: "local", repo: "book-1", tokenIndex: null, addedAt: "now" } as BookEntry;
const context = {
  route: { kind: "book-simulated-readers", bookId: "book-1" }, book, branchReady: true, branch: "main",
  structure: { title: "The Glass Harbor", language: "en", chapters: [], characters: [], locations: [], factions: [], items: [], secrets: [], timelines: [], readerPersonas: [], researchFiles: [], readerEvaluationFiles: [] },
  chapter: null, paragraph: null, title: "Simulated Readers", summary: "Managing simulated readers for The Glass Harbor.", relevantFiles: [], availableFiles: [], loadedFilePaths: [], noteTargetPath: "notes.md",
} as unknown as LoadedWriterContext;

function ask(prompt: string, settings = settingsWith()) {
  return runAssistantPrompt({ prompt, context, settings, book, branch: "main", token: "local", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
}

const persona = (name: string, aspect: string) => ({ name, description: `${name}, a historical reader.`, profile: `${name} knows the period.`, aspects: [aspect], preferredGenres: ["historical-fiction"], dislikedGenres: [], experienceLevel: "expert", severity: 7, audienceAge: "adult", interests: [], appreciatedElements: [], frequentCriticisms: [], customPrompt: "" });
const HISTORIANS = [persona("The Military Historian", "battles"), persona("The Court Chronicler", "etiquette"), persona("The Social Historian", "daily life")];

beforeEach(() => {
  files.store = new MemoryBookStore({ "personas/captain-ada.md": "---\ntype: reader-persona\nid: reader:custom:captain-ada\nname: Captain Ada\nreader_type: custom\nenabled: true\n---\n\nA sailor.\n" });
  provider.answers = {};
  provider.requests = [];
  stubProvider();
});

afterEach(() => vi.unstubAllGlobals());

describe("the Copilot on the Simulated readers page", () => {
  it("proposes the batch with a model that calls tools: one call for its turn, one for all the new readers, and every reader with its resulting state", async () => {
    provider.answers.copilot_turn = [() => ({ reply: "Here is the proposal: three historians, and the default readers off.", calls: [{ tool: "propose_reader_changes", args: { create: { count: 3, brief: "historical readers of different kinds" }, disable: ["@builtin"] } }] })];
    provider.answers.reader_personas = [() => ({ readers: HISTORIANS })];
    const message = await ask("create only historical readers of different kinds and turn off all the default ones");
    expect(provider.requests.map((request) => request.tool)).toEqual(["copilot_turn", "reader_personas"]);
    // The turn sees the page: its state, and its tools first.
    expect(provider.requests[0].system).toContain("CURRENT PAGE. The author is on the Simulated readers page");
    expect(provider.requests[0].system).toContain("Simulated readers: 29 (28 built-in, 1 custom); 9 on:");
    expect(provider.requests[0].system).toMatch(/The tools of this page, first:\n- read_readers/);
    expect(provider.requests[1].system).toContain("Write exactly 3 readers that match the brief, each a different kind of reader");
    expect(message.text).toContain("Here is the proposal: three historians, and the default readers off.");
    expect(message.text).toContain("Proposed changes to the simulated readers: 3 created, 8 turned off. After them, 32 readers, 4 on. Nothing changes until you apply the proposal.");
    const action = message.action as { kind: string; toolId: string; updates: Array<{ path: string; content: string | null }>; review: { page: string; rows: Array<{ name: string; change: string; after: boolean | null }> } };
    expect(action).toMatchObject({ kind: "apply-file-updates", toolId: "edit-page", review: { page: "readers" } });
    expect(action.review.rows).toHaveLength(32);
    expect(action.review.rows.slice(0, 3).map((row) => [row.name, row.change])).toEqual([["The Military Historian", "created"], ["The Court Chronicler", "created"], ["The Social Historian", "created"]]);
    expect(action.updates.map((update) => update.path).sort()).toEqual(["personas/standard-characters.md", "personas/standard-continuity.md", "personas/standard-critical.md", "personas/standard-emotional.md", "personas/standard-general.md", "personas/standard-plot.md", "personas/standard-style.md", "personas/standard-worldbuilding.md", "personas/the-court-chronicler.md", "personas/the-military-historian.md", "personas/the-social-historian.md"]);
    // Nothing is written before the author applies it.
    expect([...files.store.files.keys()]).toEqual(["personas/captain-ada.md"]);
  });

  it("gets there with a model that cannot call tools: the page's rule chooses the batch, made by two calls in the text, for an Italian request", async () => {
    provider.answers.propose_reader_changes = [() => ({ create: { count: 3, brief: "lettori storici di diverso tipo" }, disable: ["@builtin"] })];
    provider.answers.reader_personas = [() => ({ readers: HISTORIANS })];
    const message = await ask("creami solo lettori storici, di diverso tipo, e leva tutti i lettori di default", settingsWith({ supportsToolCalls: false }));
    expect(provider.requests.map((request) => request.tool)).toEqual(["propose_reader_changes", "reader_personas"]);
    expect(provider.requests[0].system).toContain("Return ONLY one JSON object with this shape");
    expect(message.text).toBe("Modifiche proposte ai lettori simulati: 3 creati, 8 spenti. Dopo, 32 lettori, 4 accesi. Nulla cambia finché non applichi la proposta.");
    expect(message.action).toMatchObject({ kind: "apply-file-updates", toolId: "edit-page" });
  });

  it("reaches the batch without tool calls from another page of the book, and for a change on the page that names no reader", async () => {
    const elsewhere = { ...context, route: parseAppRoute("/app/books/book-1/chapters/001-dawn"), title: "Dawn" } as LoadedWriterContext;
    provider.answers.propose_reader_changes = [() => ({ disable: ["@standard"] }), () => ({ disable: ["Critical Reader"] })];
    const fromChapter = await runAssistantPrompt({ prompt: "spegni i lettori standard", context: elsewhere, settings: settingsWith({ supportsToolCalls: false }), book, branch: "main", token: "local", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
    expect(fromChapter.text).toBe("Modifiche proposte ai lettori simulati: 8 spenti. Dopo, 29 lettori, 1 acceso. Nulla cambia finché non applichi la proposta.");
    const onPage = await ask("keep the harsh one and switch the critical one off", settingsWith({ supportsToolCalls: false }));
    expect(provider.requests.map((request) => request.tool)).toEqual(["propose_reader_changes", "propose_reader_changes"]);
    expect(onPage.text).toBe("Proposed changes to the simulated readers: 1 turned off. After them, 29 readers, 8 on. Nothing changes until you apply the proposal.");
    expect(onPage.action).toMatchObject({ kind: "apply-file-updates", toolId: "edit-page", review: { page: "readers" } });
  });

  it("does not take new readers that are not different, and tells the model so: nothing is proposed", async () => {
    provider.answers.copilot_turn = [
      () => ({ reply: "Creating two.", calls: [{ tool: "propose_reader_changes", args: { create: { count: 2, brief: "historians" } } }] }),
      ({ user }) => ({ reply: user.includes("propose_reader_changes (refused)") && user.includes("two readers have the same name") ? "I could not make two different readers." : "?", calls: [] }),
    ];
    provider.answers.reader_personas = [() => ({ readers: [persona("Twin", "a"), persona("Twin", "b")] })];
    const message = await ask("create two historians");
    expect(message.text).toBe("I could not make two different readers.");
    expect(message.action).toBeUndefined();
  });

  it("proposes nothing when the author turned the tool off for the Copilot", async () => {
    provider.answers.copilot_turn = [
      () => ({ reply: "Turning them off.", calls: [{ tool: "propose_reader_changes", args: { disable: ["@builtin"] } }] }),
      () => ({ reply: "Changes of the readers are turned off in your settings.", calls: [] }),
    ];
    const message = await ask("turn off the default readers", settingsWith({}, { copilotTools: { ...DEFAULT_SETTINGS.copilotTools, toolOverrides: { "edit-page": { enabled: false } } } } as Partial<AppSettings>));
    expect(message.action).toBeUndefined();
    expect(provider.requests[1].user).toContain("propose_reader_changes (refused): Changes of the pages by the Copilot are turned off");
  });
});

describe("the readers of the book as the Copilot reads them", () => {
  it("are every reader, the built-in ones included", () => {
    const readers: ReaderPersonaProfile[] = mergeReaderPersonas("en", [parseReaderPersona("captain-ada", files.store.files.get("personas/captain-ada.md")!)]);
    expect(readers.filter((reader) => reader.builtin)).toHaveLength(28);
  });
});
