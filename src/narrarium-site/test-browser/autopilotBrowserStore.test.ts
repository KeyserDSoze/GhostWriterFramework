import "fake-indexeddb/auto";
import { afterEach, expect, test } from "vitest";
import { AutopilotSession, BookConflictError, askDirector, listDirectorOpinions, parseMarkdown } from "narrarium-engine";
import { createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import { LocalWorkingCopyMissingError, createBrowserBookStore } from "@/autopilot/browserStore";
import { getLocalFile, listUnpushedLocalCommits, putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import type { BookEntry } from "@/types/settings";
import { putCleanLocalFile } from "./helpers/localRepositorySeed";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const book: BookEntry = { id: "book-autopilot", owner: "owner", repo: "autopilot", name: "The Glass Harbor", tokenIndex: null, addedAt: "2026-11-21T00:00:00.000Z" };
let repoId = "";

afterEach(async () => {
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

async function seedWorkingCopy(): Promise<string> {
  const repo = await putLocalRepository({ bookId: book.id, owner: book.owner, repo: book.repo, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: "2026-11-21T00:00:00.000Z", cloneComplete: true }, captureRepositoryOperationScope());
  for (const [path, text] of Object.entries(seedBookFiles())) {
    await putCleanLocalFile({ repoId: repo.id, path, kind: "text", text, size: new TextEncoder().encode(text).length });
  }
  repoId = repo.id;
  return repo.id;
}

test("the shared autopilot writes a book into the browser working copy as local commits", async () => {
  const id = await seedWorkingCopy();
  const store = createBrowserBookStore(book, "main");
  const ai = createFakeAutopilotAi();
  const session = new AutopilotSession({ bookId: book.id, store, ai, host: "browser", hostLabel: "Browser · test", hostId: "device-test", retryDelayMs: 0 });
  await session.start({ brief: { idea: "A harbor built on glass hides a lie.", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
  await session.waitForIdle();

  const snapshot = await session.snapshot();
  expect(snapshot.state?.status).toBe("completed");
  expect(snapshot.state?.runner).toBeNull();
  const scene = await getLocalFile(id, "chapters/001-chapter-title-1/001-scene-1-title.md", captureRepositoryOperationScope());
  expect(parseMarkdown(scene?.text ?? "").frontmatter.type).toBe("paragraph");
  expect(parseMarkdown(scene?.text ?? "").body.length).toBeGreaterThan(200);
  const opinion = await getLocalFile(id, "evaluations/director/chapters/001-chapter-title-1.md", captureRepositoryOperationScope());
  expect(parseMarkdown(opinion?.text ?? "").frontmatter.source).toBe("autopilot");

  const commits = await listUnpushedLocalCommits(id);
  expect(commits).toHaveLength(1);
  expect(commits[0].message).toMatch(/^Autopilot: /);
  expect(commits[0].files.map((file) => file.path)).toEqual(expect.arrayContaining(["autopilot/state.json", "chapters/001-chapter-title-1/001-scene-1-title.md"]));
});

test("asking the director on demand keeps the opinion in the working copy", async () => {
  await seedWorkingCopy();
  const store = createBrowserBookStore(book, "main");
  const result = await askDirector({ store, ai: createFakeAutopilotAi(), target: { kind: "book" }, question: "Does the premise hold?", save: true });
  expect(result.opinion.answer).toBe("Yes, keep it.");
  const opinions = await listDirectorOpinions(store);
  expect(opinions.map((entry) => [entry.path, entry.question])).toEqual([["evaluations/director/book.md", "Does the premise hold?"]]);
});

test("author edits win over stale autopilot writes, and a missing working copy is explained", async () => {
  await seedWorkingCopy();
  const store = createBrowserBookStore(book, "main");
  const original = await store.read("plot.md");
  expect(original).not.toBeNull();
  await store.commit([{ path: "plot.md", content: "The author's plot.", expectedHash: original!.hash }], "Author edit");
  await expect(store.commit([{ path: "plot.md", content: "stale", expectedHash: original!.hash }], "Stale")).rejects.toBeInstanceOf(BookConflictError);
  expect((await store.read("plot.md"))?.content).toBe("The author's plot.");
  await expect(createBrowserBookStore({ ...book, id: "another-book" }, "main").list()).rejects.toBeInstanceOf(LocalWorkingCopyMissingError);
});
