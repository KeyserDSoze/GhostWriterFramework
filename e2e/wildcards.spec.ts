import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { autopilotFacts, engineModule, filesUnder, openApp, seed, settingsOf, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubProvider } from "./helpers/autopilot";
import { capture, contrast, horizontalOverflow, overflowing, setTheme } from "./helpers/review-view";

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

// ─── Right click: «Out-of-the-box ideas…» ────────────────────────────────────────────────────────────────────────────────────────────────

const SCENE = "Mira stepped on the quay while the tide came in. The glass houses rang like bells in the wind, and Orrin watched from the harbour office.";

test("right click: the room's ideas on a selection become a rewrite the author keeps, on a chapter its Synopsis entry; the decisions are in the journal and only the Guardian reads a hidden secret", async ({ page }) => {
  const github = watchGitHub(page);
  const prompts: string[] = [];
  const reply = (user: string) => {
    prompts.push(user);
    const name = /You are «([^»]+)»/.exec(user)?.[1] ?? "A voice";
    const sentinel = /a sentinel: you check/.test(user);
    return { items: [1, 2].map((index) => ({ title: `${name} ${index}`, idea: `${name} proposes idea ${index}.`, why: "It lifts the scene.", changes: "One beat changes.", chapters: [1], risk: "Small.", audacity: 6, ...(sentinel ? { evidence: "the tide", severity: "minor" } : {}) })) };
  };
  const stub = await startProvider({ answers: { wildcard_ideas: reply } });
  try {
    const { serializeOutlineChapter } = await engineModule("index.js");
    const { seedBookFiles } = await engineModule("testing/index.js");
    const roomBook: SeedBook = {
      id: "book-ideas", repo: "e2e-local-ideas", name: "The Glass Harbor",
      files: {
        ...seedBookFiles({ title: "The Glass Harbor" }),
        "outline/chapters/001.md": serializeOutlineChapter({ number: 1, title: "Arrival", body: "Mira arrives at the glass harbor.", origin: "author" }),
        "chapters/001-arrival/chapter.md": "---\ntype: chapter\nid: chapter:001-arrival\nnumber: 1\ntitle: Arrival\n---\n\n# Arrival\n",
        "chapters/001-arrival/001-quay.md": `---\ntype: paragraph\nnumber: 1\ntitle: The Quay\n---\n\n${SCENE}\n`,
        "secrets/the-wall.md": "---\ntype: secret\nid: secret:the-wall\ntitle: The Wall Is Failing\nreveal_in: chapter:009-ch\n---\n\nThe sea wall cracked years ago.\n",
      },
    };
    const { openAi } = await seed(page, settingsOf(stub.url, [roomBook]), [roomBook]);
    await openApp(page);
    await page.goto("app/books", { waitUntil: "domcontentloaded" });
    await waitForAiSettings(page, stub.url);

    // A selection in the scene's editor, and the room on it.
    await page.goto(`app/books/${roomBook.id}/chapters/001-arrival/paragraphs/001`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Edit paragraph" }).click({ timeout: 30_000 });
    const editor = page.getByRole("textbox", { name: "Start writing…" });
    await expect(editor).toHaveValue(`${SCENE}\n`, { timeout: 30_000 });
    await editor.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(0, 48); });
    const box = await editor.boundingBox();
    await editor.dispatchEvent("contextmenu", { clientX: (box?.x ?? 0) + 30, clientY: (box?.y ?? 0) + 15, button: 2 });
    await page.getByRole("button", { name: "Out-of-the-box ideas on the selection…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Out-of-the-box ideas" });
    await expect(dialog.getByRole("radio", { name: /Creative room/ })).toBeChecked({ timeout: 30_000 });
    await expect(dialog.locator("[data-wildcards-estimate]")).toContainText(/About 4–8 calls/);
    await dialog.getByRole("button", { name: "Ask the room", exact: true }).click();
    const table = dialog.getByRole("table");
    await expect(table.locator("tbody tr")).toHaveCount(8, { timeout: 30_000 });
    expect(await filesUnder(page, roomBook.repo, "bible/"), "nothing is written by asking").toEqual([]);
    await dialog.getByRole("button", { name: "Skip all", exact: true }).click();
    await dialog.getByRole("group", { name: "Decision on «The Subversive 1»" }).getByRole("radio", { name: "Accept" }).check();
    await dialog.getByRole("group", { name: "Decision on «The Poet 2»" }).getByRole("radio", { name: "Accept" }).check();
    await expect(dialog.getByText("2 accepted · 6 skipped · 0 not decided")).toBeVisible();
    await dialog.getByRole("button", { name: "Apply to the selection", exact: true }).click();

    // The rewrite by the ghostwriter, as a difference; kept, it replaces the selection only.
    const keep = page.getByRole("button", { name: "Keep the new one" });
    await expect(keep).toBeEnabled({ timeout: 30_000 });
    await keep.click();
    await expect(editor).not.toHaveValue(`${SCENE}\n`, { timeout: 20_000 });
    expect(await editor.inputValue()).toContain(SCENE.slice(48));
    // In the editor, as an edit of the author's: saved like any other.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(async () => {
      const [scene] = await filesUnder(page, roomBook.repo, "chapters/001-arrival/001-quay.md");
      expect(scene?.text).toContain(SCENE.slice(48));
      expect(scene?.text).not.toContain(SCENE.slice(0, 48));
    }).toPass({ timeout: 20_000 });
    const { parseIdeasJournal } = await engineModule("index.js");
    const [journal] = await filesUnder(page, roomBook.repo, "bible/ideas.yml");
    const entries = parseIdeasJournal(journal?.text).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ by: "author", preset: "creative-room", target: { kind: "selection", chapter: 1, paragraph: 1 } });
    expect(entries[0].ideas.map((idea: { decision?: { verdict: string; by: string } }) => `${idea.decision?.verdict}:${idea.decision?.by}`).sort()).toEqual([...Array(2).fill("adopted:author"), ...Array(6).fill("rejected:author")].sort());

    // The chapter: the narrative quality check, and the accepted finding in its entry of the Synopsis.
    prompts.length = 0;
    await page.goto(`app/books/${roomBook.id}/chapters/001-arrival`, { waitUntil: "domcontentloaded" });
    const count = page.getByRole("main").getByText("1 paragraph", { exact: true });
    await expect(count).toBeVisible({ timeout: 30_000 });
    await count.click({ button: "right" });
    await page.getByRole("button", { name: "Out-of-the-box ideas…", exact: true }).click();
    await dialog.getByRole("radio", { name: /Narrative quality check/ }).check();
    await dialog.getByRole("button", { name: "Ask the room", exact: true }).click();
    await expect(table.locator("tbody tr")).toHaveCount(8, { timeout: 30_000 });
    await dialog.getByRole("button", { name: "Skip all", exact: true }).click();
    await dialog.getByRole("group", { name: "Decision on «The Ledger Keeper 1»" }).getByRole("radio", { name: "Accept" }).check();
    await dialog.getByRole("button", { name: "Apply to the Synopsis entry", exact: true }).click();
    await expect(page.getByText("Synopsis entry of chapter 1, with the accepted ideas")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Keep the new one" }).click();
    await expect(async () => {
      const [entry] = await filesUnder(page, roomBook.repo, "outline/chapters/001.md");
      expect(entry?.text).toContain("Ideas from the room (Fuori dal coro), accepted on");
      expect(entry?.text).toContain("- The Ledger Keeper 1: The Ledger Keeper proposes idea 1.");
      expect(entry?.text).toContain("origin: author");
    }).toPass({ timeout: 20_000 });
    const [changes] = await filesUnder(page, roomBook.repo, "outline/changes.yml");
    expect(changes?.text).toContain("by: author");

    // Only the Secrets Guardian was told the hidden secret; the other three sentinels were not.
    const guardian = prompts.filter((prompt) => prompt.includes("You are «The Secrets Guardian»"));
    expect(guardian).toHaveLength(1);
    expect(guardian[0]).toContain("The sea wall cracked years ago.");
    expect(prompts.filter((prompt) => !prompt.includes("You are «The Secrets Guardian»")).every((prompt) => !prompt.includes("sea wall cracked"))).toBe(true);
    expect(github, "no request went to GitHub").toEqual([]);
    expect(openAi).toEqual([]);
  } finally {
    await stub.close();
  }
});

