import type { AccountInfo } from "@azure/msal-browser";
import type { AppUser, AuthProvider } from "@/store/authStore";

export const ACCOUNT_CONTINUITY_STORAGE_KEY = "narrarium-account-continuity-v1";
export const LEGACY_AUTH_STORAGE_KEY = "narrarium-bms-auth";
export const ACCOUNT_CONTINUITY_VERSION = 1 as const;
export const VOLATILE_AUTH_STORAGE_KEY = "narrarium-auth-session-v1";

export interface VolatileAuthState {
  accessToken: string | null;
  accessTokenExpiry: number | null;
  provider?: AuthProvider;
  providerAccountId?: string;
}

export interface AccountContinuity {
  version: typeof ACCOUNT_CONTINUITY_VERSION;
  provider: AuthProvider;
  providerAccountId: string;
  normalizedEmail: string;
  displayName: string;
  picture: string;
  homeAccountId?: string;
  localAccountId?: string;
  createdAt: number;
  lastSeen: number;
}

interface ContinuityEnvelope {
  version: typeof ACCOUNT_CONTINUITY_VERSION;
  accounts: Partial<Record<AuthProvider, AccountContinuity>>;
}

const PROVIDERS: AuthProvider[] = ["google", "microsoft"];
const BASE_RECORD_KEYS = ["createdAt", "displayName", "lastSeen", "normalizedEmail", "picture", "provider", "providerAccountId", "version"];
const MICROSOFT_RECORD_KEYS = [...BASE_RECORD_KEYS, "homeAccountId", "localAccountId"];

function storage(): Storage | null {
  try { return localStorage; } catch { return null; }
}

function sessionStorageSafe(): Storage | null {
  try { return sessionStorage; } catch { return null; }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validRecord(value: unknown, provider?: AuthProvider): value is AccountContinuity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AccountContinuity>;
  const keys = Object.keys(candidate).sort();
  const expectedKeys = (candidate.provider === "microsoft" ? MICROSOFT_RECORD_KEYS : BASE_RECORD_KEYS).sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])) return false;
  if (provider && candidate.provider !== provider) return false;
  if (candidate.version !== ACCOUNT_CONTINUITY_VERSION || !PROVIDERS.includes(candidate.provider as AuthProvider)) return false;
  if (!isNonEmptyString(candidate.providerAccountId) || !isNonEmptyString(candidate.normalizedEmail)
    || !isNonEmptyString(candidate.displayName) || typeof candidate.picture !== "string") return false;
  if (candidate.provider === "microsoft"
    && (!isNonEmptyString(candidate.homeAccountId) || !isNonEmptyString(candidate.localAccountId)
      || candidate.homeAccountId !== candidate.providerAccountId)) return false;
  return typeof candidate.createdAt === "number" && Number.isFinite(candidate.createdAt)
    && typeof candidate.lastSeen === "number" && Number.isFinite(candidate.lastSeen)
    && candidate.createdAt <= candidate.lastSeen;
}

function readEnvelope(): ContinuityEnvelope {
  const target = storage();
  const value = target?.getItem(ACCOUNT_CONTINUITY_STORAGE_KEY);
  if (!value) return { version: ACCOUNT_CONTINUITY_VERSION, accounts: {} };
  try {
    const parsed = JSON.parse(value) as Partial<ContinuityEnvelope>;
    if (parsed.version !== ACCOUNT_CONTINUITY_VERSION || !parsed.accounts || typeof parsed.accounts !== "object"
      || Object.keys(parsed).sort().join(",") !== "accounts,version"
      || Object.keys(parsed.accounts).some((provider) => !PROVIDERS.includes(provider as AuthProvider))) throw new Error("invalid continuity");
    const accounts: Partial<Record<AuthProvider, AccountContinuity>> = {};
    for (const provider of PROVIDERS) if (validRecord(parsed.accounts[provider], provider)) accounts[provider] = parsed.accounts[provider];
    return { version: ACCOUNT_CONTINUITY_VERSION, accounts };
  } catch {
    target?.removeItem(ACCOUNT_CONTINUITY_STORAGE_KEY);
    return { version: ACCOUNT_CONTINUITY_VERSION, accounts: {} };
  }
}

