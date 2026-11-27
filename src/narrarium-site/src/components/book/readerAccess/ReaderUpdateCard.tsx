import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import "@/i18n/readerUpdate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BookEntry } from "@/types/settings";
import { describeReaderFailure } from "@/readerAccess/messages";
import { LEGACY_READER_SECRET } from "@/readerAccess/contract";
import { readerProtection } from "@/readerAccess/model";
import type { ReaderAccess } from "@/components/book/readerAccess/useReaderAccess";
import type { ReaderUpdateDecision, UpdateTarget } from "@/readerUpdate/decision";
import { outsideCheckCommand, outsideCheckUrls } from "@/readerUpdate/outsideCheck";
import { useOutsideCheck } from "@/readerRun/outsideStore";
import { PublicationRun } from "@/components/book/readerAccess/PublicationRun";
import { RunFailureNotice } from "@/components/book/readerAccess/RunFailureNotice";
import { useBranchSyncStore } from "@/branches/syncStore";
import { RepositoryError, repositoryErrorDescription, type RepositoryErrorKind } from "@/repository/repositoryError";
import { useReaderUpdate, useWorkingBranch, type ReaderUpdateFailure } from "@/readerUpdate/useReaderUpdate";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Update = Extract<ReaderUpdateDecision, { kind: "update" }>;
type OnDevice = Extract<ReaderUpdateDecision, { kind: "on-device" }>;

interface PlanView { branch: string; plan: Pick<UpdateTarget, "workflow" | "workflowChanges" | "folder">; legacyPassword: boolean }

