import { expect, test, type Page } from "@playwright/test";
import { KEY, bookFiles, openApp, routedSettingsOf, seed, startAutopilot, startProvider, waitForAiSettings, waitForAutopilot, type SeedBook, type StubBehavior, type StubCall, type StubProvider } from "./helpers/autopilot";

// A model that is asked through the Responses API, against a stub that plays it (its events when the request streams, one JSON body when it does not): the request the browser sends (the address built from the
// integration, the key in the header its provider takes, the thinking level together with a flat forced function, nothing stored), the reply read as it streams (the live JSON of a structured step), the tokens and the
// cost the run counts, the address that a model has of its own used exactly as written and told without its query, and the notice of a model that refused thinking with tools, which offers the Responses API with a
// button that makes the next request go there.

test.use({ serviceWorkers: "block" });

const BOOK = { id: "book-responses", repo: "e2e-local-responses", name: "The Glass Harbor" };
const FIRST = { id: "ai-a", name: "Fake A", model: "model-a" };
const SECOND = { id: "ai-b", name: "Fake B", model: "model-b" };
const IDEA = `A harbor town built on glass hides a lie that the tide will tell (the ledger key is ${KEY}).`;
const PRICE = { inputPerMTok: 2, cachedPerMTok: 1, outputPerMTok: 8 };

interface Setup {
  a?: StubBehavior;
  b?: StubBehavior;
  /** What is merged into the integration of A and into its model. */
  integrationA?: Record<string, unknown>;
  modelA?: Record<string, unknown>;
  thinkingA?: string;
  /** Milliseconds between the first pieces of a streamed reply of A. */
  pieceGapMs?: number;
}

interface Run {
  a: StubProvider;
  b: StubProvider;
  timeline: StubCall[];
  openAi: string[];
}

const open: StubProvider[] = [];
test.afterEach(async () => { await Promise.all(open.splice(0).map((provider) => provider.close())); });

/** The book of this browser with a router that names A and then B, and its autopilot started from its configuration. */
async function begin(page: Page, options: Setup = {}): Promise<Run> {
  const timeline: StubCall[] = [];
  const a = await startProvider({ name: "A", timeline, ...(options.a ? { behavior: options.a } : {}), ...(options.pieceGapMs ? { pieceGapMs: options.pieceGapMs } : {}) });
  const b = await startProvider({ name: "B", timeline, ...(options.b ? { behavior: options.b } : {}) });
  open.push(a, b);
  const books: SeedBook[] = [{ ...BOOK, files: await bookFiles(IDEA) }];
  const modelA = typeof options.modelA?.endpointUrl === "string" ? { ...options.modelA, endpointUrl: String(options.modelA.endpointUrl).replace("{A}", new URL(a.url).origin) } : options.modelA;
  const settings = routedSettingsOf(
    { ...FIRST, url: a.url, thinking: options.thinkingA, modelEntry: { pricing: PRICE, ...modelA }, ...(options.integrationA ? { integrationEntry: options.integrationA } : {}) },
    { ...SECOND, url: b.url },
    books,
  );
  const { openAi } = await seed(page.context(), settings, books);
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, a.url);
  await startAutopilot(page, BOOK.id);
  return { a, b, timeline, openAi };
}

/**
 * The live JSON that the page shows of the structured replies that are being written, every value it showed (the band's lines and the live block of the step), collected by an observer that is in the
 * document from its start, so that no value is missed between two reads.
 */
async function recordLiveJson(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { __liveJson: Set<string> }).__liveJson = seen;
    const scan = () => document.querySelectorAll("[data-stream-text][data-stream-json], [data-live-text][data-stream-json]").forEach((element) => {
      const text = (element.textContent ?? "").trim();
      if (text) seen.add(text);
    });
    new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

const liveJson = (page: Page) => page.evaluate(() => [...((window as unknown as { __liveJson?: Set<string> }).__liveJson ?? [])]);

