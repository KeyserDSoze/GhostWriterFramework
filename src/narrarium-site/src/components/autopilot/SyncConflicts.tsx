import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/autopilot/format";
import type { ConflictSide, SyncConflict } from "@/autopilot/store";

/** Conflicts are listed this many at a time: a first sync of two books that diverged can have thousands. */
const PAGE = 50;
/** The labels are sentences: they wrap instead of running out of the card, whatever the language. */
const WRAP = "h-auto min-h-9 whitespace-normal py-1.5 text-left";

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
  const side = (state: ConflictSide, bytes: number | undefined) => bytes === undefined ? t(`autopilot.where.side.${state}`) : t("autopilot.where.sideSize", { state: t(`autopilot.where.side.${state}`), size: formatBytes(bytes) });
  const shown = conflicts.slice(0, limit);

  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <h3 id={headingId} className="flex items-center gap-1.5 text-sm font-semibold">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
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
          <li key={conflict.path} className="space-y-1.5 rounded-md border bg-background/70 p-2">
            <code className="block break-all text-xs">{conflict.path}</code>
            <p className="text-xs text-muted-foreground">{t("autopilot.where.conflictLine", { local: side(conflict.local, conflict.localBytes), remote: side(conflict.remote, conflict.remoteBytes) })}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className={WRAP} disabled={disabled} aria-label={t("autopilot.where.keepLocalFor", { path: conflict.path })} onClick={() => choose("local", [conflict])}>{t("autopilot.where.keepLocal")}</Button>
              <Button size="sm" variant="outline" className={WRAP} disabled={disabled} aria-label={t("autopilot.where.keepRemoteFor", { path: conflict.path })} onClick={() => choose("remote", [conflict])}>{t("autopilot.where.keepRemote")}</Button>
            </div>
          </li>
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
