import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { AutopilotFeed } from "@/components/autopilot/AutopilotFeed";
import { cn } from "@/lib/utils";

/** Where the choice of the author is kept, on this device: `open` or `closed`. */
export const HUB_FEED_KEY = "narrarium-autopilot-hub-feed";
/** A phone: the feed starts closed there, under the cards. */
const NARROW = "(max-width: 767px)";

function initiallyOpen(): boolean {
  try {
    const chosen = localStorage.getItem(HUB_FEED_KEY);
    if (chosen === "open" || chosen === "closed") return chosen === "open";
  } catch {
    // Storage that cannot be read keeps the default.
  }
  return typeof window.matchMedia === "function" ? !window.matchMedia(NARROW).matches : true;
}

/**
 * What happens in every book, newest first, in a part of the page the author opens and closes: open on a wide screen, closed on a phone until the
 * author opens it, and as the author left it from then on. The step that runs is not repeated here (each card says it), and nothing of it is
 * announced: its text changes several times a second.
 */
export function HubFeed({ className }: { className?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const toggle = () => setOpen((value) => {
    const next = !value;
    try {
      localStorage.setItem(HUB_FEED_KEY, next ? "open" : "closed");
    } catch {
      // The choice holds for this visit.
    }
    return next;
  });
  return (
    <section aria-labelledby={`${id}-title`} className={cn("rounded-2xl border border-layer bg-card shadow-sm", className)}>
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          onClick={toggle}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-2xl px-4 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("autopilot.dockTitle")}
          <ChevronDown className={cn("h-5 w-5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden="true" />
        </button>
      </h2>
      <div id={`${id}-panel`} hidden={!open} className="px-4 pb-4">
        <AutopilotFeed showBook limit={200} showLive={false} />
      </div>
    </section>
  );
}
