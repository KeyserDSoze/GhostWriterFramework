import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ completeTextRouted: vi.fn() }));
vi.mock("@/assistant/router", async (original) => ({ ...await original<typeof import("@/assistant/router")>(), completeTextRouted: mocks.completeTextRouted }));

import {
  KEEP_RECENT,
  MAX_SUMMARY_CHARS,
  activeCompaction,
  afterUncompactedSend,
  canUndoCompaction,
  chooseKeep,
  compactionCover,
  compactionInput,
  conversationToSend,
  fallbackSummary,
  summarizeConversation,
  summaryInForce,
  withCompaction,
  withNextUncompacted,
} from "@/assistant/contextCompaction";
import { createEmptyAssistantSession, type AssistantMessage, type AssistantSession, type ContextCompaction } from "@/assistant/store";
import { DEFAULT_SETTINGS } from "@/types/settings";

// #122: what a compacted chat sends (the summary and the messages after it, every message still in the chat), what a compaction covers and keeps, the summary (by a model,
// else made from the messages), and «Undo for the next message».

const message = (index: number, role: AssistantMessage["role"] = index % 2 ? "assistant" : "user"): AssistantMessage => ({ id: `m${index}`, role, text: `Message ${index}` });
const chat = (count: number, overrides: Partial<AssistantSession> = {}): AssistantSession => ({ ...createEmptyAssistantSession("Chat"), messages: Array.from({ length: count }, (_, index) => message(index)), ...overrides });
const compaction = (through: string, id = `c-${through}`, overrides: Partial<ContextCompaction> = {}): ContextCompaction => ({ id, throughMessageId: through, messageCount: 0, coveredCount: 0, summary: `Summary through ${through}`, source: "model", trigger: "auto", at: "2026-11-27T10:00:00.000Z", beforeTokens: 100_000, afterTokens: 20_000, ...overrides });
const ids = (messages: readonly AssistantMessage[]) => messages.map((entry) => entry.id);

beforeEach(() => mocks.completeTextRouted.mockReset());

describe("what a chat sends of its conversation", () => {
  it("sends every message, the chat's own notes left out, with the archive's summary of an older chat; once compacted, the summary and the messages after it", () => {
    const notes = chat(6);
    notes.messages.splice(3, 0, { id: "note", role: "system", text: "/context printed this" });
    expect(conversationToSend(notes)).toEqual({ summary: "", messages: notes.messages.filter((entry) => entry.role !== "system"), compaction: null });
    const older = chat(4, { archive: { summary: "What an older compaction said", messageCount: 20, actions: [], attachments: [] } });
    expect(conversationToSend(older).summary).toBe("What an older compaction said");
    const compacted = withCompaction(chat(10), compaction("m5"));
    const sent = conversationToSend(compacted);
    expect(sent.summary).toBe("Summary through m5");
    expect(ids(sent.messages)).toEqual(["m6", "m7", "m8", "m9"]);
    expect(compacted.messages, "every message stays in the chat").toHaveLength(10);
  });

  it("for the next message after «Undo» sets the last compaction aside: what was in force before it, and the messages after that, as they are", () => {
    const twice = withCompaction(withCompaction(chat(12), compaction("m3")), compaction("m7"));
    const undone = withNextUncompacted(twice, true);
    expect(activeCompaction(undone)?.skipNext).toBe(true);
    expect(conversationToSend(undone)).toMatchObject({ summary: "Summary through m3", compaction: { id: "c-m3" } });
    expect(ids(conversationToSend(undone).messages)).toEqual(["m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11"]);
    // The only compaction undone: the whole conversation (and the archive's summary of an older chat, if any).
    const once = withNextUncompacted(withCompaction(chat(8), compaction("m3")), true);
    expect(conversationToSend(once)).toMatchObject({ summary: "", compaction: null });
    expect(conversationToSend(once).messages).toHaveLength(8);
    // After that message it is in force again; «Keep it compacted» does the same before it.
    expect(activeCompaction(afterUncompactedSend(once))?.skipNext).toBeUndefined();
    expect(conversationToSend(afterUncompactedSend(once)).summary).toBe("Summary through m3");
    expect(withNextUncompacted(once, false)).toEqual(afterUncompactedSend(once));
    expect(afterUncompactedSend(twice), "nothing to give back").toBe(twice);
  });

  it("cannot undo a compaction whose messages a chat too large to keep archived: they are no longer in it, and the summary stays in force", () => {
    const archived = withNextUncompacted({ ...withCompaction(chat(10), compaction("m5")), messages: chat(10).messages.slice(6) }, true);
    expect(canUndoCompaction(archived)).toBe(false);
    expect(conversationToSend(archived)).toMatchObject({ summary: "Summary through m5", compaction: { id: "c-m5" } });
    expect(ids(conversationToSend(archived).messages)).toEqual(["m6", "m7", "m8", "m9"]);
  });

  it("a new compaction starts from the summary in force, else from the archive's", () => {
    expect(summaryInForce(chat(2, { archive: { summary: "Archive", messageCount: 3, actions: [], attachments: [] } }))).toBe("Archive");
    expect(summaryInForce(withCompaction(chat(6), compaction("m2")))).toBe("Summary through m2");
  });
});

