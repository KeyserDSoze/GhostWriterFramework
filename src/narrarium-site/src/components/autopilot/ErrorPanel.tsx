import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Copy, Loader2, Play, Timer } from "lucide-react";
import { ENGINE_VERSION, type AutopilotActivity, type AutopilotEvent } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { ConnectionCheck } from "@/components/autopilot/ConnectionCheck";
import { ErrorFiles } from "@/components/autopilot/StopNotices";
import { KindIcon } from "@/components/autopilot/KindIcon";
import { APP_VERSION } from "@/config/version";
import { useBookAutopilotView, useNow } from "@/autopilot/hooks";
import { diagnosticsText, errorActions, errorFacts, failureSource, formatCountdown, formatLimit, offersConnectionCheck, retryAfterSeconds, secondsLeft, timeoutOf, type ErrorFact, type FailureSource, type TimeoutNote } from "@/autopilot/errorModel";
import { taskLabel } from "@/autopilot/format";
import { useAutopilotStore, type FeedEntry } from "@/autopilot/store";
import { mergeLog } from "@/autopilot/timelineModel";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { useAutopilotControl } from "@/autopilot/useAutopilotControl";
import { toolsOnlyReport } from "@/router/toolsOnly";
import { useSettingsStore } from "@/store/settingsStore";
import { cn } from "@/lib/utils";

const NO_ACTIVITIES: AutopilotActivity[] = [];
const NO_EVENTS: AutopilotEvent[] = [];
const NO_FEED: FeedEntry[] = [];

/** The failures whose words are what a person needs to read, so they are said in the alert and not kept for the technical details: a configuration error names the models. */
const WORDS_ARE_THE_POINT = new Set(["unknown", "profile", "config"]);
/** The failures that may name a file of the book. */
const NAMES_FILES = new Set(["conflict", "profile", "unknown"]);

const FACT_LABEL: Record<ErrorFact["key"], string> = {
  endpoint: "autopilot.failure.facts.endpoint",
  model: "autopilot.failure.facts.model",
  provider: "autopilot.failure.facts.provider",
  integration: "autopilot.failure.facts.integration",
  status: "autopilot.failure.facts.status",
  attempt: "autopilot.failure.facts.attempt",
};

/**
 * The time until the runner tries again, counted from the moment the engine says (it is the engine's clock: a page opened in the middle of the wait shows what is
 * left of it), and said to a screen reader twice and no more: when the wait begins and when it is over. The count itself is a timer, which is not read out as it goes,
 * and it is not inside the alert, which would read it at every tick. It holds at “trying again now” until the engine says the attempt has begun.
 */
