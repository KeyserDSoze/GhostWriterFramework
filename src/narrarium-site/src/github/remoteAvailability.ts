import { useSyncExternalStore } from "react";
import { bookStorageMode, LOCAL_BOOK_TOKEN, type BookEntry } from "@/types/settings";

/**
 * Whether a feature that needs GitHub itself, not the working copy (pull requests, the branches and the commits of the remote, fetch, pull, push), can run
 * for a book now, and otherwise why: the book is kept on this device (`local`), it has no GitHub credential, or the browser is offline. Everything
 * else reads and writes the working copy and needs none of this.
 */
export type GitHubRemoteAvailability = "ready" | "local" | "no-credential" | "offline";

export function githubRemoteAvailability(book: BookEntry | undefined, token: string, online = typeof navigator === "undefined" || navigator.onLine !== false): GitHubRemoteAvailability {
  if (!book || bookStorageMode(book) === "local-only" || !book.owner || !book.repo) return "local";
  if (!token || token === LOCAL_BOOK_TOKEN) return "no-credential";
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

/** `githubRemoteAvailability`, rendered again when the browser goes offline or comes back. */
export function useGitHubRemoteAvailability(book: BookEntry | undefined, token: string): GitHubRemoteAvailability {
  const online = useSyncExternalStore(subscribeToConnectivity, () => navigator.onLine !== false, () => true);
  return githubRemoteAvailability(book, token, online);
}
