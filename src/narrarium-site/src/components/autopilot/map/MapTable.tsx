import { memo, useId } from "react";
import { useTranslation } from "react-i18next";
import { PanelRightOpen } from "lucide-react";
import { SCENE_STATES } from "@/autopilot/chapterMapModel";
import { formatCount } from "@/autopilot/format";
import { chapterStateText, type MapRowModel } from "@/components/autopilot/map/MapGrid";
import { Button } from "@/components/ui/button";

export interface MapTableProps {
  rows: MapRowModel[];
  caption: string;
  ghostwriterName: (slug: string) => string;
  onOpen: (index: number, opener: HTMLElement) => void;
}

/**
 * The same chapters as the map, as a real table: a row for each chapter, its state and the state of its scenes in words, the director's vote, the rounds
 * of review and what marks it (frozen, from the author's Outline, its ghostwriter, written by the author, in progress), with the button that opens the
 * same panel. For whoever prefers words to symbols, a screen reader first of all.
 */
export const MapTable = memo(function MapTable({ rows, caption, ghostwriterName, onOpen }: MapTableProps) {
  const { t } = useTranslation();
  const id = useId();
  const none = t("autopilot.map.table.none");
  return (
    <div role="region" aria-labelledby={`${id}-caption`} tabIndex={0} className="relative max-h-[min(28rem,60dvh)] overflow-auto rounded-lg border border-layer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <table className="w-full border-collapse text-sm">
        <caption id={`${id}-caption`} className="px-2 py-1.5 text-left text-xs text-muted-foreground">{caption}</caption>
        <thead className="sticky top-0 bg-card">
          <tr className="border-b text-xs text-muted-foreground">
            {(["chapter", "state", "scenes", "director", "rounds", "notes", "details"] as const).map((key) => (
              <th key={key} scope="col" className={key === "director" || key === "rounds" ? "px-2 py-1.5 text-right font-medium" : "px-2 py-1.5 text-left font-medium"}>{t(`autopilot.map.table.${key}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { chapter } = row;
            const counts = new Map<string, number>();
            for (const state of row.scenes) counts.set(state, (counts.get(state) ?? 0) + 1);
            const scenes = SCENE_STATES.filter((state) => counts.has(state)).map((state) => t(`autopilot.map.sceneCount.${state}`, { count: counts.get(state) })).join(", ");
            const notes = [
              row.frozen ? t("autopilot.map.frozen") : null,
              row.origin === "author" ? t("autopilot.map.outline") : null,
              chapter.ghostwriter ? t("autopilot.plan.ghostwriter", { name: ghostwriterName(chapter.ghostwriter) }) : null,
              row.current ? t("autopilot.map.current") : null,
            ].filter(Boolean).join(" · ");
            return (
              <tr key={`${chapter.number}:${chapter.slug}`} data-chapter={chapter.number} className="border-b align-top last:border-b-0">
                <th scope="row" className="min-w-[10rem] px-2 py-1.5 text-left font-medium"><span className="tabular-nums">{chapter.number}.</span> {chapter.title}</th>
                <td className="px-2 py-1.5">{chapterStateText(t, row)}</td>
                <td className="px-2 py-1.5">{scenes || t("autopilot.map.noScenes")}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{typeof chapter.score === "number" ? formatCount(chapter.score) : <><span aria-hidden="true">—</span><span className="sr-only">{none}</span></>}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{formatCount(chapter.rounds?.length ?? 0)}</td>
                <td className="px-2 py-1.5 text-xs">{notes}</td>
                <td className="px-2 py-1">
                  <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" aria-label={t("autopilot.map.table.open", { number: chapter.number })} onClick={(event) => onOpen(row.index, event.currentTarget)}>
                    <PanelRightOpen className="h-4 w-4" aria-hidden="true" />{t("autopilot.map.table.details")}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
