import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Lock, PenLine, Repeat, Star } from "lucide-react";
import type { PlannedChapter } from "narrarium-engine";
import { chapterStateOf, moveInGrid, sceneStateOf, type ChapterState, type MapContext, type SceneState } from "@/autopilot/chapterMapModel";
import { formatCount } from "@/autopilot/format";
import type { OutlineOrigin } from "@/autopilot/planApprovalModel";
import { SCENE_ICON, SCENE_STYLE } from "@/components/autopilot/map/mapVisuals";
import { cn } from "@/lib/utils";

/** The rows Page Up and Page Down move by. */
const PAGE_ROWS = 10;

/** What a row of the map shows of its chapter, worked out once per drawing of the map. */
export interface MapRowModel {
  index: number;
  chapter: PlannedChapter;
  state: ChapterState;
  scenes: SceneState[];
  frozen: boolean;
  origin: OutlineOrigin | undefined;
  current: boolean;
  /** The round of the review in progress, for a chapter in review. */
  round: number | null;
}

export function rowModel(chapter: PlannedChapter, index: number, context: MapContext, origin: OutlineOrigin | undefined, current: boolean): MapRowModel {
  return {
    index,
    chapter,
    state: chapterStateOf(chapter, context),
    scenes: chapter.scenes.map((scene) => sceneStateOf(chapter, scene, context)),
    frozen: context.frozen.has(chapter.slug),
    origin,
    current,
    round: context.review?.chapterNumber === chapter.number ? context.review.round : null,
  };
}

/** The state of a chapter in words, the round included for a chapter in review. */
export function chapterStateText(t: (key: string, options?: Record<string, unknown>) => string, row: Pick<MapRowModel, "state" | "round">): string {
  return row.state === "review" && row.round ? t("autopilot.map.chapter.reviewRound", { round: row.round }) : t(`autopilot.map.chapter.${row.state}`);
}

interface RowProps {
  row: MapRowModel;
  /** The column of the cell of this row that is in the order of the Tab key; -1 when it is in another row. */
  activeCol: number;
  onCell: (row: MapRowModel, col: number, element: HTMLElement, open: boolean) => void;
  onHint: (text: string) => void;
}

const MapRow = memo(function MapRow({ row, activeCol, onCell, onHint }: RowProps) {
  const { t } = useTranslation();
  const { chapter } = row;
  const rounds = chapter.rounds?.length ?? 0;
  const stateText = chapterStateText(t, row);
  const score = typeof chapter.score === "number" ? formatCount(chapter.score) : null;
  // A chapter not approved yet has the vote of its last round, which is not its final one.
  const lastVote = [...(chapter.rounds ?? [])].reverse().find((round) => typeof round.director === "number")?.director;
  const last = !score && typeof lastVote === "number" ? formatCount(lastVote) : null;
  // Everything the cell of the chapter says, in one sentence for a screen reader; the screen shows the same in figures and symbols.
  const said = [
    t("autopilot.map.chapterCell", { number: chapter.number }),
    stateText,
    score ? t("autopilot.map.score", { score }) : last ? t("autopilot.map.lastVote", { score: last }) : t("autopilot.map.noScore"),
    rounds ? t("autopilot.map.rounds", { count: rounds }) : null,
    row.frozen ? t("autopilot.map.frozen") : null,
    row.origin === "author" ? t("autopilot.map.outline") : null,
    row.current ? t("autopilot.map.current") : null,
    chapter.scenes.length ? null : t("autopilot.map.noScenes"),
  ].filter(Boolean).join(". ");
  const events = (col: number, hint: string) => ({
    onClick: (event: MouseEvent<HTMLElement>) => onCell(row, col, event.currentTarget, true),
    onFocus: (event: FocusEvent<HTMLElement>) => {
      onCell(row, col, event.currentTarget, false);
      onHint(hint);
    },
    onMouseEnter: () => onHint(hint),
  });
  return (
    <div role="row" aria-rowindex={row.index + 1} data-chapter={chapter.number} className={cn("flex flex-wrap items-center gap-1 rounded-lg p-0.5", row.current && "bg-primary/5 ring-2 ring-inset ring-primary/60")}>
      <div
        role="rowheader"
        tabIndex={activeCol === 0 ? 0 : -1}
        data-col={0}
        {...events(0, said)}
        className={cn("flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ring-offset-background motion-reduce:transition-none sm:min-h-9", chapter.scenes.length ? "w-full sm:w-44" : "flex-1")}
      >
        <span aria-hidden="true" className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums">{chapter.number}</span>
        <span aria-hidden="true" className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{stateText}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {score && <span className="inline-flex items-center gap-0.5 tabular-nums text-foreground"><Star className="h-3 w-3" />{score}</span>}
            {last && <span className="inline-flex items-center gap-0.5 tabular-nums"><Star className="h-3 w-3" />{last}…</span>}
            {rounds > 0 && <span className="inline-flex items-center gap-0.5 tabular-nums"><Repeat className="h-3 w-3" />{rounds}</span>}
            {row.frozen && <Lock className="h-3 w-3 text-foreground" />}
            {row.origin === "author" && <PenLine className="h-3 w-3 text-foreground" />}
            {!chapter.scenes.length && <span>{t("autopilot.map.noScenes")}</span>}
          </span>
        </span>
        <span className="sr-only">{said}</span>
      </div>
      {chapter.scenes.map((scene, position) => {
        const state = row.scenes[position];
        const Icon = SCENE_ICON[state];
        const text = t("autopilot.map.cell", { number: scene.number, state: t(`autopilot.map.scene.${state}`) });
        return (
          <div
            key={scene.number}
            role="gridcell"
            tabIndex={activeCol === position + 1 ? 0 : -1}
            data-col={position + 1}
            data-state={state}
            {...events(position + 1, `${t("autopilot.map.chapterCell", { number: chapter.number })} · ${text}`)}
            className={cn("flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background", SCENE_STYLE[state], state === "writing" && "motion-safe:animate-pulse")}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{text}</span>
          </div>
        );
      })}
    </div>
  );
});

