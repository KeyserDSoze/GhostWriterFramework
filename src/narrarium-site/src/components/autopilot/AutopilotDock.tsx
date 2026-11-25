import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ExternalLink, Loader2, Plane, Trash2, X } from "lucide-react";
import { runnerActivity } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useBackGestureClose } from "@/components/layout/historyStep";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { parseAppRoute } from "@/assistant/context";
import { useBookAutopilotView, useAutopilotRefresh } from "@/autopilot/hooks";
import { isAutopilotLivePage, isAutopilotPage, autopilotLiveHref, autopilotSettingsHref } from "@/autopilot/pageRoute";
import type { ActiveBook } from "@/autopilot/activeBooks";
import { useActiveBooks } from "@/autopilot/useActiveBooks";
import { latestSummary } from "@/autopilot/summary";
import { useTextDetail } from "@/autopilot/useLiveText";
import { LastDone } from "@/components/autopilot/live/LastDone";
import { LiveAnnouncer, TextDetailToggle } from "@/components/autopilot/live/LiveControls";
import { StreamLines } from "@/components/autopilot/live/StreamLines";
import { useAutopilotStore } from "@/autopilot/store";
import { useFocusBook } from "@/autopilot/useFocusBook";
import { useReserveSpace } from "@/hooks/useReserveSpace";
import { useUiStore } from "@/store/uiStore";
import { useSettingsStore } from "@/store/settingsStore";
import { AutopilotFeed } from "@/components/autopilot/AutopilotFeed";
import { useBandModel } from "@/components/autopilot/AutopilotControlBand";
import { FrozenChangesChip, HostChip, ProgressBars, StatusMessage, StatusPill, StepNow } from "@/components/autopilot/band/parts";
import { OperationNotice } from "@/components/autopilot/OperationNotice";
import { QuickCommands } from "@/components/autopilot/QuickCommands";
import { ProfileProblemsNotice, RunErrorNotice } from "@/components/autopilot/StopNotices";
import { isErrorKind } from "@/autopilot/errorModel";
import { isProfileProblemStop } from "@/autopilot/stopReason";
import { questionHeading } from "@/autopilot/format";
import { cn } from "@/lib/utils";

/** The events the “Live” tab lists: the last ones, one line each. The page of the autopilot has all of them. */
const LATEST_EVENTS = 12;
/** The screens where the mini-player is a sheet at the bottom: a phone held upright (narrow), or sideways (short). */
const SHEET_SCREENS = "(max-width: 639px), (max-height: 600px)";

/** Whether a click leads to a page of the autopilot (a step of its history, the text that streams): the panel makes way for it. */
function leadsToAutopilot(event: MouseEvent<HTMLElement>): boolean {
  const link = (event.target as Element | null)?.closest?.("a[href]");
  if (!(link instanceof HTMLAnchorElement) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === "_blank") return false;
  const url = new URL(link.href, window.location.href);
  return url.origin === window.location.origin && isAutopilotPage(url.pathname.replace(/^.*?(\/app\/)/, "/app/"));
}

/**
 * The mini-player of the autopilot, next to the Copilot: what the autopilot of a book is, what it does now, how far it is, and its commands, with
 * the way to its page; and, in the “Live” tab, the last events of every book in one line each. With «Show the text» (the toggle of its header,
 * kept on this device) it also shows the last lines of what the step is writing and the last three steps it finished, each a way to the step on
 * the Autopilot page; the whole list of the steps is on that page. On the pages of the autopilot it keeps out of the way (the page shows all
 * this), and a small button brings it back. It stays open while the author navigates on the other pages.
 */
