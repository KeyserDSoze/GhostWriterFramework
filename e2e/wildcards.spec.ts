import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, type SeedBook, type StubProvider } from "./helpers/autopilot";
import { overflowing } from "./helpers/review-view";

// The wildcards («Fuori dal coro») in a real browser, on a book kept on this device with GitHub out of reach and a stub provider: the page lists the fourteen
// built-in voices, turns one off in the book, keeps a wildcard of the author's own in the account, and the page-aware Copilot creates «a provocateur who
// thinks like a hacker» as one batch the author reviews and applies.

test.use({ serviceWorkers: "block" });

const BOOK = { id: "book-wildcards", repo: "e2e-local-wildcards", name: "The Glass Harbor" };
const BUILTIN = ["The Subversive", "The Devil's Advocate", "The Cliché Hunter", "The Twist Engineer", "The Genre Guest", "The Naive", "The Antagonist", "The Chaos Maker", "The Poet", "The Ledger Keeper", "The Continuity Keeper", "The Secrets Guardian", "The Domain Expert", "The Moral Stress-Test"];

async function book(): Promise<SeedBook> {
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: BOOK.name }));
  return { ...BOOK, files: store.toObject() };
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

/** Closes the Copilot: Escape closes the topmost layer first (a toast that is still there), then the panel. */
async function closeCopilot(page: Page): Promise<void> {
  const panel = page.locator('[data-assistant-mode="copilot"]');
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

const wildcardSwitch = (page: Page, name: string) => page.getByRole("switch", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `) });

let ai: StubProvider;
test.beforeAll(async () => {
  ai = await startProvider({
    answers: {
      copilot_turn: () => ({ reply: "Here is the proposal: a provocateur who thinks like a hacker.", calls: [{ tool: "propose_wildcard_changes", args: { create: { count: 1, brief: "a provocateur who thinks like a hacker" } } }] }),
      wildcard_personas: () => ({ wildcards: [{ name: "The Hacker", group: "provocateur", mandate: "Finds the exploit in every plot: the door nobody locked.", temperament: "Laconic and nocturnal.", audacity: 8, canonRespect: "subversive", outputFormat: "ideas", domain: "computer security", prompt: "Think like an attacker: where would you get in?" }] }),
    },
  });
});
test.afterAll(async () => { await ai.close(); });

test("the Wildcards page lists the built-in voices, turns one off in the book, keeps one of the author's own in the account, and the Copilot creates a hacker", async ({ page }) => {
  const github = watchGitHub(page);
  const seeded = await book();
  const { openAi } = await seed(page, settingsOf(ai.url, [seeded]), [seeded]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  await page.goto(`app/books/${BOOK.id}/wildcards`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Wildcards" })).toBeVisible({ timeout: 30_000 });
  for (const name of BUILTIN) await expect(wildcardSwitch(page, name)).toHaveAttribute("aria-checked", "true");
  // On a phone, and at 320 px, the page has no sideways scroll: nothing in it is wider than the page.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await overflowing(page.getByRole("main")), `what is wider than the page at ${width} px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `the page at ${width} px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  // Turned off in this book: a file of its own, nothing else.
  await wildcardSwitch(page, "The Chaos Maker").click();
  await expect(wildcardSwitch(page, "The Chaos Maker")).toHaveAttribute("aria-checked", "false", { timeout: 20_000 });
  const files = Object.fromEntries((await filesUnder(page, BOOK.repo, "wildcards/")).map((file) => [file.path, file.text]));
  expect(Object.keys(files)).toEqual(["wildcards/chaos-maker.md"]);
  expect(files["wildcards/chaos-maker.md"]).toMatch(/type: wildcard\nid: wildcard:chaos-maker[\s\S]*enabled: false/);

  // One of the author's own, for every book: kept with the account, not in the book.
  await page.getByRole("button", { name: "All my books", exact: true }).click();
  await expect(page.getByRole("button", { name: "All my books", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "New wildcard", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("The Night Owl");
  await page.getByLabel("Mandate", { exact: true }).fill("Reads every scene as if it happened at night.");
  await page.getByLabel("Prompt of the persona", { exact: true }).fill("Find what the dark hides in the scene.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(wildcardSwitch(page, "The Night Owl")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("listitem").filter({ has: wildcardSwitch(page, "The Night Owl") }).getByText("My account")).toBeVisible();
  expect((await filesUnder(page, BOOK.repo, "wildcards/")).map((file) => file.path)).toEqual(["wildcards/chaos-maker.md"]);
  // In the book it is the account's, and it stays there after a reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("listitem").filter({ has: wildcardSwitch(page, "The Night Owl") }).getByText("My account")).toBeVisible({ timeout: 30_000 });

  // The Copilot on the page creates «a provocateur who thinks like a hacker» as one batch: reviewed before anything is written, applied in one change.
  await page.getByRole("button", { name: "Copilot", exact: true }).click();
  const panel = page.locator('[data-assistant-mode="copilot"]');
  await expect(panel.locator('[data-copilot-scope="wildcards"]')).toContainText("Working on: Wildcards");
  await panel.locator("textarea").fill("Create a provocateur who thinks like a hacker");
  await panel.getByRole("button", { name: "Send" }).click();
  const review = panel.locator('[data-page-review="wildcards"]');
  await expect(review.getByRole("heading", { name: "Proposed changes to the wildcards" })).toBeVisible({ timeout: 30_000 });
  await expect(review.locator('tr[data-change="created"] th')).toContainText(["The Hacker"]);
  expect((await filesUnder(page, BOOK.repo, "wildcards/")).map((file) => file.path), "nothing is written yet").toEqual(["wildcards/chaos-maker.md"]);
  await review.getByRole("button", { name: "Apply" }).click();
  await expect(review.getByRole("status")).toHaveText(/^Applied: 1 created/, { timeout: 20_000 });
  const hacker = (await filesUnder(page, BOOK.repo, "wildcards/")).find((file) => file.path === "wildcards/the-hacker.md");
  expect(hacker?.text).toMatch(/id: wildcard:custom:the-hacker[\s\S]*audacity: 8[\s\S]*canon_respect: subversive[\s\S]*domain: computer security/);
  await closeCopilot(page);
  await expect(page.getByRole("listitem").filter({ has: wildcardSwitch(page, "The Hacker") }).getByText("This book")).toBeVisible({ timeout: 20_000 });

  expect(ai.asked).toEqual(["copilot_turn", "wildcard_personas"]);
  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});

// ─── Brainstorming: «Ask the room» ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface RoomProvider {
  url: string;
  /** Every request: the function it asked for (or `brainstorming`), its system prompt and its request. */
  calls: Array<{ tool: string; system: string; user: string }>;
  close(): Promise<void>;
}

/** A provider for Brainstorming and the room: Brainstorming asks the room, then synthesises; every voice of the room is answered by the engine's own fake. */
async function startRoomProvider(): Promise<RoomProvider> {
  const { createFakeAutopilotAi } = await engineModule("testing/index.js");
  const fake = createFakeAutopilotAi();
  const calls: RoomProvider["calls"] = [];
  const server: Server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "*");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [] })); return; }
    let raw = "";
    for await (const piece of request) raw += piece;
    const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ function?: { name: string } }> };
    const text = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");
    const system = text(body.messages?.find((message) => message.role === "system")?.content);
    const user = text([...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content);
    const tool = body.tools?.[0]?.function?.name;
    calls.push({ tool: tool ?? "brainstorming", system, user });
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    if (tool) {
      const answer = await fake.complete({ system, user, label: "e2e", json: { name: tool } } as never);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "cmpl-1", object: "chat.completion", model: "fake-model", usage, choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool, arguments: JSON.stringify(answer.json) } }] } }] }));
      return;
    }
    const content = user.includes("TOOL RESULTS")
      ? JSON.stringify({ reply: "The room agrees on one thing: Orrin must act on his own. The tide as narrator is the boldest idea, and the riskiest. Shall I turn it into a proposal for chapter 2?", calls: [] })
      : JSON.stringify({ reply: "Let me ask the room.", calls: [{ tool: "ask_the_room", args: { question: "What do the provocateurs think of this Synopsis, and what would they change?" } }] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "cmpl-1", object: "chat.completion", model: "fake-model", usage, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] }));
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    calls,
    close: () => new Promise<void>((closed) => { server.closeAllConnections(); server.close(() => closed()); }),
  };
}

test("in Brainstorming the author asks the room: four voices answer as their own characters, Brainstorming synthesises, and the calls are the room's own use in the costs", async ({ page }) => {
  const github = watchGitHub(page);
  const room = await startRoomProvider();
  try {
    const { serializeOutlineBook, serializeOutlineChapter } = await engineModule("index.js");
    const { seedBookFiles } = await engineModule("testing/index.js");
    const brainstormBook: SeedBook = {
      id: "book-room", repo: "e2e-local-room", name: "The Glass Harbor",
      files: {
        ...seedBookFiles({ title: "The Glass Harbor" }),
        "outline/book.md": serializeOutlineBook({ body: "A harbor town built on glass hides a lie that the tide will tell.", origin: "author" }),
        "outline/chapters/001.md": serializeOutlineChapter({ number: 1, title: "Arrival", body: "Mira arrives at the glass harbor.", origin: "author" }),
        "outline/chapters/002.md": serializeOutlineChapter({ number: 2, title: "The key", body: "Mira finds the key of the old vault.", origin: "author" }),
        "secrets/the-wall.md": "---\ntype: secret\nid: secret:the-wall\ntitle: The Wall Is Failing\nreveal_in: chapter:009-ch\n---\n\nThe sea wall cracked years ago.\n",
      },
    };
    const { openAi } = await seed(page, settingsOf(room.url, [brainstormBook]), [brainstormBook]);
    await openApp(page);
    await page.goto("app/books", { waitUntil: "domcontentloaded" });
    await waitForAiSettings(page, room.url);

    await page.goto(`app/books/${brainstormBook.id}/outline`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-brainstorm-open]").click();
    const panel = page.locator('[data-assistant-mode="brainstorming"]');
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Ask the room", exact: true }).click();
    await expect(panel.getByPlaceholder("Ask about the big design of the book…")).toHaveValue("Ask the room (Fuori dal coro): what do the provocateurs think of this Synopsis, and what would they change?");
    await panel.getByRole("button", { name: "Send" }).click();

    // The voices, each as its own character, then Brainstorming's synthesis.
    await expect(panel.getByText("The room (Fuori dal coro): 4 voices", { exact: true })).toBeVisible({ timeout: 30_000 });
    for (const name of ["The Subversive", "The Cliché Hunter", "The Twist Engineer", "The Poet"]) await expect(panel.locator("blockquote strong", { hasText: name }).first()).toBeVisible();
    await expect(panel.getByText("Advisory: never a score, and nothing is applied by itself.", { exact: true })).toBeVisible();
    await expect(panel.locator(".doc-prose p", { hasText: "The room agrees on one thing" })).toBeVisible();

    // Brainstorming, the four voices of the creative room, Brainstorming again; no voice was told a secret, and nothing was written.
    expect(room.calls.map((call) => call.tool)).toEqual(["brainstorming", "wildcard_ideas", "wildcard_ideas", "wildcard_ideas", "wildcard_ideas", "brainstorming"]);
    for (const call of room.calls.filter((entry) => entry.tool === "wildcard_ideas")) {
      expect(call.user).toContain("Mira finds the key of the old vault.");
      expect(call.user).not.toContain("sea wall cracked");
    }
    expect(room.calls[5].user).toContain("VOICE The Subversive (provocateur)");
    expect(await filesUnder(page, brainstormBook.repo, "bible/")).toEqual([]);

    // On the Costs page the room is a use of its own.
    await page.keyboard.press("Escape");
    await page.goto("app/costs", { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Use", { exact: true }).locator("option")).toContainText(["Wildcards' ideas"], { timeout: 30_000 });
    await page.getByRole("radio", { name: "Uses" }).check({ force: true });
    await expect(page.getByRole("table").locator('[data-costs-row="ideas"]')).toContainText("Wildcards' ideas");

    expect(github, "no request went to GitHub").toEqual([]);
    expect(openAi).toEqual([]);
  } finally {
    await room.close();
  }
});
