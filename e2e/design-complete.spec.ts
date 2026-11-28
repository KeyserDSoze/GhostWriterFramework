import { expect, test, type Page } from "@playwright/test";
import { autopilotFacts, engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";

// «Review and complete» (#125) on a book kept on this device, with GitHub out of reach: every chapter of the book is the author's in the Synopsis, each with part of its
// design (as a long paste leaves it). The Studio says which design runs and why before it starts; the run reads the chapters, the readers and the director review what it
// proposes, and it stops with the proposals waiting; nothing of the author's is written until the author applies the ones chosen, in one commit, recorded in the journal of
// the Synopsis as the autopilot's. The overview of the autopilot then says that the Synopsis binds over the plot of the brief, and empties it on request.

test.use({ serviceWorkers: "block" });
test.setTimeout(240_000);

const BOOK = { id: "book-complete", repo: "e2e-local-complete", name: "The Glass Harbor" };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell: a glassmaker's daughter must expose it before the sea wall gives way.";
const PLOT = "Chapter 1: Mira finds the crack.\nChapter 2: the council lies.\nChapter 3: the wall gives way.";
/** Seven of the seventeen fields of a design, as the long paste of the author's Synopsis gives them. */
const PASTED = { goal: "Mira finds the crack.", pov: ["Mira Vale"], characters: ["Mira Vale", "Orrin Hale"], events: ["Mira dives under the wall"], conflicts: ["Mira against the tide"], ending: "She surfaces with a shard.", notes: "Keep it cold." };

/** A book whose three chapters the author wrote in the Synopsis, with a description and a brief that still has its chapter-by-chapter plot. */
async function writtenBook(): Promise<SeedBook> {
  const { writeOutlineBrief, serializeOutlineChapter, outlineChapterPath } = await engineModule("index.js");
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: BOOK.name }));
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 300, synopsis: PLOT });
  const changes = [1, 2, 3].map((number) => ({
    path: outlineChapterPath(number),
    content: serializeOutlineChapter({ number, title: `The Tide ${number}`, body: `What happens in chapter ${number}: Mira follows the water to the wall.`, ...(number === 2 ? {} : { design: PASTED }), origin: "author" }),
    expectedHash: null,
  }));
  await store.commit(changes, "The author's Synopsis");
  return { ...BOOK, files: store.toObject() };
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

let ai: StubProvider;
const asked: Record<string, string[]> = {};
test.beforeAll(async () => {
  // What the run asks is kept; the engine's fake answers it (an answer of `undefined` is the fake's).
  const keep = (tool: string) => (user: string) => {
    (asked[tool] ??= []).push(user);
    return undefined;
  };
  ai = await startProvider({ answers: { chapter_completion: keep("chapter_completion"), completion_review: keep("completion_review") } });
});
test.afterAll(async () => { await ai.close(); });

