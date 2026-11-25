import { expect, test, type Page } from "@playwright/test";
import { autopilotFacts, bookFiles, openApp, seed, settingsOf, startAutopilot, startProvider, waitForAiSettings, waitForAutopilot, type StubProvider } from "./helpers/autopilot";

// A book of this browser runs against a fake AI provider whose model has a price: every call of the run is a row of the costs ledger in the account data of this
// device (IndexedDB `narrarium-local-account`), for the book's autopilot, its integration and its model, in the currency of the settings; the band says what the
// step that runs has spent so far and what the run cost, the same money the ledger holds; and a new currency of the costs, chosen in Settings › Costs, applies
// to the band of the same document (no reload of the page), where what was recorded in the old currency is never shown as the new one until the person says
// so (the relabel the band offers), which then shows at once.
//
// Deterministic on purpose: the fake provider reports 100 tokens in and 50 out for every answer, so each call costs the same; the texts of the step's cost are
// collected by an observer that is in the document from its start, so that none is missed between two reads.

test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });

const BOOK_ID = "book-costs";
const LOCAL_REPOSITORY_ID = "e2e-local-costs";
const IDEA = "A lighthouse keeper counts the ships that never come in, and one night one does.";
const PRICE = { inputPerMTok: 2, outputPerMTok: 8 };
/** What one answer of the fake provider costs at that price. */
const PER_CALL = (100 * PRICE.inputPerMTok + 50 * PRICE.outputPerMTok) / 1_000_000;
const TASK_COSTS_KEY = "narrarium-task-costs-v1";

/** An amount as the app writes it in English: up to four decimals below one unit. */
const money = (value: number, currency: string) => new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2 }).format(value);

let ai: StubProvider;

test.beforeAll(async () => { ai = await startProvider({ delayMs: 300 }); });
test.afterAll(async () => { await ai.close(); });

interface LedgerRow { period: string; bookId: string; source: string; capability: string; integrationId: string; model: string; currency: string; calls: number; tasks: number; inputTokens: number; outputTokens: number; cost: number }

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
          const [period, bookId, source, capability, integrationId, model, currency] = key.split("|").map((value) => decodeURIComponent(value));
          const [calls = 0, tasks = 0, inputTokens = 0, , outputTokens = 0, cost = 0] = String(counters).split(" ").map(Number);
          rows.push({ period, bookId, source, capability, integrationId, model, currency, calls, tasks, inputTokens, outputTokens, cost });
        }
      }
      resolveRows(rows);
    };
    get.onerror = () => { db.close(); resolveRows([]); };
  };
  open.onerror = () => resolveRows([]);
}));

/** What this browser kept of each step it ran: its calls and its money. */
const stepRecordsOf = (page: Page) => page.evaluate((key) => Object.values(JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, { task: string; calls: number; money: Record<string, number> }>), TASK_COSTS_KEY);

/** Every text the band showed of the cost of the step that runs, from the start of the document. */
async function recordStepCosts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { __stepCosts: Set<string> }).__stepCosts = seen;
    const scan = () => document.querySelectorAll("[data-band-step-cost]").forEach((element) => {
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) seen.add(text);
    });
    new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

const stepCosts = (page: Page) => page.evaluate(() => [...((window as unknown as { __stepCosts?: Set<string> }).__stepCosts ?? [])]);

