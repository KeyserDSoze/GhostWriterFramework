import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FROZEN_CHANGE_ACTIONS, SnapshotCache, frozenChanges, loadBookSnapshot, type ChapterFreeze, type FrozenAction, type FrozenChapterChanges, type FrozenStatus } from "narrarium-engine";
import { AutopilotFrozenUnsupportedError, serverHasFrozenChapters } from "@/autopilot/frozenChapters";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { useAutopilotStore } from "@/autopilot/store";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { readChapterFolder } from "@/frozen/chapterFolder";
import type { Chapter } from "@/types/book";
import type { BookEntry } from "@/types/settings";

/** What the page of a chapter, or of one of its scenes, shows of its freeze, and what the author can do about it. */
export interface FrozenChapterModel {
  bookId: string;
  slug: string;
  number: number;
  /** The record, when the chapter is frozen; a record that cannot be read is `problem` (the chapter counts as not frozen). */
  record: ChapterFreeze | null;
  problem: string | null;
  /** What changed in the text since it was frozen, in this browser's copy of the book. */
  changed: FrozenChapterChanges | null;
  /** What can be decided about the change now, and the decision already queued for it. */
  actions: FrozenAction[];
  pending: { action: FrozenAction; at: string } | null;
  /** The autopilot is working on the chapter itself: there is nothing for the author to decide. */
  inHands: boolean;
  /** What can be decided is being read. */
  checking: boolean;
  /** The book runs on a personal server that predates the frozen chapters: nothing can be decided or frozen from here. */
  serverUnsupported: boolean;
  /** The autopilot of the book runs now (here, in another tab or on the server). */
  running: boolean;
  /** The book has an autopilot that a queued review can be started with. */
  hasAutopilot: boolean;
  busy: boolean;
  /** What the last action of the author did, said once. */
  outcome: string | null;
  decide: (action: FrozenAction) => Promise<void>;
  setFrozen: (frozen: boolean) => Promise<void>;
  start: () => Promise<void>;
}

interface LocalView {
  number: number;
  record: ChapterFreeze | null;
  problem: string | null;
  changed: FrozenChapterChanges | null;
  hasAutopilot: boolean;
}

interface Decision {
  actions: FrozenAction[];
  pending: { action: FrozenAction; at: string } | null;
  inHands: boolean;
}

/** Every book's chapters as their pages read them: a file is parsed again only when it changed. */
const caches = new Map<string, SnapshotCache>();

/**
 * What can be decided about the change of the chapter, from the status of the book. This browser's session sees what the page sees, so a change it
 * does not list is the autopilot's own work in progress; a personal server may not have received the author's edit yet (a decision hands it over
 * first), so there the choices are those of any frozen chapter.
 */
function decisionFrom(status: FrozenStatus, number: number, server: boolean): Decision {
  const entry = status.changes.find((item) => item.kind === "frozen" && item.number === number);
  if (entry) return { actions: entry.actions, pending: entry.pending ?? null, inHands: false };
  return server ? { actions: [...FROZEN_CHANGE_ACTIONS.frozen], pending: null, inHands: false } : { actions: [], pending: null, inHands: true };
}

/**
 * The freeze of a chapter on the page of the chapter or of one of its scenes. The change is told from this browser's copy of the chapter's folder
 * with the engine's own fingerprints (so an edit shows at once, wherever the autopilot runs), and what can be decided about it is asked of the
 * runtime only when there is a change: the engine's session in this browser, or the personal server. `version` is whatever changes when the page
 * saves the chapter's files.
 */
