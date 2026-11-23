import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ clientId: "Iv1.client-id", slug: "narrarium", broker: true as boolean | null, save: vi.fn(async () => true) }));
vi.mock("@/config/publicClients", () => ({ get GITHUB_APP_CLIENT_ID() { return env.clientId; }, get GITHUB_APP_SLUG() { return env.slug; }, GOOGLE_CLIENT_ID: "g", MICROSOFT_CLIENT_ID: "m" }));
vi.mock("@/hooks/useBrokerAvailability", () => ({ useBrokerAvailability: () => env.broker }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: env.save }) }));

import i18n from "@/i18n";
import { GitHubAccessSection, type GitHubAccessSectionProps } from "@/components/account/GitHubAccessSection";
import { GitHubServerTokenNotice } from "@/components/book/GitHubServerTokenNotice";
import { BookGitHubAccess } from "@/components/book/BookGitHubAccess";
import { useConnectionStore } from "@/account/connectionStore";
import type { LocalGitHubConnection } from "@/account/types";
import { setConnectedGitHubToken } from "@/github/githubCredentialRuntime";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { createFakeNetwork, jsonResponse, type FakeNetwork } from "./oauthTestKit";

const TEXTS = {
  en: {
    notEnabled: "Sign-in with GitHub is not enabled on this site yet.", connect: "Connect with GitHub", recommended: "Recommended", pat: "Use a personal access token (advanced)", patHelp: /several GitHub accounts/,
    appConnected: "Connected with the GitHub app as writer.", patConnected: "Connected with a personal access token as writer.", longLived: /renews its 8-hour token by itself/, memory: /only while this tab is open/, reconnectNeeded: /has to be renewed/, reconnect: "Reconnect GitHub",
    none: /not installed on any of your accounts yet/, all: "Installed on all the repositories of me.", selected: "Installed on these 2 repositories of me.", choose: "Choose repositories on GitHub", manage: "Change repositories on GitHub", refresh: "Check again",
    outside: /me\/two is not among the repositories the app can use/, notInstalled: /acme has not installed the app, so it cannot reach acme\/book. An owner of acme has to install or approve it/, reachable: "The app can reach me/one.",
    sso: /requires single sign-on \(SAML\)/, uses: (what: string) => `One: ${what}`, appUses: "your GitHub connection (the app)", defaultUses: "the default token", prefer: "Prefer the GitHub connection over the default token", serverWarning: "App tokens last 8 hours; for a book your server runs, use a personal access token (or keep the browser open).", bookTitle: "GitHub access of this book",
  },
  it: {
    notEnabled: "L'accesso con GitHub non è ancora attivo su questo sito.", connect: "Connetti con GitHub", recommended: "Consigliato", pat: "Usa un token di accesso personale (avanzato)", patHelp: /più account GitHub/,
    appConnected: "Connesso con la GitHub App come writer.", patConnected: "Connesso con un token di accesso personale come writer.", longLived: /rinnova da sola il suo token da 8 ore/, memory: /solo finché questa scheda è aperta/, reconnectNeeded: /va rinnovato/, reconnect: "Riconnetti GitHub",
    none: /non è ancora installata su nessuno dei tuoi account/, all: "Installata su tutti i repository di me.", selected: "Installata su questi 2 repository di me.", choose: "Scegli i repository su GitHub", manage: "Cambia i repository su GitHub", refresh: "Controlla di nuovo",
    outside: /me\/two non è tra i repository che l'app può usare/, notInstalled: /acme non ha installato l'app, quindi non può raggiungere acme\/book. Un proprietario di acme deve installarla o approvarla/, reachable: "L'app può raggiungere me/one.",
    sso: /richiede il single sign-on \(SAML\)/, uses: (what: string) => `One: ${what}`, appUses: "la tua connessione GitHub (l'app)", defaultUses: "il token predefinito", prefer: "Preferisci la connessione GitHub al token predefinito", serverWarning: "I token dell'app durano 8 ore; per un libro gestito dal tuo server usa un token di accesso personale (o tieni il browser aperto).", bookTitle: "Accesso a GitHub di questo libro",
  },
} as const;

const book = (patch: Partial<BookEntry> = {}): BookEntry => ({ id: "b1", owner: "me", repo: "one", name: "One", tokenIndex: null, addedAt: "2026-11-01T00:00:00.000Z", ...patch });
const app = (patch: Partial<LocalGitHubConnection> = {}): LocalGitHubConnection => ({ backend: "github", method: "github-app", credentialKind: "app", identity: { provider: "github", providerAccountId: "4242", displayName: "W", username: "writer" }, token: "ghu_app", accessTokenExpiry: Date.now() + 3_600_000, refreshToken: "ghr_refresh", rememberMe: true, accountSyncEnabled: false, repositoryName: "narrarium.settings", replica: { enabled: false, status: "disabled" }, ...patch });
const pat = (): LocalGitHubConnection => ({ backend: "github", method: "github-pat", credentialKind: "pat", identity: { provider: "github", providerAccountId: "1", displayName: "W", username: "writer" }, token: "ghp_pat", rememberMe: true, accountSyncEnabled: true, repositoryName: "narrarium.settings", replica: { enabled: true, status: "idle" } });

