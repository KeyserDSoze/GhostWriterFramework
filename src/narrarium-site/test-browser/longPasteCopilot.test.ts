import { beforeEach, describe, expect, it, vi } from "vitest";
import { outlineChapterPath, outlineEntryDigest, parseMarkdown, serializeOutlineChapter } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { longSynopsis, longSynopsisTitle } from "./fixtures/longSynopsis";
import { stubLongPasteProvider } from "./fixtures/longPasteProvider";

// #121 through the whole Copilot path (runAssistantPrompt, the router, the engine's client) with a fake OpenAI-compatible provider, on the Synopsis page, with a model configured like
// the owner's (a 1,000,000-token window, a large output, a price): the author pastes a 63,000-character synopsis of 37 chapters and asks to create the chapters from it.

const mocks = vi.hoisted(() => ({ store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore> }));
vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return { ...original, browserOutlineSource: () => original.storeOutlineSource(mocks.store) };
});
vi.mock("@/github/githubClient", async (importOriginal) => {
  const { RepositoryError } = await import("@/repository/repositoryError");
  return {
    ...(await importOriginal<typeof import("@/github/githubClient")>()),
    readFileWithSha: vi.fn(async (_token: string, _owner: string, _repo: string, _branch: string, path: string) => {
      const file = await mocks.store.read(path);
      if (!file) throw new RepositoryError(`${path} was not found.`, "not-found", "read", 404);
      return { content: file.content, sha: file.hash };
    }),
  };
});

import { runAssistantPrompt } from "@/assistant/service";
import { listenToPromptCuts, promptCutNote, type PromptCut } from "@/assistant/promptCut";
import { attachmentTextCut } from "@/assistant/attachmentText";
import { RoutingExecutionBudgetError } from "@/assistant/routingExecutionBudget";
import type { LoadedWriterContext } from "@/assistant/context";
import type { AssistantAttachment, AssistantMessage, PageChangesReview } from "@/assistant/store";
import { DEFAULT_SETTINGS, type AppSettings, type BookEntry, type ChatModel } from "@/types/settings";

const DOC = longSynopsis();

let provider: ReturnType<typeof stubLongPasteProvider>;
beforeEach(() => {
  mocks.store = new MemoryBookStore({ "book.md": "---\ntype: book\ntitle: Le correnti di Ancona\nlanguage: it\n---\n" });
  provider = stubLongPasteProvider();
});

const book = { id: "book", name: "Le correnti di Ancona", owner: "local", repo: "book", tokenIndex: null, addedAt: "now" } as BookEntry;
const context = {
  route: { kind: "book-outline", bookId: "book" }, book, branchReady: true, branch: "main",
  structure: { title: "Le correnti di Ancona", language: "it", chapters: [], ghostwriters: [], characters: [], locations: [], factions: [], items: [], secrets: [], timelines: [], readerPersonas: [], researchFiles: [], readerEvaluationFiles: [] },
  chapter: null, paragraph: null, title: "Sinossi", summary: "", relevantFiles: [], availableFiles: [], loadedFilePaths: [], noteTargetPath: "notes.md",
} as unknown as LoadedWriterContext;

/** The owner's model: a 1,000,000-token window, 65,536 tokens of output, a price. */
const OWNER_LIKE = { maxInputTokens: 1_000_000, maxOutputTokens: 65_536, supportsToolCalls: true, pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } } as Partial<ChatModel>;
function settingsWith(model: Partial<ChatModel> = OWNER_LIKE): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ui: { ...DEFAULT_SETTINGS.ui, language: "it" },
    aiIntegrations: [{ id: "fake", name: "Fake", provider: "openai", endpoint: "https://fake.test/v1", apiKey: "sk-fake-0123456789abcdef", streamMode: "off", chatModels: [{ id: "big", name: "big", capabilities: ["default", "copilot"], ...model }] }],
    taskRouting: { copilot: { primary: { integrationId: "fake", model: "big" }, fallbacks: [] }, default: { primary: { integrationId: "fake", model: "big" }, fallbacks: [] } },
  } as AppSettings;
}

