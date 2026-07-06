import { Activity, ArrowLeftRight, Coins, Eye, EyeOff, GitCommit, GitPullRequest, HelpCircle, LogOut, Menu, PanelRight, RefreshCcw, Settings, UploadCloud, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageToggle } from "./LanguageToggle";
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
import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useUiStore } from "@/store/uiStore";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { speakText, type SpeechController } from "@/assistant/speech";
import { useToast } from "@/components/ui/use-toast";
import { parseAppRoute } from "@/assistant/context";
import { getLocalRepositoryByBook, listUnpushedLocalCommits, localStatus } from "@/repository/localRepository";
import { RepositoryStatusDialog } from "@/components/repository/RepositoryStatusDialog";
import { commitLocalChanges, fetchRemoteStatus, pullRemoteChanges, pushLocalCommits, syncFullRepository } from "@/repository/repositoryService";
import { resolveBookToken } from "@/types/settings";

function initials(name: string | undefined): string {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

export function Topbar({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  const { t } = useTranslation();
  const { user, clearAuth } = useAuthStore();
  const { settings } = useSettingsStore();
  const cloneProgress = useBooksStore((s) => s.cloneProgress);
  const { floatingHidden, toggleFloating } = useUiStore();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const dossierColumnHidden = useUiStore((s) => s.dossierColumnHidden);
  const setDossierColumnHidden = useUiStore((s) => s.setDossierColumnHidden);
  const setDossierSearchOpen = useUiStore((s) => s.setDossierSearchOpen);
  const setDebugOpen = useUiStore((s) => s.setDebugOpen);
  const debugCount = useLlmDebugStore((s) => s.entries.length);
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const speechRef = useRef<SpeechController | null>(null);
  const [repoStatus, setRepoStatus] = useState<{ label: string; tone: "clean" | "dirty" | "ahead" | "behind" | "offline" | "none" }>({ label: "", tone: "none" });
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [repoActionBusy, setRepoActionBusy] = useState<string | null>(null);
  const route = parseAppRoute(location.pathname);
  const currentBookId = "bookId" in route ? route.bookId : undefined;
  const currentBook = currentBookId ? settings.books.find((entry) => entry.id === currentBookId) : undefined;

  useEffect(() => {
    const bookId = currentBookId;
    let cancelled = false;
    async function refresh() {
      if (!bookId) { if (!cancelled) setRepoStatus({ label: "", tone: "none" }); return; }
      const progress = cloneProgress[bookId];
      if (progress) {
        const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
        if (!cancelled) setRepoStatus({ label: t("repoStatus.cloning", { percent }), tone: "offline" });
        return;
      }
      const repo = await getLocalRepositoryByBook(bookId).catch(() => null);
      if (!repo) { if (!cancelled) setRepoStatus({ label: t("repoStatus.notCloned"), tone: "offline" }); return; }
      const status = await localStatus(repo.id);
      if (cancelled) return;
      if (status.ahead > 0) {
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
      setRepoStatus(status.dirty > 0
        ? { label: t("repoStatus.dirty", { count: status.dirty }), tone: "dirty" }
        : status.ahead > 0
          ? { label: t("repoStatus.ahead", { count: status.ahead }), tone: "ahead" }
          : repo.remoteChanged
            ? { label: t("repoStatus.behind"), tone: "behind" }
        : { label: t("repoStatus.clean"), tone: "clean" });
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [cloneProgress, currentBookId, t, toast]);

  useEffect(() => {
    if (!currentBook || !settings.repository.autoFetchIntervalMinutes || settings.repository.autoFetchIntervalMinutes <= 0) return;
    const token = resolveBookToken(currentBook, settings);
    if (!token) return;
    const intervalMs = settings.repository.autoFetchIntervalMinutes * 60_000;
    const tick = async () => {
      if (!navigator.onLine) return;
      try {
        const result = await fetchRemoteStatus({ bookId: currentBook.id, token });
        if (result.changed && settings.repository.autoPullWhenClean) await pullRemoteChanges({ bookId: currentBook.id, token }).catch(() => undefined);
      } catch {
        // Background sync is opportunistic; keep local editing uninterrupted.
      }
    };
    const timer = window.setInterval(() => void tick(), intervalMs);
    return () => window.clearInterval(timer);
  }, [currentBook, settings]);

  function handleSignOut() {
    clearAuth();
    navigate("/login");
  }

  async function handleReadPage() {
    try {
      if (speechRef.current) {
        speechRef.current.stop();
        speechRef.current = null;
        return;
      }
      const main = document.querySelector("main");
      const text = main?.textContent?.trim() ?? document.body.textContent?.trim() ?? "";
      speechRef.current = await speakText(text, settings);
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
      toast({ title: t("repoStatus.actionFailed"), description: String(err), variant: "destructive" });
    } finally {
      setRepoActionBusy(null);
    }
  }

  const currentToken = currentBook ? resolveBookToken(currentBook, settings) : "";

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
      <div className="flex items-center gap-2 lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("shell.openNav")}
          onClick={onOpenMobileNav}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <span className="font-semibold">Narrarium</span>
      </div>

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        {repoStatus.tone !== "none" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={repoStatus.tone === "dirty"
                  ? "hidden items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300 sm:inline-flex"
                  : repoStatus.tone === "ahead"
                    ? "hidden items-center gap-1 rounded-full border border-sky-500/50 bg-sky-500/10 px-2 py-1 text-xs text-sky-700 dark:text-sky-300 sm:inline-flex"
                    : repoStatus.tone === "behind"
                      ? "hidden items-center gap-1 rounded-full border border-violet-500/50 bg-violet-500/10 px-2 py-1 text-xs text-violet-700 dark:text-violet-300 sm:inline-flex"
                  : repoStatus.tone === "clean"
                    ? "hidden items-center gap-1 rounded-full border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300 sm:inline-flex"
                    : "hidden items-center gap-1 rounded-full border px-2 py-1 text-xs text-muted-foreground sm:inline-flex"}
                title={repoStatus.label}
              >
                <span className="h-2 w-2 rounded-full bg-current" />
                {repoStatus.label}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>{t("repoStatus.quickActions")}</DropdownMenuLabel>
              <div className="p-2">
                <Button className="w-full" size="sm" disabled={!currentBook || !currentToken || !!repoActionBusy} onClick={() => void runRepoAction("sync", async () => {
                  const result = await syncFullRepository({ bookId: currentBook!.id, token: currentToken });
                  return t("repoStatus.syncDone", { pulled: result.pulled, kept: result.keptLocal, committed: result.committed, pushed: result.pushed });
                })}>{repoActionBusy === "sync" ? <RefreshCcw className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCcw className="mr-1 h-4 w-4" />}{t("repoStatus.sync")}</Button>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setRepoDialogOpen(true)}><Activity className="mr-2 h-4 w-4" />{t("repoStatus.viewStatus")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRepoDialogOpen(true)}><Eye className="mr-2 h-4 w-4" />{t("repoStatus.viewChangedFiles")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!currentBook || !currentToken || !!repoActionBusy} onSelect={() => void runRepoAction("fetch", async () => {
                const result = await fetchRemoteStatus({ bookId: currentBook!.id, token: currentToken });
                return result.changed ? t("repoStatus.remoteChanged") : t("repoStatus.remoteUpToDate");
              })}><RefreshCcw className="mr-2 h-4 w-4" />{t("repoStatus.fetch")}</DropdownMenuItem>
              <DropdownMenuItem disabled={!currentBook || !currentToken || !!repoActionBusy} onSelect={() => void runRepoAction("pull", async () => {
                const result = await pullRemoteChanges({ bookId: currentBook!.id, token: currentToken });
                return t("repoStatus.pullDone", { count: result.updated });
              })}><GitPullRequest className="mr-2 h-4 w-4" />{t("repoStatus.pull")}</DropdownMenuItem>
              <DropdownMenuItem disabled={!currentBook || !!repoActionBusy} onSelect={() => void runRepoAction("commit", async () => { await commitLocalChanges(currentBook!.id, ""); return t("repoStatus.commitDone"); })}><GitCommit className="mr-2 h-4 w-4" />{t("repoStatus.commit")}</DropdownMenuItem>
              <DropdownMenuItem disabled={!currentBook || !currentToken || !!repoActionBusy} onSelect={() => void runRepoAction("push", async () => { const result = await pushLocalCommits({ bookId: currentBook!.id, token: currentToken }); return t("repoStatus.pushDone", { count: result.files }); })}><UploadCloud className="mr-2 h-4 w-4" />{t("repoStatus.push")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button variant="ghost" size="icon" aria-label={floatingHidden ? t("shell.showFloating") : t("shell.hideFloating")} onClick={toggleFloating}>
          {floatingHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="icon" aria-label={t("shell.readPage")} onClick={() => void handleReadPage()}>
          <Volume2 className="h-4 w-4" />
        </Button>
        <ThemeToggle />
        <LanguageToggle />
        <Button
          variant="ghost"
          size="icon"
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
            <Button variant="ghost" size="icon" className="rounded-full">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="text-xs font-medium">
                  {initials(user?.name)}
                </AvatarFallback>
              </Avatar>
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
            <DropdownMenuItem onClick={() => navigate("/app/settings")}>
              <Settings className="mr-2 h-4 w-4" />
              {t("nav.settings")}
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
              <Activity className="mr-2 h-4 w-4" />
              <span className="flex-1">{t("debug.title")}</span>
              {debugCount > 0 && (
                <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">{debugCount}</span>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/app/docs")}>
              <HelpCircle className="mr-2 h-4 w-4" />
              {t("nav.help")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut}>
              <LogOut className="mr-2 h-4 w-4" />
              {t("shell.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <RepositoryStatusDialog open={repoDialogOpen} onOpenChange={setRepoDialogOpen} book={currentBook} settings={settings} />
    </header>
  );
}
