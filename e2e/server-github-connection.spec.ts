import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { bookFiles, openApp, seed, settingsOf, startProvider, waitForAiSettings, type SeedBook, type StubProvider } from "./helpers/autopilot";
import { ACCESS_TOKEN, CLIENT_ID, startFakeBroker, startFakeGitHub, type FakeBroker, type FakeGitHub } from "./helpers/fake-github";
import { startPersonalServer, type TestPersonalServer } from "./helpers/personal-server";

// The personal server's own connection to GitHub (device authorization), from the owner's side: Settings → Personal server shows the card, the owner types the code on a GitHub that lives in this process,
// the server (the real one, in this process too) finishes the connection by itself and renews it through a broker that lives here as well; a GitHub book is moved to the server with that connection,
// so that no copy of any token is sent; and disconnecting stops the books that use it. The page is a build for these specs, given the Client ID and the broker of the fakes.

test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const GLASS = { id: "book-glass", repo: "e2e-glass", name: "The Glass Harbor", github: { owner: "e2e-owner", repo: "glass-harbor", branch: "main" } };
const APP_TOKEN = "ghu_e2e_browser_app_token_0123456789";
const SHOTS = process.env.SHOTS_DIR ?? "";

let ai: StubProvider;
let github: FakeGitHub;
let broker: FakeBroker;
let server: TestPersonalServer;
let remote: string;

test.beforeAll(async () => { ai = await startProvider({ chapters: 1, scenes: 2 }); });
test.afterAll(async () => { await ai.close(); });

test.beforeEach(async () => {
  github = await startFakeGitHub();
  broker = await startFakeBroker();
  remote = await bareRemote(await bookFiles("A harbor town built on glass hides a lie that the tide will tell.", 1));
  server = await startPersonalServer({ githubConnection: github.options, githubRemoteUrl: () => remote });
});
test.afterEach(async () => {
  await server.close();
  await github.close();
  await broker.close();
  await rm(remote, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A bare repository with the files of the book on `main`: what GitHub's remote of the book is for the server, which clones it. */
async function bareRemote(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "narrarium-e2e-remote-"));
  const bare = join(root, "remote.git");
  const work = join(root, "work");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-C", cwd, ...args], { stdio: "pipe" });
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare]);
  await mkdir(work, { recursive: true });
  git(work, "init", "--quiet", "-b", "main");
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(work, file)), { recursive: true });
    await writeFile(join(work, file), text);
  }
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "seed");
  git(work, "push", "--quiet", bare, "main");
  return bare;
}

/** What the page asked of GitHub, and of the server about its connection, for the specs that say what was and was not asked. */
interface Asked {
  github: Array<{ url: string; authorization: string | null }>;
  connectionRoute: Array<{ method: string; at: number }>;
  toServer: Array<{ method: string; url: string; body: string }>;
}

/** The page seeded with the book and the app's token of this device, paired with the server, and given the Client ID and the broker of the fakes (the build for specs reads them from the page). */
async function open(page: Page, options: { githubRefAnswers?: boolean } = {}): Promise<Asked> {
  const asked: Asked = { github: [], connectionRoute: [], toServer: [] };
  const books: SeedBook[] = [{ ...GLASS, files: await bookFiles("A harbor town built on glass hides a lie that the tide will tell.", 1) }];
  await seed(page, { ...settingsOf(ai.url, books), personalServer: server.pairing }, books, { githubApp: { token: APP_TOKEN, login: "e2e-user" } });
  await page.addInitScript((site) => { (window as unknown as { __serverGitHubSiteForTests?: unknown }).__serverGitHubSiteForTests = site; }, { clientId: CLIENT_ID, broker: broker.url });
  await page.route(/^https:\/\/([a-z]+\.)?github(usercontent)?\.com\//, (route) => {
    const request = route.request();
    asked.github.push({ url: request.url(), authorization: request.headers().authorization ?? null });
    // The browser publishes the book before it moves: its working copy is at the head of the remote, which is all it asks.
    if (options.githubRefAnswers && /^https:\/\/api\.github\.com\/repos\/e2e-owner\/glass-harbor\/git\/ref\/heads(\/|%2F)main$/.test(request.url())) return route.fulfill({ json: { ref: "refs/heads/main", object: { sha: "head-base", type: "commit" } } });
    return route.abort("blockedbyclient");
  });
  await page.route("https://www.googleapis.com/upload/drive/v3/files/**", (route) => route.fulfill({ json: { id: "e2e-settings" } }));
  page.on("request", (request) => {
    if (!request.url().startsWith(`${server.url}/`)) return;
    if (/\/api\/v1\/github\/connection$/.test(request.url())) asked.connectionRoute.push({ method: request.method(), at: Date.now() });
    if (request.method() !== "GET") asked.toServer.push({ method: request.method(), url: request.url(), body: request.postData() ?? "" });
  });
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  return asked;
}

