import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookConflictError, type AutopilotState, type BookFileChange, type OutlineChapterEntry, type OutlineEdit, type OutlineWarning } from "narrarium-engine";
import { applyToSnapshot, composeEdits, remapNumber, restoreChanges, snapshotOf, type OutlineFile, type OutlineSnapshot } from "@/outline/outlineModel";
import type { OutlineSource } from "@/outline/outlineSource";

/** What the author typed in an entry and has not saved: the version of the file it started from is `baseHash` (none for a new entry). */
export interface EntryDraft {
  title: string;
  body: string;
  /** `null`: the book's ghostwriter. */
  ghostwriter: string | null;
  baseHash: string | undefined;
}

export interface BookDraft {
  title: string;
  body: string;
  baseHash: string | undefined;
}

const same = (left: string, right: string) => left.replace(/\r\n?/g, "\n").trim() === right.replace(/\r\n?/g, "\n").trim();
const sentences = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" ");

export function draftOf(entry: OutlineChapterEntry): EntryDraft {
  return { title: entry.title, body: entry.body, ghostwriter: entry.ghostwriter ?? null, baseHash: entry.hash };
}

/** Whether a draft says something its entry does not (spaces around a text, and the kind of line ending, do not count: the engine drops them). */
export function draftChanged(draft: EntryDraft | undefined, entry: OutlineChapterEntry | undefined): boolean {
  if (!draft) return false;
  if (!entry) return Boolean(draft.title.trim() || draft.body.trim() || draft.ghostwriter);
  return !same(draft.title, entry.title) || !same(draft.body, entry.body) || (draft.ghostwriter ?? null) !== (entry.ghostwriter ?? null);
}

/** The last action, and how to take it back: the files as they were, each expecting the version the action left. */
interface UndoRecord {
  label: string;
  restore: BookFileChange[];
  /** Where each entry that the action moved was before it: drafts follow their entry back. */
  previousNumber: Map<number, number>;
}

export interface OutlineActionResult {
  ok: boolean;
  next?: OutlineSnapshot;
}

export interface OutlineEditorOptions {
  source: OutlineSource | null;
  /** The slugs of the book's ghostwriters, so that the engine says when an entry names one that does not exist. */
  ghostwriters: readonly string[];
  /** Words for the announcements and the undo, in the language of the page. */
  describe: (key: string, options?: Record<string, unknown>) => string;
  /** What the page adds to the announcement of the entries saved (what the autopilot will do with a written chapter's), or nothing. */
  afterSave?: (numbers: readonly number[]) => string;
}

/**
 * The state of the Outline page: the outline as the engine reads it, what the author typed and has not saved, the last action (to undo it) and
 * what the page says of it. Every save goes through the engine (`outlineChanges`, composed into one commit) and through the source's commit,
 * which never overwrites a file that changed since it was read: then the edits are kept and the page says that the outline changed elsewhere.
 */
