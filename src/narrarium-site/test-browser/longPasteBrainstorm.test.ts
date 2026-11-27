import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";
import { longSynopsis } from "./fixtures/longSynopsis";
import { stubLongPasteProvider } from "./fixtures/longPasteProvider";

// #121 in Brainstorming, on the Synopsis page, with a model configured like the owner's: the same 63,000-character synopsis of 37 chapters reaches the provider (the routing limits
// refused it before anything was sent: «The first routing candidate exceeds the configured token-attempt or estimated-cost budget»), as material, and comes back as the proposal.

const mocks = vi.hoisted(() => ({ store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore> }));
vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return { ...original, browserOutlineSource: () => original.storeOutlineSource(mocks.store) };
});

import { runBrainstormPrompt } from "@/assistant/brainstorm/runner";
import { BRAINSTORM_TOOL_IDS } from "@/assistant/brainstorm/tools";
import type { PageChangesReview } from "@/assistant/store";
import type { BookStructure } from "@/types/book";
import { DEFAULT_SETTINGS, type AppSettings, type BookEntry, type ChatModel } from "@/types/settings";

const DOC = longSynopsis();
let provider: ReturnType<typeof stubLongPasteProvider>;
beforeEach(() => {
  mocks.store = new MemoryBookStore({ "book.md": "---\ntype: book\ntitle: Le correnti di Ancona\nlanguage: it\n---\n" });
  provider = stubLongPasteProvider();
});

const book = { id: "book", name: "Le correnti di Ancona", owner: "local", repo: "book", tokenIndex: null, addedAt: "now" } as BookEntry;
const structure = { title: "Le correnti di Ancona", language: "it", chapters: [], ghostwriters: [], characters: [], locations: [], factions: [], items: [], secrets: [], timelines: [], readerPersonas: [], researchFiles: [], readerEvaluationFiles: [] } as unknown as BookStructure;
const OWNER_LIKE = { maxInputTokens: 1_000_000, maxOutputTokens: 65_536, supportsToolCalls: true, pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } } as Partial<ChatModel>;
const settings = {
  ...DEFAULT_SETTINGS,
  ui: { ...DEFAULT_SETTINGS.ui, language: "it" },
  aiIntegrations: [{ id: "fake", name: "Fake", provider: "openai", endpoint: "https://fake.test/v1", apiKey: "sk-fake-0123456789abcdef", streamMode: "off", chatModels: [{ id: "big", name: "big", capabilities: ["default", "copilot"], ...OWNER_LIKE }] }],
  taskRouting: { copilot: { primary: { integrationId: "fake", model: "big" }, fallbacks: [] } },
} as AppSettings;

function brainstorm(prompt: string, onText?: (text: string) => void, more: { material?: string; settings?: AppSettings } = {}) {
  return runBrainstormPrompt({ prompt, settings: more.settings ?? settings, book, branch: "main", structure, history: [], accountScope: null, ...(onText ? { onText } : {}), ...(more.material ? { material: more.material } : {}) });
}

type Proposal = { kind: string; toolId: string; updates: Array<{ path: string }>; review: PageChangesReview };

describe("Brainstorming with a 63,000-character synopsis of 37 chapters pasted", () => {
  it("imports it when asked to create the chapters from it: the provider reads it a few chapters at a time, and the answer is the proposal", async () => {
    const progress: string[] = [];
    const message = await brainstorm(`crea i capitoli basandoti esattamente su questo testo\n\n${DOC}`, (text) => progress.push(text));
    expect(provider.calls.map((call) => call.tool)).toEqual(Array(7).fill("synopsis_chapters"));
    expect(progress[0]).toBe("Leggo il testo: capitoli 1-6 di 37…");
    const action = message.action as unknown as Proposal;
    expect(action).toMatchObject({ kind: "apply-file-updates", toolId: "edit-outline", review: { page: "outline" } });
    expect(action.updates).toHaveLength(37);
    expect(action.review.rows).toHaveLength(37);
    expect(message.text).toContain("Ho letto 37 capitoli su 37 del testo");
  });

  it("gives any other request the material as data, and the model can import it with its own tool", async () => {
    expect(BRAINSTORM_TOOL_IDS).toContain("import_synopsis_text");
    provider.answer = (call) => (call.tool === "prose" && call.system.includes("Brainstorming") ? { reply: "Trasformo il testo nella Sinossi.", calls: [{ tool: "import_synopsis_text", args: {} }] } : undefined);
    const message = await brainstorm(`Ecco la mia analisi del romanzo, usala per il libro.\n\n${DOC}`);
    const turn = provider.calls[0];
    expect(turn.user).toContain("<current_request trust=\"user-instruction\">\nEcco la mia analisi del romanzo, usala per il libro.\n</current_request>");
    expect(turn.user).toContain("a synopsis of 37 chapters: import_synopsis_text turns it into the Synopsis");
    expect(provider.calls.slice(1).map((call) => call.tool)).toEqual(Array(7).fill("synopsis_chapters"));
    expect((message.action as unknown as Proposal).updates).toHaveLength(37);
  });

  it("reads a text set apart as material in the composer the same way, with the line the author typed as the request", async () => {
    const message = await brainstorm("crea i capitoli basandoti esattamente su questo testo", undefined, { material: DOC });
    expect(provider.calls.map((call) => call.tool)).toEqual(Array(7).fill("synopsis_chapters"));
    expect((message.action as unknown as Proposal).updates).toHaveLength(37);
  });

  it("asks its first model whatever its estimated cost, and when it fails lets the fallbacks a routing limit left out reach the chat with the numbers", async () => {
    const bad = { ...settings.aiIntegrations[0], id: "bad", name: "Bad", endpoint: "https://bad.test/v1" };
    const route = { primary: { integrationId: "bad", model: "big" }, fallbacks: [{ integrationId: "fake", model: "big" }] };
    const tight = { ...settings, aiIntegrations: [bad, ...settings.aiIntegrations], taskRouting: { copilot: route }, routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxEstimatedCost: 0.01 } } as AppSettings;
    provider.failHosts = new Set(["bad.test"]);
    const refused = await brainstorm(`Cosa ne pensi?\n\n${DOC}`, undefined, { settings: tight }).then(() => null, (error: unknown) => error);
    expect((refused as { budget?: unknown }).budget).toMatchObject({ limit: "cost", allowed: 0.01 });
    expect(provider.calls, "the first model was asked, its fallback was not").toHaveLength(1);
  });
});
