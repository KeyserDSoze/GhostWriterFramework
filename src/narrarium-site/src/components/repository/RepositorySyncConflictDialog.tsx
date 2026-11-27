import "@/i18n/repositoryConflicts";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ChevronRight, Info, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ConflictDiff, ConflictDiffRow } from "@/components/diff/conflictDiff";
import { createConflictDiffer } from "@/components/diff/conflictDiffClient";
import type { RepositorySyncConflict, RepositorySyncConflictResolution, RepositorySyncProgress, RepositorySyncStep, SyncResult } from "@/repository/repositoryService";
import { cn } from "@/lib/utils";

/** How applying the choices ended, as the caller (the top bar, which runs the sync) tells the window. */
export type ConflictApplyOutcome =
  | { kind: "done"; result: SyncResult; reload: boolean }
  | { kind: "stopped" }
  /** The caller gave the window a new list of files: something changed while the author chose, or GitHub changed again meanwhile. */
  | { kind: "replaced"; reason: "stale" | "changed" }
  | { kind: "nothing" }
  | { kind: "failed"; message: string };

export interface ConflictApplyControl {
  signal: AbortSignal;
  onProgress: (progress: RepositorySyncProgress) => void;
}

type Stage = "choose" | "applying" | "done" | "failed";
type Notice = "stopped" | "stale" | "changed" | "nothing";
type DiffState = ConflictDiff | "failed";

/** The steps a stop can still undo: nothing on this device or on GitHub has changed yet. */
const STOPPABLE: ReadonlySet<RepositorySyncStep> = new Set(["waiting", "checking", "downloading"]);
/** Rows of differences drawn at first, and added by each «Show more». */
const ROWS_AT_ONCE = 300;

const utf8 = new TextEncoder();

