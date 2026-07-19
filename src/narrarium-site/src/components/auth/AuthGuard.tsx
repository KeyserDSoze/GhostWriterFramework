import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useGoogleLogin } from "@react-oauth/google";
import { useMsal } from "@azure/msal-react";
import { Loader2 } from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { useUiStore } from "@/store/uiStore";
import { ensureMsalInitialized, findMicrosoftAccountByEmail, microsoftSilentRequest } from "@/config/msal";
import { GOOGLE_DRIVE_SCOPES } from "@/config/googleAuth";
import { WanderingAuthGhost } from "@/components/auth/WanderingAuthGhost";

interface AuthGuardProps {
  children: React.ReactNode;
}

type Status = "checking" | "ok" | "unauthenticated";
const SILENT_AUTH_TIMEOUT_MS = 4000;

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
  const silentAttemptActiveRef = useRef(false);

  function clearSilentAuthTimeout() {
    if (silentAuthTimeoutRef.current != null) {
      window.clearTimeout(silentAuthTimeoutRef.current);
      silentAuthTimeoutRef.current = null;
    }
  }

  /** Give up gracefully: never nuke the session while offline or backgrounded. */
  function giveUpSilent() {
    silentAttemptActiveRef.current = false;
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
    silentAttemptActiveRef.current = true;
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
      if (!silentAttemptActiveRef.current || !user) return;
      silentAttemptActiveRef.current = false;
      clearSilentAuthTimeout();
      setAuth(
        tokenResponse.access_token,
        user,
        "expires_in" in tokenResponse
          ? (tokenResponse as { expires_in: number }).expires_in
          : 3600,
      );
      useUiStore.getState().setAuthActivity("idle");
      setStatus("ok");
    },
    // The token is already unusable here. One silent attempt is enough while
    // online; offline keeps the known user and retries when connectivity returns.
    onError: () => {
      if (silentAttemptActiveRef.current) giveUpSilent();
    },
  });

  useEffect(() => {
    async function tryMicrosoftSilentLogin() {
      try {
        await ensureMsalInitialized();
        const account = findMicrosoftAccountByEmail(user?.email);
        if (!account) {
          silentAttemptActiveRef.current = false;
          clearSilentAuthTimeout();
          clearAuth();
          setStatus("unauthenticated");
          return;
        }
        const result = await instance.acquireTokenSilent({ ...microsoftSilentRequest(account), forceRefresh: true });
        if (!silentAttemptActiveRef.current || !user) return;
        if (result.account) instance.setActiveAccount(result.account);
        const expiresAt = result.expiresOn?.getTime() ?? Date.now() + 3600_000;
        const expiresIn = Math.max(120, Math.round((expiresAt - Date.now()) / 1000));
        silentAttemptActiveRef.current = false;
        clearSilentAuthTimeout();
        setAuth(result.accessToken, user, expiresIn);
        setStatus("ok");
      } catch {
        if (silentAttemptActiveRef.current) giveUpSilent();
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
  }, [accessToken, accessTokenExpiry, clearAuth, instance, setAuth, silentAttemptNonce, silentLogin, user]);

  useEffect(() => () => {
    silentAttemptActiveRef.current = false;
    clearSilentAuthTimeout();
    lastAttemptKeyRef.current = "";
  }, []);

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
      <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background px-6 text-center">
        <WanderingAuthGhost />
        <div className="relative z-10 flex max-w-md flex-col items-center gap-3 rounded-3xl bg-background px-6 py-5 shadow-[0_0_40px_24px_hsl(var(--background))]">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm font-medium">{t("auth.checkingSession")}</p>
          <p className="text-sm text-muted-foreground">{t("auth.checkingSessionHint")}</p>
        </div>
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
