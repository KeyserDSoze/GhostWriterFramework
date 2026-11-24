import { Activity, ArrowLeftRight, BookOpen, CircleAlert, Cloud, Coins, Eye, EyeOff, GitCommit, GitPullRequest, Github, HelpCircle, History, Keyboard, Languages, Menu, Moon, NotebookPen, PanelRight, RefreshCcw, Settings, Sun, UploadCloud, Volume2, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuthStore } from "@/store/authStore";
import { useLocation, useNavigate } from "react-router-dom";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useUiStore } from "@/store/uiStore";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { sameRepositorySyncTarget, triggerCurrentRepositorySync, useRegisterRepositorySync, useRepositorySyncStore } from "@/store/repositorySyncStore";
import { speakText, type SpeechController } from "@/assistant/speech";
import { useToast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useSettings } from "@/drive/useSettings";
import { parseAppRoute } from "@/assistant/context";
import { effectiveRemoteStatus, getLocalRepositoryStatusSnapshot, listUnpushedLocalCommits } from "@/repository/localRepository";
import { RepositorySyncConflictDialog } from "@/components/repository/RepositorySyncConflictDialog";
import { repositoryErrorDescription } from "@/repository/repositoryError";
import { commitLocalChanges, fetchRemoteStatus, pullRemoteChanges, RepositorySyncChoiceStaleError, RepositorySyncConflictError, syncFullRepository, type RepositorySyncConflictChoice, type RepositorySyncConflictResolution } from "@/repository/repositoryService";
import { bookStorageMode, resolveBookToken } from "@/types/settings";
import { emailToBranchName } from "@/github/githubClient";
import { useTheme } from "./ThemeProvider";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { useNavigationHistoryStore } from "@/store/navigationHistoryStore";
import { resolveContextualNavigation } from "@/lib/contextualNavigation";
import { useCurrentObjectPendingCommit } from "@/hooks/useCurrentObjectPendingCommit";
import { useAppUpdateStore } from "@/store/appUpdateStore";
import { activateAvailableUpdate } from "@/pwa";
import { KeyboardShortcutsDialog } from "@/components/layout/KeyboardShortcutsDialog";
import { SyncStatusIndicator } from "@/components/layout/SyncStatusIndicator";
import { triggerCurrentSave } from "@/store/saveStore";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { githubRemoteAvailability, useGitHubRemoteAvailability } from "@/github/remoteAvailability";
import "@/i18n/localFirst";

// The repository status is opened from its menu or from a page: its code and its texts load then, not with the shell of every page.
const RepositoryStatusDialog = lazy(() => import("@/components/repository/RepositoryStatusDialog").then((module) => ({ default: module.RepositoryStatusDialog })));

