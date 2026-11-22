import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** The tones of a chip: the same colours the status badges of the autopilot use, so they keep their contrast in both themes. */
const TONES = {
  info: "bg-sky-500/15 text-sky-800 dark:text-sky-300",
  warning: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  critical: "bg-red-500/15 text-red-800 dark:text-red-300",
  ok: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
} as const;

/** One thing that is pending or going on, in words with an icon, and, when it can be taken back or closed, a button that says what it does. */
export function Chip({ tone = "info", icon, children, action }: { tone?: keyof typeof TONES; icon: ReactNode; children: ReactNode; action?: { label: string; onClick: () => void; disabled?: boolean } }) {
  return (
    <span className={cn("inline-flex min-h-7 items-center gap-1.5 rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium", TONES[tone])}>
      <span aria-hidden className="inline-flex shrink-0">{icon}</span>
      <span>{children}</span>
      {action && (
        <button
          type="button"
          aria-label={action.label}
          title={action.label}
          disabled={action.disabled}
          onClick={action.onClick}
          className="-mr-1.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-offset-background transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </span>
  );
}

/** Why a control is not available, as text that stays on the screen; the control points at it. */
export function Reason({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return <p id={id} className={cn("max-w-xs text-xs text-muted-foreground", className)}>{children}</p>;
}

/**
 * What goes in an entry of a menu: what it does, and under it, when there is one, what that means or why it is not there. An entry that
 * is not available says so in words (the reason is the hint) and stays as readable as the rest: it is not only dimmed.
 */
export function MenuText({ label, hint, disabled }: { label: string; hint?: string; disabled?: boolean }) {
  return (
    <>
      <span className={cn(disabled && "text-muted-foreground")}>{label}</span>
      {hint && <span className="block text-xs font-normal text-muted-foreground">{hint}</span>}
    </>
  );
}

export const MENU_CONTENT = "max-w-[min(22rem,calc(100vw-2rem))]";
export const MENU_ITEM = "flex-col items-start whitespace-normal data-[disabled]:opacity-100";
