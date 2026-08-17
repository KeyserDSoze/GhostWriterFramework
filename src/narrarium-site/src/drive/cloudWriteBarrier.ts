import { useAuthStore, type AuthProvider } from "../store/authStore.ts";
import { accountIdentity } from "../auth/accountIdentity.ts";

interface WriteState { queue: Promise<void> }
interface LeaseRecord { id: string; owner: string; fence: number; expiresAt: number; deletion?: Tombstone; resumedDeletion?: ResumedDeletion }
interface ActiveLease { owner: string; fence: number; lost: boolean; heartbeat: ReturnType<typeof setInterval>; controller: AbortController }
export interface CloudDeletionTargetIntent {
  target: string;
  itemId?: string;
  name?: string;
  eTag?: string;
  role?: "ordinary" | "ownership-marker" | "root";
}
interface DeletionTarget extends CloudDeletionTargetIntent { operationId: string; state: "in-progress" | "completed" }
interface Tombstone {
  accountId: string;
  operationId: string;
  generation: string;
  ownerNonce: string;
  fence: number;
  state: "requesting" | "deleting" | "deleted" | "nothing-to-delete";
  phase: string;
  heartbeatAt: number;
  expiresAt: number;
  completedTargets: string[];
  targets: DeletionTarget[];
  mutations: number;
  error?: string;
  terminalReason?: string;
}
interface ResumedDeletion { accountId: string; generation: string; fence: number }
export interface CloudDeletionHandle { provider: AuthProvider; token: string; id: string; operationId: string; generation: string; owner: string; fence: number; leaseFence: number; mutations: number; completedTargets: string[]; phase: string }

const TOMBSTONE_PREFIX = "narrarium-cloud-write-suspended-v3.";
const LEASE_DB = "narrarium-cloud-write-leases";
const LEASE_STORE = "leases";
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 5_000;
const POLL_MS = 50;
const states = new Map<string, WriteState>();
const accountKeys = new Map<string, string>();
const activeLeases = new Map<string, ActiveLease>();
const deletionLeases = new Map<string, ActiveLease>();
const memoryTombstones = new Map<string, Tombstone>();
const channel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("narrarium-cloud-write-barrier-v3") : null;
if (channel && "unref" in channel && typeof channel.unref === "function") channel.unref();
let leaseDbPromise: Promise<IDBDatabase> | null = null;
let failNextResumeTransaction = false;
let crashNextResumeAfterCommit = false;
let crashNextDeletionTransitionAfterCommit = false;
let crashNextDeletionMutationAfterProviderSuccess = false;
let crashNextDeletionMutationAfterCompletedMark = false;

function key(provider: AuthProvider, token: string): string {
  const auth = useAuthStore.getState();
  if (auth.accessToken === token && auth.user?.provider === provider) {
    const stable = accountIdentity(auth.user);
    if (!stable) throw new Error("Immutable cloud account identity is unavailable.");
    accountKeys.set(`${provider}:${token}`, stable);
    return stable;
  }
  return accountKeys.get(`${provider}:${token}`) ?? `${provider}:token:${token}`;
}

function tombstoneKey(id: string): string { return `${TOMBSTONE_PREFIX}${encodeURIComponent(id)}`; }
function readTombstoneMirror(id: string): Tombstone | null {
  if (typeof localStorage === "undefined") return memoryTombstones.get(id) ?? null;
  try {
    const value = JSON.parse(localStorage.getItem(tombstoneKey(id)) ?? "null") as Tombstone | null;
    return value && typeof value.generation === "string" && typeof value.ownerNonce === "string" && typeof value.fence === "number" && (value.state === "requesting" || value.state === "deleting" || value.state === "deleted" || value.state === "nothing-to-delete") ? value : null;
  } catch { return null; }
}
function sameTombstone(first: Tombstone | null, second: Tombstone | null): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}
function writeTombstone(id: string, value: Tombstone | null): void {
  if (value) memoryTombstones.set(id, value); else memoryTombstones.delete(id);
  if (typeof localStorage !== "undefined") {
    if (value) localStorage.setItem(tombstoneKey(id), JSON.stringify(value));
    else localStorage.removeItem(tombstoneKey(id));
  }
  channel?.postMessage({ id, tombstone: value });
}
channel?.addEventListener("message", (event: MessageEvent<{ id?: unknown; tombstone?: unknown }>) => {
  const id = event.data?.id;
  if (typeof id !== "string") return;
  void loadAuthoritativeTombstone(id).catch(() => undefined);
});
function stateById(id: string): WriteState {
  const existing = states.get(id);
  if (existing) return existing;
  const created = { queue: Promise.resolve() };
  states.set(id, created);
  return created;
}

