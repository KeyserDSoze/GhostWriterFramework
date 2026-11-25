/** The Web Lock the browser autopilot holds for the whole of a run of a book (`@/autopilot/runtime`): while it is held, the book is not synced. */
export const AUTOPILOT_LOCK_PREFIX = "narrarium:autopilot:";
/** Held (shared) by a tab whose page of the book has unsaved edits: the branch on the screen is not pulled under them. */
export const EDITING_LOCK_PREFIX = "narrarium:editing:";
/** The lock of a working copy while a change, a sync or a push holds it (`withRepositoryMutationLease`). */
export const REPOSITORY_LOCK_PREFIX = "narrarium-repository-";
