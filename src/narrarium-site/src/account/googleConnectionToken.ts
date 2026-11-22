import { acquireBrokerAccessToken, type AcquireOptions } from "@/account/brokerAccessToken";
import { accountBackendToken, useConnectionStore } from "@/account/connectionStore";

/**
 * The access token for syncing with Google Drive.
 *
 * With a refresh token (long-lived credentials) the token is renewed through the broker when it has less than a minute
 * left. Without one the connection behaves exactly as it always did: the stored token is used until it expires, then the
 * replica asks to reconnect.
 */
export async function acquireGoogleConnectionToken(options: AcquireOptions = {}): Promise<string> {
  if (useConnectionStore.getState().configuration.google?.refreshToken) return acquireBrokerAccessToken("google-drive", options);
  return accountBackendToken("google-drive");
}
