import "@/i18n/githubConflicts";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, Pause, Play, XCircle } from "lucide-react";
import type { GithubConflict, GithubConflictChoice } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConflictFile, sideText } from "@/components/autopilot/ConflictFile";
import { CONFLICTS_PAGE, pageCount, pageRange, type Failure, type Version } from "@/autopilot/githubConflicts";
import { useGithubConflicts } from "@/autopilot/useGithubConflicts";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { useAutopilotControl } from "@/autopilot/useAutopilotControl";
import { cn } from "@/lib/utils";

/** The text of each failure, by its kind (`githubConflicts.failure.<key>`): the words say what the server refused and what to do, never the server's own. */
const FAILURE_KEY: Record<Failure["kind"], string> = {
  busy: "busy",
  "not-conflicted": "notConflicted",
  "no-remote": "noRemote",
  "unrelated-histories": "unrelatedHistories",
  maintenance: "maintenance",
  "feature-unavailable": "oldServer",
  "book-missing": "bookMissing",
  forbidden: "forbidden",
  unreachable: "unreachable",
  changed: "other",
  "choice-missing": "choiceMissing",
  "invalid-path": "invalidPath",
  "git-failed": "gitFailed",
  "too-many": "tooMany",
  other: "other",
};

/** How many of the files without a version the notice names: the server names up to a hundred, and the author needs a few to find where to look. */
const NAMED_FILES = 5;

