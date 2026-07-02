import type { ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ClipboardCheck, Columns2, FileEdit, FileText, NotebookText, Network, PenLine, Wand2 } from "lucide-react";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { parseAppRoute } from "@/assistant/context";
import { resolveBookToken } from "@/types/settings";
import { useToast } from "@/components/ui/use-toast";
import { createChapterDraftArtifacts, createChapterEvaluationArtifact, createChapterResumeArtifact, createParagraphDraftArtifact, createParagraphEvaluationArtifact, createParagraphScriptArtifact } from "@/narrarium/workspace";

export interface ContextualAction {
  id: string;
  label: string;
  icon: ReactNode;
  to?: string;
  run?: () => void | Promise<void>;
}

/** Props needed to open the image dialog for the current route target. */
export interface ContextualImageProps {
  book: import("@/types/settings").BookEntry;
  branch: string;
  token: string;
  kind: "paragraph" | "chapter" | "book";
  title: string;
  chapterSlug?: string;
  paragraphSlug?: string;
  textPath?: string;
  resumePath?: string;
}

/**
 * The contextual navigable actions for the current route (script/draft/final/evaluation,
 * indexes, resume, writing-style, ghostwriters). Shared by FloatingActions and the right-click menu.
 */
export function useContextualActions(): { actions: ContextualAction[]; hasBookActions: boolean; imageProps: ContextualImageProps | null } {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { structures } = useBooksStore();

  const route = parseAppRoute(location.pathname);
  const bookId = "bookId" in route ? route.bookId : undefined;
  const chapterId = "chapterId" in route ? route.chapterId : undefined;
  const paragraphNum = "paragraphNum" in route ? route.paragraphNum : undefined;
  const { reload } = useBookStructure(bookId);
  const { branch } = useWorkingBranch(bookId);
  const structure = bookId ? structures[bookId] : undefined;
  const chapter = chapterId && structure ? structure.chapters.find((c) => c.slug === chapterId) : undefined;
  const paragraph = paragraphNum && chapter ? chapter.paragraphs.find((p) => p.number === paragraphNum) : undefined;
  const book = bookId ? settings.books.find((b) => b.id === bookId) : undefined;
  const token = book ? resolveBookToken(book, settings) : "";

  async function openOrCreate(kind: "draft" | "script") {
    if (!chapter || !paragraph || !book || !token) return;
    const target = `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraph.number}/workspace/${kind}`;
    const present = kind === "draft" ? paragraph.draftPath : paragraph.scriptPath;
    if (!present) {
      try {
        if (kind === "draft") await createParagraphDraftArtifact(token, book.owner, book.repo, branch, { chapterSlug: chapter.slug, number: Number(paragraph.number), title: paragraph.title });
        else await createParagraphScriptArtifact(token, book.owner, book.repo, branch, { chapterSlug: chapter.slug, number: Number(paragraph.number), title: paragraph.title });
        await reload();
      } catch (err) {
        toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
        return;
      }
    }
    navigate(target);
  }

  async function openOrCreateChapter(kind: "draft" | "resume" | "evaluation") {
    if (!chapter || !book || !token || !chapterId) return;
    const target = `/app/books/${bookId}/chapters/${chapterId}/workspace/${kind}`;
    const present = kind === "draft" ? !!chapter.draftPath : kind === "resume" ? chapter.hasResume : chapter.hasEvaluation;
    if (!present) {
      try {
        if (kind === "draft") {
          const number = Number(/^(\d{3})-/.exec(chapter.slug)?.[1] ?? "1");
          await createChapterDraftArtifacts(token, book.owner, book.repo, branch, { number, title: chapter.title });
        } else if (kind === "resume") {
          await createChapterResumeArtifact(token, book.owner, book.repo, branch, { chapterSlug: chapter.slug });
        } else {
          await createChapterEvaluationArtifact(token, book.owner, book.repo, branch, { chapterSlug: chapter.slug });
        }
        await reload();
      } catch (err) {
        toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
        return;
      }
    }
    navigate(target);
  }

  async function openOrCreateParagraphEvaluation() {
    if (!chapter || !paragraph || !book || !token || !chapterId) return;
    const target = `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraph.number}/workspace/evaluation`;
    if (!paragraph.evaluationPath) {
      try {
        await createParagraphEvaluationArtifact(token, book.owner, book.repo, branch, { chapterSlug: chapter.slug, paragraphPath: paragraph.path });
        await reload();
      } catch (err) {
        toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
        return;
      }
    }
    navigate(target);
  }

  const actions: ContextualAction[] = [];
  if (paragraph && chapterId) {
    const base = `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraph.number}`;
    actions.push({ id: "script", label: paragraph.scriptPath ? t("chapter.openScript") : t("chapter.createScript"), run: () => openOrCreate("script"), icon: <Network className="h-4 w-4" /> });
    actions.push({ id: "draft", label: paragraph.draftPath ? t("chapter.openDraft") : t("chapter.createDraft"), run: () => openOrCreate("draft"), icon: <FileEdit className="h-4 w-4" /> });
    actions.push({ id: "final", label: t("stageIndex.final"), to: base, icon: <FileText className="h-4 w-4" /> });
    // Split (draft|final side by side) is desktop-only.
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches) {
      actions.push({ id: "split", label: t("paragraph.splitView"), to: `${base}/split`, icon: <Columns2 className="h-4 w-4" /> });
    }
    actions.push({ id: "eval", label: paragraph.evaluationPath ? t("chapter.openEvaluation") : t("chapter.createEvaluation"), run: () => openOrCreateParagraphEvaluation(), icon: <ClipboardCheck className="h-4 w-4" /> });
  } else if (chapter && chapterId) {
    const base = `/app/books/${bookId}/chapters/${chapterId}`;
    actions.push({ id: "scripts", label: t("nav.scriptsIndex"), to: `${base}/scripts`, icon: <Network className="h-4 w-4" /> });
    actions.push({ id: "drafts", label: t("nav.draftsIndex"), to: `${base}/drafts`, icon: <FileEdit className="h-4 w-4" /> });
    actions.push({ id: "chDraft", label: chapter.draftPath ? t("chapter.openDraft") : t("chapter.createDraft"), run: () => openOrCreateChapter("draft"), icon: <FileEdit className="h-4 w-4" /> });
    actions.push({ id: "chResume", label: chapter.hasResume ? t("chapter.openResume") : t("chapter.createResume"), run: () => openOrCreateChapter("resume"), icon: <NotebookText className="h-4 w-4" /> });
    actions.push({ id: "chEval", label: chapter.hasEvaluation ? t("chapter.openEvaluation") : t("chapter.createEvaluation"), run: () => openOrCreateChapter("evaluation"), icon: <ClipboardCheck className="h-4 w-4" /> });
    actions.push({ id: "chStyle", label: t("writingStyle.chapterButton"), to: `${base}/writing-style`, icon: <PenLine className="h-4 w-4" /> });
  } else if (bookId) {
    actions.push({ id: "gw", label: t("ghostwriters.title"), to: `/app/books/${bookId}/ghostwriters`, icon: <Wand2 className="h-4 w-4" /> });
    actions.push({ id: "style", label: t("writingStyle.title"), to: `/app/books/${bookId}/writing-style`, icon: <PenLine className="h-4 w-4" /> });
  }

  // Book-level dialogs (image/commit/PR/export) exist whenever a book is in scope.
  const hasBookActions = Boolean(book && token);

  // Image dialog props for the current target (paragraph → chapter → book).
  let imageProps: ContextualImageProps | null = null;
  if (book && token) {
    if (paragraph && chapter) {
      imageProps = {
        book, branch, token, kind: "paragraph", title: paragraph.title, chapterSlug: chapter.slug,
        paragraphSlug: (paragraph.path.split("/").pop() ?? "").replace(/\.md$/i, ""), textPath: paragraph.path,
      };
    } else if (chapter) {
      imageProps = {
        book, branch, token, kind: "chapter", title: chapter.title, chapterSlug: chapter.slug,
        textPath: `${chapter.path}/chapter.md`, resumePath: `resumes/chapters/${chapter.slug}.md`,
      };
    } else if (structure) {
      imageProps = { book, branch, token, kind: "book", title: structure.title ?? book.name, textPath: "book.md", resumePath: "resumes/total.md" };
    }
  }

  return { actions, hasBookActions, imageProps };
}
