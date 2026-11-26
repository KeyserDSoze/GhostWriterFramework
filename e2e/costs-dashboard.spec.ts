import { expect, test, type Page } from "@playwright/test";
import { bookFiles, openApp, seed, settingsOf, startAutopilot, startProvider, waitForAiSettings, waitForAutopilot, type StubProvider } from "./helpers/autopilot";

// A run of this browser against a fake AI provider whose model has a price: before anything is spent the top bar shows no spend; once the run has made its
// calls the bar shows what was spent today and this month (a link to the dashboard), loaded after the page was drawn; and the dashboard of the costs says the same
// money as the ledger of the account data on this device: a row for the book with its spend, tasks, calls and tokens, the totals always in sight, the filters,
// the settings of the book at a glance and the rows as a CSV.
//
// Deterministic on purpose: the fake provider reports 100 tokens in and 50 out for every answer, so each call costs the same.

test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });

const BOOK_ID = "book-dashboard";
const LOCAL_REPOSITORY_ID = "e2e-local-dashboard";
const BOOK_NAME = "The Lighthouse Dashboard";
const IDEA = "A lighthouse keeper counts the ships that never come in, and one night one does.";
const PRICE = { inputPerMTok: 2, outputPerMTok: 8 };
const PER_CALL = (100 * PRICE.inputPerMTok + 50 * PRICE.outputPerMTok) / 1_000_000;

const money = (value: number, currency: string) => new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2 }).format(value);

let ai: StubProvider;

test.beforeAll(async () => { ai = await startProvider({ delayMs: 300 }); });
test.afterAll(async () => { await ai.close(); });

interface LedgerRow { source: string; capability: string; currency: string; calls: number; tasks: number; inputTokens: number; outputTokens: number; cost: number }

/** The rows of the costs ledger of the account data on this device, every writer's, decoded. */
const ledgerOf = (page: Page) => page.evaluate(() => new Promise<LedgerRow[]>((resolveRows) => {
  const open = indexedDB.open("narrarium-local-account");
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("core")) { db.close(); resolveRows([]); return; }
    const get = db.transaction("core", "readonly").objectStore("core").get("current");
    get.onsuccess = () => {
      db.close();
      const writers = (get.result?.costs?.ledger?.writers ?? {}) as Record<string, { rows?: Record<string, string> }>;
      const rows: LedgerRow[] = [];
      for (const part of Object.values(writers)) {
        for (const [key, counters] of Object.entries(part.rows ?? {})) {
          const [, , source, capability, , , currency] = key.split("|").map((value) => decodeURIComponent(value));
          const [calls = 0, tasks = 0, inputTokens = 0, , outputTokens = 0, cost = 0] = String(counters).split(" ").map(Number);
          rows.push({ source, capability, currency, calls, tasks, inputTokens, outputTokens, cost });
        }
      }
      resolveRows(rows);
    };
    get.onerror = () => { db.close(); resolveRows([]); };
  };
  open.onerror = () => resolveRows([]);
}));

