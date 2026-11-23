import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2 } from "lucide-react";
import "@/i18n/githubCreateBook";
import "@/i18n/githubApp";
import { GITHUB_APP_SLUG } from "@/config/publicClients";
import { installAppUrl } from "@/github/githubAppInstall";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PAGES_WORKFLOW_PATH, type BookRepositoryError, type BookRepositoryProgress, type CreateCompleteBookRepositoryResult } from "@/github/bookRepository";
import { bookRepositoryErrorText } from "@/github/bookRepositoryTexts";
import { formatRepositoryBytes } from "@/repository/repositoryLimits";

const TARGET = "h-auto min-h-9 whitespace-normal text-left [@media(pointer:coarse)]:min-h-11";
const SUMMARY = "cursor-pointer py-2 text-sm font-semibold [@media(pointer:coarse)]:py-3";

/** The step the creation is at, in a polite live region (one line that changes, not a message for every request). */
export function GitHubCreateProgress({ progress, busy }: { progress: BookRepositoryProgress | null; busy: boolean }) {
  const { t } = useTranslation();
  const text = !busy || !progress ? "" : progress.chunk && progress.chunks && progress.chunks > 1 ? t("github.createBook.progress.firstCommitPart", { chunk: progress.chunk, chunks: progress.chunks }) : t(`github.createBook.progress.${progress.step === "first-commit" ? "firstCommit" : progress.step}`);
  return (
    <div role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
      {busy && <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{text || t("github.createBook.progress.label")}</span>}
    </div>
  );
}

export interface GitHubCreateFailureProps {
  error: BookRepositoryError;
  owner: string;
  repo: string;
  busy: boolean;
  /** Fill the same empty repository again. */
  onRetry: () => void;
  /** Delete the empty repository: only after the user has said so here. */
  onDelete: () => Promise<void>;
}

