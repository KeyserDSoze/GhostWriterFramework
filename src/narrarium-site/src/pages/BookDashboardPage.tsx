import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, ArrowLeft, BookOpen, CheckCircle2, GitBranch, Image, PackageCheck, Wand2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useAuthStore } from "@/store/authStore";
import { resolveBookExportProfiles, resolveBookExportSettings } from "@/types/settings";
import type { Chapter, Paragraph } from "@/types/book";

interface ChecklistItem {
  key: string;
  label: string;
  done: number;
  total: number;
  weight: number;
}

interface IssueItem {
  key: string;
  label: string;
  href?: string;
}

export function BookDashboardPage() {
  const { t } = useTranslation();
  const { bookId } = useParams<{ bookId: string }>();
  const { user } = useAuthStore();
  const { book, structure, loading, error, reload } = useBookStructure(bookId);
  const { branch, ensuring } = useWorkingBranch(bookId);

  if (!book) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{t("bookPage.notFound")}</AlertDescription>
      </Alert>
    );
  }

  if (loading && !structure) {
    return <DashboardSkeleton />;
  }

  if (error && !structure) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={() => reload()}>{t("common.reloadBook")}</Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!structure) return <DashboardSkeleton />;

  const paragraphs = structure.chapters.flatMap((chapter) => chapter.paragraphs.map((paragraph) => ({ chapter, paragraph })));
  const profiles = resolveBookExportProfiles(book);
  const exportSettings = resolveBookExportSettings(book);
  const hasDriveTarget = Boolean(
    user?.provider === "google"
      ? exportSettings.googleDriveFolderId
      : user?.provider === "microsoft"
        ? exportSettings.microsoftDriveFolderPath
        : exportSettings.googleDriveFolderId || exportSettings.microsoftDriveFolderPath,
  );

  const checklist: ChecklistItem[] = [
    { key: "chapters", label: t("dashboard.checkChapters"), done: structure.chapters.length > 0 ? 1 : 0, total: 1, weight: 12 },
    { key: "paragraphs", label: t("dashboard.checkParagraphs"), done: paragraphs.length > 0 ? 1 : 0, total: 1, weight: 10 },
    { key: "chapter-resumes", label: t("dashboard.checkChapterResumes"), done: count(structure.chapters, (chapter) => chapter.hasResume), total: structure.chapters.length, weight: 10 },
    { key: "chapter-evals", label: t("dashboard.checkChapterEvaluations"), done: count(structure.chapters, (chapter) => chapter.hasEvaluation), total: structure.chapters.length, weight: 10 },
    { key: "paragraph-evals", label: t("dashboard.checkParagraphEvaluations"), done: count(paragraphs, ({ paragraph }) => Boolean(paragraph.evaluationPath)), total: paragraphs.length, weight: 10 },
    { key: "paragraph-scripts", label: t("dashboard.checkParagraphScripts"), done: count(paragraphs, ({ paragraph }) => Boolean(paragraph.scriptPath)), total: paragraphs.length, weight: 7 },
    { key: "book-cover", label: t("dashboard.checkBookCover"), done: structure.bookCoverPath ? 1 : 0, total: 1, weight: 8 },
    { key: "chapter-images", label: t("dashboard.checkChapterImages"), done: count(structure.chapters, (chapter) => Boolean(chapter.imagePath)), total: structure.chapters.length, weight: 8 },
    { key: "paragraph-images", label: t("dashboard.checkParagraphImages"), done: count(paragraphs, ({ paragraph }) => Boolean(paragraph.imagePath)), total: paragraphs.length, weight: 8 },
    { key: "export", label: t("dashboard.checkExportTarget"), done: profiles.length > 0 && hasDriveTarget ? 1 : 0, total: 1, weight: 8 },
    { key: "style-plot", label: t("dashboard.checkStylePlot"), done: Number(Boolean(structure.globalWritingStylePath)) + Number(Boolean(structure.plotPath)), total: 2, weight: 7 },
  ];

  const score = computeScore(checklist);
  const issues = buildIssues({ chapters: structure.chapters, paragraphs, bookId: book.id, hasBookCover: Boolean(structure.bookCoverPath), hasDriveTarget, hasPlot: Boolean(structure.plotPath), t });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
            <Link to={`/app/books/${book.id}`}><ArrowLeft className="mr-1 h-4 w-4" />{book.name}</Link>
          </Button>
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{t("dashboard.title")}</h1>
          <p className="text-muted-foreground">{t("dashboard.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={structure.loadedBranch === structure.defaultBranch ? "secondary" : "outline"} className="gap-1">
            <GitBranch className="h-3 w-3" />
            {ensuring ? t("bookPage.creatingBranch") : branch}
          </Badge>
          <Button asChild variant="outline" size="sm"><Link to={`/app/books/${book.id}/settings`}>{t("bookPage.bookSettings")}</Link></Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><PackageCheck className="h-5 w-5 text-primary" />{t("dashboard.readiness")}</CardTitle>
            <CardDescription>{t("dashboard.readinessDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end gap-3">
              <span className="font-serif text-6xl font-semibold">{score}</span>
              <span className="pb-2 text-muted-foreground">/ 100</span>
            </div>
            <ScoreBar score={score} />
            <div className="grid gap-2">
              {checklist.map((item) => <ChecklistRow key={item.key} item={item} />)}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <MetricCard icon={<BookOpen className="h-4 w-4" />} label={t("dashboard.structure")} value={`${structure.chapters.length} / ${paragraphs.length}`} hint={t("dashboard.structureHint")} />
          <MetricCard icon={<Wand2 className="h-4 w-4" />} label={t("dashboard.editorial")} value={`${count(structure.chapters, (chapter) => chapter.hasResume && chapter.hasEvaluation)}/${structure.chapters.length}`} hint={t("dashboard.editorialHint")} />
          <MetricCard icon={<Image className="h-4 w-4" />} label={t("dashboard.assets")} value={`${count(structure.chapters, (chapter) => Boolean(chapter.imagePath))}/${structure.chapters.length}`} hint={t("dashboard.assetsHint")} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("dashboard.issues")}</CardTitle>
          <CardDescription>{t("dashboard.issuesDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {issues.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              {t("dashboard.noIssues")}
            </div>
          ) : (
            <div className="grid gap-2">
              {issues.slice(0, 30).map((issue) => (
                issue.href ? (
                  <Link key={issue.key} to={issue.href} className="rounded-lg border bg-card px-3 py-2 text-sm hover:bg-accent/50">{issue.label}</Link>
                ) : (
                  <div key={issue.key} className="rounded-lg border bg-card px-3 py-2 text-sm">{issue.label}</div>
                )
              ))}
              {issues.length > 30 && <p className="text-xs text-muted-foreground">{t("dashboard.moreIssues", { count: issues.length - 30 })}</p>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function count<T>(items: T[], predicate: (item: T) => boolean): number {
  return items.filter(predicate).length;
}

function ratio(done: number, total: number): number {
  if (total <= 0) return 1;
  return Math.max(0, Math.min(1, done / total));
}

function computeScore(items: ChecklistItem[]): number {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  const score = items.reduce((sum, item) => sum + ratio(item.done, item.total) * item.weight, 0);
  return Math.round((score / totalWeight) * 100);
}

function ScoreBar({ score }: { score: number }) {
  return <div className="h-3 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${score}%` }} /></div>;
}

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const done = ratio(item.done, item.total) >= 1;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
      <span className="flex items-center gap-2"><CheckCircle2 className={done ? "h-4 w-4 text-primary" : "h-4 w-4 text-muted-foreground"} />{item.label}</span>
      <Badge variant={done ? "secondary" : "outline"}>{item.done}/{item.total}</Badge>
    </div>
  );
}

function MetricCard({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">{icon}{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function buildIssues(input: {
  chapters: Chapter[];
  paragraphs: Array<{ chapter: Chapter; paragraph: Paragraph }>;
  bookId: string;
  hasBookCover: boolean;
  hasDriveTarget: boolean;
  hasPlot: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}): IssueItem[] {
  const { chapters, paragraphs, bookId, hasBookCover, hasDriveTarget, hasPlot, t } = input;
  const issues: IssueItem[] = [];
  if (!hasBookCover) issues.push({ key: "book-cover", label: t("dashboard.issueBookCover"), href: `/app/books/${bookId}` });
  if (!hasDriveTarget) issues.push({ key: "drive-target", label: t("dashboard.issueDriveTarget"), href: `/app/books/${bookId}/settings` });
  if (!hasPlot) issues.push({ key: "plot", label: t("dashboard.issuePlot") });
  chapters.forEach((chapter) => {
    const chapterHref = `/app/books/${bookId}/chapters/${chapter.slug}`;
    if (!chapter.hasResume) issues.push({ key: `${chapter.slug}-resume`, label: t("dashboard.issueChapterResume", { title: chapter.title }), href: chapterHref });
    if (!chapter.hasEvaluation) issues.push({ key: `${chapter.slug}-eval`, label: t("dashboard.issueChapterEvaluation", { title: chapter.title }), href: chapterHref });
    if (!chapter.imagePath) issues.push({ key: `${chapter.slug}-image`, label: t("dashboard.issueChapterImage", { title: chapter.title }), href: chapterHref });
  });
  paragraphs.forEach(({ chapter, paragraph }) => {
    const href = `/app/books/${bookId}/chapters/${chapter.slug}/paragraphs/${paragraph.number}`;
    const title = `${chapter.title} / ${paragraph.title}`;
    if (!paragraph.evaluationPath) issues.push({ key: `${paragraph.path}-eval`, label: t("dashboard.issueParagraphEvaluation", { title }), href });
    if (!paragraph.scriptPath) issues.push({ key: `${paragraph.path}-script`, label: t("dashboard.issueParagraphScript", { title }), href });
    if (!paragraph.imagePath) issues.push({ key: `${paragraph.path}-image`, label: t("dashboard.issueParagraphImage", { title }), href });
  });
  return issues;
}

function DashboardSkeleton() {
  return <div className="space-y-4"><Skeleton className="h-20 w-full" /><Skeleton className="h-80 w-full" /><Skeleton className="h-48 w-full" /></div>;
}
