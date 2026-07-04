import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useGoogleLogin } from "@react-oauth/google";
import { useMsal } from "@azure/msal-react";
import { Loader2 } from "lucide-react";
import { useAuthStore, type GoogleUser } from "@/store/authStore";
import { ensureMsalInitialized, findMicrosoftAccountByEmail, microsoftSilentRequest } from "@/config/msal";
import { GOOGLE_DRIVE_SCOPES } from "@/config/googleAuth";

interface AuthGuardProps {
  children: React.ReactNode;
}

type Status = "checking" | "ok" | "unauthenticated";
const SILENT_AUTH_TIMEOUT_MS = 12000;
const GOOGLE_MAX_RETRIES = 3;
const GOOGLE_BACKOFF_MS = [700, 1600, 3200];

/** Errors that mean the Google session is really gone → interactive login is required. */
const HARD_GOOGLE_ERRORS = new Set([
  "interaction_required",
  "login_required",
  "consent_required",
  "account_selection_required",
  "access_denied",
]);

export function AuthGuard({ children }: AuthGuardProps) {
  const { accessToken, accessTokenExpiry, user, setAuth, clearAuth } =
    useAuthStore();
  const { instance } = useMsal();
  const location = useLocation();
  const [status, setStatus] = useState<Status>("checking");
  const lastAttemptKeyRef = useRef("");
  const silentAuthTimeoutRef = useRef<number | null>(null);
  const googleRetryRef = useRef(0);

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
      setStatus((s) => (s === "checking" ? "checking" : s));
      return;
    }
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
          googleRetryRef.current = 0;
          setStatus("ok");
        })
        .catch(() => {
          // Userinfo fetch failed (often a transient network hiccup) → keep the token,
          // it is still valid for Drive; do not force a logout.
          googleRetryRef.current = 0;
          clearSilentAuthTimeout();
          setStatus("ok");
        });
    },
    onError: (err?: { error?: string }) => {
      const code = err?.error ?? "";
      // Real "session gone" → interactive login. Transient errors → backoff retries.
      if (HARD_GOOGLE_ERRORS.has(code)) {
        clearSilentAuthTimeout();
        clearAuth();
        setStatus("unauthenticated");
        return;
      }
      if (googleRetryRef.current < GOOGLE_MAX_RETRIES) {
        const delay = GOOGLE_BACKOFF_MS[googleRetryRef.current] ?? 3200;
        googleRetryRef.current += 1;
        startSilentAuthTimeout();
        window.setTimeout(() => silentLogin(), delay);
        return;
      }
      giveUpSilent();
    },
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
        clearSilentAuthTimeout();
        clearAuth();
        setStatus("unauthenticated");
      }
    }

    const tokenValid =
      !!accessToken &&
      !!accessTokenExpiry &&
      Date.now() < accessTokenExpiry;

    if (tokenValid) {
      clearSilentAuthTimeout();
      setStatus("ok");
    } else if (user?.provider === "google") {
      // Known user, but token missing/expired → try silent re-auth
      const attemptKey = `google:${user.email}:${accessToken ?? "missing"}:${accessTokenExpiry ?? 0}`;
      if (lastAttemptKeyRef.current === attemptKey) return;
      lastAttemptKeyRef.current = attemptKey;
      googleRetryRef.current = 0;
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
  }, [accessToken, accessTokenExpiry, clearAuth, instance, setAuth, silentLogin, user]);

  // When the PWA comes back online or to the foreground, allow a fresh silent attempt
  // (reset the dedupe key + retry counter so the main effect re-runs the silent login).
  useEffect(() => {
    const retry = () => {
      const valid = !!accessToken && !!accessTokenExpiry && Date.now() < accessTokenExpiry;
      if (user && !valid) {
        lastAttemptKeyRef.current = "";
        googleRetryRef.current = 0;
        // Nudge a re-render by touching status; the main effect will re-attempt.
        setStatus((s) => (s === "unauthenticated" ? "checking" : s));
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") retry(); };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [accessToken, accessTokenExpiry, user]);

  if (status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
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
