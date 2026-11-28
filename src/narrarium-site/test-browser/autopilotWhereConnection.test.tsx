import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerGitHubConnection, ServerInfo } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  moveToServer: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
  read: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  armHandover: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true })),
  save: vi.fn(async () => true),
  toast: vi.fn(),
  clientId: "Iv1.0123456789abcdef",
  status: { state: "disconnected" } as unknown,
}));

vi.mock("@/autopilot/loader", () => ({
  loadAutopilotRuntime: async () => ({ moveToServer: mocks.moveToServer, moveToBrowser: vi.fn(), syncWithServer: vi.fn(), readServerGitHub: mocks.read, armHandover: mocks.armHandover, describeError: (error: unknown) => String(error) }),
}));
vi.mock("@/config/publicClients", () => ({ get GITHUB_APP_CLIENT_ID() { return mocks.clientId; } }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { WhereCard } from "@/pages/AutopilotPage";
import { emptyView, useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry, type PersonalServerSettings } from "@/types/settings";

const PIN = "a".repeat(64);
const CONNECTION: PersonalServerSettings = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const INFO = { name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.23", engineVersion: "0.1.28", serverId: "s", label: "Home", git: true, features: ["github", "server-github-connection"] } as ServerInfo;
const OLD_INFO = { ...INFO, features: ["github"] } as ServerInfo;
const BOOK: BookEntry = { id: "book-1", owner: "acme", repo: "glass-harbor", name: "The Glass Harbor", tokenIndex: null, storageMode: "github", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const LOCAL_BOOK: BookEntry = { ...BOOK, id: "book-2", owner: "local", repo: "book-2", storageMode: "local-only" };
const CONNECTED: ServerGitHubConnection = { state: "connected", login: "octocat", broker: "https://auth.example.com", accessTokenExpiresAt: "2026-11-29T02:00:00.000Z" };
const LOST: ServerGitHubConnection = { state: "needs-reconnect", login: "octocat", broker: "https://auth.example.com" };

const t = (key: string, options?: Record<string, unknown>) => String(i18n.t(key, options as never));
const move = () => screen.getByRole("button", { name: t("autopilot.where.move") }) as HTMLButtonElement;

function open(options: { book?: BookEntry; status?: ServerGitHubConnection; server?: Partial<ServerConnectionState>; serverBook?: Record<string, unknown>; chooseServer?: boolean } = {}) {
  const book = options.book ?? BOOK;
  mocks.status = options.status ?? { state: "disconnected" };
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], personalServer: CONNECTION } });
  useAutopilotStore.setState({ views: { [book.id]: { ...emptyView(book.id), ...(options.serverBook ? { server: options.serverBook as never } : {}) } }, server: { status: "online", info: INFO, message: null, books: [], updates: null, connection: CONNECTION, ...(options.server ?? {}) } });
  const view = render(<MemoryRouter><WhereCard book={book} running={false} /></MemoryRouter>);
  if (options.chooseServer !== false && !options.serverBook) fireEvent.click(screen.getByRole("radio", { name: t("autopilot.where.server") }));
  return view;
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.clientId = "Iv1.0123456789abcdef";
  mocks.moveToServer.mockReset().mockResolvedValue(undefined);
  mocks.armHandover.mockReset().mockResolvedValue({ ok: true });
  mocks.read.mockReset().mockImplementation(async () => { useAutopilotStore.getState().setServer({ githubConnection: mocks.status as ServerGitHubConnection }); return mocks.status; });
  mocks.save.mockClear();
  mocks.toast.mockReset();
  vi.stubEnv("VITE_AUTH_BROKER_BASE", "https://auth.example.com");
});

