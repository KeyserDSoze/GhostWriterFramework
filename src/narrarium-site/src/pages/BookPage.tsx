import { useParams, Link, useLocation } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseDocument, stringify } from "yaml";
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
  Save,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { createFile, readFileWithSha, slugToTitle, updateFile } from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { type BookFile } from "@/types/book";
import { resolveBookToken } from "@/types/settings";
import { openCanonDossier } from "@/narrarium/openDossier";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useRegisterPageSave } from "@/store/saveStore";
import { GhostwriterField } from "@/components/book/GhostwriterField";
import {
  createCanonEntity,
  createChapter as createChapterFile,
  formatOrdinal,
  type EntityKind,
} from "@/narrarium/canon";
import { CreateChapterDialog } from "@/components/canon/CreateChapterDialog";
import { CreateEntityDialog } from "@/components/canon/CreateEntityDialog";
import { ChapterReorderList } from "@/components/book/ChapterReorderList";

function fileSlug(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

function splitMarkdownDoc(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  try {
    return { frontmatter: (parseDocument(match[1]).toJSON() as Record<string, unknown>) ?? {}, body: match[2].replace(/^\s*\n/, "") };
  } catch {
    return { frontmatter: {}, body: match[2].replace(/^\s*\n/, "") };
  }
}

function buildMarkdownDoc(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}

function metaString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
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
          <Link to={`/app/books/${bookId}/canon/${section}/${fileSlug(f.path)}`} className="font-medium hover:underline">
            {f.name ?? slugToTitle(f.path.split("/").pop()?.replace(/\.md$/, "") ?? f.path)}
          </Link>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground lg:inline">{f.path}</span>
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
  const location = useLocation();
  const SECTIONS = ["chapters", "characters", "locations", "factions", "items", "timelines", "secrets"];
  const [section, setSection] = useState("chapters");
  useEffect(() => {
    const hash = location.hash.replace(/^#/, "");
    if (hash && SECTIONS.includes(hash)) setSection(hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash]);
  const { settings } = useSettingsStore();
  const { toast } = useToast();
  const { book, structure, loading, error, reload } = useBookStructure(bookId ?? "");
  // Kick off branch creation as soon as the structure is available
  const { branch, ensuring } = useWorkingBranch(bookId);
  const token = book ? resolveBookToken(book, settings) : "";

  const [bookFrontmatter, setBookFrontmatter] = useState<Record<string, unknown>>({});
  const [bookBody, setBookBody] = useState("");
  const [savedBookFrontmatter, setSavedBookFrontmatter] = useState<Record<string, unknown>>({});
  const [savedBookBody, setSavedBookBody] = useState("");
  const [bookSha, setBookSha] = useState("");
  const [bookDocLoading, setBookDocLoading] = useState(false);
  const [bookDocSaving, setBookDocSaving] = useState(false);
  const loadedBookDocRef = useRef("");

  const bookDocDirty = bookBody !== savedBookBody || JSON.stringify(bookFrontmatter) !== JSON.stringify(savedBookFrontmatter);

  useEffect(() => {
    if (!book || !token) return;
    const key = `${book.id}:${branch}:book.md`;
    if (loadedBookDocRef.current === key) return;
    loadedBookDocRef.current = key;
    setBookDocLoading(true);
    readFileWithSha(token, book.owner, book.repo, branch, "book.md")
      .then(({ content, sha }) => {
        const { frontmatter, body } = splitMarkdownDoc(content);
        setBookFrontmatter(frontmatter);
        setBookBody(body);
        setSavedBookFrontmatter(frontmatter);
        setSavedBookBody(body);
        setBookSha(sha);
      })
      .catch(() => {
        const fallback = {
          type: "book",
          title: structure?.title ?? book.name,
          language: structure?.language ?? settings.ui.language ?? "en",
          ...(structure?.ghostwriter ? { ghostwriter: structure.ghostwriter } : {}),
        };
        setBookFrontmatter(fallback);
        setBookBody(structure?.description ?? "");
        setSavedBookFrontmatter(fallback);
        setSavedBookBody(structure?.description ?? "");
        setBookSha("");
      })
      .finally(() => setBookDocLoading(false));
  }, [book, token, branch, structure?.title, structure?.description, structure?.language, structure?.ghostwriter, settings.ui.language]);

  function patchBookFrontmatter(key: string, value: string) {
    setBookFrontmatter((prev) => {
      const next = { ...prev };
      if (key === "ghostwriter" && !value) delete next.ghostwriter;
      else next[key] = value;
      return next;
    });
  }

  async function saveBookDoc() {
    if (!book || !token || !bookDocDirty) return;
    setBookDocSaving(true);
    try {
      const nextFrontmatter = {
        ...bookFrontmatter,
        title: metaString(bookFrontmatter.title).trim() || structure?.title || book.name,
      };
      const content = buildMarkdownDoc(nextFrontmatter, bookBody);
      const nextSha = bookSha
        ? await updateFile(token, book.owner, book.repo, branch, "book.md", bookSha, content, "Update book metadata")
        : await createFile(token, book.owner, book.repo, branch, "book.md", content, "Create book metadata");
      setBookSha(nextSha);
      setBookFrontmatter(nextFrontmatter);
      setSavedBookFrontmatter(nextFrontmatter);
      setSavedBookBody(bookBody);
      toast({ title: t("common.saved") });
      reload();
    } catch (err) {
      toast({ title: t("common.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBookDocSaving(false);
    }
  }

  useRegisterPageSave({ dirty: bookDocDirty, enabled: Boolean(book && token), onSave: () => saveBookDoc() });

  if (!book) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{t("bookPage.notFound")}</AlertDescription>
      </Alert>
    );
  }

  const displayTitle = metaString(bookFrontmatter.title).trim() || structure?.title || book.name;
  const displayDescription = bookBody.trim() || structure?.description;
  const currentGhostwriter = metaString(bookFrontmatter.ghostwriter);

  async function handleOpenDossier(section: string, file: BookFile) {
    if (!structure || !token || !bookId) return;
    try {
      await openCanonDossier({ token, owner: book!.owner, repo: book!.repo, branch, bookId, section, file });
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
            {displayTitle}
          </h1>
          {displayDescription && (
            <p className="text-muted-foreground">{displayDescription}</p>
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
        <section className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t("bookPage.bookMetadata")}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">book.md</p>
            </div>
            <div className="flex items-center gap-2">
              {bookDocDirty && !bookDocSaving && <span className="text-xs text-muted-foreground">{t("common.unsaved")}</span>}
              <Button size="sm" onClick={() => void saveBookDoc()} disabled={!bookDocDirty || bookDocSaving || bookDocLoading}>
                {bookDocSaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                {t("common.save")}
              </Button>
            </div>
          </div>
          {bookDocLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[1fr_180px]">
              <div className="space-y-2">
                <Label htmlFor="book-title">{t("bookPage.titleField")}</Label>
                <Input
                  id="book-title"
                  value={metaString(bookFrontmatter.title)}
                  onChange={(event) => patchBookFrontmatter("title", event.target.value)}
                  placeholder={book.name}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="book-language">{t("bookPage.languageField")}</Label>
                <Input
                  id="book-language"
                  value={metaString(bookFrontmatter.language)}
                  onChange={(event) => patchBookFrontmatter("language", event.target.value)}
                  placeholder="en"
                />
              </div>
              <div className="lg:col-span-2">
                <GhostwriterField ghostwriters={structure.ghostwriters} value={currentGhostwriter} onChange={(slug) => patchBookFrontmatter("ghostwriter", slug)} />
              </div>
              <div className="space-y-2 lg:col-span-2">
                <Label htmlFor="book-description">{t("bookPage.descriptionField")}</Label>
                <AutoTextarea
                  id="book-description"
                  value={bookBody}
                  onChange={(event) => setBookBody(event.target.value)}
                  className="min-h-28 text-sm leading-6"
                  placeholder={t("bookPage.descriptionPlaceholder")}
                />
              </div>
            </div>
          )}
        </section>
      )}

      {structure && (
        <Tabs value={section} onValueChange={setSection}>
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
            {book && token && structure.chapters.length > 0 ? (
              <ChapterReorderList
                bookId={bookId ?? ""}
                book={book}
                token={token}
                branch={branch}
                chapters={structure.chapters}
                onReordered={() => void reload()}
              />
            ) : (
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
            )}
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
