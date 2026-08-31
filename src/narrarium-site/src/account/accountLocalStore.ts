import { localDeviceId } from "@/account/deviceIdentity";
import {
  ACCOUNT_SYNC_SCHEMA_VERSION,
  type AccountSyncManifest,
  type LocalAccountSnapshot,
  type LocalSyncConfiguration,
  type SyncableAccountData,
} from "@/account/types";
import { initialAccountManifest, nextAccountManifest, reconciledAccountManifest } from "@/account/vectorClock";
import type { AssistantLosslessSegment, AssistantSession } from "@/assistant/store";
import type { ClipboardEntry } from "@/clipboard/clipboardStore";
import type { CostsFile } from "@/costs/model";
import type { AppSettings } from "@/types/settings";
import { projectSyncableSettings } from "@/account/dataProjection";

const DB_NAME = "narrarium-local-account";
const DB_VERSION = 1;
const CURRENT_KEY = "current";
const MAX_RECOVERIES = 5;

export const ACCOUNT_LOCAL_CHANGED_EVENT = "narrarium:account-local-changed";

interface StoredMeta {
  key: typeof CURRENT_KEY;
  manifest: AccountSyncManifest;
  dirty: boolean;
  initializedAtUtc: string;
}

interface StoredCore {
  key: typeof CURRENT_KEY;
  schemaVersion: typeof ACCOUNT_SYNC_SCHEMA_VERSION;
  settings: AppSettings;
  costs: CostsFile;
  clipboard: ClipboardEntry[];
}

type StoredChat = Omit<AssistantSession, "losslessSegments"> & { id: string };
interface StoredSegment { key: string; sessionId: string; segment: AssistantLosslessSegment }
interface StoredRecovery { id: string; createdAtUtc: string; reason: string; snapshot: LocalAccountSnapshot }
interface StoredConfiguration { key: typeof CURRENT_KEY; value: LocalSyncConfiguration }

let dbPromise: Promise<IDBDatabase> | null = null;
let initializationPromise: Promise<LocalAccountSnapshot> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Local account database upgrade is blocked by another Narrarium tab."));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("core")) db.createObjectStore("core", { keyPath: "key" });
      if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "id" });
      if (!db.objectStoreNames.contains("segments")) {
        const segments = db.createObjectStore("segments", { keyPath: "key" });
        segments.createIndex("sessionId", "sessionId", { unique: false });
      }
      if (!db.objectStoreNames.contains("recoveries")) {
        const recoveries = db.createObjectStore("recoveries", { keyPath: "id" });
        recoveries.createIndex("createdAtUtc", "createdAtUtc", { unique: false });
      }
      if (!db.objectStoreNames.contains("deviceConfiguration")) db.createObjectStore("deviceConfiguration", { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
  }).catch((error) => { dbPromise = null; throw error; });
  return dbPromise;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Local account transaction was aborted."));
  });
}

function emitChanged(manifest: AccountSyncManifest, logical = true): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ACCOUNT_LOCAL_CHANGED_EVENT, { detail: { snapshotId: manifest.snapshotId, logical } }));
}

function splitSession(session: AssistantSession): { chat: StoredChat; segments: StoredSegment[] } {
  const { losslessSegments = [], ...chat } = session;
  return {
    chat,
    segments: losslessSegments.map((segment) => ({ key: `${session.id}\0${segment.id}`, sessionId: session.id, segment })),
  };
}

function joinSession(chat: StoredChat, segments: StoredSegment[]): AssistantSession {
  return { ...chat, losslessSegments: segments.filter((entry) => entry.sessionId === chat.id).map((entry) => entry.segment) };
}

export function initializeAccountLocalStore(seed: Omit<SyncableAccountData, "schemaVersion">): Promise<LocalAccountSnapshot> {
  initializationPromise ??= initializeAccountLocalStoreOnce(seed).finally(() => { initializationPromise = null; });
  return initializationPromise;
}

async function initializeAccountLocalStoreOnce(seed: Omit<SyncableAccountData, "schemaVersion">): Promise<LocalAccountSnapshot> {
  const existing = await loadLocalAccountSnapshot();
  if (existing) return existing;
  const db = await openDb();
  const tx = db.transaction(["meta", "core"], "readwrite");
  const now = new Date().toISOString();
  const manifest = initialAccountManifest(localDeviceId(), now);
  tx.objectStore("meta").add({ key: CURRENT_KEY, manifest, dirty: false, initializedAtUtc: now } satisfies StoredMeta);
  tx.objectStore("core").add({ key: CURRENT_KEY, schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings: seed.settings, costs: seed.costs, clipboard: seed.clipboard } satisfies StoredCore);
  await transactionDone(tx);
  return { data: { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, ...seed }, manifest, dirty: false };
}

