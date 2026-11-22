import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, Clapperboard, Laptop, Loader2, Plane, Server } from "lucide-react";
import { summarizeAutopilotState, type AutopilotStateSummary } from "narrarium-engine";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AutopilotFeed, AutopilotStatusBadge } from "@/components/autopilot/AutopilotFeed";
import { ProfileProblemsNotice, RunErrorNotice } from "@/components/autopilot/StopNotices";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { useAutopilotStore } from "@/autopilot/store";
import { useServerConnection } from "@/autopilot/serverConnection";
import { activityTitle, autopilotSummaryLine } from "@/autopilot/format";
import { isErrorKind } from "@/autopilot/errorModel";
import { isProfileProblemStop } from "@/autopilot/stopReason";
import { useSettingsStore } from "@/store/settingsStore";

/** Every book's autopilot at a glance, plus everything that happens, live. */
export function AutopilotHubPage() {
  const { t } = useTranslation();
  const books = useSettingsStore((state) => state.settings.books);
  const views = useAutopilotStore((state) => state.views);
  const summaries = useAutopilotStore((state) => state.summaries);
  const live = useAutopilotStore((state) => state.live);
  const server = useServerConnection();
  const bookIds = useMemo(() => books.map((book) => book.id).join(","), [books]);

  useEffect(() => {
    let cancelled = false;
    void loadAutopilotRuntime().then(async (runtime) => {
      runtime.ensureServerStream();
      for (const id of bookIds.split(",").filter(Boolean)) {
        if (cancelled) return;
        await runtime.refresh(id, { join: true });
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [bookIds]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold tracking-tight"><Plane className="h-6 w-6 text-primary" />{t("autopilot.title")}</h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">{t("autopilot.hubDescription")}</p>
        </div>
        <Link to="/app/settings/server" className="flex items-center gap-2 rounded-xl border border-layer bg-card px-3 py-2 text-sm shadow-sm transition hover:bg-accent">
          <Server className="h-4 w-4 text-primary" />
          <span>{t("autopilot.hub.server")}</span>
          <Badge variant="outline">{t(`personalServer.status.${server.status}`)}</Badge>
          {server.status === "online" && server.updates?.available && server.updates.latestVersion && (
            <Badge className="border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300">{t("autopilot.hub.serverUpdate", { version: server.updates.latestVersion })}</Badge>
          )}
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("autopilot.hub.books")}</h2>
          {books.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("autopilot.hub.noBooks")}</p>
          ) : (
            <ul className="space-y-2">
              {books.map((book) => {
                const view = views[book.id];
                const state = view?.snapshot?.state ?? null;
                const summary: AutopilotStateSummary | null = summaries[book.id] && (!state || summaries[book.id].updatedAt > state.updatedAt) ? summaries[book.id] : state ? summarizeAutopilotState(state) : null;
                const current = live[book.id];
                const host = book.autopilotHost === "server" ? "server" : "browser";
                return (
                  <li key={book.id} className="space-y-2 rounded-xl border border-layer bg-card p-3 shadow-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-medium">{book.name}</span>
                      {view?.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                      <Badge variant="outline" className="gap-1">{host === "server" ? <Server className="h-3 w-3" /> : <Laptop className="h-3 w-3" />}{t(`autopilot.host.${host}`)}</Badge>
                      <AutopilotStatusBadge status={summary?.status} />
                    </div>
                    {summary && (
                      <p className="text-xs text-muted-foreground">
                        {autopilotSummaryLine(t, summary)}
                      </p>
                    )}
                    {isProfileProblemStop(summary) && <ProfileProblemsNotice bookId={book.id} message={summary?.message} compact />}
                    {summary?.status === "error" && summary.lastError && <RunErrorNotice bookId={book.id} message={summary.lastError.message} kind={isErrorKind(summary.lastError.kind ?? summary.lastError.errorKind) ? summary.lastError.kind ?? summary.lastError.errorKind : undefined} />}
                    {current && <p className="truncate text-xs"><span className="font-medium text-primary">{t("autopilot.feed.now")}:</span> {activityTitle(t, current.activity)}</p>}
                    {!summary && view?.error && <p className="text-xs text-muted-foreground">{view.error}</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button asChild size="sm" variant="outline"><Link to={`/app/books/${encodeURIComponent(book.id)}/autopilot`}><Plane className="h-3.5 w-3.5" />{t("autopilot.hub.open")}</Link></Button>
                      <Button asChild size="sm" variant="ghost"><Link to={`/app/books/${encodeURIComponent(book.id)}/director`}><Clapperboard className="h-3.5 w-3.5" />{t("director.title")}</Link></Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("autopilot.dockTitle")}</h2>
          <AutopilotFeed showBook limit={200} />
        </section>
      </div>
    </div>
  );
}
