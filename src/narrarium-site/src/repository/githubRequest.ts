import { Octokit } from "@octokit/rest";
import { clearGitHubCredentialRejection, markGitHubCredentialRejected } from "@/github/remoteAvailability";
import { RepositoryError } from "@/repository/repositoryError";
import { recordRepositoryWriteValidated, recordSuccessfulGitHubResponse, type TokenHealthTarget } from "@/repository/tokenHealth";
import { LOCAL_BOOK_TOKEN } from "@/types/settings";

/**
 * Nothing is sent to GitHub without a credential: a GitHub book without one, or a book kept on this device (the local token), works on its working copy,
 * and GitHub is never asked anonymously. The error says what is missing instead of what GitHub would have answered.
 */
export function assertGitHubCredential(token: string): void {
  if (!token || token === LOCAL_BOOK_TOKEN) throw new RepositoryError("No GitHub credential.", "no-credential", "read");
}

/** What GitHub answered to a token tells whether it is still a credential: a 401 refuses it (revoked, expired), any answer accepts it again. */
export function recordGitHubCredentialAnswer(token: string, status: number): void {
  if (status === 401) markGitHubCredentialRejected(token);
  else if (status < 500) clearGitHubCredentialRejection(token);
}

export function createTrackedGitHubClient(token: string, target?: Omit<TokenHealthTarget, "token">): Octokit {
  const octokit = new Octokit({ auth: token });
  if (!octokit.hook) return octokit;
  octokit.hook.before("request", () => assertGitHubCredential(token));
  octokit.hook.error("request", (error) => {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") recordGitHubCredentialAnswer(token, status);
    throw error;
  });
  octokit.hook.after("request", async (response, options) => {
    recordGitHubCredentialAnswer(token, response.status);
    if (!target) return;
    const healthTarget = { ...target, token };
    await recordSuccessfulGitHubResponse(healthTarget, response.headers as Record<string, unknown>);
    const method = options.method.toUpperCase();
    const landedRefWrite = method === "PATCH" && /\/git\/refs\//.test(options.url);
    const landedContentsWrite = (method === "PUT" || method === "DELETE") && /\/contents(?:\/|$)/.test(options.url);
    if (landedRefWrite || landedContentsWrite) await recordRepositoryWriteValidated(healthTarget);
  });
  return octokit;
}
