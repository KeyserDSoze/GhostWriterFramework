import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerRequestError, type ServerMcpClient } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  server: null as unknown as { verified: () => unknown },
  /** The connection every request to the server was made with. */
  connections: [] as unknown[],
  toast: vi.fn(),
}));

vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => undefined), syncStatus: "idle" }) }));
vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async (options?: { connection?: unknown }) => {
    mocks.connections.push(options?.connection);
    return mocks.server.verified();
  },
}));

import i18n from "@/i18n";
import { McpServerSection } from "@/components/book/McpServerSection";
import { BookSettingsPage } from "@/pages/BookSettingsPage";
import { formatDateTime } from "@/autopilot/format";
import { useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry, type PersonalServerSettings } from "@/types/settings";
import { FakeBookServer, MCP_LOCAL_MESSAGE, PIN } from "./helpers/fakeBookServer";

type Language = "en" | "it";

const T0 = "2026-11-21T10:00:00.000Z";
/** The client token of this device: what the app keeps to reach the server, and never shows. */
const DEVICE_TOKEN = "nrs_device_secret_token_0123456789";
const CONNECTION: PersonalServerSettings = { url: "http://127.0.0.1:24242", token: DEVICE_TOKEN, serverId: "server-1", fingerprint: PIN, clientLabel: "Writer's laptop" };
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: T0 };
const SERVER_BOOK: BookEntry = { ...BOOK, autopilotHost: "server" };
const URL_PUBLIC = "https://books.example.net/mcp/the-glass-harbor";
const CHATGPT: ServerMcpClient = { id: "grant-1", clientId: "app-chatgpt", name: "ChatGPT", redirectHost: "chatgpt.com", scopes: ["read", "write", "run"], createdAt: "2026-11-02T09:30:00.000Z", lastUsedAt: "2026-11-20T18:45:00.000Z" };
const CLAUDE: ServerMcpClient = { id: "grant-2", clientId: "app-claude", name: "Claude", redirectHost: "claude.ai", scopes: ["read"], createdAt: "2026-11-10T08:00:00.000Z", lastUsedAt: "2026-11-21T07:15:00.000Z" };
const IDLE: ServerConnectionState = { status: "disabled", info: null, message: null, books: [], updates: null, connection: null };

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const escaped = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

let fake: FakeBookServer;

/** The personal server is online and follows the connection of the settings; `book` is among its books unless `books` says otherwise. */
function connect(state: Partial<ServerConnectionState> = {}, book: BookEntry = BOOK) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, personalServer: CONNECTION, books: [book] } });
  useAutopilotStore.setState({ server: { status: "online", info: fake.info(), message: null, books: [fake.summary(book.id)], updates: null, connection: CONNECTION, ...state } });
}

function open(book: BookEntry = BOOK) {
  return render(<MemoryRouter><McpServerSection book={book} /></MemoryRouter>);
}

const mcpSwitch = () => screen.getByRole("switch", { name: t("mcp.switch") });
const loaded = () => screen.findByRole("switch", { name: t("mcp.switch") });
const appsList = () => screen.findByRole("list", { name: t("mcp.apps.title") });
const settled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

beforeEach(() => {
  fake = new FakeBookServer();
  mocks.server = fake;
  mocks.connections.length = 0;
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ server: IDLE });
  await i18n.changeLanguage("en");
});

