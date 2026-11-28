import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { bookFiles, openApp, seed, settingsOf, startProvider, waitForAiSettings, type StubProvider } from "./helpers/autopilot";
import { startServer, type StubServer } from "./helpers/server";

// What the costs say before and beside a run, with GitHub blocked, a fake AI provider whose model has a price and a stub personal server:
// 1. the setup of the autopilot compares the estimate of the run with what the budget has left, says where it would stop, and one click raises the budget until it fits;
// 2. the books that run on the personal server are counted in a line of their own (the top bar, the dashboard), never added to the browser's months, with what it holds and what it does not;
// 3. a call of the log says which window its model was judged by. With COSTS_SHOTS set the parts are captured at 390x844 and 1280x800, light and dark.

test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });

const BOOK = { id: "book-outlook", repo: "e2e-local-outlook", name: "The Lighthouse Outlook" };
const SERVED = { id: "book-served", repo: "e2e-local-served", name: "The Fog Bell" };
const UNREAD = { id: "book-unread", repo: "e2e-local-unread", name: "The Salt Road" };
const IDEA = "A lighthouse keeper counts the ships that never come in, and one night one does.";
const PRICE = { inputPerMTok: 2, outputPerMTok: 8 };

let ai: StubProvider;
let server: StubServer;

test.beforeAll(async () => {
  ai = await startProvider({ delayMs: 50, chapters: 6, scenes: 2 });
  server = await startServer([{ bookId: SERVED.id, title: SERVED.name, stats: { cost: 3.2, aiCalls: 12, costUnknownCalls: 2 } }]);
});
test.afterAll(async () => { await ai.close(); await server.close(); });

const storedBudgets = (page: Page) => page.evaluate(() => new Promise<unknown>((resolveBudgets) => {
  const open = indexedDB.open("narrarium-local-account");
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("core")) { db.close(); resolveBudgets(null); return; }
    const get = db.transaction("core", "readonly").objectStore("core").get("current");
    get.onsuccess = () => { db.close(); resolveBudgets(get.result?.settings?.costBudgets ?? null); };
    get.onerror = () => { db.close(); resolveBudgets(null); };
  };
  open.onerror = () => resolveBudgets(null);
}));