function openLeaseDb(): Promise<IDBDatabase> {
  leaseDbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(LEASE_DB, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => request.result.createObjectStore(LEASE_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
  }).catch((error): never => { leaseDbPromise = null; throw error; });
  return leaseDbPromise;
}
async function mutateLease<T>(run: (store: IDBObjectStore, finish: (value: T) => void) => void): Promise<T> {
  const db = await openLeaseDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(LEASE_STORE, "readwrite");
    let result: T;
    run(tx.objectStore(LEASE_STORE), (value) => { result = value; });
    tx.oncomplete = () => resolve(result!);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Cloud lease transaction aborted."));
  });
}
async function readLeaseRecord(id: string): Promise<LeaseRecord | null> {
  if (typeof indexedDB === "undefined") throw new Error("Durable cloud write storage is unavailable.");
  const db = await openLeaseDb();
  return new Promise<LeaseRecord | null>((resolve, reject) => {
    const tx = db.transaction(LEASE_STORE, "readonly");
    const request = tx.objectStore(LEASE_STORE).get(id);
    request.onsuccess = () => resolve((request.result as LeaseRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}
async function loadAuthoritativeTombstone(id: string): Promise<Tombstone | null> {
  const deletion = (await readLeaseRecord(id))?.deletion ?? null;
  const authoritative = deletion?.accountId === id ? deletion : null;
  if (!sameTombstone(readTombstoneMirror(id), authoritative)) writeTombstone(id, authoritative);
  else if (authoritative) memoryTombstones.set(id, authoritative);
  else memoryTombstones.delete(id);
  return authoritative;
}
async function claimLease(id: string, owner: string, deletion?: { owner: string; generation: string; fence: number }): Promise<number | null> {
  return mutateLease<number | null>((store, finish) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as LeaseRecord | undefined;
      if (current?.deletion && (!deletion || current.deletion.ownerNonce !== deletion.owner || current.deletion.generation !== deletion.generation || current.deletion.fence !== deletion.fence)) { finish(null); return; }
      if (current && current.owner !== owner && current.expiresAt > Date.now()) { finish(null); return; }
      const fence = (current?.fence ?? 0) + 1;
      store.put({ ...current, id, owner, fence, expiresAt: Date.now() + LEASE_MS } satisfies LeaseRecord);
      finish(fence);
    };
  });
}
async function refreshLease(id: string, owner: string, fence: number, deletion?: { owner: string; generation: string; fence: number }): Promise<boolean> {
  return mutateLease<boolean>((store, finish) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as LeaseRecord | undefined;
      if (current?.owner !== owner || current.fence !== fence) { finish(false); return; }
      if (current.deletion && current.deletion.state !== "requesting" && (!deletion || current.deletion.ownerNonce !== deletion.owner || current.deletion.generation !== deletion.generation || current.deletion.fence !== deletion.fence)) { finish(false); return; }
      store.put({ ...current, id, owner, fence, expiresAt: Date.now() + LEASE_MS } satisfies LeaseRecord);
      finish(true);
    };
  });
}

function loseLease(active: ActiveLease, message: string): void {
  if (active.lost) return;
  active.lost = true;
  active.controller.abort(new Error(message));
}
async function releaseLease(id: string, owner: string, fence: number): Promise<void> {
  await mutateLease<void>((store, finish) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as LeaseRecord | undefined;
      if (current?.owner === owner && current.fence === fence) store.put({ ...current, expiresAt: 0 });
      finish();
    };
  });
}
async function claimDeletionIntent(id: string): Promise<Tombstone | null> {
  const now = Date.now();
  if (typeof indexedDB === "undefined") throw new Error("Durable cloud deletion storage is unavailable.");
  return mutateLease<Tombstone | null>((store, finish) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as LeaseRecord | undefined;
      const deletion = current?.deletion;
      if (deletion?.state === "deleted" || deletion?.state === "nothing-to-delete" || ((deletion?.state === "requesting" || deletion?.state === "deleting") && deletion.expiresAt > now)) { finish(null); return; }
      const operationId = deletion?.operationId ?? deletion?.generation ?? crypto.randomUUID();
      const generation = deletion ? crypto.randomUUID() : operationId;
      const targets = (deletion?.targets ?? []).map((target) => ({ ...target, operationId: target.operationId ?? operationId }));
      const next: Tombstone = { accountId: id, operationId, ownerNonce: crypto.randomUUID(), generation, fence: (deletion?.fence ?? 0) + 1, state: "requesting", phase: deletion ? "reclaiming" : "waiting-for-writes", heartbeatAt: now, expiresAt: now + LEASE_MS, completedTargets: [...(deletion?.completedTargets ?? [])], targets, mutations: deletion?.mutations ?? 0, error: deletion?.error };
      store.put({ id, owner: current?.owner ?? "", fence: current?.fence ?? 0, expiresAt: current?.expiresAt ?? 0, deletion: next } satisfies LeaseRecord);
      finish(next);
    };
  });
}

