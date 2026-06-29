import { useEffect } from "react";
import { useGoogleLogin } from "@react-oauth/google";
import { useMsal } from "@azure/msal-react";
import { useAuthStore } from "@/store/authStore";
import { findMicrosoftAccountByEmail, microsoftSilentRequest } from "@/config/msal";
import { GOOGLE_DRIVE_SCOPES } from "@/config/googleAuth";

const REFRESH_BEFORE_MS = 5 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 1000;

export function useTokenRefresh() {
  const user = useAuthStore((state) => state.user);
  const accessTokenExpiry = useAuthStore((state) => state.accessTokenExpiry);
  const { setAuth } = useAuthStore();
  const { instance } = useMsal();

  const refreshGoogle = useGoogleLogin({
    scope: GOOGLE_DRIVE_SCOPES,
    prompt: "none",
    hint: user?.email,
    onSuccess: (tokenResponse) => {
      if (!user) return;
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
      if (user.provider === "google") {
        try { refreshGoogle(); } catch { /* ignore, will retry */ }
        return;
      }
      const account = findMicrosoftAccountByEmail(user.email);
      if (!account) return; // keep current session; AuthGuard will prompt if truly needed
      instance.acquireTokenSilent({ ...microsoftSilentRequest(account), forceRefresh: true })
        .then((result) => {
          if (cancelled) return;
          if (result.account) instance.setActiveAccount(result.account);
          const expiresAt = result.expiresOn?.getTime() ?? Date.now() + 3600_000;
          setAuth(result.accessToken, user, Math.max(120, Math.round((expiresAt - Date.now()) / 1000)));
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
  }, [accessTokenExpiry, instance, refreshGoogle, setAuth, user]);
}
