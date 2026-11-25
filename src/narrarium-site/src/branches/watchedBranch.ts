/** The branch of a book this tab shows, and the Sync of that book: what the branch sync tells the person about here (`@/branches/outcomeToasts`). */
export interface WatchedBranch {
  bookId: string;
  branch: string;
  onSyncNow: () => void;
}

let watched: WatchedBranch | null = null;
let listener: (() => void) | null = null;

export function watchBranch(next: WatchedBranch | null): void {
  const same = watched && next && watched.bookId === next.bookId && watched.branch === next.branch;
  watched = next;
  if (!same) listener?.();
}

export function watchedBranch(): WatchedBranch | null {
  return watched;
}

/** One listener: the branch sync of this tab, once it is loaded. */
export function onWatchedBranch(next: (() => void) | null): void {
  listener = next;
}
