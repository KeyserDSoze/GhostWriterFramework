import { describe, expect, it, vi } from "vitest";
import { MemoryBookStore, seedBookFiles } from "narrarium-engine/testing";
import { likelyTextTokens, serializeOutlineBook, serializeOutlineChapter, servedFromCache } from "narrarium-engine";

// What a provider that caches the start of a prompt can serve of the next turn of a conversation: everything the two turns have in common from the first token. The Copilot and Brainstorming used to begin their
// user message with the request of the turn (and the Copilot said which files were loaded in its system message), so two turns had in common little more than the instructions. Now the book, the files and the
// conversation come first and the request last. These tests run the real prompt builders of both on a fixture book, turn after turn, and compare the messages as the provider receives them.

const captured = vi.hoisted(() => ({ copilot: [] as Array<Array<{ role: string; content: unknown }>>, brainstorm: [] as Array<Array<{ role: string; content: unknown }>>, store: null as unknown }));
vi.mock("@/assistant/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/assistant/router")>()),
  completeTextRouted: async (_settings: unknown, messages: Array<{ role: string; content: unknown }>, capability: string) => {
    if (capability === "brainstorming") {
      captured.brainstorm.push(messages);
      return JSON.stringify({ reply: `Answer ${captured.brainstorm.length}: the middle of the book needs a turn that costs the protagonist something; consider moving the reveal of the ledger one chapter earlier and letting Orrin act on it.`, calls: [] });
    }
    captured.copilot.push(messages);
    return `Reply number ${captured.copilot.length}: the pacing of this scene holds, the second paragraph could breathe a little more before the turn.`;
  },
}));
const prose = (seed: number, words: number) => Array.from({ length: words }, (_, i) => ["the", "harbor", "light", "glass", "she", "walked", "slowly", "toward", "silent", "boats", "while", "wind"][(i * 7 + seed) % 12]).join(" ");
vi.mock("@/github/githubClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/github/githubClient")>()),
  loadFileContent: async (_token: string, _owner: string, _repo: string, path: string) => `---\ntype: paragraph\n---\n\n${prose(path.length, path.includes("chapter.md") ? 80 : 700)}`,
}));
vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return { ...original, browserOutlineSource: () => original.storeOutlineSource(captured.store as never) };
});

import { runAssistantPrompt } from "@/assistant/service";
import { runBrainstormPrompt } from "@/assistant/brainstorm/runner";
import { DEFAULT_SETTINGS, type AppSettings, type BookEntry } from "@/types/settings";
import type { LoadedWriterContext } from "@/assistant/context";
import type { AssistantMessage } from "@/assistant/store";

