import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Info, MessagesSquare, MoreHorizontal, Pin, ScrollText } from "lucide-react";
import type { AiCallRecord } from "narrarium-engine";
import "@/i18n/autopilotCalls";
import type { CallsSource, CallsUnavailableReason } from "@/autopilot/calls/source";
import { useCallsSource } from "@/autopilot/calls/sourceHook";
import { formatBytes, formatCount } from "@/autopilot/format";
import { callIdOfHash } from "@/components/autopilot/calls/anchors";
import { CallSection } from "@/components/autopilot/calls/CallSection";
import { useCallsView } from "@/components/autopilot/calls/callsView";
import { TARGET } from "@/components/autopilot/calls/ui";
import { useCallTask } from "@/components/autopilot/calls/useCallTask";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/store/settingsStore";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why the messages cannot be read here, in the author's words: never an error. */
function Unavailable({ reason }: { reason: Exclude<CallsUnavailableReason, "unwired"> }) {
  const { t } = useTranslation();
  return (
    <p data-calls-unavailable={reason} className="flex items-start gap-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{t(`autopilot.calls.unavailable.${reason}`)}</span>
    </p>
  );
}

/** «Keep»: the messages of this step are never deleted to make room. Pressed or not, as the store says; a choice that cannot be saved is taken back and said so. */
function KeepToggle({ source, bookId, activityId, pinned }: { source: CallsSource; bookId: string; activityId: string; pinned: boolean }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(pinned);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    if (!busy.current) setValue(pinned);
  }, [pinned]);
  const toggle = async () => {
    const next = !value;
    busy.current = true;
    setValue(next);
    setError(null);
    try {
      await source.keep(bookId, activityId, next);
    } catch (failure) {
      setValue(!next);
      setError(messageOf(failure));
    } finally {
      busy.current = false;
    }
  };
  return (
    <>
      <Button type="button" variant="ghost" size="sm" aria-pressed={value} title={t("autopilot.calls.keepHint")} onClick={() => void toggle()} data-keep-task className={cn("h-auto px-2 aria-pressed:bg-primary/15 aria-pressed:text-foreground", TARGET)}>
        <Pin aria-hidden="true" />
        {t("autopilot.calls.keep")}
      </Button>
      {error && <p className="w-full text-xs text-destructive">{t("autopilot.calls.keepFailed", { message: error })}</p>}
    </>
  );
}

