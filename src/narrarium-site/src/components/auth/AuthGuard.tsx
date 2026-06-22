import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useGoogleLogin } from "@react-oauth/google";
import { useMsal } from "@azure/msal-react";
import { Loader2 } from "lucide-react";
import { useAuthStore, type GoogleUser } from "@/store/authStore";
import { ensureMsalInitialized, findMicrosoftAccountByEmail, microsoftSilentRequest } from "@/config/msal";

interface AuthGuardProps {
  children: React.ReactNode;
}

type Status = "checking" | "ok" | "unauthenticated";

export function AuthGuard({ children }: AuthGuardProps) {
  const { accessToken, accessTokenExpiry, user, setAuth, clearAuth } =
    useAuthStore();
  const { instance } = useMsal();
  const location = useLocation();
  const [status, setStatus] = useState<Status>("checking");
  const didTryRef = useRef(false);

  const silentLogin = useGoogleLogin({
    scope: [
      "https://www.googleapis.com/auth/drive.appdata",
      "https://www.googleapis.com/auth/drive.file",
      "openid",
      "profile",
      "email",
    ].join(" "),
    // prompt: "none" → no UI, returns immediately; fails with interaction_required
    // if the Google session has expired → we fall through to /login
    prompt: "none",
    hint: user?.email,
    onSuccess: (tokenResponse) => {
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
          setStatus("ok");
        })
        .catch(() => {
          clearAuth();
          setStatus("unauthenticated");
        });
    },
    onError: () => {
      // Silent reauth failed (session expired) → force manual login
      clearAuth();
      setStatus("unauthenticated");
    },
  });

  useEffect(() => {
    if (didTryRef.current) return;
    didTryRef.current = true;

    async function tryMicrosoftSilentLogin() {
      try {
        await ensureMsalInitialized();
        const account = findMicrosoftAccountByEmail(user?.email);
        if (!account) {
          clearAuth();
          setStatus("unauthenticated");
          return;
        }
        const result = await instance.acquireTokenSilent(microsoftSilentRequest(account));
        if (result.account) instance.setActiveAccount(result.account);
        const expiresAt = result.expiresOn?.getTime() ?? Date.now() + 3600_000;
        const expiresIn = Math.max(120, Math.round((expiresAt - Date.now()) / 1000));
        setAuth(result.accessToken, user!, expiresIn);
        setStatus("ok");
      } catch {
        clearAuth();
        setStatus("unauthenticated");
      }
    }

    const tokenValid =
      !!accessToken &&
      !!accessTokenExpiry &&
      Date.now() < accessTokenExpiry;

    if (tokenValid) {
      setStatus("ok");
    } else if (user?.provider === "google") {
      // Known user, but token missing/expired → try silent re-auth
      silentLogin();
    } else if (user?.provider === "microsoft") {
      void tryMicrosoftSilentLogin();
    } else {
      setStatus("unauthenticated");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (status === "unauthenticated" || !accessToken) {
    return (
      <Navigate
        to="/login"
        state={{ returnTo: location.pathname }}
        replace
      />
    );
  }

  return <>{children}</>;
}
