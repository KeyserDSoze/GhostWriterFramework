import { useEffect, useRef } from "react";
import { useGoogleLogin } from "@react-oauth/google";
import { useMsal } from "@azure/msal-react";
import { useAuthStore } from "@/store/authStore";
import { findMicrosoftAccount, microsoftSilentRequest } from "@/config/msal";
import { GOOGLE_DRIVE_SCOPES } from "@/config/googleAuth";
import { registerCloudAccount } from "@/drive/cloudWriteBarrier";
import { accountIdentity, isAccountIdentityCurrent, requireGoogleProviderAccountId } from "@/auth/accountIdentity";

const REFRESH_BEFORE_MS = 5 * 60 * 1000;

export function useTokenRefresh() {
  const user = useAuthStore((state) => state.user);
  const accessTokenExpiry = useAuthStore((state) => state.accessTokenExpiry);
  const { setAuth } = useAuthStore();
  const { instance } = useMsal();
  const refreshStateRef = useRef<{ identity: string | null; generation: number }>({ identity: null, generation: 0 });
  const googleAttemptRef = useRef<{ key: string; active: boolean } | null>(null);
  const identity = accountIdentity(user);
  if (refreshStateRef.current.identity !== identity) {
    refreshStateRef.current = { identity, generation: refreshStateRef.current.generation + 1 };
    googleAttemptRef.current = null;
  }

  const refreshGoogle = useGoogleLogin({
    scope: GOOGLE_DRIVE_SCOPES,
    prompt: "none",
    hint: user?.email,
    onSuccess: async (tokenResponse) => {
      if (!user || !identity) return;
      const generation = refreshStateRef.current.generation;
      const ownsRefresh = () => refreshStateRef.current.identity === identity
        && refreshStateRef.current.generation === generation
        && isAccountIdentityCurrent(identity, useAuthStore.getState().user);
      if (!ownsRefresh()) return;
      const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${tokenResponse.access_token}` } });
      if (!ownsRefresh()) return;
      if (!response.ok) return;
      const profile = await response.json() as { sub?: string; email?: string };
      if (!ownsRefresh()) return;
      let providerAccountId: string;
      try { providerAccountId = requireGoogleProviderAccountId(profile); } catch { return; }
      if (!ownsRefresh() || providerAccountId !== user.providerAccountId || profile.email?.trim().toLocaleLowerCase() !== user.email.trim().toLocaleLowerCase()) return;
      registerCloudAccount("google", tokenResponse.access_token, user.providerAccountId);
      if (!ownsRefresh()) return;
      setAuth(tokenResponse.access_token, user, "expires_in" in tokenResponse ? tokenResponse.expires_in : 3600);
      googleAttemptRef.current = null;
    },
    // Background refresh must never log the user out. A failed silent refresh
    // leaves the current token in place; AuthGuard handles real expiry.
    onError: () => {
      if (googleAttemptRef.current) googleAttemptRef.current.active = false;
    },
  });

  useEffect(() => {
    if (!user || !accessTokenExpiry) return;
    let cancelled = false;

    const refresh = () => {
      if (cancelled) return;
      const expectedIdentity = identity;
      const generation = refreshStateRef.current.generation;
      const ownsRefresh = () => !cancelled && refreshStateRef.current.identity === expectedIdentity
        && refreshStateRef.current.generation === generation
        && isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user);
      if (!ownsRefresh()) return;
      if (user.provider === "google") {
        // Google token flow cannot guarantee a truly silent refresh after the
        // provider session expires. Never open an automatic popup for an
        // already-expired token; AuthGuard sends the user to explicit login.
        if (Date.now() >= accessTokenExpiry) return;
        const key = `${expectedIdentity}:${accessTokenExpiry}`;
        if (googleAttemptRef.current?.key === key) return;
        googleAttemptRef.current = { key, active: true };
        try { refreshGoogle(); }
        catch { if (googleAttemptRef.current?.key === key) googleAttemptRef.current.active = false; }
        return;
      }
      const account = findMicrosoftAccount(user);
      if (!account?.homeAccountId?.trim() || !account.localAccountId?.trim()) return; // keep current session; AuthGuard will prompt if truly needed
      instance.acquireTokenSilent({ ...microsoftSilentRequest(account), forceRefresh: true })
        .then((result) => {
          if (!ownsRefresh()) return;
          if (!result.account || result.account.homeAccountId !== account.homeAccountId || result.account.localAccountId !== account.localAccountId) return;
          instance.setActiveAccount(result.account);
          const expiresAt = result.expiresOn?.getTime() ?? Date.now() + 3600_000;
          const upgradedUser = { ...user, providerAccountId: account.homeAccountId, homeAccountId: account.homeAccountId, localAccountId: account.localAccountId };
          registerCloudAccount("microsoft", result.accessToken, account.homeAccountId);
          if (!ownsRefresh()) return;
          setAuth(result.accessToken, upgradedUser, Math.max(120, Math.round((expiresAt - Date.now()) / 1000)));
        })
        .catch((err) => {
          // Never clear auth in the background. Retry later instead.
          console.warn("Background token refresh failed; will retry", err);
        });
    };

    const invalidateExpiredToken = () => {
      const expectedIdentity = identity;
      const generation = refreshStateRef.current.generation;
      if (cancelled || refreshStateRef.current.identity !== expectedIdentity || refreshStateRef.current.generation !== generation || !isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user)) return;
      const current = useAuthStore.getState();
      if (current.accessTokenExpiry === accessTokenExpiry && Date.now() >= accessTokenExpiry) current.invalidateToken();
    };

    const scheduleRefresh = (): number => {
      const msLeft = accessTokenExpiry - Date.now();
      if (msLeft <= REFRESH_BEFORE_MS) {
        refresh();
        return window.setTimeout(() => undefined, Math.max(10_000, msLeft));
      }
      return window.setTimeout(refresh, Math.max(10_000, msLeft - REFRESH_BEFORE_MS));
    };

    const scheduleExpiry = () => window.setTimeout(invalidateExpiredToken, Math.max(0, accessTokenExpiry - Date.now()));
    let refreshTimer = scheduleRefresh();
    let expiryTimer = scheduleExpiry();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(refreshTimer);
        window.clearTimeout(expiryTimer);
        refreshTimer = scheduleRefresh();
        expiryTimer = scheduleExpiry();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      window.clearTimeout(expiryTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [accessTokenExpiry, identity, instance, refreshGoogle, setAuth, user]);
}
