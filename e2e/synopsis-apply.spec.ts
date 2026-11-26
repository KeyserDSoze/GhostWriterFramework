import { expect, test, type Page } from "@playwright/test";
import { autopilotFacts, engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";

// The Synopsis applied to a book kept on this device, with GitHub out of reach: a book the autopilot finished (four chapters approved and frozen, the fourth
// frozen again by the author by hand), whose Synopsis the author changes on its page (a chapter moved, one modified, one added). The journal of the Synopsis
// records it, «What changed» shows it with what the autopilot will do, and «Apply to the book» rewrites exactly the chapters chosen, in the order of the book,
// after the author confirmed them, then goes on with the plan (the chapter added is written); the chapter the author froze, left for later, is not touched,
// nor asked about. A reload in the middle of the work resumes it.

test.use({ serviceWorkers: "block" });
test.setTimeout(240_000);

const BOOK = { id: "book-apply", repo: "e2e-local-apply", name: "The Glass Harbor" };
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const NOTE = "The vault comes first now.";

interface Seeded {
  book: SeedBook;
  /** The folder of each chapter, by number. */
  folders: Map<number, string>;
}

/** The finished book, made in Node by the engine with its fake AI: what the browser's working copy starts from. */
async function finishedBook(): Promise<Seeded> {
  const { AutopilotSession, writeOutlineBrief } = await engineModule("index.js");
  const { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 4, title: BOOK.name }));
  await writeOutlineBrief(store, { idea: "A harbor town built on glass hides a lie that the tide will tell.", genre: "mystery", audience: "adults", wordsPerScene: 200 });
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1, words: 120 });
  const session = new AutopilotSession({ bookId: BOOK.id, store, ai, host: "browser", hostLabel: "seed", retryDelayMs: 0 });
  await session.start({ options: FAST });
  await session.waitForIdle();
  const snapshot = await session.snapshot();
  if (snapshot.state?.status !== "completed") throw new Error(`The seed did not finish: ${snapshot.state?.status} ${snapshot.state?.lastError?.message ?? ""}`);
  const folders = new Map<number, string>(snapshot.state.plan.chapters.map((chapter: { number: number; slug: string }) => [chapter.number, chapter.slug]));
  // The author froze chapter 4 again, by hand: from now on it is the author's.
  await session.freezeChapter(folders.get(4)!);
  return { book: { ...BOOK, files: store.toObject() }, folders };
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

const textOf = async (page: Page, path: string) => (await filesUnder(page, BOOK.repo, path)).find((file) => file.path === path)?.text ?? null;
const bodyOf = (text: string | null) => (text ?? "").replace(/^---[\s\S]*?\n---\n/, "").trim();
const sceneOf = (folders: Map<number, string>, number: number) => `chapters/${folders.get(number)}/001-scene-1-title.md`;

let ai: StubProvider;
const impacts: string[] = [];
test.beforeAll(async () => {
  ai = await startProvider({
    chapters: 1,
    scenes: 1,
    words: 120,
    // The impact of a chapter rewritten to follow its entry: its first scene. The engine's fake names chapter 1 whatever the chapter.
    answers: {
      revision_impact: (user) => {
        impacts.push(user);
        const number = /written scenes of chapter (\d+) must be rewritten/i.exec(user)?.[1];
        return number ? { summary: "The first scene follows the new entry.", targets: [{ chapterNumber: Number(number), sceneNumber: 1, instruction: "Follow the new entry." }] } : { summary: "Nothing else.", targets: [] };
      },
    },
  });
});
test.afterAll(async () => { await ai.close(); });