function Countdown({ at }: { at: string }) {
  const { t } = useTranslation();
  const now = useNow(1000, true);
  const seconds = secondsLeft(at, now);
  const over = seconds === 0;
  const [announcement, setAnnouncement] = useState("");
  // A new wait (another moment for the attempt) is told once, from what is left of it then.
  useEffect(() => {
    const left = secondsLeft(at, Date.now());
    setAnnouncement(left !== null && left > 0 ? t("autopilot.failure.countdown.announceStart", { time: formatCountdown(left) }) : "");
    // The words of the announcement are fixed when it is made: a change of language does not tell it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);
  useEffect(() => {
    if (over) setAnnouncement(t("autopilot.failure.countdown.announceNow"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over, at]);
  if (seconds === null) return null;
  return (
    <>
      <p className="flex items-center gap-2 text-sm font-medium">
        <Timer className="h-4 w-4 shrink-0 text-amber-800 dark:text-amber-300" aria-hidden="true" />
        <span role="timer" data-error-countdown className="tabular-nums">{over ? t("autopilot.failure.countdown.now") : t("autopilot.failure.countdown.in", { time: formatCountdown(seconds) })}</span>
      </p>
      <p role="status" data-error-announcement className="sr-only">{announcement}</p>
    </>
  );
}

/** Where it happened, in the words of the engine and the app: the step by its kind (its title is in the history), then what the engine knows of the call. */
function Facts({ source, integrationName }: { source: FailureSource; integrationName: (id: string) => string | undefined }) {
  const { t } = useTranslation();
  const facts = errorFacts(source.detail, integrationName);
  // A retry the summary says and the failure does not (a failure of an older engine, a step not in the log yet) is told all the same.
  if (source.retry && !facts.some((fact) => fact.key === "attempt")) facts.push({ key: "attempt", attempt: source.retry.attempt, retries: source.retry.retries });
  const rows: Array<{ key: string; label: string; value: string }> = [];
  if (source.step) rows.push({ key: "step", label: t("autopilot.failure.facts.step"), value: taskLabel(t, source.step.task, source.step.chapterNumber) });
  for (const fact of facts) rows.push({ key: fact.key, label: t(FACT_LABEL[fact.key]), value: fact.key === "attempt" ? t("autopilot.failure.facts.attemptOf", { attempt: fact.attempt, retries: fact.retries }) : fact.value });
  if (!rows.length) return null;
  return (
    <dl data-error-facts className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-x-4">
      {rows.map((row) => (
        <Fragment key={row.key}>
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words font-medium">{row.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * Which deadline ran out, how long it was and where it is changed. It is outside the alert: the deadline can differ from one attempt to the next, and the alert holds what
 * does not. The total limit cannot be changed, and says so.
 */
function TimeoutNotice({ note }: { note: TimeoutNote }) {
  const { t, i18n } = useTranslation();
  const what = t(`autopilot.failure.timeout.what.${note.phase}`);
  const limit = note.ms === undefined ? t("autopilot.failure.timeout.limitNoTime", { what }) : t("autopilot.failure.timeout.limit", { what, time: formatLimit(note.ms, i18n.resolvedLanguage ?? i18n.language) });
  return (
    <p data-error-timeout className="text-sm">
      <span className="font-medium">{limit}.</span>{" "}
      {note.phase === "total" ? t("autopilot.failure.timeout.fixed") : t("autopilot.failure.timeout.change", { field: t(`autopilot.failure.timeout.field.${note.phase}`) })}
    </p>
  );
}

/**
 * The section of the panel. When the panel goes away with the focus in it (the retry was made, or the attempt began) the focus is not lost to the page: it goes to the band,
 * which is right above, so that a keyboard goes on from there. A panel that goes away while the focus is somewhere else does not take it.
 */
function PanelSection({ children, ...props }: ComponentPropsWithoutRef<"section">) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (element?.contains(document.activeElement)) document.querySelector<HTMLElement>("[data-autopilot-band]")?.focus({ preventScroll: true });
    };
  }, []);
  return <section ref={ref} {...props}>{children}</section>;
}

/**
 * What went wrong, in one panel under the band: for a run that ended with an error, and for a failure the runner is going to try again. It says what kind of failure
 * it was and what that means, how many times the step failed in a row (once, not once for each attempt), where it happened (the endpoint, the model, the provider, the
 * integration by its name, the status, which retry), how long until the next attempt, and what can be done: retry now, open the AI Integrations, open the file the
 * error names, copy the diagnostics. The words of the provider are kept for whoever wants them. The alert holds what does not change from one attempt to the next, so
 * it is announced once; the count, the facts and the buttons are outside it.
 */
export function ErrorPanel({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const titleId = useId();
  const control = useAutopilotControl(bookId);
  const view = useBookAutopilotView(bookId);
  const book = useSettingsStore((state) => state.settings.books.find((entry) => entry.id === bookId));
  const integrations = useSettingsStore((state) => state.settings.aiIntegrations);
  const settings = useSettingsStore((state) => state.settings);
  const { busy, commands } = useAutopilotActions(bookId, { unreachable: control.running && !control.controllable });
  const [copied, setCopied] = useState<"none" | "done" | "failed">("none");
  // Nothing is worked out for a book that has nothing wrong: the feed and the log are looked at only once the summary says there is a failure to tell.
  const failing = failureSource(control.summary, NO_ACTIVITIES) !== null;
  const feed = useAutopilotStore((state) => (failing ? state.feed : NO_FEED));
  const events = useMemo(() => (failing ? feed.filter((entry) => entry.event.bookId === bookId).map((entry) => entry.event) : NO_EVENTS), [failing, feed, bookId]);
  const log = useMemo(() => (failing ? mergeLog(view.snapshot?.activities ?? NO_ACTIVITIES, events, undefined) : NO_ACTIVITIES), [failing, view.snapshot?.activities, events]);
  const source = useMemo(() => failureSource(control.summary, log), [control.summary, log]);
  // The confirmation belongs to the text that was copied: another failure, or none, starts without one (this component stays when the panel goes away).
  const failureKey = source ? `${source.kind}|${source.at ?? ""}|${source.message}` : "";
  useEffect(() => setCopied("none"), [failureKey]);
  // A configuration error is repeated by the same configuration: whether the settings still give it is worked out for that kind only.
  const isConfig = source?.kind === "config";
  const configurationBlocks = useMemo(() => isConfig && toolsOnlyReport(settings).blocked.length > 0, [isConfig, settings]);
  if (!source) return null;

  const { kind } = source;
  const host = book?.autopilotHost === "server" ? "server" : "browser";
  const noAi = host === "browser" && integrations.length === 0;
  const integrationName = (id: string) => integrations.find((entry) => entry.id === id)?.name;
  const actions = errorActions(kind, { configurationBlocks });
  const timeout = kind === "timeout" ? timeoutOf(source.detail) : null;
  const retryAfter = retryAfterSeconds(source.detail);
  const retryLabel = t("autopilot.failure.actions.retry");
  const integrationId = source.detail.integration;
  // A check of the connection is for the failures an endpoint can cause, on the integration of the step that failed when this browser has it and it has a list to ask (OpenAI-compatible).
  const checked = offersConnectionCheck(kind) && integrationId ? integrations.find((entry) => entry.id === integrationId && entry.provider === "openai") : undefined;

  async function copyDiagnostics() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(diagnosticsText({ source: source as FailureSource, appVersion: APP_VERSION, engineVersion: ENGINE_VERSION, host, at: new Date(), integrationName: integrationId ? integrationName(integrationId) : undefined }));
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <PanelSection
      data-autopilot-error
      data-kind={kind}
      aria-labelledby={titleId}
      className={cn("space-y-3 rounded-2xl border p-4 sm:p-5", source.ended ? "border-red-500/50 bg-red-500/5 dark:border-red-400/50" : "border-amber-500/50 bg-amber-500/5 dark:border-amber-400/50")}
    >
      <div role="alert" className="space-y-2">
        <h2 id={titleId} className={cn("flex items-start gap-2 text-base font-semibold", source.ended ? "text-red-700 dark:text-red-300" : "text-amber-800 dark:text-amber-300")}>
          <KindIcon kind={kind} className="mt-1 h-4 w-4 shrink-0" />
          <span>{t(`autopilot.failure.kind.${kind}.title`)}</span>
        </h2>
        <p className="text-sm">{t(`autopilot.failure.kind.${kind}.explain`)}</p>
        {WORDS_ARE_THE_POINT.has(kind) && source.message && (
          <p className="whitespace-pre-wrap break-words text-sm">
            <span className="font-medium">{t("autopilot.lastError")}:</span>{" "}
            {/* The engine wrote the sentence of a configuration error in English, whatever the language of the app. */}
            <span lang={kind === "config" ? "en" : undefined}>{source.message}</span>
          </p>
        )}
      </div>
      {source.repeats > 1 && <p className="text-sm font-medium">{t("autopilot.failure.repeats", { count: source.repeats })}</p>}
      <Facts source={source} integrationName={integrationName} />
      {timeout && <TimeoutNotice note={timeout} />}
      {retryAfter !== null && <p data-error-retry-after className="text-sm font-medium">{t("autopilot.failure.retryAfter", { time: formatCountdown(retryAfter) })}</p>}
      {source.retry && <Countdown at={source.retry.at} />}
      {NAMES_FILES.has(kind) && source.message && (
        <div className="space-y-1.5">
          <ErrorFiles bookId={bookId} message={source.message} hint={kind === "profile"} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {source.ended && actions.retry !== "hidden" && (
          <Button size="sm" variant={actions.first === "retry" ? "default" : "outline"} disabled={busy !== null || noAi} aria-label={t("autopilot.quick.named", { label: retryLabel, context: book?.name ?? bookId })} onClick={() => void commands.resume()}>
            {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
            {retryLabel}
          </Button>
        )}
        {actions.integrations && (
          <Button asChild size="sm" variant={actions.first === "integrations" ? "default" : "outline"}>
            <Link to="/app/settings/ai-integrations">{t("autopilot.failure.actions.integrations")}</Link>
          </Button>
        )}
        {actions.router && (
          <Button asChild size="sm" variant="outline">
            <Link to="/app/settings/ai-router#tools-only">{t("autopilot.failure.config.openRouter")}</Link>
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void copyDiagnostics()}>
          <Copy className="h-4 w-4" aria-hidden="true" />
          {t("autopilot.failure.actions.copy")}
        </Button>
        <p role="status" data-error-copy className="min-w-0 text-xs text-muted-foreground">{copied === "done" ? t("autopilot.failure.actions.copied") : copied === "failed" ? t("autopilot.failure.actions.copyFailed") : ""}</p>
      </div>
      {checked && <ConnectionCheck key={failureKey} integration={checked} hostedOnServer={host === "server"} />}
      {source.ended && actions.retry === "hidden" && <p data-error-retry-hint className="text-xs text-muted-foreground">{t("autopilot.failure.config.retryHint")}</p>}
      {!WORDS_ARE_THE_POINT.has(kind) && source.message && (
        <details className="text-xs">
          <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("autopilot.failure.actions.details")}</summary>
          <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono">{source.message}</p>
        </details>
      )}
    </PanelSection>
  );
}
