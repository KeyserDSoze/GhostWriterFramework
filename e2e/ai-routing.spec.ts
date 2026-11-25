import { expect, test, type Page } from "@playwright/test";
import { KEY, bookFiles, openApp, routedSettingsOf, seed, startAutopilot, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubBehavior, type StubCall, type StubProvider } from "./helpers/autopilot";

// Which provider a browser run asks, and what the page says when it did not ask the one the router names first. Two stub providers (A, B) share one timeline, in the order the requests
// arrive, so that a spec reads who was asked and when. The router names A first and B as its fallback, for every task, and the specs change that the way a person does: through the
// Router's «Swap with…» and its bulk editor, in this tab and in another one, saved or not, with the page reloaded in the middle of the run, and with the primary that fails or is left out.
//
// What the router says has to be what runs: a change applies to the very next call of the run of this tab, and, once saved, to the run of any tab and to the run that resumes after a reload.
// When the primary is not the one that answered, the page says so: every attempt of a failed step in the order it was made, with the integration, the model, how it ended and how long it
// took, and every candidate that the plan left out, with the reason. And while a step runs, the band, the live panel and the card of the step say which candidate its call asks now (the
// primary, or the fallback it went on to, with the thinking and the request it is), as soon as the request is sent and before the provider answers.

test.use({ serviceWorkers: "block" });

const BOOK = { id: "book-routing", repo: "e2e-local-routing", name: "The Glass Harbor" };
const FIRST = { id: "ai-a", name: "Fake A", model: "model-a" };
const SECOND = { id: "ai-b", name: "Fake B", model: "model-b" };
const IDEA = `A harbor town built on glass hides a lie that the tide will tell (the ledger key is ${KEY}).`;

interface Providers {
  a?: StubBehavior;
  b?: StubBehavior;
  /** Milliseconds every answer of a provider that answers takes: the time a step takes. */
  delayMs?: number;
  /** The context window of the model of A, in tokens. */
  windowA?: number;
  /** The routing time a fallback has. */
  maxTotalDurationMs?: number;
  /** The thinking level of the integration of A and of B: absent, none is chosen. */
  thinkingA?: string;
  thinkingB?: string;
}

interface Run {
  a: StubProvider;
  b: StubProvider;
  /** Every request of both providers, in the order they arrived. */
  timeline: StubCall[];
  openAi: string[];
}

const open: StubProvider[] = [];
test.afterEach(async () => { await Promise.all(open.splice(0).map((provider) => provider.close())); });

/** The providers who asked, in order, one letter each: `AAB` is two requests to A and then one to B. */
const order = (run: Run) => run.timeline.map((call) => call.provider).join("");

/** The book of this browser with a router that names A and then B, and its autopilot started from its configuration. The run is the page's: it is left only by the app's own links. */
async function begin(page: Page, options: Providers = {}): Promise<Run> {
  const timeline: StubCall[] = [];
  const delayMs = options.delayMs ?? 0;
  const a = await startProvider({ name: "A", timeline, delayMs, ...(options.a ? { behavior: options.a } : {}) });
  const b = await startProvider({ name: "B", timeline, delayMs, ...(options.b ? { behavior: options.b } : {}) });
  open.push(a, b);
  const books: SeedBook[] = [{ ...BOOK, files: await bookFiles(IDEA) }];
  const settings = routedSettingsOf({ ...FIRST, url: a.url, window: options.windowA, thinking: options.thinkingA }, { ...SECOND, url: b.url, thinking: options.thinkingB }, books, { maxTotalDurationMs: options.maxTotalDurationMs });
  // The context seeds every page of the spec: the run's tab and the second tab of the specs that open one.
  const { openAi } = await seed(page.context(), settings, books);
  // Leaving a page whose autopilot runs asks first: the reload of the spec is accepted, as the author would.
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, a.url);
  await startAutopilot(page, BOOK.id);
  return { a, b, timeline, openAi };
}

/** From the autopilot page to the AI Router by the app's own links (the runtime lives in the document, so the page is never loaded again). */
async function openRouter(page: Page): Promise<void> {
  await page.getByRole("button", { name: "EU", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "AI Router" }).first().click();
  await expect(page.getByRole("button", { name: "Swap with… for Text (chat)" })).toBeVisible();
}

/** «Swap with Fallback 1» for every text task, the way the Router offers it. */
async function swap(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Swap with… for Text (chat)" }).click();
  await page.getByRole("menuitem", { name: "Swap with Fallback 1" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Swapped \d+ rows between Primary and Fallback 1\./ })).toBeVisible();
}

