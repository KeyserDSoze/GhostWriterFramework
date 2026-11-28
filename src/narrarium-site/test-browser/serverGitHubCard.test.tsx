import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_CONNECTION_PROBLEM_CODES, ServerRequestError, type ServerGitHubConnection, type ServerInfo } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  read: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  connect: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  disconnect: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  toast: vi.fn(),
  clientId: "Iv1.0123456789abcdef",
}));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => ({ readServerGitHub: mocks.read, connectServerGitHub: mocks.connect, disconnectServerGitHub: mocks.disconnect }) }));
vi.mock("@/config/publicClients", () => ({ get GITHUB_APP_CLIENT_ID() { return mocks.clientId; } }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import ServerGitHubCard from "@/components/settings/ServerGitHubCard";
import { useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type PersonalServerSettings } from "@/types/settings";

const PIN = "a".repeat(64);
const CONNECTION: PersonalServerSettings = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const INFO = { name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.23", engineVersion: "0.1.28", serverId: "s", label: "Home", git: true, features: ["github", "server-github-connection"] } as ServerInfo;
const PENDING: ServerGitHubConnection = { state: "pending", broker: "https://auth.example.com", pending: { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: "2026-11-28T10:15:00.000Z", interval: 5 } };
const CONNECTED: ServerGitHubConnection = {
  state: "connected", login: "octocat", broker: "https://auth.example.com", connectedAt: "2026-11-28T10:00:00.000Z", renewedAt: "2026-11-28T18:00:00.000Z",
  accessTokenExpiresAt: "2026-11-29T02:00:00.000Z", refreshTokenExpiresAt: "2027-05-30T10:00:00.000Z",
};
const LOST: ServerGitHubConnection = { state: "needs-reconnect", login: "octocat", broker: "https://auth.example.com", problem: { code: "renewal-failed", message: "THE SERVER'S ENGLISH" } };

const t = (key: string, options?: Record<string, unknown>) => String(i18n.t(key, options as never));

/** What the server answers, for the next reads; the store is what the card reads. */
let answer: ServerGitHubConnection | null = { state: "disconnected" };

function open(options: { status?: ServerGitHubConnection | null; server?: Partial<ServerConnectionState>; books?: ServerConnectionState["books"] } = {}) {
  answer = options.status === undefined ? { state: "disconnected" } : options.status;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, personalServer: CONNECTION } });
  useAutopilotStore.setState({ server: { status: "online", info: INFO, message: null, books: options.books ?? [], updates: null, connection: CONNECTION, ...(options.server ?? {}) } });
  return render(<ServerGitHubCard />);
}