function initials(name: string | undefined): string {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

function remoteChangedNoticeKey(bookId: string, remoteHeadSha: string): string {
  return `narrarium-remote-changed-${bookId}-${remoteHeadSha}`;
}

export function ownsCompletedSpeechController(current: SpeechController | null, completed: SpeechController, currentGeneration: number, completedGeneration: number): boolean {
  return current === completed && currentGeneration === completedGeneration;
}

export function Topbar({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  const { t, i18n } = useTranslation();
  const { user } = useAuthStore();
  const { settings, patchSettings } = useSettingsStore();
  const { save } = useSettings();
  const { theme, toggle: toggleTheme } = useTheme();
  const cloneProgress = useBooksStore((s) => s.cloneProgress);
  const workingBranches = useBooksStore((s) => s.workingBranches);
  const structures = useBooksStore((s) => s.structures);
  const { floatingHidden, toggleFloating } = useUiStore();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const dossierColumnHidden = useUiStore((s) => s.dossierColumnHidden);
  const setDossierColumnHidden = useUiStore((s) => s.setDossierColumnHidden);
  const setDossierSearchOpen = useUiStore((s) => s.setDossierSearchOpen);
  const setNotesOpen = useUiStore((s) => s.setNotesOpen);
  const setDebugOpen = useUiStore((s) => s.setDebugOpen);
  const debugCount = useLlmDebugStore((s) => s.entries.length);
  const debugStorageError = useLlmDebugStore((s) => s.storageError);
  const updateWorker = useAppUpdateStore((s) => s.worker);
  const updateVersion = useAppUpdateStore((s) => s.version);
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const speechRef = useRef<SpeechController | null>(null);
  const speechGenerationRef = useRef(0);
  const fetchedOnOpen = useRef<string | null>(null);
  const [repoStatus, setRepoStatus] = useState<{ label: string; tone: "clean" | "dirty" | "ahead" | "behind" | "offline" | "none" }>({ label: "", tone: "none" });
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [repoDialogLoaded, setRepoDialogLoaded] = useState(false);
  if (repoDialogOpen && !repoDialogLoaded) setRepoDialogLoaded(true);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const syncConflict = useRepositorySyncStore((state) => state.conflict);
  const setSyncConflict = useRepositorySyncStore((state) => state.setConflict);
  useEffect(() => {
    const openRepositoryStatus = () => setRepoDialogOpen(true);
    window.addEventListener("narrarium:open-repository-status", openRepositoryStatus);
    return () => window.removeEventListener("narrarium:open-repository-status", openRepositoryStatus);
  }, []);
  const [repoActionBusy, setRepoActionBusy] = useState<string | null>(null);
  const previousDocument = useNavigationHistoryStore((s) => s.previous);
  const route = parseAppRoute(location.pathname);
  const currentBookId = "bookId" in route ? route.bookId : undefined;
  const currentBook = currentBookId ? settings.books.find((entry) => entry.id === currentBookId) : undefined;
  const currentBranch = currentBook?.activeBranch
    ?? (currentBookId ? workingBranches[currentBookId] : undefined)
    ?? (user?.email ? emailToBranchName(user.email) : undefined);
  const currentToken = currentBook ? resolveBookToken(currentBook, settings) : "";
  const currentBookIsLocal = Boolean(currentBook && bookStorageMode(currentBook) === "local-only");
  const remote = useGitHubRemoteAvailability(currentBook, currentToken);
  const currentAccountIdentity = localWorkspaceScope();
  const repositoryTarget = currentBook && currentBranch && currentAccountIdentity ? { bookId: currentBook.id, owner: currentBook.owner, repo: currentBook.repo, branch: currentBranch, accountIdentity: currentAccountIdentity } : null;
  const currentStructure = currentBookId ? structures[currentBookId] : undefined;
  const currentObjectNavigation = resolveContextualNavigation(currentStructure, location.pathname, currentBookId);
  const pendingCurrentObject = useCurrentObjectPendingCommit({
    book: currentBook,
    branch: currentBranch ?? "",
    paths: currentObjectNavigation.currentFilePaths,
  });
  const readerSettingsState = route.kind === "reader" ? { returnTo: location.pathname } : undefined;

  useEffect(() => {
    const bookId = currentBookId;
    let cancelled = false;
    async function refresh() {
      if (!bookId) { if (!cancelled) setRepoStatus({ label: "", tone: "none" }); return; }
      const progress = cloneProgress[bookId];
      if (progress) {
        const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
        const label = progress.phase === "migrating" ? t("repoStatus.migrating") : progress.phase === "finalizing" ? t("repoStatus.finalizing") : t("repoStatus.cloning", { percent });
        if (!cancelled) setRepoStatus({ label, tone: "offline" });
        return;
      }
      const snapshot = currentBook && currentBranch && currentAccountIdentity ? await getLocalRepositoryStatusSnapshot(currentBook.owner, currentBook.repo, currentBranch, currentAccountIdentity).catch(() => null) : null;
      if (!snapshot) { if (!cancelled) setRepoStatus({ label: t("repoStatus.notCloned"), tone: "offline" }); return; }
      const { meta: repo, status } = snapshot;
      if (cancelled) return;
      // The local commits of a book kept on this device are its saved history: there is nowhere to push them, so they are not "ahead" of anything.
      if (currentBookIsLocal && status.dirty === 0) {
        setRepoStatus({ label: t("localFirst.pillLocalOnly"), tone: "clean" });
        return;
      }
      if (!currentBookIsLocal && status.ahead > 0) {
        const commits = await listUnpushedLocalCommits(repo.id).catch(() => []);
        const oldest = commits[0];
        const oldMs = oldest ? Date.now() - new Date(oldest.createdAt).getTime() : 0;
        const shouldNotify = status.ahead >= 3 || oldMs > 24 * 60 * 60 * 1000;
        if (shouldNotify) {
          const key = `narrarium-unpushed-warning-${bookId}-${status.ahead}-${oldest?.id ?? "none"}`;
          if (!sessionStorage.getItem(key)) {
            sessionStorage.setItem(key, "1");
            toast({ title: t("repoStatus.unpushedNotice", { count: status.ahead }) });
          }
        }
      }
      const remoteStatus = effectiveRemoteStatus(repo);
      setRepoStatus(status.dirty > 0
        ? { label: t("repoStatus.dirty", { count: status.dirty }), tone: "dirty" }
        : status.ahead > 0
          ? { label: t("repoStatus.ahead", { count: status.ahead }), tone: "ahead" }
          : repo.cloneComplete !== true
            ? { label: t("repoStatus.incomplete"), tone: "behind" }
          : remoteStatus === "changed"
            ? { label: t("repoStatus.behind"), tone: "behind" }
            : remoteStatus === "checking"
              ? { label: t("repoStatus.checking"), tone: "offline" }
              : remoteStatus === "unverified" || remoteStatus === "unavailable"
                ? { label: t(repo.lastKnownChanged ? "repoStatus.staleChanged" : "repoStatus.unverified"), tone: "offline" }
                : { label: t("repoStatus.clean"), tone: "clean" });
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [cloneProgress, currentAccountIdentity, currentBook, currentBookId, currentBookIsLocal, currentBranch, settings.ui.language, t, toast]);

  useEffect(() => {
    if (!currentBook) fetchedOnOpen.current = null;
    if (!currentBook || bookStorageMode(currentBook) === "local-only") return;
    const intervalMinutes = settings.repository.autoFetchIntervalMinutes;
    const onOpen = settings.repository.autoFetchOnOpen && fetchedOnOpen.current !== currentBook.id;
    if (!onOpen && (!intervalMinutes || intervalMinutes <= 0)) return;
    const token = resolveBookToken(currentBook, settings);
    const tick = async () => {
      if (githubRemoteAvailability(currentBook, token) !== "ready") return;
      try {
        if (!repositoryTarget) return;
        const result = await fetchRemoteStatus({ ...repositoryTarget, token });
        if (result.changed && settings.repository.autoPullWhenClean) await pullRemoteChanges({ ...repositoryTarget, token }).catch(() => undefined);
        else if (result.changed) {
          const key = remoteChangedNoticeKey(currentBook.id, result.remoteHeadSha);
          if (!sessionStorage.getItem(key)) {
            sessionStorage.setItem(key, "1");
            toast({
              title: t("repoStatus.remoteBehindTitle"),
              description: t("repoStatus.remoteBehindDescription"),
              action: currentBook
                ? <ToastAction altText={t("repoStatus.syncNow")} onClick={() => { void triggerCurrentRepositorySync(); }}>{t("repoStatus.syncNow")}</ToastAction>
                : undefined,
            });
          }
        }
      } catch {
        // Background sync is opportunistic; keep local editing uninterrupted.
      }
    };
    // "Auto-fetch on open": one light check of the remote head when a book is opened, the same check the periodic one makes.
    if (onOpen && repositoryTarget) {
      fetchedOnOpen.current = currentBook.id;
      void tick();
    }
    if (!intervalMinutes || intervalMinutes <= 0) return;
    const timer = window.setInterval(() => void tick(), intervalMinutes * 60_000);
    return () => window.clearInterval(timer);
  }, [currentBook, currentBranch, settings]);

  async function changeLanguage(code: "en" | "it") {
    await i18n.changeLanguage(code);
    patchSettings({ ui: { ...settings.ui, language: code } });
    try { await save(); } catch { return; }
  }

  async function handleReadPage() {
    try {
      if (speechRef.current) {
        speechGenerationRef.current += 1;
        speechRef.current.stop();
        speechRef.current = null;
        return;
      }
      const main = document.querySelector("main");
      const text = main?.textContent?.trim() ?? document.body.textContent?.trim() ?? "";
      const generation = ++speechGenerationRef.current;
      const controller = await speakText(text, settings, { accountScope: localWorkspaceScope() });
      if (generation !== speechGenerationRef.current) {
        controller.stop();
        return;
      }
      speechRef.current = controller;
      const clearCompleted = () => {
        if (ownsCompletedSpeechController(speechRef.current, controller, speechGenerationRef.current, generation)) speechRef.current = null;
      };
      void controller.done.then(clearCompleted, clearCompleted);
    } catch (err) {
      toast({ title: t("shell.ttsFailed"), description: String(err), variant: "destructive" });
    }
  }

  async function runRepoAction(label: string, action: () => Promise<string>) {
    if (!currentBook) return;
    setRepoActionBusy(label);
    try {
      const result = await action();
      toast({ title: result });
    } catch (err) {
      toast({ title: t("repoStatus.actionFailed"), description: repositoryErrorDescription(err, t), variant: "destructive" });
    } finally {
      setRepoActionBusy(null);
    }
  }

  async function runFullSync(conflictResolutions?: Record<string, RepositorySyncConflictChoice>): Promise<boolean> {
    if (!repositoryTarget) return false;
    setRepoActionBusy("sync");
    try {
      // Without GitHub at hand (a book kept on this device, no credential, offline) the changes are committed here, and publishing them waits.
      if (remote !== "ready") {
        const snapshot = await getLocalRepositoryStatusSnapshot(repositoryTarget.owner, repositoryTarget.repo, repositoryTarget.branch, repositoryTarget.accountIdentity);
        if (snapshot?.status.dirty) await commitLocalChanges(repositoryTarget, "Save local book changes");
        toast({ title: t("localFirst.savedLocally"), description: remote === "offline" ? t("localFirst.savedOffline") : remote === "no-credential" ? t("localFirst.savedNoCredential") : undefined });
        return true;
      }
      const result = await syncFullRepository({ ...repositoryTarget, token: currentToken, conflictResolutions });
      setSyncConflict(null);
      toast({ title: t("repoStatus.syncDone", { pulled: result.pulled, kept: result.keptLocal, committed: result.committed, pushed: result.pushed }) });
      return true;
    } catch (error) {
      if (error instanceof RepositorySyncConflictError) {
        setSyncConflict({ error, target: repositoryTarget });
        return false;
      }
      if (error instanceof RepositorySyncChoiceStaleError) {
        setSyncConflict(error.conflicts.length ? { error: new RepositorySyncConflictError(error.conflicts), target: repositoryTarget } : null);
        toast({ title: t("repoStatus.conflictChoicesStale"), variant: "destructive" });
        return false;
      }
      toast({ title: t("repoStatus.actionFailed"), description: repositoryErrorDescription(error, t), variant: "destructive" });
      return false;
    } finally {
      setRepoActionBusy(null);
    }
  }

  async function applyConflictChoices(resolutions: Record<string, RepositorySyncConflictResolution>) {
    if (!syncConflict) return;
    const sameTarget = repositoryTarget && sameRepositorySyncTarget(syncConflict.target, repositoryTarget);
    if (!sameTarget) {
      setSyncConflict(null);
      toast({ title: t("repoStatus.conflictContextChanged"), variant: "destructive" });
      return;
    }
    const boundResolutions = Object.fromEntries(syncConflict.error.conflicts.map((conflict) => [conflict.path, {
      choice: resolutions[conflict.path],
      expectedLocalHash: conflict.localHash,
      expectedRemoteSha: conflict.remoteSha,
      expectedLocalDeleted: conflict.localDeleted,
      expectedRemoteDeleted: conflict.remoteDeleted,
      expectedLocalBaseSha: conflict.localBaseSha,
      expectedLocalChanged: conflict.localChanged,
    }])) as Record<string, RepositorySyncConflictChoice>;
    if (!await runFullSync(boundResolutions)) return;
    if (Object.values(resolutions).includes("remote")) {
      window.location.reload();
      return;
    }
    await triggerCurrentSave();
  }

  useRegisterRepositorySync({
    enabled: Boolean(repositoryTarget),
    busy: repoActionBusy === "sync",
    onSync: () => runFullSync(),
  });

  const visibleRepoStatus = currentBook && repoStatus.tone === "none"
    ? { label: t("repoStatus.notCloned"), tone: "offline" as const }
    : repoStatus;

  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b bg-background px-3 sm:px-4">
      {sidebarCollapsed && (
        <Button
          variant="ghost"
          size="icon"
          className="hidden lg:inline-flex"
          aria-label={t("nav.expandSidebar")}
          onClick={() => setSidebarCollapsed(false)}
        >
          <Menu className="h-5 w-5" />
        </Button>
      )}
      {/* With large text (200%) the bar keeps its buttons on the screen: the name of the app and the status of the repository give up their room first. */}
      <div className="flex min-w-0 items-center gap-2 lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label={t("shell.openNav")}
          onClick={onOpenMobileNav}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <span className="hidden min-w-0 truncate font-semibold min-[360px]:block">Narrarium</span>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
        {previousDocument && (
          <Button
            variant="outline"
            size="sm"
            className="hidden max-w-[260px] items-center gap-1 text-xs md:inline-flex"
            title={`${t("quickSwitch.backToPrevious")}: ${previousDocument.label}`}
            onClick={() => navigate(previousDocument.pathname)}
          >
            <History className="h-3.5 w-3.5" />
            <span className="truncate">{previousDocument.label}</span>
            <span className="ml-1 text-xs text-muted-foreground">Ctrl+`</span>
          </Button>
        )}
        {currentBook && visibleRepoStatus.tone !== "none" && (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={visibleRepoStatus.tone === "dirty"
                  ? `inline-flex min-w-0 items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300${pendingCurrentObject.pending ? " motion-safe:animate-pulse" : ""}`
                  : visibleRepoStatus.tone === "ahead"
                    ? "inline-flex min-w-0 items-center gap-1 rounded-full border border-sky-500/50 bg-sky-500/10 px-2 py-1 text-xs text-sky-800 dark:text-sky-300"
                    : visibleRepoStatus.tone === "behind"
                      ? "inline-flex min-w-0 items-center gap-1 rounded-full border border-violet-500/50 bg-violet-500/10 px-2 py-1 text-xs text-violet-700 dark:text-violet-300"
                  : visibleRepoStatus.tone === "clean"
                    ? "inline-flex min-w-0 items-center gap-1 rounded-full border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-800 dark:text-emerald-300"
                    : "inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-1 text-xs text-muted-foreground"}
                title={visibleRepoStatus.label}
              >
                <span className="h-2 w-2 shrink-0 rounded-full bg-current" />
                <span className="min-w-0 max-w-[34vw] truncate sm:max-w-none">{visibleRepoStatus.label}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64" aria-describedby={remote !== "ready" ? "repository-menu-github-hint" : undefined}>
              <DropdownMenuLabel>{t("repoStatus.quickActions")}</DropdownMenuLabel>
              <div className="p-2">
                <Button className="w-full" size="sm" disabled={!repositoryTarget || !!repoActionBusy} onClick={() => void triggerCurrentRepositorySync()}>{repoActionBusy === "sync" ? <RefreshCcw className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCcw className="mr-1 h-4 w-4" />}{t("repoStatus.sync")}</Button>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setRepoDialogOpen(true)}><Activity className="mr-2 h-4 w-4" />{t("repoStatus.viewStatus")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRepoDialogOpen(true)}><Eye className="mr-2 h-4 w-4" />{t("repoStatus.viewChangedFiles")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              {remote !== "ready" && <DropdownMenuLabel id="repository-menu-github-hint" className="max-w-64 text-xs font-normal text-muted-foreground">{t(remote === "local" ? "localFirst.repositoryMenuLocal" : remote === "offline" ? "localFirst.repositoryMenuOffline" : "localFirst.repositoryMenuNoCredential")}</DropdownMenuLabel>}
              {remote === "no-credential" && <DropdownMenuItem onSelect={() => navigate("/app/settings/github")}><Github className="mr-2 h-4 w-4" />{t("localFirst.connectGitHub")}</DropdownMenuItem>}
              <DropdownMenuItem disabled={remote !== "ready" || !!repoActionBusy} onSelect={() => void runRepoAction("fetch", async () => {
                const result = await fetchRemoteStatus({ ...repositoryTarget!, token: currentToken });
                return result.changed ? t("repoStatus.remoteChanged") : t("repoStatus.remoteUpToDate");
              })}><RefreshCcw className="mr-2 h-4 w-4" />{t("repoStatus.fetch")}</DropdownMenuItem>
              <DropdownMenuItem disabled={remote !== "ready" || !!repoActionBusy} onSelect={() => void runRepoAction("pull", async () => {
                const result = await pullRemoteChanges({ ...repositoryTarget!, token: currentToken });
                return t("repoStatus.pullDone", { count: result.updated });
              })}><GitPullRequest className="mr-2 h-4 w-4" />{t("repoStatus.pull")}</DropdownMenuItem>
              <DropdownMenuItem disabled={!repositoryTarget || !!repoActionBusy} onSelect={() => void runRepoAction("commit", async () => { await commitLocalChanges(repositoryTarget!, ""); return t("repoStatus.commitDone"); })}><GitCommit className="mr-2 h-4 w-4" />{t("repoStatus.commit")}</DropdownMenuItem>
               <DropdownMenuItem disabled={remote !== "ready" || !repositoryTarget || !!repoActionBusy} onSelect={() => void triggerCurrentRepositorySync()}><UploadCloud className="mr-2 h-4 w-4" />{t("repoStatus.push")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <SyncStatusIndicator />
        {/* Below sm the room is short: these three live in the menu of the account, and the bar does not spill over the edge of the screen. */}
        <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label={floatingHidden ? t("shell.showFloating") : t("shell.hideFloating")} onClick={toggleFloating}>
          {floatingHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label={t("shell.readPage")} onClick={() => void handleReadPage()}>
          <Volume2 className="h-4 w-4" />
        </Button>
        {currentBook && (
          <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label={t("notes.title")} title={`${t("notes.title")} (Ctrl+M)`} onClick={() => setNotesOpen(true)}>
            <NotebookPen className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label={t("dossier.title")}
          title={t("dossier.title")}
          onClick={() => {
            const isMobile = window.matchMedia("(max-width: 1279px)").matches;
            if (isMobile) setDossierSearchOpen(true);
            else setDossierColumnHidden(!dossierColumnHidden);
          }}
        >
          <PanelRight className="h-4 w-4" />
        </Button>

          <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative shrink-0 rounded-full">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="text-xs font-medium">
                  {initials(user?.name)}
                </AvatarFallback>
              </Avatar>
              {updateWorker && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-xs font-bold leading-none text-amber-950 shadow-sm ring-2 ring-background">!</span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {user && (
              <>
                <DropdownMenuLabel>
                  <div className="font-normal">
                    <p className="font-medium">{user.name}</p>
                    <p className="text-xs text-muted-foreground">{user.email}</p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem className="sm:hidden" onSelect={toggleFloating}>
              {floatingHidden ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}
              {floatingHidden ? t("shell.showFloating") : t("shell.hideFloating")}
            </DropdownMenuItem>
            <DropdownMenuItem className="sm:hidden" onSelect={() => void handleReadPage()}>
              <Volume2 className="mr-2 h-4 w-4" />
              {t("shell.readPage")}
            </DropdownMenuItem>
            {currentBook && (
              <DropdownMenuItem className="sm:hidden" onSelect={() => setNotesOpen(true)}>
                <NotebookPen className="mr-2 h-4 w-4" />
                {t("notes.title")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator className="sm:hidden" />
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); toggleTheme(); }}>
              {theme === "dark" ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
              {theme === "dark" ? t("common.switchToLight") : t("common.switchToDark")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-2 text-xs"><Languages className="h-3.5 w-3.5" />{t("common.changeLanguage")}</DropdownMenuLabel>
            {SUPPORTED_LANGUAGES.map((language) => (
              <DropdownMenuItem key={language.code} onSelect={() => void changeLanguage(language.code)} className={(i18n.resolvedLanguage?.split("-")[0] ?? settings.ui.language) === language.code ? "font-semibold" : undefined}>
                {language.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate("/app/settings")}>
              <Settings className="mr-2 h-4 w-4" />
              {t("nav.settings")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/app/account-sync")}>
              <Cloud className="mr-2 h-4 w-4" />
              Account &amp; Sync
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/app/reader-settings", { state: readerSettingsState })}>
              <BookOpen className="mr-2 h-4 w-4" />
              {t("reader.settingsTitle")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/app/custom-actions")}>
              <Wand2 className="mr-2 h-4 w-4" />
              {t("customActions.title")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/app/migrate")}>
              <ArrowLeftRight className="mr-2 h-4 w-4" />
              {t("migration.title")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/app/costs")}>
              <Coins className="mr-2 h-4 w-4" />
              {t("costs.title")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDebugOpen(true)}>
              {debugStorageError ? <CircleAlert className="mr-2 h-4 w-4 text-destructive" /> : <Activity className="mr-2 h-4 w-4" />}
              <span className="flex-1">{t("debug.title")}</span>
              {debugCount > 0 && (
                <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">{debugCount}</span>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/app/docs")}>
              <HelpCircle className="mr-2 h-4 w-4" />
              {t("nav.help")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShortcutsOpen(true)}>
              <Keyboard className="mr-2 h-4 w-4" />
              {t("shortcuts.title")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.dispatchEvent(new Event("narrarium:open-onboarding"))}>
              <Wand2 className="mr-2 h-4 w-4" />
              {t("onboarding.open")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/app/patch-notes")}>
              <History className="mr-2 h-4 w-4" />
              {t("patchNotes.title")}
            </DropdownMenuItem>
            {updateWorker && (
               <DropdownMenuItem className="font-semibold text-amber-800 focus:text-amber-900 dark:text-amber-300 dark:focus:text-amber-200" onSelect={() => void activateAvailableUpdate(true)}>
                <CircleAlert className="mr-2 h-4 w-4" />
                <span className="flex-1">{t("pwa.updateMenu")}</span>
                {updateVersion && <span className="ml-2 font-mono text-xs">v{updateVersion}</span>}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {repoDialogLoaded && <Suspense fallback={null}><RepositoryStatusDialog open={repoDialogOpen} onOpenChange={setRepoDialogOpen} book={currentBook} branch={currentBranch} settings={settings} /></Suspense>}
      <RepositorySyncConflictDialog conflicts={syncConflict?.error.conflicts ?? []} busy={repoActionBusy === "sync"} onCancel={() => setSyncConflict(null)} onApply={applyConflictChoices} />
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </header>
  );
}
