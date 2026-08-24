import { expect, test, type BrowserContext, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__NARRARIUM_ENABLE_E2E_BRIDGE__ = true; });
});

const ACCOUNT_IDENTITY = "google:e2e-google-user";
const REPO_ID = `${ACCOUNT_IDENTITY}::owner/historical#main`;
const PRIMARY_VERSIONS = [1, 2, 3, 4, 6, 7, 12, 13, 14] as const;
const REWRITE_VERSIONS = [1, 2, 3, 7] as const;
const PRIMARY_STORES = ["commits", "consumedBackupReceipts", "files", "logs", "maintenanceCompletions", "maintenanceFences", "maintenanceTombstones", "migrationJournals", "mutationLeases", "recoveries", "removalJournals", "repositories", "repositoryDiagnostics"];
const REWRITE_STORES = ["maintenanceCompletions", "maintenanceTombstones", "migrationCompletions", "rewriteOperationsV3"];
const HISTORICAL_NOW = "2024-01-01T00:00:00.000Z";
const FOREIGN_REMOVAL_JOURNAL = { repoId: "foreign-repo", journalId: "foreign-removal", accountIdentity: "google:other", bookId: "foreign-book", owner: "foreign", repo: "repository", branch: "main", localInstanceId: "foreign-instance", snapshotDigest: "snapshot", primaryDigest: "primary", rewriteDigest: "rewrite", rewriteSnapshot: "[]", rewriteCount: 0, rewriteRecords: [], receiptId: "foreign-receipt", observedFence: 0, removalFence: 1, recoveriesPreserved: 0, rewriteOperationsRemoved: 0, primaryCounts: { files: 0, commits: 0, recoveries: 0, rewrites: 0 }, recoveryRecords: [], phase: "prepared", createdAt: HISTORICAL_NOW };
const FOREIGN_COMPLETION = { repoId: "foreign-repo", journalId: "foreign-removal", localInstanceId: "foreign-instance", accountIdentity: "google:other", bookId: "foreign-book", owner: "foreign", repo: "repository", branch: "main", receiptId: "foreign-receipt", snapshotDigest: "snapshot", primaryDigest: "primary", rewriteDigest: "rewrite", rewriteCount: 0, rewriteRecords: [], recoveriesPreserved: 0, primaryCounts: { files: 0, commits: 0, recoveries: 0, rewrites: 0 }, recoveryRecords: [], rewriteCompleted: true, phase: "finalized", completedAt: HISTORICAL_NOW };
const FOREIGN_TOMBSTONE = { repoId: "foreign-repo", journalId: "foreign-tombstone", localInstanceId: "foreign-instance", accountIdentity: "google:other", bookId: "foreign-book", owner: "foreign", repo: "repository", branch: "main", fence: 1, createdAt: HISTORICAL_NOW };
const FOREIGN_MIGRATION = { id: "foreign-migration", oldRepoId: "old", newRepoId: "new", bookId: "foreign-book", owner: "foreign", repo: "repository", branch: "main", legacyAccountIdentity: "google:legacy-other", immutableAccountIdentity: "google:other", phase: "prepared", createdAt: HISTORICAL_NOW };
const FOREIGN_RECEIPT = { receiptId: "historical-receipt", repoId: "foreign-repo" };
const FOREIGN_FENCE = { repoId: "foreign-repo", fence: 1 };
const FOREIGN_LEASE = { repoId: "foreign-repo", ownerInstanceNonce: "historical-owner", acquiredAt: HISTORICAL_NOW, heartbeatAt: HISTORICAL_NOW, expiresAt: "2024-01-01T00:01:00.000Z", fence: 1 };
const HISTORICAL_COMMIT = { id: "historical-commit", repoId: REPO_ID, message: "Historical local work", createdAt: HISTORICAL_NOW, files: [], pushed: false };

function expectedPrimaryRepository(version: number, id = version < 6 ? "owner/historical#main" : REPO_ID, generatedInstanceId = "historical-local-instance"): Record<string, unknown> {
  return { id, localInstanceId: generatedInstanceId, bookId: "historical-book", owner: "owner", repo: "historical", branch: "main", defaultBranch: "main", remoteHeadSha: "historical-head", clonedAt: HISTORICAL_NOW, updatedAt: HISTORICAL_NOW, ...(version >= 6 ? { cloneComplete: true, accountScope: ACCOUNT_IDENTITY } : {}) };
}

function expectedPrimaryFile(version: number, id = version < 6 ? "owner/historical#main" : REPO_ID): Record<string, unknown> {
  return { key: `${id}::book.md`, repoId: id, path: "book.md", kind: "text", text: "historical prose", baseSha: "historical-blob", currentHash: "historical-hash", status: "clean", size: 16, updatedAt: HISTORICAL_NOW, ...(version >= 2 ? { committed: false } : {}), ...(version >= 3 ? { baseHash: "historical-hash" } : {}) };
}

function expectExactKeys(record: Record<string, unknown>, keys: string[]): void {
  expect(Object.keys(record).sort()).toEqual([...keys].sort());
}

function expectUuid(value: unknown): asserts value is string {
  expect(value).toEqual(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
}

function expectSha256(value: unknown): asserts value is string {
  expect(value).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/i));
}

function expectIsoTimestamp(value: unknown): asserts value is string {
  expect(value).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/));
}

function expectedRewriteRecord(version: number): Record<string, unknown> {
  const repoId = version === 1 ? "owner/historical#main" : REPO_ID;
  return {
    schemaVersion: 1,
    operationId: "historical-rewrite",
    operation: "rewriteFromReaderFeedback",
    scope: "chapter",
    bookId: "historical-book",
    chapterId: "001",
    paragraphIds: [],
    startedAt: HISTORICAL_NOW,
    completedAt: null,
    status: "preparing",
    createdAt: HISTORICAL_NOW,
    updatedAt: HISTORICAL_NOW,
    repoId,
    owner: "owner",
    repo: "historical",
    branch: "main",
    chapterSlug: "001",
    targetIds: [],
    feedbackMode: "panel-summary",
    feedbackPath: "feedback.md",
    feedbackSummaryPath: "feedback.md",
    feedbackSourceHash: "hash",
    staleFeedback: false,
    progress: { completed: 0, total: 0 },
    modifiedFiles: [],
    generationRuns: [],
    aggregateInputTokens: 0,
    aggregateCachedInputTokens: 0,
    aggregateOutputTokens: 0,
    aggregateCost: 0,
    conflicts: [],
    repoKey: "owner/historical#main",
    targetKey: "chapter:001",
    storageId: `${encodeURIComponent(repoId)}::historical-rewrite`,
    ...(version >= 2 ? { accountIdentity: ACCOUNT_IDENTITY } : {}),
    ...(version >= 2 ? { localInstanceId: "historical-local-instance" } : {}),
    ...(version === 1 ? { legacyUnresolved: true, quarantineReason: "legacyRepository" } : {}),
  };
}

function expectedLegacyRewriteRecord(version: 1 | 2): Record<string, unknown> {
  const current = expectedRewriteRecord(version);
  return Object.fromEntries(Object.entries(current).filter(([key]) => !["storageId", "localInstanceId", "legacyUnresolved", "quarantineReason"].includes(key)));
}

function storeCounts(records: Record<string, unknown[]>): Record<string, number> {
  return Object.fromEntries(Object.entries(records).map(([store, rows]) => [store, rows.length]));
}

