import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { engineModule, openApp, seed, settingsOf, TEXT_TASKS, waitForAiSettings, type SeedBook } from "./helpers/autopilot";

// Prompt caching, from the provider to the Costs page, on a book kept on this device. The fake provider caches the way OpenAI does: a request that starts with what the one before it started with, for at least
// 1,024 tokens, is answered with the tokens it served from its cache (`prompt_tokens_details.cached_tokens`, in steps of 128). The author asks Brainstorming three questions about the Synopsis of a book; the
// book and the conversation come before the question in its prompts, so the turns after the first two are served from the cache (the book that Brainstorming reads may be completed by the page's structure, which loads while
// the first turn is asked: the first two turns may differ in their first lines, and from the third on nothing does). The ledger of the costs says it, and so does the Costs page: the share of the input that
// was served from the cache, and the money that saved against the full input rate, for the model that did it. The page changes no setting for it (the row of the model says «learned» from the ledger), and
// once it knows that a model caches it sends the provider the key that helps it find the cache, a short name that is not the book.

test.use({ serviceWorkers: "block" });

const BOOK = { id: "book-cache", repo: "e2e-local-cache", name: "The Glass Harbor" };
const PRICE = { inputPerMTok: 2, cachedPerMTok: 0.2, outputPerMTok: 8 };
const QUESTIONS = ["Is the middle of the book too slow?", "What if the ledger were revealed earlier?", "Which chapters carry the antagonist best?", "What would a stronger midpoint look like?"];

interface CachingCall {
  /** The tokens of the request (the engine's estimate: four characters a token), and what the fake provider served of them from its cache. */
  prompt: number;
  cached: number;
  cacheKey: unknown;
}

interface CachingProvider {
  url: string;
  calls: CachingCall[];
  close(): Promise<void>;
}

/** The step of a provider that caches: nothing under 1,024 tokens, then whole steps of 128. */
const served = (prefix: number): number => (prefix < 1024 ? 0 : 1024 + Math.floor((prefix - 1024) / 128) * 128);

async function startCachingProvider(): Promise<CachingProvider> {
  const calls: CachingCall[] = [];
  let previous = "";
  const server: Server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "*");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [] })); return; }
    let raw = "";
    for await (const piece of request) raw += piece;
    const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }>; prompt_cache_key?: unknown };
    const text = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");
    const wire = (body.messages ?? []).map((message) => `[${message.role}]\n${text(message.content)}`).join("\n");
    let common = 0;
    while (common < wire.length && common < previous.length && wire[common] === previous[common]) common += 1;
    previous = wire;
    const prompt = Math.ceil(wire.length / 4);
    const cached = Math.min(prompt, served(Math.floor(common / 4)));
    calls.push({ prompt, cached, cacheKey: body.prompt_cache_key });
    const content = JSON.stringify({ reply: "The middle holds if the ledger turns up a chapter earlier: the reader then has a reason to keep the harbor in mind.", calls: [] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "cmpl-1", object: "chat.completion", model: "fake-model",
      usage: { prompt_tokens: prompt, completion_tokens: 50, total_tokens: prompt + 50, prompt_tokens_details: { cached_tokens: cached } },
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    }));
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    calls,
    close: () => new Promise<void>((closed) => { server.closeAllConnections(); server.close(() => closed()); }),
  };
}

/** A book of twelve chapter entries, so that the Synopsis (which Brainstorming reads whole) is long enough for the start of its prompts to be cached. */
async function library(): Promise<SeedBook[]> {
  const { serializeOutlineBook, serializeOutlineChapter } = await engineModule("index.js");
  const { seedBookFiles } = await engineModule("testing/index.js");
  const words = (count: number, seed: number) => Array.from({ length: count }, (_, index) => ["harbor", "glass", "lie", "tide", "ledger", "council", "light", "silence", "inherit", "secret"][(index * 3 + seed) % 10]).join(" ");
  const files: Record<string, string> = {
    ...seedBookFiles({ title: BOOK.name }),
    "outline/book.md": serializeOutlineBook({ body: `A harbor town built on glass hides a lie that the tide will tell. ${words(120, 1)}`, origin: "author" }),
  };
  for (let number = 1; number <= 12; number += 1) files[`outline/chapters/${String(number).padStart(3, "0")}.md`] = serializeOutlineChapter({ number, title: `Chapter ${number} title`, body: words(110, number), origin: "author" });
  return [{ ...BOOK, files }];
}

