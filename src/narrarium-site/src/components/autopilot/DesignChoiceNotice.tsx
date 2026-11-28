import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { studioHref } from "@/autopilot/pitchChoice";

/**
 * The design run stopped without a question because the design asks for the author's choice among the pitches: says so, and leads to the Studio, where the pitches are with what
 * the readers and the director said of them. It is not a problem with a profile file, and nothing is wrong: the run goes on when she has chosen and resumes it.
 */
export function DesignChoiceNotice({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="design-choice-title" data-design-choice-notice className="space-y-2 rounded-2xl border border-primary/40 bg-primary/5 p-4 sm:p-5">
      <h2 id="design-choice-title" className="flex items-start gap-2 text-base font-semibold"><Lightbulb className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><span>{t("autopilot.designChoice.title")}</span></h2>
      <p className="text-sm">{t("autopilot.designChoice.body")}</p>
      <Button asChild size="sm"><Link to={studioHref(bookId)}>{t("autopilot.designChoice.open")}</Link></Button>
    </section>
  );
}
