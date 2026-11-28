import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

// #122 in the panel: the ring next to Send, the compaction at the threshold of the window (every message kept in the chat, the summary and the recent messages sent), its
// marker with «Undo for the next message», `/compact` and `/context` (a note of the chat that is never sent), and a message that does not fit even after the compaction.

const mocks = vi.hoisted(() => ({ runAssistantPrompt: vi.fn(), completeTextRouted: vi.fn() }));
vi.mock("@/assistant/service", () => ({ appendAssistantNote: vi.fn(), applyParagraphRewrite: vi.fn(), compactAssistantSession: vi.fn(async ({ session }) => session), runAssistantPrompt: mocks.runAssistantPrompt }));
vi.mock("@/assistant/router", async (original) => ({ ...await original<typeof import("@/assistant/router")>(), completeTextRouted: mocks.completeTextRouted }));
vi.mock("@/assistant/chatCloud", async (original) => ({ ...await original<typeof import("@/assistant/chatCloud")>(), listAssistantSessions: vi.fn(async () => []), saveAssistantSession: vi.fn(async () => ({ fileId: "f", revision: "r" })), loadAssistantSession: vi.fn(), deleteAssistantSession: vi.fn() }));
vi.mock("@/assistant/chatLocal", () => ({ listLocalChatSessions: vi.fn(async () => []), saveLocalChatSession: vi.fn(async () => undefined), loadLocalChatSession: vi.fn(), deleteLocalChatSession: vi.fn(async () => undefined) }));
vi.mock("@/assistant/context", async (original) => ({ ...await original<typeof import("@/assistant/context")>(), loadWriterContext: vi.fn(async () => ({ title: "Chapter 1", summary: "", loadedFilePaths: [], availableFiles: [], relevantFiles: [], route: { kind: "other", pathname: "/" }, book: null, structure: null })) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false }) }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { forgetTokenRatios } from "@/assistant/contextBudget";
import { createEmptyAssistantSession, useAssistantStore, type AssistantMessage, type AssistantSession } from "@/assistant/store";
import { resetAssistantSessionIndex } from "@/assistant/sessionIndex";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";

beforeAll(async () => {
  await loadAutopilotTranslations();
});

/** Ten messages of `words` words each: about 9,000 words a message take a window of 128,000 tokens past its threshold. */
function longChat(words: number, extra: Partial<AssistantSession> = {}): AssistantSession {
  const messages: AssistantMessage[] = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? "assistant" : "user", text: `Message ${index}: ${"parola ".repeat(words)}` }));
  return { ...createEmptyAssistantSession("Chapter 1"), messages, ...extra };
}

function withSettings(extra: Partial<AppSettings> = {}) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "USD", ...extra } });
}

beforeEach(async () => {
  forgetTokenRatios();
  resetAssistantSessionIndex(null);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
  mocks.runAssistantPrompt.mockReset().mockImplementation(async () => ({ id: crypto.randomUUID(), role: "assistant", text: "Fatto." }));
  mocks.completeTextRouted.mockReset().mockResolvedValue("- The author is revising chapter 1.\n- The ending stays open.");
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "writer-id", email: "writer@example.com", name: "Writer", picture: "" }, accessToken: "token", accessTokenExpiry: Date.now() + 60_000 });
  withSettings();
  useAssistantStore.setState({ open: true, busy: false, sessions: [], sessionAccountIdentity: null, sessionsLoading: false, currentSession: createEmptyAssistantSession("Chapter 1") });
  await i18n.changeLanguage("en");
});

afterEach(() => cleanup());

const panel = () => render(<MemoryRouter initialEntries={["/app/books"]}><AssistantPanel /></MemoryRouter>);
const composer = () => document.querySelector<HTMLTextAreaElement>("textarea")!;
const send = (text: string) => {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true });
};
const ringButton = () => document.querySelector<HTMLButtonElement>("[data-context-ring] > button")!;
const lastCall = () => mocks.runAssistantPrompt.mock.calls[mocks.runAssistantPrompt.mock.calls.length - 1][0] as { history: AssistantMessage[]; compactSummary: string; prompt: string };
const session = () => useAssistantStore.getState().currentSession!;

