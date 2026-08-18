import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitCommit, GitPullRequest, Loader2, RefreshCcw, RotateCcw, Trash2, UploadCloud, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import type { BookEntry, AppSettings } from "@/types/settings";
import { resolveBookToken } from "@/types/settings";
import { addLocalRepoLog, buildLocalBookStructure, effectiveRemoteStatus, type LocalRepoLogEntry, type LocalRepoLogKind, type LocalRepositoryFile, type LocalRepositoryMeta, type LocalRepositoryRecovery, type LocalRepoStatus } from "@/repository/localRepository";
import { commitLocalChanges, ensureLocalBookStructure, fetchRemoteStatus, overwriteRemoteWithLocal, pullRemoteChanges, pushLocalCommits, recloneLocalWorkingCopy, removeLocalWorkingCopy, restoreLocalFilesToBase, restoreRepositoryRecovery, syncFullRepository, checkRepositoryTokenHealth } from "@/repository/repositoryService";
import { useBooksStore } from "@/store/booksStore";
import { useAuthStore } from "@/store/authStore";
import { accountIdentity } from "@/auth/accountIdentity";
import { createMaintenanceBackupBundle, lookupRepositoryMaintenanceTarget, RepositoryMaintenanceError, type BackupReceipt, type RepositoryMaintenanceSnapshot } from "@/repository/repositoryMaintenance";
import { repositoryErrorDescription } from "@/repository/repositoryError";
import { readTokenHealth, tokenExpirationWarning, type TokenHealth } from "@/repository/tokenHealth";

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const LOG_FILTERS: Array<"all" | LocalRepoLogKind> = ["all", "clone", "fetch", "pull", "commit", "push", "backup", "reset", "error"];

function logKindLabel(t: ReturnType<typeof useTranslation>["t"], kind: LocalRepoLogKind): string {
  return t(`repoStatus.logKinds.${kind}`, { defaultValue: kind });
}

function logTone(kind: LocalRepoLogKind): string {
  if (kind === "error") return "border-destructive/40 bg-destructive/10 text-destructive";
  if (kind === "push" || kind === "commit") return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (kind === "pull" || kind === "fetch" || kind === "clone") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  return "border-muted bg-muted/40 text-muted-foreground";
}

