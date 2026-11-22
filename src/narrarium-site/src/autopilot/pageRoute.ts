import { parseAppRoute } from "@/assistant/context";

/**
 * Whether the path is a page of the autopilot (the one of a book, or the one of every book): the pages that show what the live panel would
 * show, so that the panel keeps out of their way.
 */
export function isAutopilotPage(pathname: string): boolean {
  const route = parseAppRoute(pathname);
  return route.kind === "book-autopilot" || (route.kind === "app-page" && route.page === "autopilot");
}
