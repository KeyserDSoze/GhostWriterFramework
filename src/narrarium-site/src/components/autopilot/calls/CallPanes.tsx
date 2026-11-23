import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import type { AiCallField, AiCallRecord } from "narrarium-engine";
import type { CallsSource } from "@/autopilot/calls/source";
import { formatBytes, formatCount } from "@/autopilot/format";
import { sayInLiveVoice } from "@/autopilot/liveText";
import { textAttemptsOf } from "@/components/autopilot/calls/callFacts";
import { TextBuffer, utf8Bytes } from "@/components/autopilot/calls/textBuffer";
import { TextPane } from "@/components/autopilot/calls/TextPane";
import { TARGET } from "@/components/autopilot/calls/ui";
import { useCallText } from "@/components/autopilot/calls/useCallText";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A system or user message is shown up to this many lines until the reader asks for all of it. */
export const COLLAPSED_LINES = 40;
/** …and up to this many characters, for a text whose lines are very long. */
export const COLLAPSED_CHARACTERS = 8000;

/** What every pane of a call needs. */
export interface PaneProps {
  source: CallsSource;
  bookId: string;
  record: AiCallRecord;
  raw: boolean;
  /** Says at once, in the status line of the history, what the reader's action did. */
  announce: (text: string) => void;
}

/** «12 lines · 3,456 characters · 3.4 KB»: what a pane holds. */
function counters(t: ReturnType<typeof useTranslation>["t"], lines: number, characters: number, bytes: number): string {
  return [t("autopilot.calls.pane.lines", { count: lines, value: formatCount(lines) }), t("autopilot.calls.pane.characters", { count: characters, value: formatCount(characters) }), formatBytes(bytes)].join(" · ");
}

/** Copies the whole text of a pane, and says it did (or that it could not), at once: the answer to the reader's click. */
function CopyButton({ pane, text, announce }: { pane: string; text: () => string; announce: (text: string) => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard");
      await navigator.clipboard.writeText(text());
      setState("copied");
      announce(t("autopilot.calls.pane.copied"));
      timer.current = setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("failed");
      announce(t("autopilot.calls.pane.copyFailed"));
    }
  };
  return (
    <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2">
      {state === "failed" && <p className="text-xs text-destructive">{t("autopilot.calls.pane.copyFailed")}</p>}
      <Button type="button" variant="ghost" size="sm" onClick={() => void copy()} data-copy-pane className={cn("h-auto px-2", TARGET)}>
        {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {state === "copied" ? t("autopilot.calls.pane.copied") : t("autopilot.calls.pane.copy")}
        <span className="sr-only">{t("autopilot.calls.pane.copyOf", { pane })}</span>
      </Button>
    </div>
  );
}

/** The head of a pane: its name, what it holds, what it is, and Copy. */
function PaneHead({ id, name, detail, notes, copy }: { id: string; name: string; detail: string; notes?: ReactNode; copy: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <h6 id={id} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{name}</h6>
      <span className="text-xs tabular-nums text-muted-foreground">{detail}</span>
      {notes}
      {copy}
    </div>
  );
}

function PaneError({ error, retry }: { error: unknown; retry: () => void }) {
  const { t } = useTranslation();
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
      <span className="min-w-0 break-words">{t("autopilot.calls.error", { message })}</span>
      <Button type="button" variant="outline" size="sm" className={cn("h-auto", TARGET)} onClick={retry}>{t("autopilot.calls.retry")}</Button>
    </div>
  );
}

/** A text of `text` alone, for the head of a long message. */
function bufferOf(text: string): TextBuffer {
  const buffer = new TextBuffer();
  buffer.append(text);
  return buffer;
}