test("the spend of a run is in the top bar, loaded after the first paint, and in the dashboard of the costs", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1500, height: 1000 });
  const books = [{ id: BOOK_ID, repo: LOCAL_REPOSITORY_ID, name: BOOK_NAME, files: await bookFiles(IDEA) }];
  const settings = settingsOf(ai.url, books);
  settings.aiIntegrations[0].chatModels[0] = { ...settings.aiIntegrations[0].chatModels[0], pricing: PRICE } as typeof settings.aiIntegrations[0]["chatModels"][0];
  const { openAi } = await seed(page, settings, books, { marker: "narrarium-e2e-dashboard-seeded-v1" });
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // Nothing was spent: the bar has no spend, and the page no placeholder for it.
  await expect(page.locator("header")).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator("[data-costs-indicator]"), "no spend, no indicator").toHaveCount(0);

  // The run makes its calls, then pauses after the step that runs.
  await startAutopilot(page, BOOK_ID);
  await waitForAutopilot(page, LOCAL_REPOSITORY_ID, ["running"]);
  if (!(await page.locator("[data-autopilot-band]").first().isVisible().catch(() => false))) await page.getByRole("link", { name: "Live" }).first().click();
  const pause = page.getByRole("button", { name: /^Pause after this step/ }).first();
  await expect(pause).toBeVisible({ timeout: 60_000 });
  await pause.click();
  await waitForAutopilot(page, LOCAL_REPOSITORY_ID, ["paused", "completed"], 90_000);
  expect(openAi, "no request went to the real OpenAI").toEqual([]);
  const requests = ai.requests;
  await expect.poll(async () => (await ledgerOf(page)).reduce((sum, row) => sum + row.calls, 0), { timeout: 20_000, message: "every call of the run is in the ledger" }).toBe(requests);
  const rows = await ledgerOf(page);
  const spent = rows.reduce((sum, row) => sum + row.cost, 0);
  const tokens = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  const tasks = rows.reduce((sum, row) => sum + row.tasks, 0);
  expect(spent).toBeCloseTo(requests * PER_CALL, 9);

  // The bar now says what was spent, today and this month, and leads to the dashboard.
  const indicator = page.locator("[data-costs-indicator]");
  await expect(indicator).toBeVisible({ timeout: 20_000 });
  await expect(indicator.locator("[data-costs-month]")).toHaveText(money(spent, "USD"));
  await expect(indicator).toHaveAttribute("href", /\/app\/costs$/);

  // The dashboard: reached through the app (the same document), the totals and the row of the book say the same money as the ledger.
  await page.evaluate(() => { (window as unknown as { __sameDocument?: boolean }).__sameDocument = true; });
  await indicator.click();
  await expect(page.getByRole("heading", { level: 1, name: "Costs" })).toBeVisible();
  const totals = page.locator("[data-costs-totals]");
  await expect(totals).toContainText(`Spend${money(spent, "USD")}`);
  await expect(totals).toContainText(`Calls${requests}`);
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  const row = table.locator(`[data-costs-row="${BOOK_ID}"]`);
  await expect(row).toContainText(BOOK_NAME);
  await expect(row.getByRole("cell").nth(0)).toContainText(money(spent, "USD"));
  await expect(row.getByRole("cell").nth(1)).toHaveText(String(tasks));
  await expect(row.getByRole("cell").nth(2)).toHaveText(String(requests));
  await expect(row.getByRole("img", { name: /^Spend of the last six months:/ })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Spend" })).toHaveAttribute("aria-sort", "descending");
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument), "the page was not reloaded").toBe(true);

  // The settings of the book at a glance, and its budget (none: it is set in the autopilot).
  await row.getByRole("button", { name: new RegExp(`${BOOK_NAME} — settings`) }).click();
  const glance = page.locator("[data-book-settings]");
  await expect(glance).toContainText("Runs in");
  await expect(glance).toContainText("this browser");
  await expect(glance).toContainText("Only on this device");
  await expect(glance).toContainText("fake-model (Fake AI)");
  await expect(glance).toContainText(/Autopilot\s*(paused|completed)/);
  await expect(glance).toContainText("No budget");

  // The filters: by use, by task, and a filter that keeps nothing.
  const use = page.getByLabel("Use", { exact: true });
  await expect(use.locator("option")).toHaveText(["All", "Autopilot"]);
  await use.selectOption("autopilot");
  await expect(totals).toContainText(`Spend${money(spent, "USD")}`);
  const capabilities = [...new Set(rows.map((entry) => entry.capability))].sort();
  const task = page.getByLabel("Task", { exact: true });
  expect(capabilities.length, "the run asked for at least one task").toBeGreaterThan(0);
  await expect(task.locator("option")).toHaveCount(capabilities.length + 1);
  await task.selectOption(capabilities[0]);
  const callsOfTask = rows.filter((entry) => entry.capability === capabilities[0]).reduce((sum, entry) => sum + entry.calls, 0);
  await expect(totals).toContainText(`Calls${callsOfTask}`);
  await task.selectOption("");
  await use.selectOption("");
  await page.getByLabel("Model").selectOption("fake-model");
  await expect(totals).toContainText(`Calls${requests}`);
  await page.getByRole("button", { name: /Clear the filters/ }).click();

  // The rows by month and by use.
  await page.getByRole("radio", { name: "Uses" }).check({ force: true });
  await expect(table.locator('[data-costs-row="autopilot"]')).toContainText("Autopilot");
  await page.getByRole("radio", { name: "Months" }).check({ force: true });
  await expect(page.getByRole("columnheader", { name: "Month" })).toBeVisible();
  await page.getByRole("radio", { name: "Books" }).check({ force: true });

  // The CSV: the rows the filters keep, as recorded, in the currency they were priced in.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^narrarium-costs-\d{4}-\d{2}-\d{2}\.csv$/);
  const stream = await download.createReadStream();
  let csv = "";
  for await (const chunk of stream) csv += chunk.toString("utf8");
  const lines = csv.split("\r\n").filter(Boolean);
  expect(lines[0]).toMatch(/^period,book,source,capability,integration,model,currency,calls,tasks,/);
  expect(lines.length - 1, "one line for each row of the ledger").toBe(rows.length);
  expect(lines.slice(1).every((line) => line.includes(`,${BOOK_NAME},autopilot,`) && line.includes(",Fake AI,fake-model,USD,")), "the book, the integration and the currency as the person reads them").toBe(true);
  const csvCost = lines.slice(1).reduce((sum, line) => sum + Number(line.split(",")[12]), 0);
  expect(csvCost).toBeCloseTo(spent, 9);
  expect(tokens).toBe(100 * requests + 50 * requests);

  // A new document with the spend already there: the code of the indicator is asked for after the first paint, the dashboard is not loaded for the bar, and
  // when the pill comes nothing of the bar moves (the browser's own layout-shift entries say which elements of the header moved).
  await page.addInitScript(() => {
    const moved: string[] = [];
    (window as unknown as { __headerShifts: string[] }).__headerShifts = moved;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as Array<{ hadRecentInput: boolean; sources?: Array<{ node: Element | null }> }>) {
        if (entry.hadRecentInput) continue;
        for (const source of entry.sources ?? []) {
          const node = source.node;
          // The group of the controls is right-aligned: it grows to the left when the pill comes (and when anything else of the bar does), so its own edge
          // moves; what matters is that none of the controls in it, or before it, does.
          if (node && node.closest("header") && !node.hasAttribute("data-costs-indicator") && !node.querySelector("[data-costs-indicator]")) moved.push((node.getAttribute("aria-label") ?? node.textContent ?? node.tagName).trim().slice(0, 40));
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-costs-indicator]")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as { __headerShifts: string[] }).__headerShifts), "no control of the top bar moved when the pill came: it grows to the left of the others").toEqual([]);
  await expect(page.getByRole("button", { name: "EU", exact: true }), "the account menu is still at the right of the bar").toBeVisible();
  const timing = await page.evaluate(() => {
    const paint = performance.getEntriesByType("paint").find((entry) => entry.name === "first-contentful-paint");
    const chunk = performance.getEntriesByType("resource").find((entry) => /\/assets\/CostsIndicator-[^/]+\.js/.test(entry.name));
    const dashboard = performance.getEntriesByType("resource").find((entry) => /\/assets\/CostsPage-[^/]+\.js/.test(entry.name));
    return { paint: paint?.startTime ?? null, chunk: chunk?.startTime ?? null, dashboard: dashboard ? dashboard.startTime : null };
  });
  expect(timing.chunk, "the chunk of the indicator was asked for").not.toBeNull();
  expect(timing.paint, "the page painted").not.toBeNull();
  expect(timing.chunk!, "after the first paint").toBeGreaterThan(timing.paint!);
  expect(timing.dashboard, "the dashboard is not loaded for the bar").toBeNull();
});
