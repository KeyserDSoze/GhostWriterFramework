import { createTrackedGitHubClient } from "@/repository/githubRequest";
import { classifyRepositoryError } from "@/repository/repositoryError";
import type { RateLimitState } from "@/branches/autoSyncPolicy";

/**
 * The branches of a repository and their heads, in one request per page (`GET /repos/{owner}/{repo}/branches`, 100 a page), asked again with the ETag of
 * the last answer: an unchanged list answers 304, which costs nothing of the hour's rate limit. Each page and its ETag are kept on this device
 * (localStorage, per account and repository: branch names and commit ids, nothing secret), so every tab and the next start ask conditionally too.
 */

/** At most this many pages (1,000 branches): a longer list is said to be incomplete, and a branch not in it is not taken for one GitHub does not have. */
export const MAX_BRANCH_PAGES = 10;
const CACHE_PREFIX = "narrarium-branch-list-v1:";
/** A first request carries a condition too, so that the browser never answers it from its own cache (an author's condition makes the fetch `no-store`). */
const NEVER = "Thu, 01 Jan 1970 00:00:00 GMT";

interface CachedPage {
  etag?: string;
  branches: Array<[string, string]>;
  next: boolean;
}

interface CachedListing {
  pages: CachedPage[];
  at: number;
}

export interface RemoteBranchListing {
  /** Head commit by branch. */
  heads: Map<string, string>;
  /** False when GitHub had more pages than are read. */
  complete: boolean;
  /** Every page answered 304: nothing changed on GitHub since the last list. */
  unchanged: boolean;
  rate: RateLimitState | null;
}

function cacheKey(accountIdentity: string, owner: string, repo: string): string {
  return `${CACHE_PREFIX}${accountIdentity}::${owner}/${repo}`.toLowerCase();
}

function readCache(key: string): CachedListing | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as CachedListing | null;
    return parsed && Array.isArray(parsed.pages) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, listing: CachedListing): void {
  try { localStorage.setItem(key, JSON.stringify(listing)); } catch { /* a full storage only costs a full request next time */ }
}

function header(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

function rateOf(headers: Record<string, unknown> | undefined): RateLimitState | null {
  const remaining = Number(header(headers, "x-ratelimit-remaining"));
  const reset = Number(header(headers, "x-ratelimit-reset"));
  return Number.isFinite(remaining) && Number.isFinite(reset) && header(headers, "x-ratelimit-remaining") !== undefined ? { remaining, resetAt: reset * 1000 } : null;
}

/** The last list of this repository on this device, without asking GitHub (the switcher paints it at once). */
export function cachedRemoteBranches(accountIdentity: string, owner: string, repo: string): { heads: Map<string, string>; at: number } | null {
  const cached = readCache(cacheKey(accountIdentity, owner, repo));
  return cached ? { heads: new Map(cached.pages.flatMap((page) => page.branches)), at: cached.at } : null;
}

export async function listRemoteBranches(input: { token: string; owner: string; repo: string; accountIdentity: string; signal?: AbortSignal }): Promise<RemoteBranchListing> {
  const key = cacheKey(input.accountIdentity, input.owner, input.repo);
  const cached = readCache(key);
  const octokit = createTrackedGitHubClient(input.token, { accountIdentity: input.accountIdentity, owner: input.owner, repo: input.repo, branch: "" });
  const pages: CachedPage[] = [];
  let rate: RateLimitState | null = null;
  let unchanged = true;
  for (let page = 1; page <= MAX_BRANCH_PAGES; page += 1) {
    const known = cached?.pages[page - 1];
    try {
      const response = await octokit.request("GET /repos/{owner}/{repo}/branches", {
        owner: input.owner,
        repo: input.repo,
        per_page: 100,
        page,
        headers: known?.etag ? { "if-none-match": known.etag } : { "if-modified-since": NEVER },
        request: { signal: input.signal },
      });
      const headers = response.headers as Record<string, unknown>;
      rate = rateOf(headers) ?? rate;
      unchanged = false;
      pages.push({ etag: header(headers, "etag"), branches: (response.data as Array<{ name: string; commit: { sha: string } }>).map((branch) => [branch.name, branch.commit.sha]), next: /rel="next"/.test(header(headers, "link") ?? "") });
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      const headers = (error as { response?: { headers?: Record<string, unknown> } }).response?.headers;
      if (status === 304 && known) {
        rate = rateOf(headers) ?? rate;
        pages.push(known);
      } else throw classifyRepositoryError(error, "list");
    }
    if (!pages[pages.length - 1].next) break;
  }
  writeCache(key, { pages, at: Date.now() });
  return { heads: new Map(pages.flatMap((page) => page.branches)), complete: !pages[pages.length - 1].next, unchanged, rate };
}

/** A branch GitHub was just told about (published, pushed): the list on this device says so until GitHub is asked again. */
export function rememberRemoteHead(accountIdentity: string, owner: string, repo: string, branch: string, sha: string): void {
  const key = cacheKey(accountIdentity, owner, repo);
  const cached = readCache(key);
  if (!cached?.pages.length) return;
  // The page that changes loses its ETag: GitHub is asked for it in full next time, and its answer replaces this.
  const pages = cached.pages.map((page) => page.branches.some(([name]) => name === branch)
    ? { ...page, etag: undefined, branches: page.branches.map(([name, head]) => [name, name === branch ? sha : head] as [string, string]) }
    : page);
  if (!pages.some((page) => page.branches.some(([name]) => name === branch))) pages[0] = { ...pages[0], etag: undefined, branches: [...pages[0].branches, [branch, sha]] };
  writeCache(key, { ...cached, pages });
}
