import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DESIGN_REVIEW_SERVER_VERSION, type ReviewBlock } from "@/outline/designReviewModel";

export interface ReviewRequestProps {
  /** The entries of the Synopsis: their numbers and titles. */
  chapters: ReadonlyArray<{ number: number; title: string }>;
  /** Why a review cannot begin now, or `null`. */
  block: ReviewBlock | null;
  /** The request is on its way. */
  starting: boolean;
  onReview: (chapters?: number[]) => void;
}

/** «Review the design»: a review on request of the whole design, or of one chapter with the chapters beside it. Nothing is rewritten and nothing is written. */
export function ReviewRequest({ chapters, block, starting, onReview }: ReviewRequestProps) {
  const { t } = useTranslation();
  const id = useId();
  const [chapter, setChapter] = useState<string>("");
  const chosen = chapter || String(chapters[0]?.number ?? "");
  const blocked = block !== null || starting;
  return (
    <section aria-labelledby="studio-review-title" data-design-review-request className="space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
      <h2 id="studio-review-title" className="flex items-center gap-2 text-lg font-semibold"><ClipboardCheck className="h-5 w-5 text-primary" aria-hidden="true" />{t("designReview.request.title")}</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("designReview.request.intro")}</p>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-8">
        <div className="flex flex-col gap-1">
          <Button type="button" data-review-whole="" disabled={blocked} aria-describedby={`${id}-whole-hint${block ? ` ${id}-blocked` : ""}`} onClick={() => onReview()}>
            {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ClipboardCheck className="h-4 w-4" aria-hidden="true" />}{t("designReview.request.whole")}
          </Button>
          <p id={`${id}-whole-hint`} className="text-xs text-muted-foreground">{t("designReview.request.wholeHint")}</p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-chapter`} className="text-xs font-medium">{t("designReview.request.chapterLabel")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id={`${id}-chapter`}
              data-review-chapter-select=""
              value={chosen}
              disabled={blocked || chapters.length === 0}
              className="h-9 max-w-full rounded-md border border-field bg-background px-2 text-sm"
              onChange={(event) => setChapter(event.target.value)}
            >
              {chapters.map((entry) => <option key={entry.number} value={entry.number}>{entry.title ? t("designReview.request.chapterOption", { number: entry.number, title: entry.title }) : t("designReview.request.chapterUntitled", { number: entry.number })}</option>)}
            </select>
            <Button type="button" size="sm" variant="outline" data-review-chapter="" disabled={blocked || !chosen} onClick={() => onReview([Number(chosen)])}>{t("designReview.request.chapter")}</Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("designReview.request.chapterHint")}</p>
        </div>
      </div>
      {block && <p id={`${id}-blocked`} data-review-blocked={block} className="text-sm text-muted-foreground">{t(`designReview.request.blocked.${block}`, { version: DESIGN_REVIEW_SERVER_VERSION })}</p>}
    </section>
  );
}
