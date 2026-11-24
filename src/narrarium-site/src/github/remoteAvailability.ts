import { useSyncExternalStore } from "react";
import { bookStorageMode, LOCAL_BOOK_TOKEN, type BookEntry } from "@/types/settings";

/**
 * Whether a feature that needs GitHub itself, not the working copy (pull requests, the branches and the commits of the remote, fetch, pull, push), can run
 * for a book now, and otherwise why: the book is kept on this device (`local`), it has no GitHub credential (none, or one GitHub refused), or the browser is
 * offline. Everything else reads and writes the working copy and needs none of this: this is the one decision about GitHub, never the token itself.
 */
export type GitHubRemoteAvailability = "ready" | "local" | "no-credential" | "offline";

// The tokens GitHub refused in this session (revoked or expired): until the credential changes, a book that uses one works as a book without a credential.
const rejected = new Set<string>();
const listeners = new Set<() => void>();
let rejectedVersion = 0;

function changed(): void {
  rejectedVersion += 1;
  for (const listener of listeners) listener();
}

/** GitHub answered 401 to this token. */
export function markGitHubCredentialRejected(token: string): void {
  if (!token || rejected.has(token)) return;
  rejected.add(token);
  changed();
}

/** GitHub accepted this token: it is a credential again. */
export function clearGitHubCredentialRejection(token: string): void {
  if (rejected.delete(token)) changed();
}

/** A token that may be sent to GitHub: one is there, it is not the local token, and GitHub has not refused it in this session. */
export function isUsableGitHubToken(token: string | undefined): boolean {
  return Boolean(token) && token !== LOCAL_BOOK_TOKEN && !rejected.has(token!);
}

export function githubRemoteAvailability(book: BookEntry | undefined, token: string, online = typeof navigator === "undefined" || navigator.onLine !== false): GitHubRemoteAvailability {
  if (!book || bookStorageMode(book) === "local-only" || !book.owner || !book.repo) return "local";
  if (!isUsableGitHubToken(token)) return "no-credential";
  return online ? "ready" : "offline";
}

function subscribeToConnectivity(notify: () => void): () => void {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

function subscribeToRejections(notify: () => void): () => void {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

/** `githubRemoteAvailability`, rendered again when the browser goes offline or comes back, and when GitHub refuses a token. */
export function useGitHubRemoteAvailability(book: BookEntry | undefined, token: string): GitHubRemoteAvailability {
  const online = useSyncExternalStore(subscribeToConnectivity, () => navigator.onLine !== false, () => true);
  useSyncExternalStore(subscribeToRejections, () => rejectedVersion, () => 0);
  return githubRemoteAvailability(book, token, online);
}
