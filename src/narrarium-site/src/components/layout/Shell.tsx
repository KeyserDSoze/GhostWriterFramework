import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Search } from "lucide-react";
import i18n from "@/i18n";
import { Sidebar, MobileSidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { DossierDock, DossierSearchDialog } from "./DossierDock";
import { FloatingActions } from "./FloatingActions";
import { NotesDialog } from "./NotesDialog";
import { GlobalContextMenu } from "@/components/editor/GlobalContextMenu";
import { LlmDebugPanel } from "@/components/debug/LlmDebugPanel";
import { GenerateDiffDialog } from "@/components/book/GenerateDiffDialog";
import { SessionStatusPill } from "@/components/layout/SessionStatusPill";
import { PatchNotesDialog } from "@/components/layout/PatchNotesDialog";
import { OnboardingDialog } from "@/components/layout/OnboardingDialog";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useUiStore } from "@/store/uiStore";
import { useTokenRefresh } from "@/hooks/useTokenRefresh";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useCostsSync } from "@/costs/useCostsSync";
import { useCostsStore } from "@/costs/costsStore";
import { useClipboardSync } from "@/clipboard/useClipboardSync";
import { parseAppRoute } from "@/assistant/context";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNavigationHistoryStore, type NavigationHistoryEntry } from "@/store/navigationHistoryStore";

const AssistantPanel = lazy(() =>
  import("@/components/assistant/AssistantPanel").then((module) => ({ default: module.AssistantPanel })),
);