function writeEnvelope(envelope: ContinuityEnvelope): void {
  const target = storage();
  if (!target) return;
  try {
    target.setItem(ACCOUNT_CONTINUITY_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Continuity is best effort when browser storage is disabled or full.
  }
}

function parsePersistedSession(raw: string | null): VolatileAuthState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: Partial<VolatileAuthState>; version?: unknown };
    if (parsed.version !== 1 || Object.keys(parsed).sort().join(",") !== "state,version" || !parsed.state
      || Object.keys(parsed.state).sort().join(",") !== "accessToken,accessTokenExpiry,provider,providerAccountId") return null;
    return parsed.state && typeof parsed.state === "object" ? {
      accessToken: typeof parsed.state.accessToken === "string" ? parsed.state.accessToken : null,
      accessTokenExpiry: typeof parsed.state.accessTokenExpiry === "number" ? parsed.state.accessTokenExpiry : null,
      provider: parsed.state.provider,
      providerAccountId: parsed.state.providerAccountId,
    } : null;
  } catch { return null; }
}

function boundSession(state: VolatileAuthState, user?: AppUser): VolatileAuthState | null {
  const provider = state.provider ?? user?.provider;
  const providerAccountId = state.providerAccountId ?? user?.providerAccountId;
  if (!state.accessToken || !state.accessTokenExpiry || !provider || !providerAccountId) return null;
  const continuity = readAccountContinuity(provider);
  if (!continuity || continuity.providerAccountId !== providerAccountId) return null;
  if (user && (user.provider !== provider || user.providerAccountId !== providerAccountId)) return null;
  return { accessToken: state.accessToken, accessTokenExpiry: state.accessTokenExpiry, provider, providerAccountId };
}

function writePersistedSession(state: VolatileAuthState): void {
  const target = sessionStorageSafe();
  if (!target) return;
  try {
    target.setItem(VOLATILE_AUTH_STORAGE_KEY, JSON.stringify({
      state,
      version: 1,
    }));
  } catch { /* Session storage is volatile and optional. */ }
}

export function readBoundVolatileAuth(): VolatileAuthState | null {
  const target = sessionStorageSafe();
  const state = parsePersistedSession(target?.getItem(VOLATILE_AUTH_STORAGE_KEY) ?? null);
  const bound = state ? boundSession(state) : null;
  if (state && !bound) {
    try { target?.removeItem(VOLATILE_AUTH_STORAGE_KEY); } catch { /* Invalid bearer material is not retained when storage is restricted. */ }
  }
  return bound;
}

export function readVolatileAuthHint(): Pick<VolatileAuthState, "provider" | "providerAccountId"> | null {
  const state = parsePersistedSession(sessionStorageSafe()?.getItem(VOLATILE_AUTH_STORAGE_KEY) ?? null);
  return state?.provider && state.providerAccountId ? { provider: state.provider, providerAccountId: state.providerAccountId } : null;
}

export function sanitizeVolatileAuthStorage(raw: string | null): string | null {
  const state = parsePersistedSession(raw);
  if (!state || !boundSession(state)) {
    try { sessionStorageSafe()?.removeItem(VOLATILE_AUTH_STORAGE_KEY); } catch { /* Invalid bearer material is not retained when storage is restricted. */ }
    return null;
  }
  return JSON.stringify({ state, version: 1 });
}

export function createVolatileAuthState(accessToken: string, accessTokenExpiry: number, user: AppUser): VolatileAuthState {
  return { accessToken, accessTokenExpiry, provider: user.provider, providerAccountId: user.providerAccountId };
}

export function continuityToUser(record: AccountContinuity): AppUser {
  return {
    provider: record.provider,
    providerAccountId: record.providerAccountId,
    name: record.displayName,
    email: record.normalizedEmail,
    picture: record.picture,
    ...(record.provider === "microsoft" ? { homeAccountId: record.homeAccountId, localAccountId: record.localAccountId } : {}),
  };
}