/** The calls of one task (one attempt of a step): its header (how many, how much, Keep) and a section for each call. */
const AttemptCalls = memo(function AttemptCalls({ source, bookId, activityId, heading, running, latest, raw, announce, epoch }: { source: CallsSource; bookId: string; activityId: string; heading: string | null; running: boolean; latest: boolean; raw: boolean; announce: (text: string) => void; epoch: number }) {
  const { t } = useTranslation();
  const { task, loading, error, reload } = useCallTask(source, bookId, activityId, running, epoch);
  const location = useLocation();
  const target = callIdOfHash(location.hash);
  const opened = useCallsView((state) => state.open);
  const setOpen = useCallsView((state) => state.setOpen);
  const [revealed, setRevealed] = useState<string | null>(null);
  const followed = useRef<string | null>(null);
  const calls = useMemo(() => task?.calls ?? [], [task]);

  // A link to a call of this task opens it, and the call takes the focus once it is drawn: once for each visit of the link.
  useEffect(() => {
    if (!target || !calls.some((call) => call.callId === target)) return;
    const visit = `${location.key}:${target}`;
    if (followed.current === visit) return;
    followed.current = visit;
    setOpen(target, true);
    setRevealed(target);
  }, [calls, target, location.key, setOpen]);

  // Open unless the reader closed it: the call that answers now, and the last call of the attempt that counts.
  const defaults = useRef(new Map<string, boolean>());
  defaults.current = new Map(calls.map((call, index) => [call.callId, call.status === "running" || (latest && index === calls.length - 1)]));
  const isOpen = (call: AiCallRecord) => opened[call.callId] ?? defaults.current.get(call.callId) ?? false;
  const toggle = useCallback((callId: string) => {
    const state = useCallsView.getState();
    state.setOpen(callId, !(state.open[callId] ?? defaults.current.get(callId) ?? false));
  }, []);
  const answering = running ? [...calls].reverse().find((call) => call.status === "running")?.callId ?? null : null;

  return (
    <div data-call-task={activityId} className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {heading && <p className="text-xs font-semibold">{heading}</p>}
        {task && task.calls.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{t("autopilot.calls.summary", { count: task.calls.length, value: formatCount(task.calls.length), size: formatBytes(task.header.bytes) })}</span>}
        {task && <div className="ml-auto flex flex-wrap items-center gap-1"><KeepToggle source={source} bookId={bookId} activityId={activityId} pinned={task.header.pinned} /></div>}
      </div>
      {error && !task ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 break-words">{t("autopilot.calls.error", { message: messageOf(error) })}</span>
          <Button type="button" variant="outline" size="sm" className={cn("h-auto", TARGET)} onClick={reload}>{t("autopilot.calls.retry")}</Button>
        </div>
      ) : loading && !task ? (
        <p className="text-xs text-muted-foreground">{t("autopilot.calls.loading")}</p>
      ) : calls.length === 0 ? (
        <p data-calls-empty className="text-xs text-muted-foreground">{running ? t("autopilot.calls.emptyRunning") : t("autopilot.calls.empty")}</p>
      ) : (
        <ol className="min-w-0 space-y-1.5">
          {calls.map((call) => (
            <li key={call.callId} className="min-w-0">
              <CallSection source={source} bookId={bookId} record={call} open={isOpen(call)} onToggle={toggle} raw={raw} announce={announce} liveActivityId={call.callId === answering ? activityId : null} revealed={revealed === call.callId} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});

/** The tasks of the book that the store keeps, counted page by page for the dialog that deletes them (at most ten pages of 200). */
async function countTasks(source: CallsSource, bookId: string): Promise<{ tasks: number; bytes: number; more: boolean }> {
  let tasks = 0;
  let bytes = 0;
  let before: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await source.listTasks(bookId, { ...(before === undefined ? {} : { before }), limit: 200 });
    tasks += result.tasks.length;
    bytes += result.tasks.reduce((sum, task) => sum + task.bytes, 0);
    if (!result.next) return { tasks, bytes, more: false };
    before = result.next;
  }
  return { tasks, bytes, more: true };
}

/** «Delete all the messages of this book»: what it deletes, where, and that the history stays; asked before it is done. */
function DeleteAllDialog({ source, bookId, onClose, announce }: { source: CallsSource; bookId: string; onClose: () => void; announce: (text: string) => void }) {
  const { t } = useTranslation();
  const server = useSettingsStore((state) => state.settings.books.find((book) => book.id === bookId)?.autopilotHost === "server");
  const deleted = useCallsView((state) => state.deleted);
  const [count, setCount] = useState<{ tasks: number; bytes: number; more: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    countTasks(source, bookId)
      .then((result) => {
        if (!cancelled) setCount(result);
      })
      .catch(() => {
        if (!cancelled) setCount({ tasks: 0, bytes: 0, more: true });
      });
    return () => {
      cancelled = true;
    };
  }, [source, bookId]);
  const where = server ? t("autopilot.calls.whereServer") : t("autopilot.calls.whereBrowser");
  const body = !count
    ? t("autopilot.calls.deleteCounting")
    : count.more
      ? t("autopilot.calls.deleteBodyMany", { value: formatCount(count.tasks), where })
      : t("autopilot.calls.deleteBody", { count: count.tasks, value: formatCount(count.tasks), size: formatBytes(count.bytes), where });
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await source.deleteAll(bookId);
      deleted();
      announce(t("autopilot.calls.deleted"));
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent data-calls-delete className="max-w-md">
        <DialogTitle>{t("autopilot.calls.deleteTitle")}</DialogTitle>
        <DialogDescription>{body}</DialogDescription>
        {error && <p className="text-sm text-destructive">{t("autopilot.calls.deleteFailed", { message: error })}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" className={cn("h-auto", TARGET)} disabled={busy} onClick={onClose}>{t("autopilot.calls.cancel")}</Button>
          <Button type="button" variant="destructive" className={cn("h-auto", TARGET)} disabled={busy || !count} onClick={() => void confirm()}>{busy ? t("autopilot.calls.deleting") : t("autopilot.calls.deleteConfirm")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface TaskCallsProps {
  bookId: string;
  /** The activities of the step, oldest first: one task each. */
  activityIds: readonly string[];
  /** The step runs: its last attempt is followed while it answers. */
  running: boolean;
  /** Says at once, in the status line of the history, what the reader's action did. */
  announce: (text: string) => void;
}

/**
 * The task view: the messages a step exchanged with the AI, one section for each call of each of its attempts, with Raw (the exact text, for the whole
 * page), Keep (for each attempt) and, in its menu, the deletion of every record of the book. Where the records cannot be read it says why, in words.
 */
export default function TaskCalls({ bookId, activityIds, running, announce }: TaskCallsProps) {
  const { t } = useTranslation();
  const source = useCallsSource(bookId);
  const raw = useCallsView((state) => state.raw);
  const setRaw = useCallsView((state) => state.setRaw);
  const epoch = useCallsView((state) => state.epoch);
  const [deleting, setDeleting] = useState(false);
  const heading = useId();
  if (!source.available && (source.reason === "unwired" || !source.reason)) return null;
  return (
    <section aria-labelledby={heading} data-task-calls className="min-w-0 space-y-2 border-t pt-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 id={heading} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <MessagesSquare className="h-3.5 w-3.5" aria-hidden="true" />
          {t("autopilot.calls.title")}
        </h4>
        {source.available && (
          <div className="ml-auto flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" aria-pressed={raw} title={t("autopilot.calls.rawHint")} onClick={() => setRaw(!raw)} data-calls-raw className={cn("h-auto px-2 aria-pressed:bg-primary/15 aria-pressed:text-foreground", TARGET)}>
              <ScrollText aria-hidden="true" />
              {t("autopilot.calls.raw")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" title={t("autopilot.calls.more")} aria-label={t("autopilot.calls.more")} data-calls-menu className={cn("h-auto w-11 sm:w-9", TARGET)}>
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setDeleting(true)} className="text-destructive focus:text-destructive">{t("autopilot.calls.deleteAll")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      {source.available && source.notRecording && <Unavailable reason="recording-off" />}
      {!source.available && source.reason && source.reason !== "unwired" ? (
        <Unavailable reason={source.reason} />
      ) : (
        activityIds.map((activityId, index) => (
          <AttemptCalls
            key={activityId}
            source={source}
            bookId={bookId}
            activityId={activityId}
            heading={activityIds.length > 1 ? t("autopilot.calls.attempt", { number: index + 1 }) : null}
            running={running && index === activityIds.length - 1}
            latest={index === activityIds.length - 1}
            raw={raw}
            announce={announce}
            epoch={epoch}
          />
        ))
      )}
      {deleting && <DeleteAllDialog source={source} bookId={bookId} onClose={() => setDeleting(false)} announce={announce} />}
    </section>
  );
}