export function RepositoryStatusDialog({ open, onOpenChange, book, branch, settings }: { open: boolean; onOpenChange: (open: boolean) => void; book?: BookEntry; branch?: string; settings: AppSettings }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const setStructure = useBooksStore((s) => s.setStructure);
  const clearBook = useBooksStore((s) => s.clearBook);
  const setCloneProgress = useBooksStore((s) => s.setCloneProgress);
  const cloneProgress = useBooksStore((s) => (book ? s.cloneProgress[book.id] : undefined));
  const user = useAuthStore((s) => s.user);
  const currentAccountIdentity = accountIdentity(user);
  const [status, setStatus] = useState<LocalRepoStatus | null>(null);
  const [repoMeta, setRepoMeta] = useState<LocalRepositoryMeta | null>(null);
  const [dirtyFiles, setDirtyFiles] = useState<LocalRepositoryFile[]>([]);
  const [ahead, setAhead] = useState(0);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number }>({});
  const [logs, setLogs] = useState<LocalRepoLogEntry[]>([]);
  const [recoveries, setRecoveries] = useState<LocalRepositoryRecovery[]>([]);
  const [maintenance, setMaintenance] = useState<RepositoryMaintenanceSnapshot | null>(null);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [backupReceipt, setBackupReceipt] = useState<BackupReceipt | null>(null);
  const [removeConfirmation, setRemoveConfirmation] = useState("");
  const [logFilter, setLogFilter] = useState<"all" | LocalRepoLogKind>("all");
  const [message, setMessage] = useState("");
  const [selectedDraftPaths, setSelectedDraftPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [tokenHealth, setTokenHealth] = useState<TokenHealth | null>(null);
  const token = book ? resolveBookToken(book, settings) : "";
  const disabled = !book || !!busy;
  const operationalReady = maintenance?.lifecycle === "complete";
  const networkDisabled = !book || !token || !!busy || !navigator.onLine || !operationalReady;
  const maintenanceNetworkDisabled = !book || !token || !!busy || !navigator.onLine;
  const storageHigh = Boolean(storage.usage && storage.quota && storage.usage / storage.quota > 0.8);
  const draftDirtyFiles = useMemo(() => dirtyFiles.filter((file) => file.path.startsWith("drafts/")), [dirtyFiles]);
  const remoteStatus = repoMeta ? effectiveRemoteStatus(repoMeta) : null;

  const defaultMessage = useMemo(() => {
    if (dirtyFiles.length === 1) return t("repoStatus.defaultCommitSingle", { path: dirtyFiles[0].path });
    return dirtyFiles.length ? t("repoStatus.defaultCommitMany", { count: dirtyFiles.length }) : "";
  }, [dirtyFiles, t]);

  const visibleLogs = useMemo(() => logFilter === "all" ? logs : logs.filter((log) => log.kind === logFilter), [logFilter, logs]);

  useEffect(() => {
    const available = new Set(draftDirtyFiles.map((file) => file.path));
    setSelectedDraftPaths((current) => current.filter((path) => available.has(path)));
  }, [draftDirtyFiles]);

  async function currentRepo() {
    if (!book || !branch || !currentAccountIdentity) return null;
    return (await lookupRepositoryMaintenanceTarget({ bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentAccountIdentity })).repository;
  }

  async function exactTarget() {
    const repo = await currentRepo();
    if (!book || !repo) throw new Error(t("repoStatus.notCloned"));
    if (!currentAccountIdentity) throw new Error(t("repoStatus.notCloned"));
    return { bookId: book.id, owner: repo.owner, repo: repo.repo, branch: repo.branch, repoId: repo.id, accountIdentity: currentAccountIdentity };
  }

  async function refresh() {
    if (!book || !branch || !currentAccountIdentity) { setMaintenance(null); setRepoMeta(null); setStatus(null); setDirtyFiles([]); setAhead(0); setRecoveries([]); return; }
    try {
      const snapshot = await lookupRepositoryMaintenanceTarget({ bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentAccountIdentity });
       setMaintenance(snapshot);
      setMaintenanceError(null);
       setStatus(snapshot.repository ? snapshot.status : null);
       setRepoMeta(snapshot.repository);
      setDirtyFiles(snapshot.dirtyFiles);
      setAhead(snapshot.unpushedCommits.length);
      setLogs(snapshot.logs);
      setRecoveries(snapshot.recoveries);
      const dirty = snapshot.dirtyFiles;
      if (!message && dirty.length) setMessage(dirty.length === 1 ? t("repoStatus.defaultCommitSingle", { path: dirty[0].path }) : t("repoStatus.defaultCommitMany", { count: dirty.length }));
    } catch (error) {
      setMaintenance(null);
      setRepoMeta(null);
      setMaintenanceError(maintenanceErrorText(error));
    }
    setStorage(await navigator.storage?.estimate?.().catch(() => ({})) ?? {});
  }

  function maintenanceErrorText(error: unknown): string {
    return error instanceof RepositoryMaintenanceError
      ? t(`repoStatus.maintenanceErrors.${error.code}`)
      : t("repoStatus.maintenanceErrors.UNKNOWN");
  }

  async function refreshBookStructure() {
    if (!book) return;
    const repo = await currentRepo().catch(() => null);
    if (!repo) return;
    setStructure(book.id, await buildLocalBookStructure(repo));
  }

  useEffect(() => { if (open) void refresh(); }, [open, book?.id, branch]);
  useEffect(() => {
    let cancelled = false;
    setTokenHealth(null);
    if (open && token && currentAccountIdentity && book && branch) {
      void readTokenHealth({ accountIdentity: currentAccountIdentity, token, owner: book.owner, repo: book.repo, branch }).then((health) => { if (!cancelled) setTokenHealth(health); });
    }
    return () => { cancelled = true; };
  }, [open, token, currentAccountIdentity, book?.owner, book?.repo, branch]);

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label);
    try {
      const result = await fn();
      toast({ title: result });
      await refreshBookStructure();
      await refresh();
    } catch (err) {
      if (book) {
        const repo = await currentRepo().catch(() => null);
        if (repo) await addLocalRepoLog(repo.id, "error", `${label}: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
      }
        toast({ title: t("repoStatus.actionFailed"), description: repositoryErrorDescription(err, t), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function exportBackup() {
    if (!book) return;
    setBusy("backup");
    try {
      const snapshot = maintenance ?? (book && branch && currentAccountIdentity ? await lookupRepositoryMaintenanceTarget({ bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentAccountIdentity }) : null);
      if (!snapshot) throw new RepositoryMaintenanceError("NOT_FOUND");
      const { blob, receipt } = await createMaintenanceBackupBundle(snapshot.target);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${book.owner}-${book.repo}-working-copy.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBackupReceipt(receipt);
      toast({ title: t("repoStatus.backupDone") });
    } catch (err) {
      toast({ title: t("repoStatus.actionFailed"), description: maintenanceErrorText(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function removeLocal() {
    if (!book || !branch || !maintenance || !currentAccountIdentity) return;
    setBusy("remove-local");
    try {
      const result = await removeLocalWorkingCopy({ bookId: book.id, owner: book.owner, repo: book.repo, branch, repoId: maintenance.target.repoId, accountIdentity: currentAccountIdentity, backupReceiptId: backupReceipt?.receiptId ?? "", confirmation: removeConfirmation });
      clearBook(book.id);
      toast({ title: t("repoStatus.removeLocalDone"), description: t("repoStatus.removeLocalResult", result) });
      setRemoveConfirmation("");
      await refresh();
    } catch (err) {
      toast({ title: t("repoStatus.actionFailed"), description: maintenanceErrorText(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function recloneLocal() {
    if (!book || !token) return;
    setBusy("reclone");
    try {
      const current = await currentRepo().catch(() => null);
      if (!currentAccountIdentity) throw new Error(t("repoStatus.notCloned"));
      const result = await recloneLocalWorkingCopy({ bookId: book.id, book, token, accountIdentity: currentAccountIdentity, branch: current?.branch, onProgress: (p) => setCloneProgress(book.id, p) });
      setStructure(book.id, result.structure);
      toast({ title: t("repoStatus.recloneDone") });
      await refresh();
    } catch (err) {
      toast({ title: t("repoStatus.actionFailed"), description: maintenanceErrorText(err), variant: "destructive" });
    } finally {
      setCloneProgress(book.id, undefined);
      setBusy(null);
    }
  }

  async function restoreRecovery(recovery: LocalRepositoryRecovery) {
    if (!book || !branch) return;
    if (!window.confirm(t("repoStatus.restoreRecoveryConfirm", { date: new Date(recovery.createdAt).toLocaleString() }))) return;
    setBusy(`recovery-${recovery.id}`);
    try {
      if (!currentAccountIdentity) throw new Error(t("repoStatus.notCloned"));
      const result = await restoreRepositoryRecovery({ bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentAccountIdentity, recoveryId: recovery.id });
      setStructure(book.id, result.structure);
      toast({ title: t("repoStatus.restoreRecoveryDone") });
      await refresh();
    } catch (err) {
      toast({ title: t("repoStatus.actionFailed"), description: maintenanceErrorText(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] !w-[calc(100vw-1rem)] !max-w-2xl overflow-x-hidden overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>{t("repoStatus.title")}</DialogTitle>
        </DialogHeader>
        {!book ? <p className="text-sm text-muted-foreground">{t("repoStatus.noBook")}</p> : (
          <div className="min-w-0 space-y-4">
            <div className="rounded-xl border bg-muted/20 p-3 text-sm">
              <p className="break-all font-medium">{book.owner}/{book.repo}</p>
               <p className="text-xs text-muted-foreground">{status ? t("repoStatus.summary", { dirty: status.dirty, ahead }) : t("repoStatus.notCloned")}</p>
               {repoMeta && <p className="mt-1 text-xs text-muted-foreground">{t(remoteStatus === "changed" ? "repoStatus.behind" : remoteStatus === "checking" ? "repoStatus.checking" : remoteStatus === "unavailable" || remoteStatus === "unverified" ? (repoMeta.lastKnownChanged ? "repoStatus.staleChanged" : "repoStatus.unverified") : "repoStatus.clean")}</p>}
              {maintenance?.lifecycle && <p className="mt-1 text-xs font-medium">{t("repoStatus.lifecycle", { status: t(`repoStatus.lifecycleStates.${maintenance.lifecycle}`) })}</p>}
              {maintenance && <p className="mt-1 text-xs text-muted-foreground">{t("repoStatus.maintenanceCounts", { modified: maintenance.status.modified, new: maintenance.status.new, deleted: maintenance.status.deleted, commits: maintenance.unpushedCommits.length, recoveries: maintenance.recoveries.length, rewrites: maintenance.rewriteOperationCount })}</p>}
              {maintenance?.legacyCopies.length ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t("repoStatus.legacyCopies", { count: maintenance.legacyCopies.length })}</p> : null}
              {maintenanceError && <p className="mt-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert">{maintenanceError}</p>}
              {cloneProgress && (
                <div className="mt-3 space-y-1">
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary transition-all" style={{ width: `${cloneProgress.total ? Math.round((cloneProgress.done / cloneProgress.total) * 100) : 0}%` }} />
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{t("repoStatus.cloneProgress", { done: cloneProgress.done, total: cloneProgress.total })} {cloneProgress.path ?? ""}</p>
                </div>
              )}
              {storage.usage && (
                <p className={storageHigh ? "mt-2 text-xs font-medium text-amber-600 dark:text-amber-300" : "mt-2 text-xs text-muted-foreground"}>{t("repoStatus.storage", { usage: formatBytes(storage.usage), quota: storage.quota ? formatBytes(storage.quota) : "n/d" })}{storageHigh ? ` · ${t("repoStatus.storageHigh")}` : ""}</p>
              )}
            </div>
            <div className="rounded-xl border p-3 text-sm">
              <p className="font-medium">{t("repoStatus.tokenHealth")}</p>
              {tokenHealth && <p className="text-xs text-muted-foreground">{t(`repoStatus.tokenPermission.${tokenHealth.permissionStatus}`)}</p>}
              <p className="text-xs text-muted-foreground">{tokenHealth?.expiresAt ? t(`repoStatus.expiration.${tokenExpirationWarning(tokenHealth.expiresAt)}`, { date: new Date(tokenHealth.expiresAt).toLocaleDateString() }) : t("repoStatus.expiration.unknown")}</p>
              <Button className="mt-2" size="sm" variant="outline" disabled={maintenanceNetworkDisabled || !token || !branch} onClick={() => void run("token-health", async () => {
                if (!book || !branch || !currentAccountIdentity) throw new Error(t("repoStatus.notCloned"));
                const health = await checkRepositoryTokenHealth({ owner: book.owner, repo: book.repo, branch, accountIdentity: currentAccountIdentity, token });
                setTokenHealth(health);
                return t("repoStatus.tokenHealthy");
              })}>{busy === "token-health" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1 h-4 w-4" />}{t("repoStatus.checkToken")}</Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Button variant="outline" className="sm:col-span-3" disabled={maintenanceNetworkDisabled} onClick={() => void run("recover-lifecycle", async () => {
                if (!book || !branch || !currentAccountIdentity) throw new Error(t("repoStatus.notCloned"));
                const result = await ensureLocalBookStructure({ bookId: book.id, book, token, accountIdentity: currentAccountIdentity, branch, onProgress: (p) => setCloneProgress(book.id, p) });
                setStructure(book.id, result.structure);
                return result.meta.cloneComplete ? t("repoStatus.remoteUpToDate") : t("repoStatus.incomplete");
              })}>{busy === "recover-lifecycle" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}{t("repoStatus.retryRecovery")}</Button>
              <Button className="sm:col-span-3" disabled={networkDisabled} onClick={() => void run("sync", async () => {
                 const result = await syncFullRepository({ ...await exactTarget(), token });
                return t("repoStatus.syncDone", { pulled: result.pulled, kept: result.keptLocal, committed: result.committed, pushed: result.pushed });
              })}>{busy === "sync" ? <RefreshCcw className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCcw className="mr-1 h-4 w-4" />}{t("repoStatus.sync")}</Button>
              <Button variant="outline" disabled={networkDisabled} onClick={() => void run("fetch", async () => {
                 const result = await fetchRemoteStatus({ ...await exactTarget(), token });
                return result.changed ? t("repoStatus.remoteChanged") : t("repoStatus.remoteUpToDate");
              })}>{busy === "fetch" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCcw className="mr-1 h-4 w-4" />}{t("repoStatus.fetch")}</Button>
              <Button variant="outline" disabled={networkDisabled} onClick={() => void run("pull", async () => {
                if ((dirtyFiles.length || ahead) && !window.confirm(t("repoStatus.pullRemoteWinsConfirm"))) return t("repoStatus.cancelled");
                 const target = await exactTarget();
                 const destructive = dirtyFiles.length > 0 || ahead > 0;
                 const result = await pullRemoteChanges({ ...target, token, ...(destructive ? { mode: "remote-wins" as const, confirmed: true } : {}) });
                return t("repoStatus.pullDone", { count: result.updated });
              })}>{busy === "pull" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <GitPullRequest className="mr-1 h-4 w-4" />}{t("repoStatus.pull")}</Button>
              <Button variant="outline" disabled={networkDisabled || ahead === 0} onClick={() => void run("push", async () => {
                if (!window.confirm(t("repoStatus.pushLocalWinsConfirm"))) return t("repoStatus.cancelled");
                 const result = await pushLocalCommits({ ...await exactTarget(), token });
                return t("repoStatus.pushDone", { count: result.files });
              })}>{busy === "push" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-1 h-4 w-4" />}{t("repoStatus.push")}</Button>
            </div>
            <Button variant="outline" className="w-full" disabled={disabled} onClick={() => void exportBackup()}>{busy === "backup" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}{t("repoStatus.exportBackup")}</Button>
            {recoveries.length > 0 && (
              <div className="space-y-2 rounded-xl border p-3">
                <p className="text-sm font-medium">{t("repoStatus.recoverySnapshots")}</p>
                {recoveries.map((recovery) => (
                  <div key={recovery.id} className="flex flex-col gap-2 rounded border p-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0"><p>{new Date(recovery.createdAt).toLocaleString()}</p><p className="break-words text-muted-foreground">{recovery.reason}</p></div>
                    <Button size="sm" variant="outline" disabled={!!busy || !operationalReady} onClick={() => void restoreRecovery(recovery)}>{busy === `recovery-${recovery.id}` ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}{t("repoStatus.restoreRecovery")}</Button>
                  </div>
                ))}
              </div>
            )}
             {remoteStatus === "changed" && <div className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
              <p className="text-sm font-medium">{t("repoStatus.repairTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("repoStatus.repairDescription")}</p>
              <Button variant="outline" className="w-full" disabled={networkDisabled} onClick={() => void run("resync-local", async () => {
                if (!window.confirm(t("repoStatus.resyncLocalConfirm"))) return t("repoStatus.cancelled");
                 const result = await overwriteRemoteWithLocal({ ...await exactTarget(), token, confirmed: true });
                return t("repoStatus.resyncLocalDone", { count: result.files });
              })}>{busy === "resync-local" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1 h-4 w-4" />}{t("repoStatus.resyncLocal")}</Button>
             </div>}
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="outline" disabled={maintenanceNetworkDisabled} onClick={() => void recloneLocal()}>{busy === "reclone" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}{t("repoStatus.reclone")}</Button>
              <Button variant="destructive" disabled={disabled || !maintenance || (!maintenance.removalPending && !backupReceipt) || removeConfirmation !== `REMOVE ${book.owner}/${book.repo}`} onClick={() => void removeLocal()}>{busy === "remove-local" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}{maintenance?.removalPending ? t("repoStatus.resumeRemoval") : t("repoStatus.removePermanently")}</Button>
            </div>
            {maintenance && (maintenance.repository || maintenance.removalPending) && <div className="space-y-2 rounded-xl border border-destructive/30 p-3 text-xs">
              <p className="font-medium">{t("repoStatus.removeSummary", { modified: maintenance.status.modified, new: maintenance.status.new, deleted: maintenance.status.deleted, commits: maintenance.unpushedCommits.length, recoveries: maintenance.recoveries.length, rewrites: maintenance.rewriteOperationCount, lifecycle: t(`repoStatus.lifecycleStates.${maintenance.lifecycle}`) })}</p>
              <p className="text-muted-foreground">{t("repoStatus.recoveryPreserved")}</p>
              {!backupReceipt && !maintenance.removalPending && <p className="font-medium text-amber-700 dark:text-amber-300">{t("repoStatus.backupRequired")}</p>}
              {maintenance.removalPending && <p className="font-medium text-amber-700 dark:text-amber-300">{t("repoStatus.removalPending")}</p>}
              <Input value={removeConfirmation} onChange={(event) => setRemoveConfirmation(event.target.value)} placeholder={t("repoStatus.removeConfirmation", { value: `REMOVE ${book.owner}/${book.repo}` })} disabled={disabled} />
            </div>}
            <div className="space-y-2 rounded-xl border p-3">
              <p className="text-sm font-medium">{t("repoStatus.localChanges")}</p>
              {dirtyFiles.length ? (
                <div className="space-y-2">
                  {draftDirtyFiles.length > 0 && (
                    <div className="space-y-2 rounded-lg border bg-muted/20 p-2 text-xs">
                      <p className="text-muted-foreground">{t("repoStatus.draftRestoreHelp")}</p>
                      <p className="text-muted-foreground">{t("repoStatus.draftRestoreSummary", { selected: selectedDraftPaths.length, kept: Math.max(draftDirtyFiles.length - selectedDraftPaths.length, 0) })}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" size="sm" variant="outline" disabled={disabled || draftDirtyFiles.length === 0} onClick={() => setSelectedDraftPaths(draftDirtyFiles.map((file) => file.path))}>{t("repoStatus.selectAllDrafts")}</Button>
                        <Button type="button" size="sm" variant="outline" disabled={disabled || selectedDraftPaths.length === 0} onClick={() => setSelectedDraftPaths([])}>{t("repoStatus.clearDraftSelection")}</Button>
                        <Button type="button" size="sm" variant="outline" disabled={disabled || selectedDraftPaths.length === 0} onClick={() => void run("restore-drafts", async () => {
                          const repo = await currentRepo();
                          if (!repo) throw new Error(t("repoStatus.notCloned"));
                          if (!currentAccountIdentity || !book) throw new Error(t("repoStatus.notCloned"));
                          const result = await restoreLocalFilesToBase({ repoId: repo.id, bookId: book.id, owner: repo.owner, repo: repo.repo, branch: repo.branch, accountIdentity: currentAccountIdentity, paths: selectedDraftPaths, token: token || undefined });
                          setSelectedDraftPaths([]);
                          return t("repoStatus.restoreSelectedDraftsDone", { count: result.restored });
                        })}><RotateCcw className="mr-1 h-4 w-4" />{t("repoStatus.restoreSelectedDrafts")}</Button>
                      </div>
                    </div>
                  )}
                  <div className="max-h-56 min-w-0 space-y-1 overflow-y-auto text-xs">
                    {dirtyFiles.map((file) => {
                      const isDraft = file.path.startsWith("drafts/");
                      const checked = selectedDraftPaths.includes(file.path);
                      return (
                        <label key={file.path} className="flex min-w-0 items-start gap-2 rounded border px-2 py-1.5">
                          {isDraft ? (
                            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={checked} onChange={(event) => setSelectedDraftPaths((current) => event.target.checked ? [...current, file.path] : current.filter((path) => path !== file.path))} aria-label={t("repoStatus.selectDraftToRestore", { path: file.path })} />
                          ) : (
                            <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                          )}
                          <span className="w-16 shrink-0 uppercase text-muted-foreground">{file.status}</span>
                          <span className="min-w-0 flex-1 break-all font-mono">{file.path}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : <p className="text-sm text-muted-foreground">{t("repoStatus.noLocalChanges")}</p>}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input value={message || defaultMessage} onChange={(event) => setMessage(event.target.value)} placeholder={t("repoStatus.commitMessage")} disabled={disabled || dirtyFiles.length === 0} />
                <Button disabled={disabled || dirtyFiles.length === 0} onClick={() => void run("commit", async () => {
                   await commitLocalChanges(await exactTarget(), message || defaultMessage);
                  setMessage("");
                  return t("repoStatus.commitDone");
                })}>{busy === "commit" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <GitCommit className="mr-1 h-4 w-4" />}{t("repoStatus.commit")}</Button>
              </div>
            </div>
            <div className="space-y-2 rounded-xl border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">{t("repoStatus.history")}</p>
                <div className="flex flex-wrap gap-1">
                  {LOG_FILTERS.map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      onClick={() => setLogFilter(filter)}
                      className={logFilter === filter ? "rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium uppercase text-primary-foreground" : "rounded-full border px-2 py-0.5 text-[10px] uppercase text-muted-foreground hover:bg-muted"}
                    >
                      {filter === "all" ? t("repoStatus.logAll") : logKindLabel(t, filter)}
                    </button>
                  ))}
                </div>
              </div>
              {visibleLogs.length ? (
                <div className="max-h-48 space-y-1 overflow-auto text-xs">
                  {visibleLogs.map((log) => (
                    <div key={log.id} className="rounded border px-2 py-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${logTone(log.kind)}`}>{logKindLabel(t, log.kind)}</span>
                        <span className="text-[10px] text-muted-foreground">{new Date(log.createdAt).toLocaleString()}</span>
                      </div>
                      <p className="break-words text-xs">{log.message}</p>
                    </div>
                  ))}
                </div>
              ) : <p className="text-sm text-muted-foreground">{t("repoStatus.noHistory")}</p>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
