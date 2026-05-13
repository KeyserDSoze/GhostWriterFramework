import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface GoogleUser {
  name: string;
  email: string;
  picture: string;
}

interface AuthState {
  /** Google OAuth access token – used for Drive API calls */
  accessToken: string | null;
  /** Unix ms timestamp when the token expires (with 60s buffer) */
  accessTokenExpiry: number | null;
  user: GoogleUser | null;
  setAuth: (accessToken: string, user: GoogleUser, expiresIn?: number) => void;
  clearAuth: () => void;
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
      setAuth: (accessToken, user, expiresIn = 3600) =>
        set({
          accessToken,
          user,
          // subtract 60s buffer so we refresh before actual expiry
          accessTokenExpiry: Date.now() + (expiresIn - 60) * 1000,
        }),
      clearAuth: () =>
        set({ accessToken: null, user: null, accessTokenExpiry: null }),
      invalidateToken: () =>
        set({ accessToken: null, accessTokenExpiry: null }),
      isTokenValid: () => {
        const { accessToken, accessTokenExpiry } = get();
        if (!accessToken || !accessTokenExpiry) return false;
        return Date.now() < accessTokenExpiry;
      },
    }),
    {
      name: "narrarium-bms-auth",
      // Persist token + expiry so F5 doesn't log the user out
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        accessTokenExpiry: state.accessTokenExpiry,
      }),
    },
  ),
);
