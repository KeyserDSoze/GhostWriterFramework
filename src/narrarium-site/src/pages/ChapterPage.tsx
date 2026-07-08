import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  GripVertical,
  Plus,
  Trash2,
  Loader2,
  FileEdit,
  PenLine,
  Save,
  MoreHorizontal,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  createFile,
  readFileWithSha,
  reorderParagraphsInChapter,
  slugToTitle,
  updateFile,
} from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { type Paragraph } from "@/types/book";
import { resolveBookToken } from "@/types/settings";
import { slugify } from "@/narrarium/canon";
import { useBookStructure } from "@/hooks/useBookStructure";
import {
  createParagraphDraftArtifact,
  createParagraphEvaluationArtifact,
  createParagraphScriptArtifact,
} from "@/narrarium/workspace";
import { GhostwriterField } from "@/components/book/GhostwriterField";
import { parseDocument, stringify } from "yaml";

function stringifyFrontmatter(frontmatter: Record<string, unknown>): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---`;
}

/** Split a chapter.md into frontmatter object + body, keeping unknown keys. */
function splitChapterDoc(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  const doc = parseDocument(match[1]);
  const parsed = (doc.toJSON() as Record<string, unknown>) ?? {};
  return { frontmatter: parsed, body: match[2].replace(/^\s*\n/, "") };
}

export function ChapterPage() {
  const { bookId, chapterId } = useParams<{
    bookId: string;
    chapterId: string;
  }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation();

  const { settings } = useSettingsStore();
  const { updateChapterParagraphs } = useBooksStore();
  const { book, structure, loading: structureLoading, error: structureError, reload } = useBookStructure(bookId);
  const chapter = structure?.chapters.find((c) => c.slug === chapterId);

  const token = book ? resolveBookToken(book, settings) : "";

  const { branch } = useWorkingBranch(bookId);

  // ── Chapter title (chapter.md frontmatter) ────────────────────────────────
  const chapterMdPath = chapter ? `${chapter.path}/chapter.md` : "";
  const [titleValue, setTitleValue] = useState("");
  const [savedTitle, setSavedTitle] = useState("");
  const [savedChapterGhostwriter, setSavedChapterGhostwriter] = useState("");
  const [chapterFm, setChapterFm] = useState<Record<string, unknown> | null>(null);
  const [chapterBody, setChapterBody] = useState("");
  const [chapterSha, setChapterSha] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const titleLoadedRef = useRef("");

  useEffect(() => {
    if (!chapter || !book || !token || !chapterMdPath) return;
    const key = `${branch}:${chapterMdPath}`;
    if (titleLoadedRef.current === key) return;
    titleLoadedRef.current = key;
    readFileWithSha(token, book.owner, book.repo, branch, chapterMdPath)
      .then(({ content, sha }) => {
        const { frontmatter, body } = splitChapterDoc(content);
        const title = typeof frontmatter.title === "string" ? frontmatter.title : chapter.title;
        setChapterFm(frontmatter);
        setChapterBody(body);
        setChapterSha(sha);
        setTitleValue(title);
        setSavedTitle(title);
        setSavedChapterGhostwriter(typeof frontmatter.ghostwriter === "string" ? frontmatter.ghostwriter : "");
      })
      .catch(() => {
        // No chapter.md yet → seed from slug-derived title; save will create it.
        setChapterFm({ type: "chapter", id: `chapter:${chapter.slug}`, title: chapter.title });
        setChapterBody("");
        setChapterSha("");
        setTitleValue(chapter.title);
        setSavedTitle(chapter.title);
        setSavedChapterGhostwriter("");
      });
  }, [chapter, book, token, branch, chapterMdPath]);

  const currentChapterGhostwriter = typeof chapterFm?.ghostwriter === "string" ? chapterFm.ghostwriter : "";
  const chapterMetadataDirty = titleValue.trim() !== savedTitle || currentChapterGhostwriter !== savedChapterGhostwriter;

  function setChapterGhostwriter(slug: string) {
    setChapterFm((prev) => {
      const next = { ...(prev ?? { type: "chapter", id: `chapter:${chapter?.slug ?? chapterId}`, title: titleValue || chapter?.title || "" }) };
      if (slug) next.ghostwriter = slug;
      else delete next.ghostwriter;
      return next;
    });
  }

  async function saveChapterTitle() {
    if (!book || !token || !chapterMdPath || !chapterFm) return;
    const trimmed = titleValue.trim();
    if (!trimmed || !chapterMetadataDirty) return;
    setSavingTitle(true);
    try {
      const nextFm: Record<string, unknown> = { ...chapterFm, title: trimmed };
      const content = `${stringifyFrontmatter(nextFm)}\n\n${chapterBody.trim()}\n`;
      if (chapterSha) {
        const newSha = await updateFile(token, book.owner, book.repo, branch, chapterMdPath, chapterSha, content, `Rename chapter ${chapter!.slug}`);
        setChapterSha(newSha);
      } else {
        const newSha = await createFile(token, book.owner, book.repo, branch, chapterMdPath, content, `Create chapter.md for ${chapter!.slug}`);
        setChapterSha(newSha);
      }
      setChapterFm(nextFm);
      setSavedTitle(trimmed);
      setSavedChapterGhostwriter(typeof nextFm.ghostwriter === "string" ? nextFm.ghostwriter : "");
      toast({ title: t("common.saved") });
      void reload();
    } catch (err) {
      toast({ title: t("common.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setSavingTitle(false);
    }
  }

  // ── Local paragraph list (source of truth for optimistic UI) ─────────────
  const [localParagraphs, setLocalParagraphs] = useState<Paragraph[]>(
    () => chapter?.paragraphs ?? [],
  );

  useEffect(() => {
    setLocalParagraphs(chapter?.paragraphs ?? []);
  }, [chapter?.paragraphs]);

  // ── Drag & drop state ─────────────────────────────────────────────────────
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  // Proposed reorder awaiting user confirmation.
  const [pendingReorder, setPendingReorder] = useState<Paragraph[] | null>(null);

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

    const newOrder = [...localParagraphs];
    const [moved] = newOrder.splice(from, 1);
    newOrder.splice(targetIdx, 0, moved);
    setLocalParagraphs(newOrder); // optimistic visual reorder
    setPendingReorder(newOrder); // opens confirmation dialog
  }

  function cancelReorder() {
    setPendingReorder(null);
    setLocalParagraphs(chapter?.paragraphs ?? []); // revert visual change
  }

  async function confirmReorder() {
    if (!pendingReorder || !book || !structure || !chapter) return;
    setIsSavingOrder(true);
    try {
      const updated = await reorderParagraphsInChapter(
        token,
        book.owner,
        book.repo,
        branch,
        chapter.path,
        chapter.paragraphs,
        pendingReorder,
        `Reorder paragraphs in ${chapter.slug}`,
      );
      setLocalParagraphs(updated);
      updateChapterParagraphs(bookId!, chapterId!, updated);
      setPendingReorder(null);
    } catch (err) {
      toast({
        title: t("chapter.reorderFailed"),
        description: String(err),
        variant: "destructive",
      });
      setLocalParagraphs(chapter.paragraphs); // revert
      setPendingReorder(null);
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
        title: t("chapter.deleteFailed"),
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
        title: t("chapter.createParagraphFailed"),
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setAdding(false);
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
        toast({ title: t("chapter.draftCreatedFor", { title: paragraph.title }) });
      } else if (kind === "script") {
        await createParagraphScriptArtifact(token, book.owner, book.repo, branch, {
          chapterSlug: chapter.slug,
          number: Number(paragraph.number),
          title: paragraph.title,
        });
        toast({ title: t("chapter.scriptCreatedFor", { title: paragraph.title }) });
      } else {
        await createParagraphEvaluationArtifact(token, book.owner, book.repo, branch, {
          chapterSlug: chapter.slug,
          paragraphPath: paragraph.path,
        });
        toast({ title: t("chapter.evaluationCreatedFor", { title: paragraph.title }) });
      }
    } catch (err) {
      toast({ title: t("chapter.createKindFailed", { kind }), description: String(err), variant: "destructive" });
    }
  }

  // ── Guards ────────────────────────────────────────────────────────────────
  if (!book) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("bookPage.notFound")}</AlertDescription>
      </Alert>
    );
  }
  if (structureLoading && !structure) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <p className="text-sm">{t("common.loading")}</p>
      </div>
    );
  }
  if (structureError && !structure) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{structureError}</span>
          <Button size="sm" variant="outline" onClick={() => reload()}>{t("common.reloadBook")}</Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!chapter) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("chapter.notFound", { id: chapterId })}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back */}
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to={`/app/books/${bookId}`}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          {t("chapter.backToBook")}
        </Link>
      </Button>

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Input
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void saveChapterTitle(); }}
              className="h-auto border-0 bg-transparent px-0 text-2xl font-bold tracking-tight shadow-none outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
              placeholder={chapter.title}
            />
            {titleValue.trim() && chapterMetadataDirty && (
              <Button size="sm" onClick={() => void saveChapterTitle()} disabled={savingTitle}>
                {savingTitle ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
                {t("common.save")}
              </Button>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            {localParagraphs.length} paragraph
            {localParagraphs.length !== 1 ? "s" : ""}
          </p>
          <div className="mt-3 max-w-xl rounded-lg border bg-muted/30 px-3 py-2">
            <GhostwriterField ghostwriters={structure?.ghostwriters ?? []} value={currentChapterGhostwriter} onChange={setChapterGhostwriter} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isSavingOrder && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("chapter.savingOrder")}
            </div>
          )}
        </div>
      </div>

      {/* Metadata badges */}
      <div className="flex flex-wrap gap-2">
        {chapter.draftPath && (
          <Badge variant="secondary">
            <FileEdit className="mr-1 h-3 w-3" />
            {t("chapter.hasDraft")}
          </Badge>
        )}
        {chapter.writingStylePath && (
          <Badge variant="secondary">
            <PenLine className="mr-1 h-3 w-3" />
            {t("chapter.writingStyle")}
          </Badge>
        )}
        {chapter.hasResume && <Badge variant="secondary">{t("chapter.resume")}</Badge>}
        {chapter.hasEvaluation && <Badge variant="secondary">{t("chapter.evaluation")}</Badge>}
      </div>

      {/* Paragraph list */}
      <div className="space-y-1">
        {localParagraphs.map((p, i) => (
          <div
            key={p.path}
            draggable
            onDragStart={(e) => handleDragStart(e, i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDrop={(e) => handleDrop(e, i)}
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
                {t("chapter.draft")}
              </Badge>
            )}

            <div className="flex items-center gap-1">
              <Button asChild variant="ghost" size="sm" className="hidden h-7 px-2 text-[10px] sm:inline-flex">
                <Link to={`/app/books/${bookId}/chapters/${chapterId}/paragraphs/${p.number}/workspace/draft`}>{t("chapter.draft")}</Link>
              </Button>
              <Button asChild variant="ghost" size="sm" className="hidden h-7 px-2 text-[10px] sm:inline-flex">
                <Link to={`/app/books/${bookId}/chapters/${chapterId}/paragraphs/${p.number}/workspace/script`}>{t("chapter.script")}</Link>
              </Button>
              <Button asChild variant="ghost" size="sm" className="hidden h-7 px-2 text-[10px] sm:inline-flex">
                <Link to={`/app/books/${bookId}/chapters/${chapterId}/paragraphs/${p.number}/workspace/evaluation`}>{t("chapter.eval")}</Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7 sm:hidden">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void handleCreateParagraphWorkspace("draft", p)}>{t("chapter.createDraft")}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleCreateParagraphWorkspace("script", p)}>{t("chapter.createScript")}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleCreateParagraphWorkspace("evaluation", p)}>{t("chapter.createEvaluation")}</DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to={`/app/books/${bookId}/chapters/${chapterId}/paragraphs/${p.number}/workspace/draft`}>{t("chapter.openDraft")}</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to={`/app/books/${bookId}/chapters/${chapterId}/paragraphs/${p.number}/workspace/script`}>{t("chapter.openScript")}</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to={`/app/books/${bookId}/chapters/${chapterId}/paragraphs/${p.number}/workspace/evaluation`}>{t("chapter.openEvaluation")}</Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Delete */}
            <button
              onClick={() => setToDelete(p)}
              className="ml-1 shrink-0 rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              aria-label={t("chapter.deleteParagraphAria", { number: p.number })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}

        {localParagraphs.length === 0 && !showAddForm && (
          <p className="py-4 text-sm text-muted-foreground">
            {t("chapter.noParagraphs")}
          </p>
        )}
      </div>

      {/* Add paragraph form */}
      {showAddForm ? (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            placeholder={t("chapter.paragraphPlaceholder")}
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
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : t("common.add")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setShowAddForm(false);
              setNewTitle("");
            }}
            disabled={adding}
          >
            {t("common.cancel")}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowAddForm(true)}
        >
          <Plus className="mr-1 h-4 w-4" />
          {t("chapter.addParagraph")}
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
            <DialogTitle>{t("chapter.deleteParagraph")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("chapter.deleteParagraphDescription", {
              title: `${toDelete?.number} — ${toDelete?.title}`,
            })}
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleting}>
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reorder confirmation */}
      <Dialog
        open={!!pendingReorder}
        onOpenChange={(open) => { if (!open) cancelReorder(); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("chapter.reorderConfirmTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("chapter.reorderConfirmDescription")}</p>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2">
            {(pendingReorder ?? []).map((p, i) => (
              <div key={p.path} className="flex items-center gap-2 rounded px-2 py-1 text-sm">
                <Badge variant="outline" className="shrink-0 font-mono text-[10px]">{String(i + 1).padStart(3, "0")}</Badge>
                <span className="truncate">{p.title}</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={cancelReorder} disabled={isSavingOrder}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void confirmReorder()} disabled={isSavingOrder}>
              {isSavingOrder ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {t("chapter.reorderConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
