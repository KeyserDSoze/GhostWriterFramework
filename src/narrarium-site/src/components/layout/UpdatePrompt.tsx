import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function UpdatePrompt() {
  const { t } = useTranslation();
  const [worker, setWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    const onUpdate = (event: WindowEventMap["narrarium:update-available"]) => {
      setWorker(event.detail.worker);
    };
    window.addEventListener("narrarium:update-available", onUpdate);
    return () => window.removeEventListener("narrarium:update-available", onUpdate);
  }, []);

  if (!worker) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[80] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 rounded-2xl border bg-card p-4 text-card-foreground shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{t("pwa.updateTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("pwa.updateDescription")}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setWorker(null)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="mt-3 flex justify-end">
        <Button onClick={() => worker.postMessage({ type: "SKIP_WAITING" })}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t("pwa.updateNow")}
        </Button>
      </div>
    </div>
  );
}
