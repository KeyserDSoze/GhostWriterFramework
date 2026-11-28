import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { engineModule, filesUnder, openApp, seed, settingsOf, TEXT_TASKS, waitForAiSettings, type SeedBook } from "./helpers/autopilot";

// The Bible of a book kept on this device, with GitHub out of reach and the stub provider: the author locks a decision, and a proposal of Brainstorming that goes against it is
// flagged and held (apply it anyway, or leave it); and on a seeded book the checks of the design show what does not hold together (a secret told too early, a thread never paid,
// a date that clashes, a character in two places), the table of the designs shows its gaps, and the spoiler check reads a written chapter. With STUDIO_SHOTS set the page is
// captured at 390x844 and 1280x800, light and dark.

test.use({ serviceWorkers: "block" });

const BOOK = { id: "book-bible", repo: "e2e-local-bible", name: "The Glass Harbor" };
const TRUTH = "The keeper scuttled the Aurora himself, to hide the smuggled silver beneath the lighthouse.";

interface Provider { url: string; calls: Array<{ system: string; user: string }>; close(): Promise<void> }

/** An OpenAI-compatible provider that answers Brainstorming with a proposal that changes chapter 2 of the Synopsis. */
async function startProvider(): Promise<Provider> {
  const calls: Array<{ system: string; user: string }> = [];
  const server: Server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "*");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [] })); return; }
    let raw = "";
    for await (const piece of request) raw += piece;
    const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> };
    const text = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");
    const system = text(body.messages?.find((message) => message.role === "system")?.content);
    const user = text([...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content);
    calls.push({ system, user });
    const content = system.startsWith("You are Brainstorming")
      ? JSON.stringify({ reply: "Let Mira break the vault open at once.", calls: [{ tool: "propose_synopsis_edits", args: { summary: "Chapter 2 opens the vault.", edits: [{ kind: "update", number: 2, body: "Mira breaks the vault open at once." }] } }] })
      : "This provider only answers Brainstorming.";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "cmpl-1", object: "chat.completion", model: "fake-model", usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] }));
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls, close: () => new Promise<void>((closed) => { server.closeAllConnections(); server.close(() => closed()); }) };
}

const document = (frontmatter: string, body = "") => `---\n${frontmatter}\n---\n\n${body}\n`;