const money = (value: number, currency: string) => new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2 }).format(value);
const compact = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

async function ask(page: Page, question: string, answered: number): Promise<void> {
  const panel = page.locator('[data-assistant-mode="brainstorming"]');
  await panel.getByPlaceholder("Ask about the big design of the book…").fill(question);
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.locator(".doc-prose p", { hasText: "The middle holds if the ledger" })).toHaveCount(answered, { timeout: 20_000 });
}

let ai: CachingProvider;
test.beforeAll(async () => { ai = await startCachingProvider(); });
test.afterAll(async () => { await ai.close(); });

test("a provider that serves the next turn from its cache: the ledger and the Costs page say how much of the input and how much money, and the page changes no setting for it", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1500, height: 1000 });
  const books = await library();
  const base = settingsOf(ai.url, books);
  const settings = {
    ...base,
    costCurrency: "USD",
    aiIntegrations: base.aiIntegrations.map((integration) => ({ ...integration, chatModels: integration.chatModels.map((model) => ({ ...model, pricing: PRICE, capabilities: TEXT_TASKS.filter((task) => task !== "brainstorming") })) })),
    taskRouting: { copilot: { primary: { integrationId: "fake-ai", model: "fake-model" }, fallbacks: [] } },
  };
  const { openAi } = await seed(page, settings, books);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);

  // Four questions to Brainstorming about the same book.
  await page.goto(`app/books/${BOOK.id}/outline`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#outline-chapter-12")).toBeVisible();
  await page.locator("[data-brainstorm-open]").click();
  await expect(page.locator('[data-assistant-mode="brainstorming"]')).toBeVisible();
  for (const [index, question] of QUESTIONS.entries()) await ask(page, question, index + 1);

  // The provider served the last two from its cache: the book and the conversation came first, and the question last.
  expect(ai.calls).toHaveLength(QUESTIONS.length);
  expect(ai.calls[0].cached, "nothing was asked before the first").toBe(0);
  for (const call of ai.calls.slice(2)) expect(call.cached / call.prompt, "most of a turn is what the turn before it had").toBeGreaterThan(0.8);
  // The page sends the key that helps a provider find its cache once it knows that this one has one: not before, and never the book.
  ai.calls.forEach((call, index) => {
    const known = ai.calls.slice(0, index).some((earlier) => earlier.cached > 0);
    expect(typeof call.cacheKey, `call ${index + 1}: the key is sent once a response has shown the cache`).toBe(known ? "string" : "undefined");
    if (known) expect(call.cacheKey).toMatch(/^narrarium-[0-9a-f]{16}$/);
  });
  expect(ai.calls.some((call) => call.cached > 0), "and a response did").toBe(true);
  expect(openAi, "no request went to the real OpenAI").toEqual([]);

  // The Costs page: the share of the input that was served from a cache, and what that saved against the full input rate, for the model.
  const cached = ai.calls.reduce((sum, call) => sum + call.cached, 0);
  const input = ai.calls.reduce((sum, call) => sum + call.prompt, 0);
  const saved = (cached * (PRICE.inputPerMTok - PRICE.cachedPerMTok)) / 1_000_000;
  await page.goto("app/costs", { waitUntil: "domcontentloaded" });
  const panel = page.locator("[data-costs-cache]");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole("heading", { name: "Prompt cache" })).toBeVisible();
  const summary = panel.locator("[data-cache-summary]");
  await expect(summary).toContainText(`${Math.round((cached / input) * 100)}% of the input (${compact(cached)} of ${compact(input)} tokens) was served from the provider's cache`);
  await expect(summary).toContainText(`saved ${money(saved, "USD")}`);
  const line = panel.locator("[data-cache-line]");
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("fake-model");
  await expect(line).toContainText(`${Math.round((cached / input) * 100)}% from cache`);
  await expect(line).toContainText(`saved ${money(saved, "USD")}`);

  // The page changed no setting for it: the row of the model has no word of caching in what is saved, and says «learned» from the ledger.
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("narrarium-settings-cache-v2:")).map((key) => localStorage.getItem(key) ?? "").join("\n"));
  expect(stored).not.toContain("promptCaching");
  await page.goto("app/settings/ai-integrations", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-prompt-caching='learned']")).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator("[data-prompt-caching-row]").first().getByLabel("Cached input (USD / 1M tokens)")).toHaveValue("0.2");
});