async function clearDeletionIntent(id: string, owner: string, generation: string, fence: number): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await mutateLease<void>((store, finish) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as LeaseRecord | undefined;
      if (current?.deletion?.ownerNonce === owner && current.deletion.generation === generation && current.deletion.fence === fence) store.put({ ...current, deletion: undefined });
      finish();
    };
  });
}

async function transitionResumedDeletion(id: string, observedGeneration: string, observedFence: number | null): Promise<boolean> {
  const db = await openLeaseDb();
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(LEASE_STORE, "readwrite");
    const store = tx.objectStore(LEASE_STORE);
    let resumed = false;
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result as LeaseRecord | undefined;
      const deletion = record?.deletion;
      if (failNextResumeTransaction) {
        failNextResumeTransaction = false;
        tx.abort();
        return;
      }
      if (deletion) {
        if (observedFence === null || deletion.accountId !== id || (deletion.state !== "deleted" && deletion.state !== "nothing-to-delete") || (deletion.operationId ?? deletion.generation) !== observedGeneration || deletion.fence !== observedFence) return;
        store.put({ ...record, owner: "", expiresAt: 0, deletion: undefined, resumedDeletion: { accountId: id, generation: observedGeneration, fence: observedFence } });
        resumed = true;
        return;
      }
      resumed = record?.resumedDeletion?.accountId === id
        && record.resumedDeletion.generation === observedGeneration
        && (observedFence === null || record.resumedDeletion.fence === observedFence);
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(resumed);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Cloud resume transaction aborted."));
  });
}

function abortError(signal: AbortSignal): unknown { return signal.reason instanceof Error ? signal.reason : new DOMException("The cloud operation was cancelled.", "AbortError"); }
function suspendedError(): Error { return new Error("Cloud writes are suspended because app data was deleted. Reconnect the account to save again."); }
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(abortError(signal)); }, { once: true });
  });
}

async function acquireDurableLease(id: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  if (typeof indexedDB === "undefined") throw new Error("Durable cloud write storage is unavailable.");
  const owner = crypto.randomUUID();
  let fence: number | null = null;
  while (fence == null) {
    if (signal?.aborted) throw abortError(signal);
    if (await loadAuthoritativeTombstone(id)) throw suspendedError();
    fence = await claimLease(id, owner);
    if (fence == null) {
      if (await loadAuthoritativeTombstone(id)) throw suspendedError();
      await wait(POLL_MS, signal);
    }
  }
  const active: ActiveLease = { owner, fence, lost: false, heartbeat: 0 as unknown as ReturnType<typeof setInterval>, controller: new AbortController() };
  active.heartbeat = setInterval(() => {
    void refreshLease(id, owner, fence!).then((ok) => { if (!ok) loseLease(active, "The cloud write heartbeat lost its fence."); }).catch(() => { loseLease(active, "The cloud write heartbeat failed."); });
  }, HEARTBEAT_MS);
  activeLeases.set(id, active);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(active.heartbeat);
    if (activeLeases.get(id) === active) activeLeases.delete(id);
    await releaseLease(id, owner, fence!);
  };
}

export function registerCloudAccount(provider: AuthProvider, token: string, identity: string): void {
  if (!identity.trim()) throw new Error("Cloud account identity is unavailable.");
  accountKeys.set(`${provider}:${token}`, `${provider}:${identity.trim().toLowerCase()}`);
}
export function registeredCloudAccount(provider: AuthProvider, token: string): string | null {
  const value = accountKeys.get(`${provider}:${token}`);
  return value?.startsWith(`${provider}:`) ? value.slice(provider.length + 1) : null;
}

export async function acquireCloudWriteLease(provider: AuthProvider, token: string, signal?: AbortSignal): Promise<() => void> {
  const id = key(provider, token);
  if (signal?.aborted) throw abortError(signal);
  if (await loadAuthoritativeTombstone(id)) throw suspendedError();
  if (signal?.aborted) throw abortError(signal);
  const current = stateById(id);
  let releaseQueue!: () => void;
  const previous = current.queue;
  current.queue = new Promise<void>((resolve) => { releaseQueue = resolve; });
  try {
    if (signal) await Promise.race([previous, new Promise<never>((_, reject) => {
      if (signal.aborted) reject(abortError(signal));
      else signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
    })]);
    else await previous;
  } catch (error) { void previous.then(releaseQueue); throw error; }
  if (await loadAuthoritativeTombstone(id)) { releaseQueue(); throw suspendedError(); }
  let releaseDurable: () => Promise<void>;
  try { releaseDurable = await acquireDurableLease(id, signal); } catch (error) { releaseQueue(); throw error; }
  if (await loadAuthoritativeTombstone(id)) {
    await releaseDurable();
    releaseQueue();
    throw suspendedError();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    void releaseDurable().catch(() => undefined).finally(releaseQueue);
  };
}
export const beginCloudWrite = acquireCloudWriteLease;