/** The card at 390x844 and 1280x800, light and dark, scrolled to it. */
async function shots(page: Page, name: string, target: Locator) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
      await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/server-conn-${name}-${width}x${height}-${theme}.png` });
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize({ width: 1280, height: 800 });
}

const cardOf = (page: Page) => page.getByTestId("server-github-card");

async function openCard(page: Page): Promise<Locator> {
  await page.goto("app/settings/server", { waitUntil: "domcontentloaded" });
  const card = cardOf(page);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole("heading", { name: "GitHub connection of the server" })).toBeVisible();
  return card;
}

/** The owner connects the server to GitHub in the card: the code, the page on GitHub, and the type of the code (the fake approves). */
async function connectFromTheCard(page: Page, card: Locator) {
  await card.getByRole("button", { name: "Connect the server to GitHub" }).click();
  await expect(card).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
}

test("Settings → Personal server: the owner connects the server to GitHub with a code, and the card follows the server until it is connected", async ({ page }) => {
  const asked = await open(page);
  // Nothing of the connection is asked of the server by a page that does not show the card, nor of GitHub by any page.
  await page.waitForTimeout(1500);
  expect(asked.connectionRoute, "the server is not asked about its GitHub connection while no card is on screen").toEqual([]);

  const card = await openCard(page);
  await expect(card).toHaveAttribute("data-state", "disconnected");
  await expect(card).toContainText("Lets your personal server reach your GitHub books by itself");
  await expect(card).toContainText("The server then keeps a GitHub App token on your computer");
  expect(asked.connectionRoute.map((call) => call.method), "the card reads the status once, when it is shown").toEqual(["GET"]);
  await expect(card.getByRole("button", { name: "Connect the server to GitHub" })).toBeEnabled();

  await connectFromTheCard(page, card);
  expect(github.requests.find((request) => request.path === "/login/device/code")?.form.client_id, "the server asked GitHub with the Client ID of the site, not with anything of this browser's sign-in").toBe(CLIENT_ID);
  const code = card.getByTestId("server-github-code");
  await expect(code).toHaveText(/WDJB-MJHT/);
  await expect(card.getByText("Waiting for you to enter the code on GitHub…")).toBeVisible();
  await expect(card.getByRole("button", { name: "Copy the code" })).toBeEnabled();
  const link = card.getByRole("link", { name: /Open GitHub to enter the code/ });
  await expect(link).toHaveAttribute("href", github.verificationUri);
  await expect(link).toHaveAttribute("target", "_blank");
  await shots(page, "pending", card);

  // The owner opens GitHub in a new tab and types the code there (the fake approves), and the card, which asks the server again while it waits, shows the connection.
  const [tab] = await Promise.all([page.waitForEvent("popup"), link.click()]);
  await tab.waitForLoadState("domcontentloaded");
  expect(tab.url()).toBe(github.verificationUri);
  expect(github.visits).toBe(1);
  await tab.close();
  github.approve();
  await expect(card.getByText("Connected as octocat; the server renews it by itself.")).toBeVisible({ timeout: 60_000 });
  await expect(card).toHaveAttribute("data-state", "connected");
  await expect(card.getByRole("button", { name: "Disconnect" })).toBeEnabled();
  await expect(card.getByText("Current token valid until")).toBeVisible();
  await expect(card.getByText(broker.url)).toBeVisible();
  await expect(card.getByTestId("server-github-code")).toHaveCount(0);
  expect(await server.githubConnection()).toMatchObject({ state: "connected", login: "octocat" });
  expect(await page.content(), "no token is on the page").not.toContain(ACCESS_TOKEN);
  await shots(page, "connected", card);

  // The page never asked GitHub for anything: it asks the server, and the server asks GitHub.
  expect(asked.github, "the browser asked github.com and api.github.com for nothing").toEqual([]);
  const polling = asked.connectionRoute.filter((call) => call.method === "GET").length;
  await page.waitForTimeout(4000);
  expect(asked.connectionRoute.filter((call) => call.method === "GET").length, "the card stops asking once the server is connected").toBe(polling);
});

test("a GitHub book is moved to the server with the server's own GitHub connection: no copy of a token is sent, and the warning about the 8 hours does not show", async ({ page }) => {
  const asked = await open(page, { githubRefAnswers: true });
  expect((await server.startGitHubConnection({ clientId: CLIENT_ID, broker: broker.url })).state).toBe("pending");
  github.approve();
  await expect.poll(async () => (await server.githubConnection()).state, { timeout: 30_000 }).toBe("connected");

  await page.goto(`app/books/${GLASS.id}/autopilot`, { waitUntil: "domcontentloaded" });
  const card = page.locator("#autopilot-where");
  const before = asked.connectionRoute.length;
  await card.getByRole("radio", { name: "My personal server" }).click();

  // The connection is offered, and chosen: the other way is a token sent with the book.
  const group = card.getByRole("group", { name: "How the server signs in to GitHub for this book" });
  await expect(group).toBeVisible({ timeout: 30_000 });
  await expect(group.getByRole("radio", { name: /Use the server's own GitHub connection for this book \(no copy of the token is sent\)/ })).toBeChecked();
  await expect(group.getByRole("radio", { name: "Send this book's GitHub token to my server" })).not.toBeChecked();
  await expect(group).toContainText("Connected as octocat");
  expect(asked.connectionRoute.length, "the connection is read when the author chooses the server").toBeGreaterThan(before);
  await expect(card.getByTestId("github-server-token-notice"), "the book uses the app's token here, and warns about it only when the token is the one that is sent").toHaveCount(0);
  await shots(page, "choice", group);

  await group.getByRole("radio", { name: "Send this book's GitHub token to my server" }).check();
  await expect(card.getByTestId("github-server-token-notice")).toContainText("App tokens last 8 hours");
  await group.getByRole("radio", { name: /Use the server's own GitHub connection/ }).check();
  await expect(card.getByTestId("github-server-token-notice")).toHaveCount(0);

  await card.getByRole("button", { name: "Move to my server" }).click();
  await expect(page.getByText("This book's autopilot now runs on your server.").first()).toBeVisible({ timeout: 90_000 });

  // The server holds the book on its connection, and no token of this browser was ever sent to it.
  await expect.poll(async () => (await server.books()).map((book) => ({ id: book.bookId, auth: book.githubAuth, token: book.hasGithubToken }))).toEqual([{ id: GLASS.id, auth: "connection", token: false }]);
  const registration = asked.toServer.find((call) => /\/api\/v1\/books\/book-glass$/.test(call.url) && call.method !== "DELETE");
  expect(registration, "the book was registered").toBeTruthy();
  expect(JSON.parse(registration!.body)).toMatchObject({ githubAuth: "connection", storage: { kind: "github", owner: "e2e-owner", repo: "glass-harbor" } });
  expect(registration!.body).not.toContain("githubToken");
  expect(JSON.stringify(asked.toServer), "nothing the browser sent to the server holds its GitHub token").not.toContain(APP_TOKEN);
  expect(asked.github.map((call) => call.url).filter((url) => !/\/repos\/e2e-owner\/glass-harbor\/(git\/ref\/heads(\/|%2F)main|branches)/.test(url)), "the browser asked GitHub only for what publishing the book needs").toEqual([]);

  // The card now says how the book signs in, and the book's pages carry no warning about a token that lapses.
  await expect(card.locator("[data-where-server-connection]")).toContainText("signs in to GitHub with the server's own GitHub connection");
  await expect(card.getByTestId("github-server-token-notice")).toHaveCount(0);
  await page.goto(`app/books/${GLASS.id}/settings#github`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("This book uses:").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("github-server-token-notice")).toHaveCount(0);

  // Disconnecting stops the books that use it, and says so before it does.
  const settings = await openCard(page);
  await expect(settings.getByText("1 book on your server uses this connection.")).toBeVisible({ timeout: 30_000 });
  await settings.getByRole("button", { name: "Disconnect" }).click();
  const dialog = page.getByRole("dialog", { name: "Disconnect the server from GitHub?" });
  await expect(dialog).toContainText("1 book on your server uses it.");
  await shots(page, "disconnect-dialog", dialog);
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(settings).toHaveAttribute("data-state", "disconnected", { timeout: 30_000 });
  expect(await server.githubConnection()).toMatchObject({ state: "disconnected" });
  await expect.poll(() => broker.requests.filter((call) => call.path === "/oauth/github/revoke-token").length, { message: "the server asked the broker to revoke its own token" }).toBe(1);
  expect(broker.requests.find((call) => call.path === "/oauth/github/revoke-token")?.json).toEqual({ token: ACCESS_TOKEN });

  // The book is still the server's, and says that it cannot publish until the connection is made again.
  await page.goto(`app/books/${GLASS.id}/autopilot`, { waitUntil: "domcontentloaded" });
  const down = page.locator("#autopilot-where").locator("[data-where-server-connection-down]");
  await expect(down).toContainText("not connected", { timeout: 30_000 });
  await expect(down.getByRole("link", { name: "Personal server" })).toHaveAttribute("href", /\/app\/settings\/server$/);
});

