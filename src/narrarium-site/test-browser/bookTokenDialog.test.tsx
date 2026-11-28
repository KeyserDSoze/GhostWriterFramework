import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  save: vi.fn(async () => true),
  replace: vi.fn(async (..._args: unknown[]) => true),
  toast: vi.fn(),
}));
vi.mock("@/config/publicClients", () => ({ GITHUB_APP_CLIENT_ID: "Iv1.client-id", GITHUB_APP_SLUG: "narrarium", GOOGLE_CLIENT_ID: "g", MICROSOFT_CLIENT_ID: "m" }));
vi.mock("@/hooks/useBrokerAvailability", () => ({ useBrokerAvailability: () => true }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: env.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: env.toast }), toast: env.toast }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => ({ replaceServerGitHubToken: env.replace }) }));

import i18n from "@/i18n";
import { GitHubAccessSection, type GitHubAccessSectionProps } from "@/components/account/GitHubAccessSection";
import { BookGitHubAccess } from "@/components/book/BookGitHubAccess";
import { GitHubServerTokenNotice } from "@/components/book/GitHubServerTokenNotice";
import { useConnectionStore } from "@/account/connectionStore";
import { setConnectedGitHubToken } from "@/github/githubCredentialRuntime";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const BOOK: BookEntry = { id: "b1", owner: "me", repo: "one", name: "One", tokenIndex: null, addedAt: "2026-11-01T00:00:00.000Z", autopilotHost: "server" };
const REPO = "https://api.github.com/repos/me/one";
const TOKEN = "github_pat_0123456789abcdef";
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

let requests: Array<{ url: string; authorization: string | null }>;
let answer: (url: string) => Response | Promise<Response>;

const ok = (push: boolean | undefined) => new Response(JSON.stringify({ full_name: "me/one", permissions: push === undefined ? undefined : { push } }), { status: 200, headers: { "content-type": "application/json" } });

function installBook(book: BookEntry = BOOK, language: "en" | "it" = "en") {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], ui: { ...DEFAULT_SETTINGS.ui, language } } });
}

const book = () => useSettingsStore.getState().settings.books[0];
const press = () => fireEvent.click(screen.getByRole("button", { name: t("accountSync.github.server.usePat") }));
const type = (value: string) => fireEvent.change(screen.getByLabelText(t("accountSync.github.bookToken.field")), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: t("accountSync.github.bookToken.save") }));
/** The notice of a page: the book it is given is the one in the settings, as it is in the pages, so it follows when the token is saved. */
function Live({ onSaved }: { onSaved?: (saved: { token: string; label: string }) => void }) {
  const current = useSettingsStore((state) => state.settings.books[0]);
  return <GitHubServerTokenNotice book={current} onSaved={onSaved} />;
}
const renderNotice = (onSaved?: (saved: { token: string; label: string }) => void) => render(<MemoryRouter><Live onSaved={onSaved} /></MemoryRouter>);