const card = () => screen.getByTestId("server-github-card");
const settled = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.clientId = "Iv1.0123456789abcdef";
  mocks.toast.mockReset();
  mocks.read.mockReset().mockImplementation(async () => { useAutopilotStore.getState().setServer({ githubConnection: answer }); return answer; });
  mocks.connect.mockReset().mockImplementation(async () => { answer = PENDING; useAutopilotStore.getState().setServer({ githubConnection: PENDING }); return PENDING; });
  mocks.disconnect.mockReset().mockImplementation(async () => { answer = { state: "disconnected" }; useAutopilotStore.getState().setServer({ githubConnection: answer }); return answer; });
  vi.stubEnv("VITE_AUTH_BROKER_BASE", "https://auth.example.com");
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("when there is nothing to offer", () => {
  it("shows nothing while the server is not online: the status of the page says why", async () => {
    const { container } = open({ server: { status: "offline" } });
    await settled();
    expect(container).toBeEmptyDOMElement();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("says in one calm line that an older server has to be updated, and asks it nothing", async () => {
    open({ server: { info: { ...INFO, features: ["github"] } } });
    await settled();
    expect(card()).toHaveAttribute("data-offer", "old-server");
    expect(within(card()).getByRole("heading", { name: t("serverGitHub.title") })).toBeInTheDocument();
    expect(within(card()).getByText(t("serverGitHub.oldServer"))).toBeInTheDocument();
    expect(within(card()).queryByRole("button")).not.toBeInTheDocument();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("says in one line that this build has no GitHub App, with no button to connect", async () => {
    mocks.clientId = "";
    open();
    await waitFor(() => expect(card()).toHaveAttribute("data-offer", "no-site"));
    expect(within(card()).getByText(t("serverGitHub.noSite"))).toBeInTheDocument();
    expect(within(card()).queryByRole("button")).not.toBeInTheDocument();
  });

  it("still shows a connection that exists when the build has no app (it was made elsewhere, and its books use it), with its way out and no way to start one", async () => {
    mocks.clientId = "";
    open({ status: CONNECTED });
    await screen.findByText(t("serverGitHub.connectedAs", { login: "octocat" }));
    expect(screen.getByRole("button", { name: t("serverGitHub.disconnect") })).toBeInTheDocument();
    cleanup();
    open({ status: LOST });
    await screen.findByText(t("serverGitHub.lost"));
    expect(screen.queryByRole("button", { name: t("serverGitHub.connectAgain") })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("serverGitHub.forget") })).toBeInTheDocument();
  });
});

describe("not connected", () => {
  it("says what it is for in two sentences, honest about what the server then keeps, and offers to connect; the server is asked once, when the card is shown", async () => {
    open();
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    await screen.findByText(t("serverGitHub.intro"));
    expect(screen.getByText(t("serverGitHub.tradeoff"))).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: t("serverGitHub.title") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("serverGitHub.connect") })).toBeEnabled();
    expect(card()).toHaveAttribute("data-state", "disconnected");
    expect(screen.getByText(t("serverGitHub.state.disconnected"))).toBeInTheDocument();
  });

  it("reads the connection from the server first, and says so", async () => {
    let release: () => void = () => undefined;
    mocks.read.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(null); }));
    open({ status: undefined });
    await screen.findByText(t("serverGitHub.reading"));
    expect(card()).toHaveAttribute("data-state", "reading");
    act(() => { useAutopilotStore.getState().setServer({ githubConnection: { state: "disconnected" } }); release(); });
    await screen.findByRole("button", { name: t("serverGitHub.connect") });
  });

  it("starts the connection when asked, says it is asking GitHub, and shows the code the server was given", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: t("serverGitHub.connect") }));
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Enter this code on GitHub")).toBeInTheDocument();
  });

  it("tells a refusal of the request in words (the server already waits for a code), in a region that is read out", async () => {
    mocks.connect.mockRejectedValueOnce(new ServerRequestError("x", 409, "github_connection_exists"));
    open();
    fireEvent.click(await screen.findByRole("button", { name: t("serverGitHub.connect") }));
    const error = await screen.findByTestId("server-github-error");
    expect(error).toHaveTextContent(t("serverGitHub.errors.exists"));
    expect(error).toHaveAttribute("role", "alert");
  });
});