export async function assertCloudWriteAllowed(provider: AuthProvider, token: string): Promise<void> {
  const id = key(provider, token);
  const active = activeLeases.get(id);
  if (!active || active.lost) throw new Error("The cloud write lease was lost.");
  const deletion = await loadAuthoritativeTombstone(id);
  if (deletion && deletion.state !== "requesting") throw suspendedError();
  const renewed = await refreshLease(id, active.owner, active.fence);
  if (!renewed) {
    loseLease(active, "The cloud write fence is stale.");
    throw new Error("The cloud write fence is stale.");
  }
  const afterRenewal = await loadAuthoritativeTombstone(id);
  if (afterRenewal && afterRenewal.state !== "requesting") throw suspendedError();
}

export async function fencedCloudMutation(provider: AuthProvider, token: string, input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  await assertCloudWriteAllowed(provider, token);
  const active = activeLeases.get(key(provider, token));
  const signal = combineSignals(init.signal, active?.controller.signal);
  return fetch(input, { ...init, ...(signal ? { signal } : {}) });
}

function combineSignals(first?: AbortSignal | null, second?: AbortSignal | null): AbortSignal | undefined {
  const signals = [first, second].filter((signal): signal is AbortSignal => Boolean(signal));
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export async function suspendCloudWrites(provider: AuthProvider, token: string): Promise<CloudDeletionHandle> {
  const id = key(provider, token);
  const deletion = await claimDeletionIntent(id);
  if (!deletion) throw new Error("Another cloud deletion owns this account.");
  const owner = deletion.ownerNonce;
  const operationId = deletion.operationId;
  const generation = deletion.generation;
  writeTombstone(id, deletion);
  await stateById(id).queue;
  const leaseFence = await acquireDeletionLease(id, owner, generation, deletion.fence);
  const deleting = await transitionDeletionRequest(id, owner, generation, deletion.fence, leaseFence);
  writeTombstone(id, deleting);
  const afterClaim = await loadAuthoritativeTombstone(id);
  if (!afterClaim || afterClaim.ownerNonce !== owner || afterClaim.generation !== generation || afterClaim.fence !== deletion.fence) {
    if (typeof indexedDB !== "undefined") await releaseLease(id, owner, leaseFence);
    throw new Error("Another cloud deletion owns this account.");
  }
  if (typeof indexedDB !== "undefined") {
    const active: ActiveLease = { owner, fence: leaseFence, lost: false, heartbeat: 0 as unknown as ReturnType<typeof setInterval>, controller: new AbortController() };
    active.heartbeat = setInterval(() => {
      void heartbeatCloudDeletion({ provider, token, id, operationId, owner, generation, fence: deletion.fence, leaseFence, mutations: deletion.mutations, completedTargets: deletion.completedTargets, phase: deletion.phase }).catch(() => { loseLease(active, "The cloud deletion heartbeat failed."); });
    }, HEARTBEAT_MS);
    deletionLeases.set(id, active);
  }
  return { provider, token, id, operationId, owner, generation, fence: deletion.fence, leaseFence, mutations: deleting.mutations, completedTargets: [...deleting.completedTargets], phase: deleting.phase };
}
async function acquireDeletionLease(id: string, owner: string, generation: string, deletionFence: number): Promise<number> {
  let fence: number | null = null;
  while (fence == null) {
    const tombstone = await loadAuthoritativeTombstone(id);
    if (tombstone && (tombstone.ownerNonce !== owner || tombstone.generation !== generation || tombstone.fence !== deletionFence)) throw new Error("Another cloud deletion owns this account.");
    await refreshDeletionRequest(id, owner, generation, deletionFence);
    fence = await claimLease(id, owner, { owner, generation, fence: deletionFence });
    if (fence == null) await wait(POLL_MS);
  }
  return fence;
}
async function refreshDeletionRequest(id: string, owner: string, generation: string, deletionFence: number): Promise<void> {
  await mutateLease<void>((store, finish) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result as LeaseRecord | undefined;
      const deletion = record?.deletion;
      if (!record || !deletion || deletion.state !== "requesting" || deletion.ownerNonce !== owner || deletion.generation !== generation || deletion.fence !== deletionFence) {
        request.transaction?.abort();
        return;
      }
      const now = Date.now();
      store.put({ ...record, deletion: { ...deletion, heartbeatAt: now, expiresAt: now + LEASE_MS } });
      finish();
    };
  }).catch(() => { throw new Error("Another cloud deletion owns this account."); });
}
async function transitionDeletionRequest(id: string, owner: string, generation: string, deletionFence: number, leaseFence: number): Promise<Tombstone> {
  return mutateLease<Tombstone>((store, finish) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result as LeaseRecord | undefined;
      const deletion = record?.deletion;
      if (!record || record.owner !== owner || record.fence !== leaseFence || !deletion || deletion.state !== "requesting"
        || deletion.ownerNonce !== owner || deletion.generation !== generation || deletion.fence !== deletionFence) {
        request.transaction?.abort();
        return;
      }
      const next = { ...deletion, state: "deleting" as const, phase: deletion.targets.length ? "reclaiming" : "starting", heartbeatAt: Date.now(), expiresAt: Date.now() + LEASE_MS };
      store.put({ ...record, deletion: next });
      finish(next);
    };
  }).catch(() => { throw new Error("Cloud deletion request ownership was lost."); });
}
export async function completeCloudDeletion(handle: CloudDeletionHandle, deleted: boolean): Promise<void> {
  try {
    const current = await loadAuthoritativeTombstone(handle.id);
    if (current?.state === "nothing-to-delete" && current.operationId === handle.operationId && current.ownerNonce === handle.owner && current.generation === handle.generation && current.fence === handle.fence && !deleted) return;
    if (current?.state === "deleted" && current.operationId === handle.operationId && current.ownerNonce === handle.owner && current.generation === handle.generation && current.fence === handle.fence && deleted) return;
    if (!current || current.operationId !== handle.operationId || current.ownerNonce !== handle.owner || current.generation !== handle.generation || current.fence !== handle.fence) throw new Error("Cloud deletion ownership was lost.");
    const targets = current.targets ?? [];
    if (!deleted || !targets.length || targets.some((target) => target.operationId !== handle.operationId || target.state !== "completed")) {
      throw new Error("Cloud deletion cannot complete until every durable target intent is completed.");
    }
    const final = { ...current, state: "deleted" as const, phase: "complete", heartbeatAt: Date.now(), expiresAt: 0, mutations: targets.length, completedTargets: targets.map((target) => target.target), error: undefined };
    await transitionDeletionOwner(handle, final);
    if (crashNextDeletionTransitionAfterCommit) {
      crashNextDeletionTransitionAfterCommit = false;
      throw new Error("Simulated crash after durable cloud deletion transition.");
    }
    writeTombstone(handle.id, final);
  } finally {
    stopDeletionHeartbeat(handle);
  }
}

