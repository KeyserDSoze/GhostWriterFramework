import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { autoResumeOn } from "@/autopilot/resume";
import { localRuns, subscribeLocalRuns } from "@/autopilot/localRuns";
import { applyUpdateNow } from "@/pwa";
import { useAppUpdateStore } from "@/store/appUpdateStore";

let stopWaiting: (() => void) | null = null;

/**
 * «Update when they finish»: the update is applied as soon as no autopilot runs in this tab (at once when none does). When it cannot be applied
 * (what is being edited could not be saved) the prompt opens again.
 */
export function updateWhenRunsFinish(): void {
  useAppUpdateStore.setState({ promptOpen: false });
  if (stopWaiting) return;
  const check = () => {
    if (localRuns().length > 0) return;
    stopWaiting?.();
    stopWaiting = null;
    void applyUpdateNow(false).then((applied) => { if (!applied) useAppUpdateStore.getState().openPrompt(); });
  };
  stopWaiting = subscribeLocalRuns(check);
  check();
}

/**
 * What the prompt of a new version says and offers while autopilots run in this tab (see `provideUpdateRunsView`): updating now stops them, and
 * they resume by themselves after the reload unless the author turned that off for one of them on this device; or the update waits for them to
 * finish. Its texts come with the autopilot, which is loaded whenever one runs.
 */
export function UpdatePromptRuns({ runs }: { runs: readonly string[] }) {
  const { t } = useTranslation();
  const count = runs.length;
  const resume = runs.every((bookId) => autoResumeOn(bookId));
  const later = () => {
    updateWhenRunsFinish();
    toast({ title: t("autopilot.update.scheduled", { count }) });
  };
  return (
    <>
      <p data-update-runs className="relative rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
        {t(resume ? "autopilot.update.runsStopResume" : "autopilot.update.runsStop", { count })}
      </p>
      <div className="relative flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => void applyUpdateNow(false)}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t("autopilot.update.now")}
        </Button>
        <Button onClick={later}>{t("autopilot.update.later", { count })}</Button>
      </div>
    </>
  );
}
