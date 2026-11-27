import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Lock, Power, RefreshCw, ShieldAlert } from "lucide-react";
import "@/i18n/readerAccess";
import "@/i18n/readerRun";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import type { BookEntry } from "@/types/settings";
import { describeReaderFailure } from "@/readerAccess/messages";
import { LEGACY_READER_SECRET } from "@/readerAccess/contract";
import { reconcileReaderPasswords, type ReaderPasswordRow } from "@/readerAccess/model";
import { inspectReaderWorkflow } from "@/readerAccess/workflowPlan";
import { isReaderPasswordSlotName } from "narrarium-astro-reader/github-pages";
import { rowActivation } from "@/readerRun/publication";
import { PublicationRun } from "@/components/book/readerAccess/PublicationRun";
import { AddPasswordForm } from "@/components/book/readerAccess/AddPasswordForm";
import { RunFailureNotice } from "@/components/book/readerAccess/RunFailureNotice";
import { PasswordRow } from "@/components/book/readerAccess/PasswordRow";
import { ReaderResultNotice } from "@/components/book/readerAccess/ReaderResultNotice";
import { useReaderAccess, type ReaderAccess } from "@/components/book/readerAccess/useReaderAccess";

const RUN_STATE_KEY = { queued: "queued", running: "running", "action-required": "action-required", succeeded: "succeeded", failed: "failed", cancelled: "cancelled" } as const;

/**
 * «Reader access» of a GitHub book: whether GitHub Pages publishes the reader, who can open it (the passwords, which GitHub keeps as write-only secrets and
 * Narrarium keeps in the synced account data so that they can be shown again), and how the last publication went. Every change writes the secrets, then
 * the variable, then starts the workflow (see `readerAccess/operations`) and says what happened if a step fails.
 */
export function ReaderAccessCard({ book }: { book: BookEntry }) {
  return <ReaderAccessCardView book={book} access={useReaderAccess(book)} />;
}

