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
  /** Whether the app reaches the book's repository, whatever token the book uses now. `null` until the installations are known (or without an app connection). */
  appReach: RepositoryReach | null;
  /** The book's autopilot runs on the personal server, which cannot renew the app's 8-hour token. */
  runsOnServer: boolean;
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
      appReach: installations ? repositoryReach(installations, book.owner, book.repo) : null,
      runsOnServer: book.autopilotHost === "server",
      reach: source === "app" && installations ? repositoryReach(installations, book.owner, book.repo) : null,
      ownAccount: Boolean(login) && book.owner.toLowerCase() === login!.toLowerCase(),
    };
  });
}

/** True when the effective credential of the book is the app's access token (what a personal server cannot renew). */
export function bookUsesAppToken(book: BookEntry, settings: AppSettings): boolean {
  return resolveGitHubCredential(book, settings)?.source === "app";
}

const REACHED: readonly RepositoryReach[] = ["all", "selected"];

/**
 * Whether to offer a book «Use the GitHub connection»: the app reaches its repository (the installation covers it), the book uses a token of its own, a
 * named one or the default one, and its autopilot does not run on the personal server (which cannot renew the app's token). It is only an offer: nothing
 * is switched until the owner asks, and not before the connection has been seen reading the repository.
 */
export function canOfferConnection(line: BookCredentialLine): boolean {
  return line.appReach !== null && REACHED.includes(line.appReach) && (line.source === "book-pat" || line.source === "named-pat" || line.source === "default-pat") && !line.runsOnServer;
}

/** The book as it is once it has a token of its own: that token, labelled, and neither a named token nor the GitHub connection (a token of its own wins over both). */
export function bookWithOwnToken(book: BookEntry, token: string, label: string): BookEntry {
  const { useGitHubConnection: _useGitHubConnection, ...rest } = book;
  return { ...rest, tokenIndex: null, bookToken: token.trim(), bookTokenLabel: label };
}

/** The book as it is once it uses the GitHub connection: no token of its own, no named token, and not the default token. The named token stays in the list. */
export function bookUsingConnection(book: BookEntry): BookEntry {
  const { bookToken: _bookToken, bookTokenLabel: _bookTokenLabel, ...rest } = book;
  return { ...rest, tokenIndex: null, useGitHubConnection: true };
}

/**
 * Whether to suggest removing the default token: there is one, at least one book already uses the app, and no book still falls back to the default token.
 * Every book that uses the app must be one the app reaches, or the connection is not yet proven to serve them all.
 */
export function defaultTokenRemovable(lines: readonly BookCredentialLine[], settings: Pick<AppSettings, "defaultGitHubToken">): boolean {
  if (!settings.defaultGitHubToken.trim()) return false;
  const onApp = lines.filter((line) => line.source === "app");
  return onApp.length > 0 && onApp.every((line) => line.appReach !== null && REACHED.includes(line.appReach)) && !lines.some((line) => line.source === "default-pat");
}
