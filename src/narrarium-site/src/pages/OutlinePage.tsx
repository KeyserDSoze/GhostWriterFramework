import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, CircleHelp, FileInput, ListTree, Loader2, Plus, Rocket, Save, Search, Undo2, X } from "lucide-react";
import { changeOfWritten, chapterFilePath, groupOutlineChanges, type AutopilotState, type OutlineChangeGroup, type OutlineEdit } from "narrarium-engine";
import "@/i18n/outline";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { FileChangedNotice } from "@/components/book/FileChangedNotice";
import { OutlineEntryCard, type OutlineEntryHandlers } from "@/components/outline/OutlineEntryCard";
import { OutlineBookSection } from "@/components/outline/OutlineBookSection";
import { useOutlineBriefEditor } from "@/components/outline/useOutlineBriefEditor";
import { ConvertSynopsisDialog, DeleteEntryDialog } from "@/components/outline/OutlineDialogs";
import { draftChanged, useOutlineEditor } from "@/components/outline/useOutlineEditor";
import { OutlineBodyAssist, OutlineAssistDialog, useOutlineAssist, useOutlineDescriptionAssist } from "@/components/outline/OutlineAssist";
import { useAutopilotStore } from "@/autopilot/store";
import { autopilotSettingsHref } from "@/autopilot/pageRoute";
import { OUTLINE_BRIEF_FILE } from "@/autopilot/outlineBrief";
import { formatCount } from "@/autopilot/format";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { browserOutlineSource } from "@/outline/outlineSource";
import { convertSynopsis, entryStatus, filterEntries, frozenChapterSlugs, isToldOutcome, missingNumbers, warningsByPath, writtenChapters, type ConvertedSynopsis, type StatusContext, type ToldOutcome } from "@/outline/outlineModel";
import { useOutlineFocusStore } from "@/store/outlineFocusStore";
import { useRegisterPageSave } from "@/store/saveStore";
import { BrainstormPageButton, useBrainstormLauncher } from "@/components/assistant/brainstorm/BrainstormLauncher";

/** The entries drawn at once: an outline has no maximum, and a book of 5000 chapters opens as fast as one of ten. */
export const OUTLINE_PAGE_SIZE = 50;
/** The runs of chapters without an entry the page lists before it says how many more there are. */
const LISTED_GAPS = 8;

type FocusTarget = { number: number; field: "title" | "move-up" | "move-down" | "entry" };

const NO_FROZEN: ReadonlySet<string> = new Set();
const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) => left.size === right.size && [...left].every((item) => right.has(item));

