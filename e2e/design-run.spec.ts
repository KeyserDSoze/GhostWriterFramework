import { expect, test, type Page } from "@playwright/test";
import { autopilotFacts, engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";

// «Design the book with the autopilot» on a book kept on this device, with GitHub out of reach: a book that has only its description is designed from the Studio of the
// Synopsis page. The dialog takes the chapters and the review of the design and says what it will cost; the run makes the concept, the design of every chapter in the
// Synopsis, the world and the secrets with their ledger, the readers and the director review it (the first review sends it back, the second approves it), and the run
// stops there, with no prose. The Studio says the design is ready with what it made, the author approves it, and the Bible and the Synopsis show it.

test.use({ serviceWorkers: "block" });
test.setTimeout(240_000);

const BOOK = { id: "book-design", repo: "e2e-local-design", name: "The Glass Harbor" };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell: a glassmaker's daughter must expose it before the sea wall gives way.";

/** A book with nothing but its description and its brief, made in Node by the engine. */
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

/** The design of the chapters the request asks for, as the engine's fake writes one, for any range (the stub's own fake answers one chapter). */
function chapterDesign(user: string) {
  const range = /numbered (\d+) to (\d+)/.exec(user) ?? /chapters (\d+)-(\d+)/.exec(user);
  const [from, to] = range ? [Number(range[1]), Number(range[2])] : [1, 4];
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
        time: `Day ${number}`,
        events: [`Event ${number}`],
        scenes: [`Scene A of chapter ${number}`, `Scene B of chapter ${number}`],
        conflicts: ["Mira against Orrin"],
        emotions: "From doubt to resolve",
        reveals: number === 2 ? ["The Wall Is Failing"] : [],
        withholds: number < 2 ? ["Who knew about the wall"] : [],
        clues: number === 1 ? ["Salt water in the cellar"] : [],
        previous: number > 1 ? `Picks up chapter ${number - 1}.` : "",
        next: `Sets up chapter ${number + 1}.`,
        ending: `Chapter ${number} ends on a door closing.`,
        cliffhanger: number === 1,
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

let reviews = 0;
let ai: StubProvider;
test.beforeAll(async () => {
  ai = await startProvider({
    answers: {
      chapter_design: (user) => chapterDesign(user),
      design_review: () => {
        reviews += 1;
        return reviews === 1
          ? { verdict: "revise", score: 7, summary: "The reveal costs Mira nothing.", strengths: ["Atmosphere"], changes: [{ chapterNumber: 2, instruction: "Make the reveal cost Mira her trust in her father." }], guidance: [], critical: [], counterProposal: "Reveal the wall in chapter 3, through Orrin." }
          : { verdict: "approve", score: 8.5, summary: "Now the reveal hurts.", strengths: ["Clear stakes"], changes: [], guidance: ["Keep every chapter ending on a turn."], critical: [], counterProposal: "Open on the flood itself." };
      },
    },
  });
});
test.afterAll(async () => { await ai.close(); });

test("a book with only its description is designed from the Studio: the dialog, the reviews, the design ready to approve, and no prose", async ({ page }) => {
  const github = watchGitHub(page);
  const book = await describedBook();
  const { openAi } = await seed(page, settingsOf(ai.url, [book]), [book]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // The Synopsis has only the description: it offers to design the book, in the Studio.
  await page.goto(`app/books/${BOOK.id}/outline`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("tablist", { name: "Synopsis, Bible and Studio" })).toBeVisible({ timeout: 30_000 });
  const cta = page.locator("[data-design-cta]");
  await expect(cta.getByRole("heading", { name: "Design the book with the autopilot" })).toBeVisible();
  await cta.getByRole("button", { name: "Open the Studio" }).click();
  await expect(page).toHaveURL(/\?tab=studio$/);

  // The dialog: the chapters, the review of the design, what it will cost. Nothing starts before the confirmation.
  await page.getByRole("button", { name: "Design the book with the autopilot" }).click();
  const dialog = page.getByRole("dialog", { name: "Design the book" });
  await expect(dialog.getByLabel("Chapters")).toHaveValue("12");
  await dialog.getByLabel("Chapters").fill("4");
  await dialog.getByLabel("Score to reach").fill("8.5");
  await dialog.getByLabel("Reviews of the design").fill("3");
  await expect(dialog.locator("[data-review-estimate]")).toContainText("Estimate of the design");
  expect(await autopilotFacts(page, BOOK.repo), "nothing started before the confirmation").toBeNull();
  await dialog.getByRole("button", { name: "Design 4 chapters" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // The run designs the book and stops at the director's approval: no step that writes.
  const facts = await waitForAutopilot(page, BOOK.repo, ["paused"], 180_000);
  const kinds = facts.done.map((step) => step.split(":")[0]);
  expect(kinds.filter((kind) => kind === "plan-review"), facts.done.join(", ")).toHaveLength(2);
  expect(kinds).toContain("concept");
  expect(kinds).toContain("plan-reader");
  for (const kind of ["scenes", "write", "director-review", "consolidate", "final"]) expect(kinds, kind).not.toContain(kind);

  // The Studio: the design ready, with what it made and its reviews; the author approves it.
  const ready = page.locator("[data-design-ready]");
  await expect(ready.getByRole("heading", { name: "Design ready" })).toBeVisible({ timeout: 30_000 });
  await expect(ready.locator("[data-design-counts]")).toHaveText("4 chapters, 1 secret, 2 world entries", { timeout: 20_000 });
  await expect(ready).toContainText("The director approved it with 8.5/10.");
  await expect(page.locator("[data-design-round]")).toHaveText(["Review 1: 7/10, sent back · readers 7/10", "Review 2: 8.5/10, approved · readers 7/10"]);
  await ready.getByRole("button", { name: "Approve the design" }).click();
  await expect(ready.locator("[data-design-approved]")).toContainText("You approved this design on");
  await expect(ready.getByRole("button", { name: "Start writing with the autopilot" })).toBeEnabled();

  // The files: the Synopsis with the design of every chapter, the world, the secret with its ledger and its reveal, the approval; no scene.
  const outline = await filesUnder(page, BOOK.repo, "outline/");
  const entries = outline.filter((file) => /^outline\/chapters\/\d+\.md$/.test(file.path)).sort((left, right) => left.path.localeCompare(right.path));
  expect(entries.map((file) => file.path)).toEqual(["outline/chapters/001.md", "outline/chapters/002.md", "outline/chapters/003.md", "outline/chapters/004.md"]);
  expect(entries[1].text).toContain("origin: autopilot");
  expect(entries[1].text).toMatch(/design:\n {2}goal: Goal of chapter 2\.\n {2}pov:\n {4}- Mira Vale/);
  expect(outline.find((file) => file.path === "outline/book.md")?.text).toMatch(/design_approved:\n {2}at: .+\n {2}run: .+/);
  const [secret] = await filesUnder(page, BOOK.repo, "secrets/");
  expect(secret.text).toMatch(/clues:\n {2}- chapter: 1\n {4}note: Salt water in the cellar\./);
  expect(secret.text).toContain("reveal_in: chapter:002-the-tide-2");
  expect((await filesUnder(page, BOOK.repo, "bible/")).map((file) => file.path).sort()).toEqual(["bible/themes.md", "bible/world.md"]);
  const chapters = await filesUnder(page, BOOK.repo, "chapters/");
  expect(chapters.map((file) => file.path).filter((path) => !path.endsWith("/chapter.md")), "no prose").toEqual([]);

  // The Bible composes them; the Synopsis shows the design of every entry.
  await page.getByRole("tab", { name: "Bible" }).click();
  const secretCard = page.locator("[data-bible-secret='the-wall-is-failing']");
  await expect(secretCard.locator("[data-secret-reveal]")).toHaveText("Revealed to the reader in chapter 2");
  await expect(secretCard).toContainText("Chapter 1: Salt water in the cellar.");
  await expect(page.locator("[data-bible-checks='none']")).toBeVisible();
  await page.getByRole("tab", { name: "Synopsis" }).click();
  await expect(page.getByRole("button", { name: /Design of chapter 2/ })).toContainText("14 of 17 fields");

  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});
