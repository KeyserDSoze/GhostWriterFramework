import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import { mutateTextFilesAtomically } from "@/github/githubClient";
import { getLocalFile, putLocalRepository, writeLocalText } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";

beforeEach(async () => {
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
  indexedDB.deleteDatabase("narrarium-local-repositories");
});

it("rejects all related local writes when one expected hash is stale", async () => {
  const meta = await putLocalRepository({ bookId: crypto.randomUUID(), owner: "owner", repo: "repo", branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
  const first = await writeLocalText(meta.id, "draft.md", "draft");
  const second = await writeLocalText(meta.id, "final.md", "final");

  await expect(mutateTextFilesAtomically("token", "owner", "repo", "main", [
    { path: "draft.md", content: "next draft", expectedCurrentHash: first.currentHash },
    { path: "final.md", content: "next final", expectedCurrentHash: "stale" },
  ], "swap")).rejects.toThrow("File changed since");

  expect((await getLocalFile(meta.id, "draft.md"))?.text).toBe("draft");
  expect((await getLocalFile(meta.id, "final.md"))?.text).toBe("final");
  expect(second.currentHash).toBeTruthy();
});
