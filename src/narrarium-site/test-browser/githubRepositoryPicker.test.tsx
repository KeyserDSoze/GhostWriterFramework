import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/publicClients", () => ({ GITHUB_APP_CLIENT_ID: "Iv1.client-id", GITHUB_APP_SLUG: "narrarium", GOOGLE_CLIENT_ID: "g", MICROSOFT_CLIENT_ID: "m" }));

import i18n from "@/i18n";
import { GitHubRepositoryPicker } from "@/components/book/GitHubRepositoryPicker";
import { defaultGitHubRepositoryChoices, type GitHubPreflightState, type GitHubRepositoryChoices } from "@/components/book/GitHubRepositoryPanel";
import { clearRepositoryListingCache } from "@/github/useRepositoryListing";
import { installFakeGitHubApi, type FakeApiRepository } from "./helpers/fakeGitHubApi";
import type { PickerContext, RepositoryDecision } from "@/github/repositoryPickerModel";

// The repository picker as a person meets it: the two modes and which comes first, the searchable list (what a screen reader and the keyboard get from it,
// how it reads a page at a time), what is said and done with the repository that was picked, and the name of a new one. GitHub is a fake `fetch`.

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const ready = (overrides: Record<string, unknown> = {}): GitHubPreflightState => ({ status: "ready", preflight: { login: "ada", tokenKind: "classic", scopes: ["repo", "workflow"], organizations: ["acme"], canCreate: "yes", canWriteWorkflows: "yes", issues: [], ...overrides } as never });

interface HarnessProps { context?: PickerContext; token?: string; app?: boolean; login?: string; cacheKey?: string; defaultName?: string; books?: Array<{ owner: string; repo: string }>; preflight?: GitHubPreflightState }
let last: RepositoryDecision | null = null;

function Harness({ context = "add", token = "ghp_test", app = false, login, cacheKey = "pat#a", defaultName = "grande-libro", books = [], preflight = ready() }: HarnessProps) {
  const [choices, setChoices] = useState<GitHubRepositoryChoices>(defaultGitHubRepositoryChoices);
  const [decision, setDecision] = useState<RepositoryDecision | null>(null);
  return (
    <>
      <GitHubRepositoryPicker context={context} token={token} app={app} login={login} cacheKey={cacheKey} defaultName={defaultName} choices={choices} onChoicesChange={setChoices} preflight={preflight} books={books} onDecision={(next) => { last = next; setDecision(next); }} />
      <output data-testid="decision">{decision ? `${decision.mode}|${decision.name}|${decision.outcome?.kind ?? "-"}|${decision.ready ? "ready" : "not-ready"}|${decision.overwrite}` : ""}</output>
    </>
  );
}

