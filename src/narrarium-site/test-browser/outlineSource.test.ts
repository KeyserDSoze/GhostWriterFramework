import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { BookConflictError, createAutopilotState, outlineChapterPath, serializeOutlineChapter, sha256Hex } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { LocalWorkingCopyMissingError } from "@/autopilot/browserStore";
import { browserOutlineSource, storeOutlineSource } from "@/outline/outlineSource";
import { listLocalFilesUnder, listUnpushedLocalCommits, putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import type { BookEntry } from "@/types/settings";
import { deleteLocalFile, putCleanLocalFile } from "./helpers/localRepositorySeed";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const book: BookEntry = { id: "book-outline", owner: "owner", repo: "outline", name: "The Glass Harbor", tokenIndex: null, addedAt: "2026-11-21T00:00:00.000Z" };
let repoId = "";

afterEach(async () => {
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

const ENTRY_ONE = serializeOutlineChapter({ number: 1, title: "Wake", body: "Mira wakes.", origin: "author" });
const ENTRY_TWO = serializeOutlineChapter({ number: 2, title: "Key", body: "Mira finds the key.", origin: "author" });

async function seed(files: Record<string, string>): Promise<string> {
  const repo = await putLocalRepository({ bookId: book.id, owner: book.owner, repo: book.repo, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: "2026-11-21T00:00:00.000Z", cloneComplete: true }, captureRepositoryOperationScope());
  for (const [path, text] of Object.entries(files)) await putCleanLocalFile({ repoId: repo.id, path, kind: "text", text, size: new TextEncoder().encode(text).length });
  repoId = repo.id;
  return repo.id;
}

describe("the files of the outline in the local working copy", () => {
  it("are listed by their folder, with their text, without reading the rest of the book", async () => {
    const id = await seed({
      "book.md": "---\ntype: book\n---\n",
      "outline/book.md": "---\ntype: outline\n---\nGlass.",
      [outlineChapterPath(1)]: ENTRY_ONE,
      [outlineChapterPath(2)]: ENTRY_TWO,
      "outlines/notes.md": "not the outline",
      "outline.md": "not the outline either",
      "chapters/001-wake/chapter.md": "---\ntype: chapter\n---\n",
    });
    await deleteLocalFile(id, outlineChapterPath(2));
    const files = await listLocalFilesUnder(id, "outline/", captureRepositoryOperationScope());
    expect(files.map((file) => file.path)).toEqual(["outline/book.md", "outline/chapters/001.md"]);
    expect(files[1].text).toBe(ENTRY_ONE);
  });

  it("are what the page reads, with the hash the working copy keeps", async () => {
    await seed({ [outlineChapterPath(1)]: ENTRY_ONE, "chapters/001-wake/chapter.md": "x" });
    const files = await browserOutlineSource(book, "main").files();
    expect(files).toEqual([{ path: "outline/chapters/001.md", content: ENTRY_ONE, hash: await sha256Hex(ENTRY_ONE) }]);
  });

  it("are saved as one local commit, and never over a version that changed since it was read", async () => {
    const id = await seed({ [outlineChapterPath(1)]: ENTRY_ONE });
    const source = browserOutlineSource(book, "main");
    await source.commit([{ path: outlineChapterPath(2), content: ENTRY_TWO, expectedHash: null }], "Outline: add chapter 2");
    expect((await listUnpushedLocalCommits(id)).map((commit) => commit.message)).toEqual(["Outline: add chapter 2"]);
    await expect(source.commit([{ path: outlineChapterPath(1), content: ENTRY_TWO, expectedHash: "an old version" }], "Outline: stale")).rejects.toBeInstanceOf(BookConflictError);
  });

  it("need the working copy that opening the book prepares", async () => {
    await expect(browserOutlineSource({ ...book, id: "elsewhere" }, "main").files()).rejects.toBeInstanceOf(LocalWorkingCopyMissingError);
  });
});

describe("the plan the page compares the outline with", () => {
  it("is read from the autopilot's state, and is nothing for a book that never started or a state that cannot be read", async () => {
    const state = createAutopilotState(new Date("2026-11-21T00:00:00.000Z"), { idea: "x" });
    state.plan = { chapters: [{ number: 1, title: "Wake", slug: "001-wake", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [] }], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
    expect((await storeOutlineSource(new MemoryBookStore({ "autopilot/state.json": JSON.stringify(state) })).readState())?.plan?.chapters[0].status).toBe("done");
    expect(await storeOutlineSource(new MemoryBookStore({})).readState()).toBeNull();
    expect(await storeOutlineSource(new MemoryBookStore({ "autopilot/state.json": "{ not json" })).readState()).toBeNull();
  });
});
