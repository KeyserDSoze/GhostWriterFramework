import type { Octokit } from "@octokit/rest";
import { classifyVisibilityFailure, VisibilityFlowError } from "@/repoVisibility/model";

export interface RepositoryVisibility {
  private: boolean;
  /** GitHub's word for it: `public`, `private` or `internal`. */
  visibility: string;
  /** The person is an administrator of the repository (what GitHub says of the token's user). */
  canAdminister: boolean;
  archived: boolean;
  htmlUrl: string;
  defaultBranch: string;
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { throw new VisibilityFlowError(classifyVisibilityFailure(error)); }
}

/** Reads the visibility from the repository itself (never guessed). */
export async function readRepositoryVisibility(octokit: Octokit, repo: { owner: string; repo: string }): Promise<RepositoryVisibility> {
  const { data } = await call(() => octokit.rest.repos.get({ ...repo }));
  return {
    private: data.private,
    visibility: typeof data.visibility === "string" ? data.visibility : data.private ? "private" : "public",
    canAdminister: data.permissions?.admin === true,
    archived: data.archived === true,
    htmlUrl: data.html_url,
    defaultBranch: data.default_branch || "main",
  };
}

/** `PATCH /repos/{owner}/{repo}` with `private`: needs Administration (write) for an app, the `repo` scope and admin rights for a token. */
export async function setRepositoryPrivate(octokit: Octokit, repo: { owner: string; repo: string }, makePrivate: boolean): Promise<void> {
  await call(() => octokit.rest.repos.update({ ...repo, private: makePrivate }));
}
