import { describe, expect, it, vi } from "vitest";
import { OUTLINE_CHANGES_FILE, parseOutlineJournal, serializeOutlineChapter, sha256Hex, type BookFileChange } from "narrarium-engine";
import { commitWithJournal, withJournal } from "@/outline/outlineJournal";
import type { OutlineSource } from "@/outline/outlineSource";

const entry = (number: number, title: string, body: string) => serializeOutlineChapter({ number, title, body });
const path = (number: number) => `outline/chapters/${String(number).padStart(3, "0")}.md`;

async function filesOf(record: Record<string, string>) {
  return new Map(await Promise.all(Object.entries(record).map(async ([name, content]) => [name, { content, hash: await sha256Hex(content) }] as const)));
}

describe("the journal of the Synopsis in the commits of the app", () => {
  it("adds one series to the commit, with who made it and what happened to each chapter, expecting the journal as it was", async () => {
    const files = await filesOf({ [path(1)]: entry(1, "Arrival", "Mira arrives."), [path(2)]: entry(2, "The key", "Mira finds the key.") });
    const changes: BookFileChange[] = [{ path: path(2), content: entry(2, "The key", "Mira loses the key."), expectedHash: files.get(path(2))!.hash }, { path: path(3), content: entry(3, "The flood", "The harbor floods."), expectedHash: null }];
    const committed = await withJournal(files, changes, { by: "author", language: "it" });
    expect(committed.slice(0, 2)).toEqual(changes);
    expect(committed[2]).toMatchObject({ path: OUTLINE_CHANGES_FILE, expectedHash: null });
    const [series] = parseOutlineJournal(committed[2].content).series;
    expect(series.by).toBe("author");
    expect(series.chapters.map((item) => [item.chapter, item.change, item.summary])).toEqual([[2, "modified", "La voce del capitolo 2 «The key» è cambiata."], [3, "created", "Il capitolo 3 «The flood» è nuovo."]]);

    // The next series expects the journal the first one wrote.
    const after = await filesOf({ [path(1)]: entry(1, "Arrival", "Mira arrives."), [OUTLINE_CHANGES_FILE]: committed[2].content! });
    const next = await withJournal(after, [{ path: path(1), content: null, expectedHash: after.get(path(1))!.hash }], { by: "brainstorming" });
    expect(next[1]).toMatchObject({ path: OUTLINE_CHANGES_FILE, expectedHash: await sha256Hex(committed[2].content!) });
    expect(parseOutlineJournal(next[1].content).series.map((entry) => entry.by)).toEqual(["author", "brainstorming"]);
  });

  it("adds nothing for a commit that changes no chapter's entry", async () => {
    const files = await filesOf({ "outline/book.md": "---\ntype: outline\n---\n\nThe book.\n" });
    const changes: BookFileChange[] = [{ path: "outline/book.md", content: "---\ntype: outline\n---\n\nAnother book.\n", expectedHash: files.get("outline/book.md")!.hash }];
    expect(await withJournal(files, changes, { by: "author" })).toEqual(changes);
  });

  it("reads the files of the commit and the journal as they are, then commits them together", async () => {
    const stored = new Map([[path(4), entry(4, "Four", "The fourth.")]]);
    const commit = vi.fn(async () => undefined);
    const source: OutlineSource = {
      files: async () => Promise.all([...stored].map(async ([name, content]) => ({ path: name, content, hash: await sha256Hex(content) }))),
      commit,
      readState: async () => null,
      readFiles: async () => [],
    };
    await commitWithJournal(source, [{ path: path(4), content: null, expectedHash: await sha256Hex(stored.get(path(4))!) }], "Outline: delete chapter 4", { by: "author" });
    const [changes, message] = commit.mock.calls[0] as unknown as [BookFileChange[], string];
    expect(message).toBe("Outline: delete chapter 4");
    expect(changes.map((change) => change.path)).toEqual([path(4), OUTLINE_CHANGES_FILE]);
    expect(parseOutlineJournal(changes[1].content).series[0].chapters.map((item) => [item.chapter, item.change, item.title])).toEqual([[4, "removed", "Four"]]);
  });
});
