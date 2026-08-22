import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { accountIdentity, clearLegacyAccountUpgrade, finalizeInteractiveLegacyAccountUpgrade } from "../auth/accountIdentity.ts";
import { clearAccountContinuity, continuityToUser, migrateLegacyAuthStorage, readAccountContinuity, readBoundVolatileAuth, readVolatileAuthHint, sanitizeVolatileAuthStorage, saveAccountContinuity, VOLATILE_AUTH_STORAGE_KEY } from "../auth/accountContinuity.ts";
import { clearTokenHealth } from "../repository/tokenHealth.ts";

const AUTH_STORAGE_KEY = VOLATILE_AUTH_STORAGE_KEY;
export const PERSISTENT_AUTH_STORAGE_KEY = "narrarium-auth-persistent-v1";

interface PersistentAuthRecord {
  accessToken: string;
  accessTokenExpiry: number;
  provider: AuthProvider;
  providerAccountId: string;
}

export function readPersistentAuth(): PersistentAuthRecord | null {
  try {
    const raw = localStorage.getItem(PERSISTENT_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistentAuthRecord>;
    if (!value.accessToken || !value.accessTokenExpiry || value.accessTokenExpiry <= Date.now() || !value.provider || !value.providerAccountId) {
      localStorage.removeItem(PERSISTENT_AUTH_STORAGE_KEY);
      return null;
    }
    return value as PersistentAuthRecord;
  } catch {
    return null;
  }
}

function writePersistentAuth(record: PersistentAuthRecord | null): void {
  try {
    if (record) localStorage.setItem(PERSISTENT_AUTH_STORAGE_KEY, JSON.stringify(record));
    else localStorage.removeItem(PERSISTENT_AUTH_STORAGE_KEY);
  } catch { /* Persistent login is optional and must not block authentication. */ }
}

function sessionAuthStorage(): Storage {
  migrateLegacyAuthStorage();
  return {
    get length() { return sessionStorage.length; },
    clear: () => sessionStorage.clear(),
    getItem: (key) => key === AUTH_STORAGE_KEY ? sanitizeVolatileAuthStorage(sessionStorage.getItem(key)) : sessionStorage.getItem(key),
    key: (index) => sessionStorage.key(index),
    removeItem: (key) => sessionStorage.removeItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
  };
}

migrateLegacyAuthStorage();
const initialSessionHint = readVolatileAuthHint();
const initialSession = readBoundVolatileAuth();
const initialPersistent = readPersistentAuth();
const selectedProvider = initialSession?.provider ?? initialPersistent?.provider ?? initialSessionHint?.provider;
const initialContinuity = selectedProvider
  ? readAccountContinuity(selectedProvider)
  : readAccountContinuity();

export type AuthProvider = "google" | "microsoft";

export interface AppUser {
  provider: AuthProvider;
  /** Immutable provider subject: Google OIDC sub or Microsoft homeAccountId. */
  providerAccountId?: string;
  name: string;
  email: string;
  picture: string;
  /** Immutable MSAL identifiers. Required after a legacy Microsoft session is refreshed. */
  homeAccountId?: string;
  localAccountId?: string;
}

export type GoogleUser = AppUser;

interface AuthState {
  /** Google OAuth access token – used for Drive API calls */
  accessToken: string | null;
  /** Unix ms timestamp when the token expires (with 60s buffer) */
  accessTokenExpiry: number | null;
  rememberMe: boolean;
  provider: AuthProvider | null;
  providerAccountId: string | null;
  user: AppUser | null;
  /** Keeps account-local state scoped during the identity-bound recovery login round trip. */
  interactiveRecoveryIdentity: string | null;
  setAuth: (accessToken: string, user: AppUser, expiresIn?: number) => void;
  setInteractiveAuth: (accessToken: string, user: AppUser, expiresIn?: number, rememberMe?: boolean) => void;
  setRememberMe: (rememberMe: boolean) => void;
  clearAuth: () => void;
  clearAuthForLegacyUpgrade: () => void;
  beginInteractiveRecoveryAuth: () => void;
  clearInteractiveRecoveryAuth: () => void;
  /** Nulls the token (but keeps user) so AuthGuard triggers silent re-auth */
  invalidateToken: () => void;
  isTokenValid: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: initialSession?.accessToken ?? initialPersistent?.accessToken ?? null,
      accessTokenExpiry: initialSession?.accessTokenExpiry ?? initialPersistent?.accessTokenExpiry ?? null,
      rememberMe: Boolean(initialPersistent),
      provider: initialSession?.provider ?? initialPersistent?.provider ?? null,
      providerAccountId: initialSession?.providerAccountId ?? initialPersistent?.providerAccountId ?? null,
      user: initialContinuity ? continuityToUser(initialContinuity) : null,
      interactiveRecoveryIdentity: null,
      setAuth: (accessToken, user, expiresIn = 3600) =>
        set(() => {
          saveAccountContinuity(user);
          const rememberMe = get().rememberMe;
          const accessTokenExpiry = Date.now() + (expiresIn - 60) * 1000;
          writePersistentAuth(rememberMe ? { accessToken, accessTokenExpiry, provider: user.provider, providerAccountId: user.providerAccountId! } : null);
          return {
            accessToken,
            user,
            accessTokenExpiry,
            provider: user.provider,
            providerAccountId: user.providerAccountId ?? null,
            interactiveRecoveryIdentity: null,
          };
        }),
      setInteractiveAuth: (accessToken, user, expiresIn = 3600, rememberMe = false) => {
        finalizeInteractiveLegacyAccountUpgrade(user);
        saveAccountContinuity(user);
        const accessTokenExpiry = Date.now() + (expiresIn - 60) * 1000;
        writePersistentAuth(rememberMe ? { accessToken, accessTokenExpiry, provider: user.provider, providerAccountId: user.providerAccountId! } : null);
        set({ accessToken, user, rememberMe, accessTokenExpiry, provider: user.provider, providerAccountId: user.providerAccountId ?? null, interactiveRecoveryIdentity: null });
      },
      setRememberMe: (rememberMe) => {
        set({ rememberMe });
        if (!rememberMe) writePersistentAuth(null);
      },
      clearAuth: () => {
        clearLegacyAccountUpgrade();
        clearTokenHealth();
        clearAccountContinuity();
        writePersistentAuth(null);
        set({ accessToken: null, user: null, rememberMe: false, accessTokenExpiry: null, provider: null, providerAccountId: null, interactiveRecoveryIdentity: null });
        try { sessionStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* Session storage may be unavailable during shutdown. */ }
      },
      clearAuthForLegacyUpgrade: () => set({ accessToken: null, accessTokenExpiry: null, provider: null, providerAccountId: null, user: null }),
      beginInteractiveRecoveryAuth: () => set((state) => ({
        accessToken: null,
        accessTokenExpiry: null,
        provider: null,
        providerAccountId: null,
        user: null,
        interactiveRecoveryIdentity: accountIdentity(state.user),
      })),
      clearInteractiveRecoveryAuth: () => set({ interactiveRecoveryIdentity: null }),
      invalidateToken: () => set({ accessToken: null, accessTokenExpiry: null, provider: null, providerAccountId: null }),
      isTokenValid: () => {
        const { accessToken, accessTokenExpiry, provider, providerAccountId, user } = get();
        if (!accessToken || !accessTokenExpiry || !provider || provider !== user?.provider || providerAccountId !== user.providerAccountId) return false;
        return Date.now() < accessTokenExpiry;
      },
    }),
    {
      name: AUTH_STORAGE_KEY,
      storage: createJSONStorage(sessionAuthStorage),
      // Only this tab's volatile bearer is persisted. Identity continuity is durable separately.
      partialize: (state) => ({
        accessToken: state.accessToken,
        accessTokenExpiry: state.accessTokenExpiry,
        provider: state.provider,
        providerAccountId: state.providerAccountId,
        rememberMe: state.rememberMe,
      }),
    },
  ),
);