export function OutlinePage() {
  const { bookId = "" } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const location = useLocation();
  const { branch, ready } = useWorkingBranch(bookId);
  const { book, structure, error, reload: reloadStructure, loading: structureLoading } = useBookStructure(bookId);
  const loaded = Boolean(structure);
  // The settings are replaced whenever they reload, so the `book` object is new each time: the source changes only for another book or branch.
  const bookKey = book ? `${book.id}|${book.owner}/${book.repo}` : "";
  const bookRef = useRef(book);
  bookRef.current = book;
  const source = useMemo(() => (bookKey && ready && loaded && bookRef.current ? browserOutlineSource(bookRef.current, branch) : null), [bookKey, branch, ready, loaded]);
  const ghostwriters = useMemo(() => structure?.ghostwriters ?? [], [structure?.ghostwriters]);
  const ghostwriterSlugs = useMemo(() => ghostwriters.map((entry) => entry.slug), [ghostwriters]);
  const describe = useCallback((key: string, options?: Record<string, unknown>) => t(key, options) as string, [t]);
  // What a save adds when it changes the entry of a chapter the autopilot closed or has in its hands: the engine's rule says whether it asks, rewrites, only reports
  // or tells it once and decides when the chapter is closed (`changeOfWritten`, grouped as the engine groups a series of changes).
  const autopilotRef = useRef<AutopilotState | null>(null);
  const afterSave = useCallback((numbers: readonly number[]) => groupOutlineChanges(autopilotRef.current, numbers.map((number) => ({ number })))
    .filter((group): group is OutlineChangeGroup & { outcome: ToldOutcome } => isToldOutcome(group.outcome))
    .map((group) => t(`outline.written.${group.outcome}`, { count: group.numbers.length, numbers: group.numbers.map(formatCount) }))
    .join(" "), [t]);
  const editor = useOutlineEditor({ source, ghostwriters: ghostwriterSlugs, describe, afterSave, language: structure?.language });
  const { entries, byNumber, drafts, busy } = editor;
  // The brief of the book is a file of the outline: it is read with the outline and saved with its commits, and what it says is the author's.
  const briefEditor = useOutlineBriefEditor({ file: editor.snapshot?.files.get(OUTLINE_BRIEF_FILE), source, refresh: editor.refresh });
  // What the brief's own save refused or failed to write, said above the page until the next save (the outline's own refusals are its `failure`).
  const [briefFailure, setBriefFailure] = useState<string | null>(null);
  // «Save all» (and Ctrl+S): the book and its entries through the outline's commit, then the brief's fields through the brief's commit. Each part says what it did.
  const saveAll = async (): Promise<boolean> => {
    const outlineSaved = await editor.saveAll();
    const result = await briefEditor.save();
    setBriefFailure(result.status === "conflict" ? "" : result.status === "failed" ? result.message ?? "" : null);
    if (result.status === "saved") editor.announce(t("outline.brief.result.saved"));
    return outlineSaved && (result.status === "saved" || result.status === "unchanged");
  };

  // The outline changes outside the page too: the autopilot fills it, the Copilot edits it, another tab saves it. Read again what changed when
  // the page comes back into view, when the autopilot of the book finishes a step and when the book is read again after a change.
  const finishedSteps = useAutopilotStore((state) => {
    let count = 0;
    for (const entry of state.feed) if (entry.event.bookId === bookId && entry.event.type === "task-finished") count += 1;
    return count;
  });
  const lastSync = useAutopilotStore((state) => state.views[bookId]?.sync?.at ?? "");
  const { refresh } = editor;
  const [focusCount, setFocusCount] = useState(0);
  useEffect(() => { void refresh(); }, [refresh, finishedSteps, lastSync, structure]);
  useEffect(() => {
    const onFocus = () => {
      void refresh();
      setFocusCount((count) => count + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useRegisterPageSave({
    dirty: editor.dirty || briefEditor.dirty,
    enabled: Boolean(editor.snapshot),
    onSave: saveAll,
  });

  autopilotRef.current = editor.autopilot;
  const written = useMemo(() => writtenChapters(structure?.chapters ?? []), [structure?.chapters]);

  // ─── The window of entries ─────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterEntries(entries, query), [entries, query]);
  const [start, setStart] = useState(0);
  const first = Math.min(start, Math.max(0, Math.floor((filtered.length - 1) / OUTLINE_PAGE_SIZE) * OUTLINE_PAGE_SIZE));
  const visible = useMemo(() => filtered.slice(first, first + OUTLINE_PAGE_SIZE), [filtered, first]);

  // Which written chapters on the screen are frozen, from their chapter.md: an outline has no maximum, so only the chapters of the window are
  // read, again when the autopilot finishes a step, when the book is read again and when the page comes back into view.
  const visibleWritten = visible.map((entry) => written.get(entry.number)?.slug).filter((slug): slug is string => Boolean(slug)).join("\n");
  const [frozen, setFrozen] = useState<ReadonlySet<string>>(NO_FROZEN);
  useEffect(() => {
    if (!source || !visibleWritten) {
      setFrozen(NO_FROZEN);
      return;
    }
    let current = true;
    source.readFiles(visibleWritten.split("\n").map(chapterFilePath))
      .then((files) => {
        const next = frozenChapterSlugs(files);
        if (current) setFrozen((previous) => (sameSet(previous, next) ? previous : next));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [source, visibleWritten, finishedSteps, lastSync, structure, focusCount]);

  const statusContext = useMemo<StatusContext>(() => ({
    autopilot: editor.autopilot,
    written,
    ghostwriters: new Set(ghostwriterSlugs),
    warnings: warningsByPath(editor.warnings),
    frozen,
  }), [editor.autopilot, written, ghostwriterSlugs, editor.warnings, frozen]);
  // One status for each entry on the screen, made again only when the entries or what they are compared with change: typing in one entry
  // draws only that entry again.
  const statuses = useMemo(() => new Map(visible.map((entry) => [entry.number, entryStatus(entry, statusContext)])), [visible, statusContext]);
  // Where the focus goes once the entry is on the screen: after an action, a jump or a link. A state, so that the page draws again for it.
  const [pendingFocus, setPendingFocus] = useState<FocusTarget | null>(null);

  const reveal = useCallback((number: number, field: FocusTarget["field"]) => {
    setPendingFocus({ number, field });
    const index = filterEntries(editor.snapshot?.outline.chapters ?? [], query).findIndex((entry) => entry.number === number);
    if (index >= 0) setStart(Math.floor(index / OUTLINE_PAGE_SIZE) * OUTLINE_PAGE_SIZE);
    else {
      setQuery("");
      const all = (editor.snapshot?.outline.chapters ?? []).findIndex((entry) => entry.number === number);
      setStart(Math.max(0, Math.floor(all / OUTLINE_PAGE_SIZE) * OUTLINE_PAGE_SIZE));
    }
  }, [editor.snapshot, query]);

  useLayoutEffect(() => {
    const target = pendingFocus;
    if (!target) return;
    const card = document.getElementById(`outline-chapter-${target.number}`);
    if (!card) return;
    setPendingFocus(null);
    const element = target.field === "title"
      ? card.querySelector<HTMLElement>('[data-outline-field="title"]')
      : target.field === "entry"
        ? card
        : card.querySelector<HTMLButtonElement>(`[data-outline-action="${target.field}"]:not(:disabled)`) ?? card;
    element?.scrollIntoView?.({ block: "center" });
    element?.focus({ preventScroll: true });
  });

  // A link to `#outline-chapter-N` (from an error of the autopilot, from the help) opens the window on that entry.
  const followedHash = useRef("");
  useEffect(() => {
    const match = /^#outline-chapter-(\d+)$/.exec(location.hash);
    if (!match || !editor.snapshot || followedHash.current === location.key) return;
    followedHash.current = location.key;
    if (byNumber.has(Number(match[1]))) reveal(Number(match[1]), "entry");
  }, [location.hash, location.key, editor.snapshot, byNumber, reveal]);

  // ─── Actions ───────────────────────────────────────────────────────────────
  const [deleting, setDeleting] = useState<number | null>(null);
  const [converted, setConverted] = useState<ConvertedSynopsis | null>(null);
  const [jump, setJump] = useState("");
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const lastNumber = entries.length ? entries[entries.length - 1].number : 0;

  const addAtEnd = useCallback(async () => {
    const number = lastNumber + 1;
    const result = await editorRef.current.act([{ kind: "append", entry: {} }], { done: t("outline.done.added", { number }), undo: t("outline.undo.add", { number }), message: `Outline: add chapter ${number}` });
    if (result.ok) reveal(number, "title");
  }, [lastNumber, reveal, t]);

  const handlers = useMemo<OutlineEntryHandlers>(() => ({
    onEdit: (number, patch) => editorRef.current.editEntry(number, patch),
    onSave: (number) => void editorRef.current.saveEntry(number),
    onDiscard: (number) => editorRef.current.discardEntry(number),
    onFocusEntry: (number) => useOutlineFocusStore.getState().focus(bookId, number),
    onRemove: (number) => setDeleting(number),
    onInsert: (number, where) => {
      const current = editorRef.current.byNumber;
      // A gap right there takes the new chapter without moving the others.
      const target = where === "before" ? number : number + 1;
      const free = where === "before" ? number - 1 >= 1 && !current.has(number - 1) : !current.has(number + 1);
      const at = free ? (where === "before" ? number - 1 : number + 1) : target;
      const edit: OutlineEdit = free ? { kind: "update", number: at, entry: {} } : { kind: "insert", at, entry: {} };
      void editorRef.current.act([edit], { done: t(free ? "outline.done.added" : "outline.done.inserted", { number: at }), undo: t("outline.undo.insert", { number: at }), message: `Outline: insert chapter ${at}` })
        .then((result) => { if (result.ok) reveal(at, "title"); });
    },
    onMove: (number, direction) => {
      const list = editorRef.current.entries;
      const index = list.findIndex((entry) => entry.number === number);
      const neighbour = list[direction === "up" ? index - 1 : index + 1];
      if (index < 0 || !neighbour) return;
      const to = neighbour.number;
      void editorRef.current.act([{ kind: "move", from: number, to }], { done: t("outline.done.moved", { from: number, to }), undo: t("outline.undo.move", { from: number }), message: `Outline: move chapter ${number} to ${to}` })
        .then((result) => { if (result.ok) reveal(to, direction === "up" ? "move-up" : "move-down"); });
    },
  }), [bookId, reveal, t]);

  const confirmDelete = async (renumber: boolean) => {
    const number = deleting;
    if (number === null) return;
    const result = await editor.act([{ kind: "remove", number, renumber }], {
      done: t(renumber ? "outline.done.removedRenumbered" : "outline.done.removed", { number }),
      undo: t("outline.undo.remove", { number }),
      message: `Outline: delete chapter ${number}${renumber ? " and renumber the following ones" : ""}`,
    });
    setDeleting(null);
    if (result.ok) {
      const chapters = result.next?.outline.chapters ?? [];
      const next = chapters.find((entry) => entry.number >= number) ?? chapters[chapters.length - 1];
      if (next) reveal(next.number, "entry");
    }
  };

  const synopsis = (briefEditor.brief.synopsis || editor.autopilot?.brief.synopsis || "").trim();
  const confirmConvert = async () => {
    if (!converted) return;
    const edits: OutlineEdit[] = [];
    const existing = editor.snapshot?.outline.book?.body.trim() ?? "";
    const description = [existing, converted.description].filter(Boolean).join("\n\n");
    if (converted.description) edits.push({ kind: "book", body: description });
    for (const entry of converted.entries) edits.push({ kind: "update", number: entry.number, entry: { title: entry.title, body: entry.body } });
    const result = await editor.act(edits, { done: t("outline.done.converted", { count: converted.entries.length }), undo: t("outline.undo.convert"), message: "Outline: convert the chapter-by-chapter synopsis of the brief" });
    setConverted(null);
    if (result.ok && converted.entries[0]) reveal(converted.entries[0].number, "entry");
  };

  const goTo = () => {
    const number = Number(jump.trim());
    if (!Number.isSafeInteger(number) || number < 1) return;
    if (!byNumber.has(number)) {
      editor.announce(t("outline.jump.missing", { number }));
      return;
    }
    reveal(number, "title");
  };

  // ─── The assistant of the context menu ─────────────────────────────────────
  const description = editor.bookDraft?.body ?? editor.snapshot?.outline.book?.body ?? "";
  const assist = useOutlineAssist({ structure, source, entries, drafts, description, editEntry: editor.editEntry, announce: editor.announce });
  const renderBody = useCallback((props: { number: number; textareaRef: React.RefObject<HTMLTextAreaElement | null>; value: string; onChange: (value: string) => void }) => (
    <OutlineBodyAssist key={props.number} {...props} controller={assist} />
  ), [assist]);

  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const editBook = editor.editBook;
  const editDescription = useCallback((body: string) => editBook({ body }), [editBook]);
  const descriptionDialogs = useOutlineDescriptionAssist({ textareaRef: descriptionRef, value: description, onChange: editDescription, controller: assist, enabled: Boolean(editor.snapshot) });

  // ─── Brainstorming, the Copilot's mode for the big design of this book ─────
  const bookName = structure?.title || book?.name || "";
  const brainstormTarget = useMemo(() => (source && bookId ? { bookId, title: t("brainstorm.sessionTitle", { book: bookName }) } : null), [source, bookId, bookName, t]);
  useBrainstormLauncher(bookId, brainstormTarget);

  if (error && !structure) return <BookStructureErrorAlert error={error} reload={reloadStructure} />;
  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;

  const snapshot = editor.snapshot;
  const bookEntry = snapshot?.outline.book ?? null;
  const bookTitle = editor.bookDraft?.title ?? bookEntry?.title ?? "";
  const bookBody = description;
  const gaps = missingNumbers(entries.map((entry) => entry.number));
  const gapText = gaps.slice(0, LISTED_GAPS).map(([from, to]) => (from === to ? formatCount(from) : `${formatCount(from)}–${formatCount(to)}`)).join(", ") + (gaps.length > LISTED_GAPS ? ", …" : "");
  const windowed = filtered.length > OUTLINE_PAGE_SIZE;
  const rangeText = t("outline.window.range", { from: formatCount(visible[0]?.number ?? 0), to: formatCount(visible[visible.length - 1]?.number ?? 0), total: formatCount(filtered.length) });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 sm:flex-1">
          <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold tracking-tight"><ListTree className="h-6 w-6 text-primary" aria-hidden="true" />{t("outline.title")}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("outline.intro")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {snapshot && <Badge variant="outline">{t("outline.count", { count: entries.length })}</Badge>}
            <span className="font-mono">outline/</span>
            <Link to="/app/docs/outline" className="inline-flex min-h-6 items-center gap-1 underline underline-offset-4 [@media(pointer:coarse)]:min-h-11"><CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />{t("outline.help")}</Link>
          </div>
          {/* The one place where the page says how an action went: always there, empty until there is something to say. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm empty:hidden">
            <p role="status" className="min-w-0 text-muted-foreground">{editor.announcement}</p>
            {editor.undo && <Button size="sm" variant="outline" onClick={() => void editor.undoLast()} disabled={busy}><Undo2 className="h-4 w-4" aria-hidden="true" />{t("outline.actions.undo")}</Button>}
          </div>
        </div>
        {/* The actions take at most half the width, a line each when they need it, so that the introduction keeps its lines. */}
        <div className="flex flex-wrap gap-2 sm:max-w-[50%] sm:justify-end">
          <BrainstormPageButton target={brainstormTarget} />
          {editor.dirty && (
            <Button onClick={() => void editor.saveAll()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}{t("outline.actions.saveAll")}
            </Button>
          )}
          {snapshot && entries.length > 0 && <Button variant="outline" onClick={() => void addAtEnd()} disabled={busy}><Plus className="h-4 w-4" aria-hidden="true" />{t("outline.actions.add")}</Button>}
        </div>
      </header>

      {editor.changedElsewhere && <FileChangedNotice message={t("outline.changedElsewhere")} reloadLabel={t("outline.reload")} onReload={() => void editor.reload()} />}
      {editor.failure && <Alert variant="destructive"><AlertDescription><span className="font-medium">{t("outline.saveFailed")}</span> {editor.failure}</AlertDescription></Alert>}
      {briefFailure !== null && <Alert variant="destructive"><AlertDescription><span className="font-medium">{t("outline.brief.saveFailed")}</span> {briefFailure || t("outline.brief.result.conflict")}</AlertDescription></Alert>}
      {editor.loadFailed && !snapshot && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3"><span>{t("outline.loadFailed")}</span><Button size="sm" variant="outline" onClick={() => void editor.reload()}>{t("common.retry")}</Button></AlertDescription>
        </Alert>
      )}

      {!snapshot ? (
        (editor.loading || structureLoading || !source) && !editor.loadFailed ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("outline.loading")}</p> : null
      ) : (
        <>
          <OutlineBookSection
            workingTitle={bookTitle}
            idea={bookBody}
            brief={briefEditor.brief}
            dirty={editor.bookDirty || briefEditor.dirty}
            busy={busy}
            ideaRef={descriptionRef}
            onTitle={(title) => editor.editBook({ title })}
            onIdea={(body) => editor.editBook({ body })}
            onBrief={briefEditor.edit}
            onSave={() => void saveAll()}
          />

          {entries.length === 0 ? (
            <section aria-labelledby="outline-empty-title" className="space-y-3 rounded-2xl border border-dashed border-layer p-5 sm:p-6">
              <h2 id="outline-empty-title" className="text-lg font-semibold">{t("outline.empty.title")}</h2>
              <p className="max-w-3xl text-sm text-muted-foreground">{t("outline.empty.body")}</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void addAtEnd()} disabled={busy}><Plus className="h-4 w-4" aria-hidden="true" />{t("outline.empty.addFirst")}</Button>
                <Button asChild variant="outline"><Link to={autopilotSettingsHref(bookId)}><Rocket className="h-4 w-4" aria-hidden="true" />{t("outline.empty.autopilot")}</Link></Button>
                {synopsis && <Button variant="outline" onClick={() => setConverted(convertSynopsis(synopsis))} disabled={busy}><FileInput className="h-4 w-4" aria-hidden="true" />{t("outline.empty.convert")}</Button>}
              </div>
            </section>
          ) : (
            <section aria-labelledby="outline-chapters-title" className="space-y-3">
              <h2 id="outline-chapters-title" className="sr-only">{t("outline.count", { count: entries.length })}</h2>
              <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-layer bg-card p-3 shadow-sm">
                <div className="min-w-[12rem] flex-1 space-y-1">
                  <Label htmlFor="outline-filter" className="text-xs">{t("outline.filter.label")}</Label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <Input id="outline-filter" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setStart(0); }} className="h-9 pl-8" aria-describedby={query ? "outline-filter-results" : undefined} />
                  </div>
                </div>
                <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); goTo(); }}>
                  <div className="space-y-1">
                    <Label htmlFor="outline-jump" className="text-xs">{t("outline.jump.label")}</Label>
                    <Input id="outline-jump" inputMode="numeric" pattern="[0-9]*" value={jump} onChange={(event) => setJump(event.target.value.replace(/[^\d]/g, ""))} className="h-9 w-24" />
                  </div>
                  <Button type="submit" variant="outline" size="sm" className="h-9">{t("outline.jump.button")}</Button>
                </form>
                {query && (
                  <p id="outline-filter-results" className="flex w-full items-center gap-2 text-xs text-muted-foreground">
                    {filtered.length ? t("outline.filter.results", { count: filtered.length }) : t("outline.filter.none")}
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => { setQuery(""); setStart(0); }}><X className="h-3.5 w-3.5" aria-hidden="true" />{t("outline.filter.clear")}</Button>
                  </p>
                )}
              </div>
              {gaps.length > 0 && !query && <p className="text-xs text-muted-foreground">{t("outline.gaps", { ranges: gapText })}</p>}
              {windowed && <WindowNav label={t("outline.window.label")} range={rangeText} first={first} total={filtered.length} onMove={setStart} />}
              <ol className="space-y-3">
                {visible.map((entry) => {
                  const draft = drafts.get(entry.number);
                  return (
                    <li key={entry.path}>
                      <OutlineEntryCard
                        bookId={bookId}
                        entry={entry}
                        draft={draft}
                        dirty={draftChanged(draft, entry)}
                        status={statuses.get(entry.number)!}
                        ghostwriters={ghostwriters}
                        first={entries[0]?.number === entry.number}
                        last={entries[entries.length - 1]?.number === entry.number}
                        busy={busy}
                        renderBody={renderBody}
                        {...handlers}
                      />
                    </li>
                  );
                })}
              </ol>
              {windowed && <WindowNav label={t("outline.window.label")} range={rangeText} first={first} total={filtered.length} onMove={setStart} />}
            </section>
          )}
        </>
      )}

      <DeleteEntryDialog
        number={deleting}
        written={deleting !== null && statusContext.written.has(deleting)}
        stays={deleting !== null && changeOfWritten(editor.autopilot, deleting, { entry: "removed", outlineEmpty: entries.length <= 1 }) === "stays"}
        unsaved={deleting !== null && draftChanged(drafts.get(deleting), byNumber.get(deleting))}
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={(renumber) => void confirmDelete(renumber)}
      />
      <ConvertSynopsisDialog converted={converted} busy={busy} onCancel={() => setConverted(null)} onConfirm={() => void confirmConvert()} />
      <OutlineAssistDialog controller={assist} />
      {descriptionDialogs}
    </div>
  );
}

/** Previous and next page of entries, with where the window is. */
function WindowNav({ label, range, first, total, onMove }: { label: string; range: string; first: number; total: number; onMove: (start: number) => void }) {
  const { t } = useTranslation();
  const previous = Math.max(0, first - OUTLINE_PAGE_SIZE);
  const next = first + OUTLINE_PAGE_SIZE;
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <Button type="button" variant="outline" size="sm" disabled={first === 0} onClick={() => onMove(previous)}><ChevronLeft className="h-4 w-4" aria-hidden="true" />{t("outline.window.previous", { count: Math.min(OUTLINE_PAGE_SIZE, first) || OUTLINE_PAGE_SIZE })}</Button>
      <span className="text-xs text-muted-foreground">{range}</span>
      <Button type="button" variant="outline" size="sm" disabled={next >= total} onClick={() => onMove(next)}>{t("outline.window.next", { count: Math.min(OUTLINE_PAGE_SIZE, Math.max(0, total - next)) || OUTLINE_PAGE_SIZE })}<ChevronRight className="h-4 w-4" aria-hidden="true" /></Button>
    </nav>
  );
}