afterEach(async () => {
  cleanup();
  vi.unstubAllEnvs();
  await i18n.changeLanguage("en");
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("«Where it runs», for a GitHub book, when the server is connected to GitHub on its own", () => {
  it("offers the connection, preselected, with the token as the alternative: two radios of one group with a legend, and no copy of the token is sent by default", async () => {
    open({ status: CONNECTED });
    const group = await screen.findByRole("group", { name: t("autopilot.where.githubAccess") });
    const viaConnection = within(group).getByRole("radio", { name: new RegExp(t("autopilot.where.githubViaConnection").replace(/[()]/g, "\\$&")) });
    const viaToken = within(group).getByRole("radio", { name: t("autopilot.where.consentGithub") });
    expect(viaConnection).toBeChecked();
    expect(viaToken).not.toBeChecked();
    expect(viaConnection).toHaveAttribute("name", viaToken.getAttribute("name"));
    expect(group).toHaveTextContent(t("autopilot.where.githubViaConnectionHelp", { login: "octocat" }));
    // The checkbox that sent the token is the other radio now, not a second control.
    expect(screen.queryByRole("checkbox", { name: t("autopilot.where.consentGithub") })).not.toBeInTheDocument();
    expect(move()).toBeEnabled();
    expect(screen.queryByTestId("github-server-token-notice")).not.toBeInTheDocument();

    fireEvent.click(move());
    await waitFor(() => expect(mocks.moveToServer).toHaveBeenCalledWith(BOOK.id, { sendAiConfiguration: true, sendGitHubToken: false, githubAuth: "connection" }));
  });

  it("sends the token when the author chooses it instead: the registration of the old way, and the choice is not sent", async () => {
    open({ status: CONNECTED });
    const viaToken = await screen.findByRole("radio", { name: t("autopilot.where.consentGithub") });
    fireEvent.click(viaToken);
    expect(viaToken).toBeChecked();
    expect(move()).toBeEnabled();
    fireEvent.click(move());
    await waitFor(() => expect(mocks.moveToServer).toHaveBeenCalledWith(BOOK.id, { sendAiConfiguration: true, sendGitHubToken: true }));
    expect(mocks.moveToServer.mock.calls[0][1]).not.toHaveProperty("githubAuth");
  });

  it("can be changed back to the connection after the token was chosen", async () => {
    open({ status: CONNECTED });
    fireEvent.click(await screen.findByRole("radio", { name: t("autopilot.where.consentGithub") }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(t("autopilot.where.githubViaConnection").replace(/[()]/g, "\\$&")) }));
    fireEvent.click(move());
    await waitFor(() => expect(mocks.moveToServer).toHaveBeenCalledWith(BOOK.id, expect.objectContaining({ githubAuth: "connection", sendGitHubToken: false })));
  });

  it("is read from the server when the author looks at the way to the server, and not when the page opens", async () => {
    open({ status: CONNECTED, chooseServer: false });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: t("autopilot.where.githubAccess") })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: t("autopilot.where.server") }));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    await screen.findByRole("group", { name: t("autopilot.where.githubAccess") });
  });

  it("reads the connection of the server once, and does not poll it: the card shows nothing of a pending code", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open({ status: CONNECTED });
      await screen.findByRole("group", { name: t("autopilot.where.githubAccess") });
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(mocks.read).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("«Where it runs», when the connection cannot be chosen", () => {
  it("keeps the checkbox of the token as it was, and points to Settings → Personal server, when the server is not connected", async () => {
    open({ status: { state: "disconnected" } });
    const box = await screen.findByRole("checkbox", { name: t("autopilot.where.consentGithub") });
    expect(box).toBeChecked();
    expect(screen.queryByRole("group", { name: t("autopilot.where.githubAccess") })).not.toBeInTheDocument();
    const note = await screen.findByText(t("autopilot.where.githubConnectHint"), { exact: false });
    expect(note).toHaveAttribute("role", "note");
    expect(within(note).getByRole("link", { name: t("personalServer.title") })).toHaveAttribute("href", "/app/settings/server");
    fireEvent.click(move());
    await waitFor(() => expect(mocks.moveToServer).toHaveBeenCalledWith(BOOK.id, { sendAiConfiguration: true, sendGitHubToken: true }));
  });

  it("says that the connection was lost, in its own words, and still offers the token", async () => {
    open({ status: LOST });
    expect(await screen.findByText(t("autopilot.where.githubLostHint"), { exact: false })).toHaveAttribute("data-where-github-hint", "lost");
    expect(screen.getByRole("checkbox", { name: t("autopilot.where.consentGithub") })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: t("autopilot.where.githubAccess") })).not.toBeInTheDocument();
  });

  it("asks an older server nothing and shows nothing new: the page is as it was", async () => {
    open({ status: CONNECTED, server: { info: OLD_INFO } });
    await screen.findByRole("checkbox", { name: t("autopilot.where.consentGithub") });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: t("autopilot.where.githubAccess") })).not.toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.where.githubConnectHint"), { exact: false })).not.toBeInTheDocument();
    fireEvent.click(move());
    await waitFor(() => expect(mocks.moveToServer).toHaveBeenCalledWith(BOOK.id, { sendAiConfiguration: true, sendGitHubToken: true }));
  });

  it("shows nothing about the connection for a local book, and does not ask the server", async () => {
    open({ book: LOCAL_BOOK, status: CONNECTED });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: t("autopilot.where.githubAccess") })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: t("autopilot.where.consentGithub") })).not.toBeInTheDocument();
  });

  it("blocks the move, with its reason next to the button, when nothing is sent and the connection is not chosen", async () => {
    open({ status: { state: "disconnected" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: t("autopilot.where.consentGithub") }));
    expect(move()).toBeDisabled();
    expect(move().getAttribute("aria-describedby")).toBeTruthy();
  });
});

