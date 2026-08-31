import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Github, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exchangeGitHubOAuthCode } from "@/github/githubOAuth";
import { connectGitHubCredential } from "@/github/githubConnection";

export function GitHubOAuthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const providerError = params.get("error_description") ?? params.get("error");
    const code = params.get("code");
    const state = params.get("state");
    if (providerError || !code || !state) { setError(providerError ?? "GitHub OAuth callback is incomplete."); return; }
    let cancelled = false;
    void exchangeGitHubOAuthCode(code, state)
      .then(async (result) => {
        await connectGitHubCredential({ token: result.accessToken, kind: "oauth", rememberMe: result.rememberMe, accountSyncEnabled: true });
        if (!cancelled) navigate(result.returnTo, { replace: true });
      })
      .catch((cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [navigate, params]);

  return <main className="flex min-h-screen items-center justify-center bg-background p-6"><div className="w-full max-w-lg rounded-2xl border bg-card p-8 text-center shadow-sm"><Github className="mx-auto h-10 w-10" />{error ? <><h1 className="mt-4 text-xl font-semibold">GitHub connection failed</h1><p className="mt-2 text-sm text-destructive">{error}</p><p className="mt-3 text-sm text-muted-foreground">The static browser token exchange may be blocked by GitHub CORS. No backend fallback is used. You can connect with a PAT instead.</p><Button asChild className="mt-5"><Link to="/app/account-sync">Use a PAT</Link></Button></> : <><Loader2 className="mx-auto mt-4 h-6 w-6 animate-spin" /><h1 className="mt-3 text-xl font-semibold">Connecting GitHub</h1><p className="mt-2 text-sm text-muted-foreground">Validating the one-time PKCE callback...</p></>}</div></main>;
}
