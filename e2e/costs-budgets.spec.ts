import { expect, test, type Page } from "@playwright/test";
import { bookFiles, openApp, seed, settingsOf, startAutopilot, startProvider, waitForAiSettings, waitForAutopilot, type StubProvider } from "./helpers/autopilot";

// Budgets (spec point 5), with GitHub blocked and a fake AI provider whose model has a price: a small monthly budget of all the books is set from the dashboard; the run makes its
// calls; the top bar warns when the budget is at 80% (in words, and the call that goes on is held back so that the state can be looked at); the autopilot is then paused by the
// engine's own cap, before the next step, with the reason panel of the budget; one click raises the budget and the run goes on to the new cap; and «Continue anyway» goes on once
// past it. Deterministic on purpose: the fake provider reports 100 tokens in and 50 out for every answer, so each call costs the same.

test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });

const BOOK_ID = "book-budgets";
const LOCAL_REPOSITORY_ID = "e2e-local-budgets";
const BOOK_NAME = "The Lighthouse Budget";
const IDEA = "A lighthouse keeper counts the ships that never come in, and one night one does.";
const PRICE = { inputPerMTok: 2, outputPerMTok: 8 };
const PER_CALL = (100 * PRICE.inputPerMTok + 50 * PRICE.outputPerMTok) / 1_000_000;
/** About seventeen calls, and about twenty-seven for the raised one: the book (six chapters of two scenes, over thirty calls) is far from its end at either. */
const BUDGET = 0.01;
const RAISED = 0.016;

let ai: StubProvider;

/** The budgets of the settings of the account as this device's account store holds them. */
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

test.beforeAll(async () => { ai = await startProvider({ delayMs: 300, chapters: 6, scenes: 2 }); });
test.afterAll(async () => { await ai.close(); });

