import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search, Loader2, Github, Lock, Globe, Plus, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSettingsStore } from "@/store/settingsStore";
import { useSettings } from "@/drive/useSettings";
import { useRepositories } from "@/github/useRepositories";
import type { RepoSummary } from "@/github/githubClient";
import { BookRepositoryError, createCompleteBookRepository, deleteEmptyBookRepository, isBookRepositoryError, repositoryNameProblem, type BookRepositoryProgress, type CreateCompleteBookRepositoryResult } from "@/github/bookRepository";
import { GitHubRepositoryPanel, defaultGitHubRepositoryChoices, ownerOf, useGitHubPreflight, type GitHubRepositoryChoices } from "@/components/book/GitHubRepositoryPanel";
import { GitHubCreateFailure, GitHubCreateProgress, GitHubCreateResult } from "@/components/book/GitHubRepositoryOutcome";
import "@/i18n/githubCreateBook";
import { type BookEntry } from "@/types/settings";
import { createLocalOnlyBookRepository } from "@/repository/repositoryService";
import { defaultRepositoryName } from "@/narrarium/bookScaffold";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { StartSizePicker } from "@/components/book/StartSizePicker";
import { presetOutlineFiles } from "@/autopilot/outlineBrief";
import type { AutopilotPresetId } from "narrarium-engine";