let net: FakeNetwork;
const INSTALLATIONS = "https://api.github.com/user/installations?per_page=100&page=1";
const installation = (selection: "all" | "selected", account = "me", id = 1) => ({ id, app_slug: "narrarium", account: { login: account, type: account === "me" ? "User" : "Organization" }, repository_selection: selection, html_url: `https://github.com/settings/installations/${id}` });

function props(patch: Partial<GitHubAccessSectionProps> = {}): GitHubAccessSectionProps {
  return { connection: undefined, rememberMe: true, onRememberChange: vi.fn(), onConnect: vi.fn(), starting: false, startError: null, pat: "", onPatChange: vi.fn(), onConnectPat: vi.fn(), busy: false, ...patch };
}

async function open(language: "en" | "it", properties: GitHubAccessSectionProps, books: BookEntry[] = [book()], settings: Record<string, unknown> = {}) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books, ui: { ...DEFAULT_SETTINGS.ui, language }, ...settings } });
  useConnectionStore.setState({ hydrated: true, configuration: properties.connection ? { github: properties.connection } : {} });
  await i18n.changeLanguage(language);
  return render(<MemoryRouter><GitHubAccessSection {...properties} /></MemoryRouter>);
}

beforeEach(() => {
  env.clientId = "Iv1.client-id"; env.slug = "narrarium"; env.broker = true; env.save.mockClear();
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  setConnectedGitHubToken(undefined);
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  setConnectedGitHubToken(undefined);
  useConnectionStore.setState({ hydrated: true, configuration: {} });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe.each(["en", "it"] as const)("the GitHub card in %s", (language) => {
  const text = TEXTS[language];

  describe("not connected", () => {
    it("says in one honest line that sign-in with GitHub is not enabled when the broker does not serve it, and offers the PAT (open)", async () => {
      env.broker = false;
      await open(language, props());
      expect(screen.getByText(text.notEnabled, { exact: false })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: text.connect })).toBeNull();
      const summary = screen.getByText(text.pat);
      expect(summary.closest("details")).toHaveAttribute("open");
      expect(screen.getByLabelText(language === "it" ? "Token di accesso personale" : "Personal access token")).toBeInTheDocument();
    });

    it("says the same when the broker says yes but this build has no client id for the app", async () => {
      env.clientId = "";
      await open(language, props());
      expect(screen.getByText(text.notEnabled, { exact: false })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: text.connect })).toBeNull();
    });

    it("offers «Connect with GitHub», recommended, when the broker says yes and the build has the id; the PAT is behind a disclosure", async () => {
      const properties = props();
      await open(language, properties);
      const connect = screen.getByRole("button", { name: text.connect });
      expect(screen.getByText(text.recommended)).toBeInTheDocument();
      expect(screen.queryByText(text.notEnabled, { exact: false })).toBeNull();
      expect(screen.getByText(text.pat).closest("details")).not.toHaveAttribute("open");
      fireEvent.click(connect);
      expect(properties.onConnect).toHaveBeenCalledTimes(1);
    });

    it("keeps the device choice as a labelled switch that is on by default and can be changed", async () => {
      const properties = props();
      await open(language, properties);
      const remember = screen.getByRole("switch", { name: language === "it" ? "Mantieni questa connessione su questo dispositivo" : "Keep this connection on this device" });
      expect(remember).toBeChecked();
      fireEvent.click(remember);
      expect(properties.onRememberChange).toHaveBeenCalledWith(false);
    });

    it("is not clickable while the sign-in starts, and says so", async () => {
      await open(language, props({ starting: true }));
      expect(screen.getByRole("button", { name: language === "it" ? "Apro GitHub…" : "Opening GitHub…" })).toBeDisabled();
    });

    it("says what the broker is being asked while it has not answered", async () => {
      env.broker = null;
      await open(language, props());
      expect(screen.getByText(language === "it" ? "Controllo se l'accesso con GitHub è disponibile…" : "Checking whether sign-in with GitHub is available…").closest("[role=status]")).not.toBeNull();
      expect(screen.queryByRole("button", { name: text.connect })).toBeNull();
    });

    it("keeps the PAT field working: its button is off until there is a token, and sends it", async () => {
      env.broker = false;
      const properties = props({ pat: "" });
      const { rerender } = await open(language, properties);
      const button = screen.getByRole("button", { name: language === "it" ? "Usa questo token" : "Use this token" });
      expect(button).toBeDisabled();
      rerender(<MemoryRouter><GitHubAccessSection {...props({ pat: "ghp_typed" })} /></MemoryRouter>);
      fireEvent.click(screen.getByRole("button", { name: language === "it" ? "Usa questo token" : "Use this token" }));
    });

    it("explains when to prefer a personal access token", async () => {
      env.broker = false;
      await open(language, props());
      expect(screen.getByText(text.patHelp, { exact: false })).toBeInTheDocument();
    });
  });

  describe("connected with the app", () => {
    it("says who, how long it stays signed in, and that disconnecting revokes the app's access", async () => {
      net.reply("GET", INSTALLATIONS, { installations: [installation("all")] });
      await open(language, props({ connection: app() }));
      expect(screen.getByText(text.appConnected)).toBeInTheDocument();
      expect(screen.getByText(text.longLived)).toBeInTheDocument();
      expect(screen.getByText(language === "it" ? /revoca anche l'accesso dell'app su GitHub/ : /also revokes the app's access at GitHub/)).toBeInTheDocument();
      await screen.findByText(text.all);
    });

    it("says it stays signed in only while the tab is open when the device does not keep it", async () => {
      net.reply("GET", INSTALLATIONS, { installations: [] });
      await open(language, props({ connection: app({ rememberMe: false }) }));
      expect(screen.getByText(text.memory)).toBeInTheDocument();
    });

    it("shows where the app is installed: none yet, with the install link and a way to check again", async () => {
      net.reply("GET", INSTALLATIONS, { installations: [] });
      await open(language, props({ connection: app() }));
      expect(await screen.findByText(text.none)).toBeInTheDocument();
      const link = screen.getByRole("link", { name: new RegExp(text.choose) });
      expect(link).toHaveAttribute("href", "https://github.com/apps/narrarium/installations/new");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
      net.reply("GET", INSTALLATIONS, { installations: [installation("all")] });
      fireEvent.click(screen.getByRole("button", { name: text.refresh }));
      expect(await screen.findByText(text.all)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: new RegExp(text.manage) })).toHaveAttribute("href", "https://github.com/settings/installations/1");
    });

    it("lists the repositories of a selected installation, and says a book outside them cannot be reached, with the same button", async () => {
      net.reply("GET", INSTALLATIONS, { installations: [installation("selected")] });
      net.reply("GET", "https://api.github.com/user/installations/1/repositories?per_page=100&page=1", { repositories: [{ full_name: "me/one" }, { full_name: "me/three" }] });
      const books = [book(), book({ id: "b2", repo: "two", name: "Two" })];
      setConnectedGitHubToken("ghu_app", "app");
      await open(language, props({ connection: app() }), books);
      expect(await screen.findByText(text.selected)).toBeInTheDocument();
      expect(within(screen.getByRole("list", { name: language === "it" ? "Repository di me" : "Repositories of me" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["me/one", "me/three"]);
      expect(await screen.findByText(text.reachable)).toBeInTheDocument();
      expect(screen.getByText(text.outside)).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: new RegExp(text.choose) }).length).toBeGreaterThanOrEqual(1);
    });

    it("says who has to install the app for a book of an organization that has not approved it", async () => {
      net.reply("GET", INSTALLATIONS, { installations: [installation("all")] });
      setConnectedGitHubToken("ghu_app", "app");
      await open(language, props({ connection: app() }), [book({ owner: "acme", repo: "book", name: "Org book" })]);
      expect(await screen.findByText(text.notInstalled)).toBeInTheDocument();
    });

    it("explains a SAML organization that blocked the list, and the reconnect case", async () => {
      net.reply("GET", INSTALLATIONS, { message: "Resource protected by organization SAML enforcement." }, 403);
      await open(language, props({ connection: app() }));
      expect(await screen.findByText(text.sso)).toBeInTheDocument();
      cleanup();
      net.reply("GET", INSTALLATIONS, { message: "Bad credentials" }, 401);
      await open(language, props({ connection: app() }));
      expect(await screen.findByText(language === "it" ? /Riconnetti GitHub, poi controlla di nuovo/ : /Reconnect GitHub, then check again/)).toBeInTheDocument();
    });

    it("offers «Reconnect GitHub» when the sign-in has to be renewed, and says nothing is lost", async () => {
      net.reply("GET", INSTALLATIONS, { installations: [installation("all")] });
      const properties = props({ connection: app({ refreshToken: undefined, accessTokenExpiry: Date.now() - 1_000, replica: { enabled: false, status: "needs-auth", errorKind: "credential-expired" } }) });
      await open(language, properties);
      expect(screen.getByText(text.reconnectNeeded)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: text.reconnect }));
      expect(properties.onConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe("connected with a personal access token", () => {
    it("says so, and mentions the app as an option when it is available; the PAT field stays reachable", async () => {
      await open(language, props({ connection: pat() }));
      expect(screen.getByText(text.patConnected)).toBeInTheDocument();
      expect(screen.getByText(language === "it" ? /Puoi anche accedere con la GitHub App/ : /You can also sign in with the GitHub app/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: text.connect })).toBeInTheDocument();
      expect(net.calls).toHaveLength(0);
    });
  });

  describe("which token each book uses", () => {
    it("says it for every book on GitHub, in words", async () => {
      setConnectedGitHubToken("ghp_conn", "connected-pat");
      const books = [book(), book({ id: "b2", repo: "two", name: "Two", bookToken: "ghp_own" })];
      await open(language, props({ connection: pat() }), books, { defaultGitHubToken: "ghp_default" });
      const list = screen.getByRole("list", { name: language === "it" ? "Libri e relativi token" : "Books and their tokens" });
      expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([text.uses(text.defaultUses), `Two: ${language === "it" ? "un token proprio" : "its own token"}`]);
    });

    it("«Prefer the GitHub connection» is a labelled switch that moves the connection ahead of the default token and saves", async () => {
      net.reply("GET", INSTALLATIONS, { installations: [installation("all")] });
      setConnectedGitHubToken("ghu_app", "app");
      await open(language, props({ connection: app() }), [book()], { defaultGitHubToken: "ghp_default" });
      const list = screen.getByRole("list", { name: language === "it" ? "Libri e relativi token" : "Books and their tokens" });
      expect(list).toHaveTextContent(text.uses(text.defaultUses));
      const prefer = screen.getByRole("switch", { name: text.prefer });
      expect(prefer).not.toBeChecked();
      fireEvent.click(prefer);
      await waitFor(() => expect(useSettingsStore.getState().settings.githubPreferConnection).toBe(true));
      expect(env.save).toHaveBeenCalled();
      expect(await screen.findByText(text.uses(text.appUses))).toBeInTheDocument();
      fireEvent.click(screen.getByRole("switch", { name: text.prefer }));
      await waitFor(() => expect(useSettingsStore.getState().settings.githubPreferConnection).toBeUndefined());
    });

    it("warns, for a book a personal server runs on the app's token, that the token lasts 8 hours", async () => {
      net.reply("GET", INSTALLATIONS, { installations: [installation("all")] });
      setConnectedGitHubToken("ghu_app", "app");
      await open(language, props({ connection: app() }), [book({ autopilotHost: "server" }), book({ id: "b2", repo: "two", name: "Two", bookToken: "ghp_own", autopilotHost: "server" })]);
      expect(await screen.findAllByText(text.serverWarning)).toHaveLength(1);
    });
  });
});

