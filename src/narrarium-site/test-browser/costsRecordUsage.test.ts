import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiRequest } from "narrarium-engine";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalAccountSnapshot, updateLocalAccountCosts } from "@/account/accountLocalStore";
import { localDeviceId, localWorkspaceScope } from "@/account/deviceIdentity";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { createBrowserAi } from "@/autopilot/browserAi";
import { useCostsStore } from "@/costs/costsStore";
import { addToLedger, ledgerRows, ledgerWriterId } from "@/costs/ledger";
import { emptyCostsFile } from "@/costs/model";
import { countersOf, flushPendingUsage, recordUsage, usageWaitingForStore, type UsageRecord } from "@/costs/recordUsage";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { resetCosts } from "./helpers/costs";
import { assertProvidersClean, createFakeProvider, failReply, streamedReply, textReply } from "./helpers/fakeProvider";
import { chatModel, compatible, endpointsOf, GITHUB_TOKEN, PRICE, routed, settingsOf } from "./helpers/aiFixtures";

const CHAT: UsageRecord = { capability: "copilot", label: "copilot", integrationId: "int-1", model: "gpt-5", usage: { inputTokens: 1000, cachedTokens: 200, outputTokens: 300 }, usageKnown: true, cost: 0.004, costKnown: true, priced: true, currency: "EUR" };

const rows = () => ledgerRows(useCostsStore.getState().file.ledger);
const storedRows = async () => ledgerRows((await loadLocalAccountSnapshot())?.data.costs.ledger);
const sum = (list: ReturnType<typeof rows>, field: "calls" | "tasks" | "inputTokens" | "outputTokens" | "cost" | "estimatedCost" | "unpricedCalls" | "unknownUsageCalls" | "estimatedInputTokens") => list.reduce((total, row) => total + row[field], 0);

async function freshAccountStore(): Promise<void> {
  closeAccountLocalStoreForTests();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("narrarium-local-account");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

beforeEach(async () => {
  localStorage.clear();
  await freshAccountStore();
  resetCosts({ bookId: "book-1", bookName: "The Glass Harbor" });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "EUR" } });
});

describe("what a call counts: measured numbers and estimates apart", () => {
  it("counts a priced call with reported tokens as measured", () => {
    expect(countersOf(CHAT, true)).toEqual({ calls: 1, tasks: 1, inputTokens: 1000, cachedTokens: 200, outputTokens: 300, cost: 0.004 });
  });

  it("keeps the tokens the provider did not report, and their cost, as an estimate only", () => {
    expect(countersOf({ ...CHAT, usageKnown: false, costKnown: false }, false)).toEqual({ calls: 1, tasks: 0, unknownUsageCalls: 1, estimatedInputTokens: 1000, estimatedOutputTokens: 300, estimatedCost: 0.004 });
  });

  it("counts a call on a model without a price, with its tokens and no money", () => {
    expect(countersOf({ ...CHAT, priced: false, cost: undefined, costKnown: false }, true)).toEqual({ calls: 1, tasks: 1, inputTokens: 1000, cachedTokens: 200, outputTokens: 300, unpricedCalls: 1 });
  });

  it("counts an attempt that used nothing (it failed before an answer) as a call, and as nothing else", () => {
    expect(countersOf({ ...CHAT, usage: null, usageKnown: false, cost: undefined, costKnown: false }, true)).toEqual({ calls: 1, tasks: 1 });
    expect(countersOf({ ...CHAT, usage: null, usageKnown: false, cost: undefined, costKnown: false, priced: false }, true)).toEqual({ calls: 1, tasks: 1 });
  });

  it("counts something made without a report of what it used (an image) as a call without a token count", () => {
    expect(countersOf({ ...CHAT, usage: null, usageKnown: false, cost: undefined, costKnown: false, billed: true }, true)).toEqual({ calls: 1, tasks: 1, unknownUsageCalls: 1 });
    expect(countersOf({ ...CHAT, usage: null, usageKnown: true, cost: undefined, costKnown: false, billed: true, priced: false }, true)).toEqual({ calls: 1, tasks: 1, unpricedCalls: 1 });
  });
});