test("disconnect asks first, forgets the connection on the server, and the card offers to connect again", async ({ page }) => {
  await open(page);
  await server.startGitHubConnection({ clientId: CLIENT_ID, broker: broker.url });
  github.approve();
  await expect.poll(async () => (await server.githubConnection()).state, { timeout: 30_000 }).toBe("connected");
  const card = await openCard(page);
  await expect(card.getByText("Connected as octocat; the server renews it by itself.")).toBeVisible({ timeout: 30_000 });

  await card.getByRole("button", { name: "Disconnect" }).click();
  const dialog = page.getByRole("dialog", { name: "Disconnect the server from GitHub?" });
  await expect(dialog).toContainText("The books that use the server's connection stop publishing");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await server.githubConnection()).state, "«Cancel» disconnects nothing").toBe("connected");

  await card.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("dialog", { name: "Disconnect the server from GitHub?" }).getByRole("button", { name: "Disconnect" }).click();
  await expect(card).toHaveAttribute("data-state", "disconnected", { timeout: 30_000 });
  await expect(card.getByRole("button", { name: "Connect the server to GitHub" })).toBeEnabled();
  expect((await server.githubConnection()).state).toBe("disconnected");
});

test("when the GitHub App has no device flow the card says which switch to turn on, in its own words, and the server keeps nothing", async ({ page }) => {
  github.mode = "device-flow-disabled";
  const asked = await open(page);
  const card = await openCard(page);
  await card.getByRole("button", { name: "Connect the server to GitHub" }).click();
  const problem = card.getByTestId("server-github-problem");
  await expect(problem).toHaveAttribute("data-problem", "device-flow-disabled", { timeout: 30_000 });
  await expect(problem).toContainText("Device flow is switched off in the GitHub App. In the settings of the GitHub App turn on “Enable Device Flow”, save, and connect again.");
  await expect(problem, "the sentence is this site's, not the server's English").not.toContainText("Settings → Developer settings");
  await expect(card).toHaveAttribute("data-state", "disconnected");
  await expect(card.getByRole("button", { name: "Connect the server to GitHub" })).toBeEnabled();
  expect(await server.githubConnection()).toMatchObject({ state: "disconnected", problem: { code: "device-flow-disabled" } });
  expect(asked.github).toEqual([]);
  await shots(page, "device-flow-disabled", card);

  // After the owner switched it on, the same button works.
  github.mode = "ok";
  await card.getByRole("button", { name: "Connect the server to GitHub" }).click();
  await expect(card).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
  await expect(card.getByTestId("server-github-problem")).toHaveCount(0);
});
