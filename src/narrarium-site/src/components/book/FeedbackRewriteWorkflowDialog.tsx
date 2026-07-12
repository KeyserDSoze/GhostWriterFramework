import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, FileClock, Loader2, RotateCcw, Sparkles, Square, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileDiff } from "@/components/diff/DiffView";
import { loadFileContent } from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import {
  applyParagraphFeedbackProposal,
  inspectReaderFeedbackSummary,
  loadLatestRewriteOperation,
  MissingReaderFeedbackOpinionError,
  MissingReaderFeedbackSummaryError,
  prepareParagraphFeedbackProposal,
  restorePreviousDrafts,
  resumeChapterFeedbackRewrite,
  runChapterFeedbackRewrite,
  type RewriteOperationManifest,
  type RewriteRepositoryContext,
  type RewriteRollbackPolicy,
  type FeedbackSourceSelection,
} from "@/narrarium/rewriteFromReaderFeedback";
import { rewriteOperationManifestPath } from "@/narrarium/rewriteOperationPaths";
import { useSettingsStore } from "@/store/settingsStore";
import { useFeedbackRewriteWorkflowStore, type FeedbackRewriteIntent } from "@/store/feedbackRewriteWorkflowStore";
import { resolveBookToken } from "@/types/settings";

function manifestPath(manifest: RewriteOperationManifest): string {
  return rewriteOperationManifestPath(manifest.scope, manifest.chapterSlug, manifest.operationId, manifest.paragraphSlug);
}

export function FeedbackRewriteWorkflowDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const state = useFeedbackRewriteWorkflowStore();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(state.intent?.bookId);
  const { book, structure, reload } = useBookStructure(state.intent?.bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const context: RewriteRepositoryContext | null = book && structure && token
    ? { token, book, branch, structure, settings }
    : null;
  const busy = Boolean(state.abortController);

  useEffect(() => {
    if (!state.open || !state.intent || !context) return;
    let active = true;
    const intent = state.intent;
    void (async () => {
      try {
        const target = { scope: intent.scope, chapterSlug: intent.chapterSlug, paragraphSlug: intent.paragraphSlug };
        const latest = await loadLatestRewriteOperation(context, target);
        if (!active) return;
        if (intent.mode === "restore" || intent.mode === "status") {
          if (!latest) {
            state.patch({ phase: "configure", error: t("feedbackRewrite.noOperation") });
            return;
          }
          state.patch({
            manifest: latest,
            manifestPath: manifestPath(latest),
            progress: latest.progress,
            phase: intent.mode === "restore" ? "rollback-confirmation" : resultPhase(latest),
          });
          return;
       }
        const summary = await inspectReaderFeedbackSummary({ ...context, chapterSlug: intent.chapterSlug, paragraphSlug: intent.paragraphSlug, feedbackSource: sourceFromIntent(intent) });
        if (active) state.patch({ staleFeedback: summary.stale, phase: "mandatory-warning" });
      } catch (error) {
        if (!active) return;
        if (error instanceof MissingReaderFeedbackSummaryError || error instanceof MissingReaderFeedbackOpinionError) state.patch({ missingSummary: true, phase: "configure" });
        else state.patch({ error: errorMessage(error), phase: "failed" });
      }
    })();
    return () => { active = false; };
  }, [state.open, state.requestId, context?.book.id, context?.branch]);

  if (!state.intent) return null;
  const intent = state.intent;
  const feedbackSource = sourceFromIntent(intent);
  const displayedMode = state.manifest?.feedbackMode ?? feedbackSource.feedbackMode ?? "panel-summary";
  const displayedReaderName = state.manifest?.feedbackReaderName ?? feedbackSource.readerName;
  const chapter = structure?.chapters.find((entry) => entry.slug === intent.chapterSlug);
  const paragraph = chapter?.paragraphs.find((entry) => slugOf(entry.path) === intent.paragraphSlug);
  const evaluationsHref = paragraph
    ? `/app/books/${intent.bookId}/chapters/${intent.chapterSlug}/paragraphs/${paragraph.number}/reader-evaluations`
    : `/app/books/${intent.bookId}/chapters/${intent.chapterSlug}/reader-evaluations`;

  function setController(controller: AbortController | null, abortable = false) {
    state.patch({ abortController: controller, abortable: Boolean(controller && abortable) });
  }

  async function startGeneration() {
    if (!context) return;
    const controller = new AbortController();
    setController(controller, true);
    state.patch({ error: null, phase: intent.scope === "paragraph" ? "preparing" : "chapter-progress", progress: intent.scope === "chapter" ? { completed: 0, total: chapter?.paragraphs.length ?? 0 } : null });
    try {
      if (intent.scope === "paragraph" && intent.paragraphSlug) {
        const proposal = await prepareParagraphFeedbackProposal({ ...context, chapterSlug: intent.chapterSlug, paragraphSlug: intent.paragraphSlug, feedbackSource, signal: controller.signal });
        state.patch({ proposal, staleFeedback: proposal.staleFeedback, phase: "paragraph-preview" });
      } else {
        const manifest = await runChapterFeedbackRewrite({
          ...context,
          chapterSlug: intent.chapterSlug,
          feedbackSource,
          confirmed: true,
          confirmStaleFeedback: state.staleFeedback,
          signal: controller.signal,
          onProgress: (progress, current) => state.patch({ progress, manifest: structuredClone(current) }),
        });
        state.patch({ manifest, manifestPath: manifestPath(manifest), progress: manifest.progress, phase: resultPhase(manifest) });
        await reload();
      }
    } catch (error) {
      state.patch({ error: errorMessage(error), phase: controller.signal.aborted ? "cancelled" : "failed" });
    } finally {
      setController(null);
    }
  }

  async function applyParagraph() {
    if (!context || !state.proposal) return;
    state.patch({ phase: "generating", error: null });
    const controller = new AbortController();
    setController(controller);
    try {
      const manifest = await applyParagraphFeedbackProposal({ ...context, proposal: state.proposal, feedbackSource, confirmStaleFeedback: state.staleFeedback });
      state.patch({ manifest, manifestPath: manifestPath(manifest), progress: manifest.progress, phase: resultPhase(manifest) });
      await reload();
    } catch (error) {
      state.patch({ error: errorMessage(error), phase: "failed" });
    } finally {
      setController(null);
    }
  }

  async function resumeChapter() {
    if (!context || !state.manifestPath) return;
    const controller = new AbortController();
    setController(controller, true);
    state.patch({ phase: "chapter-progress", error: null });
    try {
      const manifest = await resumeChapterFeedbackRewrite({
          ...context,
          manifestPath: state.manifestPath,
          feedbackSource: state.manifest ? undefined : feedbackSource,
        confirmed: true,
        confirmStaleFeedback: state.staleFeedback || state.manifest?.staleFeedback,
        signal: controller.signal,
        onProgress: (progress, current) => state.patch({ progress, manifest: structuredClone(current) }),
      });
      state.patch({ manifest, progress: manifest.progress, phase: resultPhase(manifest) });
      await reload();
    } catch (error) {
      state.patch({ error: errorMessage(error), phase: controller.signal.aborted ? "cancelled" : "failed" });
    } finally {
      setController(null);
    }
  }

  async function beginRestore() {
    if (!context || !state.manifestPath) return;
    const controller = new AbortController();
    setController(controller);
    state.patch({ error: null, phase: "rolling-back" });
    try {
      const result = await restorePreviousDrafts({ ...context, manifestPath: state.manifestPath, defaultPolicy: "cancel" });
      if (!result.conflicts.length) {
        state.patch({ manifest: result.manifest, phase: "completed" });
        await reload();
        return;
      }
      const files = new Map(result.manifest.modifiedFiles.map((file) => [file.path, file]));
      const conflicts = await Promise.all(result.conflicts.map(async (conflict) => {
        const file = files.get(conflict.path);
        const [currentContent, beforeContent] = await Promise.all([
          loadFileContent(context.token, context.book.owner, context.book.repo, conflict.path, context.branch).catch(() => ""),
          file ? loadFileContent(context.token, context.book.owner, context.book.repo, file.beforeSnapshotPath, context.branch).catch(() => "") : Promise.resolve(""),
        ]);
        return { ...conflict, currentContent, beforeContent };
      }));
      state.patch({ manifest: result.manifest, conflicts, rollbackPolicies: Object.fromEntries(conflicts.map((entry) => [entry.path, "cancel"])), phase: "rollback-conflicts" });
    } catch (error) {
      state.patch({ error: errorMessage(error), phase: "failed" });
    } finally {
      setController(null);
    }
  }

  async function resolveRestoreConflicts() {
    if (!context || !state.manifestPath) return;
    const policies = state.rollbackPolicies;
    if (state.conflicts.some((conflict) => policies[conflict.path] === "cancel")) return;
    const controller = new AbortController();
    setController(controller);
    state.patch({ phase: "rolling-back" });
    try {
      const result = await restorePreviousDrafts({ ...context, manifestPath: state.manifestPath, policies, defaultPolicy: "keep-current" });
      state.patch({ manifest: result.manifest, conflicts: [], phase: "completed" });
      await reload();
    } catch (error) {
      state.patch({ error: errorMessage(error), phase: "failed" });
    } finally {
      setController(null);
    }
  }

  function openRestore() {
    if (state.manifest) state.patch({ phase: "rollback-confirmation" });
  }

  return (
    <Dialog open={state.open} onOpenChange={(open) => { if (!open && !busy) state.closeWorkflow(); }}>
      <DialogContent hideCloseButton={busy} className="max-h-[92dvh] !w-[calc(100vw-1rem)] !max-w-4xl overflow-x-hidden overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>{t(`feedbackRewrite.title.${intent.mode}`)}</DialogTitle>
          <DialogDescription>{chapter?.title}{paragraph ? ` / ${paragraph.title}` : ""}</DialogDescription>
        </DialogHeader>

        {intent.mode === "generate" && <Alert><AlertTitle>{t(`feedbackRewrite.source.${displayedMode}.title`, { reader: displayedReaderName })}</AlertTitle><AlertDescription>{t(`feedbackRewrite.source.${displayedMode}.description`, { reader: displayedReaderName })}</AlertDescription></Alert>}

        {(state.phase === "loading" || state.phase === "preparing" || state.phase === "generating" || state.phase === "rolling-back") && <BusyState label={t(`feedbackRewrite.phase.${state.phase}`)} cancellable={state.phase === "preparing"} />}

        {state.phase === "configure" && (
          <Alert variant={state.missingSummary ? "destructive" : "default"}>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{state.missingSummary ? t(displayedMode === "reader-opinion" ? "feedbackRewrite.missingOpinionTitle" : "feedbackRewrite.missingSummaryTitle") : t("feedbackRewrite.unavailable")}</AlertTitle>
            <AlertDescription className="mt-2 space-y-3">
              <p>{state.missingSummary ? t(displayedMode === "reader-opinion" ? "feedbackRewrite.missingOpinion" : "feedbackRewrite.missingSummary", { reader: displayedReaderName }) : state.error}</p>
              {state.missingSummary && <Button variant="outline" onClick={() => { state.closeWorkflow(); navigate(evaluationsHref); }}>{t("feedbackRewrite.openEvaluations")}</Button>}
            </AlertDescription>
          </Alert>
        )}

        {state.phase === "mandatory-warning" && (
          <div className="space-y-4">
            <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>{t("feedbackRewrite.warningTitle")}</AlertTitle><AlertDescription>{t(`feedbackRewrite.warning.${intent.scope}`)}</AlertDescription></Alert>
            {state.staleFeedback && <Alert><FileClock className="h-4 w-4" /><AlertTitle>{t(displayedMode === "reader-opinion" ? "feedbackRewrite.staleOpinionTitle" : "feedbackRewrite.staleTitle")}</AlertTitle><AlertDescription>{t(displayedMode === "reader-opinion" ? "feedbackRewrite.staleOpinion" : "feedbackRewrite.staleSummary", { reader: displayedReaderName })}</AlertDescription></Alert>}
            <DialogFooter><Button variant="outline" onClick={state.closeWorkflow}>{t("common.cancel")}</Button><Button onClick={() => void startGeneration()}><Sparkles className="mr-2 h-4 w-4" />{t("feedbackRewrite.confirmGenerate")}</Button></DialogFooter>
          </div>
        )}

        {state.phase === "paragraph-preview" && state.proposal && (
          <div className="space-y-4">
            {state.proposal.staleFeedback && <Alert><FileClock className="h-4 w-4" /><AlertDescription>{t(state.proposal.feedbackMode === "reader-opinion" ? "feedbackRewrite.staleOpinion" : "feedbackRewrite.staleSummary", { reader: state.proposal.feedbackReaderName })}</AlertDescription></Alert>}
            <div><h3 className="mb-2 text-sm font-semibold">{t("feedbackRewrite.preview")}</h3><FileDiff previous={state.proposal.currentDraftContent ?? ""} next={state.proposal.generatedDraftContent} className="max-h-[45vh]" /></div>
            <div><h3 className="mb-2 text-sm font-semibold">{t("feedbackRewrite.feedbackApplied")}</h3>{state.proposal.feedbackApplied.length ? <ul className="list-disc space-y-1 pl-5 text-sm">{state.proposal.feedbackApplied.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="text-sm text-muted-foreground">{t("feedbackRewrite.noFeedbackApplied")}</p>}</div>
            <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>{t("feedbackRewrite.replaceWarning")}</AlertDescription></Alert>
            <DialogFooter><Button variant="outline" onClick={state.closeWorkflow}>{t("common.cancel")}</Button><Button onClick={() => void applyParagraph()}>{t("feedbackRewrite.confirmReplace")}</Button></DialogFooter>
          </div>
        )}

        {state.phase === "chapter-progress" && <ChapterProgress manifest={state.manifest} progress={state.progress} title={chapter?.paragraphs.find((entry) => slugOf(entry.path) === state.progress?.currentParagraphSlug)?.title} />}

        {(state.phase === "completed" || state.phase === "failed" || state.phase === "cancelled") && (
          <ResultState phase={state.phase} manifest={state.manifest} error={state.error} />
        )}

        {state.phase === "rollback-confirmation" && (
          <div className="space-y-4">
            <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>{t("feedbackRewrite.restoreConfirmTitle")}</AlertTitle><AlertDescription>{t(`feedbackRewrite.restoreWarning.${intent.scope}`)}</AlertDescription></Alert>
            <DialogFooter><Button variant="outline" onClick={state.closeWorkflow}>{t("common.cancel")}</Button><Button variant="destructive" onClick={() => void beginRestore()}><RotateCcw className="mr-2 h-4 w-4" />{t("feedbackRewrite.confirmRestore")}</Button></DialogFooter>
          </div>
        )}

        {state.phase === "resume-confirmation" && (
          <div className="space-y-4">
            <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>{t("feedbackRewrite.warningTitle")}</AlertTitle><AlertDescription>{t("feedbackRewrite.resumeWarning")}</AlertDescription></Alert>
            <DialogFooter><Button variant="outline" onClick={() => state.patch({ phase: state.manifest?.status === "cancelled" ? "cancelled" : "failed" })}>{t("common.cancel")}</Button><Button onClick={() => void resumeChapter()}>{t("feedbackRewrite.confirmContinue")}</Button></DialogFooter>
          </div>
        )}

        {state.phase === "rollback-conflicts" && (
          <div className="space-y-5">
            <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>{t("feedbackRewrite.conflictsTitle")}</AlertTitle><AlertDescription>{t("feedbackRewrite.conflictsDescription")}</AlertDescription></Alert>
            {state.conflicts.map((conflict) => <div key={conflict.path} className="space-y-3 rounded-xl border p-3"><p className="break-all text-sm font-medium">{conflict.path}</p><FileDiff previous={conflict.currentContent} next={conflict.beforeContent} className="max-h-72" /><div className="flex flex-wrap gap-2">{(["keep-current", "force-restore", "cancel"] as RewriteRollbackPolicy[]).map((policy) => <Button key={policy} size="sm" variant={state.rollbackPolicies[conflict.path] === policy ? (policy === "force-restore" ? "destructive" : "default") : "outline"} onClick={() => state.patch({ rollbackPolicies: { ...state.rollbackPolicies, [conflict.path]: policy } })}>{t(`feedbackRewrite.policy.${policy}`)}</Button>)}</div></div>)}
            <DialogFooter><Button variant="outline" onClick={() => state.patch({ phase: "cancelled" })}>{t("feedbackRewrite.cancelRollback")}</Button><Button variant="destructive" disabled={state.conflicts.some((conflict) => state.rollbackPolicies[conflict.path] === "cancel")} onClick={() => void resolveRestoreConflicts()}>{t("feedbackRewrite.applyRestoreChoices")}</Button></DialogFooter>
          </div>
        )}

        {(state.phase === "completed" || state.phase === "failed" || state.phase === "cancelled") && state.manifest && (
          <DialogFooter className="gap-2 sm:space-x-0">
            {(state.phase === "failed" || state.phase === "cancelled") && state.manifest.scope === "chapter" && state.manifest.modifiedFiles.some((file) => file.status !== "completed") && <Button onClick={() => state.patch({ phase: "resume-confirmation" })}>{t("feedbackRewrite.continueRewrite")}</Button>}
            {state.manifest.modifiedFiles.some((file) => file.status === "completed") && state.manifest.status !== "rolledBack" && <Button variant="destructive" onClick={openRestore}><RotateCcw className="mr-2 h-4 w-4" />{t("feedbackRewrite.restore")}</Button>}
            {(state.phase === "failed" || state.phase === "cancelled") && <Button variant="outline" onClick={state.closeWorkflow}>{t("feedbackRewrite.keepCompleted")}</Button>}
            {state.phase === "completed" && <Button variant="outline" onClick={state.closeWorkflow}>{t("common.close")}</Button>}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function BusyState({ label, cancellable = false }: { label: string; cancellable?: boolean }) {
  const { t } = useTranslation();
  const cancel = useFeedbackRewriteWorkflowStore((state) => state.cancelActive);
  return <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /><p className="text-sm text-muted-foreground">{label}</p>{cancellable && <Button variant="destructive" onClick={cancel}><Square className="mr-2 h-4 w-4" />{t("common.cancel")}</Button>}</div>;
}

function ChapterProgress({ manifest, progress, title }: { manifest: RewriteOperationManifest | null; progress: RewriteOperationManifest["progress"] | null; title?: string }) {
  const { t } = useTranslation();
  const current = progress ?? manifest?.progress;
  const percent = current?.total ? Math.round((current.completed / current.total) * 100) : 0;
  const cancel = useFeedbackRewriteWorkflowStore((state) => state.cancelActive);
  return <div className="space-y-4"><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} /></div><div className="flex flex-wrap justify-between gap-2 text-sm"><span>{t("feedbackRewrite.progress", { completed: current?.completed ?? 0, total: current?.total ?? 0 })}</span><Badge variant="outline">{t(`feedbackRewrite.operationStatus.${manifest?.status ?? "rewriting"}`)}</Badge></div>{current?.currentParagraphSlug && <p className="text-sm text-muted-foreground">{t("feedbackRewrite.currentParagraph", { title: title ?? current.currentParagraphSlug, slug: current.currentParagraphSlug })}</p>}<Button variant="destructive" onClick={cancel}><Square className="mr-2 h-4 w-4" />{t("common.cancel")}</Button></div>;
}

function ResultState({ phase, manifest, error }: { phase: "completed" | "failed" | "cancelled"; manifest: RewriteOperationManifest | null; error: string | null }) {
  const { t } = useTranslation();
  const restored = manifest?.status === "rolledBack";
  const partial = restored && manifest.modifiedFiles.some((file) => file.status === "kept-current");
  return <div className="space-y-4"><Alert variant={phase === "completed" ? "default" : "destructive"}>{phase === "completed" ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}<AlertTitle>{restored ? t(partial ? "feedbackRewrite.partialRestore" : "feedbackRewrite.rolledBack") : t(`feedbackRewrite.result.${phase}`)}</AlertTitle>{(error || manifest?.error) && <AlertDescription>{error ?? manifest?.error}</AlertDescription>}</Alert>{manifest && <><div><h3 className="mb-2 text-sm font-semibold">{t("feedbackRewrite.modifiedFiles")}</h3><div className="space-y-1">{manifest.modifiedFiles.filter((file) => file.status !== "pending").map((file) => <div key={file.path} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"><span className="min-w-0 truncate">{file.path}</span><Badge variant="outline">{t(`feedbackRewrite.fileStatus.${file.status}`)}</Badge></div>)}</div></div><p className="text-xs text-muted-foreground">{t("feedbackRewrite.usage", { input: manifest.aggregateInputTokens, output: manifest.aggregateOutputTokens, cost: manifest.aggregateCost.toFixed(4), currency: manifest.currency ?? "" })}</p></>}</div>;
}

function resultPhase(manifest: RewriteOperationManifest): "completed" | "failed" | "cancelled" {
  if (manifest.status === "completed" || manifest.status === "rolledBack") return "completed";
  if (manifest.status === "cancelled") return "cancelled";
  return "failed";
}

function slugOf(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceFromIntent(intent: FeedbackRewriteIntent): FeedbackSourceSelection {
  return {
    feedbackMode: intent.feedbackMode ?? "panel-summary",
    feedbackPath: intent.feedbackPath,
    readerId: intent.readerId,
    readerName: intent.readerName,
  };
}