const decisionText = () => screen.getByTestId("decision").textContent;
const combobox = () => screen.getByRole("combobox", { name: t("github.picker.list.label") });
/** The options of the list (the native select of the owners has options too: they are not these). */
const options = () => { const list = document.getElementById(combobox().getAttribute("aria-controls")!)!; return within(list).queryAllByRole("option"); };
const repos = (count: number, owner = "ada", extra: Partial<FakeApiRepository> = {}): FakeApiRepository[] => Array.from({ length: count }, (_, index) => ({ owner, name: `repo-${String(index).padStart(2, "0")}`, ...extra }));
const modeRadio = (name: "existing" | "create") => screen.getByRole("radio", { name: t(`github.picker.mode.${name}`) }) as HTMLInputElement;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  clearRepositoryListingCache();
  last = null;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("which mode comes first", () => {
  it("is the list of existing repositories when the credential reaches some", async () => {
    installFakeGitHubApi({ repositories: repos(3) });
    render(<Harness />);
    expect(modeRadio("existing")).toBeChecked();
    expect(await screen.findByText("3 repositories")).toBeInTheDocument();
    expect(modeRadio("existing")).toBeChecked();
    expect(screen.queryByLabelText(t("github.picker.create.nameLabel"))).not.toBeInTheDocument();
  });

  it("is the creation of a new one, with the name derived from the title, when the credential reaches none", async () => {
    installFakeGitHubApi({ repositories: [] });
    render(<Harness defaultName="grande-libro-della-giungla" />);
    await waitFor(() => expect(modeRadio("create")).toBeChecked());
    expect(screen.getByLabelText(t("github.picker.create.nameLabel"))).toHaveValue("grande-libro-della-giungla");
    expect(screen.getByRole("checkbox", { name: t("github.createBook.panel.pages.label") })).toBeInTheDocument();
    await waitFor(() => expect(decisionText()).toBe("create|grande-libro-della-giungla|-|ready|false"));
  });

  it("is what the person chose, once they chose, even when the list arrives afterwards", async () => {
    installFakeGitHubApi({ repositories: repos(3) });
    render(<Harness />);
    fireEvent.click(modeRadio("create"));
    await screen.findByLabelText(t("github.picker.create.nameLabel"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(modeRadio("create")).toBeChecked();
    fireEvent.click(modeRadio("existing"));
    expect(await screen.findByRole("combobox", { name: t("github.picker.list.label") })).toBeInTheDocument();
  });

  it("has the two modes as a group of native radio buttons with a legend and what each is for", async () => {
    installFakeGitHubApi({ repositories: repos(2) });
    render(<Harness />);
    const group = screen.getByRole("group", { name: t("github.picker.mode.legend") });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(radios[0]).toHaveAccessibleDescription(t("github.picker.mode.existingHint"));
    for (const radio of radios) expect(radio.closest("label")!.className).toContain("min-h-11");
    await screen.findByText("2 repositories");
  });
});

describe("the list as a combobox", () => {
  const withList = async (items: FakeApiRepository[], props: HarnessProps = {}) => {
    const api = installFakeGitHubApi({ repositories: items });
    render(<Harness {...props} />);
    await screen.findByText(new RegExp(`^${items.length} repositor`));
    return api;
  };

  it("is a labelled combobox that controls a listbox, closed until it is asked for", async () => {
    await withList(repos(5));
    const input = combobox();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-controls");
    expect(input).toHaveAccessibleDescription(t("github.picker.list.hint"));
    const listbox = document.getElementById(input.getAttribute("aria-controls")!)!;
    expect(listbox).toHaveAttribute("role", "listbox");
    expect(listbox).toBeEmptyDOMElement();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(within(listbox).getAllByRole("option")).toHaveLength(5);
  });

  it("names each option with the repository, whether it is private or public, whether the credential can write, and when it was last pushed", async () => {
    await withList([{ owner: "ada", name: "grande-libro", private: false, push: true, pushedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }, { owner: "acme", name: "notes", private: true, push: false }, { owner: "ada", name: "old", archived: true, push: null }], { books: [{ owner: "ada", repo: "old" }] });
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    const [first, second, third] = options();
    expect(first).toHaveTextContent("ada/grande-libro");
    expect(first).toHaveTextContent("public");
    expect(first).toHaveTextContent("you can write");
    expect(first).toHaveTextContent("last push 3 days ago");
    expect(second).toHaveTextContent("acme/notes");
    expect(second).toHaveTextContent("private");
    expect(second).toHaveTextContent("read only");
    expect(third).toHaveTextContent("archived");
    expect(third).toHaveTextContent("already added");
    expect(third).not.toHaveTextContent("you can write");
    expect(third).not.toHaveTextContent("read only");
    for (const option of [first, second, third]) expect(option.className).toContain("min-h-11");
  });

  it("moves with the arrows without leaving the field, wraps, and says which option is active", async () => {
    await withList(repos(3));
    const input = combobox();
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const items = options();
    expect(input).toHaveAttribute("aria-activedescendant", items[0].id);
    expect(items[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", items[1].id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", items[0].id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", items[2].id);
    expect(input).toHaveFocus();
  });

  it("goes to the first and the last option with Home and End while one is active, and leaves them to the text caret otherwise", async () => {
    await withList(repos(6));
    const input = combobox();
    const home = fireEvent.keyDown(input, { key: "Home" });
    expect(home).toBe(true);
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const items = options();
    expect(fireEvent.keyDown(input, { key: "End" })).toBe(false);
    expect(input).toHaveAttribute("aria-activedescendant", items[5].id);
    fireEvent.keyDown(input, { key: "Home" });
    expect(input).toHaveAttribute("aria-activedescendant", items[0].id);
  });

  it("chooses the active option with Enter: the field shows it, the list closes, and the decision follows", async () => {
    await withList(repos(4));
    const input = combobox();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("ada/repo-01");
    expect(input).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(decisionText()).toMatch(/^existing\|repo-01\|/));
  });

  it("does nothing on Enter when no option is active (it must not send the form)", async () => {
    await withList(repos(2));
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    fireEvent.keyDown(combobox(), { key: "Escape" });
    expect(fireEvent.keyDown(combobox(), { key: "Enter" })).toBe(true);
    expect(decisionText()).not.toMatch(/repo-0/);
  });

  it("closes the list with Escape and, with it closed, empties the field", async () => {
    await withList(repos(3));
    const input = combobox();
    fireEvent.change(input, { target: { value: "repo" } });
    expect(input).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveValue("repo");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
  });

  it("opens with Alt+ArrowDown without moving, and chooses with the mouse without taking the focus from the field", async () => {
    await withList(repos(3));
    const input = combobox();
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    const option = options()[1];
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);
    expect(input).toHaveValue("ada/repo-01");
    expect(input).toHaveFocus();
  });

  it("filters as the person types, without case or accents, and says the count in a polite live region a moment later", async () => {
    await withList([{ owner: "ada", name: "grande-libro" }, { owner: "ada", name: "notes" }, { owner: "acme", name: "libro-di-ricette" }, { owner: "ada", name: "Èra" }]);
    const input = combobox();
    fireEvent.change(input, { target: { value: "LIBRO" } });
    const items = options();
    expect(items.map((option) => option.textContent)).toEqual([expect.stringContaining("acme/libro-di-ricette"), expect.stringContaining("ada/grande-libro")]);
    const live = document.querySelector('[role="status"].sr-only')!;
    expect(live).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(live).toHaveTextContent("2 repositories"));
    fireEvent.change(input, { target: { value: "era" } });
    await waitFor(() => expect(live).toHaveTextContent("1 repository"));
  });

  it("says plainly that nothing matches, and offers to read more when there is more", async () => {
    await withList(repos(3));
    fireEvent.change(combobox(), { target: { value: "zzz" } });
    expect(screen.getByText(/No repository found for «zzz»/)).toBeInTheDocument();
    expect(options()).toHaveLength(0);
  });

  it("shows a skeleton and says it is reading while the first page is on its way, and has nothing to read before there is a token", async () => {
    installFakeGitHubApi({ repositories: repos(2), hold: "/user/repos" });
    const { unmount } = render(<Harness />);
    expect(await screen.findByText(t("github.picker.list.loading"), { selector: ".sr-only" })).toBeInTheDocument();
    expect(document.querySelectorAll('[aria-hidden="true"] .animate-pulse')).toHaveLength(3);
    unmount();
    cleanup();
    const none = installFakeGitHubApi({ repositories: repos(2) });
    render(<Harness token="" cacheKey="none" />);
    expect(combobox()).toBeDisabled();
    expect(none.calls).toEqual([]);
  });
});

describe("reading a big account a page at a time", () => {
  it("reads only the first page, and the next one when the last option is chosen", async () => {
    const api = installFakeGitHubApi({ repositories: repos(75), pageSize: 30 });
    render(<Harness />);
    await screen.findByText("30 repositories");
    expect(api.count("/user/repos")).toBe(1);
    const input = combobox();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "End" });
    const more = options()[options().length - 1];
    expect(more).toHaveTextContent(t("github.picker.list.loadMore"));
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("60 repositories");
    expect(api.count("/user/repos")).toBe(2);
    expect(api.calls[1].path).toContain("page=2");
    // The list stays open, so that what was just read can be seen.
    expect(input).toHaveAttribute("aria-expanded", "true");
  });

  it("goes on by itself, a few pages, when what was typed is not among what was read, and stops when it finds it", async () => {
    const api = installFakeGitHubApi({ repositories: [...repos(90), { owner: "ada", name: "giungla-il-libro" }], pageSize: 30 });
    render(<Harness />);
    await screen.findByText("30 repositories");
    fireEvent.change(combobox(), { target: { value: "giungla" } });
    await waitFor(() => expect(options()[0]).toHaveTextContent("ada/giungla-il-libro"), { timeout: 20_000 });
    expect(api.count("/user/repos")).toBe(4);
    expect(options()).toHaveLength(1);
  });

  it("does not read the same pages again when the list is shown again for the same credential, and does when the credential is another", async () => {
    const api = installFakeGitHubApi({ repositories: repos(4) });
    const { unmount } = render(<Harness cacheKey="pat#one" />);
    await screen.findByText("4 repositories");
    unmount();
    render(<Harness cacheKey="pat#one" />);
    await screen.findByText("4 repositories");
    expect(api.count("/user/repos")).toBe(1);
    cleanup();
    render(<Harness cacheKey="pat#two" token="ghp_other" />);
    await screen.findByText("4 repositories");
    expect(api.count("/user/repos")).toBe(2);
    expect(api.calls[1].auth).toBe("Bearer ghp_other");
  });

  it("reads one organization's repositories when it is chosen, and aborts what the old choice had on its way", async () => {
    const api = installFakeGitHubApi({ repositories: [...repos(3), { owner: "acme", name: "acme-book" }] });
    render(<Harness />);
    await screen.findByText("4 repositories");
    fireEvent.change(screen.getByLabelText(t("github.picker.list.scope")), { target: { value: "acme" } });
    await screen.findByText("1 repository");
    expect(api.paths()).toContain("/orgs/acme/repos");
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    expect(options()).toHaveLength(1);
  });
});

