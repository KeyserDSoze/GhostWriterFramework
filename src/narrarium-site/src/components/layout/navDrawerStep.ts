import type { Location } from "react-router-dom";

/** The mark of the step the open menu of a phone adds to the history, so that the back gesture closes the menu instead of leaving the page. */
export const NAV_DRAWER_STEP = "narrariumNavDrawer";

/** Whether the state of a history entry is the step of the open menu. */
export function isNavDrawerStep(state: unknown): boolean {
  return Boolean(state && typeof state === "object" && (state as Record<string, unknown>)[NAV_DRAWER_STEP] === true);
}

/** Whether going from `current` to `next` only opens or closes the menu: the page stays the same, and so do its unsaved changes. */
export function isNavDrawerMove(current: Location, next: Location): boolean {
  return current.pathname === next.pathname && current.search === next.search && (isNavDrawerStep(current.state) || isNavDrawerStep(next.state));
}
