import { CheckCircle2, Circle, Eye, FileText, Lock, PenLine, RotateCcw, type LucideIcon } from "lucide-react";
import type { SceneState } from "@/autopilot/chapterMapModel";

/**
 * How a state of a scene is drawn: a symbol of its own and a colour, always with its word (in the legend, in the cell for a screen reader, in the
 * table and in the panel). The colour only helps: two states never share a symbol.
 */
export const SCENE_ICON: Record<SceneState, LucideIcon> = {
  todo: Circle,
  writing: PenLine,
  written: FileText,
  review: Eye,
  approved: CheckCircle2,
  rewrite: RotateCcw,
  frozen: Lock,
};

/** The colours of a cell: a light tint with a dark symbol, a dark tint with a light one; the edge sets the cell apart from the card. */
export const SCENE_STYLE: Record<SceneState, string> = {
  todo: "border-dashed border-slate-500 bg-background text-slate-700 dark:border-slate-400 dark:text-slate-300",
  writing: "border-sky-700 bg-sky-100 text-sky-900 dark:border-sky-400 dark:bg-sky-950 dark:text-sky-200",
  written: "border-indigo-700 bg-indigo-100 text-indigo-900 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-200",
  review: "border-amber-700 bg-amber-100 text-amber-900 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-200",
  approved: "border-emerald-700 bg-emerald-100 text-emerald-900 dark:border-emerald-400 dark:bg-emerald-950 dark:text-emerald-200",
  rewrite: "border-rose-700 bg-rose-100 text-rose-900 dark:border-rose-400 dark:bg-rose-950 dark:text-rose-200",
  frozen: "border-slate-700 bg-slate-200 text-slate-900 dark:border-slate-300 dark:bg-slate-800 dark:text-slate-100",
};