describe("what goes wrong while reading", () => {
  it("says GitHub's limit and the time it ends, and does not try again by itself", async () => {
    const api = installFakeGitHubApi({ repositories: repos(2), failures: [{ prefix: "/user/repos", status: 403, message: "API rate limit exceeded", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" }, times: 1 }] });
    render(<Harness />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("github.picker.error.title"));
    expect(alert).toHaveTextContent(/Try again after \d{1,2}:\d{2}/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.count("/user/repos")).toBe(1);
    fireEvent.click(within(alert).getByRole("button", { name: t("github.picker.list.retry") }));
    await screen.findByText("2 repositories");
    expect(api.count("/user/repos")).toBe(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says the credential must be reconnected on 401, the network, and an organization's single sign-on", async () => {
    installFakeGitHubApi({ failures: [{ prefix: "/user/repos", status: 401, message: "Bad credentials" }] });
    const { unmount } = render(<Harness cacheKey="a" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(t("github.picker.error.reconnect"));
    unmount();
    installFakeGitHubApi({ failures: [{ prefix: "/user/repos", status: 403, message: "SAML", headers: { "x-github-sso": "required" } }] });
    render(<Harness cacheKey="b" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(t("github.picker.error.sso"));
  });

  it("keeps the repositories already read when a later page fails, and retries only that page", async () => {
    const api = installFakeGitHubApi({ repositories: repos(40), pageSize: 30, failures: [{ prefix: "/user/repos", status: 500, times: 0 }] });
    render(<Harness />);
    await screen.findByText("30 repositories");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "boom" }), { status: 502 })));
    const input = combobox();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "End" });
    fireEvent.keyDown(input, { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("GitHub answered with an error (502)");
    expect(screen.getByText("30 repositories")).toBeInTheDocument();
    expect(api.count("/user/repos")).toBe(1);
  });
});

describe("with the GitHub app", () => {
  const appProps: HarnessProps = { app: true, token: "ghu_app", login: "ada", cacheKey: "app:ada" };

  it("lists the repositories of each installation, and says the app sees only those, with the link to change them", async () => {
    const api = installFakeGitHubApi({ repositories: [...repos(2), { owner: "acme", name: "team-book" }], installations: [{ id: 7, account: "ada" }, { id: 9, account: "acme" }] });
    render(<Harness {...appProps} />);
    // The installations are in the order of their accounts: the first page is the first installation's (acme), the second page the next one's.
    await screen.findByText("1 repository");
    expect(api.paths()).toContain("/user/installations/9/repositories");
    expect(api.paths()).not.toContain("/user/installations/7/repositories");
    expect(api.paths()).not.toContain("/user/repos");
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    fireEvent.keyDown(combobox(), { key: "End" });
    fireEvent.keyDown(combobox(), { key: "Enter" });
    await screen.findByText("3 repositories");
    expect(api.paths()).toContain("/user/installations/7/repositories");
    expect(screen.getByText(t("github.picker.app.only"))).toBeInTheDocument();
    expect(screen.getByText(t("github.picker.app.missing"))).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Change repositories on GitHub/ });
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("href", expect.stringContaining("https://github.com/"));
    expect(screen.getByLabelText(t("github.picker.list.scope"))).toBeInTheDocument();
    expect(within(screen.getByLabelText(t("github.picker.list.scope"))).getAllByRole("option").map((option) => option.textContent)).toEqual([t("github.picker.list.scopeAll"), "acme", "ada"]);
  });

  it("goes to the creation of a new repository, and says how to install the app, when it is installed nowhere", async () => {
    installFakeGitHubApi({ repositories: [], installations: [] });
    render(<Harness {...appProps} />);
    await waitFor(() => expect(modeRadio("create")).toBeChecked());
    fireEvent.click(modeRadio("existing"));
    expect(await screen.findByText(t("github.picker.app.none"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Choose repositories on GitHub/ })).toHaveAttribute("href", "https://github.com/apps/narrarium/installations/new");
  });

  it("reads the list again when the person comes back from GitHub and asks for it", async () => {
    const api = installFakeGitHubApi({ repositories: repos(1), installations: [{ id: 7, account: "ada" }] });
    render(<Harness {...appProps} />);
    await screen.findByText("1 repository");
    const before = api.count("/user/installations/7/repositories");
    fireEvent.click(screen.getByRole("button", { name: t("github.picker.list.reload") }));
    await waitFor(() => expect(api.count("/user/installations/7/repositories")).toBeGreaterThan(before));
  });

  it("does not describe the app as a token: the create mode says what the app needs", async () => {
    installFakeGitHubApi({ repositories: [], installations: [{ id: 7, account: "ada" }] });
    render(<Harness {...appProps} preflight={ready({ tokenKind: "app", scopes: [], issues: ["app-token"] })} />);
    await waitFor(() => expect(modeRadio("create")).toBeChecked());
    const section = screen.getByRole("heading", { name: t("github.createBook.panel.token.titleApp") }).parentElement!;
    expect(section).toHaveTextContent("Repository creation");
    expect(section).toHaveTextContent("Contents");
    expect(section).toHaveTextContent("Workflows");
    expect(section).toHaveTextContent("installed on");
    expect(screen.queryByText(/fine-grained/)).not.toBeInTheDocument();
  });
});