describe("waiting for the code", () => {
  it("shows the code large and selectable, read one character at a time, with a button that copies it", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { clipboard: { writeText } }));
    open({ status: PENDING });
    const code = await screen.findByTestId("server-github-code");
    expect(code).toHaveTextContent("WDJB-MJHT");
    expect(code.className).toContain("select-all");
    expect(code.className).toContain("text-2xl");
    expect(within(code).getByText("W D J B - M J H T", { selector: ".sr-only" })).toBeInTheDocument();
    expect(within(code).getByText("WDJB-MJHT", { selector: "[aria-hidden=true]" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("serverGitHub.pending.copy") }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("WDJB-MJHT"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("serverGitHub.pending.copied") }));
  });

  it("says a failed copy, and leaves the code to select by hand", async () => {
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { clipboard: { writeText: async () => { throw new Error("denied"); } } }));
    open({ status: PENDING });
    fireEvent.click(await screen.findByRole("button", { name: t("serverGitHub.pending.copy") }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("serverGitHub.pending.copyFailed"), variant: "destructive" }));
  });

  it("opens GitHub's page in a new tab, with a link that says so, and shows until when the code is valid", async () => {
    open({ status: PENDING });
    const link = await screen.findByRole("link", { name: new RegExp(t("serverGitHub.pending.open")) });
    expect(link).toHaveAttribute("href", "https://github.com/login/device");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAccessibleName(new RegExp(`${t("serverGitHub.pending.open")}\\s+\\${t("serverGitHub.pending.opensNewTab").replace(")", "\\)")}`));
    const until = screen.getByText(t("serverGitHub.pending.expires"), { exact: false });
    expect(within(until).getByText(/./, { selector: "time" })).toHaveAttribute("datetime", "2026-11-28T10:15:00.000Z");
  });

  it("never makes a link of an address that is not GitHub's (or this computer's): it is written as text", async () => {
    open({ status: { ...PENDING, pending: { ...PENDING.pending!, verificationUri: "javascript:alert(1)" } } });
    await screen.findByTestId("server-github-code");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(t("serverGitHub.pending.address", { address: "javascript:alert(1)" }))).toBeInTheDocument();
  });

  it("announces the wait in a polite status region and the state in a badge, and has a way to cancel", async () => {
    open({ status: PENDING });
    const waiting = await screen.findByText(t("serverGitHub.pending.waiting"));
    expect(waiting.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
    expect(card()).toHaveAttribute("data-state", "pending");
    expect(screen.getByText(t("serverGitHub.state.pending"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("serverGitHub.pending.cancel") })).toBeEnabled();
  });

  it("asks the server again only while it waits and the card is shown: when it becomes connected the polling stops, and the card says so", async () => {
    vi.useFakeTimers();
    open({ status: PENDING });
    await settled();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    answer = CONNECTED;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.read).toHaveBeenCalledTimes(3);
    expect(screen.getByText(t("serverGitHub.connectedAs", { login: "octocat" }))).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(mocks.read).toHaveBeenCalledTimes(3);
  });

  it("stops asking when the card goes away", async () => {
    vi.useFakeTimers();
    const { unmount } = open({ status: PENDING });
    await settled();
    unmount();
    mocks.read.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("connected", () => {
  it("says who it is connected as and that the server renews it by itself, with when it was renewed, when the token ends, and where it renews through", async () => {
    open({ status: CONNECTED });
    expect(await screen.findByText(t("serverGitHub.connectedAs", { login: "octocat" }))).toBeInTheDocument();
    expect(card()).toHaveAttribute("data-state", "connected");
    const facts = card().querySelector("dl") as HTMLElement;
    for (const label of ["connectedAt", "renewedAt", "tokenEnds", "refreshEnds", "broker"]) expect(within(facts).getByText(t(`serverGitHub.facts.${label}`))).toBeInTheDocument();
    expect(within(facts).getAllByText(/./, { selector: "time" }).map((time) => time.getAttribute("datetime"))).toEqual(["2026-11-28T10:00:00.000Z", "2026-11-28T18:00:00.000Z", "2026-11-29T02:00:00.000Z", "2027-05-30T10:00:00.000Z"]);
    expect(within(facts).getByText("https://auth.example.com")).toBeInTheDocument();
    expect(card().textContent).not.toMatch(/ghu_|ghr_|dc_/);
  });

  it("says «Connected» without a name when the server could not read it, and does not show a renewal that did not happen", async () => {
    open({ status: { state: "connected", broker: "https://auth.example.com", accessTokenExpiresAt: "2026-11-29T02:00:00.000Z" } });
    expect(await screen.findByText(t("serverGitHub.connectedNoLogin"))).toBeInTheDocument();
    expect(screen.queryByText(t("serverGitHub.facts.renewedAt"))).not.toBeInTheDocument();
  });

  it("counts the books of the server that use the connection", async () => {
    const book = (id: string, githubAuth?: "token" | "connection") => ({ bookId: id, title: id, storage: { kind: "github" as const, owner: "o", repo: "r", branch: "main" }, hasGithubToken: false, ...(githubAuth ? { githubAuth } : {}), ready: true, revision: "r", autopilot: null, running: false, lastSync: null });
    open({ status: CONNECTED, books: [book("a", "connection"), book("b", "token"), book("c", "connection")] });
    expect(await screen.findByText(t("serverGitHub.booksUsing", { count: 2 }))).toBeInTheDocument();
  });

  it("asks before it disconnects, and says that the books that use it will stop until it is connected again; a «no» does nothing", async () => {
    const book = { bookId: "a", title: "a", storage: { kind: "github" as const, owner: "o", repo: "r", branch: "main" }, hasGithubToken: false, githubAuth: "connection" as const, ready: true, revision: "r", autopilot: null, running: false, lastSync: null };
    open({ status: CONNECTED, books: [book] });
    fireEvent.click(await screen.findByRole("button", { name: t("serverGitHub.disconnect") }));
    const dialog = await screen.findByRole("dialog", { name: t("serverGitHub.dialog.title") });
    expect(within(dialog).getByText(new RegExp(t("serverGitHub.dialog.body").slice(0, 40)))).toBeInTheDocument();
    expect(dialog).toHaveTextContent(t("serverGitHub.dialog.booksOne"));
    fireEvent.click(within(dialog).getByRole("button", { name: t("serverGitHub.dialog.cancel") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(card()).toHaveAttribute("data-state", "connected");
  });

  it("disconnects when confirmed: the server is asked, the card goes back to «not connected», and the author is told", async () => {
    open({ status: CONNECTED });
    fireEvent.click(await screen.findByRole("button", { name: t("serverGitHub.disconnect") }));
    const dialog = await screen.findByRole("dialog", { name: t("serverGitHub.dialog.title") });
    fireEvent.click(within(dialog).getByRole("button", { name: t("serverGitHub.dialog.confirm") }));
    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(card()).toHaveAttribute("data-state", "disconnected"));
    expect(mocks.toast).toHaveBeenCalledWith({ title: t("serverGitHub.done.disconnected") });
    expect(screen.getByRole("button", { name: t("serverGitHub.connect") })).toBeInTheDocument();
  });

  it("does not say it disconnected when the server could not be asked", async () => {
    mocks.disconnect.mockRejectedValueOnce(new ServerRequestError("x", 0, "unreachable"));
    open({ status: CONNECTED });
    fireEvent.click(await screen.findByRole("button", { name: t("serverGitHub.disconnect") }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: t("serverGitHub.dialog.confirm") }));
    expect(await screen.findByTestId("server-github-error")).toHaveTextContent(t("serverGitHub.errors.unreachable"));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(card()).toHaveAttribute("data-state", "connected");
  });

  it("shows a problem of a renewal that is being tried again, and the connection stays connected", async () => {
    open({ status: { ...CONNECTED, problem: { code: "broker-unreachable", message: "THE SERVER'S ENGLISH" } } });
    const problem = await screen.findByTestId("server-github-problem");
    expect(problem).toHaveTextContent(t("serverGitHub.problems.broker-unreachable"));
    expect(card()).toHaveAttribute("data-state", "connected");
  });
});

describe("lost", () => {
  it("says the connection was lost and that the books that use it wait, and offers to connect again (or to forget it), in its own words", async () => {
    open({ status: LOST });
    expect(await screen.findByText(t("serverGitHub.lost"))).toBeInTheDocument();
    expect(card()).toHaveAttribute("data-state", "needs-reconnect");
    expect(screen.getByText(t("serverGitHub.state.needs-reconnect"))).toBeInTheDocument();
    expect(screen.getByTestId("server-github-problem")).toHaveTextContent(t("serverGitHub.problems.renewal-failed-lost"));
    expect(screen.queryByText("THE SERVER'S ENGLISH")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("serverGitHub.forget") })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("serverGitHub.connectAgain") }));
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1));
  });
});

