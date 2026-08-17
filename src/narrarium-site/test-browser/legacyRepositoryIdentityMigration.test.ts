import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";

const octokit = vi.hoisted(() => ({
  getRepo: vi.fn(),
  getRef: vi.fn(),
  getTree: vi.fn(),
  getBlob: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git: octokit, repos: { get: octokit.getRepo } }; } }));

const DB_NAME = "narrarium-local-repositories";
const email = "writer@example.com";
const legacyScope = `google:${email}`;

function open(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      const repositories = db.createObjectStore("repositories", { keyPath: "id" });
      repositories.createIndex("bookId", "bookId", { unique: false });
      repositories.createIndex("remote", ["owner", "repo", "branch"], { unique: false });
      const files = db.createObjectStore("files", { keyPath: "key" });
      files.createIndex("repoId", "repoId", { unique: false });
      files.createIndex("repoStatus", ["repoId", "status"], { unique: false });
      const commits = db.createObjectStore("commits", { keyPath: "id" });
      commits.createIndex("repoId", "repoId", { unique: false });
      const logs = db.createObjectStore("logs", { keyPath: "id" });
      logs.createIndex("repoId", "repoId", { unique: false });
    };
  });
}

async function seedLegacy(db: IDBDatabase, bookId: string, repo: string): Promise<string> {
  const id = `${legacyScope}::owner/${repo}#main`;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["repositories", "files", "commits", "logs"], "readwrite");
    const now = new Date().toISOString();
    tx.objectStore("repositories").put({ id, bookId, owner: "owner", repo, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: now, updatedAt: now, cloneComplete: true, accountScope: legacyScope });
    tx.objectStore("files").put({ key: `${id}::book.md`, repoId: id, path: "book.md", kind: "text", text: "---\ntitle: Existing Book\n---\nLocal prose", baseSha: "blob", baseHash: "hash", currentHash: "hash", status: "clean", committed: false, size: 50, updatedAt: now });
    tx.objectStore("commits").put({ id: `${bookId}-commit`, repoId: id, message: "Local work", createdAt: now, files: [], pushed: false });
    tx.objectStore("logs").put({ id: `${bookId}-log`, repoId: id, kind: "clone", message: "Legacy clone", createdAt: now });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return id;
}

async function seedImmutableTarget(db: IDBDatabase, bookId: string, repo: string, dirty = false): Promise<string> {
  const id = `google:sub-a::owner/${repo}#main`;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["repositories", "files"], "readwrite");
    const now = new Date().toISOString();
    tx.objectStore("repositories").put({ id, bookId, owner: "owner", repo, branch: "main", defaultBranch: "main", remoteHeadSha: "new-head", clonedAt: now, updatedAt: now, cloneComplete: !dirty, accountScope: "google:sub-a" });
    tx.objectStore("files").put({ key: `${id}::book.md`, repoId: id, path: "book.md", kind: "text", text: dirty ? "user edit" : "remote", baseSha: "new-blob", baseHash: dirty ? "base" : "mirror", currentHash: dirty ? "changed" : "mirror", status: dirty ? "modified" : "clean", committed: false, size: 8, updatedAt: now });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return id;
}

async function freshStrandedProof(user: { provider: "google"; providerAccountId: string; name: string; email: string; picture: string }): Promise<void> {
  const { beginStrandedLegacyRecovery } = await import("@/auth/accountIdentity");
  const { useAuthStore } = await import("@/store/authStore");
  beginStrandedLegacyRecovery(user, legacyScope);
  useAuthStore.getState().setInteractiveAuth("fresh-token", user);
}

