/**
 * Access tokens for connections that hold a refresh token: renewed through the broker, one renewal at a time.
 *
 * The rules (Google and Microsoft alike):
 * - an access token with at least a minute of life left is used as it is;
 * - otherwise the refresh token is exchanged at the broker (inside the token-refresh lock, after re-reading the
 *   connection: another tab may have renewed meanwhile) and the new token, its expiry and, when the broker sends one,
 *   the new refresh token are saved. Microsoft rotates the refresh token on every renewal, so a new one is always kept;
 * - invalid_grant means the refresh token no longer works: it is forgotten and the replica asks to reconnect;
 * - a broker that is not configured any more asks to reconnect too, but the token is kept in case it comes back;
 * - anything else (network, 5xx, rate limit) is a passing problem: nothing is deleted and the error is passed on as it is,
 *   so the replica reports an error, not a lost login.
 */
import { AccountCredentialError, useConnectionStore } from "@/account/connectionStore";
import { BrokerError, refresh, type BrokerTokens } from "@/account/credentialBroker";
import { microsoftIdentityFromClientInfo } from "@/account/microsoftSignIn";
import { withTokenRefreshLock } from "@/account/tokenRefreshLock";
import type { LocalGoogleConnection, LocalMicrosoftConnection } from "@/account/types";
import { registerCloudAccount } from "@/drive/cloudWriteBarrier";
import { useAuthStore } from "@/store/authStore";

export type DriveBackend = "google-drive" | "onedrive";

export interface AcquireOptions {
  /** Renew even if the recorded expiry looks fine, for a token the provider has refused. */
  force?: boolean;
}

/** An access token needs at least this much life left to be used. */
export const MIN_ACCESS_TOKEN_LIFE_MS = 60_000;
/** The recorded expiry is the real one minus this, as everywhere else in the connection store. */
const EXPIRY_BUFFER_SECONDS = 60;

/** When an access token that lives `expiresInSeconds` should be considered over (a minute early). */
export function bufferedAccessTokenExpiry(expiresInSeconds: number, now = Date.now()): number {
  return now + Math.max(expiresInSeconds - EXPIRY_BUFFER_SECONDS, Math.floor(expiresInSeconds / 2)) * 1_000;
}

type Connection = LocalGoogleConnection | LocalMicrosoftConnection;

function connectionOf(backend: DriveBackend): Connection | undefined {
  const configuration = useConnectionStore.getState().configuration;
  return backend === "google-drive" ? configuration.google : configuration.microsoft;
}

function usable(connection: Connection): boolean {
  return Boolean(connection.accessToken) && connection.accessTokenExpiry !== undefined && connection.accessTokenExpiry - Date.now() >= MIN_ACCESS_TOKEN_LIFE_MS;
}

function sameAccount(auth: { provider: string; providerAccountId?: string; homeAccountId?: string; localAccountId?: string }, connection: Connection): boolean {
  if (connection.backend === "google-drive") return auth.provider === "google" && auth.providerAccountId === connection.identity.providerAccountId;
  return auth.provider === "microsoft" && auth.homeAccountId === connection.homeAccountId && auth.localAccountId === connection.localAccountId;
}

async function renew(backend: DriveBackend, connection: Connection): Promise<string> {
  const provider = backend === "google-drive" ? "google" : "microsoft";
  const store = useConnectionStore.getState();
  let tokens: BrokerTokens;
  try {
    tokens = await refresh(provider, connection.refreshToken!);
  } catch (error) {
    if (error instanceof BrokerError && error.code === "invalid_grant") {
      await store.clearRefreshToken(backend);
      throw new AccountCredentialError(backend, "expired");
    }
    if (error instanceof BrokerError && error.code === "not_configured") throw new AccountCredentialError(backend, "expired");
    throw error;
  }

  if (connection.backend === "onedrive" && tokens.clientInfo) {
    // Never keep tokens that belong to another Microsoft account than the one this connection syncs.
    let identity: ReturnType<typeof microsoftIdentityFromClientInfo> | null = null;
    try { identity = microsoftIdentityFromClientInfo(tokens.clientInfo); } catch { identity = null; }
    if (identity && (identity.homeAccountId !== connection.homeAccountId || identity.localAccountId !== connection.localAccountId)) throw new AccountCredentialError(backend, "expired");
  }

  await store.updateCredentials(backend, {
    accessToken: tokens.accessToken,
    accessTokenExpiry: bufferedAccessTokenExpiry(tokens.expiresIn),
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
  });
  registerCloudAccount(provider, tokens.accessToken, connection.identity.providerAccountId);

  const auth = useAuthStore.getState();
  if (auth.user && sameAccount(auth.user, connection)) auth.setAuth(tokens.accessToken, auth.user, Math.max(120, tokens.expiresIn));
  return tokens.accessToken;
}

export async function acquireBrokerAccessToken(backend: DriveBackend, options: AcquireOptions = {}): Promise<string> {
  const provider = backend === "google-drive" ? "google" : "microsoft";
  const connection = connectionOf(backend);
  if (!connection) throw new AccountCredentialError(backend, "missing");
  // A sync that the provider refused for an expired login is retried with a renewed token, even if the clock says it is fine.
  const force = options.force === true || connection.replica.errorKind === "credential-expired";
  if (!force && usable(connection)) return connection.accessToken!;
  const staleToken = connection.accessToken;

  return withTokenRefreshLock(provider, async () => {
    await useConnectionStore.getState().reloadCredentialsFromDevice(backend);
    const current = connectionOf(backend);
    if (!current) throw new AccountCredentialError(backend, "missing");
    if (!current.refreshToken) throw new AccountCredentialError(backend, "expired");
    // Whoever held the lock before may have renewed the token already.
    if (usable(current) && !(force && current.accessToken === staleToken)) return current.accessToken!;
    return renew(backend, current);
  });
}
