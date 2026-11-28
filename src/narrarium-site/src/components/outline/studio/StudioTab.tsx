import { Suspense, lazy, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookMarked, CheckCircle2, ClipboardCheck, Compass, ListTree, Loader2, Pause, Play, PenLine, Sparkles } from "lucide-react";
import { OUTLINE_BOOK_FILE, designModeChoice, lockedDecisions, openQuestions, serverSupportsDesign, summarizeDesign, type AutopilotState, type OutlineChapterEntry } from "narrarium-engine";
import "@/i18n/design";
import "@/i18n/bibleStudio";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { BrainstormPageButton } from "@/components/assistant/brainstorm/BrainstormLauncher";
import { useBibleFiles } from "@/components/outline/bible/useBibleFiles";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { useAutopilotRefresh, useBookAutopilotView } from "@/autopilot/hooks";
import { useAutopilotStore } from "@/autopilot/store";
import { autopilotLiveHref } from "@/autopilot/pageRoute";
import { formatDate, voteText } from "@/autopilot/format";
import { DESIGN_SERVER_VERSION, approveDesignChange, designApprovalOf, designBlockOf, designModeBlockOf, designStatusOf, initialDesignMode } from "@/outline/designModel";
import { serverHasDesignReview } from "@/outline/designReviewModel";
import { serverHasDesignComplete } from "@/autopilot/designComplete";
import { composeBible, worldEntries } from "@/outline/bibleModel";
import type { OutlineSnapshot } from "@/outline/outlineModel";
import type { OutlineSource } from "@/outline/outlineSource";
import type { BrainstormingTarget } from "@/assistant/store";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

const DesignDialog = lazy(() => import("@/components/outline/studio/DesignDialog"));
const StudioReviews = lazy(() => import("@/components/outline/studio/StudioReviews"));
const DesignProposals = lazy(() => import("@/components/outline/studio/DesignProposals"));
const DesignRounds = lazy(() => import("@/components/outline/studio/DesignRounds"));

export interface StudioTabProps {
  book: BookEntry;
  branch: string;
  structure: BookStructure | undefined;
  source: OutlineSource | null;
  snapshot: OutlineSnapshot | null;
  /** The autopilot's state as the working copy has it (the live one of the session wins when there is one). */
  state: AutopilotState | null;
  description: string;
  entries: readonly OutlineChapterEntry[];
  refresh: () => Promise<void>;
  refreshKey: string;
  brainstormTarget: BrainstormingTarget | null;
  onShowTab: (tab: string) => void;
}

/**
 * The Studio of the design: the design run of the autopilot (start it, follow it, pause it, go on with it), the design when it is ready (approve it, or start writing),
 * the reviews it had, and the Brainstorming to talk it through. The progress of a run is the autopilot's own, as the band and the dock show it.
 */
