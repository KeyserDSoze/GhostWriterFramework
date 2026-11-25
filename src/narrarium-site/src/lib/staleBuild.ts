import { useAppUpdateStore } from "@/store/appUpdateStore";

/**
 * A part of the app that could not be loaded because the page runs an older version than the site serves: after a deployment the files of the
 * old version are gone (their names have the hash of their content), and a page opened before it asks for them when the author opens something
 * new. Chromium, Firefox and Safari say it each in their words; Vite says it of a stylesheet it preloads.
 */
const STALE_CHUNK = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === "string" ? error : "";
  return STALE_CHUNK.test(message);
}

/**
 * Says that this page runs an older version than the site: the update prompt offers to reload when the author chooses (never by itself, and never
 * silently over an autopilot that runs in this tab). Offline, a part that cannot be loaded is no sign of a new version: nothing is said.
 */
export function noteStaleChunk(error: unknown): boolean {
  if (!isStaleChunkError(error)) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  useAppUpdateStore.getState().setStale();
  return true;
}
