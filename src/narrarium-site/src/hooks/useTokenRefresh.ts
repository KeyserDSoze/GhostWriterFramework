import { useEffect } from "react";
import { useGoogleLogin } from "@react-oauth/google";
import { useMsal } from "@azure/msal-react";
import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { useAuthStore } from "@/store/authStore";
import { findMicrosoftAccountByEmail, microsoftSilentRequest } from "@/config/msal";
import { GOOGLE_DRIVE_SCOPES } from "@/config/googleAuth";

const REFRESH_BEFORE_MS = 5 * 60 * 1000;

export function useTokenRefresh() {
  const user = useAuthStore((state) => state.user);
  const accessTokenExpiry = useAuthStore((state) => state.accessTokenExpiry);
  const { setAuth, clearAuth } = useAuthStore();
  const { instance } = useMsal();

  const refreshGoogle = useGoogleLogin({
    scope: GOOGLE_DRIVE_SCOPES,
    prompt: "none",
    hint: user?.email,
    onSuccess: (tokenResponse) => {
      if (!user) return;
      setAuth(tokenResponse.access_token, user, "expires_in" in tokenResponse ? tokenResponse.expires_in : 3600);
    },
    onError: () => clearAuth(),
  });

  useEffect(() => {
    if (!user || !accessTokenExpiry) return;
    const refresh = () => {
      if (user.provider === "google") {
        refreshGoogle();
        return;
      }
      const account = findMicrosoftAccountByEmail(user.email);
      if (!account) {
        clearAuth();
        return;
      }
      instance.acquireTokenSilent(microsoftSilentRequest(account))
        .then((result) => {
          if (result.account) instance.setActiveAccount(result.account);
          const expiresAt = result.expiresOn?.getTime() ?? Date.now() + 3600_000;
          setAuth(result.accessToken, user, Math.max(120, Math.round((expiresAt - Date.now()) / 1000)));
        })
        .catch((err) => {
          if (err instanceof InteractionRequiredAuthError) clearAuth();
          else console.warn("Token refresh failed", err);
        });
    };

    const schedule = () => {
      const msLeft = accessTokenExpiry - Date.now();
      if (msLeft <= REFRESH_BEFORE_MS) refresh();
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
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [accessTokenExpiry, clearAuth, instance, refreshGoogle, setAuth, user]);
}
