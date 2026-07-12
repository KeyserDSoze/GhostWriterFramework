import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useGoogleLogin } from "@react-oauth/google";
import { useMsal } from "@azure/msal-react";
import { Loader2 } from "lucide-react";
import { useAuthStore, type GoogleUser } from "@/store/authStore";
import { useUiStore } from "@/store/uiStore";
import { ensureMsalInitialized, findMicrosoftAccountByEmail, microsoftSilentRequest } from "@/config/msal";
import { GOOGLE_DRIVE_SCOPES } from "@/config/googleAuth";

interface AuthGuardProps {
  children: React.ReactNode;
}

type Status = "checking" | "ok" | "unauthenticated";
const SILENT_AUTH_TIMEOUT_MS = 12000;

export function AuthGuard({ children }: AuthGuardProps) {
  const { t } = useTranslation();
  const { accessToken, accessTokenExpiry, user, setAuth, clearAuth } =
    useAuthStore();
  const { instance } = useMsal();
  const location = useLocation();
  const [status, setStatus] = useState<Status>("checking");
  const [silentAttemptNonce, setSilentAttemptNonce] = useState(0);
  const lastAttemptKeyRef = useRef("");
  const silentAuthTimeoutRef = useRef<number | null>(null);

  function clearSilentAuthTimeout() {
    if (silentAuthTimeoutRef.current != null) {
      window.clearTimeout(silentAuthTimeoutRef.current);
      silentAuthTimeoutRef.current = null;
    }
  }

  /** Give up gracefully: never nuke the session while offline or backgrounded. */
  function giveUpSilent() {
    clearSilentAuthTimeout();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // Offline: keep whatever we have; AuthGuard will retry when back online.
      useUiStore.getState().setAuthActivity("offline");
      setStatus((s) => (s === "checking" ? "checking" : s));
      return;
    }
    useUiStore.getState().setAuthActivity("idle");
    clearAuth();
    setStatus("unauthenticated");
  }

  function startSilentAuthTimeout() {
    clearSilentAuthTimeout();
    silentAuthTimeoutRef.current = window.setTimeout(() => {
      giveUpSilent();
    }, SILENT_AUTH_TIMEOUT_MS);
  }

  const silentLogin = useGoogleLogin({
    scope: GOOGLE_DRIVE_SCOPES,
    // prompt: "none" → no UI silent token refresh while the Google session cookie is alive.
    prompt: "none",
    hint: user?.email,
    onSuccess: (tokenResponse) => {
      clearSilentAuthTimeout();
      fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
      })
        .then((r) => r.json())
        .then((profile: Record<string, string>) => {
          const u: GoogleUser = {
            provider: "google",
            name: profile["name"] ?? "",
            email: profile["email"] ?? "",
            picture: profile["picture"] ?? "",
          };
          setAuth(
            tokenResponse.access_token,
            u,
            "expires_in" in tokenResponse
              ? (tokenResponse as { expires_in: number }).expires_in
              : 3600,
          );
          useUiStore.getState().setAuthActivity("idle");
          setStatus("ok");
        })
        .catch(() => {
          // Userinfo fetch failed (often a transient network hiccup) → keep the token,
          // it is still valid for Drive; do not force a logout.
          clearSilentAuthTimeout();
          useUiStore.getState().setAuthActivity("idle");
          setStatus("ok");
        });
    },
    // The token is already unusable here. One silent attempt is enough while
    // online; offline keeps the known user and retries when connectivity returns.
    onError: () => giveUpSilent(),
  });

  useEffect(() => {
    async function tryMicrosoftSilentLogin() {
      try {
        await ensureMsalInitialized();
        const account = findMicrosoftAccountByEmail(user?.email);
        if (!account) {
          clearAuth();
          setStatus("unauthenticated");
          return;
        }
        const result = await instance.acquireTokenSilent({ ...microsoftSilentRequest(account), forceRefresh: true });
        if (result.account) instance.setActiveAccount(result.account);
        const expiresAt = result.expiresOn?.getTime() ?? Date.now() + 3600_000;
        const expiresIn = Math.max(120, Math.round((expiresAt - Date.now()) / 1000));
        clearSilentAuthTimeout();
        setAuth(result.accessToken, user!, expiresIn);
        setStatus("ok");
      } catch {
        giveUpSilent();
      }
    }

    const tokenValid =
      !!accessToken &&
      !!accessTokenExpiry &&
      Date.now() < accessTokenExpiry;

    if (tokenValid) {
      clearSilentAuthTimeout();
      useUiStore.getState().setAuthActivity("idle");
      setStatus("ok");
    } else if (user?.provider === "google") {
      // Known user, but token missing/expired → try silent re-auth
      const attemptKey = `google:${user.email}:${accessToken ?? "missing"}:${accessTokenExpiry ?? 0}`;
      if (lastAttemptKeyRef.current === attemptKey) return;
      lastAttemptKeyRef.current = attemptKey;
      useUiStore.getState().setAuthActivity(navigator.onLine === false ? "offline" : "refreshing");
      setStatus("checking");
      startSilentAuthTimeout();
      silentLogin();
    } else if (user?.provider === "microsoft") {
      const attemptKey = `microsoft:${user.email}:${accessToken ?? "missing"}:${accessTokenExpiry ?? 0}`;
      if (lastAttemptKeyRef.current === attemptKey) return;
      lastAttemptKeyRef.current = attemptKey;
      setStatus("checking");
      startSilentAuthTimeout();
      void tryMicrosoftSilentLogin();
    } else {
      clearSilentAuthTimeout();
      setStatus("unauthenticated");
    }
    return () => clearSilentAuthTimeout();
  }, [accessToken, accessTokenExpiry, clearAuth, instance, setAuth, silentAttemptNonce, silentLogin, user]);

  // When the PWA comes back online or to the foreground after an offline wait,
  // explicitly re-run the single silent attempt.
  useEffect(() => {
    const retry = () => {
      const valid = !!accessToken && !!accessTokenExpiry && Date.now() < accessTokenExpiry;
      const activity = useUiStore.getState().authActivity;
      if (user && !valid && navigator.onLine !== false && activity !== "refreshing") {
        lastAttemptKeyRef.current = "";
        useUiStore.getState().setAuthActivity("refreshing");
        setStatus("checking");
        setSilentAttemptNonce((value) => value + 1);
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") retry(); };
    const onOffline = () => { if (user) useUiStore.getState().setAuthActivity("offline"); };
    const onOnline = () => {
      const valid = !!accessToken && !!accessTokenExpiry && Date.now() < accessTokenExpiry;
      if (user && valid) useUiStore.getState().setAuthActivity("idle");
      retry();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    // Initialize the pill on mount to reflect current connectivity.
    if (user && navigator.onLine === false) useUiStore.getState().setAuthActivity("offline");
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [accessToken, accessTokenExpiry, user]);

  if (status === "checking") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm font-medium">{t("auth.checkingSession")}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t("auth.checkingSessionHint")}</p>
      </div>
    );
  }

  if (status === "unauthenticated" || !accessToken) {
    sessionStorage.setItem("narrarium-return-to", `${location.pathname}${location.search}${location.hash}`);
    return (
      <Navigate
        to="/login"
        state={{ returnTo: `${location.pathname}${location.search}${location.hash}` }}
        replace
      />
    );
  }

  return <>{children}</>;
}