function stableSnapshot(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSnapshot).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableSnapshot(item)}`).join(",")}}`;
}

async function openFixturePage(page: Page): Promise<void> {
  await page.route("**/__e2e-indexeddb-fixture", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>IndexedDB fixture</title>" }));
  await page.goto("__e2e-indexeddb-fixture");
  await page.unroute("**/__e2e-indexeddb-fixture");
}

async function seedHistoricalStorage(page: Page, primaryVersion: number, rewriteVersion: number, sequential = false): Promise<void> {
  await openFixturePage(page);
  await page.evaluate(async ({ primaryVersion, rewriteVersion, sequential, accountIdentity, repoId }) => {
    const deleteDatabase = (name: string) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`${name} fixture cleanup was blocked.`));
    });
    const transactionDone = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Fixture transaction aborted."));
    });
    const ensureIndex = (store: IDBObjectStore, name: string, keyPath: string | string[]) => {
      if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
    };
    const applyPrimarySchema = (request: IDBOpenDBRequest, version: number) => {
      const db = request.result;
      const tx = request.transaction!;
      if (!db.objectStoreNames.contains("repositories")) {
        const store = db.createObjectStore("repositories", { keyPath: "id" });
        ensureIndex(store, "bookId", "bookId");
        ensureIndex(store, "remote", ["owner", "repo", "branch"]);
      }
      if (!db.objectStoreNames.contains("files")) {
        const store = db.createObjectStore("files", { keyPath: "key" });
        ensureIndex(store, "repoId", "repoId");
        ensureIndex(store, "repoStatus", ["repoId", "status"]);
      }
      if (version >= 2 && !db.objectStoreNames.contains("commits")) {
        const store = db.createObjectStore("commits", { keyPath: "id" });
        ensureIndex(store, "repoId", "repoId");
        if (version <= 3) ensureIndex(store, "repoPushed", ["repoId", "pushed"]);
      }
      if (version >= 3 && !db.objectStoreNames.contains("logs")) {
        const store = db.createObjectStore("logs", { keyPath: "id" });
        ensureIndex(store, "repoId", "repoId");
      }
      if (version >= 6 && !db.objectStoreNames.contains("recoveries")) {
        const store = db.createObjectStore("recoveries", { keyPath: "id" });
        ensureIndex(store, "repoId", "repoId");
      }
      if (version >= 7 && !db.objectStoreNames.contains("migrationJournals")) db.createObjectStore("migrationJournals", { keyPath: "id" });
      if (version >= 12) {
        if (!db.objectStoreNames.contains("maintenanceFences")) db.createObjectStore("maintenanceFences", { keyPath: "repoId" });
        if (!db.objectStoreNames.contains("removalJournals")) db.createObjectStore("removalJournals", { keyPath: "repoId" });
        if (!db.objectStoreNames.contains("consumedBackupReceipts")) db.createObjectStore("consumedBackupReceipts", { keyPath: "receiptId" });
        if (!db.objectStoreNames.contains("maintenanceTombstones")) db.createObjectStore("maintenanceTombstones", { keyPath: "repoId" });
        if (!db.objectStoreNames.contains("maintenanceCompletions")) db.createObjectStore("maintenanceCompletions", { keyPath: "repoId" });
      }
      if (version >= 13 && !db.objectStoreNames.contains("repositoryDiagnostics")) {
        const store = db.createObjectStore("repositoryDiagnostics", { keyPath: "id" });
        ensureIndex(store, "localInstanceId", "localInstanceId");
        ensureIndex(store, "operationId", "operationId");
        ensureIndex(store, "createdAt", "createdAt");
      }
      if (version >= 14 && !db.objectStoreNames.contains("mutationLeases")) db.createObjectStore("mutationLeases", { keyPath: "repoId" });
      if (version >= 12 && db.objectStoreNames.contains("repositories")) {
        const cursor = tx.objectStore("repositories").openCursor();
        cursor.onsuccess = () => { const row = cursor.result; if (!row) return; if (!row.value.localInstanceId) row.update({ ...row.value, localInstanceId: "historical-local-instance" }); row.continue(); };
      }
      if (version >= 13 && db.objectStoreNames.contains("logs")) {
        const cursor = tx.objectStore("logs").openCursor();
        cursor.onsuccess = () => { const row = cursor.result; if (!row) return; row.update({ ...row.value, message: `Repository ${row.value.kind} operation recorded.` }); row.continue(); };
      }
    };
    const applyRewriteSchema = (request: IDBOpenDBRequest, version: number) => {
      const db = request.result;
      if (version <= 2) {
        if (!db.objectStoreNames.contains("rewriteOperations")) {
          const store = db.createObjectStore("rewriteOperations", { keyPath: "operationId" });
          ensureIndex(store, "repoKey", "repoKey");
          ensureIndex(store, "bookId", "bookId");
          ensureIndex(store, "repoTargetKey", ["repoKey", "targetKey"]);
        }
        return;
      }
      if (!db.objectStoreNames.contains("rewriteOperationsV3")) {
        const store = db.createObjectStore("rewriteOperationsV3", { keyPath: "storageId" });
        ensureIndex(store, "repoKey", "repoKey");
        ensureIndex(store, "bookId", "bookId");
        ensureIndex(store, "repoTargetKey", ["repoKey", "targetKey"]);
        ensureIndex(store, "operationId", "operationId");
        if (db.objectStoreNames.contains("rewriteOperations")) {
          const cursor = request.transaction!.objectStore("rewriteOperations").openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            store.put({ ...row.value, storageId: `${encodeURIComponent(row.value.repoId)}::${row.value.operationId}` });
            row.continue();
          };
        }
      }
      if (version >= 5) {
        if (!db.objectStoreNames.contains("maintenanceTombstones")) db.createObjectStore("maintenanceTombstones", { keyPath: "repoId" });
        if (!db.objectStoreNames.contains("maintenanceCompletions")) db.createObjectStore("maintenanceCompletions", { keyPath: "markerId" });
      }
      if (version >= 7 && !db.objectStoreNames.contains("migrationCompletions")) db.createObjectStore("migrationCompletions", { keyPath: "markerId" });
    };
    const openVersion = (name: string, version: number, schema: (request: IDBOpenDBRequest, version: number) => void) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => schema(request, version);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`${name} fixture upgrade was blocked.`));
    });

    await deleteDatabase("narrarium-local-repositories");
    await deleteDatabase("narrarium-local-rewrite-operations");
    const now = "2024-01-01T00:00:00.000Z";
    const operationId = "historical-rewrite";
    const sourcePrimaryVersion = sequential ? 1 : primaryVersion;
    const sourceRepoId = sourcePrimaryVersion < 6 ? "owner/historical#main" : repoId;
    const localInstanceId = sourcePrimaryVersion >= 12 ? "historical-local-instance" : undefined;
    const repository = { id: sourceRepoId, bookId: "historical-book", owner: "owner", repo: "historical", branch: "main", defaultBranch: "main", remoteHeadSha: "historical-head", clonedAt: now, updatedAt: now, ...(sourcePrimaryVersion >= 6 ? { cloneComplete: true, accountScope: accountIdentity } : {}), ...(localInstanceId ? { localInstanceId } : {}) };
    const file = { key: `${sourceRepoId}::book.md`, repoId: sourceRepoId, path: "book.md", kind: "text", text: "historical prose", baseSha: "historical-blob", currentHash: "historical-hash", status: "clean", size: 16, updatedAt: now, ...(sourcePrimaryVersion >= 2 ? { committed: false } : {}), ...(sourcePrimaryVersion >= 3 ? { baseHash: "historical-hash" } : {}) };
    const commit = { id: "historical-commit", repoId: sourceRepoId, message: "Historical local work", createdAt: now, files: [], pushed: false };
    const seedPrimaryRecords = async (db: IDBDatabase, schemaVersion: number) => {
      const stores = [...db.objectStoreNames];
      const tx = db.transaction(stores, "readwrite");
      const direct = !sequential;
      if (direct || schemaVersion === 1) { tx.objectStore("repositories").put(repository); tx.objectStore("files").put(file); }
      if (stores.includes("commits") && (direct || schemaVersion === 2)) tx.objectStore("commits").put(commit);
      if (stores.includes("logs") && (direct || schemaVersion === 3)) tx.objectStore("logs").put({ id: "historical-log", repoId: sourceRepoId, kind: "sync", message: schemaVersion >= 13 ? "Repository sync operation recorded." : "token ghp_secret at /Users/writer/private", createdAt: now });
      if (stores.includes("recoveries") && (direct || schemaVersion === 6)) tx.objectStore("recoveries").put({ id: "historical-recovery", repoId: sourceRepoId, ...(sourcePrimaryVersion >= 6 ? { accountIdentity } : {}), reason: "Historical recovery", createdAt: now, repository, files: [file], commits: [commit] });
      if (stores.includes("repositoryDiagnostics") && (direct || schemaVersion === 13)) tx.objectStore("repositoryDiagnostics").put({ id: "historical-diagnostic", schemaVersion: 1, localInstanceId: localInstanceId ?? "historical-local-instance", operationId: "historical-operation", operation: "sync", stage: "finalize", outcome: "success", createdAt: now, startedAt: now });
      if (stores.includes("migrationJournals") && (direct || schemaVersion === 7)) tx.objectStore("migrationJournals").put({ id: "foreign-migration", oldRepoId: "old", newRepoId: "new", bookId: "foreign-book", owner: "foreign", repo: "repository", branch: "main", legacyAccountIdentity: "google:legacy-other", immutableAccountIdentity: "google:other", phase: "prepared", createdAt: now });
      if (stores.includes("maintenanceFences") && (direct || schemaVersion === 12)) tx.objectStore("maintenanceFences").put({ repoId: "foreign-repo", fence: 1 });
      if (stores.includes("removalJournals") && (direct || schemaVersion === 12)) tx.objectStore("removalJournals").put({ repoId: "foreign-repo", journalId: "foreign-removal", accountIdentity: "google:other", bookId: "foreign-book", owner: "foreign", repo: "repository", branch: "main", localInstanceId: "foreign-instance", snapshotDigest: "snapshot", primaryDigest: "primary", rewriteDigest: "rewrite", rewriteSnapshot: "[]", rewriteCount: 0, rewriteRecords: [], receiptId: "foreign-receipt", observedFence: 0, removalFence: 1, recoveriesPreserved: 0, rewriteOperationsRemoved: 0, primaryCounts: { files: 0, commits: 0, recoveries: 0, rewrites: 0 }, recoveryRecords: [], phase: "prepared", createdAt: now });
      if (stores.includes("consumedBackupReceipts") && (direct || schemaVersion === 12)) tx.objectStore("consumedBackupReceipts").put({ receiptId: "historical-receipt", repoId: "foreign-repo" });
      if (stores.includes("maintenanceTombstones") && (direct || schemaVersion === 12)) tx.objectStore("maintenanceTombstones").put({ repoId: "foreign-repo", journalId: "foreign-tombstone", localInstanceId: "foreign-instance", accountIdentity: "google:other", bookId: "foreign-book", owner: "foreign", repo: "repository", branch: "main", fence: 1, createdAt: now });
      if (stores.includes("maintenanceCompletions") && (direct || schemaVersion === 12)) tx.objectStore("maintenanceCompletions").put({ repoId: "foreign-repo", journalId: "foreign-removal", localInstanceId: "foreign-instance", accountIdentity: "google:other", bookId: "foreign-book", owner: "foreign", repo: "repository", branch: "main", receiptId: "foreign-receipt", snapshotDigest: "snapshot", primaryDigest: "primary", rewriteDigest: "rewrite", rewriteCount: 0, rewriteRecords: [], recoveriesPreserved: 0, primaryCounts: { files: 0, commits: 0, recoveries: 0, rewrites: 0 }, recoveryRecords: [], rewriteCompleted: true, phase: "finalized", completedAt: now });
      if (stores.includes("mutationLeases") && (direct || schemaVersion === 14)) tx.objectStore("mutationLeases").put({ repoId: "foreign-repo", ownerInstanceNonce: "historical-owner", acquiredAt: now, heartbeatAt: now, expiresAt: "2024-01-01T00:01:00.000Z", fence: 1 });
      await transactionDone(tx);
      void schemaVersion;
    };
    const primarySequence = sequential ? [1, 2, 3, 4, 6, 7, 12, 13].filter((version) => version <= primaryVersion) : [primaryVersion];
    for (const version of primarySequence) {
      const db = await openVersion("narrarium-local-repositories", version, applyPrimarySchema);
      await seedPrimaryRecords(db, version);
      db.close();
    }

    const sourceRewriteVersion = sequential ? 1 : rewriteVersion;
    const rewriteRepoId = sourceRewriteVersion === 1 ? "owner/historical#main" : repoId;
    const operation = { schemaVersion: 1, operationId, operation: "rewriteFromReaderFeedback", scope: "chapter", bookId: "historical-book", chapterId: "001", paragraphIds: [], startedAt: now, completedAt: null, status: "preparing", createdAt: now, updatedAt: now, repoId: rewriteRepoId, owner: "owner", repo: "historical", branch: "main", chapterSlug: "001", targetIds: [], feedbackMode: "panel-summary", feedbackPath: "feedback.md", feedbackSummaryPath: "feedback.md", feedbackSourceHash: "hash", staleFeedback: false, progress: { completed: 0, total: 0 }, modifiedFiles: [], generationRuns: [], aggregateInputTokens: 0, aggregateCachedInputTokens: 0, aggregateOutputTokens: 0, aggregateCost: 0, conflicts: [], repoKey: "owner/historical#main", targetKey: "chapter:001", ...(sourceRewriteVersion >= 2 ? { accountIdentity } : {}), ...(sourceRewriteVersion >= 3 ? { storageId: `${encodeURIComponent(rewriteRepoId)}::${operationId}` } : {}), ...(sourceRewriteVersion >= 7 ? { localInstanceId: "historical-local-instance" } : {}) };
    const rewriteSequence = sequential ? [1, 2, 3].filter((version) => version <= rewriteVersion) : [rewriteVersion];
    for (const version of rewriteSequence) {
      const db = await openVersion("narrarium-local-rewrite-operations", version, applyRewriteSchema);
      const store = sourceRewriteVersion <= 2 ? "rewriteOperations" : "rewriteOperationsV3";
      if (db.objectStoreNames.contains(store)) {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(operation);
        await transactionDone(tx);
      }
      db.close();
    }

    const user = { provider: "google", providerAccountId: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" };
    const nowMs = Date.now();
    localStorage.setItem("narrarium-account-scope-v1", accountIdentity);
    localStorage.setItem("narrarium-account-continuity-v1", JSON.stringify({ version: 1, accounts: { google: { version: 1, provider: "google", providerAccountId: user.providerAccountId, normalizedEmail: user.email, displayName: user.name, picture: user.picture, createdAt: 1704067200000, lastSeen: nowMs } } }));
    sessionStorage.setItem("narrarium-auth-session-v1", JSON.stringify({ version: 1, state: { accessToken: "e2e-google-token", accessTokenExpiry: nowMs + 3_600_000, provider: user.provider, providerAccountId: user.providerAccountId } }));
  }, { primaryVersion, rewriteVersion, sequential, accountIdentity: ACCOUNT_IDENTITY, repoId: REPO_ID });
}