export function useOutlineEditor({ source, ghostwriters, describe, afterSave }: OutlineEditorOptions) {
  const [snapshot, setSnapshotState] = useState<OutlineSnapshot | null>(null);
  const snapshotRef = useRef<OutlineSnapshot | null>(null);
  const setSnapshot = useCallback((next: OutlineSnapshot | null) => {
    snapshotRef.current = next;
    setSnapshotState(next);
  }, []);
  const [autopilot, setAutopilot] = useState<AutopilotState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [drafts, setDraftsState] = useState<Map<number, EntryDraft>>(() => new Map());
  const draftsRef = useRef(drafts);
  const setDrafts = useCallback((update: (current: Map<number, EntryDraft>) => Map<number, EntryDraft>) => {
    setDraftsState((current) => {
      const next = update(current);
      draftsRef.current = next;
      return next;
    });
  }, []);
  const [bookDraft, setBookDraftState] = useState<BookDraft | null>(null);
  const bookDraftRef = useRef<BookDraft | null>(null);
  const setBookDraft = useCallback((next: BookDraft | null) => {
    bookDraftRef.current = next;
    setBookDraftState(next);
  }, []);
  const [undo, setUndo] = useState<UndoRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useRef({ source, ghostwriters, describe, afterSave });
  latest.current = { source, ghostwriters, describe, afterSave };

  const entries = snapshot?.outline.chapters;
  const byNumber = useMemo(() => new Map((entries ?? []).map((entry) => [entry.number, entry])), [entries]);
  const byNumberRef = useRef(byNumber);
  byNumberRef.current = byNumber;

  const readAutopilot = useCallback(async (from: OutlineSource) => {
    setAutopilot(await from.readState().catch(() => null));
  }, []);

  /** Read the outline again and forget what was typed: the author asked for it (or nothing was typed). */
  const reload = useCallback(async () => {
    const from = latest.current.source;
    if (!from) return;
    setLoading(true);
    try {
      const next = await snapshotOf(await from.files());
      setSnapshot(next);
      setDrafts(() => new Map());
      setBookDraft(null);
      setChangedElsewhere(false);
      // What the last action left may not be there any more: it is not taken back over a version read again.
      setUndo(null);
      setLoadFailed(false);
      setFailure(null);
      void readAutopilot(from);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [readAutopilot, setBookDraft, setDrafts, setSnapshot]);

  useEffect(() => {
    setSnapshot(null);
    setUndo(null);
    if (source) void reload();
  }, [source, reload, setSnapshot]);

  /**
   * The outline as the book has it now (the autopilot, the Copilot or another tab may have changed it), without losing what was typed: the files
   * that changed are read again, and an entry the author is editing that changed underneath is said (`changedElsewhere`), never replaced.
   */
  const refresh = useCallback(async () => {
    const from = latest.current.source;
    const current = snapshotRef.current;
    if (!from || !current || busyRef.current) return;
    let files: OutlineFile[];
    try {
      files = await from.files();
    } catch {
      return;
    }
    if (snapshotRef.current !== current || busyRef.current) return;
    const changes: BookFileChange[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      seen.add(file.path);
      if (current.files.get(file.path)?.hash !== file.hash) changes.push({ path: file.path, content: file.content });
    }
    for (const path of current.files.keys()) if (!seen.has(path)) changes.push({ path, content: null });
    void readAutopilot(from);
    if (!changes.length) return;
    const next = await applyToSnapshot(current, changes);
    if (snapshotRef.current !== current) return;
    const conflicted = [...draftsRef.current.entries()].some(([number, draft]) => next.outline.chapters.find((entry) => entry.number === number)?.hash !== draft.baseHash)
      || Boolean(bookDraftRef.current && bookDraftRef.current.baseHash !== next.outline.book?.hash);
    setSnapshot(next);
    if (conflicted) setChangedElsewhere(true);
    // What the page knew is gone: the last action cannot be taken back over what changed since.
    setUndo(null);
  }, [readAutopilot, setSnapshot]);

  const announce = useCallback((text: string) => setAnnouncement(text), []);

  /**
   * Make `edits` as one commit and update the page with what the engine wrote. `label` names the action for the undo; `done` is what the page
   * says once it is saved. Drafts follow their entry when the action moves it.
   */
  const act = useCallback(async (edits: OutlineEdit[], words: { done: string; undo: string; message: string }, after?: (next: OutlineSnapshot) => void): Promise<OutlineActionResult> => {
    const from = latest.current.source;
    const before = snapshotRef.current;
    if (!from || !before || busyRef.current) return { ok: false };
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const composed = await composeEdits(before, edits, latest.current.ghostwriters);
      if (!composed.changes.length) return { ok: true, next: before };
      await from.commit(composed.changes, words.message);
      const restore = await restoreChanges(before, composed.changes);
      const previousNumber = new Map<number, number>();
      for (const entry of before.outline.chapters) {
        let number: number | null = entry.number;
        for (const edit of edits) number = number === null ? null : remapNumber(edit, number);
        if (number !== null) previousNumber.set(number, entry.number);
      }
      setDrafts((current) => {
        const next = new Map<number, EntryDraft>();
        for (const [number, draft] of current) {
          let moved: number | null = number;
          for (const edit of edits) moved = moved === null ? null : remapNumber(edit, moved);
          if (moved === null) continue;
          // A draft that followed its entry starts from the file the entry has now, unless the entry had already changed under it.
          const was = before.outline.chapters.find((entry) => entry.number === number);
          const now = composed.next.outline.chapters.find((entry) => entry.number === moved);
          next.set(moved, moved !== number && was?.hash === draft.baseHash ? { ...draft, baseHash: now?.hash } : draft);
        }
        return next;
      });
      setSnapshot(composed.next);
      setUndo({ label: words.undo, restore, previousNumber });
      after?.(composed.next);
      announce(words.done);
      return { ok: true, next: composed.next };
    } catch (error) {
      if (error instanceof BookConflictError) {
        setChangedElsewhere(true);
        busyRef.current = false;
        void refresh();
      } else {
        setFailure(error instanceof Error ? error.message : String(error));
      }
      return { ok: false };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [announce, refresh, setDrafts, setSnapshot]);

  const undoLast = useCallback(async () => {
    const from = latest.current.source;
    const before = snapshotRef.current;
    const record = undo;
    if (!from || !before || !record || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await from.commit(record.restore, `Outline: undo ${record.label}`);
      const next = await applyToSnapshot(before, record.restore);
      setDrafts((current) => {
        const back = new Map<number, EntryDraft>();
        for (const [number, draft] of current) {
          const previous = record.previousNumber.get(number);
          if (previous === undefined) continue;
          const entry = next.outline.chapters.find((candidate) => candidate.number === previous);
          back.set(previous, previous !== number ? { ...draft, baseHash: entry?.hash } : draft);
        }
        return back;
      });
      setSnapshot(next);
      setUndo(null);
      announce(latest.current.describe("outline.done.undone", { action: record.label }));
      return true;
    } catch (error) {
      if (error instanceof BookConflictError) {
        setChangedElsewhere(true);
        setUndo(null);
        busyRef.current = false;
        void refresh();
      } else {
        setFailure(error instanceof Error ? error.message : String(error));
      }
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [announce, refresh, setDrafts, setSnapshot, undo]);

  const editEntry = useCallback((number: number, patch: Partial<Omit<EntryDraft, "baseHash">>) => {
    setDrafts((current) => {
      const next = new Map(current);
      const entry = byNumberRef.current.get(number);
      const base = current.get(number) ?? (entry ? draftOf(entry) : { title: "", body: "", ghostwriter: null, baseHash: undefined });
      next.set(number, { ...base, ...patch });
      return next;
    });
  }, [setDrafts]);

  const discardEntry = useCallback((number: number) => {
    setDrafts((current) => {
      const next = new Map(current);
      next.delete(number);
      return next;
    });
  }, [setDrafts]);

  const editBook = useCallback((patch: Partial<Omit<BookDraft, "baseHash">>) => {
    const book = snapshotRef.current?.outline.book;
    const base = bookDraftRef.current ?? { title: book?.title ?? "", body: book?.body ?? "", baseHash: book?.hash };
    setBookDraft({ ...base, ...patch });
  }, [setBookDraft]);

  /** A draft whose entry changed since it began is not saved: the page says so, and the author reloads or keeps editing. */
  const stale = useCallback((number: number) => {
    const draft = draftsRef.current.get(number);
    return Boolean(draft && byNumberRef.current.get(number)?.hash !== draft.baseHash);
  }, []);

  const dirtyNumbers = useMemo(() => [...drafts.entries()].filter(([number, draft]) => draftChanged(draft, byNumber.get(number))).map(([number]) => number).sort((left, right) => left - right), [drafts, byNumber]);
  const bookDirty = Boolean(bookDraft && (!same(bookDraft.title, snapshot?.outline.book?.title ?? "") || !same(bookDraft.body, snapshot?.outline.book?.body ?? "")));

  const saveEntry = useCallback(async (number: number) => {
    const draft = draftsRef.current.get(number);
    if (!draft) return false;
    if (stale(number)) {
      setChangedElsewhere(true);
      return false;
    }
    const { describe: say, afterSave: then } = latest.current;
    const result = await act([{ kind: "update", number, entry: { title: draft.title, body: draft.body, ghostwriter: draft.ghostwriter } }], {
      done: sentences(say("outline.done.saved", { number }), then?.([number])),
      undo: say("outline.undo.save", { number }),
      message: `Outline: update chapter ${number}`,
    });
    if (result.ok) discardEntry(number);
    return result.ok;
  }, [act, discardEntry, stale]);

  const saveAll = useCallback(async () => {
    const book = bookDraftRef.current;
    const current = snapshotRef.current;
    const numbers = [...draftsRef.current.entries()].filter(([number, draft]) => draftChanged(draft, byNumberRef.current.get(number))).map(([number]) => number);
    const bookChanged = Boolean(book && current && (!same(book.title, current.outline.book?.title ?? "") || !same(book.body, current.outline.book?.body ?? "")));
    if (!numbers.length && !bookChanged) return true;
    if (numbers.some(stale) || (bookChanged && book?.baseHash !== current?.outline.book?.hash)) {
      setChangedElsewhere(true);
      return false;
    }
    const edits: OutlineEdit[] = [];
    if (bookChanged && book) edits.push({ kind: "book", title: book.title.trim() ? book.title : null, body: book.body });
    for (const number of numbers) {
      const draft = draftsRef.current.get(number)!;
      edits.push({ kind: "update", number, entry: { title: draft.title, body: draft.body, ghostwriter: draft.ghostwriter } });
    }
    const { describe: say, afterSave: then } = latest.current;
    const count = edits.length;
    const result = await act(edits, {
      done: sentences(say("outline.done.savedAll", { count }), then?.(numbers)),
      undo: say("outline.undo.saveAll", { count }),
      message: `Outline: update ${count} ${count === 1 ? "entry" : "entries"}`,
    });
    if (result.ok) {
      setDrafts(() => new Map());
      setBookDraft(null);
    }
    return result.ok;
  }, [act, setBookDraft, setDrafts, stale]);

  const saveBook = useCallback(async () => {
    const book = bookDraftRef.current;
    const current = snapshotRef.current;
    if (!book || !current) return false;
    if (book.baseHash !== current.outline.book?.hash) {
      setChangedElsewhere(true);
      return false;
    }
    const { describe: say } = latest.current;
    const result = await act([{ kind: "book", title: book.title.trim() ? book.title : null, body: book.body }], {
      done: say("outline.done.bookSaved"),
      undo: say("outline.undo.book"),
      message: "Outline: update the description of the book",
    });
    if (result.ok) setBookDraft(null);
    return result.ok;
  }, [act, setBookDraft]);

  return {
    snapshot,
    entries: entries ?? [],
    byNumber,
    warnings: snapshot?.outline.warnings ?? ([] as OutlineWarning[]),
    autopilot,
    loading,
    loadFailed,
    drafts,
    bookDraft,
    dirtyNumbers,
    bookDirty,
    dirty: dirtyNumbers.length > 0 || bookDirty,
    undo,
    busy,
    changedElsewhere,
    announcement,
    failure,
    reload,
    refresh,
    act,
    undoLast,
    editEntry,
    discardEntry,
    editBook,
    saveEntry,
    saveAll,
    saveBook,
    announce,
  };
}

export type OutlineEditor = ReturnType<typeof useOutlineEditor>;
