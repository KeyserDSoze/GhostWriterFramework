import { useAuthStore, type AuthProvider } from "../store/authStore.ts";

interface WriteState {
  active: number;
  suspended: boolean;
  waiters: Array<() => void>;
  leaseHeld: boolean;
  leaseWaiters: Array<{ resolve: (release: () => void) => void; reject: (error: unknown) => void; signal?: AbortSignal; abort?: () => void }>;
}

const states = new Map<string, WriteState>();
const accountKeys = new Map<string, string>();

function key(provider: AuthProvider, token: string): string {
  const auth = useAuthStore.getState();
  if (auth.accessToken === token && auth.user?.provider === provider) {
    const stableKey = `${provider}:${auth.user.email.trim().toLowerCase()}`;
    accountKeys.set(`${provider}:${token}`, stableKey);
    return stableKey;
  }
  return accountKeys.get(`${provider}:${token}`) ?? `${provider}:token:${token}`;
}

export function registerCloudAccount(provider: AuthProvider, token: string, identity: string): void {
  accountKeys.set(`${provider}:${token}`, `${provider}:${identity.trim().toLowerCase()}`);
}

function state(provider: AuthProvider, token: string): WriteState {
  const id = key(provider, token);
  const existing = states.get(id);
  if (existing) return existing;
  const created: WriteState = { active: 0, suspended: false, waiters: [], leaseHeld: false, leaseWaiters: [] };
  states.set(id, created);
  return created;
}

/** Serializes complete cloud mutations and maintenance passes for one provider account. */
export function acquireCloudWriteLease(provider: AuthProvider, token: string, signal?: AbortSignal): Promise<() => void> {
  const current = state(provider, token);
  if (current.suspended) return Promise.reject(new Error("Cloud writes are suspended because app data was deleted. Reconnect the account to save again."));
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const grant = () => {
      current.leaseHeld = true;
      current.active += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        current.leaseHeld = false;
        current.active = Math.max(0, current.active - 1);
        if (current.active === 0) current.waiters.splice(0).forEach((done) => done());
        grantNextLease(current);
      });
    };
    if (!current.leaseHeld && current.leaseWaiters.length === 0) { grant(); return; }
    const waiter: WriteState["leaseWaiters"][number] = { resolve, reject, signal };
    waiter.abort = () => {
      const index = current.leaseWaiters.indexOf(waiter);
      if (index >= 0) current.leaseWaiters.splice(index, 1);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", waiter.abort, { once: true });
    current.leaseWaiters.push(waiter);
  });
}

function grantNextLease(current: WriteState): void {
  while (!current.leaseHeld && current.leaseWaiters.length) {
    const waiter = current.leaseWaiters.shift()!;
    waiter.signal?.removeEventListener("abort", waiter.abort!);
    if (waiter.signal?.aborted) { waiter.reject(abortError(waiter.signal)); continue; }
    if (current.suspended) { waiter.reject(new Error("Cloud writes are suspended because app data was deleted. Reconnect the account to save again.")); continue; }
    current.leaseHeld = true;
    current.active += 1;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      current.leaseHeld = false;
      current.active = Math.max(0, current.active - 1);
      if (current.active === 0) current.waiters.splice(0).forEach((done) => done());
      grantNextLease(current);
    });
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The cloud operation was cancelled.", "AbortError");
}

export function beginCloudWrite(provider: AuthProvider, token: string): () => void {
  const current = state(provider, token);
  if (current.suspended) throw new Error("Cloud writes are suspended because app data was deleted. Reconnect the account to save again.");
  current.active += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    current.active = Math.max(0, current.active - 1);
    if (current.active === 0) current.waiters.splice(0).forEach((resolve) => resolve());
  };
}

export async function suspendCloudWrites(provider: AuthProvider, token: string): Promise<void> {
  const current = state(provider, token);
  current.suspended = true;
  if (current.active === 0) return;
  await new Promise<void>((resolve) => current.waiters.push(resolve));
}

export function resumeCloudWrites(provider: AuthProvider, token: string): void {
  const current = state(provider, token);
  current.suspended = false;
}

export function cloudWritesSuspended(provider: AuthProvider, token: string): boolean {
  return state(provider, token).suspended;
}