export function readAccountContinuity(provider?: AuthProvider): AccountContinuity | null {
  const accounts = readEnvelope().accounts;
  return provider ? accounts[provider] ?? null : accounts.google ?? accounts.microsoft ?? null;
}

export function saveAccountContinuity(user: AppUser, now = Date.now()): AccountContinuity | null {
  if (!Number.isFinite(now) || !isNonEmptyString(user.providerAccountId)) return null;
  const providerAccountId = user.providerAccountId.trim();
  const normalizedEmail = user.email.trim().toLocaleLowerCase();
  if (!normalizedEmail || !user.name.trim()) return null;
  if (user.provider === "microsoft" && (!isNonEmptyString(user.homeAccountId) || !isNonEmptyString(user.localAccountId) || user.homeAccountId.trim() !== providerAccountId)) return null;
  const current = readAccountContinuity(user.provider);
  const record: AccountContinuity = {
    version: ACCOUNT_CONTINUITY_VERSION,
    provider: user.provider,
    providerAccountId,
    normalizedEmail,
    displayName: user.name.trim(),
    picture: user.picture ?? "",
    ...(user.provider === "microsoft" ? { homeAccountId: user.homeAccountId!.trim(), localAccountId: user.localAccountId!.trim() } : {}),
    createdAt: current?.providerAccountId === providerAccountId ? current.createdAt : now,
    lastSeen: now,
  };
  const envelope = readEnvelope();
  envelope.accounts[user.provider] = record;
  writeEnvelope(envelope);
  return record;
}

export function clearAccountContinuity(): void {
  try { storage()?.removeItem(ACCOUNT_CONTINUITY_STORAGE_KEY); } catch { /* Explicit signout still clears the in-memory session. */ }
}

export function migrateLegacyAuthStorage(): void {
  const target = storage();
  if (!target) return;
  // The old localStorage payload was a bearer-token container. Never copy it.
  try {
    const raw = target.getItem(LEGACY_AUTH_STORAGE_KEY);
    const candidate = JSON.parse(raw ?? "null") as { state?: { user?: AppUser } } | null;
    if (candidate?.state?.user) saveAccountContinuity(candidate.state.user);
  } catch { /* Invalid legacy data is removed when possible; no token is copied. */ }
  try { target.removeItem(LEGACY_AUTH_STORAGE_KEY); } catch { /* Nothing durable remains when removal is unavailable. */ }
  migrateLegacySessionKey(LEGACY_AUTH_STORAGE_KEY);
  migrateLegacySessionKey(VOLATILE_AUTH_STORAGE_KEY);
  try { sessionStorageSafe()?.removeItem(LEGACY_AUTH_STORAGE_KEY); } catch { /* Session cleanup is best effort. */ }
}

function migrateLegacySessionKey(key: string): void {
  const target = sessionStorageSafe();
  if (!target) return;
  try {
    const raw = target.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state?: { user?: AppUser; accessToken?: string; accessTokenExpiry?: number; provider?: AuthProvider; providerAccountId?: string } };
    const oldState = parsed.state;
    if (!oldState?.accessToken || !oldState.accessTokenExpiry) {
      target.removeItem(key);
      return;
    }
    const user = oldState.user;
    if (user?.providerAccountId && !readAccountContinuity(user.provider)) saveAccountContinuity(user);
    const bound = boundSession({
      accessToken: oldState.accessToken,
      accessTokenExpiry: oldState.accessTokenExpiry,
      provider: oldState.provider,
      providerAccountId: oldState.providerAccountId,
    }, user);
    if (bound) writePersistedSession(bound);
    else target.removeItem(key);
  } catch {
    try { target.removeItem(key); } catch { /* Invalid bearer material is not retained. */ }
  }
}

export function exactMicrosoftAccount(record: AccountContinuity, accounts: AccountInfo[]): AccountInfo | null {
  if (record.provider !== "microsoft") return null;
  return accounts.find((account) => account.homeAccountId === record.homeAccountId && account.localAccountId === record.localAccountId) ?? null;
}
