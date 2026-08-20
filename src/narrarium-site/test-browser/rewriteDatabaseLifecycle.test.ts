import "fake-indexeddb/auto";
import { afterEach, expect, test, vi } from "vitest";
import { LOCAL_REWRITE_DATABASE_BLOCKED_EVENT, RewriteOperationDatabaseBlockedError, closeLocalRewriteOperationStoreForTests, ensureLocalRewriteOperationStoreReady } from "@/repository/localRewriteOperationStore";

const DB_NAME = "narrarium-local-rewrite-operations";
const heldConnections: IDBDatabase[] = [];
const extraClosers: Array<() => Promise<void>> = [];

async function deleteDatabase(): Promise<void> {
  await closeLocalRewriteOperationStoreForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Rewrite database cleanup was blocked."));
  });
}

afterEach(async () => {
  for (const db of heldConnections.splice(0)) db.close();
  for (const close of extraClosers.splice(0)) await close();
  await deleteDatabase();
});

test("blocked old-tab upgrade settles, preserves records, and retries after close", async () => {
  await deleteDatabase();
  const operationId = crypto.randomUUID();
  const repoId = "google:user::owner/repo#main";
  const storageId = `${encodeURIComponent(repoId)}::${operationId}`;
  const oldTab = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 6);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore("rewriteOperationsV3", { keyPath: "storageId" });
      store.createIndex("repoKey", "repoKey", { unique: false });
      store.createIndex("bookId", "bookId", { unique: false });
      store.createIndex("repoTargetKey", ["repoKey", "targetKey"], { unique: false });
      store.createIndex("operationId", "operationId", { unique: false });
      db.createObjectStore("maintenanceTombstones", { keyPath: "repoId" });
      db.createObjectStore("maintenanceCompletions", { keyPath: "markerId" });
      request.transaction!.objectStore("rewriteOperationsV3").put({ storageId, operationId, repoId, repoKey: "owner/repo#main", targetKey: "chapter:001", bookId: "book", localInstanceId: crypto.randomUUID(), accountIdentity: "google:user" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  heldConnections.push(oldTab);

  const blocked = vi.fn();
  window.addEventListener(LOCAL_REWRITE_DATABASE_BLOCKED_EVENT, blocked, { once: true });
  const attempt = ensureLocalRewriteOperationStoreReady();
  await expect(Promise.race([attempt, new Promise((_, reject) => setTimeout(() => reject(new Error("open hung")), 500))])).rejects.toBeInstanceOf(RewriteOperationDatabaseBlockedError);
  expect(blocked).toHaveBeenCalledOnce();

  oldTab.close();
  await expect(ensureLocalRewriteOperationStoreReady()).resolves.toBeUndefined();
  const upgraded = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(DB_NAME); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  expect(upgraded.version).toBe(7);
  expect(upgraded.objectStoreNames.contains("migrationCompletions")).toBe(true);
  const preserved = await new Promise<any>((resolve, reject) => { const tx = upgraded.transaction("rewriteOperationsV3", "readonly"); const request = tx.objectStore("rewriteOperationsV3").get(storageId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  expect(preserved).toMatchObject({ operationId, bookId: "book" });
  upgraded.close();

  await closeLocalRewriteOperationStoreForTests();
  vi.resetModules();
  const reloaded = await import("@/repository/localRewriteOperationStore");
  extraClosers.push(reloaded.closeLocalRewriteOperationStoreForTests);
  await expect(reloaded.ensureLocalRewriteOperationStoreReady()).resolves.toBeUndefined();
});

test("legacy rewrite records are copied into the current store during upgrade", async () => {
  await deleteDatabase();
  const operationId = crypto.randomUUID();
  const repoId = "google:user::owner/repo#main";
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 6);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore("rewriteOperations", { keyPath: "operationId" });
      store.put({ operationId, repoId, repoKey: "owner/repo#main", targetKey: "chapter:001", bookId: "book", localInstanceId: crypto.randomUUID(), accountIdentity: "google:user" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  legacy.close();
  await ensureLocalRewriteOperationStoreReady();
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(DB_NAME); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  heldConnections.push(db);
  const storageId = `${encodeURIComponent(repoId)}::${operationId}`;
  const preserved = await new Promise<any>((resolve, reject) => { const tx = db.transaction("rewriteOperationsV3", "readonly"); const request = tx.objectStore("rewriteOperationsV3").get(storageId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  expect(preserved).toMatchObject({ operationId, repoId, storageId });
});

test("a current connection closes on versionchange so another tab can upgrade", async () => {
  await deleteDatabase();
  await ensureLocalRewriteOperationStoreReady();
  const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 8);
    request.onupgradeneeded = () => undefined;
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Current connection did not close on versionchange."));
  });
  heldConnections.push(upgraded);
  expect(upgraded.version).toBe(8);
  upgraded.close();
  await closeLocalRewriteOperationStoreForTests();
});
