import { expect, test, type Page } from "@playwright/test";
import { engineModule, filesUnder, openApp, routedSettingsOf, seed, settingsOf, startProvider, waitForAiSettings, type SeedBook, type StubProvider } from "./helpers/autopilot";
import { longSynopsis } from "../src/narrarium-site/test-browser/fixtures/longSynopsis";
import { chaptersAnswer } from "../src/narrarium-site/test-browser/fixtures/longSynopsisAnswers";

// #121 in a real browser, on a book kept on this device with GitHub out of reach, with a model configured like the owner's (a 1,000,000-token window, 65,536 tokens of output, a
// price): the author pastes a 63,000-character synopsis of 37 chapters into the Copilot on the Synopsis page, sets it apart as material, asks «crea i capitoli basandoti esattamente
// su questo testo», sees the progress, reviews the 37 entries in one table, applies them once, and the Synopsis shows them. Brainstorming, given the same paste in its chat, reaches
// the provider and answers with the proposal of the 37 entries. A request whose first model fails and whose fallback a routing limit keeps out says the limit and its numbers, and
// one click raises it and sends the request again, which the fallback answers.

test.use({ serviceWorkers: "block" });

const DOC = longSynopsis();
const ASK = "crea i capitoli basandoti esattamente su questo testo";
const COPILOT_BOOK = { id: "book-long-paste", repo: "e2e-local-long-paste", name: "Le correnti di Ancona" };
const BRAINSTORM_BOOK = { id: "book-long-paste-brainstorm", repo: "e2e-local-long-paste-brainstorm", name: "Le correnti di Ancona (Brainstorming)" };
const LIMIT_BOOK = { id: "book-long-paste-limit", repo: "e2e-local-long-paste-limit", name: "Le correnti di Ancona (limiti)" };

async function emptyBook(entry: { id: string; repo: string; name: string }): Promise<SeedBook> {
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  return { ...entry, files: new MemoryBookStore(seedBookFiles({ chapters: 0, title: entry.name })).toObject() };
}

/** The owner's model: what a large model of today is configured with in AI Integrations. */
function ownerLike(url: string, books: readonly SeedBook[], extra: Record<string, unknown> = {}) {
  const base = settingsOf(url, books);
  return {
    ...base,
    ui: { language: "en", theme: "light" },
    aiIntegrations: base.aiIntegrations.map((integration) => ({ ...integration, chatModels: integration.chatModels.map((model) => ({ ...model, maxInputTokens: 1_000_000, maxOutputTokens: 65_536, pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } })) })),
    ...extra,
  } as ReturnType<typeof settingsOf>;
}

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

async function openSynopsis(page: Page, bookId: string) {
  await page.goto(`app/books/${bookId}/outline`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Synopsis" })).toBeVisible({ timeout: 30_000 });
}

async function closePanel(page: Page, mode: "copilot" | "brainstorming"): Promise<void> {
  const panel = page.locator(`[data-assistant-mode="${mode}"]`);
  await panel.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(panel).toBeHidden({ timeout: 15_000 });
}

/** What a model configured like the owner's says of itself in AI Integrations: a window of 1,000,000 tokens, 65,536 of output, a price. */
const OWNER_LIKE = { maxInputTokens: 1_000_000, maxOutputTokens: 65_536, pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } };

let ai: StubProvider;
/** A provider whose model is not there: it refuses every request, and the router goes on to the fallback, if the limits let it. */
let gone: StubProvider;
test.beforeAll(async () => {
  gone = await startProvider({ name: "gone", behavior: { kind: "error", status: 400, message: "The model gone-model does not exist." } });
  ai = await startProvider({
    // Slow enough for the progress of the reading to be seen.
    delayMs: 300,
    answers: {
      synopsis_chapters: (user) => chaptersAnswer(user),
      copilot_turn: () => ({ reply: "È una sinossi lunga: posso trasformarla nella Sinossi del libro quando vuoi.", calls: [] }),
    },
  });
});
test.afterAll(async () => { await ai.close(); await gone.close(); });

