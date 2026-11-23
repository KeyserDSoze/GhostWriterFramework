import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConflictFile, WRAP, sideText } from "@/components/autopilot/ConflictFile";
import { CONFLICTS_PAGE as PAGE } from "@/autopilot/githubConflicts";
import type { SyncConflict } from "@/autopilot/store";

/**
 * The files that changed differently on this device and on the server, with a way out: keep this device's version or the
 * server's, for each file or for all of them. Nothing is overwritten until the author chooses; the version not kept is replaced.
 */
export function SyncConflicts({ conflicts, disabled, onResolve }: { conflicts: SyncConflict[]; disabled: boolean; onResolve: (choices: Record<string, "local" | "remote">) => void }) {
  const { t } = useTranslation();
  const headingId = useId();
  const [limit, setLimit] = useState(PAGE);
  if (conflicts.length === 0) return null;

  const choose = (choice: "local" | "remote", files: SyncConflict[]) => onResolve(Object.fromEntries(files.map((file) => [file.path, choice])));
  const chooseAll = (choice: "local" | "remote") => {
    if (window.confirm(t(choice === "local" ? "autopilot.where.keepLocalAllConfirm" : "autopilot.where.keepRemoteAllConfirm", { count: conflicts.length }))) choose(choice, conflicts);
  };
  const shown = conflicts.slice(0, limit);

  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <h3 id={headingId} className="flex items-center gap-1.5 text-sm font-semibold">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-600" aria-hidden />
        {t("autopilot.where.conflictsTitle", { count: conflicts.length })}
      </h3>
      <p className="text-xs text-muted-foreground">{t("autopilot.where.conflictsHint")}</p>
      {conflicts.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className={WRAP} disabled={disabled} onClick={() => chooseAll("local")}>{t("autopilot.where.keepLocalAll", { count: conflicts.length })}</Button>
          <Button size="sm" variant="outline" className={WRAP} disabled={disabled} onClick={() => chooseAll("remote")}>{t("autopilot.where.keepRemoteAll", { count: conflicts.length })}</Button>
        </div>
      )}
      <ul aria-labelledby={headingId} className="space-y-2">
        {shown.map((conflict) => (
          <ConflictFile key={conflict.path} path={conflict.path} line={t("autopilot.where.conflictLine", { local: sideText(t, conflict.local, conflict.localBytes), remote: sideText(t, conflict.remote, conflict.remoteBytes) })}>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className={WRAP} disabled={disabled} aria-label={t("autopilot.where.keepLocalFor", { path: conflict.path })} onClick={() => choose("local", [conflict])}>{t("autopilot.where.keepLocal")}</Button>
              <Button size="sm" variant="outline" className={WRAP} disabled={disabled} aria-label={t("autopilot.where.keepRemoteFor", { path: conflict.path })} onClick={() => choose("remote", [conflict])}>{t("autopilot.where.keepRemote")}</Button>
            </div>
          </ConflictFile>
        ))}
      </ul>
      {conflicts.length > limit && (
        <Button size="sm" variant="ghost" className="w-full" onClick={() => setLimit((current) => current + PAGE)}>
          {t("autopilot.plan.run.showMore", { count: Math.min(PAGE, conflicts.length - limit) })}
        </Button>
      )}
    </div>
  );
}
