import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useGoogleLogin } from "@react-oauth/google";
import { useMsal } from "@azure/msal-react";
import { Loader2 } from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { useUiStore } from "@/store/uiStore";
import { ensureMsalInitialized, findMicrosoftAccount, microsoftSilentRequest } from "@/config/msal";
import { GOOGLE_DRIVE_SCOPES } from "@/config/googleAuth";
import { registerCloudAccount } from "@/drive/cloudWriteBarrier";
import { WanderingAuthGhost } from "@/components/auth/WanderingAuthGhost";
import { accountIdentity, beginLegacyAccountUpgrade, isAccountIdentityCurrent, normalizedAccountEmail, requireGoogleProviderAccountId } from "@/auth/accountIdentity";
import { markUpdateDestinationAuthRequired } from "@/pwaUpdateIntent";

interface AuthGuardProps {
  children: React.ReactNode;
}

type Status = "checking" | "ok" | "offline" | "unauthenticated";
const SILENT_AUTH_TIMEOUT_MS = 4000;
const SILENT_RETRY_LIMIT = 2;
const SILENT_RETRY_BASE_MS = 500;

export function AuthGuard({ children }: AuthGuardProps) {
  const { t } = useTranslation();
  const { accessToken, accessTokenExpiry, provider, providerAccountId, user, setAuth, clearAuthForLegacyUpgrade, invalidateToken } =
    useAuthStore();
  const { instance } = useMsal();
  const location = useLocation();
  const [status, setStatus] = useState<Status>("checking");
  const [silentAttemptNonce, setSilentAttemptNonce] = useState(0);
  const lastAttemptKeyRef = useRef("");
  const silentAuthTimeoutRef = useRef<number | null>(null);
  const silentAttemptActiveRef = useRef(false);
  const silentRetryCountRef = useRef(0);
  const retryIdentityRef = useRef<string | null>(null);
  const silentRetryTimerRef = useRef<number | null>(null);
  const attemptSequenceRef = useRef(0);
  const currentAttemptRef = useRef<{ nonce: number; identity: string } | null>(null);
  const observedIdentityRef = useRef<string | null>(null);
  const silentFallbackIdentityRef = useRef<string | null>(null);
  const retryTimerGenerationRef = useRef(0);
  const googleInvocationQueueRef = useRef<Array<{ nonce: number; identity: string }>>([]);
  const e2eAuth = __NARRARIUM_E2E_BUILD__ && import.meta.env.VITE_E2E === "true";

  function clearSilentAuthTimeout() {
    if (silentAuthTimeoutRef.current != null) {
      window.clearTimeout(silentAuthTimeoutRef.current);
      silentAuthTimeoutRef.current = null;
    }
  }

  function clearSilentRetryTimer() {
    if (silentRetryTimerRef.current != null) {
      window.clearTimeout(silentRetryTimerRef.current);
      silentRetryTimerRef.current = null;
    }
  }

  function currentIdentity(): string | null {
    return accountIdentity(useAuthStore.getState().user);
  }

  function ownsAttempt(attempt: { nonce: number; identity: string } | null): boolean {
    return !!attempt && currentAttemptRef.current?.nonce === attempt.nonce
      && currentAttemptRef.current.identity === attempt.identity && currentIdentity() === attempt.identity;
  }

  function cancelAttempt(): void {
    retryTimerGenerationRef.current += 1;
    silentAttemptActiveRef.current = false;
    currentAttemptRef.current = null;
    googleInvocationQueueRef.current = [];
    clearSilentAuthTimeout();
    clearSilentRetryTimer();
  }

  function beginAttempt(identity: string): { nonce: number; identity: string } {
    cancelAttempt();
    if (retryIdentityRef.current !== identity) {
      retryIdentityRef.current = identity;
      silentRetryCountRef.current = 0;
    }
    const attempt = { nonce: ++attemptSequenceRef.current, identity };
    currentAttemptRef.current = attempt;
    silentAttemptActiveRef.current = true;
    return attempt;
  }

  /** Give up gracefully, but only for the attempt that is still current. */
  function giveUpSilent(attempt: { nonce: number; identity: string }, retry = true) {
    if (!ownsAttempt(attempt)) return;
    silentAttemptActiveRef.current = false;
    currentAttemptRef.current = null;
    clearSilentAuthTimeout();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // Offline: keep whatever we have; AuthGuard will retry when back online.
      useUiStore.getState().setAuthActivity("offline");
      setStatus("offline");
      return;
    }
    if (retry && silentRetryCountRef.current < SILENT_RETRY_LIMIT) {
      const delay = SILENT_RETRY_BASE_MS * 2 ** silentRetryCountRef.current;
      silentRetryCountRef.current += 1;
      const timerGeneration = retryTimerGenerationRef.current;
      useUiStore.getState().setAuthActivity("refreshing");
      silentRetryTimerRef.current = window.setTimeout(() => {
        silentRetryTimerRef.current = null;
        if (retryTimerGenerationRef.current !== timerGeneration || currentIdentity() !== attempt.identity || currentAttemptRef.current) return;
        lastAttemptKeyRef.current = "";
        setSilentAttemptNonce((value) => value + 1);
      }, delay);
      return;
    }
    silentFallbackIdentityRef.current = attempt.identity;
    useUiStore.getState().setAuthActivity("idle");
    invalidateToken();
    setStatus("unauthenticated");
  }

  function showInteractiveLogin(attempt?: { nonce: number; identity: string }) {
    if (attempt && !ownsAttempt(attempt)) return;
    silentFallbackIdentityRef.current = attempt?.identity ?? currentIdentity();
    cancelAttempt();
    useUiStore.getState().setAuthActivity("idle");
    invalidateToken();
    setStatus("unauthenticated");
  }

  function startSilentAuthTimeout(attempt: { nonce: number; identity: string }) {
    clearSilentAuthTimeout();
    silentAuthTimeoutRef.current = window.setTimeout(() => {
      if (ownsAttempt(attempt)) giveUpSilent(attempt);
    }, SILENT_AUTH_TIMEOUT_MS);
  }

  const silentLogin = useGoogleLogin({
    scope: GOOGLE_DRIVE_SCOPES,
    // prompt: "none" → no UI silent token refresh while the Google session cookie is alive.
    prompt: "none",
    hint: user?.email,
    onSuccess: async (tokenResponse) => {
      const nonce = tokenResponse.state;
      const index = nonce ? googleInvocationQueueRef.current.findIndex((entry) => String(entry.nonce) === nonce) : -1;
      const attempt = index >= 0 ? googleInvocationQueueRef.current.splice(index, 1)[0] : null;
      const currentUser = useAuthStore.getState().user;
      if (!attempt || !silentAttemptActiveRef.current || !currentUser || !ownsAttempt(attempt) || !isAccountIdentityCurrent(attempt.identity, currentUser)) return;
      const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${tokenResponse.access_token}` } });
      if (!ownsAttempt(attempt)) return;
      if (!response.ok) { giveUpSilent(attempt); return; }
      const profile = await response.json() as { sub?: string; email?: string };
      if (!ownsAttempt(attempt)) return;
      let providerAccountId: string;
      try { providerAccountId = requireGoogleProviderAccountId(profile); } catch { giveUpSilent(attempt); return; }
      const verifiedUser = useAuthStore.getState().user;
      if (!verifiedUser || !ownsAttempt(attempt) || providerAccountId !== verifiedUser.providerAccountId || !profile.email || normalizedAccountEmail({ email: profile.email }) !== normalizedAccountEmail(verifiedUser)) { showInteractiveLogin(attempt); return; }
      if (!ownsAttempt(attempt)) return;
      silentAttemptActiveRef.current = false;
      clearSilentAuthTimeout();
      if (!ownsAttempt(attempt)) return;
      registerCloudAccount("google", tokenResponse.access_token, verifiedUser.providerAccountId!);
      if (!ownsAttempt(attempt)) return;
      setAuth(
        tokenResponse.access_token,
        verifiedUser,
        "expires_in" in tokenResponse
          ? (tokenResponse as { expires_in: number }).expires_in
          : 3600,
      );
      currentAttemptRef.current = null;
      useUiStore.getState().setAuthActivity("idle");
      setStatus("ok");
      silentRetryCountRef.current = 0;
    },
    // The token is already unusable here. One silent attempt is enough while
    // online; offline keeps the known user and retries when connectivity returns.
    // Error callbacks do not carry the request nonce. Timeout ownership handles
    // the current attempt, while ignoring this callback prevents an old popup
    // error from affecting a newer account attempt.
    onError: () => undefined,
  });

  function invokeGoogleSilent(attempt: { nonce: number; identity: string }): void {
    googleInvocationQueueRef.current.push(attempt);
    try { silentLogin({ state: String(attempt.nonce) }); } catch { googleInvocationQueueRef.current = googleInvocationQueueRef.current.filter((entry) => entry !== attempt); giveUpSilent(attempt); }
  }

  useEffect(() => {
    async function tryMicrosoftSilentLogin() {
      const attempt = currentAttemptRef.current;
      if (!attempt) return;
      try {
        await ensureMsalInitialized();
        if (!ownsAttempt(attempt)) return;
        const account = user?.provider === "microsoft" ? findMicrosoftAccount(user) : null;
        if (!account?.homeAccountId?.trim() || !account.localAccountId?.trim()) {
          silentAttemptActiveRef.current = false;
          clearSilentAuthTimeout();
          if (!ownsAttempt(attempt)) return;
          invalidateToken();
          currentAttemptRef.current = null;
          setStatus("unauthenticated");
          return;
        }
        const result = await instance.acquireTokenSilent({ ...microsoftSilentRequest(account), forceRefresh: true });
        if (!ownsAttempt(attempt) || !user || !isAccountIdentityCurrent(accountIdentity(user), useAuthStore.getState().user)) return;
        if (!result.account || result.account.homeAccountId !== account.homeAccountId || result.account.localAccountId !== account.localAccountId) { showInteractiveLogin(attempt); return; }
        if (!ownsAttempt(attempt)) return;
        if (result.account) instance.setActiveAccount(result.account);
        const expiresAt = result.expiresOn?.getTime() ?? Date.now() + 3600_000;
        const expiresIn = Math.max(120, Math.round((expiresAt - Date.now()) / 1000));
        silentAttemptActiveRef.current = false;
        clearSilentAuthTimeout();
        const upgradedUser = { ...user, providerAccountId: account.homeAccountId, homeAccountId: account.homeAccountId, localAccountId: account.localAccountId };
        if (!ownsAttempt(attempt)) return;
        registerCloudAccount("microsoft", result.accessToken, account.homeAccountId);
        if (!ownsAttempt(attempt)) return;
        setAuth(result.accessToken, upgradedUser, expiresIn);
        currentAttemptRef.current = null;
        setStatus("ok");
        silentRetryCountRef.current = 0;
      } catch {
        if (ownsAttempt(attempt)) giveUpSilent(attempt);
      }
    }

    const tokenBound = user?.provider === provider && user.providerAccountId === providerAccountId;
    const tokenValid =
      !!accessToken &&
      !!accessTokenExpiry &&
      Date.now() < accessTokenExpiry &&
      tokenBound;

    // E2E builds use a deterministic local identity instead of exercising a real
    // provider popup. The production build never enables this compile-time flag.
    if (e2eAuth) {
      const e2eUser = user ?? { provider: "google" as const, providerAccountId: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" };
      if (!user || !accessToken) setAuth("e2e-google-token", e2eUser, 3600);
      useUiStore.getState().setAuthActivity("idle");
      setStatus("ok");
      return;
    }

    const immutableIdentity = Boolean(user?.providerAccountId?.trim()) && (user?.provider !== "microsoft" || Boolean(user.homeAccountId?.trim() && user.localAccountId?.trim()));
    const identity = accountIdentity(user);
    if (observedIdentityRef.current !== identity) {
      cancelAttempt();
      observedIdentityRef.current = identity;
      silentFallbackIdentityRef.current = null;
    }
    if (user && !immutableIdentity) {
      beginLegacyAccountUpgrade(user);
      clearSilentAuthTimeout();
      clearAuthForLegacyUpgrade();
      setStatus("unauthenticated");
    } else if (tokenValid) {
      clearSilentAuthTimeout();
      useUiStore.getState().setAuthActivity("idle");
      setStatus("ok");
    } else if (identity && silentFallbackIdentityRef.current === identity && !accessToken) {
      useUiStore.getState().setAuthActivity("idle");
      setStatus("unauthenticated");
    } else if (user?.provider === "google") {
      if (navigator.onLine === false) {
        useUiStore.getState().setAuthActivity("offline");
        setStatus("offline");
        return;
      }
      // Google OAuth token flow may open a popup even with prompt=none once the
      // provider session is stale. Do not launch or retry it automatically.
      // Preserve remembered identity and require one explicit login click.
      silentFallbackIdentityRef.current = identity;
      cancelAttempt();
      useUiStore.getState().setAuthActivity("idle");
      invalidateToken();
      setStatus("unauthenticated");
    } else if (user?.provider === "microsoft") {
      if (navigator.onLine === false) {
        useUiStore.getState().setAuthActivity("offline");
        setStatus("offline");
        return;
      }
      const attemptKey = `microsoft:${identity}:${accessToken ?? "missing"}:${accessTokenExpiry ?? 0}`;
      if (lastAttemptKeyRef.current === attemptKey) return;
      lastAttemptKeyRef.current = attemptKey;
      setStatus("checking");
      startSilentAuthTimeout(beginAttempt(identity!));
      void tryMicrosoftSilentLogin();
    } else {
      clearSilentAuthTimeout();
      setStatus("unauthenticated");
    }
  }, [accessToken, accessTokenExpiry, clearAuthForLegacyUpgrade, e2eAuth, instance, invalidateToken, setAuth, silentAttemptNonce, silentLogin, user]);

  useEffect(() => {
    if (!silentAttemptNonce || user?.provider !== "google") return;
    const attempt = currentAttemptRef.current;
    if (!attempt || !ownsAttempt(attempt)) return;
    startSilentAuthTimeout(attempt);
    invokeGoogleSilent(attempt);
  }, [silentAttemptNonce, silentLogin, user]);

  useEffect(() => () => {
    cancelAttempt();
    lastAttemptKeyRef.current = "";
  }, []);

  // When the PWA comes back online or to the foreground after an offline wait,
  // explicitly re-run the single silent attempt.
  useEffect(() => {
    const retry = () => {
      const valid = !!accessToken && !!accessTokenExpiry && Date.now() < accessTokenExpiry;
      const activity = useUiStore.getState().authActivity;
      if (user && !valid && navigator.onLine !== false && activity !== "refreshing") {
        if (user.provider === "google") {
          silentFallbackIdentityRef.current = accountIdentity(user);
          cancelAttempt();
          useUiStore.getState().setAuthActivity("idle");
          invalidateToken();
          setStatus("unauthenticated");
          return;
        }
        if (retryIdentityRef.current !== accountIdentity(user)) {
          retryIdentityRef.current = accountIdentity(user);
          silentRetryCountRef.current = 0;
        }
        silentFallbackIdentityRef.current = null;
        lastAttemptKeyRef.current = "";
        useUiStore.getState().setAuthActivity("refreshing");
        setStatus("checking");
        setSilentAttemptNonce((value) => value + 1);
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") retry(); };
    const onOffline = () => {
      if (!user) return;
      useUiStore.getState().setAuthActivity("offline");
      if (!accessToken || !accessTokenExpiry || Date.now() >= accessTokenExpiry) setStatus("offline");
    };
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
      clearSilentRetryTimer();
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

  if (status === "offline") {
    return <>{children}</>;
  }

  if (status === "unauthenticated" || !accessToken) {
    const requestedReturnTo = `${location.pathname}${location.search}${location.hash}`;
    const returnTo = markUpdateDestinationAuthRequired(location.pathname) ?? requestedReturnTo;
    sessionStorage.setItem("narrarium-return-to", returnTo);
    return (
      <Navigate
        to="/login"
        state={{ returnTo }}
        replace
      />
    );
  }

  return <>{children}</>;
}
