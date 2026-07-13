import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ChevronRight, FileClock, Loader2, RotateCcw, Sparkles, Square, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileDiff } from "@/components/diff/DiffView";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import {
  applyParagraphFeedbackProposal,
  inspectReaderFeedbackSummary,
  loadLatestRewriteOperation,
  loadRewriteWorkingCopyText,
  MissingReaderFeedbackOpinionError,
  MissingReaderFeedbackSummaryError,
  prepareParagraphFeedbackProposal,
  RewriteFinalizationError,
  restorePreviousDrafts,
  resumeChapterFeedbackRewrite,
  runChapterFeedbackRewrite,
  type FeedbackSourceSelection,
  type RewriteOperationManifest,
  type RewriteRepositoryContext,
  type RewriteRollbackPolicy,
} from "@/narrarium/rewriteFromReaderFeedback";
import { useSettingsStore } from "@/store/settingsStore";
import { useFeedbackRewriteWorkflowStore, type FeedbackRewriteIntent } from "@/store/feedbackRewriteWorkflowStore";
import { resolveBookToken } from "@/types/settings";

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
  const [restoreScopePaths, setRestoreScopePaths] = useState<string[] | null>(null);
  const [rollbackReturnPhase, setRollbackReturnPhase] = useState<"completed" | "failed" | "cancelled">("completed");

  useEffect(() => {
    setRestoreScopePaths(null);
    setRollbackReturnPhase("completed");
  }, [state.requestId, state.open]);

  useEffect(() => {
    if (!state.open || !state.intent || !context || state.phase !== "loading") return;
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
            operationId: latest.operationId,
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

  function patchOperationError(error: unknown, phase: "failed" | "cancelled") {
    if (error instanceof RewriteFinalizationError) {
      state.patch({
        manifest: error.manifest,
        operationId: error.operationId,
        progress: error.manifest.progress,
        error: error.message,
        phase,
      });
      return;
    }
    state.patch({ error: errorMessage(error), phase });
  }

  function buildRestorePolicies(selectedPaths: string[] | null, conflictPolicies?: Record<string, RewriteRollbackPolicy>): Record<string, RewriteRollbackPolicy> | undefined {
    if (!state.manifest) return undefined;
    const restorable = state.manifest.modifiedFiles.filter(isRestorableRewriteFile);
    if (!restorable.length) return undefined;
    if (selectedPaths?.length) {
      const selected = new Set(selectedPaths);
      return Object.fromEntries(restorable.map((file) => [file.path, selected.has(file.path) ? (conflictPolicies?.[file.path] ?? "cancel") : "keep-current"]));
    }
    if (!conflictPolicies) return undefined;
    return Object.fromEntries(restorable.map((file) => [file.path, conflictPolicies[file.path] ?? "cancel"]));
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
        state.patch({ manifest, operationId: manifest.operationId, progress: manifest.progress, phase: resultPhase(manifest) });
        await reload();
      }
    } catch (error) {
      patchOperationError(error, controller.signal.aborted ? "cancelled" : "failed");
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
      state.patch({ manifest, operationId: manifest.operationId, progress: manifest.progress, phase: resultPhase(manifest) });
      await reload();
    } catch (error) {
      patchOperationError(error, "failed");
    } finally {
      setController(null);
    }
  }

  async function resumeChapter() {
    if (!context || !state.operationId) return;
    const controller = new AbortController();
    setController(controller, true);
    state.patch({ phase: "chapter-progress", error: null });
    try {
      const manifest = await resumeChapterFeedbackRewrite({
        ...context,
        operationId: state.operationId,
        feedbackSource: state.manifest ? undefined : feedbackSource,
        confirmed: true,
        confirmStaleFeedback: state.staleFeedback || state.manifest?.staleFeedback,
        signal: controller.signal,
        onProgress: (progress, current) => state.patch({ progress, manifest: structuredClone(current) }),
      });
      state.patch({ manifest, progress: manifest.progress, phase: resultPhase(manifest) });
      await reload();
    } catch (error) {
      patchOperationError(error, controller.signal.aborted ? "cancelled" : "failed");
    } finally {
      setController(null);
    }
  }

  async function beginRestore(selectedPaths: string[] | null = null) {
    if (!context || !state.operationId) return;
    setRestoreScopePaths(selectedPaths);
    setRollbackReturnPhase(state.phase === "completed" || state.phase === "failed" || state.phase === "cancelled" ? state.phase : resultPhase(state.manifest));
    const controller = new AbortController();
    setController(controller);
    state.patch({ error: null, phase: "rolling-back" });
    try {
      const selected = selectedPaths ? new Set(selectedPaths) : null;
      const result = await restorePreviousDrafts({
        ...context,
        operationId: state.operationId,
        policies: buildRestorePolicies(selectedPaths),
        defaultPolicy: selectedPaths?.length ? "keep-current" : "cancel",
      });
      const relevantConflicts = selected ? result.conflicts.filter((conflict) => selected.has(conflict.path)) : result.conflicts;
      if (!relevantConflicts.length) {
        state.patch({ manifest: result.manifest, phase: "completed" });
        setRestoreScopePaths(null);
        await reload();
        return;
      }
      const files = new Map(result.manifest.modifiedFiles.map((file) => [file.path, file]));
      const conflicts = await Promise.all(relevantConflicts.map(async (conflict) => {
        const file = files.get(conflict.path);
        const [currentContent, beforeContent] = await Promise.all([
          loadRewriteWorkingCopyText(context, conflict.path).then((value) => value ?? ""),
          Promise.resolve(file?.beforeContent ?? ""),
        ]);
        return { ...conflict, currentContent, beforeContent };
      }));
      state.patch({ manifest: result.manifest, conflicts, rollbackPolicies: Object.fromEntries(conflicts.map((entry) => [entry.path, "cancel"])), phase: "rollback-conflicts" });
    } catch (error) {
      patchOperationError(error, "failed");
    } finally {
      setController(null);
    }
  }

  async function resolveRestoreConflicts() {
    if (!context || !state.operationId) return;
    const policies = state.rollbackPolicies;
    if (state.conflicts.some((conflict) => policies[conflict.path] === "cancel")) return;
    const controller = new AbortController();
    setController(controller);
    state.patch({ phase: "rolling-back" });
    try {
      const result = await restorePreviousDrafts({
        ...context,
        operationId: state.operationId,
        policies: buildRestorePolicies(restoreScopePaths, policies),
        defaultPolicy: restoreScopePaths?.length ? "keep-current" : "cancel",
      });
      state.patch({ manifest: result.manifest, conflicts: [], phase: "completed" });
      setRestoreScopePaths(null);
      await reload();
    } catch (error) {
      patchOperationError(error, "failed");
    } finally {
      setController(null);
    }
  }

  function openRestore() {
    if (!state.manifest) return;
    setRestoreScopePaths(null);
    state.patch({ phase: "rollback-confirmation" });
  }

  return (
    <Dialog open={state.open} onOpenChange={(open) => { if (!open && !busy) state.closeWorkflow(); }}>
      <DialogContent hideCloseButton={busy} className="max-h-[92dvh] min-w-0 !w-[calc(100vw-1rem)] !max-w-4xl overflow-x-hidden overflow-y-auto p-4 sm:p-6">
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
          <ResultState phase={state.phase} manifest={state.manifest} error={state.error} context={context} busy={busy} onRestoreFile={(path) => void beginRestore([path])} />
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
            <DialogFooter><Button variant="outline" onClick={() => state.patch({ phase: rollbackReturnPhase })}>{t("feedbackRewrite.cancelRollback")}</Button><Button variant="destructive" disabled={state.conflicts.some((conflict) => state.rollbackPolicies[conflict.path] === "cancel")} onClick={() => void resolveRestoreConflicts()}>{t("feedbackRewrite.applyRestoreChoices")}</Button></DialogFooter>
          </div>
        )}

        {(state.phase === "completed" || state.phase === "failed" || state.phase === "cancelled") && state.manifest && (
          <DialogFooter className="gap-2 sm:space-x-0">
            {(state.phase === "failed" || state.phase === "cancelled") && state.manifest.scope === "chapter" && state.manifest.modifiedFiles.some((file) => file.status !== "completed") && <Button onClick={() => state.patch({ phase: "resume-confirmation" })}>{t("feedbackRewrite.continueRewrite")}</Button>}
            {state.manifest.scope === "chapter" && state.manifest.status === "saving" && state.manifest.modifiedFiles.length > 0 && state.manifest.modifiedFiles.every((file) => file.status === "completed") && <Button onClick={() => void resumeChapter()}>{t("feedbackRewrite.retryFinalize")}</Button>}
            {state.manifest.modifiedFiles.some(isRestorableRewriteFile) && <Button variant="destructive" onClick={openRestore}><RotateCcw className="mr-2 h-4 w-4" />{t("feedbackRewrite.restore")}</Button>}
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

function ResultState({
  phase,
  manifest,
  error,
  context,
  busy,
  onRestoreFile,
}: {
  phase: "completed" | "failed" | "cancelled";
  manifest: RewriteOperationManifest | null;
  error: string | null;
  context: RewriteRepositoryContext | null;
  busy: boolean;
  onRestoreFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const [currentDrafts, setCurrentDrafts] = useState<Record<string, string | null>>({});

  useEffect(() => {
    setExpandedPaths({});
    setLoadingPaths({});
    setCurrentDrafts({});
  }, [manifest?.operationId, manifest?.updatedAt]);

  const restored = manifest?.status === "rolledBack";
  const partial = manifest?.modifiedFiles.some((file) => file.status === "kept-current") ?? false;
  const completed = manifest?.modifiedFiles.filter((file) => file.status === "completed").length ?? 0;

  async function toggleExpanded(file: RewriteOperationManifest["modifiedFiles"][number]) {
    const expanded = !expandedPaths[file.path];
    setExpandedPaths((current) => ({ ...current, [file.path]: expanded }));
    if (!expanded || currentDrafts[file.path] !== undefined || !context || file.status === "restored") return;
    setLoadingPaths((current) => ({ ...current, [file.path]: true }));
    try {
      const currentDraft = await loadRewriteWorkingCopyText(context, file.path);
      setCurrentDrafts((current) => ({ ...current, [file.path]: currentDraft }));
    } finally {
      setLoadingPaths((current) => ({ ...current, [file.path]: false }));
    }
  }

  return (
    <div className="space-y-4">
      <Alert variant={phase === "completed" ? "default" : "destructive"}>
        {phase === "completed" ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
        <AlertTitle>{restored ? t(partial ? "feedbackRewrite.partialRestore" : "feedbackRewrite.rolledBack") : t(`feedbackRewrite.result.${phase}`)}</AlertTitle>
        {(error || manifest?.error) && <AlertDescription>{error ?? manifest?.error}</AlertDescription>}
      </Alert>

      {manifest && phase !== "completed" && (
        <Alert>
          <FileClock className="h-4 w-4" />
          <AlertTitle>{t("feedbackRewrite.recoveryTitle")}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{t("feedbackRewrite.recoveryDescription")}</p>
            <dl className="grid min-w-0 gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
              <dt className="font-medium">{t("feedbackRewrite.recovery.operationId")}</dt>
              <dd className="break-all">{manifest.operationId}</dd>
              <dt className="font-medium">{t("feedbackRewrite.recovery.repository")}</dt>
              <dd className="break-all">{manifest.owner}/{manifest.repo}</dd>
              <dt className="font-medium">{t("feedbackRewrite.recovery.branch")}</dt>
              <dd className="break-all">{manifest.branch}</dd>
              <dt className="font-medium">{t("feedbackRewrite.recovery.completed")}</dt>
              <dd>{t("feedbackRewrite.progress", { completed, total: manifest.modifiedFiles.length })}</dd>
              <dt className="font-medium">{t("feedbackRewrite.recovery.stage")}</dt>
              <dd>{t(`feedbackRewrite.operationStatus.${manifest.status}`)}</dd>
              <dt className="font-medium">{t("feedbackRewrite.recovery.current")}</dt>
              <dd className="break-all">{manifest.progress.currentParagraphSlug ?? t("feedbackRewrite.recovery.none")}</dd>
              <dt className="font-medium">{t("feedbackRewrite.recovery.originalError")}</dt>
              <dd className="break-words">{error ?? manifest.error ?? t("feedbackRewrite.recovery.none")}</dd>
            </dl>
          </AlertDescription>
        </Alert>
      )}

      {manifest && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t("feedbackRewrite.modifiedFiles")}</h3>
          <div className="space-y-2">
            {manifest.modifiedFiles.map((file) => {
              const expanded = Boolean(expandedPaths[file.path]);
              const liveCurrent = currentDrafts[file.path] ?? null;
              const nextContent = file.status === "restored"
                ? (file.generatedContent ?? null)
                : (liveCurrent ?? file.generatedContent ?? null);
              const previewSource = file.status === "restored" || liveCurrent === null ? (file.generatedContent ? "generated" : "unavailable") : "current";
              const currentDiffersFromSaved = liveCurrent !== null && file.generatedContent !== undefined && file.generatedContent !== null && liveCurrent !== file.generatedContent;
              const hasDiff = nextContent !== null && (file.beforeContent ?? "") !== nextContent;

              return (
                <div key={file.path} className="overflow-hidden rounded-xl border">
                  <button type="button" className="w-full min-w-0 px-3 py-3 text-left sm:px-4" onClick={() => void toggleExpanded(file)}>
                    <div className="flex min-w-0 items-start gap-3">
                      <ChevronRight className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="break-all text-sm font-medium">{file.path}</p>
                        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span>{t("feedbackRewrite.fileRowStatus", { status: t(`feedbackRewrite.fileStatus.${file.status}`) })}</span>
                          {expanded && <span>{t(`feedbackRewrite.previewSource.${previewSource}`)}</span>}
                        </div>
                      </div>
                      <Badge variant="outline" className="shrink-0">{t(`feedbackRewrite.fileStatus.${file.status}`)}</Badge>
                    </div>
                  </button>

                  {expanded && (
                    <div className="space-y-3 border-t px-3 py-3 sm:px-4">
                      {loadingPaths[file.path] ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</div>
                      ) : hasDiff ? (
                        <>
                          {currentDiffersFromSaved && <p className="text-xs text-muted-foreground">{t("feedbackRewrite.previewChangedSinceGenerated")}</p>}
                          <FileDiff previous={file.beforeContent ?? ""} next={nextContent ?? ""} className="max-h-72" />
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">{nextContent === null ? t("feedbackRewrite.noSavedRewrite") : t("feedbackRewrite.noDiffPreview")}</p>
                      )}

                      {isRestorableRewriteFile(file) && (
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="destructive" disabled={busy} onClick={(event) => { event.stopPropagation(); onRestoreFile(file.path); }}>
                            <RotateCcw className="mr-2 h-4 w-4" />
                            {t("feedbackRewrite.restoreThisDraft")}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {manifest.aggregateOutputTokens > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("feedbackRewrite.usage", { input: manifest.aggregateInputTokens, output: manifest.aggregateOutputTokens, cost: manifest.aggregateCost.toFixed(4), currency: manifest.currency ?? "USD" })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function resultPhase(manifest: RewriteOperationManifest | null): "completed" | "failed" | "cancelled" {
  if (!manifest) return "failed";
  if (manifest.status === "completed" || manifest.status === "rolledBack") return "completed";
  if (manifest.status === "cancelled") return "cancelled";
  return "failed";
}

function isRestorableRewriteFile(file: RewriteOperationManifest["modifiedFiles"][number]): boolean {
  return file.status === "completed" || file.status === "kept-current";
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