function ask(prompt: string, settings = settingsWith(), onText?: (text: string) => void, more: { attachments?: AssistantAttachment[]; signal?: AbortSignal } = {}): Promise<AssistantMessage> {
  return runAssistantPrompt({ prompt, context, settings, book, branch: "main", token: "local", history: [], compactSummary: "", compactedMessageCount: 0, attachments: more.attachments ?? [], accountScope: null, onText, ...(more.signal ? { signal: more.signal } : {}) });
}

/** The text the author pasted and set apart with «Use this text as material». */
const asMaterial = (text: string): AssistantAttachment => ({ id: "material-1", name: "Testo incollato", mimeType: "text/plain", kind: "text", sizeBytes: text.length, textContent: text, material: true });

type Proposal = { kind: string; toolId: string; updates: Array<{ path: string; content: string | null }>; sourceRevisions: Record<string, string | null>; review: PageChangesReview };

describe("the Copilot on the Synopsis page, with a 63,000-character synopsis of 37 chapters pasted", () => {
  it("asks the model, a few chapters at a time with the progress said, and proposes the 37 entries with their design in one table and one apply", async () => {
    const progress: string[] = [];
    const message = await ask(`Creami i capitoli basandoti esattamente su questo riassunto:\n\n${DOC}`, settingsWith(), (text) => progress.push(text));
    // Seven calls of six chapters (the last of one), each a validated forced function; nothing else is asked.
    expect(provider.calls.map((call) => call.tool)).toEqual(Array(7).fill("synopsis_chapters"));
    expect(progress).toEqual(["capitoli 1-6", "7-12", "13-18", "19-24", "25-30", "31-36", "37"].map((range) => `Leggo il testo: ${range.includes("capitoli") ? range : `capitoli ${range}`} di 37…`));
    // The material reaches the model as data, the instruction as the request; a batch reads its chapters and the parts of the text that are not chapters.
    expect(provider.calls[0].user).toContain("<current_request trust=\"user-instruction\">\nCreami i capitoli basandoti esattamente su questo riassunto:");
    expect(provider.calls[0].user).toMatch(/<user_content trust="untrusted-data">\nThe chapters 1-6 of the 37 of the text the author pasted/);
    expect(provider.calls[0].user).toContain("| Il padre di Elena è vivo | 31 | 30 |");
    expect(provider.calls[0].user).not.toContain("## Capitolo 7 ");
    expect(message.text).toBe("Ho letto 37 capitoli su 37 del testo: 37 nuove voci della Sinossi, 0 voci aggiornate.\n\nNulla è salvato finché non applichi la proposta, tutta insieme: ogni voce che scrivo diventa tua.");
    const action = message.action as unknown as Proposal;
    expect(action).toMatchObject({ kind: "apply-file-updates", toolId: "edit-outline", review: { page: "outline" } });
    expect(action.updates).toHaveLength(37);
    expect(Object.keys(action.sourceRevisions).sort()).toEqual(action.updates.map((update) => update.path).sort());
    expect(action.review.rows).toHaveLength(37);
    expect(action.review.rows.every((row) => row.change === "created")).toBe(true);
    expect(action.review.rows[0]).toMatchObject({ id: "chapter-1", name: `1. ${longSynopsisTitle(1)}`, fields: ["title", "summary", "goal", "events", "emotions", "next", "ending"] });
    expect(action.review.rows[2].fields).toContain("cliffhanger");
    // The entry is the text's, field by field, and nothing it does not say.
    const first = parseMarkdown(action.updates.find((update) => update.path === outlineChapterPath(1))!.content!);
    expect(first.frontmatter).toMatchObject({ title: longSynopsisTitle(1), origin: "author" });
    expect(first.body).toContain("Marco arriva alla villa sul colle con una chiave d'ottone");
    expect((first.frontmatter.design as Record<string, unknown>).events).toEqual(["Marco trova una chiave d'ottone nascosto sotto il pavimento.", "Nadia mente sul giorno in cui è tornato in città.", "Una telefonata anonima avverte Marco di non cercare oltre."]);
    expect((first.frontmatter.design as Record<string, unknown>).pov).toBeUndefined();
    // Nothing is written before the author applies it.
    expect([...mocks.store.files.keys()]).toEqual(["book.md"]);
  });

  it("sizes its batches on the model the call is routed to, also by its tags without a route of its own", async () => {
    const { taskRouting: _routes, ...untagged } = settingsWith();
    const message = await ask(`Creami i capitoli basandoti esattamente su questo riassunto:\n\n${DOC}`, { ...untagged, taskRouting: {} } as AppSettings);
    expect(provider.calls.map((call) => call.tool), "65,536 tokens of output hold six chapters a batch").toEqual(Array(7).fill("synopsis_chapters"));
    expect((message.action as unknown as Proposal).updates).toHaveLength(37);
  });

  it("works the same with the request after the text, and with a model without tool calls", async () => {
    const message = await ask(`${DOC}\n\ncrea i capitoli basandoti esattamente su questo testo`, settingsWith({ ...OWNER_LIKE, supportsToolCalls: false }));
    expect(provider.calls).toHaveLength(7);
    expect(provider.calls.every((call) => call.tool === "prose")).toBe(true);
    expect((message.action as unknown as Proposal).updates).toHaveLength(37);
  });

  it("reads a batch that fails again in halves, and says the chapter it could not read instead of leaving it out in silence", async () => {
    provider.fail = new Set([17]);
    const message = await ask(`Creami i capitoli basandoti esattamente su questo riassunto:\n\n${DOC}`);
    const action = message.action as unknown as Proposal;
    expect(action.updates).toHaveLength(36);
    expect(action.review.rows.map((row) => row.id)).not.toContain("chapter-17");
    expect(message.text).toContain("Ho letto 36 capitoli su 37 del testo");
    expect(message.text).toContain("Non sono riuscito a leggere il capitolo 17: non è nella proposta.");
    // 13-18 failed, then 13-15 and 16-18, then 16-17 and 18, then 16 and 17, then 17 again.
    expect(provider.calls.length).toBeGreaterThan(7);
  });

  it("never replaces an entry the author wrote: it fills the empty ones and the autopilot's, and keeps the author's aside for the review to add", async () => {
    await mocks.store.commit([
      { path: outlineChapterPath(3), content: serializeOutlineChapter({ number: 3, title: "Il mio terzo", body: "Quello che ho scritto io.", origin: "author" }) },
      { path: outlineChapterPath(5), content: serializeOutlineChapter({ number: 5, title: "Dell'autopilot", body: "Un piano dell'autopilot.", origin: "autopilot", digest: await outlineEntryDigest({ title: "Dell'autopilot", body: "Un piano dell'autopilot." }) }) },
    ], "seed");
    const message = await ask(`Creami i capitoli basandoti esattamente su questo riassunto:\n\n${DOC}`);
    const action = message.action as unknown as Proposal;
    expect(action.updates.map((update) => update.path)).not.toContain(outlineChapterPath(3));
    expect(action.review.rows.find((row) => row.id === "chapter-3")).toMatchObject({ name: "3. Il mio terzo", change: "unchanged", kind: "own" });
    expect(action.review.rows.find((row) => row.id === "chapter-5")).toMatchObject({ change: "edited" });
    expect(action.review.optional?.rows).toEqual(["chapter-3"]);
    expect(action.review.optional?.updates.map((update) => update.path)).toEqual([outlineChapterPath(3)]);
    expect(Object.keys(action.review.optional?.sourceRevisions ?? {})).toEqual([outlineChapterPath(3)]);
    expect(message.text).toContain("La voce 3 è tua: non le sostituisco.");
  });

  it("keeps «non creare i capitoli» a refusal (without asking a model that cannot call tools; refused in code when a model that can calls the tool), and answers a long text with a negative request from the model, changing nothing", async () => {
    const refusal = await ask("non creare i capitoli della sinossi", settingsWith({ ...OWNER_LIKE, supportsToolCalls: false }));
    expect(provider.calls).toHaveLength(0);
    expect(refusal.text).toBe("Non ho eseguito il tool (edit-outline) e non ho generato modifiche o proposte applicabili.");
    // Without a word of the Synopsis the rules find no tool for it, and the model answers: nothing is proposed either way.
    const plain = await ask("non creare i capitoli", settingsWith({ ...OWNER_LIKE, supportsToolCalls: false }));
    expect(plain.action).toBeUndefined();
    expect(provider.calls.map((call) => call.tool)).toEqual(["prose"]);
    provider.calls = [];
    provider.answer = (call) => (call.tool === "copilot_turn" ? { reply: "Creo i capitoli.", calls: [{ tool: "edit-outline" }] } : undefined);
    const refusedInCode = await ask("non creare i capitoli");
    expect(refusedInCode.action).toBeUndefined();
    expect(refusedInCode.text).toContain("Non ho eseguito il tool (edit-outline) e non ho generato modifiche o proposte applicabili.");
    provider.answer = null;
    provider.calls = [];
    const answered = await ask(`Non creare i capitoli: dimmi solo cosa ne pensi di questo testo.\n\n${DOC}`, settingsWith({ ...OWNER_LIKE, supportsToolCalls: false }));
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(answered.action).toBeUndefined();
    expect(provider.calls.some((call) => call.tool === "synopsis_chapters")).toBe(false);
    expect(provider.calls[provider.calls.length - 1].user).toContain("<pasted_material trust=\"untrusted-data\">");
  });

  it("reads a text set apart as material («Use this text as material») the same way, with the one line the author typed as the request", async () => {
    const message = await ask("crea i capitoli basandoti esattamente su questo testo", settingsWith(), undefined, { attachments: [asMaterial(DOC)] });
    expect(provider.calls.map((call) => call.tool)).toEqual(Array(7).fill("synopsis_chapters"));
    expect(provider.calls[0].user).toContain("<current_request trust=\"user-instruction\">\ncrea i capitoli basandoti esattamente su questo testo");
    expect((message.action as unknown as Proposal).updates).toHaveLength(37);
    // Material is not a file: the limits of the attachments never cut it, and the chat has nothing to say about them.
    expect(attachmentTextCut(settingsWith(), [asMaterial(DOC)])).toBeNull();
    const file = { ...asMaterial(DOC), id: "file", name: "sinossi.md", material: undefined };
    expect(attachmentTextCut(settingsWith(), [file])).toEqual({ sent: expect.any(Number), total: DOC.length });
    expect(attachmentTextCut(settingsWith(), [file])!.sent).toBeLessThan(24_000);
  });
});