export function Shell() {
  const { load } = useSettings();
  const { t, i18n } = useTranslation();
  const { cloudLoaded, syncStatus, settings } = useSettingsStore();
  const { structures } = useBooksStore();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const notesOpen = useUiStore((s) => s.notesOpen);
  const setNotesOpen = useUiStore((s) => s.setNotesOpen);

  useTokenRefresh();
  useCostsSync();
  useClipboardSync();
  useGlobalShortcuts();

  useEffect(() => {
    const route = parseAppRoute(location.pathname);
    const bookId = "bookId" in route ? route.bookId : undefined;
    const book = bookId ? settings.books.find((b) => b.id === bookId) : undefined;
    useCostsStore.getState().setCurrentBook(bookId, book?.name);
  }, [location.pathname, settings.books]);

  useEffect(() => {
    const route = parseAppRoute(location.pathname);
    const entry = buildHistoryEntry(route, location.pathname, structures);
    if (entry) useNavigationHistoryStore.getState().record(entry);
  }, [location.pathname, settings, structures]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      const route = parseAppRoute(location.pathname);
      const bookId = "bookId" in route ? route.bookId : undefined;

      if (key === "r") {
        if (!bookId) return;
        event.preventDefault();
        navigate(`/app/books/${bookId}/research`);
        return;
      }

      if (key === "l") {
        if (!bookId) return;
        event.preventDefault();
        setQuickOpen(true);
        return;
      }

      if (key === "n") {
        if (!bookId) return;
        event.preventDefault();
        setNotesOpen(true);
        return;
      }

      if (key === "tab") {
        const previous = useNavigationHistoryStore.getState().previous;
        if (!previous) return;
        event.preventDefault();
        navigate(previous.pathname);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [location.pathname, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (cloudLoaded && settings.ui.language && i18n.resolvedLanguage !== settings.ui.language) {
      void i18n.changeLanguage(settings.ui.language);
    }
  }, [cloudLoaded, i18n, settings.ui.language]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  if (!cloudLoaded) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        {syncStatus === "error" ? (
          <>
            <p className="font-semibold">{t("shell.loadError")}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t("shell.loadErrorHint")}</p>
            <Button onClick={() => void load()}>{t("shell.retry")}</Button>
          </>
        ) : (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t("shell.loadingSettings")}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar onOpenMobileNav={() => setMobileNavOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
      <DossierDock />
      <SessionStatusPill />
      <DossierSearchDialog />
      <FloatingActions />
      <GlobalContextMenu />
      <LlmDebugPanel />
      <GenerateDiffDialog />
      <OnboardingDialog />
      <PatchNotesDialog />
      <Suspense fallback={null}>
        <AssistantPanel />
      </Suspense>

      <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DialogContent className="left-0 top-0 h-[100dvh] max-w-none translate-x-0 translate-y-0 rounded-none border-r p-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:left-0 sm:top-0 sm:max-w-sm sm:translate-x-0 sm:translate-y-0 sm:rounded-none">
          <MobileSidebar onNavigate={() => setMobileNavOpen(false)} />
        </DialogContent>
      </Dialog>
      <QuickSwitchDialog open={quickOpen} onOpenChange={setQuickOpen} />
      <NotesDialog open={notesOpen} onOpenChange={setNotesOpen} />
    </div>
  );
}

function buildHistoryEntry(route: ReturnType<typeof parseAppRoute>, pathname: string, structures: ReturnType<typeof useBooksStore.getState>["structures"]): NavigationHistoryEntry | null {
  const bookId = "bookId" in route ? route.bookId : undefined;
  if (!bookId) return null;
  const structure = structures[bookId];
  if (!structure) return null;

  if (route.kind === "paragraph") {
    const chapter = structure.chapters.find((entry) => entry.slug === route.chapterId);
    const paragraph = chapter?.paragraphs.find((entry) => entry.number === route.paragraphNum);
    return { pathname, bookId, kind: "paragraph", label: paragraph ? `${chapter?.title ?? route.chapterId} / ${paragraph.title}` : pathname, updatedAt: Date.now() };
  }
  if (route.kind === "canon") {
    const files = structure[route.section as keyof typeof structure] as Array<{ path: string; name?: string }> | undefined;
    const path = `${route.section}/${route.slug}.md`;
    const file = Array.isArray(files) ? files.find((entry) => entry.path === path || entry.path.endsWith(`/${route.slug}.md`)) : undefined;
    return { pathname, bookId, kind: route.section, label: file?.name ?? route.slug, updatedAt: Date.now() };
  }
  if (route.kind === "research" || route.kind === "research-detail") {
    return { pathname, bookId, kind: "research", label: route.kind === "research-detail" ? route.researchSlug : i18n.t("research.title"), updatedAt: Date.now() };
  }
  return null;
}

interface QuickItem { label: string; subtitle: string; path: string; kind: string }

function navigationKindLabel(t: ReturnType<typeof useTranslation>["t"], kind: string): string {
  if (kind === "chapter") return t("bookPage.chapters");
  if (kind === "paragraph") return t("bookPage.paragraphLabel");
  if (kind === "research") return t("research.title");
  if (kind === "characters") return t("bookPage.characters");
  if (kind === "locations") return t("bookPage.locations");
  if (kind === "factions") return t("bookPage.factions");
  if (kind === "items") return t("bookPage.items");
  if (kind === "timelines") return t("bookPage.timelines");
  if (kind === "secrets") return t("bookPage.secrets");
  return kind;
}

function QuickSwitchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { structures } = useBooksStore();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const route = parseAppRoute(location.pathname);
  const bookId = "bookId" in route ? route.bookId : undefined;
  const structure = bookId ? structures[bookId] : undefined;

  const items = useMemo<QuickItem[]>(() => {
    if (!bookId || !structure) return [];
    const out: QuickItem[] = [];
    structure.chapters.forEach((chapter) => {
      out.push({ label: chapter.title, subtitle: t("nav.chapterOverview"), path: `/app/books/${bookId}/chapters/${chapter.slug}`, kind: "chapter" });
      chapter.paragraphs.forEach((paragraph) => out.push({ label: paragraph.title, subtitle: chapter.title, path: `/app/books/${bookId}/chapters/${chapter.slug}/paragraphs/${paragraph.number}`, kind: "paragraph" }));
    });
    (["characters", "locations", "factions", "items", "timelines", "secrets"] as const).forEach((section) => {
      structure[section].forEach((file) => {
        const slug = file.path.split("/").pop()?.replace(/\.md$/i, "") ?? file.path;
        out.push({ label: file.name ?? slug, subtitle: t(`bookPage.${section}`), path: `/app/books/${bookId}/canon/${section}/${slug}`, kind: section });
      });
    });
    structure.researchFiles.forEach((file) => out.push({ label: file.title || file.slug, subtitle: t("research.title"), path: `/app/books/${bookId}/research`, kind: "research" }));
    return out;
  }, [bookId, structure, t]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items.slice(0, 30);
    return items.filter((item) => `${item.label} ${item.subtitle} ${item.kind}`.toLowerCase().includes(needle)).slice(0, 30);
  }, [items, query]);

  useEffect(() => {
    if (open) { setQuery(""); setActive(0); }
  }, [open]);

  function go(item: QuickItem | undefined) {
    if (!item) return;
    navigate(item.path);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[18vh] max-w-2xl translate-y-0">
        <DialogHeader><DialogTitle>{t("quickSwitch.title")}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              placeholder={t("quickSwitch.placeholder")}
              className="pl-9"
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(filtered.length - 1, value + 1)); }
                if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
                if (event.key === "Enter") { event.preventDefault(); go(filtered[active]); }
              }}
            />
          </div>
          <div className="max-h-[55vh] overflow-auto rounded-lg border p-1">
            {filtered.length === 0 ? <p className="p-3 text-sm text-muted-foreground">{t("quickSwitch.empty")}</p> : filtered.map((item, index) => (
              <button
                key={`${item.path}-${index}`}
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => go(item)}
                className={index === active ? "flex w-full items-center justify-between gap-3 rounded-md bg-accent px-3 py-2 text-left" : "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-accent"}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{item.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>
                </span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{navigationKindLabel(t, item.kind)}</span>
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
