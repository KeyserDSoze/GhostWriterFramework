import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitCommit, GitPullRequest, Loader2, RefreshCcw, RotateCcw, Trash2, UploadCloud, ShieldCheck } from "lucide-react";
import JSZip from "jszip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import type { BookEntry, AppSettings } from "@/types/settings";
import { resolveBookToken } from "@/types/settings";
import { addLocalRepoLog, buildLocalBookStructure, getLocalRepository, getLocalRepositoryByBook, listAllLocalFiles, listDirtyLocalFiles, listLocalRepoLogs, listUnpushedLocalCommits, localStatus, type LocalRepoLogEntry, type LocalRepoLogKind, type LocalRepositoryFile, type LocalRepoStatus } from "@/repository/localRepository";
import { commitLocalChanges, fetchRemoteStatus, overwriteRemoteWithLocal, pullRemoteChanges, pushLocalCommits, recloneLocalWorkingCopy, removeLocalWorkingCopy, syncFullRepository } from "@/repository/repositoryService";
import { useBooksStore } from "@/store/booksStore";

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
  const [status, setStatus] = useState<LocalRepoStatus | null>(null);
  const [dirtyFiles, setDirtyFiles] = useState<LocalRepositoryFile[]>([]);
  const [ahead, setAhead] = useState(0);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number }>({});
  const [logs, setLogs] = useState<LocalRepoLogEntry[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | LocalRepoLogKind>("all");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const token = book ? resolveBookToken(book, settings) : "";
  const disabled = !book || !!busy;
  const networkDisabled = !book || !token || !!busy;
  const storageHigh = Boolean(storage.usage && storage.quota && storage.usage / storage.quota > 0.8);

  const defaultMessage = useMemo(() => {
    if (dirtyFiles.length === 1) return `Update ${dirtyFiles[0].path}`;
    return dirtyFiles.length ? `Update ${dirtyFiles.length} files` : "";
  }, [dirtyFiles]);

  const visibleLogs = useMemo(() => logFilter === "all" ? logs : logs.filter((log) => log.kind === logFilter), [logFilter, logs]);

  async function currentRepo() {
    if (!book) return null;
    return branch ? getLocalRepository(book.owner, book.repo, branch) : getLocalRepositoryByBook(book.id);
  }

  async function refresh() {
    if (!book) { setStatus(null); setDirtyFiles([]); setAhead(0); return; }
    const repo = await currentRepo().catch(() => null);
    if (!repo) { setStatus(null); setDirtyFiles([]); setAhead(0); return; }
    const [nextStatus, dirty, commits, nextLogs] = await Promise.all([localStatus(repo.id), listDirtyLocalFiles(repo.id), listUnpushedLocalCommits(repo.id), listLocalRepoLogs(repo.id)]);
    setStatus(nextStatus);
    setDirtyFiles(dirty);
    setAhead(commits.length);
    setLogs(nextLogs);
    setStorage(await navigator.storage?.estimate?.().catch(() => ({})) ?? {});
    if (!message && dirty.length) setMessage(dirty.length === 1 ? `Update ${dirty[0].path}` : `Update ${dirty.length} files`);
  }

  async function refreshBookStructure() {
    if (!book) return;
    const repo = await currentRepo().catch(() => null);
    if (!repo) return;
    setStructure(book.id, await buildLocalBookStructure(repo));
  }

  useEffect(() => { if (open) void refresh(); }, [open, book?.id, branch]);

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
      toast({ title: t("repoStatus.actionFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function exportBackup() {
    if (!book) return;
    setBusy("backup");
    try {
      const repo = await currentRepo();
      if (!repo) throw new Error(t("repoStatus.notCloned"));
      const zip = new JSZip();
      const files = await listAllLocalFiles(repo.id);
      for (const file of files) {
        if (file.status === "deleted") continue;
        if (file.kind === "text") zip.file(file.path, file.text ?? "");
        else if (file.blob) zip.file(file.path, file.blob);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${book.owner}-${book.repo}-working-copy.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      await addLocalRepoLog(repo.id, "backup", `Exported backup ZIP (${files.length} files)`);
      toast({ title: t("repoStatus.backupDone") });
    } catch (err) {
      toast({ title: t("repoStatus.actionFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function removeLocal() {
    if (!book) return;
    if (!window.confirm(t("repoStatus.removeLocalConfirm"))) return;
    setBusy("remove-local");
    try {
      await removeLocalWorkingCopy(book.id);
      clearBook(book.id);
      toast({ title: t("repoStatus.removeLocalDone") });
      await refresh();
    } catch (err) {
      toast({ title: t("repoStatus.actionFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function recloneLocal() {
    if (!book || !token) return;
    if (!window.confirm(t("repoStatus.recloneConfirm"))) return;
    setBusy("reclone");
    try {
      const current = await currentRepo().catch(() => null);
      const result = await recloneLocalWorkingCopy({ bookId: book.id, book, token, branch: current?.branch, onProgress: (p) => setCloneProgress(book.id, p) });
      setStructure(book.id, result.structure);
      toast({ title: t("repoStatus.recloneDone") });
      await refresh();
    } catch (err) {
      toast({ title: t("repoStatus.actionFailed"), description: String(err), variant: "destructive" });
    } finally {
      setCloneProgress(book.id, undefined);
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("repoStatus.title")}</DialogTitle>
        </DialogHeader>
        {!book ? <p className="text-sm text-muted-foreground">{t("repoStatus.noBook")}</p> : (
          <div className="space-y-4">
            <div className="rounded-xl border bg-muted/20 p-3 text-sm">
              <p className="font-medium">{book.owner}/{book.repo}</p>
              <p className="text-xs text-muted-foreground">{status ? t("repoStatus.summary", { dirty: status.dirty, ahead }) : t("repoStatus.notCloned")}</p>
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
            <div className="grid gap-2 sm:grid-cols-3">
              <Button className="sm:col-span-3" disabled={networkDisabled} onClick={() => void run("sync", async () => {
                const result = await syncFullRepository({ bookId: book.id, token });
                return t("repoStatus.syncDone", { pulled: result.pulled, kept: result.keptLocal, committed: result.committed, pushed: result.pushed });
              })}>{busy === "sync" ? <RefreshCcw className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCcw className="mr-1 h-4 w-4" />}{t("repoStatus.sync")}</Button>
              <Button variant="outline" disabled={networkDisabled} onClick={() => void run("fetch", async () => {
                const result = await fetchRemoteStatus({ bookId: book.id, token });
                return result.changed ? t("repoStatus.remoteChanged") : t("repoStatus.remoteUpToDate");
              })}>{busy === "fetch" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCcw className="mr-1 h-4 w-4" />}{t("repoStatus.fetch")}</Button>
              <Button variant="outline" disabled={networkDisabled} onClick={() => void run("pull", async () => {
                if ((dirtyFiles.length || ahead) && !window.confirm(t("repoStatus.pullRemoteWinsConfirm"))) return t("repoStatus.cancelled");
                const result = await pullRemoteChanges({ bookId: book.id, token });
                return t("repoStatus.pullDone", { count: result.updated });
              })}>{busy === "pull" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <GitPullRequest className="mr-1 h-4 w-4" />}{t("repoStatus.pull")}</Button>
              <Button variant="outline" disabled={networkDisabled || ahead === 0} onClick={() => void run("push", async () => {
                if (!window.confirm(t("repoStatus.pushLocalWinsConfirm"))) return t("repoStatus.cancelled");
                const result = await pushLocalCommits({ bookId: book.id, token });
                return t("repoStatus.pushDone", { count: result.files });
              })}>{busy === "push" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-1 h-4 w-4" />}{t("repoStatus.push")}</Button>
            </div>
            <Button variant="outline" className="w-full" disabled={disabled} onClick={() => void exportBackup()}>{busy === "backup" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}{t("repoStatus.exportBackup")}</Button>
            <div className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
              <p className="text-sm font-medium">{t("repoStatus.repairTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("repoStatus.repairDescription")}</p>
              <Button variant="outline" className="w-full" disabled={networkDisabled} onClick={() => void run("resync-local", async () => {
                if (!window.confirm(t("repoStatus.resyncLocalConfirm"))) return t("repoStatus.cancelled");
                const result = await overwriteRemoteWithLocal({ bookId: book.id, token });
                return t("repoStatus.resyncLocalDone", { count: result.files });
              })}>{busy === "resync-local" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1 h-4 w-4" />}{t("repoStatus.resyncLocal")}</Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="outline" disabled={networkDisabled} onClick={() => void recloneLocal()}>{busy === "reclone" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}{t("repoStatus.reclone")}</Button>
              <Button variant="destructive" disabled={disabled} onClick={() => void removeLocal()}>{busy === "remove-local" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}{t("repoStatus.removeLocal")}</Button>
            </div>
            <div className="space-y-2 rounded-xl border p-3">
              <p className="text-sm font-medium">{t("repoStatus.localChanges")}</p>
              {dirtyFiles.length ? (
                <div className="max-h-56 space-y-1 overflow-auto text-xs">
                  {dirtyFiles.map((file) => <div key={file.path} className="flex items-center gap-2 rounded border px-2 py-1"><span className="w-16 shrink-0 uppercase text-muted-foreground">{file.status}</span><span className="truncate font-mono">{file.path}</span></div>)}
                </div>
              ) : <p className="text-sm text-muted-foreground">{t("repoStatus.noLocalChanges")}</p>}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input value={message || defaultMessage} onChange={(event) => setMessage(event.target.value)} placeholder={t("repoStatus.commitMessage")} disabled={disabled || dirtyFiles.length === 0} />
                <Button disabled={disabled || dirtyFiles.length === 0} onClick={() => void run("commit", async () => {
                  await commitLocalChanges(book.id, message || defaultMessage);
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
                      {filter === "all" ? t("repoStatus.logAll") : filter}
                    </button>
                  ))}
                </div>
              </div>
              {visibleLogs.length ? (
                <div className="max-h-48 space-y-1 overflow-auto text-xs">
                  {visibleLogs.map((log) => (
                    <div key={log.id} className="rounded border px-2 py-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${logTone(log.kind)}`}>{log.kind}</span>
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
