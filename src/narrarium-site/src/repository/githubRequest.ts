import { Octokit } from "@octokit/rest";
import { recordRepositoryWriteValidated, recordSuccessfulGitHubResponse, type TokenHealthTarget } from "@/repository/tokenHealth";

export function createTrackedGitHubClient(token: string, target?: Omit<TokenHealthTarget, "token">): Octokit {
  const octokit = new Octokit({ auth: token });
  if (target && octokit.hook?.after) {
    octokit.hook.after("request", async (response, options) => {
      const healthTarget = { ...target, token };
      await recordSuccessfulGitHubResponse(healthTarget, response.headers as Record<string, unknown>);
      const method = options.method.toUpperCase();
      const landedRefWrite = method === "PATCH" && /\/git\/refs\//.test(options.url);
      const landedContentsWrite = (method === "PUT" || method === "DELETE") && /\/contents(?:\/|$)/.test(options.url);
      if (landedRefWrite || landedContentsWrite) await recordRepositoryWriteValidated(healthTarget);
    });
  }
  return octokit;
}