export function AutopilotDock() {
  const { t } = useTranslation();
  const location = useLocation();
  const hidden = useUiStore((state) => state.floatingHidden);
  // On a phone (narrow, or held sideways and short) the panel is a sheet at the bottom of the screen: it had no room to float there.
  const sheet = useMediaQuery(SHEET_SCREENS);
  const onPage = isAutopilotPage(location.pathname);
  // The configuration is a page of the autopilot, but it does not show the run: brought back there, the panel says the step and lists the events.
  const pageShowsRun = isAutopilotLivePage(location.pathname);
  const dockOpen = useAutopilotStore((state) => state.dockOpen);
  const pageDockOpen = useAutopilotStore((state) => state.pageDockOpen);
  const setDockOpen = useAutopilotStore((state) => state.setDockOpen);
  const setPageDockOpen = useAutopilotStore((state) => state.setPageDockOpen);
  const dockTab = useAutopilotStore((state) => state.dockTab);
  const setDockTab = useAutopilotStore((state) => state.setDockTab);
  const clearFeed = useAutopilotStore((state) => state.clearFeed);
  const route = parseAppRoute(location.pathname);
  const bookId = "bookId" in route ? route.bookId : undefined;
  const tab = bookId ? dockTab : "live";
  const open = onPage ? pageDockOpen : dockOpen;
  const shown = open && !hidden;
  const panel = useRef<HTMLElement>(null);
  const close = () => (onPage ? setPageDockOpen(false) : setDockOpen(false));
  // A link to a step (or to the text that streams) leads to the Autopilot page, where the panel keeps out of the way: brought back there, it closes, so that the
  // step it leads to is not under it. Elsewhere it closes by itself on that page and stays open for the others.
  const makeWay = (event: MouseEvent<HTMLElement>) => {
    if (leadsToAutopilot(event)) setPageDockOpen(false);
  };
  // While the panel floats the page keeps room for it at the bottom, so that what it covers can be scrolled out from under it. A sheet takes the screen instead.
  useReserveSpace(panel, "--dock-reserve", shown && !sheet);
  const followLink = useBackGestureClose(shown && sheet, close, "autopilot-dock");
  if (!shown) return null;

  const tabClass = (active: boolean) => cn("rounded-md px-2.5 py-1 text-xs font-medium transition", active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground", sheet && "min-h-11 text-sm");
  const icon = sheet ? "h-11 w-11" : "h-7 w-7";
  const tabs = (
    <div className="order-last flex w-full rounded-lg bg-muted p-0.5 empty:hidden" role="tablist">
      {bookId && (
        <>
          <button type="button" role="tab" aria-selected={tab === "book"} className={cn(tabClass(tab === "book"), "flex-1")} onClick={() => setDockTab("book")}>{t("autopilot.dockBook")}</button>
          <button type="button" role="tab" aria-selected={tab === "live"} className={cn(tabClass(tab === "live"), "flex-1")} onClick={() => setDockTab("live")}>{t("autopilot.dockLive")}</button>
        </>
      )}
    </div>
  );
  const actions = (
    <div className="flex items-center gap-0.5">
      <TextDetailToggle context={t("autopilot.dockTitle")} className={cn(icon, !sheet && "[&_svg]:size-3.5")} />
      {tab === "live" && (
        <Button variant="ghost" size="icon" className={icon} title={t("autopilot.clearFeed")} aria-label={t("autopilot.clearFeed")} onClick={clearFeed}><Trash2 className="h-3.5 w-3.5" /></Button>
      )}
      <Button asChild variant="ghost" size="icon" className={icon} title={t("autopilot.openPage")}>
        <Link to={bookId ? `/app/books/${encodeURIComponent(bookId)}/autopilot` : "/app/autopilot"} aria-label={t("autopilot.openPage")}><ExternalLink className="h-3.5 w-3.5" /></Link>
      </Button>
      <Button variant="ghost" size="icon" className={icon} title={t("autopilot.close")} aria-label={t("autopilot.close")} onClick={close}><X className="h-4 w-4" /></Button>
    </div>
  );
  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
      {tab === "book" && bookId ? <DockBookPanel bookId={bookId} announce={!pageShowsRun} /> : <DockLivePanel announce={!pageShowsRun} showBook={Boolean(bookId)} onPage={pageShowsRun ? (bookId ? "book" : "all") : null} pageBook={bookId} />}
    </div>
  );

  if (sheet) return <DockSheet title={t("autopilot.dockTitle")} onClose={close} onLinkClick={(event) => { makeWay(event); followLink(event); }} tabs={tabs} actions={actions}>{body}</DockSheet>;

  return (
    <section ref={panel} aria-label={t("autopilot.dockTitle")} onClickCapture={makeWay} className="fixed bottom-[calc(8.5rem+var(--bottom-reserve,0px))] right-4 z-40 flex max-h-[min(70dvh,38rem)] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-layer bg-card text-card-foreground shadow-2xl lg:bottom-[calc(6rem+var(--bottom-reserve,0px))] lg:right-6">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-3 py-2">
        <Plane className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("autopilot.dockTitle")}</h2>
        {tabs}
        {actions}
      </header>
      {body}
    </section>
  );
}

/**
 * The mini-player as a sheet at the bottom of a phone: a dialog (the focus stays in it, Escape and the back gesture close it, and the focus goes
 * back to the button that opened it), as wide as the screen and never taller than most of it, above the keyboard when one of its fields is
 * written in. The page under it cannot take the focus while it is open, so it never covers the field that has the focus.
 */