export function useFrozenChapter({ book, branch, chapter, version }: { book: BookEntry | undefined; branch: string; chapter: Chapter | undefined; version?: unknown }): FrozenChapterModel | null {
  const { t } = useTranslation();
  const bookId = book?.id;
  const slug = chapter?.slug;
  const server = book?.autopilotHost === "server";
  const serverInfo = useAutopilotStore((state) => state.server.info);
  const knownUnsupported = server && serverInfo !== null && !serverHasFrozenChapters(serverInfo);
  const running = useAutopilotStore((state) => (bookId ? (state.summaries[bookId]?.status ?? state.views[bookId]?.snapshot?.state?.status) === "running" : false));
  const { run, busy } = useAutopilotActions(bookId);
  const [view, setView] = useState<LocalView | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const bookRef = useRef(book);
  bookRef.current = book;
  const revisions = chapter?.paragraphs.map((paragraph) => `${paragraph.path}:${paragraph.revision ?? ""}`).join("|") ?? "";

  useEffect(() => {
    const current = bookRef.current;
    if (!current || !slug) {
      setView(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      let local: LocalView;
      try {
        const folder = await readChapterFolder(current, branch, slug);
        const cache = caches.get(current.id) ?? new SnapshotCache();
        caches.set(current.id, cache);
        const snapshot = await loadBookSnapshot(folder.store, cache);
        const info = snapshot.chapters.find((entry) => entry.slug === slug);
        if (!info) {
          if (!cancelled) setView(null);
          return;
        }
        const change = frozenChanges(snapshot).find((entry) => entry.slug === slug);
        local = { number: info.number, record: info.frozen ?? null, problem: info.frozenProblem ?? null, changed: change?.changed ?? null, hasAutopilot: folder.hasAutopilot };
      } catch {
        // A book without a working copy in this browser, or one that cannot be read now: nothing is said of its freeze.
        if (!cancelled) setView(null);
        return;
      }
      if (cancelled) return;
      setView(local);
      if (!local.changed || knownUnsupported) {
        setDecision(null);
        return;
      }
      try {
        const runtime = await loadAutopilotRuntime();
        const status = await runtime.frozenStatus(current.id);
        if (!cancelled) setDecision(decisionFrom(status, local.number, server));
      } catch (error) {
        if (cancelled) return;
        if (error instanceof AutopilotFrozenUnsupportedError) setUnsupported(true);
        // The runtime could not say (a server that cannot be reached): the choices of a frozen chapter, which the decision checks again.
        else setDecision({ actions: [...FROZEN_CHANGE_ACTIONS.frozen], pending: null, inHands: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId, branch, slug, revisions, version, tick, knownUnsupported, server]);

  // An edit made elsewhere (another tab, the autopilot) is seen when the author comes back to the page.
  useEffect(() => {
    const again = () => setTick((value) => value + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);

  const number = view?.number ?? 0;
  const decide = useCallback(async (action: FrozenAction) => {
    if (!view) return;
    const ok = await run("answer", async (runtime, id) => {
      const status = await runtime.resolveFrozenChange(id, number, action);
      // Marking it reviewed is done at once: the chapter is read again below, and the notice goes away.
      setDecision(action === "mark-reviewed" || action === "keep-text" ? null : decisionFrom(status, number, server));
    });
    if (!ok) return;
    setOutcome(t(action === "mark-reviewed" || action === "keep-text" ? "frozen.done.reviewed" : "frozen.done.queued"));
    setTick((value) => value + 1);
  }, [view, run, number, server, t]);

  const setFrozen = useCallback(async (frozen: boolean) => {
    if (!slug) return;
    const ok = await run("configure", (runtime, id) => runtime.setChapterFrozen(id, slug, frozen));
    if (!ok) return;
    setOutcome(t(frozen ? "frozen.done.frozen" : "frozen.done.unfrozen"));
    setDecision(null);
    setTick((value) => value + 1);
  }, [slug, run, t]);

  const start = useCallback(async () => {
    await run("start", (runtime, id) => runtime.start(id));
  }, [run]);

  if (!view || !bookId || !slug) return null;
  const serverUnsupported = knownUnsupported || unsupported;
  return {
    bookId,
    slug,
    number: view.number,
    record: view.record,
    problem: view.problem,
    changed: view.changed,
    actions: decision?.actions ?? [],
    pending: decision?.pending ?? null,
    inHands: decision?.inHands ?? false,
    checking: Boolean(view.changed) && decision === null && !serverUnsupported,
    serverUnsupported,
    running,
    hasAutopilot: view.hasAutopilot,
    busy: busy !== null,
    outcome,
    decide,
    setFrozen,
    start,
  };
}
