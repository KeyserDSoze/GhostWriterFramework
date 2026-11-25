import { memo, useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Ban, CheckCircle2, ChevronRight, Loader2, ScrollText, X, XCircle } from "lucide-react";
import type { AiCallRecord, AiCallStatus } from "narrarium-engine";
import type { CallsSource } from "@/autopilot/calls/source";
import { formatBytes, formatCount, formatDateTime, formatDuration, taskLabel } from "@/autopilot/format";
import { useNow } from "@/autopilot/hooks";
import { PHONE_SCREENS } from "@/autopilot/liveText";
import { callElementId } from "@/components/autopilot/calls/anchors";
import { useCallsView } from "@/components/autopilot/calls/callsView";
import { askedAttempts, costWords, errorWords, failedAttempts, leftOutAttempts, modelOf, timesOf, transportFacts, useOf } from "@/components/autopilot/calls/callFacts";
import { leftOutReason } from "@/autopilot/routeWords";
import { useSettingsStore } from "@/store/settingsStore";
import { PromptPane, ResponsePane } from "@/components/autopilot/calls/CallPanes";
import { ProviderWords } from "@/components/autopilot/ProviderWords";
import { TARGET } from "@/components/autopilot/calls/ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";

/** How a call is, as a shape (the words say it too): it answers, it is done, it failed, it was cut, it was stopped. */
function CallStatusIcon({ status }: { status: AiCallStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 shrink-0 text-primary motion-safe:animate-spin" aria-hidden="true" />;
  if (status === "ok") return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />;
  if (status === "aborted") return <Ban className="h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-500" aria-hidden="true" />;
  if (status === "interrupted") return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-500" aria-hidden="true" />;
  return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />;
}

/** One fact of a call: a term and what it is, in the list under its header. */
function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

/** What the settings call an integration of a record, by its id: the name the author gave it, and nothing when this device does not know it (a record of a personal server, an integration that is gone). */
function useIntegrationName(): (id: string | null | undefined) => string | undefined {
  const integrations = useSettingsStore((state) => state.settings.aiIntegrations);
  return (id) => (id ? integrations.find((entry) => entry.id === id)?.name : undefined);
}

/** What a call asked, of which model, how it went, when and for how long, what it sent and received, what it used and cost. In words and figures. */
function CallFacts({ record, now }: { record: AiCallRecord; now: number }) {
  const { t } = useTranslation();
  const integrationName = useIntegrationName();
  const { model, provider, integrationId } = modelOf(record);
  const where = integrationName(integrationId) ?? provider;
  const use = useOf(record);
  const { tookMs, firstWordsMs } = timesOf(record, now);
  const { request } = record;
  const images = request.images > 0 ? ` · ${t("autopilot.calls.call.images", { count: request.images, value: formatCount(request.images) })}` : "";
  const answer = record.response.text;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
      <Fact term={t("autopilot.calls.call.asked")}>{record.label || taskLabel(t, record.task, record.chapter ?? undefined)}</Fact>
      {record.capability && <Fact term={t("autopilot.calls.call.for")}>{t(`settings.capability.${record.capability}`, { defaultValue: record.capability })}</Fact>}
      {model && <Fact term={t("autopilot.calls.call.model")}>{where ? `${model} (${where})` : model}</Fact>}
      <Fact term={t("autopilot.calls.call.status")}>{t(`autopilot.calls.status.${record.status}`)}{record.response.partial ? ` · ${t("autopilot.calls.call.partial")}` : ""}</Fact>
      <Fact term={t("autopilot.calls.call.started")}>{formatDateTime(record.timing.startedAt)}</Fact>
      {tookMs !== null && <Fact term={t("autopilot.calls.call.took")}>{formatDuration(tookMs)}</Fact>}
      {firstWordsMs !== null && <Fact term={t("autopilot.calls.call.firstWords")}>{formatDuration(firstWordsMs)}</Fact>}
      <Fact term={t("autopilot.calls.call.sent")}>{t("autopilot.calls.call.sentValue", { system: formatBytes(request.system.storedBytes), user: formatBytes(request.user.storedBytes) })}{images}</Fact>
      {answer && <Fact term={t("autopilot.calls.call.answer")}>{t("autopilot.calls.call.answerValue", { size: formatBytes(answer.storedBytes), characters: formatCount(answer.characters) })}</Fact>}
      {request.structured && request.tool && <Fact term={t("autopilot.calls.call.structured")}><code className="font-mono">{request.tool}</code></Fact>}
      <Fact term={t("autopilot.calls.call.tokens")}>{use.tokens ? t("autopilot.calls.call.tokensValue", { input: formatCount(use.tokens.input), cached: formatCount(use.tokens.cached), output: formatCount(use.tokens.output) }) : t("autopilot.calls.call.tokensUnknown")}</Fact>
      <Fact term={t("autopilot.calls.call.cost")}>{costWords(t, use)}</Fact>
      {record.dropped && <Fact term={t("autopilot.calls.call.limits")}>{t(`autopilot.calls.call.dropped.${record.dropped}`)}</Fact>}
    </dl>
  );
}

