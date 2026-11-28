import { expect, test, type Page } from "@playwright/test";
import { engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, type SeedBook, type StubProvider } from "./helpers/autopilot";

// Phase 4 of #108 on a book kept on this device, with GitHub out of reach: the Studio draws the votes of the reviews of the design and keeps what every reviewer said, a
// version of the Synopsis and the Bible is compared with the files as they are and restored only once the author confirms (the files as they were kept as a version), and
// a conversation of Brainstorming offers «Capture this decision».

test.use({ serviceWorkers: "block" });
test.setTimeout(180_000);

const BOOK = { id: "book-history", repo: "e2e-local-history", name: "The Glass Harbor" };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell: a glassmaker's daughter must expose it before the sea wall gives way.";
const at = "2026-11-26T09:00:00.000Z";

/** A book with two chapters of the author's, a design the director approved at its second review, and a version saved before chapter 1 was rewritten. */
async function bookWithHistory(): Promise<SeedBook> {
  const engine = await engineModule("index.js");
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: BOOK.name }));
  await engine.writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 300 });
  const entry = (number: number, body: string) => ({ path: engine.outlineChapterPath(number), content: engine.serializeOutlineChapter({ number, title: `The Tide ${number}`, body, origin: "author" }) });
  const first = entry(1, "Mira finds the crack in the sea wall.");
  const second = entry(2, "The council lies about the repairs.");
  const files = [...[...store.files].map(([path, content]) => ({ path, content })), first, second];
  const version = engine.designSnapshotChange(files, { at: "2026-11-27T10:00:00.000Z", reason: "request" });
  const state = engine.createAutopilotState(new Date(at), { idea: IDEA });
  state.concept = { done: true, generated: true, secrets: [] };
  state.plan = { chapters: [1, 2].map((number) => ({ number, title: `The Tide ${number}`, slug: `00${number}-the-tide-${number}`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "planned", scenes: [] })), approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: true };
  state.design = {
    startedAt: at, chapters: 2, endedAt: at, outcome: "target", review: { targetScore: 8 },
    rounds: [
      { round: 1, score: 6.5, verdict: "revise", readers: 7, critical: 1, findings: 0, at, texts: { summary: "The reveal costs Mira nothing.", counterProposal: "Reveal the wall in chapter 3, through Orrin.", changes: ["Chapter 2: make the reveal cost Mira her trust."], critical: ["Critical — Chapter 1: Orrin cannot know yet."], readers: [{ slug: "tess", name: "Tess", score: 7, text: "I would read it.", counterProposal: "Open on the flood." }] } },
      { round: 2, score: 8.5, verdict: "approve", readers: 7.5, critical: 0, findings: 0, at, texts: { summary: "Now the reveal hurts." } },
    ],
  };
  state.status = "paused";
  await store.commit([
    { ...first, content: engine.serializeOutlineChapter({ number: 1, title: "The Tide 1", body: "Mira finds the crack, and tells nobody.", origin: "author" }), expectedHash: null },
    { ...second, expectedHash: null },
    { ...version, expectedHash: null },
    { path: "autopilot/state.json", content: engine.serializeAutopilotState(state), expectedHash: null },
  ], "The book");
  return { ...BOOK, files: store.toObject() };
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

let ai: StubProvider;
test.beforeAll(async () => {
  // Brainstorming's requests (its JSON in the text of the answer): a reply, then, asked to capture what was settled, its proposal for the log of decisions.
  ai = await startProvider({
    prose: (user, system) => {
      if (!system.startsWith("You are Brainstorming")) return undefined;
      return JSON.stringify(user.includes("Capture what we settled in this conversation")
        ? { reply: "Here it is, for you to confirm.", calls: [{ tool: "propose_bible_decisions", args: { decisions: [{ decision: "Orrin learns of the wall in chapter 3, never before.", chapters: [3] }] } }] }
        : { reply: "Then Orrin learns of the wall in chapter 3, never before.", calls: [] });
    },
  });
});
test.afterAll(async () => { await ai.close(); });

