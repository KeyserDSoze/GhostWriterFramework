import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { engineModule, filesUnder, openApp, seed, settingsOf, waitForAiSettings, type SeedBook } from "./helpers/autopilot";

// Brainstorming, the Copilot's mode on the Synopsis page, on a book kept on this device with GitHub out of reach and no credential: the author enters it
// from the page, asks to move a chapter and to create one, sees the difference of every file and what the autopilot will do about each chapter before
// anything is applied, confirms, and the Synopsis of the book changes. The mode wears its own colours, and the way back to the Copilot is there.

test.use({ serviceWorkers: "block" });

const BOOK = { id: "book-brainstorm", repo: "e2e-local-brainstorm", name: "The Glass Harbor" };
/** Brainstorming's accent in the light theme, an orange-700: `--primary: 17 88% 40%`, as the browser paints it. */
const ACCENT = "rgb(192, 63, 12)";

interface BrainstormProvider {
  url: string;
  /** The system prompt and the request of every call, in order. */
  calls: Array<{ system: string; user: string }>;
  close(): Promise<void>;
}

/** An OpenAI-compatible provider that answers Brainstorming's request with its JSON: a series of edits of the Synopsis, a move and a new chapter. */
async function startBrainstormProvider(): Promise<BrainstormProvider> {
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
      ? JSON.stringify({
        reply: "Open with the vault: the key then answers the question it raises. And let the flood close the book, so the lie surfaces at last.",
        calls: [{ tool: "propose_synopsis_edits", args: { summary: "The vault before the key, and the flood at the end.", edits: [{ kind: "move", from: 3, to: 2 }, { kind: "append", title: "The flood", body: "The harbor floods and the lie surfaces." }] } }],
      })
      : "This provider only answers Brainstorming.";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "cmpl-1", object: "chat.completion", model: "fake-model", usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] }));
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    calls,
    close: () => new Promise<void>((closed) => { server.closeAllConnections(); server.close(() => closed()); }),
  };
}

const scene = { number: 1, title: "A scene", goal: "", beats: [], characters: [], status: "reviewed", revisions: 0 };
const planned = (number: number, title: string, status: string) => ({ number, title, slug: `00${number}-${title.toLowerCase().replace(/\W+/g, "-")}`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status, scenes: status === "done" ? [scene] : [], outlineDigest: "0123456789abcdef" });

/** A book of three chapter entries; the autopilot, paused, has approved the first two and planned the third. */
async function library(): Promise<SeedBook[]> {
  const { serializeOutlineBook, serializeOutlineChapter } = await engineModule("index.js");
  const { seedBookFiles } = await engineModule("testing/index.js");
  return [{
    ...BOOK,
    files: {
      ...seedBookFiles({ title: BOOK.name }),
      "outline/book.md": serializeOutlineBook({ body: "A harbor town built on glass hides a lie that the tide will tell.", origin: "author" }),
      "outline/chapters/001.md": serializeOutlineChapter({ number: 1, title: "Arrival", body: "Mira arrives at the glass harbor.", origin: "author" }),
      "outline/chapters/002.md": serializeOutlineChapter({ number: 2, title: "The key", body: "Mira finds the key of the old vault.", origin: "author" }),
      "outline/chapters/003.md": serializeOutlineChapter({ number: 3, title: "The vault", body: "Mira opens the vault and finds the ledger.", origin: "author" }),
      "autopilot/state.json": JSON.stringify({ status: "paused", phase: "writing", options: { frozenEdits: "ask" }, plan: { approved: true, chapters: [planned(1, "Arrival", "done"), planned(2, "The key", "done"), planned(3, "The vault", "planned")] } }),
    },
  }];
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

const background = (page: Page, selector: string) => page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor);

let ai: BrainstormProvider;
test.beforeAll(async () => { ai = await startBrainstormProvider(); });
test.afterAll(async () => { await ai.close(); });

