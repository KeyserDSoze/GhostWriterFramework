import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle, Eraser, Loader2, Pencil, Plane } from "lucide-react";
import type { AutopilotState } from "narrarium-engine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatWhole } from "@/autopilot/runEstimateFormat";
import type { OutlineBrief } from "@/autopilot/outlineBrief";
import { autopilotLiveHref } from "@/autopilot/pageRoute";

export interface ConfigOverviewProps {
  bookId: string;
  state: AutopilotState | null;
  /** The autopilot has never started: the card says what it does. */
  fresh: boolean;
  brief: OutlineBrief;
  chapters: number;
  readable: boolean;
  loaded: boolean;
  /** The number of the last chapter entry: the chapters of the book. */
  lastChapter: number;
  /** The Scaletta has no chapter entries and the book no plan: the autopilot cannot start, and the page says so. */
  noChapters: boolean;
  /** The run's estimate, shown under the Scaletta. */
  preview?: ReactNode;
  /** «Use my Synopsis only»: empty the chapter-by-chapter plot of the brief, so that the entries are the one source (#125). Absent: not offered. */
  onSynopsisOnly?: () => Promise<SynopsisOnlyOutcome>;
}

export type SynopsisOnlyOutcome = "saved" | "conflict" | "failed";

/**
 * The first part of the configuration: the state of the autopilot with its live page, and what it follows from the Scaletta: the brief and the
 * chapter entries, read here and never edited here. The link goes to the Scaletta, where they are written.
 */
export function ConfigOverview({ bookId, state, fresh, brief, chapters, readable, loaded, lastChapter, noChapters, preview, onSynopsisOnly }: ConfigOverviewProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || "en";
  const scaletta = `/app/books/${encodeURIComponent(bookId)}/outline`;
  const none = t("autopilot.config.overview.notWritten");
  const synopsis = brief.synopsis.trim();
  // What «Use my Synopsis only» came to stays said once the note goes (the brief has no plot any more).
  const [synopsisOutcome, setSynopsisOutcome] = useState<SynopsisOnlyOutcome | null>(null);
  const facts: Array<[string, string]> = [
    [t("autopilot.config.overview.idea"), brief.idea.trim() || none],
    [t("autopilot.config.overview.genre"), brief.genre.trim() || none],
    [t("autopilot.config.overview.audience"), brief.audience.trim() || none],
    [t("autopilot.config.overview.words"), t("autopilot.config.overview.wordsValue", { words: formatWhole(brief.wordsPerScene, locale) })],
    [t("autopilot.config.overview.chapters"), t("autopilot.config.overview.chaptersValue", { count: chapters })],
  ];

  return (
    <div className="space-y-5">
      {fresh && <p className="text-sm text-muted-foreground">{t("autopilot.setup.description")}</p>}
      <section aria-labelledby="autopilot-overview-state" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
        <div className="min-w-0 space-y-1">
          <h2 id="autopilot-overview-state" className="text-base font-semibold">{t("autopilot.config.overview.state")}</h2>
          <p className="text-sm text-muted-foreground">{state ? t(`autopilot.status.${state.status}`) : t("autopilot.notStarted")}</p>
        </div>
        <Button asChild variant="outline"><Link to={autopilotLiveHref(bookId)}><Plane className="h-4 w-4" aria-hidden="true" />{t("nav.autopilotLive")}</Link></Button>
      </section>

      <section aria-labelledby="autopilot-overview-scaletta" className="space-y-4 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 id="autopilot-overview-scaletta" className="text-base font-semibold">{t("autopilot.config.overview.scaletta")}</h2>
            <p className="text-sm text-muted-foreground">{t("autopilot.config.overview.scalettaHint")}</p>
          </div>
          <Button asChild variant="outline" size="sm"><Link to={scaletta}><Pencil className="h-4 w-4" aria-hidden="true" />{t("autopilot.config.overview.edit")}</Link></Button>
        </div>

        {!loaded ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("autopilot.current.loading")}</p>
        ) : !readable ? (
          <Alert role="note"><AlertDescription>{t("autopilot.config.overview.unreadable")}</AlertDescription></Alert>
        ) : (
          <>
            {noChapters && (
              <Alert variant="destructive" className="space-y-2">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t("autopilot.config.overview.noChapters")}</span>
                  <Link className="font-medium underline underline-offset-4" to={scaletta}>{t("autopilot.config.overview.edit")}</Link>
                </AlertDescription>
              </Alert>
            )}
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              {facts.map(([label, value], position) => (
                <div key={label} className={position === 0 ? "min-w-0 sm:col-span-2" : "min-w-0"}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  {/* The idea is read as an excerpt, six lines at most: the whole of it is on the Scaletta page. */}
                  <dd className={position === 0 ? "line-clamp-6 whitespace-pre-line break-words" : "break-words"}>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("autopilot.config.overview.synopsis")}</p>
              <p className="line-clamp-3 whitespace-pre-line break-words text-sm">{synopsis || none}</p>
              {/* Two sources that can disagree: the entries of the Synopsis bind, and the brief's text is the older fallback (#125). */}
              {synopsis && chapters > 0 && (
                <div data-synopsis-binds="" className="mt-2 space-y-2 rounded-lg border border-layer bg-muted/30 p-3 text-sm">
                  <p>{t("autopilot.config.overview.synopsisBinds")}</p>
                  {onSynopsisOnly && <SynopsisOnly onConfirm={onSynopsisOnly} onOutcome={setSynopsisOutcome} />}
                </div>
              )}
              {synopsisOutcome && (
                <p role="status" data-synopsis-only-outcome={synopsisOutcome} className={synopsisOutcome === "saved" ? "mt-2 text-sm font-medium" : "mt-2 text-sm font-medium text-destructive"}>
                  {synopsisOutcome === "saved" ? t("autopilot.config.overview.synopsisOnlyDone") : synopsisOutcome === "conflict" ? t("autopilot.config.overview.synopsisOnlyConflict") : t("autopilot.config.overview.synopsisOnlyFailed")}
                </p>
              )}
            </div>
            {lastChapter > 0 && <p className="text-sm font-medium">{t("autopilot.config.overview.length", { count: lastChapter, words: formatWhole(brief.wordsPerScene, locale) })}</p>}
          </>
        )}
      </section>

      {preview}
    </div>
  );
}

