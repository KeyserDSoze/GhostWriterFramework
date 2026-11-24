import { setDeviceLocalSecret } from "@/account/deviceSecrets";

let connectedGitHubToken = "";
let connectedGitHubSource: "app" | "connected-pat" = "connected-pat";

/**
 * The token of the GitHub connection of this device, for the many places that read a book's token without waiting. The refresher of the app token keeps it
 * fresh. The token of the app is registered as a device-local secret: it is never part of what is synced.
 */
export function setConnectedGitHubToken(token: string | undefined, source: "app" | "connected-pat" = "connected-pat"): void {
  connectedGitHubToken = token?.trim() ?? "";
  connectedGitHubSource = source;
  setDeviceLocalSecret("github-app-access-token", source === "app" ? connectedGitHubToken : undefined);
}

export function currentConnectedGitHubToken(): string {
  return connectedGitHubToken;
}

export function currentConnectedGitHubSource(): "app" | "connected-pat" {
  return connectedGitHubSource;
}

export type GitHubCredentialSource = "app" | "connected-pat" | "default-pat" | "named-pat" | "book-pat" | "manual-pat";

export interface ResolvedGitHubCredential {
  token: string;
  source: GitHubCredentialSource;
}

/**
 * Which token a book uses. The order is: the book's own token, the named token the book points at, the default token, the GitHub connection. Whatever
 * the author typed wins over the connection; one setting, «prefer the GitHub connection», moves the connection ahead of the default token only (never ahead
 * of the book's own or named token, which are explicit choices for that book).
 */
export function resolveGitHubCredentialValue(input: {
  bookToken?: string;
  tokenIndex?: number | null;
  extraTokens: Array<{ token: string }>;
  defaultToken: string;
  preferConnection?: boolean;
  /** This book was moved to the connection (it has no token of its own and does not follow the default token). */
  useConnection?: boolean;
}): ResolvedGitHubCredential | null {
  if (input.bookToken?.trim()) return { token: input.bookToken.trim(), source: "book-pat" };
  if (input.tokenIndex != null) {
    const token = input.extraTokens[input.tokenIndex]?.token.trim();
    if (token) return { token, source: "named-pat" };
  }
  if ((input.preferConnection || input.useConnection) && connectedGitHubToken) return { token: connectedGitHubToken, source: connectedGitHubSource };
  if (input.defaultToken.trim()) return { token: input.defaultToken.trim(), source: "default-pat" };
  if (!connectedGitHubToken) return null;
  return { token: connectedGitHubToken, source: connectedGitHubSource };
}
