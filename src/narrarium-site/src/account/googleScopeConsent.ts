import { GOOGLE_CLIENT_ID } from "@/config/publicClients";

/**
 * Asking Google for one more scope, at the moment it is needed and only then (incremental authorization): Google Identity Services' token client with the
 * scope of that one request. What the person already allowed is kept (`include_granted_scopes`), so the consent screen shows only the new permission.
 *
 * The answer is an access token for this session only; it is never saved, and it does not change the connection (its refresh token, its scopes).
 */
export interface GoogleScopeGrant {
  accessToken: string;
  /** When the token stops working (ms since the epoch, a minute early). */
  expiresAt: number;
  /** The scopes the token has, as Google lists them. */
  scopes: string[];
}

export type GoogleScopeConsentFailure = "unavailable" | "denied" | "popup-blocked" | "failed";

export class GoogleScopeConsentError extends Error {
  constructor(readonly reason: GoogleScopeConsentFailure) {
    super(`Google did not give the access: ${reason}.`);
    this.name = "GoogleScopeConsentError";
  }
}

interface TokenResponse { access_token?: string; expires_in?: number | string; scope?: string; error?: string; error_description?: string }
interface TokenClient { requestAccessToken(overrides?: Record<string, unknown>): void }
interface GoogleIdentity {
  accounts?: { oauth2?: { initTokenClient?(config: Record<string, unknown>): TokenClient } };
}

function identity(): GoogleIdentity | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as { google?: GoogleIdentity }).google;
}

/** The scopes of the request that came back, as a list (Google answers with them separated by spaces). */
export function grantedScopes(response: Pick<TokenResponse, "scope">): string[] {
  return (response.scope ?? "").split(/\s+/).filter(Boolean);
}

export function requestGoogleScope(scope: string, options: { hint?: string; clientId?: string } = {}): Promise<GoogleScopeGrant> {
  const init = identity()?.accounts?.oauth2?.initTokenClient;
  if (!init) return Promise.reject(new GoogleScopeConsentError("unavailable"));
  const wanted = scope.split(/\s+/).filter(Boolean);
  return new Promise<GoogleScopeGrant>((resolve, reject) => {
    const client = init.call(identity()!.accounts!.oauth2, {
      client_id: options.clientId ?? GOOGLE_CLIENT_ID,
      scope,
      include_granted_scopes: true,
      ...(options.hint ? { hint: options.hint } : {}),
      callback: (response: TokenResponse) => {
        if (response.error || !response.access_token) { reject(new GoogleScopeConsentError(response.error === "access_denied" ? "denied" : "failed")); return; }
        const scopes = grantedScopes(response);
        // A person can untick a permission on the consent screen: what was not given is not assumed.
        if (!wanted.every((entry) => scopes.includes(entry))) { reject(new GoogleScopeConsentError("denied")); return; }
        resolve({ accessToken: response.access_token, expiresAt: Date.now() + (Number(response.expires_in ?? 3_600) - 60) * 1_000, scopes });
      },
      error_callback: (error: { type?: string }) => reject(new GoogleScopeConsentError(error?.type === "popup_failed_to_open" ? "popup-blocked" : error?.type === "popup_closed" ? "denied" : "failed")),
    });
    client.requestAccessToken();
  });
}
