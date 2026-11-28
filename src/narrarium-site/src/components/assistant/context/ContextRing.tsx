import { Suspense, lazy, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Loader2 } from "lucide-react";
import type { ChatContext } from "@/assistant/chatContext";
import type { ContextState } from "@/assistant/contextBudget";
import { formatWhole } from "@/autopilot/format";
import { FloatingLayerMarker } from "@/lib/floatingLayer";
import { cn } from "@/lib/utils";

/**
 * The context ring of a chat (#122), next to Send: how much of its model's window the next message would take, with its state in colour and in words. Hovered or focused it says
 * the numbers; pressed, it opens what the next message carries part by part (loaded with the first opening), with «Compact now».
 */

const ContextBreakdown = lazy(() => import("@/components/assistant/context/ContextParts").then((module) => ({ default: module.ContextBreakdown })));

/** The colours of the states: text and ring alike, each above 4.5:1 on the panel in light and in dark. */
const STATE_CLASS: Record<ContextState, string> = {
  normal: "text-primary",
  full: "text-amber-800 dark:text-amber-300",
  compacting: "text-sky-700 dark:text-sky-300",
  over: "text-red-700 dark:text-red-400",
};

/** What the ring says of itself: «N% of the context (X of Y tokens), window from …», and its state when it is not the usual one. */
export function contextRingLabel(t: TFunction, context: ChatContext): string {
  const { estimate } = context;
  const label = t("pageCopilot.context.ring.label", {
    percent: estimate.percent,
    used: formatWhole(estimate.total),
    window: formatWhole(estimate.window.tokens),
    source: t(`pageCopilot.context.ring.source.${estimate.window.source}`),
  });
  const state = estimate.state === "normal" ? "" : `. ${t(`pageCopilot.context.ring.state.${estimate.state}`)}`;
  const first = estimate.measured ? "" : `. ${t("pageCopilot.context.ring.firstMessage")}`;
  return `${label}${state}${first}`;
}

