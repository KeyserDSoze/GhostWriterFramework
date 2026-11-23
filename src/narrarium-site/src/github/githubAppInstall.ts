import { GITHUB_APP_SLUG } from "@/config/publicClients";

/**
 * Where Narrarium's GitHub App is installed, read with the user's own token: a GitHub App reaches only the repositories it is installed on (all of an
 * account's, or the ones the owner chose), so the page says where it works, and which books it cannot reach yet.
 *
 * Nothing here needs more than the user token of the app: `GET /user/installations` and `GET /user/installations/{id}/repositories`.
 */
export interface AppInstallation {
  id: number;
  /** The login of the user or organization the app is installed on. */
  account: string;
  accountType: "User" | "Organization";
  selection: "all" | "selected";
  /** `owner/repo` of every repository the app may use (only when `selection` is `selected`). */
  repositories: string[];
  suspended: boolean;
  /** Where the owner changes the repositories on GitHub. */
  settingsUrl: string;
}

export type InstallErrorReason = "reconnect" | "sso" | "rate-limit" | "network" | "unknown";

export class InstallationsError extends Error {
  constructor(readonly reason: InstallErrorReason, readonly status?: number) {
    super(`GitHub installations: ${reason}`);
    this.name = "InstallationsError";
  }
}

/** Where a person who has not installed the app yet does it. */
export function installAppUrl(slug: string = GITHUB_APP_SLUG): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

const API = "https://api.github.com";
const MAX_PAGES = 20;

async function getJson(path: string, token: string, signal?: AbortSignal): Promise<{ body: unknown; link: string | null }> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, cache: "no-store", signal });
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") throw error;
    throw new InstallationsError("network");
  }
  if (!response.ok) {
    const sso = response.headers.get("x-github-sso") !== null;
    const message = await response.clone().json().then((body: { message?: unknown }) => String(body?.message ?? ""), () => "").catch(() => "");
    if (response.status === 401) throw new InstallationsError("reconnect", 401);
    if (response.status === 429 || (response.status === 403 && /rate limit|abuse|secondary/i.test(message))) throw new InstallationsError("rate-limit", response.status);
    if (response.status === 403 && (sso || /saml|single sign/i.test(message))) throw new InstallationsError("sso", 403);
    throw new InstallationsError("unknown", response.status);
  }
  return { body: await response.json().catch(() => null), link: response.headers.get("link") };
}

const hasNext = (link: string | null): boolean => Boolean(link && /rel="next"/.test(link));

async function pages<T>(path: string, key: string, token: string, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { body, link } = await getJson(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, token, signal);
    const list = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
    if (!Array.isArray(list)) break;
    items.push(...(list as T[]));
    if (!hasNext(link)) break;
  }
  return items;
}

interface RawInstallation { id?: unknown; app_slug?: unknown; account?: { login?: unknown; type?: unknown } | null; repository_selection?: unknown; suspended_at?: unknown; html_url?: unknown }

/** The installations of the app the token can see, with the repositories of those installed on selected ones. Throws `InstallationsError`. */
export async function loadAppInstallations(token: string, options: { slug?: string; signal?: AbortSignal } = {}): Promise<AppInstallation[]> {
  const slug = options.slug ?? GITHUB_APP_SLUG;
  const raw = await pages<RawInstallation>("/user/installations", "installations", token, options.signal);
  const result: AppInstallation[] = [];
  for (const entry of raw) {
    if (typeof entry.id !== "number" || typeof entry.account?.login !== "string") continue;
    if (slug && typeof entry.app_slug === "string" && entry.app_slug !== slug) continue;
    const selection = entry.repository_selection === "selected" ? "selected" : "all";
    const account = entry.account.login;
    let repositories: string[] = [];
    if (selection === "selected") {
      const found = await pages<{ full_name?: unknown }>(`/user/installations/${entry.id}/repositories`, "repositories", token, options.signal);
      repositories = found.map((repository) => repository.full_name).filter((name): name is string => typeof name === "string").sort((left, right) => left.localeCompare(right));
    }
    const type = entry.account.type === "Organization" ? "Organization" : "User";
    result.push({
      id: entry.id,
      account,
      accountType: type,
      selection,
      repositories,
      suspended: typeof entry.suspended_at === "string" && entry.suspended_at.length > 0,
      settingsUrl: typeof entry.html_url === "string" && entry.html_url.startsWith("https://github.com/") ? entry.html_url : type === "Organization" ? `https://github.com/organizations/${encodeURIComponent(account)}/settings/installations/${entry.id}` : `https://github.com/settings/installations/${entry.id}`,
    });
  }
  return result.sort((left, right) => left.account.localeCompare(right.account));
}

/**
 * Whether the app reaches a repository: `all` (installed on every repository of its owner), `selected` (it is one of the chosen ones), `outside-selection`
 * (the owner installed the app on other repositories only), `not-installed` (no installation on that account at all) or `suspended`.
 */
export type RepositoryReach = "all" | "selected" | "outside-selection" | "not-installed" | "suspended";

export function repositoryReach(installations: readonly AppInstallation[], owner: string, repo: string): RepositoryReach {
  const installation = installations.find((entry) => entry.account.toLowerCase() === owner.toLowerCase());
  if (!installation) return "not-installed";
  if (installation.suspended) return "suspended";
  if (installation.selection === "all") return "all";
  const full = `${owner}/${repo}`.toLowerCase();
  return installation.repositories.some((name) => name.toLowerCase() === full) ? "selected" : "outside-selection";
}
