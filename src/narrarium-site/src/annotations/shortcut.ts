/**
 * The shortcut that annotates the passage selected in the reader. It is not the Ctrl/Cmd+Alt+M of the word processors on a Mac, where ⌥⌘M minimizes
 * every window of the app (Apple, «Mac keyboard shortcuts») and opens the responsive design mode of Firefox: there it is ⌥⌘A, the «new comment» of
 * Word for Mac (Safari gives ⌥⌘A to «Show Page Resources» only when its Develop menu is turned on). Ctrl+Alt+M (Google Docs, Word) elsewhere: no
 * browser (Chrome, Edge, Firefox) and no default of Windows, GNOME or KDE takes it. Ctrl+Alt+A (KDE: the window that wants attention), Ctrl+Alt+N
 * (NVDA starts with it) and the Alt+Shift keys (ChromeOS opens its notifications and Files with them, Chrome focuses its dialogs with Alt+Shift+A)
 * were left out. It works only in the reader, never where the keys type (fields, text areas, editable text). The keys are read by their meaning first
 * and by their place second, so that Option or AltGr changing the character does not hide them.
 */

import { annotateShortcutLabel, isMacPlatform } from "./shortcutLabel";

export { annotateShortcutLabel, isMacPlatform };

export function isAnnotateShortcut(event: Pick<KeyboardEvent, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">, mac: boolean = isMacPlatform()): boolean {
  if (event.shiftKey || !event.altKey) return false;
  if (mac) return event.metaKey && !event.ctrlKey && (event.key.toLowerCase() === "a" || event.code === "KeyA");
  return event.ctrlKey && !event.metaKey && (event.key.toLowerCase() === "m" || event.code === "KeyM");
}

/** Where a key is typing, never a shortcut: a field, a text area, a list of choices or editable text. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select")) return true;
  const editable = target.closest("[contenteditable]");
  return Boolean(editable && editable.getAttribute("contenteditable") !== "false");
}