test("a book whose every chapter is the author's is reviewed and completed: the Studio says why, the proposals wait, and one apply writes only the chosen ones", async ({ page }) => {
  const github = watchGitHub(page);
  const book = await writtenBook();
  const before = Object.fromEntries(Object.entries(book.files).filter(([path]) => path.startsWith("outline/chapters/")));
  const { openAi } = await seed(page, settingsOf(ai.url, [book]), [book]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // The Studio says which design runs and why, before anything starts.
  await page.goto(`app/books/${BOOK.id}/outline?tab=studio`, { waitUntil: "domcontentloaded" });
  const start = page.getByRole("button", { name: "Review and complete the book" });
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator("[data-design-mode='complete']")).toHaveText("Review and complete will run: every chapter of the book is yours in the Synopsis (3), so they are reviewed and what their design lacks is proposed, without planning the book again.");
  await start.click();
  const dialog = page.getByRole("dialog", { name: "Design the book" });
  await expect(dialog.getByRole("radio", { name: "Review and complete your Synopsis" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Design the book" })).not.toBeChecked();
  await expect(dialog.locator("[data-design-mode-reason]")).toHaveText("Every chapter of the book (1 to 3) is written by you in the Synopsis: Review and complete reviews them and plans nothing again.");
  await expect(dialog.getByLabel("Chapters")).toHaveCount(0);
  await expect(dialog.locator("[data-review-estimate]")).toContainText("Estimate of the design");
  expect(await autopilotFacts(page, BOOK.repo), "nothing started before the confirmation").toBeNull();
  await dialog.getByRole("button", { name: "Review and complete 3 chapters" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // The run reviews and completes: no concept, no plan, no prose.
  const facts = await waitForAutopilot(page, BOOK.repo, ["paused"], 180_000);
  const kinds = facts.done.map((step) => step.split(":")[0]);
  expect(kinds, facts.done.join(", ")).toContain("design-complete");
  expect(kinds).toContain("design-complete-reader");
  expect(kinds.filter((kind) => kind === "design-complete-review")).toHaveLength(1);
  for (const kind of ["concept", "plan", "plan-review", "scenes", "write"]) expect(kinds, kind).not.toContain(kind);
  expect(asked.chapter_completion?.[0]).toContain("MISSING FIELDS: setting, time, scenes, emotions, reveals, withholds, clues, previous, next, cliffhanger");
  expect(asked.completion_review?.[0]).toContain("The author's text binds: never ask to change what happens in a chapter");
  const untouched = await filesUnder(page, BOOK.repo, "outline/chapters/");
  for (const file of untouched) expect(file.text, `${file.path} is the author's until the proposals are applied`).toBe(before[file.path]);

  // The proposals, chapter by chapter: the author leaves the planned scenes of chapter 1 out, and applies the rest that is chosen.
  const proposals = page.locator("[data-design-proposals]");
  await expect(proposals).toHaveAttribute("data-design-proposals", "waiting", { timeout: 30_000 });
  await expect(proposals.getByRole("heading", { name: "Proposals of Review and complete" })).toBeVisible();
  const one = proposals.locator("[data-proposals-chapter='1']");
  await one.locator("summary").click();
  await expect(one.getByRole("checkbox", { name: /^Setting/ })).toBeChecked();
  await expect(one.locator("[data-proposal^='d1-']")).toContainText("Critical · Narrative coherence · the director");
  await one.getByRole("checkbox", { name: /^Planned scenes/ }).uncheck();
  await expect(proposals.locator("[data-proposals-canon]")).toContainText("Tessa Lune");
  await proposals.getByRole("button", { name: /^Apply \d+ proposals$/ }).click();
  await expect(proposals).toHaveAttribute("data-design-proposals", "decided", { timeout: 30_000 });
  await expect(proposals).toContainText(/proposals applied, in 3 chapters\. One entry of the canon created as a draft\./);

  // The files: the chosen fields written where the entries lacked them, the director's finding a note for the ghostwriter, the text and the title as the author wrote them.
  const { readOutlineChapter } = await engineModule("index.js");
  const entries = await filesUnder(page, BOOK.repo, "outline/chapters/");
  const first = (await readOutlineChapter("outline/chapters/001.md", 1, entries.find((file) => file.path === "outline/chapters/001.md")!.text)).entry;
  expect(first.origin).toBe("author");
  expect(first.title).toBe("The Tide 1");
  expect(first.body).toBe("What happens in chapter 1: Mira follows the water to the wall.");
  expect(first.design.goal).toBe(PASTED.goal);
  expect(first.design.setting).toBe("Proposed setting of chapter 1.");
  expect(first.design.scenes, "the field left out is not written").toBeUndefined();
  expect(first.design.notes).toBe("Keep it cold.\nReview (the architect): Chapter 1 lingers before its turn. — Cut the first beat.\nReview (the director): Mira knows about the wall before anyone tells her. — Let her overhear it first.");
  const second = (await readOutlineChapter("outline/chapters/002.md", 2, entries.find((file) => file.path === "outline/chapters/002.md")!.text)).entry;
  expect(second.design.goal).toBe("Proposed goal of chapter 2.");
  const [journal] = await filesUnder(page, BOOK.repo, "outline/changes.yml");
  expect(journal.text).toContain("by: autopilot");
  expect(journal.text).toMatch(/note: "Review and complete: \d+ proposals applied"/);
  const [character] = await filesUnder(page, BOOK.repo, "characters/");
  expect(character.path).toBe("characters/tessa-lune.md");
  expect(character.text).toContain("canon: draft");

  // The overview of the autopilot: the Synopsis binds, the brief's plot is the older fallback, and «Use my Synopsis only» empties it.
  await page.goto(`app/books/${BOOK.id}/autopilot/settings`, { waitUntil: "domcontentloaded" });
  const note = page.locator("[data-synopsis-binds]");
  await expect(note).toContainText("The entries of the Synopsis are what binds the autopilot", { timeout: 30_000 });
  await note.getByRole("button", { name: "Use my Synopsis only" }).click();
  await note.getByRole("button", { name: "Empty the text" }).click();
  await expect(page.locator("[data-synopsis-only-outcome='saved']")).toHaveText("The text of the brief is empty: the Synopsis is the only source.");
  const [brief] = await filesUnder(page, BOOK.repo, "outline/_brief.md");
  expect(brief.text).not.toContain("the council lies");
  expect(brief.text).toContain("genre: mystery");

  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});
