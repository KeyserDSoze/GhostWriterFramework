import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { accountIdentity, clearLegacyAccountUpgrade, finalizeInteractiveLegacyAccountUpgrade } from "../auth/accountIdentity.ts";

const AUTH_STORAGE_KEY = "narrarium-bms-auth";

function sessionAuthStorage(): Storage {
  const legacy = localStorage.getItem(AUTH_STORAGE_KEY);
  if (!sessionStorage.getItem(AUTH_STORAGE_KEY) && legacy) sessionStorage.setItem(AUTH_STORAGE_KEY, legacy);
  if (legacy) localStorage.removeItem(AUTH_STORAGE_KEY);
  return sessionStorage;
}

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
      user: null,
      interactiveRecoveryIdentity: null,
      setAuth: (accessToken, user, expiresIn = 3600) =>
        set({
          accessToken,
          user,
          // subtract 60s buffer so we refresh before actual expiry
          accessTokenExpiry: Date.now() + (expiresIn - 60) * 1000,
          interactiveRecoveryIdentity: null,
        }),
      setInteractiveAuth: (accessToken, user, expiresIn = 3600) => {
        finalizeInteractiveLegacyAccountUpgrade(user);
        set({ accessToken, user, accessTokenExpiry: Date.now() + (expiresIn - 60) * 1000, interactiveRecoveryIdentity: null });
      },
      clearAuth: () => {
        clearLegacyAccountUpgrade();
        set({ accessToken: null, user: null, accessTokenExpiry: null, interactiveRecoveryIdentity: null });
      },
      clearAuthForLegacyUpgrade: () => set({ accessToken: null, user: null, accessTokenExpiry: null }),
      beginInteractiveRecoveryAuth: () => set((state) => ({
        accessToken: null,
        user: null,
        accessTokenExpiry: null,
        interactiveRecoveryIdentity: accountIdentity(state.user),
      })),
      clearInteractiveRecoveryAuth: () => set({ interactiveRecoveryIdentity: null }),
      invalidateToken: () =>
        set({ accessToken: null, accessTokenExpiry: null }),
      isTokenValid: () => {
        const { accessToken, accessTokenExpiry } = get();
        if (!accessToken || !accessTokenExpiry) return false;
        return Date.now() < accessTokenExpiry;
      },
    }),
    {
      name: AUTH_STORAGE_KEY,
      storage: createJSONStorage(sessionAuthStorage),
      // Keep reload continuity without leaving bearer tokens on a shared device after the tab session.
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        accessTokenExpiry: state.accessTokenExpiry,
        interactiveRecoveryIdentity: state.interactiveRecoveryIdentity,
      }),
    },
  ),
);