// ─── The Copilot: «What do the provocateurs think of this chapter?» ─────────────────────────────────────────────────────────────────────

test("the Copilot asks the provocateurs about the chapter it is on: the voices answer in the chat, and the table of their ideas opens", async ({ page }) => {
  const github = watchGitHub(page);
  const stub = await startProvider({ answers: { copilot_turn: () => ({ reply: "", calls: [{ tool: "ask-wildcards", args: {} }] }) } });
  try {
    const { seedBookFiles } = await engineModule("testing/index.js");
    const copilotBook: SeedBook = {
      id: "book-copilot-room", repo: "e2e-local-copilot-room", name: "The Glass Harbor",
      files: {
        ...seedBookFiles({ title: "The Glass Harbor" }),
        "chapters/001-arrival/chapter.md": "---\ntype: chapter\nid: chapter:001-arrival\nnumber: 1\ntitle: Arrival\n---\n\n# Arrival\n",
        "chapters/001-arrival/001-quay.md": `---\ntype: paragraph\nnumber: 1\ntitle: The Quay\n---\n\n${SCENE}\n`,
      },
    };
    const { openAi } = await seed(page, settingsOf(stub.url, [copilotBook]), [copilotBook]);
    await openApp(page);
    await page.goto("app/books", { waitUntil: "domcontentloaded" });
    await waitForAiSettings(page, stub.url);
    await page.goto(`app/books/${copilotBook.id}/chapters/001-arrival`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("main").getByText("1 paragraph", { exact: true })).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Copilot", exact: true }).click();
    const panel = page.locator('[data-assistant-mode="copilot"]');
    await panel.locator("textarea").fill("What do the provocateurs think of this chapter?");
    await panel.getByRole("button", { name: "Send" }).click();
    await expect(panel.getByText("The room (Fuori dal coro): 4 voices", { exact: true })).toBeVisible({ timeout: 30_000 });
    for (const name of ["The Subversive", "The Cliché Hunter", "The Twist Engineer", "The Poet"]) await expect(panel.locator("blockquote strong", { hasText: name }).first()).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "Out-of-the-box ideas" });
    await expect(dialog.getByRole("table").locator("tbody tr")).toHaveCount(8, { timeout: 30_000 });
    await expect(dialog.getByRole("button", { name: "Apply to the Synopsis entry", exact: true })).toBeDisabled();
    expect(stub.asked).toEqual(["copilot_turn", "wildcard_ideas", "wildcard_ideas", "wildcard_ideas", "wildcard_ideas"]);
    expect(await filesUnder(page, copilotBook.repo, "bible/"), "nothing is written by asking").toEqual([]);
    expect(github, "no request went to GitHub").toEqual([]);
    expect(openAi).toEqual([]);
  } finally {
    await stub.close();
  }
});

