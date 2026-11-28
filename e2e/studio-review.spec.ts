import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { autopilotFacts, engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";
import { autopilotState, chapterDesign, describedBook, watchGitHub } from "./helpers/design";

// The reviews of a design in the Studio of the Synopsis, on a book kept on this device with GitHub out of reach and a stub provider: the author asks for three alternative pitches and for the
// choice to be hers, the Brainstormer of the book proposes them, the readers and the director judge them, and the run waits for her. She chooses another pitch than the director's, and the design
// goes on from it: a panel reviews every chapter, a specialist analyses the structure, the director sends the design back once and approves it. The Studio shows the rubric of every subject and the
// finding that is left; she asks the autopilot to fix it with one click, a round rewrites the chapters it requires and the finding is fixed. She asks for a review of the whole design and of one
// chapter, and approves the design. Nothing is written but the design, and nothing goes to GitHub or to the provider of the book's own account.

test.use({ serviceWorkers: "block" });
test.setTimeout(360_000);

const BOOK = { id: "book-studio-review", repo: "e2e-local-studio-review", name: "The Glass Harbor" };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell: a glassmaker's daughter must expose it before the sea wall gives way.";
const FINDING = "Orrin knows about the wall in chapter 2 but asks Mira about it in chapter 3.";
const SHOTS = process.env.STUDIO_SHOTS_DIR;

type Sheet = { width: number; height: number; scheme: "light" | "dark" };
const SHEETS: Sheet[] = [
  { width: 390, height: 844, scheme: "light" },
  { width: 390, height: 844, scheme: "dark" },
  { width: 1280, height: 800, scheme: "light" },
  { width: 1280, height: 800, scheme: "dark" },
];

/**
 * Captures of what the author sees, on a phone and on a desktop, in the light and in the dark, when `STUDIO_SHOTS_DIR` names a folder (nothing is written otherwise). The page scrolls in a
 * container of its own, so a target taller than the window is shown from its top, a window at a time (at most five).
 */
async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const original = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const sheet of SHEETS) {
    await page.setViewportSize({ width: sheet.width, height: sheet.height });
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), sheet.scheme === "dark");
    await page.waitForTimeout(400);
    const base = join(SHOTS, `${name}-${sheet.width}x${sheet.height}-${sheet.scheme}`);
    if (!target) {
      await page.screenshot({ path: `${base}.png` });
      continue;
    }
    await target.evaluate((element) => element.scrollIntoView({ block: "start" }));
    const height = await target.evaluate((element) => element.getBoundingClientRect().height);
    const step = sheet.height - 140;
    const shots = Math.min(5, Math.max(1, Math.ceil(height / step)));
    for (let shot = 1; shot <= shots; shot += 1) {
      await page.waitForTimeout(150);
      await page.screenshot({ path: shots === 1 ? `${base}.png` : `${base}-${shot}.png` });
      await target.evaluate((element, by) => {
        let node: HTMLElement | null = element.parentElement;
        while (node && !(node.scrollHeight > node.clientHeight && /(auto|scroll)/.test(getComputedStyle(node).overflowY))) node = node.parentElement;
        node?.scrollBy(0, by);
      }, step);
    }
  }
  await page.setViewportSize(original);
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

/** The steps of the log that succeeded, by kind: how many times the autopilot made each one. */
const countOf = (done: string[], kind: string) => done.filter((step) => step.split(":")[0] === kind).length;

let ai: StubProvider;
let directorReviews = 0;
let coherenceCalls = 0;
const prompts = { pitches: [] as string[], concept: [] as string[] };
/** How many times the design of each chapter was written: a chapter written again says so, so that what the specialist reads has changed. */
const designed: Record<number, number> = {};