async function runProductionUpgrade(page: Page) {
  await page.goto(".");
  await page.waitForFunction(() => Boolean(window.__narrariumE2e));
  return page.evaluate(({ repoId, accountIdentity }) => window.__narrariumE2e!.upgradeStorage(repoId, accountIdentity), { repoId: REPO_ID, accountIdentity: ACCOUNT_IDENTITY });
}

async function seedLegacyMigrationStorage(page: Page): Promise<{ oldRepoId: string; newRepoId: string }> {
  await seedHistoricalStorage(page, 14, 7);
  const oldRepoId = "google:e2e@example.test::owner/historical#main";
  await page.evaluate(async ({ oldRepoId, newRepoId, legacyIdentity }) => {
    const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    const primary = await open("narrarium-local-repositories");
    const stores = ["repositories", "files", "commits", "logs", "recoveries"];
    const tx = primary.transaction(stores, "readwrite");
    const repositories = tx.objectStore("repositories");
    const repositoryRequest = repositories.get(newRepoId);
    const fileRequest = tx.objectStore("files").index("repoId").getAll(newRepoId);
    const commitRequest = tx.objectStore("commits").index("repoId").getAll(newRepoId);
    const logRequest = tx.objectStore("logs").index("repoId").getAll(newRepoId);
    const recoveryRequest = tx.objectStore("recoveries").index("repoId").getAll(newRepoId);
    repositoryRequest.onsuccess = () => {
      repositories.delete(newRepoId);
      repositories.put({ ...repositoryRequest.result, id: oldRepoId, accountScope: legacyIdentity });
    };
    fileRequest.onsuccess = () => { for (const row of fileRequest.result) { tx.objectStore("files").delete(row.key); tx.objectStore("files").put({ ...row, key: `${oldRepoId}::${row.path}`, repoId: oldRepoId }); } };
    commitRequest.onsuccess = () => { for (const row of commitRequest.result) tx.objectStore("commits").put({ ...row, repoId: oldRepoId }); };
    logRequest.onsuccess = () => { for (const row of logRequest.result) tx.objectStore("logs").put({ ...row, repoId: oldRepoId }); };
    recoveryRequest.onsuccess = () => { for (const row of recoveryRequest.result) tx.objectStore("recoveries").put({ ...row, repoId: oldRepoId, accountIdentity: legacyIdentity, repository: { ...row.repository, id: oldRepoId, accountScope: legacyIdentity } }); };
    await done(tx);
    primary.close();

    const rewrite = await open("narrarium-local-rewrite-operations");
    const rewriteTx = rewrite.transaction("rewriteOperationsV3", "readwrite");
    const rewriteStore = rewriteTx.objectStore("rewriteOperationsV3");
    const read = rewriteStore.getAll();
    read.onsuccess = () => {
      for (const row of read.result) {
        rewriteStore.delete(row.storageId);
        rewriteStore.put({ ...row, storageId: `${encodeURIComponent(oldRepoId)}::${row.operationId}`, repoId: oldRepoId, accountIdentity: legacyIdentity });
      }
    };
    await done(rewriteTx);
    rewrite.close();
  }, { oldRepoId, newRepoId: REPO_ID, legacyIdentity: "google:e2e@example.test" });
  return { oldRepoId, newRepoId: REPO_ID };
}

