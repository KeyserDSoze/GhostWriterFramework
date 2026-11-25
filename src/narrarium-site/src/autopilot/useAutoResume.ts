import { useEffect } from "react";
import i18n from "@/i18n";
import { toast } from "@/components/ui/use-toast";
import { interruptedRuns } from "@/autopilot/resume";
import type { ResumeReport } from "@/autopilot/runtime";
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { useSettingsStore } from "@/store/settingsStore";

/** The reasons the author is told when a run is left to them; the others need no word (they paused it, it moved, it runs elsewhere). */
const TOLD = new Set(["no-working-copy", "no-ai", "crash-loop"]);

function tell(report: ResumeReport): void {
  const books = useSettingsStore.getState().settings.books;
  const book = books.find((entry) => entry.id === report.intent.bookId)?.name ?? report.intent.bookId;
  const { decision } = report;
  if (report.error) {
    toast({ title: i18n.t("autopilot.resume.failed", { book }), description: report.error, variant: "destructive" });
  } else if (decision.kind === "resume") {
    toast({ title: i18n.t("autopilot.resume.resumed"), description: report.intent.step ? i18n.t("autopilot.resume.resumedStep", { book, step: report.intent.step }) : i18n.t("autopilot.resume.resumedBook", { book }) });
  } else if (decision.kind === "wait" && decision.reason === "offline") {
    toast({ title: i18n.t("autopilot.resume.offline", { book }) });
  } else if (decision.kind === "skip" && TOLD.has(decision.reason)) {
    toast({ title: i18n.t("autopilot.resume.notResumed", { book }), description: i18n.t(`autopilot.resume.reason.${decision.reason}`), variant: "destructive" });
  }
}

/**
 * When the app starts (a reload, an update, a browser opened again) with runs this browser was running when the page ended, it resumes them by
 * itself once the settings are loaded, and says so: which book, and what it was doing. The autopilot is loaded only then. A device that is offline
 * waits for the connection to come back.
 */
export function useAutoResume(): void {
  const ready = useSettingsStore((state) => state.cloudLoaded);
  const generation = useSettingsStore((state) => state.accountGeneration);
  useEffect(() => {
    if (!ready || !interruptedRuns(currentRepositoryScopeIdentity()).length) return undefined;
    let cancelled = false;
    let waiting = false;
    const resume = async () => {
      const { loadAutopilotRuntime } = await import("@/autopilot/loader");
      const runtime = await loadAutopilotRuntime();
      if (cancelled) return;
      const reports = await runtime.resumeInterrupted();
      if (cancelled) return;
      for (const report of reports) tell(report);
      if (reports.some((report) => report.decision.kind === "wait" && report.decision.reason === "offline") && !waiting) {
        waiting = true;
        window.addEventListener("online", () => { waiting = false; if (!cancelled) void resume().catch(() => undefined); }, { once: true });
      }
    };
    void resume().catch(() => undefined);
    return () => { cancelled = true; };
  }, [ready, generation]);
}