type Sent = Array<{ role: string; content: unknown }>;
/** The text of a message as the provider reads it: its parts joined, as the engine joins them for every provider but the ones that are told where to cache. */
const textOf = (message: { content: unknown }): string => (typeof message.content === "string" ? message.content : (message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(""));
/** The whole request of a turn, as one text: every message, in order. */
const wire = (messages: Sent): string => messages.map((message) => `[${message.role}]\n${textOf(message)}`).join("\n");
const common = (left: string, right: string) => {
  const limit = Math.min(left.length, right.length);
  let at = 0;
  while (at < limit && left[at] === right[at]) at += 1;
  return at;
};
/** What the turn has in common with the one before, from its first token: in tokens, its share of the turn, and what a provider that caches in steps of 128 tokens serves of it. */
function shared(before: Sent, after: Sent) {
  const text = wire(after);
  const prefix = likelyTextTokens(text.slice(0, common(wire(before), text)));
  const total = likelyTextTokens(text);
  return { prefix, total, share: prefix / total, served: servedFromCache(prefix, total) };
}

const chapter = { slug: "001-current", title: "Current", path: "chapters/001-current", paragraphs: [1, 2, 3].map((n) => ({ number: `00${n}`, title: `Scene ${n}`, path: `chapters/001-current/00${n}-scene.md` })) };
const book = { id: "book", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" } satisfies BookEntry;
const available = Array.from({ length: 80 }, (_, i) => ({ path: `characters/character-${i}.md`, role: "character", exists: true }));
function context(summary: string, loaded: string[]): LoadedWriterContext {
  return {
    route: { kind: "chapter", bookId: "book", chapterId: chapter.slug },
    branchReady: true, branch: "main", book,
    structure: { defaultBranch: "main", chapters: [chapter], researchFiles: [], readerEvaluationFiles: [], characters: [], locations: [], factions: [], items: [], timelines: [] },
    chapter, paragraph: null, title: "Chapter 1: Current", summary,
    relevantFiles: loaded.map((path, i) => ({ path, content: `---\ntype: character\n---\n\n${prose(i, 200)}` })),
    availableFiles: available, loadedFilePaths: loaded, noteTargetPath: null,
  } as unknown as LoadedWriterContext;
}
const settings = { ...DEFAULT_SETTINGS, aiIntegrations: [{ id: "ai", name: "AI", provider: "openai", apiKey: "key", chatModels: [{ id: "model", name: "model", capabilities: ["default", "copilot"] }] }] } as AppSettings;


const glass: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const brainstormSettings = { ...DEFAULT_SETTINGS, aiIntegrations: [{ id: "ai", name: "AI", provider: "openai", apiKey: "key", chatModels: [{ id: "model", name: "model", capabilities: ["default", "copilot", "brainstorming"] }] }] } as AppSettings;
const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => ["harbor", "glass", "lie", "tide", "ledger", "council", "light", "silence", "inherit", "secret"][(i * 3 + seed) % 10]).join(" ");

describe("the Copilot, turn after turn about one chapter", () => {
  const prompts = ["How does the pacing here feel to you?", "Is the second scene too slow in the middle?", "What would make the ending land harder?", "Does Mira's reaction hold up against what she knows?", "Whose point of view carries the scene?", "And is the tension building the way I intended?"];

  async function converse(): Promise<Sent[]> {
    captured.copilot.length = 0;
    const history: AssistantMessage[] = [];
    for (let turn = 0; turn < prompts.length; turn += 1) {
      const before = captured.copilot.length;
      // The files loaded in full change with the question: one for the first three, two after.
      const ctx = context("Chapter route", turn < 3 ? ["characters/character-1.md"] : ["characters/character-1.md", "characters/character-2.md"]);
      const message = await runAssistantPrompt({ prompt: prompts[turn], context: ctx, settings, book, branch: "main", token: "token", history: [...history], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
      history.push({ id: `u${turn}`, role: "user", text: prompts[turn] } as AssistantMessage, message);
      expect(captured.copilot.length, `turn ${turn + 1} asked the model once`).toBe(before + 1);
    }
    return [...captured.copilot];
  }

  it("shares with the turn before it, when the question is about the same text, nearly all of its prompt (84% to 99% where before it was a quarter), and a provider that caches serves it", async () => {
    const turns = await converse();
    const results = turns.slice(1).map((messages, index) => shared(turns[index], messages));
    for (const index of [3, 4]) {
      const { prefix, total, share, served } = results[index];
      expect(share, `turn ${index + 2}: ${prefix} of ${total} tokens`).toBeGreaterThanOrEqual(0.8);
      expect(served, `turn ${index + 2}: served from a cache`).toBeGreaterThan(0.75 * total);
    }
    // The turns that ask about another text still share the system message, and what comes after it while it is the same.
    const average = results.reduce((sum, entry) => sum + entry.share, 0) / results.length;
    expect(average, "over the five turns after the first").toBeGreaterThanOrEqual(0.55);
  });

  it("keeps the system message the same while the files loaded in full change: which they are is told in the user message", async () => {
    const turns = await converse();
    const systems = turns.map((messages) => textOf(messages[0]));
    expect(new Set(systems).size, "one system message for every turn about the page").toBe(1);
    expect(systems[0]).not.toContain("Loaded files available in full this turn");
    const users = turns.map((messages) => textOf(messages[1]));
    expect(users[0]).toContain("Loaded files available in full this turn:\n- characters/character-1.md");
    expect(users[5]).toContain("- characters/character-1.md\n- characters/character-2.md");
  });

  it("asks the request last: the text it is about first, then the files and the conversation, then <current_request>, with nothing after it", async () => {
    const turns = await converse();
    for (const [index, messages] of turns.entries()) {
      const user = textOf(messages[1]);
      expect(user.endsWith("</current_request>"), `turn ${index + 1}`).toBe(true);
      expect(user.match(/<current_request/g)).toHaveLength(1);
      expect(!user.includes("prior_transcript") || user.indexOf("</prior_transcript>") < user.indexOf("<current_request"), "the conversation is before the request").toBe(true);
      expect(user).toContain(prompts[index]);
      if (index > 0) expect(user, "and the turn before is in it").toContain(`USER: ${prompts[index - 1]}`);
    }
  });

  it("says where the start that stays the same ends, in the parts of the user message that the engine reads", async () => {
    const turns = await converse();
    const parts = turns[4][1].content as Array<{ type: string; text: string; cacheBreak?: boolean }>;
    expect(parts.map((part) => [part.type, part.cacheBreak === true])).toEqual([["text", true], ["text", false]]);
    expect(parts[0].text).toContain("Loaded files available in full this turn");
    expect(parts[0].text).not.toContain("<current_request");
    expect(parts[1].text.startsWith("<prior_transcript") || parts[1].text.startsWith("<current_request")).toBe(true);
  });
});

describe("Brainstorming, turn after turn about one book", () => {
  const prompts = ["Is the middle of the book too slow?", "What if the ledger were revealed earlier?", "Compare moving the reveal to chapter 5 against chapter 7.", "Which chapters carry the antagonist best?", "What would a stronger midpoint look like?"];

  async function converse(): Promise<Sent[]> {
    captured.brainstorm.length = 0;
    const files: Record<string, string> = { ...seedBookFiles({ chapters: 0 }), "outline/book.md": serializeOutlineBook({ body: `A glassmaker's daughter finds the lie the tide will tell. ${words(120, 1)}` }) };
    for (let n = 1; n <= 12; n += 1) files[`outline/chapters/${String(n).padStart(3, "0")}.md`] = serializeOutlineChapter({ number: n, title: `Chapter ${n} title`, body: words(110, n), origin: "author" });
    captured.store = new MemoryBookStore(files);
    const structure = { title: "The Glass Harbor", language: "en", chapters: [], characters: [], locations: [], factions: [], items: [], timelines: [], ghostwriters: [], readerPersonas: [] } as never;
    const history: AssistantMessage[] = [];
    for (let turn = 0; turn < prompts.length; turn += 1) {
      const message = await runBrainstormPrompt({ prompt: prompts[turn], settings: brainstormSettings, book: glass, branch: "main", structure, history: [...history], accountScope: null });
      history.push({ id: `u${turn}`, role: "user", text: prompts[turn] } as AssistantMessage, message);
    }
    expect(captured.brainstorm).toHaveLength(prompts.length);
    return [...captured.brainstorm];
  }

  it("shares with the turn before it the book and the conversation so far: over 90% of its prompt (29% before), which a provider that caches serves", async () => {
    const turns = await converse();
    for (let turn = 1; turn < turns.length; turn += 1) {
      const { prefix, total, share, served } = shared(turns[turn - 1], turns[turn]);
      expect(share, `turn ${turn + 1}: ${prefix} of ${total} tokens`).toBeGreaterThanOrEqual(0.9);
      expect(served, `turn ${turn + 1}: served from a cache`).toBeGreaterThan(0.85 * total);
    }
  });

  it("asks the request after the book and the conversation, and says where the book ends", async () => {
    const turns = await converse();
    for (const [index, messages] of turns.entries()) {
      const user = textOf(messages[1]);
      expect(user.indexOf("<repository_content")).toBe(0);
      expect(user.indexOf("<current_request")).toBeGreaterThan(user.indexOf("</repository_content>"));
      if (index > 0) expect(user.indexOf("<prior_transcript")).toBeLessThan(user.indexOf("<current_request"));
      expect(user).toContain(prompts[index]);
      const parts = messages[1].content as Array<{ text: string; cacheBreak?: boolean }>;
      expect(parts[0].cacheBreak).toBe(true);
      expect(parts[0].text.endsWith("</repository_content>\n\n")).toBe(true);
    }
  });
});