// ─── The autopilot ─────────────────────────────────────────────────────────────────────────────────────

const DESIGN = { id: "book-wildcards-design", repo: "e2e-local-wildcards-design", name: "The Glass Harbor" };
const REVIEW = { id: "book-wildcards-review", repo: "e2e-local-wildcards-review", name: "The Glass Harbor" };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";

/** A book with nothing but its description and its brief. */
async function describedBook(): Promise<SeedBook> {
  const { writeOutlineBrief } = await engineModule("index.js");
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: DESIGN.name }));
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 200 });
  return { ...DESIGN, files: store.toObject() };
}

/** A finished book, made in Node by the engine: one chapter closed at 8, the book judged 7.4 with two points, reviewed to 8. */
async function reviewedBook(): Promise<SeedBook> {
  const { AutopilotSession, writeOutlineBrief } = await engineModule("index.js");
  const { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1, title: REVIEW.name }));
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 200 });
  const fake = createFakeAutopilotAi({ scenes: 1, words: 120, reviewVerdict: () => "approve" });
  const reply = (json: unknown) => ({ text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake" });
  const ai = {
    calls: fake.calls,
    async complete(request: { label: string; user: string; system: string; json?: { name?: string } }) {
      if (request.label === "director:book") return reply(bookJudgement());
      return fake.complete(request);
    },
  };
  const session = new AutopilotSession({ bookId: REVIEW.id, store, ai, host: "browser", hostLabel: "seed", retryDelayMs: 0 });
  await session.start({ options: { readers: false, specialists: false, readersOnPlan: false, pauseAfterPlan: false, review: { targetScore: 8 } } });
  await session.waitForIdle();
  const done = await session.snapshot();
  if (done.state?.status !== "completed" || done.state.finalReview?.score !== 7.4) throw new Error(`The seed did not finish as it should: ${done.state?.status} ${done.state?.finalReview?.score} ${done.state?.lastError?.message ?? ""}`);
  return { ...REVIEW, files: store.toObject() };
}

/** The director's judgement of the whole book: 7.4, always, with the two points the corrections cite. */
const bookJudgement = () => ({
  verdict: "revise",
  score: 7.4,
  summary: "The book as a whole.",
  strengths: ["Atmosphere"],
  concerns: [{ severity: "major", issue: "The ending is not earned", suggestion: "Plant its setup earlier" }],
  decisions: [],
  nextSteps: ["Tighten the middle chapters"],
  questionsForAuthor: [],
});

/** Opens a group of the timeline of the Autopilot page (in its tab, when the page is too narrow for two columns). */
const openGroup = async (page: Page, key: string) => {
  const tab = page.getByRole("tab", { name: "Timeline", exact: true });
  const group = page.locator(`[data-timeline-group='${key}']`);
  await expect(tab.or(group).first()).toBeVisible({ timeout: 30_000 });
  if (await tab.count()) await tab.click();
  const toggle = group.locator("h3 button");
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return group;
};

/** Opens the step of a group whose line says `text`, and gives it. */
const openStep = async (group: ReturnType<Page["locator"]>, text: string) => {
  const step = group.locator("[data-timeline-row='step']").filter({ hasText: text }).first();
  await step.locator("summary").click();
  return step;
};

test("the design dialog asks the wildcards first: they read the plan before the director's review, the director triages, and the journal keeps it", async ({ page }) => {
  test.setTimeout(240_000);
  const github = watchGitHub(page);
  const seeded = await describedBook();
  const { openAi } = await seed(page, settingsOf(ai.url, [seeded]), [seeded]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // «Design the book»: the room is off until the author asks for it; asked, the dialog says what a consultation adds.
  const mark = ai.calls.length;
  await page.goto(`app/books/${DESIGN.id}/outline?tab=studio`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Design the book with the autopilot", exact: true }).click({ timeout: 30_000 });
  const dialog = page.getByRole("dialog", { name: "Design the book" });
  await dialog.getByLabel("Chapters", { exact: true }).fill("1");
  const room = dialog.getByRole("checkbox", { name: "The wildcards read the design first", exact: true });
  await expect(room).not.toBeChecked();
  await expect(dialog.locator("[data-design-wildcards-estimate]")).toHaveCount(0);
  await room.check();
  await expect(room).toHaveAccessibleDescription(/A pre-mortem before the director's first review[\s\S]*One consultation \(4 voices and the director's triage\): 5–10 AI calls/);
  // On a phone, and at 320 px, the dialog has no sideways scroll; its new words are readable in both themes (WCAG 2.2 AA: 4.5).
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await overflowing(dialog), `what is wider than the dialog at ${width} px`).toEqual([]);
    expect(await horizontalOverflow(dialog), `the dialog at ${width} px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    expect(await contrast(dialog.locator("[data-design-wildcards-estimate]")), `the estimate in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(dialog.getByText("The wildcards read the design first", { exact: true })), `the label in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
  }
  await setTheme(page, "light");
  await capture(page, "wildcards-design-dialog", { prepare: async () => { await room.scrollIntoViewIfNeeded(); } });
  await dialog.getByRole("button", { name: "Design 1 chapter", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // The design run: the room between the plan (and its readers) and the director's first review, once.
  const facts = await waitForAutopilot(page, DESIGN.repo, ["paused"], 180_000);
  expect(facts.review, "the run's policy").toEqual({ wildcards: { design: true } });
  const kinds = facts.done.map((step) => step.split(":")[0]);
  expect(kinds.filter((kind) => kind === "wildcards"), facts.done.join(", ")).toHaveLength(1);
  expect(kinds.indexOf("wildcards"), facts.done.join(", ")).toBeGreaterThan(kinds.lastIndexOf("plan"));
  expect(kinds.indexOf("wildcards"), "right before the director's first review").toBe(kinds.indexOf("plan-review") - 1);
  const tools = ai.calls.slice(mark).map((call) => call.tool);
  expect(tools.filter((tool) => tool === "wildcard_ideas"), tools.join(", ")).toHaveLength(4);
  expect(tools.filter((tool) => tool === "wildcard_triage")).toHaveLength(1);
  expect(tools.indexOf("wildcard_triage")).toBeLessThan(tools.indexOf("design_review"));

  // The journal of the room: the consultation, by the autopilot, about the plan, every idea decided by the director with its reason. No prose.
  const [journal] = await filesUnder(page, DESIGN.repo, "bible/ideas.yml");
  expect(journal?.text).toMatch(/by: autopilot\n\s+target:\n\s+kind: plan/);
  expect(journal?.text).toContain("preset: pre-mortem");
  expect(journal?.text).toMatch(/verdict: adopted[\s\S]*by: director/);
  expect((await filesUnder(page, DESIGN.repo, "chapters/")).map((file) => file.path).filter((path) => !path.endsWith("/chapter.md")), "no prose").toEqual([]);

  // The timeline, reached through the menu (the page keeps what the run said while it followed it): the step is the director's, in the group of the plan.
  await page.locator(`a[href$="/app/books/${DESIGN.id}/autopilot"]`).first().click();
  const plan = await openGroup(page, "plan");
  await expect(plan).toContainText("The wildcards look at the design");
  const step = await openStep(plan, "The wildcards look at the design");
  await expect(step).toContainText("Wildcards (Fuori dal coro) · voices: 4 · ideas: 8 · accepted by the director: 2");
  await capture(page, "wildcards-design-timeline", { prepare: async () => { await step.getByText(/^Wildcards \(Fuori dal coro\) · voices/).evaluate((element) => element.scrollIntoView({ block: "center" })); } });

  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});

test("a review of the book that stalls asks the room in the browser: two voices and the director's triage at the stall, the journal of the room, and what the run says of it", async ({ page }) => {
  test.setTimeout(240_000);
  const github = watchGitHub(page);
  const seeded = await reviewedBook();
  const { openAi } = await seed(page, settingsOf(ai.url, [seeded]), [seeded]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // The Review tab: the room at a stall, with two voices; it says that the stall needs a round for the whole book while that is off in the settings.
  await page.goto(`app/books/${REVIEW.id}/autopilot/settings#autopilot-review`, { waitUntil: "domcontentloaded" });
  const part = page.locator("[data-wildcards-field]");
  await expect(part.getByRole("heading", { name: "Wildcards (Fuori dal coro)", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(part.getByLabel("Voices in a consultation", { exact: true })).toBeDisabled();
  await part.getByRole("checkbox", { name: "When a review of the book stalls", exact: true }).check();
  await expect(part.locator("[data-wildcards-needs-book-round]")).toContainText("It works with a round for the book as a whole");
  await part.getByLabel("Voices in a consultation", { exact: true }).fill("2");
  await expect(part.locator("[data-wildcards-estimate]")).toContainText("One consultation (2 voices and the director's triage): 3–6 AI calls");
  // The part fits a phone and a screen 320 px wide, and its words are readable in both themes (WCAG 2.2 AA: 4.5 for text of normal size).
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await overflowing(part), `what is wider than the part at ${width} px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `the page at ${width} px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  const readable: Array<[string, ReturnType<Page["locator"]>]> = [
    ["the intro", part.locator("p").first()],
    ["a hint", part.locator(`[id$='-wildcards-plateau-hint']`)],
    ["the note on the round for the whole book", part.locator("[data-wildcards-needs-book-round]")],
    ["the estimate", part.locator("[data-wildcards-estimate]")],
  ];
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    for (const [name, locator] of readable) expect(await contrast(locator), `${name} in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
  }
  await setTheme(page, "light");
  await capture(page, "wildcards-review-tab", { prepare: async () => { await part.evaluate((element) => element.scrollIntoView({ block: "center" })); } });
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect.poll(async () => (await autopilotFacts(page, REVIEW.repo))?.review, { timeout: 20_000 }).toEqual({ targetScore: 8, wildcards: { plateau: true, voices: 2 } });

  // The book is under its target and every chapter has its own: the author reviews the book as a whole, the corrections carried out as the director asks them. The run goes on
  // in this browser, which registered the room's plateau breaker when its autopilot started; the director judges the book 7 every time, so the review stalls.
  await page.goto(`app/books/${REVIEW.id}/autopilot`, { waitUntil: "domcontentloaded" });
  const block = page.locator("[data-autopilot-result] [data-result-book-round]");
  await block.getByRole("button", { name: "Review the book as a whole", exact: true }).click({ timeout: 30_000 });
  const dialog = page.getByRole("dialog", { name: "Review the book again" });
  await dialog.getByLabel("Score to reach", { exact: true }).fill("8");
  await dialog.getByRole("radio", { name: "Correct the book", exact: true }).check();
  const mark = ai.calls.length;
  await dialog.getByRole("button", { name: "Ask for the corrections of the book", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  const facts = await waitForAutopilot(page, REVIEW.repo, ["completed"], 200_000);
  const tools = ai.calls.slice(mark).map((call) => call.tool);
  expect(tools.filter((tool) => tool === "wildcard_ideas"), tools.join(", ")).toHaveLength(2);
  expect(tools.filter((tool) => tool === "wildcard_triage")).toHaveLength(1);
  const corrections = facts.done.filter((step) => step === "book-corrections::").length;
  expect(corrections, facts.done.join(", ")).toBeGreaterThanOrEqual(3);
  expect(facts.review, "the review's own choices did not change the settings of the book").toEqual({ targetScore: 8, wildcards: { plateau: true, voices: 2 } });

  const [journal] = await filesUnder(page, REVIEW.repo, "bible/ideas.yml");
  expect(journal?.text).toMatch(/by: autopilot\n\s+target:\n\s+kind: book/);
  expect(journal?.text).toContain("preset: creative-room");

  // What the run said, in the timeline of the page it followed it on: the room's consultation and the stall it took on.
  const final = await openGroup(page, "final");
  // The step that took the stall on: the two voices, the director's triage and the corrections, four calls.
  const step = await openStep(final, "4 calls");
  await expect(step).toContainText("The director lists the corrections of the whole book");
  await expect(step).toContainText("Wildcards (Fuori dal coro) · voices: 2 · ideas: 4 · accepted by the director: 2", { timeout: 30_000 });
  await expect(step).toContainText("The review had stopped getting better");
  await capture(page, "wildcards-plateau-timeline", { prepare: async () => { await step.getByText(/^Wildcards \(Fuori dal coro\) · voices/).evaluate((element) => element.scrollIntoView({ block: "center" })); } });

  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});
