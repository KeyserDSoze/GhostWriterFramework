import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { appendAssistantNote } from "@/assistant/service";
import { getLocalFile, putCleanLocalFile, putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const owner = "note-race-owner";
const repo = "note-race-repo";
const branch = "note-race-branch";
let repositoryId = "";

afterEach(async () => {
  if (repositoryId) await removeLocalRepository(repositoryId, captureRepositoryOperationScope());
  repositoryId = "";
});

describe("local chat note append", () => {
  it("retries an expected-hash conflict so concurrent appends are both retained exactly once", async () => {
    const repository = await putLocalRepository({
      bookId: "book-1",
      owner,
      repo,
      branch,
      defaultBranch: "main",
      remoteHeadSha: "remote-head",
      clonedAt: new Date().toISOString(),
      lastFetchAt: new Date().toISOString(),
      cloneComplete: true,
    }, captureRepositoryOperationScope());
    repositoryId = repository.id;
    const initial = "---\ntype: note\nid: note:book:notes\ntitle: Notes\n---\n# Notes\n";
    await putCleanLocalFile({ repoId: repository.id, path: "notes.md", kind: "text", text: initial, baseSha: "remote-notes", size: initial.length });

    await Promise.all([
      appendAssistantNote({ token: "unused", owner, repo, branch, path: "notes.md", noteBody: "First concurrent note", idempotencyKey: "append-first" }),
      appendAssistantNote({ token: "unused", owner, repo, branch, path: "notes.md", noteBody: "Second concurrent note", idempotencyKey: "append-second" }),
    ]);

    const saved = await getLocalFile(repository.id, "notes.md");
    expect(saved?.text?.match(/narrarium-chat-note:append-first/g)).toHaveLength(1);
    expect(saved?.text?.match(/narrarium-chat-note:append-second/g)).toHaveLength(1);
    expect(saved?.text).toContain("First concurrent note");
    expect(saved?.text).toContain("Second concurrent note");
  });
});
