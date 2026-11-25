import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/i18n/brainstorm";
import { BrainstormMark } from "@/components/assistant/brainstorm/BrainstormMark";
import { Button } from "@/components/ui/button";

/**
 * Brainstorming's own parts of the Copilot panel: loaded the first time the panel is in that mode, which only the Synopsis page opens, so the panel
 * carries none of them.
 */

/** Who is speaking: Brainstorming's mark and name, on what. */
export function BrainstormIdentity({ book }: { book: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"><BrainstormMark className="h-4 w-4" /></div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold leading-tight">{t("brainstorm.name")}</p>
        <p className="truncate text-xs leading-tight text-muted-foreground">{book ? t("brainstorm.context", { book }) : t("brainstorm.tagline")}</p>
      </div>
    </div>
  );
}

/** The way back to the Copilot, always in the header: the Copilot's chat comes back as it was. */
export function BrainstormBack({ onBack, disabled }: { onBack: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <Button type="button" variant="outline" size="sm" className="h-8 gap-1 px-2" aria-label={t("brainstorm.back")} title={t("brainstorm.back")} onClick={onBack} disabled={disabled} data-brainstorm-back="">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      <span className="sm:hidden">{t("assistant.floatingButton")}</span>
      <span className="hidden sm:inline">{t("brainstorm.back")}</span>
    </Button>
  );
}

/** What an empty chat of Brainstorming says it can do. */
export function BrainstormEmpty() {
  const { t } = useTranslation();
  return <div className="rounded-2xl border border-dashed border-primary/60 p-5 text-sm text-muted-foreground">{t("brainstorm.empty")}</div>;
}
