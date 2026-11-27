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
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useUiStore } from "@/store/uiStore";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { sameRepositorySyncTarget, triggerCurrentRepositorySync, useRegisterRepositorySync, useRepositorySyncStore } from "@/store/repositorySyncStore";
import { speakText, type SpeechController } from "@/assistant/speech";
import { useToast } from "@/components/ui/use-toast";
import { useSettings } from "@/drive/useSettings";
import { parseAppRoute } from "@/assistant/context";
import { getLocalRepositoryStatusSnapshot, listUnpushedLocalCommits } from "@/repository/localRepository";
import { pillOfCopy, pillText, shownPill, type RepositoryPill } from "@/components/layout/repositoryPill";
import type { ConflictApplyControl, ConflictApplyOutcome } from "@/components/repository/RepositorySyncConflictDialog";
import { isRepositoryError, repositoryErrorDescription } from "@/repository/repositoryError";
import { BranchNameTakenError, commitLocalChanges, fetchRemoteStatus, pullRemoteChanges, RepositorySyncChoiceStaleError, RepositorySyncConflictError, syncFullRepository, type RepositorySyncConflictChoice, type RepositorySyncConflictResolution } from "@/repository/repositoryService";
import { bookStorageMode, resolveBookToken } from "@/types/settings";
import { resolveAuthoritativeBranch } from "@/github/branchRules";
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
import { useGitHubRemoteAvailability } from "@/github/remoteAvailability";
import "@/i18n/localFirst";
import { adoptRememberedBranches, bookAutoSyncMode, recordOpenedBranch } from "@/branches/memory";
import { useBranchAutoSync } from "@/branches/useBranchAutoSync";
import { BranchButton } from "@/components/branches/BranchButton";
import { setOpenBook } from "@/branches/openBook";

// The repository status is opened from its menu or from a page: its code and its texts load then, not with the shell of every page.
const RepositoryStatusDialog = lazy(() => import("@/components/repository/RepositoryStatusDialog").then((module) => ({ default: module.RepositoryStatusDialog })));
// The switcher of branches loads when it is opened, and what the automatic sync did when the menu of the pill opens: the top bar carries only the button.
const BranchSwitcherDialog = lazy(() => import("@/components/branches/BranchSwitcherDialog").then((module) => ({ default: module.BranchSwitcherDialog })));
const AutoSyncStatus = lazy(() => import("@/components/branches/AutoSyncStatus").then((module) => ({ default: module.AutoSyncStatus })));
const CostsIndicator = lazy(() => import("@/components/costs/CostsIndicator").then((module) => ({ default: module.CostsIndicator })));
// The resolver of the conflicts of a sync, its texts and its comparison of the two versions load when a sync finds files changed on both sides.
const RepositorySyncConflictDialog = lazy(() => import("@/components/repository/RepositorySyncConflictDialog").then((module) => ({ default: module.RepositorySyncConflictDialog })));

