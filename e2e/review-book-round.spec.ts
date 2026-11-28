import { expect, test, type Page } from "@playwright/test";
import { autopilotFacts, engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";
import { capture, contrast, horizontalOverflow, overflowing, setTheme } from "./helpers/review-view";

// The round for the whole book of a review, on a book kept on this device with GitHub out of reach. The autopilot finished the book: both chapters closed at 9, and the director's
// vote of the whole book is 7.4, with two points (the ending is not earned, the middle needs tightening). Another round of the same chapters would change nothing. The page says it
// (the book's vote is below the target, and every chapter has its targets) and offers to review the book as a whole: «Review the book again» opens with the round on «Show me the
// corrections first». The director is asked for the corrections across the chapters (one for each chapter, each citing a point), the run stops for the author, who ticks one of the two
// and carries it out: chapter 1 is revised and reviewed again, chapter 2 is left as it is, the director judges the book again (9.2) and the review ends on the target. The card says what
// the director asked and what became of each correction. The new parts fit a phone and a screen 320 px wide, are readable in both themes, and say it in Italian.

test.use({ serviceWorkers: "block" });
test.setTimeout(240_000);

const BOOK = { id: "book-round", repo: "e2e-local-round", name: "The Glass Harbor" };
// The book is approved at 8: every chapter has more, the book as a whole has less.
const OPTIONS = { readers: false, specialists: false, readersOnPlan: false, pauseAfterPlan: false, review: { targetScore: 8 } };
const POINTS = ["major: The ending is not earned — Plant its setup earlier", "next step: Tighten the middle chapters"];

/** The director: approves every chapter at 9 the moment it is asked, and judges the book as `votes` says (the last one for every judgement after it). */
function director(votes: readonly number[]) {
  let judged = 0;
  return {
    review(user: string) {
      const ids = [...user.matchAll(/\[([A-Z]\d+-\d+)\]/g)].map((match) => match[1]);
      return {
        verdict: "approve",
        score: 9,
        summary: "Judged.",
        strengths: [],
        decisions: ids.map((id) => ({ findingId: id, action: "reject", rationale: "Because.", remediation: "", sceneNumber: 1 })),
        extraFixes: [],
        guidance: [],
      };
    },
    book() {
      const score = votes[Math.min(judged, votes.length - 1)];
      judged += 1;
      return {
        verdict: score >= 9 ? "approve" : "revise",
        score,
        summary: "The book as a whole.",
        strengths: ["Atmosphere"],
        concerns: [{ severity: "major", issue: "The ending is not earned", suggestion: "Plant its setup earlier" }],
        decisions: [],
        nextSteps: ["Tighten the middle chapters"],
        questionsForAuthor: [],
      };
    },
  };
}

/** The finished book, made in Node by the engine: both chapters closed at 9, the book judged 7.4. */
async function finishedBook(): Promise<SeedBook> {
  const { AutopilotSession, writeOutlineBrief } = await engineModule("index.js");
  const { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 2, title: BOOK.name }));
  await writeOutlineBrief(store, { idea: "A harbor town built on glass hides a lie that the tide will tell.", genre: "mystery", audience: "adults", wordsPerScene: 200 });
  const fake = createFakeAutopilotAi({ scenes: 1, words: 120 });
  const voting = director([7.4]);
  const reply = (json: unknown) => ({ text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake" });
  const ai = {
    calls: fake.calls,
    async complete(request: { label: string; user: string; system: string; json?: { name?: string } }) {
      if (/^autopilot:director-review:\d+$/.test(request.label)) return reply(voting.review(request.user));
      if (request.label === "director:book") return reply(voting.book());
      return fake.complete(request);
    },
  };
  const session = new AutopilotSession({ bookId: BOOK.id, store, ai, host: "browser", hostLabel: "seed", retryDelayMs: 0 });
  await session.start({ options: OPTIONS });
  await session.waitForIdle();
  const snapshot = await session.snapshot();
  if (snapshot.state?.status !== "completed") throw new Error(`The seed did not finish: ${snapshot.state?.status} ${snapshot.state?.lastError?.message ?? ""}`);
  const scores = snapshot.state.plan.chapters.map((chapter: { score?: number }) => chapter.score);
  if (JSON.stringify(scores) !== JSON.stringify([9, 9])) throw new Error(`The seed closed the chapters at ${JSON.stringify(scores)}`);
  if (JSON.stringify(snapshot.state.finalReview?.points) !== JSON.stringify(POINTS)) throw new Error(`The judgement of the book has the points ${JSON.stringify(snapshot.state.finalReview?.points)}`);
  return { ...BOOK, files: store.toObject() };
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

/** The corrections the director gives: one for each chapter, each citing a point of its judgement of the book. */
const corrections = () => ({
  summary: "The ending and the middle carry the book.",
  corrections: [
    { chapterNumber: 1, change: "Plant the setup of the ending in the first scene.", reason: "The ending pays off a promise that nothing made.", cites: [1] },
    { chapterNumber: 2, change: "Cut the detour of the second scene.", reason: "The middle drags.", cites: [2] },
  ],
});

// In the browser: the director approves every chapter at 9, and judges the book 9.2 once the chapters it named are corrected (the 7.4 was judged when the book was made).
const browserDirector = director([9.2]);
let ai: StubProvider;
test.beforeAll(async () => {
  ai = await startProvider({
    chapters: 1,
    scenes: 1,
    words: 120,
    answers: {
      director_review: (user) => browserDirector.review(user),
      director_opinion: () => browserDirector.book(),
      book_corrections: () => corrections(),
    },
  });
});
test.afterAll(async () => { await ai.close(); });

test("the round for the whole book: the page says the book is under its target, the director's corrections wait for the author, and what is carried out is reviewed again and judged", async ({ page }) => {
  const github = watchGitHub(page);
  const book = await finishedBook();
  const { openAi } = await seed(page, settingsOf(ai.url, [book]), [book]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // The finished book: every chapter has its targets, and the book's vote is under the target.
  await page.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });
  const result = page.locator("[data-autopilot-result]");
  await expect(result).toBeVisible({ timeout: 30_000 });
  const block = result.locator("[data-result-book-round]");
  await expect(block.getByRole("heading", { name: "The book as a whole" })).toBeVisible({ timeout: 30_000 });
  await expect(block.locator("[data-book-below]")).toContainText("The book's vote is below the target: 7.4/10 (target 8/10).");
  await expect(block).toContainText("Every chapter has its targets");
  await expect(block).toContainText("The round for the whole book is off in the settings of this book");
  await expect(block.getByRole("heading", { name: "What the director asked of the book" })).toHaveCount(0);

  // «Review the book as a whole» opens «Review the book again» with the round on «Show me the corrections first»: no chapter is under the target, the book is.
  await block.getByRole("button", { name: "Review the book as a whole" }).click();
  const dialog = page.getByRole("dialog", { name: "Review the book again" });
  await expect(dialog.getByRole("radio", { name: "Show me the corrections first" })).toBeChecked();
  await expect(dialog.locator("[data-review-nothing]")).toContainText("the director is asked for the corrections across the chapters");
  await expect(dialog.locator("[data-review-book-round-cost]")).toContainText("The request for the corrections is one call of the director");
  const submit = dialog.getByRole("button", { name: "Ask for the corrections of the book" });
  await expect(submit).toBeEnabled();
  // On a phone, and at 320 px, the dialog has no sideways scroll: nothing in it is wider than it is.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await overflowing(dialog), `what is wider than the dialog at ${width} px`).toEqual([]);
    expect(await horizontalOverflow(dialog), `the dialog at ${width} px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await capture(page, "round-dialog");
  expect((await autopilotFacts(page, BOOK.repo))?.status, "nothing started before the confirmation").toBe("completed");
  const mark = (await autopilotFacts(page, BOOK.repo))?.done.length ?? 0;
  const chapterTwo = (await filesUnder(page, BOOK.repo, "chapters/002")).map((file) => `${file.path}\n${file.text}`).sort();
  await submit.click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // The director is asked for the corrections, and the run stops for the author with them: nothing was changed yet.
  const panel = page.locator("[data-book-round='proposed']");
  await expect(panel).toBeVisible({ timeout: 120_000 });
  await expect(panel.getByRole("heading", { name: "The director asks for corrections of the whole book" })).toBeVisible();
  await expect(panel).toContainText("The director says: The ending and the middle carry the book.");
  const list = panel.getByRole("list", { name: "Corrections the director asks for" });
  const items = list.locator("[data-book-correction]");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Plant the setup of the ending in the first scene.");
  await expect(items.nth(0)).toContainText("The ending pays off a promise that nothing made.");
  await expect(items.nth(0)).toContainText(POINTS[0]);
  await expect(items.nth(1)).toContainText(POINTS[1]);
  await expect(panel.getByRole("status")).toContainText("Chosen: 2 of 2.");
  const paused = await autopilotFacts(page, BOOK.repo);
  expect(paused?.status).toBe("paused");
  expect(paused?.done.slice(mark), "the director was asked, and nothing was revised").toContain("book-corrections::");
  expect(paused?.done.filter((step) => step.startsWith("revise:"))).toEqual([]);
  // The band says it once: the panel has the words, and the chip says where the review is.
  await expect(page.locator("[data-campaign-book='proposed']:visible").first()).toBeVisible();
  // On a phone, and at 320 px, the panel fits: no sideways scroll, and no page wider than the screen.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await overflowing(panel), `what is wider than the corrections at ${width} px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `the page at ${width} px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await capture(page, "round-proposal", { prepare: async () => { await panel.scrollIntoViewIfNeeded(); } });

  // The words are readable in both themes (WCAG 2.2 AA: 4.5 for text of normal size).
  const readable: Array<[string, ReturnType<Page["locator"]>]> = [
    ["the title", panel.getByRole("heading", { name: "The director asks for corrections of the whole book" })],
    ["the intro", panel.locator("p").first()],
    ["a point the correction answers", items.nth(0).locator("li").first()],
    ["the count", panel.getByRole("status")],
    ["the hint under the buttons", panel.locator("p").last()],
  ];
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    for (const [name, locator] of readable) expect(await contrast(locator), `${name} in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
  }
  await setTheme(page, "light");

  // By the keyboard: the boxes and the two buttons are reached in order. The author leaves chapter 2's correction out, and carries out the other.
  await items.nth(1).getByRole("checkbox").uncheck();
  await expect(panel.getByRole("status")).toContainText("Chosen: 1 of 2.");
  await panel.getByRole("button", { name: "Carry out 1 correction" }).click();

  // Chapter 1 is revised and reviewed again, the director judges the book again (9.2) and the review ends on the target; chapter 2 is as it was.
  const facts = await waitForAutopilot(page, BOOK.repo, ["completed"], 180_000);
  const steps = facts.done.slice(mark);
  expect(steps.filter((step) => step.startsWith("revise:")), steps.join(", ")).toEqual(["revise:1:1"]);
  expect(steps.indexOf("book-corrections::")).toBeLessThan(steps.findIndex((step) => step.startsWith("impact:")));
  expect(steps.filter((step) => step.startsWith("director-review:1:")).length, "chapter 1 was reviewed again").toBeGreaterThanOrEqual(1);
  expect(steps.filter((step) => step.startsWith("director-review:2:")), "chapter 2 was not").toEqual([]);
  expect(steps.at(-1), "the director judged the book last").toBe("final::");
  expect((await filesUnder(page, BOOK.repo, "chapters/002")).map((file) => `${file.path}\n${file.text}`).sort(), "chapter 2 is as the author had it").toEqual(chapterTwo);
  expect(facts.review, "the review's choices did not change the settings of the book").toEqual({ targetScore: 8 });

  // The card: the book reached the target, and what the director asked, with what became of each correction.
  await expect(result.locator("[data-result-review]")).toContainText("the target was reached in 1 round");
  const asked = result.locator("[data-result-book-round]");
  await expect(asked.locator("[data-book-below]")).toHaveCount(0);
  await expect(asked.getByRole("heading", { name: "What the director asked of the book" })).toBeVisible();
  const round = asked.locator("[data-book-round-history='1']");
  await expect(round.locator("summary")).toContainText("Round 1 · the book got 7.4/10 · 2 corrections (carried out: 1, left out: 1)");
  await expect(round.locator("[data-correction-status]")).toHaveText(["carried out", "left out · not chosen"]);
  await expect(round.locator("[data-correction-status] svg")).toHaveCount(2);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    expect(await contrast(round.locator("[data-correction-status='applied']")), `a correction carried out, in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(round.locator("[data-correction-status='left-out']")), `a correction left out, in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(round.locator("summary")), `the round, in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
  }
  await setTheme(page, "light");
  await capture(page, "round-result", { prepare: async () => { await asked.scrollIntoViewIfNeeded(); } });

  // What the state keeps of it: the round, its points and what became of each correction.
  const state = JSON.parse((await filesUnder(page, BOOK.repo, "autopilot/state.json"))[0].text) as { reviews: Array<{ outcome: string; rounds: number; bookRounds: Array<{ round: number; score: number; points: string[]; corrections: Array<{ chapter: number; status: string; why?: string }> }> }> };
  expect(state.reviews.at(-1)).toMatchObject({ outcome: "target", rounds: 1 });
  expect(state.reviews.at(-1)?.bookRounds[0]).toMatchObject({ round: 1, score: 7.4, points: POINTS });
  expect(state.reviews.at(-1)?.bookRounds[0].corrections.map((entry) => [entry.chapter, entry.status, entry.why])).toEqual([[1, "applied", undefined], [2, "left-out", "declined"]]);
  expect(ai.asked.filter((tool) => tool === "book_corrections"), "the director was asked once").toHaveLength(1);
  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});

test("the round for the whole book is chosen in the Review tab, which keeps it, and the new parts say it in Italian and fit a screen 320 px wide", async ({ page }) => {
  const book = await finishedBook();
  const settings = settingsOf(ai.url, [book]);
  settings.ui = { ...settings.ui, language: "it" };
  await seed(page, settings, [book]);
  watchGitHub(page);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await page.setViewportSize({ width: 320, height: 640 });

  // The card of the finished book, in Italian.
  await page.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });
  const result = page.locator("[data-autopilot-result]");
  await expect(result).toBeVisible({ timeout: 30_000 });
  const block = result.locator("[data-result-book-round]");
  await expect(block.getByRole("heading", { name: "Il libro intero" })).toBeVisible({ timeout: 30_000 });
  await expect(block.locator("[data-book-below]")).toContainText("Il voto del libro è sotto l'obiettivo: 7,4/10 (obiettivo 8/10).");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "the page at 320 px").toBeLessThanOrEqual(0);

  // The dialog: the round for the whole book, in Italian, inside it.
  await block.getByRole("button", { name: "Rivedi il libro intero" }).click();
  const dialog = page.getByRole("dialog", { name: "Rivedi di nuovo il libro" });
  await expect(dialog.getByRole("radio", { name: "Mostrami prima le correzioni" })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Chiedi le correzioni del libro" })).toBeEnabled();
  expect(await overflowing(dialog), "what is wider than the dialog, in Italian, at 320 px").toEqual([]);
  expect(await horizontalOverflow(dialog)).toBeLessThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The Review tab: the three ways, chosen and saved, and kept when the page is opened again.
  await page.goto(`app/books/${BOOK.id}/autopilot/settings#autopilot-review`, { waitUntil: "domcontentloaded" });
  const part = page.locator("[data-book-round-field]");
  await expect(part.getByRole("heading", { name: "Il libro intero" })).toBeVisible({ timeout: 30_000 });
  await expect(part.getByRole("radio", { name: "Fermati lì" })).toBeChecked();
  expect(await overflowing(part), "what is wider than the round for the book, in Italian, at 320 px").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "the page at 320 px").toBeLessThanOrEqual(0);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    expect(await contrast(part.getByRole("heading", { name: "Il libro intero" })), `the title, in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(part.locator("#autopilot-review-book-round-apply-hint")), `a line that says what a choice does, in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
  }
  await setTheme(page, "light");
  await part.getByRole("radio", { name: "Correggi il libro" }).check();
  await page.getByRole("button", { name: "Salva" }).first().click();
  await expect.poll(async () => (await autopilotFacts(page, BOOK.repo))?.review).toMatchObject({ bookRound: "apply" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-book-round-field]").getByRole("radio", { name: "Correggi il libro" })).toBeChecked({ timeout: 30_000 });
});