beforeEach(async () => {
  requests = [];
  answer = () => ok(true);
  env.save.mockReset().mockResolvedValue(true);
  env.replace.mockReset().mockResolvedValue(true);
  env.toast.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    requests.push({ url, authorization: init?.headers?.Authorization ?? null });
    return answer(url);
  }));
  setConnectedGitHubToken("ghu_app", "app");
  installBook();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  setConnectedGitHubToken(undefined);
  useConnectionStore.setState({ hydrated: true, configuration: {} });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the notice about the app's token has the fix at hand", () => {
  it("shows the warning and the button, and asks GitHub for nothing: not when it shows, not when the dialog opens", async () => {
    renderNotice();
    const notice = screen.getByTestId("github-server-token-notice");
    expect(notice).toHaveTextContent(t("accountSync.github.server.warning"));
    expect(within(notice).getByRole("button", { name: t("accountSync.github.server.usePat") })).toBeEnabled();
    press();
    expect(await screen.findByRole("dialog", { name: t("accountSync.github.bookToken.title") })).toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it("explains in two lines how to make the token and what it needs, with a link to GitHub that says it opens a new tab", async () => {
    renderNotice();
    press();
    const dialog = await screen.findByRole("dialog");
    const steps = within(dialog).getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent("me/one");
    expect(steps[1]).toHaveTextContent("Contents: Read and write");
    const link = within(dialog).getByRole("link", { name: new RegExp(t("accountSync.github.bookToken.create")) });
    expect(link).toHaveAttribute("href", "https://github.com/settings/personal-access-tokens/new");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("checks the token with GitHub when the button is pressed, saves it for the book, tells the server that runs it, and the notice goes away", async () => {
    const saved = vi.fn();
    renderNotice(saved);
    press();
    await screen.findByRole("dialog");
    type(`  ${TOKEN}  `);
    submit();
    await waitFor(() => expect(book().bookToken).toBe(TOKEN));
    expect(requests).toEqual([{ url: REPO, authorization: `Bearer ${TOKEN}` }]);
    expect(book()).toMatchObject({ bookToken: TOKEN, bookTokenLabel: "one PAT", tokenIndex: null });
    expect(book().useGitHubConnection).toBeUndefined();
    expect(env.save).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(env.replace).toHaveBeenCalledWith("b1"));
    expect(saved).toHaveBeenCalledWith({ token: TOKEN, label: "one PAT" });
    expect(env.toast).toHaveBeenCalledWith({ title: t("accountSync.github.bookToken.saved") });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByTestId("github-server-token-notice")).not.toBeInTheDocument();
  });

  it("a book that is not on the server is not sent anywhere: the server is asked, and it has nothing to replace", async () => {
    env.replace.mockResolvedValue(false);
    renderNotice();
    press();
    await screen.findByRole("dialog");
    type(TOKEN);
    submit();
    await waitFor(() => expect(book().bookToken).toBe(TOKEN));
    expect(env.toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
  });

  it("says, when the server cannot be given the token, that it was saved here and the server was not given it", async () => {
    env.replace.mockRejectedValue(new Error("The server is away."));
    renderNotice();
    press();
    await screen.findByRole("dialog");
    type(TOKEN);
    submit();
    await waitFor(() => expect(env.toast).toHaveBeenCalledWith({ title: t("accountSync.github.bookToken.errors.serverFailed"), description: "The server is away.", variant: "destructive" }));
    expect(book().bookToken).toBe(TOKEN);
  });

  describe.each([
    ["no token", "", () => ok(true), "empty"],
    ["a token GitHub does not accept", TOKEN, () => new Response("{}", { status: 401 }), "invalid"],
    ["a token that cannot see the repository", TOKEN, () => new Response("{}", { status: 404 }), "noAccess"],
    ["a token that reads the repository and cannot save to it", TOKEN, () => ok(false), "readOnly"],
    ["a token for which GitHub does not say what it can do", TOKEN, () => ok(undefined), "readOnly"],
  ] as const)("%s", (_name, value, reply, key) => {
    it("is refused, with the reason in words next to the field, and nothing is saved", async () => {
      answer = reply;
      renderNotice();
      press();
      await screen.findByRole("dialog");
      type(value);
      submit();
      const alert = await screen.findByText(t(`accountSync.github.bookToken.errors.${key}`, { repo: "me/one" }));
      expect(alert).toHaveAttribute("role", "alert");
      const field = screen.getByLabelText(t("accountSync.github.bookToken.field"));
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field.getAttribute("aria-describedby")).toContain(alert.id);
      expect(book().bookToken).toBeUndefined();
      expect(env.save).not.toHaveBeenCalled();
      expect(screen.getByTestId("github-server-token-notice")).toBeInTheDocument();
    });
  });

  it("says that GitHub could not be reached, and keeps what was typed", async () => {
    answer = () => { throw new TypeError("Failed to fetch"); };
    renderNotice();
    press();
    await screen.findByRole("dialog");
    type(TOKEN);
    submit();
    expect(await screen.findByText(t("accountSync.github.bookToken.errors.unreachable"))).toBeInTheDocument();
    expect(screen.getByLabelText(t("accountSync.github.bookToken.field"))).toHaveValue(TOKEN);
  });

  it("puts the settings back when the token is valid but cannot be saved, and says so", async () => {
    env.save.mockRejectedValue(new Error("offline"));
    renderNotice();
    press();
    await screen.findByRole("dialog");
    type(TOKEN);
    submit();
    expect(await screen.findByText(t("accountSync.github.bookToken.errors.saveFailed"))).toBeInTheDocument();
    expect(book().bookToken).toBeUndefined();
    expect(env.replace).not.toHaveBeenCalled();
  });

  it("is a labelled dialog: the field has its name, the checking is said, the buttons wait, and Cancel closes it", async () => {
    let release: (response: Response) => void = () => undefined;
    answer = () => new Promise<Response>((resolve) => { release = resolve; });
    renderNotice();
    press();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(t("accountSync.github.bookToken.field"))).toHaveAttribute("type", "password");
    type(TOKEN);
    submit();
    expect(await within(dialog).findByRole("button", { name: t("accountSync.github.bookToken.checking") })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: t("accountSync.github.bookToken.cancel") })).toBeDisabled();
    release(ok(false));
    await within(dialog).findByText(t("accountSync.github.bookToken.errors.readOnly", { repo: "me/one" }));
    fireEvent.click(within(dialog).getByRole("button", { name: t("accountSync.github.bookToken.cancel") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(book().bookToken).toBeUndefined();
  });

  it("speaks Italian", async () => {
    installBook(BOOK, "it");
    await i18n.changeLanguage("it");
    renderNotice();
    fireEvent.click(screen.getByRole("button", { name: "Usa un token di accesso personale per questo libro" }));
    const dialog = await screen.findByRole("dialog", { name: "Usa un token di accesso personale per questo libro" });
    expect(within(dialog).getAllByRole("listitem")[1]).toHaveTextContent("Contenuti: lettura e scrittura");
    expect(within(dialog).getByRole("button", { name: "Controlla e salva" })).toBeInTheDocument();
  });
});

