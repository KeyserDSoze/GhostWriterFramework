import type { GitHubTokenKind } from "@/github/bookRepository";
import type { AppInstallation } from "@/github/githubAppInstall";

/**
 * Making a repository public or private, as pure decisions: whether the credential can do it, what typing the name has to match, what the repository holds
 * that Narrarium keeps there, and what a refusal of GitHub means. Nothing here reads or writes GitHub.
 */

/** Said to the rest of the page after a change, so that what reads the published side (Reader access, the update card) reads it again. */
export const REPOSITORY_VISIBILITY_EVENT = "narrarium:repository-visibility";

/** What the GitHub app was granted for «Administration» on the installation that covers the repository's owner. */
export type AppAdministration = "write" | "read" | "none" | "unknown";

export function appAdministration(installations: readonly AppInstallation[] | null, owner: string): AppAdministration {
  if (!installations) return "unknown";
  const installation = installations.find((entry) => entry.account.toLowerCase() === owner.toLowerCase() && !entry.suspended);
  if (!installation) return "unknown";
  if (!installation.permissions) return "unknown";
  const value = installation.permissions.administration;
  return value === "write" ? "write" : value === "read" ? "read" : "none";
}

export type VisibilityAvailability =
  | { state: "ok" }
  /** GitHub says the person is not an administrator of the repository. */
  | { state: "no-admin-right" }
  /** The app was installed without «Administration: write»: the action is explained, not tried. */
  | { state: "app-permission-missing" }
  /** The credential may or may not be allowed (GitHub does not say in advance): the action is tried, and a refusal is explained. */
  | { state: "unverified" };

export function visibilityAvailability(input: { tokenKind: GitHubTokenKind; canAdminister: boolean | null; appAdministration: AppAdministration }): VisibilityAvailability {
  if (input.canAdminister === false) return { state: "no-admin-right" };
  if (input.tokenKind === "app") {
    if (input.appAdministration === "write") return { state: "ok" };
    if (input.appAdministration === "read" || input.appAdministration === "none") return { state: "app-permission-missing" };
    return { state: "unverified" };
  }
  return input.tokenKind === "classic" && input.canAdminister === true ? { state: "ok" } : { state: "unverified" };
}

/** The name the person types to confirm making a repository public: the repository's name, as GitHub spells it (the owner is not asked for). */
export function confirmationMatches(typed: string, repo: string): boolean {
  return repo.length > 0 && typed.trim() === repo;
}

/** What Narrarium keeps in a book's repository besides the text of the book: made readable by anyone when the repository becomes public. */
export const KEPT_IN_REPOSITORY: ReadonlyArray<{ path: string; kind: "folder" | "file" }> = [
  { path: "secrets/", kind: "folder" },
  { path: "director.md", kind: "file" },
  { path: "conversations/", kind: "folder" },
  { path: "drafts/", kind: "folder" },
];

export interface KeptItem { path: string; kind: "folder" | "file"; count: number }

/** Of what Narrarium keeps, what this repository has, from the paths of its working copy. */
export function summarizeKept(paths: readonly string[]): KeptItem[] {
  return KEPT_IN_REPOSITORY.map((item) => ({ ...item, count: item.kind === "file" ? paths.filter((path) => path === item.path).length : paths.filter((path) => path.startsWith(item.path)).length }))
    .filter((item) => item.count > 0);
}

export type VisibilityFailureKind = "permission" | "policy" | "sso" | "credential" | "rate-limit" | "network" | "other";

/** A refusal of GitHub: its kind, the status and, for a policy, GitHub's own words (a short plain text, never a request or a token). */
export interface VisibilityFailure { kind: VisibilityFailureKind; status?: number; message?: string }

export class VisibilityFlowError extends Error {
  constructor(readonly failure: VisibilityFailure) {
    super(`Repository visibility: ${failure.kind}${failure.status ? ` ${failure.status}` : ""}.`);
    this.name = "VisibilityFlowError";
  }
}

interface ErrorLike { status?: unknown; message?: unknown; response?: { headers?: Record<string, unknown>; data?: { message?: unknown } } }

const POLICY = /organization|enterprise|policy|not allowed|disabled|has been restricted|cannot be changed|can't be changed/i;
const RATE = /rate limit|abuse|secondary/i;

export function classifyVisibilityFailure(error: unknown): VisibilityFailure {
  const value = (error && typeof error === "object" ? error : {}) as ErrorLike;
  const status = typeof value.status === "number" ? value.status : undefined;
  const raw = typeof value.response?.data?.message === "string" ? value.response.data.message : typeof value.message === "string" ? value.message : "";
  const message = raw.replace(/\s+/g, " ").replace(/https?:\/\/\S+/g, "").trim().slice(0, 240);
  const header = (name: string) => { const found = value.response?.headers?.[name]; return typeof found === "string" ? found : undefined; };
  if (status === undefined) return { kind: "network" };
  if (status === 401) return { kind: "credential", status };
  if (status === 429 || (status === 403 && (header("x-ratelimit-remaining") === "0" || RATE.test(raw)))) return { kind: "rate-limit", status };
  if (status === 403 && header("x-github-sso")) return { kind: "sso", status };
  if (status === 403 || status === 404) return POLICY.test(raw) && status === 403 ? { kind: "policy", status, message } : { kind: "permission", status };
  if (status === 422) return { kind: "policy", status, ...(message ? { message } : {}) };
  return { kind: "other", status, ...(message ? { message } : {}) };
}
