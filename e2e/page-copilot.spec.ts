import { expect, test, type Page } from "@playwright/test";
import { engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, type SeedBook, type StubProvider } from "./helpers/autopilot";

// The page-aware Copilot on the Simulated readers page, on a book kept on this device with GitHub out of reach: the panel says it works on the page, the
// author asks for only historical readers of different kinds and the default readers turned off, reviews the list of every reader with its resulting state
// before anything is written, applies it (the page then shows exactly that), and undoes it (the page is as it was). The model calls tools: its turn is the
// forced function `copilot_turn`, and the three new readers come from one call, `reader_personas`.

test.use({ serviceWorkers: "block" });

const BOOK = { id: "book-readers", repo: "e2e-local-readers", name: "The Glass Harbor" };
const DEFAULTS = ["General Reader", "Emotional Reader", "Critical Reader", "Character Reader", "Plot Reader", "Style Reader", "Worldbuilding Reader", "Continuity Reader"];
const HISTORIANS = ["The Military Historian", "The Court Chronicler", "The Social Historian"];

const persona = (name: string, aspect: string) => ({ name, description: `${name}, a reader of historical fiction.`, profile: `${name} knows the period and reads for it.`, aspects: [aspect, "anachronisms"], preferredGenres: ["historical-fiction"], dislikedGenres: [], experienceLevel: "expert", severity: 7, audienceAge: "adult", interests: ["history"], appreciatedElements: [], frequentCriticisms: [], customPrompt: "" });

async function book(): Promise<SeedBook> {
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: BOOK.name }));
  return { ...BOOK, files: store.toObject() };
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

let ai: StubProvider;
test.beforeAll(async () => {
  ai = await startProvider({
    answers: {
      copilot_turn: () => ({ reply: "Here is the proposal: three historians of different kinds, and the default readers turned off.", calls: [{ tool: "propose_reader_changes", args: { create: { count: 3, brief: "historical readers of different kinds" }, disable: ["@builtin"] } }] }),
      reader_personas: () => ({ readers: [persona(HISTORIANS[0], "battles"), persona(HISTORIANS[1], "etiquette"), persona(HISTORIANS[2], "daily life")] }),
    },
  });
});
test.afterAll(async () => { await ai.close(); });

/** Closes the Copilot: Escape closes the topmost layer first (a toast that is still there), then the panel. */
async function closeCopilot(page: Page): Promise<void> {
  const panel = page.locator('[data-assistant-mode="copilot"]');
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

async function readerSwitch(page: Page, name: string) {
  return page.getByRole("switch", { name: new RegExp(`^${name}: `) });
}

test("on the Simulated readers page the Copilot proposes only historical readers and the defaults off, the author reviews and applies it, and undoes it", async ({ page }) => {
  const github = watchGitHub(page);
  const seeded = await book();
  const { openAi } = await seed(page, settingsOf(ai.url, [seeded]), [seeded]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  await page.goto(`app/books/${BOOK.id}/simulated-readers`, { waitUntil: "domcontentloaded" });
  await expect(await readerSwitch(page, "General Reader")).toBeVisible({ timeout: 30_000 });
  for (const name of DEFAULTS) await expect(await readerSwitch(page, name)).toHaveAttribute("aria-checked", "true");

  // The panel says which page it works on, and describes its composer with it.
  await page.getByRole("button", { name: "Copilot", exact: true }).click();
  const panel = page.locator('[data-assistant-mode="copilot"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-copilot-scope="readers"]')).toContainText("Working on: Simulated readers");
  const composer = panel.locator("textarea");
  await expect(composer).toHaveAccessibleDescription("Working on: Simulated readers. Requests are about this page first; everything else the Copilot can do stays available.");

  await composer.fill("Create only historical readers of different kinds and turn off all the default ones");
  await panel.getByRole("button", { name: "Send" }).click();

  // The review, before anything is written: every reader with its resulting state, what changes first.
  const review = panel.locator('[data-page-review="readers"]');
  await expect(review).toBeVisible({ timeout: 30_000 });
  await expect(review.getByRole("heading", { name: "Proposed changes to the simulated readers" })).toBeVisible();
  await expect(review.getByText(/3 created · 8 turned off · after it: 3 on of 31/)).toBeVisible();
  const table = review.getByRole("table");
  await expect(table.getByRole("rowheader")).toHaveCount(31);
  await expect(table.locator('tr[data-change="created"]')).toHaveCount(3);
  await expect(table.locator('tr[data-change="turned-off"]')).toHaveCount(8);
  await expect(table.locator('tr[data-change="created"] th')).toContainText(HISTORIANS);
  await expect(table.locator("tr", { has: page.getByRole("rowheader", { name: /^Critical Reader/ }) })).toContainText("On → becomes Off");
  expect((await filesUnder(page, BOOK.repo, "personas/")).map((file) => file.path), "nothing is written yet").toEqual([]);

  // Applied in one change of the book; the outcome is said, and the focus goes to it.
  await review.getByRole("button", { name: "Apply" }).click();
  await expect(review.getByRole("status")).toHaveText("Applied: 3 created · 8 turned off.", { timeout: 20_000 });
  await expect(review.getByRole("status")).toBeFocused();
  const personas = Object.fromEntries((await filesUnder(page, BOOK.repo, "personas/")).map((file) => [file.path, file.text]));
  expect(Object.keys(personas)).toHaveLength(11);
  expect(personas["personas/the-military-historian.md"]).toContain("reader_type: custom");
  expect(personas["personas/standard-critical.md"]).toMatch(/id: reader:standard\.critical[\s\S]*enabled: false[\s\S]*builtin: true/);

  // The page shows exactly that: the historians on, the defaults off.
  await closeCopilot(page);
  for (const name of HISTORIANS) await expect(await readerSwitch(page, name)).toHaveAttribute("aria-checked", "true", { timeout: 20_000 });
  for (const name of DEFAULTS) await expect(await readerSwitch(page, name)).toHaveAttribute("aria-checked", "false");

  // Undo puts the book back as it was.
  await page.getByRole("button", { name: "Copilot", exact: true }).click();
  await panel.locator('[data-page-review="readers"]').getByRole("button", { name: "Undo" }).click();
  await expect(panel.locator('[data-page-review="readers"]').getByRole("status")).toHaveText("Undone: everything is as it was before.", { timeout: 20_000 });
  expect((await filesUnder(page, BOOK.repo, "personas/")).map((file) => file.path)).toEqual([]);
  await closeCopilot(page);
  for (const name of DEFAULTS) await expect(await readerSwitch(page, name)).toHaveAttribute("aria-checked", "true", { timeout: 20_000 });
  for (const name of HISTORIANS) await expect(page.getByRole("switch", { name: new RegExp(`^${name}: `) })).toHaveCount(0);

  // One call for the turn of the Copilot and one for the three readers; nothing went to GitHub.
  expect(ai.asked).toEqual(["copilot_turn", "reader_personas"]);
  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});
