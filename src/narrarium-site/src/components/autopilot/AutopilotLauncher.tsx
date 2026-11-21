import { useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plane } from "lucide-react";
import { parseAppRoute } from "@/assistant/context";
import { autopilotChannel, useAutopilotStore } from "@/autopilot/store";
import { cn } from "@/lib/utils";

/** Bottom-right ticker next to the Copilot: what the autopilot is doing now; opens the live dock. */
export function AutopilotLauncher() {
  const { t } = useTranslation();
  const location = useLocation();
  const dockOpen = useAutopilotStore((state) => state.dockOpen);
  const setDockOpen = useAutopilotStore((state) => state.setDockOpen);
  const live = useAutopilotStore((state) => state.live);
  const summaries = useAutopilotStore((state) => state.summaries);
  const route = parseAppRoute(location.pathname);
  const bookId = "bookId" in route ? route.bookId : undefined;

  useEffect(() => {
    // Follow runs started in other tabs of this browser.
    autopilotChannel();
  }, []);

  const current = useMemo(() => (bookId ? live[bookId] : null) ?? Object.values(live).find(Boolean) ?? null, [bookId, live]);
  const waiting = useMemo(() => Object.values(summaries).some((summary) => summary.status === "waiting-author"), [summaries]);
  const label = current ? current.activity.title : t("autopilot.launcher");

  return (
    <button
      type="button"
      onClick={() => setDockOpen(!dockOpen)}
      aria-expanded={dockOpen}
      aria-label={t("autopilot.openDock")}
      title={current ? `${t("autopilot.openDock")} — ${current.activity.title}` : t("autopilot.openDock")}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-full border bg-card px-3 py-2.5 text-sm font-medium text-card-foreground shadow-lg transition hover:bg-accent",
        dockOpen && "border-primary/50 bg-accent",
      )}
    >
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        <Plane className="h-4 w-4" />
        {(current || waiting) && (
          <span className={cn("absolute -right-1 -top-1 h-2 w-2 rounded-full", current ? "animate-pulse bg-emerald-500" : "bg-amber-500")} aria-hidden />
        )}
      </span>
      <span className="hidden max-w-[16rem] truncate sm:inline">{label}</span>
    </button>
  );
}
