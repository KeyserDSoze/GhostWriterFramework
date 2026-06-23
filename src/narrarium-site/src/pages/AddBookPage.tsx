import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search, Loader2, Github, Lock, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { type RepoSummary } from "@/github/githubClient";
import { type BookEntry } from "@/types/settings";

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
            <Card key={repo.id} className="flex items-center gap-4 p-4">
              <Github className="h-5 w-5 shrink-0 text-muted-foreground" />
              <CardHeader className="flex-1 p-0">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  {repo.full_name}
                  {repo.private ? (
                    <Lock className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <Globe className="h-3 w-3 text-muted-foreground" />
                  )}
                </CardTitle>
                {repo.description && (
                  <CardContent className="p-0 text-xs text-muted-foreground">
                    {repo.description}
                  </CardContent>
                )}
              </CardHeader>
              {alreadyAdded ? (
                <Badge variant="secondary">{t("addBook.added")}</Badge>
              ) : (
                <Button
                  size="sm"
                  disabled={adding === repo.full_name}
                  onClick={() => void handleAdd(repo)}
                >
                  {adding === repo.full_name ? (
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  ) : null}
                  {t("addBook.add")}
                </Button>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