test("Brainstorming moves a chapter and creates one in the Synopsis of a book kept on this device, after showing the difference and what the autopilot will do", async ({ page }) => {
  const github = watchGitHub(page);
  const books = await library();
  const { openAi } = await seed(page, settingsOf(ai.url, books), books);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  await page.goto(`app/books/${BOOK.id}/outline`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Synopsis" })).toBeVisible();
  await expect(page.locator("#outline-chapter-3")).toBeVisible();
  // Its button on the page and in the launcher of the shell, in the accent of the mode.
  const open = page.locator("[data-brainstorm-open]");
  await expect(open).toBeEnabled();
  await expect(page.locator("[data-brainstorm-launcher]")).toBeVisible();
  expect(await background(page, "[data-brainstorm-open]")).toBe(ACCENT);
  expect(await background(page, "[data-brainstorm-launcher]")).toBe(ACCENT);

  await open.click();
  const panel = page.locator('[data-assistant-mode="brainstorming"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Brainstorming", { exact: true })).toBeVisible();
  await expect(panel.locator("svg[data-brainstorm-mark]")).toBeVisible();
  await expect(panel.locator("[data-brainstorm-starters]")).toBeVisible();
  expect(await panel.evaluate((element) => getComputedStyle(element).getPropertyValue("--ring").trim()), "the focus ring of the mode").toBe("17 88% 40%");

  await panel.getByPlaceholder("Ask about the big design of the book…").fill("Move chapter 3 before chapter 2, and add a last chapter: the flood.");
  await panel.getByRole("button", { name: "Send" }).click();

  const proposal = panel.locator('[data-brainstorm-proposal="synopsis"]');
  await expect(proposal).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator(".doc-prose p", { hasText: "Open with the vault" })).toBeVisible();
  expect(await background(page, '[data-assistant-mode="brainstorming"] .bg-primary.whitespace-pre-wrap'), "the author's bubble").toBe(ACCENT);
  // What the autopilot will do, before anything is applied: chapter 2 is approved (it asks), chapter 3 is not written (it plans it again).
  const consequences = proposal.locator("[data-brainstorm-consequences]");
  await expect(consequences.locator('[data-outcome="ask"]')).toContainText("Chapter 2 is already written: after this change the autopilot will ask you whether to rewrite it");
  await expect(consequences.locator('[data-outcome="replan"]')).toContainText("Chapter 3 is not written yet: the autopilot plans it again");
  // The difference of every file.
  await expect(proposal.locator("details")).toHaveCount(3);
  await expect(proposal.getByText("The harbor floods and the lie surfaces.").first()).toBeVisible();
  expect((await filesUnder(page, BOOK.repo, "outline/chapters/")).map((file) => file.path).sort(), "nothing is written yet").toEqual(["outline/chapters/001.md", "outline/chapters/002.md", "outline/chapters/003.md"]);

  await proposal.getByRole("button", { name: "Apply to the Synopsis" }).click();
  const confirm = page.getByRole("dialog", { name: "Apply these changes to the Synopsis?" });
  await expect(confirm).toBeVisible();
  await expect(confirm.locator('[data-outcome="ask"]')).toBeVisible();
  await confirm.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(proposal.getByText("Applied", { exact: true })).toBeVisible({ timeout: 20_000 });

  const outline = Object.fromEntries((await filesUnder(page, BOOK.repo, "outline/chapters/")).map((file) => [file.path, file.text]));
  expect(Object.keys(outline).sort()).toEqual(["outline/chapters/001.md", "outline/chapters/002.md", "outline/chapters/003.md", "outline/chapters/004.md"]);
  expect(outline["outline/chapters/002.md"]).toContain("title: The vault");
  expect(outline["outline/chapters/003.md"]).toContain("title: The key");
  expect(outline["outline/chapters/004.md"]).toContain("title: The flood");
  expect(outline["outline/chapters/004.md"]).toContain("origin: author");

  // Brainstorming asked through the AI router with its own instructions and only its own tools, and the Copilot was never asked.
  expect(ai.calls).toHaveLength(1);
  expect(ai.calls[0].system).toContain("propose_synopsis_edits");
  expect(ai.calls[0].system).not.toContain("multi-file-edit");
  expect(ai.calls[0].user).toContain("Mira opens the vault and finds the ledger.");

  // The way back to the Copilot, and the page shows the new Synopsis.
  await panel.locator("[data-brainstorm-back]").click();
  await expect(page.locator('[data-assistant-mode="copilot"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#outline-chapter-4")).toBeVisible({ timeout: 20_000 });
  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});