test("a model on the Responses API is asked at the address built from its integration, with a flat forced function and its thinking level together, nothing stored, and its reply is read as it streams: the live JSON, the tokens and the cost", async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 1000 });
  await recordLiveJson(page);
  const run = await begin(page, {
    integrationA: { provider: "azure_openai", apiVersion: "2024-10-21", streamMode: "auto" },
    modelA: { apiProtocol: "responses", supportsStreaming: true },
    thinkingA: "high",
    pieceGapMs: 120,
  });
  const facts = await waitForAutopilot(page, BOOK.repo, ["completed"], 120_000);
  const samples = await liveJson(page);
  expect(run.b.requests, "the fallback was never asked").toBe(0);
  expect(run.openAi).toEqual([]);

  // How the model was asked: every request is a request to the Responses API, at the address of the playground that the integration builds, with the key in the Azure header.
  expect(run.a.calls.length).toBeGreaterThanOrEqual(4);
  for (const call of run.a.calls) {
    expect(call.responses, `${call.tool} went through the Responses API`).toBeDefined();
    expect(call.responses).toMatchObject({ path: "/v1/openai/responses", query: "?api-version=2025-04-01-preview", auth: "api-key", store: false, stream: true });
    expect(call.responses?.inputRoles[0], "the system prompt is a developer message").toBe("developer");
    expect(call.thinking, `${call.tool} carries the thinking level`).toBe("high");
  }
  const withTools = run.a.calls.filter((call) => call.tool !== "prose");
  expect(withTools.length, "the structured steps of the autopilot").toBeGreaterThanOrEqual(3);
  for (const call of withTools) expect(call.responses).toMatchObject({ toolForm: "flat", toolChoice: "required", strict: false });

  // The reply was read as it came: the page showed the JSON of a structured step growing, one value from the one before.
  const grown = samples.filter((sample) => sample.includes("{"));
  expect(grown.length, `the live JSON was seen to grow (${samples.length} values)`).toBeGreaterThanOrEqual(3);
  const starts = new Map<string, string[]>();
  for (const sample of grown) starts.set(sample.slice(0, 24), [...(starts.get(sample.slice(0, 24)) ?? []), sample]);
  expect([...starts.values()].some((values) => new Set(values).size >= 2), "one reply was seen at two moments: its JSON grew").toBe(true);

  // What the run counted: the tokens the provider reported for every call, and what they cost at the price of the model (the 20 tokens of reasoning are inside the 50 of the output).
  expect(facts?.stats?.aiCalls).toBe(run.a.requests);
  expect(facts?.stats?.inputTokens).toBe(100 * run.a.requests);
  expect(facts?.stats?.outputTokens).toBe(50 * run.a.requests);
  expect(facts?.stats?.usageUnknownCalls ?? 0).toBe(0);
  expect(facts?.stats?.costUnknownCalls ?? 0).toBe(0);
  expect(facts?.stats?.cost).toBeCloseTo(run.a.requests * (100 / 1e6 * PRICE.inputPerMTok + 50 / 1e6 * PRICE.outputPerMTok), 9);
});

