import { mkdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { bookFiles, openApp, seed, settingsOf, startAutopilot, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";
import { startPersonalServer, type TestPersonalServer } from "./helpers/personal-server";

// «Where it runs», for the case of the owner's report: a book of GitHub on the GitHub app's token, its autopilot running in this browser, GitHub out of reach, and a real personal
// server (in this process) that has nothing of this device yet. «Pass to the server after this step» in the band cannot make its plan without the author's consent, so it opens
// the card; the card finishes it (the consents, the plan, the sentence that says where it is, the way to take it back) instead of leaving every action disabled, and the amber notice about
// the app's token has the fix at hand.

test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const GLASS = { id: "book-glass", repo: "e2e-glass", name: "The Glass Harbor", github: { owner: "e2e-owner", repo: "glass-harbor", branch: "main" } };
const CLONE = "main";
const APP_TOKEN = "ghu_e2e_app_token_0123456789";
const PAT = "github_pat_e2e_0123456789abcdef";
const SHOTS = process.env.SHOTS_DIR ?? "";

let ai: StubProvider;
let server: TestPersonalServer;
test.beforeAll(async () => { ai = await startProvider({ delayMs: 6000, chapters: 1, scenes: 2 }); });
test.beforeEach(async () => { server = await startPersonalServer(); });
test.afterEach(async () => { await server.close(); });
test.afterAll(async () => { await ai.close(); });

/** The page seeded with the book, the app's token and the pairing with the server, GitHub out of reach: every request to it is kept and fails, except the ones a spec answers. */
async function open(page: Page): Promise<{ github: Array<{ url: string; authorization: string | null }> }> {
  const github: Array<{ url: string; authorization: string | null }> = [];
  const books: SeedBook[] = [{ ...GLASS, files: await bookFiles("A harbor town built on glass hides a lie that the tide will tell.", 1) }];
  await seed(page, { ...settingsOf(ai.url, books), personalServer: server.pairing }, books, { githubApp: { token: APP_TOKEN, login: "e2e-user" } });
  await page.route(/^https:\/\/([a-z]+\.)?github(usercontent)?\.com\//, (route) => { github.push({ url: route.request().url(), authorization: route.request().headers().authorization ?? null }); return route.abort("blockedbyclient"); });
  // The settings are saved to the Drive of the test: the save is accepted.
  await page.route("https://www.googleapis.com/upload/drive/v3/files/**", (route) => route.fulfill({ json: { id: "e2e-settings" } }));
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  return { github };
}

/** What was asked of GitHub, but for the list of the branches that the automatic sync asks once when a linked book is opened: that is not the card's. */
const askedOfGitHubByTheCard = (github: Array<{ url: string }>) => github.map((request) => request.url).filter((url) => !/\/repos\/[^/]+\/[^/]+\/branches\?/.test(url));

/** The card at 390x844 and 1280x800, light and dark: scrolled to what the capture is about (`target`), as the author finds it (`"none"`), or to the card. */
async function shots(page: Page, name: string, target: Locator | "card" | "none" = "card") {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
      if (target === "card") await page.locator("#autopilot-where").scrollIntoViewIfNeeded();
      else if (target !== "none") await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/${name}-${width}x${height}-${theme}.png` });
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize({ width: 1280, height: 800 });
}

/** The live band of a book that runs: «Runs on: This browser» is under «More», and «Pass to the server after this step» in its menu. */
async function askToPassAfterTheStep(page: Page) {
  await page.getByRole("button", { name: "More — The Glass Harbor", exact: true }).click();
  const menu = page.getByRole("button", { name: /^Runs on: This browser/ }).first();
  await expect(menu).toBeEnabled({ timeout: 30_000 });
  await menu.click();
  await page.getByRole("menuitem", { name: "Pass to the server after this step" }).click();
}

async function runningWithTheCardOpen(page: Page, viewport?: { width: number; height: number }) {
  const network = await open(page);
  if (viewport) await page.setViewportSize(viewport);
  await startAutopilot(page, GLASS.id);
  await waitForAutopilot(page, CLONE, ["running"]);
  await askToPassAfterTheStep(page);
  // The server has none of this device's consents: the command says so, and opens the card with the server already chosen.
  await expect(page).toHaveURL(/#autopilot-where$/);
  return { ...network, card: page.locator("#autopilot-where") };
}

test("the author sent to «Where it runs» by «after this step» finds the consents and the button that finishes it, and the plan says where it is and can be taken back", async ({ page }) => {
  // The step takes longer than everything this spec does while it is in flight: the plan waits for it all the time.
  ai.delayMs = 120_000;
  // On a phone: the bar of commands is fixed at the foot of the screen, and what takes the focus must not be hidden behind it.
  const { card, github } = await runningWithTheCardOpen(page, { width: 390, height: 844 });
  const server_ = card.getByRole("radio", { name: "My personal server" });
  const browser_ = card.getByRole("radio", { name: "This browser" });
  const pass = card.getByRole("button", { name: "Pass to the server after this step" });

  // What was a dead end: the radios are free, the button is the command itself, and the focus is on it.
  await expect(server_).toHaveAttribute("aria-checked", "true");
  await expect(server_).toBeEnabled();
  await expect(browser_).toBeEnabled();
  await expect(pass).toBeEnabled();
  await expect(pass).toBeFocused();
  await expect(card.getByLabel(/^Send my AI configuration/)).toBeChecked();
  await expect(card.getByLabel(/^Send this book's GitHub token/)).toBeChecked();
  await expect(card).toContainText("The autopilot is running in this browser. The book passes to the server when the step in progress ends");
  await expect(card.getByTestId("github-server-token-notice").getByRole("button", { name: "Use a personal access token for this book" })).toBeVisible();
  const view = await pass.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { onScreen: box.top >= 0 && box.bottom <= window.innerHeight, covered: !(hit === element || element.contains(hit)), by: hit ? `${hit.tagName}.${String(hit.className).slice(0, 60)}` : null, bottom: Math.round(box.bottom), height: window.innerHeight };
  });
  expect(JSON.stringify(view), "the button that has the focus is on the screen and nothing covers it").toContain(`"onScreen":true,"covered":false`);
  await shots(page, "after-arrival", "none");
  await shots(page, "after-finish", pass);

  // A box that is not ticked, and that the server cannot do without, says why the button waits, and has the action.
  await card.getByLabel(/^Send this book's GitHub token/).uncheck();
  await expect(pass).toBeDisabled();
  await expect(card).toContainText("Your server does not have this book's GitHub token. Send it with the book to go on.");
  await shots(page, "after-blocked", card.locator("[id^=where-move-blocked]"));
  await card.getByRole("button", { name: "Send the token with the book" }).click();
  await expect(pass).toBeEnabled();

  // The plan: its sentence, its button to take it back; nothing was sent to the server, and GitHub was not asked for anything by this page.
  await pass.click();
  const plan = card.locator("[data-where-plan]");
  await expect(plan).toContainText("The book will pass to the server when the current step ends");
  await expect(plan).toBeFocused();
  await expect(card.getByRole("button", { name: "Cancel the switch to the server" })).toBeEnabled();
  expect(await server.aiConfigured(), "the consent is held by the plan: nothing was sent while the step runs").toBe(false);
  expect(await server.books()).toEqual([]);
  expect(askedOfGitHubByTheCard(github), "the card and its plan ask GitHub for nothing").toEqual([]);
  await shots(page, "after-queued", plan);

  // Taken back: the card is as it was, the run goes on, and still nothing was sent.
  await card.getByRole("button", { name: "Cancel the switch to the server" }).click();
  await expect(plan).toHaveCount(0);
  await expect(pass).toBeEnabled();
  await expect(pass).toBeFocused();
  expect((await waitForAutopilot(page, CLONE, ["running"], 20_000)).status).toBe("running");
  expect(await server.aiConfigured()).toBe(false);
  expect(await server.books()).toEqual([]);
});

test("the plan goes on when the step ends: the consent is sent by the move, and with GitHub out of reach the move says so and leaves the book stopped where it was", async ({ page }) => {
  ai.delayMs = 6000;
  const { card, github } = await runningWithTheCardOpen(page);
  await card.getByRole("button", { name: "Pass to the server after this step" }).click();
  await expect(card.locator("[data-where-plan]")).toContainText("The book will pass to the server when the current step ends");
  expect(await server.aiConfigured()).toBe(false);

  // The step ends, the run stops, the plan moves the book: the AI configuration the author consented to goes first, then the book is published, which GitHub being out of reach refuses.
  await expect.poll(() => server.aiConfigured(), { timeout: 90_000, message: "the configuration is sent when the book moves" }).toBe(true);
  await expect(page.getByText("The switch to the server did not complete").first()).toBeVisible({ timeout: 90_000 });
  expect(github.length, "the move tried GitHub, which is out of reach").toBeGreaterThan(0);
  // Nothing was lost and nothing is half done: the book is not on the server, and runs nowhere.
  expect(await server.books()).toEqual([]);
  expect((await waitForAutopilot(page, CLONE, ["paused"], 30_000)).status).toBe("paused");
  await expect(card.getByRole("button", { name: "Pass to the server after this step" })).toHaveCount(0);
  await expect(card.getByRole("radio", { name: "This browser" })).toBeEnabled();
});

test("«Use a personal access token for this book»: the dialog explains it, asks GitHub only when the button is pressed, saves the token for the book, and the notice goes", async ({ page }) => {
  const { github } = await open(page);
  // GitHub answers for the token that the author pastes: it reads and writes the repository.
  const answered: Array<string | null> = [];
  await page.route("https://api.github.com/repos/e2e-owner/glass-harbor", (route) => {
    answered.push(route.request().headers().authorization ?? null);
    return route.fulfill({ json: { full_name: "e2e-owner/glass-harbor", permissions: { push: true } } });
  });
  await page.goto(`app/books/${GLASS.id}/autopilot`, { waitUntil: "domcontentloaded" });
  const card = page.locator("#autopilot-where");
  await card.getByRole("radio", { name: "My personal server" }).click();
  const notice = card.getByTestId("github-server-token-notice");
  await expect(notice).toContainText("App tokens last 8 hours");
  await notice.getByRole("button", { name: "Use a personal access token for this book" }).click();

  const dialog = page.getByRole("dialog", { name: "Use a personal access token for this book" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  await expect(dialog).toContainText("Contents: Read and write");
  await expect(dialog.getByRole("link", { name: /Create it on GitHub/ })).toHaveAttribute("href", "https://github.com/settings/personal-access-tokens/new");
  expect(askedOfGitHubByTheCard(github).length + answered.length, "GitHub is asked when the button is pressed, not before").toBe(0);
  await shots(page, "after-token-dialog", "none");

  await dialog.getByLabel("Token").fill(PAT);
  await dialog.getByRole("button", { name: "Check and save" }).click();
  await expect(dialog).toHaveCount(0);
  expect(answered, "one question to GitHub, with the token that was pasted").toEqual([`Bearer ${PAT}`]);
  await expect(notice).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Move to my server" })).toBeEnabled();

  // The book's own settings show that it uses a token of its own.
  await page.goto(`app/books/${GLASS.id}/settings#github`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("This book uses: its own token.", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
});
