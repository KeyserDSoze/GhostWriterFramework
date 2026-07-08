import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronRight, FileText, GripVertical, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { reorderChaptersInBook } from "@/github/githubClient";
import type { BookEntry } from "@/types/settings";
import type { Chapter } from "@/types/book";

export function ChapterReorderList({
  bookId,
  book,
  token,
  branch,
  chapters,
  onReordered,
}: {
  bookId: string;
  book: BookEntry;
  token: string;
  branch: string;
  chapters: Chapter[];
  onReordered: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [localChapters, setLocalChapters] = useState<Chapter[]>(chapters);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [pending, setPending] = useState<Chapter[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setLocalChapters(chapters); }, [chapters]);

  function handleDragStart(e: React.DragEvent, i: number) {
    setDraggingIdx(i);
    e.dataTransfer.effectAllowed = "move";
  }
  function handleDragOver(e: React.DragEvent, i: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOverIdx(i);
  }
  function handleDragEnd() {
    setDraggingIdx(null);
    setOverIdx(null);
  }
  function handleDrop(e: React.DragEvent, targetIdx: number) {
    e.preventDefault();
    const from = draggingIdx;
    setDraggingIdx(null);
    setOverIdx(null);
    if (from === null || from === targetIdx) return;
    const next = [...localChapters];
    const [moved] = next.splice(from, 1);
    next.splice(targetIdx, 0, moved);
    setLocalChapters(next);
    setPending(next);
  }

  function cancelReorder() {
    setPending(null);
    setLocalChapters(chapters);
  }

  async function confirmReorder() {
    if (!pending) return;
    setSaving(true);
    try {
      await reorderChaptersInBook(
        token,
        book.owner,
        book.repo,
        branch,
        pending.map((c) => ({ slug: c.slug })),
        "Reorder chapters",
      );
      setPending(null);
      toast({ title: t("bookPage.chaptersReordered") });
      onReordered();
    } catch (err) {
      toast({ title: t("bookPage.reorderChaptersFailed"), description: String(err), variant: "destructive" });
      setLocalChapters(chapters);
      setPending(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ul className="space-y-2">
        {localChapters.map((ch, i) => (
          <li
            key={ch.slug}
            draggable
            onDragStart={(e) => handleDragStart(e, i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDrop={(e) => handleDrop(e, i)}
            onDragEnd={handleDragEnd}
            className={[
              "flex items-center gap-2 rounded-lg border bg-card px-3 py-3 text-sm transition-colors",
              draggingIdx === i ? "opacity-40" : "",
              overIdx === i && draggingIdx !== i ? "border-primary bg-accent" : "hover:bg-accent/50",
            ].filter(Boolean).join(" ")}
          >
            <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground" />
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Link
              to={`/app/books/${bookId}/chapters/${ch.slug}`}
              className="min-w-0 flex-1"
              onClick={(e) => { if (draggingIdx !== null) e.preventDefault(); }}
            >
              <p className="truncate font-medium">{ch.title}</p>
              <p className="text-xs text-muted-foreground">
                {ch.paragraphs.length} paragraph{ch.paragraphs.length !== 1 ? "s" : ""}
                {ch.draftPath && ` · ${t("bookPage.draft")}`}
                {ch.hasResume && ` · ${t("bookPage.resume")}`}
                {ch.hasEvaluation && ` · ${t("bookPage.eval")}`}
              </p>
            </Link>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </li>
        ))}
      </ul>

      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) cancelReorder(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("bookPage.reorderChaptersConfirmTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("bookPage.reorderChaptersConfirmDescription")}</p>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2">
            {(pending ?? []).map((c, i) => (
              <div key={c.slug} className="flex items-center gap-2 rounded px-2 py-1 text-sm">
                <Badge variant="outline" className="shrink-0 font-mono text-[10px]">{String(i + 1).padStart(3, "0")}</Badge>
                <span className="truncate">{c.title}</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={cancelReorder} disabled={saving}>{t("common.cancel")}</Button>
            <Button onClick={() => void confirmReorder()} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {t("chapter.reorderConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
