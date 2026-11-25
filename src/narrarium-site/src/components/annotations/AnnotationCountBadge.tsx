import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Highlighter } from "lucide-react";
import "@/i18n/annotations";
import { pendingCounts, type PendingCounts } from "@/annotations/model";
import { useBookAnnotations } from "@/annotations/useBookAnnotations";
import { cn } from "@/lib/utils";

/** How many annotations wait for the author (open or later) in each chapter of a book, and in each of its scenes. */
export function useAnnotationCounts(bookId: string | undefined): (chapter: string) => PendingCounts {
  const { chapters } = useBookAnnotations(bookId);
  const counts = useMemo(() => new Map([...chapters].map(([slug, state]) => [slug, pendingCounts(state.annotations)])), [chapters]);
  return (chapter: string) => counts.get(chapter) ?? { total: 0, byParagraph: {} };
}

export function chapterAnnotationsHref(bookId: string, chapter: string, scene?: string): string {
  return `/app/books/${bookId}/chapters/${chapter}/annotations${scene ? `?scene=${encodeURIComponent(scene)}` : ""}`;
}

/**
 * The count of the annotations to review, as a link to their list: in the lists of chapters and scenes, and on the pages of a chapter and a scene.
 * Nothing when there are none. Its name says what it counts and where («2 annotations to review in The Gate»).
 */
export function AnnotationCountBadge({ to, count, title, variant = "row", className }: { to: string; count: number; title: string; variant?: "row" | "chip"; className?: string }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <Link
      to={to}
      onClick={(event) => event.stopPropagation()}
      aria-label={t("annotations.badge.aria", { count, title })}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-medium transition-colors",
        variant === "chip"
          ? "min-h-7 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs text-primary hover:bg-primary/20 [@media(pointer:coarse)]:min-h-11"
          : "min-h-6 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    >
      <Highlighter className="h-3.5 w-3.5" aria-hidden="true" />
      {variant === "chip" && <span>{t("annotations.badge.chip")}</span>}
      <span className={variant === "chip" ? "rounded-full bg-primary/15 px-1.5 font-semibold tabular-nums" : "tabular-nums"}>{variant === "chip" ? count : t("annotations.badge.label", { count })}</span>
    </Link>
  );
}
