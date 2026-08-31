import { GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET_B64X3 } from "@/config/publicClients";

const ATTEMPT_KEY = "narrarium-github-oauth-attempt-v1";
const ATTEMPT_MAX_AGE_MS = 10 * 60_000;
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const AUTHORIZE_ENDPOINT = "https://github.com/login/oauth/authorize";

/** Verified in Chromium on 2026-08-31: GitHub's token response has no CORS grant. */
export const GITHUB_OAUTH_BROWSER_EXCHANGE_SUPPORTED = false;

interface GitHubOAuthAttempt {
  version: 1;
  state: string;
  codeVerifier: string;
  createdAt: number;
  expiresAt: number;
  rememberMe: boolean;
  returnTo: string;
}

export interface GitHubOAuthResult {
  accessToken: string;
  scope: string;
  tokenType: string;
  rememberMe: boolean;
  returnTo: string;
}

/**
 * Exactly three Base64 decodes as requested. This is only obfuscation. Anyone
 * who can download the JavaScript bundle can recover the OAuth client secret.
 */
export function decodeGitHubClientSecret(value: string): string {
  return atob(atob(atob(value)));
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

export async function createGitHubOAuthAuthorizationUrl(options: { rememberMe: boolean; returnTo?: string; now?: number }): Promise<string> {
  if (!GITHUB_OAUTH_CLIENT_ID) throw new Error("VITE_GITHUB_OAUTH_CLIENT_ID is not configured.");
  const now = options.now ?? Date.now();
  const attempt: GitHubOAuthAttempt = {
    version: 1,
    state: randomUrlSafe(32),
    codeVerifier: randomUrlSafe(64),
    createdAt: now,
    expiresAt: now + ATTEMPT_MAX_AGE_MS,
    rememberMe: options.rememberMe,
    returnTo: safeReturnTo(options.returnTo),
  };
  sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
  const query = new URLSearchParams({
    client_id: GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: githubOAuthCallbackUrl(),
    scope: "repo read:user user:email",
    state: attempt.state,
    code_challenge: await sha256UrlSafe(attempt.codeVerifier),
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_ENDPOINT}?${query}`;
}

export async function exchangeGitHubOAuthCode(code: string, state: string, now = Date.now()): Promise<GitHubOAuthResult> {
  const attempt = consumeAttempt(state, now);
  if (!code.trim()) throw new Error("GitHub OAuth callback did not include an authorization code.");
  if (!GITHUB_OAUTH_CLIENT_ID || !GITHUB_OAUTH_CLIENT_SECRET_B64X3) throw new Error("GitHub OAuth client configuration is incomplete.");
  const clientSecret = decodeGitHubClientSecret(GITHUB_OAUTH_CLIENT_SECRET_B64X3);
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GITHUB_OAUTH_CLIENT_ID,
        client_secret: clientSecret,
        code,
        redirect_uri: githubOAuthCallbackUrl(),
        code_verifier: attempt.codeVerifier,
      }),
    });
  } catch (error) {
    const wrapped = new Error("GitHub OAuth token exchange could not be completed by this browser. GitHub may be blocking cross-origin token responses for static clients.");
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
  if (!response.ok) throw new Error(`GitHub OAuth token exchange failed (${response.status}).`);
  const body = await response.json() as { access_token?: unknown; scope?: unknown; token_type?: unknown; error?: unknown; error_description?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    const detail = typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : "missing access token";
    throw new Error(`GitHub OAuth token exchange failed: ${detail}.`);
  }
  return {
    accessToken: body.access_token,
    scope: typeof body.scope === "string" ? body.scope : "",
    tokenType: typeof body.token_type === "string" ? body.token_type : "bearer",
    rememberMe: attempt.rememberMe,
    returnTo: attempt.returnTo,
  };
}

function consumeAttempt(state: string, now: number): GitHubOAuthAttempt {
  let attempt: GitHubOAuthAttempt | null = null;
  try { attempt = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY) ?? "null") as GitHubOAuthAttempt | null; }
  finally { sessionStorage.removeItem(ATTEMPT_KEY); }
  if (!attempt || attempt.version !== 1 || attempt.state !== state || !state || attempt.createdAt > now || attempt.expiresAt <= now || attempt.expiresAt !== attempt.createdAt + ATTEMPT_MAX_AGE_MS || !attempt.codeVerifier) {
    throw new Error("GitHub OAuth state is invalid, expired, or was already used.");
  }
  return attempt;
}

function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/app") || value.startsWith("//")) return "/app/account-sync";
  return value;
}

export function clearGitHubOAuthAttempt(): void {
  sessionStorage.removeItem(ATTEMPT_KEY);
}