export interface MapGridProps {
  rows: MapRowModel[];
  /** How many chapters the plan has: the rows say their place among them. */
  total: number;
  label: string;
  keysId: string;
  /** The chapter whose cell starts in the order of the Tab key: the one in progress, when it is on the screen. */
  startChapter: number | null;
  /** A chapter to give the focus to, once it is on the screen (after a jump). */
  focusChapter: number | null;
  onFocused: () => void;
  onOpen: (index: number, opener: HTMLElement) => void;
}

/**
 * The map itself: a grid (WAI-ARIA) of a row for each chapter of the window and a cell for each scene. One cell at a time is in the order of the Tab
 * key; the arrows move between the cells, Home and End to the ends of a row (of the map with Control), Page Up and Page Down by ten rows, and Enter or
 * Space open the chapter. A line under the map says in words the cell under the pointer or the focus, for whoever sees the symbols only.
 */
export function MapGrid({ rows, total, label, keysId, startChapter, focusChapter, onFocused, onOpen }: MapGridProps) {
  const grid = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLParagraphElement>(null);
  const [active, setActive] = useState<{ chapter: number; col: number } | null>(null);
  const shown = rows.find((row) => row.chapter.number === active?.chapter);
  // The cell in the order of the Tab key: the one the author was on, while its chapter is on the screen; else the chapter in progress, or the first.
  const anchor = shown && active ? { chapter: active.chapter, col: Math.min(active.col, shown.chapter.scenes.length) } : { chapter: rows.some((row) => row.chapter.number === startChapter) ? startChapter! : rows[0]?.chapter.number ?? -1, col: 0 };

  const onHint = useCallback((text: string) => {
    if (hint.current) hint.current.textContent = text;
  }, []);
  const onCell = useCallback((row: MapRowModel, col: number, element: HTMLElement, open: boolean) => {
    setActive((current) => (current && current.chapter === row.chapter.number && current.col === col ? current : { chapter: row.chapter.number, col }));
    if (open) onOpen(row.index, element);
  }, [onOpen]);

  const cellAt = (chapter: number, col: number) => grid.current?.querySelector<HTMLElement>(`[data-chapter="${chapter}"] [data-col="${col}"]`) ?? null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const rowElement = target.closest<HTMLElement>("[data-chapter]");
    if (!rowElement || target.dataset.col === undefined) return;
    const position = rows.findIndex((row) => String(row.chapter.number) === rowElement.dataset.chapter);
    if (position < 0) return;
    const col = Number(target.dataset.col);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(rows[position].index, target);
      return;
    }
    const next = moveInGrid({ row: position, col }, event.key, rows.map((row) => row.chapter.scenes.length + 1), { ctrl: event.ctrlKey || event.metaKey, page: PAGE_ROWS });
    if (!next) return;
    event.preventDefault();
    const chapter = rows[next.row].chapter.number;
    setActive({ chapter, col: next.col });
    const cell = cellAt(chapter, next.col);
    cell?.focus();
    cell?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };

  // A jump to a chapter gives it the focus once its row is drawn.
  useEffect(() => {
    if (focusChapter === null) return;
    const cell = cellAt(focusChapter, 0);
    if (!cell) return;
    setActive({ chapter: focusChapter, col: 0 });
    cell.focus();
    cell.scrollIntoView?.({ block: "nearest" });
    onFocused();
  });

  // The chapter in progress is in view inside the map when the map opens or its window changes (the page itself does not move).
  const first = rows[0]?.chapter.number;
  useLayoutEffect(() => {
    const box = grid.current;
    const row = startChapter === null ? null : box?.querySelector<HTMLElement>(`[data-chapter="${startChapter}"]`);
    if (!box || !row) return;
    box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 3);
  }, [first, startChapter]);

  return (
    <div className="space-y-1.5">
      <div
        ref={grid}
        role="grid"
        aria-label={label}
        aria-rowcount={total}
        aria-describedby={keysId}
        onKeyDown={onKeyDown}
        className="relative max-h-[28rem] space-y-0.5 overflow-y-auto overscroll-contain rounded-lg border border-layer bg-background/40 p-1"
      >
        {rows.map((row) => <MapRow key={`${row.chapter.number}:${row.chapter.slug}`} row={row} activeCol={row.chapter.number === anchor.chapter ? anchor.col : -1} onCell={onCell} onHint={onHint} />)}
      </div>
      <p ref={hint} aria-hidden="true" className="min-h-4 text-xs text-foreground" />
    </div>
  );
}
