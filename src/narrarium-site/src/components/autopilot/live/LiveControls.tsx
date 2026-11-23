import { ScrollText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useStreamAnnouncements, useTextDetail } from "@/autopilot/useLiveText";
import { cn } from "@/lib/utils";

/**
 * «Show the text»: whether the panels of the autopilot show the last lines of what it is writing and the last steps it finished (pressed), or only its
 * state, its step and its progress, as they did before. One choice for the mini-player, the band and the page of every book, kept on this device.
 * `labelled` shows the words beside the icon; without them they are still its name.
 */
export function TextDetailToggle({ labelled = false, context, className }: { labelled?: boolean; context?: string; className?: string }) {
  const { t } = useTranslation();
  const [detail, setDetail] = useTextDetail();
  const on = detail === "full";
  // Where two panels show it at once (the mini-player brought back on the page of the band), each is named after its own.
  const name = context ? t("autopilot.band.named", { label: t("autopilot.liveText.toggle"), context }) : t("autopilot.liveText.toggle");
  return (
    <Button
      type="button"
      variant="ghost"
      size={labelled ? "sm" : "icon"}
      aria-pressed={on}
      title={t("autopilot.liveText.toggleHint")}
      onClick={() => setDetail(on ? "compact" : "full")}
      data-text-toggle
      className={cn("aria-pressed:bg-primary/15 aria-pressed:text-foreground", labelled && "h-auto min-h-9 px-2.5", className)}
    >
      <ScrollText className="h-4 w-4" aria-hidden="true" />
      {labelled ? <span aria-hidden={context ? true : undefined}>{t("autopilot.liveText.toggle")}</span> : null}
      {(!labelled || context) && <span className="sr-only">{name}</span>}
    </Button>
  );
}

/**
 * The one polite voice of a surface for what the autopilot of its books does (see `useStreamAnnouncements`): hidden, and at most one message every
 * ten seconds. `nameOf` names the book where several are followed.
 */
export function LiveAnnouncer({ bookIds, nameOf }: { bookIds: readonly string[]; nameOf?: (bookId: string) => string | undefined }) {
  const message = useStreamAnnouncements(bookIds, nameOf);
  return <p role="status" aria-live="polite" data-live-announcer className="sr-only">{message}</p>;
}
