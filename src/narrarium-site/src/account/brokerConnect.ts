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
import { accountSyncForNewGitHubConnection } from "@/account/githubSyncChoice";
import { microsoftIdentityFromClientInfo, type MicrosoftAuthorization } from "@/account/microsoftSignIn";
import type { LocalReplicaState } from "@/account/types";
import { fetchMicrosoftGraph } from "@/drive/microsoftGraph";
import { consumeGitHubAuthorization } from "@/github/githubOAuth";
import { useAuthStore } from "@/store/authStore";

/** An upgrade of a connection keeps its sync switch and history; a failure it had been waiting on is cleared. */
export function upgradedReplica(replica: LocalReplicaState): LocalReplicaState {
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

export interface GitHubBrokerConnection {
  /** The `code` and `state` GitHub sent back to the callback page. */
  code: string;
  state: string;
  now?: number;
}

/**
 * Finishing «Connect with GitHub»: the state is checked against the attempt this tab started, the code is swapped at the broker (which holds the app's
 * client secret), the user is read with the new token, and the connection is saved with its refresh token (sealed in the vault when the device remembers
 * it). Nothing is saved unless every step worked, so a failure leaves the existing connection exactly as it was. The tokens are never logged.
 */
export async function completeGitHubBrokerConnection(options: GitHubBrokerConnection): Promise<{ returnTo: string; rememberMe: boolean }> {
  let authorization;
  try { authorization = consumeGitHubAuthorization(options.state, options.now); } catch { throw new ConnectFlowError("state_mismatch"); }
  if (!options.code.trim()) throw new ConnectFlowError("invalid_response", "GitHub did not send an authorization code.");
  const tokens = await exchangeCode({ provider: "github", code: options.code, codeVerifier: authorization.codeVerifier, redirectUri: authorization.redirectUri });
  // A token that cannot be renewed would end after 8 hours without a way back: it is not accepted.
  if (!tokens.refreshToken) throw new ConnectFlowError("invalid_response", "GitHub did not return renewable credentials.");

  let response: Response;
  try { response = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/vnd.github+json" }, cache: "no-store" }); }
  catch { throw new ConnectFlowError("invalid_response", "GitHub could not be reached to read the account."); }
  if (!response.ok) throw new ConnectFlowError("invalid_response", `GitHub did not accept the new sign-in (${response.status}).`);
  const user = await response.json().catch(() => null) as { id?: unknown; login?: unknown; name?: unknown; email?: unknown; avatar_url?: unknown } | null;
  if (!user || typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.login !== "string" || !user.login) throw new ConnectFlowError("invalid_response", "GitHub did not return a stable account.");

  const accountId = String(user.id);
  const existing = useConnectionStore.getState().configuration.github;
  const sameAccount = existing?.identity?.providerAccountId === accountId;
  await useConnectionStore.getState().connectGitHub({
    method: "github-app",
    credentialKind: "app",
    identity: {
      provider: "github",
      providerAccountId: accountId,
      displayName: typeof user.name === "string" && user.name.trim() ? user.name.trim() : user.login,
      username: user.login,
      ...(typeof user.email === "string" ? { email: user.email } : {}),
      ...(typeof user.avatar_url === "string" ? { avatarUrl: user.avatar_url } : {}),
    },
    token: tokens.accessToken,
    accessTokenExpiry: bufferedAccessTokenExpiry(tokens.expiresIn),
    refreshToken: tokens.refreshToken,
    rememberMe: authorization.rememberMe,
    // The account syncs by itself, as with a token; the owner's earlier choice for this same account stands. If the app cannot reach narrarium.settings the card says so.
    accountSyncEnabled: accountSyncForNewGitHubConnection(existing, accountId),
    repositoryOwner: user.login,
    ...(sameAccount && existing ? { replica: upgradedReplica(existing.replica) } : {}),
  });
  return { returnTo: authorization.returnTo, rememberMe: authorization.rememberMe };
}