export function ContextRing({ context, canCompact, onCompact, currency }: { context: ChatContext; canCompact: boolean; onCompact: () => void; currency: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const titleId = useId();
  const tipId = useId();
  const { estimate } = context;
  const label = contextRingLabel(t, context);
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.min(100, Math.max(0, estimate.percent));

  // A press outside closes it; the focus goes back to the ring only from Escape or from its own Close.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (popoverRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  useEffect(() => {
    if (open) popoverRef.current?.focus();
  }, [open]);

  // The words shown on hover and focus close with Escape wherever the focus is (WCAG 1.4.13); the panel stays open, as for any floating layer.
  useEffect(() => {
    if (!tip) return;
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setTip(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [tip]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onPopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  return (
    // The words and the popover open above the row the ring is in (its nearest positioned parent), aligned with its end: on a phone they stay on the screen.
    <div data-context-ring={estimate.state} data-context-percent={estimate.percent}>
      <button
        ref={buttonRef}
        type="button"
        className={cn("flex h-9 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium tabular-nums hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", STATE_CLASS[estimate.state])}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => { setTip(false); setOpen((value) => !value); }}
        onPointerEnter={() => setTip(true)}
        onPointerLeave={() => setTip(false)}
        onFocus={() => setTip(true)}
        onBlur={() => setTip(false)}
      >
        <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0 -rotate-90" aria-hidden="true">
          <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
          <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${(filled / 100) * circumference} ${circumference}`} className={estimate.state === "compacting" ? "motion-safe:animate-pulse" : undefined} />
        </svg>
        <span aria-hidden="true">{estimate.state === "compacting" ? <Loader2 className="inline h-3.5 w-3.5 motion-safe:animate-spin" /> : `${estimate.percent}%`}</span>
        {estimate.state !== "normal" && <span aria-hidden="true" className="max-w-[6.5rem] truncate">{t(`pageCopilot.context.ring.short.${estimate.state}`)}</span>}
      </button>
      {tip && !open && (
        <>
          {/* Shown while the ring is hovered or focused; Escape hides it. A floating layer, so that Escape does not close the panel too. */}
          <FloatingLayerMarker />
          <div id={tipId} role="tooltip" aria-hidden="true" className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 w-max max-w-[min(20rem,calc(100vw-2rem))] rounded-md border border-layer bg-popover px-2.5 py-1.5 text-xs leading-5 text-popover-foreground shadow-md">
            {label}
          </div>
        </>
      )}
      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={onPopoverKeyDown}
          className="absolute bottom-full right-0 z-50 mb-2 max-h-[min(70dvh,34rem)] w-[min(23rem,calc(100vw-2rem))] overflow-auto rounded-xl border border-layer bg-popover p-3 text-sm text-popover-foreground shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FloatingLayerMarker />
          <Suspense fallback={<p id={titleId} className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />{t("pageCopilot.context.popover.title")}</p>}>
            <ContextBreakdown context={context} titleId={titleId} canCompact={canCompact} currency={currency} onCompact={() => { onCompact(); close(); }} onClose={close} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

/** The slash commands of the chats. */
export type SlashCommandName = "/compact" | "/context";
export const SLASH_COMMANDS: readonly SlashCommandName[] = ["/compact", "/context"];

/** The command a message is, when it is one of them and nothing else (`/compact`, `/Context `). */
export function slashCommandOf(text: string): SlashCommandName | null {
  const word = text.trim().toLowerCase();
  return (SLASH_COMMANDS as readonly string[]).includes(word) ? (word as SlashCommandName) : null;
}

/** The commands a draft asks for: a draft of one word that starts with «/» shows the commands that begin with it. */
export function slashMatches(draft: string): SlashCommandName[] {
  if (!draft.startsWith("/") || /\s/.test(draft)) return [];
  const typed = draft.toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.startsWith(typed));
}

/**
 * The menu of the slash commands under the composer's keyboard: the composer keeps the focus (`aria-activedescendant`), the arrows move through the commands, Enter runs the one
 * that is active, Tab writes it in the box, Escape closes the menu (the panel stays open).
 */
export function useSlashMenu(draft: string, onRun: (command: SlashCommandName) => void, onComplete: (command: SlashCommandName) => void) {
  const rows = slashMatches(draft);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listId = useId();
  const open = rows.length > 0 && dismissed !== draft;
  const index = Math.min(active, Math.max(0, rows.length - 1));
  const optionId = (command: SlashCommandName) => `${listId}-${command.slice(1)}`;

  useEffect(() => {
    setActive(0);
    if (!draft.startsWith("/")) setDismissed(null);
  }, [draft]);

  /** The keys the menu takes: `true` when it took this one. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((index + 1) % rows.length);
        return true;
      case "ArrowUp":
        event.preventDefault();
        setActive((index - 1 + rows.length) % rows.length);
        return true;
      case "Enter":
        event.preventDefault();
        onRun(rows[index]);
        return true;
      case "Tab":
        if (event.shiftKey) return false;
        event.preventDefault();
        onComplete(rows[index]);
        return true;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        setDismissed(draft);
        return true;
      default:
        return false;
    }
  };

  return {
    open,
    rows,
    active: index,
    setActive,
    listId,
    optionId,
    onKeyDown,
    /** For the composer: what it controls and which option is active, while the menu is open. */
    fieldProps: open
      ? { "aria-autocomplete": "list" as const, "aria-haspopup": "listbox" as const, "aria-controls": listId, "aria-activedescendant": optionId(rows[index]) }
      : { "aria-autocomplete": "list" as const, "aria-haspopup": "listbox" as const },
  };
}

export function SlashMenu({ menu, onRun }: { menu: ReturnType<typeof useSlashMenu>; onRun: (command: SlashCommandName) => void }) {
  const { t } = useTranslation();
  if (!menu.open) return null;
  return (
    <>
      <FloatingLayerMarker />
      <ul id={menu.listId} role="listbox" aria-label={t("pageCopilot.context.slash.label")} className="absolute bottom-full left-0 z-50 mb-1 w-full max-w-sm overflow-hidden rounded-lg border border-layer bg-popover p-1 text-sm text-popover-foreground shadow-lg">
        {menu.rows.map((command, index) => (
          <li
            key={command}
            id={menu.optionId(command)}
            role="option"
            aria-selected={index === menu.active}
            // The composer keeps the focus: a press chooses without moving it.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => menu.setActive(index)}
            onClick={() => onRun(command)}
            className={cn("flex cursor-pointer flex-col rounded-md px-2.5 py-1.5", index === menu.active ? "bg-accent text-accent-foreground" : "")}
          >
            <span className="font-mono font-medium">{command}</span>
            <span className="text-xs text-muted-foreground">{t(`pageCopilot.context.slash.${command.slice(1)}`)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