describe("what a compaction covers", () => {
  it("covers the messages after the compaction in force but the last ones of the conversation, which go as they are (the chat's notes are not counted)", () => {
    const value = chat(10);
    value.messages.push({ id: "note", role: "system", text: "/context" });
    const cover = compactionCover(value)!;
    expect(KEEP_RECENT).toBe(4);
    expect(ids(cover.covered)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
    expect(cover.through.id).toBe("m5");
    expect(cover.messageCount).toBe(6);
    expect(ids(cover.kept)).toEqual(["m6", "m7", "m8", "m9"]);
    const next = compactionCover(withCompaction(value, compaction("m5")), 2)!;
    expect(ids(next.covered)).toEqual(["m6", "m7"]);
    expect(compactionCover(withCompaction(value, compaction("m5")))).toBeNull();
    expect(compactionCover(chat(4))).toBeNull();
    expect(ids(compactionCover(chat(4), 0)!.covered)).toHaveLength(4);
  });

  it("keeps as many of the last messages as leave the next request under the threshold (4, 2, 1), and none when even the last does not", () => {
    const value = chat(12);
    expect(chooseKeep(value, () => true)).toBe(4);
    expect(chooseKeep(value, (kept) => kept.length <= 2)).toBe(2);
    expect(chooseKeep(value, (kept) => kept.length <= 1)).toBe(1);
    expect(chooseKeep(value, () => false)).toBe(0);
  });
});

describe("the summary of a compaction", () => {
  const covered = chat(6).messages;

  it("is written by the chat-resume route, from the summary in force and the messages it covers, read as data", async () => {
    mocks.completeTextRouted.mockResolvedValueOnce("- The author wants a darker ending.\n- Chapter 3 is done.");
    const result = await summarizeConversation({ settings: DEFAULT_SETTINGS, accountScope: null, previous: "Earlier: the plan of the book.", covered, italian: false, maxChars: 100_000 });
    expect(result).toEqual({ summary: "- The author wants a darker ending.\n- Chapter 3 is done.", source: "model" });
    const [, messages, capability, options] = mocks.completeTextRouted.mock.calls[0];
    expect(capability).toBe("chat-resume");
    expect(options).toMatchObject({ label: "copilot:compact" });
    expect(messages[1].content).toContain('<prior_transcript trust="untrusted-data">');
    expect(messages[1].content).toContain("PREVIOUS SUMMARY:\nEarlier: the plan of the book.");
    expect(messages[1].content).toContain("USER: Message 0");
  });

  it("is made from the messages when the model fails or says nothing: the chat is never blocked", async () => {
    mocks.completeTextRouted.mockRejectedValueOnce(new Error("HTTP 503"));
    const failed = await summarizeConversation({ settings: DEFAULT_SETTINGS, accountScope: null, previous: "", covered, italian: true, maxChars: 100_000 });
    expect(failed.source).toBe("fallback");
    expect(failed.summary).toContain("Messaggi riassunti senza un modello");
    expect(failed.summary).toContain("- Autore: Message 0");
    expect(failed.summary).toContain("- Assistente: Message 1");
    mocks.completeTextRouted.mockResolvedValueOnce("   ");
    expect((await summarizeConversation({ settings: DEFAULT_SETTINGS, accountScope: null, previous: "", covered, italian: false, maxChars: 100_000 })).source).toBe("fallback");
  });

  it("stops when the author stops it", async () => {
    const controller = new AbortController();
    mocks.completeTextRouted.mockImplementationOnce(async () => { controller.abort(); throw new DOMException("Stopped", "AbortError"); });
    await expect(summarizeConversation({ settings: DEFAULT_SETTINGS, accountScope: null, signal: controller.signal, previous: "", covered, italian: false, maxChars: 100_000 })).rejects.toThrow("Stopped");
  });

  it("reads the summary in force whole and the start and the end of messages too long for its model", () => {
    const long = [{ id: "x", role: "user" as const, text: `START ${"x".repeat(50_000)} END` }];
    const text = compactionInput("Previous", long, 10_000);
    expect(text.length).toBeLessThanOrEqual(10_000);
    expect(text).toContain("PREVIOUS SUMMARY:\nPrevious");
    expect(text).toContain("USER: START");
    expect(text).toContain("END");
    expect(text).toMatch(/characters of the middle of these messages not read again/);
  });

  it("made without a model stays within the size of a summary, the newest lines kept", () => {
    const many = Array.from({ length: 400 }, (_, index) => ({ id: `m${index}`, role: "user" as const, text: `Request number ${index} ${"y".repeat(300)}` }));
    const text = fallbackSummary("Earlier summary", many, false);
    expect(text.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(text.startsWith("Earlier summary")).toBe(true);
    expect(text).toContain("Request number 399");
  });
});