/** The bulk editor: every task of the Primary tab goes to the endpoint of B. */
async function editPrimary(page: Page): Promise<void> {
  await page.getByLabel("Select all visible tasks").check();
  await page.getByLabel("1. Endpoint of the selected tasks").click();
  await page.getByRole("option", { name: SECOND.name }).click();
  await page.getByRole("button", { name: /^Apply to \d+ tasks$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /Changes applied to \d+ tasks\./ })).toBeVisible();
}

async function save(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
}

/** The integration the account's saved settings name as the primary of the autopilot: what a page loaded from the device now would run with. */
const savedPrimary = (page: Page) => page.evaluate(() => new Promise<string | null>((resolve) => {
  const request = indexedDB.open("narrarium-local-account");
  request.onsuccess = () => {
    const db = request.result;
    const read = db.transaction("core", "readonly").objectStore("core").getAll();
    read.onsuccess = () => { db.close(); resolve((read.result[0]?.settings?.taskRouting?.autopilot?.primary?.integrationId as string | undefined) ?? null); };
    read.onerror = () => { db.close(); resolve(null); };
  };
  request.onerror = () => resolve(null);
}));

/** The first step of the book's log: the id its task view is opened with. */
const firstActivity = (page: Page) => page.evaluate(() => new Promise<{ id: string }>((resolve) => {
  const request = indexedDB.open("narrarium-local-repositories");
  request.onsuccess = () => {
    const all = request.result.transaction("files", "readonly").objectStore("files").getAll();
    all.onsuccess = () => resolve(JSON.parse((all.result as Array<{ path: string; text: string }>).find((entry) => entry.path === "autopilot/activity.json")?.text ?? "{\"activities\":[{}]}").activities[0]);
  };
}));