/** The same card over an access that the caller holds, so that the card beside it (the update of the reader) reads and follows the same GitHub state. */
export function ReaderAccessCardView({ access, book }: { access: ReaderAccess; book: BookEntry }) {
  const { t } = useTranslation();
  const { snapshot, records } = access;
  const titleId = useId();
  const [removing, setRemoving] = useState<ReaderPasswordRow | null>(null);
  const [pagesOff, setPagesOff] = useState(false);
  const [deleteSecrets, setDeleteSecrets] = useState(false);
  const [forgetStored, setForgetStored] = useState(false);
  const lastAction = useRef<(() => void) | null>(null);

  const rows = reconcileReaderPasswords(records, snapshot.remote);
  const run = snapshot.runs?.[0];
  const tracked = access.publication.tracked;
  const pages = snapshot.pages;
  const busy = access.busy !== null;
  const workflow = snapshot.workflow ? inspectReaderWorkflow(snapshot.workflow.present ? snapshot.workflow.content ?? "" : null) : null;
  // Passwords can always be prepared. They protect the reader only when the published workflow reads them, so until then they are «prepared», never «protecting»,
  // and the card says so (see `readerPublication`). The branch named is the one the workflow publishes from: the repository's default branch.
  const publishingBranch = snapshot.repository?.defaultBranch ?? "main";
  const workflowReads = workflow === "current" || workflow === "customized" || workflow === "previous";
  const addNote = snapshot.loadedAt === null ? undefined : workflow === "missing" ? t("readerAccess.workflow.addNoteMissing", { branch: publishingBranch }) : workflow === "outdated" ? t("readerAccess.workflow.addNoteOutdated", { branch: publishingBranch }) : undefined;
  const publication = access.readerState;
  const protectionKey = publication === "protecting" ? "protected" : publication === "public" ? "public" : publication === "unknown" ? "unknown" : publication;
  const goToUpdate = () => {
    const target = document.getElementById("reader-update-card");
    target?.scrollIntoView?.({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    target?.focus({ preventScroll: true });
  };
  // The workflow of version 3 passes the 24 slots to the build and no other name: a password kept under another name would not be read by it.
  const outsideSlots = rows.filter((row) => row.secretName !== LEGACY_READER_SECRET && !isReaderPasswordSlotName(row.secretName) && row.state !== "dangling");
  const protectingElsewhere = (row: ReaderPasswordRow) => rows.some((other) => other.secretName !== row.secretName && (other.state === "active" || other.state === "legacy" || other.state === "unknown-value"));
  const failureLines = (Object.entries(snapshot.failures) as Array<[string, NonNullable<(typeof snapshot.failures)[keyof typeof snapshot.failures]>]>)
    .map(([part, failure]) => ({ part, text: describeReaderFailure(failure, access.tokenKind) }));

  const act = (action: () => void) => () => { lastAction.current = action; action(); };

  return (
    <Card aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId} className="flex items-center gap-2"><Lock aria-hidden="true" className="h-4 w-4" />{t("readerAccess.title")}</CardTitle>
        <CardDescription>{t("readerAccess.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        {!access.token && <p role="alert" className="text-destructive">{t("readerAccess.noToken")}</p>}

        <section aria-labelledby={`${titleId}-pages`} className="space-y-2">
          <h3 id={`${titleId}-pages`} className="text-sm font-medium">{t("readerAccess.pages.title")}</h3>
          <div role="status" aria-live="polite" className="space-y-1">
            {access.loading && snapshot.loadedAt === null && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("readerAccess.loading")}</p>}
            {pages?.status === "enabled" && <p>{t("readerAccess.pages.on")} <a className="inline-flex items-center gap-1 font-medium underline underline-offset-2" href={pages.url} target="_blank" rel="noopener noreferrer">{pages.url}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /><span className="sr-only"> {t("readerAccess.opensNewTab")}</span></a></p>}
            {pages?.status === "off" && <p>{t("readerAccess.pages.off")}</p>}
            {snapshot.repository?.private && pages?.status === "off" && <p className="text-xs text-muted-foreground">{t("readerAccess.pages.privateNote")}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {pages?.status === "off" && <Button type="button" size="sm" disabled={busy || !access.token} onClick={act(() => void access.enablePages())}>{access.busy === "enable-pages" ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Power aria-hidden="true" className="mr-1 h-4 w-4" />}{t("readerAccess.pages.turnOn")}</Button>}
            {pages?.status === "enabled" && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={act(() => void access.republish())}>{access.busy === "republish" ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />}{t("readerAccess.publishNow")}</Button>}
            {pages?.status === "enabled" && <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => { setDeleteSecrets(false); setForgetStored(false); setPagesOff(true); }}>{t("readerAccess.pages.turnOff")}</Button>}
            <Button type="button" size="sm" variant="ghost" disabled={access.loading || !access.token} onClick={() => void access.refresh()}>{access.loading ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />}{t("readerAccess.refresh")}</Button>
          </div>
        </section>

        {failureLines.length > 0 && (
          <ul role="alert" className="space-y-1 rounded-md border border-amber-600/50 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" data-testid="reader-read-failures">
            {failureLines.map((line) => <li key={line.part} className="flex items-start gap-2"><AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span><strong>{t(`readerAccess.part.${line.part}`)}:</strong> {t(line.text.key, line.text.params)}</span></li>)}
          </ul>
        )}

        {workflow === "outdated" && (
          <div className="space-y-2 rounded-md border p-2 text-xs" data-testid="reader-workflow-outdated">
            <p>{t("readerAccess.workflow.outdated", { branch: publishingBranch })}</p>
          </div>
        )}

        {workflow === "missing" && (
          <div className="space-y-2 rounded-md border p-2 text-xs" data-testid="reader-workflow-missing">
            <p>{t("readerAccess.workflow.missing", { branch: publishingBranch })}</p>
          </div>
        )}

        <section aria-labelledby={`${titleId}-pw`} className="space-y-3">
          <h3 id={`${titleId}-pw`} className="text-sm font-medium">{t("readerAccess.passwords.title")}</h3>
          <p role="status" className="text-xs text-muted-foreground" data-testid="reader-protection" data-publication={access.readerStateReady ? publication : "checking"}>{snapshot.loadedAt === null || !access.readerStateReady ? t("readerAccess.loading") : t(`readerAccess.protection.${protectionKey}`)}</p>
          {access.readerStateReady && publication === "prepared" && (
            <section aria-labelledby={`${titleId}-prepared`} className="space-y-2 rounded-md border border-amber-600/50 bg-amber-50 p-3 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" data-testid="reader-prepared">
              <h4 id={`${titleId}-prepared`} className="flex items-start gap-2 text-sm font-semibold"><ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("readerPrepared.title")}</h4>
              <p>{t("readerPrepared.public")}</p>
              {access.outside.result?.kind === "epub-exposed" && <p className="font-medium">{t("readerPrepared.outside.exposed", { status: access.outside.result.status })}</p>}
              {access.outside.result?.kind === "not-protected" && <p className="font-medium">{t("readerPrepared.outside.notProtected")}</p>}
              <p className="text-xs">{workflowReads ? t("readerPrepared.publishHelp") : t("readerPrepared.updateHelp")}</p>
              <div className="flex flex-wrap items-center gap-2">
                {workflowReads
                  ? <Button type="button" size="sm" disabled={busy} onClick={act(() => void access.republish())}><RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />{t("readerAccess.publishNow")}</Button>
                  : <Button type="button" size="sm" onClick={goToUpdate}><RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />{t("readerPrepared.update")}</Button>}
                {access.outside.siteUrl && <Button type="button" size="sm" variant="outline" disabled={access.outside.running} onClick={() => void access.outside.check()}>{access.outside.running ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}{t("readerRun.outside.check")}</Button>}
              </div>
            </section>
          )}
          {access.readerStateReady && publication === "protecting" && access.outside.result?.kind === "protected" && tracked?.state === "succeeded" && (
            <p role="status" className="flex items-start gap-2 text-sm font-medium" data-testid="reader-activated"><CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("readerPrepared.activated")}</p>
          )}
          {rows.length === 0 && snapshot.loadedAt !== null && <p className="text-muted-foreground">{t("readerAccess.passwords.none")}</p>}
          {rows.length > 0 && (
            <ul className="space-y-2" aria-label={t("readerAccess.passwords.listLabel")}>
              {rows.map((row) => <PasswordRow key={row.secretName} row={row} busy={busy} activation={access.readerStateReady ? rowActivation(row, publication) : null} onRemove={() => setRemoving(row)} onRetry={() => void access.resume(row.secretName)} />)}
            </ul>
          )}
          {outsideSlots.length > 0 && (
            <p role="note" className="rounded-md border border-amber-600/50 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" data-testid="reader-outside-slots">
              {t("readerAccess.outsideSlots", { names: outsideSlots.map((row) => row.secretName).join(", "), count: 24 })}
            </p>
          )}
          <AddPasswordForm busy={access.busy === "add"} note={addNote} onAdd={(input) => { lastAction.current = () => void access.add(input); return access.add(input); }} />
        </section>

        {snapshot.runFailure && <RunFailureNotice compact failure={snapshot.runFailure} book={book} repository={snapshot.repository} />}

        {tracked && tracked.trigger !== "push" ? (
          <PublicationRun owner={book.owner} repo={book.repo} tracked={tracked} live={access.publication.live} going={access.publication.going} onRefresh={() => void access.publication.refreshNow()}
            failure={snapshot.runFailure && snapshot.runFailure.runId === tracked.runId ? snapshot.runFailure : null}
            outside={access.outside.siteUrl && rows.length > 0 ? { result: access.outside.result, running: access.outside.running } : null}
            onCheckOutside={access.outside.siteUrl && rows.length > 0 ? () => void access.outside.check() : undefined} />
        ) : !tracked && run && (
          <p role="status" className="text-xs text-muted-foreground" data-testid="reader-run">
            {t("readerAccess.run.label")}: <strong>{t(`readerAccess.run.${RUN_STATE_KEY[run.state]}`)}</strong> · <LocalTime value={run.createdAt} /> · <a className="font-medium text-foreground underline underline-offset-2" href={run.url} target="_blank" rel="noopener noreferrer">{t("readerAccess.run.open")}<span className="sr-only"> {t("readerAccess.opensNewTab")}</span></a>
          </p>
        )}

        {access.outcome && <ReaderResultNotice result={access.outcome.text} busy={busy} onDismiss={access.dismissOutcome} onRetry={lastAction.current ?? undefined} />}
      </CardContent>

      <Dialog open={Boolean(removing)} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("readerAccess.removeDialog.title", { label: removing?.record?.label || removing?.secretName || "" })}</DialogTitle>
            <DialogDescription>{removing?.secretName === LEGACY_READER_SECRET ? t("readerAccess.removeDialog.legacy") : t("readerAccess.removeDialog.body")}</DialogDescription>
          </DialogHeader>
          {removing && !protectingElsewhere(removing) && <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 p-2 text-sm text-destructive"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("readerAccess.removeDialog.last")}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRemoving(null)}>{t("readerAccess.cancel")}</Button>
            <Button type="button" variant="destructive" onClick={() => { const target = removing; setRemoving(null); if (target) { lastAction.current = () => void access.remove(target.secretName); void access.remove(target.secretName); } }}>{t("readerAccess.removeDialog.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pagesOff} onOpenChange={setPagesOff}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("readerAccess.offDialog.title")}</DialogTitle>
            <DialogDescription>{t("readerAccess.offDialog.body")}</DialogDescription>
          </DialogHeader>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("readerAccess.offDialog.legend")}</legend>
            <label className="flex items-start gap-2 rounded-md border p-2 text-sm"><input type="radio" className="mt-1" name={`${titleId}-off`} checked={!deleteSecrets} onChange={() => { setDeleteSecrets(false); setForgetStored(false); }} /><span><strong>{t("readerAccess.offDialog.keep")}</strong><br /><span className="text-xs text-muted-foreground">{t("readerAccess.offDialog.keepHelp")}</span></span></label>
            <label className="flex items-start gap-2 rounded-md border p-2 text-sm"><input type="radio" className="mt-1" name={`${titleId}-off`} checked={deleteSecrets} onChange={() => setDeleteSecrets(true)} /><span><strong>{t("readerAccess.offDialog.delete")}</strong><br /><span className="text-xs text-muted-foreground">{t("readerAccess.offDialog.deleteHelp")}</span></span></label>
            {deleteSecrets && <label className="ml-6 flex items-start gap-2 rounded-md border border-destructive/50 p-2 text-sm"><input type="checkbox" className="mt-1" checked={forgetStored} onChange={(event) => setForgetStored(event.target.checked)} /><span><strong>{t("readerAccess.offDialog.forget")}</strong><br /><span className="text-xs text-muted-foreground">{t("readerAccess.offDialog.forgetHelp")}</span></span></label>}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPagesOff(false)}>{t("readerAccess.cancel")}</Button>
            <Button type="button" variant="destructive" onClick={() => { setPagesOff(false); const options = { deleteSecrets, forgetStored: deleteSecrets && forgetStored }; lastAction.current = () => void access.disablePages(options); void access.disablePages(options); }}>{t("readerAccess.offDialog.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