export function StudioTab({ book, branch, structure, source, snapshot, state: fileState, description, entries, refresh, refreshKey, brainstormTarget, onShowTab }: StudioTabProps) {
  const { t } = useTranslation();
  useAutopilotRefresh(book.id);
  const view = useBookAutopilotView(book.id);
  const state = view.snapshot?.state ?? fileState;
  const running = view.snapshot?.running === true || view.busyInAnotherTab;
  const status = designStatusOf(state);
  const serverInfo = useAutopilotStore((store) => store.server.info);
  const serverWithoutDesign = book.autopilotHost === "server" && serverInfo !== null && !serverSupportsDesign(serverInfo);
  const serverWithoutReview = book.autopilotHost === "server" && serverInfo !== null && !serverHasDesignReview(serverInfo);
  const serverWithoutComplete = book.autopilotHost === "server" && serverInfo !== null && !serverHasDesignComplete(serverInfo);
  // Which design runs, and why (#125): «Review and complete» when every chapter of the book is the author's in the Synopsis, the design of the book otherwise.
  const choice = useMemo(() => designModeChoice(entries), [entries]);
  const mode = initialDesignMode(choice, { description, serverWithoutComplete });
  const modeBlocked = designModeBlockOf(mode, { description, choice, serverWithoutComplete });
  const block = designBlockOf({ description, state, serverWithoutDesign, authorChapters: choice.written.length });
  // The design asked for her choice of a pitch and waits for it: going on would stop at the same place.
  const choosingPitch = status.kind === "active" && summarizeDesign(state?.design)?.choosePitch === true;
  const completing = status.kind !== "none" && status.mode === "complete";
  const { busy, commands } = useAutopilotActions(book.id);
  const [dialog, setDialog] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const step = view.snapshot?.activities.find((activity) => activity.status === "running")?.title;
  const last = status.kind === "active" || status.kind === "ready" ? status.rounds[status.rounds.length - 1] : undefined;
  const target = status.kind === "active" || status.kind === "ready" ? (status.target !== undefined ? voteText(status.target) : t("design.studio.status.directorTarget")) : "";

  // What the design made: the secrets and the world, read from the book (the Bible's reading).
  const bible = useBibleFiles(source, refreshKey);
  const data = useMemo(() => (bible.files ? composeBible({ files: bible.files, entries, state }) : null), [bible.files, entries, state]);
  const counts = useMemo(() => (data ? { secrets: data.secrets.length, world: worldEntries(data) } : null), [data]);
  const agreed = useMemo(() => (data ? {
    locked: lockedDecisions(data.decisions).length,
    questions: openQuestions(data.decisions).length,
    findings: data.findings.length,
    warnings: data.findings.filter((finding) => finding.severity === "warning").length,
  } : null), [data]);
  const chapters = (state?.plan?.chapters ?? []).filter((chapter) => !chapter.imported).length || (status.kind === "ready" ? status.chapters : 0);
  const bookFile = snapshot?.files.get(OUTLINE_BOOK_FILE);
  const approval = designApprovalOf(bookFile?.content);
  const approved = status.kind === "ready" && approval?.run === status.startedAt ? approval : null;
  const [approving, setApproving] = useState(false);
  const [approveFailed, setApproveFailed] = useState(false);

  const approve = async () => {
    if (status.kind !== "ready" || !source) return;
    setApproving(true);
    setApproveFailed(false);
    try {
      await source.commit([approveDesignChange(bookFile ? { content: bookFile.content, hash: bookFile.hash } : undefined, status.startedAt, new Date())], "Synopsis: approve the design");
      await refresh();
    } catch {
      setApproveFailed(true);
    } finally {
      setApproving(false);
    }
  };
  const startWriting = async () => {
    if (await commands.resume()) setAnnouncement(t("design.studio.ready.follow"));
  };

  const blockedText = block === "description" ? t("design.studio.blocked.description") : block === "written" ? t("design.studio.blocked.written") : block === "server" ? t("design.studio.blocked.server", { version: DESIGN_SERVER_VERSION }) : running && status.kind !== "active" ? t("design.studio.blocked.running") : null;
  // What will run, said before it starts: the mode the dialog offers first and why.
  const modeText = block || modeBlocked ? null : mode === "complete"
    ? t("design.mode.studio.complete", { count: choice.written.length })
    : choice.reason === "missing"
      ? t("design.mode.studio.missing", { count: choice.missing.length, written: choice.written.length })
      : t("design.mode.studio.plan");
  const canStart = !block && !running && busy === null;

  return (
    <div data-studio className="flex flex-col gap-5">
      <section aria-labelledby="studio-design-title" data-design-status={status.kind} className="space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
        <h2 id="studio-design-title" className="flex items-center gap-2 text-xl font-semibold"><Compass className="h-5 w-5 text-primary" aria-hidden="true" />{t("design.studio.title")}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{t("design.studio.intro")}</p>

        {status.kind === "none" && <p className="text-sm">{t("design.studio.status.none")}</p>}
        {status.kind === "ended" && !completing && <p className="text-sm">{t("design.studio.ended", { date: formatDate(status.endedAt) })}</p>}
        {status.kind === "active" && (
          <div data-design-progress className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3" aria-live="polite">
            <p className="flex items-center gap-2 text-sm font-medium">
              {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Pause className="h-4 w-4" aria-hidden="true" />}
              {running ? (completing ? t("design.studio.status.runningComplete") : t("design.studio.status.running")) : state?.question ? t("design.studio.status.waiting") : choosingPitch ? t("designReview.alternatives.statusWaiting") : t("design.studio.status.paused")}
            </p>
            {running && step && <p className="text-sm text-muted-foreground">{t("design.studio.status.step", { step })}</p>}
            {!running && state?.message && <p className="text-sm text-muted-foreground">{state.message}</p>}
            <p className="text-xs text-muted-foreground">
              {status.rounds.length ? t("design.studio.status.rounds", { round: status.rounds.length, max: status.maxRounds }) : t("design.studio.status.noRounds")}
              {last && <> · {t("design.studio.status.lastVote", { score: voteText(last.score), target })}</>}
            </p>
            <div className="flex flex-wrap gap-2">
              {running && !view.busyInAnotherTab && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void commands.pause("after-step")}><Pause className="h-4 w-4" aria-hidden="true" />{t("design.studio.status.pause")}</Button>}
              {!running && state?.question && <Button size="sm" asChild><Link to={autopilotLiveHref(book.id)}>{t("design.studio.status.answer")}</Link></Button>}
              {!running && !state?.question && <Button size="sm" data-design-resume="" disabled={busy !== null || choosingPitch || Boolean(block && block !== "written")} aria-describedby={choosingPitch ? "studio-choose-hint" : undefined} onClick={() => void commands.resume()}><Play className="h-4 w-4" aria-hidden="true" />{t("design.studio.status.resume")}</Button>}
            </div>
            {choosingPitch && !running && <p id="studio-choose-hint" className="text-xs text-muted-foreground">{t("designReview.alternatives.resumeHint")}</p>}
          </div>
        )}

        {status.kind !== "active" && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button type="button" data-design-open="" variant={status.kind === "ready" ? "outline" : "default"} disabled={!canStart} aria-describedby={blockedText ? "studio-design-blocked" : modeText ? "studio-design-mode" : undefined} onClick={() => setDialog(true)}>
                {mode === "complete" ? <ClipboardCheck className="h-4 w-4" aria-hidden="true" /> : <Compass className="h-4 w-4" aria-hidden="true" />}
                {mode === "complete" ? (status.kind === "ready" && completing ? t("design.studio.againComplete") : t("design.studio.startComplete")) : status.kind === "ready" ? t("design.studio.again") : t("design.studio.start")}
              </Button>
            </div>
            {blockedText && <p id="studio-design-blocked" data-design-blocked={block ?? "running"} className="text-sm text-muted-foreground">{blockedText}</p>}
            {!blockedText && modeText && <p id="studio-design-mode" data-design-mode={mode} className="max-w-3xl text-sm text-muted-foreground">{modeText}</p>}
          </div>
        )}
      </section>

      {completing && (
        <Suspense fallback={null}>
          <DesignProposals bookId={book.id} state={state} entries={entries} running={running} onShowTab={onShowTab} onStartWriting={() => void startWriting()} />
        </Suspense>
      )}

      {status.kind === "ready" && !completing && (
        <section aria-labelledby="studio-ready-title" data-design-ready className="space-y-3 rounded-2xl border border-emerald-600/40 bg-emerald-500/5 p-4 shadow-sm sm:p-5">
          <h2 id="studio-ready-title" className="flex items-center gap-2 text-lg font-semibold"><CheckCircle2 className="h-5 w-5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />{t("design.studio.ready.title")}</h2>
          <p data-design-counts className="text-base font-medium">
            {t("design.studio.ready.counts", {
              chapters: t("design.counts.chapters", { count: chapters }),
              secrets: counts ? t("design.counts.secrets", { count: counts.secrets }) : "…",
              world: counts ? t("design.counts.world", { count: counts.world }) : "…",
            })}
          </p>
          {last && <p className="text-sm text-muted-foreground">{t(`design.studio.ready.outcome.${status.outcome}`, { score: voteText(last.score) })}</p>}
          {approved && <p data-design-approved className="flex items-center gap-1.5 text-sm font-medium"><CheckCircle2 className="h-4 w-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />{t("design.studio.ready.approved", { date: formatDate(approved.at) })}</p>}
          {approveFailed && <Alert variant="destructive"><AlertDescription>{t("design.studio.ready.approveFailed")}</AlertDescription></Alert>}
          <div className="flex flex-wrap gap-2">
            {!approved && <Button type="button" data-design-approve="" variant="outline" disabled={approving || !source} onClick={() => void approve()}>{approving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}{t("design.studio.ready.approve")}</Button>}
            <Button type="button" data-design-write="" disabled={running || busy !== null} aria-describedby="studio-ready-write-hint" onClick={() => void startWriting()}><PenLine className="h-4 w-4" aria-hidden="true" />{t("design.studio.ready.write")}</Button>
            <Button type="button" variant="ghost" onClick={() => onShowTab("synopsis")}><ListTree className="h-4 w-4" aria-hidden="true" />{t("design.studio.ready.synopsis")}</Button>
            <Button type="button" variant="ghost" onClick={() => onShowTab("bible")}><BookMarked className="h-4 w-4" aria-hidden="true" />{t("design.studio.ready.bible")}</Button>
          </div>
          <p id="studio-ready-write-hint" className="text-xs text-muted-foreground">{t("design.studio.ready.writeHint")}</p>
          {announcement && <p role="status" className="text-sm"><Link to={autopilotLiveHref(book.id)} className="underline underline-offset-4">{announcement}</Link></p>}
        </section>
      )}

      {(status.kind === "active" || status.kind === "ready") && status.rounds.length > 0 && (
        <section aria-labelledby="studio-rounds-title" className="space-y-2 rounded-2xl border border-layer bg-card p-4 shadow-sm">
          <h2 id="studio-rounds-title" className="text-base font-semibold">{t("design.studio.rounds.title")}</h2>
          <Suspense fallback={null}><DesignRounds rounds={status.rounds} target={status.target} /></Suspense>
        </section>
      )}

      {agreed && (
        <section aria-labelledby="studio-agreed-title" data-studio-agreed className="space-y-2 rounded-2xl border border-layer bg-card p-4 shadow-sm">
          <h2 id="studio-agreed-title" className="text-base font-semibold">{t("bibleStudio.studio.title")}</h2>
          {agreed.locked + agreed.questions + agreed.findings === 0
            ? <p className="text-sm text-muted-foreground">{t("bibleStudio.studio.none")}</p>
            : (
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <li data-agreed="locked">{t("bibleStudio.studio.locked", { count: agreed.locked })}</li>
                <li data-agreed="questions">{t("bibleStudio.studio.questions", { count: agreed.questions })}</li>
                <li data-agreed="findings">{t("bibleStudio.studio.findings", { count: agreed.findings })}{agreed.warnings > 0 && <> ({t("bibleStudio.studio.warnings", { count: agreed.warnings })})</>}</li>
              </ul>
            )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => onShowTab("bible")}><BookMarked className="h-4 w-4" aria-hidden="true" />{t("bibleStudio.studio.open")}</Button>
          </div>
        </section>
      )}

      {(entries.length > 0 || state?.design?.alternatives || state?.design?.rubric || state?.design?.coherence) && (
        <Suspense fallback={null}>
          <StudioReviews book={book} state={state} entries={entries} running={running} designing={status.kind === "active"} serverWithoutReview={serverWithoutReview} designBlock={block} />
        </Suspense>
      )}

      <section aria-labelledby="studio-brainstorm-title" className="flex flex-col gap-3 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:flex-row sm:items-center">
        <Sparkles className="hidden h-5 w-5 shrink-0 text-primary sm:block" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id="studio-brainstorm-title" className="text-base font-semibold">{t("design.studio.brainstorm.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("design.studio.brainstorm.body")}</p>
        </div>
        <BrainstormPageButton target={brainstormTarget} />
      </section>

      {dialog && (
        <Suspense fallback={null}>
          <DesignDialog
            open
            onClose={() => setDialog(false)}
            book={book}
            branch={branch}
            structure={structure}
            state={state}
            entries={entries.length}
            choice={choice}
            description={description}
            serverWithoutComplete={serverWithoutComplete}
            onStarted={() => setAnnouncement(t("design.dialog.started"))}
          />
        </Suspense>
      )}
      {announcement && (status.kind !== "ready" || completing) && <p role="status" className="sr-only">{announcement}</p>}
    </div>
  );
}
