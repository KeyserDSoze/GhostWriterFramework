import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import "@/i18n/pageCopilot";
import { parseAssistantSession, serializeAssistantSession } from "@/assistant/sessionSchema";
import { createEmptyAssistantSession, type AssistantSession, type ContextCompaction, type ContextLastRequest } from "@/assistant/store";
import { migrateSettings, normalizeContextCompaction } from "@/drive/cloudSettingsClient";
import { ContextCompactionSettingsBody } from "@/components/settings/ContextCompactionSettings";
import { ArchivedMessages } from "@/components/assistant/context/ContextParts";
import { DEFAULT_SETTINGS } from "@/types/settings";

// #122: what a chat keeps of its context across a save (its compactions, the shape of its last request) and how leniently it is read back; the settings of the compaction
// (normalised, with their card in Settings › Tools for Copilot); the messages a chat too large to keep archived, shown again on request.

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => cleanup());

const compaction = (extra: Partial<ContextCompaction> = {}): ContextCompaction => ({ id: "compaction-1", throughMessageId: "m2", messageCount: 3, coveredCount: 3, summary: "- What was said.", source: "model", trigger: "auto", at: "2026-11-28T10:00:00.000Z", beforeTokens: 110_000, afterTokens: 20_000, ...extra });
const last: ContextLastRequest = { integrationId: "fake", model: "big", shape: { system: 3_000, tools: 600, files: 8_000, pageState: 400, attachments: 0, summary: 250, conversation: 4_000, request: 50, results: 0, other: 12 }, usage: { inputTokens: 17_000, cachedInputTokens: 9_000, outputTokens: 800 }, turn: { inputTokens: 34_000, cachedInputTokens: 20_000, outputTokens: 1_600 }, attachmentsKey: "a1", summaryKey: "compaction-1", pasted: true, at: "2026-11-28T10:01:00.000Z" };

function chat(extra: Record<string, unknown> = {}): AssistantSession {
  return { ...createEmptyAssistantSession("Chat"), messages: Array.from({ length: 5 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? "assistant" as const : "user" as const, text: `Message ${index}` })), ...extra } as AssistantSession;
}

describe("the context of a chat, saved", () => {
  it("keeps its compactions and the shape and usage of its last request across a save", () => {
    const saved = parseAssistantSession(JSON.parse(serializeAssistantSession(chat({ contextCompactions: [compaction(), compaction({ id: "compaction-2", throughMessageId: "m3", skipNext: true, trigger: "manual", source: "fallback" })], contextLast: last }))));
    expect(saved.contextCompactions).toEqual([compaction(), compaction({ id: "compaction-2", throughMessageId: "m3", skipNext: true, trigger: "manual", source: "fallback" })]);
    expect(saved.contextLast).toEqual(last);
    expect(saved.messages).toHaveLength(5);
  });

  it("drops a record it cannot read, never the chat: a chat of a newer or broken version still opens with its messages", () => {
    const saved = parseAssistantSession({
      ...JSON.parse(serializeAssistantSession(chat())),
      contextCompactions: [compaction(), { ...compaction({ id: "bad" }), source: "oracle" }, { ...compaction({ id: "bad-2" }), beforeTokens: -1 }, "nonsense"],
      contextLast: { ...last, shape: "not a shape" },
    });
    expect(saved.contextCompactions?.map((entry) => entry.id)).toEqual(["compaction-1"]);
    expect(saved.contextLast).toBeUndefined();
    expect(saved.messages).toHaveLength(5);
    const plain = parseAssistantSession(JSON.parse(serializeAssistantSession(chat())));
    expect(plain.contextCompactions, "a chat that was never compacted has none").toBeUndefined();
    expect(plain.contextLast).toBeUndefined();
  });
});

describe("the settings of the compaction", () => {
  it("are on at 90% by default, and a threshold is kept within 50% and 95%", () => {
    expect(normalizeContextCompaction(undefined)).toEqual({ auto: true, threshold: 90 });
    expect(normalizeContextCompaction({ auto: false, threshold: 99 })).toEqual({ auto: false, threshold: 95 });
    expect(normalizeContextCompaction({ threshold: 12.4 })).toEqual({ auto: true, threshold: 50 });
    expect(normalizeContextCompaction({ auto: "no", threshold: "80" })).toEqual({ auto: true, threshold: 90 });
    expect(normalizeContextCompaction({ threshold: 72.6 })).toEqual({ auto: true, threshold: 73 });
    expect(migrateSettings({ ...DEFAULT_SETTINGS, contextCompaction: undefined }).contextCompaction, "settings saved before it").toEqual({ auto: true, threshold: 90 });
    expect(migrateSettings({ ...DEFAULT_SETTINGS, contextCompaction: { auto: false, threshold: 60 } }).contextCompaction).toEqual({ auto: false, threshold: 60 });
  });

  it("have their card: the switch says what it does, the threshold is a share of the model's window, and with the switch off the card says how to compact", () => {
    const patchSettings = vi.fn();
    const { rerender } = render(<ContextCompactionSettingsBody settings={DEFAULT_SETTINGS} patchSettings={patchSettings} />);
    const toggle = screen.getByRole("switch", { name: "Compact automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription(/When the next message would reach the threshold, the older part of the conversation is summarised/);
    expect(screen.getByRole("combobox", { name: "Threshold" })).toHaveTextContent("90% of the model's window");
    expect(screen.getByRole("combobox", { name: "Threshold" })).toHaveAccessibleDescription(/The default is 90%/);
    fireEvent.click(toggle);
    expect(patchSettings).toHaveBeenCalledWith({ contextCompaction: { auto: false, threshold: 90 } });
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<ContextCompactionSettingsBody settings={{ ...DEFAULT_SETTINGS, contextCompaction: { auto: false, threshold: 75 } }} patchSettings={patchSettings} />);
    expect(screen.getByRole("switch", { name: "Compact automatically" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("combobox", { name: "Threshold" })).toHaveTextContent("75% of the model's window");
    expect(screen.getByRole("status")).toHaveTextContent("With it off, compact yourself: /compact in the chat, or “Compact now” on the ring next to Send.");
  });

  it("speak Italian", async () => {
    await i18n.changeLanguage("it");
    render(<ContextCompactionSettingsBody settings={DEFAULT_SETTINGS} patchSettings={vi.fn()} />);
    expect(screen.getByRole("switch", { name: "Compatta automaticamente" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Soglia" })).toHaveTextContent("90% della finestra del modello");
  });
});

describe("the messages a chat too large to keep archived", () => {
  it("are shown again on request, read-only, with who wrote each", () => {
    render(<ArchivedMessages messages={[{ id: "a", role: "user", text: "The first request." }, { id: "b", role: "assistant", text: "The first answer." }, { id: "c", role: "user", text: "The second request." }]} />);
    const show = screen.getByRole("button", { name: "Show the 3 archived messages" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("The first answer.")).toBeNull();
    fireEvent.click(show);
    const hide = screen.getByRole("button", { name: "Hide the archived messages" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    const list = document.getElementById(hide.getAttribute("aria-controls")!)!;
    expect(list).toHaveTextContent("Kept apart to keep this chat within its size: read-only.");
    expect(list).toHaveTextContent("YouThe first request.");
    expect(list).toHaveTextContent("AssistantThe first answer.");
    expect(list.querySelectorAll("button, textarea, input")).toHaveLength(0);
    cleanup();
    const { container } = render(<ArchivedMessages messages={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
