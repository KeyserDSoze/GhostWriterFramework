import { useSyncExternalStore, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { applyUpdateNow, activateAvailableUpdate } from "@/pwa";
import { localRuns, subscribeLocalRuns } from "@/autopilot/localRuns";
import { useAppUpdateStore } from "@/store/appUpdateStore";

/** What the prompt says and offers while autopilots run in this tab, given their books: it takes the place of the buttons. */
export type UpdateRunsView = ComponentType<{ runs: readonly string[] }>;

let RunsView: UpdateRunsView | null = null;

/**
 * The shell of the app gives the prompt what it says and offers while autopilots run in this tab: that updating now stops them, and to update once
 * they finish instead. A run starts only in the shell, so the entry of the app does not carry it.
 */
export function provideUpdateRunsView(view: UpdateRunsView): void {
  RunsView = view;
}

/**
 * The new version of the app: ready to be installed (a service worker waits), or already the site's while this page runs an older one (a part of
 * it could not be loaded, or another tab installed it). It is applied only when the author chooses, and never by itself over an autopilot that
 * runs in this tab.
 */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const worker = useAppUpdateStore((state) => state.worker);
  const version = useAppUpdateStore((state) => state.version);
  const stale = useAppUpdateStore((state) => state.stale);
  const open = useAppUpdateStore((state) => state.promptOpen);
  const dismiss = useAppUpdateStore((state) => state.dismissPrompt);
  const runs = useSyncExternalStore(subscribeLocalRuns, localRuns, localRuns);

  if (!worker && !stale) return null;
  const Runs = runs.length ? RunsView : null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <DialogContent className="w-[calc(100vw-2rem)] overflow-hidden rounded-3xl sm:max-w-lg">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-br from-primary/20 via-primary/5 to-transparent" />
        <DialogHeader className="relative">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <Sparkles className="h-6 w-6" />
          </div>
          <DialogTitle>{t("pwa.updateTitle")}</DialogTitle>
        </DialogHeader>
        <div className="relative space-y-2">
          <DialogDescription>{t(worker ? "pwa.updateDescription" : "pwa.staleDescription")}</DialogDescription>
          {version && <p className="font-mono text-xs text-primary">v{version}</p>}
        </div>
        {Runs ? <Runs runs={runs} /> : (
          <div className="relative flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            {worker ? (
              <>
                <Button variant="outline" onClick={() => void activateAvailableUpdate(false)}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t("pwa.updateOnly")}
                </Button>
                <Button onClick={() => void activateAvailableUpdate(true)}>
                  <Sparkles className="mr-2 h-4 w-4" />
                  {t("pwa.updateAndViewChanges")}
                </Button>
              </>
            ) : (
              <Button onClick={() => void applyUpdateNow(false)}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t("pwa.reloadNow")}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
