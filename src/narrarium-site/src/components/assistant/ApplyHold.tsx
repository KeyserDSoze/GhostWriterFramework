import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import type { DecisionConflict } from "narrarium-engine";
import "@/i18n/bibleStudio";
import { Button } from "@/components/ui/button";
import { heldLines } from "@/assistant/decisionHold";

/**
 * A change held by a locked decision of the book: nothing was applied. It says which decision each part goes against, and the author decides: apply it anyway (then it is
 * applied, and the decision stays locked), or leave things as they are.
 */
export default function ApplyHold({ conflicts, busy, language, onApply, onLeave }: { conflicts: readonly DecisionConflict[]; busy: boolean; language: string; onApply: () => void; onLeave: () => void }) {
  const { t } = useTranslation();
  const lines = heldLines(conflicts, language);
  return (
    <section role="group" aria-label={t("bibleStudio.hold.region")} data-apply-hold className="mt-2 rounded-xl border border-amber-500/60 bg-amber-50 p-3 text-xs text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
      <p className="flex items-center gap-1.5 font-medium"><Lock className="h-3.5 w-3.5" aria-hidden="true" />{t("bibleStudio.hold.title")}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
      <p className="mt-2">{t("bibleStudio.hold.intro")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onApply}>{t("bibleStudio.hold.apply")}</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onLeave}>{t("bibleStudio.hold.leave")}</Button>
      </div>
    </section>
  );
}
