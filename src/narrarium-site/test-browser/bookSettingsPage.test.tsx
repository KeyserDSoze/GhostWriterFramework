import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ save: vi.fn(async () => true), readerMounts: 0 }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: env.save, syncStatus: "idle" }) }));
vi.mock("@/components/book/McpServerSection", () => ({ McpServerSection: () => <section aria-label="mcp-stub" /> }));
vi.mock("@/components/book/BookGitHubAccess", () => ({ BookGitHubAccess: () => <section aria-label="book-github-access-stub" /> }));
vi.mock("@/components/book/GitHubRepositoryPicker", () => ({ GitHubRepositoryPicker: () => <section aria-label="picker-stub" /> }));
vi.mock("@/components/book/readerAccess/ReaderTabContent", () => ({ ReaderTabContent: () => { env.readerMounts += 1; return <section aria-label="reader-access-stub">Reader access card</section>; } }));

import i18n from "@/i18n";
import { BookSettingsPage } from "@/pages/BookSettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { useSaveStore, triggerCurrentSave } from "@/store/saveStore";
import { useConnectionStore } from "@/account/connectionStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const GITHUB_BOOK: BookEntry = { id: "b1", owner: "ada", repo: "glass-harbor", name: "Glass Harbor", tokenIndex: null, activeBranch: "main", addedAt: "2026-11-01T00:00:00.000Z" };
const LOCAL_BOOK: BookEntry = { id: "b2", owner: "", repo: "", name: "Local Book", tokenIndex: null, storageMode: "local-only", activeBranch: "local:b2", addedAt: "2026-11-01T00:00:00.000Z" };

const TEXTS = {
  en: { tabs: ["General", "GitHub", "Online reader", "Export", "Audit"], tablist: "Sections of the book settings", save: "Save", discard: "Discard changes", unsaved: "Unsaved changes", name: "Name", notFound: "Book not found.", needsGitHub: /lives only on this device, so it cannot have one yet/, goToGitHub: "Go to the GitHub tab", localBranch: "Local working branch", onlyHere: /only on this device/, publishedAs: "published as main on GitHub", connectTitle: "Connect this book to GitHub", auditSwitch: "Enable audit", repository: "ada/glass-harbor", appStatus: /Connected as ada with the GitHub app/ },
  it: { tabs: ["Generale", "GitHub", "Lettore online", "Esportazione", "Audit"], tablist: "Sezioni delle impostazioni del libro", save: "Salva", discard: "Annulla le modifiche", unsaved: "Modifiche non salvate", name: "Nome", notFound: "Libro non trovato.", needsGitHub: /vive solo su questo dispositivo, quindi non può averne uno/, goToGitHub: "Vai alla scheda GitHub", localBranch: "Ramo di lavoro locale", onlyHere: /solo su questo dispositivo/, publishedAs: "pubblicato come main su GitHub", connectTitle: "Collega il libro a GitHub", auditSwitch: "Abilita audit", repository: "ada/glass-harbor", appStatus: /Connesso come ada con la GitHub App/ },
} as const;

function mount(book: BookEntry, hash = "") {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "ghp_default", books: [book] } });
  return render(
    <MemoryRouter initialEntries={[`/app/books/${book.id}/settings${hash}`]}>
      <Routes><Route path="/app/books/:bookId/settings" element={<BookSettingsPage />} /></Routes>
    </MemoryRouter>,
  );
}

const tab = (name: string) => screen.getByRole("tab", { name });
const panelOf = (name: string) => document.getElementById(tab(name).getAttribute("aria-controls")!) as HTMLElement;
const bookNow = (id = "b1") => useSettingsStore.getState().settings.books.find((entry) => entry.id === id)!;

beforeEach(() => { env.save.mockClear(); env.readerMounts = 0; window.history.replaceState(null, "", "/"); });
afterEach(async () => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useSaveStore.setState({ current: null });
  useConnectionStore.setState({ configuration: {} });
  await i18n.changeLanguage("en");
});