/** The system or the user message of a call, as it was sent: up to 40 lines until the reader asks for all of it. */
export const PromptPane = memo(function PromptPane({ source, bookId, record, raw, announce, field }: PaneProps & { field: Exclude<AiCallField, "response"> }) {
  const { t } = useTranslation();
  const text = useCallText({ source, bookId, callId: record.callId, field, running: false });
  const [all, setAll] = useState(false);
  const name = t(`autopilot.calls.pane.${field}`);
  const id = `${record.callId}-${field}`;
  const { buffer, version } = text;
  // The buffer changes in place: its version says when.
  const head = useMemo(() => buffer.head(COLLAPSED_LINES, COLLAPSED_CHARACTERS), [buffer, version]);
  const long = buffer.lines > COLLAPSED_LINES || !head.whole;
  const shown = useMemo(() => (all || !long ? buffer : bufferOf(head.text)), [all, long, buffer, head]);
  const size = formatBytes(buffer.bytes);
  const lines = t("autopilot.calls.pane.lines", { count: buffer.lines, value: formatCount(buffer.lines) });
  return (
    <section aria-labelledby={id} data-call-pane={field} className="min-w-0 space-y-1.5">
      <PaneHead id={id} name={name} detail={text.loading ? "" : counters(t, buffer.lines, buffer.characters, buffer.bytes)} copy={buffer.characters > 0 && <CopyButton pane={name} text={() => buffer.text} announce={announce} />} />
      {text.error ? (
        <PaneError error={text.error} retry={text.retry} />
      ) : (
        <TextPane key={all ? "all" : "head"} label={t("autopilot.calls.pane.label", { pane: name, call: record.label })} buffer={shown} version={shown === buffer ? version : shown.version} raw={raw} streaming={false} placeholder={text.loading ? t("autopilot.calls.loading") : t("autopilot.calls.pane.empty")} />
      )}
      {long && !text.error && (
        <Button type="button" variant="outline" size="sm" aria-expanded={all} onClick={() => setAll(!all)} data-show-all className={cn("h-auto whitespace-normal text-left", TARGET)}>
          {all ? t("autopilot.calls.pane.showLess") : t("autopilot.calls.pane.showAll", { lines, size })}
        </Button>
      )}
    </section>
  );
});