/** A choice between two versions, or among the ways to settle the others: the whole line is the target, and the state is the mark of the radio, never only a colour. */
function Choice({ name, checked, disabled, label, ariaLabel, onChange }: { name: string; checked: boolean; disabled: boolean; label: string; ariaLabel?: string; onChange: () => void }) {
  return (
    <label className={cn("flex min-h-11 items-center gap-2.5 rounded-md border bg-background px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-background", checked && "border-primary bg-primary/5", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-accent/50")}>
      <input type="radio" name={name} checked={checked} disabled={disabled} aria-label={ariaLabel} onChange={onChange} className="h-4 w-4 shrink-0 accent-primary focus-visible:outline-none" />
      <span className="min-w-0 break-words">{label}</span>
    </label>
  );
}

/** A note of the window: what the author should know, in words and with an icon (never only a colour). */
function Note({ tone, role, icon, children, className }: { tone: "warning" | "info" | "error" | "success"; role?: "status" | "alert" | "note"; icon?: ReactNode; children: ReactNode; className?: string }) {
  const frame = { warning: "border-amber-500/50 bg-amber-500/5", info: "border-border bg-muted/40", error: "border-red-500/50 bg-red-500/5", success: "border-emerald-600/40 bg-emerald-500/10" }[tone];
  return (
    <div role={role} className={cn("flex items-start gap-2 rounded-md border p-3 text-sm", frame, className)}>
      {icon}
      <div className="min-w-0 flex-1 space-y-1.5 break-words">{children}</div>
    </div>
  );
}

/** What the server said, in its own words: they are English whatever the language of the app, and are marked so. */
function Said({ text }: { text: string }) {
  const { t } = useTranslation();
  if (!text.trim()) return null;
  return (
    <p className="text-xs">
      <span className="font-medium">{t("githubConflicts.failure.said")}:</span>{" "}
      <span lang="en" className="whitespace-pre-wrap break-words">{text}</span>
    </p>
  );
}

interface FailureProps {
  failure: Failure;
  busy: boolean;
  /** The author may pause the run from here. */
  canPause: boolean;
  focusRef?: RefObject<HTMLDivElement>;
  onPause: () => void;
  onRetry: () => void;
  onReload: () => void;
}

/** One refusal, in words, with what can be done about it: the alert is one element, so that it is announced once. */
function FailureNotice({ failure, busy, canPause, focusRef, onPause, onRetry, onReload }: FailureProps) {
  const { t } = useTranslation();
  const key = FAILURE_KEY[failure.kind];
  const missing = failure.kind === "choice-missing" ? failure : null;
  const text = missing ? t(`githubConflicts.failure.${key}`, { count: missing.missing }) : t(`githubConflicts.failure.${key}`);
  const action = (label: string, onClick: () => void, variant: "default" | "outline" = "outline") => (
    <Button size="sm" variant={variant} className="min-h-11 whitespace-normal" disabled={busy} onClick={onClick}>{label}</Button>
  );
  let actions: ReactNode = null;
  switch (failure.kind) {
    case "busy": actions = canPause ? <Button size="sm" className="min-h-11 whitespace-normal" disabled={busy} onClick={onPause}><Pause className="h-4 w-4" aria-hidden />{t("githubConflicts.actions.pause")}</Button> : null; break;
    case "maintenance":
    case "invalid-path": actions = action(t("githubConflicts.actions.retry"), onRetry); break;
    case "unreachable":
    case "git-failed":
    case "other": actions = action(t("githubConflicts.actions.reload"), onReload); break;
    case "feature-unavailable":
    case "forbidden": actions = <Button asChild size="sm" variant="outline" className="min-h-11 whitespace-normal"><Link to="/app/settings/server">{t("githubConflicts.failure.settings")}</Link></Button>; break;
    default: break;
  }
  const detail = failure.kind === "invalid-path" || failure.kind === "git-failed" ? failure.detail : failure.kind === "other" && failure.server ? failure.message : "";
  const note = failure.kind === "other" && !failure.server ? failure.message : "";
  return (
    <Note tone="error" role="alert" icon={<XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" aria-hidden />}>
      <div ref={focusRef} tabIndex={-1} className="space-y-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <p>{text}</p>
        {note && <p className="text-xs">{note}</p>}
        {missing && missing.paths.length > 0 && (
          <ul className="space-y-0.5 text-xs">
            {missing.paths.slice(0, NAMED_FILES).map((path) => <li key={path}><code dir="auto" className="break-all">{path}</code></li>)}
            {missing.missing > NAMED_FILES && <li>{t("githubConflicts.failure.andMore", { count: missing.missing - NAMED_FILES })}</li>}
          </ul>
        )}
        <Said text={detail} />
      </div>
      {actions && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
    </Note>
  );
}

/** What was resolved, in the sentence of the spec, and how it stands with GitHub; it is announced politely, and the focus comes here. */
function Outcome({ answer, outcomeRef }: { answer: NonNullable<ReturnType<typeof useGithubConflicts>["state"]["answer"]>; outcomeRef: RefObject<HTMLDivElement> }) {
  const { t } = useTranslation();
  const { counts } = answer;
  const unpublished = !answer.pushed && !answer.pushError;
  return (
    <div
      ref={outcomeRef}
      data-github-conflicts-outcome
      role="status"
      aria-live="polite"
      tabIndex={-1}
      className="space-y-2 rounded-md border border-emerald-600/40 bg-emerald-500/10 p-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <h3 className="flex items-center gap-2 font-semibold text-emerald-800 dark:text-emerald-300">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
        {t("githubConflicts.done.title")}
      </h3>
      <p>{t("githubConflicts.done.summary", { kept: t("githubConflicts.done.kept", { count: counts.server }), taken: t("githubConflicts.done.taken", { count: counts.github }) })}</p>
      {counts.unresolvable > 0 && <p>{t("githubConflicts.done.fixed", { count: counts.unresolvable })}</p>}
      {counts.ignored > 0 && <p>{t("githubConflicts.done.ignored", { count: counts.ignored })}</p>}
      {answer.autopilotFiles && <p>{t(`githubConflicts.done.autopilotFiles.${answer.autopilotFiles}`)}</p>}
      {answer.pushed && <p>{t("githubConflicts.done.published")}</p>}
      {answer.pushError && (
        <div className="space-y-1">
          <p className="flex items-start gap-2 font-medium text-amber-800 dark:text-amber-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-600" aria-hidden />{t("githubConflicts.done.pushFailed")}</p>
          <Said text={answer.pushError} />
        </div>
      )}
      {unpublished && <p className="flex items-start gap-2"><Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />{t("githubConflicts.done.notPublished")}</p>}
    </div>
  );
}

/** One file the author chooses for: its path, what each side did with it, and the two versions to keep. */
function FileChoice({ conflict, index, uid, version, disabled, onChoose }: { conflict: GithubConflict; index: number; uid: string; version: GithubConflictChoice | undefined; disabled: boolean; onChoose: (version: Version) => void }) {
  const { t } = useTranslation();
  const pathId = `${uid}-file-${index}`;
  const line = t("githubConflicts.list.line", { server: sideText(t, conflict.server, conflict.serverBytes), github: sideText(t, conflict.github, conflict.githubBytes) });
  return (
    <ConflictFile path={conflict.path} pathId={pathId} line={line}>
      <div role="radiogroup" aria-labelledby={pathId} className="grid gap-2 sm:grid-cols-2">
        <Choice name={`${uid}-choice-${index}`} checked={version === "server"} disabled={disabled} label={t("githubConflicts.choose.server")} ariaLabel={t("githubConflicts.choose.serverFor", { path: conflict.path })} onChange={() => onChoose("server")} />
        <Choice name={`${uid}-choice-${index}`} checked={version === "github"} disabled={disabled} label={t("githubConflicts.choose.github")} ariaLabel={t("githubConflicts.choose.githubFor", { path: conflict.path })} onChange={() => onChoose("github")} />
      </div>
    </ConflictFile>
  );
}

/** Files the server cannot choose for: shown apart, with why, and kept as the server has them. */
function FixedFiles({ files }: { files: GithubConflict[] }) {
  const { t } = useTranslation();
  const headingId = useId();
  if (files.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 id={headingId} className="text-sm font-semibold">{t("githubConflicts.fixed.title", { count: files.length })}</h3>
      <p className="text-xs text-muted-foreground">{t("githubConflicts.fixed.hint")}</p>
      <ul aria-labelledby={headingId} className="space-y-2">
        {files.map((file) => (
          <ConflictFile key={file.path} path={file.path} line={file.reason ? t(`githubConflicts.fixed.reason.${file.reason}`) : t("githubConflicts.fixed.hint")} />
        ))}
      </ul>
    </section>
  );
}

function Resolver({ bookId, close, onBusy, titleRef }: { bookId: string; close: () => void; onBusy: (busy: boolean) => void; titleRef: RefObject<HTMLHeadingElement> }) {
  const { t } = useTranslation();
  const uid = useId();
  const { state, readiness, read, resolve, choose, chooseRest, clearFailure } = useGithubConflicts(bookId);
  const control = useAutopilotControl(bookId);
  const { busy, commands } = useAutopilotActions(bookId, { unreachable: control.running && !control.controllable });
  const { stage, listing, failure, draft, again } = state;
  const outcomeRef = useRef<HTMLDivElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const resolveRef = useRef<HTMLButtonElement>(null);
  const changingPage = useRef(false);
  const publishOff = control.summary?.publish === "off";
  const holding = busy !== null;
  const total = listing?.total ?? 0;
  const { from, to } = pageRange(listing?.offset ?? 0, listing?.conflicts.length ?? 0, total);
  const pages = pageCount(total);
  const page = Math.floor((listing?.offset ?? 0) / CONFLICTS_PAGE) + 1;

  useEffect(() => onBusy(stage === "resolving"), [stage, onBusy]);

  // Where the author looks next: at the summary once it is resolved, at the list when the page changed, at the refusal that replaced the list.
  useEffect(() => {
    if (stage === "done") outcomeRef.current?.focus();
    else if (stage === "list" && changingPage.current) {
      changingPage.current = false;
      listHeadingRef.current?.focus();
    } else if (stage === "failed") failureRef.current?.focus();
  }, [stage]);

  // The run was paused (from here, or somewhere else): what said it must be paused goes away, and the focus goes to the next thing to do.
  const stopped = !control.running;
  useEffect(() => {
    if (stopped && failure?.kind === "busy") {
      const hadFocus = document.activeElement === document.body || Boolean(footerRef.current?.contains(document.activeElement));
      clearFailure();
      if (hadFocus) window.setTimeout(() => resolveRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopped]);

  const fixed = useMemo(() => (listing?.conflicts ?? []).filter((conflict) => conflict.resolvable === false), [listing]);
  const choosable = useMemo(() => (listing?.conflicts ?? []).filter((conflict) => conflict.resolvable !== false), [listing]);
  const confirm = (version: Version, count: number) => window.confirm(t(`githubConflicts.confirm.${version}`, { count }));
  const goTo = (offset: number) => {
    changingPage.current = true;
    void read(offset);
  };
  const resume = async () => {
    if (await commands.resume()) close();
  };
  const showBusy = control.running || failure?.kind === "busy";
  // The run can be paused from here unless it is known to belong to another device.
  const canPause = !control.running || control.controllable;
  const ready = readiness.ready && !control.running;
  const statusText = stage === "loading"
    ? state.listing ? t("githubConflicts.list.loading", { from: state.offset + 1, to: Math.min(state.offset + CONFLICTS_PAGE, total) }) : t("githubConflicts.status.loading")
    : stage === "resolving" ? t("githubConflicts.status.resolving")
    : stage === "list" && listing ? t("githubConflicts.status.page", { from, to, total })
    : "";
  const noticeProps = { busy: holding, canPause, onPause: () => void commands.pause("now"), onRetry: () => void resolve(confirm), onReload: () => void read(state.offset) };
  const leftId = `${uid}-left`;

  return (
    <>
      <DialogHeader className="shrink-0 space-y-1 border-b p-4 pr-4 text-left sm:p-6">
        <DialogTitle ref={titleRef} tabIndex={-1} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("githubConflicts.dialog.title")}</DialogTitle>
        <DialogDescription>{t("githubConflicts.dialog.description")}</DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
        <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted-foreground empty:hidden">
          {statusText && (stage === "loading" || stage === "resolving") && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />}
          {statusText}
        </p>

        {stage === "failed" && failure && <FailureNotice failure={failure} focusRef={failureRef} {...noticeProps} />}

        {(stage === "list" || stage === "loading" || stage === "resolving") && listing && (
          <>
            <p className="text-sm">{t("githubConflicts.intro")}</p>
            <p className="text-xs text-muted-foreground">{t("githubConflicts.divergence", { ahead: listing.ahead, behind: listing.behind })}</p>
            {listing.autopilotFiles && <p className="text-xs text-muted-foreground">{t(`githubConflicts.autopilotFiles.${listing.autopilotFiles}`)}</p>}
            {publishOff && <Note tone="warning" role="note" icon={<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-600" aria-hidden />}><p>{t("githubConflicts.unpublished")}</p></Note>}
            {again && <Note tone="warning" role="status" icon={<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-600" aria-hidden />}><p>{t("githubConflicts.again")}</p></Note>}
            {showBusy && !failure && <Note tone="warning" role="note" icon={<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-600" aria-hidden />}><p>{t("githubConflicts.failure.busy")}</p>{canPause && <Button size="sm" className="min-h-11" disabled={holding} onClick={() => void commands.pause("now")}><Pause className="h-4 w-4" aria-hidden />{t("githubConflicts.actions.pause")}</Button>}</Note>}

            <div role="radiogroup" aria-labelledby={`${uid}-rest`} className="space-y-2 rounded-md border p-3">
              <p id={`${uid}-rest`} className="text-sm font-semibold">{t("githubConflicts.rest.legend")}</p>
              <p className="text-xs text-muted-foreground">{t("githubConflicts.rest.hint")}</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <Choice name={`${uid}-rest`} checked={draft.rest === null} disabled={holding || stage !== "list"} label={t("githubConflicts.rest.none")} onChange={() => chooseRest(null)} />
                <Choice name={`${uid}-rest`} checked={draft.rest === "server"} disabled={holding || stage !== "list"} label={t("githubConflicts.rest.server")} onChange={() => chooseRest("server")} />
                <Choice name={`${uid}-rest`} checked={draft.rest === "github"} disabled={holding || stage !== "list"} label={t("githubConflicts.rest.github")} onChange={() => chooseRest("github")} />
              </div>
            </div>

            {stage === "list" && (
              <section className="space-y-2">
                <h3 id={`${uid}-list`} ref={listHeadingRef} tabIndex={-1} className="text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("githubConflicts.list.title", { count: total })}</h3>
                <ul aria-labelledby={`${uid}-list`} className="space-y-2">
                  {choosable.map((conflict, index) => (
                    <FileChoice key={conflict.path} conflict={conflict} index={index} uid={uid} version={Object.prototype.hasOwnProperty.call(draft.chosen, conflict.path) ? draft.chosen[conflict.path] : undefined} disabled={holding} onChoose={(version) => choose(conflict.path, version)} />
                  ))}
                </ul>
                <FixedFiles files={fixed} />
                {pages > 1 && (
                  <nav aria-label={t("githubConflicts.list.pages")} className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <Button size="sm" variant="outline" className="min-h-11" disabled={holding || listing.offset === 0} onClick={() => goTo(Math.max(0, listing.offset - CONFLICTS_PAGE))}><ChevronLeft className="h-4 w-4" aria-hidden />{t("githubConflicts.list.previous")}</Button>
                    <span className="text-xs text-muted-foreground">{t("githubConflicts.list.page", { page, pages })}</span>
                    <Button size="sm" variant="outline" className="min-h-11" disabled={holding || listing.offset + CONFLICTS_PAGE >= total} onClick={() => goTo(listing.offset + CONFLICTS_PAGE)}>{t("githubConflicts.list.next")}<ChevronRight className="h-4 w-4" aria-hidden /></Button>
                  </nav>
                )}
              </section>
            )}
          </>
        )}

        {stage === "done" && state.answer && <Outcome answer={state.answer} outcomeRef={outcomeRef} />}
      </div>

      <div ref={footerRef} className="max-h-[40vh] shrink-0 space-y-2 overflow-y-auto border-t p-3 sm:px-6 sm:py-4">
        {stage === "list" && failure && <FailureNotice failure={failure} {...noticeProps} />}
        {stage === "list" && (
          <div className="space-y-0.5 text-xs">
            {readiness.chosen > 0 && <p>{t("githubConflicts.summary.chosen", { count: readiness.chosen })}</p>}
            {draft.rest !== null && <p>{t(draft.rest === "server" ? "githubConflicts.summary.restServer" : "githubConflicts.summary.restGithub")}</p>}
            {!readiness.ready && <p id={leftId} className="text-muted-foreground">{t("githubConflicts.summary.left", { count: readiness.left })}</p>}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {(stage === "list" || stage === "resolving") && (
            <Button ref={resolveRef} className="min-h-11" disabled={!ready || holding || stage === "resolving"} aria-describedby={readiness.ready ? undefined : leftId} onClick={() => void resolve(confirm)}>
              {t("githubConflicts.actions.resolve")}
            </Button>
          )}
          {(stage === "done" || (stage === "failed" && failure?.kind === "not-conflicted")) && (
            <Button className="min-h-11" disabled={holding} onClick={() => void resume()}>
              {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
              {t("autopilot.actions.resume")}
            </Button>
          )}
          <Button variant="outline" className="min-h-11" disabled={stage === "resolving" || busy === "start"} onClick={close}>{t("githubConflicts.actions.close")}</Button>
        </div>
      </div>
    </>
  );
}

/**
 * The window that settles the conflicts of a book on the personal server with GitHub: the files that both sides changed, read from the server a page at a time, the version to keep of
 * each (the server's or GitHub's) chosen file by file or for all the others, and what came of it, with Resume (never by itself). It cannot be closed while the server is resolving.
 */
export function GithubConflictsDialog({ bookId, open, onOpenChange, returnFocusTo }: { bookId: string; open: boolean; onOpenChange: (open: boolean) => void; returnFocusTo?: RefObject<HTMLElement | null> }) {
  const [resolving, setResolving] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // The control that opened the window, when the caller does not say: a click does not always focus a button (Safari does not), so it is not asked of the page.
  const opener = useRef<Element | null>(null);
  if (open && opener.current === null) opener.current = document.activeElement;
  if (!open) opener.current = null;
  const guarded = (next: boolean) => {
    if (!next && resolving) return;
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={guarded}>
      <DialogContent
        hideCloseButton
        className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:rounded-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          // The focus goes back to the control that opened the window; when that is gone (the run started again, and the panel with it) it goes to the band, where the author looks next.
          event.preventDefault();
          const target = returnFocusTo?.current ?? (opener.current instanceof HTMLElement && opener.current !== document.body ? opener.current : null);
          if (target?.isConnected) target.focus({ preventScroll: true });
          else document.querySelector<HTMLElement>("[data-autopilot-band]")?.focus({ preventScroll: true });
        }}
      >
        <Resolver bookId={bookId} close={() => onOpenChange(false)} onBusy={setResolving} titleRef={titleRef} />
      </DialogContent>
    </Dialog>
  );
}

