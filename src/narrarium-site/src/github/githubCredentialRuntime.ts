let connectedGitHubToken = "";
let connectedGitHubSource: "oauth" | "connected-pat" = "connected-pat";

export function setConnectedGitHubToken(token: string | undefined, source: "oauth" | "connected-pat" = "connected-pat"): void {
  connectedGitHubToken = token?.trim() ?? "";
  connectedGitHubSource = source;
}

export function currentConnectedGitHubToken(): string {
  return connectedGitHubToken;
}

export type GitHubCredentialSource = "oauth" | "connected-pat" | "default-pat" | "named-pat" | "book-pat" | "manual-pat";

export interface ResolvedGitHubCredential {
  token: string;
  source: GitHubCredentialSource;
}

export function resolveGitHubCredentialValue(input: {
  bookToken?: string;
  tokenIndex?: number | null;
  extraTokens: Array<{ token: string }>;
  defaultToken: string;
}): ResolvedGitHubCredential | null {
  if (input.bookToken?.trim()) return { token: input.bookToken.trim(), source: "book-pat" };
  if (input.tokenIndex != null) {
    const token = input.extraTokens[input.tokenIndex]?.token.trim();
    if (token) return { token, source: "named-pat" };
  }
  if (input.defaultToken.trim()) return { token: input.defaultToken.trim(), source: "default-pat" };
  if (!connectedGitHubToken) return null;
  return { token: connectedGitHubToken, source: connectedGitHubSource };
}
