import { expect, test, type Locator, type Page } from "@playwright/test";
import { engineModule, openApp, seed, settingsOf, startProvider, waitForAiSettings, type SeedBook, type StubProvider } from "./helpers/autopilot";

// #122 in a real browser, with a stub provider that counts the tokens of what it is sent (about four characters each) and serves from a cache the start a request shares with the
// one before it: the author writes long messages to the Copilot on a model with a window of 32,000 tokens, the ring next to Send rises turn after turn, the chat compacts by
// itself at the threshold (the marker says how many messages were summarised, every message stays in the chat), `/compact` from the menu of the slash commands compacts again,
// «Undo for the next message» sends what that compaction summarised as it is, once, and the popover of the ring shows what the next message carries with the measured cached share.

test.use({ serviceWorkers: "block" });

const BOOK = { id: "book-long-context", repo: "e2e-local-long-context", name: "La casa sul colle" };
const SUMMARY = "- The author is asking about the chapters one at a time.\n- Every answer so far is a long one.";

async function emptyBook(entry: { id: string; repo: string; name: string }): Promise<SeedBook> {
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  return { ...entry, files: new MemoryBookStore(seedBookFiles({ chapters: 0, title: entry.name })).toObject() };
}

/** A model with a window of 32,000 tokens, an answer of at most 2,000, and prices. */
function smallWindow(url: string, books: readonly SeedBook[]) {
  const base = settingsOf(url, books);
  return {
    ...base,
    ui: { language: "en", theme: "light" },
    aiIntegrations: base.aiIntegrations.map((integration) => ({ ...integration, chatModels: integration.chatModels.map((model) => ({ ...model, maxInputTokens: 32_000, maxOutputTokens: 2_000, pricing: { inputPerMTok: 2, cachedPerMTok: 0.5, outputPerMTok: 8 } })) })),
  } as ReturnType<typeof settingsOf>;
}

const words = (count: number, seed: number) => Array.from({ length: count }, (_, index) => ["casa", "colle", "chiave", "ottone", "villa", "notte", "lettera", "giardino", "pioggia", "ritorno"][(index * 7 + seed) % 10]).join(" ");

/** What the stub was sent: each request, with the words of its system and user messages. */
const sent: Array<{ tool?: string; system: string; user: string }> = [];
let previous = "";
let summaries = 0;
let ai: StubProvider;
test.beforeAll(async () => {
  ai = await startProvider({
    answers: {
      // A long answer each time: about 3,000 tokens.
      copilot_turn: (user) => ({ reply: `Answer to «${/Turn \d+/.exec(user.slice(user.lastIndexOf("<current_request")))?.[0] ?? "the request"}»: ${words(1_800, user.length)}`, calls: [] }),
    },
    prose: (_user, system) => (system.startsWith("Merge the previous summary") ? `${SUMMARY}\n- Summary number ${(summaries += 1)}.` : undefined),
    usage: ({ system, user, tool, raw }) => {
      sent.push({ ...(tool ? { tool } : {}), system, user });
      // The start this request shares with the one before it, served from a cache by 128 tokens at a time from 1,024 on, as OpenAI does.
      let shared = 0;
      while (shared < raw.length && shared < previous.length && raw[shared] === previous[shared]) shared += 1;
      previous = raw;
      const cachedTokens = Math.floor(shared / 4 / 128) * 128;
      return { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 600, ...(cachedTokens >= 1_024 ? { cached_tokens: cachedTokens } : {}) };
    },
  });
});
test.afterAll(async () => { await ai.close(); });

const percentOf = async (panel: Locator) => Number(await panel.locator("[data-context-ring]").getAttribute("data-context-percent"));

async function ask(page: Page, panel: Locator, text: string, answered: number): Promise<void> {
  await panel.locator("textarea").fill(text);
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.locator(".doc-prose").filter({ hasText: /^Answer to/ })).toHaveCount(answered, { timeout: 30_000 });
  // The turn is over, and a compaction it started (at the threshold) too.
  await expect(panel.locator("textarea")).toHaveValue("");
  await page.waitForTimeout(300);
  await expect(panel.locator("[data-context-ring]")).not.toHaveAttribute("data-context-ring", "compacting", { timeout: 30_000 });
}

