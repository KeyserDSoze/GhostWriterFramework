import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Github, Loader2 } from "lucide-react";
import "@/i18n/githubApp";
import { Button } from "@/components/ui/button";
import { completeGitHubBrokerConnection } from "@/account/brokerConnect";
import { ConnectFlowError } from "@/account/connectErrors";
import { BrokerError } from "@/account/credentialBroker";
import { clearGitHubOAuthAttempt } from "@/github/githubOAuth";
import { classifyGitHubCallback } from "@/github/githubCallbackParams";

/** The words for a connection that did not complete: fixed texts, never the provider's own, never a code or a token. */
function failureKey(error: unknown): string {
  if (error instanceof ConnectFlowError) return error.code === "state_mismatch" ? "stateMismatch" : "failed";
  if (error instanceof BrokerError) return `error.${error.code === "invalid_grant" || error.code === "not_configured" || error.code === "rate_limited" || error.code === "upstream" || error.code === "network" ? error.code : "other"}`;
  return "error.other";
}

export function GitHubOAuthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const providerError = params.get("error");
    const code = params.get("code");
    const state = params.get("state");
    const kind = classifyGitHubCallback(params);
    if (kind === "refused") { clearGitHubOAuthAttempt(); setError(providerError === "access_denied" ? "cancelled" : "incomplete"); return; }
    // The app was just installed: Account & Sync reads where it is installed as soon as it opens.
    if (kind === "installation-return") { navigate("/app/account-sync", { replace: true }); return; }
    if (kind !== "authorization" || !code || !state) { setError("incomplete"); return; }
    let cancelled = false;
    void completeGitHubBrokerConnection({ code, state })
      .then((result) => { if (!cancelled) navigate(result.returnTo, { replace: true }); })
      .catch((cause: unknown) => { if (!cancelled) setError(failureKey(cause)); });
    return () => { cancelled = true; };
  }, [navigate, params]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg rounded-2xl border border-layer bg-card p-8 text-center shadow-sm">
        <Github aria-hidden="true" className="mx-auto h-10 w-10" />
        {error ? (
          <div role="alert">
            <h1 className="mt-4 text-xl font-semibold">{t("accountSync.github.callback.failedTitle")}</h1>
            <p className="mt-2 text-sm text-destructive">{t(`accountSync.github.callback.${error}`)}</p>
            <p className="mt-3 text-sm text-muted-foreground">{t("accountSync.github.callback.failed")}</p>
            <Button asChild className="mt-5"><Link to="/app/account-sync">{t("accountSync.github.callback.retry")}</Link></Button>
          </div>
        ) : (
          <div role="status">
            <Loader2 aria-hidden="true" className="mx-auto mt-4 h-6 w-6 animate-spin motion-reduce:animate-none" />
            <h1 className="mt-3 text-xl font-semibold">{t("accountSync.github.callback.connecting")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t("accountSync.github.callback.checking")}</p>
          </div>
        )}
      </div>
    </main>
  );
}
