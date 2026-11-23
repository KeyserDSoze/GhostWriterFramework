import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayoutGrid, Lock, Map as MapIcon, PenLine, Repeat, Star, Table2 } from "lucide-react";
import { chapterFilePath, outlineChapterPath, type AutopilotState, type PlannedChapter } from "narrarium-engine";
import { Card } from "@/components/autopilot/Card";
import { useGhostwriterName } from "@/components/autopilot/PlanChapters";
import { ChapterPanel } from "@/components/autopilot/map/ChapterPanel";
import { ChapterWindowControls, useChapterWindow } from "@/components/autopilot/map/ChapterWindow";
import { MapGrid, rowModel } from "@/components/autopilot/map/MapGrid";
import { MapTable } from "@/components/autopilot/map/MapTable";
import { SCENE_ICON, SCENE_STYLE } from "@/components/autopilot/map/mapVisuals";
import { MAP_PAGE_SIZE, SCENE_STATES, mapContext, progressIndex, type LiveStep } from "@/autopilot/chapterMapModel";
import { formatCount } from "@/autopilot/format";
import { outlineOrigins, type OutlineOrigin } from "@/autopilot/planApprovalModel";
import { useAutopilotStore } from "@/autopilot/store";
import { useBookFiles } from "@/autopilot/useBookFiles";
import { frozenChapterSlugs } from "@/outline/outlineModel";
import { useBackGestureClose } from "@/components/layout/historyStep";
import { cn } from "@/lib/utils";

type MapView = "map" | "table";
const VIEW_KEY = "narrarium-chapter-map-view";
const NO_SLUGS: ReadonlySet<string> = new Set();
const NO_ORIGINS: ReadonlyMap<number, OutlineOrigin> = new Map();

function readView(): MapView {
  try {
    return localStorage.getItem(VIEW_KEY) === "table" ? "table" : "map";
  } catch {
    return "map";
  }
}

/** The step that runs now, as one string: the text it streams changes many times a second, and the map does not hear of it. */
function liveKeyOf(activity: { task: string; status: string; chapterNumber?: number; sceneNumber?: number } | null | undefined): string {
  return activity && activity.status === "running" ? `${activity.task}|${activity.chapterNumber ?? ""}|${activity.sceneNumber ?? ""}` : "";
}

function liveStepOf(key: string): LiveStep | null {
  if (!key) return null;
  const [task, chapter, scene] = key.split("|");
  return { task: task as LiveStep["task"], ...(chapter ? { chapterNumber: Number(chapter) } : {}), ...(scene ? { sceneNumber: Number(scene) } : {}) };
}

/**
 * Which chapters of the window are frozen (their `chapter.md`, for the ones that are approved) and which follow an entry of the author's outline (the
 * entries of the window): the only files the map reads, never the whole book, again after every saved step.
 */