test("the context ring rises turn after turn, the chat compacts by itself at the threshold, /compact compacts again, and «Undo for the next message» sends what it summarised as it is", async ({ page }) => {
  test.setTimeout(240_000);
  await page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  const books = [await emptyBook(BOOK)];
  const { openAi } = await seed(page, smallWindow(ai.url, books), books);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await page.goto(`app/books/${BOOK.id}/outline`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Synopsis" })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Copilot", exact: true }).click();
  const panel = page.locator('[data-assistant-mode="copilot"]');
  await expect(panel).toBeVisible();
  const ring = panel.locator("[data-context-ring] > button");
  await expect(ring).toHaveAccessibleName(/^\d+% of the context \(\d[\d,]* of 32,000 tokens\), window from the model's configuration\. The instructions, the page and the tools are counted after the first message\.$/);

  // Turn after turn the ring rises, until the chat compacts by itself.
  const percents: number[] = [await percentOf(panel)];
  let turn = 0;
  const auto = panel.locator('[data-context-marker="auto"]');
  while ((await auto.count()) === 0 && turn < 12) {
    turn += 1;
    await ask(page, panel, `Turn ${turn}: tell me more about the house on the hill. ${words(600, turn)}`, turn);
    if ((await auto.count()) === 0) percents.push(await percentOf(panel));
  }
  await expect(auto).toHaveCount(1, { timeout: 30_000 });
  const autoTurn = turn;
  expect(turn, `the chat compacted after ${turn} turns (${percents.join("% → ")}%)`).toBeGreaterThanOrEqual(3);
  for (let index = 1; index < percents.length; index += 1) expect(percents[index], `the ring rose: ${percents.join("% → ")}%`).toBeGreaterThan(percents[index - 1]);
  expect(percents[percents.length - 1]).toBeGreaterThan(50);
  await expect(auto).toContainText(/^Context compacted: \d+ messages summarised/);
  await expect(ring).not.toHaveAccessibleName(/counted after the first message/);
  const afterAuto = await percentOf(panel);
  expect(afterAuto, `after the compaction the ring went down (${percents[percents.length - 1]}% → ${afterAuto}%)`).toBeLessThan(percents[percents.length - 1]);
  expect(sent.some((request) => !request.tool && request.system.startsWith("Merge the previous summary")), "the summary was asked of a model (chat-resume)").toBe(true);
  // Every message stays in the chat.
  await expect(panel.getByText(/^Turn 1: tell me more about the house on the hill\./)).toHaveCount(1);
  await auto.getByRole("button", { name: "Show the summary" }).click();
  await expect(auto).toContainText("The author is asking about the chapters one at a time.");

  // The next request carries the summary and the recent messages: not the first turn.
  turn += 1;
  await ask(page, panel, `Turn ${turn}: and the garden? ${words(600, turn)}`, turn);
  const afterCompaction = sent.filter((request) => request.tool === "copilot_turn").at(-1)!;
  expect(afterCompaction.user).toContain("<compaction_summary");
  expect(afterCompaction.user).toContain("The author is asking about the chapters one at a time.");
  expect(afterCompaction.user).not.toContain("Turn 1: tell me more about the house on the hill.");

  // `/compact` from the menu of the slash commands: the arrows, Enter.
  turn += 1;
  await ask(page, panel, `Turn ${turn}: and the garden? ${words(600, turn)}`, turn);
  const composer = panel.locator("textarea");
  await composer.fill("/");
  const menu = panel.getByRole("listbox", { name: "Commands" });
  await expect(menu.getByRole("option")).toHaveText([/^\/compact/, /^\/context/]);
  await expect(composer).toHaveAttribute("aria-activedescendant", (await menu.getByRole("option").first().getAttribute("id"))!);
  await composer.press("ArrowDown");
  await composer.press("ArrowUp");
  await composer.press("Enter");
  const manual = panel.locator('[data-context-marker="manual"]');
  await expect(manual).toHaveCount(1, { timeout: 30_000 });
  await expect(manual).toContainText(/^Context compacted on request: \d+ messages summarised/);
  await expect(composer).toHaveValue("");

  // «Undo for the next message»: that request carries what /compact summarised, as it is (with the summary in force before it), and then /compact's summary is in force again.
  const summarised = `Turn ${autoTurn}: tell me more about the house on the hill.`;
  await manual.getByRole("button", { name: "Undo for the next message" }).click();
  await expect(manual.getByRole("status")).toHaveText("The next message carries these messages as they are, once.");
  turn += 1;
  await ask(page, panel, `Turn ${turn}: one more. ${words(100, turn)}`, turn);
  const undone = sent.filter((request) => request.tool === "copilot_turn").at(-1)!;
  expect(undone.user).toContain(summarised);
  expect(undone.user).toContain("Summary number 1.");
  expect(undone.user).not.toContain("Summary number 2.");
  await expect(manual.getByRole("button", { name: "Undo for the next message" })).toBeVisible();
  turn += 1;
  await ask(page, panel, `Turn ${turn}: and the last one. ${words(100, turn)}`, turn);
  const again = sent.filter((request) => request.tool === "copilot_turn").at(-1)!;
  expect(again.user, "compacted again").not.toContain(summarised);
  expect(again.user).toContain("Summary number 2.");

  // The popover of the ring: what the next message carries, the cached share the provider reported, the cost.
  await ring.click();
  const popover = panel.getByRole("dialog", { name: "Context of the next message" });
  await expect(popover.getByRole("rowheader")).toHaveText(["Instructions and tools", "Canon and files", "Page state", "Attachments and material", "Compacted summary", "Conversation", "Your message"]);
  await expect(popover).toContainText(/Last request: \d+% served from the provider's cache \(\d[\d,]* of \d[\d,]* tokens\)\./);
  await expect(popover).toContainText(/Next message: about \$0\.\d+ of input\./);
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(ring).toBeFocused();

  // `/context` prints the same in the chat, as a note that is never sent.
  await composer.fill("/context");
  await composer.press("Enter");
  const note = panel.locator("[data-local-note]");
  await expect(note).toContainText("Context of the next message");
  await expect(note.getByRole("table")).toBeVisible();
  expect(openAi).toEqual([]);
});
