import "fake-indexeddb/auto";
import { afterEach, expect, test } from "vitest";
import {
  REPOSITORY_DIAGNOSTIC_MAX_BYTES,
  REPOSITORY_DIAGNOSTIC_MAX_RECORDS,
  getLocalRepositoryById,
  listRepositoryDiagnostics,
  listLocalRepoLogs,
  putLocalRepository,
  recordRepositoryDiagnostic,
  addLocalRepoLog,
} from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";

const identity = "google:diagnostics-writer";
const target = { bookId: "diagnostics-book", owner: "owner", repo: "diagnostics-repo", branch: "main" };
let repoId = "";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "diagnostics-writer", name: "Writer", email: "writer@example.com", picture: "" } });

afterEach(async () => {
  if (repoId) {
    const scope = captureRepositoryOperationScope();
    const repository = await getLocalRepositoryById(repoId, identity);
    if (repository) {
      const { removeLocalRepository } = await import("@/repository/localRepository");
      await removeLocalRepository(repoId, scope);
    }
  }
  repoId = "";
});

async function setup() {
  const meta = await putLocalRepository({ ...target, defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), cloneComplete: true, cloneStatus: "complete" }, captureRepositoryOperationScope());
  repoId = meta.id;
  return { meta, scope: captureRepositoryOperationScope() };
}

test("creates the versioned diagnostic store and records only safe fields", async () => {
  const { meta, scope } = await setup();
  const secret = "token=ghp_secret email=writer@example.com path=chapters/001-secret.md manuscript=Never persist this prose";
  await recordRepositoryDiagnostic({
    repoId: meta.id,
    scope,
    operationId: "not-a-real-operation-id",
    localInstanceId: meta.localInstanceId,
    operation: "push",
    stage: "push",
    outcome: "failure",
    startedAt: new Date().toISOString(),
    durationMs: 12.7,
    fileCount: 2,
    byteCount: 128,
    error: Object.assign(new Error(secret), { status: 403, response: { data: { message: secret }, headers: { authorization: secret } } }),
    errorOperation: "update",
    commitSha: "not-a-real-sha",
  });

  const records = await listRepositoryDiagnostics(meta.id, meta.localInstanceId, scope);
  expect(records).toHaveLength(1);
  const serialized = JSON.stringify(records[0]);
  expect(serialized).not.toContain("ghp_secret");
  expect(serialized).not.toContain("writer@example.com");
  expect(serialized).not.toContain("chapters/001-secret.md");
  expect(serialized).not.toContain("Never persist this prose");
  expect(records[0]).toMatchObject({ schemaVersion: 1, operation: "push", stage: "push", outcome: "failure", errorKind: "permission-unverified", httpStatus: 403, retryable: true, durationMs: 13, fileCount: 2, byteCount: 128 });
  expect(records[0].operationId).not.toBe("not-a-real-operation-id");
  expect(records[0].commitShaPrefix).toBeUndefined();

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("narrarium-local-repositories");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  expect(db.objectStoreNames.contains("repositoryDiagnostics")).toBe(true);
  expect(db.version).toBeGreaterThanOrEqual(13);
  db.close();
});

test("prunes diagnostics deterministically by record count and bytes", async () => {
  const { meta, scope } = await setup();
  for (let index = 0; index < REPOSITORY_DIAGNOSTIC_MAX_RECORDS + 12; index += 1) {
    await recordRepositoryDiagnostic({
      repoId: meta.id,
      scope,
      operationId: crypto.randomUUID(),
      localInstanceId: meta.localInstanceId,
      operation: "fetch",
      stage: "remote-read",
      outcome: "stage",
      startedAt: new Date(Date.now() - index).toISOString(),
      byteCount: index,
    });
  }
  const records = await listRepositoryDiagnostics(meta.id, meta.localInstanceId, scope);
  expect(records.length).toBeLessThanOrEqual(REPOSITORY_DIAGNOSTIC_MAX_RECORDS);
  expect(records.reduce((sum, record) => sum + new TextEncoder().encode(JSON.stringify(record)).byteLength, 0)).toBeLessThanOrEqual(REPOSITORY_DIAGNOSTIC_MAX_BYTES);
});

test("legacy history is sanitized when written and read", async () => {
  const { meta } = await setup();
  await addLocalRepoLog(meta.id, "error", "token=ghp_secret path=chapters/secret.md manuscript=private prose");
  const logs = await listLocalRepoLogs(meta.id);
  expect(logs[0].message).toBe("Repository operation failed.");
  expect(JSON.stringify(logs)).not.toContain("ghp_secret");
  expect(JSON.stringify(logs)).not.toContain("chapters/secret.md");
});
