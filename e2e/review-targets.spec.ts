import { expect, test, type Page } from "@playwright/test";
import { autopilotFacts, engineModule, openApp, seed, settingsOf, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";
import { capture, contrast, horizontalOverflow, overflowing, setTheme } from "./helpers/review-view";

// The targets for the readers, on a book kept on this device with GitHub out of reach. The autopilot finished the book (two chapters the director closed at 9): the readers read chapter 1
// before its corrections and gave it a 6.5, and chapter 2 a 7.5 that no correction followed (its emotional reader gave a 7). The author sets, in the Review tab of the configuration, an
// average of 7.5 for the readers and an 8 for the emotional reader; «Review the book again» takes up both chapters (the director is content with them: the readers are asked). Chapter 2 is
// only read, and meets the targets; chapter 1 is reviewed and read again round after round, and the review stops on a plateau that names the readers, with the card saying each subject
// against its target and the vote of the readers after the corrections, with its round. The pages that are new fit a phone, and a screen 320 px wide, and are readable in both themes.

test.use({ serviceWorkers: "block" });
test.setTimeout(240_000);

const BOOK = { id: "book-targets", repo: "e2e-local-targets", name: "The Glass Harbor" };
const GENERAL = "standard-general";
const EMOTIONAL = "standard-emotional";
const OPTIONS = { readers: true, maxReaders: 2, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

const chapterOf = (text: string): number => Number(/Chapter Title (\d+)/.exec(text)?.[1] ?? "0");

/** The reader a request is for, from the persona the system message gives it. */
const readerOf = (system: string): "general" | "emotional" => (/reader: Emotional Reader\./.test(system) ? "emotional" : "general");

/** What a reader answers: the score of each reader for each chapter, the others as the engine's fake says them. */
const evaluation = (score: number) => ({ generalImpression: "Engaging.", strengths: ["Atmosphere"], weaknesses: ["Pacing"], mostEffectiveMoment: "The confrontation.", mainProblem: "The middle drags.", prioritySuggestion: "Tighten the middle.", score });

/** The director: approves at 9 and, when asked, accepts the first finding so that a scene is corrected (the text changes, and the readers must read it again). */
function director(accept: (chapter: number, turn: number) => boolean, verdicts: (chapter: number, turn: number) => ["approve" | "revise", number]) {
  const turns = new Map<number, number>();
  return {
    review(user: string) {
      const chapter = Number(/Decide on chapter (\d+)/.exec(user)?.[1] ?? "0");
      const turn = turns.get(chapter) ?? 0;
      turns.set(chapter, turn + 1);
      const [verdict, score] = verdicts(chapter, turn);
      const ids = [...user.matchAll(/\[([A-Z]\d+-\d+)\]/g)].map((match) => match[1]);
      const fix = accept(chapter, turn);
      return {
        verdict,
        score,
        summary: "Judged.",
        strengths: [],
        decisions: ids.map((id, index) => ({ findingId: id, action: fix && index === 0 ? "accept" : "reject", rationale: "Because.", remediation: fix && index === 0 ? "Open with Mira already running." : "", sceneNumber: 1 })),
        extraFixes: [],
        guidance: [],
      };
    },
    book: () => ({ verdict: "approve", score: 8.5, summary: "The book as a whole.", strengths: ["Atmosphere"], concerns: [], decisions: [], nextSteps: [], questionsForAuthor: [] }),
  };
}

/** The finished book, made in Node by the engine: chapter 1 is sent back once and read by the readers before its corrections; both close at 9. */
async function finishedBook(): Promise<SeedBook> {
  const { AutopilotSession, writeOutlineBrief } = await engineModule("index.js");
  const { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 2, title: BOOK.name }));
  await writeOutlineBrief(store, { idea: "A harbor town built on glass hides a lie that the tide will tell.", genre: "mystery", audience: "adults", wordsPerScene: 200 });
  const fake = createFakeAutopilotAi({ scenes: 1, words: 120 });
  const voting = director((chapter, turn) => chapter === 1 && turn === 0, (chapter, turn) => (chapter === 1 && turn === 0 ? ["revise", 6] : ["approve", 9]));
  const first = { 1: { general: 5.5, emotional: 7.5 }, 2: { general: 8, emotional: 7 } } as const;
  const reply = (json: unknown) => ({ text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake" });
  const ai = {
    calls: fake.calls,
    async complete(request: { label: string; user: string; system: string; json?: { name?: string } }) {
      if (/^autopilot:director-review:\d+$/.test(request.label)) return reply(voting.review(request.user));
      if (request.label === "director:book") return reply(voting.book());
      if (request.label.startsWith("reader-evaluation:") && request.json?.name === "reader_evaluation") {
        const who = request.label.endsWith(EMOTIONAL) ? "emotional" : "general";
        return reply(evaluation(first[chapterOf(request.user) as 1 | 2][who]));
      }
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
  return { ...BOOK, files: store.toObject() };
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

// In the browser: the director approves every chapter at 9 and accepts a fix, so every review corrects the text. The general reader gives chapter 1 a 6 and chapter 2 an 8,
// the emotional one a 7 and an 8.5: chapter 1 never reaches the average of 7.5 (6.5) nor the 8 asked of the emotional reader, chapter 2 reaches both.
const votes = { 1: { general: 6, emotional: 7 }, 2: { general: 8, emotional: 8.5 } } as const;
const browserDirector = director(() => true, () => ["approve", 9]);
let ai: StubProvider;
test.beforeAll(async () => {
  ai = await startProvider({
    chapters: 1,
    scenes: 1,
    words: 120,
    answers: {
      director_review: (user) => browserDirector.review(user),
      director_opinion: () => browserDirector.book(),
      reader_evaluation: (user, system) => evaluation(votes[chapterOf(user) as 1 | 2]?.[readerOf(system)] ?? 7),
    },
  });
});
test.afterAll(async () => { await ai.close(); });

test("the targets for the readers: set in the Review tab, taken up by «Review the book again», and the review stops on a plateau that names the readers", async ({ page }) => {
  const github = watchGitHub(page);
  const book = await finishedBook();
  const { openAi } = await seed(page, settingsOf(ai.url, [book]), [book]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // The book as it is: the director gave chapter 1 a 9, and the readers a 6.5 on its first draft, before the corrections (the star says so).
  await page.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });
  const result = page.locator("[data-autopilot-result]");
  await expect(result).toBeVisible({ timeout: 30_000 });
  const cell = (chapter: number) => result.getByRole("table", { name: "Scores by chapter" }).locator("tbody tr").nth(chapter - 1).locator("[data-readers-cell]");
  await expect(cell(1)).toHaveAttribute("data-readers-current", "false");
  await expect(cell(1)).toContainText("6.5*");
  await expect(cell(2)).toHaveAttribute("data-readers-current", "true");
  await expect(cell(2)).toContainText("7.5");
  await expect(result.locator("[data-readers-legend='before']")).toBeVisible();
  await expect(result.locator("[data-targets-before]")).toContainText("The readers last read 1 chapter before its corrections");
  await capture(page, "targets-result-before", { prepare: async () => { await result.getByRole("table", { name: "Scores by chapter" }).scrollIntoViewIfNeeded(); } });

  // The Review tab: the average of the readers, and a table of the readers of the book with the weight, the target and whether each counts.
  await page.goto(`app/books/${BOOK.id}/autopilot/settings#autopilot-review`, { waitUntil: "domcontentloaded" });
  const part = page.locator("[data-reader-targets]");
  await expect(part.getByRole("heading", { name: "Readers' targets" })).toBeVisible({ timeout: 30_000 });
  await expect(part.locator("[data-reader-row]")).toHaveCount(2);
  await expect(part.locator("[data-reader-row]")).toContainText(["General Reader", "Emotional Reader"]);
  await part.getByLabel("Readers' average to reach").fill("7.5");
  await part.getByLabel("Target of Emotional Reader").fill("8");
  await capture(page, "targets-review-tab", { prepare: async () => { await part.scrollIntoViewIfNeeded(); } });
  // The same on the page of the configuration: the card of the readers' targets fits a phone, and a screen 320 px wide.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await overflowing(part), `what is wider than the readers' targets at ${width} px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `the page at ${width} px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect.poll(async () => (await autopilotFacts(page, BOOK.repo))?.review).toEqual({ readersTarget: 7.5, readerTargets: { [EMOTIONAL]: 8 } });

  // «Review the book again»: the director is content with both chapters (9), and the readers are not: both are taken up, and the dialog says why.
  await page.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });
  await expect(result).toBeVisible({ timeout: 30_000 });
  await result.getByRole("button", { name: "Review the book again" }).click();
  const dialog = page.getByRole("dialog", { name: "Review the book again" });
  await expect(dialog.getByLabel("Readers' average to reach")).toHaveValue("7.5");
  await expect(dialog.getByLabel("Target of Emotional Reader")).toHaveValue("8");
  await expect(dialog.getByRole("heading", { name: "2 chapters under 8/10 or under a target of the readers will be taken up" })).toBeVisible();
  await expect(dialog.locator("[data-review-chapter]").first()).toContainText("readers 6.5/10");
  await expect(dialog.locator("[data-review-chapter]").first()).toContainText("the director is content with it");
  await expect(dialog.locator("[data-review-estimate]")).toContainText("2 of them only need their readers' vote");
  await expect(dialog.locator("[data-review-readers-delta]")).toContainText("What the readers' targets add");
  // On a phone, and at 320 px, the dialog has no sideways scroll: nothing in it is wider than it is.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await overflowing(dialog), `what is wider than the dialog at ${width} px`).toEqual([]);
    expect(await horizontalOverflow(dialog), `the dialog at ${width} px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.getByLabel("Director's rounds per chapter").fill("1");
  await capture(page, "targets-review-dialog");
  expect((await autopilotFacts(page, BOOK.repo))?.status, "nothing started before the confirmation").toBe("completed");
  const mark = (await autopilotFacts(page, BOOK.repo))?.done.length ?? 0;
  await dialog.getByRole("button", { name: "Review 2 chapters" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // The review goes on until it learns nothing more: chapter 2 is only read (the readers are content), chapter 1 is reviewed and read again, round after round.
  const facts = await waitForAutopilot(page, BOOK.repo, ["completed"], 180_000);
  const steps = facts.done.slice(mark);
  expect(steps.filter((step) => step.startsWith("director-review:2:")), "chapter 2 needed no review: its readers were content").toEqual([]);
  expect(steps.filter((step) => step.startsWith("director-review:1:")).length, steps.join(", ")).toBeGreaterThanOrEqual(2);
  expect(steps.filter((step) => step.startsWith("consolidate:2:")), "and its text was not closed again").toEqual([]);
  expect(facts.review, "the review's targets are the run's: nothing of the review changed them").toEqual({ readersTarget: 7.5, readerTargets: { [EMOTIONAL]: 8 } });
  const kept = facts.rounds[1].slice(-3);
  expect(kept.map((round) => round.reading ?? "director"), "the last review of chapter 1: the readers alone, the director, the readers on the corrected text").toEqual(["check", "director", "end"]);
  expect(facts.rounds[1].at(-1)).toMatchObject({ reading: "end", readerVotes: { [GENERAL]: 6, [EMOTIONAL]: 7 }, readers: 6.5 });
  expect(facts.rounds[2].at(-1)).toMatchObject({ reading: "check", readerVotes: { [GENERAL]: 8, [EMOTIONAL]: 8.5 } });

  // The card: how the review ended, each subject against its target, and the vote of the readers after the corrections, with its round and no star.
  await expect(result.locator("[data-result-review]")).toContainText("stopped after 3 rounds");
  const targets = result.locator("[data-result-targets]");
  await expect(targets.locator("[data-target-row='director'] [data-target-status]")).toHaveAttribute("data-target-status", "reached");
  await expect(targets.locator("[data-target-row='average'] [data-target-status]")).toHaveAttribute("data-target-status", "missed");
  await expect(targets.locator("[data-target-row='average']")).toContainText("7.5/10");
  await expect(targets.locator(`[data-target-row='${EMOTIONAL}'] [data-target-status]`)).toHaveAttribute("data-target-status", "missed");
  await expect(targets.locator("[data-targets-before]")).toBeHidden();
  await expect(cell(1)).toHaveAttribute("data-readers-current", "true");
  await expect(cell(1)).toContainText("6.5");
  await expect(cell(1).locator("[data-readers-before]")).toHaveCount(0);
  await expect(cell(1).locator("[data-readers-round]")).toHaveText("r1");
  await expect(cell(2)).toContainText("8.3");

  // The words of the new parts are readable in both themes (WCAG 2.2 AA: 4.5 for text of normal size), and the status of each target is words with an icon, not colour.
  const status = targets.locator("[data-target-row='average'] [data-target-status]");
  await expect(status).toContainText("Not reached");
  await expect(status.locator("svg")).toHaveCount(1);
  const readable: Array<[string, ReturnType<Page["locator"]>]> = [
    ["the status of a target", status],
    ["the round of a reading", cell(1).locator("[data-readers-round]")],
    ["the note under the targets", targets.locator("p").first()],
    ["the vote of the readers", cell(2)],
  ];
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    for (const [name, locator] of readable) expect(await contrast(locator), `${name} in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
  }
  await setTheme(page, "light");
  await capture(page, "targets-result", { prepare: async () => { await targets.scrollIntoViewIfNeeded(); } });
  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});

test("the new parts say it in Italian and still fit a screen 320 px wide", async ({ page }) => {
  const book = await finishedBook();
  const settings = settingsOf(ai.url, [book]);
  settings.ui = { ...settings.ui, language: "it" };
  await seed(page, settings, [book]);
  watchGitHub(page);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await page.setViewportSize({ width: 320, height: 640 });

  // The card of the finished book: what stands against the targets, and the vote of the readers with its words, in a table that scrolls inside its own region.
  await page.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });
  const result = page.locator("[data-autopilot-result]");
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result.getByRole("heading", { name: "Rispetto agli obiettivi" })).toBeVisible();
  await expect(result.locator("[data-targets-before]")).toContainText("I lettori hanno letto l'ultima volta 1 capitolo prima delle sue correzioni");
  await expect(result.getByRole("table", { name: "Voti per capitolo" }).locator("[data-readers-cell]").first()).toContainText("6,5*");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "the page at 320 px").toBeLessThanOrEqual(0);

  // «Rivedi di nuovo il libro»: the readers' targets, in Italian, inside the dialog.
  await result.getByRole("button", { name: "Rivedi di nuovo il libro" }).click();
  const dialog = page.getByRole("dialog", { name: "Rivedi di nuovo il libro" });
  await expect(dialog.getByRole("heading", { name: "Obiettivi dei lettori" })).toBeVisible();
  await expect(dialog.getByLabel("Media dei lettori da raggiungere")).toBeVisible();
  expect(await overflowing(dialog), "what is wider than the dialog, in Italian, at 320 px").toEqual([]);
  expect(await horizontalOverflow(dialog)).toBeLessThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The Review tab: the same part, with the table of the readers.
  await page.goto(`app/books/${BOOK.id}/autopilot/settings#autopilot-review`, { waitUntil: "domcontentloaded" });
  const part = page.locator("[data-reader-targets]");
  await expect(part.getByRole("heading", { name: "Obiettivi dei lettori" })).toBeVisible({ timeout: 30_000 });
  await expect(part.locator("[data-reader-row]")).toHaveCount(2);
  expect(await overflowing(part), "what is wider than the readers' targets, in Italian, at 320 px").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "the page at 320 px").toBeLessThanOrEqual(0);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    expect(await contrast(part.getByRole("heading", { name: "Obiettivi dei lettori" })), `the title, in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
  }
});
