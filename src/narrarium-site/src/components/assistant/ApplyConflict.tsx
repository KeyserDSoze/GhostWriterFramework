import { useTranslation } from "react-i18next";
import "@/i18n/copilotApply";
import { Button } from "@/components/ui/button";
import type { AssistantFileUpdate } from "@/assistant/store";

export interface ApplyConflictProps {
  /** The files the apply stopped on, because they changed after the proposal was made. */
  updates: AssistantFileUpdate[];
  busy: boolean;
  onKeepMine: (path: string) => void;
  onUseProposal: (path: string) => void;
}

/**
 * A file the proposal touches changed after it was proposed (edits of the author's that are not saved as a change yet, or a saved change): never a refusal. The
 * author chooses, for each file, between what is there now and the proposal; the one that is not kept stays available (with Undo, or as it is).
 */
export default function ApplyConflict({ updates, busy, onKeepMine, onUseProposal }: ApplyConflictProps) {
  const { t } = useTranslation();
  if (!updates.length) return null;
  return (
    <section role="group" aria-label={t("copilotApply.conflictChoice.title")} data-apply-conflict className="mt-2 rounded-xl border border-amber-500/60 bg-amber-50 p-3 text-xs text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
      <p className="font-medium">{t("copilotApply.conflictChoice.title")}</p>
      <ul className="mt-2 space-y-3">
        {updates.map((update) => (
          <li key={update.path} data-apply-conflict-file={update.path}>
            <p>{t(`copilotApply.conflictChoice.${update.conflict ?? "changed"}`, { file: update.path })}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={busy} aria-label={t("copilotApply.conflictChoice.keepMineFor", { file: update.path })} onClick={() => onKeepMine(update.path)}>{t("copilotApply.conflictChoice.keepMine")}</Button>
              <Button type="button" size="sm" disabled={busy} aria-label={t("copilotApply.conflictChoice.useProposalFor", { file: update.path })} onClick={() => onUseProposal(update.path)}>{t("copilotApply.conflictChoice.useProposal")}</Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
