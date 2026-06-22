import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  GripVertical,
  Plus,
  Trash2,
  Loader2,
  FileEdit,
  PenLine,
  ClipboardCheck,
  NotebookText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useToast } from "@/components/ui/use-toast";
import {
  createFile,
  reorderParagraphsInChapter,
  slugToTitle,
} from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { type Paragraph } from "@/types/book";
import { resolveBookToken } from "@/types/settings";
import { slugify } from "@/narrarium/canon";
import {
  createChapterDraftArtifacts,
  createChapterEvaluationArtifact,
  createChapterResumeArtifact,
  createParagraphDraftArtifact,
  createParagraphEvaluationArtifact,
  createParagraphScriptArtifact,
} from "@/narrarium/workspace";
import { stringify } from "yaml";

function stringifyFrontmatter(frontmatter: Record<string, unknown>): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---`;
}

export function ChapterPage() {
  const { bookId, chapterId } = useParams<{
    bookId: string;
    chapterId: string;
  }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const { settings } = useSettingsStore();
  const { structures, updateChapterParagraphs } = useBooksStore();

  const book = settings.books.find((b) => b.id === bookId);
  const structure = bookId ? structures[bookId] : undefined;
  const chapter = structure?.chapters.find((c) => c.slug === chapterId);

  const token = book ? resolveBookToken(book, settings) : "";

  const { branch } = useWorkingBranch(bookId);

  // ── Local paragraph list (source of truth for optimistic UI) ─────────────
  const [localParagraphs, setLocalParagraphs] = useState<Paragraph[]>(
    () => chapter?.paragraphs ?? [],
  );

  // ── Drag & drop state ─────────────────────────────────────────────────────
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [isSavingOrder, setIsSavingOrder] = useState(false);

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
  async function handleDrop(e: React.DragEvent, targetIdx: number) {
    e.preventDefault();
    setDraggingIdx(null);
    setOverIdx(null);
    if (draggingIdx === null || draggingIdx === targetIdx) return;

    const newOrder = [...localParagraphs];
    const [moved] = newOrder.splice(draggingIdx, 1);
    newOrder.splice(targetIdx, 0, moved);
    setLocalParagraphs(newOrder); // optimistic update

    if (!book || !structure) return;
    setIsSavingOrder(true);
    try {
      const updated = await reorderParagraphsInChapter(
        token,
        book.owner,
        book.repo,
        branch,
        chapter!.path,
        chapter!.paragraphs,
        newOrder,
        `Reorder paragraphs in ${chapter!.slug}`,
      );
      setLocalParagraphs(updated);
      updateChapterParagraphs(bookId!, chapterId!, updated);
    } catch (err) {
      toast({
        title: "Reorder failed",
        description: String(err),
        variant: "destructive",
      });
      setLocalParagraphs(chapter!.paragraphs); // revert
    } finally {
      setIsSavingOrder(false);
    }
  }

  // ── Delete paragraph ──────────────────────────────────────────────────────
  const [toDelete, setToDelete] = useState<Paragraph | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!toDelete || !book || !structure || !chapter) return;
    setDeleting(true);
    try {
      const remaining = localParagraphs.filter((p) => p.path !== toDelete.path);
      const updated = await reorderParagraphsInChapter(
        token,
        book.owner,
        book.repo,
        branch,
        chapter.path,
        chapter.paragraphs,
        remaining,
        `Delete paragraph ${toDelete.number}: ${toDelete.title}`,
      );
      setLocalParagraphs(updated);
      updateChapterParagraphs(bookId!, chapterId!, updated);
      setToDelete(null);
    } catch (err) {
      toast({
        title: "Delete failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  }

  // ── Add paragraph ─────────────────────────────────────────────────────────
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);

  async function handleAdd() {
    if (!newTitle.trim() || !book || !structure || !chapter) return;
    setAdding(true);
    try {
      const nextNum = String(localParagraphs.length + 1).padStart(3, "0");
      const slug = slugify(newTitle) || "paragraph";
      const filename = `${nextNum}-${slug}.md`;
      const path = `${chapter.path}/${filename}`;
      const frontmatter = {
        type: "paragraph",
        id: `paragraph:${chapter.slug}:${nextNum}-${slug}`,
        chapter: `chapter:${chapter.slug}`,
        number: localParagraphs.length + 1,
        title: newTitle.trim(),
        canon: "draft",
      };
      const content = `${stringifyFrontmatter(frontmatter)}\n\n`;

      await createFile(
        token,
        book.owner,
        book.repo,
        branch,
        path,
        content,
        `Add paragraph ${nextNum}: ${newTitle.trim()}`,
      );

      const newParagraph: Paragraph = {
        number: nextNum,
        title: slugToTitle(`${nextNum}-${slug}`),
        path,
      };
      const updated = [...localParagraphs, newParagraph];
      setLocalParagraphs(updated);
      updateChapterParagraphs(bookId!, chapterId!, updated);
      setNewTitle("");
      setShowAddForm(false);
      // Navigate directly to the new paragraph for editing
      navigate(`/app/books/${bookId}/chapters/${chapterId}/paragraphs/${nextNum}`);
    } catch (err) {
      toast({
        title: "Failed to create paragraph",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setAdding(false);
    }
  }

  async function handleCreateChapterDraft() {
    if (!book || !chapter) return;
    try {
      const match = /^(\d{3})-/.exec(chapter.slug);
      const number = Number(match?.[1] ?? 1);
      await createChapterDraftArtifacts(token, book.owner, book.repo, branch, {
        number,
        title: chapter.title,
      });
      toast({ title: "Chapter draft created" });
    } catch (err) {
      toast({ title: "Chapter draft failed", description: String(err), variant: "destructive" });
    }
  }

  async function handleCreateChapterResume() {
    if (!book || !chapter) return;
    try {
      await createChapterResumeArtifact(token, book.owner, book.repo, branch, { chapterSlug: chapter.slug });
      toast({ title: "Chapter resume created" });
    } catch (err) {
      toast({ title: "Chapter resume failed", description: String(err), variant: "destructive" });
    }
  }

  async function handleCreateChapterEvaluation() {
    if (!book || !chapter) return;
    try {
      await createChapterEvaluationArtifact(token, book.owner, book.repo, branch, { chapterSlug: chapter.slug });
      toast({ title: "Chapter evaluation created" });
    } catch (err) {
      toast({ title: "Chapter evaluation failed", description: String(err), variant: "destructive" });
    }
  }

  async function handleCreateParagraphWorkspace(
    kind: "draft" | "script" | "evaluation",
    paragraph: Paragraph,
  ) {
    if (!book || !chapter) return;
    try {
      if (kind === "draft") {
        await createParagraphDraftArtifact(token, book.owner, book.repo, branch, {
          chapterSlug: chapter.slug,
          number: Number(paragraph.number),
          title: paragraph.title,
        });
        toast({ title: `Draft created for ${paragraph.title}` });
      } else if (kind === "script") {
        await createParagraphScriptArtifact(token, book.owner, book.repo, branch, {
          chapterSlug: chapter.slug,
          number: Number(paragraph.number),
          title: paragraph.title,
        });
        toast({ title: `Script created for ${paragraph.title}` });
      } else {
        await createParagraphEvaluationArtifact(token, book.owner, book.repo, branch, {
          chapterSlug: chapter.slug,
          paragraphPath: paragraph.path,
        });
        toast({ title: `Evaluation created for ${paragraph.title}` });
      }
    } catch (err) {
      toast({ title: `Create ${kind} failed`, description: String(err), variant: "destructive" });
    }
  }

  // ── Guards ────────────────────────────────────────────────────────────────
  if (!book || !structure) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Book not loaded yet.{" "}
          <Link to={`/app/books/${bookId}`} className="underline">
            Go back to the book
          </Link>{" "}
          to load its structure first.
        </AlertDescription>
      </Alert>
    );
  }
  if (!chapter) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Chapter "{chapterId}" not found.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back */}
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to={`/app/books/${bookId}`}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to book
        </Link>
      </Button>

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{chapter.title}</h1>
          <p className="text-muted-foreground text-sm">
            {localParagraphs.length} paragraph
            {localParagraphs.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isSavingOrder && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving order…
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => void handleCreateChapterDraft()}>
            <FileEdit className="mr-1 h-4 w-4" />
            Draft
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleCreateChapterResume()}>
            <NotebookText className="mr-1 h-4 w-4" />
            Resume
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleCreateChapterEvaluation()}>
            <ClipboardCheck className="mr-1 h-4 w-4" />
            Evaluation
          </Button>
        </div>
      </div>

      {/* Metadata badges */}
      <div className="flex flex-wrap gap-2">
        {chapter.draftPath && (
          <Badge variant="secondary">
            <FileEdit className="mr-1 h-3 w-3" />
            Has draft
          </Badge>
        )}
        {chapter.writingStylePath && (
          <Badge variant="secondary">
            <PenLine className="mr-1 h-3 w-3" />
            Writing style
          </Badge>
        )}
        {chapter.hasResume && <Badge variant="secondary">Resume</Badge>}
        {chapter.hasEvaluation && <Badge variant="secondary">Evaluation</Badge>}
      </div>

      {/* Paragraph list */}
      <div className="space-y-1">
        {localParagraphs.map((p, i) => (
          <div
            key={p.path}
            draggable
            onDragStart={(e) => handleDragStart(e, i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDrop={(e) => void handleDrop(e, i)}
            onDragEnd={handleDragEnd}
            className={[
              "flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-sm transition-colors",
              draggingIdx === i ? "opacity-40" : "",
              overIdx === i && draggingIdx !== i
                ? "border-primary bg-accent"
                : "hover:bg-accent/50",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {/* Drag handle */}
            <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground" />

            {/* Number badge */}
            <Badge variant="outline" className="shrink-0 font-mono text-xs">
              {p.number}
            </Badge>

            {/* Title — clickable, takes full remaining width */}
            <Link
              to={`/app/books/${bookId}/chapters/${chapterId}/paragraphs/${p.number}`}
              className="flex-1 font-medium hover:underline truncate"
              onClick={(e) => {
                // Don't navigate while dragging
                if (draggingIdx !== null) e.preventDefault();
              }}
            >
              {p.title}
            </Link>

            {p.draftPath && (
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                draft
              </Badge>
            )}

            <div className="hidden items-center gap-1 lg:flex">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={() => void handleCreateParagraphWorkspace("draft", p)}>Draft</Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={() => void handleCreateParagraphWorkspace("script", p)}>Script</Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={() => void handleCreateParagraphWorkspace("evaluation", p)}>Eval</Button>
            </div>

            {/* Delete */}
            <button
              onClick={() => setToDelete(p)}
              className="ml-1 shrink-0 rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              aria-label={`Delete paragraph ${p.number}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}

        {localParagraphs.length === 0 && !showAddForm && (
          <p className="py-4 text-sm text-muted-foreground">
            No paragraphs yet. Add the first one below.
          </p>
        )}
      </div>

      {/* Add paragraph form */}
      {showAddForm ? (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            placeholder="Paragraph title (e.g. At the Gate)"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAdd();
              if (e.key === "Escape") {
                setShowAddForm(false);
                setNewTitle("");
              }
            }}
            disabled={adding}
          />
          <Button onClick={() => void handleAdd()} disabled={adding || !newTitle.trim()}>
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setShowAddForm(false);
              setNewTitle("");
            }}
            disabled={adding}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowAddForm(true)}
        >
          <Plus className="mr-1 h-4 w-4" />
          Add Paragraph
        </Button>
      )}

      {/* Delete confirmation */}
      <Dialog
        open={!!toDelete}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete paragraph?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <strong>
              {toDelete?.number} — {toDelete?.title}
            </strong>{" "}
            will be permanently deleted from GitHub and the remaining paragraphs
            will be renumbered.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
