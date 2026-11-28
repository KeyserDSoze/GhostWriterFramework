import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinWildcards, readOutlineChapter, readWildcardReply, serializeOutlineChapter, loadBookSnapshot } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({ complete: vi.fn(), read: vi.fn(), update: vi.fn() }));
vi.mock("@/assistant/router", () => ({ completeTextRouted: mocks.complete }));
vi.mock("@/github/githubClient", async (original) => ({ ...(await original<typeof import("@/github/githubClient")>()), readFileWithSha: mocks.read, updateFile: mocks.update }));

import { acceptedIdeas, authorDecisions, outlineEntryWithIdeas, readSceneBody, rewriteWithIdeas, writeSceneBody } from "@/wildcards/applyIdeas";
import { DEFAULT_SETTINGS } from "@/types/settings";

// What applying the ideas of the room does: the author's decisions as the journal keeps them, a rewrite by the ghostwriter with the accepted ideas as material,
// and the chapter's entry of the Synopsis with them, the author's entry from then on.

const target = { kind: "chapter" as const, label: "Chapter 1: Arrival", chapter: 1 };
const subversive = builtinWildcards("en").find((profile) => profile.slug === "subversive")!;
const ideas = readWildcardReply({ items: [{ title: "Tell it from the tide", idea: "The tide narrates the night.", why: "w", changes: "c", risk: "r", audacity: 8 }, { title: "Orrin acts", idea: "Orrin has a plan.", why: "w", changes: "c", risk: "r", audacity: 6 }] }, subversive, { target, consultation: "room-x" }).ideas;
const NOW = new Date("2026-11-28T10:00:00.000Z");

beforeEach(() => {
  mocks.complete.mockReset();
  mocks.read.mockReset();
  mocks.update.mockReset();
});

describe("applying the ideas of the room", () => {
  it("turns the author's choices into decisions: accepted is adopted, skipped is rejected, with the reason in the book's language", () => {
    const decisions = authorDecisions({ [ideas[0].id]: "accept", [ideas[1].id]: "skip" }, "it", NOW);
    expect(decisions.get(ideas[0].id)).toEqual({ verdict: "adopted", reason: "Accettata dall'autore nella tabella delle idee.", by: "author", at: NOW.toISOString() });
    expect(decisions.get(ideas[1].id)).toMatchObject({ verdict: "rejected", by: "author" });
    const entry = { id: "room-x", at: NOW.toISOString(), by: "author" as const, target, voices: ["subversive"], ideas: ideas.map((idea, index) => (index === 0 ? { ...idea, decision: decisions.get(idea.id)! } : idea)) };
    expect(acceptedIdeas(entry).map((idea) => idea.title)).toEqual(["Tell it from the tide"]);
  });

  it("adds the accepted ideas to the chapter's entry of the Synopsis, which becomes the author's; a chapter without an entry is left alone", async () => {
    const store = new MemoryBookStore({ "outline/chapters/001.md": serializeOutlineChapter({ number: 1, title: "Arrival", body: "Mira arrives.", origin: "autopilot", digest: "0123456789abcdef" }) });
    const accepted = [{ ...ideas[0], decision: { verdict: "adopted" as const, reason: "Yes.", by: "author" as const, at: NOW.toISOString() } }, { ...ideas[1], decision: { verdict: "adapted" as const, reason: "Smaller.", by: "author" as const, at: NOW.toISOString(), adaptation: "Orrin has half a plan." } }];
    const change = await outlineEntryWithIdeas({ store, chapter: 1, ideas: accepted, language: "en", now: NOW });
    expect(change?.path).toBe("outline/chapters/001.md");
    const { entry } = await readOutlineChapter("outline/chapters/001.md", 1, change!.newText);
    expect(entry.origin).toBe("author");
    expect(entry.digest).toBeUndefined();
    expect(entry.title).toBe("Arrival");
    expect(entry.body).toBe("Mira arrives.\n\nIdeas from the room (Fuori dal coro), accepted on 2026-11-28:\n- Tell it from the tide: The tide narrates the night.\n- Orrin acts: Orrin has half a plan.");
    expect(await outlineEntryWithIdeas({ store, chapter: 2, ideas: accepted, language: "en" })).toBeNull();
  });

  it("asks the ghostwriter for a rewrite with the accepted ideas as material, for the editor's task with the room's label", async () => {
    mocks.complete.mockResolvedValueOnce("```\nThe tide spoke all night.\n```");
    const store = new MemoryBookStore({
      "book.md": "---\ntype: book\ntitle: The Glass Harbor\nlanguage: en\nghostwriter: noir\n---\n",
      "ghostwriters/noir.md": "---\ntype: ghostwriter\nid: ghostwriter:noir\nname: Noir\n---\n\nShort, dark sentences.\n",
      "chapters/001-arrival/chapter.md": "---\ntype: chapter\nnumber: 1\ntitle: Arrival\n---\n",
      "chapters/001-arrival/001-quay.md": "---\ntype: paragraph\nnumber: 1\ntitle: Quay\n---\n\nThe quay shone.\n",
    });
    const snapshot = await loadBookSnapshot(store);
    const chapter = snapshot.chapters[0];
    const text = await rewriteWithIdeas({ settings: DEFAULT_SETTINGS, store, snapshot, chapter, paragraph: chapter.paragraphs[0], text: "The quay shone.", ideas: [{ ...ideas[0], decision: { verdict: "adopted", reason: "Yes.", by: "author", at: NOW.toISOString() } }], language: "en", kind: "paragraph" });
    expect(text).toBe("The tide spoke all night.");
    const [, messages, capability, options] = mocks.complete.mock.calls[0];
    expect(capability).toBe("editor-actions");
    expect(options).toMatchObject({ label: "wildcards:apply" });
    expect(messages[0].content).toContain("Short, dark sentences.");
    expect(messages[0].content).toContain("Never reveal a secret before its time.");
    expect(messages[1].content).toContain("IDEAS ACCEPTED FROM THE ROOM");
    expect(messages[1].content).toContain("Tell it from the tide (The Subversive): The tide narrates the night.");
    expect(messages[1].content).toContain("The quay shone.");
  });

  it("writes a scene's new body over the version it was rewritten from, its frontmatter as it is, and never over a scene changed since", async () => {
    const book = { id: "b", owner: "local", repo: "r", name: "B", tokenIndex: null, storageMode: "local-only" as const, activeBranch: "main", addedAt: "2026-11-28T00:00:00.000Z" };
    mocks.read.mockResolvedValue({ content: "---\ntype: paragraph\ntitle: Quay\nmood: tense\n---\n\nThe quay shone.\n", sha: "v1" });
    expect(await readSceneBody({ token: "t", book, branch: "main", path: "chapters/001-a/001-quay.md" })).toEqual({ body: "The quay shone.", sha: "v1" });
    await writeSceneBody({ token: "t", book, branch: "main", path: "chapters/001-a/001-quay.md", sha: "v1", body: "The tide spoke all night.", message: "Rewrite" });
    const written = mocks.update.mock.calls[0][6] as string;
    expect(written).toMatch(/^---\n[\s\S]*title: Quay[\s\S]*mood: tense[\s\S]*---\n/);
    expect(written).toContain("The tide spoke all night.");
    expect(written).not.toContain("The quay shone.");
    mocks.read.mockResolvedValue({ content: "---\ntype: paragraph\n---\n\nChanged by the author.\n", sha: "v2" });
    await expect(writeSceneBody({ token: "t", book, branch: "main", path: "chapters/001-a/001-quay.md", sha: "v1", body: "x", message: "Rewrite" })).rejects.toThrow(/changed after this rewrite was made/);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
});