describe.each(["en", "it"] as const)("the settings of a book in tabs, in %s", (language) => {
  const text = TEXTS[language];
  beforeEach(async () => { await i18n.changeLanguage(language); });

  it("has the five tabs in a labelled tablist, General selected, only its panel shown, and no tab or panel is drawn again on a switch", async () => {
    mount(GITHUB_BOOK);
    const list = await screen.findByRole("tablist", { name: text.tablist });
    expect(within(list).getAllByRole("tab").map((entry) => entry.textContent)).toEqual([...text.tabs]);
    expect(tab(text.tabs[0])).toHaveAttribute("aria-selected", "true");
    for (const name of text.tabs) expect(panelOf(name)).toHaveAttribute("role", "tabpanel");
    expect(panelOf(text.tabs[0])).not.toHaveAttribute("hidden");
    expect(panelOf(text.tabs[1])).toHaveAttribute("hidden");
    const nameField = screen.getByLabelText(text.name);
    fireEvent.click(tab(text.tabs[4]));
    expect(panelOf(text.tabs[4])).not.toHaveAttribute("hidden");
    expect(panelOf(text.tabs[0])).toHaveAttribute("hidden");
    fireEvent.click(tab(text.tabs[0]));
    expect(screen.getByLabelText(text.name)).toBe(nameField);
  });

  it("opens the tab an address names, and follows the tab in the address without leaving the page", async () => {
    mount(GITHUB_BOOK, "#github");
    expect(await screen.findByRole("tab", { name: text.tabs[1], selected: true })).toBeInTheDocument();
    fireEvent.click(tab(text.tabs[3]));
    expect(window.location.hash).toBe("#export");
    fireEvent.click(tab(text.tabs[4]));
    expect(window.location.hash).toBe("#audit");
    cleanup();
    mount(GITHUB_BOOK, "#reader");
    expect(await screen.findByRole("tab", { name: text.tabs[2], selected: true })).toBeInTheDocument();
  });

  it("moves between the tabs with the arrow keys, Home and End, selects the tab it lands on, focuses it, and only the selected tab is in the tab order", async () => {
    mount(GITHUB_BOOK);
    const first = await screen.findByRole("tab", { name: text.tabs[0] });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(tab(text.tabs[1])).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tab(text.tabs[1]));
    expect(tab(text.tabs[1])).toHaveAttribute("tabindex", "0");
    expect(tab(text.tabs[0])).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(tab(text.tabs[1]), { key: "End" });
    expect(tab(text.tabs[4])).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab(text.tabs[4]), { key: "ArrowRight" });
    expect(tab(text.tabs[0])).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab(text.tabs[0]), { key: "ArrowLeft" });
    expect(tab(text.tabs[4])).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab(text.tabs[4]), { key: "Home" });
    expect(tab(text.tabs[0])).toHaveAttribute("aria-selected", "true");
    expect(window.location.hash).toBe("#general");
  });

  it("keeps what was edited in one tab when another is shown, marks the page as unsaved, and saves every tab at once from the bar", async () => {
    mount(GITHUB_BOOK);
    const save = await screen.findByRole("button", { name: text.save });
    expect(save).toBeDisabled();
    expect(useSaveStore.getState().current?.dirty).toBe(false);
    fireEvent.change(screen.getByLabelText(text.name), { target: { value: "Glass Harbor II" } });
    expect(save).toBeEnabled();
    expect(screen.getByText(text.unsaved)).toBeInTheDocument();
    expect(useSaveStore.getState().current?.dirty).toBe(true);

    fireEvent.click(tab(text.tabs[4]));
    fireEvent.click(within(panelOf(text.tabs[4])).getByRole("switch", { name: text.auditSwitch }));
    fireEvent.click(tab(text.tabs[0]));
    expect((screen.getByLabelText(text.name) as HTMLInputElement).value).toBe("Glass Harbor II");

    fireEvent.click(save);
    await waitFor(() => expect(env.save).toHaveBeenCalledTimes(1));
    expect(bookNow().name).toBe("Glass Harbor II");
    expect(bookNow().auditSettings?.enabled).toBe(false);
    await waitFor(() => expect(save).toBeDisabled());
    expect(screen.queryByText(text.unsaved)).toBeNull();
    expect(useSaveStore.getState().current?.dirty).toBe(false);
    // It stays on the page: the tab and what was typed are still there.
    expect((screen.getByLabelText(text.name) as HTMLInputElement).value).toBe("Glass Harbor II");
  });

  it("is saved by the shortcut too (the page registers its save), and discards what was edited when asked", async () => {
    mount(GITHUB_BOOK);
    await screen.findByRole("button", { name: text.save });
    fireEvent.change(screen.getByLabelText(text.name), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: text.discard }));
    expect((screen.getByLabelText(text.name) as HTMLInputElement).value).toBe("Glass Harbor");
    expect(useSaveStore.getState().current?.dirty).toBe(false);
    fireEvent.change(screen.getByLabelText(text.name), { target: { value: "Changed" } });
    expect(await triggerCurrentSave()).toBe(true);
    expect(bookNow().name).toBe("Changed");
  });

  it("edits the export presets in the Export tab, with every field named, and writes them with the rest when saved", async () => {
    mount(GITHUB_BOOK, "#export");
    const panel = panelOf(text.tabs[3]);
    const size = within(panel).getByLabelText(language === "en" ? "Font size" : "Dimensione font") as HTMLInputElement;
    fireEvent.change(size, { target: { value: "14" } });
    expect(await screen.findByText(text.unsaved)).toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText(language === "en" ? "New preset (e.g. Generic publisher)" : "Nuovo preset (es. Mondadori)"), { target: { value: "Ebook" } });
    fireEvent.click(within(panel).getByRole("button", { name: language === "en" ? "Add preset" : "Aggiungi preset" }));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(env.save).toHaveBeenCalled());
    expect(bookNow().exportProfiles?.map((profile) => profile.name)).toEqual(["Default", "Ebook"]);
    expect(bookNow().exportSettings).toMatchObject({ fontSize: 14 });
    expect(bookNow().defaultExportProfileId).toBe(bookNow().exportProfiles![1].id);
  });

  it("does not ask GitHub about the reader until its tab is opened", async () => {
    mount(GITHUB_BOOK);
    await screen.findByRole("tablist");
    expect(env.readerMounts).toBe(0);
    fireEvent.click(tab(text.tabs[2]));
    expect(await screen.findByLabelText("reader-access-stub")).toBeInTheDocument();
    expect(env.readerMounts).toBeGreaterThan(0);
  });

  it("for a book on GitHub: the repository, the token and its status, and the working branch published on GitHub", async () => {
    mount(GITHUB_BOOK, "#github");
    const panel = panelOf(text.tabs[1]);
    expect(within(panel).getByRole("link", { name: new RegExp(text.repository) })).toHaveAttribute("href", "https://github.com/ada/glass-harbor");
    expect(within(panel).getByLabelText("book-github-access-stub")).toBeInTheDocument();
    expect(within(panel).getByTestId("working-branch-state")).toHaveTextContent(text.publishedAs);
  });

  it("for a book that uses the GitHub app, the token status says what is known instead of an unknown expiry", async () => {
    useConnectionStore.setState({ configuration: { github: { backend: "github", method: "github-app", credentialKind: "app", identity: { provider: "github", providerAccountId: "1", displayName: "Ada", username: "ada" }, token: "ghu_app", accessTokenExpiry: Date.now() + 3_600_000, refreshToken: "ghr_x", rememberMe: true, accountSyncEnabled: true, repositoryName: "narrarium.settings", replica: { enabled: true, status: "idle" } } } });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "", githubPreferConnection: true, books: [GITHUB_BOOK] } });
    const { setConnectedGitHubToken } = await import("@/github/githubCredentialRuntime");
    setConnectedGitHubToken("ghu_app", "app");
    try {
      render(<MemoryRouter initialEntries={["/app/books/b1/settings#github"]}><Routes><Route path="/app/books/:bookId/settings" element={<BookSettingsPage />} /></Routes></MemoryRouter>);
      const panel = panelOf(text.tabs[1]);
      expect(await within(panel).findByText(text.appStatus)).toBeInTheDocument();
      expect(within(panel).queryByText(/Expiration unknown|Scadenza sconosciuta/)).toBeNull();
      expect(panel.querySelector("time")).not.toBeNull();
    } finally { setConnectedGitHubToken(undefined); }
  });

  describe("a book that lives only on this device", () => {
    it("has a GitHub tab that offers to connect it, with its working branch shown as only on this device", async () => {
      mount(LOCAL_BOOK, "#github");
      const panel = panelOf(text.tabs[1]);
      expect(await within(panel).findByText(text.connectTitle)).toBeInTheDocument();
      expect(within(panel).getByLabelText("picker-stub")).toBeInTheDocument();
      expect(within(panel).getByTestId("working-branch-state")).toHaveTextContent(text.localBranch);
      expect(within(panel).getByTestId("working-branch-state")).toHaveTextContent(text.onlyHere);
      expect(within(panel).queryByRole("link")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("has an Online reader tab that says why it is not available and takes to the GitHub tab, never asking GitHub for anything", async () => {
      mount(LOCAL_BOOK, "#reader");
      const panel = panelOf(text.tabs[2]);
      expect(await within(panel).findByTestId("online-reader-unavailable")).toHaveTextContent(text.needsGitHub);
      expect(env.readerMounts).toBe(0);
      fireEvent.click(within(panel).getByRole("button", { name: text.goToGitHub }));
      expect(tab(text.tabs[1])).toHaveAttribute("aria-selected", "true");
    });

    it("can be renamed, exported and audited like any other book", async () => {
      mount(LOCAL_BOOK);
      fireEvent.change(await screen.findByLabelText(text.name), { target: { value: "Renamed" } });
      fireEvent.click(tab(text.tabs[4]));
      expect(within(panelOf(text.tabs[4])).getByRole("switch", { name: text.auditSwitch })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: text.save }));
      await waitFor(() => expect(bookNow("b2").name).toBe("Renamed"));
      expect(bookNow("b2").activeBranch).toBe("local:b2");
      expect(bookNow("b2").storageMode).toBe("local-only");
    });
  });

  it("says so when the book does not exist", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [] } });
    render(<MemoryRouter initialEntries={["/app/books/zzz/settings"]}><Routes><Route path="/app/books/:bookId/settings" element={<BookSettingsPage />} /></Routes></MemoryRouter>);
    expect(await screen.findByText(text.notFound)).toBeInTheDocument();
  });
});

describe("the draft and the book", () => {
  it("follows the book when it changed elsewhere and nothing was edited, and keeps what was edited otherwise", async () => {
    mount(GITHUB_BOOK);
    const field = await screen.findByLabelText("Name");
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, books: [{ ...GITHUB_BOOK, name: "Renamed elsewhere" }] } });
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Renamed elsewhere"));
    expect(screen.getByLabelText("Name")).toBe(field);
    fireEvent.change(field, { target: { value: "Mine" } });
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, books: [{ ...GITHUB_BOOK, name: "Renamed again" }] } });
    await waitFor(() => expect(bookNow().name).toBe("Renamed again"));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Mine");
  });

  it("starts again from the book when a book on this device is connected to GitHub, so that its branch is the GitHub one and not the local name", async () => {
    mount(LOCAL_BOOK);
    await screen.findByLabelText("Name");
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, books: [{ ...LOCAL_BOOK, storageMode: "github", owner: "ada", repo: "local-book", activeBranch: "main" }] } });
    fireEvent.click(tab("GitHub"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
    expect(screen.getByRole("link", { name: /ada\/local-book/ })).toBeInTheDocument();
  });
});
