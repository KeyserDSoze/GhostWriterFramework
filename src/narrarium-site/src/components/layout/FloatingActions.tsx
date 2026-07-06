import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronUp, ClipboardCheck, FileEdit, FileText, NotebookText, Network, PenLine, Save, Sparkles, Wand2, X } from "lucide-react";
import { useUiStore } from "@/store/uiStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { parseAppRoute } from "@/assistant/context";
import { resolveBookToken } from "@/types/settings";
import { useToast } from "@/components/ui/use-toast";
import { AssetImageDialog } from "@/components/book/AssetImageDialog";
import { BookExportDialog } from "@/components/book/BookExportDialog";
import { CommitHistoryDialog } from "@/components/github/CommitHistoryDialog";
import { PullRequestsDialog } from "@/components/github/PullRequestsDialog";
import { createChapterDraftArtifacts, createChapterEvaluationArtifact, createChapterResumeArtifact, createParagraphDraftArtifact, createParagraphScriptArtifact } from "@/narrarium/workspace";
import { useSaveStore } from "@/store/saveStore";
import { usePageActionsStore } from "@/store/pageActionsStore";

interface ActionRow {
  label: string;
  to?: string;
  onClick?: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
}

export function FloatingActions() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const floatingHidden = useUiStore((s) => s.floatingHidden);
  const open = useUiStore((s) => s.actionsOpen);
  const setOpen = useUiStore((s) => s.setActionsOpen);
  const { settings } = useSettingsStore();
  const { structures } = useBooksStore();
  const saveReg = useSaveStore((s) => s.current);
  const pageActions = usePageActionsStore((s) => s.actions);

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
    setOpen(false);
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
    setOpen(false);
    navigate(target);
  }

  const rows: ActionRow[] = pageActions.map((action) => ({ label: action.label, icon: action.icon, onClick: () => { setOpen(false); void action.run(); }, disabled: action.disabled }));
  if (saveReg) rows.push({ label: t("common.save"), icon: <Save className="h-4 w-4" />, disabled: !saveReg.dirty, onClick: () => { setOpen(false); void saveReg.save(); } });
  if (paragraph && chapterId) {
    const base = `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraph.number}`;
    rows.push({ label: paragraph.scriptPath ? t("chapter.openScript") : t("chapter.createScript"), onClick: () => void openOrCreate("script"), icon: <Network className="h-4 w-4" /> });
    rows.push({ label: paragraph.draftPath ? t("chapter.openDraft") : t("chapter.createDraft"), onClick: () => void openOrCreate("draft"), icon: <FileEdit className="h-4 w-4" /> });
    rows.push({ label: t("stageIndex.final"), to: base, icon: <FileText className="h-4 w-4" /> });
    rows.push({ label: t("chapter.openEvaluation"), to: `${base}/workspace/evaluation`, icon: <ClipboardCheck className="h-4 w-4" /> });
  } else if (chapter && chapterId) {
    const base = `/app/books/${bookId}/chapters/${chapterId}`;
    rows.push({ label: t("nav.scriptsIndex"), to: `${base}/scripts`, icon: <Network className="h-4 w-4" /> });
    rows.push({ label: t("nav.draftsIndex"), to: `${base}/drafts`, icon: <FileEdit className="h-4 w-4" /> });
    rows.push({ label: chapter.draftPath ? t("chapter.openDraft") : t("chapter.createDraft"), onClick: () => void openOrCreateChapter("draft"), icon: <FileEdit className="h-4 w-4" /> });
    rows.push({ label: chapter.hasResume ? t("chapter.openResume") : t("chapter.createResume"), onClick: () => void openOrCreateChapter("resume"), icon: <NotebookText className="h-4 w-4" /> });
    rows.push({ label: chapter.hasEvaluation ? t("chapter.openEvaluation") : t("chapter.createEvaluation"), onClick: () => void openOrCreateChapter("evaluation"), icon: <ClipboardCheck className="h-4 w-4" /> });
    rows.push({ label: t("writingStyle.chapterButton"), to: `${base}/writing-style`, icon: <PenLine className="h-4 w-4" /> });
  } else if (bookId) {
    rows.push({ label: t("ghostwriters.title"), to: `/app/books/${bookId}/ghostwriters`, icon: <Wand2 className="h-4 w-4" /> });
    rows.push({ label: t("writingStyle.title"), to: `/app/books/${bookId}/writing-style`, icon: <PenLine className="h-4 w-4" /> });
  }

  if (floatingHidden || rows.length === 0) return null;

  return (
    <div className="fixed bottom-20 right-4 z-40 flex flex-col items-end gap-2 lg:bottom-24 lg:right-6">
      {open && (
        <div className="w-60 max-w-[80vw] overflow-hidden rounded-2xl border bg-card p-1.5 shadow-2xl">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("bookActions.title")}</span>
            <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-muted"><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="flex flex-col">
            {book && token && paragraph && chapter && (
              <div className="px-1 py-1">
                <AssetImageDialog
                  book={book}
                  branch={branch}
                  token={token}
                  kind="paragraph"
                  title={paragraph.title}
                  chapterSlug={chapter.slug}
                  paragraphSlug={(paragraph.path.split("/").pop() ?? "").replace(/\.md$/i, "")}
                  textPath={paragraph.path}
                />
              </div>
            )}
            {book && token && chapter && !paragraph && (
              <div className="px-1 py-1">
                <AssetImageDialog
                  book={book}
                  branch={branch}
                  token={token}
                  kind="chapter"
                  title={chapter.title}
                  chapterSlug={chapter.slug}
                  textPath={`${chapter.path}/chapter.md`}
                  resumePath={`resumes/chapters/${chapter.slug}.md`}
                />
              </div>
            )}
            {book && token && !chapter && (
              <div className="flex flex-col gap-1 px-1 py-1">
                <CommitHistoryDialog token={token} owner={book.owner} repo={book.repo} branch={branch} />
                <PullRequestsDialog token={token} owner={book.owner} repo={book.repo} head={branch} base={structure?.defaultBranch ?? "main"} />
                {structure && <AssetImageDialog book={book} branch={branch} token={token} kind="book" title={structure.title ?? book.name} textPath="book.md" resumePath="resumes/total.md" />}
                {structure && <BookExportDialog book={book} structure={structure} branch={branch} token={token} />}
              </div>
            )}
            {rows.map((row, i) =>
              row.to ? (
                <Link key={i} to={row.to} onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-accent">
                  {row.icon}{row.label}
                </Link>
              ) : (
                <button key={i} type="button" onClick={row.onClick} disabled={row.disabled} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50">
                  {row.icon}{row.label}
                </button>
              ),
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-full bg-secondary px-4 py-2.5 text-sm font-medium text-secondary-foreground shadow-lg transition hover:bg-secondary/80 lg:hidden"
      >
        {open ? <ChevronUp className="h-4 w-4 rotate-180" /> : <Sparkles className="h-4 w-4" />}
        {t("bookActions.title")}
      </button>
    </div>
  );
}