async function holdDatabase(context: BrowserContext, name: string, version: number): Promise<{ page: Page; close: () => Promise<void> }> {
  const blocker = await context.newPage();
  await openFixturePage(blocker);
  await blocker.evaluate(async ({ name, version }) => {
    const target = window as typeof window & { __heldDatabase?: IDBDatabase };
    target.__heldDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }, { name, version });
  return {
    page: blocker,
    close: async () => {
      await blocker.evaluate(() => {
        const target = window as typeof window & { __heldDatabase?: IDBDatabase };
        target.__heldDatabase?.close();
        target.__heldDatabase = undefined;
      });
      await blocker.close();
    },
  };
}

for (const version of PRIMARY_VERSIONS) {
  test(`upgrades shipped repository schema v${version} directly in Chromium`, async ({ page }) => {
    await seedHistoricalStorage(page, version, 7);
    const result = await runProductionUpgrade(page);
    expect(result.primaryVersion).toBe(14);
    expect(result.primaryStores).toEqual(PRIMARY_STORES);
    if (version < 6) {
      expect(result.repository).toBeNull();
      expect(result.primaryRecords.repositories).toHaveLength(1);
      expectExactKeys(result.primaryRecords.repositories[0], ["id", "localInstanceId", "bookId", "owner", "repo", "branch", "defaultBranch", "remoteHeadSha", "clonedAt", "updatedAt"]);
      expectUuid(result.primaryRecords.repositories[0].localInstanceId);
      expect(result.primaryRecords.repositories[0]).toEqual(expectedPrimaryRepository(version, undefined, result.primaryRecords.repositories[0].localInstanceId as string));
    } else {
      if (version < 12) expectUuid(result.repository?.localInstanceId);
      expect(result.repository).toEqual(expectedPrimaryRepository(version, undefined, result.repository!.localInstanceId));
    }
    const expectedFile = expectedPrimaryFile(version);
    expect(result.primaryRecords.files).toEqual([expectedFile]);
    if (version < 6) {
      expect(result.commits).toEqual([]);
      expect(result.recoveries).toEqual([]);
      expect(result.primaryRecords.commits).toHaveLength(version >= 2 ? 1 : 0);
      expect(result.primaryRecords.recoveries).toHaveLength(0);
    } else {
      expect(result.commits).toHaveLength(1);
      expect(result.recoveries).toHaveLength(1);
    }
    if (version >= 2) expect(result.primaryRecords.commits).toEqual([{ ...HISTORICAL_COMMIT, repoId: version < 6 ? "owner/historical#main" : REPO_ID }]);
    if (version >= 3) expect(result.primaryRecords.logs[0]).toEqual({ id: "historical-log", repoId: version < 6 ? "owner/historical#main" : REPO_ID, kind: "sync", message: "Repository sync operation recorded.", createdAt: HISTORICAL_NOW });
    if (version >= 6) expect(result.primaryRecords.recoveries).toEqual([{ id: "historical-recovery", repoId: REPO_ID, accountIdentity: ACCOUNT_IDENTITY, reason: "Historical recovery", createdAt: HISTORICAL_NOW, repository: { ...expectedPrimaryRepository(version), localInstanceId: version >= 12 ? "historical-local-instance" : undefined }, files: [expectedFile], commits: [HISTORICAL_COMMIT] }].map((recovery) => ({ ...recovery, repository: Object.fromEntries(Object.entries(recovery.repository).filter(([, value]) => value !== undefined)) })));
    for (const store of PRIMARY_STORES) expect(result.primaryRecords).toHaveProperty(store);
    expect(storeCounts(result.primaryRecords)).toEqual({ commits: version >= 2 ? 1 : 0, consumedBackupReceipts: version >= 12 ? 1 : 0, files: 1, logs: version >= 3 ? 1 : 0, maintenanceCompletions: version >= 12 ? 1 : 0, maintenanceFences: version >= 12 ? 1 : 0, maintenanceTombstones: version >= 12 ? 1 : 0, migrationJournals: version >= 7 ? 1 : 0, mutationLeases: version >= 14 ? 1 : 0, recoveries: version >= 6 ? 1 : 0, removalJournals: version >= 12 ? 1 : 0, repositories: 1, repositoryDiagnostics: version >= 13 ? 1 : 0 });
    if (version >= 12) {
      expectExactKeys(result.primaryRecords.removalJournals[0], ["repoId", "journalId", "accountIdentity", "bookId", "owner", "repo", "branch", "localInstanceId", "snapshotDigest", "primaryDigest", "rewriteDigest", "rewriteSnapshot", "rewriteCount", "rewriteRecords", "receiptId", "observedFence", "removalFence", "recoveriesPreserved", "rewriteOperationsRemoved", "primaryCounts", "recoveryRecords", "phase", "createdAt"]);
      expectExactKeys(result.primaryRecords.maintenanceCompletions[0], ["repoId", "journalId", "localInstanceId", "accountIdentity", "bookId", "owner", "repo", "branch", "receiptId", "snapshotDigest", "primaryDigest", "rewriteDigest", "rewriteCount", "rewriteRecords", "recoveriesPreserved", "primaryCounts", "recoveryRecords", "rewriteCompleted", "phase", "completedAt"]);
      expect(result.primaryRecords.removalJournals[0]).toEqual(FOREIGN_REMOVAL_JOURNAL);
      expect(result.primaryRecords.maintenanceCompletions[0]).toEqual(FOREIGN_COMPLETION);
      expect(result.primaryRecords.migrationJournals).toEqual([FOREIGN_MIGRATION]);
      expect(result.primaryRecords.maintenanceFences).toEqual([FOREIGN_FENCE]);
      expect(result.primaryRecords.consumedBackupReceipts).toEqual([FOREIGN_RECEIPT]);
      expect(result.primaryRecords.maintenanceTombstones).toEqual([FOREIGN_TOMBSTONE]);
    }
    if (version >= 13) expect(result.primaryRecords.repositoryDiagnostics).toEqual([{ id: "historical-diagnostic", schemaVersion: 1, localInstanceId: "historical-local-instance", operationId: "historical-operation", operation: "sync", stage: "finalize", outcome: "success", createdAt: HISTORICAL_NOW, startedAt: HISTORICAL_NOW }]);
    if (version >= 14) expect(result.primaryRecords.mutationLeases).toEqual([FOREIGN_LEASE]);
  });
}