/** A book with a design that has a little of everything the checks look for. */
async function library(): Promise<SeedBook[]> {
  const { serializeOutlineBook, serializeOutlineChapter, wholeDesignPatch } = await engineModule("index.js");
  const { seedBookFiles } = await engineModule("testing/index.js");
  const entry = (number: number, title: string, design: Record<string, unknown>) => serializeOutlineChapter({ number, title, body: `${title}: what happens.`, design: wholeDesignPatch(design), origin: "author" });
  return [{
    ...BOOK,
    files: {
      ...seedBookFiles({ title: BOOK.name }),
      "outline/book.md": serializeOutlineBook({ body: "A harbor town built on glass hides a lie that the tide will tell.", origin: "author" }),
      "outline/chapters/001.md": entry(1, "Arrival", { goal: "Mira lands", pov: ["Mara Voss"], characters: ["Mara Voss", "Elio Marr"], setting: "The Harbour", time: "1348-03-10", events: ["She lands"], ending: "A door closes" }),
      "outline/chapters/002.md": entry(2, "The pier", { goal: "The lie begins", pov: ["Mara Voss"], characters: ["Mara Voss", "Elio Marr"], setting: "The Lighthouse", time: "1348-03-12, night", events: ["The storm"], reveals: ["secret:the-wreck"], ending: "The lamp goes out" }),
      "outline/chapters/003.md": entry(3, "The letter", { goal: "A letter arrives", pov: ["Elio Marr"], characters: ["Elio Marr"], setting: "The Harbour", time: "1348-03-12, night", events: ["He reads it"], ending: "He leaves" }),
      "outline/chapters/004.md": entry(4, "The reveal", { clues: ["A wet footprint"], events: ["The truth"] }),
      "secrets/the-wreck.md": document("type: secret\nid: secret:the-wreck\ntitle: The wreck of the Aurora\nreveal_in: chapter:004-the-reveal\nholders: [character:keeper]", TRUTH),
      "characters/mara-voss.md": document("type: character\nid: character:mara-voss\nname: Mara Voss", "# Mara Voss"),
      "characters/elio-marr.md": document("type: character\nid: character:elio-marr\nname: Elio Marr", "# Elio Marr"),
      "locations/lighthouse.md": document("type: location\nid: location:lighthouse\nname: The Lighthouse", "# The Lighthouse"),
      "locations/harbour.md": document("type: location\nid: location:harbour\nname: The Harbour", "# The Harbour"),
      "timelines/events/storm.md": document("type: timeline-event\nid: timeline-event:storm\ntitle: The great storm\ndate: 1348-03-15\nreveal_in: chapter:002-the-pier\nparticipants: [Elio Marr]", "The storm."),
      "bible/threads.md": document("type: bible\nid: bible:threads\nthreads:\n  - id: t-001\n    title: The keeper's lamp\n    setup: { chapter: 2 }\n    status: open"),
      "chapters/002-the-pier/chapter.md": document("type: chapter\nid: chapter:002-the-pier\nnumber: 2\ntitle: The pier", "# The pier"),
      "chapters/002-the-pier/001-dinner.md": document("type: paragraph\nid: paragraph:002-the-pier:001-dinner\nchapter: chapter:002-the-pier\nnumber: 1\ntitle: Dinner", `Tam said it plainly. ${TRUTH}`),
    },
  }];
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

let ai: Provider;
test.beforeAll(async () => { ai = await startProvider(); });
test.afterAll(async () => { await ai.close(); });

async function openBible(page: Page) {
  const books = await library();
  const base = settingsOf(ai.url, books);
  const seeded = { ...base, aiIntegrations: base.aiIntegrations.map((integration) => ({ ...integration, chatModels: integration.chatModels.map((model) => ({ ...model, capabilities: TEXT_TASKS.filter((task) => task !== "brainstorming") })) })), taskRouting: { copilot: { primary: { integrationId: "fake-ai", model: "fake-model" }, fallbacks: [] } } };
  await seed(page, seeded, books);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await page.goto(`app/books/${BOOK.id}/outline?tab=bible`, { waitUntil: "domcontentloaded" });
  const bible = page.locator("[data-bible]");
  await expect(bible).toBeVisible({ timeout: 30_000 });
  return bible;
}

async function capture(page: Page, name: string, selector: string) {
  const folder = process.env.STUDIO_SHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  for (const [width, height] of [[390, 844], [1280, 800]] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
      await page.locator(selector).first().scrollIntoViewIfNeeded();
      await page.locator(selector).first().screenshot({ path: `${folder}/${name}-${width}x${height}-${theme}.png` });
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize({ width: 1280, height: 800 });
}

test("the author locks a decision, and a proposal of Brainstorming that goes against it is flagged and held: leave it, or apply it anyway", async ({ page }) => {
  const github = watchGitHub(page);
  const bible = await openBible(page);

  // Capture a decision about chapter 2 and lock it at once.
  const decisions = bible.locator("#bible-decisions");
  await decisions.getByLabel("The decision").fill("Chapter 2 stays as it is: the vault is not opened yet.");
  await decisions.getByLabel("Why", { exact: true }).fill("The reveal of chapter 4 depends on it.");
  await decisions.getByLabel("Chapters it is about").fill("2");
  await decisions.getByRole("button", { name: "Add it and lock it" }).click();
  const row = decisions.locator("[data-decision='d-001']");
  await expect(row).toHaveAttribute("data-decision-status", "locked");
  await expect(row).toContainText("by you");
  await expect(row).toContainText("Covers: chapters 2");
  const [log] = await filesUnder(page, BOOK.repo, "bible/decisions.md");
  expect(log.text).toContain("status: locked");
  await capture(page, "decisions", "#bible-decisions");

  // Brainstorming is told it, and its proposal that touches chapter 2 is flagged to the model and to the author.
  await page.goto(`app/books/${BOOK.id}/outline`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#outline-chapter-2")).toBeVisible();
  await page.locator("[data-brainstorm-open]").click();
  const panel = page.locator('[data-assistant-mode="brainstorming"]');
  await expect(panel).toBeVisible();
  await panel.getByPlaceholder("Ask about the big design of the book…").fill("Let chapter 2 open the vault at once.");
  await panel.getByRole("button", { name: "Send" }).click();
  const proposal = panel.locator('[data-brainstorm-proposal="synopsis"]');
  await expect(proposal).toBeVisible({ timeout: 20_000 });
  expect(ai.calls[0].user).toContain("LOCKED DECISIONS");
  expect(ai.calls[0].user).toContain("d-001: Chapter 2 stays as it is");
  expect(ai.calls[0].system).toContain("propose_bible_decisions");
  await expect(panel.locator("p", { hasText: "You will be asked before it is applied." })).toBeVisible();

  // Applying asks the author instead of applying: nothing changes.
  await proposal.getByRole("button", { name: "Apply to the Synopsis" }).click();
  await page.getByRole("dialog", { name: "Apply these changes to the Synopsis?" }).getByRole("button", { name: "Apply", exact: true }).click();
  const hold = panel.getByRole("group", { name: "A change held by a locked decision" });
  await expect(hold).toBeVisible({ timeout: 20_000 });
  await expect(hold).toContainText("the entry of chapter 2, which the locked decision d-001 covers");
  const entry = async () => (await filesUnder(page, BOOK.repo, "outline/chapters/002.md"))[0].text;
  expect(await entry()).not.toContain("breaks the vault open");
  await hold.getByRole("button", { name: "Leave it" }).click();
  await expect(hold).toBeHidden();
  expect(await entry()).not.toContain("breaks the vault open");

  // The proposal can be applied again, and «apply it anyway» applies it (the decision stays locked).
  await proposal.getByRole("button", { name: "Apply to the Synopsis" }).click();
  await page.getByRole("dialog", { name: "Apply these changes to the Synopsis?" }).getByRole("button", { name: "Apply", exact: true }).click();
  await expect(hold).toBeVisible({ timeout: 20_000 });
  await hold.getByRole("button", { name: "Apply it anyway" }).click();
  await expect.poll(entry, { timeout: 20_000 }).toContain("breaks the vault open");
  const [after] = await filesUnder(page, BOOK.repo, "bible/decisions.md");
  expect(after.text, "the decision stays locked").toContain("status: locked");
  expect(github, "no request went to GitHub").toEqual([]);
});

test("on a seeded book the checks show what does not hold together, the table shows the gaps, and the spoiler check reads a written chapter", async ({ page }) => {
  const github = watchGitHub(page);
  const bible = await openBible(page);

  // The checks of the design, with their severity and where.
  const checks = bible.locator("#bible-checks");
  await expect(checks.locator("[data-design-finding='reveal-too-early']")).toContainText("Chapter 2 tells the reader the secret «The wreck of the Aurora», which is revealed only from chapter 4");
  await expect(checks.locator("[data-design-finding='thread-without-payoff']")).toContainText("The thread «The keeper's lamp» is set up in chapter 2 and has no payoff");
  await expect(checks.locator("[data-design-finding='timeline-date-mismatch']")).toContainText("The timeline event «The great storm», anchored to chapter 2, has another date than the time of the chapter");
  await expect(checks.locator("[data-design-finding='character-in-two-places']")).toContainText("Elio Marr is in two places at the same time: in chapter 2 at «The Lighthouse» and in chapter 3 at «The Harbour»");
  await expect(checks.locator("[data-finding-severity='warning']").first()).toBeVisible();
  await checks.getByLabel("Show").selectOption("info");
  expect(await checks.locator("[data-design-finding]").evaluateAll((items) => items.every((item) => (item as HTMLElement).dataset.findingSeverity === "info"))).toBe(true);
  await checks.getByLabel("Show").selectOption("all");

  // The timeline in the order of its dates, and the table of all the designs with the gaps in the needed fields.
  await expect(bible.locator("[data-timeline-event='storm']")).toContainText("1348-03-15");
  const table = bible.locator("[data-design-table] table");
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(table.locator("[data-design-row='4'] td[data-gap='key']")).toHaveCount(3);
  await expect(table.locator("[data-design-row='4'] td[data-gap='key']").first()).toContainText("missing");
  await bible.getByLabel("Only chapters with a gap in a needed field").check();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await bible.getByLabel("Only chapters with a gap in a needed field").uncheck();
  await bible.getByLabel("Search the designs").fill("footprint");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await bible.getByLabel("Search the designs").fill("");

  // The spoiler check reads the written chapter on request.
  await expect(checks.locator("[data-design-finding='spoiler-in-prose']")).toHaveCount(0);
  await checks.getByRole("button", { name: "Check the written chapters" }).click();
  await expect(checks.locator("[data-design-finding='spoiler-in-prose']")).toContainText("The written text of chapter 2 states the secret «The wreck of the Aurora» before its reveal (chapter 4)");
  await expect(checks.locator("[data-spoiler-summary]")).toContainText("Read 1 written chapters");

  await capture(page, "checks", "#bible-checks");
  await capture(page, "table", "#bible-table");
  await capture(page, "timeline", "#bible-timeline");
  expect(github, "no request went to GitHub").toEqual([]);
});
