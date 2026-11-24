import { vi } from "vitest";

/**
 * A small api.github.com for the repository picker: the user's repositories and an organization's, the installations of the app and what each lists, what a
 * repository holds (`book.md`, a branch), and whether a name is taken. It replaces the global `fetch` (Octokit uses it too), so nothing reaches the network
 * and no token is read. Every request is kept in `calls`, with the path and the token it carried.
 */

export interface FakeApiRepository {
  owner: string;
  name: string;
  private?: boolean;
  push?: boolean | null;
  pushedAt?: string;
  description?: string;
  archived?: boolean;
  branch?: string;
  /** What it holds: a Narrarium book (`book.md`), nothing, or other files. Default: a book. */
  holds?: "book" | "empty" | "other";
}

export interface FakeApiOptions {
  repositories?: FakeApiRepository[];
  /** Repositories per page (GitHub's `per_page` is honoured up to this). */
  pageSize?: number;
  /** The installations of the app: each lists the repositories of its account. */
  installations?: Array<{ id: number; account: string; selection?: "all" | "selected"; suspended?: boolean }>;
  /** `owner/name`, lower case, of the names that are taken. */
  taken?: string[];
  /** Fail a path (a prefix) with a status and a message, for the given number of times (default: always). */
  failures?: Array<{ prefix: string; status: number; message?: string; headers?: Record<string, string>; times?: number }>;
  /** Hold the answer of a path (a prefix) until `release()`. */
  hold?: string;
}

let idCounter = 1000;
const idOf = new Map<string, number>();
const idFor = (full: string) => { if (!idOf.has(full)) idOf.set(full, ++idCounter); return idOf.get(full)!; };

export function installFakeGitHubApi(options: FakeApiOptions = {}) {
  const calls: Array<{ path: string; auth: string | null }> = [];
  const repositories = options.repositories ?? [];
  const failures = (options.failures ?? []).map((failure) => ({ ...failure, remaining: failure.times ?? Infinity }));
  let release: () => void = () => undefined;
  const gate = options.hold ? new Promise<void>((resolve) => { release = resolve; }) : null;

  const shape = (repository: FakeApiRepository) => ({
    id: idFor(`${repository.owner}/${repository.name}`),
    name: repository.name,
    full_name: `${repository.owner}/${repository.name}`,
    owner: { login: repository.owner },
    private: repository.private ?? true,
    permissions: repository.push === null ? undefined : { push: repository.push ?? true },
    pushed_at: repository.pushedAt ?? "2026-11-20T10:00:00Z",
    description: repository.description ?? null,
    default_branch: repository.branch ?? "main",
    archived: repository.archived ?? false,
  });

  const page = (items: unknown[], url: URL) => {
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 30), options.pageSize ?? 100);
    const number = Number(url.searchParams.get("page") ?? 1);
    const slice = items.slice((number - 1) * per, number * per);
    const more = number * per < items.length;
    return { slice, headers: more ? { link: `<${url.origin}${url.pathname}?page=${number + 1}>; rel="next"` } : {} };
  };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const find = (owner: string, name: string) => repositories.find((entry) => entry.owner.toLowerCase() === owner.toLowerCase() && entry.name.toLowerCase() === name.toLowerCase());

  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = decodeURIComponent(url.pathname);
    calls.push({ path: `${path}${url.search}`, auth: new Headers(init?.headers).get("authorization") });
    if (gate && options.hold && path.startsWith(options.hold)) await gate;
    const failure = failures.find((entry) => path.startsWith(entry.prefix) && entry.remaining > 0);
    if (failure) { failure.remaining -= 1; return json({ message: failure.message ?? "failed" }, failure.status, failure.headers); }

    if (path === "/user/repos") {
      const own = url.searchParams.get("affiliation") === "owner";
      const items = repositories.filter((entry) => !own || entry.owner === "ada").map(shape);
      const result = page(items, url);
      return json(result.slice, 200, result.headers);
    }
    const org = /^\/orgs\/([^/]+)\/repos$/.exec(path);
    if (org) { const result = page(repositories.filter((entry) => entry.owner === org[1]).map(shape), url); return json(result.slice, 200, result.headers); }
    if (path === "/user/installations") {
      return json({ total_count: options.installations?.length ?? 0, installations: (options.installations ?? []).map((entry) => ({ id: entry.id, account: { login: entry.account, type: "User" }, repository_selection: entry.selection ?? "all", suspended_at: entry.suspended ? "2026-01-01T00:00:00Z" : null, html_url: `https://github.com/settings/installations/${entry.id}` })) });
    }
    const installed = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
    if (installed) {
      const installation = options.installations?.find((entry) => entry.id === Number(installed[1]));
      const items = repositories.filter((entry) => entry.owner === installation?.account).map(shape);
      const result = page(items, url);
      return json({ total_count: items.length, repositories: result.slice }, 200, result.headers);
    }
    const contents = /^\/repos\/([^/]+)\/([^/]+)\/contents\/book\.md$/.exec(path);
    if (contents) { const found = find(contents[1], contents[2]); return found && (found.holds ?? "book") === "book" ? json({ name: "book.md" }) : json({ message: "Not Found" }, 404); }
    const ref = /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/.+$/.exec(path);
    if (ref) { const found = find(ref[1], ref[2]); return found && (found.holds ?? "book") !== "empty" ? json({ object: { sha: "a".repeat(40) } }) : json({ message: "Git Repository is empty." }, 409); }
    const named = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (named) return options.taken?.includes(`${named[1]}/${named[2]}`.toLowerCase()) || find(named[1], named[2]) ? json({ id: 1 }) : json({ message: "Not Found" }, 404);
    return json({ message: `unexpected ${path}` }, 500);
  }));

  return {
    calls,
    paths: () => calls.map((call) => call.path.split("?")[0]),
    count: (prefix: string) => calls.filter((call) => call.path.startsWith(prefix)).length,
    release: () => release(),
  };
}