test("the Studio draws the votes of the reviews with what each reviewer said, restores a version only once confirmed, and Brainstorming offers to capture a decision", async ({ page }) => {
  const github = watchGitHub(page);
  const book = await bookWithHistory();
  const { openAi } = await seed(page, settingsOf(ai.url, [book]), [book]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // The reviews: the chart says its figures, and each review keeps what the reviewers said.
  await page.goto(`app/books/${BOOK.id}/outline?tab=studio`, { waitUntil: "domcontentloaded" });
  const chart = page.getByRole("img", { name: /The votes of the reviews of the design/ });
  await expect(chart).toBeVisible({ timeout: 30_000 });
  await expect(chart).toHaveAccessibleName("The votes of the reviews of the design Review 1: the director 6.5/10, the readers 7/10. Review 2: the director 8.5/10, the readers 7.5/10. The target is 8/10.");
  const first = page.locator("[data-round-texts='1']");
  await first.getByText("What the reviewers said in review 1").click();
  await expect(first).toContainText("The reveal costs Mira nothing.");
  await expect(first).toContainText("Reveal the wall in chapter 3, through Orrin.");
  await expect(first.locator("[data-round-reader='tess']")).toContainText("Counter-proposal: Open on the flood.");

  // The version saved before chapter 1 was rewritten: compared, and restored once confirmed.
  const history = page.locator("[data-design-history]");
  const version = history.locator("[data-history-version='request']");
  await expect(version).toContainText("saved by you");
  await version.getByRole("button", { name: "Compare with now" }).click();
  await expect(version).toContainText("One file would change:");
  await expect(version.locator("[data-history-item='changed']")).toContainText("outline/chapters/001.md");
  await version.getByRole("button", { name: "Restore this version" }).click();
  await expect(version).toContainText("Restore this version? One file changes; the files as they are now are kept as a version of their own first.");
  await version.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(history.locator("[data-history-outcome='restored']")).toHaveText("Restored: one file changed. The files as they were are kept as a version.");
  const [restored] = await filesUnder(page, BOOK.repo, "outline/chapters/001.md");
  expect(restored.text).toContain("Mira finds the crack in the sea wall.");
  const versions = await filesUnder(page, BOOK.repo, "history/design/");
  expect(versions.map((file) => file.path.replace(/^history\/design\/.+-(\w+)\.json$/, "$1")).sort()).toEqual(["request", "restore"]);
  expect(versions.find((file) => file.path.endsWith("-restore.json"))?.text).toContain("tells nobody");

  // Brainstorming: under a conversation, «Capture this decision» fills in the request, and the request reaches the log of decisions once the author applies it.
  await page.getByRole("tab", { name: "Synopsis" }).click();
  // The button in the header of the page (the card of the Studio, still in the page, has one too).
  await page.locator("[data-brainstorm-open]").first().click();
  const panel = page.locator('[data-assistant-mode="brainstorming"]');
  await expect(panel).toBeVisible();
  await panel.getByPlaceholder("Ask about the big design of the book…").fill("When does Orrin learn of the wall?");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.locator(".doc-prose p", { hasText: "Then Orrin learns of the wall in chapter 3, never before." })).toBeVisible({ timeout: 30_000 });
  await panel.locator("[data-brainstorm-capture]").getByRole("button", { name: "Capture this decision" }).click();
  const composer = panel.getByPlaceholder("Ask about the big design of the book…");
  await expect(composer).toHaveValue("Capture what we settled in this conversation as decisions of the book, with the questions it leaves open, for me to confirm in the Bible.");
  await expect(composer, "the request is the author's to change or send").toBeFocused();
  // Sent, it reaches Brainstorming's own tool: the log of decisions changes only once the author applies it, and the decision captured is open.
  await panel.getByRole("button", { name: "Send" }).click();
  const proposal = panel.locator("[data-brainstorm-proposal]").filter({ hasText: "bible/decisions.md" });
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  expect(await filesUnder(page, BOOK.repo, "bible/decisions.md"), "nothing is written before the author applies it").toEqual([]);
  await proposal.locator("[data-brainstorm-apply]").click();
  await page.locator("[data-brainstorm-confirm]").click();
  await expect.poll(async () => (await filesUnder(page, BOOK.repo, "bible/decisions.md"))[0]?.text ?? "", { timeout: 20_000 }).toContain("Orrin learns of the wall in chapter 3, never before.");
  const [log] = await filesUnder(page, BOOK.repo, "bible/decisions.md");
  expect(log.text).toContain("status: open");
  expect(log.text).not.toContain("status: locked");

  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});
