import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { engineModule, openApp, seed, settingsOf, startProvider, waitForAiSettings, type SeedBook, type StubProvider } from "./helpers/autopilot";
import { capture, contrast, horizontalOverflow, overflowing, setTheme } from "./helpers/review-view";

// A chapter of a finished book read in a window over «How the book turned out», on a book kept on this device with GitHub out of reach. The chapter links of the table of scores and of «Read
// these first» open the chapter at once, from the working copy (no request goes anywhere): its scenes in order, drawn a few at a time when a chapter is long, with its votes and rounds; Ctrl and
// the middle button open the page, as a link does; the arrow keys and the buttons go to the chapter before and after; Escape closes it and the focus goes back to the link. Nothing of the
// canon is read (a secret that is not due yet stays out), a scene that holds a script, a link that runs code or an image shows none of them, and the window fits a screen 320 pixels wide.

test.use({ serviceWorkers: "block" });
test.setTimeout(240_000);

const BOOK = { id: "book-reading", repo: "e2e-local-reading", name: "The Glass Harbor" };
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const SECRET = "The harbor master is the thief.";

type Vote = ["approve" | "revise", number];

/** A director who votes each chapter as a script says: one entry for each of its judgements. */
function scripted(chapters: Record<number, Vote[]>) {
  const asked = new Map<number, number>();
  return {
    review(user: string) {
      const chapter = Number(/Decide on chapter (\d+)/.exec(user)?.[1] ?? "0");
      const turn = asked.get(chapter) ?? 0;
      asked.set(chapter, turn + 1);
      const list = chapters[chapter] ?? [["approve", 8]];
      const [verdict, score] = list[Math.min(turn, list.length - 1)];
      const extraFixes = verdict === "revise" ? [{ sceneNumber: 1, remediation: "Open with Mira already running.", rationale: "The opening is slow." }] : [];
      return { verdict, score, summary: "Judged.", strengths: [], decisions: [], extraFixes, guidance: [] };
    },
    book: () => ({ verdict: "approve", score: 8, summary: "The book as a whole.", strengths: ["Atmosphere"], concerns: [], decisions: [], nextSteps: [], questionsForAuthor: [] }),
  };
}

const paragraph = (index: number) => `Paragraph ${index} of this scene. The tide came in over the glass and the keeper counted the lanterns again, because counting was what kept the fear small, and the harbor master watched from the pier without saying what he knew.`;
const longScene = (chapter: number, scene: number) => `---\ntype: paragraph\ntitle: Extra scene ${scene}\nnumber: ${scene}\n---\n${Array.from({ length: 14 }, (_, index) => paragraph(index + 1)).join("\n\n")}\n\nEnd marker E${chapter}.${scene}.`;
const sceneFile = (slug: string, number: number) => `chapters/${slug}/${String(number).padStart(3, "0")}-extra-scene-${number}.md`;

interface Seeded {
  book: SeedBook;
  slugs: string[];
  titles: string[];
}

/** The finished book, made in Node by the engine (four chapters closed at 8.5, 8, 7.5 and 9), with scenes added to its working copy: eight long ones in chapter 2, one that holds a script in chapter 4. */
async function finishedBook(): Promise<Seeded> {
  const { AutopilotSession, writeOutlineBrief } = await engineModule("index.js");
  const { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 4, title: BOOK.name }));
  await writeOutlineBrief(store, { idea: "A harbor town built on glass hides a lie that the tide will tell.", genre: "mystery", audience: "adults", wordsPerScene: 200 });
  const fake = createFakeAutopilotAi({ scenes: 1, words: 120 });
  const director = scripted({ 1: [["approve", 8.5]], 2: [["revise", 5.5], ["approve", 8]], 3: [["approve", 7.5]], 4: [["approve", 9]] });
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
  const chapters = snapshot.state.plan.chapters as Array<{ slug: string; title: string; score?: number }>;
  if (JSON.stringify(chapters.map((chapter) => chapter.score)) !== JSON.stringify([8.5, 8, 7.5, 9])) throw new Error(`The seed closed the chapters at ${JSON.stringify(chapters.map((chapter) => chapter.score))}`);
  const files = store.toObject() as Record<string, string>;
  for (let scene = 2; scene <= 9; scene += 1) files[sceneFile(chapters[1].slug, scene)] = longScene(2, scene);
  files[sceneFile(chapters[3].slug, 2)] = "---\ntype: paragraph\ntitle: A scene with a script\n---\nSafe text of the scene.\n\n<script>window.__pwned = true</script>\n\n[a link that runs code](javascript:window.__pwned=true)\n\n![a picture](../../assets/x.png)";
  files["secrets/the-lie.md"] = `---\ntype: secret\nname: The Lie\nknown_from: chapter:${chapters[2].slug}\nreveal_in: chapter:${chapters[3].slug}\n---\n${SECRET}`;
  return { book: { ...BOOK, files }, slugs: chapters.map((chapter) => chapter.slug), titles: chapters.map((chapter) => chapter.title) };
}