function stopDeletionHeartbeat(handle: CloudDeletionHandle): void {
  const active = deletionLeases.get(handle.id);
  if (active?.owner !== handle.owner || active.fence !== handle.leaseFence) return;
  clearInterval(active.heartbeat);
  deletionLeases.delete(handle.id);
}

async function transitionDeletionOwner(handle: CloudDeletionHandle, deletion: Tombstone | null): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openLeaseDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(LEASE_STORE, "readwrite");
    const store = tx.objectStore(LEASE_STORE);
    let ownershipError: Error | null = null;
    const request = store.get(handle.id);
    request.onsuccess = () => {
      const record = request.result as LeaseRecord | undefined;
      const current = record?.deletion;
      if (!record || record.owner !== handle.owner || record.fence !== handle.leaseFence
        || !current || current.operationId !== handle.operationId || current.ownerNonce !== handle.owner || current.generation !== handle.generation || current.fence !== handle.fence) {
        ownershipError = new Error("Cloud deletion ownership was lost.");
        tx.abort();
        return;
      }
      store.put({ ...record, owner: "", expiresAt: 0, deletion: deletion ?? undefined });
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(ownershipError ?? tx.error);
    tx.onabort = () => reject(ownershipError ?? tx.error ?? new Error("Cloud deletion transition was aborted."));
  });
}

async function heartbeatCloudDeletion(handle: CloudDeletionHandle): Promise<void> {
  const now = Date.now();
  const current = await loadAuthoritativeTombstone(handle.id);
  if (!current || current.operationId !== handle.operationId || current.ownerNonce !== handle.owner || current.generation !== handle.generation || current.fence !== handle.fence || current.state !== "deleting") throw new Error("Cloud deletion ownership was lost.");
  const next = { ...current, heartbeatAt: now, expiresAt: now + LEASE_MS };
  if (typeof indexedDB !== "undefined") {
    const ok = await refreshLease(handle.id, handle.owner, handle.leaseFence, { owner: handle.owner, generation: handle.generation, fence: current.fence });
    if (!ok) throw new Error("Cloud deletion heartbeat failed.");
    await persistDeletionProgress(handle, next);
  }
  writeTombstone(handle.id, next);
}

