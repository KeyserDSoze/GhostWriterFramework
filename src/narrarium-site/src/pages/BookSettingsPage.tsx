import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/i18n/bookGithub";
import "@/i18n/githubCreateBook";
import "@/i18n/localFirst";
import "@/i18n/bookSettingsTabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { ConfigTabs, type ConfigTab } from "@/components/autopilot/config/ConfigTabs";
import { AuditTab } from "@/components/book/settings/AuditTab";
import { ExportTab } from "@/components/book/settings/ExportTab";
import { GeneralTab } from "@/components/book/settings/GeneralTab";
import { GitHubTab } from "@/components/book/settings/GitHubTab";
import { OnlineReaderTab } from "@/components/book/settings/OnlineReaderTab";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useRegisterPageSave } from "@/store/saveStore";
import { bookStorageMode, type BookEntry } from "@/types/settings";
import { applyDraft, draftOfBook, isDraftDirty, type BookSettingsDraft } from "@/bookSettings/draft";
import { chooseBranch } from "@/branches/memoryEdits";
import { DEFAULT_BOOK_SETTINGS_TAB, bookSettingsHash, bookSettingsTabOfHash, bookSettingsTabState, type BookSettingsTab } from "@/bookSettings/tabs";

interface Session { base: BookEntry; draft: BookSettingsDraft }

/**
 * The settings of a book, in tabs: General (the name, the metadata the reader and exported files show, the MCP server), GitHub (the repository, the token the book
 * uses and its state, the working branch), Online reader (GitHub Pages and its passwords), Export (the export presets) and Audit. The bar at the top saves or
 * discards what was edited; all the tabs edit one draft, and a tab that is not shown is kept (hidden, not drawn again), so that nothing typed is lost by looking
 * at another one. A link can point at a tab (`#github`, `#reader`, …).
 */
