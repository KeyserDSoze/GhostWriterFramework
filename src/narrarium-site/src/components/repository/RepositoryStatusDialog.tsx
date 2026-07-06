import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitCommit, GitPullRequest, Loader2, RefreshCcw, UploadCloud } from "lucide-react";
import JSZip from "jszip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import type { BookEntry, AppSettings } from "@/types/settings";
import { resolveBookToken } from "@/types/settings";
import { getLocalRepositoryByBook, listAllLocalFiles, listDirtyLocalFiles, listUnpushedLocalCommits, localStatus, type LocalRepositoryFile, type LocalRepoStatus } from "@/repository/localRepository";
import { commitLocalChanges, fetchRemoteStatus, pullRemoteChanges, pushLocalCommits } from "@/repository/repositoryService";

export function RepositoryStatusDialog({ open, onOpenChange, book, settings }: { open: boolean; onOpenChange: (open: boolean) => void; book?: BookEntry; settings: AppSettings }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [status, setStatus] = useState<LocalRepoStatus | null>(null);
  const [dirtyFiles, setDirtyFiles] = useState<LocalRepositoryFile[]>([]);
  const [ahead, setAhead] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const token = book ? resolveBookToken(book, settings) : "";
  const disabled = !book || !token || !!busy;

  const defaultMessage = useMemo(() => {
    if (dirtyFiles.length === 1) return `Update ${dirtyFiles[0].path}`;
    return dirtyFiles.length ? `Update ${dirtyFiles.length} files` : "";
  }, [dirtyFiles]);

  async function refresh() {
    if (!book) { setStatus(null); setDirtyFiles([]); setAhead(0); return; }
    const repo = await getLocalRepositoryByBook(book.id).catch(() => null);
    if (!repo) { setStatus(null); setDirtyFiles([]); setAhead(0); return; }
    const [nextStatus, dirty, commits] = await Promise.all([localStatus(repo.id), listDirtyLocalFiles(repo.id), listUnpushedLocalCommits(repo.id)]);
    setStatus(nextStatus);
    setDirtyFiles(dirty);
    setAhead(commits.length);
    if (!message && dirty.length) setMessage(dirty.length === 1 ? `Update ${dirty[0].path}` : `Update ${dirty.length} files`);
  }

  useEffect(() => { if (open) void refresh(); }, [open, book?.id]);

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label);
    try {
      const result = await fn();
      toast({ title: result });
      await refresh();
    } catch (err) {
      toast({ title: t("repoStatus.actionFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function exportBackup() {
    if (!book) return;
    setBusy("backup");
    try {
      const repo = await getLocalRepositoryByBook(book.id);
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
      toast({ title: t("repoStatus.backupDone") });
    } catch (err) {
      toast({ title: t("repoStatus.actionFailed"), description: String(err), variant: "destructive" });
    } finally {
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
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Button variant="outline" disabled={disabled} onClick={() => void run("fetch", async () => {
                const result = await fetchRemoteStatus({ bookId: book.id, token });
                return result.changed ? t("repoStatus.remoteChanged") : t("repoStatus.remoteUpToDate");
              })}>{busy === "fetch" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCcw className="mr-1 h-4 w-4" />}{t("repoStatus.fetch")}</Button>
              <Button variant="outline" disabled={disabled} onClick={() => void run("pull", async () => {
                const result = await pullRemoteChanges({ bookId: book.id, token });
                return t("repoStatus.pullDone", { count: result.updated });
              })}>{busy === "pull" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <GitPullRequest className="mr-1 h-4 w-4" />}{t("repoStatus.pull")}</Button>
              <Button variant="outline" disabled={disabled || ahead === 0} onClick={() => void run("push", async () => {
                const result = await pushLocalCommits({ bookId: book.id, token });
                return t("repoStatus.pushDone", { count: result.files });
              })}>{busy === "push" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-1 h-4 w-4" />}{t("repoStatus.push")}</Button>
            </div>
            <Button variant="outline" className="w-full" disabled={disabled} onClick={() => void exportBackup()}>{busy === "backup" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}{t("repoStatus.exportBackup")}</Button>
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
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