test("the primary of the router is the one asked, and the fallback is not asked while the primary answers", async ({ page }) => {
  const run = await begin(page, { delayMs: 200 });
  await expect.poll(() => run.timeline.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  expect(order(run)).toMatch(/^A+$/);
  expect(run.openAi, "no request went to the real OpenAI").toEqual([]);
});

test("«Swap with…» in the tab of the run decides the very next call, and the router says where an unsaved change applies", async ({ page }) => {
  const run = await begin(page, { delayMs: 1500 });
  await expect.poll(() => run.timeline.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  expect(order(run)).toMatch(/^A+$/);

  await openRouter(page);
  // While an autopilot runs in this tab, the router says what a change does and where: now in this tab, and after a save everywhere.
  const note = page.locator("[data-router-run-note]");
  await expect(note).toBeVisible();
  await expect(note).toContainText("next call");
  await expect(note).toContainText("Save");
  await swap(page);
  await expect.poll(() => order(run), { timeout: 30_000, message: "the run asks B after the swap" }).toMatch(/B/);
  // A request that was already on its way answers from A; after that, only B.
  expect(order(run)).toMatch(/^A+B+$/);
  expect(await savedPrimary(page), "the swap was not saved: the device still has A").toBe(FIRST.id);
});

test("the bulk editor of the Primary tab decides the very next call as well", async ({ page }) => {
  const run = await begin(page, { delayMs: 1500 });
  await expect.poll(() => run.timeline.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await openRouter(page);
  await editPrimary(page);
  await expect.poll(() => order(run), { timeout: 30_000, message: "the run asks B after the edit" }).toMatch(/B/);
  expect(order(run)).toMatch(/^A+B+$/);
});

test("a swap that was saved survives the reload of the page: the run that resumes asks B first", async ({ page }) => {
  const run = await begin(page, { delayMs: 1500 });
  await expect.poll(() => run.timeline.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await openRouter(page);
  await swap(page);
  await save(page);
  expect(await savedPrimary(page)).toBe(SECOND.id);
  await expect.poll(() => order(run), { timeout: 30_000 }).toMatch(/B/);

  const before = run.timeline.length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Autopilot resumed after the restart", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => run.timeline.length, { timeout: 30_000, message: "the resumed run asks the AI again" }).toBeGreaterThan(before);
  // The page that ended did not ask A either: the request it had in flight was cut, and a page that ends sends nothing to its fallback.
  expect(order(run), "after the reload only B is asked, by the page that ended and by the one that resumes").toMatch(/^A+B+$/);
});

test("a swap saved in another tab of the same browser decides the next call of the run of the first tab", async ({ page }) => {
  const run = await begin(page, { delayMs: 1500 });
  await expect.poll(() => run.timeline.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  expect(order(run)).toMatch(/^A+$/);

  const second = await page.context().newPage();
  second.on("dialog", (dialog) => { void dialog.accept(); });
  await second.goto("app/settings/ai-router", { waitUntil: "domcontentloaded" });
  await swap(second);
  await save(second);
  expect(await savedPrimary(second), "the other tab saved the swap on the device").toBe(SECOND.id);

  await expect.poll(() => order(run), { timeout: 15_000, message: "the run of the first tab asks B after the other tab saved the swap" }).toMatch(/B/);
  expect(order(run)).toMatch(/^A+B+$/);
});

test("a step that failed says every attempt in the order it was made: the primary that failed at once, then the fallback that ran out of time", async ({ page }) => {
  const run = await begin(page, {
    a: { kind: "error", status: 404, message: "The model `model-a` does not exist or you do not have access to it." },
    b: { kind: "slow", ms: 30_000 },
    maxTotalDurationMs: 3000,
  });
  const panel = page.locator("[data-autopilot-error][data-kind=\"timeout\"]");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  expect(order(run).startsWith("AB"), "the primary is asked first, then the fallback").toBe(true);

  const attempts = panel.locator("[data-error-route] li");
  await expect(attempts).toHaveCount(2);
  await expect(attempts.nth(0)).toContainText(FIRST.name);
  await expect(attempts.nth(0)).toContainText(FIRST.model);
  await expect(attempts.nth(0)).toContainText("HTTP 404");
  await expect(attempts.nth(1)).toContainText(SECOND.name);
  await expect(attempts.nth(1)).toContainText(SECOND.model);
  await expect(attempts.nth(1)).toContainText("timed out");
  // The 3 s of the second attempt are what was left of the routing time, which is the author's («Total routing time»): the page says where it is changed, not that it cannot be.
  const limit = panel.locator("[data-error-timeout]");
  await expect(limit).toContainText("Total routing time");
  await expect(limit).not.toContainText("cannot be changed");

  // The records of the step say the same, with the names of the integrations.
  const activity = await firstActivity(page);
  await page.evaluate((id) => { window.location.hash = `#task-${id}`; }, activity.id);
  const failed = page.locator("[data-task-calls] [data-failed-attempts] li");
  await expect(failed).toHaveCount(2, { timeout: 30_000 });
  await expect(failed.nth(0)).toContainText(FIRST.name);
  await expect(failed.nth(1)).toContainText(SECOND.name);
});

test("a candidate that the plan leaves out is said with its reason, in the records of the step that went to the next one", async ({ page }) => {
  // The window of A (1,000 tokens) cannot hold the prompt of any step: B answers, and nothing was sent to A.
  const run = await begin(page, { windowA: 1000, delayMs: 300 });
  await expect.poll(() => run.timeline.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  expect(order(run)).toMatch(/^B+$/);

  const activity = await firstActivity(page);
  await page.evaluate((id) => { window.location.hash = `#task-${id}`; }, activity.id);
  const view = page.locator("[data-task-calls]").first();
  await expect(view).toBeVisible({ timeout: 30_000 });
  const left = view.locator("[data-left-out] li");
  await expect(left).toHaveCount(1);
  await expect(left.first()).toContainText(FIRST.name);
  await expect(left.first()).toContainText(FIRST.model);
  await expect(left.first()).toContainText("context window");
  await expect(view).toContainText(`${SECOND.model} (${SECOND.name})`);
});

/** The line of the band that says which candidate the step asks now. */
const bandLine = (page: Page) => page.locator("[data-autopilot-band] [data-band-attempt]");

test("the band says the primary first, with its integration and its thinking, before its answer has come", async ({ page }) => {
  // A page with room for the whole band (the cost line and the history beside the step): the line is beside the cost.
  await page.setViewportSize({ width: 1700, height: 1000 });
  // A answers after eight seconds: the request is on its way for the whole of the check.
  const run = await begin(page, { delayMs: 8000, thinkingA: "high" });
  await expect.poll(() => run.timeline.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  const line = bandLine(page);
  await expect(line).toBeVisible({ timeout: 4000 });
  await expect(line.locator("[data-attempt-badge]")).toHaveText("Primary");
  await expect(line.locator("[data-attempt-model]")).toHaveText(FIRST.model);
  await expect(line.locator("[data-attempt-integration]")).toHaveText(FIRST.name);
  await expect(line.locator("[data-attempt-thinking]")).toHaveText("Thinking: High");
  await expect(line.locator("[data-attempt-count]")).toHaveCount(0);
  await expect(line).not.toHaveAttribute("data-attempt-fallback");
  expect(order(run), "the line was there before the provider answered: only the primary was asked").toBe("A");
  // It sits right before the cost line, and the card of the step in the history says it too.
  await expect(page.locator("[data-autopilot-band] [data-band-attempt] + [data-band-usage]")).toBeVisible();
  await expect(page.locator("[data-timeline-live] [data-band-attempt]")).toContainText(FIRST.model);
});

test("when the primary fails the band says the fallback at once: its model, its integration, its thinking and the request it is, while it is still answering", async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 1000 });
  const run = await begin(page, {
    a: { kind: "error", status: 404, message: "The model `model-a` does not exist or you do not have access to it." },
    b: { kind: "slow", ms: 20_000 },
    thinkingA: "high",
  });
  const line = bandLine(page);
  await expect(line.locator("[data-attempt-badge]")).toHaveText("Fallback 1", { timeout: 30_000 });
  await expect(line.locator("[data-attempt-model]")).toHaveText(SECOND.model);
  await expect(line.locator("[data-attempt-integration]")).toHaveText(SECOND.name);
  // The fallback has no level chosen: nothing is sent, and the line says so instead of the primary's.
  await expect(line.locator("[data-attempt-thinking]")).toHaveText("Thinking: automatic");
  await expect(line.locator("[data-attempt-count]")).toHaveText("attempt 2/2");
  await expect(line).toHaveAttribute("data-attempt-fallback");
  // The words and the arrow say it, not the colour alone.
  await expect(line.locator("[data-attempt-badge] svg")).toHaveCount(1);
  expect(order(run), "the primary was asked first and failed, then the fallback, which has not answered").toMatch(/^AB$/);
  await expect(page.locator("[data-timeline-live] [data-band-attempt]")).toContainText("Fallback 1");
});

test("a page that is reloaded says the candidate of the run it resumes as soon as the request is sent, before the provider answers", async ({ page }) => {
  const run = await begin(page, {
    a: { kind: "error", status: 404, message: "The model `model-a` does not exist or you do not have access to it." },
    b: { kind: "slow", ms: 25_000 },
    thinkingA: "high",
  });
  const line = bandLine(page);
  await expect(line.locator("[data-attempt-badge]")).toHaveText("Fallback 1", { timeout: 30_000 });
  const before = run.timeline.length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Autopilot resumed after the restart", { exact: true })).toBeVisible({ timeout: 30_000 });
  // The page that resumes asks again: the primary, which fails at once, then the fallback, which is slow for another 25 seconds.
  await expect.poll(() => run.timeline.length, { timeout: 30_000, message: "the resumed run asks the AI again" }).toBeGreaterThan(before + 1);
  await expect(bandLine(page).locator("[data-attempt-badge]")).toHaveText("Fallback 1", { timeout: 5000 });
  await expect(bandLine(page).locator("[data-attempt-model]")).toHaveText(SECOND.model);
  await expect(bandLine(page).locator("[data-attempt-count]")).toHaveText("attempt 2/2");
});

test("a tab opened in the middle of the step says the candidate at once, whichever tab runs the book", async ({ page }) => {
  const run = await begin(page, {
    a: { kind: "error", status: 404, message: "The model `model-a` does not exist or you do not have access to it." },
    b: { kind: "slow", ms: 25_000 },
  });
  await expect(bandLine(page).locator("[data-attempt-badge]")).toHaveText("Fallback 1", { timeout: 30_000 });
  const before = run.timeline.length;

  // The run belongs to the first tab; the second opens now, while the fallback is still answering, and is told what the first one shows.
  const second = await page.context().newPage();
  second.on("dialog", (dialog) => { void dialog.accept(); });
  await second.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });
  await expect(bandLine(second).locator("[data-attempt-badge]")).toHaveText("Fallback 1", { timeout: 10_000 });
  await expect(bandLine(second).locator("[data-attempt-model]")).toHaveText(SECOND.model);
  await expect(bandLine(second).locator("[data-attempt-integration]")).toHaveText(SECOND.name);
  expect(run.timeline.length, "no new request was made for it: the second tab only asked the first").toBe(before);
});

test("after «Swap with…» the live panel says that the model the run asks now is the new primary", async ({ page }) => {
  const run = await begin(page, { delayMs: 1500, thinkingA: "high", thinkingB: "low" });
  await expect.poll(() => run.timeline.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await openRouter(page);
  await swap(page);
  await expect.poll(() => order(run), { timeout: 30_000, message: "the run asks B after the swap" }).toMatch(/B/);
  // On a page that is not the autopilot's the live panel has the card of the book: the primary is now B, with its own thinking.
  await page.getByRole("button", { name: /^Show what the autopilot is doing/ }).click();
  const card = page.locator("[data-dock-book] [data-band-attempt]");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator("[data-attempt-badge]")).toHaveText("Primary");
  await expect(card.locator("[data-attempt-model]")).toHaveText(SECOND.model);
  await expect(card.locator("[data-attempt-integration]")).toHaveText(SECOND.name);
  await expect(card.locator("[data-attempt-thinking]")).toHaveText("Thinking: Low");
});