test.beforeAll(async () => {
  const { fakeRubric } = await engineModule("testing/index.js");
  ai = await startProvider({
    answers: {
      chapter_design: (user) => {
        const reply = chapterDesign(user);
        for (const chapter of reply.chapters) {
          designed[chapter.number] = (designed[chapter.number] ?? 0) + 1;
          if (designed[chapter.number] > 1) chapter.summary += ` After the revision ${designed[chapter.number] - 1}, the reveal costs Mira her trust in her father.`;
        }
        return reply;
      },
      // What the pitches are proposed in (the Brainstormer's own voice), and what the concept is made of.
      design_pitches: (_user, system) => { prompts.pitches.push(system); return undefined; },
      design_concept: (user) => { prompts.concept.push(user); return undefined; },
      // The panel judges every chapter: in its first round the second chapter is weak, and the rest holds.
      design_chapter_review: (user) => {
        const round = Number(/Round (\d+) of the design/.exec(user)?.[1] ?? "1");
        const section = user.slice(user.indexOf("CHAPTERS UNDER REVIEW:"));
        const chapters = [...section.matchAll(/^Chapter (\d+)(?: \(the author's entry: binding\))?:$/gm)].map((match) => Number(match[1]));
        return {
          chapters: chapters.map((chapterNumber) => {
            const weak = chapterNumber === 2 && round === 1;
            return { chapterNumber, verdict: weak ? "revise" : "ok", summary: weak ? "The reveal costs Mira nothing." : `Chapter ${chapterNumber} holds.`, rubric: fakeRubric(weak ? { tension: 5.5, emotion: 6 } : 8, { applicable: true }) };
          }),
        };
      },
      // The specialist finds one thing that does not hold together, and finds it again until the chapters it requires are rewritten for it.
      design_coherence: () => {
        coherenceCalls += 1;
        return coherenceCalls <= 2
          ? { findings: [{ severity: "major", kind: "contradiction", chapters: [2, 3], requires: [2, 3], text: FINDING, proposal: "Have Orrin hide what he knows until chapter 3." }], summary: "The structure mostly holds." }
          : { findings: [], summary: "The structure holds together." };
      },
      // The director sends the design back once, and approves it after.
      design_review: () => {
        directorReviews += 1;
        const base = { strengths: ["Atmosphere"], guidance: ["Keep every chapter ending on a turn."], critical: [], counterProposal: "Open on the flood itself.", findingDecisions: [] };
        return directorReviews === 1
          ? { ...base, verdict: "revise", score: 7, summary: "The reveal costs Mira nothing.", changes: [{ chapterNumber: 2, instruction: "Make the reveal cost Mira her trust in her father." }], rubric: fakeRubric({ originality: 8, tension: 5.5, emotion: 6 }) }
          : { ...base, verdict: "approve", score: 8.5, summary: "Now the reveal hurts.", changes: [], rubric: fakeRubric(8.5) };
      },
    },
  });
});
test.afterAll(async () => { await ai.close(); });

test.beforeEach(() => {
  directorReviews = 0;
  coherenceCalls = 0;
  prompts.pitches.length = 0;
  prompts.concept.length = 0;
  for (const number of Object.keys(designed)) delete designed[Number(number)];
});

/** A book whose Brainstormer is the author's own: a name, a boldness and what it refuses. */
async function bookWithBrainstormer(): Promise<SeedBook> {
  const { BRAINSTORMER_FILE, defaultBrainstormer, serializeBrainstormer } = await engineModule("index.js");
  const book = await describedBook(BOOK, IDEA);
  const profile = { ...defaultBrainstormer("en"), name: "Nora Vance", boldness: 9, avoid: ["The butler did it"] };
  return { ...book, files: { ...book.files, [BRAINSTORMER_FILE]: serializeBrainstormer(profile) } };
}

test("the author chooses among alternative pitches, the design is reviewed chapter by chapter and as a whole, a finding is fixed with one click, and the design is approved", async ({ page }) => {
  const github = watchGitHub(page);
  const book = await bookWithBrainstormer();
  const { openAi } = await seed(page, settingsOf(ai.url, [book]), [book]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // The Studio of a Synopsis that has only the description: the dialog offers the reviews, all on, and says what they cost.
  await page.goto(`app/books/${BOOK.id}/outline?tab=studio`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("tablist", { name: "Synopsis, Bible and Studio" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-design-reviews]"), "nothing of the reviews while there is no chapter and no review").toHaveCount(0);
  await page.getByRole("button", { name: "Design the book with the autopilot" }).click();
  const dialog = page.getByRole("dialog", { name: "Design the book" });
  const reviews = dialog.getByRole("group", { name: "Alternatives and reviews" });
  await expect(reviews.getByRole("checkbox")).toHaveCount(4);
  for (const box of await reviews.getByRole("checkbox").all()) await expect(box).toBeChecked();
  await expect(reviews.getByLabel("How many pitches")).toHaveValue("3");
  await expect(reviews.getByRole("radio", { name: "The director", exact: true })).toBeChecked();
  const estimate = dialog.locator("[data-review-estimate]");
  await expect(estimate).toContainText("Estimate of the design");
  await shoot(page, "dialog", reviews);

  // What the reviews add is in the estimate: a box off takes its calls out, and on brings them back.
  const calls = async () => Number((/(\d+)(?: to (\d+))? AI calls/.exec((await estimate.textContent()) ?? "") ?? []).slice(1).filter(Boolean).pop());
  const all = await calls();
  expect(all).toBeGreaterThan(0);
  await reviews.getByRole("checkbox", { name: "Analyse the whole structure" }).uncheck();
  await expect.poll(calls).toBeLessThan(all);
  await reviews.getByRole("checkbox", { name: "Analyse the whole structure" }).check();
  await expect.poll(calls).toBe(all);

  // A count the engine would refuse is said, and the design cannot start with it.
  await reviews.getByLabel("How many pitches").fill("9");
  await expect(reviews.getByText("A whole number from 2 to 6.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Design \d+ chapters$/ })).toBeDisabled();
  await reviews.getByLabel("How many pitches").fill("3");
  await reviews.getByRole("radio", { name: "Me", exact: true }).check();
  await dialog.getByLabel("Chapters", { exact: true }).fill("4");
  await dialog.getByLabel("Score to reach").fill("8.5");
  await dialog.getByLabel("Reviews of the design", { exact: true }).fill("3");
  expect(await autopilotFacts(page, BOOK.repo), "nothing started before the confirmation").toBeNull();
  await dialog.getByRole("button", { name: "Design 4 chapters" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // The Brainstormer proposes three pitches in its own voice, the readers and the director judge them, and the run waits for the author: nothing is designed before she chooses.
  const waiting = await waitForAutopilot(page, BOOK.repo, ["waiting-author"], 120_000);
  const waitingKinds = waiting.done.map((step) => step.split(":")[0]);
  expect(waitingKinds, waiting.done.join(", ")).toContain("design-pitches");
  expect(waitingKinds).toContain("design-pitch-review");
  for (const kind of ["concept", "plan", "design-chapter-review", "design-coherence", "plan-review"]) expect(waitingKinds, kind).not.toContain(kind);
  expect(prompts.pitches[0], "the pitches are proposed by the Brainstormer of the book").toMatch(/Brainstormer: Nora Vance\./);
  expect(prompts.pitches[0]).toContain("Boldness: 9/10");
  expect(prompts.pitches[0]).toContain("The butler did it");

  const alternatives = page.locator("[data-design-alternatives]");
  await expect(alternatives.getByRole("heading", { name: "Alternative pitches" })).toBeVisible({ timeout: 30_000 });
  await expect(alternatives.locator("[data-pitch]")).toHaveCount(3);
  await expect(alternatives.locator("[data-pitch-waiting]")).toContainText("The director recommends");
  await expect(alternatives.locator("[data-pitch][data-pitch-chosen]")).toHaveCount(0);
  const recommended = await alternatives.locator("[data-pitch]").filter({ hasText: "Recommended by the director" }).getAttribute("data-pitch");
  expect(recommended).not.toBeNull();
  const progress = page.locator("[data-design-progress]");
  await expect(progress).toContainText("The design waits for you to choose a pitch.");
  await expect(progress.getByRole("button", { name: "Go on with the design" })).toBeDisabled();
  await shoot(page, "alternatives-waiting", alternatives);

  // The live page does not take the wait for a profile to be corrected: it says what the design waits for, and leads to the Studio.
  const live = await page.context().newPage();
  await live.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });
  await expect(live.locator("[data-design-choice-notice]").getByRole("heading", { name: "Waiting for you: choose the pitch the book is designed from" })).toBeVisible({ timeout: 30_000 });
  await expect(live.getByText("there are problems in the profile files")).toHaveCount(0);
  await expect(live.locator("[data-design-choice-notice]").getByRole("link", { name: "Choose the pitch in the Studio" })).toHaveAttribute("href", /\/outline\?tab=studio$/);
  await live.close();

  // She chooses another pitch than the director's, and goes on.
  const chosen = recommended === "p1" ? "p2" : "p1";
  await alternatives.locator(`[data-pitch-choose='${chosen}']`).click();
  await expect(alternatives.locator("[data-pitch-selection]")).toHaveText("Chosen by you.");
  await expect(alternatives.locator(`[data-pitch='${chosen}']`)).toHaveAttribute("data-pitch-chosen", "");
  await expect(progress.getByRole("button", { name: "Go on with the design" })).toBeEnabled();
  await progress.getByRole("button", { name: "Go on with the design" }).click();

  // The design goes on from her pitch: the concept, the chapters, the readers, the panel's review of every chapter, the specialist's analysis, and two reviews of the director.
  const first = await waitForAutopilot(page, BOOK.repo, ["paused"], 240_000);
  expect(first.lastError).toBeNull();
  const ready = page.locator("[data-design-ready]");
  await expect(ready.getByRole("heading", { name: "Design ready" })).toBeVisible({ timeout: 30_000 });
  expect(prompts.concept[0], "the concept is made of the pitch the author chose").toMatch(new RegExp(`THE CHOSEN PITCH \\(the author chose it\\)\\. Develop the book from this pitch, in its own direction:\\nPitch ${chosen}: «`));
  const kinds = first.done.map((step) => step.split(":")[0]);
  expect(kinds.filter((kind) => kind === "plan-review"), first.done.join(", ")).toHaveLength(2);
  expect(countOf(first.done, "design-pitches"), "the pitches are proposed once").toBe(1);
  expect(kinds).toContain("design-chapter-review");
  expect(countOf(first.done, "design-coherence")).toBe(2);
  for (const kind of ["scenes", "write", "director-review", "consolidate", "final"]) expect(kinds, kind).not.toContain(kind);
  await expect(ready).toContainText("The director approved it with 8.5/10.");

  // The rubric of every subject: the design with its twelve criteria and how it went, the readers, the chapters with the panel's verdicts, the pitches.
  const rubric = page.locator("[data-design-rubric]");
  await expect(rubric.getByRole("heading", { name: "How the design is judged" })).toBeVisible();
  const design = rubric.locator("[data-rubric-subject='design']");
  await expect(design.getByRole("table", { name: "The twelve criteria of The design, by the director" }).getByRole("row")).toHaveCount(13);
  await expect(design.locator("[data-rubric-trend]")).toHaveAttribute("data-rubric-trend", "up");
  await expect(design).toContainText("Review 1:");
  await expect(design).toContainText("Review 2:");
  await expect(rubric.locator("[data-rubric-subject^='reader:']").first()).toBeVisible();
  const second = rubric.locator("[data-rubric-subject='chapter:2']");
  await expect(second).toContainText("Chapter 2 «The Tide 2»");
  await expect(rubric.locator("[data-rubric-subject^='pitch:']")).toHaveCount(3);

  // The finding that is left: what is wrong, where, which chapters to revise and what to do. A major one does not block the approval.
  const findings = page.locator("[data-design-findings]");
  await expect(findings.locator("[data-findings-counts]")).toHaveText("0 critical, 1 major, 0 minor");
  const finding = findings.locator("[data-finding]");
  await expect(finding).toHaveCount(1);
  await expect(finding).toContainText("Major");
  await expect(finding).toContainText("Contradiction");
  await expect(finding).toContainText("Chapters 2, 3");
  await expect(finding).toContainText(FINDING);
  await expect(finding).toContainText("What to do: Have Orrin hide what he knows until chapter 3.");
  await expect(finding).toContainText("To fix it, revise: chapters 2, 3");
  await expect(finding.getByRole("button")).toHaveText(["Ask the autopilot to fix it", "I'll handle it", "Not a problem"]);
  await shoot(page, "studio-ready", page.locator("[data-design-reviews]"));

  // One click: the decision is saved and a design round rewrites the chapters the finding requires, judges them again, and the structure is analysed again.
  const before = first.done.length;
  await finding.getByRole("button", { name: "Ask the autopilot to fix it" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The design round has begun." })).toBeAttached({ timeout: 20_000 });
  await expect.poll(async () => {
    const state = await autopilotState(page, BOOK.repo);
    const facts = await autopilotFacts(page, BOOK.repo);
    return state?.status === "paused" && (facts?.done.length ?? 0) > before && state.design?.coherence?.findings.every((entry: { status: string }) => entry.status === "fixed") === true;
  }, { timeout: 240_000, intervals: [500] }).toBe(true);
  const fixed = await waitForAutopilot(page, BOOK.repo, ["paused"], 60_000);
  expect(fixed.lastError).toBeNull();
  expect(countOf(fixed.done, "design-coherence"), "the structure was analysed again after the rewrite").toBeGreaterThan(2);
  expect(countOf(fixed.done, "design-pitches"), "the pitches are not proposed again").toBe(1);
  await expect(findings.locator("[data-findings-none], [data-finding-group='fixed']").first()).toBeAttached({ timeout: 30_000 });
  await expect(findings.locator("[data-finding-group='open']")).toHaveCount(0);
  const fixedGroup = findings.locator("[data-finding-group='fixed']");
  await expect(fixedGroup).toContainText("Fixed (1)");
  await fixedGroup.locator("summary").click();
  await expect(fixedGroup.locator("[data-finding]")).toContainText(FINDING);
  await shoot(page, "findings-fixed", findings);

  // A review on request of the whole design, and of one chapter: the design is judged as it is, nothing is designed, nothing is written, and the run stops.
  const request = page.locator("[data-design-review-request]");
  await expect(request.getByRole("heading", { name: "Review the design" })).toBeVisible();
  const designed = countOf(fixed.done, "plan") + countOf(fixed.done, "replan") + countOf(fixed.done, "revise");
  const chapterReviews = countOf(fixed.done, "design-chapter-review");
  await shoot(page, "review-request", request);
  await request.getByRole("button", { name: "Review the whole design" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The review of the design has begun." })).toBeAttached({ timeout: 20_000 });
  await expect.poll(async () => countOf((await autopilotFacts(page, BOOK.repo))?.done ?? [], "design-chapter-review"), { timeout: 120_000, intervals: [500] }).toBeGreaterThan(chapterReviews);
  const reviewed = await waitForAutopilot(page, BOOK.repo, ["paused"], 120_000);
  expect(reviewed.lastError).toBeNull();
  expect(countOf(reviewed.done, "plan") + countOf(reviewed.done, "replan") + countOf(reviewed.done, "revise"), "a review designs nothing").toBe(designed);
  expect((await autopilotState(page, BOOK.repo))?.design?.reviewing, "the review on request is what the state says").toMatchObject({ startedAt: expect.any(String) });
  await request.getByLabel("Chapter", { exact: true }).selectOption("3");
  const chaptersBefore = countOf(reviewed.done, "design-chapter-review");
  await request.getByRole("button", { name: "Review this chapter", exact: true }).click();
  await expect.poll(async () => countOf((await autopilotFacts(page, BOOK.repo))?.done ?? [], "design-chapter-review"), { timeout: 120_000, intervals: [500] }).toBeGreaterThan(chaptersBefore);
  await waitForAutopilot(page, BOOK.repo, ["paused"], 120_000);
  await expect(request.getByRole("button", { name: "Review the whole design" })).toBeEnabled({ timeout: 30_000 });

  // The author approves the design; the files hold the design and nothing else: no prose, no scene.
  await ready.getByRole("button", { name: "Approve the design" }).click();
  await expect(ready.locator("[data-design-approved]")).toContainText("You approved this design on");
  const outline = await filesUnder(page, BOOK.repo, "outline/");
  expect(outline.filter((file) => /^outline\/chapters\/\d+\.md$/.test(file.path)).map((file) => file.path).sort()).toEqual(["outline/chapters/001.md", "outline/chapters/002.md", "outline/chapters/003.md", "outline/chapters/004.md"]);
  expect(outline.find((file) => file.path === "outline/book.md")?.text).toMatch(/design_approved:\n {2}at: .+\n {2}run: .+/);
  const chapters = await filesUnder(page, BOOK.repo, "chapters/");
  expect(chapters.map((file) => file.path).filter((path) => !path.endsWith("/chapter.md")), "no prose").toEqual([]);
  const state = await autopilotState(page, BOOK.repo);
  expect(state?.design?.alternatives?.selected).toMatchObject({ id: chosen, by: "author" });
  expect(Object.keys(state?.design?.rubric ?? {})).toEqual(expect.arrayContaining(["design", "chapter:1", "chapter:2", "chapter:3", "chapter:4", `pitch:${chosen}`]));
  await shoot(page, "studio-approved", page.locator("[data-design-ready]"));

  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});

test("the Brainstormer has a page like the director's: its sheet is saved in the book as brainstormer.md, and the design run reads it", async ({ page }) => {
  const github = watchGitHub(page);
  const book = await describedBook(BOOK, IDEA);
  await seed(page, settingsOf(ai.url, [book]), [book]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // The entry is in the Profiles group of the menu of the book, and leads to the page.
  await page.goto(`app/books/${BOOK.id}`, { waitUntil: "domcontentloaded" });
  const entry = page.getByRole("link", { name: "Brainstormer", exact: true });
  await expect(entry.first()).toBeVisible({ timeout: 30_000 });
  await entry.first().click();
  await expect(page).toHaveURL(new RegExp(`/app/books/${BOOK.id}/brainstormer$`));
  await expect(page.getByRole("heading", { level: 1, name: "The Brainstormer" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("This book has no Brainstormer of its own yet")).toBeVisible();
  await shoot(page, "brainstormer", page.locator("main"));

  // The sheet: a name, how bold it is, what it refuses. Saving writes the file in the book.
  await page.getByLabel("Name", { exact: true }).fill("Nora Vance");
  await page.getByLabel("Boldness", { exact: true }).fill("9");
  await expect(page.getByRole("slider", { name: "Boldness" })).toHaveAttribute("aria-valuetext", "9 out of 10, proposes the version nobody would write");
  await page.getByLabel("Clichés and devices it refuses").fill("The butler did it\nA dream ending");
  await page.getByRole("button", { name: "Save the Brainstormer" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The Brainstormer is saved" }).first()).toBeVisible({ timeout: 20_000 });
  const [file] = await filesUnder(page, BOOK.repo, "brainstormer.md");
  expect(file.text).toMatch(/^---\n[\s\S]*name: Nora Vance[\s\S]*boldness: 9[\s\S]*- The butler did it\n {2}- A dream ending[\s\S]*---/);

  // The design run reads it: the pitches are proposed in its voice, with what it refuses.
  await page.goto(`app/books/${BOOK.id}/outline?tab=studio`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Design the book with the autopilot" }).click();
  const dialog = page.getByRole("dialog", { name: "Design the book" });
  await dialog.getByRole("radio", { name: "Me", exact: true }).check();
  await dialog.getByRole("button", { name: /^Design \d+ chapters$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await waitForAutopilot(page, BOOK.repo, ["waiting-author"], 120_000);
  expect(prompts.pitches[0]).toMatch(/Brainstormer: Nora Vance\./);
  expect(prompts.pitches[0]).toContain("Boldness: 9/10");
  expect(prompts.pitches[0]).toContain("A dream ending");
  expect(github, "no request went to GitHub").toEqual([]);
});
