import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownRight } from "lucide-react";
import { attemptWords, candidateHint, candidateWords, thinkingWords } from "@/autopilot/attemptModel";
import { useAutopilotStore } from "@/autopilot/store";
import { cn } from "@/lib/utils";

/** The mark between two facts of the line: read by nobody, so that a screen reader says the facts and not the dots. */
const Dot = () => <span aria-hidden="true" className="px-1 text-muted-foreground">·</span>;

/**
 * Which candidate of the AI Router the call of the step that runs asks now, in one line: the badge («Primary», or «Fallback 1» in amber, with an arrow, so that it is never the colour
 * alone), the model, the integration, how it thinks («Thinking: High») and, for a call that went on to another request, «attempt 2/3». The engine says it as each request is sent
 * (`AutopilotLive.trying`), so it is the one being asked, not the one that was meant to be: a primary that failed at once is already the fallback here. It follows the store by itself, and
 * the numbers of the text that streams never draw it again. Not a live region: the one status of the surface says a fallback, once (`useStreamAnnouncements`). Nothing from a host that does
 * not say it (a personal server older than the engine that does): no placeholder, no error. Once the line has been shown it keeps its place while a step ends and the next one has not asked
 * yet, so that what is under it does not jump; `compact` keeps it to two lines for a phone.
 */
export const AttemptNow = memo(function AttemptNow({ bookId, compact = false, className }: { bookId: string; compact?: boolean; className?: string }) {
  const { t } = useTranslation();
  const trying = useAutopilotStore((state) => state.live[bookId]?.trying);
  const [kept, setKept] = useState(false);
  if (trying && !kept) setKept(true);
  if (!trying && !kept) return null;
  const count = trying ? attemptWords(t, trying) : null;
  return (
    <p data-band-attempt data-attempt-fallback={trying?.fallback ? "" : undefined} className={cn("min-w-0 break-words text-xs leading-5", compact ? "line-clamp-2" : "min-h-5", className)}>
      {trying && (
        <>
          <span className="sr-only">{t("autopilot.band.attempt.label")} </span>
          <span
            data-attempt-badge
            title={candidateHint(t, trying)}
            className={cn("mr-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 align-middle font-semibold leading-4", trying.fallback ? "bg-amber-500/15 text-amber-800 dark:text-amber-300" : "bg-primary/15 text-foreground")}
          >
            {trying.fallback && <CornerDownRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
            {candidateWords(t, trying)}
          </span>
          <span data-attempt-model className="font-medium">{trying.model}</span>
          <Dot />
          <span data-attempt-integration className="text-muted-foreground">{trying.integrationName}</span>
          <Dot />
          <span data-attempt-thinking className="text-muted-foreground">{thinkingWords(t, trying.thinking)}</span>
          {count && (
            <>
              <Dot />
              <span data-attempt-count className="tabular-nums text-muted-foreground">{count}</span>
            </>
          )}
        </>
      )}
    </p>
  );
});
