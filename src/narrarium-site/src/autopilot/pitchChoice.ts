import type { AutopilotStateSummary } from "narrarium-engine";

/**
 * The design waits for the author to choose the pitch the book is designed from: her choice is made in the Studio. Apart from `stopReason.ts`, which the shell of the app loads, so
 * that what only the pages that show the wait need does not weigh on every route.
 */
export function isPitchChoiceStop(summary: Pick<AutopilotStateSummary, "status" | "design"> | null | undefined): boolean {
  return summary?.status === "waiting-author" && summary.design?.choosePitch === true;
}

/** Where the author chooses: the Studio of the Synopsis. */
export function studioHref(bookId: string): string {
  return `/app/books/${encodeURIComponent(bookId)}/outline?tab=studio`;
}