function DockSheet({ title, onClose, onLinkClick, tabs, actions, children }: { title: string; onClose: () => void; onLinkClick: (event: MouseEvent<HTMLElement>) => void; tabs: ReactNode; actions: ReactNode; children: ReactNode }) {
  const [opener] = useState(() => (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  // Closed by one of its links: the focus goes where the link leads (the page it opens moves it there), not back to the button that opened the sheet.
  const followed = useRef(false);
  const keyboard = useKeyboardInset();
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        bare
        hideCloseButton
        aria-describedby={undefined}
        onClickCapture={(event) => {
          onLinkClick(event);
          if (event.defaultPrevented && (event.target as Element | null)?.closest?.("a[href]")) followed.current = true;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!followed.current && opener?.isConnected) opener.focus();
        }}
        style={keyboard ? { bottom: keyboard, maxHeight: `calc(100dvh - ${keyboard}px - 1rem)` } : undefined}
        className="inset-x-0 bottom-0 flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border-x-0 border-b-0 bg-card text-card-foreground sm:rounded-b-none sm:rounded-t-2xl"
      >
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-3 py-2">
          <Plane className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <DialogTitle className="min-w-0 flex-1 truncate text-base font-semibold">{title}</DialogTitle>
          {tabs}
          {actions}
        </header>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** How much of the bottom of the screen the keyboard of a phone covers now (0 without one): the sheet stands above it. */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = typeof window !== "undefined" ? window.visualViewport : null;
    if (!viewport) return undefined;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

/**
 * The “Live” tab: a card for every book whose autopilot is active (it runs or waits to try again, it waits for the author, it was paused lately),
 * wherever it runs, each with its name, its host, its state, the step it does with its time (and the wait before a retry), its commands and the
 * way to its page; then the last events of every book, in one line each. With no book active and no book in the page it has the mini-player of the
 * book in focus (the one that was active last), with the name of the book always on it; with several books to choose from the author picks which one.
 */
function DockLivePanel({ announce, showBook, onPage, pageBook }: { announce: boolean; showBook: boolean; onPage: "book" | "all" | null; pageBook: string | undefined }) {
  const { t } = useTranslation();
  const { focus, candidates, choose } = useFocusBook();
  const active = useActiveBooks({ summarize: latestSummary, runnerActivity });
  useAutopilotRefresh(active.length ? undefined : focus?.id);
  // A page of the autopilot lists the events itself (the timeline of the book, the feed of every book): the panel does not say them again.
  const pageLists = onPage === "all" ? t("autopilot.dock.pageListsAll") : null;
  return (
    <div className="space-y-3">
      {active.length > 0 && <ActiveBooks books={active} announce={announce} />}
      {active.length === 0 && !showBook && focus && (
        <MiniPlayer
          bookId={focus.id}
          announce={announce}
          heading={candidates.length > 1 ? <FocusSelector focusId={focus.id} candidates={candidates} onChoose={choose} /> : undefined}
        />
      )}
      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("autopilot.dock.latest")}</h3>
        {pageLists ? <p className="rounded-xl border border-dashed p-3 text-center text-xs text-muted-foreground">{pageLists}</p> : <AutopilotFeed showBook limit={LATEST_EVENTS} compact showLive={false} exceptBook={onPage === "book" ? pageBook : undefined} emptyText={onPage === "book" ? t("autopilot.dock.pageLists") : undefined} />}
      </div>
      {showBook && (
        <Button asChild variant="ghost" size="sm" className="w-full">
          <Link to="/app/autopilot">{t("autopilot.dock.all")}</Link>
        </Button>
      )}
    </div>
  );
}

function FocusSelector({ focusId, candidates, onChoose }: { focusId: string; candidates: Array<{ id: string; name: string; running: boolean }>; onChoose: (bookId: string) => void }) {
  const { t } = useTranslation();
  const focus = candidates.find((candidate) => candidate.id === focusId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-auto min-h-9 max-w-full justify-start whitespace-normal text-left">
          <span className="min-w-0 break-words">{t("autopilot.quick.bookLabel", { name: focus?.name ?? focusId })}</span>
          <ChevronDown className="h-4 w-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[min(22rem,calc(100vw-2rem))]">
        <DropdownMenuLabel>{t("autopilot.quick.bookChoose")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={focusId} onValueChange={onChoose}>
          {candidates.map((candidate) => (
            <DropdownMenuRadioItem key={candidate.id} value={candidate.id} className="items-start whitespace-normal">
              <span>{candidate.name}<span className="block text-xs text-muted-foreground">{t(candidate.running ? "autopilot.quick.bookRunning" : "autopilot.quick.bookIdle")}</span></span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The books whose autopilot is active, a card each, told apart at a glance by their names (each a heading, and the way to the book's page), their
 * hosts and their states. One polite voice for all of them, which names the book of what it says: the cards themselves are never read out.
 */
function ActiveBooks({ books, announce }: { books: ActiveBook[]; announce: boolean }) {
  const { t } = useTranslation();
  const titleId = useId();
  const names = useRef(new Map<string, string>());
  names.current = new Map(books.map((book) => [book.id, book.name]));
  const nameOf = useCallback((id: string) => names.current.get(id), []);
  return (
    <section aria-labelledby={titleId} className="space-y-2" data-dock-active={books.length}>
      <h3 id={titleId} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("autopilot.dock.activeTitle", { count: books.length })}</h3>
      <ul className="space-y-2">
        {books.map((book) => (
          <li key={book.id} data-dock-book={book.id}>
            <ActiveBookCard book={book} />
          </li>
        ))}
      </ul>
      {announce && <LiveAnnouncer bookIds={books.map((book) => book.id)} nameOf={nameOf} />}
    </section>
  );
}

function ActiveBookCard({ book }: { book: ActiveBook }) {
  const { t } = useTranslation();
  useAutopilotRefresh(book.id);
  const heading = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      <h4 className="min-w-0 max-w-full text-sm font-semibold">
        <Link to={autopilotLiveHref(book.id)} aria-label={t("autopilot.dock.openBook", { book: book.name })} className="break-words underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{book.name}</Link>
      </h4>
      <HostChip host={book.host} />
    </div>
  );
  return <MiniPlayer bookId={book.id} announce={false} compact heading={heading} />;
}

/** The “This book” tab: the mini-player of the book of the page. */
function DockBookPanel({ bookId, announce }: { bookId: string; announce: boolean }) {
  useAutopilotRefresh(bookId);
  return <MiniPlayer bookId={bookId} announce={announce} />;
}

/**
 * One book in the small: its name and its state, the step it does now with its time, how far it is, what is wrong when something is (the question,
 * the problems of a profile, the error), and its commands. A book that never started has the way to its configuration, where it starts. `announce` says
 * whether the step is read out as it changes: not when the page of the autopilot is on the screen and does it already.
 */
function MiniPlayer({ bookId, announce, heading, compact = false }: { bookId: string; announce: boolean; heading?: ReactNode; compact?: boolean }) {
  const { t } = useTranslation();
  const [detail] = useTextDetail();
  // The text and the last steps are the page's business where the page shows the run (the panel brought back there does not say them twice), and
  // the card of one book among several keeps to its state, its step and its commands (the events of every book are under the cards).
  const text = detail === "full" && announce && !compact;
  const view = useBookAutopilotView(bookId);
  const bookName = useSettingsStore((state) => state.settings.books.find((book) => book.id === bookId)?.name);
  const model = useBandModel(bookId);
  const pageHref = `/app/books/${encodeURIComponent(bookId)}/autopilot`;
  const summary = model?.summary ?? null;
  // A run that waits for the author without a question has a profile file with problems; one that ended with an error says why.
  const profileStop = isProfileProblemStop(summary);
  const failure = summary?.status === "error" ? summary.lastError ?? null : null;
  const profileHintId = `dock-profile-problems-${bookId}`;

  return (
    <div className="space-y-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {heading ?? <p className="min-w-0 flex-1 truncate text-sm font-semibold">{bookName ?? bookId}</p>}
        {view.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />}
        {model ? <StatusPill status={model.status} /> : <span className="text-xs text-muted-foreground">{t("autopilot.notStarted")}</span>}
        <FrozenChangesChip count={summary?.frozenChanges} />
      </div>
      {model && (model.running ? <StepNow bookId={bookId} compact announce={announce} wait={model.wait} countdown /> : model.message ? <StatusMessage>{model.message}</StatusMessage> : null)}
      {text && model?.running && !model.wait && <StreamLines bookId={bookId} />}
      {model && !compact && <ProgressBars summary={model.summary} scenes={false} context={t("autopilot.dockTitle")} />}
      {text && <LastDone bookId={bookId} />}
      {announce && <LiveAnnouncer bookIds={[bookId]} />}
      {profileStop && <ProfileProblemsNotice bookId={bookId} message={summary?.message} compact hintId={profileHintId} />}
      {failure && <RunErrorNotice bookId={bookId} message={failure.message} kind={isErrorKind(failure.kind ?? failure.errorKind) ? failure.kind ?? failure.errorKind : undefined} pageHref={pageHref} />}
      <OperationNotice bookId={bookId} />
      {view.busyInAnotherTab && <p className="text-xs text-muted-foreground">{t("autopilot.anotherTab")}</p>}
      {view.error && <p className="flex items-start gap-1.5 text-xs text-destructive"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{view.error}</p>}
      {summary?.question && (
        <Link to={pageHref} className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-800 hover:bg-amber-500/20 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span><span className="font-medium">{questionHeading(t, summary.question)}:</span> {summary.question.question}</span>
        </Link>
      )}
      <QuickCommands bookId={bookId} variant="dock" heading={null} profileHintId={profileHintId} condensed={compact} />
      {!model && (
        <Button asChild size="sm">
          <Link to={autopilotSettingsHref(bookId)}>{t("autopilot.actions.start")}</Link>
        </Button>
      )}
    </div>
  );
}
