import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Download, FileText, Image, PackageCheck, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BookExportDialog } from "@/components/book/BookExportDialog";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useSettingsStore } from "@/store/settingsStore";
import { resolveBookExportProfiles, resolveBookExportSettings, resolveBookToken } from "@/types/settings";

export function BookExportPage() {
  const { t } = useTranslation();
  const { bookId } = useParams<{ bookId: string }>();
  const { settings } = useSettingsStore();
  const { book, structure, loading, error, reload } = useBookStructure(bookId);
  const { branch, ensuring } = useWorkingBranch(bookId);

  if (!book) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("bookPage.notFound")}</AlertDescription>
      </Alert>
    );
  }

  const token = resolveBookToken(book, settings);

  if (loading && !structure) return <BookExportSkeleton />;

  if (error && !structure) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={() => reload()}>{t("common.reloadBook")}</Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!structure) return <BookExportSkeleton />;

  const profiles = resolveBookExportProfiles(book);
  const selectedProfile = profiles.find((profile) => profile.id === book.defaultExportProfileId) ?? profiles[0];
  const exportSettings = resolveBookExportSettings(book, selectedProfile?.id);
  const paragraphCount = structure.chapters.reduce((sum, chapter) => sum + chapter.paragraphs.length, 0);
  const chapterImages = structure.chapters.filter((chapter) => chapter.imagePath).length;
  const paragraphImages = structure.chapters.reduce((sum, chapter) => sum + chapter.paragraphs.filter((paragraph) => paragraph.imagePath).length, 0);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
            <Link to={`/app/books/${book.id}`}><ArrowLeft className="mr-1 h-4 w-4" />{book.name}</Link>
          </Button>
          <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold tracking-tight"><Download className="h-6 w-6" />{t("export.pageTitle")}</h1>
          <p className="text-muted-foreground">{t("export.pageDescription")}</p>
        </div>
        <Badge variant={structure.loadedBranch === structure.defaultBranch ? "secondary" : "outline"}>
          {ensuring ? t("bookPage.creatingBranch") : branch}
        </Badge>
      </div>

      {!token && (
        <Alert variant="destructive">
          <AlertDescription>{t("bookPage.noTokenConfigured")}</AlertDescription>
        </Alert>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="bg-muted/30">
          <CardTitle className="flex items-center gap-2"><PackageCheck className="h-5 w-5 text-primary" />{t("export.readyTitle")}</CardTitle>
          <CardDescription>{t("export.readyDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 pt-6 md:grid-cols-[1fr_auto] md:items-center">
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>{t("export.openDialogHint")}</p>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{t("export.docx")}</Badge>
              <Badge variant="outline">{t("export.pdf")}</Badge>
              <Badge variant="outline">{t("export.epub")}</Badge>
              <Badge variant="outline">{t("export.submissionPackage")}</Badge>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <Button asChild variant="outline">
              <Link to={`/app/books/${book.id}/settings`}><Settings className="mr-1 h-4 w-4" />{t("export.configure")}</Link>
            </Button>
            {token && <BookExportDialog book={book} structure={structure} branch={branch} token={token} />}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard icon={<FileText className="h-4 w-4" />} label={t("export.scope")} value={exportSettings.defaultScope === "draft" ? t("export.publisherDraft", { count: exportSettings.sampleChapters }) : t("export.fullBook")} />
        <MetricCard icon={<Image className="h-4 w-4" />} label={t("export.imageAssets")} value={exportSettings.includeImages ? `${chapterImages}/${structure.chapters.length} ${t("export.chaptersShort")}, ${paragraphImages}/${paragraphCount} ${t("export.scenesShort")}` : t("export.imagesDisabled")} />
        <MetricCard icon={<Settings className="h-4 w-4" />} label={t("export.preset")} value={selectedProfile?.name ?? "Default"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("export.settingsSummary")}</CardTitle>
          <CardDescription>{t("export.settingsSummaryDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <SummaryRow label={t("export.fontFamily")} value={t(`reader.font${capitalize(exportSettings.fontFamily)}`)} />
          <SummaryRow label={t("export.fontName")} value={`${exportSettings.fontName}, ${exportSettings.fontSize}pt`} />
          <SummaryRow label={t("export.lineSpacing")} value={String(exportSettings.lineSpacing)} />
          <SummaryRow label={t("export.pageSize")} value={exportSettings.pageSize.toUpperCase()} />
          <SummaryRow label={t("export.lineBreakMode")} value={lineBreakLabel(exportSettings.lineBreakMode, t)} />
          <SummaryRow label={t("export.includeFrontmatter")} value={exportSettings.includeFrontmatter ? t("common.yes") : t("common.no")} />
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div className="rounded-full bg-primary/10 p-2 text-primary">{icon}</div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-1 text-sm font-medium leading-snug">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function BookExportSkeleton() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-36 w-full" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    </div>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function lineBreakLabel(mode: "book" | "dialogue" | "source", t: (key: string) => string): string {
  if (mode === "dialogue") return t("reader.lineBreakDialogue");
  if (mode === "source") return t("reader.lineBreakSource");
  return t("reader.lineBreakBook");
}
