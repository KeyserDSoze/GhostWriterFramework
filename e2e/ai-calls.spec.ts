import { expect, test, type Page } from "@playwright/test";
import { KEY, bookFiles, openApp, seed, settingsOf, startAutopilot, startProvider, waitForAiSettings, waitForAutopilot, type StubProvider } from "./helpers/autopilot";

// A book of this browser runs one step against a fake AI provider: the browser's AI call store (IndexedDB `narrarium-ai-calls`) holds what was sent and what came back, the step opens
// with its messages from #task-<id> and survives a reload, no record keeps the key of the integration, and with the recording turned off for the book on this device nothing is kept
// and the page says so. The provider answers whole (`streamMode: "off"`) to keep the checks short; the streaming view and the records of a personal server are not part of this suite.
//
// Deterministic on purpose: the run starts once the account's settings have the integration's endpoint (before, its first request would go to the
// real OpenAI and the run would end in an authentication error), the pause is asked while the first step is answering (each answer takes 600 ms),
// and a run that does not pause fails with what its state says (its status, its last error, its steps).

test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });

const BOOK_ID = "book-calls";
const LOCAL_REPOSITORY_ID = "e2e-local-calls";
const IDEA = `A harbor town built on glass hides a lie that the tide will tell (the ledger key is ${KEY}).`;

let ai: StubProvider;

const book = async () => [{ id: BOOK_ID, repo: LOCAL_REPOSITORY_ID, name: "The Glass Harbor", files: await bookFiles(IDEA) }];

/** What the browser's AI call store holds: how many tasks, and every text (decompressed) with its field. */
const storeOf = (page: Page) => page.evaluate(async () => {
  const names = (await indexedDB.databases()).map((entry) => entry.name);
  if (!names.includes("narrarium-ai-calls")) return { database: false, tasks: 0, texts: [] as Array<{ field: string; text: string }> };
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("narrarium-ai-calls"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const all = (name: string) => new Promise<any[]>((resolve, reject) => { const request = db.transaction(name, "readonly").objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const [tasks, rows] = await Promise.all([all("tasks"), all("texts")]);
  const texts: Array<{ field: string; text: string }> = [];
  for (const row of rows) {
    const bytes = row.encoding === "plain" ? new Blob([row.data]).stream() : new Blob([row.data]).stream().pipeThrough(new DecompressionStream("gzip"));
    texts.push({ field: row.field, text: new TextDecoder().decode(await new Response(bytes).arrayBuffer()) });
  }
  db.close();
  return { database: true, tasks: tasks.filter((task) => task.listed === 1).length, texts };
});

/** Configures nothing but the first step: no readers, no specialists, no pause after the plan; starts the autopilot and pauses it after the step that runs. */
async function runOneStep(page: Page, openAi: string[]): Promise<void> {
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await startAutopilot(page, BOOK_ID);
  await waitForAutopilot(page, LOCAL_REPOSITORY_ID, ["running"]);
  // The runtime lives in the document: the page is left by the app's own links, not by a new document.
  const pause = page.getByRole("button", { name: /^Pause after this step/ }).first();
  if (!(await pause.isVisible().catch(() => false))) await page.getByRole("link", { name: "Live" }).first().click();
  await pause.click();
  await waitForAutopilot(page, LOCAL_REPOSITORY_ID, ["paused"]);
  expect(openAi, "no request went to the real OpenAI").toEqual([]);
}

/** The log of the steps of the book, as its local repository keeps it. */
const firstActivity = (page: Page) => page.evaluate(() => new Promise<string>((resolve) => {
  const open = indexedDB.open("narrarium-local-repositories");
  open.onsuccess = () => { const all = open.result.transaction("files", "readonly").objectStore("files").getAll(); all.onsuccess = () => resolve((all.result as Array<{ path: string; text: string }>).find((entry) => entry.path === "autopilot/activity.json")?.text ?? "{}"); };
})).then((text) => (JSON.parse(text) as { activities: Array<{ id: string }> }).activities[0]);

test.beforeAll(async () => { ai = await startProvider({ delayMs: 600 }); });
test.afterAll(async () => { await ai.close(); });

test("a step run in this browser is recorded in the browser's store and opens with its messages", async ({ page }) => {
  const books = await book();
  const { openAi } = await seed(page, settingsOf(ai.url, books), books);
  await openApp(page);
  await runOneStep(page, openAi);
  expect(ai.requests).toBeGreaterThan(0);

  const kept = await storeOf(page);
  expect(kept.tasks).toBeGreaterThanOrEqual(1);
  for (const field of ["system", "user", "response"]) expect(kept.texts.some((entry) => entry.field === field && entry.text.length > 20), field).toBe(true);
  expect(kept.texts.some((entry) => entry.text.includes(KEY)), "no record keeps the key of the integration").toBe(false);
  expect(kept.texts.some((entry) => entry.text.includes("[redacted]")), "the place the key was in says so").toBe(true);

  const activity = await firstActivity(page);
  await page.evaluate((id) => { window.location.hash = `#task-${id}`; }, activity.id);
  const view = page.locator("[data-task-calls]").first();
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect(view).toContainText("System");
  await expect(view).toContainText("Response");
  await page.reload({ waitUntil: "domcontentloaded" });
  expect((await storeOf(page)).tasks, "the records survive a reload").toBe(kept.tasks);
});

test("nothing is recorded while the recording of the book is off on this device, and the step says so", async ({ page }) => {
  const books = await book();
  const { openAi } = await seed(page, settingsOf(ai.url, books), books, { recordingOff: [BOOK_ID] });
  await openApp(page);
  await runOneStep(page, openAi);
  expect(await storeOf(page)).toMatchObject({ tasks: 0 });
  const activity = await firstActivity(page);
  await page.evaluate((id) => { window.location.hash = `#task-${id}`; }, activity.id);
  const view = page.locator("[data-task-calls]").first();
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect(view).toContainText("the recording is turned off");
  await expect(view).toContainText("No messages were recorded for this step");
});
