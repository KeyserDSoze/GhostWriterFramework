import { useTranslation } from "react-i18next";
import { RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { activateAvailableUpdate } from "@/pwa";
import { useAppUpdateStore } from "@/store/appUpdateStore";

export function UpdatePrompt() {
  const { t } = useTranslation();
  const worker = useAppUpdateStore((state) => state.worker);
  const version = useAppUpdateStore((state) => state.version);
  const open = useAppUpdateStore((state) => state.promptOpen);
  const dismiss = useAppUpdateStore((state) => state.dismissPrompt);

  if (!worker) return null;

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
          <DialogDescription>{t("pwa.updateDescription")}</DialogDescription>
          {version && <p className="font-mono text-xs text-primary">v{version}</p>}
        </div>
        <div className="relative flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => activateAvailableUpdate(false)}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t("pwa.updateOnly")}
          </Button>
          <Button onClick={() => activateAvailableUpdate(true)}>
            <Sparkles className="mr-2 h-4 w-4" />
            {t("pwa.updateAndViewChanges")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