describe("what is said when a request is cut or refused", () => {
  const listen = () => {
    const controller = new AbortController();
    const cuts: PromptCut[] = [];
    listenToPromptCuts(controller.signal, (cut) => cuts.push(cut));
    return { signal: controller.signal, cuts };
  };

  it("judges a request by the window of its model: nothing is cut of a 63,000-character text for a model of 1,000,000 tokens or for one whose window is not set (128,000 assumed), and a cut is said with how much and for which window", async () => {
    // Since #122 a request is measured with the likely tokens (about four characters each, times 1.25 until the provider counts one), not the bytes: it is cut where the window
    // really ends. A window of 12,000 tokens does not hold the text; the default window does not hold seven copies of it.
    const wide = listen();
    await ask(`Cosa ne pensi di questo testo?\n\n${DOC}`, settingsWith({ ...OWNER_LIKE, supportsToolCalls: false }), undefined, { signal: wide.signal });
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(wide.cuts).toEqual([]);
    expect(provider.calls[provider.calls.length - 1].user).toContain(DOC.slice(-2_000));

    const unset = listen();
    await ask(`Cosa ne pensi di questo testo?\n\n${DOC}`, settingsWith({ supportsToolCalls: false }), undefined, { signal: unset.signal });
    expect(unset.cuts, "the default window holds it").toEqual([]);

    const narrow = listen();
    await ask(`Cosa ne pensi di questo testo?\n\n${DOC}`, settingsWith({ supportsToolCalls: false, maxInputTokens: 12_000 }), undefined, { signal: narrow.signal });
    expect(narrow.cuts.length).toBeGreaterThan(0);
    const [cut] = narrow.cuts;
    expect(cut).toMatchObject({ model: "big", integration: "Fake", windowTokens: 12_000, configured: true, images: 0 });
    expect(cut.characters).toBeGreaterThan(DOC.length);
    expect(cut.sentCharacters).toBeLessThan(cut.characters / 2);
    const t = (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}`;
    const note = promptCutNote(narrow.cuts, t as never, (value) => String(value));
    expect(note).toContain("autopilot.copilotCut.line{");
    expect(note).toContain(`"sent":"${cut.sentCharacters}"`);
    expect(note).toContain("autopilot.copilotCut.where");

    const huge = listen();
    await ask(`Cosa ne pensi di questo testo?\n\n${Array.from({ length: 7 }, () => DOC).join("\n\n")}`, settingsWith({ supportsToolCalls: false }), undefined, { signal: huge.signal });
    expect(huge.cuts[0]).toMatchObject({ windowTokens: 128_000, configured: false });
    expect(promptCutNote(huge.cuts, t as never, (value) => String(value))).toContain("autopilot.copilotCut.lineDefault");
  });

  it("sends a first model whatever its estimated cost, and when it fails tells the author the fallbacks a routing limit left out, with its numbers, instead of answering by the rules as if nothing was asked", async () => {
    const both = (model: Partial<ChatModel>, routingExecution = DEFAULT_SETTINGS.routingExecution): AppSettings => {
      const base = settingsWith(model);
      const bad = { ...base.aiIntegrations[0], id: "bad", name: "Bad", endpoint: "https://bad.test/v1" };
      const route = { primary: { integrationId: "bad", model: "big" }, fallbacks: [{ integrationId: "fake", model: "big" }] };
      return { ...base, aiIntegrations: [bad, ...base.aiIntegrations], taskRouting: { copilot: route, default: route }, routingExecution } as AppSettings;
    };
    provider.failHosts = new Set(["bad.test"]);
    const tight = { ...DEFAULT_SETTINGS.routingExecution, maxEstimatedCost: 0.01 };
    const refused = await ask(`Cosa ne pensi di questo testo?\n\n${DOC}`, both(OWNER_LIKE, tight)).then(() => null, (error: unknown) => error);
    expect((refused as { budget?: unknown }).budget).toMatchObject({ limit: "cost", allowed: 0.01 });
    expect((refused as { budget: { estimated: number } }).budget.estimated).toBeGreaterThan(0.01);
    expect((refused as Error).message).toMatch(/Not tried: "big" in "Fake": the fallbacks after the first attempt would be estimated at/);
    expect(provider.calls, "the first model was asked, its fallback was not").toHaveLength(1);
    // With a limit that holds the fallback, it is asked and answers.
    provider.calls = [];
    const answered = await ask(`Cosa ne pensi di questo testo?\n\n${DOC}`, both(OWNER_LIKE));
    expect(answered.text).toBeTruthy();
    expect(provider.calls.length).toBeGreaterThan(1);
  });

});
