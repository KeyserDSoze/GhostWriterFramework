import { expect, test, type Page } from "@playwright/test";
import { autopilotFacts, bookFiles, openApp, seed, settingsOf, startAutopilot, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";

// In-app navigation never reloads the page, and the autopilot that runs in this browser goes on: the links of the live panel (every book's activity,
// a book's card, the page of the autopilot), the launcher, the row of the active books on the page of every book and the switch to another book.
// A page of an older version, whose files the site no longer has after a deployment, says that a new version is available and leaves the reload to
// the author, without stopping the run. Every check reads a mark left on the document (a reload loses it) and the run's own state and requests.

test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });

const GLASS = { id: "book-glass", repo: "e2e-local-glass", name: "The Glass Harbor" };
const TIDE = { id: "book-tide", repo: "e2e-local-tide", name: "Tide Lines" };

let ai: StubProvider;

async function library(): Promise<SeedBook[]> {
  return [
    { ...GLASS, files: await bookFiles("A harbor town built on glass hides a lie that the tide will tell.", 2) },
    { ...TIDE, files: await bookFiles("A lighthouse keeper's last winter.", 1) },
  ];
}

test.beforeAll(async () => { ai = await startProvider({ delayMs: 2000, chapters: 2, scenes: 2 }); });
test.afterAll(async () => { await ai.close(); });

/** A run of «The Glass Harbor» in this browser, with a mark on the document that only a reload takes away. */
async function runningBook(page: Page): Promise<{ openAi: string[]; loads: string[] }> {
  const books = await library();
  const { openAi } = await seed(page, settingsOf(ai.url, books), books);
  const loads: string[] = [];
  page.on("load", () => loads.push(page.url()));
  // A document navigation would ask to leave a page whose autopilot runs: the request is refused, and the spec sees it.
  page.on("dialog", (dialog) => { loads.push(`dialog ${dialog.type()}`); void dialog.dismiss(); });
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await startAutopilot(page, GLASS.id);
  await waitForAutopilot(page, GLASS.repo, ["running"]);
  await page.evaluate(() => { (window as unknown as { __documentMark: string }).__documentMark = "the same document"; });
  loads.length = 0;
  return { openAi, loads };
}

/** The document is the one the run started in, and the run goes on: it asks the AI again. */
async function stillRunning(page: Page, loads: string[], where: string): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __documentMark?: string }).__documentMark ?? null), `${where}: the same document`).toBe("the same document");
  expect(loads, `${where}: no reload`).toEqual([]);
  const before = ai.requests;
  await expect.poll(() => ai.requests, { timeout: 30_000, message: `${where}: the run asks the AI again` }).toBeGreaterThan(before);
  expect((await autopilotFacts(page, GLASS.repo))?.status, `${where}: the run goes on`).toBe("running");
}

const launcher = (page: Page) => page.getByRole("button", { name: /^Show what the autopilot is doing/ });

async function openPanel(page: Page): Promise<void> {
  if ((await launcher(page).getAttribute("aria-expanded")) !== "true") await launcher(page).click();
  await expect(page.getByRole("region", { name: "Autopilot live" }).or(page.getByRole("dialog", { name: "Autopilot live" }))).toBeVisible();
}

