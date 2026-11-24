import { acquireGitHubConnectionToken } from "@/account/githubConnectionToken";

export type ConnectionReadResult =
  | { ok: true }
  | { ok: false; reason: "refused"; status: number }
  | { ok: false; reason: "read-only" }
  | { ok: false; reason: "unreachable" };

/**
 * Whether the GitHub connection really reads AND writes a repository: one `GET /repos/{owner}/{repo}` with the connection's own token (renewed first when it is the
 * app's and about to lapse). It is the check that has to pass before a book's own token is let go of: an installation that looks right in the list is not
 * proof, a repository that answers is. The answer carries the `permissions` of the token's user on it: without `push: true` the connection could read the
 * book but not save to it, so the book keeps its own token.
 */
export async function verifyConnectionReadsRepository(owner: string, repo: string): Promise<ConnectionReadResult> {
  let token: string;
  try { token = await acquireGitHubConnectionToken(); }
  catch { return { ok: false, reason: "unreachable" }; }
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
  } catch { return { ok: false, reason: "unreachable" }; }
  if (!response.ok) return { ok: false, reason: "refused", status: response.status };
  const body = await response.json().catch(() => null) as { permissions?: { push?: unknown } } | null;
  return body?.permissions?.push === true ? { ok: true } : { ok: false, reason: "read-only" };
}