async function capture(page: Page, name: string, selector: string) {
  const folder = process.env.COSTS_SHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  for (const [width, height] of [[390, 844], [1280, 800]] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
      await page.locator(selector).first().scrollIntoViewIfNeeded();
      await page.locator(selector).first().screenshot({ path: `${folder}/${name}-${width}x${height}-${theme}.png` });
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize({ width: 1280, height: 800 });
}

function watchGitHub(page: Page): string[] {
  const github: string[] = [];
  void page.route(/^https:\/\/([a-z-]+\.)?github(usercontent)?\.com\//, (route) => { github.push(route.request().url()); return route.abort("blockedbyclient"); });
  return github;
}

test("the setup compares the estimate of the run with the budget, says where it would stop, and one click raises the budget until it fits", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const github = watchGitHub(page);
  const books = [{ id: BOOK.id, repo: BOOK.repo, name: BOOK.name, files: await bookFiles(IDEA, 6) }];
  const settings = settingsOf(ai.url, books) as ReturnType<typeof settingsOf> & { costBudgets?: unknown };
  settings.aiIntegrations[0].chatModels[0] = { ...settings.aiIntegrations[0].chatModels[0], pricing: PRICE } as typeof settings.aiIntegrations[0]["chatModels"][0];
  settings.costBudgets = { global: { USD: { total: 0.05 } } };
  const { openAi } = await seed(page, settings, books, { marker: "narrarium-e2e-outlook-seeded-v1" });
  await openApp(page);
  await page.goto(`app/books/${BOOK.id}/autopilot/settings`, { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  const outlook = page.locator("#autopilot-estimate [data-budget-outlook]");
  await expect(outlook).toBeVisible({ timeout: 30_000 });
  await expect(outlook).toHaveAttribute("data-budget-outlook", "stops");
  await expect(outlook.locator("[data-outlook-text]")).toHaveText(/^This run is estimated at \$[\d.]+( to \$[\d.]+)?, you have \$0\.05 left in the budget \(All books, in total\): it would stop (at about chapter \d+\.|somewhere between chapter \d+ and chapter \d+\.)$/);
  await expect(outlook.getByRole("button", { name: "Start anyway" }), "the setup card has nothing to start: its own start button is below").toHaveCount(0);
  await capture(page, "outlook", "#autopilot-estimate [data-budget-outlook]");

  await outlook.getByRole("button", { name: /^Raise the budget to / }).click();
  await expect(outlook).toHaveAttribute("data-budget-outlook", "fits");
  await expect(outlook.locator("[data-outlook-text]")).toContainText("it fits.");
  await expect(outlook.locator("[data-outlook-raised]")).toContainText("Raised: the in total budget of All books is now");
  const stored = await storedBudgets(page) as { global: { USD: { total: number } } };
  expect(stored.global.USD.total, "the budget the click set is in the settings of the account, and it covers the run").toBeGreaterThan(0.05);

  expect(openAi, "no request went to the real OpenAI").toEqual([]);
  expect(github, "GitHub was blocked and was not asked for anything").toEqual([]);
});

test("the books on the personal server are counted in a line of their own: the top bar and the dashboard say what the server counted, what it holds and what it does not", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1500, height: 900 });
  const github = watchGitHub(page);
  const books = [SERVED, UNREAD].map((book) => ({ id: book.id, repo: book.repo, name: book.name, files: {} as Record<string, string> }));
  for (const book of books) book.files = await bookFiles(IDEA, 2);
  const settings = settingsOf(ai.url, books) as ReturnType<typeof settingsOf> & { personalServer?: unknown };
  for (const entry of settings.books as Array<Record<string, unknown>>) entry.autopilotHost = "server";
  settings.personalServer = { url: server.url, token: server.token, serverId: server.serverId, fingerprint: server.fingerprint, clientLabel: "e2e" };
  const { openAi } = await seed(page, settings, books, { marker: "narrarium-e2e-server-spend-seeded-v1" });
  await openApp(page);
  await page.goto("app/costs", { waitUntil: "domcontentloaded" });

  // The top bar: the server's count has a part of its own; nothing was spent in this browser, so there is no today and no month of its own to add it to.
  const pill = page.locator("[data-costs-indicator]");
  await expect(pill.locator("[data-costs-server]")).toHaveText("server $3.20", { timeout: 60_000 });
  await expect(pill.locator("[data-costs-server-note]")).toHaveText(/^On your server: \$3\.20 in all, from the autopilot's own count of its runs, not split by day or month and not included in today or this month\./);
  await expect(pill).toHaveAccessibleName(/On your server: \$3\.20 in all/);

  // The dashboard: the same figure in a line of its own, with what it holds and what it does not (the book whose count was not listed, the calls without a price).
  const line = page.locator("[data-server-totals]");
  await expect(line).toContainText("On your server: $3.20 over all the runs of 1 book, from the server's own count. It is not split by month, so it is not added to the totals above.");
  await expect(line.locator("[data-server-includes]")).toContainText("Included: the autopilot's calls of the books that run on your server. Not included: what your browsers recorded");
  await expect(line.locator("[data-server-unread]")).toContainText("1 book that runs on your server has not been read yet, so it is not in this figure.");
  await expect(line.locator("[data-server-unpriced]")).toContainText("2 calls of the server have no price, so their cost is not in this figure.");
  await expect(page.locator("[data-costs-totals] dl"), "the totals of this browser do not hold what the server counted").toContainText("Spend—");
  await capture(page, "server-totals", "[data-server-totals]");
  await capture(page, "topbar-pill", "[data-costs-indicator]");
  expect(server.requests.filter((request) => request === "GET /api/v1/books").length, "the app asked the server for its books").toBeGreaterThan(0);

  expect(openAi, "no request went to the real OpenAI").toEqual([]);
  expect(github, "GitHub was blocked and was not asked for anything").toEqual([]);
});
