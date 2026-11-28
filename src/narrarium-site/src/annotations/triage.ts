import type { NoteItem } from "@/annotations/notesView";
import { sortNotes } from "@/annotations/notesView";
import { annotationStatus } from "@/annotations/model";

/** What the author can do with the note in front of them. «skip» only moves on: the note stays as it is. */
export type TriageAction = "handled" | "later" | "dismissed" | "fix" | "paragraph" | "skip" | "reason";

/** The keys of the triage, one letter each (they work only when nothing is being typed and no window is open). */
export const TRIAGE_KEYS: Record<string, TriageAction> = { h: "handled", l: "later", d: "dismissed", f: "fix", p: "paragraph", s: "skip", r: "reason" };

/** The action of a key press, or null when the press is not for the triage (a modifier is down, or it is another key). */
export function triageActionOfKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): TriageAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  return TRIAGE_KEYS[event.key.toLowerCase()] ?? null;
}

/** The notes still to look at, in the order of the book: the open ones that were not passed over. What was put off (later) is not in the way. */
export function triageQueue(items: readonly NoteItem[], passed: ReadonlySet<string>, chapter = ""): NoteItem[] {
  return sortNotes(items.filter((item) => annotationStatus(item.annotation.status) === "open" && !passed.has(item.annotation.id) && (!chapter || item.annotation.chapter === chapter)));
}

const storageKey = (bookId: string) => `narrarium.annotations.triage.${bookId}`;

/** The notes passed over in earlier sittings of this book on this device, so that the triage resumes where it stopped (what was decided is in the notes' own status). */
export function loadPassed(storage: Pick<Storage, "getItem"> | undefined, bookId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(storageKey(bookId)) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, 5000) : []);
  } catch {
    return new Set();
  }
}

export function savePassed(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, bookId: string, passed: ReadonlySet<string>): void {
  try {
    if (passed.size) storage?.setItem(storageKey(bookId), JSON.stringify([...passed]));
    else storage?.removeItem(storageKey(bookId));
  } catch {
    // A device that cannot keep it just starts over the next time.
  }
}

export const SWIPE_DISTANCE = 96;

/** A swipe on a touch screen: to the right closes the note as handled, to the left puts it off. Mostly vertical or short movements are a scroll, not a decision. */
export function swipeAction(dx: number, dy: number): "handled" | "later" | null {
  if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx > 0 ? "handled" : "later";
}

/** What asking the AI to fix several notes costs, roughly: one call each, with the passage, the note and the blocks around it. */
export interface BulkFixEstimate { calls: number; inputTokens: number; outputTokens: number }

const BLOCK_CHARS = 1200;
const SYSTEM_TOKENS = 450;

export function estimateBulkFix(notes: ReadonlyArray<{ quote: string; comment: string }>): BulkFixEstimate {
  let inputTokens = 0;
  for (const note of notes) inputTokens += SYSTEM_TOKENS + Math.ceil((note.quote.length + note.comment.length + BLOCK_CHARS) / 4);
  return { calls: notes.length, inputTokens, outputTokens: notes.length * Math.ceil(BLOCK_CHARS / 4) };
}
