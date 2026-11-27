import { useId } from "react";
import type { TFunction } from "i18next";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ReadFirst, ReadFirstReason } from "@/autopilot/resultModel";
import { formatCount } from "@/autopilot/format";
import { chapterLinkClick, type OpenChapter } from "@/autopilot/chapterReading";
import type { TitleOf } from "@/components/autopilot/result/Scores";

/** Why a chapter is on the list, in one line: the lowest score of the book, a score under its average, many rounds of review, or the score and the rounds together. */
function reasonText(t: TFunction, item: ReadFirst): string {
  const values = { score: formatCount(item.score), average: formatCount(item.average), count: item.rounds };
  const key: Record<ReadFirstReason, string> = {
    lowest: "autopilot.result.read.why.lowest",
    below: "autopilot.result.read.why.below",
    rounds: "autopilot.result.read.why.rounds",
    both: "autopilot.result.read.why.both",
    plain: "autopilot.result.read.why.plain",
  };
  return String(t(key[item.reason], values));
}

/**
 * The chapters to read first, each with a line that says why and the way to open it (plain words for a chapter the book does not have yet). The list is named by its
 * heading, and the chapter is told in one text, so that it is not the same words as the plan's row for it.
 */
export function ReadFirstBlock({ bookId, items, linkedSlugs, titleOf, onOpenChapter }: { bookId: string; items: readonly ReadFirst[]; linkedSlugs: ReadonlySet<string>; titleOf: TitleOf; onOpenChapter?: OpenChapter }) {
  const { t } = useTranslation();
  const titleId = useId();
  if (!items.length) return null;
  return (
    <div className="min-w-0 space-y-3">
      <h3 id={titleId} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("autopilot.result.read.title")}</h3>
      <ol aria-labelledby={titleId} className="space-y-3">
        {items.map((item) => {
          const title = titleOf(item.chapter.number)?.trim();
          const label = title ? t("autopilot.result.read.open", { number: item.chapter.number, title }) : t("autopilot.result.read.chapter", { number: item.chapter.number });
          return (
            <li key={item.chapter.number} className="space-y-0.5">
              {linkedSlugs.has(item.chapter.slug)
                ? <Link to={`/app/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(item.chapter.slug)}`} onClick={chapterLinkClick(onOpenChapter, item.chapter.slug)} aria-haspopup={onOpenChapter ? "dialog" : undefined} data-chapter-link={item.chapter.slug} className="inline-flex min-h-6 items-center text-sm font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{label}</Link>
                : <p className="text-sm font-medium">{label}</p>}
              <p className="text-xs text-muted-foreground">{reasonText(t, item)}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