async function persistDeletionProgress(handle: CloudDeletionHandle, tombstone?: Tombstone): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await mutateLease<void>((store, finish) => {
    const request = store.get(handle.id);
    request.onsuccess = () => {
      const record = request.result as LeaseRecord | undefined;
      const current = record?.deletion;
      if (!record || !current || current.operationId !== handle.operationId || current.ownerNonce !== handle.owner || current.generation !== handle.generation || current.fence !== handle.fence) { request.transaction?.abort(); return; }
      store.put({ ...record, deletion: tombstone ?? { ...current, phase: handle.phase, completedTargets: [...handle.completedTargets], mutations: handle.mutations, error: undefined } });
      finish();
    };
  });
}

export async function updateCloudDeletionPhase(handle: CloudDeletionHandle, phase: string): Promise<void> {
  handle.phase = phase;
  await heartbeatCloudDeletion(handle);
  await persistDeletionProgress(handle);
}

export async function failCloudDeletion(handle: CloudDeletionHandle, error: unknown): Promise<void> {
  try {
    const current = await loadAuthoritativeTombstone(handle.id);
    if (!current || current.operationId !== handle.operationId || current.ownerNonce !== handle.owner || current.generation !== handle.generation || current.fence !== handle.fence) throw new Error("Cloud deletion ownership was lost.");
    const now = Date.now();
    const next = { ...current, heartbeatAt: now, expiresAt: now, phase: handle.phase, error: error instanceof Error ? error.message : String(error) };
    await transitionDeletionOwner(handle, next);
    if (crashNextDeletionTransitionAfterCommit) {
      crashNextDeletionTransitionAfterCommit = false;
      throw new Error("Simulated crash after durable cloud deletion transition.");
    }
    writeTombstone(handle.id, next);
  } finally {
    stopDeletionHeartbeat(handle);
  }
}

export async function fencedCloudDeletionMutation(handle: CloudDeletionHandle, input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  if (init.method?.toUpperCase() !== "DELETE") throw new Error("Cloud deletion targets require DELETE requests.");
  const target = String(input);
  await transitionDeletionTarget(handle, target, "in-progress");
  const active = deletionLeases.get(handle.id);
  if (active?.lost) throw new Error("Cloud deletion lease was lost.");
  const signal = combineSignals(init.signal, active?.controller.signal);
  const response = await fetch(input, { ...init, ...(signal ? { signal } : {}) });
  if (response.ok || response.status === 404) {
    if (crashNextDeletionMutationAfterProviderSuccess) {
      crashNextDeletionMutationAfterProviderSuccess = false;
      throw new Error("Simulated crash after provider deletion success.");
    }
    await transitionDeletionTarget(handle, target, "completed");
    if (!handle.completedTargets.includes(target)) handle.completedTargets.push(target);
    handle.mutations = handle.completedTargets.length;
    if (crashNextDeletionMutationAfterCompletedMark) {
      crashNextDeletionMutationAfterCompletedMark = false;
      throw new Error("Simulated crash after durable target completion.");
    }
  }
  return response;
}

export async function journalCloudDeletionTargets(handle: CloudDeletionHandle, intents: CloudDeletionTargetIntent[]): Promise<void> {
  if (!intents.length || new Set(intents.map((intent) => intent.target)).size !== intents.length) throw new Error("Cloud deletion target journal is invalid.");
  await mutateLease<void>((store, finish) => {
    const request = store.get(handle.id);
    request.onsuccess = () => {
      const record = request.result as LeaseRecord | undefined;
      const deletion = record?.deletion;
      if (!record || record.owner !== handle.owner || record.fence !== handle.leaseFence || !deletion
        || deletion.accountId !== handle.id || deletion.operationId !== handle.operationId || deletion.ownerNonce !== handle.owner
        || deletion.generation !== handle.generation || deletion.fence !== handle.fence || deletion.state !== "deleting") {
        request.transaction?.abort();
        return;
      }
      if (deletion.targets.length) {
        const existing = deletion.targets.map(({ operationId: _operationId, state: _state, ...intent }) => intent);
        if (JSON.stringify(existing) !== JSON.stringify(intents)) request.transaction?.abort();
        else finish();
        return;
      }
      store.put({ ...record, deletion: { ...deletion, targets: intents.map((intent) => ({ ...intent, operationId: handle.operationId, state: "in-progress" as const })) } });
      finish();
    };
  }).catch(() => { throw new Error("Cloud deletion journal ownership was lost or the verified target set changed."); });
}

export async function cloudDeletionTargetJournal(handle: CloudDeletionHandle): Promise<Array<CloudDeletionTargetIntent & { state: DeletionTarget["state"] }>> {
  const current = await loadAuthoritativeTombstone(handle.id);
  if (!current || current.operationId !== handle.operationId || current.ownerNonce !== handle.owner || current.generation !== handle.generation || current.fence !== handle.fence || current.state !== "deleting") throw new Error("Cloud deletion ownership was lost.");
  return (current.targets ?? []).filter((target) => target.operationId === handle.operationId).map(({ operationId: _operationId, ...target }) => target);
}