for (const version of REWRITE_VERSIONS) {
  test(`upgrades shipped rewrite schema v${version} directly in Chromium`, async ({ page }) => {
    await seedHistoricalStorage(page, 14, version);
    const result = await runProductionUpgrade(page);
    expect(result.rewriteVersion).toBe(7);
    expect(result.rewriteStores).toEqual(version <= 2 ? [...REWRITE_STORES, "rewriteOperations"].sort() : REWRITE_STORES);
    const rewriteRecord = result.rewriteRecords.rewriteOperationsV3[0];
    expect(rewriteRecord).toEqual(expectedRewriteRecord(version));
    if (version <= 2) expect(result.rewriteRecords.rewriteOperations).toEqual([expectedLegacyRewriteRecord(version)]);
    expect(storeCounts(result.rewriteRecords)).toEqual(version <= 2
      ? { maintenanceCompletions: 0, maintenanceTombstones: 0, migrationCompletions: 0, rewriteOperations: 1, rewriteOperationsV3: 1 }
      : { maintenanceCompletions: 0, maintenanceTombstones: 0, migrationCompletions: 0, rewriteOperationsV3: 1 });
  });
}

test("upgrades repository and rewrite schemas sequentially before the current production upgrade", async ({ page }) => {
  await seedHistoricalStorage(page, 13, 3, true);
  const result = await runProductionUpgrade(page);
  expect(result.primaryVersion).toBe(14);
  expect(result.rewriteVersion).toBe(7);
  expect(result.primaryStores).toEqual(PRIMARY_STORES);
  expect(result.rewriteStores).toEqual([...REWRITE_STORES, "rewriteOperations"].sort());
  expect(result.repository).toBeNull();
  expect(result.primaryRecords.repositories).toEqual([{ id: "owner/historical#main", localInstanceId: "historical-local-instance", bookId: "historical-book", owner: "owner", repo: "historical", branch: "main", defaultBranch: "main", remoteHeadSha: "historical-head", clonedAt: HISTORICAL_NOW, updatedAt: HISTORICAL_NOW }]);
  expect(result.primaryRecords.mutationLeases).toEqual([]);
  expect(result.rewriteRecords.rewriteOperationsV3).toEqual([expectedRewriteRecord(1)]);
  expect(storeCounts(result.primaryRecords)).toEqual({ commits: 1, consumedBackupReceipts: 1, files: 1, logs: 1, maintenanceCompletions: 1, maintenanceFences: 1, maintenanceTombstones: 1, migrationJournals: 1, mutationLeases: 0, recoveries: 1, removalJournals: 1, repositories: 1, repositoryDiagnostics: 1 });
  expect(result.primaryRecords.files).toEqual([expectedPrimaryFile(1)]);
  expect(result.primaryRecords.commits).toEqual([{ ...HISTORICAL_COMMIT, repoId: "owner/historical#main" }]);
  expect(result.primaryRecords.logs).toEqual([{ id: "historical-log", repoId: "owner/historical#main", kind: "sync", message: "Repository sync operation recorded.", createdAt: HISTORICAL_NOW }]);
  expect(result.primaryRecords.recoveries).toEqual([{ id: "historical-recovery", repoId: "owner/historical#main", reason: "Historical recovery", createdAt: HISTORICAL_NOW, repository: { id: "owner/historical#main", bookId: "historical-book", owner: "owner", repo: "historical", branch: "main", defaultBranch: "main", remoteHeadSha: "historical-head", clonedAt: HISTORICAL_NOW, updatedAt: HISTORICAL_NOW }, files: [expectedPrimaryFile(1)], commits: [{ ...HISTORICAL_COMMIT, repoId: "owner/historical#main" }] }]);
  expect(result.primaryRecords.repositoryDiagnostics).toEqual([{ id: "historical-diagnostic", schemaVersion: 1, localInstanceId: "historical-local-instance", operationId: "historical-operation", operation: "sync", stage: "finalize", outcome: "success", createdAt: HISTORICAL_NOW, startedAt: HISTORICAL_NOW }]);
  expect(result.primaryRecords.migrationJournals).toEqual([FOREIGN_MIGRATION]);
  expect(result.primaryRecords.maintenanceFences).toEqual([FOREIGN_FENCE]);
  expect(result.primaryRecords.removalJournals).toEqual([FOREIGN_REMOVAL_JOURNAL]);
  expect(result.primaryRecords.consumedBackupReceipts).toEqual([FOREIGN_RECEIPT]);
  expect(result.primaryRecords.maintenanceTombstones).toEqual([FOREIGN_TOMBSTONE]);
  expect(result.primaryRecords.maintenanceCompletions).toEqual([FOREIGN_COMPLETION]);
  expect(result.rewriteRecords.rewriteOperations).toEqual([expectedLegacyRewriteRecord(1)]);
});

