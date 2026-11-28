import { expect, test, type Page } from "@playwright/test";
import { engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, type SeedBook, type StubProvider } from "./helpers/autopilot";
import { overflowing } from "./helpers/review-view";

// The wildcards («Fuori dal coro») in a real browser, on a book kept on this device with GitHub out of reach and a stub provider: the page lists the fourteen
// built-in voices, turns one off in the book, keeps a wildcard of the author's own in the account, and the page-aware Copilot creates «a provocateur who
// thinks like a hacker» as one batch the author reviews and applies.

test.use({ serviceWorkers: "block" });

const BOOK = { id: "book-wildcards", repo: "e2e-local-wildcards", name: "The Glass Harbor" };
const BUILTIN = ["The Subversive", "The Devil's Advocate", "The Cliché Hunter", "The Twist Engineer", "The Genre Guest", "The Naive", "The Antagonist", "The Chaos Maker", "The Poet", "The Ledger Keeper", "The Continuity Keeper", "The Secrets Guardian", "The Domain Expert", "The Moral Stress-Test"];

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

/** Closes the Copilot: Escape closes the topmost layer first (a toast that is still there), then the panel. */
async function closeCopilot(page: Page): Promise<void> {
  const panel = page.locator('[data-assistant-mode="copilot"]');
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

const wildcardSwitch = (page: Page, name: string) => page.getByRole("switch", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `) });

let ai: StubProvider;
test.beforeAll(async () => {
  ai = await startProvider({
    answers: {
      copilot_turn: () => ({ reply: "Here is the proposal: a provocateur who thinks like a hacker.", calls: [{ tool: "propose_wildcard_changes", args: { create: { count: 1, brief: "a provocateur who thinks like a hacker" } } }] }),
      wildcard_personas: () => ({ wildcards: [{ name: "The Hacker", group: "provocateur", mandate: "Finds the exploit in every plot: the door nobody locked.", temperament: "Laconic and nocturnal.", audacity: 8, canonRespect: "subversive", outputFormat: "ideas", domain: "computer security", prompt: "Think like an attacker: where would you get in?" }] }),
    },
  });
});
test.afterAll(async () => { await ai.close(); });

test("the Wildcards page lists the built-in voices, turns one off in the book, keeps one of the author's own in the account, and the Copilot creates a hacker", async ({ page }) => {
  const github = watchGitHub(page);
  const seeded = await book();
  const { openAi } = await seed(page, settingsOf(ai.url, [seeded]), [seeded]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  await page.goto(`app/books/${BOOK.id}/wildcards`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Wildcards" })).toBeVisible({ timeout: 30_000 });
  for (const name of BUILTIN) await expect(wildcardSwitch(page, name)).toHaveAttribute("aria-checked", "true");
  // On a phone, and at 320 px, the page has no sideways scroll: nothing in it is wider than the page.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await overflowing(page.getByRole("main")), `what is wider than the page at ${width} px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `the page at ${width} px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  // Turned off in this book: a file of its own, nothing else.
  await wildcardSwitch(page, "The Chaos Maker").click();
  await expect(wildcardSwitch(page, "The Chaos Maker")).toHaveAttribute("aria-checked", "false", { timeout: 20_000 });
  const files = Object.fromEntries((await filesUnder(page, BOOK.repo, "wildcards/")).map((file) => [file.path, file.text]));
  expect(Object.keys(files)).toEqual(["wildcards/chaos-maker.md"]);
  expect(files["wildcards/chaos-maker.md"]).toMatch(/type: wildcard\nid: wildcard:chaos-maker[\s\S]*enabled: false/);

  // One of the author's own, for every book: kept with the account, not in the book.
  await page.getByRole("button", { name: "All my books", exact: true }).click();
  await expect(page.getByRole("button", { name: "All my books", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "New wildcard", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("The Night Owl");
  await page.getByLabel("Mandate", { exact: true }).fill("Reads every scene as if it happened at night.");
  await page.getByLabel("Prompt of the persona", { exact: true }).fill("Find what the dark hides in the scene.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(wildcardSwitch(page, "The Night Owl")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("listitem").filter({ has: wildcardSwitch(page, "The Night Owl") }).getByText("My account")).toBeVisible();
  expect((await filesUnder(page, BOOK.repo, "wildcards/")).map((file) => file.path)).toEqual(["wildcards/chaos-maker.md"]);
  // In the book it is the account's, and it stays there after a reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("listitem").filter({ has: wildcardSwitch(page, "The Night Owl") }).getByText("My account")).toBeVisible({ timeout: 30_000 });

  // The Copilot on the page creates «a provocateur who thinks like a hacker» as one batch: reviewed before anything is written, applied in one change.
  await page.getByRole("button", { name: "Copilot", exact: true }).click();
  const panel = page.locator('[data-assistant-mode="copilot"]');
  await expect(panel.locator('[data-copilot-scope="wildcards"]')).toContainText("Working on: Wildcards");
  await panel.locator("textarea").fill("Create a provocateur who thinks like a hacker");
  await panel.getByRole("button", { name: "Send" }).click();
  const review = panel.locator('[data-page-review="wildcards"]');
  await expect(review.getByRole("heading", { name: "Proposed changes to the wildcards" })).toBeVisible({ timeout: 30_000 });
  await expect(review.locator('tr[data-change="created"] th')).toContainText(["The Hacker"]);
  expect((await filesUnder(page, BOOK.repo, "wildcards/")).map((file) => file.path), "nothing is written yet").toEqual(["wildcards/chaos-maker.md"]);
  await review.getByRole("button", { name: "Apply" }).click();
  await expect(review.getByRole("status")).toHaveText(/^Applied: 1 created/, { timeout: 20_000 });
  const hacker = (await filesUnder(page, BOOK.repo, "wildcards/")).find((file) => file.path === "wildcards/the-hacker.md");
  expect(hacker?.text).toMatch(/id: wildcard:custom:the-hacker[\s\S]*audacity: 8[\s\S]*canon_respect: subversive[\s\S]*domain: computer security/);
  await closeCopilot(page);
  await expect(page.getByRole("listitem").filter({ has: wildcardSwitch(page, "The Hacker") }).getByText("This book")).toBeVisible({ timeout: 20_000 });

  expect(ai.asked).toEqual(["copilot_turn", "wildcard_personas"]);
  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});