/** What went wrong, in words; and, when the repository exists with no first commit, the two things the user can do about it. */
export function GitHubCreateFailure({ error, owner, repo, busy, onRetry, onDelete }: GitHubCreateFailureProps) {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState<"idle" | "confirm" | "deleting" | "deleted" | "failed">("idle");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const empty = error.repository;
  useEffect(() => { if (step === "confirm") confirmRef.current?.focus(); }, [step]);
  // On a phone the form is longer than the screen: the failure comes into view, without taking the focus from the button that was pressed.
  useEffect(() => { alertRef.current?.scrollIntoView?.({ block: "nearest" }); }, []);
  const text = bookRepositoryErrorText(t, error, { owner: empty?.owner ?? owner, repo: empty?.repo ?? repo }, i18n.resolvedLanguage || i18n.language);
  const remove = async () => {
    setStep("deleting");
    try { await onDelete(); setStep("deleted"); } catch { setStep("failed"); }
  };
  if (step === "deleted") return <Alert role="status"><AlertDescription>{t("github.createBook.recover.deleted")}</AlertDescription></Alert>;
  return (
    <Alert ref={alertRef} variant="destructive" role="alert">
      <AlertDescription className="space-y-3">
        <p className="font-medium">{t("github.createBook.error.title")}</p>
        <p>{text}</p>
        {error.tokenKind === "app" && GITHUB_APP_SLUG && (error.code === "cannot-create" || (error.code === "first-commit-failed" && (error.reason === "permission" || error.reason === "permission-unverified"))) && (
          <Button asChild variant="outline" className={TARGET}>
            <a href={installAppUrl()} target="_blank" rel="noopener noreferrer">{t("github.createBook.app.install")}<span className="sr-only"> {t("github.createBook.result.newTab")}</span><ExternalLink className="h-4 w-4" aria-hidden="true" /></a>
          </Button>
        )}
        {empty && (
          <div className="space-y-3 rounded-md border border-destructive/30 p-3">
            <p className="font-medium">{t("github.createBook.recover.title")}</p>
            <p>{t("github.createBook.recover.text", { owner: empty.owner, repo: empty.repo })}</p>
            {step === "failed" && <p>{t("github.createBook.recover.deleteFailed")}</p>}
            {step === "confirm" || step === "deleting" ? (
              <div className="space-y-2">
                <p>{t("github.createBook.recover.confirm", { owner: empty.owner, repo: empty.repo })}</p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="destructive" className={TARGET} disabled={step === "deleting"} onClick={() => void remove()}>
                    {step === "deleting" ? t("github.createBook.recover.deleting") : t("github.createBook.recover.confirmYes")}
                  </Button>
                  <Button ref={confirmRef} type="button" variant="outline" className={TARGET} disabled={step === "deleting"} onClick={() => setStep("idle")}>{t("github.createBook.recover.confirmNo")}</Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button type="button" className={TARGET} disabled={busy} onClick={onRetry}>{busy ? t("github.createBook.recover.retrying") : t("github.createBook.recover.retry")}</Button>
                {empty.created && <Button type="button" variant="outline" className={TARGET} disabled={busy} onClick={() => setStep("confirm")}>{t("github.createBook.recover.delete")}</Button>}
                <Button asChild variant="outline" className={TARGET}>
                  <a href={empty.htmlUrl} target="_blank" rel="noopener noreferrer">{t("github.createBook.recover.open")}<span className="sr-only"> {t("github.createBook.result.newTab")}</span><ExternalLink className="h-4 w-4" aria-hidden="true" /></a>
                </Button>
              </div>
            )}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}

export interface GitHubCreateResultProps {
  result: CreateCompleteBookRepositoryResult;
  onOpenBook: () => void;
}

/** What was made and what was not, with the manual steps for what was not. It takes the focus when it appears, so that a keyboard or screen reader user lands on it. */
export function GitHubCreateResult({ result, onOpenBook }: GitHubCreateResultProps) {
  const { t, i18n } = useTranslation();
  const base = useId();
  const ref = useRef<HTMLElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => { ref.current?.focus(); }, []);
  const locale = i18n.resolvedLanguage || i18n.language;
  const url = `https://${result.owner.toLowerCase()}.github.io/${result.repo}/`;
  const workflowFile = result.pendingWorkflow.find((file) => file.path === PAGES_WORKFLOW_PATH);
  const rateLimit = result.warnings.find((warning) => warning.code === "workflow-rate-limit");
  const reset = rateLimit?.resetAt ? new Date(rateLimit.resetAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : undefined;
  const workflowKey = result.workflow === "done" ? "done" : result.workflow === "not-allowed" ? "notAllowed" : rateLimit ? "rateLimit" : workflowFile ? "skipped" : "none";
  const branch = result.warnings.some((warning) => warning.code === "branch-not-main");
  const planHint = result.pages === "manual" && result.private;
  const showPagesSteps = result.pages !== "enabled";
  const needsWorkflowPermission = result.workflow === "not-allowed" || (result.workflow === "skipped" && Boolean(workflowFile));
  const copyWorkflow = async () => {
    try { await navigator.clipboard.writeText(workflowFile?.content ?? ""); setCopy("copied"); } catch { setCopy("failed"); }
  };

  return (
    <section ref={ref} tabIndex={-1} aria-labelledby={`${base}-title`} className="space-y-4 rounded-lg border bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <h2 id={`${base}-title`} className="text-lg font-semibold">{t("github.createBook.result.title")}</h2>
      <p className="text-sm">{t("github.createBook.result.intro", { owner: result.owner, repo: result.repo, visibility: t(result.private ? "github.createBook.result.private" : "github.createBook.result.public") })}</p>
      <ul aria-label={t("github.createBook.result.listLabel")} className="list-disc space-y-1 pl-5 text-sm">
        <li>{t("github.createBook.result.files", { files: result.committed.files, size: formatRepositoryBytes(result.committed.bytes) })}</li>
        <li>{workflowKey === "notAllowed" && result.tokenKind === "app" ? t("github.createBook.app.workflowNotAllowed") : t(`github.createBook.result.workflow.${workflowKey}`, { reset })}</li>
        <li>{t(`github.createBook.result.pages.${result.pages}`, { url })}</li>
        {branch && <li>{t("github.createBook.result.branch", { branch: result.defaultBranch })}</li>}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" className={TARGET} onClick={onOpenBook}>{t("github.createBook.result.openBook")}</Button>
        <Button asChild variant="outline" className={TARGET}>
          <a href={result.htmlUrl} target="_blank" rel="noopener noreferrer">{t("github.createBook.result.openRepository")}<span className="sr-only"> {t("github.createBook.result.newTab")}</span><ExternalLink className="h-4 w-4" aria-hidden="true" /></a>
        </Button>
      </div>

      {needsWorkflowPermission && workflowFile && (
        <details open className="rounded-md border p-3">
          <summary className={SUMMARY}>{t("github.createBook.manual.workflow.title")}</summary>
          <div className="mt-2 space-y-3 text-sm">
            <p>{t("github.createBook.manual.workflow.intro")}</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>{t("github.createBook.manual.workflow.step1")}</li>
              <li>{t("github.createBook.manual.workflow.step2", { path: workflowFile.path })}</li>
              <li>{t("github.createBook.manual.workflow.step3")}</li>
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" className={TARGET} onClick={() => void copyWorkflow()}>{t("github.createBook.manual.workflow.copy")}</Button>
              <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
                {copy === "copied" && t("github.createBook.manual.workflow.copied")}
                {copy === "failed" && t("github.createBook.manual.workflow.copyFailed")}
              </span>
            </div>
            <pre tabIndex={0} aria-label={t("github.createBook.manual.workflow.contentLabel", { path: workflowFile.path })} className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">{workflowFile.content}</pre>
          </div>
        </details>
      )}

      {showPagesSteps && (
        <details open={result.pages === "manual"} className="rounded-md border p-3">
          <summary className={SUMMARY}>{t("github.createBook.manual.pages.title")}</summary>
          <div className="mt-2 space-y-2 text-sm">
            <ol className="list-decimal space-y-1 pl-5">
              <li>{t("github.createBook.manual.pages.step1")}</li>
              <li>{t("github.createBook.manual.pages.step2")}</li>
              <li>{t("github.createBook.manual.pages.step3", { url })}</li>
            </ol>
            {planHint && <p>{t("github.createBook.manual.pages.plan")}</p>}
          </div>
        </details>
      )}

      {(needsWorkflowPermission || result.pages === "manual") && (
        <div className="space-y-1 text-sm">
          <h3 className="font-medium">{t("github.createBook.manual.token.title")}</h3>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {needsWorkflowPermission && <li>{t("github.createBook.manual.token.workflow")}</li>}
            {result.pages === "manual" && <li>{t("github.createBook.manual.token.pages")}</li>}
          </ul>
        </div>
      )}
    </section>
  );
}
