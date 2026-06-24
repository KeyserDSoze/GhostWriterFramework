import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  AlertCircle,
  BookOpen,
  Users,
  MapPin,
  Shield,
  Package,
  Clock,
  EyeOff,
  FileText,
  ChevronRight,
  Settings,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { loadFileContent, slugToTitle } from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { type BookFile } from "@/types/book";
import { resolveBookToken } from "@/types/settings";
import { useDossierStore } from "@/store/dossierStore";
import { useBookStructure } from "@/hooks/useBookStructure";
import {
  createCanonEntity,
  createChapter as createChapterFile,
  formatOrdinal,
  type EntityKind,
} from "@/narrarium/canon";
import { CreateChapterDialog } from "@/components/canon/CreateChapterDialog";
import { CreateEntityDialog } from "@/components/canon/CreateEntityDialog";
import { PullRequestsDialog } from "@/components/github/PullRequestsDialog";
import { CommitHistoryDialog } from "@/components/github/CommitHistoryDialog";

function fileSlug(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

function CanonList({
  bookId,
  files,
  emptyLabel,
  section,
  onOpen,
}: {
  bookId: string;
  label?: string;
  files: BookFile[];
  emptyLabel: string;
  section: string;
  onOpen: (section: string, file: BookFile) => void;
}) {
  const { t } = useTranslation();
  if (files.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">{emptyLabel}</p>
    );
  }
  return (
    <ul className="divide-y">
      {files.map((f) => (
        <li
          key={f.path}
          className="flex items-center justify-between py-2 text-sm"
        >
          <span className="font-medium">
            {slugToTitle(f.path.split("/").pop()?.replace(/\.md$/, "") ?? f.path)}
          </span>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground lg:inline">{f.path}</span>
            <Button asChild variant="ghost" size="sm">
              <Link to={`/app/books/${bookId}/canon/${section}/${fileSlug(f.path)}`}>{t("common.edit")}</Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onOpen(section, f)}>
              {t("common.openDossier")}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function BookPage() {
  const { t } = useTranslation();
  const { bookId } = useParams<{ bookId: string }>();
  const { settings } = useSettingsStore();
  const { toast } = useToast();
  const pinDossier = useDossierStore((state) => state.pinDossier);
  const { book, structure, loading, error, reload } = useBookStructure(bookId ?? "");
  // Kick off branch creation as soon as the structure is available
  const { branch, ensuring } = useWorkingBranch(bookId);

  if (!book) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{t("bookPage.notFound")}</AlertDescription>
      </Alert>
    );
  }

  const token = resolveBookToken(book, settings);

  async function handleOpenDossier(section: string, file: BookFile) {
    if (!structure || !token) return;
    try {
      const content = await loadFileContent(token, book!.owner, book!.repo, file.path, branch);
      pinDossier({
        id: file.path,
        title: slugToTitle(file.path.split("/").pop()?.replace(/\.md$/, "") ?? file.path),
        section,
        path: file.path,
        content,
      });
    } catch (err) {
      toast({ title: t("bookPage.dossierLoadFailed"), description: String(err), variant: "destructive" });
    }
  }

  async function handleCreateChapter(input: {
    number: number;
    title: string;
    summary?: string;
  }) {
    if (!book || !token) throw new Error(t("bookPage.noTokenConfigured"));
    await createChapterFile(token, book.owner, book.repo, branch, input);
    toast({ title: t("bookPage.chapterCreated", { number: formatOrdinal(input.number) }) });
    reload();
  }

  function makeCreateEntity(kind: EntityKind) {
    return async (input: {
      label: string;
      summary?: string;
      extraFrontmatter?: Record<string, unknown>;
    }) => {
      if (!book || !token) throw new Error(t("bookPage.noTokenConfigured"));
      await createCanonEntity(token, book.owner, book.repo, branch, {
        kind,
        label: input.label,
        summary: input.summary,
        extraFrontmatter: input.extraFrontmatter,
      });
      toast({ title: t("bookPage.created", { label: input.label }) });
      reload();
    };
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {structure?.title ?? book.name}
          </h1>
          {structure?.description && (
            <p className="text-muted-foreground">{structure.description}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {book.owner}/{book.repo}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground font-mono">
            {ensuring ? t("bookPage.creatingBranch") : branch}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("bookPage.token")}{" "}
            {book.bookToken
              ? `${t("bookPage.dedicatedPatLabel")}${book.bookTokenLabel ? ` · ${book.bookTokenLabel}` : ""}`
              : book.tokenIndex != null
                ? settings.extraGitHubTokens[book.tokenIndex]?.label ?? t("bookPage.savedToken")
                : t("bookPage.defaultToken")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {loading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
          <CommitHistoryDialog
            token={token}
            owner={book.owner}
            repo={book.repo}
            branch={branch}
          />
          <PullRequestsDialog
            token={token}
            owner={book.owner}
            repo={book.repo}
            head={branch}
            base={structure?.defaultBranch ?? "main"}
          />
          <Button asChild variant="outline" size="sm">
            <Link to={`/app/books/${book.id}/settings`}>
              <Settings className="mr-1 h-4 w-4" />
              {t("bookPage.bookSettings")}
            </Link>
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => reload()}>
              {t("common.reloadBook")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loading && !structure && <BookSkeleton />}

      {structure && (
        <Tabs defaultValue="chapters">
          <TabsList className="flex-wrap h-auto gap-1">
            <TabsTrigger value="chapters">
              <BookOpen className="mr-1 h-3 w-3" />
              {t("bookPage.chapters")}
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.chapters.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="characters">
              <Users className="mr-1 h-3 w-3" />
              {t("bookPage.characters")}
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.characters.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="locations">
              <MapPin className="mr-1 h-3 w-3" />
              {t("bookPage.locations")}
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.locations.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="factions">
              <Shield className="mr-1 h-3 w-3" />
              {t("bookPage.factions")}
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.factions.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="items">
              <Package className="mr-1 h-3 w-3" />
              {t("bookPage.items")}
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.items.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="timelines">
              <Clock className="mr-1 h-3 w-3" />
              {t("bookPage.timelines")}
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.timelines.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="secrets">
              <EyeOff className="mr-1 h-3 w-3" />
              {t("bookPage.secrets")}
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.secrets.length}
              </Badge>
            </TabsTrigger>
          </TabsList>

          {/* ── Chapters ── */}
          <TabsContent value="chapters" className="mt-4">
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {structure.chapters.length} chapter
                {structure.chapters.length !== 1 ? "s" : ""}
              </p>
              <CreateChapterDialog
                nextNumber={structure.chapters.length + 1}
                onCreate={handleCreateChapter}
              />
            </div>
            <ul className="space-y-2">
              {structure.chapters.map((ch) => (
                <li key={ch.slug}>
                  <Link
                    to={`/app/books/${bookId}/chapters/${ch.slug}`}
                    className="flex items-center justify-between rounded-lg border bg-card px-4 py-3 text-sm hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-medium">{ch.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {ch.paragraphs.length} paragraph
                          {ch.paragraphs.length !== 1 ? "s" : ""}
                          {ch.draftPath && ` · ${t("bookPage.draft")}`}
                          {ch.hasResume && ` · ${t("bookPage.resume")}`}
                          {ch.hasEvaluation && ` · ${t("bookPage.eval")}`}
                        </p>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
            {structure.chapters.length === 0 && (
              <p className="text-sm text-muted-foreground py-4">
                {t("bookPage.noChapters")}
              </p>
            )}
          </TabsContent>

          <TabsContent value="characters" className="mt-4">
            <div className="mb-3 flex justify-end">
              <CreateEntityDialog kind="character" onCreate={makeCreateEntity("character")} />
            </div>
            <CanonList
              bookId={bookId ?? ""}
              label="Characters"
              files={structure.characters}
              emptyLabel={t("bookPage.noCharacters")}
              section="characters"
              onOpen={handleOpenDossier}
            />
          </TabsContent>

          <TabsContent value="locations" className="mt-4">
            <div className="mb-3 flex justify-end">
              <CreateEntityDialog kind="location" onCreate={makeCreateEntity("location")} />
            </div>
            <CanonList
              bookId={bookId ?? ""}
              label="Locations"
              files={structure.locations}
              emptyLabel={t("bookPage.noLocations")}
              section="locations"
              onOpen={handleOpenDossier}
            />
          </TabsContent>

          <TabsContent value="factions" className="mt-4">
            <div className="mb-3 flex justify-end">
              <CreateEntityDialog kind="faction" onCreate={makeCreateEntity("faction")} />
            </div>
            <CanonList
              bookId={bookId ?? ""}
              label="Factions"
              files={structure.factions}
              emptyLabel={t("bookPage.noFactions")}
              section="factions"
              onOpen={handleOpenDossier}
            />
          </TabsContent>

          <TabsContent value="items" className="mt-4">
            <div className="mb-3 flex justify-end">
              <CreateEntityDialog kind="item" onCreate={makeCreateEntity("item")} />
            </div>
            <CanonList
              bookId={bookId ?? ""}
              label="Items"
              files={structure.items}
              emptyLabel={t("bookPage.noItems")}
              section="items"
              onOpen={handleOpenDossier}
            />
          </TabsContent>

          <TabsContent value="timelines" className="mt-4">
            <div className="mb-3 flex justify-end">
              <CreateEntityDialog
                kind="timeline-event"
                onCreate={makeCreateEntity("timeline-event")}
                triggerLabel={t("bookPage.addTimelineEvent")}
              />
            </div>
            <CanonList
              bookId={bookId ?? ""}
              label="Timelines"
              files={structure.timelines}
              emptyLabel={t("bookPage.noTimeline")}
              section="timelines"
              onOpen={handleOpenDossier}
            />
          </TabsContent>

          <TabsContent value="secrets" className="mt-4">
            <div className="mb-3 flex justify-end">
              <CreateEntityDialog kind="secret" onCreate={makeCreateEntity("secret")} />
            </div>
            <CanonList
              bookId={bookId ?? ""}
              label="Secrets"
              files={structure.secrets}
              emptyLabel={t("bookPage.noSecrets")}
              section="secrets"
              onOpen={handleOpenDossier}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function BookSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-lg" />
      ))}
    </div>
  );
}
