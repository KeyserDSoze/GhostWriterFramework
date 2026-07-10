import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { ArrowLeft, Loader2, NotebookPen, Plus, Save, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/components/ui/use-toast";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { parseAppRoute } from "@/assistant/context";
import { resolveBookToken } from "@/types/settings";
import { deleteFile, readFileWithSha, updateFile } from "@/github/githubClient";
import { createNote, renderNoteMarkdown, updateNoteFrontmatterField } from "@/narrarium/notes";
import type { NoteFile } from "@/types/book";

function splitNoteMarkdown(markdown: string): { frontmatterRaw: string; title: string; body: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n*/);
  const frontmatterRaw = match ? match[1] : "";
  const body = match ? markdown.slice(match[0].length) : markdown;
  const titleMatch = frontmatterRaw.match(/^title:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, "") : "";
  return { frontmatterRaw, title, body: body.replace(/^\s*\n/, "") };
}

type Mode = { kind: "list" } | { kind: "new" } | { kind: "edit"; note: NoteFile };

export function NotesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const location = useLocation();
  const { settings } = useSettingsStore();
  const { structures } = useBooksStore();
  const route = parseAppRoute(location.pathname);
  const bookId = "bookId" in route ? route.bookId : undefined;
  const book = bookId ? settings.books.find((b) => b.id === bookId) : undefined;
  const token = book ? resolveBookToken(book, settings) : "";
  const { branch } = useWorkingBranch(bookId);
  const { reload } = useBookStructure(bookId);
  const structure = bookId ? structures[bookId] : undefined;

  const notes: NoteFile[] = useMemo(() => structure?.notesFiles ?? [], [structure]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editFrontmatter, setEditFrontmatter] = useState("");
  const [editSha, setEditSha] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingNote, setLoadingNote] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode({ kind: "list" });
    setQuery("");
    setNewTitle("");
    setNewBody("");
    setTimeout(() => searchRef.current?.focus(), 50);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return notes;
    return notes.filter((n) => `${n.title} ${n.slug}`.toLowerCase().includes(needle));
  }, [notes, query]);

  async function openNote(note: NoteFile) {
    if (!book || !token) return;
    setMode({ kind: "edit", note });
    setLoadingNote(true);
    try {
      const { content, sha } = await readFileWithSha(token, book.owner, book.repo, branch, note.path);
      const parts = splitNoteMarkdown(content);
      setEditFrontmatter(parts.frontmatterRaw);
      setEditTitle(parts.title || note.title);
      setEditBody(parts.body.trim());
      setEditSha(sha);
    } catch (err) {
      toast({ title: t("notes.loadFailed"), description: String(err), variant: "destructive" });
      setMode({ kind: "list" });
    } finally {
      setLoadingNote(false);
    }
  }

  async function handleCreate() {
    if (!book || !token || !newTitle.trim()) return;
    setBusy(true);
    try {
      await createNote(token, book.owner, book.repo, branch, { title: newTitle.trim(), body: newBody });
      toast({ title: t("notes.created") });
      await reload();
      setMode({ kind: "list" });
      setNewTitle("");
      setNewBody("");
    } catch (err) {
      toast({ title: t("notes.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit() {
    if (mode.kind !== "edit" || !book || !token || !editSha) return;
    setBusy(true);
    try {
      let fm = updateNoteFrontmatterField(editFrontmatter, "updatedAt", new Date().toISOString());
      fm = updateNoteFrontmatterField(fm, "title", editTitle.trim() || mode.note.title);
      const content = renderNoteMarkdown(fm, editBody.trim() + "\n");
      await updateFile(token, book.owner, book.repo, branch, mode.note.path, editSha, content, `Update note ${mode.note.slug}`);
      toast({ title: t("common.saved") });
      await reload();
      setMode({ kind: "list" });
    } catch (err) {
      toast({ title: t("notes.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (mode.kind !== "edit" || !book || !token || !editSha) return;
    if (!window.confirm(t("notes.deleteConfirm"))) return;
    setBusy(true);
    try {
      await deleteFile(token, book.owner, book.repo, branch, mode.note.path, editSha, `Remove note ${mode.note.slug}`);
      toast({ title: t("notes.deleted") });
      await reload();
      setMode({ kind: "list" });
    } catch (err) {
      toast({ title: t("notes.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="left-1/2 top-1/2 flex h-[80dvh] max-h-[80dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 flex-col p-0 sm:w-[640px]">
        <DialogHeader className="flex-shrink-0 border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <NotebookPen className="h-5 w-5 text-primary" />
            {t("notes.title")}
          </DialogTitle>
        </DialogHeader>

        {!book ? (
          <div className="p-6 text-sm text-muted-foreground">{t("notes.openBookFirst")}</div>
        ) : mode.kind === "list" ? (
          <>
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("notes.searchPlaceholder")} className="pl-8" />
              </div>
              <Button size="sm" onClick={() => setMode({ kind: "new" })}>
                <Plus className="mr-1 h-4 w-4" />{t("notes.new")}
              </Button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-1 p-3">
                {filtered.length === 0 ? (
                  <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("notes.empty")}</p>
                ) : (
                  filtered.map((note) => (
                    <button
                      key={note.slug}
                      type="button"
                      onClick={() => void openNote(note)}
                      className="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm hover:bg-accent/50"
                    >
                      <NotebookPen className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{note.title || note.slug}</span>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </>
        ) : mode.kind === "new" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b px-4 py-2">
              <Button variant="ghost" size="sm" onClick={() => setMode({ kind: "list" })}><ArrowLeft className="mr-1 h-4 w-4" />{t("common.back")}</Button>
              <span className="text-sm font-medium">{t("notes.newTitle")}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
              <Input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t("notes.titlePlaceholder")} />
              <AutoTextarea value={newBody} onChange={(e) => setNewBody(e.target.value)} placeholder={t("notes.bodyPlaceholder")} className="min-h-[40vh] text-sm leading-6" />
            </div>
            <div className="flex justify-end gap-2 border-t px-4 py-3">
              <Button variant="ghost" onClick={() => setMode({ kind: "list" })} disabled={busy}>{t("common.cancel")}</Button>
              <Button onClick={() => void handleCreate()} disabled={busy || !newTitle.trim()}>
                {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}{t("notes.create")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b px-4 py-2">
              <Button variant="ghost" size="sm" onClick={() => setMode({ kind: "list" })}><ArrowLeft className="mr-1 h-4 w-4" />{t("common.back")}</Button>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{editTitle}</span>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void handleDelete()} disabled={busy || loadingNote} aria-label={t("common.delete")}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
            {loadingNote ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{t("notes.loading")}</p>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
                <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder={t("notes.titlePlaceholder")} />
                <AutoTextarea value={editBody} onChange={(e) => setEditBody(e.target.value)} placeholder={t("notes.bodyPlaceholder")} className="min-h-[40vh] text-sm leading-6" />
              </div>
            )}
            <div className="flex justify-end gap-2 border-t px-4 py-3">
              <Button variant="ghost" onClick={() => setMode({ kind: "list" })} disabled={busy}><X className="mr-1 h-4 w-4" />{t("common.cancel")}</Button>
              <Button onClick={() => void handleSaveEdit()} disabled={busy || loadingNote}>
                {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}{t("common.save")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
