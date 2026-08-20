import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDiff } from "@/components/diff/DiffView";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { RepositorySyncConflict, RepositorySyncConflictResolution } from "@/repository/repositoryService";

export function RepositorySyncConflictDialog({
  conflicts,
  busy,
  onCancel,
  onApply,
}: {
  conflicts: RepositorySyncConflict[];
  busy: boolean;
  onCancel: () => void;
  onApply: (resolutions: Record<string, RepositorySyncConflictResolution>) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [resolutions, setResolutions] = useState<Record<string, RepositorySyncConflictResolution>>({});

  useEffect(() => setResolutions({}), [conflicts]);

  const complete = conflicts.length > 0 && conflicts.every((conflict) => resolutions[conflict.path]);
  return (
    <Dialog open={conflicts.length > 0} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("repoStatus.conflictsTitle")}</DialogTitle>
          <DialogDescription>{t("repoStatus.conflictsDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {conflicts.map((conflict) => {
            const local = conflict.localDeleted ? t("repoStatus.fileDeletedLocally") : conflict.localContent;
            const remote = conflict.remoteDeleted ? t("repoStatus.fileDeletedRemotely") : conflict.remoteContent;
            return (
              <section key={conflict.path} className="space-y-3 rounded-xl border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="break-all font-mono text-sm font-semibold">{conflict.path}</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant={resolutions[conflict.path] === "local" ? "default" : "outline"} disabled={busy} onClick={() => setResolutions((current) => ({ ...current, [conflict.path]: "local" }))}>{t("repoStatus.keepLocal")}</Button>
                    <Button size="sm" variant={resolutions[conflict.path] === "remote" ? "default" : "outline"} disabled={busy} onClick={() => setResolutions((current) => ({ ...current, [conflict.path]: "remote" }))}>{t("repoStatus.keepRemote")}</Button>
                  </div>
                </div>
                {conflict.kind === "text" ? (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">{t("repoStatus.diffDirection")}</p>
                    <FileDiff previous={local ?? ""} next={remote ?? ""} className="max-h-72" />
                  </div>
                ) : <p className="text-sm text-muted-foreground">{t("repoStatus.binaryConflict")}</p>}
              </section>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>{t("common.cancel")}</Button>
          <Button disabled={!complete || busy} onClick={() => void onApply(resolutions)}>{t("repoStatus.applyConflictChoices")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
