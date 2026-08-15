import { ensureDevBranch } from "@/github/githubClient";
export { branchIsReady, resolveAuthoritativeBranch } from "@/github/branchRules";

const pendingCreations = new Map<string, Promise<string>>();

export function ensureAuthoritativePersonalBranch(input: {
  token: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  email: string;
}): Promise<string> {
  const key = `${input.owner}/${input.repo}:${input.defaultBranch}:${input.email.trim().toLowerCase()}`;
  const existing = pendingCreations.get(key);
  if (existing) return existing;
  const pending = ensureDevBranch(input.token, input.owner, input.repo, input.defaultBranch, input.email)
    .finally(() => pendingCreations.delete(key));
  pendingCreations.set(key, pending);
  return pending;
}
