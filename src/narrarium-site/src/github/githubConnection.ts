import { Octokit } from "@octokit/rest";
import { useConnectionStore } from "@/account/connectionStore";
import type { GitHubCredentialKind } from "@/account/types";

export async function connectGitHubCredential(input: { token: string; kind: GitHubCredentialKind; rememberMe: boolean; accountSyncEnabled?: boolean }): Promise<void> {
  const token = input.token.trim();
  if (!token) throw new Error("GitHub credential is required.");
  const octokit = new Octokit({ auth: token });
  const response = await octokit.rest.users.getAuthenticated();
  const user = response.data;
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error("GitHub did not return a stable numeric user ID.");
  await useConnectionStore.getState().connectGitHub({
    method: input.kind === "oauth" ? "github-oauth" : "github-pat",
    credentialKind: input.kind,
    identity: {
      provider: "github",
      providerAccountId: String(user.id),
      displayName: user.name?.trim() || user.login,
      username: user.login,
      email: user.email ?? undefined,
      avatarUrl: user.avatar_url,
    },
    token,
    rememberMe: input.rememberMe,
    accountSyncEnabled: input.accountSyncEnabled ?? true,
    repositoryOwner: user.login,
  });
}
