import { GITHUB_APP_CLIENT_ID } from "@/config/publicClients";

/**
 * The browser's half of «Connect with GitHub»: the authorization request of Narrarium's GitHub App, with PKCE (S256), a one-time state and an attempt
 * that lasts ten minutes. The other half, swapping the code for tokens, is the broker's (`completeGitHubBrokerConnection`): GitHub's token endpoint
 * has no CORS and the exchange needs the app's client secret, which only the Cloudflare Worker holds. Nothing in this site ever sends a secret to
 * github.com, and a GitHub App asks for no scopes: what its token can do is set by the app's permissions and the repositories it is installed on.
 */
const ATTEMPT_KEY = "narrarium-github-oauth-attempt-v2";
const ATTEMPT_MAX_AGE_MS = 10 * 60_000;
const AUTHORIZE_ENDPOINT = "https://github.com/login/oauth/authorize";

interface GitHubAuthorizationAttempt {
  version: 2;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
  rememberMe: boolean;
  returnTo: string;
}

/** What the callback page needs to finish the connection: the verifier and the redirect address the code was asked with. */
export interface GitHubAuthorization {
  codeVerifier: string;
  redirectUri: string;
  rememberMe: boolean;
  returnTo: string;
}

function randomUrlSafe(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256UrlSafe(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function githubOAuthCallbackUrl(): string {
  return new URL("auth/github/callback", new URL(import.meta.env.BASE_URL, window.location.origin)).toString();
}

export async function createGitHubAppAuthorizationUrl(options: { rememberMe: boolean; returnTo?: string; now?: number }): Promise<string> {
  if (!GITHUB_APP_CLIENT_ID) throw new Error("The GitHub App is not configured for this build.");
  const now = options.now ?? Date.now();
  const attempt: GitHubAuthorizationAttempt = {
    version: 2,
    state: randomUrlSafe(32),
    codeVerifier: randomUrlSafe(64),
    redirectUri: githubOAuthCallbackUrl(),
    createdAt: now,
    expiresAt: now + ATTEMPT_MAX_AGE_MS,
    rememberMe: options.rememberMe,
    returnTo: safeReturnTo(options.returnTo),
  };
  sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
  const query = new URLSearchParams({
    client_id: GITHUB_APP_CLIENT_ID,
    redirect_uri: attempt.redirectUri,
    state: attempt.state,
    code_challenge: await sha256UrlSafe(attempt.codeVerifier),
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_ENDPOINT}?${query}`;
}

/** Checks the state of the callback against the attempt this tab started, once: a second try, a wrong or an old state is refused. */
export function consumeGitHubAuthorization(state: string, now = Date.now()): GitHubAuthorization {
  let attempt: GitHubAuthorizationAttempt | null = null;
  try { attempt = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY) ?? "null") as GitHubAuthorizationAttempt | null; }
  catch { attempt = null; }
  finally { sessionStorage.removeItem(ATTEMPT_KEY); }
  if (!attempt || attempt.version !== 2 || attempt.state !== state || !state || attempt.createdAt > now || attempt.expiresAt <= now || attempt.expiresAt !== attempt.createdAt + ATTEMPT_MAX_AGE_MS || !attempt.codeVerifier || !attempt.redirectUri) {
    throw new Error("GitHub sign-in state is invalid, expired, or was already used.");
  }
  return { codeVerifier: attempt.codeVerifier, redirectUri: attempt.redirectUri, rememberMe: attempt.rememberMe, returnTo: attempt.returnTo };
}

function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/app") || value.startsWith("//")) return "/app/account-sync";
  return value;
}

export function clearGitHubOAuthAttempt(): void {
  sessionStorage.removeItem(ATTEMPT_KEY);
}