/** What the update changes, branch by branch when it is made on two: the publishing branch's plan and the working branch's are listed apart, and said to be the same files when they are. */
function UpdateDetails({ plans }: { plans: PlanView[] }) {
  const { t } = useTranslation();
  const same = plans.length === 2 && plans[0].plan.workflowChanges === plans[1].plan.workflowChanges
    && JSON.stringify(plans[0].plan.folder.writes.map((file) => [file.path, file.content])) === JSON.stringify(plans[1].plan.folder.writes.map((file) => [file.path, file.content]))
    && plans[0].plan.folder.deletes.length === plans[1].plan.folder.deletes.length;
  const shown = same ? [plans[0]] : plans;
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">{t("readerUpdate.what")}</h4>
      {same && <p className="text-xs text-muted-foreground" data-testid="reader-update-same">{t("readerUpdate.branches.same")}</p>}
      {shown.map(({ branch, plan, legacyPassword }) => {
        const added = plan.folder.writes.filter((file) => file.change === "added");
        const replaced = plan.folder.writes.filter((file) => file.change === "replaced");
        const params = { replaced: replaced.length, added: added.length, version: plan.folder.version ?? "" };
        const files: Array<[string, string[]]> = [["filesReplaced", replaced.map((file) => file.path)], ["filesAdded", added.map((file) => file.path)], ["filesDeleted", plan.folder.deletes.map((file) => file.path)]];
        return (
          <div key={branch} className="space-y-2" data-testid="reader-update-plan">
            {shown.length > 1 && <h5 className="text-sm font-medium">{t("readerUpdate.branches.plan", { branch })}</h5>}
            <ul className="ml-4 list-disc space-y-1 break-words text-sm">
              {plan.workflowChanges && <li>{t(plan.workflow.status === "missing" ? "readerUpdate.workflowAdd" : "readerUpdate.workflowUpgrade")}</li>}
              {plan.workflowChanges && legacyPassword && <li>{t("readerUpdate.workflowLegacy", { name: LEGACY_READER_SECRET })}</li>}
              {plan.folder.writes.length > 0 && <li>{t(plan.folder.version ? "readerUpdate.folder" : "readerUpdate.folderNoVersion", params)}</li>}
              {plan.folder.deletes.length > 0 && <li>{t("readerUpdate.deletes", { count: plan.folder.deletes.length })}</li>}
              {plan.folder.kept.length > 0 && <li>{t("readerUpdate.kept", { count: plan.folder.kept.length })}</li>}
              <li>{t("readerUpdate.untouched")}</li>
            </ul>
            {plan.folder.writes.length + plan.folder.deletes.length > 0 && (
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
      })}
    </div>
  );
}

/** The branches the card is about, and what each has: «main (publishes the reader): old reader; this branch: reader up to date». Nothing when the author works on the publishing branch itself. */
function BranchStates({ decision, branch }: { decision: Extract<ReaderUpdateDecision, { kind: "update" | "on-device" | "current" }>; branch: string }) {
  const { t } = useTranslation();
  const titleId = useId();
  const publishing = decision.publishing;
  if (!publishing) return null;
  const mine = decision.kind === "update" && decision.currentNeeded ? "old" : "updated";
  const theirs = publishing.state === "current" ? "updated" : publishing.state;
  return (
    <section aria-labelledby={titleId} className="space-y-1 rounded-md border p-3 text-sm" data-testid="reader-branches">
      <h4 id={titleId} className="font-medium">{t("readerUpdate.branches.title")}</h4>
      <ul className="space-y-1">
        <li data-branch="publishing" data-state={theirs}><strong>{t("readerUpdate.branches.publishing", { branch: publishing.branch })}</strong>: {t(`readerUpdate.branches.state.${theirs}`)}</li>
        <li data-branch="current" data-state={mine}><strong>{t("readerUpdate.branches.current", { branch })}</strong>: {t(`readerUpdate.branches.state.${mine}`)}</li>
      </ul>
    </section>
  );
}

/** What the update does where it is made, in one sentence: on both branches, only on the publishing one, only here because the publishing branch cannot be reached, or on this one. */
function deliveryLine(t: (key: string, options?: Record<string, unknown>) => string, decision: Update, branch: string): string {
  const publishing = decision.publishing;
  const params = { branch, publishing: publishing?.branch ?? "" };
  const target = decision.publishingTarget;
  if (target) {
    if (target.delivery !== "now") return t("readerUpdate.delivery.publishingLater", { ...params, why: t(`readerUpdate.delivery.publishingLaterWhy.${target.delivery === "no-credential" ? "no-credential" : target.delivery === "offline" ? "offline" : "unknown"}`) });
    return t(decision.currentNeeded ? "readerUpdate.delivery.both" : "readerUpdate.delivery.publishingOnly", params);
  }
  if (publishing?.state === "unknown") return t("readerUpdate.delivery.publishingLater", { ...params, why: t(`readerUpdate.delivery.publishingLaterWhy.${decision.delivery === "no-credential" ? "no-credential" : decision.delivery === "offline" ? "offline" : "unknown"}`) });
  if (publishing?.state === "unreadable") return t("readerUpdate.delivery.publishingUnreadable", params);
  return t(`readerUpdate.delivery.${decision.delivery}`, params);
}

function TurnPagesOff({ onAsk }: { onAsk: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2 rounded-md border border-destructive/40 p-3 text-sm" data-testid="reader-turn-pages-off">
      <h4 className="font-medium">{t("readerUpdate.pagesOff.offerTitle")}</h4>
      <p>{t("readerUpdate.pagesOff.offerBody")}</p>
      <Button type="button" size="sm" variant="destructive" onClick={onAsk}>{t("readerUpdate.pagesOff.button")}</Button>
    </section>
  );
}

function OnDeviceBody({ decision, lastAuto, branch, syncing, onSync, pagesOn, onTurnOff, workflowPaused }: { decision: OnDevice; lastAuto: { outcome: string; errorKind?: string } | null; branch: string; syncing: boolean; onSync: () => void; pagesOn: boolean; onTurnOff: () => void; workflowPaused: boolean }) {
  const { t } = useTranslation();
  const blocked = decision.delivery === "no-credential" || decision.delivery === "offline";
  const exposure = decision.exposure;
  return (
    <div className="space-y-4">
      <section className="space-y-1 rounded-md border border-amber-600/50 bg-amber-50 p-3 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" data-testid="reader-on-device">
        <h3 className="flex items-start gap-2 text-sm font-semibold"><ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("readerUpdate.onDevice.title")}</h3>
        <p className="text-sm">{t(`readerUpdate.onDevice.reason.${decision.reason}`, { count: decision.unpublished.length })}</p>
        {decision.remoteWorkflow === "old" && <p className="text-sm">{t("readerUpdate.onDevice.remoteOld")}</p>}
        {decision.remoteWorkflow === "missing" && <p className="text-sm">{t("readerUpdate.onDevice.remoteMissing")}</p>}
      </section>
      {exposure && exposure !== "not-published" && (
        <section className={`space-y-1 rounded-md border p-3 ${exposure === "password-old-reader" ? "border-destructive/60 bg-destructive/5" : "border-amber-600/50"}`} data-testid="reader-update-exposure">
          <h3 className="flex items-start gap-2 text-sm font-semibold"><ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t(`readerUpdate.exposure.${exposure}.title`)}</h3>
          <p className="text-sm">{t(`readerUpdate.exposure.${exposure}.body`)}</p>
        </section>
      )}
      {workflowPaused && <p role="note" className="text-sm">{t("readerUpdate.paused")}</p>}
      {decision.unpublished.length > 0 && (
        <details className="text-xs">
          <summary className="inline-flex min-h-6 cursor-pointer items-center font-medium underline underline-offset-2">{t("readerUpdate.onDevice.files", { count: decision.unpublished.length })}</summary>
          <ul className="mt-2 max-h-40 overflow-auto break-all font-mono text-muted-foreground">{decision.unpublished.map((path) => <li key={path}>{path}</li>)}</ul>
        </details>
      )}
      {lastAuto && (
        <p className="text-sm" data-testid="reader-last-auto-sync">
          {lastAuto.outcome === "failed"
            ? t("readerUpdate.onDevice.auto.failed", { reason: repositoryErrorDescription(new RepositoryError("", (lastAuto.errorKind ?? "unknown") as RepositoryErrorKind, "compare"), t) })
            : t(`readerUpdate.onDevice.auto.${lastAuto.outcome === "name-taken" || lastAuto.outcome === "gone" ? "other" : lastAuto.outcome}`)}
        </p>
      )}
      <BranchStates decision={decision} branch={branch} />
      <p className="text-sm">{t(`readerUpdate.onDevice.delivery.${decision.delivery}`, { branch })}</p>
      {!decision.publishesFromBranch && (decision.publishing?.state === "unknown" || decision.publishing?.state === "unreadable") && <p className="text-sm font-medium">{t("readerUpdate.delivery.otherBranch", { branch, publishing: decision.publishing.branch })}</p>}
      {pagesOn && exposure === "password-old-reader" && <TurnPagesOff onAsk={onTurnOff} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={syncing || blocked} aria-describedby={blocked ? "reader-sync-blocked" : undefined} onClick={onSync}>
          {syncing ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />}{syncing ? t("readerUpdate.onDevice.syncing") : t("readerUpdate.onDevice.sync")}
        </Button>
        {blocked && <span id="reader-sync-blocked" className="text-xs text-muted-foreground">{t(`readerUpdate.onDevice.blocked.${decision.delivery}`)}</span>}
      </div>
    </div>
  );
}

function OutsideCheck({ siteUrl }: { siteUrl: string }) {
  const { t } = useTranslation();
  const titleId = useId();
  // The answer is shared with the other card and with the publication that asked for it: one check, read wherever it matters.
  const outside = useOutsideCheck(siteUrl);
  const result = outside.result;
  const running = outside.running;
  const [copied, setCopied] = useState(false);
  const urls = outsideCheckUrls(siteUrl, Date.now());
  const command = outsideCheckCommand(urls);
  const check = async () => { await outside.check(); };
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
  const workingBranch = useWorkingBranch(book);
  // GitHub's workflow is read on the default branch: it says what GitHub has only for a book that works on that branch.
  const workflowRead = snapshot.workflow && !snapshot.failures.workflow && snapshot.repository?.defaultBranch === workingBranch;
  const remote = {
    pagesOn: snapshot.pages ? snapshot.pages.status === "enabled" : null,
    passwordsSet: snapshot.loadedAt === null ? null : readerProtection(snapshot.remote) === "protected" ? true : readerProtection(snapshot.remote) === "public" ? false : null,
    ...(workflowRead ? { workflowText: snapshot.workflow!.present ? snapshot.workflow!.content ?? null : null } : {}),
  };
  const update = useReaderUpdate(book, remote, snapshot.repository?.defaultBranch ? { publishingBranch: snapshot.repository.defaultBranch } : {});
  const [pagesOffAsked, setPagesOffAsked] = useState(false);
  const lastAutoOutcome = useBranchSyncStore((state) => state.books[book.id]?.branches[workingBranch]);
  const lastAuto = lastAutoOutcome && ["failed", "diverged", "held", "gone", "name-taken"].includes(lastAutoOutcome.outcome) ? lastAutoOutcome : null;
  const [replaceEdits, setReplaceEdits] = useState(false);
  const decision = update.inspection?.decision;
  const siteUrl = snapshot.pages?.status === "enabled" ? snapshot.pages.url : null;
  // The publication that the update made is followed live under it: its run is found by the commit that was pushed to the publishing branch.
  const tracked = access.publication.tracked;
  const trackedHere = tracked !== null && tracked.trigger === "push" && update.outcome?.published === true && tracked.headSha === update.outcome.commitSha;
  const publishedRunDone = trackedHere && tracked.state === "succeeded";
  const busy = update.applying;

  const doSync = async () => {
    const result = await update.syncNow();
    if (result?.headSha) access.watchCommit(result.headSha);
  };

  const doUpdate = async () => {
    const outcome = await update.apply({ replaceEdits });
    if (outcome?.published) access.watchCommit(outcome.commitSha, outcome.publishedBranch ?? undefined);
  };

  let body: React.ReactNode = null;
  if (update.checking && !decision) {
    body = <p role="status" className="flex items-center gap-2 text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("readerUpdate.checking")}</p>;
  } else if (!decision) {
    body = <p role="status" className="text-muted-foreground">{t("readerUpdate.unreadable")}</p>;
  } else if (decision.kind === "update") {
    const exposure = decision.exposure;
    const needsReplace = (decision.currentNeeded && decision.customized) || Boolean(decision.publishingTarget?.customized);
    body = (
      <div className="space-y-4">
        <section className={`space-y-1 rounded-md border p-3 ${exposure === "password-old-reader" ? "border-destructive/60 bg-destructive/5" : "border-amber-600/50 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"}`} data-testid="reader-update-exposure">
          <h3 className="flex items-start gap-2 text-sm font-semibold"><ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t(`readerUpdate.exposure.${exposure}.title`)}</h3>
          <p className="text-sm">{t(`readerUpdate.exposure.${exposure}.body`)}</p>
        </section>
        {snapshot.workflowState === "paused" && <p role="note" className="text-sm">{t("readerUpdate.paused")}</p>}
        <BranchStates decision={decision} branch={update.branch} />
        <UpdateDetails plans={[...(decision.publishingTarget ? [{ branch: decision.publishingTarget.branch, plan: decision.publishingTarget, legacyPassword: decision.publishingTarget.workflow.settings.legacyPasswordSecret !== undefined }] : []), ...(decision.currentNeeded ? [{ branch: update.branch, plan: decision, legacyPassword: decision.workflow.settings.legacyPasswordSecret !== undefined }] : [])]} />
        {(decision.customized || decision.publishingTarget?.customized) && (
          <section className="space-y-2 rounded-md border border-amber-600/50 p-3 text-sm" data-testid="reader-update-customized">
            <h4 className="font-medium">{t("readerUpdate.customized.title")}</h4>
            <p>{t("readerUpdate.customized.body")}</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs" tabIndex={0} aria-label={t("readerUpdate.customized.title")}>{[...(decision.publishingTarget?.customized ? decision.publishingTarget.workflow.customizations : []), ...(decision.customized ? decision.workflow.customizations : [])].join("\n")}</pre>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={replaceEdits} onChange={(event) => setReplaceEdits(event.target.checked)} /><span className="font-medium">{t("readerUpdate.customized.confirm")}</span></label>
          </section>
        )}
        <div className="space-y-1 text-sm">
          <p>{deliveryLine(t, decision, update.branch)}</p>
          {!decision.publishesFromBranch && (decision.publishing?.state === "unknown" || decision.publishing?.state === "unreadable") && <p className="font-medium">{t("readerUpdate.delivery.otherBranch", { branch: update.branch, publishing: decision.publishing.branch })}</p>}
        </div>
        {remote.pagesOn === true && exposure === "password-old-reader" && <TurnPagesOff onAsk={() => setPagesOffAsked(true)} />}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={busy || (needsReplace && !replaceEdits)} aria-describedby={needsReplace && !replaceEdits ? `${titleId}-needed` : undefined} onClick={() => void doUpdate()}>
            {busy ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />}{busy ? t("readerUpdate.updating") : t("readerUpdate.update")}
          </Button>
          {needsReplace && !replaceEdits && <span id={`${titleId}-needed`} className="text-xs text-muted-foreground">{t("readerUpdate.customized.needed")}</span>}
        </div>
      </div>
    );
  } else if (decision.kind === "on-device") {
    body = <OnDeviceBody decision={decision} lastAuto={lastAuto} branch={update.branch} syncing={update.syncing} onSync={() => void doSync()} pagesOn={remote.pagesOn === true} onTurnOff={() => setPagesOffAsked(true)} workflowPaused={snapshot.workflowState === "paused"} />;
  } else {
    const message = decision.kind === "current"
      ? t(decision.remote === "unchecked" ? "readerUpdate.currentUnchecked" : decision.version ? "readerUpdate.current" : "readerUpdate.currentNoVersion", { version: decision.version ?? "" })
      : decision.kind === "elsewhere" ? t("readerUpdate.elsewhere", { dir: decision.readerDir })
      : decision.kind === "not-published" ? t("readerUpdate.notPublished")
      : decision.kind === "no-working-copy" ? t("readerUpdate.noWorkingCopy")
      : decision.kind === "local-only" ? t("readerUpdate.localOnly")
      : t("readerUpdate.unreadable");
    body = (
      <div className="space-y-3">
        <p role="status" className="flex items-start gap-2">{decision.kind === "current" && <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}<span>{message}</span></p>
        {decision.kind === "current" && <BranchStates decision={decision} branch={update.branch} />}
      </div>
    );
  }

  const failureText = (failure: ReaderUpdateFailure | null) => failure ? (failure.kind === "refused-customized" ? t("readerUpdate.failure.customized")
    : failure.kind === "changed" ? t("readerUpdate.failure.changed")
    : failure.kind === "conflict" ? t("readerUpdate.failure.conflict")
    : failure.kind === "github" ? (failure.failure.kind === "permission" && failure.failure.permissions.includes("workflows") ? t("readerUpdate.failure.permission") : (() => { const line = describeReaderFailure(failure.failure, access.tokenKind); return `${t("readerUpdate.failure.other")} ${t(line.key, line.params)}`; })())
    : t("readerUpdate.failure.other")) : null;
  const updateFailure = failureText(update.failure);
  const syncFailure = failureText(update.syncFailure);

  return (
    <Card id="reader-update-card" tabIndex={-1} aria-labelledby={titleId} data-testid="reader-update-card" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <CardHeader>
        <CardTitle id={titleId} className="flex items-center gap-2"><RefreshCw aria-hidden="true" className="h-4 w-4" />{t("readerUpdate.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {body}
        {snapshot.runFailure && <RunFailureNotice failure={snapshot.runFailure} book={book} repository={snapshot.repository} />}
        {updateFailure && <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 p-3 text-destructive"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{updateFailure}</p>}
        {syncFailure && <p role="alert" data-testid="reader-sync-failure" className="flex items-start gap-2 rounded-md border border-destructive/50 p-3 text-destructive"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /><span><strong>{t("readerUpdate.onDevice.notSent")}</strong> {syncFailure}</span></p>}
        {access.outcome?.kind === "disable-pages" && <p role="status" data-testid="reader-pages-off-result" className="rounded-md border border-primary/40 bg-primary/5 p-3 font-medium">{access.outcome.result.ok ? t("readerUpdate.pagesOff.done") : t("readerUpdate.pagesOff.failed")}</p>}
        {update.outcome && (
          <div role="status" className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3" data-testid="reader-update-outcome">
            {(update.outcome.published || update.outcome.branches.some((entry) => entry.status === "local")) && (
              <p className="flex items-start gap-2 font-medium"><CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{update.outcome.published ? t("readerUpdate.result.published", { branch: update.outcome.publishedBranch ?? update.branch, sha: update.outcome.commitSha.slice(0, 7) }) : t("readerUpdate.result.local")}</p>
            )}
            <ul className="space-y-1 text-sm" data-testid="reader-update-branches">
              {update.outcome.branches.map((entry) => (
                <li key={entry.branch} data-branch={entry.role} data-status={entry.status}>{t(`readerUpdate.branchResult.${entry.status}`, { branch: entry.branch, sha: (entry.commitSha ?? "").slice(0, 7), message: entry.githubMessage ?? "" })}</li>
              ))}
            </ul>
            {update.outcome.pullRequestOffer && !update.pullRequest && (
              <div className="space-y-2" data-testid="reader-update-pr-offer">
                <p className="text-sm">{t("readerUpdate.pullRequest.offer", { branch: update.outcome.pullRequestOffer.base })}</p>
                <Button type="button" size="sm" variant="outline" disabled={update.openingPullRequest} onClick={() => void update.openPullRequest(t("readerUpdate.pullRequest.body"))}>
                  {update.openingPullRequest ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}{update.openingPullRequest ? t("readerUpdate.pullRequest.opening") : t("readerUpdate.pullRequest.open")}
                </Button>
              </div>
            )}
            {update.pullRequest && (
              <p className="text-sm" data-testid="reader-update-pr-done">
                {t("readerUpdate.pullRequest.done", { branch: update.outcome.pullRequestOffer?.base ?? "" })}{" "}
                <a className="font-medium underline underline-offset-2" href={update.pullRequest.url} target="_blank" rel="noopener noreferrer">{t("readerUpdate.pullRequest.link", { number: update.pullRequest.number })}<ExternalLink aria-hidden="true" className="ml-1 inline h-3 w-3" /><span className="sr-only"> {t("readerAccess.opensNewTab")}</span></a>
              </p>
            )}
            {update.pullRequestFailed && <p role="alert" className="text-sm text-destructive">{t("readerUpdate.pullRequest.failed")}</p>}
            {update.outcome.published && !trackedHere && (
              <p className="text-xs text-muted-foreground">{t("readerUpdate.run.label")}: {t("readerUpdate.run.waiting")}</p>
            )}
          </div>
        )}
        {trackedHere && tracked && (
          <PublicationRun owner={book.owner} repo={book.repo} tracked={tracked} live={access.publication.live} going={access.publication.going} onRefresh={() => void access.publication.refreshNow()}
            failure={snapshot.runFailure && snapshot.runFailure.runId === tracked.runId ? snapshot.runFailure : null}
            outside={siteUrl ? { result: access.outside.result, running: access.outside.running } : null}
            onCheckOutside={siteUrl ? () => void access.outside.check() : undefined} />
        )}
        {siteUrl && (publishedRunDone || (decision?.kind === "current" && !update.outcome) || (remote.pagesOn === true && ((decision?.kind === "update" || decision?.kind === "on-device") && decision.exposure === "password-old-reader"))) && <OutsideCheck siteUrl={siteUrl} />}
        <Dialog open={pagesOffAsked} onOpenChange={setPagesOffAsked}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("readerUpdate.pagesOff.title")}</DialogTitle>
              <DialogDescription>{t("readerUpdate.pagesOff.body")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPagesOffAsked(false)}>{t("readerAccess.cancel")}</Button>
              <Button type="button" variant="destructive" onClick={() => { setPagesOffAsked(false); void access.disablePages({ deleteSecrets: false, forgetStored: false }); }}>{t("readerUpdate.pagesOff.confirm")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button type="button" size="sm" variant="ghost" disabled={update.checking || busy} onClick={() => void update.check()}>{update.checking ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />}{t("readerUpdate.recheck")}</Button>
      </CardContent>
    </Card>
  );
}
