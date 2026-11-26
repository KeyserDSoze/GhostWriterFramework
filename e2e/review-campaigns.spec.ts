import { expect, test, type Page } from "@playwright/test";
import { autopilotFacts, engineModule, openApp, seed, settingsOf, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";

// «Review the book again» on a book kept on this device, with GitHub out of reach: a book the autopilot finished (four chapters, two of them closed under 8, the
// whole book judged 6.5) shows how it turned out and how many rounds of review its chapters had; the author asks for a review to 8.5 with one round allowed
// since the start. The chapters under the target are reviewed again in the order of the book, the director judges the book again, and the review waits for the
// author, with the panel that says why and the numbers; one click allows one more round, and the review ends on the target, which the card then says.

test.use({ serviceWorkers: "block" });
test.setTimeout(240_000);

const BOOK = { id: "book-review", repo: "e2e-local-review", name: "The Glass Harbor" };
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

type Vote = ["approve" | "revise", number];

/** A director who votes each chapter as a script says, one entry for each of its reviews (the last repeated), and judges the book with the scores of `books`. */
function scripted(chapters: Record<number, Vote[]>, books: number[]) {
  const asked = new Map<number, number>();
  let judged = 0;
  return {
    review(user: string) {
      const chapter = Number(/Decide on chapter (\d+)/.exec(user)?.[1] ?? "0");
      const turn = asked.get(chapter) ?? 0;
      asked.set(chapter, turn + 1);
      const list = chapters[chapter] ?? [["approve", 8]];
      const [verdict, score] = list[Math.min(turn, list.length - 1)];
      // Without specialists a revision needs a fix of the director's own, else the chapter is approved as it is.
      const extraFixes = verdict === "revise" ? [{ sceneNumber: 1, remediation: "Open with Mira already running.", rationale: "The opening is slow." }] : [];
      return { verdict, score, summary: "Judged.", strengths: [], decisions: [], extraFixes, guidance: [] };
    },
    book() {
      const score = books[Math.min(judged, books.length - 1)];
      judged += 1;
      return { verdict: "approve", score, summary: "The book as a whole.", strengths: ["Atmosphere"], concerns: [], decisions: [], nextSteps: [], questionsForAuthor: [] };
    },
  };
}

/** The finished book, made in Node by the engine with a director that closes chapters 2 and 4 under 8 and judges the book 6.5. */
async function finishedBook(): Promise<SeedBook> {
  const { AutopilotSession, writeOutlineBrief } = await engineModule("index.js");
  const { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 4, title: BOOK.name }));
  await writeOutlineBrief(store, { idea: "A harbor town built on glass hides a lie that the tide will tell.", genre: "mystery", audience: "adults", wordsPerScene: 200 });
  const fake = createFakeAutopilotAi({ scenes: 1, words: 120 });
  const director = scripted({ 1: [["approve", 8]], 2: [["revise", 5.5], ["revise", 6]], 3: [["approve", 8]], 4: [["revise", 6], ["revise", 6.5]] }, [6.5]);
  const reply = (json: unknown) => ({ text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake" });
  const ai = {
    calls: fake.calls,
    async complete(request: { label: string; user: string }) {
      if (/^autopilot:director-review:\d+$/.test(request.label)) return reply(director.review(request.user));
      if (request.label === "director:book") return reply(director.book());
      return fake.complete(request);
    },
  };
  const session = new AutopilotSession({ bookId: BOOK.id, store, ai, host: "browser", hostLabel: "seed", retryDelayMs: 0 });
  await session.start({ options: FAST });
  await session.waitForIdle();
  const snapshot = await session.snapshot();
  if (snapshot.state?.status !== "completed") throw new Error(`The seed did not finish: ${snapshot.state?.status} ${snapshot.state?.lastError?.message ?? ""}`);
  const scores = snapshot.state.plan.chapters.map((chapter: { score?: number }) => chapter.score);
  if (JSON.stringify(scores) !== JSON.stringify([8, 6, 8, 6.5])) throw new Error(`The seed closed the chapters at ${JSON.stringify(scores)}`);
  return { ...BOOK, files: store.toObject() };
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

// In the browser: round 1 brings chapters 1, 2 and 3 to 8.5 and chapter 4 to 8 (still under 8.5), the book to 8; round 2 brings chapter 4 to 9 and the book to 9.
const director = scripted({ 1: [["approve", 8.5]], 2: [["revise", 7], ["approve", 8.5]], 3: [["approve", 8.5]], 4: [["revise", 7], ["revise", 8], ["approve", 9]] }, [8, 9]);
let ai: StubProvider;
test.beforeAll(async () => {
  ai = await startProvider({ chapters: 1, scenes: 1, words: 120, answers: { director_review: (user) => director.review(user), director_opinion: () => director.book() } });
});
test.afterAll(async () => { await ai.close(); });

test("a finished book is reviewed again to a target: the chapters under it in order, the review held after the rounds allowed with its panel, one more round with one click, and the end on the target", async ({ page }) => {
  const github = watchGitHub(page);
  const book = await finishedBook();
  const { openAi } = await seed(page, settingsOf(ai.url, [book]), [book]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // How the book turned out: the verdict, and the rounds of review the chapters had.
  await page.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });
  const result = page.locator("[data-autopilot-result]");
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result.locator("[data-result-score]")).toHaveText("6.5/10");
  await expect(result.locator("dt", { hasText: "Rounds of review" })).toBeVisible();
  await expect(result.locator("dd").filter({ hasText: "up to 2 for a chapter" })).toContainText("6");

  // «Review the book again»: the target, the rounds, the chapters under it.
  await result.getByRole("button", { name: "Review the book again" }).click();
  const dialog = page.getByRole("dialog", { name: "Review the book again" });
  await expect(dialog.getByLabel("Score to reach")).toHaveValue("8");
  await expect(dialog.getByRole("heading", { name: "2 chapters under 8/10 will be reviewed again" })).toBeVisible();
  await expect(dialog.locator("[data-review-chapter]")).toHaveText([/Chapter 2.*6\/10/, /Chapter 4.*6\.5\/10/]);
  await dialog.getByLabel("Score to reach").fill("8.5");
  await expect(dialog.getByRole("heading", { name: "4 chapters under 8.5/10 will be reviewed again" })).toBeVisible();
  await dialog.getByLabel("Rounds of a review of the book").fill("1");
  await expect(dialog.locator("[data-review-estimate]")).toContainText("One round: 4 chapters reviewed again");
  expect((await autopilotFacts(page, BOOK.repo))?.status, "nothing started before the confirmation").toBe("completed");
  const mark = (await autopilotFacts(page, BOOK.repo))?.done.length ?? 0;
  await dialog.getByRole("button", { name: "Review 4 chapters" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // The rounds allowed are done: the review waits, and the panel says why, with the numbers.
  const held = await waitForAutopilot(page, BOOK.repo, ["paused"], 120_000);
  const round1 = held.done.slice(mark);
  const reviewed = round1.filter((step) => step.startsWith("director-review:")).map((step) => Number(step.split(":")[1]));
  expect([...new Set(reviewed)], round1.join(", ")).toEqual([1, 2, 3, 4]);
  expect(round1.indexOf("consolidate:1:")).toBeLessThan(round1.indexOf("director-review:2:"));
  expect(round1.indexOf("consolidate:4:")).toBeLessThan(round1.indexOf("final::"));
  const panel = page.locator("[data-limit-panel='review-rounds']");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole("heading", { name: "The review of the book waits for you" })).toBeVisible();
  await expect(panel).toContainText("1 round of the review done since the start, as many as you allowed (1).");
  await expect(panel).toContainText("Review to 8.5/10, round 2 next: the lowest chapter is 8/10, the book 8/10.");
  await expect(page.locator('[data-campaign="review-target"]').first()).toContainText("Review to 8.5/10: round 2");

  // One more round, with one click: chapter 4 reaches it, and so does the book.
  await panel.getByRole("button", { name: "Go on for 1 more round" }).click();
  const facts = await waitForAutopilot(page, BOOK.repo, ["completed"], 120_000);
  // The steps after the judgement of round 1: the second to last judgement of the book.
  const finals = facts.done.flatMap((step, index) => (step === "final::" ? [index] : []));
  const round2 = facts.done.slice(finals[finals.length - 2] + 1);
  expect(round2.filter((step) => step.startsWith("director-review:")).map((step) => step.split(":")[1])).toEqual(["4"]);
  await expect(panel).toBeHidden({ timeout: 20_000 });
  await expect(result.locator("[data-result-score]")).toHaveText("9/10", { timeout: 20_000 });
  await expect(result.locator("[data-result-review]")).toHaveText("Reviewed again to 8.5/10: the target was reached in 2 rounds, and the book went from 6.5/10 to 9/10.");
  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});
