import { afterEach, describe, expect, it } from "vitest";
import { chatContextOf, doesNotFit, estimateWithKept, firstChatCandidate, summaryInputChars, wantsCompaction } from "@/assistant/chatContext";
import { forgetTokenRatios, recordTokenUsage } from "@/assistant/contextBudget";
import { withCompaction } from "@/assistant/contextCompaction";
import { createEmptyAssistantSession, type AssistantSession, type ContextLastRequest } from "@/assistant/store";
import { DEFAULT_SETTINGS, type AppSettings, type ChatModel } from "@/types/settings";

// #122: the ring's view of a chat — the model the next request goes to and its window (configured or the default), the parts of that request, the compaction it wants, the
// request that would not fit, the measured and the estimated cached share, the cost.

afterEach(() => forgetTokenRatios());

function settingsWith(model: Partial<ChatModel> = {}, extra: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    aiIntegrations: [{ id: "fake", name: "Fake", provider: "openai", endpoint: "https://fake.test/v1", apiKey: "sk-fake-0123456789abcdef", chatModels: [{ id: "big", name: "big", capabilities: ["default", "copilot", "brainstorming", "chat-resume"], supportsToolCalls: true, ...model }] }],
    taskRouting: { copilot: { primary: { integrationId: "fake", model: "big" }, fallbacks: [] }, default: { primary: { integrationId: "fake", model: "big" }, fallbacks: [] } },
    ...extra,
  } as AppSettings;
}

const last = (overrides: Partial<ContextLastRequest> = {}): ContextLastRequest => ({
  integrationId: "fake",
  model: "big",
  shape: { system: 3_000, tools: 600, files: 8_000, pageState: 400, attachments: 0, summary: 0, conversation: 4_000, request: 50, results: 0, other: 0 },
  usage: { inputTokens: 17_655, cachedInputTokens: 9_000, outputTokens: 800 },
  attachmentsKey: "",
  summaryKey: "",
  at: "2026-11-27T10:00:00.000Z",
  ...overrides,
});

function chat(words: number, overrides: Partial<AssistantSession> = {}): AssistantSession {
  const messages = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, role: (index % 2 ? "assistant" : "user") as "assistant" | "user", text: "parola ".repeat(words) }));
  return { ...createEmptyAssistantSession("Chat"), messages, ...overrides };
}

