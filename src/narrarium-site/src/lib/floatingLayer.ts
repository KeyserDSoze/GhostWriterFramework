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
 * Solution: track how many floating layers are currently open and the moment
 * the last one closed. The Dialog outside-interaction guard can then ignore any
 * event that happens while a layer is open OR within a short grace window after
 * one just closed.
 */

import { useEffect } from "react";

let openFloatingLayerCount = 0;
let lastFloatingLayerClosedAt = 0;

/** Grace period (ms) after a floating layer closes during which Dialog outside events are ignored. */
const FLOATING_LAYER_CLOSE_GRACE_MS = 350;

/** Called when a floating layer (dropdown/select content) mounts/opens. */
export function registerFloatingLayerOpen(): void {
  openFloatingLayerCount += 1;
}

/** Called when a floating layer unmounts/closes. */
export function registerFloatingLayerClose(): void {
  openFloatingLayerCount = Math.max(0, openFloatingLayerCount - 1);
  lastFloatingLayerClosedAt = Date.now();
}

/** True while at least one floating layer is currently open. */
export function hasOpenFloatingLayer(): boolean {
  return openFloatingLayerCount > 0;
}

/** True if a floating layer just closed within the grace window. */
export function floatingLayerJustClosed(): boolean {
  return Date.now() - lastFloatingLayerClosedAt < FLOATING_LAYER_CLOSE_GRACE_MS;
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