function useMapMarks(bookId: string, chapters: readonly PlannedChapter[], visible: readonly number[], refresh: number) {
  const frozenPaths = useMemo(() => visible.filter((index) => chapters[index].status === "done").map((index) => chapterFilePath(chapters[index].slug)), [visible, chapters]);
  const outlinePaths = useMemo(() => visible.map((index) => outlineChapterPath(chapters[index].number)), [visible, chapters]);
  const paths = useMemo(() => [...frozenPaths, ...outlinePaths], [frozenPaths, outlinePaths]);
  const { files, failed } = useBookFiles(bookId, paths, refresh);
  const [frozen, setFrozen] = useState<ReadonlySet<string>>(NO_SLUGS);
  const [origins, setOrigins] = useState<ReadonlyMap<number, OutlineOrigin>>(NO_ORIGINS);
  useEffect(() => {
    if (!files) return undefined;
    const pick = (list: readonly string[]) => list.flatMap((path) => {
      const content = files.get(path);
      return content === undefined ? [] : [{ path, content }];
    });
    const next = frozenChapterSlugs(pick(frozenPaths));
    setFrozen((current) => (current.size === next.size && [...next].every((slug) => current.has(slug)) ? current : next));
    let current = true;
    void outlineOrigins(pick(outlinePaths)).then((found) => {
      if (current) setOrigins((previous) => (previous.size === found.size && [...found].every(([number, origin]) => previous.get(number) === origin) ? previous : found));
    }).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [files, frozenPaths, outlinePaths]);
  return { frozen, origins, failed };
}

export interface ChapterMapProps {
  bookId: string;
  state: AutopilotState;
  linkedSlugs: ReadonlySet<string>;
}

/**
 * The map of the chapters of the live page: a row for each chapter and a cell for each scene, the state of each in words, in a symbol and in a colour,
 * the director's vote and the rounds of review of every chapter, the frozen chapters and the ones that follow the author's Outline. A click, or Enter,
 * opens the panel of the chapter. As a table too, with the same words. A long book is shown fifty chapters at a time, as the outline is: the map is
 * drawn from the autopilot's state, and the book is never read to draw it.
 */
export const ChapterMap = memo(function ChapterMap({ bookId, state, linkedSlugs }: ChapterMapProps) {
  const { t } = useTranslation();
  const id = useId();
  const chapters = state.plan?.chapters ?? [];
  const liveKey = useAutopilotStore((store) => liveKeyOf(store.live[bookId]?.activity));
  const live = useMemo(() => liveStepOf(liveKey), [liveKey]);
  const ghostwriterName = useGhostwriterName(bookId);
  // The chapter in progress: the one the step that runs is about, or the first that is not approved.
  const currentNumber = live?.chapterNumber ?? chapters[progressIndex(chapters)]?.number ?? null;
  const follow = currentNumber === null ? 0 : Math.max(0, chapters.findIndex((chapter) => chapter.number === currentNumber));
  const view = useChapterWindow(chapters, MAP_PAGE_SIZE, follow);
  const marks = useMapMarks(bookId, chapters, view.visible, state.version);
  const context = useMemo(() => mapContext(state, live, marks.frozen), [state, live, marks.frozen]);
  const rows = useMemo(() => view.visible.map((index) => rowModel(chapters[index], index, context, marks.origins.get(chapters[index].number), chapters[index].number === currentNumber)), [view.visible, chapters, context, marks.origins, currentNumber]);

  const [mode, setMode] = useState<MapView>(readView);
  const choose = (next: MapView) => {
    setMode(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Without storage the choice lasts as long as the page.
    }
  };

  // The chapter whose panel is open, and the cell (or button) that opened it, which has the focus again when it closes.
  const [opened, setOpened] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback((index: number, element: HTMLElement) => {
    opener.current = element;
    setOpened(index);
  }, []);
  const close = useCallback(() => {
    setOpened(null);
    const element = opener.current;
    // The dialog gives the focus back once it is gone; the cell is found again by its place, in case the map was drawn again in the meantime.
    window.setTimeout(() => {
      if (element?.isConnected) element.focus();
    }, 0);
  }, []);
  const openedRow = opened === null ? null : rows.find((row) => row.index === opened) ?? (chapters[opened] ? rowModel(chapters[opened], opened, context, marks.origins.get(chapters[opened].number), chapters[opened].number === currentNumber) : null);
  // On a phone the panel covers the screen: the back gesture closes it instead of leaving the page.
  const followPanelLink = useBackGestureClose(openedRow !== null, close, "chapter-panel");

  const [focusChapter, setFocusChapter] = useState<number | null>(null);
  const range = { from: formatCount(view.visible.length ? view.first + 1 : 0), to: formatCount(view.first + view.visible.length), total: formatCount(view.total) };
  const keysId = `${id}-keys`;

  const switcher = (
    <div role="radiogroup" aria-label={t("autopilot.map.view.label")} className="flex gap-1">
      {(["map", "table"] as const).map((option) => (
        <label key={option} className="relative inline-flex">
          <input type="radio" name={`${id}-view`} value={option} checked={mode === option} onChange={() => choose(option)} className="peer sr-only" />
          <span className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border border-layer bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 ring-offset-background motion-reduce:transition-none sm:min-h-8">
            {option === "map" ? <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" /> : <Table2 className="h-3.5 w-3.5" aria-hidden="true" />}{t(`autopilot.map.view.${option}`)}
          </span>
        </label>
      ))}
    </div>
  );

  return (
    <Card id="autopilot-map" title={t("autopilot.map.title")} icon={<MapIcon className="h-4 w-4 text-primary" aria-hidden="true" />} actions={switcher}>
      {mode === "map" && (
        <ul aria-label={t("autopilot.map.legend")} className="flex flex-wrap gap-x-3 gap-y-1.5">
          {SCENE_STATES.map((state) => {
            const Icon = SCENE_ICON[state];
            return (
              <li key={state} className="inline-flex items-center gap-1.5 text-xs">
                <span aria-hidden="true" className={cn("flex h-5 w-5 items-center justify-center rounded border", SCENE_STYLE[state])}><Icon className="h-3 w-3" /></span>
                {t(`autopilot.map.scene.${state}`)}
              </li>
            );
          })}
        </ul>
      )}
      {mode === "map" && (
        <ul aria-label={t("autopilot.map.marks")} className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <li className="inline-flex items-center gap-1"><Star className="h-3 w-3 text-foreground" aria-hidden="true" />{t("autopilot.map.voteMark")}</li>
          <li className="inline-flex items-center gap-1"><Repeat className="h-3 w-3 text-foreground" aria-hidden="true" />{t("autopilot.map.roundsMark")}</li>
          <li className="inline-flex items-center gap-1"><Lock className="h-3 w-3 text-foreground" aria-hidden="true" />{t("autopilot.map.frozen")}</li>
          <li className="inline-flex items-center gap-1"><PenLine className="h-3 w-3 text-foreground" aria-hidden="true" />{t("autopilot.map.outline")}</li>
        </ul>
      )}
      <ChapterWindowControls window={view} onJumped={(index) => setFocusChapter(chapters[index].number)} />
      {mode === "map" ? (
        <>
          <MapGrid rows={rows} total={chapters.length} label={t("autopilot.map.label", range)} keysId={keysId} startChapter={currentNumber} focusChapter={focusChapter} onFocused={() => setFocusChapter(null)} onOpen={open} />
          <p id={keysId} className="text-xs text-muted-foreground">{t("autopilot.map.keys")}</p>
        </>
      ) : (
        <MapTable rows={rows} caption={t("autopilot.map.table.caption", range)} ghostwriterName={ghostwriterName} onOpen={open} />
      )}
      {marks.failed && <p className="text-xs text-muted-foreground">{t("autopilot.map.unread")}</p>}
      {openedRow && <ChapterPanel bookId={bookId} row={openedRow} state={state} linked={linkedSlugs.has(openedRow.chapter.slug)} ghostwriter={openedRow.chapter.ghostwriter ? ghostwriterName(openedRow.chapter.ghostwriter) : undefined} onClose={close} onLinkClick={followPanelLink} />}
    </Card>
  );
});