function initials(name: string | undefined): string {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
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
  const [repoStatus, setRepoStatus] = useState<RepositoryPill>({ key: "", label: "", tone: "none", copy: false });
  // Read again at once after a sync or a Git action, without waiting for the next look.
  const [statusTick, setStatusTick] = useState(0);
  const refreshRepositoryStatus = useCallback(() => setStatusTick((tick) => tick + 1), []);
  // The branch on the screen was made on this device and is not on GitHub yet.
  const [branchPending, setBranchPending] = useState(false);
  // What was spent today and this month: its code loads once the page is drawn and the browser is idle, never with the bar.
  const [costsShown, setCostsShown] = useState(false);
  useEffect(() => {
    const show = () => setCostsShown(true);
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(show, { timeout: 3000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(show, 200);
    return () => window.clearTimeout(timer);
  }, []);
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [branchDialogLoaded, setBranchDialogLoaded] = useState(false);
  if (branchDialogOpen && !branchDialogLoaded) setBranchDialogLoaded(true);
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
  const currentStructure = currentBookId ? structures[currentBookId] : undefined;
  // The same rule as the pages of the book (`useWorkingBranch`): without an account, the branch of the copy it opened, never none.
  const currentBranch = currentBook ? resolveAuthoritativeBranch({
    activeBranch: currentBook.activeBranch,
    workingBranch: workingBranches[currentBook.id],
    loadedBranch: currentStructure?.loadedBranch,
    defaultBranch: currentStructure?.defaultBranch,
    userEmail: user?.email,
  }).branch : undefined;
  const currentToken = currentBook ? resolveBookToken(currentBook, settings) : "";
  const currentBookIsLocal = Boolean(currentBook && bookStorageMode(currentBook) === "local-only");
  const remote = useGitHubRemoteAvailability(currentBook, currentToken);
  const currentAccountIdentity = localWorkspaceScope();
  const repositoryTarget = currentBook && currentBranch && currentAccountIdentity ? { bookId: currentBook.id, owner: currentBook.owner, repo: currentBook.repo, branch: currentBranch, accountIdentity: currentAccountIdentity } : null;
  const currentObjectNavigation = resolveContextualNavigation(currentStructure, location.pathname, currentBookId);
  const pendingCurrentObject = useCurrentObjectPendingCommit({
    book: currentBook,
    branch: currentBranch ?? "",
    paths: currentObjectNavigation.currentFilePaths,
  });
  const readerSettingsState = route.kind === "reader" ? { returnTo: location.pathname } : undefined;
  const currentStructureLoaded = Boolean(currentStructure);
  const autoSyncMode = currentBook ? bookAutoSyncMode(settings, currentBook) : "off";

  // Entering a book takes the branch chosen last on another device since it was open here; while it is on the screen, nothing moves it.
  useEffect(() => {
    if (!currentBookId) return;
    const loaded = useSettingsStore.getState().settings;
    const adopted = adoptRememberedBranches(loaded, { only: currentBookId });
    if (adopted !== loaded) patchSettings({ books: adopted.books });
  }, [currentBookId, patchSettings]);
  useEffect(() => {
    setOpenBook(currentBookId && currentStructureLoaded ? currentBookId : null);
  }, [currentBookId, currentStructureLoaded]);
  // A branch opened here for the first time joins the branches of the book that every device knows.
  const loadedBranch = currentStructure?.loadedBranch;
  useEffect(() => {
    const loaded = useSettingsStore.getState().settings;
    const book = loaded.books.find((entry) => entry.id === currentBookId);
    const patch = book && loadedBranch ? recordOpenedBranch(loaded, book, loadedBranch, new Date().toISOString()) : null;
    if (!patch) return;
    patchSettings(patch);
    void save().catch(() => undefined);
  }, [currentBookId, loadedBranch, patchSettings, save]);

  // The status reads the working copy of the book, branch and account on the screen, and only those values restart it: a change of the settings or the
  // progress of another book does not throw away a read under way (on a big book a read takes a while, and restarting it kept the pill from ever updating).
  const statusOwner = currentBook?.owner ?? "";
  const statusRepo = currentBook?.repo ?? "";
  const statusKey = currentBookId ? [currentBookId, statusOwner, statusRepo, currentBranch ?? "", currentAccountIdentity].join("\n") : "";
  const bookProgress = currentBookId ? cloneProgress[currentBookId] : undefined;
  const bookOpenFailed = useBooksStore((s) => Boolean(currentBookId && s.errors[currentBookId]));
  // «No local copy» is said once the book has finished opening: until then its copy may simply not be read yet.
  const bookSettled = currentStructureLoaded || bookOpenFailed;
  useEffect(() => {
    const bookId = currentBookId;
    if (!bookId) return;
    const key = statusKey;
    let cancelled = false;
    let reading = false;
    const show = (pill: Omit<RepositoryPill, "key">) => { if (!cancelled) setRepoStatus({ key, ...pill }); };
    async function refresh() {
      if (bookProgress) {
        const percent = bookProgress.total ? Math.round((bookProgress.done / bookProgress.total) * 100) : 0;
        const label = bookProgress.phase === "migrating" ? t("repoStatus.migrating") : bookProgress.phase === "finalizing" ? t("repoStatus.finalizing") : t("repoStatus.cloning", { percent });
        show({ label, tone: "offline", copy: false });
        return;
      }
      // One read at a time: a slow working copy is never read twice at once.
      if (reading || !currentBranch) return;
      reading = true;
      try {
        const snapshot = await getLocalRepositoryStatusSnapshot(statusOwner, statusRepo, currentBranch, currentAccountIdentity);
        if (cancelled) return;
        if (!snapshot) {
          if (bookSettled) show({ label: t("repoStatus.notCloned"), tone: "offline", copy: false });
          return;
        }
        const { meta: repo, status } = snapshot;
        setBranchPending(Boolean(repo.pendingBranch));
        if (!currentBookIsLocal && status.ahead > 0) {
          const commits = await listUnpushedLocalCommits(repo.id).catch(() => []);
          const oldest = commits[0];
          const oldMs = oldest ? Date.now() - new Date(oldest.createdAt).getTime() : 0;
          const shouldNotify = status.ahead >= 3 || oldMs > 24 * 60 * 60 * 1000;
          if (shouldNotify && !cancelled) {
            const noticeKey = `narrarium-unpushed-warning-${bookId}-${status.ahead}-${oldest?.id ?? "none"}`;
            if (!sessionStorage.getItem(noticeKey)) {
              sessionStorage.setItem(noticeKey, "1");
              toast({ title: t("repoStatus.unpushedNotice", { count: status.ahead }) });
            }
          }
        }
        show({ ...pillOfCopy(repo, status, currentBookIsLocal, t), copy: true });
      } catch {
        // A read that failed says nothing about the copy: the pill keeps what it said, and the next look reads again.
      } finally {
        reading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [bookProgress, bookSettled, currentAccountIdentity, currentBookId, currentBookIsLocal, currentBranch, settings.ui.language, statusKey, statusOwner, statusRepo, statusTick, t, toast]);

  // The branches of a GitHub book sync by themselves, as its mode says (`@/branches/useBranchAutoSync`): on opening, on coming back to the window, and
  // periodically if chosen; only what cannot lose or merge anything happens without the person.
  useBranchAutoSync({
    bookId: currentBook && !currentBookIsLocal ? currentBook.id : undefined,
    loadedBranch,
    ready: remote === "ready",
    mode: autoSyncMode,
    onSyncNow: () => { void triggerCurrentRepositorySync(); },
  });

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
      refreshRepositoryStatus();
    }
  }

  async function runFullSync(): Promise<boolean> {
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
      const result = await syncFullRepository({ ...repositoryTarget, token: currentToken });
      setSyncConflict(null);
      toast({
        title: t("repoStatus.syncDone", { pulled: result.pulled, kept: result.keptLocal, pushed: result.pushed }),
        description: result.unpublished > 0 ? t("repoStatus.syncUnpublished", { count: result.unpublished }) : undefined,
      });
      return true;
    } catch (error) {
      if (error instanceof RepositorySyncConflictError) {
        setSyncConflict({ error, target: repositoryTarget });
        return false;
      }
      if (error instanceof BranchNameTakenError) {
        // Its words load with the texts of the branches, not with the shell.
        const branch = error.branch;
        void import("@/i18n/branches").then(() => toast({ title: t("repoStatus.actionFailed"), description: t("branches.nameTaken", { branch }), variant: "destructive" }));
        return false;
      }
      toast({ title: t("repoStatus.actionFailed"), description: repositoryErrorDescription(error, t), variant: "destructive" });
      return false;
    } finally {
      setRepoActionBusy(null);
      refreshRepositoryStatus();
    }
  }

  /** Runs the sync with the author's choices for the resolver, which shows its steps and what came of it; a new list of files replaces the one in it. */
  async function applyConflictChoices(resolutions: Record<string, RepositorySyncConflictResolution>, control: ConflictApplyControl): Promise<ConflictApplyOutcome> {
    if (!syncConflict) return { kind: "nothing" };
    const sameTarget = repositoryTarget && sameRepositorySyncTarget(syncConflict.target, repositoryTarget);
    if (!repositoryTarget || !sameTarget) {
      setSyncConflict(null);
      toast({ title: t("repoStatus.conflictContextChanged"), variant: "destructive" });
      return { kind: "nothing" };
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
    const target = repositoryTarget;
    setRepoActionBusy("sync");
    try {
      const result = await syncFullRepository({ ...target, token: currentToken, conflictResolutions: boundResolutions, onProgress: control.onProgress, signal: control.signal });
      // A version taken from GitHub replaces what the open pages hold: the page reloads (from the resolver, once the author has read what happened).
      const reload = Object.values(resolutions).includes("remote");
      if (!reload) await triggerCurrentSave();
      return { kind: "done", result, reload };
    } catch (error) {
      if ((error instanceof DOMException && error.name === "AbortError") || isRepositoryError(error, "abort")) return { kind: "stopped" };
      if (error instanceof RepositorySyncConflictError) {
        setSyncConflict({ error, target });
        return { kind: "replaced", reason: "changed" };
      }
      if (error instanceof RepositorySyncChoiceStaleError) {
        if (!error.conflicts.length) return { kind: "nothing" };
        setSyncConflict({ error: new RepositorySyncConflictError(error.conflicts), target });
        return { kind: "replaced", reason: "stale" };
      }
      return { kind: "failed", message: repositoryErrorDescription(error, t) };
    } finally {
      setRepoActionBusy(null);
      refreshRepositoryStatus();
    }
  }

  useRegisterRepositorySync({
    enabled: Boolean(repositoryTarget),
    busy: repoActionBusy === "sync",
    onSync: () => runFullSync(),
  });

  const visibleRepoStatus = currentBook ? shownPill(repoStatus, statusKey, t) : repoStatus;
  const pillLabel = pillText(visibleRepoStatus, { bookOnDevice: currentBookIsLocal, remote, token: currentToken }, t);

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
        {/* On a phone the name of the app gives its room to the branch and the sync pill. */}
        <span className="hidden min-w-0 truncate font-semibold min-[420px]:block">Narrarium</span>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
        {costsShown && <Suspense fallback={null}><CostsIndicator /></Suspense>}
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
        {currentBook && !currentBookIsLocal && currentBranch && (
          <BranchButton bookId={currentBook.id} branch={currentBranch} pending={branchPending} mode={autoSyncMode} onOpen={() => setBranchDialogOpen(true)} />
        )}
        {currentBook && visibleRepoStatus.tone !== "none" && (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="repository-pill"
                className={visibleRepoStatus.tone === "dirty"
                  ? `inline-flex min-w-0 items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300${pendingCurrentObject.pending ? " motion-safe:animate-pulse" : ""}`
                  : visibleRepoStatus.tone === "ahead"
                    ? "inline-flex min-w-0 items-center gap-1 rounded-full border border-sky-500/50 bg-sky-500/10 px-2 py-1 text-xs text-sky-800 dark:text-sky-300"
                    : visibleRepoStatus.tone === "behind"
                      ? "inline-flex min-w-0 items-center gap-1 rounded-full border border-violet-500/50 bg-violet-500/10 px-2 py-1 text-xs text-violet-700 dark:text-violet-300"
                  : visibleRepoStatus.tone === "clean"
                    ? "inline-flex min-w-0 items-center gap-1 rounded-full border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-800 dark:text-emerald-300"
                    : "inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-1 text-xs text-muted-foreground"}
                title={pillLabel}
              >
                <span className="h-2 w-2 shrink-0 rounded-full bg-current" />
                <span className="min-w-0 max-w-[34vw] truncate sm:max-w-none">{pillLabel}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64" aria-describedby={remote !== "ready" ? "repository-menu-github-hint" : undefined}>
              <DropdownMenuLabel>{t("repoStatus.quickActions")}</DropdownMenuLabel>
              <div className="p-2">
                <Button className="w-full" size="sm" disabled={!repositoryTarget || !!repoActionBusy} onClick={() => void triggerCurrentRepositorySync()}>{repoActionBusy === "sync" ? <RefreshCcw className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCcw className="mr-1 h-4 w-4" />}{t("repoStatus.sync")}</Button>
              </div>
              <DropdownMenuSeparator />
              {currentBook && !currentBookIsLocal && (
                <>
                  <div className="max-w-64 space-y-1 px-2 py-1.5 text-xs text-muted-foreground">
                    <Suspense fallback={null}><AutoSyncStatus bookId={currentBook.id} mode={autoSyncMode} pending={branchPending} className="space-y-1" /></Suspense>
                  </div>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onSelect={() => setRepoDialogOpen(true)}><Activity className="mr-2 h-4 w-4" />{t("repoStatus.viewStatus")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRepoDialogOpen(true)}><Eye className="mr-2 h-4 w-4" />{t("repoStatus.viewChangedFiles")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              {remote !== "ready" && <DropdownMenuLabel id="repository-menu-github-hint" className="max-w-64 text-xs font-normal text-muted-foreground">{t(remote === "local" ? "localFirst.repositoryMenuLocal" : remote === "offline" ? "localFirst.repositoryMenuOffline" : "localFirst.repositoryMenuNoCredential")}</DropdownMenuLabel>}
              {remote === "no-credential" && <DropdownMenuItem onSelect={() => navigate("/app/settings/github")}><Github className="mr-2 h-4 w-4" />{t("localFirst.connectGitHub")}</DropdownMenuItem>}
              <DropdownMenuItem disabled={remote !== "ready" || branchPending || !!repoActionBusy} onSelect={() => void runRepoAction("fetch", async () => {
                const result = await fetchRemoteStatus({ ...repositoryTarget!, token: currentToken });
                return result.changed ? t("repoStatus.remoteChanged") : t("repoStatus.remoteUpToDate");
              })}><RefreshCcw className="mr-2 h-4 w-4" />{t("repoStatus.fetch")}</DropdownMenuItem>
              <DropdownMenuItem disabled={remote !== "ready" || branchPending || !!repoActionBusy} onSelect={() => void runRepoAction("pull", async () => {
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
      {branchDialogLoaded && currentBook && !currentBookIsLocal && currentBranch && <Suspense fallback={null}><BranchSwitcherDialog open={branchDialogOpen} onOpenChange={setBranchDialogOpen} book={currentBook} branch={currentBranch} pending={branchPending} remote={remote} token={currentToken} onSyncNow={() => { void triggerCurrentRepositorySync(); }} /></Suspense>}
      {syncConflict && (
        <Suspense fallback={null}>
          <RepositorySyncConflictDialog conflicts={syncConflict.error.conflicts} onApply={applyConflictChoices} onClose={() => setSyncConflict(null)} onReload={() => window.location.reload()} />
        </Suspense>
      )}
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </header>
  );
}
