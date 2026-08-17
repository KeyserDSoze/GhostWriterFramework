import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { accountIdentity, clearLegacyAccountUpgrade, finalizeInteractiveLegacyAccountUpgrade } from "../auth/accountIdentity.ts";
import { clearAccountContinuity, continuityToUser, migrateLegacyAuthStorage, readAccountContinuity, readBoundVolatileAuth, readVolatileAuthHint, sanitizeVolatileAuthStorage, saveAccountContinuity, VOLATILE_AUTH_STORAGE_KEY } from "../auth/accountContinuity.ts";
import { clearTokenHealth } from "../repository/tokenHealth.ts";

const AUTH_STORAGE_KEY = VOLATILE_AUTH_STORAGE_KEY;

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
const selectedProvider = initialSession?.provider ?? initialSessionHint?.provider;
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
  provider: AuthProvider | null;
  providerAccountId: string | null;
  user: AppUser | null;
  /** Keeps account-local state scoped during the identity-bound recovery login round trip. */
  interactiveRecoveryIdentity: string | null;
  setAuth: (accessToken: string, user: AppUser, expiresIn?: number) => void;
  setInteractiveAuth: (accessToken: string, user: AppUser, expiresIn?: number) => void;
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
      accessToken: null,
      accessTokenExpiry: null,
      provider: initialSession?.provider ?? null,
      providerAccountId: initialSession?.providerAccountId ?? null,
      user: initialContinuity ? continuityToUser(initialContinuity) : null,
      interactiveRecoveryIdentity: null,
      setAuth: (accessToken, user, expiresIn = 3600) =>
        set(() => {
          saveAccountContinuity(user);
          return {
            accessToken,
            user,
            // subtract 60s buffer so we refresh before actual expiry
            accessTokenExpiry: Date.now() + (expiresIn - 60) * 1000,
            provider: user.provider,
            providerAccountId: user.providerAccountId ?? null,
            interactiveRecoveryIdentity: null,
          };
        }),
      setInteractiveAuth: (accessToken, user, expiresIn = 3600) => {
        finalizeInteractiveLegacyAccountUpgrade(user);
        saveAccountContinuity(user);
        set({ accessToken, user, accessTokenExpiry: Date.now() + (expiresIn - 60) * 1000, provider: user.provider, providerAccountId: user.providerAccountId ?? null, interactiveRecoveryIdentity: null });
      },
      clearAuth: () => {
        clearLegacyAccountUpgrade();
        clearTokenHealth();
        clearAccountContinuity();
        set({ accessToken: null, user: null, accessTokenExpiry: null, provider: null, providerAccountId: null, interactiveRecoveryIdentity: null });
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
      }),
    },
  ),
);
