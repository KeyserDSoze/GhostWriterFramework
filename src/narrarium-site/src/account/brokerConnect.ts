/**
 * Finishing a connection that was started with the authorization code (Google) or the sign-in window (Microsoft):
 * the code is swapped at the broker, the profile is read as before, and the connection is saved with its refresh token.
 *
 * Nothing is saved unless every step worked, so a failure leaves the existing connection exactly as it was.
 */
import { bufferedAccessTokenExpiry } from "@/account/brokerAccessToken";
import { ConnectFlowError } from "@/account/connectErrors";
import { useConnectionStore } from "@/account/connectionStore";
import { exchangeCode } from "@/account/credentialBroker";
import { microsoftIdentityFromClientInfo, type MicrosoftAuthorization } from "@/account/microsoftSignIn";
import type { LocalReplicaState } from "@/account/types";
import { fetchMicrosoftGraph } from "@/drive/microsoftGraph";
import { useAuthStore } from "@/store/authStore";

/** An upgrade of a connection keeps its sync switch and history; a failure it had been waiting on is cleared. */
function upgradedReplica(replica: LocalReplicaState): LocalReplicaState {
  return replica.enabled ? { ...replica, status: "dirty", errorKind: undefined, lastErrorMessage: undefined } : replica;
}

export interface GoogleCodeConnection {
  code: string;
  rememberMe: boolean;
  /** Set when an existing connection is being upgraded: another account is refused. */
  expectedAccountId?: string;
  /** Keep the connection's sync switch and history (an upgrade), instead of starting a new replica. */
  preserveReplica?: boolean;
}

/** `longLived` is false when Google issued no refresh token (it does so only when the user consents again). */
export async function completeGoogleCodeConnection(options: GoogleCodeConnection): Promise<{ longLived: boolean }> {
  const tokens = await exchangeCode({ provider: "google", code: options.code });
  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
  if (!profileResponse.ok) throw new Error(`Google profile failed (${profileResponse.status}).`);
  const profile = await profileResponse.json() as { sub?: string; name?: string; email?: string; picture?: string };
  if (!profile.sub) throw new Error("Google did not return an immutable account ID.");
  if (options.expectedAccountId && profile.sub !== options.expectedAccountId) throw new ConnectFlowError("wrong_account");

  const existing = useConnectionStore.getState().configuration.google;
  const sameAccount = existing?.identity.providerAccountId === profile.sub;
  // Google sends a refresh token only on (re)consent: the one already held for the same account stays, another account's never does.
  const refreshToken = tokens.refreshToken ?? (sameAccount ? existing?.refreshToken : undefined);
  const displayName = profile.name || profile.email || "Google";
  await useConnectionStore.getState().connectGoogle({
    identity: { provider: "google", providerAccountId: profile.sub, displayName, email: profile.email, avatarUrl: profile.picture },
    accessToken: tokens.accessToken,
    accessTokenExpiry: bufferedAccessTokenExpiry(tokens.expiresIn),
    rememberMe: options.rememberMe,
    ...(refreshToken ? { refreshToken } : {}),
    ...(options.preserveReplica && sameAccount && existing ? { replica: upgradedReplica(existing.replica) } : {}),
  });
  useAuthStore.getState().setInteractiveAuth(tokens.accessToken, { provider: "google", providerAccountId: profile.sub, name: displayName, email: profile.email ?? "", picture: profile.picture ?? "" }, tokens.expiresIn, options.rememberMe);
  return { longLived: Boolean(refreshToken) };
}

export interface MicrosoftBrokerConnection {
  authorization: MicrosoftAuthorization;
  rememberMe: boolean;
  /** Set when an existing connection is being upgraded: another account is refused. */
  expectedHomeAccountId?: string;
  preserveReplica?: boolean;
}

export async function completeMicrosoftBrokerConnection(options: MicrosoftBrokerConnection): Promise<{ longLived: true }> {
  const { code, codeVerifier, redirectUri } = options.authorization;
  const tokens = await exchangeCode({ provider: "microsoft", code, codeVerifier, redirectUri });
  if (!tokens.refreshToken) throw new ConnectFlowError("invalid_response", "Microsoft did not return long-lived credentials.");
  if (!tokens.clientInfo) throw new ConnectFlowError("invalid_response", "Microsoft did not say which account this is.");
  // The identity MSAL would have built, so the app never takes this account for another one.
  const { homeAccountId, localAccountId } = microsoftIdentityFromClientInfo(tokens.clientInfo);
  if (options.expectedHomeAccountId && homeAccountId !== options.expectedHomeAccountId) throw new ConnectFlowError("wrong_account");

  const profileResponse = await fetchMicrosoftGraph("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
  if (!profileResponse.ok) throw new Error(`Microsoft profile failed (${profileResponse.status}).`);
  const profile = await profileResponse.json() as { displayName?: string; mail?: string; userPrincipalName?: string };

  const existing = useConnectionStore.getState().configuration.microsoft;
  const sameAccount = existing?.homeAccountId === homeAccountId;
  const displayName = profile.displayName || profile.mail || "Microsoft";
  await useConnectionStore.getState().connectMicrosoft({
    identity: { provider: "microsoft", providerAccountId: homeAccountId, displayName, email: profile.mail ?? profile.userPrincipalName },
    accessToken: tokens.accessToken,
    accessTokenExpiry: bufferedAccessTokenExpiry(tokens.expiresIn),
    homeAccountId,
    localAccountId,
    rememberMe: options.rememberMe,
    refreshToken: tokens.refreshToken,
    ...(options.preserveReplica && sameAccount && existing ? { replica: upgradedReplica(existing.replica) } : {}),
  });
  useAuthStore.getState().setInteractiveAuth(tokens.accessToken, { provider: "microsoft", providerAccountId: homeAccountId, name: displayName, email: profile.mail ?? profile.userPrincipalName ?? "", picture: "", homeAccountId, localAccountId }, Math.max(120, tokens.expiresIn), options.rememberMe);
  return { longLived: true };
}