export function BookSettingsPage() {
  const { t } = useTranslation();
  const { bookId } = useParams<{ bookId: string }>();
  const location = useLocation();
  const { toast } = useToast();
  const { settings, patchSettings } = useSettingsStore();
  const { save, syncStatus } = useSettings();
  const { clearBook } = useBooksStore();
  const book = settings.books.find((entry) => entry.id === bookId);
  const [session, setSession] = useState<Session | null>(() => (book ? { base: book, draft: draftOfBook(book) } : null));
  const [tab, setTab] = useState<BookSettingsTab>(() => bookSettingsTabOfHash(location.hash) ?? DEFAULT_BOOK_SETTINGS_TAB);
  const [readerOpened, setReaderOpened] = useState(() => tab === "reader");
  const [githubOpened, setGithubOpened] = useState(() => tab === "github");

  // A link to a tab selects it.
  useEffect(() => {
    const next = bookSettingsTabOfHash(location.hash);
    if (next) setTab(next);
  }, [location.hash, location.key]);
  useEffect(() => { if (tab === "reader") setReaderOpened(true); if (tab === "github") setGithubOpened(true); }, [tab]);

  const dirty = Boolean(session && isDraftDirty(session.draft, session.base));
  // The draft follows the book when nothing has been edited (the book changed elsewhere: a repository connected, the connection chosen for it); edits are never replaced.
  useEffect(() => {
    if (!book) { setSession(null); return; }
    setSession((current) => {
      if (!current || current.base.id !== book.id || current.base.storageMode !== book.storageMode || current.base.owner !== book.owner || current.base.repo !== book.repo) return { base: book, draft: draftOfBook(book) };
      return isDraftDirty(current.draft, current.base) ? current : { base: book, draft: draftOfBook(book) };
    });
  }, [book]);

  const saving = syncStatus === "saving";

  async function handleSave(): Promise<boolean> {
    const latest = useSettingsStore.getState().settings.books.find((entry) => entry.id === bookId);
    if (!latest || !session) return false;
    const updated = applyDraft(latest, session.draft);
    const current = useSettingsStore.getState().settings;
    const books = current.books.map((entry) => (entry.id === latest.id ? updated : entry));
    // A branch chosen here is this device's choice, and the last one worked on everywhere (`branchMemory`), like one opened from the switcher.
    const at = new Date().toISOString();
    patchSettings(updated.activeBranch === latest.activeBranch ? { books }
      : updated.activeBranch ? chooseBranch({ ...current, books }, updated, updated.activeBranch, at)
        : { books: books.map((entry) => (entry.id === latest.id ? { ...entry, activeBranchAt: at } : entry)) });
    try { await save(); } catch { return false; }
    clearBook(latest.id);
    toast({ title: t("bookSettings.settingsSaved") });
    const saved = useSettingsStore.getState().settings.books.find((entry) => entry.id === latest.id) ?? updated;
    setSession({ base: saved, draft: draftOfBook(saved) });
    return true;
  }

  useRegisterPageSave({ dirty, enabled: Boolean(book), onSave: handleSave });

  if (!book || !session) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {t("bookSettings.notFound")} <Link to="/app/books" className="underline">{t("bookSettings.backToBooks")}</Link>
        </AlertDescription>
      </Alert>
    );
  }

  const draft = session.draft;
  const patch = (change: Partial<BookSettingsDraft>) => setSession((current) => (current ? { ...current, draft: { ...current.draft, ...change } } : current));
  const selectTab = (key: string) => {
    const next = key as BookSettingsTab;
    setTab(next);
    // The address follows the tab, without a navigation of the router: a link to the tab opens it, and a page with unsaved changes does not ask whether to leave.
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${bookSettingsHash(next)}`);
  };
  const availability = new Map(bookSettingsTabState(book).map((entry) => [entry.tab, entry]));

  const tabs: ConfigTab[] = [
    { key: "general", label: t("bookSettings.tabs.general"), panel: <GeneralTab book={book} name={draft.name} onName={(name) => patch({ name })} presentation={draft.presentation} onPresentation={(change) => setSession((current) => (current ? { ...current, draft: { ...current.draft, presentation: change(current.draft.presentation) } } : current))} /> },
    { key: "github", label: t("bookSettings.tabs.github"), panel: <GitHubTab book={book} draft={draft} patch={patch} opened={githubOpened} onGoToReader={() => selectTab("reader")} /> },
    { key: "reader", label: t("bookSettings.tabs.reader"), panel: <OnlineReaderTab book={book} opened={readerOpened && availability.get("reader")?.available !== false} onGoToGitHub={() => selectTab("github")} /> },
    { key: "export", label: t("bookSettings.tabs.export"), panel: <ExportTab book={book} draft={draft.exportDraft} presentation={draft.presentation} onChange={(exportDraft) => patch({ exportDraft })} /> },
    { key: "audit", label: t("bookSettings.tabs.audit"), panel: <AuditTab audit={draft.audit} onChange={(audit) => patch({ audit })} /> },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">{t("bookSettings.title")}</h1>
        <p className="text-muted-foreground">{bookStorageMode(book) === "local-only" ? t("bookSettings.deviceOnly") : `${book.owner}/${book.repo}`}</p>
      </div>

      <div data-book-settings-bar className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center justify-between gap-2 border-b bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={saving || !dirty} onClick={() => void handleSave()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}{t("settings.save")}
          </Button>
          <Button variant="outline" disabled={saving || !dirty} onClick={() => setSession({ base: book, draft: draftOfBook(book) })}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />{t("bookSettings.tabs.discard")}
          </Button>
        </div>
        <span role="status" className="text-xs font-medium text-muted-foreground">{dirty ? t("bookSettings.tabs.unsaved") : ""}</span>
      </div>

      <ConfigTabs label={t("bookSettings.tabs.label")} tabs={tabs} selected={tab} onSelect={selectTab} idPrefix="book-settings" />
    </div>
  );
}