describe("what is done with the repository that was picked", () => {
  const pick = async (name: string) => {
    const input = combobox();
    fireEvent.change(input, { target: { value: name } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
  };

  it("connects a Narrarium book as it is, and says nothing in it is written", async () => {
    const api = installFakeGitHubApi({ repositories: [{ owner: "ada", name: "ready-book", holds: "book" }] });
    render(<Harness />);
    await screen.findByText("1 repository");
    await pick("ready-book");
    expect(await screen.findByText("ada/ready-book is already a Narrarium book: it is added as it is, and nothing in it is written.")).toBeInTheDocument();
    await waitFor(() => expect(decisionText()).toBe("existing|ready-book|connect-book|ready|false"));
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(api.paths().filter((path) => path.includes("/contents/"))).toEqual(["/repos/ada/ready-book/contents/book.md"]);
  });

  it("says, for a book of this device, that the book that is there is added as a book of its own and the local one stays", async () => {
    installFakeGitHubApi({ repositories: [{ owner: "ada", name: "ready-book", holds: "book" }] });
    render(<Harness context="attach" />);
    await screen.findByText("1 repository");
    await pick("ready-book");
    expect(await screen.findByText(/added as a book of its own; the book on this device stays as it is, and nothing is overwritten/)).toBeInTheDocument();
  });

  it("fills an empty repository, in the words of the context", async () => {
    installFakeGitHubApi({ repositories: [{ owner: "ada", name: "blank", holds: "empty" }] });
    render(<Harness context="attach" />);
    await screen.findByText("1 repository");
    await pick("blank");
    expect(await screen.findByText("ada/blank is empty: the book of this device is published into it.")).toBeInTheDocument();
    await waitFor(() => expect(decisionText()).toBe("existing|blank|publish-empty|ready|false"));
  });

  it("writes nothing into a repository with other files until the replacement is turned on, which is off by default and says what it does", async () => {
    installFakeGitHubApi({ repositories: [{ owner: "ada", name: "website", holds: "other", branch: "trunk" }] });
    render(<Harness context="attach" />);
    await screen.findByText("1 repository");
    await pick("website");
    expect(await screen.findByText(/holds other files and is not a Narrarium book. Nothing is written into it unless you turn the replacement on/)).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: t("bookSettings.connectGithub.overwrite") });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(t("bookSettings.connectGithub.overwriteHint"))).toBeInTheDocument();
    await waitFor(() => expect(decisionText()).toBe("existing|website|needs-overwrite|not-ready|false"));
    fireEvent.click(toggle);
    expect(await screen.findByText("The files on the branch «trunk» of ada/website will be replaced by the book of this device.")).toBeInTheDocument();
    await waitFor(() => expect(decisionText()).toBe("existing|website|publish-overwrite|ready|true"));
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(decisionText()).toBe("existing|website|needs-overwrite|not-ready|false"));
  });

  it("starts the replacement from off again for the next repository", async () => {
    installFakeGitHubApi({ repositories: [{ owner: "ada", name: "one", holds: "other" }, { owner: "ada", name: "two", holds: "other" }] });
    render(<Harness />);
    await screen.findByText("2 repositories");
    await pick("one");
    fireEvent.click(await screen.findByRole("switch"));
    await waitFor(() => expect(decisionText()).toMatch(/publish-overwrite/));
    await pick("two");
    await waitFor(() => expect(decisionText()).toBe("existing|two|needs-overwrite|not-ready|false"));
    expect(screen.getByRole("switch")).not.toBeChecked();
  });

  it("says a repository the credential cannot write to cannot be published into, even when it is empty", async () => {
    installFakeGitHubApi({ repositories: [{ owner: "ada", name: "frozen", holds: "empty", push: false }] });
    render(<Harness />);
    await screen.findByText("1 repository");
    await pick("frozen");
    expect(await screen.findByText(/cannot write to ada\/frozen \(it is read only or archived\)/)).toBeInTheDocument();
    await waitFor(() => expect(decisionText()).toBe("existing|frozen|cannot-write|not-ready|false"));
  });

  it("connects a book the credential can only read, and says it will not be able to save", async () => {
    installFakeGitHubApi({ repositories: [{ owner: "ada", name: "theirs", holds: "book", push: false }] });
    render(<Harness />);
    await screen.findByText("1 repository");
    await pick("theirs");
    expect(await screen.findByText(/cannot write to ada\/theirs: you will be able to read the book, not to save changes/)).toBeInTheDocument();
    await waitFor(() => expect(decisionText()).toBe("existing|theirs|connect-book|ready|false"));
  });

  it("is not ready until it has looked, and says when it could not look", async () => {
    installFakeGitHubApi({ repositories: [{ owner: "ada", name: "hidden" }], failures: [{ prefix: "/repos/ada/hidden/contents", status: 403, message: "Resource not accessible" }] });
    render(<Harness />);
    await screen.findByText("1 repository");
    await pick("hidden");
    expect(await screen.findByText(/Could not look inside ada\/hidden/)).toBeInTheDocument();
    expect(decisionText()).toMatch(/not-ready/);
  });

  it("forgets the picked repository when the field is edited, and the decision is no longer ready", async () => {
    installFakeGitHubApi({ repositories: [{ owner: "ada", name: "ready-book" }] });
    render(<Harness />);
    await screen.findByText("1 repository");
    await pick("ready-book");
    await waitFor(() => expect(decisionText()).toMatch(/ready$|ready\|/));
    fireEvent.change(combobox(), { target: { value: "ada/ready-boo" } });
    await waitFor(() => expect(decisionText()).toBe("existing||-|not-ready|false"));
  });
});

