import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useGoogleLogin } from "@react-oauth/google";
import { ArrowLeftRight, Check, Loader2, LogIn, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuthStore, type AuthProvider } from "@/store/authStore";
import { ensureMsalInitialized, MICROSOFT_SCOPES, microsoftSilentRequest, msalInstance } from "@/config/msal";
import { GOOGLE_DRIVE_SCOPES } from "@/config/googleAuth";
import { MICROSOFT_CLIENT_ID } from "@/config/publicClients";
import {
  migrateCloudData,
  deleteNarrariumCloudData,
  type MigrationEndpoint,
  type MigrationStepKind,
  type MigrationStepResult,
} from "@/drive/migration";

interface TargetAccount {
  provider: AuthProvider;
  accessToken: string;
  name: string;
  email: string;
}

function providerLabel(provider: AuthProvider, t: (k: string) => string): string {
  return provider === "google" ? t("migration.google") : t("migration.microsoft");
}

const STEP_LABELS: Record<MigrationStepKind, string> = {
  settings: "migration.stepSettings",
  costs: "migration.stepCosts",
  clipboard: "migration.stepClipboard",
  chats: "migration.stepChats",
};

export function MigratePage() {
  const { t } = useTranslation();
  const { user, accessToken } = useAuthStore();
  const [target, setTarget] = useState<TargetAccount | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState<AuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const [results, setResults] = useState<MigrationStepResult[] | null>(null);
  const [activeStep, setActiveStep] = useState<MigrationStepKind | null>(null);

  const sourceProvider = user?.provider;
  // Migration always targets the OTHER provider.
  const targetProvider: AuthProvider | undefined =
    sourceProvider === "google" ? "microsoft" : sourceProvider === "microsoft" ? "google" : undefined;

  const connectGoogle = useGoogleLogin({
    scope: GOOGLE_DRIVE_SCOPES,
    onSuccess: async (tokenResponse) => {
      try {
        const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        });
        const profile = (await res.json()) as { name?: string; email?: string };
        setTarget({
          provider: "google",
          accessToken: tokenResponse.access_token,
          name: profile.name ?? profile.email ?? "Google",
          email: profile.email ?? "",
        });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setConnecting(false);
      }
    },
    onError: (err) => {
      setError(err.error_description ?? t("login.googleFailed"));
      setConnecting(false);
    },
  });

  async function connectMicrosoft() {
    if (!MICROSOFT_CLIENT_ID) {
      setError(t("auth.missingMicrosoft"));
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      await ensureMsalInitialized();
      const result = await msalInstance.loginPopup({ scopes: MICROSOFT_SCOPES, prompt: "select_account" });
      const account = result.account ?? undefined;
      const graphToken = account
        ? (await msalInstance.acquireTokenSilent(microsoftSilentRequest(account)).catch(() => result)).accessToken
        : result.accessToken;
      const res = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${graphToken}` },
      });
      const profile = (await res.json()) as { displayName?: string; mail?: string; userPrincipalName?: string };
      const email = profile.mail ?? profile.userPrincipalName ?? "";
      setTarget({
        provider: "microsoft",
        accessToken: graphToken,
        name: profile.displayName ?? email ?? "Microsoft",
        email,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  function connectTarget() {
    setResults(null);
    setDeleteNotice(null);
    if (targetProvider === "google") {
      setConnecting(true);
      connectGoogle();
    } else if (targetProvider === "microsoft") {
      void connectMicrosoft();
    }
  }

  async function runMigration() {
    if (!user || !accessToken || !target) return;
    setRunning(true);
    setError(null);
    setDeleteNotice(null);
    setResults(null);
    setActiveStep(null);
    const src: MigrationEndpoint = { provider: user.provider, accessToken };
    const dst: MigrationEndpoint = { provider: target.provider, accessToken: target.accessToken };
    try {
      const out = await migrateCloudData(src, dst, (p) => {
        if (p.status === "start") setActiveStep(p.step);
      });
      setResults(out);
      setActiveStep(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function confirmAndDelete(account: TargetAccount) {
    const provider = providerLabel(account.provider, t);
    const expected = t("migration.deleteConfirmWord");
    const typed = window.prompt(t("migration.deleteConfirmPrompt", { provider, word: expected }));
    if (typed !== expected) return;
    setDeleting(account.provider);
    setError(null);
    setDeleteNotice(null);
    try {
      const result = await deleteNarrariumCloudData(account.provider, account.accessToken);
      setDeleteNotice(result.deleted
        ? t("migration.deleteDone", { provider, count: result.count })
        : t("migration.deleteNothing", { provider }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  }

  if (!user || !accessToken || !sourceProvider || !targetProvider) {
    return (
      <div className="mx-auto max-w-2xl">
        <Alert><AlertDescription>{t("migration.notSignedIn")}</AlertDescription></Alert>
      </div>
    );
  }

  const steps: MigrationStepKind[] = ["settings", "costs", "clipboard", "chats"];
  const sourceAccount: TargetAccount = { provider: sourceProvider, accessToken, name: user.name, email: user.email };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold tracking-tight">
          <ArrowLeftRight className="h-6 w-6" />{t("migration.title")}
        </h1>
        <p className="mt-1 text-muted-foreground">{t("migration.description")}</p>
      </div>

      {error && (
        <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
      )}

      {deleteNotice && (
        <Alert><AlertDescription>{deleteNotice}</AlertDescription></Alert>
      )}

      <div className="rounded-xl border bg-card p-5">
        <p className="text-sm font-medium">{t("migration.source")}</p>
        <div className="mt-2 flex items-center gap-3">
          <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium">
            {providerLabel(sourceProvider, t)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center text-muted-foreground">
        <ArrowLeftRight className="h-5 w-5" />
      </div>

      <div className="rounded-xl border bg-card p-5">
        <p className="text-sm font-medium">{t("migration.target")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("migration.targetHint", { provider: providerLabel(targetProvider, t) })}
        </p>
        {target ? (
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium">
                {providerLabel(target.provider, t)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{target.name}</p>
                <p className="truncate text-xs text-muted-foreground">{target.email}</p>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setTarget(null)} disabled={running}>
              {t("migration.changeAccount")}
            </Button>
          </div>
        ) : (
          <Button className="mt-3" variant="outline" onClick={connectTarget} disabled={connecting || running}>
            {connecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogIn className="mr-2 h-4 w-4" />}
            {t("migration.connect", { provider: providerLabel(targetProvider, t) })}
          </Button>
        )}
      </div>

      <Alert>
        <AlertDescription>{t("migration.overwriteWarning")}</AlertDescription>
      </Alert>

      <Button className="w-full" onClick={() => void runMigration()} disabled={!target || running}>
        {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowLeftRight className="mr-2 h-4 w-4" />}
        {t("migration.start")}
      </Button>

      <div className="space-y-4 rounded-xl border border-destructive/40 bg-destructive/5 p-5">
        <div>
          <p className="text-sm font-semibold text-destructive">{t("migration.deleteTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("migration.deleteDescription")}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            variant="destructive"
            onClick={() => void confirmAndDelete(sourceAccount)}
            disabled={running || connecting || deleting !== null}
          >
            {deleting === sourceAccount.provider ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            {t("migration.deleteSource", { provider: providerLabel(sourceAccount.provider, t) })}
          </Button>
          {target ? (
            <Button
              variant="destructive"
              onClick={() => void confirmAndDelete(target)}
              disabled={running || connecting || deleting !== null}
            >
              {deleting === target.provider ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              {t("migration.deleteTarget", { provider: providerLabel(target.provider, t) })}
            </Button>
          ) : (
            <Button variant="outline" disabled>{t("migration.connectTargetToDelete")}</Button>
          )}
        </div>
      </div>

      {(running || results) && (
        <div className="space-y-2 rounded-xl border bg-card p-5">
          <p className="text-sm font-medium">{t("migration.progress")}</p>
          <ul className="space-y-1.5">
            {steps.map((step) => {
              const result = results?.find((r) => r.step === step);
              const isActive = running && activeStep === step;
              return (
                <li key={step} className="flex items-center gap-2 text-sm">
                  {isActive ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  ) : result ? (
                    result.ok ? <Check className="h-4 w-4 text-green-600" /> : <X className="h-4 w-4 text-destructive" />
                  ) : (
                    <span className="h-4 w-4 rounded-full border" />
                  )}
                  <span className="flex-1">{t(STEP_LABELS[step])}</span>
                  {result?.ok && typeof result.count === "number" && (
                    <span className="text-xs text-muted-foreground">{result.count}</span>
                  )}
                  {result && !result.ok && (
                    <span className="max-w-[50%] truncate text-xs text-destructive" title={result.detail}>{result.detail}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {results && results.every((r) => r.ok) && (
            <p className="pt-1 text-sm font-medium text-green-600">{t("migration.done")}</p>
          )}
        </div>
      )}
    </div>
  );
}