function watchGitHub(target: Page | BrowserContext): string[] {
  const requests: string[] = [];
  target.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void target.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let ai: StubProvider;
test.beforeAll(async () => {
  ai = await startProvider({ chapters: 1, scenes: 1, words: 120 });
});
test.afterAll(async () => { await ai.close(); });

test("a chapter of the finished book is read in a window: from the table and from «Read these first», a few scenes at a time, with its votes, moving between chapters, closing with the focus back on the link", async ({ page, context }) => {
  const github = watchGitHub(context);
  const requests: string[] = [];
  page.on("request", (request) => { if (!request.url().startsWith("http://127.0.0.1:4173") && !request.url().startsWith("data:") && !request.url().startsWith("blob:")) requests.push(request.url()); });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { book, slugs, titles } = await finishedBook();
  const { openAi } = await seed(context, settingsOf(ai.url, [book]), [book]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await page.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });

  const result = page.locator("[data-autopilot-result]");
  await expect(result).toBeVisible({ timeout: 30_000 });
  const dialog = page.getByRole("dialog");
  const title = (number: number) => new RegExp(`^Chapter ${number} · «${escaped(titles[number - 1])}»$`);
  const area = (number: number) => dialog.getByRole("region", { name: title(number) });
  const tableLink = (number: number) => result.locator(`a[data-chapter-link="${slugs[number - 1]}"]`).first();
  const scenes = dialog.locator("[data-reading-scene]");

  // The link opens the chapter over the page: a dialog with its name, the reading area with the focus, the page left where it was; no network was asked for the text.
  await expect(tableLink(2)).toHaveAttribute("aria-haspopup", "dialog");
  const mark = requests.length;
  await tableLink(2).focus();
  await tableLink(2).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(title(2));
  await expect(dialog).toHaveAccessibleDescription("Chapter 2 of 4. The left and right arrow keys go to the previous and the next chapter.");
  await expect(area(2)).toBeFocused();
  await expect(page).toHaveURL(/\/autopilot$/);

  // A long chapter is drawn as it is read: three scenes of nine, the button for the rest, and no end of the chapter yet.
  await expect(scenes).toHaveCount(3);
  await expect(scenes.first().getByRole("heading", { level: 3 })).toHaveText(/^Scene 1/);
  await expect(scenes.nth(1).getByRole("heading", { level: 3 })).toHaveText("Scene 2 · Extra scene 2");
  await expect(dialog.getByText("End marker E2.5.")).toHaveCount(0);
  const more = dialog.getByRole("button", { name: "Show more · 6 scenes left" });
  await expect(more).toBeVisible();
  // Reading on, to the end of what is drawn, brings the next ones by itself: the browser says when the end is near.
  await area(2).evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(scenes).toHaveCount(7);
  await expect(dialog.getByText("End marker E2.5.")).toHaveCount(1);
  await expect(dialog.getByText("End marker E2.8.")).toHaveCount(0);
  // The button brings the rest, and the focus goes to the first scene it added.
  await dialog.getByRole("button", { name: "Show more · 2 scenes left" }).click();
  await expect(scenes).toHaveCount(9);
  await expect(scenes.nth(7).getByRole("heading", { level: 3 })).toBeFocused();
  await expect(dialog.locator("[data-reading-end]")).toHaveText("End of the chapter");
  await expect(dialog.getByRole("button", { name: /^Show more/ })).toHaveCount(0);

  // What the director said of the chapter: its final score, and the rounds of its review (it was sent back once).
  await setViewport(page, 1280, 800);
  await expect(dialog.locator("[data-reading-final]")).toHaveText("8/10");
  const rounds = dialog.getByRole("table", { name: "Rounds of review" });
  await expect(rounds.getByRole("row")).toHaveCount(3);
  await expect(rounds.getByRole("row").nth(1)).toContainText("sent back for fixes");
  await expect(rounds.getByRole("row").nth(2)).toContainText("approved");

  // Nothing but the chapter's own scenes was read: not the secret that is not due yet, not the chapter's file, not another chapter.
  await expect(dialog).not.toContainText(SECRET);
  await expect(dialog).not.toContainText("The Lie");

  // The buttons and the arrow keys go to the chapter before and after, the window says which it is on, and at the end of the book the button stays where it is.
  await area(2).evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await dialog.getByRole("button", { name: /^Next chapter: 3 · / }).click();
  await expect(dialog).toHaveAccessibleName(title(3));
  await expect(dialog.locator("[data-reading-announce]")).toHaveText(`Chapter 3 of 4: 3 · ${titles[2]}`);
  expect(await area(3).evaluate((element) => element.scrollTop), "a chapter is read from its top").toBe(0);
  await expect(scenes.first()).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(dialog).toHaveAccessibleName(title(4));
  const last = dialog.getByRole("button", { name: "Next chapter: this is the last" });
  await expect(last).toHaveAttribute("aria-disabled", "true");
  await last.focus();
  await page.keyboard.press("Enter");
  await expect(last).toBeFocused();
  await expect(dialog).toHaveAccessibleName(title(4));
  // A scene that holds a script, a link that runs code and an image shows none of them.
  await expect(dialog).toContainText("Safe text of the scene.");
  await expect(dialog.locator("script, img, a[href^='javascript'], a[href*='javascript']")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned), "the script did not run").toBeUndefined();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(dialog).toHaveAccessibleName(title(2));

  // Escape closes it, and the focus is on the link again, also after going to other chapters.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(tableLink(2)).toBeFocused();
  await expect(page).toHaveURL(/\/autopilot$/);
  expect(requests.slice(mark), "the page asked nothing of the network for the text of a chapter, for the votes or for moving between chapters").toEqual([]);

  // Ctrl and the middle button open the page of the chapter in another tab, as a link does, and no window opens over this one.
  for (const how of [{ modifiers: ["Control"] as Array<"Control"> }, { button: "middle" as const }]) {
    const [tab] = await Promise.all([context.waitForEvent("page"), tableLink(3).click(how)]);
    await tab.waitForLoadState("domcontentloaded");
    expect(tab.url(), JSON.stringify(how)).toMatch(new RegExp(`/app/books/${BOOK.id}/chapters/${slugs[2]}$`));
    await tab.close();
    await expect(dialog).toBeHidden();
  }

  // «Read these first»: its first chapter (2: an 8 after a round of fixes weighs as much as chapter 3's 7.5, and the earlier one comes first) opens in the same window, and closing it with
  // its button gives the focus to that link.
  const readFirst = page.getByRole("heading", { name: "Read these first" }).locator("..");
  const first = readFirst.getByRole("link").first();
  await expect(first).toHaveAttribute("data-chapter-link", slugs[1]);
  await first.focus();
  await first.click();
  await expect(dialog).toHaveAccessibleName(title(2));
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(first).toBeFocused();

  // The page of the chapter is one click away, and the window is gone when it opens.
  await tableLink(1).click();
  await expect(dialog).toHaveAccessibleName(title(1));
  await dialog.getByRole("link", { name: "Open the chapter page" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/books/${BOOK.id}/chapters/${slugs[0]}$`));
  await expect(dialog).toBeHidden();

  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
  expect(errors).toEqual([]);
});

async function setViewport(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
}

test("the window reflows on a screen 320 pixels wide, keeps its text readable in both themes, and is looked at on a phone and on a desktop", async ({ page }) => {
  const { book, slugs, titles } = await finishedBook();
  await seed(page, settingsOf(ai.url, [book]), [book]);
  watchGitHub(page);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await page.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });
  const result = page.locator("[data-autopilot-result]");
  await expect(result).toBeVisible({ timeout: 30_000 });
  const dialog = page.getByRole("dialog");
  const region = dialog.getByRole("region", { name: new RegExp(`^Chapter 2 · «${escaped(titles[1])}»$`) });

  await page.setViewportSize({ width: 320, height: 640 });
  await result.locator(`a[data-chapter-link="${slugs[1]}"]`).first().click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-reading-scene]")).not.toHaveCount(0);

  // On a phone the window is the screen, the votes are behind a button above the text, and nothing is wider than the screen.
  const box = await dialog.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.width).toBe(320);
  expect(await overflowing(dialog), "nothing in the window is wider than it is at 320 px").toEqual([]);
  expect(await horizontalOverflow(dialog), "the window has no sideways scroll at 320 px").toBeLessThanOrEqual(0);
  expect(await horizontalOverflow(region), "nor has its reading area").toBeLessThanOrEqual(0);
  for (const control of [dialog.getByRole("button", { name: /^Previous chapter/ }), dialog.getByRole("button", { name: /^Next chapter/ }), dialog.getByRole("link", { name: "Open the chapter page" }), dialog.getByRole("button", { name: "Close" }), dialog.getByRole("button", { name: /the votes and rounds$/ })]) {
    const at = await control.boundingBox();
    expect(at && at.x >= 0 && at.x + at.width <= 320, `${await control.textContent()} is inside the screen`).toBe(true);
    expect(at && at.height >= 36, "a target of a finger").toBe(true);
  }
  const toggle = dialog.getByRole("button", { name: /the votes and rounds$/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveText("Show the votes and rounds");
  await expect(dialog.locator("[data-reading-final]")).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText("Hide the votes and rounds");
  await expect(dialog.locator("[data-reading-final]")).toBeVisible();
  expect(await horizontalOverflow(region), "the rounds table scrolls inside its own region, never the window").toBeLessThanOrEqual(0);
  const table = dialog.getByRole("region", { name: "Rounds of review" });
  await expect(table).toHaveAttribute("tabindex", "0");

  // The text of the window is readable in both themes (WCAG 2.2 AA: 4.5 for text of normal size).
  const texts: Array<[string, Locator]> = [
    ["the title of a scene", dialog.locator("[data-reading-scene] h3").first()],
    ["the text of a scene", dialog.locator("[data-reading-scene] .reader-prose").first()],
    ["a label of the votes", dialog.getByText("Director's final score")],
    ["the description", dialog.getByText(/^Chapter 2 of 4\./)],
    ["the button for the votes", toggle],
    ["a button to another chapter", dialog.getByRole("button", { name: /^Next chapter/ })],
  ];
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    for (const [name, locator] of texts) expect(await contrast(locator), `${name} in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
  }
  await setTheme(page, "light");

  // Pictures, for whoever looks at it: the reading, and the votes beside it.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(dialog.getByRole("table", { name: "Rounds of review" })).toBeVisible();
  await capture(page, "reading-modal", {
    prepare: async (size) => {
      await region.evaluate((element) => { element.scrollTop = 0; });
      if (size.width < 1024 && (await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
    },
  });
  await capture(page, "reading-modal-votes", {
    prepare: async (size) => {
      await region.evaluate((element) => { element.scrollTop = 0; });
      if (size.width < 1024 && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await region.evaluate((element) => { element.scrollTop = 1200; });
  await capture(page, "reading-modal-scrolled");
});

test("in Italian the window says it with the words of the app and still fits a screen 320 pixels wide", async ({ page }) => {
  const { book, slugs, titles } = await finishedBook();
  const settings = settingsOf(ai.url, [book]);
  settings.ui = { ...settings.ui, language: "it" };
  await seed(page, settings, [book]);
  watchGitHub(page);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await page.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });
  const result = page.locator("[data-autopilot-result]");
  await expect(result).toBeVisible({ timeout: 30_000 });
  await page.setViewportSize({ width: 320, height: 640 });
  await result.locator(`a[data-chapter-link="${slugs[1]}"]`).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAccessibleName(`Capitolo 2 · «${titles[1]}»`);
  await expect(dialog.getByRole("link", { name: "Apri la pagina del capitolo" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Capitolo precedente: 1 · / })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Capitolo successivo: 3 · / })).toBeVisible();
  await expect(dialog.locator("[data-reading-scene]").first().getByRole("heading", { level: 3 })).toHaveText(/^Scena 1/);
  expect(await overflowing(dialog), "nothing in the window is wider than it is, in Italian, at 320 px").toEqual([]);
  expect(await horizontalOverflow(dialog)).toBeLessThanOrEqual(0);
  await dialog.getByRole("button", { name: "Mostra i voti e i giri" }).click();
  await expect(dialog.getByText("Voto finale del direttore")).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Giri di revisione" })).toBeVisible();
  expect(await overflowing(dialog), "nor with the votes open").toEqual([]);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    expect(await contrast(dialog.getByText("Voto finale del direttore")), `a label of the votes, in Italian, in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
  }
  await setTheme(page, "light");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("the back gesture closes the window and the page stays, and closing it any other way leaves no step behind in the history", async ({ page }) => {
  const { book, slugs } = await finishedBook();
  await seed(page, settingsOf(ai.url, [book]), [book]);
  watchGitHub(page);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await page.goto(`app/books/${BOOK.id}/autopilot`, { waitUntil: "domcontentloaded" });
  const result = page.locator("[data-autopilot-result]");
  await expect(result).toBeVisible({ timeout: 30_000 });
  const dialog = page.getByRole("dialog");
  const link = result.locator(`a[data-chapter-link="${slugs[1]}"]`).first();
  const step = () => page.evaluate(() => ((history.state as { usr?: Record<string, unknown> } | null)?.usr ?? {}).narrariumSheet ?? null);

  // Opened, the window has a step of its own in the history; back takes it, the window closes and the page is where it was.
  await link.click();
  await expect(dialog).toBeVisible();
  await expect.poll(step).toBe("chapter-reading");
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/app/books/${BOOK.id}/autopilot$`));
  await expect(result).toBeVisible();

  // Closed by its own key, the window gives its step back: the next back leaves the page for the one before it, and not for the window.
  await link.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(step).toBeNull();
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/books$/);
});