describe("the context of a chat", () => {
  it("measures the next request against the window of the first model of the route, configured or the default", () => {
    const configured = chatContextOf({ session: chat(10), settings: settingsWith({ maxInputTokens: 200_000, maxOutputTokens: 8_000 }), draft: "" });
    expect(configured.model).toEqual({ integrationId: "fake", integrationName: "Fake", model: "big" });
    expect(configured.estimate.window).toEqual({ tokens: 200_000, source: "configured" });
    const unset = chatContextOf({ session: chat(10), settings: settingsWith(), draft: "" });
    expect(unset.estimate.window).toEqual({ tokens: 128_000, source: "default" });
    const none = chatContextOf({ session: chat(10), settings: DEFAULT_SETTINGS, draft: "" });
    expect(none.model).toBeNull();
    expect(none.estimate.window.source).toBe("default");
    // Brainstorming follows the Copilot's route while it has none of its own.
    expect(firstChatCandidate(settingsWith(), "brainstorming")?.model).toBe("big");
  });

  it("adds what the author is writing, and wants a compaction at the threshold only when it is on", () => {
    const settings = settingsWith({ maxInputTokens: 128_000, maxOutputTokens: 8_000 });
    const quiet = chatContextOf({ session: chat(10), settings, draft: "" });
    const typing = chatContextOf({ session: chat(10), settings, draft: "d".repeat(4_000) });
    expect(typing.estimate.parts.request).toBe(Math.round((1_000 + 24) * 1.25));
    expect(typing.estimate.total - quiet.estimate.total).toBe(typing.estimate.parts.request);
    // About 7,000 words a message, ten messages: past 90% of the window.
    const full = chatContextOf({ session: chat(7_000), settings, draft: "" });
    expect(full.estimate.total).toBeGreaterThanOrEqual(full.estimate.compactAt);
    expect(wantsCompaction(full)).toBe(true);
    expect(wantsCompaction(chatContextOf({ session: chat(7_000), settings: { ...settings, contextCompaction: { auto: false, threshold: 90 } }, draft: "" }))).toBe(false);
    expect(wantsCompaction(quiet)).toBe(false);
  });

  it("counts a compacted chat by its summary and the messages after it, and says what keeping fewer of them would leave", () => {
    const settings = settingsWith({ maxInputTokens: 128_000, maxOutputTokens: 8_000 });
    const whole = chatContextOf({ session: chat(7_000), settings, draft: "" });
    const compacted = withCompaction(chat(7_000), { id: "c1", throughMessageId: "m5", messageCount: 6, coveredCount: 6, summary: "s".repeat(4_000), source: "model", trigger: "auto", at: "2026-11-27T10:00:00.000Z", beforeTokens: whole.estimate.total, afterTokens: 0 });
    const after = chatContextOf({ session: compacted, settings, draft: "" });
    expect(after.conversation.messages.map((message) => message.id)).toEqual(["m6", "m7", "m8", "m9"]);
    expect(after.estimate.parts.summary).toBe(Math.round((1_000 + 24) * 1.25));
    expect(after.estimate.total).toBeLessThan(whole.estimate.total * 0.5);
    const keptTwo = estimateWithKept(whole, chat(7_000).messages.slice(8));
    expect(keptTwo).toBeLessThan(estimateWithKept(whole, chat(7_000).messages.slice(6)));
  });

  it("does not fit when even without the material set apart the request is past the room of the window; the material alone the window cuts, and the reply says so", () => {
    const settings = settingsWith({ maxInputTokens: 32_000, maxOutputTokens: 2_000 });
    const material = { id: "a1", name: "Pasted", mimeType: "text/plain", kind: "text" as const, sizeBytes: 200_000, textContent: "m".repeat(200_000), material: true };
    const withMaterial = chatContextOf({ session: chat(10, { attachments: [material] }), settings, draft: "Riassumilo" });
    expect(withMaterial.estimate.state).toBe("over");
    expect(doesNotFit(withMaterial.estimate)).toBe(false);
    const longDraft = chatContextOf({ session: chat(10), settings, draft: "x".repeat(200_000) });
    expect(doesNotFit(longDraft.estimate)).toBe(true);
  });

  it("tells the cached share it estimates from the one the provider measured, and prices the next message", () => {
    const settings = settingsWith({ maxInputTokens: 128_000, maxOutputTokens: 8_000, pricing: { inputPerMTok: 2, cachedPerMTok: 0.5, outputPerMTok: 8 } });
    const value = chatContextOf({ session: chat(400, { contextLast: last() }), settings, draft: "" });
    expect(value.measured).toEqual({ inputTokens: 17_655, cachedInputTokens: 9_000, share: 9_000 / 17_655 });
    expect(value.estimate.ratio, "the ratio of the chat's last request: what the provider counted (17,655 for 16,050 likely tokens)").toBeCloseTo(1.1, 5);
    expect(value.estimate.cacheable).toBeGreaterThan(value.estimate.parts.system + value.estimate.parts.files);
    expect(value.cost?.input).toBeCloseTo(((value.estimate.total - value.estimate.cacheable) * 2 + value.estimate.cacheable * 0.5) / 1_000_000, 10);
    expect(value.cost?.output).toBeCloseTo(800 * 8 / 1_000_000, 10);
    // A model whose row says it does not cache: nothing is served from a cache.
    const noCache = chatContextOf({ session: chat(400, { contextLast: last() }), settings: settingsWith({ maxInputTokens: 128_000, promptCaching: "unsupported", pricing: { inputPerMTok: 2 } }), draft: "" });
    expect(noCache.noCache).toBe(true);
    expect(noCache.estimate.cacheable).toBe(0);
    // Another model than the last request's: nothing is known of its cache, and its ratio is its own.
    recordTokenUsage({ integrationId: "fake", model: "big" }, 10_000, 9_000);
    const other = chatContextOf({ session: chat(400, { contextLast: last({ model: "small" }) }), settings, draft: "" });
    expect(other.estimate.cacheable).toBe(0);
    expect(other.estimate.ratio).toBeCloseTo(0.9, 10);
  });

  it("lets the summariser read what the window of its model holds", () => {
    expect(summaryInputChars(settingsWith({ maxInputTokens: 1_000_000, maxOutputTokens: 8_000 }))).toBeGreaterThan(1_000_000);
    expect(summaryInputChars(settingsWith({ maxInputTokens: 16_000 }))).toBeGreaterThanOrEqual(20_000);
    expect(summaryInputChars(DEFAULT_SETTINGS)).toBeGreaterThan(300_000);
  });
});
