import { useAuthStore, type AuthProvider } from "../store/authStore.ts";

interface WriteState {
  active: number;
  suspended: boolean;
  waiters: Array<() => void>;
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
  const created = { active: 0, suspended: false, waiters: [] };
  states.set(id, created);
  return created;
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
