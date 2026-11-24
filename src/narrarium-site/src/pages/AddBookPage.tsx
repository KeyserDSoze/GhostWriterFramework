import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, Plus, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { BookRepositoryError, classifyTokenKind, createCompleteBookRepository, deleteEmptyBookRepository, isBookRepositoryError, type BookRepositoryProgress, type CreateCompleteBookRepositoryResult } from "@/github/bookRepository";
import { defaultGitHubRepositoryChoices, ownerOf, preflightLogin, useGitHubPreflight, type GitHubRepositoryChoices } from "@/components/book/GitHubRepositoryPanel";
import { GitHubRepositoryPicker } from "@/components/book/GitHubRepositoryPicker";
import { credentialCacheKey, decisionAction, type RepositoryDecision } from "@/github/repositoryPickerModel";
import { useConnectionStore } from "@/account/connectionStore";
import { GitHubCreateFailure, GitHubCreateProgress, GitHubCreateResult } from "@/components/book/GitHubRepositoryOutcome";
import { useProtectedReaderSetup } from "@/components/book/useProtectedReaderSetup";
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
  const [decision, setDecision] = useState<RepositoryDecision | null>(null);
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

  const connection = useConnectionStore((state) => state.configuration.github);
  // Without a token of its own to pick, the GitHub connection (the app, or a token connected in Settings) is the one to use.
  useEffect(() => {
    if (selectedToken === "default" && !settings.defaultGitHubToken && connection?.token) setSelectedToken("connection");
  }, [selectedToken, settings.defaultGitHubToken, connection?.token]);

  const activeToken =
    selectedToken === "connection"
      ? connection?.token ?? ""
      : selectedToken === "default"
        ? settings.defaultGitHubToken
        : selectedToken === "custom"
          ? customToken.trim()
          : settings.extraGitHubTokens[Number(selectedToken)]?.token ?? "";
  const readerSetup = useProtectedReaderSetup(activeToken);
  const activeApp = selectedToken === "connection" ? connection?.credentialKind === "app" : classifyTokenKind(activeToken) === "app";
  const cacheKey = credentialCacheKey({ app: activeApp, login: selectedToken === "connection" ? connection?.identity?.username : undefined, token: activeToken });

  const preflight = useGitHubPreflight(storageMode === "github" ? activeToken || undefined : undefined);

  /** The book as it is stored once its repository is known: the credential it uses is the one the person picked on this page. */
  function bookEntry(input: { owner: string; repo: string; name: string; activeBranch?: string; startPreset?: AutopilotPresetId }): BookEntry {
    const usingCustom = selectedToken === "custom";
    const usingConnection = selectedToken === "connection";
    return {
      id: crypto.randomUUID(),
      owner: input.owner,
      repo: input.repo,
      name: input.name,
      tokenIndex: selectedToken === "default" || usingCustom || usingConnection ? null : Number(selectedToken),
      bookToken: usingCustom ? customToken.trim() : undefined,
      bookTokenLabel: usingCustom ? customTokenLabel.trim() || `${input.repo} PAT` : undefined,
      useGitHubConnection: usingConnection ? true : undefined,
      activeBranch: input.activeBranch,
      startPreset: input.startPreset,
      addedAt: new Date().toISOString(),
    };
  }

  /** A repository that is a Narrarium book already is added as it is: nothing in it is written. */
  async function addExistingBook(repository: { owner: string; name: string }) {
    setCreatingRepo(true);
    setCreateError(null);
    try {
      const entry = bookEntry({ owner: repository.owner, repo: repository.name, name: repository.name });
      patchSettings({ books: [...settings.books, entry] });
      await save();
      navigate(`/app/books/${entry.id}`);
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreatingRepo(false);
    }
  }

  async function handleCreateNewBook(retry = false) {
    const title = newBookTitle.trim();
    const github = storageMode === "github";
    if (github && (!activeToken || !decision?.ready)) return;
    // A repository that is a book already needs no title: it is added as it is.
    if (github && decision?.outcome?.kind === "connect-book" && decision.repository) { await addExistingBook(decision.repository); return; }
    if (!title) return;
    const repoName = decision?.name ?? "";
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
      // A repository that is there is filled (empty) or replaced (when the person said so); a new one is made with what was chosen.
      const existingTarget = decision?.mode === "existing" ? decision : null;
      failureOwner.current = existingTarget?.owner ?? ownerOf(repoChoices) ?? "";
      setProgress({ step: "repository" });
      // The template is a chunk of its own (about 400 KB): it is fetched here, when a repository is made, and by no other page.
      const { loadBookTemplate, composeCompleteBookFiles } = await import("@/narrarium/bookTemplate");
      const files = composeCompleteBookFiles(await loadBookTemplate(), { title, language: settings.ui.language, files: startSize ? presetOutlineFiles(startSize) : undefined });
      const result = await createCompleteBookRepository({
        token: activeToken,
        owner: existingTarget ? existingTarget.owner : ownerOf(repoChoices),
        name: repoName,
        description: `Narrarium book: ${title}`,
        visibility: repoChoices.visibility,
        files,
        existing: existingTarget ? (existingTarget.overwrite ? "overwrite" : "empty") : retry ? "empty" : "error",
        pages: !existingTarget && repoChoices.pages ? "enable" : "skip",
        // A protected reader: the first password is put in place before the workflow lands, so that the first publication already asks for it.
        beforeWorkflow: !existingTarget && repoChoices.pages ? readerSetup.step(repoChoices) : undefined,
        onProgress: setProgress,
      });
      readerSetup.settle(result);
      const entry = bookEntry({ owner: result.owner, repo: result.repo, name: title, activeBranch: result.defaultBranch, startPreset: startSize ?? undefined });
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

  const connectsBook = storageMode === "github" && decision?.outcome?.kind === "connect-book";
  const action = decision ? decisionAction(decision) : "create";
  const submitDisabled = creatingRepo || (storageMode === "local-only" ? !newBookTitle.trim() : !activeToken || !decision?.ready || (!connectsBook && !newBookTitle.trim()));

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
            {connection?.token && <SelectItem value="connection">{t("github.picker.tokenConnection", { account: connection.identity?.username ?? "GitHub" })}</SelectItem>}
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

      {created ? <GitHubCreateResult result={created.result} onOpenBook={() => navigate(`/app/books/${created.bookId}`)} reader={readerSetup.view(created.result, (next) => setCreated({ ...created, result: next }))} /> : <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Plus className="h-5 w-5" />{t("addBook.createNew")}</CardTitle>
          <CardDescription>{t("addBook.createNewDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-md">
            <Label htmlFor="add-book-title">{t("addBook.bookTitle")}</Label>
            <Input id="add-book-title" value={newBookTitle} onChange={(e) => setNewBookTitle(e.target.value)} placeholder={t("addBook.bookTitlePlaceholder")} />
          </div>
          {!connectsBook && <StartSizePicker value={startSize} onChange={setStartSize} />}
          {storageMode === "github" && (
            <GitHubRepositoryPicker
              context="add"
              token={activeToken}
              app={activeApp}
              login={selectedToken === "connection" ? connection?.identity?.username : undefined}
              cacheKey={cacheKey}
              defaultName={defaultRepositoryName(newBookTitle)}
              choices={repoChoices}
              onChoicesChange={setRepoChoices}
              preflight={preflight}
              books={settings.books}
              disabled={creatingRepo}
              onDecision={setDecision}
            />
          )}
          {createError && <Alert variant="destructive"><AlertDescription>{createError}</AlertDescription></Alert>}
          {storageMode === "github" && <GitHubCreateProgress progress={progress} busy={creatingRepo} />}
          {failure && <GitHubCreateFailure error={failure} owner={failureOwner.current} accountLogin={preflightLogin(preflight)} repo={decision?.name ?? ""} busy={creatingRepo} onRetry={() => void handleCreateNewBook(true)} onDelete={handleDeleteEmptyRepository} />}
          <Button className="w-full sm:w-fit [@media(pointer:coarse)]:h-11" onClick={() => void handleCreateNewBook()} disabled={submitDisabled}>
            {creatingRepo ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : storageMode === "local-only" ? <HardDrive className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
            {creatingRepo ? t("addBook.creatingRepo") : storageMode === "local-only" ? (settings.ui.language === "it" ? "Crea libro locale" : "Create local book") : action === "create" ? t("addBook.createRepo") : t(`github.picker.action.${action}`)}
          </Button>
        </CardContent>
      </Card>}

    </div>
  );
}
