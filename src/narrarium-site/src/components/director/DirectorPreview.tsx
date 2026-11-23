import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Lightbulb } from "lucide-react";
import type { DirectorProfile } from "narrarium-engine";
import { formatCount } from "@/autopilot/format";
import { directorPreview, strictnessCaption } from "@/director/sheetModel";

/**
 * What the values chosen do, in words, worked out from the engine's rules (see `directorPreview`): what happens to a chapter under the approval
 * score and at it, after the last round of review, when the director stops to ask, and to an opinion asked on demand. Strictness is a line of the
 * director's instructions, whose effect on the scores no rule tells: the preview says so instead of guessing. It follows the values as they move,
 * and is not announced while they do (the sliders say their own value).
 */
export function DirectorPreview({ profile }: { profile: Pick<DirectorProfile, "approvalScore" | "maxReviewRounds" | "autonomy" | "strictness"> }) {
  const { t } = useTranslation();
  const titleId = useId();
  const preview = directorPreview(profile);
  const threshold = formatCount(preview.threshold);
  return (
    <section aria-labelledby={titleId} data-director-preview className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-4">
      <h3 id={titleId} className="flex items-center gap-2 text-sm font-semibold"><Lightbulb className="h-4 w-4 text-primary" aria-hidden="true" />{t("director.preview.title")}</h3>
      <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
        <li>{preview.below !== null ? t("director.preview.below", { score: formatCount(preview.below), threshold }) : t("director.preview.none", { threshold })}</li>
        <li>{t("director.preview.at", { threshold })}</li>
        <li>{t("director.preview.rounds", { count: preview.rounds })}</li>
        <li>{t(`director.preview.autonomy.${preview.autonomy}`)}</li>
        <li>{t("director.preview.opinion", { threshold })}</li>
        <li className="text-muted-foreground">{t("director.preview.strictness", { value: formatCount(preview.strictness), caption: t(`director.scale.${strictnessCaption(preview.strictness)}`) })}</li>
      </ul>
    </section>
  );
}