describe.each<Language>(["en", "it"])("the MCP server of a book, in the book settings (%s)", (language) => {
  beforeEach(async () => {
    await i18n.changeLanguage(language);
  });

  it("is off at first: the switch says so, the warning is there, and no address is given out", async () => {
    fake.mcp = true;
    fake.mcpOAuth = true;
    connect();
    open();
    const toggle = await loaded();
    expect(screen.getByRole("heading", { name: t("mcp.title") })).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription(escaped(t("mcp.off")));
    expect(screen.getByText(t("mcp.warning"))).toBeInTheDocument();
    expect(screen.queryByText(URL_PUBLIC)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: t("mcp.apps.title") })).not.toBeInTheDocument();
    expect(fake.count("listMcpClients")).toBe(0);
    expect(mocks.connections.every((connection) => connection === CONNECTION), "every request goes to the server the runtime verified and follows").toBe(true);
  });

  it("switches on through the server and gives the address, with a button that copies it", async () => {
    fake.mcp = true;
    fake.mcpOAuth = true;
    connect();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    open();
    fireEvent.click(await loaded());
    await waitFor(() => expect(mcpSwitch()).toHaveAttribute("aria-checked", "true"));
    expect(fake.mcpUpdates).toEqual([{ enabled: true }]);
    expect(mcpSwitch()).toHaveAccessibleDescription(escaped(t("mcp.on")));
    expect(screen.getByText(URL_PUBLIC)).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("mcp.toast.on") }));

    fireEvent.click(screen.getByRole("button", { name: t("mcp.address.copy") }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_PUBLIC));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("mcp.toast.copied") }));
  });

  it("asks before switching off, saying that every connected app is disconnected; no means nothing changes", async () => {
    fake.mcp = true;
    fake.mcpOAuth = true;
    fake.mcpEnabled = true;
    fake.mcpClients = [{ ...CHATGPT }, { ...CLAUDE }];
    connect();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    open();
    await appsList();
    fireEvent.click(mcpSwitch());
    expect(confirm).toHaveBeenCalledTimes(1);
    const question = String(confirm.mock.calls[0][0]);
    expect(question).toContain(t("mcp.confirm.off"));
    expect(question).toContain(t("mcp.confirm.connected", { count: 2 }));
    await settled();
    expect(fake.mcpUpdates).toEqual([]);
    expect(mcpSwitch()).toHaveAttribute("aria-checked", "true");

    confirm.mockReturnValue(true);
    fireEvent.click(mcpSwitch());
    await waitFor(() => expect(mcpSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(fake.mcpUpdates).toEqual([{ enabled: false }]);
    expect(fake.mcpClients).toEqual([]);
    expect(screen.queryByText(CHATGPT.name)).not.toBeInTheDocument();
    expect(screen.queryByText(URL_PUBLIC)).not.toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("mcp.toast.off") }));
  });

  it("asks before switching off also when the server cannot say how many apps are connected", async () => {
    fake.mcp = true;
    fake.mcpEnabled = true;
    connect();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    open();
    fireEvent.click(await loaded());
    await waitFor(() => expect(fake.mcpUpdates).toEqual([{ enabled: false }]));
    expect(String(confirm.mock.calls[0][0])).toBe(t("mcp.confirm.off"));
  });

  it("changes the address after asking, and says in words, next to the field, why one was refused", async () => {
    fake.mcp = true;
    fake.mcpOAuth = true;
    fake.mcpEnabled = true;
    fake.mcpClients = [{ ...CHATGPT }];
    connect();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    open();
    await appsList();
    const field = screen.getByLabelText(t("mcp.slug.label")) as HTMLInputElement;
    const change = screen.getByRole("button", { name: t("mcp.slug.change") });
    expect(field.value).toBe("the-glass-harbor");
    expect(change).toBeDisabled();

    // Not an address name at all: refused here, before anything is asked or sent.
    fireEvent.change(field, { target: { value: "The Harbor!" } });
    fireEvent.click(change);
    expect(await screen.findByText(t("mcp.slug.invalid"))).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(escaped(t("mcp.slug.invalid")));
    expect(document.activeElement).toBe(field);
    expect(confirm).not.toHaveBeenCalled();
    expect(fake.mcpUpdates).toEqual([]);

    // The author says no: nothing is sent.
    confirm.mockReturnValueOnce(false);
    fireEvent.change(field, { target: { value: "glass" } });
    fireEvent.click(change);
    await settled();
    expect(fake.mcpUpdates).toEqual([]);

    // Another book has it: the server refuses, and the field says why.
    fireEvent.change(field, { target: { value: "another-book" } });
    fireEvent.click(change);
    expect(await screen.findByText(t("mcp.slug.taken"))).toBeInTheDocument();
    const question = String(confirm.mock.calls[confirm.mock.calls.length - 1]?.[0]);
    expect(question).toContain(t("mcp.confirm.slug", { slug: "another-book" }));
    expect(question).toContain(t("mcp.confirm.connected", { count: 1 }));
    expect(fake.mcpUpdates).toEqual([{ slug: "another-book" }]);
    expect(field).toHaveAccessibleDescription(escaped(t("mcp.slug.taken")));
    expect(document.activeElement).toBe(field);
    expect(screen.getByText(URL_PUBLIC)).toBeInTheDocument();

    // A refusal of the server's own rules reads the same way.
    fake.failures.updateMcp = new ServerRequestError("A slug is made of lowercase letters, digits and single hyphens.", 400, "invalid_slug");
    fireEvent.change(field, { target: { value: "glass" } });
    fireEvent.click(change);
    expect(await screen.findByText(t("mcp.slug.invalid"))).toBeInTheDocument();
    fake.failures.updateMcp = undefined;

    // A free one: the address moves, the error goes, and the apps were disconnected.
    fireEvent.change(field, { target: { value: "glass-harbor" } });
    fireEvent.click(change);
    expect(await screen.findByText("https://books.example.net/mcp/glass-harbor")).toBeInTheDocument();
    expect(fake.mcpUpdates[fake.mcpUpdates.length - 1]).toEqual({ slug: "glass-harbor" });
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(t("mcp.slug.invalid"))).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(CHATGPT.name)).not.toBeInTheDocument());
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("mcp.toast.slug") }));
  });

  it("an address that works only on the server's own computer says so, with the server's own words", async () => {
    fake.mcp = true;
    fake.mcpOAuth = true;
    fake.mcpEnabled = true;
    fake.mcpPublicUrl = null;
    connect();
    open();
    expect(await screen.findByText("http://127.0.0.1:24242/mcp/the-glass-harbor")).toBeInTheDocument();
    expect(screen.getByText(t("mcp.address.notPublic"))).toBeInTheDocument();
    expect(screen.getByText(MCP_LOCAL_MESSAGE)).toHaveAttribute("lang", "en");
  });

  it("tells Claude Code, Cursor and VS Code how to connect with a token, and never shows the token of this device", async () => {
    fake.mcp = true;
    fake.mcpEnabled = true;
    connect();
    open();
    expect(await screen.findByRole("heading", { name: t("mcp.connect.token.title") })).toBeInTheDocument();
    const placeholder = t("mcp.connect.token.placeholder");
    const header = `Bearer ${placeholder}`;
    const snippets = Array.from(document.querySelectorAll("pre"), (node) => node.textContent);
    expect(snippets).toEqual([
      `claude mcp add --transport http the-glass-harbor ${URL_PUBLIC} --header "Authorization: ${header}"`,
      JSON.stringify({ mcpServers: { "the-glass-harbor": { url: URL_PUBLIC, headers: { Authorization: header } } } }, null, 2),
      JSON.stringify({ servers: { "the-glass-harbor": { type: "http", url: URL_PUBLIC, headers: { Authorization: header } } } }, null, 2),
    ]);
    expect(screen.getByText(t("mcp.connect.token.body", { placeholder }))).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(DEVICE_TOKEN);
  });

  it("explains ChatGPT and Claude.ai, and lists the apps, only on a server that lets apps connect through OAuth", async () => {
    fake.mcp = true;
    fake.mcpEnabled = true;
    connect();
    const view = open();
    expect(await screen.findByText(t("mcp.connect.oauth.older"))).toBeInTheDocument();
    expect(screen.queryByText(t("mcp.connect.oauth.body"))).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: t("mcp.apps.title") })).not.toBeInTheDocument();
    expect(screen.queryByText(t("mcp.admin"))).not.toBeInTheDocument();
    await settled();
    expect(fake.count("listMcpClients")).toBe(0);
    view.unmount();

    fake.mcpOAuth = true;
    connect();
    open();
    expect(await screen.findByRole("heading", { name: t("mcp.connect.oauth.title") })).toBeInTheDocument();
    expect(screen.getByText(t("mcp.connect.oauth.body"))).toBeInTheDocument();
    expect(await screen.findByText(t("mcp.apps.none"))).toBeInTheDocument();
    expect(screen.getByText(t("mcp.admin"))).toBeInTheDocument();
    expect(screen.queryByText(t("mcp.connect.oauth.older"))).not.toBeInTheDocument();
  });

  it("lists each connected app by its name, as text, with what it may do in words, where it goes back to and when it was used", async () => {
    fake.mcp = true;
    fake.mcpOAuth = true;
    fake.mcpEnabled = true;
    // A name is the app's own: it is shown as text. A newer server may add fields and scopes: only what is known is shown, and never a token.
    const hostile = { ...CHATGPT, name: '<img src=x onerror="alert(1)"> ChatGPT', scopes: ["read", "write", "run", "admin"], accessToken: "nra_0123456789abcdef", refreshToken: "nrr_0123456789abcdef" } as unknown as ServerMcpClient;
    fake.mcpClients = [hostile, { ...CLAUDE }];
    connect();
    open();
    const items = within(await appsList()).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const [first, second] = items;
    const said = {
      en: { all: "Can read the book, change the book and control the autopilot.", read: "Can read the book." },
      it: { all: "Può leggere il libro, modificare il libro e comandare l'autopilot.", read: "Può leggere il libro." },
    }[language];
    expect(within(first).getByText(hostile.name)).toBeInTheDocument();
    expect(first.querySelector("img")).toBeNull();
    expect(within(first).getByText(said.all)).toBeInTheDocument();
    expect(within(first).getByText(t("mcp.apps.returnsTo", { host: "chatgpt.com" }))).toBeInTheDocument();
    expect(within(first).getByText(t("mcp.apps.created", { date: formatDateTime(CHATGPT.createdAt) }))).toBeInTheDocument();
    expect(within(first).getByText(t("mcp.apps.lastUsed", { date: formatDateTime(CHATGPT.lastUsedAt) }))).toBeInTheDocument();
    expect(within(second).getByText("Claude")).toBeInTheDocument();
    expect(within(second).getByText(said.read)).toBeInTheDocument();
    expect(within(second).getByText(t("mcp.apps.returnsTo", { host: "claude.ai" }))).toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/nra_|nrr_/);
    expect(document.body.innerHTML).not.toContain(DEVICE_TOKEN);
    expect(screen.getByText(t("mcp.admin"))).toBeInTheDocument();
  });

  it("revokes an app after asking, and the list follows", async () => {
    fake.mcp = true;
    fake.mcpOAuth = true;
    fake.mcpEnabled = true;
    fake.mcpClients = [{ ...CHATGPT }, { ...CLAUDE }];
    connect();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    open();
    await appsList();
    const revoke = screen.getByRole("button", { name: t("mcp.apps.revokeNamed", { name: "Claude" }) });
    expect(revoke).toHaveTextContent(t("mcp.apps.revoke"));
    fireEvent.click(revoke);
    expect(String(confirm.mock.calls[0][0])).toBe(t("mcp.confirm.revoke", { name: "Claude" }));
    await settled();
    expect(fake.mcpRevoked).toEqual([]);

    confirm.mockReturnValue(true);
    fireEvent.click(revoke);
    await waitFor(() => expect(screen.queryByText("Claude")).not.toBeInTheDocument());
    expect(fake.mcpRevoked).toEqual(["grant-2"]);
    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("mcp.toast.revoked", { name: "Claude" }) }));
  });

  it("an app that was already disconnected leaves the list without an error, and the list can be read again", async () => {
    fake.mcp = true;
    fake.mcpOAuth = true;
    fake.mcpEnabled = true;
    fake.mcpClients = [{ ...CHATGPT }];
    connect();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    open();
    await appsList();
    fake.mcpClients = [];
    fireEvent.click(screen.getByRole("button", { name: t("mcp.apps.revokeNamed", { name: "ChatGPT" }) }));
    expect(await screen.findByText(t("mcp.apps.none"))).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("mcp.toast.revokedAlready", { name: "ChatGPT" }) }));
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));

    // An app allowed meanwhile, on the server's own page, appears when the list is read again.
    fake.mcpClients = [{ ...CLAUDE }];
    fireEvent.click(screen.getByRole("button", { name: t("mcp.apps.refresh") }));
    expect(await screen.findByText("Claude")).toBeInTheDocument();
  });

  it("a list of apps that arrives late belongs to the state before the switch, and is not shown", async () => {
    fake.mcp = true;
    fake.mcpOAuth = true;
    fake.mcpEnabled = true;
    fake.mcpClients = [{ ...CHATGPT }];
    let answer!: () => void;
    fake.gates.listMcpClients = new Promise<void>((resolve) => {
      answer = resolve;
    });
    connect();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    open();
    // Off and on again while the first list is still on its way: switching off disconnected ChatGPT.
    fireEvent.click(await loaded());
    await waitFor(() => expect(mcpSwitch()).toHaveAttribute("aria-checked", "false"));
    fake.gates.listMcpClients = undefined;
    fireEvent.click(mcpSwitch());
    expect(await screen.findByText(t("mcp.apps.none"))).toBeInTheDocument();
    answer();
    await settled();
    expect(screen.queryByText(CHATGPT.name)).not.toBeInTheDocument();
    expect(screen.getByText(t("mcp.apps.none"))).toBeInTheDocument();
  });

  it("says in words why the status could not be read, and tries again on request", async () => {
    fake.mcp = true;
    fake.failures.mcpStatus = new ServerRequestError("Restarting for an update.", 503, "maintenance");
    connect();
    open();
    expect(await screen.findByText(t("mcp.errors.maintenance"))).toBeInTheDocument();
    fake.failures.mcpStatus = undefined;
    fireEvent.click(screen.getByRole("button", { name: t("mcp.retry") }));
    expect(await loaded()).toHaveAttribute("aria-checked", "false");
  });

  it("a server that predates the MCP server says to update it, and is asked nothing", async () => {
    connect();
    open();
    expect(screen.getByText(t("mcp.olderServer"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("mcp.serverSettings") })).toHaveAttribute("href", "/app/settings/server");
    await settled();
    expect(fake.calls).toEqual([]);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("a book that is not on the personal server gets one line, with the way to the personal server settings", async () => {
    fake.mcp = true;
    fake.mcpOAuth = true;
    connect({ books: [] });
    open();
    expect(screen.getByText(t("mcp.notOnServer"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("mcp.serverSettings") })).toHaveAttribute("href", "/app/settings/server");
    await settled();
    expect(fake.calls).toEqual([]);
    cleanup();

    // No personal server at all: the same line.
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK] } });
    useAutopilotStore.setState({ server: IDLE });
    open();
    expect(screen.getByText(t("mcp.notOnServer"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("mcp.serverSettings") })).toHaveAttribute("href", "/app/settings/server");
  });

  it("while the personal server cannot be reached it says so, and asks nothing", async () => {
    fake.mcp = true;
    connect({ status: "offline" }, SERVER_BOOK);
    open(SERVER_BOOK);
    expect(screen.getByText(t("mcp.unreachable"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("mcp.serverSettings") })).toHaveAttribute("href", "/app/settings/server");
    await settled();
    expect(fake.calls).toEqual([]);
  });

  it("is part of the settings page of the book", async () => {
    fake.mcp = true;
    connect({}, SERVER_BOOK);
    render(
      <MemoryRouter initialEntries={["/app/books/book-1/settings"]}>
        <Routes><Route path="/app/books/:bookId/settings" element={<BookSettingsPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: t("mcp.title") })).toBeInTheDocument();
    expect(await loaded()).toBeInTheDocument();
  });
});