test("a run of this browser writes its calls in the costs ledger, the band says what the step and the run cost, and a new currency applies without a reload", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await recordStepCosts(page);
  const books = [{ id: BOOK_ID, repo: LOCAL_REPOSITORY_ID, name: "The Lighthouse Ledger", files: await bookFiles(IDEA) }];
  const settings = settingsOf(ai.url, books);
  settings.aiIntegrations[0].chatModels[0] = { ...settings.aiIntegrations[0].chatModels[0], pricing: PRICE } as typeof settings.aiIntegrations[0]["chatModels"][0];
  const { openAi } = await seed(page, settings, books, { marker: "narrarium-e2e-costs-seeded-v1" });
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // The run: started from its configuration, it goes on until the band has said what a step spent while it ran; then it pauses after the step of the moment.
  await startAutopilot(page, BOOK_ID);
  await waitForAutopilot(page, LOCAL_REPOSITORY_ID, ["running"]);
  if (!(await page.locator("[data-autopilot-band]").first().isVisible().catch(() => false))) await page.getByRole("link", { name: "Live" }).first().click();
  await expect.poll(() => stepCosts(page), { timeout: 90_000, message: "the band said what the step that runs has spent so far" }).toContainEqual(expect.stringMatching(/^\(this step \$0\.\d{2,4} · \d+ calls?\)$/));
  await page.getByRole("button", { name: /^Pause after this step/ }).first().click();
  await waitForAutopilot(page, LOCAL_REPOSITORY_ID, ["paused", "completed"], 90_000);
  expect(openAi, "no request went to the real OpenAI").toEqual([]);
  const seenStep = (await stepCosts(page)).map((text) => /this step \$([\d.]+) · (\d+) call/.exec(text)).filter(Boolean) as RegExpExecArray[];
  for (const [, amount, calls] of seenStep) expect(Number(amount), "what a step spent so far is its calls at the price of the model").toBeCloseTo(Number(calls) * PER_CALL, 9);

  // The ledger: every call of the run, of the book's autopilot, on the integration and the model of the run, priced in the currency of the settings.
  const requests = ai.requests;
  await expect.poll(async () => (await ledgerOf(page)).reduce((sum, row) => sum + row.calls, 0), { timeout: 20_000, message: "every call of the run is in the ledger" }).toBe(requests);
  const rows = await ledgerOf(page);
  for (const row of rows) expect(row, "a row of the run").toMatchObject({ bookId: BOOK_ID, source: "autopilot", integrationId: "fake-ai", model: "fake-model", currency: "USD" });
  expect(rows.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.period)), "the rows of today are days").toBe(true);
  const spent = rows.reduce((sum, row) => sum + row.cost, 0);
  expect(spent).toBeCloseTo(requests * PER_CALL, 9);
  expect(rows.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(100 * requests);
  expect(rows.reduce((sum, row) => sum + row.tasks, 0), "the calls of a step are one task").toBeLessThan(requests + 1);
  const facts = await autopilotFacts(page, LOCAL_REPOSITORY_ID);
  expect(facts?.stats?.cost, "the engine's count and the ledger say the same").toBeCloseTo(spent, 9);

  // The band: the autopilot's total, what this run cost by this browser's record of its steps, and the book to date by the ledger.
  // The cost line is in the band, or under it where the page leaves the band narrow (its details): the same line either way.
  await page.goto(`app/books/${BOOK_ID}/autopilot`, { waitUntil: "domcontentloaded" });
  const usage = page.locator("[data-band-usage]").first();
  await expect(usage).toContainText(`Cost${money(spent, "USD")}`);
  const steps = await stepRecordsOf(page);
  const run = steps.reduce((sum, step) => sum + (step.money.USD ?? 0), 0);
  const runCalls = steps.reduce((sum, step) => sum + step.calls, 0);
  expect(runCalls, "every call of the run belongs to a step").toBe(requests);
  const bookCosts = page.locator("[data-band-book-costs]").first();
  await expect(bookCosts).toContainText(`This run${money(run, "USD")}${runCalls} calls`);
  await expect(bookCosts).toContainText(`Book to date${money(spent, "USD")}`);

  // A new currency, chosen in Settings › Costs: reached through the app, so that the document is the same one (a reload would forget the mark set here).
  await page.evaluate(() => { (window as unknown as { __sameDocument?: boolean }).__sameDocument = true; });
  await page.getByRole("button", { name: "EU", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.locator('a[href$="/app/settings/costs"]').first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Costs" })).toBeVisible();
  await page.getByRole("combobox", { name: "Currency of prices and costs" }).click();
  await page.getByRole("option", { name: /^EUR/ }).click();
  await expect(page.getByText("From now on, prices are read in EUR", { exact: false })).toBeVisible();
  const saveBar = page.getByLabel("Saving the settings");
  await saveBar.getByRole("button", { name: "Save" }).click();
  await expect(saveBar).toContainText("All changes saved");
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/app/books/${BOOK_ID}/autopilot$`));
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument), "the page was not reloaded").toBe(true);

  // What was recorded in USD stays USD (nothing is converted without a rate), and the band offers once to show it as EUR: accepted, it shows at once, marked.
  await expect(usage).toContainText(`Cost${money(spent, "USD")}`);
  const offer = page.locator("[data-relabel-suggestion]").first();
  await expect(offer).toContainText("recorded its costs in USD, but your prices are in EUR");
  await offer.getByRole("button", { name: "Show them as EUR" }).click();
  await expect(offer).toHaveCount(0);
  await expect(usage).toContainText(`Cost${money(spent, "EUR")} (relabelled)`);
  await expect(bookCosts).toContainText(`This run${money(run, "EUR")} (relabelled)`);
  await expect(bookCosts).toContainText(`Book to date${money(spent, "EUR")} (relabelled)`);
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument), "still the same document").toBe(true);

  // The relabel is kept with the settings of the account on this device, and the records were never rewritten.
  const after = await ledgerOf(page);
  expect(after.every((row) => row.currency === "USD"), "the ledger keeps what was recorded").toBe(true);
});