describe("the name of a new repository", () => {
  const toCreate = async (props: HarnessProps = {}, api = {}) => {
    const fake = installFakeGitHubApi({ repositories: [], ...api });
    render(<Harness {...props} />);
    await waitFor(() => expect(modeRadio("create")).toBeChecked());
    return fake;
  };

  it("keeps the name derived from the title until the person types, then keeps what they typed", async () => {
    const { rerender } = render(<Harness defaultName="a" />);
    cleanup();
    installFakeGitHubApi({ repositories: [] });
    const view = render(<Harness defaultName="grande-libro" />);
    await waitFor(() => expect(modeRadio("create")).toBeChecked());
    const field = screen.getByLabelText(t("github.picker.create.nameLabel"));
    expect(field).toHaveValue("grande-libro");
    expect(screen.getByText(t("github.picker.create.hintDerived"))).toBeInTheDocument();
    view.rerender(<Harness defaultName="grande-libro-della-giungla" />);
    expect(field).toHaveValue("grande-libro-della-giungla");
    fireEvent.change(field, { target: { value: "il-mio-nome" } });
    view.rerender(<Harness defaultName="altro-titolo" />);
    expect(field).toHaveValue("il-mio-nome");
    expect(screen.getByText(t("github.picker.create.hintTyped"))).toBeInTheDocument();
    await waitFor(() => expect(decisionText()).toBe("create|il-mio-nome|-|ready|false"));
    void rerender;
  });

  it("refuses a name GitHub would refuse, in words, and is not ready", async () => {
    await toCreate({ defaultName: "" });
    const field = screen.getByLabelText(t("github.picker.create.nameLabel"));
    fireEvent.change(field, { target: { value: "il mio libro" } });
    expect(screen.getByText(t("github.createBook.panel.nameProblem.characters"))).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(decisionText()).toMatch(/not-ready/));
  });

  it("says a taken name is taken, proposes the next free one, and uses it when asked", async () => {
    const api = await toCreate({ defaultName: "grande-libro" }, { taken: ["ada/grande-libro", "ada/grande-libro-2"] });
    expect(await screen.findByText(/A repository named «grande-libro» already exists in ada\. Try «grande-libro-3» instead\./, undefined, { timeout: 20_000 })).toBeInTheDocument();
    expect(screen.getByLabelText(t("github.picker.create.nameLabel"))).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(decisionText()).toMatch(/not-ready/));
    fireEvent.click(screen.getByRole("button", { name: "Use «grande-libro-3»" }));
    expect(screen.getByLabelText(t("github.picker.create.nameLabel"))).toHaveValue("grande-libro-3");
    await waitFor(() => expect(decisionText()).toBe("create|grande-libro-3|-|ready|false"), { timeout: 20_000 });
    await waitFor(() => expect(api.paths().filter((path) => path.startsWith("/repos/ada/grande-libro"))).toEqual(["/repos/ada/grande-libro", "/repos/ada/grande-libro-2", "/repos/ada/grande-libro-3", "/repos/ada/grande-libro-3"]), { timeout: 20_000 });
  });

  it("checks the name against the owner that was chosen, a moment after the typing stops (not at every key)", async () => {
    const api = await toCreate({ defaultName: "libro" });
    fireEvent.change(screen.getByLabelText(t("github.createBook.panel.owner.label")), { target: { value: "acme" } });
    const field = screen.getByLabelText(t("github.picker.create.nameLabel"));
    for (const value of ["l", "li", "lib", "libr", "libro-x"]) fireEvent.change(field, { target: { value } });
    await waitFor(() => expect(api.paths()).toContain("/repos/acme/libro-x"), { timeout: 20_000 });
    expect(api.paths().filter((path) => path.startsWith("/repos/acme/"))).toEqual(["/repos/acme/libro-x"]);
  });

  it("keeps the owner, visibility, Pages and the checklist of the creation in this mode only", async () => {
    await toCreate();
    expect(screen.getByRole("group", { name: t("github.createBook.panel.visibility.legend") })).toBeInTheDocument();
    fireEvent.click(modeRadio("existing"));
    expect(screen.queryByRole("group", { name: t("github.createBook.panel.visibility.legend") })).not.toBeInTheDocument();
  });
});