test("a real second page keeps repository upgrades fail-fast until it closes", async ({ page, context }) => {
  await seedHistoricalStorage(page, 13, 7);
  const blocker = await holdDatabase(context, "narrarium-local-repositories", 13);
  await page.goto(".");
  await page.waitForFunction(() => Boolean(window.__narrariumE2e));
  const blocked = page.evaluate(({ repoId, accountIdentity }) => window.__narrariumE2e!.upgradeStorage(repoId, accountIdentity), { repoId: REPO_ID, accountIdentity: ACCOUNT_IDENTITY });
  const blockedMessage = "Local repository database upgrade is blocked by another tab. Close or reload other Narrarium tabs and retry.";
  await expect(blocked).rejects.toThrow(blockedMessage);
  await expect(page.evaluate(({ repoId, accountIdentity }) => window.__narrariumE2e!.upgradeStorage(repoId, accountIdentity), { repoId: REPO_ID, accountIdentity: ACCOUNT_IDENTITY })).rejects.toThrow(blockedMessage);
  await blocker.close();
  let upgraded: Awaited<ReturnType<NonNullable<Window["__narrariumE2e"]>["upgradeStorage"]>> | null = null;
  await expect.poll(async () => page.evaluate(({ repoId, accountIdentity }) => window.__narrariumE2e!.upgradeStorage(repoId, accountIdentity).then((result) => result).catch(() => null), { repoId: REPO_ID, accountIdentity: ACCOUNT_IDENTITY }).then((result) => { upgraded = result; return result?.primaryVersion ?? 0; })).toBe(14);
  expect(upgraded!.repository).toEqual(expectedPrimaryRepository(13));
  expect(upgraded!.primaryRecords.files).toEqual([expectedPrimaryFile(13)]);
  expect(upgraded!.primaryRecords.repositoryDiagnostics).toEqual([{ id: "historical-diagnostic", schemaVersion: 1, localInstanceId: "historical-local-instance", operationId: "historical-operation", operation: "sync", stage: "finalize", outcome: "success", createdAt: HISTORICAL_NOW, startedAt: HISTORICAL_NOW }]);
  expect(storeCounts(upgraded!.primaryRecords)).toEqual({ commits: 1, consumedBackupReceipts: 1, files: 1, logs: 1, maintenanceCompletions: 1, maintenanceFences: 1, maintenanceTombstones: 1, migrationJournals: 1, mutationLeases: 0, recoveries: 1, removalJournals: 1, repositories: 1, repositoryDiagnostics: 1 });
  expect(upgraded!.primaryRecords.commits).toEqual([HISTORICAL_COMMIT]);
  expect(upgraded!.primaryRecords.logs).toEqual([{ id: "historical-log", repoId: REPO_ID, kind: "sync", message: "Repository sync operation recorded.", createdAt: HISTORICAL_NOW }]);
  expect(upgraded!.primaryRecords.recoveries).toEqual([{ id: "historical-recovery", repoId: REPO_ID, accountIdentity: ACCOUNT_IDENTITY, reason: "Historical recovery", createdAt: HISTORICAL_NOW, repository: expectedPrimaryRepository(13), files: [expectedPrimaryFile(13)], commits: [HISTORICAL_COMMIT] }]);
  expect(upgraded!.primaryRecords.migrationJournals).toEqual([FOREIGN_MIGRATION]);
  expect(upgraded!.primaryRecords.maintenanceFences).toEqual([FOREIGN_FENCE]);
  expect(upgraded!.primaryRecords.removalJournals).toEqual([FOREIGN_REMOVAL_JOURNAL]);
  expect(upgraded!.primaryRecords.consumedBackupReceipts).toEqual([FOREIGN_RECEIPT]);
  expect(upgraded!.primaryRecords.maintenanceTombstones).toEqual([FOREIGN_TOMBSTONE]);
  expect(upgraded!.primaryRecords.maintenanceCompletions).toEqual([FOREIGN_COMPLETION]);
});

test("a real second page blocks an old rewrite upgrade, then retry succeeds after it closes", async ({ page, context }) => {
  await seedHistoricalStorage(page, 14, 3);
  const blocker = await holdDatabase(context, "narrarium-local-rewrite-operations", 3);
  await page.goto(".");
  await page.waitForFunction(() => Boolean(window.__narrariumE2e));
  const blocked = page.evaluate(({ repoId, accountIdentity }) => window.__narrariumE2e!.upgradeStorage(repoId, accountIdentity), { repoId: REPO_ID, accountIdentity: ACCOUNT_IDENTITY });
  await expect(blocked).rejects.toThrow("Local rewrite operation database upgrade is blocked by another tab. Close or reload other Narrarium tabs and retry.");
  await blocker.close();
  let upgraded: Awaited<ReturnType<NonNullable<Window["__narrariumE2e"]>["upgradeStorage"]>> | null = null;
  await expect.poll(async () => page.evaluate(({ repoId, accountIdentity }) => window.__narrariumE2e!.upgradeStorage(repoId, accountIdentity).then((result) => result).catch(() => null), { repoId: REPO_ID, accountIdentity: ACCOUNT_IDENTITY }).then((result) => { upgraded = result; return result?.rewriteVersion ?? 0; })).toBe(7);
  expect(upgraded!.rewriteRecords.rewriteOperationsV3).toEqual([expectedRewriteRecord(3)]);
});

test("production repository and rewrite connections close on versionchange in Chromium", async ({ page, context }) => {
  await seedHistoricalStorage(page, 14, 7);
  await runProductionUpgrade(page);
  const future = await context.newPage();
  await openFixturePage(future);
  const versions = await future.evaluate(async () => {
    const upgrade = (name: string, version: number) => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => undefined;
      request.onsuccess = () => { const result = request.result.version; request.result.close(); resolve(result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`${name} did not close on versionchange.`));
    });
    return { primary: await upgrade("narrarium-local-repositories", 15), rewrite: await upgrade("narrarium-local-rewrite-operations", 8) };
  });
  expect(versions).toEqual({ primary: 15, rewrite: 8 });
  await future.close();
});

test("a forced transaction abort preserves the original repository file", async ({ page }) => {
    await seedHistoricalStorage(page, 14, 7);
    await runProductionUpgrade(page);
    const result = await page.evaluate((repoId) => window.__narrariumE2e!.writePrimaryFile(repoId, "book.md", "must not persist", true), REPO_ID);
    expect(result.error).toEqual({ name: "AbortError", message: "AbortError: Injected abort during local file write." });
    expect(result.before).toEqual({ key: `${REPO_ID}::book.md`, repoId: REPO_ID, path: "book.md", kind: "text", text: "historical prose", baseSha: "historical-blob", baseHash: "historical-hash", currentHash: "historical-hash", status: "clean", committed: false, size: 16, updatedAt: HISTORICAL_NOW });
    expect(result.after).toEqual(result.before);
});

