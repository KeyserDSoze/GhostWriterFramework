import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { RemoteRunNotice } from "@/components/autopilot/RemoteRunNotice";
import { useQuickModel, type QuickVariant } from "@/components/autopilot/quick/model";
import { PublishGroup } from "@/components/autopilot/quick/PublishGroup";
import { RunGroup } from "@/components/autopilot/quick/RunGroup";
import { HandoverFailure, StatusChips } from "@/components/autopilot/quick/Status";
import { WhereGroup } from "@/components/autopilot/quick/WhereGroup";
import { cn } from "@/lib/utils";

export interface QuickCommandsProps {
  bookId: string;
  /** `page`: the band of the autopilot page of the book. `dock`: the compact bar of the live panel. */
  variant: QuickVariant;
  /** The paragraph that tells what Resume does when a profile file has problems: Resume is described by it. The notice that holds it is the page's or the panel's own. */
  profileHintId?: string;
  /** What heads the bar: the name of the book in the live panel (the default), anything else (a selector of books), or nothing (`null`) when whoever shows it already says which book it is. */
  heading?: ReactNode | null;
  /** Draw a frame around the bar. The page has one; the live panel draws it for the bar of a book that has no card of its own. */
  framed?: boolean;
}

/** The actions of the bar that are on their way, said in words while they are (the others are operations of the book, which the page and the panel already say). */
const OWN_ACTIONS = new Set(["pause", "stop", "cancel-pause", "start", "options", "publish", "handover"]);

/**
 * The quick commands of the autopilot of one book: pause after this step or at the end of the chapter (and take the pause back), stop now,
 * run one step or one chapter, where the book is published to GitHub, and where the autopilot runs (this browser or the personal server,
 * and when it passes to the other). On the autopilot page, in the "This book" tab of the live panel, and above the live feed.
 *
 * It reads everything it needs by itself and shows nothing for a book whose autopilot has not started. A control that is not available says
 * why in words next to it, and the control points at the words; every control has a name that says which book it commands and from which bar
 * (the page or the panel), so two bars on the same screen never repeat a name.
 */
export function QuickCommands({ bookId, variant, profileHintId, heading, framed }: QuickCommandsProps) {
  const { t } = useTranslation();
  const model = useQuickModel(bookId, variant);
  if (!model) return null;

  const framedBar = framed ?? variant === "page";
  const title = heading === undefined ? (variant === "dock" ? <p className="min-w-0 break-words text-sm font-semibold">{model.book.name}</p> : null) : heading;
  const own = model.busy && OWN_ACTIONS.has(model.busy) ? model.busy : null;

  return (
    <div
      role="group"
      aria-label={t("autopilot.quick.groupLabel", { context: model.context })}
      data-quick-commands={variant}
      className={cn("min-w-0 space-y-2", framedBar && (variant === "page" ? "rounded-2xl border border-layer bg-card p-3 shadow-sm sm:p-4" : "rounded-xl border p-3"))}
    >
      {title}
      <RunGroup model={model} profileHintId={profileHintId} />
      <StatusChips model={model} />
      <div className="flex flex-wrap items-start gap-2">
        <PublishGroup model={model} />
        <WhereGroup model={model} />
      </div>
      {own && (
        <p id={model.ids.busy} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
          <span>{t(`autopilot.quick.busy.${own}`)}</span>
        </p>
      )}
      <RemoteRunNotice bookId={bookId} control={model.control} id={model.ids.remote} context={model.context} />
      <HandoverFailure model={model} />
    </div>
  );
}