describe("in Italian", () => {
  it("speaks the modes, the list, the flags and the outcome", async () => {
    await i18n.changeLanguage("it");
    installFakeGitHubApi({ repositories: [{ owner: "ada", name: "libro-pronto", holds: "book", private: true, push: true, pushedAt: new Date(Date.now() - 4 * 86_400_000).toISOString() }] });
    render(<Harness />);
    expect(await screen.findByRole("radio", { name: "Collega un repository esistente" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Crea un nuovo repository" })).toBeInTheDocument();
    await screen.findByText("1 repository");
    const input = screen.getByRole("combobox", { name: "Cerca un repository" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const option = options()[0];
    expect(option).toHaveTextContent("privato");
    expect(option).toHaveTextContent("puoi scrivere");
    expect(option).toHaveTextContent("ultimo push 4 giorni fa");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(/è già un libro Narrarium: viene aggiunto com'è/)).toBeInTheDocument();
  });

  it("speaks the app's note and the name that is taken", async () => {
    await i18n.changeLanguage("it");
    installFakeGitHubApi({ repositories: [{ owner: "ada", name: "x" }], installations: [{ id: 7, account: "ada" }] });
    render(<Harness app token="ghu_x" login="ada" cacheKey="app:ada" />);
    await screen.findByText("1 repository");
    expect(screen.getByText("L'app vede solo i repository su cui è installata.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Cambia i repository su GitHub/ })).toBeInTheDocument();
  });
});

describe("the decision is reported once for each change", () => {
  it("reports the first decision and each change, and nothing in between", async () => {
    installFakeGitHubApi({ repositories: [] });
    const seen: string[] = [];
    function Spy() {
      const [choices, setChoices] = useState(defaultGitHubRepositoryChoices);
      return <GitHubRepositoryPicker context="add" token="ghp_x" app={false} cacheKey="spy" defaultName="libro" choices={choices} onChoicesChange={setChoices} preflight={ready()} books={[]} onDecision={(next) => seen.push(`${next.mode}:${next.name}:${next.ready}`)} />;
    }
    render(<Spy />);
    await waitFor(() => expect(seen[seen.length - 1]).toBe("create:libro:true"));
    const before = seen.length;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(seen.length).toBe(before);
    expect(last).toBeNull();
  });
});
