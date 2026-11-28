import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinWildcards } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({ store: null as unknown, consult: vi.fn(), room: vi.fn() }));
vi.mock("@/autopilot/browserStore", () => ({ createBrowserBookStore: () => mocks.store }));
vi.mock("@/wildcards/roomRunner", () => ({ consultBookRoom: mocks.consult }));
vi.mock("@/wildcards/wildcardFiles", () => ({ loadWildcardRoom: mocks.room }));

import { askWildcardsFromPrompt, voicesOfPrompt } from "@/wildcards/copilotRoom";
import { useWildcardsDialogStore } from "@/store/wildcardsDialogStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

// «What do the provocateurs think of this chapter?»: the Copilot asks the room the request names about the chapter or the scene it is on; the answer shows
// the voices as their own characters, and the table of the ideas opens, where the author accepts or skips them.

const room = builtinWildcards("en");
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "r", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-28T00:00:00.000Z" };
const voice = (slug: string) => {
  const persona = room.find((profile) => profile.slug === slug)!;
  return { persona: { id: persona.id, slug, name: persona.name, group: persona.group }, status: "ok", ideas: [{ id: `idea-${slug}`, kind: "idea", persona: { id: persona.id, slug, name: persona.name, group: persona.group }, title: `${persona.name} 1`, idea: "An idea.", why: "w", changes: { chapters: [1], secrets: [], summary: "s" }, risk: "r", audacity: 6, advisory: true }], invalid: 0, omitted: 0, truncated: false, repaired: false };
};

beforeEach(() => {
  mocks.store = new MemoryBookStore({
    "book.md": "---\ntype: book\ntitle: The Glass Harbor\nlanguage: en\n---\n",
    "chapters/001-arrival/chapter.md": "---\ntype: chapter\nnumber: 1\ntitle: Arrival\n---\n",
    "chapters/001-arrival/001-quay.md": "---\ntype: paragraph\nnumber: 1\ntitle: Quay\n---\n\nThe quay shone.\n",
  });
  mocks.room.mockReset().mockResolvedValue({ room, book: [], account: [] });
  mocks.consult.mockReset().mockImplementation(async (input: { target: unknown }) => {
    const voices = ["subversive", "poet"].map(voice);
    return { consultation: "room-1", target: { ...(input.target as object), label: "Chapter 1: Arrival" }, voices, ideas: voices.flatMap((entry) => entry.ideas), voicesOmitted: 0, cost: 0, capped: false, entry: { id: "room-1", at: "2026-11-28T00:00:00.000Z", by: "copilot", target: input.target, voices: ["subversive", "poet"], ideas: [] }, asked: [], warnings: [] };
  });
  useWildcardsDialogStore.setState({ request: null });
});

describe("the Copilot asks the room", () => {
  it("hears the voices a request names: wildcards by name, a pre-mortem, the sentinels, else the creative room", () => {
    expect(voicesOfPrompt("What do the provocateurs think of this chapter?", room)).toEqual({ preset: "creative-room" });
    expect(voicesOfPrompt("Cosa pensano le sentinelle di questo capitolo?", room)).toEqual({ preset: "quality-check" });
    expect(voicesOfPrompt("Run a pre-mortem on this scene", room)).toEqual({ preset: "pre-mortem" });
    expect(voicesOfPrompt("What would the Poet and the Antagonist change?", room)).toEqual({ voices: ["antagonist", "poet"] });
  });

  it("asks about the scene the request is on, answers with each voice as its own character, and opens the table of the ideas", async () => {
    const message = await askWildcardsFromPrompt({ prompt: "What do the provocateurs think of this scene?", settings: DEFAULT_SETTINGS, book: BOOK, branch: "main", structure: null, token: "t", accountScope: "workspace:e2e", chapterSlug: "001-arrival", paragraphSlug: "001-quay" });
    expect(mocks.consult).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "paragraph", chapter: 1, paragraph: 1 }, preset: "creative-room", by: "copilot", question: "What do the provocateurs think of this scene?", accountScope: "workspace:e2e" }));
    expect(message.text).toMatch(/^\*\*The room \(Fuori dal coro\): 2 voices\*\*/);
    expect(message.text).toContain("> **The Subversive** · provocateur");
    expect(message.text).toContain("The ideas are also in the table that opened");
    expect(message.action).toBeUndefined();
    const request = useWildcardsDialogStore.getState().request;
    expect(request).toMatchObject({ bookId: "book-1", target: { kind: "paragraph", chapter: "001-arrival", paragraph: "001-quay" }, question: "What do the provocateurs think of this scene?" });
    expect(request?.result?.ideas).toHaveLength(2);
  });

  it("asks for a chapter or a scene when the request is about neither", async () => {
    const message = await askWildcardsFromPrompt({ prompt: "What do the provocateurs think?", settings: DEFAULT_SETTINGS, book: BOOK, branch: "main", structure: null, token: "t", accountScope: null });
    expect(message.text).toMatch(/Open a chapter or a scene/);
    expect(mocks.consult).not.toHaveBeenCalled();
    expect(useWildcardsDialogStore.getState().request).toBeNull();
  });
});