test("the Synopsis is changed on its page, its journal tells it, and applying it rewrites exactly the chosen chapters in order, then the book goes on", async ({ page }) => {
  const github = watchGitHub(page);
  const { book, folders } = await finishedBook();
  const { openAi } = await seed(page, settingsOf(ai.url, [book]), [book]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  const before = { 2: await textOf(page, sceneOf(folders, 2)), 4: await textOf(page, sceneOf(folders, 4)), chapter4: await textOf(page, `chapters/${folders.get(4)}/chapter.md`) };
  const rewrittenBefore = { 1: await textOf(page, sceneOf(folders, 1)), 3: await textOf(page, sceneOf(folders, 3)) };
  expect(before[4]).not.toBeNull();

  await page.goto(`app/books/${BOOK.id}/outline`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Synopsis" })).toBeVisible();
  await expect(page.locator("#outline-chapter-4")).toBeVisible();
  await expect(page.locator("[data-outline-changes]"), "nothing changed since the autopilot followed the Synopsis").toHaveCount(0);

  // Modify one entry, move one, add one.
  await page.getByLabel("What happens in chapter 1", { exact: true }).fill("Mira arrives at night, and the vault is the first thing she sees.");
  await page.getByRole("button", { name: "Save chapter 1", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Chapter 1 saved." })).toBeVisible();
  await page.getByRole("button", { name: "Move chapter 4 up", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Chapter 4 is now chapter 3." })).toBeVisible();
  await page.getByRole("button", { name: "Add a chapter at the end", exact: true }).click();
  await expect(page.getByLabel("Hypothetical title of chapter 5", { exact: true })).toBeFocused();
  await page.getByLabel("Hypothetical title of chapter 5", { exact: true }).fill("The return");
  await page.getByLabel("What happens in chapter 5", { exact: true }).fill("Mira comes back to the harbor years later.");
  await page.getByRole("button", { name: "Save chapter 5", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Chapter 5 saved." })).toBeVisible();

  // The journal of the Synopsis recorded each series, by the author.
  const { parseOutlineJournal } = await engineModule("index.js");
  const journal = parseOutlineJournal(await textOf(page, "outline/changes.yml"));
  const mine = journal.series.filter((series: { by: string }) => series.by === "author").map((series: { chapters: Array<{ chapter: number; change: string; from?: number }> }) => series.chapters.map((item) => [item.chapter, item.change, item.from ?? null]));
  expect(mine).toEqual([[[1, "modified", null]], [[3, "moved", 4], [4, "moved", 3]], [[5, "created", null]], [[5, "modified", null]]]);
  expect(journal.series, "every series of the journal is one of these: the author wrote the entries before the autopilot planned").toHaveLength(4);

  // «What changed» says it: who, what, and what the autopilot will do.
  const changes = page.locator("[data-outline-changes]");
  await expect(changes).toBeVisible();
  await expect(changes.locator("[data-outline-change]")).toHaveCount(4);
  await expect(changes.locator('[data-outline-change="1"]')).toContainText("Changed");
  await expect(changes.locator('[data-outline-change="1"]')).toContainText("by you");
  await expect(changes.locator('[data-outline-change="1"]')).toContainText("The autopilot will ask you what to do.");
  await expect(changes.locator('[data-outline-change="3"]')).toContainText("Moved from chapter 4");
  await expect(changes.locator('[data-outline-change="4"]')).toContainText("Moved from chapter 3");
  await expect(changes.locator('[data-outline-change="5"]')).toContainText("Planned after the chapters of the plan.");
  await expect(changes).toContainText("Chapters 1, 3, and 4 are already written: after these changes the autopilot will ask you whether to rewrite them to follow the Synopsis.");
  await expect(page.locator("#outline-chapter-3")).toContainText("Changed: the autopilot will ask");

  // Apply to the book: 1 and 3 are the autopilot's (rewritten by default), 4 is frozen by the author (left for later by default).
  ai.delayMs = 400;
  await changes.getByRole("button", { name: "Apply to the book…" }).click();
  const panel = page.getByRole("dialog", { name: "Apply the Synopsis to the book" });
  await expect(panel.locator("[data-apply-chapter]")).toHaveCount(3);
  const choice = (number: number, name: string) => panel.locator(`[data-apply-chapter="${number}"]`).getByRole("radio", { name });
  await expect(choice(1, "Rewrite it to follow the Synopsis")).toBeChecked();
  await expect(choice(3, "Rewrite it to follow the Synopsis")).toBeChecked();
  await expect(choice(4, "Decide later")).toBeChecked();
  await expect(panel.locator('[data-apply-chapter="4"]')).toContainText("frozen by you");
  await expect(panel.locator('[data-apply-told="5"]')).toContainText("Planned after the chapters of the plan.");
  await expect(panel.locator('[data-apply-figures="rewrite"]')).toBeVisible({ timeout: 20_000 });
  await panel.getByLabel("Words for the director (optional)").fill(NOTE);
  await panel.getByRole("button", { name: "Apply and start the autopilot" }).click();
  // The confirmation names the approved chapters that will be rewritten, and the one left alone.
  const confirm = panel.locator("[data-outline-apply-confirm]");
  await expect(confirm.getByRole("heading", { name: "Rewrite 2 approved chapters?" })).toBeFocused();
  await expect(confirm.getByRole("listitem")).toHaveText([/Chapter 1/, /Chapter 3/]);
  await expect(confirm).toContainText("Chapter 4 is not touched: you decide about it later.");
  expect((await autopilotFacts(page, BOOK.repo))?.status, "nothing started before the confirmation").toBe("completed");
  await panel.getByRole("button", { name: "Rewrite 2 chapters and start" }).click();
  await expect(panel).toBeHidden({ timeout: 20_000 });

  // The progress, on the page and in the band of the autopilot's mini-player.
  await expect(changes.locator("[data-outline-campaign]")).toContainText("Applying the Synopsis to the book", { timeout: 20_000 });
  await page.getByRole("button", { name: /^Show what the autopilot is doing/ }).first().click();
  await expect(page.locator('[data-campaign="outline-change"]').first()).toContainText("Applying the Synopsis", { timeout: 20_000 });

  // A reload in the middle: the run resumes by itself and goes on with the chapters that wait.
  await expect.poll(async () => (await autopilotFacts(page, BOOK.repo))?.done.includes("revise:1:1"), { timeout: 60_000 }).toBe(true);
  const atReload = await autopilotFacts(page, BOOK.repo);
  expect(atReload?.status).toBe("running");
  expect(atReload?.done, "chapter 3 waits for its turn").not.toContain("revise:3:1");
  await page.reload({ waitUntil: "domcontentloaded" });
  ai.delayMs = 0;
  const facts = await waitForAutopilot(page, BOOK.repo, ["completed"], 120_000);

  // Exactly the chosen chapters, in order, then the plan: chapter 5 is written.
  const done = facts.done;
  const at = (step: string) => done.indexOf(step);
  expect(at("revise:1:1"), done.join(", ")).toBeGreaterThanOrEqual(0);
  expect(at("revise:3:1")).toBeGreaterThan(at("revise:1:1"));
  expect(at("write:5:1")).toBeGreaterThan(at("revise:3:1"));
  expect(done.filter((step) => /^revise:(2|4|5):/.test(step))).toEqual([]);
  expect(impacts.map((user) => /written scenes of chapter (\d+)/.exec(user)?.[1])).toEqual(["1", "3"]);
  expect(impacts.every((user) => user.includes(NOTE)), "the author's words reach the director").toBe(true);
  expect(bodyOf(await textOf(page, sceneOf(folders, 1)))).not.toBe(bodyOf(rewrittenBefore[1]));
  expect(bodyOf(await textOf(page, sceneOf(folders, 3)))).not.toBe(bodyOf(rewrittenBefore[3]));
  expect(await textOf(page, sceneOf(folders, 2)), "kept: its entry did not change").toBe(before[2]);
  expect(await textOf(page, sceneOf(folders, 4)), "the chapter the author froze is untouched").toBe(before[4]);
  expect(await textOf(page, `chapters/${folders.get(4)}/chapter.md`), "and still frozen by the author").toBe(before.chapter4);
  const state = JSON.parse((await textOf(page, "autopilot/state.json")) ?? "{}");
  expect(state.question, "nothing asked about the chapter left for later").toBeNull();
  expect(state.campaign).toBeUndefined();
  expect(state.deferredChanges.map((entry: { number: number }) => entry.number)).toEqual([4]);

  // «What changed» now says only the chapter left for later.
  await page.goto(`app/books/${BOOK.id}/outline`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-outline-changes] [data-outline-change]")).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('[data-outline-changes] [data-outline-change="4"]')).toContainText("Left for later");
  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});
