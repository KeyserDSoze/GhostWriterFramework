/**
 * The access token of Narrarium's GitHub App, kept alive.
 *
 * A GitHub App user token lasts 8 hours and comes with a refresh token that ROTATES: every renewal returns a new one and the old one stops working at
 * once. So, exactly as for Microsoft:
 * - a token with at least a minute of life left is used as it is;
 * - otherwise the refresh token is exchanged at the broker, inside the token-refresh lock (a Web Lock named for the provider, so two tabs never spend the
 *   same refresh token), after re-reading what another tab may have saved meanwhile;
 * - the new refresh token is sealed in the credential vault BEFORE anything else, because it is the only one that works now;
 * - `invalid_grant` (a refresh token that was revoked, used twice or has expired) means «Reconnect GitHub»: the token is forgotten and the error says the
 *   sign-in has to be renewed, never a retry. A passing problem (network, 5xx, rate limit) is passed on as it is and nothing is deleted.
 * The renewed token is also given to `setConnectedGitHubToken`, so the many places that read a book's token without waiting always find a fresh one.
 *
 * `installGitHubAppTokenRetry` is the other half: any request to api.github.com that carries the app's token and comes back 401 renews the token once and
 * is repeated once. A second 401 is the answer; there is no loop.
 */
import { bufferedAccessTokenExpiry, MIN_ACCESS_TOKEN_LIFE_MS, type AcquireOptions } from "@/account/brokerAccessToken";
import { loadLocalSyncConfiguration, saveLocalSyncConfiguration } from "@/account/accountLocalStore";
import { AccountCredentialError, persistedConfiguration, useConnectionStore } from "@/account/connectionStore";
import { BrokerError, refresh, revoke } from "@/account/credentialBroker";
import { deleteRefreshToken, loadRefreshToken, saveRefreshToken } from "@/account/credentialVault";
import { withTokenRefreshLock } from "@/account/tokenRefreshLock";
import type { LocalGitHubConnection } from "@/account/types";
import { currentConnectedGitHubSource, currentConnectedGitHubToken, setConnectedGitHubToken } from "@/github/githubCredentialRuntime";

const REVOKE_TIMEOUT_MS = 5_000;

/** The access tokens this device issued lately: a request that left with one of them just before it was replaced is still ours to repeat. */
const recentTokens: string[] = [];

function remember(token: string): void {
  if (!token || recentTokens.includes(token)) return;
  recentTokens.push(token);
  while (recentTokens.length > 4) recentTokens.shift();
}

function connection(): LocalGitHubConnection | undefined {
  const github = useConnectionStore.getState().configuration.github;
  return github?.credentialKind === "app" ? github : undefined;
}

function usable(current: LocalGitHubConnection): boolean {
  return Boolean(current.token) && current.accessTokenExpiry !== undefined && current.accessTokenExpiry - Date.now() >= MIN_ACCESS_TOKEN_LIFE_MS;
}

/** Adopts what another tab saved on this device meanwhile: a fresher access token, a rotated refresh token. */
async function reloadFromDevice(): Promise<void> {
  const known = connection();
  if (!known?.rememberMe || !known.identity) return;
  const accountId = known.identity.providerAccountId;
  let stored: LocalGitHubConnection | undefined;
  try { stored = (await loadLocalSyncConfiguration()).github; } catch { stored = undefined; }
  const sealed = await loadRefreshToken("github", accountId);
  const current = connection();
  if (!current || current.identity?.providerAccountId !== accountId) return;
  const patch: Partial<LocalGitHubConnection> = {};
  if (stored?.credentialKind === "app" && stored.identity?.providerAccountId === accountId && stored.token && (stored.accessTokenExpiry ?? 0) > (current.accessTokenExpiry ?? 0)) {
    patch.token = stored.token;
    patch.accessTokenExpiry = stored.accessTokenExpiry;
  }
  if (sealed && sealed !== current.refreshToken) patch.refreshToken = sealed;
  if (!Object.keys(patch).length) return;
  useConnectionStore.setState({ configuration: { ...useConnectionStore.getState().configuration, github: { ...current, ...patch } } });
  if (patch.token) setConnectedGitHubToken(patch.token, "app");
}

async function save(current: LocalGitHubConnection, credentials: { token: string; accessTokenExpiry: number; refreshToken: string }): Promise<void> {
  // The token that is being replaced is still ours: a request that left with it just before is repeated with the new one, not refused for good.
  if (current.token) remember(current.token);
  const next: LocalGitHubConnection = { ...current, token: credentials.token, accessTokenExpiry: credentials.accessTokenExpiry, refreshToken: credentials.refreshToken };
  // The rotated refresh token is the one that must survive a crash: sealed first.
  if (next.rememberMe && next.identity) await saveRefreshToken("github", next.identity.providerAccountId, credentials.refreshToken);
  const configuration = { ...useConnectionStore.getState().configuration, github: next };
  useConnectionStore.setState({ configuration });
  setConnectedGitHubToken(credentials.token, "app");
  remember(credentials.token);
  await saveLocalSyncConfiguration(persistedConfiguration(configuration));
}

/** Forgets a refresh token that no longer works, here and on the device. The connection stays, and asks to be reconnected. */
async function forgetRefreshToken(): Promise<void> {
  const current = connection();
  if (!current?.refreshToken) return;
  const { refreshToken: _forgotten, ...rest } = current;
  useConnectionStore.setState({ configuration: { ...useConnectionStore.getState().configuration, github: rest as LocalGitHubConnection } });
  await deleteRefreshToken("github");
  await saveLocalSyncConfiguration(persistedConfiguration(useConnectionStore.getState().configuration));
}

type TokenListener = (token: string) => void;
const listeners = new Set<TokenListener>();

