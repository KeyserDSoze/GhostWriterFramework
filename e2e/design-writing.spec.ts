import { expect, test, type Page } from "@playwright/test";
import { engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";

// From an idea to a written book that follows its design (Phase 5 of #108, item 3 of #125), on a book kept on this device with GitHub out of reach: the Studio designs the
// book from its description, the author approves the design, and the writing autopilot writes it. Every step that plans the scenes of a chapter, writes it, has the
// specialists read it and the director judge it is given the design of that chapter as binding, the ledger of the secret as the spoiler guards of that chapter (what the
// reader knows by then, who does not know it yet, the clue and the red herring to plant there, the reveal of the chapter and its consequences), and the rules of the world.

test.use({ serviceWorkers: "block" });
test.setTimeout(300_000);

const BOOK = { id: "book-design-writing", repo: "e2e-local-design-writing", name: "The Glass Harbor" };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell: a glassmaker's daughter must expose it before the sea wall gives way.";

async function describedBook(): Promise<SeedBook> {
  const { writeOutlineBrief } = await engineModule("index.js");
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: BOOK.name }));
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 300 });
  return { ...BOOK, files: store.toObject() };
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

/** The design of the chapters a request asks for: chapter 1 plants the clue and the red herring of the secret that chapter 2 reveals. */
function chapterDesign(user: string) {
  const range = /numbered (\d+) to (\d+)/.exec(user) ?? /chapters (\d+)-(\d+)/.exec(user);
  const [from, to] = range ? [Number(range[1]), Number(range[2])] : [1, 2];
  const numbers = Array.from({ length: to - from + 1 }, (_, index) => from + index);
  return {
    chapters: numbers.map((number) => ({
      number,
      title: `The Tide ${number}`,
      summary: `Mira follows the lie of the sea wall, step ${number}.`,
      design: {
        goal: `Goal of chapter ${number}.`,
        pov: ["Mira Vale"],
        characters: ["Mira Vale", "Orrin Hale"],
        setting: "Glass Harbor",
        events: [`Event ${number}`],
        scenes: [`The scene of chapter ${number}`],
        reveals: number === 2 ? ["The Wall Is Failing"] : [],
        withholds: number === 1 ? ["Who knew about the wall"] : [],
        clues: number === 1 ? ["Salt water in the cellar"] : [],
        ending: `Chapter ${number} ends on a door closing.`,
        notes: "Keep Orrin calm on the surface.",
      },
    })),
    secrets: numbers.includes(1) ? [{
      title: "The Wall Is Failing",
      revealChapter: 2,
      learnedBy: [{ character: "Mira Vale", chapter: 2 }],
      readerKnows: [{ chapter: 1, note: "Something is wrong with the sea wall." }],
      clues: [{ chapter: 1, note: "Salt water in the cellar." }],
      redHerrings: [{ chapter: 1, note: "The storms are blamed." }],
    }] : [],
  };
}

let ai: StubProvider;
const asked: Array<{ tool: string; user: string }> = [];
test.beforeAll(async () => {
  // What every step asks is kept; the engine's fake answers it, but the design of the chapters.
  const keep = (tool: string) => (user: string) => {
    asked.push({ tool, user });
    return undefined;
  };
  ai = await startProvider({
    answers: { chapter_design: (user) => chapterDesign(user), scene_plan: keep("scene_plan"), chapter_findings: keep("chapter_findings"), director_review: keep("director_review") },
    prose: keep("write"),
  });
});
test.afterAll(async () => { await ai.close(); });

/** How each step names the chapter it is about, in its request. */
const ASKS: Record<string, (chapter: number) => string> = {
  scene_plan: (chapter) => `Break chapter ${chapter} «`,
  write: (chapter) => `of chapter ${chapter} «`,
  chapter_findings: (chapter) => `Review chapter ${chapter} «`,
  director_review: (chapter) => `Decide on chapter ${chapter} «`,
};

