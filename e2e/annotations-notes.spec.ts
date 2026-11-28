import { expect, test, type Page } from "@playwright/test";
import { engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, type SeedBook, type StubProvider } from "./helpers/autopilot";

// The Annotations page of a book («Appunti»), in a real browser, on a book kept on this device with GitHub out of reach and a stub AI provider: the notes are
// listed by chapter, one is closed by hand, one is fixed with the AI (the author reviews the change word by word and applies it in one write, and the note is
// closed as handled by the AI), and a conversation about a note streams an answer. No request goes to GitHub.

test.use({ serviceWorkers: "block" });

const BOOK = { id: "book-notes", repo: "e2e-local-notes", name: "The Annotated Gate" };
const CHAPTER = "001-the-gate";
const SCENE = `chapters/${CHAPTER}/001-opening.md`;
const TEXT = "The gate stood open beneath a sky the color of old steel. Mara waited by the wall, counting the lanterns one by one, and nobody came.";
const REWRITTEN = TEXT.replace("a sky the color of old steel", "a sky like wet slate");
const entry = (id: string, quote: string, tag: string, comment: string) => [
  `  - id: ${id}`, "    paragraph: paragraph:001-the-gate:001-opening", `    quote: ${JSON.stringify(quote)}`, `    prefix: ${JSON.stringify(TEXT.slice(Math.max(0, TEXT.indexOf(quote) - 32), TEXT.indexOf(quote)))}`,
  `    suffix: ${JSON.stringify(TEXT.slice(TEXT.indexOf(quote) + quote.length, TEXT.indexOf(quote) + quote.length + 32))}`, `    offset: ${TEXT.indexOf(quote)}`,
  `    tag: ${tag}`, `    comment: ${JSON.stringify(comment)}`, "    status: open", "    createdAt: 2026-11-25T10:00:00.000Z", "    updatedAt: 2026-11-25T10:00:00.000Z", "    createdOnDevice: d-1a2b3c4d",
].join("\n");
const ANNOTATIONS = ["version: 1", `chapter: chapter:${CHAPTER}`, "annotations:", entry("a-mi4k2000-aaaaaa", "the color of old steel", "rewrite", "Too familiar an image."), entry("a-mi4k3000-bbbbbb", "counting the lanterns one by one", "slow-pace", "Shorter."), ""].join("\n");

async function book(): Promise<SeedBook> {
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  const files = new MemoryBookStore(seedBookFiles({ chapters: 0, title: BOOK.name })).toObject() as Record<string, string>;
  files[`chapters/${CHAPTER}/chapter.md`] = "---\ntype: chapter\nid: chapter:001-the-gate\nnumber: 1\ntitle: The Gate\n---\n\nThe first chapter.\n";
  files[SCENE] = `---\ntype: paragraph\nid: paragraph:001-the-gate:001-opening\nchapter: chapter:001-the-gate\nnumber: 1\ntitle: Opening\n---\n\n${TEXT}\n`;
  files[`annotations/chapters/${CHAPTER}.yml`] = ANNOTATIONS;
  return { ...BOOK, files };
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

let ai: StubProvider;
test.beforeAll(async () => {
  ai = await startProvider({ prose: (user) => (user.includes("BLOCKS TO REWRITE") ? REWRITTEN : "Try the lantern first, then the wall.") });
});
test.afterAll(async () => { await ai.close(); });

test("the notes of a book: listed by chapter, closed by hand, fixed with the AI after a review, and talked through, with GitHub out of reach", async ({ page }) => {
  test.setTimeout(180_000);
  const github = watchGitHub(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const seeded = await book();
  await seed(page, settingsOf(ai.url, [seeded]), [seeded]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  await page.goto(`app/books/${BOOK.id}/annotations`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Annotations" })).toBeVisible({ timeout: 30_000 });
  const cards = page.locator("[data-note-id]");
  await expect(cards).toHaveCount(2);
  await expect(page.locator('[data-notes-chapter="001-the-gate"]')).toContainText("The Gate");

  // Closed by hand: the note leaves the list of what waits, and the file says by whom.
  await cards.nth(1).getByRole("button", { name: "Handled", exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect.poll(async () => (await filesUnder(page, BOOK.repo, "annotations/chapters/")).map((file) => file.text).join("")).toContain("by: author");

  // Fixed with the AI: nothing is written until Apply.
  await cards.first().getByRole("button", { name: "Fix with the AI" }).click();
  const dialog = page.getByRole("dialog", { name: "Fix with the AI" });
  await expect(dialog.getByText("Review the proposal")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator("del").first()).toContainText("the color of old steel");
  await expect(dialog.locator("ins").first()).toContainText("like wet slate");
  expect((await filesUnder(page, BOOK.repo, SCENE))[0].text).toContain("the color of old steel");
  await dialog.getByRole("button", { name: "Apply the changes" }).click();
  await expect(dialog.getByText("Applied: the scene is changed and the note is handled.")).toBeVisible();
  await expect.poll(async () => (await filesUnder(page, BOOK.repo, SCENE))[0].text).toContain(REWRITTEN);
  expect((await filesUnder(page, BOOK.repo, "annotations/chapters/"))[0].text).toContain("by: ai");
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(cards).toHaveCount(0);

  // Reasoning together about a note that is back on the list.
  await page.getByRole("button", { name: /^Handled/ }).click();
  await cards.first().getByRole("button", { name: "Let's reason together" }).click();
  const chat = page.getByRole("dialog", { name: "Let's reason together" });
  await chat.getByLabel("Your message").fill("What would you do here?");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect(chat.getByText("Try the lantern first, then the wall.")).toBeVisible({ timeout: 30_000 });

  expect(github, "no request went to GitHub").toEqual([]);
  expect(errors).toEqual([]);
});

test("the triage: from the reader to one note at a time, decided with the keyboard, resumable after a reload, with GitHub out of reach", async ({ page }) => {
  test.setTimeout(180_000);
  const github = watchGitHub(page);
  const seeded = await book();
  await seed(page, settingsOf(ai.url, [seeded]), [seeded]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // From the reader: the link of the header goes to the triage.
  await page.goto(`app/books/${BOOK.id}/reader`, { waitUntil: "domcontentloaded" });
  const link = page.locator("[data-reader-triage]");
  await expect(link).toBeVisible({ timeout: 30_000 });
  await link.click();
  const note = page.locator("[data-triage-note]");
  await expect(note).toContainText("the color of old steel", { timeout: 30_000 });
  await expect(page.locator("[data-triage-position]")).toHaveText("Note 1 of 2");
  await expect(page.getByRole("progressbar", { name: "Progress through the notes" })).toHaveAttribute("aria-valuemax", "2");

  // Keyboard: S skips (kept on this device), H closes the next one.
  await page.keyboard.press("s");
  await expect(note).toContainText("counting the lanterns one by one");
  await page.reload();
  await expect(note).toContainText("counting the lanterns one by one", { timeout: 30_000 });
  await page.keyboard.press("h");
  await expect(page.getByRole("heading", { name: "All the notes are reviewed" })).toBeVisible();
  await expect.poll(async () => (await filesUnder(page, BOOK.repo, "annotations/chapters/")).map((file) => file.text).join("")).toContain("by: author");
  await page.getByRole("button", { name: /^Show the 1 skipped note again$/ }).click();
  await expect(note).toContainText("the color of old steel");
  expect(github, "no request went to GitHub").toEqual([]);
});
