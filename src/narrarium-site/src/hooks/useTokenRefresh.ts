import { useEffect, useRef } from "react";
import { useGoogleLogin } from "@react-oauth/google";
import { useMsal } from "@azure/msal-react";
import { useAuthStore } from "@/store/authStore";
import { findMicrosoftAccount, microsoftSilentRequest } from "@/config/msal";
import { GOOGLE_DRIVE_SCOPES } from "@/config/googleAuth";
import { registerCloudAccount } from "@/drive/cloudWriteBarrier";
import { accountIdentity, isAccountIdentityCurrent, requireGoogleProviderAccountId } from "@/auth/accountIdentity";

const REFRESH_BEFORE_MS = 5 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 1000;

export function useTokenRefresh() {
  const user = useAuthStore((state) => state.user);
  const accessTokenExpiry = useAuthStore((state) => state.accessTokenExpiry);
  const { setAuth } = useAuthStore();
  const { instance } = useMsal();
  const refreshStateRef = useRef<{ identity: string | null; generation: number }>({ identity: null, generation: 0 });
  const identity = accountIdentity(user);
  if (refreshStateRef.current.identity !== identity) {
    refreshStateRef.current = { identity, generation: refreshStateRef.current.generation + 1 };
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
    },
    // Background refresh must never log the user out. A failed silent refresh
    // leaves the current token in place; AuthGuard handles real expiry.
    onError: () => undefined,
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
        try { refreshGoogle(); } catch { /* ignore, will retry */ }
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

    const schedule = (): number => {
      const msLeft = accessTokenExpiry - Date.now();
      if (msLeft <= REFRESH_BEFORE_MS) {
        refresh();
        return window.setTimeout(refresh, RETRY_AFTER_MS);
      }
      return window.setTimeout(refresh, Math.max(10_000, msLeft - REFRESH_BEFORE_MS));
    };

    let timer = schedule();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(timer);
        timer = schedule();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [accessTokenExpiry, identity, instance, refreshGoogle, setAuth, user]);
}
