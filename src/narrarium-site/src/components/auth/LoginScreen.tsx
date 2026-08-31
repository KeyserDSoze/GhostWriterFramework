import { useNavigate, useLocation } from "react-router-dom";
import { useGoogleLogin } from "@react-oauth/google";
import { useTranslation } from "react-i18next";
import { BookOpen, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAuthStore, type GoogleUser } from "@/store/authStore";
import { clearLegacyAccountUpgrade, requireGoogleProviderAccountId } from "@/auth/accountIdentity";
import { readAccountContinuity } from "@/auth/accountContinuity";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { ensureMsalInitialized, MICROSOFT_SCOPES, microsoftMsalInstance, microsoftSilentRequest, setMicrosoftRememberMe } from "@/config/msal";
import { MICROSOFT_CLIENT_ID } from "@/config/publicClients";
import { GOOGLE_DRIVE_SCOPES } from "@/config/googleAuth";
import { cloudDeletionReconnectState, registerCloudAccount, resumeCloudWrites } from "@/drive/cloudWriteBarrier";
import { clearLegacyRecoveryLoginRequest, consumeLegacyRecoveryLoginRequest, matchesLegacyRecoveryLoginRequest, normalizeAppReturnTo, readLegacyRecoveryLoginRequest } from "@/auth/legacyRecoveryLogin";
import { resolveUpdateAwareLoginReturnTo } from "@/pwaUpdateIntent";
import { fetchMicrosoftGraph } from "@/drive/microsoftGraph";

