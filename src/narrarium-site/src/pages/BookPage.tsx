import { useEffect } from "react";
import { useParams, Link } from "react-router-dom";
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
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { loadBookStructure, loadFileContent, slugToTitle } from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { type BookFile } from "@/types/book";
import { useDossierStore } from "@/store/dossierStore";

function useBookStructure(bookId: string) {
  const { settings } = useSettingsStore();
  const { structures, loadingIds, errors, setStructure, setLoading, setError } =
    useBooksStore();

  const book = settings.books.find((b) => b.id === bookId);
  const structure = structures[bookId];
  const loading = loadingIds.has(bookId);
  const error = errors[bookId];

  useEffect(() => {
    if (!book || structure || loading) return;
    const token =
      book.tokenIndex === null
        ? settings.defaultGitHubToken
        : (settings.extraGitHubTokens[book.tokenIndex]?.token ?? "");

    if (!token) {
      setError(bookId, "No GitHub token configured for this book.");
      return;
    }

    setLoading(bookId, true);
    loadBookStructure(token, book.owner, book.repo)
      .then((s) => setStructure(bookId, s))
      .catch((err: unknown) =>
        setError(bookId, err instanceof Error ? err.message : "Load failed"),
      )
      .finally(() => setLoading(bookId, false));
  }, [book, bookId, loading, settings, setError, setLoading, setStructure, structure]);

  return { book, structure, loading, error };
}

function CanonList({
  files,
  emptyLabel,
  section,
  onOpen,
}: {
  label?: string;
  files: BookFile[];
  emptyLabel: string;
  section: string;
  onOpen: (section: string, file: BookFile) => void;
}) {
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
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">{f.path}</span>
            <Button variant="ghost" size="sm" onClick={() => onOpen(section, f)}>
              Open dossier
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function BookPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { settings } = useSettingsStore();
  const { toast } = useToast();
  const pinDossier = useDossierStore((state) => state.pinDossier);
  const { book, structure, loading, error } = useBookStructure(bookId ?? "");
  // Kick off branch creation as soon as the structure is available
  const { branch, ensuring } = useWorkingBranch(bookId);

  if (!book) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>Book not found.</AlertDescription>
      </Alert>
    );
  }

  const token =
    book.tokenIndex === null
      ? settings.defaultGitHubToken
      : (settings.extraGitHubTokens[book.tokenIndex]?.token ?? "");

  async function handleOpenDossier(section: string, file: BookFile) {
    if (!structure || !token) return;
    try {
      const content = await loadFileContent(token, book!.owner, book!.repo, file.path);
      pinDossier({
        id: file.path,
        title: slugToTitle(file.path.split("/").pop()?.replace(/\.md$/, "") ?? file.path),
        section,
        path: file.path,
        content,
      });
    } catch (err) {
      toast({ title: "Dossier load failed", description: String(err), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
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
            {ensuring ? "Creating branch…" : branch}
          </p>
        </div>
        {loading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && !structure && <BookSkeleton />}

      {structure && (
        <Tabs defaultValue="chapters">
          <TabsList className="flex-wrap h-auto gap-1">
            <TabsTrigger value="chapters">
              <BookOpen className="mr-1 h-3 w-3" />
              Chapters
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.chapters.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="characters">
              <Users className="mr-1 h-3 w-3" />
              Characters
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.characters.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="locations">
              <MapPin className="mr-1 h-3 w-3" />
              Locations
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.locations.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="factions">
              <Shield className="mr-1 h-3 w-3" />
              Factions
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.factions.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="items">
              <Package className="mr-1 h-3 w-3" />
              Items
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.items.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="timelines">
              <Clock className="mr-1 h-3 w-3" />
              Timelines
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.timelines.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="secrets">
              <EyeOff className="mr-1 h-3 w-3" />
              Secrets
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {structure.secrets.length}
              </Badge>
            </TabsTrigger>
          </TabsList>

          {/* ── Chapters ── */}
          <TabsContent value="chapters" className="mt-4">
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
                          {ch.draftPath && " · draft"}
                          {ch.hasResume && " · resume"}
                          {ch.hasEvaluation && " · eval"}
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
                No chapters found in this repository.
              </p>
            )}
          </TabsContent>

          <TabsContent value="characters" className="mt-4">
            <CanonList
              label="Characters"
              files={structure.characters}
              emptyLabel="No characters found."
              section="characters"
              onOpen={handleOpenDossier}
            />
          </TabsContent>

          <TabsContent value="locations" className="mt-4">
            <CanonList
              label="Locations"
              files={structure.locations}
              emptyLabel="No locations found."
              section="locations"
              onOpen={handleOpenDossier}
            />
          </TabsContent>

          <TabsContent value="factions" className="mt-4">
            <CanonList
              label="Factions"
              files={structure.factions}
              emptyLabel="No factions found."
              section="factions"
              onOpen={handleOpenDossier}
            />
          </TabsContent>

          <TabsContent value="items" className="mt-4">
            <CanonList
              label="Items"
              files={structure.items}
              emptyLabel="No items found."
              section="items"
              onOpen={handleOpenDossier}
            />
          </TabsContent>

          <TabsContent value="timelines" className="mt-4">
            <CanonList
              label="Timelines"
              files={structure.timelines}
              emptyLabel="No timeline files found."
              section="timelines"
              onOpen={handleOpenDossier}
            />
          </TabsContent>

          <TabsContent value="secrets" className="mt-4">
            <CanonList
              label="Secrets"
              files={structure.secrets}
              emptyLabel="No secrets found."
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