describe("every problem the server can name", () => {
  const detail = (code: string): ServerGitHubConnection => ({ state: "disconnected", problem: { code: code as never, message: "THE SERVER'S ENGLISH" } });

  for (const language of ["en", "it"]) {
    it(`is told with its own sentence in ${language === "en" ? "English" : "Italian"}, never with the server's English`, async () => {
      await i18n.changeLanguage(language);
      for (const code of GITHUB_CONNECTION_PROBLEM_CODES) {
        const view = open({ status: detail(code) });
        const problem = await screen.findByTestId("server-github-problem");
        expect(problem).toHaveAttribute("data-problem", code);
        expect(problem.textContent, `${language}: ${code}`).not.toContain("THE SERVER'S ENGLISH");
        expect(problem.textContent).not.toMatch(/^serverGitHub|serverGitHub\./);
        view.unmount();
      }
    });
  }

  it("names, for the two switches of the GitHub App, exactly what the owner turns on, as GitHub labels it", async () => {
    open({ status: detail("device-flow-disabled") });
    expect(await screen.findByTestId("server-github-problem")).toHaveTextContent("In the settings of the GitHub App turn on “Enable Device Flow”");
    cleanup();
    open({ status: detail("expiring-tokens-off") });
    expect(await screen.findByTestId("server-github-problem")).toHaveTextContent("turn on “Expire user authorization tokens”");
    cleanup();
    await i18n.changeLanguage("it");
    open({ status: detail("device-flow-disabled") });
    expect(await screen.findByTestId("server-github-problem")).toHaveTextContent("attiva “Enable Device Flow”");
  });

  it("falls back to the server's own message only for a code that this site does not know", async () => {
    open({ status: detail("a-code-from-a-newer-server") });
    expect(await screen.findByTestId("server-github-problem")).toHaveTextContent("THE SERVER'S ENGLISH");
  });
});

describe("in Italian", () => {
  it("is all Italian: the title, the states, the button and the dialog", async () => {
    await i18n.changeLanguage("it");
    open({ status: CONNECTED });
    expect(await screen.findByRole("heading", { name: "Connessione a GitHub del server" })).toBeInTheDocument();
    expect(screen.getByText("Collegato come octocat; il server lo rinnova da solo.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Scollega" }));
    expect(await screen.findByRole("dialog", { name: "Scollegare il server da GitHub?" })).toBeInTheDocument();
  });
});
