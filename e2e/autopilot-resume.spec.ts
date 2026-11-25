import { expect, test, type Page } from "@playwright/test";
import { autopilotFacts, bookFiles, filesUnder, openApp, seed, settingsOf, startAutopilot, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";

// The autopilot that runs in this browser survives a reload of the page (an update of the app, a browser opened again) without a click: the app
// resumes it by itself, says so, and the run goes on from what the book saved, so that it finishes with every step done once and every scene
// written once. The step that the reload cut off is not a failure anywhere: not in the book, not in what the page shows of the run. A run the
// author paused is never resumed, even when the page reloads before the step it finishes.

test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });

const GLASS = { id: "book-glass", repo: "e2e-local-glass", name: "The Glass Harbor" };
const INTENTS = "narrarium.autopilot.resume.v1";
const FEED = "narrarium-autopilot-feed-v1";

let ai: StubProvider;

async function library(): Promise<SeedBook[]> {
  return [{ ...GLASS, files: await bookFiles("A harbor town built on glass hides a lie that the tide will tell.", 1) }];
}

test.beforeAll(async () => { ai = await startProvider({ delayMs: 1500, chapters: 1, scenes: 2 }); });
test.afterAll(async () => { await ai.close(); });

async function startRun(page: Page): Promise<string[]> {
  const books = await library();
  const { openAi } = await seed(page, settingsOf(ai.url, books), books);
  // Leaving a page whose autopilot runs asks first: the reload of the spec is accepted, as the author would.
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await startAutopilot(page, GLASS.id);
  await waitForAutopilot(page, GLASS.repo, ["running"]);
  return openAi;
}

const intents = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{\"intents\":{}}").intents as Record<string, { bookId: string; step?: string }>, INTENTS);

/** The steps that did not succeed in what the page shows of the runs (the live feed, which a reload keeps). */
const failedInFeed = (page: Page) => page.evaluate((key) => (JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{ event?: { type?: string; activity?: { status?: string; title?: string } } }>)
  .filter((entry) => entry.event?.type === "task-finished" && entry.event.activity?.status !== "succeeded")
  .map((entry) => `${entry.event?.activity?.title}: ${entry.event?.activity?.status}`), FEED);

test("a run that the page reloads in the middle of a step resumes by itself, says so, and finishes with every step and every scene done once", async ({ page }) => {
  const openAi = await startRun(page);
  // In the middle of the third step: two answers are saved, the third request is on its way.
  await expect.poll(() => ai.requests, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  const before = await autopilotFacts(page, GLASS.repo);
  expect(before?.status).toBe("running");
  expect(Object.values(await intents(page)).map((intent) => intent.bookId)).toEqual([GLASS.id]);
  const askedBefore = ai.requests;

  await page.reload({ waitUntil: "domcontentloaded" });

  // The notice: the run was resumed, which book, and what it was doing.
  const notice = page.getByText("Autopilot resumed after the restart", { exact: true });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(new RegExp(`^«${GLASS.name}» goes on`))).toBeVisible();
  await expect.poll(() => ai.requests, { timeout: 30_000, message: "the resumed run asks the AI again" }).toBeGreaterThan(askedBefore);

  const after = await waitForAutopilot(page, GLASS.repo, ["completed"], 180_000);
  // Every step that was saved is in the log once, the one interrupted included (a step is saved whole or not at all).
  expect(after.steps.every((step) => step.endsWith(":succeeded")), after.steps.join(", ")).toBe(true);
  expect(new Set(after.done).size, after.done.join(", ")).toBe(after.done.length);
  for (const step of before?.done ?? []) expect(after.done.filter((done) => done === step), step).toHaveLength(1);
  // The scenes of the chapter are written once each: two scenes, two files, no text twice.
  const chapterFiles = (await filesUnder(page, GLASS.repo, "chapters/")).filter((file) => /^chapters\/[^/]+\/(?!chapter\.md$)[^/]+\.md$/.test(file.path));
  expect(chapterFiles.map((file) => file.path)).toHaveLength(2);
  for (const file of chapterFiles) {
    const body = file.text.replace(/^---[\s\S]*?---/, "").trim();
    const half = body.slice(0, Math.floor(body.length / 2));
    expect(half.length, file.path).toBeGreaterThan(40);
    expect(body.indexOf(half, 1), `${file.path} has no text twice`).toBe(-1);
  }
  // The step the reload cut off was not a failure in what the page shows either.
  expect(await failedInFeed(page)).toEqual([]);
  // The run is over: nothing is left to resume.
  expect(await intents(page)).toEqual({});
  expect(openAi, "no request went to the real OpenAI").toEqual([]);
});

test("a run the author paused is never resumed, even when the page reloads before the step it finishes", async ({ page }) => {
  const openAi = await startRun(page);
  const pause = page.getByRole("button", { name: /^Pause after this step/ }).first();
  if (!(await pause.isVisible().catch(() => false))) await page.getByRole("link", { name: "Live" }).first().click();
  await pause.click();
  expect(await intents(page)).toEqual({});

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("link", { name: "All books" }).first()).toBeVisible({ timeout: 30_000 });
  const asked = ai.requests;
  await page.waitForTimeout(5000);
  expect(ai.requests, "no request after the reload: the run was not resumed").toBe(asked);
  await expect(page.getByText("Autopilot resumed after the restart", { exact: true })).toHaveCount(0);
  expect(openAi).toEqual([]);
});