export function AddBookPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { settings } = useSettingsStore();
  const { save } = useSettings();
  const { patchSettings } = useSettingsStore();

  // Token selection: "default", "custom" (inline per-book PAT), or index of extraGitHubTokens
  const [selectedToken, setSelectedToken] = useState("default");
  const [customToken, setCustomToken] = useState("");
  const [customTokenLabel, setCustomTokenLabel] = useState("");
  const [newBookTitle, setNewBookTitle] = useState("");
  const [newRepoName, setNewRepoName] = useState("");
  const [repoNameEdited, setRepoNameEdited] = useState(false);
  const [repoChoices, setRepoChoices] = useState<GitHubRepositoryChoices>(defaultGitHubRepositoryChoices);
  const [progress, setProgress] = useState<BookRepositoryProgress | null>(null);
  const [failure, setFailure] = useState<BookRepositoryError | null>(null);
  const [created, setCreated] = useState<{ result: CreateCompleteBookRepositoryResult; bookId: string } | null>(null);
  const failureOwner = useRef("");
  const [storageMode, setStorageMode] = useState<"local-only" | "github">("local-only");
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // The size a new book starts from: its words per scene, its review settings and one empty chapter entry per chapter. Nothing for none.
  const [startSize, setStartSize] = useState<AutopilotPresetId | null>(null);

  const activeToken =
    selectedToken === "default"
      ? settings.defaultGitHubToken
      : selectedToken === "custom"
        ? customToken.trim()
        : settings.extraGitHubTokens[Number(selectedToken)]?.token ?? "";

  const preflight = useGitHubPreflight(storageMode === "github" ? activeToken || undefined : undefined);
  const nameProblem = storageMode === "github" && newRepoName.trim() ? repositoryNameProblem(newRepoName) : null;

  const { repos, loading, error } = useRepositories(
    storageMode === "github" ? activeToken || undefined : undefined,
  );

  const hasPrivateRepos = repos.some((r) => r.private);
  const hasPublicRepos = repos.some((r) => !r.private);
  const showScopeHint =
    activeToken && !loading && !error && hasPublicRepos && !hasPrivateRepos;

  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    if (!repoNameEdited) setNewRepoName(defaultRepositoryName(newBookTitle));
  }, [newBookTitle, repoNameEdited]);

  const filtered = repos.filter(
    (r) =>
      r.full_name.toLowerCase().includes(search.toLowerCase()) ||
      (r.description ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  async function handleAdd(repo: RepoSummary) {
    setAdding(repo.full_name);
    const usingCustom = selectedToken === "custom";
    const entry: BookEntry = {
      id: crypto.randomUUID(),
      owner: repo.owner,
      repo: repo.name,
      name: repo.name,
      tokenIndex:
        selectedToken === "default" || usingCustom ? null : Number(selectedToken),
      bookToken: usingCustom ? customToken.trim() : undefined,
      bookTokenLabel: usingCustom
        ? customTokenLabel.trim() || `${repo.name} PAT`
        : undefined,
      addedAt: new Date().toISOString(),
    };
    const next = [...settings.books, entry];
    patchSettings({ books: next });
    try {
      await save();
      navigate(`/app/books/${entry.id}`);
    } finally {
      setAdding(null);
    }
  }

  async function handleCreateNewBook(retry = false) {
    const title = newBookTitle.trim();
    const repoName = newRepoName.trim();
    if (!title || (storageMode === "github" && (!repoName || !activeToken || repositoryNameProblem(repoName)))) return;
    setCreateError(null);
    setFailure(null);
    setCreatingRepo(true);
    try {
      if (storageMode === "local-only") {
        const id = crypto.randomUUID();
        const localRepositoryId = crypto.randomUUID();
        const entry: BookEntry = {
          id,
          storageMode: "local-only",
          localRepositoryId,
          owner: "",
          repo: "",
          name: title,
          tokenIndex: null,
          activeBranch: `local:${localRepositoryId}`,
          startPreset: startSize ?? undefined,
          addedAt: new Date().toISOString(),
        };
        await createLocalOnlyBookRepository({ book: entry, accountIdentity: localWorkspaceScope(), title, language: settings.ui.language, files: startSize ? presetOutlineFiles(startSize) : undefined });
        patchSettings({ books: [...settings.books, entry] });
        await save();
        navigate(`/app/books/${entry.id}`);
        return;
      }
      failureOwner.current = ownerOf(repoChoices) ?? "";
      setProgress({ step: "repository" });
      // The template is a chunk of its own (about 400 KB): it is fetched here, when a repository is made, and by no other page.
      const { loadBookTemplate, composeCompleteBookFiles } = await import("@/narrarium/bookTemplate");
      const files = composeCompleteBookFiles(await loadBookTemplate(), { title, language: settings.ui.language, files: startSize ? presetOutlineFiles(startSize) : undefined });
      const result = await createCompleteBookRepository({
        token: activeToken,
        owner: ownerOf(repoChoices),
        name: repoName,
        description: `Narrarium book: ${title}`,
        visibility: repoChoices.visibility,
        files,
        existing: retry ? "empty" : "error",
        pages: repoChoices.pages ? "enable" : "skip",
        onProgress: setProgress,
      });
      const usingCustom = selectedToken === "custom";
      const entry: BookEntry = {
        id: crypto.randomUUID(),
        owner: result.owner,
        repo: result.repo,
        name: title,
        tokenIndex: selectedToken === "default" || usingCustom ? null : Number(selectedToken),
        bookToken: usingCustom ? customToken.trim() : undefined,
        bookTokenLabel: usingCustom ? customTokenLabel.trim() || `${result.repo} PAT` : undefined,
        activeBranch: result.defaultBranch,
        startPreset: startSize ?? undefined,
        addedAt: new Date().toISOString(),
      };
      patchSettings({ books: [...settings.books, entry] });
      setCreated({ result, bookId: entry.id });
      await save();
    } catch (err) {
      if (storageMode === "github") setFailure(isBookRepositoryError(err) ? err : new BookRepositoryError(err instanceof TypeError ? "network" : "unknown", { cause: err }));
      else setCreateError(String(err));
    } finally {
      setCreatingRepo(false);
      setProgress(null);
    }
  }

  async function handleDeleteEmptyRepository() {
    const empty = failure?.repository;
    if (!empty) return;
    await deleteEmptyBookRepository({ token: activeToken, owner: empty.owner, repo: empty.repo, defaultBranch: empty.defaultBranch });
  }

  const noDefaultToken = !settings.defaultGitHubToken && selectedToken === "default";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("addBook.title")}</h1>
        <p className="text-muted-foreground">
          {t("addBook.subtitle")}
        </p>
      </div>

      {storageMode === "github" && noDefaultToken && (
        <Alert variant="destructive">
          <AlertDescription>
            {t("addBook.noDefaultToken")}{" "}
            <Link className="underline" to="/app/settings">
              {t("addBook.goToSettings")}
            </Link>{" "}
            {t("addBook.toAddOne")}
          </AlertDescription>
        </Alert>
      )}

      {showScopeHint && (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertDescription>
            {t("addBook.privateHint1")}{" "}
            <strong>
              <code>repo</code>
            </strong>{" "}
            {t("addBook.privateHint2")}{" "}
            <strong>{t("addBook.allRepositories")}</strong>.{" "}
            <Link className="underline" to="/app/settings">
              {t("addBook.updateToken")}
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-2 sm:max-w-xs">
        <Label>{settings.ui.language === "it" ? "Archiviazione" : "Storage"}</Label>
        <Select value={storageMode} onValueChange={(value) => setStorageMode(value as "local-only" | "github")}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="local-only">{settings.ui.language === "it" ? "Solo questo dispositivo" : "This device only"}</SelectItem><SelectItem value="github">GitHub</SelectItem></SelectContent>
        </Select>
      </div>

      {/* Token picker */}
      {storageMode === "github" && <div className="grid gap-2">
        <Label>{t("addBook.tokenToUse")}</Label>
        <Select value={selectedToken} onValueChange={setSelectedToken}>
          <SelectTrigger className="w-full sm:max-w-xs">
            <SelectValue placeholder={t("addBook.selectToken")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">
              {t("addBook.defaultToken")}
              {settings.defaultGitHubToken
                ? ` (…${settings.defaultGitHubToken.slice(-4)})`
                : t("addBook.notSet")}
            </SelectItem>
            {settings.extraGitHubTokens.map((t, i) => (
              <SelectItem key={i} value={String(i)}>
                {t.label} (…{t.token.slice(-4)})
              </SelectItem>
            ))}
            <SelectItem value="custom">{t("addBook.dedicatedPat")}</SelectItem>
          </SelectContent>
        </Select>

        {selectedToken === "custom" && (
          <div className="mt-2 grid gap-2 rounded-lg border border-dashed p-3">
            <p className="text-xs text-muted-foreground">
              {t("addBook.dedicatedHint")}
            </p>
            <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
              <Input
                placeholder={t("addBook.labelOptional")}
                value={customTokenLabel}
                onChange={(e) => setCustomTokenLabel(e.target.value)}
              />
              <Input
                type="password"
                placeholder="github_pat_…"
                value={customToken}
                onChange={(e) => setCustomToken(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
        )}
      </div>}

      {created ? <GitHubCreateResult result={created.result} onOpenBook={() => navigate(`/app/books/${created.bookId}`)} /> : <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Plus className="h-5 w-5" />{t("addBook.createNew")}</CardTitle>
          <CardDescription>{t("addBook.createNewDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>{t("addBook.bookTitle")}</Label>
              <Input value={newBookTitle} onChange={(e) => setNewBookTitle(e.target.value)} placeholder={t("addBook.bookTitlePlaceholder")} />
            </div>
            {storageMode === "github" && <div className="grid gap-2">
              <Label>{t("addBook.repositoryName")}</Label>
              <Input value={newRepoName} aria-invalid={nameProblem ? true : undefined} aria-describedby="add-book-repo-name-hint" onChange={(e) => { setRepoNameEdited(true); setNewRepoName(e.target.value); }} placeholder="book-my-story" />
              <p id="add-book-repo-name-hint" className={nameProblem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{nameProblem ? t(`github.createBook.panel.nameProblem.${nameProblem}`) : newRepoName.trim() ? t("addBook.repoNameHint") : t("addBook.repoNameHintEmpty")}</p>
            </div>}
          </div>
          <StartSizePicker value={startSize} onChange={setStartSize} />
          {storageMode === "github" && <GitHubRepositoryPanel choices={repoChoices} onChange={setRepoChoices} preflight={preflight} disabled={creatingRepo} hasToken={Boolean(activeToken)} />}
          {createError && <Alert variant="destructive"><AlertDescription>{createError}</AlertDescription></Alert>}
          {storageMode === "github" && <GitHubCreateProgress progress={progress} busy={creatingRepo} />}
          {failure && <GitHubCreateFailure error={failure} owner={failureOwner.current} repo={newRepoName.trim()} busy={creatingRepo} onRetry={() => void handleCreateNewBook(true)} onDelete={handleDeleteEmptyRepository} />}
          <Button className="w-full sm:w-fit [@media(pointer:coarse)]:h-11" onClick={() => void handleCreateNewBook()} disabled={creatingRepo || !newBookTitle.trim() || (storageMode === "github" && (!activeToken || !newRepoName.trim() || Boolean(nameProblem)))}>
            {creatingRepo ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : storageMode === "local-only" ? <HardDrive className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
            {creatingRepo ? t("addBook.creatingRepo") : storageMode === "local-only" ? (settings.ui.language === "it" ? "Crea libro locale" : "Create local book") : t("addBook.createRepo")}
          </Button>
        </CardContent>
      </Card>}

      {storageMode === "github" && !created && <Card>
        <CardHeader>
          <CardTitle>{t("addBook.existingReposTitle")}</CardTitle>
          <CardDescription>{t("addBook.existingReposDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder={t("addBook.filterRepos")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={!activeToken}
        />
      </div>

      {/* Repo list */}
      {loading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("addBook.loadingRepos")}
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!loading && !error && filtered.length === 0 && activeToken && (
        <p className="text-sm text-muted-foreground">
          {t("addBook.noRepos")}
        </p>
      )}

      <div className="space-y-2">
        {filtered.map((repo) => {
          const alreadyAdded = settings.books.some(
            (b) => b.owner === repo.owner && b.repo === repo.name,
          );
          return (
            <Card key={repo.id} className="p-4">
              <div className="flex items-start gap-4">
                <Github className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                   {repo.full_name}
                   {repo.private ? (
                     <Lock className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <Globe className="h-3 w-3 text-muted-foreground" />
                  )}
                  </p>
                  {repo.description && <p className="mt-1 text-xs text-muted-foreground">{repo.description}</p>}
                </div>
                <div className="shrink-0">
                  {alreadyAdded ? (
                    <Badge variant="secondary">{t("addBook.added")}</Badge>
                  ) : (
                    <Button
                      size="sm"
                      disabled={adding === repo.full_name}
                      onClick={() => void handleAdd(repo)}
                    >
                      {adding === repo.full_name ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
                      {t("addBook.add")}
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
        </CardContent>
      </Card>}
    </div>
  );
}