/** What the steps of a chapter were asked, by the kind of the step. */
const of = (tool: string, chapter: number) => asked.filter((entry) => entry.tool === tool && entry.user.includes(ASKS[tool](chapter)));

test("an approved design is written as designed: every chapter's design, its spoiler guards and the rules of the world reach the steps that write and judge it", async ({ page }) => {
  const github = watchGitHub(page);
  const book = await describedBook();
  const { openAi } = await seed(page, settingsOf(ai.url, [book]), [book]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // The idea becomes a design of two chapters, which the director approves at the first review.
  await page.goto(`app/books/${BOOK.id}/outline?tab=studio`, { waitUntil: "domcontentloaded" });
  const design = page.getByRole("button", { name: "Design the book with the autopilot" });
  await expect(design).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator("[data-design-mode='plan']")).toHaveText("Design the book will run: it starts from the description of the book.");
  await design.click();
  const dialog = page.getByRole("dialog", { name: "Design the book" });
  await expect(dialog.getByRole("radio", { name: "Design the book" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Review and complete your Synopsis" })).toBeDisabled();
  await dialog.getByLabel("Chapters").fill("2");
  await dialog.getByRole("button", { name: "Design 2 chapters" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await waitForAutopilot(page, BOOK.repo, ["paused"], 180_000);

  // The author approves it, and starts the writing autopilot.
  const ready = page.locator("[data-design-ready]");
  await expect(ready.getByRole("heading", { name: "Design ready" })).toBeVisible({ timeout: 30_000 });
  await ready.getByRole("button", { name: "Approve the design" }).click();
  await expect(ready.locator("[data-design-approved]")).toContainText("You approved this design on");
  await ready.getByRole("button", { name: "Start writing with the autopilot" }).click();
  const facts = await waitForAutopilot(page, BOOK.repo, ["completed"], 240_000);
  expect(facts.done.map((step) => step.split(":")[0])).toContain("write");

  // Chapter 1: the design binds, the secret stays hidden, the clue and the red herring are planted here, Mira does not know yet.
  for (const tool of ["scene_plan", "write", "chapter_findings", "director_review"]) {
    const [first] = of(tool, 1);
    expect(first, `${tool} of chapter 1`).toBeTruthy();
    expect(first.user, tool).toContain("THE DESIGN OF CHAPTER 1 (approved by the author: it binds the chapter; write what it plans):\nNarrative goal: Goal of chapter 1.");
    expect(first.user, tool).toContain("SPOILER GUARDS FOR CHAPTER 1 (from the ledgers of the secrets: they bind):\n- «The Wall Is Failing»: HIDDEN until chapter 2: do not reveal it here.\n  The reader knows by now: Something is wrong with the sea wall.");
    expect(first.user, tool).toContain("Not yet (they must not act on it here): Mira Vale (learns it in chapter 2)");
    expect(first.user, tool).toContain("Clues to plant here: Salt water in the cellar.\n  Red herrings to plant here: The storms are blamed.");
    expect(first.user, tool).toContain("RULES OF THE WORLD (never break them):");
  }
  // Chapter 2: the reveal is the chapter's, with its consequences; the chapter before is read in full.
  const [scenes] = of("scene_plan", 2);
  expect(scenes.user).toContain("«The Wall Is Failing»: revealed to the reader in THIS chapter.");
  expect(scenes.user).toContain("Who knows it by now:");
  expect(scenes.user).toContain("THE CHAPTER BEFORE IN THE SYNOPSIS — Chapter 1 «The Tide 1»:");
  expect(scenes.user).not.toContain("Not yet (they must not act on it here): Mira Vale");

  // What was written is the book's; the secret's ledger is as the design wrote it.
  const prose = (await filesUnder(page, BOOK.repo, "chapters/")).filter((file) => !file.path.endsWith("/chapter.md"));
  expect(prose.length).toBeGreaterThanOrEqual(2);
  const [secret] = await filesUnder(page, BOOK.repo, "secrets/");
  expect(secret.text).toContain("reveal_in: chapter:002-the-tide-2");
  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});
