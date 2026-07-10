/**
 * Shared bookkeeping for Radix floating layers (dropdown menus, selects) that
 * render in a portal on top of a Dialog/modal.
 *
 * Problem: clicking outside an open dropdown to dismiss it fires the same
 * pointer event that Radix Dialog interprets as an "interact outside", which
 * would close the underlying modal too. Relying on the dropdown's live
 * `data-state="open"` attribute is racy because Radix may have already flipped
 * it to "closed" by the time the Dialog handler runs.
 *
 * Solution: track how many floating layers are currently open. The Dialog
 * outside-interaction guard can then ignore any event that fires while a layer
 * is open, which covers the click that dismisses the dropdown (Radix still has
 * it mounted at pointer-down time, before React unmounts it).
 */

import { useEffect } from "react";

let openFloatingLayerCount = 0;

/** Called when a floating layer (dropdown/select content) mounts/opens. */
export function registerFloatingLayerOpen(): void {
  openFloatingLayerCount += 1;
}

/** Called when a floating layer unmounts/closes. */
export function registerFloatingLayerClose(): void {
  openFloatingLayerCount = Math.max(0, openFloatingLayerCount - 1);
}

/** True while at least one floating layer is currently open. */
export function hasOpenFloatingLayer(): boolean {
  return openFloatingLayerCount > 0;
}

/**
 * Mount inside a portalled floating layer (dropdown/select content) so its open
 * lifetime is tracked. Registers open on mount and close on unmount.
 */
export function FloatingLayerMarker(): null {
  useEffect(() => {
    registerFloatingLayerOpen();
    return () => registerFloatingLayerClose();
  }, []);
  return null;
}

