import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { loadLocalRewriteOperation, saveLocalRewriteOperation } from "@/repository/localRewriteOperationStore";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";

function manifest(operationId: string, repoId: string) {
  const now = new Date().toISOString();
  return { operationId, operation: "rewriteFromReaderFeedback", scope: "chapter", bookId: "book", chapterId: "chapter", paragraphIds: [], startedAt: now, completedAt: null, status: "preparing", createdAt: now, updatedAt: now, repoId, owner: "owner", repo: "repo", branch: "main", chapterSlug: "chapter", targetIds: [], feedbackMode: "summary", feedbackPath: "feedback.md", feedbackSummaryPath: "feedback.md", feedbackSourceHash: "hash", staleFeedback: false, progress: { completed: 0, total: 0 }, modifiedFiles: [], generationRuns: [], aggregateInputTokens: 0, aggregateCachedInputTokens: 0, aggregateOutputTokens: 0, aggregateCost: 0, conflicts: [] } as any;
}

test("rewrite operation IDs are bound to account and repository", async () => {
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "A", email: "a@example.com", picture: "" } });
  const scope = captureRepositoryOperationScope();
  const operation = manifest(crypto.randomUUID(), "repo-a");
  await saveLocalRewriteOperation(operation, scope);

  expect(await loadLocalRewriteOperation(operation.operationId, "repo-b", scope)).toBeNull();
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-other", name: "B", email: "b@example.com", picture: "" } });
  await expect(loadLocalRewriteOperation(operation.operationId, "repo-a", scope)).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  await expect(saveLocalRewriteOperation(manifest(operation.operationId, "repo-b"), scope)).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
});