export async function completeCloudDeletionNothingToDelete(handle: CloudDeletionHandle, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error("Cloud deletion terminal reason is required.");
  const current = await loadAuthoritativeTombstone(handle.id);
  if (!current || current.operationId !== handle.operationId || current.ownerNonce !== handle.owner || current.generation !== handle.generation || current.fence !== handle.fence || current.state !== "deleting") throw new Error("Cloud deletion ownership was lost.");
  if ((current.targets ?? []).length) throw new Error("A journaled cloud deletion cannot become nothing-to-delete.");
  const terminal: Tombstone = { ...current, state: "nothing-to-delete", phase: "nothing-to-delete", heartbeatAt: Date.now(), expiresAt: 0, terminalReason: reason.trim(), error: undefined };
  await transitionDeletionOwner(handle, terminal);
  stopDeletionHeartbeat(handle);
  writeTombstone(handle.id, terminal);
}

async function transitionDeletionTarget(handle: CloudDeletionHandle, target: string, state: DeletionTarget["state"]): Promise<void> {
  await mutateLease<void>((store, finish) => {
    const request = store.get(handle.id);
    request.onsuccess = () => {
      const record = request.result as LeaseRecord | undefined;
      const deletion = record?.deletion;
      if (!record || record.owner !== handle.owner || record.fence !== handle.leaseFence || !deletion
        || deletion.accountId !== handle.id || deletion.operationId !== handle.operationId || deletion.ownerNonce !== handle.owner || deletion.generation !== handle.generation
        || deletion.fence !== handle.fence || deletion.state !== "deleting") {
        request.transaction?.abort();
        return;
      }
      const targets = [...(deletion.targets ?? [])];
      const index = targets.findIndex((entry) => entry.operationId === handle.operationId && entry.target === target);
      if (state === "completed" && index < 0) {
        request.transaction?.abort();
        return;
      }
      if (index < 0) targets.push({ target, operationId: handle.operationId, state });
      else if (targets[index].state !== "completed") targets[index] = { ...targets[index], state };
      const completedTargets = targets.filter((entry) => entry.state === "completed").map((entry) => entry.target);
      store.put({ ...record, deletion: { ...deletion, targets, completedTargets, mutations: completedTargets.length } });
      finish();
    };
  }).catch(() => { throw new Error("Cloud deletion ownership was lost."); });
}

export async function pendingCloudDeletionTargets(handle: CloudDeletionHandle, prefix: string): Promise<string[]> {
  const current = await loadAuthoritativeTombstone(handle.id);
  if (!current || current.operationId !== handle.operationId || current.ownerNonce !== handle.owner || current.generation !== handle.generation || current.fence !== handle.fence || current.state !== "deleting") throw new Error("Cloud deletion ownership was lost.");
  return (current.targets ?? []).filter((target) => target.operationId === handle.operationId && target.state === "in-progress" && target.target.startsWith(prefix)).map((target) => target.target);
}
export async function completedCloudDeletionGeneration(provider: AuthProvider, token: string): Promise<string | null> {
  const value = await loadAuthoritativeTombstone(key(provider, token));
  return value?.state === "deleted" ? value.operationId ?? value.generation : null;
}
export interface CloudDeletionReconnectState { state: "deleted" | "nothing-to-delete"; generation: string; reason?: string }
export async function cloudDeletionReconnectState(provider: AuthProvider, token: string): Promise<CloudDeletionReconnectState | null> {
  const value = await loadAuthoritativeTombstone(key(provider, token));
  if (!value || (value.state !== "deleted" && value.state !== "nothing-to-delete")) return null;
  return { state: value.state, generation: value.operationId ?? value.generation, ...(value.terminalReason ? { reason: value.terminalReason } : {}) };
}
export async function resumeCloudWrites(provider: AuthProvider, token: string, observedGeneration: string): Promise<boolean> {
  const registeredIdentity = registeredCloudAccount(provider, token);
  if (!registeredIdentity) throw new Error("Immutable cloud account identity is unavailable.");
  const id = `${provider}:${registeredIdentity}`;
  const current = await loadAuthoritativeTombstone(id);
  if (current && (current.accountId !== id || (current.state !== "deleted" && current.state !== "nothing-to-delete") || (current.operationId ?? current.generation) !== observedGeneration)) return false;
  if (typeof indexedDB === "undefined") throw new Error("Durable cloud resume storage is unavailable.");
  if (!await transitionResumedDeletion(id, observedGeneration, current?.fence ?? null)) return false;
  if (crashNextResumeAfterCommit) {
    crashNextResumeAfterCommit = false;
    throw new Error("Simulated crash after durable cloud resume.");
  }
  writeTombstone(id, null);
  return true;
}
export async function cloudWritesSuspended(provider: AuthProvider, token: string): Promise<boolean> { return Boolean(await loadAuthoritativeTombstone(key(provider, token))); }