test("a budget warns at 80%, pauses the autopilot at 100% through the engine's own cap, and is raised with one click", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1500, height: 1000 });
  const github: string[] = [];
  await page.route(/^https:\/\/([a-z-]+\.)?github(usercontent)?\.com\//, (route) => { github.push(route.request().url()); return route.abort("blockedbyclient"); });
  const books = [{ id: BOOK_ID, repo: LOCAL_REPOSITORY_ID, name: BOOK_NAME, files: await bookFiles(IDEA, 6) }];
  const settings = settingsOf(ai.url, books);
  settings.aiIntegrations[0].chatModels[0] = { ...settings.aiIntegrations[0].chatModels[0], pricing: PRICE } as typeof settings.aiIntegrations[0]["chatModels"][0];
  const { openAi } = await seed(page, settings, books, { marker: "narrarium-e2e-budgets-seeded-v1" });
  await openApp(page);
  await page.goto("app/costs", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // The budget of all the books, from the dashboard: a small one per month.
  const budgets = page.locator("[data-budgets-panel]");
  await expect(budgets).toContainText("No budget set");
  await budgets.getByRole("button", { name: "Set a budget" }).click();
  await budgets.getByLabel("Per month (USD)").fill(String(BUDGET));
  await budgets.getByRole("button", { name: "Save the budget" }).click();
  await expect(budgets.getByRole("meter", { name: "Budget of All books" })).toHaveAttribute("aria-valuetext", "$0.00 of $0.01 per month (0%)");
  await expect(page.locator("[data-costs-budget]"), "nothing is spent: nothing to warn of").toHaveCount(0);
  await expect.poll(() => storedBudgets(page), { message: "the budget is in the settings of the account on this device" }).toEqual({ global: { USD: { month: BUDGET } } });

  // The run, from the configuration of the autopilot: its first step is already under the cap the budget leaves.
  await startAutopilot(page, BOOK_ID);
  await waitForAutopilot(page, LOCAL_REPOSITORY_ID, ["running"]);
  expect((await waitForAutopilot(page, LOCAL_REPOSITORY_ID, ["running", "paused"])).budgetLimit, "the budget is the cap of the engine: nothing was spent, so all of it is left").toBeCloseTo(BUDGET, 6);

  // At 80% the top bar says so, with a sign and in words; the call that goes on is held back so that the state can be looked at.
  const mark = page.locator("[data-costs-budget]");
  await expect.poll(async () => ((await mark.count()) ? await mark.first().getAttribute("data-costs-budget") : null), { timeout: 60_000, intervals: [50, 100], message: "the bar warned at 80%" }).toBe("warn");
  ai.delayMs = 8_000;
  await expect(mark).toContainText("Warning — All books, per month:");
  await expect(mark).toContainText("% of the budget used");
  const percent = Number(((await mark.textContent()) ?? "").match(/(\d+)%/)?.[1]);
  expect(percent, "at the share it warns at, and not yet over").toBeGreaterThanOrEqual(80);
  expect(percent).toBeLessThan(100);
  await expect(page.locator("[data-costs-indicator]")).toHaveAttribute("title", /Warning — All books, per month/);
  // Through the app, not a new document: a run of this browser ends with its page.
  await page.getByRole("link", { name: "Live" }).first().click();
  const notice = page.locator("[data-budget-book-notice]");
  await expect(notice).toContainText("Budget warning.");
  await expect(notice).toContainText("All books, per month:");
  await expect(page.locator("[data-limit-panel]"), "the autopilot was not stopped").toHaveCount(0);
  ai.delayMs = 300;

  // At 100% the engine pauses before its next step, at the cap the budget gave, with the reason panel of the budget.
  await waitForAutopilot(page, LOCAL_REPOSITORY_ID, ["paused"], 120_000);
  const stopped = (await waitForAutopilot(page, LOCAL_REPOSITORY_ID, ["paused"]));
  expect(stopped.limitReached, "the engine's own money cap stopped it").toMatchObject({ kind: "money", limit: BUDGET });
  expect(stopped.budgetLimit).toBeCloseTo(BUDGET, 6);
  expect(stopped.stats!.cost, "it stopped at the cap").toBeGreaterThanOrEqual(BUDGET);
  expect(stopped.stats!.cost, "before the next step, not a whole book past it").toBeLessThan(BUDGET + 8 * PER_CALL);
  const panel = page.locator('[data-limit-panel="budget"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel).toContainText("The budget stopped the autopilot");
  await expect(panel).toContainText("All books, per month:");
  await expect(page.locator('[data-costs-budget="over"]')).toContainText("Over budget — All books, per month:");
  const callsAtStop = ai.requests;

  // One click raises the budget and starts the autopilot again, with the cap that is left of the new budget.
  await panel.getByLabel("New monthly limit (USD)").fill(String(RAISED));
  await panel.getByRole("button", { name: /^Raise the budget to .* and continue$/ }).click();
  await expect.poll(() => ai.requests, { timeout: 30_000, message: "the autopilot went on" }).toBeGreaterThan(callsAtStop);
  const second = await (async () => {
    for (let at = 0; at < 600; at += 1) {
      const facts = await waitForAutopilot(page, LOCAL_REPOSITORY_ID, ["running", "paused", "completed"]);
      if (facts.status !== "running" && facts.stats!.cost > stopped.stats!.cost) return facts;
      await page.waitForTimeout(200);
    }
    throw new Error("the autopilot never stopped at the raised budget");
  })();
  expect(second.limitReached, "stopped again, at the raised budget").toMatchObject({ kind: "money" });
  expect(second.limitReached!.limit, "the cap is what the raised budget leaves, added to what the book had spent: the new budget, as nothing else was spent").toBeCloseTo(RAISED, 5);
  expect(second.stats!.cost).toBeGreaterThanOrEqual(RAISED);

  // The dashboard says the same: the budget, over, with one click to raise it.
  await page.locator("[data-costs-indicator]").click();
  const notices = page.locator("[data-budgets-panel] [data-budget-notice]");
  await expect(notices).toContainText("Over budget. All books, per month:");
  await expect(budgets.getByRole("meter", { name: "Budget of All books" })).toHaveAttribute("aria-valuetext", /of \$0\.016 per month \(\d+%\) — Over budget$/);

  // «Continue anyway» goes on once, past the budget, and the next start counts it again.
  await page.locator(`[data-costs-row="${BOOK_ID}"]`).getByRole("button", { name: new RegExp(`${BOOK_NAME} — settings`) }).click();
  await page.locator("[data-book-settings]").getByRole("link", { name: "Open the autopilot" }).click();
  const secondPanel = page.locator('[data-limit-panel="budget"]');
  await expect(secondPanel).toBeVisible({ timeout: 20_000 });
  const before = ai.requests;
  await secondPanel.getByRole("button", { name: "Continue anyway" }).click();
  await expect.poll(() => ai.requests, { timeout: 30_000, message: "the autopilot went on past the budget" }).toBeGreaterThan(before + 2);
  const pause = page.getByRole("button", { name: /^Pause after this step/ }).first();
  await expect(pause).toBeVisible({ timeout: 60_000 });
  await pause.click();
  const after = await waitForAutopilot(page, LOCAL_REPOSITORY_ID, ["paused", "completed"], 90_000);
  expect(after.stats!.cost, "it spent past the raised budget").toBeGreaterThan(second.stats!.cost);

  expect(openAi, "no request went to the real OpenAI").toEqual([]);
  expect(github, "GitHub was blocked and was not asked for anything").toEqual([]);
});
