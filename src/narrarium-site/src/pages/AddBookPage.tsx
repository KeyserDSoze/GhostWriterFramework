import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search, Loader2, Github, Lock, Globe, Plus } from "lucide-react";
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
import { createNarrariumBookRepository, type RepoSummary } from "@/github/githubClient";
import { type BookEntry } from "@/types/settings";

function defaultRepoName(title: string): string {
  const normalized = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase();
  return normalized ? `book-${normalized}` : "";
}

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
  const [newRepoVisibility, setNewRepoVisibility] = useState<"private" | "public">("private");
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const activeToken =
    selectedToken === "default"
      ? settings.defaultGitHubToken
      : selectedToken === "custom"
        ? customToken.trim()
        : settings.extraGitHubTokens[Number(selectedToken)]?.token ?? "";

  const { repos, loading, error } = useRepositories(
    activeToken || undefined,
  );

  const hasPrivateRepos = repos.some((r) => r.private);
  const hasPublicRepos = repos.some((r) => !r.private);
  const showScopeHint =
    activeToken && !loading && !error && hasPublicRepos && !hasPrivateRepos;

  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    if (!repoNameEdited) setNewRepoName(defaultRepoName(newBookTitle));
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
    await save();
    navigate(`/app/books/${entry.id}`);
  }

  async function handleCreateNewBook() {
    const title = newBookTitle.trim();
    const repoName = newRepoName.trim();
    if (!title || !repoName || !activeToken) return;
    setCreateError(null);
    setCreatingRepo(true);
    try {
      const repo = await createNarrariumBookRepository(activeToken, {
        name: repoName,
        title,
        private: newRepoVisibility === "private",
        language: settings.ui.language,
      });
      const usingCustom = selectedToken === "custom";
      const entry: BookEntry = {
        id: crypto.randomUUID(),
        owner: repo.owner,
        repo: repo.name,
        name: title,
        tokenIndex: selectedToken === "default" || usingCustom ? null : Number(selectedToken),
        bookToken: usingCustom ? customToken.trim() : undefined,
        bookTokenLabel: usingCustom ? customTokenLabel.trim() || `${repo.name} PAT` : undefined,
        activeBranch: repo.default_branch,
        addedAt: new Date().toISOString(),
      };
      patchSettings({ books: [...settings.books, entry] });
      await save();
      navigate(`/app/books/${entry.id}`);
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreatingRepo(false);
    }
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

      {noDefaultToken && (
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

      {/* Token picker */}
      <div className="grid gap-2">
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
      </div>

      <Card>
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
            <div className="grid gap-2">
              <Label>{t("addBook.repositoryName")}</Label>
              <Input value={newRepoName} onChange={(e) => { setRepoNameEdited(true); setNewRepoName(e.target.value); }} placeholder="book-my-story" />
              <p className="text-xs text-muted-foreground">{newRepoName.trim() ? t("addBook.repoNameHint") : t("addBook.repoNameHintEmpty")}</p>
            </div>
          </div>
          <div className="grid gap-2 sm:max-w-xs">
            <Label>{t("addBook.visibility")}</Label>
            <Select value={newRepoVisibility} onValueChange={(value) => setNewRepoVisibility(value as "private" | "public")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="private">{t("addBook.privateRepo")}</SelectItem>
                <SelectItem value="public">{t("addBook.publicRepo")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {createError && <Alert variant="destructive"><AlertDescription>{createError}</AlertDescription></Alert>}
          <Button className="w-full sm:w-fit" onClick={() => void handleCreateNewBook()} disabled={creatingRepo || !activeToken || !newBookTitle.trim() || !newRepoName.trim()}>
            {creatingRepo ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            {creatingRepo ? t("addBook.creatingRepo") : t("addBook.createRepo")}
          </Button>
        </CardContent>
      </Card>

      <Card>
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
      </Card>
    </div>
  );
}
