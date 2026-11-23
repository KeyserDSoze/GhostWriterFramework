import { parseAppRoute } from "@/assistant/context";

/** The live page of a book's autopilot: what it is doing, its history, its plan. */
export function autopilotLiveHref(bookId: string): string {
  return `/app/books/${encodeURIComponent(bookId)}/autopilot`;
}

/** The configuration of a book's autopilot: the brief, the review, publishing, the permanent rules, the profiles it uses. */
export function autopilotSettingsHref(bookId: string): string {
  return `${autopilotLiveHref(bookId)}/settings`;
}

/** The Scaletta of the book: where its chapters are added, edited and given their brief. */
export function scalettaHref(bookId: string): string {
  return `/app/books/${encodeURIComponent(bookId)}/outline`;
}

/**
 * Whether the path is a page of the autopilot (the live page and the configuration of a book, or the page of every book): the live panel
 * keeps out of their way.
 */
export function isAutopilotPage(pathname: string): boolean {
  const route = parseAppRoute(pathname);
  return route.kind === "book-autopilot" || route.kind === "book-autopilot-settings" || (route.kind === "app-page" && route.page === "autopilot");
}

/** Whether the page shows the run live itself (the live page of a book, the page of every book): the configuration does not. */
export function isAutopilotLivePage(pathname: string): boolean {
  const route = parseAppRoute(pathname);
  return route.kind === "book-autopilot" || (route.kind === "app-page" && route.page === "autopilot");
}