test("an IndexedDB QuotaExceededError aborts the whole file transaction", async ({ page }) => {
  await seedHistoricalStorage(page, 14, 7);
  await runProductionUpgrade(page);
  const result = await page.evaluate(async (repoId) => {
    const originalPut = IDBObjectStore.prototype.put;
    let quotaWrites = 0;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (typeof value === "object" && value && "path" in value && String((value as { path: unknown }).path).startsWith("quota-")) {
        quotaWrites += 1;
        if (quotaWrites === 2) throw new DOMException("Injected browser quota failure.", "QuotaExceededError");
      }
      return originalPut.call(this, value, key);
    };
    try {
      return await window.__narrariumE2e!.writePrimaryFiles(repoId, Array.from({ length: 4 }, (_, index) => ({ path: `quota-${index}.md`, text: `quota ${index}` })));
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
  }, REPO_ID);
    expect(result.error?.name).toBe("QuotaExceededError");
    expect(result.files).toEqual([{ key: `${REPO_ID}::book.md`, repoId: REPO_ID, path: "book.md", kind: "text", text: "historical prose", baseSha: "historical-blob", baseHash: "historical-hash", currentHash: "historical-hash", status: "clean", committed: false, size: 16, updatedAt: HISTORICAL_NOW }]);
});

const REMOVAL_CRASH_PHASES = ["after-prepare", "after-rewrite-marker", "after-rewrite-phase-update", "after-primary", "after-primary-marker", "after-rewrite-finalize", "after-primary-completion", "after-final-cleanup", "after-finalized"] as const;

for (const phase of REMOVAL_CRASH_PHASES) {
  test(`force-removal journal resumes after a real reload at ${phase}`, async ({ page }) => {
    await seedHistoricalStorage(page, 14, 7);
    await runProductionUpgrade(page);
    const target = { bookId: "historical-book", owner: "owner", repo: "historical", branch: "main", accountIdentity: ACCOUNT_IDENTITY };
    const message = await page.evaluate(({ target, phase }) => window.__narrariumE2e!.crashForceRemoval(target, phase), { target, phase });
    expect(message).toBe(`Simulated maintenance removal crash ${phase}.`);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__narrariumE2e));
    await expect(page.evaluate((target) => window.__narrariumE2e!.resumeForceRemoval(target), target)).resolves.toEqual({ recoveriesPreserved: 0, rewriteOperationsRemoved: 1 });
    const finalState = await page.evaluate(({ repoId, accountIdentity }) => window.__narrariumE2e!.upgradeStorage(repoId, accountIdentity), { repoId: REPO_ID, accountIdentity: ACCOUNT_IDENTITY });
    expect(finalState.repository).toBeNull();
    expect(finalState.files).toEqual([]);
    expect(finalState.commits).toEqual([]);
    expect(finalState.recoveries).toEqual([]);
    expect(finalState.rewriteRecords.rewriteOperationsV3).toEqual([]);
    expect(finalState.primaryRecords.repositories).toEqual([]);
    expect(finalState.primaryRecords.files).toEqual([]);
    expect(finalState.primaryRecords.commits).toEqual([]);
    expect(finalState.primaryRecords.logs).toEqual([]);
    expect(finalState.primaryRecords.recoveries).toEqual([]);
    expect(finalState.primaryRecords.repositoryDiagnostics).toEqual([]);
    expect(finalState.primaryRecords.removalJournals.filter((entry) => entry.repoId === REPO_ID)).toEqual([]);
    expect(finalState.primaryRecords.removalJournals).toEqual([FOREIGN_REMOVAL_JOURNAL]);
    expect(finalState.primaryRecords.maintenanceTombstones.filter((entry) => entry.repoId === REPO_ID)).toEqual([]);
    expect(finalState.primaryRecords.maintenanceTombstones).toEqual([FOREIGN_TOMBSTONE]);
    const targetCompletions = finalState.primaryRecords.maintenanceCompletions.filter((entry) => entry.repoId === REPO_ID);
    const markerRetained = !["after-primary-completion", "after-final-cleanup", "after-finalized"].includes(phase);
    expect(targetCompletions).toHaveLength(markerRetained ? 1 : 0);
    if (markerRetained) {
      expectExactKeys(targetCompletions[0], ["repoId", "journalId", "localInstanceId", "accountIdentity", "bookId", "owner", "repo", "branch", "receiptId", "force", "snapshotDigest", "primaryDigest", "rewriteDigest", "rewriteCount", "rewriteRecords", "recoveriesPreserved", "recoveryRecords", "primaryCounts", "rewriteCompleted", "phase", "completedAt"]);
      expectUuid(targetCompletions[0].journalId);
      expect(targetCompletions[0].receiptId).toBe(`force:${targetCompletions[0].receiptId.toString().slice(6)}`);
      expectUuid(targetCompletions[0].receiptId.toString().slice(6));
      expectSha256(targetCompletions[0].snapshotDigest);
      expectSha256(targetCompletions[0].primaryDigest);
      expectSha256(targetCompletions[0].rewriteDigest);
      expectSha256((targetCompletions[0].rewriteRecords as Array<{ hash: unknown }>)[0].hash);
      expectIsoTimestamp(targetCompletions[0].completedAt);
      expect({ ...targetCompletions[0], journalId: "<journal>", receiptId: "force:<receipt>", snapshotDigest: "<sha256>", primaryDigest: "<sha256>", rewriteDigest: "<sha256>", rewriteRecords: [{ operationId: "historical-rewrite", hash: "<sha256>" }], completedAt: "<timestamp>" }).toEqual({ repoId: REPO_ID, journalId: "<journal>", localInstanceId: "historical-local-instance", accountIdentity: ACCOUNT_IDENTITY, bookId: "historical-book", owner: "owner", repo: "historical", branch: "main", receiptId: "force:<receipt>", force: true, snapshotDigest: "<sha256>", primaryDigest: "<sha256>", rewriteDigest: "<sha256>", rewriteCount: 1, rewriteRecords: [{ operationId: "historical-rewrite", hash: "<sha256>" }], recoveriesPreserved: 0, recoveryRecords: [], primaryCounts: { files: 1, commits: 1, recoveries: 1, rewrites: 1 }, rewriteCompleted: true, phase: "finalized", completedAt: "<timestamp>" });
    }
    expect(finalState.primaryRecords.maintenanceCompletions).toEqual(markerRetained ? [FOREIGN_COMPLETION, targetCompletions[0]] : [FOREIGN_COMPLETION]);
    expect(finalState.rewriteRecords.maintenanceTombstones).toEqual([]);
    const rewriteCompletions = finalState.rewriteRecords.maintenanceCompletions.filter((entry) => entry.repoId === REPO_ID);
    expect(rewriteCompletions).toHaveLength(markerRetained ? 1 : 0);
    if (markerRetained) {
      expectExactKeys(rewriteCompletions[0], ["markerId", "journalId", "repoId", "localInstanceId", "accountIdentity", "preDeleteDigest", "deletedRecords", "deletedCount", "tombstoneGeneration", "completedAt"]);
      expect(rewriteCompletions[0].markerId).toBe(`${targetCompletions[0].journalId}::${REPO_ID}::historical-local-instance`);
      expectSha256(rewriteCompletions[0].preDeleteDigest);
      expectSha256((rewriteCompletions[0].deletedRecords as Array<{ hash: unknown }>)[0].hash);
      expectIsoTimestamp(rewriteCompletions[0].completedAt);
      expect({ ...rewriteCompletions[0], markerId: "<marker>", journalId: "<journal>", preDeleteDigest: "<sha256>", deletedRecords: [{ operationId: "historical-rewrite", hash: "<sha256>" }], completedAt: "<timestamp>" }).toEqual({ markerId: "<marker>", journalId: "<journal>", repoId: REPO_ID, localInstanceId: "historical-local-instance", accountIdentity: ACCOUNT_IDENTITY, preDeleteDigest: "<sha256>", deletedRecords: [{ operationId: "historical-rewrite", hash: "<sha256>" }], deletedCount: 1, tombstoneGeneration: 1, completedAt: "<timestamp>" });
    }
    expect(storeCounts(finalState.primaryRecords)).toEqual({ commits: 0, consumedBackupReceipts: 1, files: 0, logs: 0, maintenanceCompletions: 1 + targetCompletions.length, maintenanceFences: 1, maintenanceTombstones: 1, migrationJournals: 1, mutationLeases: 1, recoveries: 0, removalJournals: 1, repositories: 0, repositoryDiagnostics: 0 });
    expect(storeCounts(finalState.rewriteRecords)).toEqual({ maintenanceCompletions: rewriteCompletions.length, maintenanceTombstones: 0, migrationCompletions: 0, rewriteOperationsV3: 0 });
  });
}