/** The attempts of a call that did not work: who answered, how it ended, and what the transport saw, as figures. */
function FailedAttempts({ record }: { record: AiCallRecord }) {
  const { t } = useTranslation();
  const integrationName = useIntegrationName();
  const failed = failedAttempts(record);
  if (failed.length === 0) return null;
  return (
    <ul className="space-y-1.5" data-failed-attempts>
      {failed.map((attempt) => {
        const head = [t("autopilot.calls.attemptFacts.title", { number: attempt.index }), integrationName(attempt.integrationId) ?? attempt.provider, attempt.model, t(`autopilot.calls.attemptFacts.outcome.${attempt.outcome}`), typeof attempt.durationMs === "number" ? formatDuration(attempt.durationMs) : ""].filter(Boolean).join(" · ");
        const facts = transportFacts(t, attempt);
        const error = errorWords(t, attempt);
        return (
          <li key={attempt.index} className="space-y-0.5 rounded-md border-l-2 border-red-500/60 bg-red-500/5 px-2 py-1.5 text-xs">
            <p className="font-medium">{head}</p>
            {(attempt.endpoint || attempt.apiVersion) && <p className="break-all text-muted-foreground">{[attempt.endpoint, attempt.apiVersion ? t("autopilot.calls.attemptFacts.apiVersion", { version: attempt.apiVersion }) : ""].filter(Boolean).join(" · ")}</p>}
            {facts.length > 0 && <p className="tabular-nums text-muted-foreground">{facts.join(" · ")}</p>}
            {error && <p className="break-words text-destructive [overflow-wrap:anywhere]">{error}</p>}
            {attempt.error?.body && <ProviderWords body={attempt.error.body} scope="autopilot.calls.provider" className="pt-0.5" />}
            {attempt.transport?.tail && (
              <p className="break-words text-muted-foreground [overflow-wrap:anywhere]"><span className="font-medium">{t("autopilot.calls.attemptFacts.tail")}:</span> <span className="font-mono">{attempt.transport.tail}</span></p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The candidates of the route that the call did not ask, each with why: a primary whose window cannot hold the prompt is not taken for one that was asked and failed. */
function LeftOut({ record }: { record: AiCallRecord }) {
  const { t } = useTranslation();
  const integrationName = useIntegrationName();
  const left = leftOutAttempts(record);
  if (left.length === 0) return null;
  return (
    <div className="space-y-1" data-left-out-box>
      <p className="text-xs font-medium">{t("autopilot.route.leftOutTitle")}</p>
      <ul className="space-y-1" data-left-out>
        {left.map((attempt) => (
          <li key={attempt.index} className="rounded-md border-l-2 border-amber-500/60 bg-amber-500/5 px-2 py-1.5 text-xs">
            <span className="font-medium">{t("autopilot.route.target", { integration: integrationName(attempt.integrationId) ?? attempt.provider ?? attempt.integrationId ?? "?", model: attempt.model ?? "?" })}</span>
            {" — "}
            {t("autopilot.route.leftOut", { reason: leftOutReason(t, { reason: attempt.skip?.reason, why: attempt.skip?.why, promptTokens: attempt.skip?.promptTokens, windowTokens: attempt.skip?.windowTokens }) })}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface CallSectionProps {
  source: CallsSource;
  bookId: string;
  record: AiCallRecord;
  open: boolean;
  onToggle: (callId: string) => void;
  raw: boolean;
  announce: (text: string) => void;
  /** The step whose live events stream this call's answer, when it is the call that answers now. */
  liveActivityId: string | null;
  /** A link points at this call: it takes the focus once it is drawn. */
  revealed: boolean;
}

/** What an open call shows: its facts, the figures of its failed attempts, and its three texts. */
function CallBody({ source, bookId, record, raw, announce, liveActivityId, now }: Omit<CallSectionProps, "open" | "onToggle" | "revealed"> & { now: number }) {
  const running = record.status === "running";
  return (
    <div className="min-w-0 space-y-3">
      <CallFacts record={record} now={now} />
      <LeftOut record={record} />
      <FailedAttempts record={record} />
      <PromptPane source={source} bookId={bookId} record={record} raw={raw} announce={announce} field="system" />
      <PromptPane source={source} bookId={bookId} record={record} raw={raw} announce={announce} field="user" />
      <ResponsePane source={source} bookId={bookId} record={record} raw={raw} announce={announce} running={running} liveActivityId={liveActivityId} />
    </div>
  );
}

/**
 * An open call on a phone: a sheet as tall as the screen, where its texts have the whole width. The focus goes into it and, when it closes (its button,
 * Escape, the back gesture), back to the header of the call. It has Raw too, for the whole page.
 */
function CallSheet({ title, summary, onClose, header, children }: { title: string; summary: string; onClose: () => void; header: RefObject<HTMLButtonElement | null>; children: ReactNode }) {
  const { t } = useTranslation();
  const raw = useCallsView((state) => state.raw);
  const setRaw = useCallsView((state) => state.setRaw);
  const content = useRef<HTMLDivElement>(null);
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        bare
        hideCloseButton
        ref={content}
        tabIndex={-1}
        data-call-sheet
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          header.current?.focus();
        }}
        className="inset-x-0 bottom-0 top-2 flex w-full flex-col overflow-hidden rounded-t-2xl border-x-0 border-b-0 bg-card text-card-foreground focus:outline-none"
      >
        <header className="flex items-center gap-2 border-b px-3 py-1.5">
          <DialogTitle className="line-clamp-2 min-w-0 flex-1 break-words text-base font-semibold">{title}</DialogTitle>
          <Button type="button" variant="ghost" size="sm" aria-pressed={raw} title={t("autopilot.calls.rawHint")} onClick={() => setRaw(!raw)} className={cn("h-auto shrink-0 px-2 aria-pressed:bg-primary/15 aria-pressed:text-foreground", TARGET)}>
            <ScrollText aria-hidden="true" />
            {t("autopilot.calls.raw")}
          </Button>
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="icon" aria-label={t("autopilot.calls.close")} className="h-11 w-11 shrink-0">
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </header>
        {/* relative: what is placed in it without a box of its own (the hidden words of its buttons) scrolls and is clipped with it, not with the sheet. */}
        <div className="relative min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3">
          <DialogDescription className="break-words text-xs text-muted-foreground">{summary}</DialogDescription>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One call of a step: a header that says it in words (what it asked, the model, how it went, how long, what it received, its attempts) and opens it,
 * and under it, when it is open, its facts, the figures of its failed attempts and its three texts; on a phone they open in a sheet of their own, where
 * the texts have the width of the screen. Its anchor is `#call-<id>`.
 */
export const CallSection = memo(function CallSection({ source, bookId, record, open, onToggle, raw, announce, liveActivityId, revealed }: CallSectionProps) {
  const { t } = useTranslation();
  const running = record.status === "running";
  const now = useNow(1000, running);
  const phone = useMediaQuery(PHONE_SCREENS);
  const { model } = modelOf(record);
  const asked = askedAttempts(record).length;
  const leftOut = leftOutAttempts(record).length;
  const { tookMs } = timesOf(record, now);
  const element = useRef<HTMLElement>(null);
  const header = useRef<HTMLButtonElement>(null);
  const body = useId();
  const head = useId();
  const answer = record.response.text;
  const label = record.label || taskLabel(t, record.task, record.chapter ?? undefined);
  const summary = [
    model,
    `${t(`autopilot.calls.status.${record.status}`)}${record.response.partial ? ` · ${t("autopilot.calls.call.partial")}` : ""}`,
    tookMs !== null ? formatDuration(tookMs) : "",
    answer ? t("autopilot.calls.call.received", { size: formatBytes(answer.storedBytes) }) : running ? t("autopilot.calls.call.nothingYet") : "",
    asked > 1 ? t("autopilot.calls.call.attempts", { count: asked, value: formatCount(asked) }) : "",
    leftOut > 0 ? t("autopilot.calls.call.leftOut", { count: leftOut, value: formatCount(leftOut) }) : "",
  ].filter(Boolean).join(" · ");

  // A link to this call: the section comes into sight under the band and takes the focus, once (a jump, never a smooth scroll). On a phone the sheet
  // it opens in takes the focus instead.
  useEffect(() => {
    if (!revealed || !element.current) return;
    element.current.scrollIntoView?.({ block: "start" });
    if (!phone) element.current.focus({ preventScroll: true });
  }, [revealed, phone]);

  const content = <CallBody source={source} bookId={bookId} record={record} raw={raw} announce={announce} liveActivityId={liveActivityId} now={now} />;
  return (
    <section
      ref={element}
      id={callElementId(record.callId)}
      tabIndex={-1}
      aria-labelledby={head}
      data-call={record.callId}
      data-call-status={record.status}
      className="min-w-0 scroll-mt-8 rounded-md border bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[revealed]:focus:ring-2 data-[revealed]:focus:ring-ring"
      data-revealed={revealed ? "" : undefined}
    >
      <h5 id={head} className="text-sm">
        <button
          ref={header}
          type="button"
          aria-expanded={open}
          aria-controls={phone ? undefined : body}
          aria-haspopup={phone ? "dialog" : undefined}
          onClick={() => onToggle(record.callId)}
          className={cn("flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-2 text-left transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-2.5", TARGET)}
        >
          <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && !phone && "rotate-90")} aria-hidden="true" />
          <CallStatusIcon status={record.status} />
          <span className="min-w-0 flex-1 basis-40 break-words font-medium">{label}</span>
          <span className="min-w-0 break-words text-xs font-normal text-muted-foreground">{summary}</span>
        </button>
      </h5>
      {phone ? (
        open && <CallSheet title={label} summary={summary} onClose={() => onToggle(record.callId)} header={header}>{content}</CallSheet>
      ) : (
        <div id={body}>{open && <div className="border-t px-2 py-2 sm:px-2.5 sm:py-2.5">{content}</div>}</div>
      )}
    </section>
  );
});