/** «Use my Synopsis only», asked once more before the brief's text is emptied, and what came of it. */
function SynopsisOnly({ onConfirm, onOutcome }: { onConfirm: () => Promise<SynopsisOnlyOutcome>; onOutcome: (outcome: SynopsisOnlyOutcome | null) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [step, setStep] = useState<"idle" | "asking" | "saving">("idle");
  const confirm = async () => {
    setStep("saving");
    const result = await onConfirm().catch((): SynopsisOnlyOutcome => "failed");
    onOutcome(result);
    setStep("idle");
  };
  return (
    <div className="space-y-2">
      {step === "idle" ? (
        <Button type="button" size="sm" variant="outline" data-synopsis-only="" aria-describedby={`${id}-hint`} onClick={() => { onOutcome(null); setStep("asking"); }}>
          <Eraser className="h-4 w-4" aria-hidden="true" />{t("autopilot.config.overview.synopsisOnly")}
        </Button>
      ) : (
        <div role="group" aria-labelledby={`${id}-ask`} className="space-y-2">
          <p id={`${id}-ask`} className="font-medium">{t("autopilot.config.overview.synopsisOnlyAsk")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" data-synopsis-only-confirm="" disabled={step === "saving"} onClick={() => void confirm()}>
              {step === "saving" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Eraser className="h-4 w-4" aria-hidden="true" />}{t("autopilot.config.overview.synopsisOnlyConfirm")}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={step === "saving"} onClick={() => setStep("idle")}>{t("autopilot.config.overview.synopsisOnlyCancel")}</Button>
          </div>
        </div>
      )}
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t("autopilot.config.overview.synopsisOnlyHint")}</p>
    </div>
  );
}