async function seedLegacyRewrite(operationId: string, bookId: string, repo: string, repoId: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("narrarium-local-rewrite-operations");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("rewriteOperations", { keyPath: "operationId" });
      store.createIndex("repoKey", "repoKey", { unique: false });
      store.createIndex("bookId", "bookId", { unique: false });
      store.createIndex("repoTargetKey", ["repoKey", "targetKey"], { unique: false });
    };
  });
  const now = new Date().toISOString();
  await new Promise<void>((resolve, reject) => {
    const storeName = db.objectStoreNames.contains("rewriteOperationsV3") ? "rewriteOperationsV3" : "rewriteOperations";
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put({ storageId: `${encodeURIComponent(repoId)}::${operationId}`, operationId, operation: "rewriteFromReaderFeedback", scope: "chapter", bookId, chapterId: "chapter", paragraphIds: [], startedAt: now, completedAt: null, status: "preparing", createdAt: now, updatedAt: now, repoId, owner: "owner", repo, branch: "main", chapterSlug: "chapter", targetIds: [], feedbackMode: "summary", feedbackPath: "feedback.md", feedbackSummaryPath: "feedback.md", feedbackSourceHash: "hash", staleFeedback: false, progress: { completed: 0, total: 0 }, modifiedFiles: [], generationRuns: [], aggregateInputTokens: 0, aggregateCachedInputTokens: 0, aggregateOutputTokens: 0, aggregateCost: 0, conflicts: [], repoKey: `owner/${repo}#main`, targetKey: "chapter:chapter" });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe.sequential("pre-0.76.38 repository identity migration", () => {
  let useAuthStore: typeof import("@/store/authStore").useAuthStore;
  let ensureLocalBookStructure: typeof import("@/repository/repositoryService").ensureLocalBookStructure;
  let getLocalFile: typeof import("@/repository/localRepository").getLocalFile;
  let getLocalRepositoryById: typeof import("@/repository/localRepository").getLocalRepositoryById;
  let listUnpushedLocalCommits: typeof import("@/repository/localRepository").listUnpushedLocalCommits;

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const legacyDb = await open(4);
    await seedLegacy(legacyDb, "legacy-book", "legacy-repo");
    legacyDb.close();
    ({ useAuthStore } = await import("@/store/authStore"));
    ({ ensureLocalBookStructure } = await import("@/repository/repositoryService"));
    ({ getLocalFile, getLocalRepositoryById, listUnpushedLocalCommits } = await import("@/repository/localRepository"));
  });

  it("upgrades and atomically adopts the same email account without a blob fetch", async () => {
    const legacyUser = { provider: "google" as const, name: "Writer", email, picture: "" };
    useAuthStore.setState({ user: legacyUser });
    const { beginLegacyAccountUpgrade } = await import("@/auth/accountIdentity");
    beginLegacyAccountUpgrade(legacyUser);
    useAuthStore.getState().setInteractiveAuth("token", { ...legacyUser, providerAccountId: "sub-a" });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const first = ensureLocalBookStructure({ bookId: "legacy-book", book: { id: "legacy-book", owner: "owner", repo: "legacy-repo" } as never, token: "token", accountIdentity: "google:sub-a", branch: "main" });
    const second = ensureLocalBookStructure({ bookId: "legacy-book", book: { id: "legacy-book", owner: "owner", repo: "legacy-repo" } as never, token: "token", accountIdentity: "google:sub-a", branch: "main" });
    const [adopted, concurrent] = await Promise.all([first, second]);

    const id = "google:sub-a::owner/legacy-repo#main";
    expect(adopted.meta).toMatchObject({ id, accountScope: "google:sub-a", cloneComplete: true });
    expect(concurrent.meta.id).toBe(id);
    expect(adopted.structure.title).toBe("Existing Book");
    expect(await getLocalFile(id, "book.md", captureRepositoryOperationScope())).toMatchObject({ repoId: id, text: expect.stringContaining("Local prose") });
    expect(await listUnpushedLocalCommits(id)).toHaveLength(1);
    expect(await getLocalRepositoryById(`${legacyScope}::owner/legacy-repo#main`, "google:sub-a")).toBeNull();
    expect(octokit.getRepo).not.toHaveBeenCalled();
    expect(octokit.getBlob).not.toHaveBeenCalled();
  });

  it("preserves and blocks an email-scoped copy for a different immutable subject", async () => {
    const db = await open();
    const oldId = await seedLegacy(db, "isolated-book", "isolated-repo");
    db.close();
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-b", name: "Other", email, picture: "" } });

    await expect(ensureLocalBookStructure({ bookId: "isolated-book", book: { id: "isolated-book", owner: "owner", repo: "isolated-repo" } as never, token: "token", accountIdentity: "google:sub-b", branch: "main" }))
      .rejects.toMatchObject({ code: "LEGACY_REPOSITORY_MIGRATION_REQUIRED" });
    const raw = await open();
    const preserved = await new Promise<unknown>((resolve, reject) => {
      const request = raw.transaction("repositories").objectStore("repositories").get(oldId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    raw.close();
    expect(preserved).toBeTruthy();
    expect(octokit.getRepo).not.toHaveBeenCalled();
  });

  it("recovers the production-stranded immutable session only after fresh interactive reauth", async () => {
    const db = await open();
    await seedLegacy(db, "stranded-book", "stranded-repo");
    db.close();
    const user = { provider: "google" as const, providerAccountId: "sub-a", name: "Writer", email, picture: "" };
    useAuthStore.setState({ user, accessToken: "persisted" });
    const input = { bookId: "stranded-book", book: { id: "stranded-book", owner: "owner", repo: "stranded-repo" } as never, token: "token", accountIdentity: "google:sub-a", branch: "main" };
    await expect(ensureLocalBookStructure(input)).rejects.toThrow("Fresh interactive sign-in");
    await freshStrandedProof(user);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await expect(ensureLocalBookStructure(input)).resolves.toMatchObject({ meta: { accountScope: "google:sub-a" }, structure: { title: "Existing Book" } });
    expect(octokit.getBlob).not.toHaveBeenCalled();
  });

  it("replaces only a disposable competing immutable clone", async () => {
    const db = await open();
    await seedLegacy(db, "replace-book", "replace-repo");
    const targetId = await seedImmutableTarget(db, "replace-book", "replace-repo");
    db.close();
    const user = { provider: "google" as const, providerAccountId: "sub-a", name: "Writer", email, picture: "" };
    useAuthStore.setState({ user });
    await freshStrandedProof(user);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await expect(ensureLocalBookStructure({ bookId: "replace-book", book: { id: "replace-book", owner: "owner", repo: "replace-repo" } as never, token: "token", accountIdentity: "google:sub-a", branch: "main" })).resolves.toMatchObject({ structure: { title: "Existing Book" } });
    expect(await getLocalFile(targetId, "book.md", captureRepositoryOperationScope())).toMatchObject({ text: expect.stringContaining("Local prose") });
    expect(octokit.getBlob).not.toHaveBeenCalled();
  });

  it("preserves both copies when the immutable target is non-disposable", async () => {
    const db = await open();
    const legacyId = await seedLegacy(db, "blocked-book", "blocked-repo");
    const targetId = await seedImmutableTarget(db, "blocked-book", "blocked-repo", true);
    db.close();
    const user = { provider: "google" as const, providerAccountId: "sub-a", name: "Writer", email, picture: "" };
    useAuthStore.setState({ user });
    await freshStrandedProof(user);
    vi.spyOn(window, "confirm");
    await expect(ensureLocalBookStructure({ bookId: "blocked-book", book: { id: "blocked-book", owner: "owner", repo: "blocked-repo" } as never, token: "token", accountIdentity: "google:sub-a", branch: "main" })).rejects.toThrow("preserved both");
    expect(await getLocalFile(targetId, "book.md", captureRepositoryOperationScope())).toMatchObject({ text: "user edit" });
    const raw = await open();
    const legacy = await new Promise((resolve) => { const request = raw.transaction("repositories").objectStore("repositories").get(legacyId); request.onsuccess = () => resolve(request.result); });
    raw.close();
    expect(legacy).toBeTruthy();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("decline leaves proof and data retryable", async () => {
    const db = await open(); await seedLegacy(db, "decline-book", "decline-repo"); db.close();
    const user = { provider: "google" as const, providerAccountId: "sub-a", name: "Writer", email, picture: "" };
    useAuthStore.setState({ user }); await freshStrandedProof(user);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const input = { bookId: "decline-book", book: { id: "decline-book", owner: "owner", repo: "decline-repo" } as never, token: "token", accountIdentity: "google:sub-a", branch: "main" };
    await expect(ensureLocalBookStructure(input)).rejects.toThrow("declined");
    await expect(ensureLocalBookStructure(input)).resolves.toMatchObject({ structure: { title: "Existing Book" } });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("keeps completion progress through the final lifecycle transaction", async () => {
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-c", name: "New", email: "new@example.com", picture: "" } });
    octokit.getRepo.mockResolvedValue({ data: { default_branch: "main" } });
    octokit.getRef.mockResolvedValue({ data: { object: { sha: "head" } } });
    octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [] } });
    const progress: Array<{ phase?: string; done: number; total: number }> = [];
    const result = await ensureLocalBookStructure({ bookId: "new-book", book: { id: "new-book", owner: "owner", repo: "new-repo" } as never, token: "token", accountIdentity: "google:sub-c", branch: "main", onProgress: (value) => progress.push(value) });
    expect(progress[progress.length - 1]).toEqual({ done: 0, total: 0, phase: "finalizing" });
    expect(result.meta).toMatchObject({ cloneComplete: true, cloneStatus: "complete" });
  });

  it.each(["journal", "rewrite-prepared", "primary-rekeyed", "rewrite-finalized"] as const)("resumes idempotently after a crash following %s", async (phase) => {
    const suffix = phase.replace(/-/g, "");
    const bookId = `crash-${suffix}`;
    const repo = `crash-${suffix}`;
    const db = await open();
    await seedLegacy(db, bookId, repo);
    db.close();
    const legacyUser = { provider: "google" as const, name: "Writer", email, picture: "" };
    const { beginLegacyAccountUpgrade } = await import("@/auth/accountIdentity");
    const { crashNextRepositoryMigrationForTests } = await import("@/repository/localRepository");
    beginLegacyAccountUpgrade(legacyUser);
    useAuthStore.getState().setInteractiveAuth("token", { ...legacyUser, providerAccountId: "sub-a" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    crashNextRepositoryMigrationForTests(phase);
    const input = { bookId, book: { id: bookId, owner: "owner", repo } as never, token: "token", accountIdentity: "google:sub-a", branch: "main" };
    await expect(ensureLocalBookStructure(input)).rejects.toThrow("Simulated repository migration crash");
    await expect(ensureLocalBookStructure(input)).resolves.toMatchObject({ meta: { id: `google:sub-a::owner/${repo}#main`, accountScope: "google:sub-a" } });
    expect(octokit.getBlob).not.toHaveBeenCalled();
  });

  it("blocks split rewrite visibility and restores legacy unscoped operations after resume", async () => {
    const bookId = "rewrite-crash";
    const repo = "rewrite-crash";
    const db = await open();
    const oldRepoId = await seedLegacy(db, bookId, repo);
    db.close();
    const operationId = crypto.randomUUID();
    await seedLegacyRewrite(operationId, bookId, repo, oldRepoId);
    const legacyUser = { provider: "google" as const, name: "Writer", email, picture: "" };
    const { beginLegacyAccountUpgrade } = await import("@/auth/accountIdentity");
    const { crashNextRepositoryMigrationForTests } = await import("@/repository/localRepository");
    const { loadLocalRewriteOperation } = await import("@/repository/localRewriteOperationStore");
    const { captureRepositoryOperationScope } = await import("@/repository/repositoryOperationScope");
    beginLegacyAccountUpgrade(legacyUser);
    useAuthStore.getState().setInteractiveAuth("token", { ...legacyUser, providerAccountId: "sub-a" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    crashNextRepositoryMigrationForTests("primary-rekeyed");
    const input = { bookId, book: { id: bookId, owner: "owner", repo } as never, token: "token", accountIdentity: "google:sub-a", branch: "main" };
    await expect(ensureLocalBookStructure(input)).rejects.toThrow("Simulated repository migration crash");
    const newRepoId = `google:sub-a::owner/${repo}#main`;
    await expect(loadLocalRewriteOperation(operationId, newRepoId, captureRepositoryOperationScope())).rejects.toThrow("migration is incomplete");
    await ensureLocalBookStructure(input);
    await expect(loadLocalRewriteOperation(operationId, newRepoId, captureRepositoryOperationScope())).resolves.toMatchObject({ operationId, repoId: newRepoId });
  });

  it("fails closed on rewrite operation ID collision and preserves both records", async () => {
    const bookId = "collision-book";
    const repo = "collision-repo";
    const db = await open();
    const oldRepoId = await seedLegacy(db, bookId, repo);
    const newRepoId = await seedImmutableTarget(db, bookId, repo);
    db.close();
    const operationId = crypto.randomUUID();
    await seedLegacyRewrite(operationId, bookId, repo, oldRepoId);
    const { saveLocalRewriteOperation, loadLocalRewriteOperation } = await import("@/repository/localRewriteOperationStore");
    const { captureRepositoryOperationScope } = await import("@/repository/repositoryOperationScope");
    const user = { provider: "google" as const, providerAccountId: "sub-a", name: "Writer", email, picture: "" };
    useAuthStore.setState({ user });
    const now = new Date().toISOString();
    await saveLocalRewriteOperation({ operationId, operation: "rewriteFromReaderFeedback", scope: "chapter", bookId, chapterId: "chapter", paragraphIds: [], startedAt: now, completedAt: null, status: "preparing", createdAt: now, updatedAt: now, repoId: newRepoId, owner: "owner", repo, branch: "main", chapterSlug: "chapter", targetIds: [], feedbackMode: "summary", feedbackPath: "feedback.md", feedbackSummaryPath: "feedback.md", feedbackSourceHash: "hash", staleFeedback: false, progress: { completed: 0, total: 0 }, modifiedFiles: [], generationRuns: [], aggregateInputTokens: 0, aggregateCachedInputTokens: 0, aggregateOutputTokens: 0, aggregateCost: 0, conflicts: [] } as never, captureRepositoryOperationScope());
    await freshStrandedProof(user);
    vi.spyOn(window, "confirm");
    await expect(ensureLocalBookStructure({ bookId, book: { id: bookId, owner: "owner", repo } as never, token: "token", accountIdentity: "google:sub-a", branch: "main" })).rejects.toThrow("Rewrite-operation records");
    await expect(loadLocalRewriteOperation(operationId, newRepoId, captureRepositoryOperationScope())).resolves.toMatchObject({ operationId, repoId: newRepoId });
    expect(window.confirm).not.toHaveBeenCalled();
  });
});