test("the links of the live panel, the launcher, the row of the active books and the switch to another book never reload the page, and the run goes on", async ({ page }) => {
  const { openAi, loads } = await runningBook(page);

  // The switch to another book: the library, then the book.
  await page.getByRole("link", { name: "All books" }).first().click();
  await page.getByRole("link", { name: TIDE.name }).first().click();
  await expect(page).toHaveURL(new RegExp(`/app/books/${TIDE.id}$`));
  await stillRunning(page, loads, "another book");

  // The launcher says the run of the other book, and opens the live panel; its “Live” tab has the card of the book that runs.
  await expect(launcher(page)).toHaveAccessibleName(/1 autopilot running \(The Glass Harbor\)/);
  await openPanel(page);
  await page.getByRole("tab", { name: "Live" }).click();
  await expect(page.locator("[data-dock-book='book-glass']")).toBeVisible();

  // «See every book's activity»: the page of every book, with the row of the active ones.
  await page.getByRole("link", { name: "See every book's activity" }).click();
  await expect(page).toHaveURL(/\/app\/autopilot$/);
  await expect(page.locator("[data-hub-active]")).toContainText(GLASS.name);
  await stillRunning(page, loads, "every book's activity");

  // The row of the active books leads to the autopilot of the book.
  await page.locator("[data-hub-active]").getByRole("link").filter({ hasText: GLASS.name }).click();
  await expect(page).toHaveURL(new RegExp(`/app/books/${GLASS.id}/autopilot$`));
  await stillRunning(page, loads, "the row of the active books");

  // From the other book again: the card of the running book in the panel leads to its autopilot.
  await page.getByRole("link", { name: "All books" }).first().click();
  await page.getByRole("link", { name: TIDE.name }).first().click();
  await openPanel(page);
  await page.getByRole("tab", { name: "Live" }).click();
  await page.getByRole("link", { name: `Open the autopilot of «${GLASS.name}»` }).click();
  await expect(page).toHaveURL(new RegExp(`/app/books/${GLASS.id}/autopilot$`));
  await stillRunning(page, loads, "the card of the book");

  // «Open the autopilot page» of the panel, from the other book.
  await page.getByRole("link", { name: "All books" }).first().click();
  await page.getByRole("link", { name: TIDE.name }).first().click();
  await openPanel(page);
  await page.getByRole("link", { name: "Open the autopilot page" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/books/${TIDE.id}/autopilot$`));
  await stillRunning(page, loads, "the autopilot page of the panel");

  // A step of the running book, from the panel on one of its pages: «Last done» leads to it on the book's autopilot.
  await page.getByRole("link", { name: "All books" }).first().click();
  await page.getByRole("link", { name: GLASS.name }).first().click();
  await expect(page).toHaveURL(new RegExp(`/app/books/${GLASS.id}$`));
  await openPanel(page);
  await page.getByRole("tab", { name: "This book" }).click();
  const step = page.locator("[data-last-done-item]").first();
  await expect(step).toBeVisible({ timeout: 30_000 });
  await step.click();
  await expect(page).toHaveURL(new RegExp(`/app/books/${GLASS.id}/autopilot#task-`));
  await stillRunning(page, loads, "a step of «Last done»");
  expect(openAi, "no request went to the real OpenAI").toEqual([]);
});

test("a page of an older version, whose files are gone after a deployment, says that a new version is available and leaves the reload to the author: the run goes on", async ({ page }) => {
  const { loads } = await runningBook(page);
  await page.getByRole("link", { name: "All books" }).first().click();
  await page.getByRole("link", { name: TIDE.name }).first().click();
  await openPanel(page);
  await page.getByRole("tab", { name: "Live" }).click();
  // The deployment: the page of every book of this version is no longer on the site (GitHub Pages answers its 404 page).
  await page.route("**/assets/AutopilotHubPage-*.js", (route) => route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>Not found</title>" }));
  await page.getByRole("link", { name: "See every book's activity" }).click();

  // The shell stays, with the page's error in it; the update prompt says what a reload stops and offers to wait for the run.
  const alert = page.locator("[data-route-error]");
  await expect(alert).toContainText("This page runs an older version");
  const prompt = page.getByRole("dialog", { name: "New version available" });
  await expect(prompt).toContainText("Updating stops the autopilot running in this browser; it will resume by itself.");
  await prompt.getByRole("button", { name: "Update when it finishes" }).click();
  await expect(prompt).toBeHidden();
  await expect(page.getByRole("link", { name: "All books" }).first()).toBeVisible();
  await expect(launcher(page)).toBeVisible();
  await stillRunning(page, loads, "after the page of an older version");

  // «Reload now» of the page opens the prompt again: it never reloads over the run by itself.
  await alert.getByRole("button", { name: "Reload now" }).click();
  await expect(page.getByRole("dialog", { name: "New version available" })).toBeVisible();
  await stillRunning(page, loads, "after «Reload now» with a run");
});

test("a live panel that cannot be loaded closes, the app stays and the run goes on", async ({ page }) => {
  const { loads } = await runningBook(page);
  await page.route("**/assets/AutopilotDock-*.js", (route) => route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>Not found</title>" }));
  await page.getByRole("link", { name: "All books" }).first().click();
  await launcher(page).click();
  const prompt = page.getByRole("dialog", { name: "New version available" });
  await expect(prompt).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(prompt).toBeHidden();
  await expect(page.getByRole("link", { name: "All books" }).first()).toBeVisible();
  await expect(launcher(page)).toBeVisible();
  await expect(launcher(page)).toHaveAttribute("aria-expanded", "false");
  await stillRunning(page, loads, "after the panel that could not be loaded");
});
