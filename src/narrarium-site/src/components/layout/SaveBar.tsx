import { useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDot, Loader2, Save, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReserveSpace } from "@/hooks/useReserveSpace";
import { cn } from "@/lib/utils";

export type SaveBarState = "saved" | "unsaved" | "defaults" | "saving" | "failed";

const ICON = { saved: CheckCircle2, unsaved: CircleDot, defaults: CircleDot, saving: Loader2, failed: AlertTriangle } as const;

/** Under this width the bar takes the whole width of the screen. */
const NARROW = 560;

/** Where the page's column is on the screen: the bar is drawn over it, at the bottom of the window. */
function useColumn(anchor: HTMLElement | null): { left: number; width: number } | null {
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return undefined;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      setBox((current) => (current && current.left === rect.left && current.width === rect.width ? current : { left: rect.left, width: rect.width }));
    };
    update();
    // The column moves when the sidebar or the dossier opens or closes, and is resized with the window.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(anchor);
    const main = anchor.closest("main");
    if (main) observer?.observe(main);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [anchor]);
  return box;
}

export interface SaveBarProps {
  /** The column of the page: on a wide screen the bar is drawn over it; on a phone it takes the whole width. */
  anchor: HTMLElement | null;
  /** The name of the bar, for screen readers. */
  label: string;
  state: SaveBarState;
  /** The state in words (never only the icon). */
  status: string;
  saveLabel: string;
  canSave: boolean;
  busy: boolean;
  onSave: () => void;
  /** Discard changes, for a page that can. */
  discard?: { label: string; enabled: boolean; onDiscard: () => void };
}

/**
 * The bar that saves a page, at the bottom of the window over the page's column (the whole width on a phone): whether the page is saved or has
 * changes, always in words with an icon, and its Save (and Discard changes, when the page has it). It tells the page how tall it is
 * (`--bottom-reserve`), so that the end of the page and the field that has the focus scroll clear of it and the floating buttons stand above it.
 */
export function SaveBar({ anchor, label, state, status, saveLabel, canSave, busy, onSave, discard }: SaveBarProps) {
  const bar = useRef<HTMLDivElement>(null);
  useReserveSpace(bar, "--bottom-reserve", true);
  const column = useColumn(anchor);
  const wide = column !== null && column.width >= NARROW;
  const Icon = ICON[state];
  return (
    <div
      ref={bar}
      role="group"
      aria-label={label}
      data-save-bar=""
      style={wide ? { left: column.left, width: column.width } : undefined}
      className={cn(
        "fixed bottom-0 z-30 border-t border-layer bg-card px-4 py-3 shadow-[0_-8px_16px_-12px_rgba(0,0,0,0.35)]",
        wide ? "rounded-t-2xl border-x" : "inset-x-0",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" className={cn("mr-auto flex min-w-0 items-center gap-2 text-sm font-medium", state === "failed" && "text-destructive")}>
          <Icon className={cn("h-4 w-4 shrink-0", state === "saving" && "motion-safe:animate-spin", state === "saved" && "text-emerald-700 dark:text-emerald-400")} aria-hidden="true" />
          <span className="min-w-0 break-words">{status}</span>
        </p>
        {discard && (
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-10" onClick={discard.onDiscard} disabled={busy || !discard.enabled}>
            <Undo2 className="h-4 w-4" aria-hidden="true" />{discard.label}
          </Button>
        )}
        <Button type="button" className="min-h-11 sm:min-h-10" onClick={onSave} disabled={busy || !canSave}>
          {busy ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}{saveLabel}
        </Button>
      </div>
    </div>
  );
}