export async function loadLocalAccountSnapshot(): Promise<LocalAccountSnapshot | null> {
  const db = await openDb();
  const tx = db.transaction(["meta", "core", "chats", "segments"], "readonly");
  const [meta, core, chats, segments] = await Promise.all([
    requestValue(tx.objectStore("meta").get(CURRENT_KEY)) as Promise<StoredMeta | undefined>,
    requestValue(tx.objectStore("core").get(CURRENT_KEY)) as Promise<StoredCore | undefined>,
    requestValue(tx.objectStore("chats").getAll()) as Promise<StoredChat[]>,
    requestValue(tx.objectStore("segments").getAll()) as Promise<StoredSegment[]>,
  ]);
  await transactionDone(tx);
  if (!meta || !core) return null;
  return {
    data: {
      schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
      settings: core.settings,
      costs: core.costs,
      clipboard: core.clipboard,
      chats: chats.map((chat) => joinSession(chat, segments)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    },
    manifest: meta.manifest,
    dirty: meta.dirty,
  };
}

async function updateCore(patch: Partial<Pick<StoredCore, "settings" | "costs" | "clipboard">>): Promise<AccountSyncManifest> {
  const db = await openDb();
  const tx = db.transaction(["meta", "core"], "readwrite");
  const metaStore = tx.objectStore("meta");
  const coreStore = tx.objectStore("core");
  const [meta, core] = await Promise.all([
    requestValue(metaStore.get(CURRENT_KEY)) as Promise<StoredMeta | undefined>,
    requestValue(coreStore.get(CURRENT_KEY)) as Promise<StoredCore | undefined>,
  ]);
  if (!meta || !core) { tx.abort(); throw new Error("Local account store has not been initialized."); }
  const manifest = nextAccountManifest(meta.manifest, localDeviceId());
  coreStore.put({ ...core, ...patch });
  metaStore.put({ ...meta, manifest, dirty: true });
  await transactionDone(tx);
  emitChanged(manifest);
  return manifest;
}

export async function saveLocalAccountSettings(settings: AppSettings): Promise<AccountSyncManifest> {
  const current = await loadLocalAccountSnapshot();
  if (!current) throw new Error("Local account store has not been initialized.");
  if (JSON.stringify(projectSyncableSettings(current.data.settings)) === JSON.stringify(projectSyncableSettings(settings))) {
    const db = await openDb();
    const tx = db.transaction(["meta", "core"], "readwrite");
    const metaStore = tx.objectStore("meta");
    const coreStore = tx.objectStore("core");
    const [meta, core] = await Promise.all([
      requestValue(metaStore.get(CURRENT_KEY)) as Promise<StoredMeta | undefined>,
      requestValue(coreStore.get(CURRENT_KEY)) as Promise<StoredCore | undefined>,
    ]);
    if (!meta || !core) { tx.abort(); throw new Error("Local account store has not been initialized."); }
    if (meta.manifest.snapshotId !== current.manifest.snapshotId) { tx.abort(); throw new LocalAccountSnapshotChangedError(); }
    coreStore.put({ ...core, settings });
    await transactionDone(tx);
    return meta.manifest;
  }
  return updateCore({ settings });
}

export function saveLocalAccountCosts(costs: CostsFile): Promise<AccountSyncManifest> {
  return updateCore({ costs });
}

export function saveLocalAccountClipboard(clipboard: ClipboardEntry[]): Promise<AccountSyncManifest> {
  return updateCore({ clipboard });
}

export async function saveLocalAssistantSession(session: AssistantSession): Promise<AccountSyncManifest> {
  const db = await openDb();
  const tx = db.transaction(["meta", "chats", "segments"], "readwrite");
  const metaStore = tx.objectStore("meta");
  const meta = await requestValue(metaStore.get(CURRENT_KEY)) as StoredMeta | undefined;
  if (!meta) { tx.abort(); throw new Error("Local account store has not been initialized."); }
  const { chat, segments } = splitSession(session);
  tx.objectStore("chats").put(chat);
  const segmentStore = tx.objectStore("segments");
  const existingKeys = await requestValue(segmentStore.index("sessionId").getAllKeys(session.id));
  const nextKeys = new Set(segments.map((entry) => entry.key));
  for (const key of existingKeys) if (!nextKeys.has(String(key))) segmentStore.delete(key);
  for (const segment of segments) segmentStore.put(segment);
  const manifest = nextAccountManifest(meta.manifest, localDeviceId());
  metaStore.put({ ...meta, manifest, dirty: true });
  await transactionDone(tx);
  emitChanged(manifest);
  return manifest;
}

export async function loadLocalAssistantSession(sessionId: string): Promise<AssistantSession | null> {
  const db = await openDb();
  const tx = db.transaction(["chats", "segments"], "readonly");
  const [chat, segments] = await Promise.all([
    requestValue(tx.objectStore("chats").get(sessionId)) as Promise<StoredChat | undefined>,
    requestValue(tx.objectStore("segments").index("sessionId").getAll(sessionId)) as Promise<StoredSegment[]>,
  ]);
  await transactionDone(tx);
  return chat ? joinSession(chat, segments) : null;
}

export async function listLocalAssistantSessions(): Promise<Array<Pick<AssistantSession, "id" | "title" | "contextTitle" | "updatedAt" | "contentRevision"> & { fileId: string }>> {
  const db = await openDb();
  const tx = db.transaction("chats", "readonly");
  const chats = await requestValue(tx.objectStore("chats").getAll()) as StoredChat[];
  await transactionDone(tx);
  return chats.map((chat) => ({ id: chat.id, fileId: chat.id, title: chat.title, contextTitle: chat.contextTitle, updatedAt: chat.updatedAt, contentRevision: chat.contentRevision }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function deleteLocalAssistantSession(sessionId: string): Promise<AccountSyncManifest> {
  const db = await openDb();
  const tx = db.transaction(["meta", "chats", "segments"], "readwrite");
  const metaStore = tx.objectStore("meta");
  const meta = await requestValue(metaStore.get(CURRENT_KEY)) as StoredMeta | undefined;
  if (!meta) { tx.abort(); throw new Error("Local account store has not been initialized."); }
  tx.objectStore("chats").delete(sessionId);
  const segmentStore = tx.objectStore("segments");
  for (const key of await requestValue(segmentStore.index("sessionId").getAllKeys(sessionId))) segmentStore.delete(key);
  const manifest = nextAccountManifest(meta.manifest, localDeviceId());
  metaStore.put({ ...meta, manifest, dirty: true });
  await transactionDone(tx);
  emitChanged(manifest);
  return manifest;
}

export async function replaceLocalAccountSnapshot(data: SyncableAccountData, sourceManifests: AccountSyncManifest[], reason: string, expectedLocalSnapshotId?: string): Promise<LocalAccountSnapshot> {
  const current = await loadLocalAccountSnapshot();
  const manifest = reconciledAccountManifest(sourceManifests.length ? sourceManifests : current ? [current.manifest] : [], localDeviceId());
  return replaceSnapshotAtomically(data, manifest, true, reason, expectedLocalSnapshotId, true);
}

/** Adopt a causally newer remote snapshot without manufacturing a logical edit. */
export async function adoptRemoteAccountSnapshot(data: SyncableAccountData, manifest: AccountSyncManifest, reason: string, expectedLocalSnapshotId?: string): Promise<LocalAccountSnapshot> {
  return replaceSnapshotAtomically(data, manifest, false, reason, expectedLocalSnapshotId, false);
}

async function replaceSnapshotAtomically(data: SyncableAccountData, manifest: AccountSyncManifest, dirty: boolean, reason: string, expectedLocalSnapshotId: string | undefined, logical: boolean): Promise<LocalAccountSnapshot> {
  const db = await openDb();
  const tx = db.transaction(["meta", "core", "chats", "segments", "recoveries"], "readwrite");
  const metaStore = tx.objectStore("meta");
  const coreStore = tx.objectStore("core");
  const [currentMeta, currentCore, currentChats, currentSegments] = await Promise.all([
    requestValue(metaStore.get(CURRENT_KEY)) as Promise<StoredMeta | undefined>,
    requestValue(coreStore.get(CURRENT_KEY)) as Promise<StoredCore | undefined>,
    requestValue(tx.objectStore("chats").getAll()) as Promise<StoredChat[]>,
    requestValue(tx.objectStore("segments").getAll()) as Promise<StoredSegment[]>,
  ]);
  if (expectedLocalSnapshotId && currentMeta?.manifest.snapshotId !== expectedLocalSnapshotId) {
    tx.abort();
    throw new LocalAccountSnapshotChangedError();
  }
  const current = currentMeta && currentCore ? {
    data: { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings: currentCore.settings, costs: currentCore.costs, clipboard: currentCore.clipboard, chats: currentChats.map((chat) => joinSession(chat, currentSegments)) },
    manifest: currentMeta.manifest,
    dirty: currentMeta.dirty,
  } satisfies LocalAccountSnapshot : null;
  if (current) {
    const recoveries = tx.objectStore("recoveries");
    recoveries.put({ id: crypto.randomUUID(), createdAtUtc: new Date().toISOString(), reason, snapshot: current } satisfies StoredRecovery);
    const existing = await requestValue(recoveries.index("createdAtUtc").getAll()) as StoredRecovery[];
    for (const recovery of existing.sort((left, right) => right.createdAtUtc.localeCompare(left.createdAtUtc)).slice(MAX_RECOVERIES - 1)) recoveries.delete(recovery.id);
  }
  coreStore.put({ key: CURRENT_KEY, schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings: data.settings, costs: data.costs, clipboard: data.clipboard } satisfies StoredCore);
  tx.objectStore("chats").clear();
  tx.objectStore("segments").clear();
  for (const session of data.chats) {
    const { chat, segments } = splitSession(session);
    tx.objectStore("chats").put(chat);
    for (const segment of segments) tx.objectStore("segments").put(segment);
  }
  metaStore.put({ key: CURRENT_KEY, manifest, dirty, initializedAtUtc: currentMeta?.initializedAtUtc ?? new Date().toISOString() } satisfies StoredMeta);
  await transactionDone(tx);
  emitChanged(manifest, logical);
  return { data, manifest, dirty };
}

export class LocalAccountSnapshotChangedError extends Error {
  readonly code = "LOCAL_ACCOUNT_SNAPSHOT_CHANGED";
  constructor() { super("Local account data changed while synchronization was in progress."); this.name = "LocalAccountSnapshotChangedError"; }
}

export async function updateLocalAccountManifest(manifest: AccountSyncManifest, dirty: boolean, expectedSnapshotId?: string): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction("meta", "readwrite");
  const store = tx.objectStore("meta");
  const current = await requestValue(store.get(CURRENT_KEY)) as StoredMeta | undefined;
  if (!current) { tx.abort(); throw new Error("Local account store has not been initialized."); }
  if (expectedSnapshotId && current.manifest.snapshotId !== expectedSnapshotId) { tx.abort(); return false; }
  store.put({ ...current, manifest, dirty });
  await transactionDone(tx);
  return true;
}

export async function markLocalAccountReplicaConfirmed(snapshotId: string): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction("meta", "readwrite");
  const store = tx.objectStore("meta");
  const meta = await requestValue(store.get(CURRENT_KEY)) as StoredMeta | undefined;
  const matched = meta?.manifest.snapshotId === snapshotId;
  if (meta && matched) store.put({ ...meta, dirty: false });
  await transactionDone(tx);
  return Boolean(matched);
}

export async function loadLocalSyncConfiguration(): Promise<LocalSyncConfiguration> {
  const db = await openDb();
  const tx = db.transaction("deviceConfiguration", "readonly");
  const stored = await requestValue(tx.objectStore("deviceConfiguration").get(CURRENT_KEY)) as StoredConfiguration | undefined;
  await transactionDone(tx);
  return stored?.value ?? {};
}

export async function saveLocalSyncConfiguration(value: LocalSyncConfiguration): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("deviceConfiguration", "readwrite");
  tx.objectStore("deviceConfiguration").put({ key: CURRENT_KEY, value } satisfies StoredConfiguration);
  await transactionDone(tx);
}

export async function deleteAllLocalAccountData(): Promise<void> {
  await initializationPromise?.catch(() => undefined);
  initializationPromise = null;
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Local account deletion is blocked by another Narrarium tab."));
  });
}

export function closeAccountLocalStoreForTests(): void {
  initializationPromise = null;
  void dbPromise?.then((db) => db.close());
  dbPromise = null;
}