export function acquireDurableCloudLeaseForTests(id: string, signal?: AbortSignal): Promise<() => Promise<void>> { return acquireDurableLease(id, signal); }

export async function invalidateActiveCloudFenceForTests(provider: AuthProvider, token: string): Promise<void> {
  const id = key(provider, token);
  const active = activeLeases.get(id);
  if (!active || typeof indexedDB === "undefined") return;
  await mutateLease<void>((store, finish) => { store.put({ id, owner: "other-context", fence: active.fence + 1, expiresAt: Date.now() + LEASE_MS }); finish(); });
}

export function failActiveCloudHeartbeatForTests(provider: AuthProvider, token: string): void {
  const active = activeLeases.get(key(provider, token));
  if (active) loseLease(active, "The cloud write heartbeat failed.");
}

export async function reserveCloudDeletionForTests(provider: AuthProvider, token: string): Promise<() => Promise<void>> {
  const id = key(provider, token);
  const deletion = await claimDeletionIntent(id);
  if (!deletion) throw new Error("Another cloud deletion owns this account.");
  return () => clearDeletionIntent(id, deletion.ownerNonce, deletion.generation, deletion.fence);
}

export function simulateCloudDeletionReloadForTests(): void {
  for (const active of deletionLeases.values()) clearInterval(active.heartbeat);
  deletionLeases.clear();
}

export function resetCloudWriteBarrierForTests(): void {
  for (const active of activeLeases.values()) {
    clearInterval(active.heartbeat);
    active.controller.abort();
  }
  for (const active of deletionLeases.values()) {
    clearInterval(active.heartbeat);
    active.controller.abort();
  }
  activeLeases.clear();
  deletionLeases.clear();
  states.clear();
  accountKeys.clear();
  memoryTombstones.clear();
  channel?.close();
  void leaseDbPromise?.then((db) => db.close());
  leaseDbPromise = null;
}

export function failNextCloudResumeTransactionForTests(): void { failNextResumeTransaction = true; }
export function crashNextCloudResumeAfterCommitForTests(): void { crashNextResumeAfterCommit = true; }
export function crashNextCloudDeletionTransitionAfterCommitForTests(): void { crashNextDeletionTransitionAfterCommit = true; }
export function crashNextCloudDeletionMutationAfterProviderSuccessForTests(): void { crashNextDeletionMutationAfterProviderSuccess = true; }
export function crashNextCloudDeletionMutationAfterCompletedMarkForTests(): void { crashNextDeletionMutationAfterCompletedMark = true; }
export async function expireCloudDeletionLeaseForTests(handle: CloudDeletionHandle): Promise<void> {
  stopDeletionHeartbeat(handle);
  await mutateLease<void>((store, finish) => {
    const request = store.get(handle.id);
    request.onsuccess = () => {
      const record = request.result as LeaseRecord | undefined;
      const deletion = record?.deletion;
      if (!record || !deletion || deletion.operationId !== handle.operationId || deletion.ownerNonce !== handle.owner || deletion.generation !== handle.generation || deletion.fence !== handle.fence) {
        request.transaction?.abort();
        return;
      }
      store.put({ ...record, expiresAt: 0, deletion: { ...deletion, expiresAt: 0, heartbeatAt: 0 } });
      finish();
    };
  });
}
export async function completeCloudDeletionTargetForTests(handle: CloudDeletionHandle, target = "test://completed-target"): Promise<void> {
  await transitionDeletionTarget(handle, target, "in-progress");
  await transitionDeletionTarget(handle, target, "completed");
  handle.completedTargets.push(target);
  handle.mutations = handle.completedTargets.length;
}
export function writeCloudTombstoneMirrorForTests(handle: CloudDeletionHandle, state: Tombstone["state"] | null): void {
  writeTombstone(handle.id, state ? {
    accountId: handle.id,
    operationId: handle.operationId,
    generation: handle.generation,
    ownerNonce: handle.owner,
    fence: handle.fence,
    state,
    phase: handle.phase,
    heartbeatAt: Date.now(),
    expiresAt: state === "requesting" || state === "deleting" ? Date.now() + LEASE_MS : 0,
    completedTargets: [...handle.completedTargets],
    targets: handle.completedTargets.map((target) => ({ target, operationId: handle.operationId, state: "completed" })),
    mutations: handle.mutations,
  } : null);
}
