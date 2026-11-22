import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ExternalLink, Loader2, Pause, Plane, Play, Square, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseAppRoute } from "@/assistant/context";
import { useAutopilotRefresh, useBookAutopilotView } from "@/autopilot/hooks";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { useAutopilotControl } from "@/autopilot/useAutopilotControl";
import { useAutopilotStore } from "@/autopilot/store";
import { autopilotSummaryLine } from "@/autopilot/format";
import { useUiStore } from "@/store/uiStore";
import { useSettingsStore } from "@/store/settingsStore";
import { AutopilotFeed, AutopilotStatusBadge } from "@/components/autopilot/AutopilotFeed";
import { OperationNotice } from "@/components/autopilot/OperationNotice";
import { RemoteRunNotice } from "@/components/autopilot/RemoteRunNotice";
import { ProfileProblemsNotice, RunErrorNotice } from "@/components/autopilot/StopNotices";
import { isProfileProblemStop } from "@/autopilot/stopReason";
import { cn } from "@/lib/utils";

/**
 * Non-modal panel above the bottom-right launchers. It stays open while the author navigates,
 * showing everything the autopilot does (all books) or the state of the current book.
 */
export function AutopilotDock() {
  const { t } = useTranslation();
  const location = useLocation();
  const hidden = useUiStore((state) => state.floatingHidden);
  const dockOpen = useAutopilotStore((state) => state.dockOpen);
  const setDockOpen = useAutopilotStore((state) => state.setDockOpen);
  const dockTab = useAutopilotStore((state) => state.dockTab);
  const setDockTab = useAutopilotStore((state) => state.setDockTab);
  const clearFeed = useAutopilotStore((state) => state.clearFeed);
  const route = parseAppRoute(location.pathname);
  const bookId = "bookId" in route ? route.bookId : undefined;
  const tab = bookId ? dockTab : "live";
  if (hidden || !dockOpen) return null;

  const tabClass = (active: boolean) => cn("rounded-md px-2.5 py-1 text-xs font-medium transition", active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground");

  return (
    <section aria-label={t("autopilot.dockTitle")} className="fixed bottom-20 right-4 z-40 flex max-h-[min(70dvh,38rem)] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-2xl lg:bottom-24 lg:right-6">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-3 py-2">
        <Plane className="h-4 w-4 shrink-0 text-primary" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("autopilot.dockTitle")}</h2>
        <div className="order-last flex w-full rounded-lg bg-muted p-0.5 empty:hidden" role="tablist">
          {bookId && (
            <>
              <button type="button" role="tab" aria-selected={tab === "live"} className={cn(tabClass(tab === "live"), "flex-1")} onClick={() => setDockTab("live")}>{t("autopilot.dockLive")}</button>
              <button type="button" role="tab" aria-selected={tab === "book"} className={cn(tabClass(tab === "book"), "flex-1")} onClick={() => setDockTab("book")}>{t("autopilot.dockBook")}</button>
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {tab === "live" && (
            <Button variant="ghost" size="icon" className="h-7 w-7" title={t("autopilot.clearFeed")} aria-label={t("autopilot.clearFeed")} onClick={clearFeed}><Trash2 className="h-3.5 w-3.5" /></Button>
          )}
          <Button asChild variant="ghost" size="icon" className="h-7 w-7" title={t("autopilot.openPage")}>
            <Link to={bookId ? `/app/books/${encodeURIComponent(bookId)}/autopilot` : "/app/autopilot"} aria-label={t("autopilot.openPage")}><ExternalLink className="h-3.5 w-3.5" /></Link>
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" title={t("autopilot.close")} aria-label={t("autopilot.close")} onClick={() => setDockOpen(false)}><X className="h-4 w-4" /></Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "book" && bookId ? <DockBookPanel bookId={bookId} /> : <AutopilotFeed showBook limit={150} />}
      </div>
    </section>
  );
}

function DockBookPanel({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const view = useBookAutopilotView(bookId);
  const bookName = useSettingsStore((state) => state.settings.books.find((book) => book.id === bookId)?.name);
  const control = useAutopilotControl(bookId);
  const { busy, run } = useAutopilotActions(bookId);
  useAutopilotRefresh(bookId);

  // The same reading of who can command the run as the page: Pause and Stop never go to a run this client cannot reach.
  const { summary, running, controllable } = control;
  const pausing = busy === "pause" || busy === "stop";
  const awaitingPlan = Boolean(view.snapshot?.state?.plan?.awaitingAuthor);
  const pageHref = `/app/books/${encodeURIComponent(bookId)}/autopilot`;
  const noteId = `dock-remote-run-${bookId}`;
  const explained = controllable ? undefined : noteId;
  // A run that waits for the author without a question has a profile file with problems; one that ended with an error says why.
  const profileStop = isProfileProblemStop(summary);
  const failure = summary?.status === "error" ? summary.lastError ?? null : null;
  const profileHintId = `dock-profile-problems-${bookId}`;

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-xl border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold">{bookName ?? bookId}</p>
          {view.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <AutopilotStatusBadge status={summary?.status} />
        </div>
        {summary && (
          <p className="text-xs text-muted-foreground">
            {autopilotSummaryLine(t, summary)}
          </p>
        )}
        {summary?.message && !profileStop && summary.message !== failure?.message && <p className="text-xs">{summary.message}</p>}
        {profileStop && <ProfileProblemsNotice bookId={bookId} message={summary?.message} compact hintId={profileHintId} />}
        {failure && <RunErrorNotice bookId={bookId} message={failure.message} compact />}
        <OperationNotice bookId={bookId} />
        {view.busyInAnotherTab && <p className="text-xs text-muted-foreground">{t("autopilot.anotherTab")}</p>}
        <RemoteRunNotice bookId={bookId} control={control} id={noteId} />
        {view.error && <p className="flex items-start gap-1.5 text-xs text-destructive"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{view.error}</p>}
        {summary?.question && (
          <Link to={pageHref} className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-800 hover:bg-amber-500/20 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span><span className="font-medium">{t("autopilot.question.title")}:</span> {summary.question.question}</span>
          </Link>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {running ? (
            <>
              <Button size="sm" variant="outline" disabled={pausing || !controllable} aria-describedby={explained} onClick={() => void run("pause", (runtime, id) => runtime.pause(id, "after-step"))}>
                {busy === "pause" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pause className="h-3.5 w-3.5" />}{t("autopilot.actions.pause")}
              </Button>
              <Button size="sm" variant="ghost" disabled={pausing || !controllable} aria-describedby={explained} title={t("autopilot.stopHint")} onClick={() => void run("stop", (runtime, id) => runtime.pause(id, "now"))}>
                <Square className="h-3.5 w-3.5" />{t("autopilot.actions.stop")}
              </Button>
            </>
          ) : summary && summary.status !== "completed" && !summary.question ? (
            <Button size="sm" disabled={busy !== null || view.busyInAnotherTab} aria-describedby={profileStop ? profileHintId : undefined} onClick={() => void run("start", (runtime, id) => runtime.start(id))}>
              {busy === "start" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {awaitingPlan ? t("autopilot.actions.approvePlan") : t("autopilot.actions.resume")}
            </Button>
          ) : null}
          <Button asChild size="sm" variant={summary ? "ghost" : "default"}>
            <Link to={pageHref}>{summary ? t("autopilot.openPage") : t("autopilot.actions.start")}</Link>
          </Button>
        </div>
      </div>
      <AutopilotFeed bookId={bookId} limit={80} />
    </div>
  );
}
