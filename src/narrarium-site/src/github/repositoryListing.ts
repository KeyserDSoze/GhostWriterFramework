import { rateLimitResetAt, type ExistingState, type PickerRepository } from "@/github/repositoryPickerModel";

/**
 * The repositories a credential can connect, read a page at a time (never all of an account at once), and what a repository that was picked holds. It is
 * plain `fetch` against api.github.com with the credential's token: a classic or fine-grained token lists `GET /user/repos` (or one organization's), the
 * user token of the GitHub app lists `GET /user/installations/{id}/repositories` for each installation, because the app reaches only those.
 */

export type ListingFailureReason = "reconnect" | "rate-limit" | "sso" | "network" | "forbidden" | "unknown";

export class ListingError extends Error {
  constructor(readonly reason: ListingFailureReason, readonly status?: number, readonly resetAt?: string) {
    super(`GitHub repositories: ${reason}`);
    this.name = "ListingError";
  }
}

export const LISTING_PAGE_SIZE = 30;
const API = "https://api.github.com";

interface Got { status: number; body: unknown; link: string | null }

async function get(path: string, token: string, signal?: AbortSignal): Promise<Got> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, cache: "no-store", signal });
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") throw error;
    throw new ListingError("network");
  }
  if (response.ok) return { status: response.status, body: await response.json().catch(() => null), link: response.headers.get("link") };
  const message = await response.clone().json().then((body: { message?: unknown }) => String(body?.message ?? ""), () => "");
  if (response.status === 401) throw new ListingError("reconnect", 401);
  const limited = response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit|abuse|secondary/i.test(message)));
  if (limited) throw new ListingError("rate-limit", response.status, rateLimitResetAt(response.headers));
  if (response.status === 403 && (response.headers.get("x-github-sso") !== null || /saml|single sign/i.test(message))) throw new ListingError("sso", 403);
  if (response.status === 403) throw new ListingError("forbidden", 403);
  if (response.status === 404 || response.status === 409) return { status: response.status, body: null, link: null };
  throw new ListingError("unknown", response.status);
}

export interface ListingSource {
  path: string;
  /** The field of the answer that holds the repositories (installations answer `{ repositories: [...] }`); none when the answer is the array. */
  field?: "repositories";
}

export interface ListingCursor { source: number; page: number }

export interface ListingPage { items: PickerRepository[]; cursor: ListingCursor | null }

export interface InstallationRef { id: number; account: string; suspended?: boolean }

/**
 * Where to read the repositories from, for what the person chose to see (`scope`: `""` everything the credential reaches, or one owner's login).
 * A token: its user repositories (owner, collaborator, organization member), or only one account's, or one organization's. The app: each installation
 * that is not suspended, or the one that is on the owner chosen.
 */
export function listingSources(input: { app: boolean; login: string; scope: string; installations?: readonly InstallationRef[] }): ListingSource[] {
  const sort = "sort=pushed&direction=desc";
  if (input.app) {
    return (input.installations ?? [])
      .filter((installation) => !installation.suspended && (!input.scope || installation.account.toLowerCase() === input.scope.toLowerCase()))
      .map((installation) => ({ path: `/user/installations/${installation.id}/repositories`, field: "repositories" as const }));
  }
  if (!input.scope) return [{ path: `/user/repos?affiliation=owner,collaborator,organization_member&${sort}` }];
  if (input.scope.toLowerCase() === input.login.toLowerCase()) return [{ path: `/user/repos?affiliation=owner&${sort}` }];
  return [{ path: `/orgs/${encodeURIComponent(input.scope)}/repos?type=all&${sort}` }];
}

interface RawRepository {
  id?: unknown; name?: unknown; full_name?: unknown; owner?: { login?: unknown } | null; private?: unknown; permissions?: { push?: unknown } | null;
  pushed_at?: unknown; description?: unknown; default_branch?: unknown; archived?: unknown;
}

export function mapRepository(raw: RawRepository): PickerRepository | null {
  if (typeof raw.id !== "number" || typeof raw.name !== "string" || typeof raw.owner?.login !== "string") return null;
  const owner = raw.owner.login;
  return {
    id: raw.id,
    owner,
    name: raw.name,
    fullName: typeof raw.full_name === "string" ? raw.full_name : `${owner}/${raw.name}`,
    private: raw.private === true,
    canPush: typeof raw.permissions?.push === "boolean" ? raw.permissions.push : null,
    pushedAt: typeof raw.pushed_at === "string" ? raw.pushed_at : null,
    description: typeof raw.description === "string" ? raw.description : null,
    defaultBranch: typeof raw.default_branch === "string" && raw.default_branch ? raw.default_branch : "main",
    archived: raw.archived === true,
  };
}

const withQuery = (path: string, extra: string) => `${path}${path.includes("?") ? "&" : "?"}${extra}`;

/** One page of the list from the cursor on (the first page when there is none); `cursor` of the answer is `null` when nothing is left. */
export async function fetchListingPage(token: string, sources: readonly ListingSource[], cursor: ListingCursor | null, options: { signal?: AbortSignal; perPage?: number } = {}): Promise<ListingPage> {
  let at: ListingCursor | null = cursor ?? (sources.length ? { source: 0, page: 1 } : null);
  const items: PickerRepository[] = [];
  for (let guard = 0; at && guard < sources.length + 8; guard += 1) {
    const source = sources[at.source];
    const got = await get(withQuery(source.path, `per_page=${options.perPage ?? LISTING_PAGE_SIZE}&page=${at.page}`), token, options.signal);
    const list = source.field ? (got.body && typeof got.body === "object" ? (got.body as Record<string, unknown>)[source.field] : null) : got.body;
    if (Array.isArray(list)) for (const raw of list as RawRepository[]) { const mapped = mapRepository(raw); if (mapped) items.push(mapped); }
    const more = Boolean(got.link && /rel="next"/.test(got.link));
    at = more ? { source: at.source, page: at.page + 1 } : at.source + 1 < sources.length ? { source: at.source + 1, page: 1 } : null;
    if (items.length) break;
  }
  return { items, cursor: at };
}

/** What a repository holds: `book.md` at its root makes it a book; a branch with other files is something else; no branch at all is empty. */
export async function inspectRepository(token: string, target: { owner: string; repo: string; defaultBranch: string }, signal?: AbortSignal): Promise<ExistingState> {
  const base = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const book = await get(`${base}/contents/book.md`, token, signal);
  if (book.status === 200) return "book";
  const branch = await get(`${base}/git/ref/heads/${encodeURIComponent(target.defaultBranch)}`, token, signal);
  return branch.status === 200 ? "other" : "empty";
}

/** Whether nothing is at `owner/name` yet (GitHub answers 404 for a name that is free; a private repository the credential cannot see answers 404 too, and the creation then says it is taken). */
export async function repositoryNameIsFree(token: string, owner: string, name: string, signal?: AbortSignal): Promise<boolean> {
  const got = await get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token, signal);
  return got.status === 404;
}