/** Calls `listener` with each renewed token (the personal server's copy is one). Returns what stops it. */
export function onGitHubAppTokenRenewed(listener: TokenListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function renew(current: LocalGitHubConnection): Promise<string> {
  let tokens;
  try {
    tokens = await refresh("github", current.refreshToken!);
  } catch (error) {
    if (error instanceof BrokerError && error.code === "invalid_grant") {
      await forgetRefreshToken();
      throw new AccountCredentialError("github", "expired", "bad_refresh_token");
    }
    if (error instanceof BrokerError && error.code === "not_configured") throw new AccountCredentialError("github", "expired", "not_configured");
    throw error;
  }
  // GitHub always rotates: an answer without the new refresh token cannot be kept alive, so it is not trusted for more than its 8 hours.
  await save(current, { token: tokens.accessToken, accessTokenExpiry: bufferedAccessTokenExpiry(tokens.expiresIn), refreshToken: tokens.refreshToken ?? current.refreshToken! });
  for (const listener of [...listeners]) { try { listener(tokens.accessToken); } catch { /* a listener never breaks a renewal */ } }
  void sendToServerBooks(tokens.accessToken);
  return tokens.accessToken;
}

/** A book run by the personal server on the app's token gets the renewed token too (the autopilot runtime is loaded only when there is such a book). */
async function sendToServerBooks(token: string): Promise<void> {
  try {
    const { useSettingsStore } = await import("@/store/settingsStore");
    if (!useSettingsStore.getState().settings.books.some((book) => book.autopilotHost === "server")) return;
    const { autopilotRuntime } = await import("@/autopilot/runtime");
    await autopilotRuntime.refreshServerGitHubToken(token);
  } catch {
    // Never a failure of the renewal.
  }
}

export interface AcquireAppOptions extends AcquireOptions {
  /** The token the caller was refused with: a token already replaced by someone else is used instead of renewing again. */
  stale?: string;
}

export async function acquireGitHubAppToken(options: AcquireAppOptions = {}): Promise<string> {
  const known = connection();
  if (!known) throw new AccountCredentialError("github", "missing");
  const force = options.force === true || known.replica.errorKind === "credential-expired";
  if (!force && usable(known)) return known.token!;
  const stale = options.stale ?? known.token;

  return withTokenRefreshLock("github", async () => {
    await reloadFromDevice();
    const current = connection();
    if (!current) throw new AccountCredentialError("github", "missing");
    if (!current.refreshToken) throw new AccountCredentialError("github", "expired");
    // Whoever held the lock before may have renewed it already.
    if (usable(current) && !(force && current.token === stale)) return current.token!;
    return renew(current);
  });
}

/**
 * Revokes the app's authorization of the user at GitHub, through the broker (it deletes the grant, so every token of the app on every device stops).
 * GitHub finds the grant only by a LIVE access token: the token is renewed first when it can be. Every failure is swallowed: disconnecting never waits
 * for GitHub, and a user can always revoke the app at github.com/settings/applications.
 */
export async function revokeGitHubAppGrant(previous: LocalGitHubConnection): Promise<void> {
  let token = previous.token;
  if (previous.refreshToken) {
    try { token = (await refresh("github", previous.refreshToken, { timeoutMs: REVOKE_TIMEOUT_MS })).accessToken; } catch { /* the old token is tried */ }
  }
  if (!token) return;
  try { await revoke("github", token, { timeoutMs: REVOKE_TIMEOUT_MS }); } catch { /* best effort */ }
}

function isAppToken(token: string): boolean {
  return Boolean(token) && ((currentConnectedGitHubSource() === "app" && token === currentConnectedGitHubToken()) || recentTokens.includes(token));
}

function authorizationOf(input: RequestInfo | URL, init?: RequestInit): { token: string; scheme: string } | null {
  const raw = init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined);
  if (!raw) return null;
  const value = new Headers(raw as HeadersInit).get("authorization");
  const match = value ? /^(token|bearer)\s+(\S+)$/i.exec(value) : null;
  return match ? { scheme: match[1], token: match[2] } : null;
}

function replayable(init: RequestInit | undefined): boolean {
  const body = init?.body;
  return body === undefined || body === null || typeof body === "string" || body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || (typeof Blob !== "undefined" && body instanceof Blob);
}

let previousFetch: typeof fetch | null = null;

/**
 * Installs the one repeat of a request that GitHub refused (401) while it carried the app's access token: the token is renewed (once, shared with any
 * other renewal) and the request is sent again with it. A request that carries any other credential, a body that cannot be sent twice, or a renewal
 * that fails is answered with the 401 as it was; a second 401 is the answer too.
 */
export function installGitHubAppTokenRetry(): void {
  if (previousFetch || typeof globalThis.fetch !== "function") return;
  const base = globalThis.fetch;
  previousFetch = base;
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await base(input, init);
    if (response.status !== 401) return response;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.github.com/")) return response;
    const credentials = authorizationOf(input, init);
    if (!credentials || !isAppToken(credentials.token) || !replayable(init) || (typeof input === "object" && !(input instanceof URL))) return response;
    let fresh: string;
    try { fresh = await acquireGitHubAppToken({ force: true, stale: credentials.token }); } catch { return response; }
    if (!fresh || fresh === credentials.token) return response;
    void response.body?.cancel().catch(() => undefined);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `${credentials.scheme} ${fresh}`);
    return base(input, { ...init, headers });
  };
  globalThis.fetch = wrapped as typeof fetch;
}

export function resetGitHubAppTokenForTests(): void {
  if (previousFetch) globalThis.fetch = previousFetch;
  previousFetch = null;
  recentTokens.length = 0;
  listeners.clear();
}
