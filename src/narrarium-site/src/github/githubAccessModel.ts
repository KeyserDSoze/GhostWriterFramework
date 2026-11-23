import { bookStorageMode, resolveGitHubCredential, type AppSettings, type BookEntry } from "@/types/settings";
import type { GitHubCredentialSource } from "@/github/githubCredentialRuntime";
import { repositoryReach, type AppInstallation, type RepositoryReach } from "@/github/githubAppInstall";

/** Whether «Connect with GitHub» can be offered: the broker says GitHub sign-in is on AND the app's public client id is part of this build. `null` while the broker is still being asked. */
export function githubSignInAvailable(brokerSaysYes: boolean | null, clientId: string): boolean | null {
  if (!clientId) return false;
  return brokerSaysYes;
}

export interface BookCredentialLine {
  bookId: string;
  name: string;
  owner: string;
  repo: string;
  /** What the book would use: its own token, a named one, the default, or the GitHub connection. `null`: nothing. */
  source: GitHubCredentialSource | null;
  /** The book is run by the personal server and would use the app's token (which the server cannot renew). */
  serverWithAppToken: boolean;
  /** For a book that uses the app token: whether the app reaches its repository. `null` until the installations are known. */
  reach: RepositoryReach | null;
  /** The repository belongs to the account of the connection (not to an organization): who has to install the app. */
  ownAccount: boolean;
}

/** For every book that is on GitHub: which token it uses (the order is explicit tokens first, then the preference) and whether the app reaches it. */
export function bookCredentialLines(books: readonly BookEntry[], settings: AppSettings, installations: readonly AppInstallation[] | null, login?: string): BookCredentialLine[] {
  return books.filter((book) => bookStorageMode(book) === "github" && book.owner && book.repo).map((book) => {
    const source = resolveGitHubCredential(book, settings)?.source ?? null;
    return {
      bookId: book.id,
      name: book.name || book.repo,
      owner: book.owner,
      repo: book.repo,
      source,
      serverWithAppToken: book.autopilotHost === "server" && source === "app",
      reach: source === "app" && installations ? repositoryReach(installations, book.owner, book.repo) : null,
      ownAccount: Boolean(login) && book.owner.toLowerCase() === login!.toLowerCase(),
    };
  });
}

/** True when the effective credential of the book is the app's access token (what a personal server cannot renew). */
export function bookUsesAppToken(book: BookEntry, settings: AppSettings): boolean {
  return resolveGitHubCredential(book, settings)?.source === "app";
}