describe("recording into the account store", () => {
  it("writes the call in this device's part of the ledger and in the legacy totals, in one change of the account data", async () => {
    const created = await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    recordUsage(CHAT);
    await flushPendingUsage();
    const stored = await loadLocalAccountSnapshot();
    const writer = ledgerWriterId(localDeviceId(), Object.keys(stored!.data.costs.ledger!.writers)[0].split("@")[1]);
    expect(Object.keys(stored!.data.costs.ledger!.writers)).toEqual([writer]);
    expect(writer.startsWith(`${localDeviceId()}@`)).toBe(true);
    expect(await storedRows()).toEqual([expect.objectContaining({ bookId: "book-1", source: "copilot", capability: "copilot", integrationId: "int-1", model: "gpt-5", currency: "EUR", calls: 1, tasks: 1, inputTokens: 1000, cost: 0.004 })]);
    expect(stored!.data.costs.books["book-1"]).toMatchObject({ bookName: "The Glass Harbor", inputTokens: 1000, cachedTokens: 200, outputTokens: 300, chatCost: 0.004 });
    expect(stored!.dirty, "the account data has a change to sync").toBe(true);
    expect(stored!.manifest.vectorClock[localDeviceId()]).toBeGreaterThan(created.manifest.vectorClock[localDeviceId()] ?? 0);
    expect(useCostsStore.getState().persisted.ledger).toEqual(stored!.data.costs.ledger);
  });

  it("shows a record at once and keeps it until the account store exists, then writes it once", async () => {
    recordUsage(CHAT);
    await flushPendingUsage();
    expect(usageWaitingForStore()).toBe(true);
    expect(sum(rows(), "calls"), "shown while it waits").toBe(1);
    const created = await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: useCostsStore.getState().persisted, clipboard: [], chats: [] });
    useCostsStore.getState().hydrate(created.data.costs);
    await flushPendingUsage();
    expect(usageWaitingForStore()).toBe(false);
    expect(sum(await storedRows(), "calls"), "written once").toBe(1);
    expect(sum(rows(), "calls")).toBe(1);
  });

  it("counts a task at its first call, and every call", async () => {
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    recordUsage({ ...CHAT, task: "activity-1" });
    recordUsage({ ...CHAT, task: "activity-1", model: "fallback-model" });
    recordUsage({ ...CHAT, task: "activity-2" });
    recordUsage(CHAT);
    await flushPendingUsage();
    const stored = await storedRows();
    expect(sum(stored, "calls")).toBe(4);
    expect(sum(stored, "tasks")).toBe(3);
  });

  it("keeps the records of two tabs of this browser: each change is made on what the store holds, never on a copy in memory", async () => {
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    // Another tab writes in the same part (same device, same store) while this tab records.
    const otherTab = updateLocalAccountCosts((costs, writer) => ({ ...costs, ledger: addToLedger(costs.ledger, writer, [{ key: { period: "2026-11-25", bookId: "book-2", source: "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: "EUR" }, counters: { calls: 1, tasks: 1, cost: 0.5 } }], new Date(), "EUR") }));
    recordUsage(CHAT);
    recordUsage({ ...CHAT, bookId: "book-3" });
    await Promise.all([otherTab, flushPendingUsage()]);
    const stored = await storedRows();
    expect(sum(stored, "calls"), "the other tab's call and both of this tab's").toBe(3);
    expect(new Set(stored.map((row) => row.bookId))).toEqual(new Set(["book-1", "book-2", "book-3"]));
  });

  it("records a call with no book open under no book, where the legacy totals never had one", async () => {
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    resetCosts();
    recordUsage(CHAT);
    await flushPendingUsage();
    expect((await storedRows())[0]).toMatchObject({ bookId: "", calls: 1 });
    expect((await loadLocalAccountSnapshot())!.data.costs.books).toEqual({});
  });

  it("records a call without a price under no currency, and a priced one in the currency of its price", async () => {
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    recordUsage({ ...CHAT, priced: false, cost: undefined, costKnown: false });
    recordUsage({ ...CHAT, currency: "USD" });
    await flushPendingUsage();
    const stored = await storedRows();
    expect(stored.find((row) => row.currency === "")).toMatchObject({ unpricedCalls: 1, cost: 0, inputTokens: 1000 });
    expect(stored.find((row) => row.currency === "USD")).toMatchObject({ cost: 0.004 });
  });
});

describe("the browser's AI port records every attempt through the one recorder", () => {
  const ASK: AiRequest = { capability: "autopilot", label: "autopilot:scene", system: "The system prompt", user: "The user prompt" };

  beforeEach(async () => {
    useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
    setFallbackAcknowledgementAccountScope(localWorkspaceScope());
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setFallbackAcknowledgementAccountScope(null);
    assertProvidersClean();
  });

  function useProvider(fixtures: ReturnType<typeof compatible>[], settings: ReturnType<typeof settingsOf>, reply: Parameters<typeof createFakeProvider>[1]) {
    const fake = createFakeProvider(endpointsOf(fixtures), reply, [GITHUB_TOKEN]);
    vi.stubGlobal("fetch", fake.fetch);
    useSettingsStore.setState({ settings });
    return fake;
  }

  it("gives a run's calls to the run's book and to the autopilot, the fallback attempt included, as one task of the step", async () => {
    const a = compatible("a");
    const b = compatible("b");
    useProvider([a, b], routed([a, b]), (call) => (call.url.includes("a.example.test") ? textReply("Half", { prompt_tokens: 800, completion_tokens: 4000 }, "length") : textReply("Whole.", { prompt_tokens: 800, completion_tokens: 300 })));
    await createBrowserAi({ usage: () => ({ bookId: "book-run", bookName: "Run", origin: "autopilot", task: "activity_42" }) }).complete({ ...ASK, capability: "director" });
    await flushPendingUsage();
    const stored = await storedRows();
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.bookId === "book-run" && row.source === "autopilot" && row.capability === "director" && row.currency === "EUR")).toBe(true);
    expect(sum(stored, "calls")).toBe(2);
    expect(sum(stored, "tasks"), "the fallback is the same task").toBe(1);
    expect(sum(stored, "inputTokens")).toBe(1600);
    expect(sum(stored, "cost")).toBeCloseTo(((1600 * PRICE.inputPerMTok) + (4300 * PRICE.outputPerMTok)) / 1_000_000, 12);
  });

  it("makes each call of a feature a task of its own, in the book open in the app", async () => {
    const a = compatible("a");
    useProvider([a], settingsOf([a]), () => textReply("ok"));
    await createBrowserAi().complete({ ...ASK, capability: "copilot", label: "copilot" });
    await createBrowserAi().complete({ ...ASK, capability: "copilot", label: "copilot" });
    await flushPendingUsage();
    const stored = await storedRows();
    expect(stored).toEqual([expect.objectContaining({ bookId: "book-1", source: "copilot", calls: 2, tasks: 2 })]);
  });

  it("keeps the engine's estimate of a reply whose tokens were not reported apart from what was measured", async () => {
    const a = compatible("a");
    useProvider([a], settingsOf([a]), () => streamedReply("A scene with no count.", null));
    await createBrowserAi().complete({ ...ASK, onText: () => undefined });
    await flushPendingUsage();
    const [row] = await storedRows();
    expect(row).toMatchObject({ calls: 1, unknownUsageCalls: 1, inputTokens: 0, outputTokens: 0, cost: 0 });
    expect(row.estimatedInputTokens + row.estimatedOutputTokens).toBeGreaterThan(0);
    expect(row.estimatedCost).toBeGreaterThan(0);
    expect((await loadLocalAccountSnapshot())!.data.costs.books, "the legacy totals never had estimates").toEqual({});
  });

  it("counts the calls of a model without a price and says which model it is", async () => {
    const a = compatible("a", [chatModel("free-model", { pricing: undefined })]);
    useProvider([a], settingsOf([a]), () => textReply("ok"));
    await createBrowserAi().complete(ASK);
    await flushPendingUsage();
    expect(await storedRows()).toEqual([expect.objectContaining({ model: "free-model", integrationId: "a", currency: "", unpricedCalls: 1, inputTokens: 120, cost: 0 })]);
  });

  it("counts an attempt that failed with nothing billed as a call, and the one that answered as the rest", async () => {
    const a = compatible("a");
    const b = compatible("b");
    useProvider([a, b], routed([a, b]), (call) => (call.url.includes("a.example.test") ? failReply(503, "overloaded") : textReply("ok")));
    await createBrowserAi().complete(ASK);
    await flushPendingUsage();
    const stored = await storedRows();
    expect(sum(stored, "calls")).toBe(2);
    expect(sum(stored, "inputTokens")).toBe(120);
    expect(sum(stored, "unknownUsageCalls")).toBe(0);
  });

  it("prices in the currency of the settings the call was made with", async () => {
    const a = compatible("a");
    useProvider([a], settingsOf([a], { costCurrency: "GBP" }), () => textReply("ok"));
    await createBrowserAi().complete(ASK);
    await flushPendingUsage();
    expect((await storedRows())[0]).toMatchObject({ currency: "GBP" });
  });
});

describe("the price of chat tokens is one rule, the engine's", () => {
  it("prices the Copilot's reports as the engine prices the calls it makes, cached tokens included", async () => {
    const { estimateCost } = await import("narrarium-engine");
    const { chatDelta } = await import("@/costs/costsStore");
    const prices = [{ inputPerMTok: 2, cachedPerMTok: 1, outputPerMTok: 8 }, { inputPerMTok: 10, outputPerMTok: 20 }, { outputPerMTok: 3 }, {}];
    const usages = [{ inputTokens: 1000, cachedTokens: 200, outputTokens: 500 }, { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }, { inputTokens: 120_000, cachedTokens: 120_000, outputTokens: 7 }];
    for (const pricing of prices) {
      for (const usage of usages) {
        expect(chatDelta(usage, pricing).chatCost, JSON.stringify({ pricing, usage })).toBeCloseTo(estimateCost({ inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedTokens, outputTokens: usage.outputTokens }, pricing) ?? 0, 12);
      }
    }
  });
});
