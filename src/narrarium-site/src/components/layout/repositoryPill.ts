import type { TFunction } from "i18next";
import type { GitHubRemoteAvailability } from "@/github/remoteAvailability";
import { effectiveRemoteStatus, type LocalRepoStatus, type LocalRepositoryMeta } from "@/repository/localRepository";
import { LOCAL_BOOK_TOKEN } from "@/types/settings";

/**
 * What the pill of the repository in the top bar says. `key` names the book, branch and account it was read for (a pill read for another one is never
 * shown), `copy` says that a working copy was read: only then does the pill speak of the copy, and of why it does not sync.
 */
export interface RepositoryPill {
  key: string;
  label: string;
  tone: "clean" | "dirty" | "ahead" | "behind" | "offline" | "none";
  copy: boolean;
}

/** The pill of a working copy that was read: its changes first, then how it stands with GitHub. */
export function pillOfCopy(meta: LocalRepositoryMeta, status: LocalRepoStatus, bookOnDevice: boolean, t: TFunction): Pick<RepositoryPill, "label" | "tone"> {
  // The local commits of a book kept on this device are its saved history: there is nowhere to push them, so they are not "ahead" of anything.
  if (bookOnDevice && status.dirty === 0) return { label: t("localFirst.pillLocalOnly"), tone: "clean" };
  if (status.dirty > 0) return { label: t("repoStatus.dirty", { count: status.dirty }), tone: "dirty" };
  if (status.ahead > 0) return { label: t("repoStatus.ahead", { count: status.ahead }), tone: "ahead" };
  if (meta.cloneComplete !== true) return { label: t("repoStatus.incomplete"), tone: "behind" };
  const remote = effectiveRemoteStatus(meta);
  if (remote === "changed") return { label: t("repoStatus.behind"), tone: "behind" };
  if (remote === "checking") return { label: t("repoStatus.checking"), tone: "offline" };
  if (remote === "unverified" || remote === "unavailable") return { label: t(meta.lastKnownChanged ? "repoStatus.staleChanged" : "repoStatus.unverified"), tone: "offline" };
  return { label: t("repoStatus.clean"), tone: "clean" };
}

/** The pill shown for the book on the screen: until its copy is read it is being checked, never «no copy» before that is known. */
export function shownPill(pill: RepositoryPill, key: string, t: TFunction): RepositoryPill {
  return pill.key === key && pill.tone !== "none" ? pill : { key, label: t("repoStatus.checkingLocal"), tone: "offline", copy: false };
}

/** The words of the pill: a copy that cannot sync because of its GitHub credential says why after what it holds (none, or one GitHub refused). */
export function pillText(pill: RepositoryPill, input: { bookOnDevice: boolean; remote: GitHubRemoteAvailability; token: string }, t: TFunction): string {
  if (!pill.copy || input.bookOnDevice || input.remote !== "no-credential") return pill.label;
  const refused = Boolean(input.token) && input.token !== LOCAL_BOOK_TOKEN;
  return t(refused ? "repoStatus.githubSignInAgain" : "repoStatus.githubNotConnected", { status: pill.label });
}
