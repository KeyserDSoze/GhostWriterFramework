import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** What cannot be undone, apart from everything else at the end of the configuration, and asked about before it is done. */
export function DangerZone({ onReset, disabled }: { onReset: () => void; disabled: boolean }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="autopilot-danger-title" className="space-y-2 rounded-xl border border-destructive/40 p-3">
      <h2 id="autopilot-danger-title" className="text-sm font-semibold text-destructive">{t("autopilot.danger.title")}</h2>
      <p className="text-xs text-muted-foreground">{t("autopilot.danger.description")}</p>
      <Button variant="outline" size="sm" className="border-destructive/50 text-destructive hover:text-destructive" disabled={disabled} onClick={onReset}>
        <RotateCcw className="h-4 w-4" />{t("autopilot.actions.reset")}
      </Button>
    </section>
  );
}
