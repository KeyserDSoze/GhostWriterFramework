import "@/i18n/shell";
import { useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plane } from "lucide-react";
import { parseAppRoute } from "@/assistant/context";
import { activityTitle } from "@/autopilot/format";
import { isAutopilotPage } from "@/autopilot/pageRoute";
import { isProfileProblemStop } from "@/autopilot/stopReason";
import { autopilotChannel, useAutopilotStore } from "@/autopilot/store";
import { activeCounts } from "@/autopilot/activeBooks";
import { useActiveBooks } from "@/autopilot/useActiveBooks";
import { cn } from "@/lib/utils";

/**
 * Bottom-right ticker next to the Copilot: what the autopilot is doing now; opens the live panel. With more than one book running it says how many
 * autopilots run, and its name says which books and how many wait for the author, so that the runs of the other books are never out of sight. On
 * the pages of the autopilot, which show all of it, it is a small button without the words: it brings the panel back, for as long as the author
 * stays on those pages.
 */
export function AutopilotLauncher() {
  const { t } = useTranslation();
  const location = useLocation();
  const onPage = isAutopilotPage(location.pathname);
  const dockOpen = useAutopilotStore((state) => state.dockOpen);
  const setDockOpen = useAutopilotStore((state) => state.setDockOpen);
  const pageDockOpen = useAutopilotStore((state) => state.pageDockOpen);
  const setPageDockOpen = useAutopilotStore((state) => state.setPageDockOpen);
  const live = useAutopilotStore((state) => state.live);
  const summaries = useAutopilotStore((state) => state.summaries);
  const route = parseAppRoute(location.pathname);
  const bookId = "bookId" in route ? route.bookId : undefined;
  const open = onPage ? pageDockOpen : dockOpen;

  useEffect(() => {
    // Follow runs started in other tabs of this browser.
    autopilotChannel();
  }, []);

  // What the author brought back on a page of the autopilot is for that page: it is forgotten when they leave.
  useEffect(() => {
    if (!onPage && useAutopilotStore.getState().pageDockOpen) setPageDockOpen(false);
  }, [onPage, setPageDockOpen]);

  const current = useMemo(() => (bookId ? live[bookId] : null) ?? Object.values(live).find(Boolean) ?? null, [bookId, live]);
  const waiting = useMemo(() => Object.values(summaries).some((summary) => summary.status === "waiting-author"), [summaries]);
  // A book that waits without a question has a profile file with problems: said in words, since the amber dot is only a colour.
  const profileProblems = useMemo(() => Object.values(summaries).some(isProfileProblemStop), [summaries]);
  const stopped = !current && profileProblems ? t("autopilot.launcherProfileProblems") : null;
  const counts = activeCounts(useActiveBooks());
  const many = counts.running > 1 ? t("autopilot.launcherRunning", { count: counts.running }) : null;
  const label = many ?? (current ? activityTitle(t, current.activity) : counts.running === 1 ? t("autopilot.launcherRunning", { count: 1 }) : stopped ?? t("autopilot.launcher"));
  // The name says what the eye reads from the words and the dot: how many run and which books, how many wait for the author, the profiles to correct.
  const parts = [
    counts.running > 0 ? `${t("autopilot.launcherRunning", { count: counts.running })} (${counts.names.join(", ")})` : null,
    counts.attention > 0 ? t("autopilot.launcherAttention", { count: counts.attention }) : null,
    stopped,
  ].filter(Boolean);
  const name = parts.length ? `${t("autopilot.openDock")}: ${parts.join(" · ")}` : t("autopilot.openDock");

  return (
    <button
      type="button"
      onClick={() => (onPage ? setPageDockOpen(!pageDockOpen) : setDockOpen(!dockOpen))}
      aria-expanded={open}
      aria-label={name}
      title={current && !many ? `${t("autopilot.openDock")} — ${activityTitle(t, current.activity)}` : name}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-full border border-layer bg-card px-3 py-2.5 text-sm font-medium text-card-foreground shadow-lg transition hover:bg-accent",
        open && "border-primary/50 bg-accent",
      )}
    >
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        <Plane className="h-4 w-4" />
        {(current || waiting || counts.running > 0 || counts.attention > 0) && (
          <span className={cn("absolute -right-1 -top-1 h-2 w-2 rounded-full", counts.attention > 0 || (waiting && !current) ? "bg-amber-500" : "motion-safe:animate-pulse bg-emerald-500")} aria-hidden />
        )}
      </span>
      {!onPage && <span data-launcher-label className="hidden max-w-[16rem] truncate sm:inline">{label}</span>}
      {!onPage && counts.running > 1 && <span aria-hidden="true" className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-700 px-1 text-xs font-semibold tabular-nums text-white sm:hidden">{counts.running}</span>}
    </button>
  );
}
