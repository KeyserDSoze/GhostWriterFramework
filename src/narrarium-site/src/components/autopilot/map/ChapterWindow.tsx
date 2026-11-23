import { useCallback, useId, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import type { PlannedChapter } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { chapterMatches, pageStart } from "@/autopilot/chapterMapModel";
import { formatCount } from "@/autopilot/format";

export interface ChapterWindow {
  query: string;
  setQuery: (query: string) => void;
  /** The positions in the plan of the chapters on the screen, in order. */
  visible: number[];
  /** The first position of the window among the chapters found (all of them without a search). */
  first: number;
  /** How many chapters there are to page through: the ones found, or all. */
  total: number;
  size: number;
  /** Whether the controls are worth showing: the plan is longer than a window, or something is being searched. */
  windowed: boolean;
  move: (first: number) => void;
  /** Show the chapter with this number (the search is cleared for it); its position, or `null` when the plan has no such chapter. */
  jump: (number: number) => number | null;
}

/**
 * A window of `size` chapters over the chapters of a plan, as the outline has: the window that holds the chapter at `follow` until the author moves
 * it, a search by number or by the words of a title, and a jump to a number. Only the chapters of the window are drawn: a plan has no maximum number
 * of chapters, and a book of thousands of chapters opens as fast as one of ten.
 */
export function useChapterWindow(chapters: ReadonlyArray<Pick<PlannedChapter, "number" | "title">>, size: number, follow: number): ChapterWindow {
  const [query, setQueryState] = useState("");
  const [start, setStart] = useState<number | null>(null);
  const matches = useMemo(() => chapterMatches(chapters, query), [chapters, query]);
  const total = matches ? matches.length : chapters.length;
  const wanted = start ?? (matches ? 0 : pageStart(follow, size));
  const first = Math.max(0, Math.min(wanted, Math.floor(Math.max(0, total - 1) / size) * size));
  const visible = useMemo(() => {
    const positions: number[] = [];
    for (let position = first; position < Math.min(total, first + size); position += 1) positions.push(matches ? matches[position] : position);
    return positions;
  }, [first, total, size, matches]);
  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setStart(0);
  }, []);
  const jump = useCallback((number: number) => {
    const index = chapters.findIndex((chapter) => chapter.number === number);
    if (index < 0) return null;
    setQueryState("");
    setStart(pageStart(index, size));
    return index;
  }, [chapters, size]);
  return { query, setQuery, visible, first, total, size, windowed: chapters.length > size || query.trim() !== "", move: setStart, jump };
}

/**
 * The controls of a window of chapters: the search, the jump to a number and the pages, each with its name. What the search found is said under it,
 * and a jump to a chapter the plan does not have is said in words (the page moves the focus to the chapter it finds).
 */
export function ChapterWindowControls({ window: view, onJumped }: { window: ChapterWindow; onJumped: (index: number) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [jumpTo, setJumpTo] = useState("");
  const [missing, setMissing] = useState<number | null>(null);
  if (!view.windowed) return null;
  const searching = view.query.trim() !== "";
  const last = Math.min(view.total, view.first + view.size);
  const previous = Math.max(0, view.first - view.size);
  const next = view.first + view.size;
  const jump = (event: FormEvent) => {
    event.preventDefault();
    const number = Number(jumpTo.trim());
    if (!Number.isSafeInteger(number) || number < 1) return;
    const index = view.jump(number);
    setMissing(index === null ? number : null);
    if (index !== null) onJumped(index);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="min-w-[12rem] flex-1 space-y-1">
          <Label htmlFor={`${id}-find`} className="text-xs">{t("autopilot.map.window.filter")}</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input id={`${id}-find`} type="search" value={view.query} placeholder={t("autopilot.map.window.filterHint")} onChange={(event) => view.setQuery(event.target.value)} className="h-11 pl-8 sm:h-10" aria-describedby={searching ? `${id}-found` : undefined} />
          </div>
        </div>
        <form onSubmit={jump} className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-jump`} className="text-xs">{t("autopilot.map.window.jump")}</Label>
            <Input id={`${id}-jump`} inputMode="numeric" pattern="[0-9]*" value={jumpTo} onChange={(event) => setJumpTo(event.target.value.replace(/[^\d]/g, ""))} className="h-11 w-24 sm:h-10" aria-describedby={missing !== null ? `${id}-missing` : undefined} />
          </div>
          <Button type="submit" variant="outline" className="h-11 sm:h-10">{t("autopilot.map.window.go")}</Button>
        </form>
      </div>
      <div role="status" className="text-xs text-muted-foreground">
        {missing !== null && <p id={`${id}-missing`}>{t("autopilot.map.window.missing", { number: missing })}</p>}
      </div>
      {searching && (
        <p id={`${id}-found`} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {view.total ? t("autopilot.map.window.results", { count: view.total }) : t("autopilot.map.window.none")}
          <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => view.setQuery("")}><X className="h-3.5 w-3.5" aria-hidden="true" />{t("autopilot.map.window.clear")}</Button>
        </p>
      )}
      {view.total > view.size && (
        <nav aria-label={t("autopilot.map.window.label")} className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" disabled={view.first === 0} onClick={() => view.move(previous)}>
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />{t("autopilot.map.window.previous", { count: Math.min(view.size, view.first) || view.size })}
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">{t("autopilot.map.window.range", { from: formatCount(view.first + 1), to: formatCount(last), total: formatCount(view.total) })}</span>
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" disabled={next >= view.total} onClick={() => view.move(next)}>
            {t("autopilot.map.window.next", { count: Math.min(view.size, Math.max(0, view.total - next)) || view.size })}<ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </nav>
      )}
    </div>
  );
}