describe("«Where it runs», in Italian", () => {
  it("says the choice, the help and the way out in Italian", async () => {
    await i18n.changeLanguage("it");
    open({ status: CONNECTED });
    const group = await screen.findByRole("group", { name: "Come il server accede a GitHub per questo libro" });
    expect(group).toHaveTextContent("Usa la connessione GitHub propria del server per questo libro (non viene inviata nessuna copia del token)");
    expect(group).toHaveTextContent("Collegato come octocat; il server la rinnova da solo");
    expect(within(group).getByRole("radio", { name: "Invia il token GitHub di questo libro al mio server" })).toBeInTheDocument();
  });
});

describe("a book that the server runs on its own GitHub connection", () => {
  const onConnection = { bookId: "book-1", title: "The Glass Harbor", storage: { kind: "github", owner: "acme", repo: "glass-harbor", branch: "main" }, hasGithubToken: false, githubAuth: "connection", ready: true, revision: "r", autopilot: null, running: false, lastSync: null };
  const hosted: BookEntry = { ...BOOK, autopilotHost: "server" };

  it("says that no copy of a token is kept for it, shows no warning about the 8 hours, and reads the connection while the card is on screen", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [hosted], personalServer: CONNECTION } });
    open({ book: hosted, status: CONNECTED, serverBook: onConnection });
    expect(await screen.findByText(t("autopilot.where.serverViaConnection"))).toBeInTheDocument();
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("github-server-token-notice")).not.toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.where.serverConnectionDown"), { exact: false })).not.toBeInTheDocument();
  });

  it("warns, with the way to connect it again, when the connection of the server was lost: the book cannot publish until then", async () => {
    open({ book: hosted, status: LOST, serverBook: onConnection });
    const warning = await screen.findByText(t("autopilot.where.serverConnectionDown"), { exact: false });
    expect(warning).toHaveAttribute("role", "note");
    expect(within(warning).getByRole("link", { name: t("personalServer.title") })).toHaveAttribute("href", "/app/settings/server");
  });

  it("says nothing of the connection for a book that the server holds a token copy for", async () => {
    open({ book: hosted, status: CONNECTED, serverBook: { ...onConnection, githubAuth: "token", hasGithubToken: true } });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByText(t("autopilot.where.serverViaConnection"))).not.toBeInTheDocument();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