for (const phase of ["journal", "rewrite-prepared", "primary-rekeyed", "rewrite-finalized"] as const) {
  test(`legacy identity migration resumes after a real reload at ${phase}`, async ({ page }) => {
    const ids = await seedLegacyMigrationStorage(page);
    await page.goto(".");
    await page.waitForFunction(() => Boolean(window.__narrariumE2e));
    const target = { bookId: "historical-book", owner: "owner", repo: "historical", branch: "main" };
    const message = await page.evaluate(({ target, phase }) => window.__narrariumE2e!.crashLegacyMigration(target, phase), { target, phase });
    expect(message).toBe(`Simulated repository migration crash after ${phase}.`);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__narrariumE2e));
    await expect.poll(async () => page.evaluate(() => window.__narrariumE2e!.resumeLegacyMigrations().then(() => true).catch(() => false))).toBe(true);
    await expect.poll(async () => page.evaluate(({ repoId, accountIdentity }) => window.__narrariumE2e!.inspectRepository(repoId, accountIdentity).then((state) => Boolean(state.repository)), { repoId: ids.newRepoId, accountIdentity: ACCOUNT_IDENTITY })).toBe(true);
    const current = await page.evaluate(({ repoId, accountIdentity }) => window.__narrariumE2e!.inspectRepository(repoId, accountIdentity), { repoId: ids.newRepoId, accountIdentity: ACCOUNT_IDENTITY });
    const legacy = await page.evaluate(({ repoId, accountIdentity }) => window.__narrariumE2e!.inspectRepository(repoId, accountIdentity), { repoId: ids.oldRepoId, accountIdentity: ACCOUNT_IDENTITY });
    expectExactKeys(current.repository as Record<string, unknown>, ["id", "localInstanceId", "bookId", "owner", "repo", "branch", "defaultBranch", "remoteHeadSha", "clonedAt", "updatedAt", "cloneComplete", "accountScope"]);
    expectIsoTimestamp((current.repository as Record<string, unknown>).updatedAt);
    expect({ ...(current.repository as Record<string, unknown>), updatedAt: "<timestamp>" }).toEqual({ ...expectedPrimaryRepository(14), updatedAt: "<timestamp>" });
    expect(current.files).toEqual([expectedPrimaryFile(14)]);
    expect(legacy).toEqual({ repository: null, files: [] });
    const upgraded = await page.evaluate(({ repoId, accountIdentity }) => window.__narrariumE2e!.upgradeStorage(repoId, accountIdentity), { repoId: ids.newRepoId, accountIdentity: ACCOUNT_IDENTITY });
    expect(upgraded.rewriteRecords.rewriteOperationsV3).toEqual([expectedRewriteRecord(7)]);
    expect(upgraded.commits).toEqual([HISTORICAL_COMMIT]);
    expect(upgraded.recoveries).toEqual([{ id: "historical-recovery", repoId: ids.newRepoId, accountIdentity: ACCOUNT_IDENTITY, reason: "Historical recovery", createdAt: HISTORICAL_NOW, repository: expectedPrimaryRepository(14), files: [expectedPrimaryFile(14)], commits: [HISTORICAL_COMMIT] }]);
    expect(upgraded.primaryRecords.logs).toEqual([{ id: "historical-log", repoId: ids.newRepoId, kind: "sync", message: "Repository sync operation recorded.", createdAt: HISTORICAL_NOW }]);
    expect(upgraded.primaryRecords.migrationJournals.filter((entry) => entry.oldRepoId === ids.oldRepoId || entry.newRepoId === ids.newRepoId)).toEqual([]);
    expect(upgraded.primaryRecords.migrationJournals).toEqual([FOREIGN_MIGRATION]);
    expect(upgraded.rewriteRecords.migrationCompletions).toHaveLength(1);
    expectExactKeys(upgraded.rewriteRecords.migrationCompletions[0], ["markerId", "journalId", "oldRepoId", "newRepoId", "immutableAccountIdentity", "finalizedRecords", "completedAt"]);
    const migrationCompletion = upgraded.rewriteRecords.migrationCompletions[0];
    expectUuid(migrationCompletion.journalId);
    expect(migrationCompletion.markerId).toBe(`migration::${migrationCompletion.journalId}::${ids.oldRepoId}::${ids.newRepoId}`);
    const finalizedSnapshot = (migrationCompletion.finalizedRecords as Array<{ hash: unknown }>)[0].hash;
    expect(finalizedSnapshot).toBe(stableSnapshot(expectedRewriteRecord(7)));
    expectIsoTimestamp(migrationCompletion.completedAt);
    expect({ ...migrationCompletion, markerId: "<marker>", journalId: "<journal>", finalizedRecords: [{ operationId: "historical-rewrite", hash: "<snapshot>" }], completedAt: "<timestamp>" }).toEqual({ markerId: "<marker>", journalId: "<journal>", oldRepoId: ids.oldRepoId, newRepoId: ids.newRepoId, immutableAccountIdentity: ACCOUNT_IDENTITY, finalizedRecords: [{ operationId: "historical-rewrite", hash: "<snapshot>" }], completedAt: "<timestamp>" });
    expect(storeCounts(upgraded.primaryRecords)).toEqual({ commits: 1, consumedBackupReceipts: 1, files: 1, logs: 1, maintenanceCompletions: 1, maintenanceFences: 1, maintenanceTombstones: 1, migrationJournals: 1, mutationLeases: 1, recoveries: 1, removalJournals: 1, repositories: 1, repositoryDiagnostics: 1 });
    expect(storeCounts(upgraded.rewriteRecords)).toEqual({ maintenanceCompletions: 0, maintenanceTombstones: 0, migrationCompletions: 1, rewriteOperationsV3: 1 });
  });
}