describe("in a book's own settings", () => {
  it.each(["en", "it"] as const)("says which token the book uses, whether the app reaches it, and warns about a server-run book (%s)", async (language) => {
    const text = TEXTS[language];
    net.reply("GET", INSTALLATIONS, { installations: [installation("selected")] });
    net.reply("GET", "https://api.github.com/user/installations/1/repositories?per_page=100&page=1", { repositories: [{ full_name: "me/other" }] });
    setConnectedGitHubToken("ghu_app", "app");
    const current = book({ autopilotHost: "server" });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [current], ui: { ...DEFAULT_SETTINGS.ui, language } } });
    useConnectionStore.setState({ hydrated: true, configuration: { github: app() } });
    await i18n.changeLanguage(language);
    render(<MemoryRouter><BookGitHubAccess book={current} /></MemoryRouter>);
    expect(screen.getByText(text.bookTitle)).toBeInTheDocument();
    expect(screen.getByText(language === "it" ? "Questo libro usa: la tua connessione GitHub (l'app)." : "This book uses: your GitHub connection (the app).")).toBeInTheDocument();
    expect(await screen.findByText(language === "it" ? /me\/one non è tra i repository che l'app può usare/ : /me\/one is not among the repositories the app can use/)).toBeInTheDocument();
    expect(screen.getByTestId("github-server-token-notice")).toHaveTextContent(text.serverWarning);
  });

  it("shows no server warning for a personal access token, and nothing for a local book", async () => {
    const current = book({ autopilotHost: "server", bookToken: "ghp_own" });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [current] } });
    useConnectionStore.setState({ hydrated: true, configuration: {} });
    const { container, rerender } = render(<MemoryRouter><GitHubServerTokenNotice book={current} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
    const local = book({ storageMode: "local-only" });
    rerender(<MemoryRouter><BookGitHubAccess book={local} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
    void jsonResponse;
  });
});