function formatSize(bytes: number, language: string): string {
  const number = (value: number, fraction: number) => new Intl.NumberFormat(language, { maximumFractionDigits: fraction }).format(value);
  if (bytes < 1024) return `${number(bytes, 0)} B`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024, 1)} KB`;
  return `${number(bytes / (1024 * 1024), 1)} MB`;
}

/** A choice between two versions: the whole line is the target, and the state is the mark of the radio, never only a colour. */
function Choice({ name, checked, disabled, label, ariaLabel, onChange }: { name: string; checked: boolean; disabled: boolean; label: string; ariaLabel: string; onChange: () => void }) {
  return (
    <label className={cn("flex min-h-11 min-w-0 items-center gap-2.5 rounded-md border bg-background px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-background", checked && "border-primary bg-primary/5 font-medium", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-accent/50")}>
      <input type="radio" name={name} checked={checked} disabled={disabled} aria-label={ariaLabel} onChange={onChange} className="h-4 w-4 shrink-0 accent-primary focus-visible:outline-none" />
      <span className="min-w-0 break-words">{label}</span>
    </label>
  );
}

/** A note of the window, in words and with an icon (never only a colour). */
function Note({ tone, role, focusRef, children }: { tone: "info" | "warning" | "error" | "success"; role?: "status" | "alert"; focusRef?: RefObject<HTMLDivElement>; children: ReactNode }) {
  const frame = { info: "border-border bg-muted/40", warning: "border-amber-500/50 bg-amber-500/5", error: "border-red-500/50 bg-red-500/5", success: "border-emerald-600/40 bg-emerald-500/10" }[tone];
  const icon = {
    info: <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />,
    warning: <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-500" aria-hidden />,
    error: <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" aria-hidden />,
    success: <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />,
  }[tone];
  return (
    <div ref={focusRef} role={role} tabIndex={focusRef ? -1 : undefined} className={cn("flex items-start gap-2 rounded-md border p-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring", frame)}>
      {icon}
      <div className="min-w-0 flex-1 space-y-1.5 break-words">{children}</div>
    </div>
  );
}

function rowTone(type: ConflictDiffRow["type"]): string {
  if (type === "add") return "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200";
  if (type === "remove") return "bg-red-500/10 text-red-900 dark:text-red-200";
  return "text-foreground/80";
}

const DiffLine = memo(function DiffLine({ row }: { row: ConflictDiffRow }) {
  const { t } = useTranslation();
  if (row.type === "gap") {
    return (
      <tr className="bg-muted/50 text-muted-foreground">
        <td colSpan={4} className="px-2 py-0.5 text-center font-sans">⋯ {t("repositoryConflicts.diff.gap", { count: row.skipped ?? 0 })}</td>
      </tr>
    );
  }
  const sign = row.type === "add" ? "+" : row.type === "remove" ? "−" : "";
  const said = row.type === "add" ? t("repositoryConflicts.diff.onlyRemote") : row.type === "remove" ? t("repositoryConflicts.diff.onlyLocal") : t("repositoryConflicts.diff.same");
  return (
    <tr className={rowTone(row.type)}>
      <td className="select-none border-r px-1 text-right align-top tabular-nums text-muted-foreground">{row.oldNumber ?? ""}</td>
      <td className="select-none border-r px-1 text-right align-top tabular-nums text-muted-foreground">{row.newNumber ?? ""}</td>
      <td className="select-none px-1 text-center align-top"><span aria-hidden="true">{sign}</span><span className="sr-only">{said}</span></td>
      <td className="whitespace-pre-wrap px-2 align-top [overflow-wrap:anywhere]">
        {row.text || "\u00a0"}
        {row.clipped ? <span className="text-muted-foreground"> {t("repositoryConflicts.diff.clipped", { count: row.clipped })}</span> : null}
      </td>
    </tr>
  );
});

/** The differences of one file: only the changed lines and a few around them, long lines wrapped inside the block, a few hundred rows at a time. */
function DiffBlock({ path, diff }: { path: string; diff: DiffState | undefined }) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(ROWS_AT_ONCE);
  if (diff === undefined) {
    return <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />{t("repositoryConflicts.diff.comparing")}</p>;
  }
  if (diff === "failed") return <p className="text-xs text-muted-foreground">{t("repositoryConflicts.diff.failed")}</p>;
  if (!diff.rows.length) return <p className="text-xs text-muted-foreground">{t("repositoryConflicts.diff.identical")}</p>;
  const rows = diff.rows.slice(0, limit);
  const more = diff.rows.length - rows.length;
  return (
    <div className="min-w-0 space-y-2">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span><span aria-hidden="true" className="mr-1 inline-block w-4 rounded-sm bg-red-500/15 text-center font-mono text-red-900 dark:text-red-200">−</span>{t("repositoryConflicts.diff.legendLocal")}</span>
        <span><span aria-hidden="true" className="mr-1 inline-block w-4 rounded-sm bg-emerald-500/15 text-center font-mono text-emerald-900 dark:text-emerald-200">+</span>{t("repositoryConflicts.diff.legendRemote")}</span>
      </p>
      <div className="max-h-[min(24rem,55dvh)] min-w-0 overflow-auto overscroll-contain rounded-md border bg-background" data-conflict-diff>
        <table className="w-full table-fixed border-collapse font-mono text-xs leading-5">
          <caption className="sr-only">{t("repositoryConflicts.diff.caption", { path })}</caption>
          <colgroup>
            <col className="w-9 sm:w-12" />
            <col className="w-9 sm:w-12" />
            <col className="w-5" />
            <col />
          </colgroup>
          <thead className="sr-only">
            <tr>
              <th scope="col">{t("repositoryConflicts.diff.columnLocal")}</th>
              <th scope="col">{t("repositoryConflicts.diff.columnRemote")}</th>
              <th scope="col">{t("repositoryConflicts.diff.columnChange")}</th>
              <th scope="col">{t("repositoryConflicts.diff.columnText")}</th>
            </tr>
          </thead>
          <tbody>{rows.map((row, index) => <DiffLine key={index} row={row} />)}</tbody>
        </table>
      </div>
      {more > 0 && (
        <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setLimit((current) => current + ROWS_AT_ONCE)}>
          {t("repositoryConflicts.diff.more", { count: Math.min(more, ROWS_AT_ONCE) })}
        </Button>
      )}
      {more === 0 && diff.hidden > 0 && <p className="text-xs text-muted-foreground">{t("repositoryConflicts.diff.hidden", { count: diff.hidden })}</p>}
    </div>
  );
}

/** One file changed on both sides: its path, what each side did, the two versions to keep, and its differences on request. */
const ConflictFile = memo(function ConflictFile({ conflict, index, uid, choice, diff, onChoose }: { conflict: RepositorySyncConflict; index: number; uid: string; choice: RepositorySyncConflictResolution | undefined; diff: DiffState | undefined; onChoose: (path: string, choice: RepositorySyncConflictResolution) => void }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const pathId = `${uid}-path-${index}`;
  const diffId = `${uid}-diff-${index}`;
  const side = useMemo(() => {
    const describe = (deleted: boolean, content: string | null) => deleted
      ? t("repositoryConflicts.side.deleted")
      : content === null ? t("repositoryConflicts.side.changed") : t("repositoryConflicts.side.sized", { state: t("repositoryConflicts.side.changed"), size: formatSize(utf8.encode(content).byteLength, i18n.language) });
    return t("repositoryConflicts.side.line", { local: describe(conflict.localDeleted, conflict.localContent), remote: describe(conflict.remoteDeleted, conflict.remoteContent) });
  }, [conflict, i18n.language, t]);
  const stats = conflict.kind !== "text" ? t("repositoryConflicts.binary")
    : diff === undefined ? t("repositoryConflicts.diff.comparing")
      : diff === "failed" ? t("repositoryConflicts.diff.failed")
        : diff.added + diff.removed === 0 ? t("repositoryConflicts.diff.identical")
          : t("repositoryConflicts.diff.stats", { added: diff.added, removed: diff.removed });
  return (
    <li className="min-w-0 space-y-2 rounded-lg border bg-background/70 p-3" data-conflict-file={conflict.path}>
      <code id={pathId} dir="auto" className="block break-all text-sm font-semibold">{conflict.path}</code>
      <p className="text-xs text-muted-foreground">{side}</p>
      <p className="text-xs text-muted-foreground">{stats}</p>
      <div role="radiogroup" aria-labelledby={pathId} className="grid min-w-0 gap-2 sm:grid-cols-2">
        <Choice name={`${uid}-choice-${index}`} checked={choice === "local"} disabled={false} label={t("repositoryConflicts.choice.local")} ariaLabel={t("repositoryConflicts.choice.localFor", { path: conflict.path })} onChange={() => onChoose(conflict.path, "local")} />
        <Choice name={`${uid}-choice-${index}`} checked={choice === "remote"} disabled={false} label={t("repositoryConflicts.choice.remote")} ariaLabel={t("repositoryConflicts.choice.remoteFor", { path: conflict.path })} onChange={() => onChoose(conflict.path, "remote")} />
      </div>
      {choice === "remote" && <p className="text-xs text-muted-foreground">{t("repositoryConflicts.choice.remoteNote")}</p>}
      {conflict.kind === "text" && (
        <div className="min-w-0 space-y-2">
          <Button type="button" variant="ghost" size="sm" className="min-h-11 px-2" aria-expanded={open} aria-controls={diffId} onClick={() => setOpen((current) => !current)}>
            <ChevronRight className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
            {t(open ? "repositoryConflicts.diff.hide" : "repositoryConflicts.diff.show")}
          </Button>
          <div id={diffId} hidden={!open} className="min-w-0">
            {open && <DiffBlock path={conflict.path} diff={diff} />}
          </div>
        </div>
      )}
    </li>
  );
});

/** The steps the sync has reached, in order, each with its mark in words; the current one is announced once, when it starts. */
function Progress({ id, reached, counts, focusRef }: { id: string; reached: RepositorySyncStep[]; counts: Partial<Record<RepositorySyncStep, { done: number; total: number }>>; focusRef: RefObject<HTMLHeadingElement> }) {
  const { t } = useTranslation();
  const current = reached[reached.length - 1];
  return (
    <section className="space-y-3" aria-labelledby={id} data-sync-progress>
      <h3 id={id} ref={focusRef} tabIndex={-1} className="text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("repositoryConflicts.progress.title")}</h3>
      <p role="status" className="sr-only">{current ? t("repositoryConflicts.progress.announce", { step: t(`repositoryConflicts.progress.step.${current}`) }) : ""}</p>
      <ol className="space-y-2" data-sync-steps>
        {reached.map((step) => {
          const active = step === current;
          const count = counts[step];
          return (
            <li key={step} data-sync-step={step} data-state={active ? "current" : "done"} className="flex items-start gap-2 text-sm">
              {active ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />}
              <span className={cn("min-w-0 break-words", active && "font-medium")}>
                {t(`repositoryConflicts.progress.step.${step}`)}
                {count && count.total > 0 ? <span className="text-muted-foreground"> ({t("repositoryConflicts.progress.count", count)})</span> : null}
                <span className="sr-only"> — {t(active ? "repositoryConflicts.progress.state.current" : "repositoryConflicts.progress.state.done")}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Outcome({ result, kept, taken, reload, focusRef }: { result: SyncResult; kept: number; taken: number; reload: boolean; focusRef: RefObject<HTMLDivElement> }) {
  const { t } = useTranslation();
  const others = Math.max(0, result.pulled - taken);
  return (
    <div ref={focusRef} tabIndex={-1} role="status" data-conflicts-outcome className="space-y-2 rounded-md border border-emerald-600/40 bg-emerald-500/10 p-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <h3 className="flex items-center gap-2 font-semibold text-emerald-900 dark:text-emerald-300">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />
        {t("repositoryConflicts.result.title")}
      </h3>
      {kept > 0 && <p>{t("repositoryConflicts.result.kept", { count: kept })}</p>}
      {taken > 0 && <p>{t("repositoryConflicts.result.taken", { count: taken })}</p>}
      {others > 0 && <p>{t("repositoryConflicts.result.pulled", { count: others })}</p>}
      <p>{result.pushed > 0 ? t("repositoryConflicts.result.published", { count: result.pushed }) : t("repositoryConflicts.result.nothingPublished")}</p>
      {result.unpublished > 0 && (
        <p className="flex items-start gap-2 font-medium text-amber-900 dark:text-amber-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-500" aria-hidden />{t("repositoryConflicts.result.unpublished", { count: result.unpublished })}</p>
      )}
      {reload && <p>{t("repositoryConflicts.result.reload")}</p>}
    </div>
  );
}

/**
 * The window that settles the files a full sync found changed both on this device and on GitHub: one version of each to keep (or one side for all), the
 * differences of each file on request (computed off the page's thread, only the changed lines drawn), then the sync that applies the choices, step by
 * step, with a stop while nothing has changed yet, and what came of it. Everything stays inside the window: its body scrolls, long lines wrap inside
 * their block, and the title and the buttons stay in view. It cannot be closed while the choices are being applied.
 */
export function RepositorySyncConflictDialog({ conflicts, onApply, onClose, onReload }: {
  conflicts: RepositorySyncConflict[];
  onApply: (resolutions: Record<string, RepositorySyncConflictResolution>, control: ConflictApplyControl) => Promise<ConflictApplyOutcome>;
  onClose: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const uid = useId();
  const [choices, setChoices] = useState<Record<string, RepositorySyncConflictResolution>>({});
  const [stage, setStage] = useState<Stage>("choose");
  const [reached, setReached] = useState<RepositorySyncStep[]>([]);
  const [counts, setCounts] = useState<Partial<Record<RepositorySyncStep, { done: number; total: number }>>>({});
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [outcome, setOutcome] = useState<{ result: SyncResult; reload: boolean; kept: number; taken: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const controller = useRef<AbortController | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const progressRef = useRef<HTMLHeadingElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  const differ = useMemo(() => createConflictDiffer(), []);
  useEffect(() => () => differ.close(), [differ]);

  // A new list (the first, or one given after a change) starts with no choice, and its files are compared one after the other, off the page's thread.
  useEffect(() => {
    setChoices({});
    setDiffs({});
    let live = true;
    void (async () => {
      for (const conflict of conflicts) {
        if (conflict.kind !== "text") continue;
        const state: DiffState = await differ.compare(conflict.localDeleted ? "" : conflict.localContent ?? "", conflict.remoteDeleted ? "" : conflict.remoteContent ?? "").catch(() => "failed" as const);
        if (!live) return;
        setDiffs((current) => ({ ...current, [conflict.path]: state }));
      }
    })();
    return () => { live = false; };
  }, [conflicts, differ]);

  // Where the author looks next: the steps while they run, what came of them, the refusal, or the note that sent them back to choosing.
  useEffect(() => {
    if (stage === "applying") progressRef.current?.focus();
    else if (stage === "done") outcomeRef.current?.focus();
    else if (stage === "failed") failureRef.current?.focus();
    else if (notice) noticeRef.current?.focus();
  }, [stage, notice]);

  const choose = useCallback((path: string, value: RepositorySyncConflictResolution) => setChoices((current) => ({ ...current, [path]: value })), []);
  const chosen = conflicts.filter((conflict) => choices[conflict.path]).length;
  const complete = conflicts.length > 0 && chosen === conflicts.length;
  const current = reached[reached.length - 1];
  const stoppable = stage === "applying" && (!current || STOPPABLE.has(current));
  const leftId = `${uid}-left`;
  const noStopId = `${uid}-no-stop`;

  const close = () => {
    if (stage === "applying") return;
    if (stage === "done" && outcome?.reload) onReload();
    else onClose();
  };

  const apply = async () => {
    if (!complete || stage === "applying") return;
    const resolutions = Object.fromEntries(conflicts.map((conflict) => [conflict.path, choices[conflict.path]])) as Record<string, RepositorySyncConflictResolution>;
    const running = new AbortController();
    controller.current = running;
    setStage("applying");
    setNotice(null);
    setFailure(null);
    setStopping(false);
    setReached([]);
    setCounts({});
    let ended: ConflictApplyOutcome;
    try {
      ended = await onApply(resolutions, {
        signal: running.signal,
        onProgress: (progress) => {
          setReached((steps) => (steps[steps.length - 1] === progress.step ? steps : [...steps.filter((step) => step !== progress.step), progress.step]));
          if (progress.total !== undefined) setCounts((all) => ({ ...all, [progress.step]: { done: progress.done ?? 0, total: progress.total ?? 0 } }));
        },
      });
    } catch (error) {
      ended = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    controller.current = null;
    setStopping(false);
    if (ended.kind === "done") {
      const values = Object.values(resolutions);
      setOutcome({ result: ended.result, reload: ended.reload, kept: values.filter((value) => value === "local").length, taken: values.filter((value) => value === "remote").length });
      setStage("done");
    } else if (ended.kind === "failed") {
      setFailure(ended.message);
      setStage("failed");
    } else {
      setNotice(ended.kind === "replaced" ? ended.reason : ended.kind);
      setStage("choose");
    }
  };

  const stop = () => {
    if (!stoppable || stopping) return;
    setStopping(true);
    controller.current?.abort();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent
        hideCloseButton
        data-repository-conflicts
        aria-busy={stage === "applying"}
        className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:rounded-lg"
        onOpenAutoFocus={(event) => { event.preventDefault(); titleRef.current?.focus(); }}
        onEscapeKeyDown={(event) => { if (stage === "applying") event.preventDefault(); }}
        onInteractOutside={(event) => { if (stage === "applying") event.preventDefault(); }}
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 text-left sm:px-6 sm:py-4">
          <DialogTitle ref={titleRef} tabIndex={-1} className="break-words leading-snug focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("repositoryConflicts.title")}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-6" data-conflicts-body>
          <DialogDescription className="text-sm text-muted-foreground">{t("repositoryConflicts.description")}</DialogDescription>
          {notice && stage === "choose" && (
            <Note tone={notice === "stopped" ? "info" : "warning"} role="status" focusRef={noticeRef}><p>{t(`repositoryConflicts.notice.${notice}`)}</p></Note>
          )}
          {stage === "choose" && notice !== "nothing" && (
            <>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby={`${uid}-all`}>
                <span id={`${uid}-all`} className="text-sm font-medium">{t("repositoryConflicts.all.label")}</span>
                <Button type="button" variant="outline" size="sm" className="h-auto min-h-11 whitespace-normal text-left" onClick={() => setChoices(Object.fromEntries(conflicts.map((conflict) => [conflict.path, "local"])))}>{t("repositoryConflicts.all.local")}</Button>
                <Button type="button" variant="outline" size="sm" className="h-auto min-h-11 whitespace-normal text-left" onClick={() => setChoices(Object.fromEntries(conflicts.map((conflict) => [conflict.path, "remote"])))}>{t("repositoryConflicts.all.remote")}</Button>
              </div>
              <section className="min-w-0 space-y-2">
                <h3 id={`${uid}-files`} className="text-sm font-semibold">{t("repositoryConflicts.files", { count: conflicts.length })}</h3>
                <ul aria-labelledby={`${uid}-files`} className="min-w-0 space-y-3">
                  {conflicts.map((conflict, index) => (
                    <ConflictFile key={conflict.path} conflict={conflict} index={index} uid={uid} choice={choices[conflict.path]} diff={diffs[conflict.path]} onChoose={choose} />
                  ))}
                </ul>
              </section>
            </>
          )}
          {stage === "applying" && <Progress id={`${uid}-progress`} reached={reached} counts={counts} focusRef={progressRef} />}
          {stage === "done" && outcome && <Outcome {...outcome} focusRef={outcomeRef} />}
          {stage === "failed" && (
            <Note tone="error" role="alert" focusRef={failureRef}>
              <p className="font-medium">{t("repositoryConflicts.failed.title")}</p>
              {failure && <p className="whitespace-pre-wrap break-words text-xs">{failure}</p>}
            </Note>
          )}
        </div>

        <div className="max-h-[45dvh] shrink-0 space-y-2 overflow-y-auto border-t px-4 py-3 sm:px-6" data-conflicts-footer>
          {stage === "choose" && notice !== "nothing" && (
            <p id={leftId} className="text-xs text-muted-foreground">
              {t("repositoryConflicts.summary.chosen", { chosen, total: conflicts.length })}
              {!complete && <> · {t("repositoryConflicts.summary.left", { count: conflicts.length - chosen })}</>}
            </p>
          )}
          {stage === "applying" && !stoppable && <p id={noStopId} className="text-xs text-muted-foreground">{t("repositoryConflicts.progress.noStop")}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {stage === "choose" && notice === "nothing" && <Button type="button" className="min-h-11" onClick={close}>{t("repositoryConflicts.result.close")}</Button>}
            {stage === "choose" && notice !== "nothing" && (
              <>
                <Button type="button" variant="outline" className="min-h-11" onClick={close}>{t("repositoryConflicts.cancel")}</Button>
                <Button type="button" className="h-auto min-h-11 whitespace-normal" disabled={!complete} aria-describedby={leftId} onClick={() => void apply()}>{t("repositoryConflicts.apply")}</Button>
              </>
            )}
            {stage === "applying" && (
              <>
                <Button type="button" variant="outline" className="min-h-11" disabled={!stoppable || stopping} aria-describedby={stoppable ? undefined : noStopId} onClick={stop}>
                  {stopping ? t("repositoryConflicts.progress.stopping") : t("repositoryConflicts.progress.stop")}
                </Button>
                <Button type="button" className="min-h-11" disabled>
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
                  {t("repositoryConflicts.applying")}
                </Button>
              </>
            )}
            {stage === "done" && (outcome?.reload
              ? <Button type="button" className="min-h-11" onClick={onReload}>{t("repositoryConflicts.result.reloadNow")}</Button>
              : <Button type="button" className="min-h-11" onClick={onClose}>{t("repositoryConflicts.result.close")}</Button>)}
            {stage === "failed" && (
              <>
                <Button type="button" variant="outline" className="min-h-11" onClick={close}>{t("repositoryConflicts.result.close")}</Button>
                <Button type="button" className="min-h-11" onClick={() => void apply()}>{t("repositoryConflicts.failed.retry")}</Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
