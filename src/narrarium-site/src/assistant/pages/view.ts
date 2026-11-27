import type { PageId, PageView } from "@/assistant/pages/types";

const MAX_VIEW_CHARS = 2_000;

/**
 * What a page shows the author right now that its files do not say (a filter, a selection), as the page publishes it on its root element: `data-copilot-page`
 * names the page and `data-copilot-view` holds a small JSON object of texts, numbers, switches and lists of texts. Anything else is left out, and so is a view
 * that is too long or cannot be read: the page's files still say the rest.
 */
export function readPageView(id: PageId, root: ParentNode | null = typeof document === "undefined" ? null : document): PageView | null {
  const element = root?.querySelector(`[data-copilot-page="${id}"]`);
  const raw = element?.getAttribute("data-copilot-view");
  if (!raw || raw.length > MAX_VIEW_CHARS) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const view: PageView = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) view[key] = entry;
      else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) view[key] = entry as string[];
    }
    return Object.keys(view).length ? view : null;
  } catch {
    return null;
  }
}

/** The view as the model reads it: one line, `key: value`. */
export function pageViewText(view: PageView | null): string {
  if (!view) return "";
  return Object.entries(view).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`).join("; ");
}