describe("the same fix where the notice is in the book's settings, and in Account & Sync", () => {
  it("hands the token that was saved to the page of the book's settings, so that the page keeps its draft in step", async () => {
    const onTokenSaved = vi.fn();
    useConnectionStore.setState({ hydrated: true, configuration: {} });
    render(<MemoryRouter><BookGitHubAccess book={BOOK} onTokenSaved={onTokenSaved} /></MemoryRouter>);
    press();
    await screen.findByRole("dialog");
    type(TOKEN);
    submit();
    await waitFor(() => expect(onTokenSaved).toHaveBeenCalledWith({ token: TOKEN, label: "one PAT" }));
  });

  it("has the button on the line of each book that a server runs on the app's token, named after the book", async () => {
    const props: GitHubAccessSectionProps = { connection: { backend: "github", method: "github-app", credentialKind: "app", identity: { provider: "github", providerAccountId: "1", displayName: "Writer", username: "writer" }, token: "ghu_app", rememberMe: true, accountSyncEnabled: false, repositoryName: "narrarium.settings", replica: { enabled: false, status: "disabled" } }, rememberMe: true, onRememberChange: vi.fn(), onConnect: vi.fn(), starting: false, startError: null, pat: "", onPatChange: vi.fn(), onConnectPat: vi.fn(), connectingPat: false, patError: null, onDisconnect: vi.fn(), disconnecting: false } as never;
    useConnectionStore.setState({ hydrated: true, configuration: { github: props.connection } });
    render(<MemoryRouter><GitHubAccessSection {...props} /></MemoryRouter>);
    const button = await screen.findByRole("button", { name: t("accountSync.github.server.usePatFor", { book: "One" }) });
    fireEvent.click(button);
    expect(await screen.findByRole("dialog", { name: t("accountSync.github.bookToken.title") })).toBeInTheDocument();
  });
});
