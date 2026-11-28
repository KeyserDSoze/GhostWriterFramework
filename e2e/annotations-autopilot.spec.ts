import { expect, test, type Page } from "@playwright/test";
import { autopilotFacts, engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";

// The notes of the author as the input of the autopilot, in a real browser on a book kept on this device, with GitHub out of reach and a stub AI provider: a book the
// autopilot finished (two chapters) has three notes (a rewrite, an expansion, and one that asks to keep a passage); on the page of the notes the author has the autopilot
// answer them, sees what it costs before confirming, and the run rewrites the scenes, reviews the chapters again, closes the two notes it answered as handled by the
// autopilot (the third is left alone), and the page and the autopilot's page say what it did.

test.use({ serviceWorkers: "block" });
test.setTimeout(240_000);

const BOOK = { id: "book-notes-run", repo: "e2e-local-notes-run", name: "The Glass Harbor" };
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const AT = "2026-11-25T10:00:00.000Z";

async function finishedBook(): Promise<SeedBook> {
  const { AutopilotSession, writeOutlineBrief } = await engineModule("index.js");
  const { serializeChapterAnnotations } = await engineModule("annotations/index.js");
  const { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 2, title: BOOK.name }));
  await writeOutlineBrief(store, { idea: "A harbor town built on glass hides a lie that the tide will tell.", genre: "mystery", audience: "adults", wordsPerScene: 200 });
  const fake = createFakeAutopilotAi({ scenes: 1, words: 120 });
  const session = new AutopilotSession({ bookId: BOOK.id, store, ai: fake, host: "browser", hostLabel: "seed", retryDelayMs: 0 });
  await session.start({ options: FAST });
  await session.waitForIdle();
  const snapshot = await session.snapshot();
  if (snapshot.state?.status !== "completed") throw new Error(`The seed did not finish: ${snapshot.state?.status} ${snapshot.state?.lastError?.message ?? ""}`);
  const [first, second] = snapshot.state.plan.chapters as Array<{ slug: string; scenes: Array<{ path: string; title: string }> }>;
  const sceneSlug = (chapter: typeof first) => chapter.scenes[0].path.slice(chapter.scenes[0].path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  const entry = (id: string, chapter: typeof first, tag: string, comment: string) => ({ id, paragraph: sceneSlug(chapter), quote: "the harbor", prefix: "", suffix: "", offset: 0, tag, comment, status: "open", createdAt: AT, updatedAt: AT, createdOnDevice: "d-1a2b3c4d" });
  const file = (chapter: typeof first, entries: unknown[]) => serializeChapterAnnotations({ version: 1, chapter: chapter.slug, invalid: [], extra: {}, entries });
  const files = store.toObject() as Record<string, string>;
  files[`annotations/chapters/${first.slug}.yml`] = file(first, [entry("a-mi4k2000-aaaaaa", first, "rewrite", "Too familiar."), entry("a-mi4k3000-bbbbbb", first, "keep", "Perfect, do not touch.")]);
  files[`annotations/chapters/${second.slug}.yml`] = file(second, [entry("a-mi4k4000-cccccc", second, "expand", "More here.")]);
  return { ...BOOK, files };
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

let ai: StubProvider;
test.beforeAll(async () => { ai = await startProvider({ chapters: 1, scenes: 1, words: 120 }); });
test.afterAll(async () => { await ai.close(); });

test("the autopilot answers the notes of the book: an estimate first, the scenes rewritten and the chapters reviewed again, the notes closed with what it did, nothing for the note that asks to keep", async ({ page }) => {
  const github = watchGitHub(page);
  const book = await finishedBook();
  const { openAi } = await seed(page, settingsOf(ai.url, [book]), [book]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  await page.goto(`app/books/${BOOK.id}/annotations`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-note-id]")).toHaveCount(3, { timeout: 30_000 });
  await page.locator("[data-autopilot-start]").click();
  const dialog = page.getByRole("dialog", { name: "Have the autopilot answer your notes" });
  await expect(dialog.locator("[data-annotations-summary]")).toHaveText("To answer: 2 notes in 2 chapters", { timeout: 30_000 });
  await expect(dialog.locator("[data-review-estimate]")).toContainText("Plus about 2 calls to rewrite the scenes.");
  const before = (await autopilotFacts(page, BOOK.repo))?.done.length ?? 0;
  expect((await autopilotFacts(page, BOOK.repo))?.status, "nothing started before the confirmation").toBe("completed");
  await dialog.getByRole("button", { name: "Answer 2 notes" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  const done = await waitForAutopilot(page, BOOK.repo, ["completed"], 180_000);
  const steps = done.done.slice(before);
  expect(steps.filter((step) => step.startsWith("revise:")), steps.join(", ")).toHaveLength(2);
  expect(steps.some((step) => step.startsWith("director-review:1")), "chapter 1 reviewed again").toBe(true);
  expect(steps.some((step) => step.startsWith("director-review:2")), "chapter 2 reviewed again").toBe(true);

  const notes = (await filesUnder(page, BOOK.repo, "annotations/chapters/")).map((file) => file.text).join("\n");
  expect(notes.match(/status: handled/g)).toHaveLength(2);
  expect(notes.match(/by: autopilot/g)).toHaveLength(2);
  expect(notes).toContain("Rewritten by the autopilot");
  expect(notes.match(/status: open/g), "the note that asks to keep a passage is left alone").toHaveLength(1);

  // The page of the notes says what it did, and the closed notes say by whom.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Annotations" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("group", { name: "Status", exact: true }).getByRole("button", { name: /^Handled/ }).click();
  await expect(page.locator("[data-note-resolution]").first()).toContainText("Handled by the autopilot");
  await page.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-annotations-result]")).toContainText("The autopilot answered 2 of 2 notes in 2 chapters.", { timeout: 30_000 });
  expect(openAi, "no request went to the real OpenAI").toEqual([]);
  expect(github, "no request went to GitHub").toEqual([]);
});