test("the Copilot turns a pasted synopsis of 37 chapters into the Synopsis: material in one click, the progress, one table of 37 entries, one apply", async ({ page }) => {
  test.setTimeout(180_000);
  const github = watchGitHub(page);
  const books = [await emptyBook(COPILOT_BOOK)];
  const { openAi } = await seed(page, ownerLike(ai.url, books), books);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await openSynopsis(page, COPILOT_BOOK.id);
  const before = ai.asked.length;

  await page.getByRole("button", { name: "Copilot", exact: true }).click();
  const panel = page.locator('[data-assistant-mode="copilot"]');
  await expect(panel).toBeVisible();
  const composer = panel.locator("textarea");
  await composer.fill(`${ASK}\n\n${DOC}`);
  const offer = panel.locator("[data-material-offer]");
  await expect(offer).toContainText("characters: the text goes as material to read, and what you write in the box is the request.");
  await offer.getByRole("button", { name: "Use this text as material" }).click();
  await expect(composer).toHaveValue(ASK);
  await expect(panel.locator("[data-attachment-material]")).toContainText(`Pasted text (${DOC.trim().length.toLocaleString("en-US")} characters)`);

  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByText(/Leggo il testo: capitoli \d+-\d+ di 37…/)).toBeVisible({ timeout: 30_000 });

  const review = panel.locator('[data-page-review="outline"]');
  await expect(review).toBeVisible({ timeout: 60_000 });
  await expect(review.getByRole("heading", { name: "Proposed changes to the Synopsis" })).toBeVisible();
  const table = review.getByRole("table");
  await expect(table.getByRole("rowheader")).toHaveCount(37);
  await expect(table.locator('tr[data-change="created"]')).toHaveCount(37);
  await expect(panel.locator(".doc-prose p", { hasText: "Ho letto 37 capitoli su 37 del testo: 37 nuove voci della Sinossi, 0 voci aggiornate." })).toBeVisible();
  expect(ai.asked.slice(before), "seven batches of chapters, nothing else").toEqual(Array(7).fill("synopsis_chapters"));
  expect(await filesUnder(page, COPILOT_BOOK.repo, "outline/chapters/"), "nothing is written yet").toEqual([]);

  await review.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await filesUnder(page, COPILOT_BOOK.repo, "outline/chapters/")).length, { timeout: 30_000 }).toBe(37);
  const entries = Object.fromEntries((await filesUnder(page, COPILOT_BOOK.repo, "outline/chapters/")).map((file) => [file.path, file.text]));
  expect(entries["outline/chapters/001.md"]).toContain("origin: author");
  expect(entries["outline/chapters/001.md"]).toContain("Marco arriva alla villa sul colle con una chiave d'ottone");
  expect(entries["outline/chapters/037.md"]).toContain("title:");

  await closePanel(page, "copilot");
  await expect(page.locator("#outline-chapter-37")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#outline-chapter-1")).toBeVisible();
  expect(github, "no request went to GitHub").toEqual([]);
  expect(openAi).toEqual([]);
});