export function LoginScreen() {
  const { t } = useTranslation();
  const { setInteractiveAuth, clearInteractiveRecoveryAuth } = useAuthStore();
  const [rememberMe, setRememberMe] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const [loadingProvider, setLoadingProvider] = useState<"google" | "microsoft" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const microsoftClientId = MICROSOFT_CLIENT_ID;
  const [recoveryState] = useState(readLegacyRecoveryLoginRequest);
  const knownUser = useAuthStore((state) => state.user);
  const recoveryRequest = recoveryState.status === "valid" ? recoveryState.request : null;
  const recoveryExpired = recoveryState.status === "expired" || recoveryState.status === "invalid";
  const continuity = readAccountContinuity(knownUser?.provider ?? recoveryRequest?.provider);

  useEffect(() => {
    if (!recoveryExpired) return;
    clearLegacyRecoveryLoginRequest();
    clearLegacyAccountUpgrade();
    clearInteractiveRecoveryAuth();
  }, [clearInteractiveRecoveryAuth, recoveryExpired]);

  function returnToApp() {
    const explicitReturnTo =
      normalizeAppReturnTo((location.state as { returnTo?: string } | null)?.returnTo)
      ?? normalizeAppReturnTo(sessionStorage.getItem("narrarium-return-to"));
    const returnTo =
      recoveryRequest?.returnTo
      ?? resolveUpdateAwareLoginReturnTo(explicitReturnTo);
    sessionStorage.removeItem("narrarium-return-to");
    navigate(returnTo, { replace: true });
  }

  async function finishLogin(accessToken: string, user: GoogleUser, expiresIn: number): Promise<boolean> {
    if (recoveryRequest && !matchesLegacyRecoveryLoginRequest(recoveryRequest, user)) {
      setError(t("auth.recoveryMismatch"));
      return false;
    }
    registerCloudAccount(user.provider, accessToken, user.providerAccountId!);
    await confirmAndResumeCloudWrites(user.provider, accessToken);
    setInteractiveAuth(accessToken, user, expiresIn, rememberMe);
    const { migrateConnectedProviderRepositories } = await import("@/auth/accountScope");
    const migration = await migrateConnectedProviderRepositories();
    if (migration.error) {
      setError(t("auth.loginFailed"));
      return false;
    }
    if (recoveryRequest) {
      const { resetBookStructureLoadCoordinator } = await import("@/hooks/useBookStructure");
      resetBookStructureLoadCoordinator();
      consumeLegacyRecoveryLoginRequest(recoveryRequest);
    }
    returnToApp();
    return true;
  }

  const login = useGoogleLogin({
    scope: GOOGLE_DRIVE_SCOPES,
    onSuccess: async (tokenResponse) => {
      setLoadingProvider("google");
      setError(null);
      try {
        // Fetch user profile
        const profileRes = await fetch(
          "https://www.googleapis.com/oauth2/v3/userinfo",
          { headers: { Authorization: `Bearer ${tokenResponse.access_token}` } },
        );
        if (!profileRes.ok) throw new Error(`Google profile load failed (${profileRes.status})`);
        const profile = (await profileRes.json()) as {
          sub?: string;
          name: string;
          email: string;
          picture: string;
        };
        if (!profile.email?.trim()) throw new Error("Google profile did not provide an email address.");
        const providerAccountId = requireGoogleProviderAccountId(profile);

        const user: GoogleUser = {
          provider: "google",
          providerAccountId,
          name: profile.name,
          email: profile.email,
          picture: profile.picture,
        };

        await finishLogin(
          tokenResponse.access_token,
          user,
          "expires_in" in tokenResponse
            ? (tokenResponse as { expires_in: number }).expires_in
            : 3600,
        );
      } catch (err) {
        setError(recoveryRequest ? t("auth.recoveryFailed") : err instanceof Error ? err.message : t("login.failed"));
      } finally {
        setLoadingProvider(null);
      }
    },
    onError: (err) => {
      setError(recoveryRequest ? t("auth.recoveryFailed") : err.error_description ?? t("login.googleFailed"));
    },
  });

  async function loginWithMicrosoft() {
    if (recoveryRequest?.provider === "google") return;
    if (!microsoftClientId) {
      setError(t("auth.missingMicrosoft"));
      return;
    }
    setLoadingProvider("microsoft");
    setError(null);
    try {
      // MSAL cache location is fixed when the provider is created. Persist the
      // choice before login, then reload after success so the provider and
      // silent-refresh hooks use the same cache instance.
      setMicrosoftRememberMe(rememberMe);
      const microsoftInstance = microsoftMsalInstance(rememberMe);
      await ensureMsalInitialized(microsoftInstance);
      const result = await microsoftInstance.loginPopup({
        scopes: MICROSOFT_SCOPES,
        prompt: "select_account",
      });
      if (!result.account?.homeAccountId?.trim() || !result.account.localAccountId?.trim()) {
        throw new Error("Microsoft did not provide immutable account identifiers.");
      }
      microsoftInstance.setActiveAccount(result.account);

       let graphToken: string;
       let tokenExpiresOn = result.expiresOn;
       let silentAccountMismatch = false;
       try {
          const silentResult = await microsoftInstance.acquireTokenSilent(microsoftSilentRequest(result.account));
         if (!silentResult.account
           || silentResult.account.homeAccountId !== result.account.homeAccountId
           || silentResult.account.localAccountId !== result.account.localAccountId) {
           silentAccountMismatch = true;
           throw new Error(t("auth.accountMismatch"));
         }
         graphToken = silentResult.accessToken;
         tokenExpiresOn = silentResult.expiresOn;
       } catch (error) {
         if (silentAccountMismatch) throw error;
         graphToken = result.accessToken;
       }

      const profileRes = await fetchMicrosoftGraph("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${graphToken}` },
      });
      if (!profileRes.ok) throw new Error(`Microsoft profile load failed (${profileRes.status})`);
      const profile = (await profileRes.json()) as {
        displayName?: string;
        mail?: string;
        userPrincipalName?: string;
      };
      const email = profile.mail ?? profile.userPrincipalName ?? "";
      if (!email.trim()) throw new Error("Microsoft profile did not provide an email address.");
      const name = profile.displayName ?? (email || t("login.microsoftUser"));
       const expiresAt = tokenExpiresOn?.getTime() ?? Date.now() + 3600_000;
      const expiresIn = Math.max(120, Math.round((expiresAt - Date.now()) / 1000));
      await finishLogin(
        graphToken,
        {
          provider: "microsoft",
          providerAccountId: result.account.homeAccountId,
          name,
          email,
          picture: "",
          homeAccountId: result.account.homeAccountId,
          localAccountId: result.account.localAccountId,
        },
        expiresIn,
      );
      window.location.reload();
    } catch (err) {
      setError(recoveryRequest ? t("auth.recoveryFailed") : err instanceof Error ? err.message : t("login.microsoftFailed"));
    } finally {
      setLoadingProvider(null);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm space-y-8 text-center">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary">
            <BookOpen className="h-9 w-9 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              {t("auth.title")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("auth.subtitle")}
            </p>
          </div>
        </div>

        {/* Sign-in card */}
        <div className="rounded-xl border bg-card p-8 shadow-sm space-y-6">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">{recoveryExpired ? t("auth.recoveryExpiredHeading") : recoveryRequest ? t("auth.recoveryHeading") : continuity ? t("auth.continuityHeading", { email: continuity.normalizedEmail }) : t("auth.heading")}</h2>
            <p className="text-sm text-muted-foreground">
              {recoveryExpired ? t("auth.recoveryExpiredDescription") : recoveryRequest ? t("auth.recoveryDescription", { provider: recoveryRequest.provider === "google" ? "Google" : "Microsoft", email: recoveryRequest.normalizedEmail }) : continuity ? t("auth.continuityDescription") : t("auth.description")}
            </p>
          </div>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex items-start gap-2 text-left">
            <input id="remember-me" type="checkbox" className="mt-0.5 h-4 w-4 rounded border-input accent-primary" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} disabled={!!loadingProvider || recoveryRequest !== null} />
            <div className="space-y-1">
              <Label htmlFor="remember-me" className="cursor-pointer text-sm">{t("auth.rememberMe")}</Label>
              <p className="text-xs text-muted-foreground">{t("auth.rememberMeHint")}</p>
            </div>
          </div>

          <Button
            className="w-full"
            onClick={() => login()}
            disabled={recoveryExpired || !!loadingProvider || recoveryRequest?.provider === "microsoft"}
          >
            {loadingProvider === "google" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <svg
                className="mr-2 h-4 w-4"
                aria-hidden="true"
                viewBox="0 0 24 24"
              >
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
            )}
            {loadingProvider === "google" ? t("auth.signingInGoogle") : t("auth.google")}
          </Button>

          <Button
            className="w-full bg-[#0078d4] text-white hover:bg-[#106ebe]"
            onClick={() => void loginWithMicrosoft()}
            disabled={recoveryExpired || !!loadingProvider || !microsoftClientId || recoveryRequest?.provider === "google"}
          >
            {loadingProvider === "microsoft" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <svg className="mr-2 h-4 w-4" aria-hidden="true" viewBox="0 0 23 23">
                <path fill="#f3f3f3" d="M0 0h23v23H0z" />
                <path fill="#f35325" d="M1 1h10v10H1z" />
                <path fill="#81bc06" d="M12 1h10v10H12z" />
                <path fill="#05a6f0" d="M1 12h10v10H1z" />
                <path fill="#ffba08" d="M12 12h10v10H12z" />
              </svg>
            )}
            {loadingProvider === "microsoft" ? t("auth.signingInMicrosoft") : t("auth.microsoft")}
          </Button>
          {recoveryExpired && <Button variant="outline" className="w-full" onClick={() => navigate("/app/books", { replace: true })}>{t("auth.recoveryExpiredBack")}</Button>}

        </div>

        <p className="text-xs text-muted-foreground">
          {t("auth.consent")}
        </p>
      </div>
    </div>
  );
}

async function confirmAndResumeCloudWrites(provider: "google" | "microsoft", token: string): Promise<void> {
  const reconnect = await cloudDeletionReconnectState(provider, token);
  if (!reconnect) return;
  if (reconnect.state === "nothing-to-delete" && !window.confirm(`No verified owned cloud folder was found, so no provider data was deleted. Resume cloud writes?\n\n${reconnect.reason ?? ""}`)) {
    throw new Error("Cloud reconnect was cancelled.");
  }
  if (!await resumeCloudWrites(provider, token, reconnect.generation)) throw new Error("Cloud reconnect was superseded by a newer deletion.");
}