test("the address that a model has of its own is used exactly as it was written, with the key of its integration, and the trail of a failure says its host and its path, never its query", async ({ page }) => {
  const run = await begin(page, {
    a: { kind: "error", status: 404, message: "The deployment does not exist.", code: "DeploymentNotFound" },
    b: { kind: "error", status: 500, message: "Down." },
    integrationA: { provider: "azure_openai", apiVersion: "2024-10-21" },
    modelA: { apiProtocol: "responses", endpointUrl: "{A}/gw/proxy/responses?api-version=preview&trace=1" },
  });
  const panel = page.locator("[data-autopilot-error]");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const first = run.a.calls[0];
  expect(first.responses).toMatchObject({ path: "/gw/proxy/responses", query: "?api-version=preview&trace=1", auth: "api-key" });

  // The trail of the router: the host and the path of the address, the protocol, no version of ours and no query.
  const steps = panel.locator("[data-error-route] li");
  await expect(steps).toHaveCount(2);
  const origin = new URL(run.a.url).origin;
  await expect(steps.nth(0).locator("[data-route-address]")).toHaveText(`${origin}/gw/proxy/responses`);
  await expect(steps.nth(0).locator("[data-route-protocol]")).toHaveText("Responses API");
  await expect(steps.nth(0).locator("[data-route-api-version]")).toHaveCount(0);
  await expect(steps.nth(0)).not.toContainText("trace=1");
  await expect(steps.nth(0)).not.toContainText("api-version=preview");
  await expect(steps.nth(1).locator("[data-route-protocol]")).toHaveCount(0);
  await expect(steps.nth(1).locator("[data-route-address]")).toHaveText(new URL(run.b.url).origin);

  // The diagnostics that are copied say it in the same way.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await panel.getByRole("button", { name: "Copy diagnostics" }).click();
  await expect(panel.locator("[data-error-copy]")).toHaveText("Diagnostics copied.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`[Responses API] [${origin}/gw/proxy/responses]`);
  expect(copied).not.toContain("trace=1");
  expect(copied).not.toContain(KEY);
});

test("a model that took function tools only with none is told with the Responses API as the first way out, and its button makes the next requests go there with the level and the tools together", async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 1000 });
  const run = await begin(page, {
    a: { kind: "refuse-thinking-with-tools", accepts: "none" },
    thinkingA: "high",
    modelA: { supportsStreaming: false },
  });
  const notice = page.locator("[data-learned-model]");
  await expect(notice).toBeVisible({ timeout: 40_000 });
  const ways = notice.locator("[data-learned-way]");
  await expect(ways).toHaveCount(2);
  await expect(ways.nth(0)).toHaveAttribute("data-learned-way", "responses");
  await expect(ways.nth(1)).toHaveAttribute("data-learned-way", "no-thinking");
  const button = notice.getByRole("button", { name: `Use the Responses API for ${FIRST.model}` });
  await expect(button).toBeVisible();
  expect(run.a.calls.every((call) => !call.responses), "until the button is pressed, every request is a Chat Completions request").toBe(true);
  const before = run.a.calls.length;

  await button.click();
  await expect(notice).toHaveAttribute("data-learned-on-responses", "");
  await expect(notice.locator("[data-learned-done-responses]")).toContainText(`${FIRST.model} is asked through the Responses API from its next request on.`);
  await expect(notice.locator("[data-learned-use-responses]")).toHaveCount(0);

  // The run goes on, and its next requests go to the Responses API with the level and the function together, as one JSON body (the model does not stream).
  await expect.poll(() => run.a.calls.slice(before).filter((call) => call.responses && call.tool !== "prose").length, { timeout: 40_000, message: "the run asks the Responses API with tools" }).toBeGreaterThanOrEqual(2);
  const after = run.a.calls.slice(before).filter((call) => call.responses);
  for (const call of after) expect(call.responses).toMatchObject({ path: "/v1/responses", auth: "bearer", store: false });
  for (const call of after.filter((entry) => entry.tool !== "prose")) {
    expect(call.thinking, "the level goes with the tools").toBe("high");
    expect(call.responses).toMatchObject({ toolForm: "flat", toolChoice: "required" });
  }
  expect(run.b.requests, "the fallback was never asked: the refusal was not a failure of the step").toBe(0);
  const facts = await waitForAutopilot(page, BOOK.repo, ["completed"], 90_000);
  expect(facts.status).toBe("completed");

  // The setting is in the model's row: the select says the Responses API, and the box of thinking with tools says that it is kept and not used.
  await page.getByRole("button", { name: "EU", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "AI Integrations" }).first().click();
  const section = page.locator("details").filter({ hasText: "Configure providers used for writing" }).first();
  if (!(await section.evaluate((element) => (element as HTMLDetailsElement).open))) await section.locator("summary").first().click();
  const card = page.locator("details", { has: page.locator("summary p.font-semibold", { hasText: FIRST.name }) }).last();
  if (!(await card.evaluate((element) => (element as HTMLDetailsElement).open))) await card.locator("summary").first().click();
  await expect(card.getByRole("combobox", { name: `API protocol — ${FIRST.model}` })).toHaveText("Responses API");
  await expect(card.locator("[data-model-goes-to]").first()).toContainText(new RegExp(`${new URL(run.a.url).origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/v1/responses`));
  await expect(card.getByRole("checkbox", { name: `Do not use thinking when tools are used — ${FIRST.model}` })).toBeChecked();
  await expect(card.locator("[data-no-thinking-unused]")).toHaveCount(1);
});