test("Brainstorming, given the same paste in its chat, reaches the provider and answers with the proposal of the 37 entries", async ({ page }) => {
  test.setTimeout(180_000);
  const github = watchGitHub(page);
  const books = [await emptyBook(BRAINSTORM_BOOK)];
  const { openAi } = await seed(page, ownerLike(ai.url, books), books);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await openSynopsis(page, BRAINSTORM_BOOK.id);
  const before = ai.asked.length;

  await page.locator("[data-brainstorm-open]").click();
  const panel = page.locator('[data-assistant-mode="brainstorming"]');
  await expect(panel).toBeVisible();
  await panel.getByPlaceholder("Ask about the big design of the book…").fill(`${ASK}\n\n${DOC}`);
  await panel.getByRole("button", { name: "Send" }).click();
  // Brainstorming speaks the language of the book (this one says none: English), the Copilot the language of the request.
  await expect(panel.getByText(/Reading the text: chapters \d+-\d+ of 37…/)).toBeVisible({ timeout: 30_000 });

  const proposal = panel.locator('[data-brainstorm-proposal="synopsis"]');
  await expect(proposal).toBeVisible({ timeout: 60_000 });
  await expect(proposal.getByRole("table").getByRole("rowheader")).toHaveCount(37);
  await expect(panel.locator(".doc-prose p", { hasText: "I read 37 of the 37 chapters of the text: 37 new entries of the synopsis, 0 entries updated." })).toBeVisible();
  expect(ai.asked.slice(before)).toEqual(Array(7).fill("synopsis_chapters"));

  await proposal.getByRole("button", { name: "Apply to the Synopsis" }).click();
  const confirm = page.getByRole("dialog", { name: "Apply these changes to the Synopsis?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(proposal.getByText("Applied", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect((await filesUnder(page, BRAINSTORM_BOOK.repo, "outline/chapters/")).length).toBe(37);

  await closePanel(page, "brainstorming");
  await expect(page.locator("#outline-chapter-37")).toBeVisible({ timeout: 30_000 });
  expect(github).toEqual([]);
  expect(openAi).toEqual([]);
});

test("a request whose fallback a routing limit keeps out says the limit and its numbers, and one click raises it, sends the request again and remembers the old value", async ({ page }) => {
  test.setTimeout(120_000);
  watchGitHub(page);
  const books = [await emptyBook(LIMIT_BOOK)];
  // The first model refuses every request; its fallback, the owner's, is what a cost limit of 0.10 keeps out (the first attempt is the author's choice, and never stopped by it).
  const settings = routedSettingsOf(
    { id: "gone-ai", name: "Gone AI", model: "gone-model", url: gone.url, modelEntry: OWNER_LIKE },
    { id: "fake-ai", name: "Fake AI", model: "fake-model", url: ai.url, modelEntry: OWNER_LIKE },
    books,
    { extra: { ui: { language: "en", theme: "light" }, costCurrency: "USD", routingExecution: { maxCandidates: 4, maxTotalDurationMs: 180_000, maxTokenAttempts: 200_000, maxEstimatedCost: 0.1 } } },
  );
  await seed(page, settings, books);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, gone.url);
  await openSynopsis(page, LIMIT_BOOK.id);
  const asked = { gone: gone.asked.length, ai: ai.asked.length };

  await page.getByRole("button", { name: "Copilot", exact: true }).click();
  const panel = page.locator('[data-assistant-mode="copilot"]');
  await panel.locator("textarea").fill(`Cosa ne pensi di questo testo?\n\n${DOC}`);
  await panel.getByRole("button", { name: "Send" }).click();
  const raise = panel.getByRole("button", { name: /^Raise the limit to \$\d+\.\d\d and send again$/ });
  await expect(raise).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator(".doc-prose strong", { hasText: "A routing limit left the fallbacks out" })).toBeVisible();
  await expect(panel.locator(".doc-prose p").getByText(/The fallbacks after the first model were not tried: they are estimated at \$0\.\d+ together, and the limit of the AI Router is \$0\.10 \(“Maximum estimated route cost”, Settings › AI Router › Routing options\)\./)).toBeVisible();
  expect(gone.asked.length - asked.gone, "the first model was asked").toBeGreaterThan(0);
  expect(ai.asked.length, "its fallback was not").toBe(asked.ai);

  await raise.click();
  await expect(panel.locator(".doc-prose p", { hasText: "È una sinossi lunga: posso trasformarla nella Sinossi del libro quando vuoi." })).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator(".doc-prose p").getByText(/The limit is now \$\d+\.\d\d \(it was \$0\.10\), and the request was sent again\./)).toBeVisible();
  expect(ai.asked.length, "the fallback answered").toBeGreaterThan(asked.ai);
  await expect(panel.locator(".bg-primary.whitespace-pre-wrap", { hasText: "Cosa ne pensi di questo testo?" }), "the request is in the chat once").toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Put back $0.10" })).toBeVisible();

  // The settings say it too, with the way to put it back.
  await closePanel(page, "copilot");
  await page.goto("app/settings/ai-router#routing-options", { waitUntil: "domcontentloaded" });
  const raised = page.locator('[data-raised-limit="maxEstimatedCost"]');
  await expect(raised).toContainText("Maximum estimated route cost: raised from $0.10 on", { timeout: 30_000 });
  await raised.getByRole("button", { name: "Put back $0.10" }).click();
  await expect(page.locator("[data-raised-limit]")).toHaveCount(0);
});