/** Whether a whole response reads as JSON: an object or a list, from its first character to its last. */
function asJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || !((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

/**
 * The response of a call. While the call runs it fills in as it streams (from the record, and the end of the live events while the record is behind),
 * keeping its end in sight until the reader scrolls up. A call that has ended shows the reply of its last attempt with text, and any other attempt's on
 * request; a partial or failed reply says so. A whole reply that is JSON is laid out, unless Raw is on. What it says out loud goes through the polite voice
 * of the page: that a later call of the step answers, that its answer is complete, or that it failed or started again.
 */
export const ResponsePane = memo(function ResponsePane({ source, bookId, record, raw, announce, running, liveActivityId }: PaneProps & { running: boolean; liveActivityId: string | null }) {
  const { t, i18n } = useTranslation();
  const texts = useMemo(() => textAttemptsOf(record), [record]);
  const [chosen, setChosen] = useState<number | null>(null);
  const picked = running ? undefined : chosen ?? undefined;
  const name = t("autopilot.calls.pane.response");
  const id = `${record.callId}-response`;
  const label = record.label;
  const text = useCallText({
    source,
    bookId,
    callId: record.callId,
    field: "response",
    attempt: picked,
    running,
    liveActivityId,
    onRestart: () => sayInLiveVoice(bookId, t("autopilot.calls.say.retrying", { call: label }), 3),
  });
  const { buffer, version, tail } = text;
  const streaming = running && !text.done;

  // What is said out loud about a call that was followed while it ran: its first words (a later call of the step: the band said the first), and its end.
  const followed = useRef(running);
  const spoke = useRef({ answering: false, ended: false });
  useEffect(() => {
    if (!followed.current) return;
    if (streaming && !spoke.current.answering && record.seq > 1 && (buffer.characters > 0 || tail.extra)) {
      spoke.current.answering = true;
      sayInLiveVoice(bookId, t("autopilot.calls.say.answering", { call: label }), 1);
    }
    if (!running && !spoke.current.ended) {
      spoke.current.ended = true;
      const characters = record.response.text?.characters ?? buffer.characters;
      const value = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language).format(characters);
      if (record.status === "ok") sayInLiveVoice(bookId, t("autopilot.calls.say.complete", { count: characters, value }), 2);
      else sayInLiveVoice(bookId, t("autopilot.calls.say.failed", { call: label }), 3);
    }
  }, [streaming, running, version, tail.extra, record, buffer, bookId, label, t, i18n]);

  // The reply laid out as JSON once it is whole, unless Raw asks for the exact text (the buffer changes in place: its version says when).
  const json = useMemo(() => (!raw && text.done && !streaming ? asJson(buffer.text) : null), [raw, text.done, streaming, buffer, version]);
  const laidOut = useMemo(() => (json === null ? null : bufferOf(json)), [json]);
  const shown = laidOut ?? buffer;

  const current = picked === undefined ? texts[texts.length - 1] : texts.find((entry) => entry.number === picked);
  const outcome = current?.attempt.outcome ?? null;
  const isLast = current !== undefined && current === texts[texts.length - 1];
  const notes: ReactNode[] = [];
  if (!running && isLast && record.response.partial) notes.push(<span key="partial" className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300">{t("autopilot.calls.pane.partial")}</span>);
  else if (!running && current && outcome !== "ok") notes.push(<span key="failed" className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-800 dark:text-red-300">{t("autopilot.calls.pane.failed")}</span>);

  const characters = buffer.characters + tail.extra.length;
  const detail = text.loading && !tail.extra ? "" : counters(t, Math.max(buffer.lines, tail.extra ? 1 : 0), characters, buffer.bytes + utf8Bytes(tail.extra));
  const placeholder = running
    ? tail.bytes !== null
      ? t("autopilot.calls.pane.answering", { size: formatBytes(tail.bytes) })
      : t("autopilot.calls.pane.waiting")
    : text.loading
      ? t("autopilot.calls.loading")
      : record.response.text === null
        ? t("autopilot.calls.pane.empty")
        : t("autopilot.calls.pane.notKept");
  const radio = `${record.callId}-reply`;
  return (
    <section aria-labelledby={id} data-call-pane="response" className="min-w-0 space-y-1.5">
      <PaneHead id={id} name={name} detail={detail} notes={notes} copy={characters > 0 && <CopyButton pane={name} text={() => (laidOut ? laidOut.text : buffer.text + tail.extra)} announce={announce} />} />
      {!running && texts.length > 1 && (
        <fieldset className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <legend className="sr-only">{t("autopilot.calls.pane.replyOf")}</legend>
          <span aria-hidden="true" className="text-muted-foreground">{t("autopilot.calls.pane.replyOf")}</span>
          {texts.map(({ number, attempt }) => (
            <label key={number} className={cn("inline-flex cursor-pointer items-center gap-1.5", TARGET)}>
              <input type="radio" name={radio} value={number} checked={(picked ?? texts[texts.length - 1].number) === number} onChange={() => setChosen(number)} className="h-4 w-4 accent-primary" />
              {attempt.outcome === "ok" ? t("autopilot.calls.pane.replyAttempt", { number: attempt.index }) : t("autopilot.calls.pane.replyAttemptOutcome", { number: attempt.index, outcome: t(`autopilot.calls.attemptFacts.outcome.${attempt.outcome}`) })}
            </label>
          ))}
        </fieldset>
      )}
      {streaming && text.restarts > 0 && <p className="text-xs text-muted-foreground">{t("autopilot.calls.pane.restarted", { number: text.restarts + 1 })}</p>}
      {json !== null && <p className="text-xs text-muted-foreground">{t("autopilot.calls.pane.json")}</p>}
      {text.error && !streaming ? (
        <PaneError error={text.error} retry={text.retry} />
      ) : (
        <TextPane label={t("autopilot.calls.pane.label", { pane: name, call: label })} buffer={shown} version={shown === buffer ? version : shown.version} raw={raw} streaming={streaming} extra={laidOut ? "" : tail.extra} placeholder={placeholder} mono={laidOut !== null} />
      )}
    </section>
  );
});
