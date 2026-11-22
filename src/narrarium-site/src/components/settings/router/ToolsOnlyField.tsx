import { useEffect, useId, useMemo, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toolsOnlyReport } from "@/router/toolsOnly";
import type { AppSettings } from "@/types/settings";

/** The id of the switch: the link `#tools-only` of the error panel of the autopilot leads to it. */
export const TOOLS_ONLY_ID = "tools-only";

/**
 * A link to `#its-id` does not scroll by itself in the app, so the page does it: the element comes into view and takes the focus, which is where a keyboard or a screen
 * reader starts reading. The element may be drawn a moment after the page, so it is looked for during a few frames.
 */
function useFocusOnHash(id: string, ref: RefObject<HTMLElement>): void {
  const location = useLocation();
  useEffect(() => {
    if (decodeURIComponent(location.hash.replace(/^#/, "")) !== id) return undefined;
    let frame = 0;
    const look = (frames: number) => {
      const element = ref.current;
      if (element) {
        element.scrollIntoView?.({ block: "center" });
        element.focus({ preventScroll: true });
      } else if (frames > 0 && typeof requestAnimationFrame === "function") {
        frame = requestAnimationFrame(() => look(frames - 1));
      }
    };
    look(10);
    return () => { if (frame) cancelAnimationFrame(frame); };
  }, [location.hash, location.key, id, ref]);
}

/**
 * «Tools only» for the autopilot, at the top of the page of the Router: the switch, what it does, and what it means for the models of the tasks of the autopilot that cannot
 * call functions. The warnings are one status that is there from the start and changes only when the settings do, so that a change is said once and nothing talks on its own.
 * What is switched is stored as a flag, so that two devices that merge their settings never lose it.
 */
export function ToolsOnlyField({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  const { t } = useTranslation();
  const hintId = useId();
  const control = useRef<HTMLButtonElement>(null);
  useFocusOnHash(TOOLS_ONLY_ID, control);
  const report = useMemo(() => toolsOnlyReport(settings), [settings]);
  const taskName = (task: string) => t(`routing.task.${task}`);
  const anything = report.blocked.length > 0 || report.skipped.length > 0;

  return (
    <div className="space-y-2 rounded-lg border border-layer bg-card p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={TOOLS_ONLY_ID} className="text-sm font-medium">{t("routing.toolsOnly.label")}</Label>
          <p id={hintId} className="text-xs text-muted-foreground">{t("routing.toolsOnly.hint")}</p>
        </div>
        <Switch id={TOOLS_ONLY_ID} ref={control} aria-describedby={hintId} checked={settings.aiToolsOnly !== false} onCheckedChange={(aiToolsOnly) => patchSettings({ aiToolsOnly })} />
      </div>
      <div role="status" data-tools-only-notes className="space-y-1 text-xs">
        {report.blocked.length > 0 && (
          <p className="flex items-start gap-1 text-red-700 dark:text-red-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t("routing.toolsOnly.blocked", { count: report.blocked.length, tasks: report.blocked.map(taskName).join(", ") })}
          </p>
        )}
        {report.skipped.map((entry) => (
          <p key={entry.task} className="flex items-start gap-1 text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t("routing.toolsOnly.skipped", { task: taskName(entry.task), models: entry.models.join(", ") })}
          </p>
        ))}
        {anything && <p className="text-muted-foreground">{t("routing.toolsOnly.remedy")}</p>}
      </div>
    </div>
  );
}
