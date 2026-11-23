import { useSyncExternalStore } from "react";

/**
 * «Keep the messages of this run»: whether the autopilot of a book that runs in this browser records what it sends to the AI and what comes back (`autopilot/calls/wire.ts`). It
 * belongs to this device and to the book, not to the account: it is not synced with the settings, and what one device chooses says nothing of another. It is on unless the
 * author turned it off, so only the books it is off for are kept, in this browser's localStorage. A browser that refuses localStorage still honours the choice until the page closes.
 */

const STORAGE_KEY = "narrarium.aiCalls.recording.v1";

const listeners = new Set<() => void>();
let off: Set<string> | null = null;
let listening = false;

function stored(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  // Another tab of this browser changed the choice.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    off = null;
    notify();
  });
}

function booksOff(): Set<string> {
  off ??= typeof window === "undefined" ? new Set() : stored();
  return off;
}

/** Whether the messages of a book's runs in this browser are kept. On unless the author turned it off for this book on this device. */
export function isRecording(bookId: string): boolean {
  return !booksOff().has(bookId);
}

/** Turns the recording of a book on or off for this device. It applies from the next run; what was kept stays until the author deletes it. */
export function setRecording(bookId: string, on: boolean): void {
  const next = new Set(booksOff());
  if (on) next.delete(bookId);
  else next.add(bookId);
  off = next;
  try {
    if (next.size) window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The choice holds for this page only.
  }
  notify();
}

/** Calls `listener` when the choice of any book changes (here or in another tab). Returns what stops it. */
export function subscribeRecording(listener: () => void): () => void {
  listen();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The recording of a book as a component reads it: drawn again when the author changes it. */
export function useRecording(bookId: string): boolean {
  return useSyncExternalStore(subscribeRecording, () => isRecording(bookId), () => true);
}

/** Forgets what was read and listens to nothing (a test starts from the storage as it is). */
export function resetRecordingForTests(): void {
  off = null;
  listeners.clear();
}
