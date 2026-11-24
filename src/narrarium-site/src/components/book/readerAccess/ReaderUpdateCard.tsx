import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import "@/i18n/readerUpdate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import type { BookEntry } from "@/types/settings";
import { describeReaderFailure } from "@/readerAccess/messages";
import { LEGACY_READER_SECRET } from "@/readerAccess/contract";
import { readerProtection } from "@/readerAccess/model";
import type { ReaderAccess } from "@/components/book/readerAccess/useReaderAccess";
import type { ReaderUpdateDecision } from "@/readerUpdate/decision";
import { outsideCheckCommand, outsideCheckUrls, runOutsideCheck, type OutsideCheckResult } from "@/readerUpdate/outsideCheck";
import { useReaderUpdate } from "@/readerUpdate/useReaderUpdate";

type Update = Extract<ReaderUpdateDecision, { kind: "update" }>;

const RUN_KEY = { queued: "queued", running: "running", succeeded: "succeeded", failed: "failed", cancelled: "cancelled" } as const;

function UpdateDetails({ update }: { update: Update }) {
  const { t } = useTranslation();
  const added = update.folder.writes.filter((file) => file.change === "added");
  const replaced = update.folder.writes.filter((file) => file.change === "replaced");
  const params = { replaced: replaced.length, added: added.length, version: update.folder.version ?? "" };
  const files: Array<[string, string[]]> = [["filesReplaced", replaced.map((file) => file.path)], ["filesAdded", added.map((file) => file.path)], ["filesDeleted", update.folder.deletes.map((file) => file.path)]];
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{t("readerUpdate.what")}</h4>
      <ul className="ml-4 list-disc space-y-1 break-words text-sm">
        {update.workflowChanges && <li>{t(update.workflow.status === "missing" ? "readerUpdate.workflowAdd" : "readerUpdate.workflowUpgrade")}</li>}
        {update.workflowChanges && update.workflow.settings.legacyPasswordSecret && <li>{t("readerUpdate.workflowLegacy", { name: LEGACY_READER_SECRET })}</li>}
        {update.folder.writes.length > 0 && <li>{t(update.folder.version ? "readerUpdate.folder" : "readerUpdate.folderNoVersion", params)}</li>}
        {update.folder.deletes.length > 0 && <li>{t("readerUpdate.deletes", { count: update.folder.deletes.length })}</li>}
        {update.folder.kept.length > 0 && <li>{t("readerUpdate.kept", { count: update.folder.kept.length })}</li>}
        <li>{t("readerUpdate.untouched")}</li>
      </ul>
      {update.folder.writes.length + update.folder.deletes.length > 0 && (
        <details className="text-xs">
          <summary className="inline-flex min-h-6 cursor-pointer items-center font-medium underline underline-offset-2">{t("readerUpdate.files")}</summary>
          <div className="mt-2 space-y-2">
            {files.filter(([, paths]) => paths.length > 0).map(([label, paths]) => (
              <div key={label}>
                <p className="font-medium">{t(`readerUpdate.${label}`)} ({paths.length})</p>
                <ul className="max-h-40 overflow-auto break-all font-mono text-muted-foreground">{paths.map((path) => <li key={path}>{path}</li>)}</ul>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function OutsideCheck({ siteUrl }: { siteUrl: string }) {
  const { t } = useTranslation();
  const titleId = useId();
  const [result, setResult] = useState<OutsideCheckResult | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const urls = outsideCheckUrls(siteUrl, Date.now());
  const command = outsideCheckCommand(urls);
  const check = async () => {
    setRunning(true);
    setResult(null);
    setResult(await runOutsideCheck(outsideCheckUrls(siteUrl, Date.now())));
    setRunning(false);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); } catch { setCopied(false); }
  };
  const showCommand = result === null || result.kind === "unreachable";
  return (
    <section aria-labelledby={titleId} className="space-y-2 rounded-md border p-3 text-sm" data-testid="reader-outside-check">
      <h3 id={titleId} className="font-medium">{t("readerUpdate.outside.title")}</h3>
      <p className="text-muted-foreground">{t("readerUpdate.outside.description")}</p>
      <Button type="button" size="sm" variant="outline" disabled={running} onClick={() => void check()}>
        {running ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />}{running ? t("readerUpdate.outside.checking") : t("readerUpdate.outside.check")}
      </Button>
      <div role="status" aria-live="polite">
        {result?.kind === "protected" && <p className="flex items-start gap-2 font-medium"><CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("readerUpdate.outside.protected")}</p>}
        {result?.kind === "epub-exposed" && <p className="flex items-start gap-2 font-medium text-destructive"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("readerUpdate.outside.epubExposed", { status: result.status })}</p>}
        {result?.kind === "not-protected" && <p className="flex items-start gap-2"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("readerUpdate.outside.notProtected")}</p>}
        {result?.kind === "unreachable" && <p>{t("readerUpdate.outside.unreachable")}</p>}
      </div>
      {showCommand && (
        <div className="space-y-1">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs" aria-label={t("readerUpdate.outside.command")} tabIndex={0}>{command}</pre>
          <Button type="button" size="sm" variant="ghost" onClick={() => void copy()}><Copy aria-hidden="true" className="mr-1 h-4 w-4" />{copied ? t("readerUpdate.outside.copied") : t("readerUpdate.outside.copy")}</Button>
        </div>
      )}
    </section>
  );
}

/**
 * «Update the reader»: a book repository whose workflow or reader/ folder is older than the one the site carries is offered ONE explicit commit that brings both
 * to the current version. The commit is made in the working copy on this device and published with the book's credential, like any change; offline or without a
 * credential it stays on this device and the card says it will publish at the next sync and that the site stays as it is until then. Nothing is silent: the
 * card says what is exposed, what the commit changes and, for a workflow with edits, shows the differing lines and asks for «replace my edits».
 */
export function ReaderUpdateCard({ book, access }: { book: BookEntry; access: ReaderAccess }) {
  const { t } = useTranslation();
  const titleId = useId();
  const { snapshot } = access;
  const remote = {
    pagesOn: snapshot.pages ? snapshot.pages.status === "enabled" : null,
    passwordsSet: snapshot.loadedAt === null ? null : readerProtection(snapshot.remote) === "protected" ? true : readerProtection(snapshot.remote) === "public" ? false : null,
  };
  const update = useReaderUpdate(book, remote);
  const [replaceEdits, setReplaceEdits] = useState(false);
  const decision = update.inspection?.decision;
  const run = snapshot.runs?.[0];
  const siteUrl = snapshot.pages?.status === "enabled" ? snapshot.pages.url : null;
  const outcomeRun = update.outcome?.published && run && run.headSha === update.outcome.commitSha ? run : null;
  const publishedRunDone = outcomeRun?.state === "succeeded";
  const busy = update.applying;

  const doUpdate = async () => {
    const outcome = await update.apply({ replaceEdits });
    if (outcome?.published) access.watchCommit(outcome.commitSha);
  };

  let body: React.ReactNode = null;
  if (update.checking && !decision) {
    body = <p role="status" className="flex items-center gap-2 text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("readerUpdate.checking")}</p>;
  } else if (!decision) {
    body = <p role="status" className="text-muted-foreground">{t("readerUpdate.unreadable")}</p>;
  } else if (decision.kind === "update") {
    const exposure = decision.exposure;
    body = (
      <div className="space-y-4">
        <section className={`space-y-1 rounded-md border p-3 ${exposure === "password-old-reader" ? "border-destructive/60 bg-destructive/5" : "border-amber-600/50 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"}`} data-testid="reader-update-exposure">
          <h3 className="flex items-start gap-2 text-sm font-semibold"><ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t(`readerUpdate.exposure.${exposure}.title`)}</h3>
          <p className="text-sm">{t(`readerUpdate.exposure.${exposure}.body`)}</p>
        </section>
        {snapshot.workflowState === "paused" && <p role="note" className="text-sm">{t("readerUpdate.paused")}</p>}
        <UpdateDetails update={decision} />
        {decision.customized && (
          <section className="space-y-2 rounded-md border border-amber-600/50 p-3 text-sm" data-testid="reader-update-customized">
            <h4 className="font-medium">{t("readerUpdate.customized.title")}</h4>
            <p>{t("readerUpdate.customized.body")}</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs" tabIndex={0} aria-label={t("readerUpdate.customized.title")}>{decision.workflow.customizations.join("\n")}</pre>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={replaceEdits} onChange={(event) => setReplaceEdits(event.target.checked)} /><span className="font-medium">{t("readerUpdate.customized.confirm")}</span></label>
          </section>
        )}
        <div className="space-y-1 text-sm">
          <p>{t(`readerUpdate.delivery.${decision.delivery}`, { branch: update.branch })}</p>
          {!decision.publishesFromBranch && <p className="font-medium">{t("readerUpdate.delivery.otherBranch", { branch: update.branch })}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={busy || (decision.customized && !replaceEdits)} aria-describedby={decision.customized && !replaceEdits ? `${titleId}-needed` : undefined} onClick={() => void doUpdate()}>
            {busy ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />}{busy ? t("readerUpdate.updating") : t("readerUpdate.update")}
          </Button>
          {decision.customized && !replaceEdits && <span id={`${titleId}-needed`} className="text-xs text-muted-foreground">{t("readerUpdate.customized.needed")}</span>}
        </div>
      </div>
    );
  } else {
    const message = decision.kind === "current"
      ? t(decision.version ? "readerUpdate.current" : "readerUpdate.currentNoVersion", { version: decision.version ?? "" })
      : decision.kind === "elsewhere" ? t("readerUpdate.elsewhere", { dir: decision.readerDir })
      : decision.kind === "not-published" ? t("readerUpdate.notPublished")
      : decision.kind === "no-working-copy" ? t("readerUpdate.noWorkingCopy")
      : decision.kind === "local-only" ? t("readerUpdate.localOnly")
      : t("readerUpdate.unreadable");
    body = <p role="status" className="flex items-start gap-2">{decision.kind === "current" && <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}<span>{message}</span></p>;
  }

  const failure = update.failure;
  const failureText = failure ? (failure.kind === "refused-customized" ? t("readerUpdate.failure.customized")
    : failure.kind === "changed" ? t("readerUpdate.failure.changed")
    : failure.kind === "github" ? (failure.failure.kind === "permission" && failure.failure.permissions.includes("workflows") ? t("readerUpdate.failure.permission") : (() => { const line = describeReaderFailure(failure.failure, access.tokenKind); return `${t("readerUpdate.failure.other")} ${t(line.key, line.params)}`; })())
    : t("readerUpdate.failure.other")) : null;

  return (
    <Card aria-labelledby={titleId} data-testid="reader-update-card">
      <CardHeader>
        <CardTitle id={titleId} className="flex items-center gap-2"><RefreshCw aria-hidden="true" className="h-4 w-4" />{t("readerUpdate.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {body}
        {failureText && <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 p-3 text-destructive"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{failureText}</p>}
        {update.outcome && (
          <div role="status" className="space-y-1 rounded-md border border-primary/40 bg-primary/5 p-3" data-testid="reader-update-outcome">
            <p className="flex items-start gap-2 font-medium"><CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{update.outcome.published ? t("readerUpdate.result.published", { branch: update.branch, sha: update.outcome.commitSha.slice(0, 7) }) : t("readerUpdate.result.local")}</p>
            {update.outcome.published && (
              <p className="text-xs text-muted-foreground">
                {t("readerUpdate.run.label")}: {outcomeRun
                  ? <><strong>{t(`readerAccess.run.${RUN_KEY[outcomeRun.state]}`)}</strong> · <LocalTime value={outcomeRun.createdAt} /> · <a className="font-medium text-foreground underline underline-offset-2" href={outcomeRun.url} target="_blank" rel="noopener noreferrer">{t("readerAccess.run.open")}<ExternalLink aria-hidden="true" className="ml-1 inline h-3 w-3" /><span className="sr-only"> {t("readerAccess.opensNewTab")}</span></a></>
                  : t("readerUpdate.run.waiting")}
              </p>
            )}
          </div>
        )}
        {siteUrl && (publishedRunDone || (decision?.kind === "current" && !update.outcome)) && <OutsideCheck siteUrl={siteUrl} />}
        <Button type="button" size="sm" variant="ghost" disabled={update.checking || busy} onClick={() => void update.check()}>{update.checking ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />}{t("readerUpdate.recheck")}</Button>
      </CardContent>
    </Card>
  );
}