describe("the context of a chat in the panel", () => {
  it("shows the share of the window next to Send, and it rises as the author writes", async () => {
    panel();
    const before = Number(document.querySelector("[data-context-ring]")!.getAttribute("data-context-percent"));
    expect(ringButton()).toHaveAccessibleName(/^\d+% of the context \(\d[\d,]* of 128,000 tokens\), window from the default \(the model has none set\)\. The instructions, the page and the tools are counted after the first message\.$/);
    fireEvent.change(composer(), { target: { value: "parola ".repeat(20_000) } });
    await waitFor(() => expect(Number(document.querySelector("[data-context-ring]")!.getAttribute("data-context-percent"))).toBeGreaterThan(before + 20));
  });

  it("compacts by itself at the threshold: every message stays in the chat, the marker says what was summarised, and the next request carries the summary and the recent messages", async () => {
    useAssistantStore.setState({ currentSession: longChat(9_000) });
    panel();
    const marker = await screen.findByRole("note");
    expect(marker).toHaveTextContent(/^Context compacted: \d+ messages? summarised/);
    expect(mocks.completeTextRouted).toHaveBeenCalledTimes(1);
    expect(mocks.completeTextRouted.mock.calls[0][2]).toBe("chat-resume");
    const [compaction] = session().contextCompactions!;
    expect(compaction).toMatchObject({ trigger: "auto", source: "model", summary: "- The author is revising chapter 1.\n- The ending stays open." });
    expect(compaction.afterTokens).toBeLessThan(compaction.beforeTokens);
    expect(session().messages, "every message is still in the chat").toHaveLength(10);
    expect(screen.getByText(/^Message 0:/)).toBeInTheDocument();
    expect(document.querySelector("[data-context-ring]")).toHaveAttribute("data-context-ring", "normal");

    send("Ciao");
    await waitFor(() => expect(mocks.runAssistantPrompt).toHaveBeenCalledTimes(1));
    const kept = session().messages.slice(session().messages.findIndex((message) => message.id === compaction.throughMessageId) + 1).filter((message) => message.text !== "Ciao" && message.text !== "Fatto.");
    expect(lastCall().compactSummary).toBe(compaction.summary);
    expect(lastCall().history.map((message) => message.id)).toEqual(kept.map((message) => message.id));

    // «Undo for the next message» with a conversation that, whole, does not fit the window: nothing is sent, and the notice says so, with «Keep it compacted».
    fireEvent.click(within(marker).getByRole("button", { name: "Undo for the next message" }));
    send("E adesso?");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The compaction is undone for this message: with the whole conversation it does not fit the window.");
    expect(mocks.runAssistantPrompt).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Keep it compacted" }));
    expect(session().contextCompactions![0].skipNext).toBeUndefined();
    fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true });
    await waitFor(() => expect(mocks.runAssistantPrompt).toHaveBeenCalledTimes(2));
    expect(lastCall()).toMatchObject({ prompt: "E adesso?", compactSummary: compaction.summary });
  });

  it("undoes a compaction for the next message: that request carries every message as it is, once, and the compaction is in force again after it", async () => {
    // A threshold of 50%: the chat compacts at 64,000 tokens, and its whole conversation (about 88,000) still fits the window.
    withSettings({ contextCompaction: { auto: true, threshold: 50 } });
    useAssistantStore.setState({ currentSession: longChat(4_000) });
    panel();
    const marker = await screen.findByRole("note");
    fireEvent.click(within(marker).getByRole("button", { name: "Undo for the next message" }));
    expect(within(marker).getByRole("status")).toHaveTextContent("The next message carries these messages as they are, once.");
    expect(session().contextCompactions![0].skipNext).toBe(true);
    send("E adesso?");
    await waitFor(() => expect(mocks.runAssistantPrompt).toHaveBeenCalledTimes(1));
    expect(lastCall().compactSummary).toBe("");
    expect(lastCall().history.map((message) => message.id)).toEqual(Array.from({ length: 10 }, (_, index) => `m${index}`));
    expect(mocks.completeTextRouted, "not compacted again on the way").toHaveBeenCalledTimes(1);
    await waitFor(() => expect(session().contextCompactions![0].skipNext).toBeUndefined());
    expect(within(screen.getByRole("note")).getByRole("button", { name: "Undo for the next message" })).toBeInTheDocument();
    send("Ancora?");
    await waitFor(() => expect(mocks.runAssistantPrompt).toHaveBeenCalledTimes(2));
    expect(lastCall().compactSummary).toBe(session().contextCompactions![0].summary);
  });

  it("summarises without a model when the model does not answer, and never blocks the chat", async () => {
    mocks.completeTextRouted.mockReset().mockRejectedValue(new Error("HTTP 503: down"));
    useAssistantStore.setState({ currentSession: longChat(9_000) });
    panel();
    const marker = await screen.findByRole("note");
    expect(marker).toHaveTextContent("Made without a model (the model did not answer): the first words of each message.");
    fireEvent.click(within(marker).getByRole("button", { name: "Show the summary" }));
    expect(marker).toHaveTextContent("Messages summarised without a model");
    send("Ciao");
    await waitFor(() => expect(mocks.runAssistantPrompt).toHaveBeenCalledTimes(1));
    expect(lastCall().compactSummary).toContain("- Author: Message 0:");
  });

  it("leaves it to the author when the automatic compaction is off: /compact compacts, /context prints the breakdown as a note of the chat that is never sent", async () => {
    withSettings({ contextCompaction: { auto: false, threshold: 90 } });
    useAssistantStore.setState({ currentSession: longChat(9_000) });
    panel();
    await waitFor(() => expect(document.querySelector("[data-context-ring]")).toHaveAttribute("data-context-ring", "over"));
    expect(screen.queryByRole("note")).toBeNull();
    expect(mocks.completeTextRouted).not.toHaveBeenCalled();

    fireEvent.change(composer(), { target: { value: "/" } });
    expect(within(screen.getByRole("listbox", { name: "Commands" })).getAllByRole("option").map((option) => option.textContent?.slice(0, 8))).toEqual(["/compact", "/context"]);
    fireEvent.keyDown(composer(), { key: "ArrowDown" });
    fireEvent.keyDown(composer(), { key: "Enter" });
    const note = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-local-note]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(note).toHaveTextContent("Only in this chat: not sent to the model");
    expect(note).toHaveTextContent("Context of the next message");
    expect(within(note).getByRole("table")).toBeInTheDocument();
    expect(composer()).toHaveValue("");

    send("/compact");
    const marker = await screen.findByRole("note");
    expect(marker).toHaveTextContent(/^Context compacted on request: \d+ messages summarised/);
    expect(session().contextCompactions![0].trigger).toBe("manual");

    send("Ciao");
    await waitFor(() => expect(mocks.runAssistantPrompt).toHaveBeenCalledTimes(1));
    expect(lastCall().history.some((message) => message.role === "system"), "the note of /context is never sent").toBe(false);
    expect(session().messages.some((message) => message.role === "system"), "and it stays in the chat").toBe(true);
  });

  it("does not send a message that does not fit even after the compaction: it says so with the numbers, keeps the text, and turns it into material on request", async () => {
    panel();
    const text = `Leggi questo: ${"parola ".repeat(80_000)}`;
    send(text);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This message does not fit");
    expect(alert).toHaveTextContent(/With it, the next request would be about \d[\d,]* tokens, and the model of this chat has room for 119,552 \(a window of 128,000 tokens, from the default \(the model has none set\)\)\./);
    expect(mocks.runAssistantPrompt).not.toHaveBeenCalled();
    expect(composer()).toHaveValue(text.trim());
    expect(session().messages, "nothing was sent, and nothing stays in the chat").toEqual([]);
    expect(within(alert).getByRole("link", { name: "Set this model's window" })).toHaveAttribute("href", "/app/settings/ai-integrations");
    fireEvent.click(within(alert).getByRole("button", { name: "Attach it as material" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(session().attachments[0]).toMatchObject({ material: true });
    expect(composer()).toHaveValue("Leggi questo:");
    send("Leggi questo:");
    await waitFor(() => expect(mocks.runAssistantPrompt).toHaveBeenCalledTimes(1));
  });
});
