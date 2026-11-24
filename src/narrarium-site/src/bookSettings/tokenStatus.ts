import type { LocalGitHubConnection } from "@/account/types";
import type { GitHubCredentialSource } from "@/github/githubCredentialRuntime";
import { tokenExpirationWarning, type TokenHealth } from "@/repository/tokenHealth";

/** What the settings say about the token a book uses: a key of the texts and its parameters. */
export interface TokenStatusText { key: string; params?: Record<string, unknown> }

/**
 * The status line of the token. A token of the GitHub app is not a token with an expiry that GitHub tells at each request: the app signs in for the
 * owner and renews its 8-hour token by itself, so what is known is said (who is connected, until when the current token lasts, whether this device keeps the
 * connection to renew it). Any other token has the expiry GitHub reported, or none: that is «unknown».
 */
export function describeTokenStatus(input: { source: GitHubCredentialSource | null; connection?: Pick<LocalGitHubConnection, "credentialKind" | "identity" | "accessTokenExpiry" | "refreshToken" | "rememberMe">; health?: Pick<TokenHealth, "expiresAt"> | null; now?: number }): TokenStatusText {
  const now = input.now ?? Date.now();
  const connection = input.connection;
  if (input.source === "app" && connection?.credentialKind === "app") {
    const user = connection.identity?.username ?? connection.identity?.displayName ?? "GitHub";
    const until = connection.accessTokenExpiry;
    const known = typeof until === "number" && Number.isFinite(until);
    const renews = Boolean(connection.refreshToken);
    if (known && until! <= now && !renews) return { key: "bookSettings.tokenStatus.appExpired", params: { user } };
    if (renews) return known && until! > now ? { key: "bookSettings.tokenStatus.appRenewsUntil", params: { user, time: new Date(until!).toISOString() } } : { key: "bookSettings.tokenStatus.appRenews", params: { user } };
    return known ? { key: "bookSettings.tokenStatus.appSessionUntil", params: { user, time: new Date(until!).toISOString() } } : { key: "bookSettings.tokenStatus.appConnected", params: { user } };
  }
  const expiry = input.health?.expiresAt;
  const warning = tokenExpirationWarning(expiry, now);
  if (warning === "unknown") return { key: "repoStatus.expiration.unknown" };
  return { key: `repoStatus.expiration.${warning}`, params: { date: expiry } };
}
