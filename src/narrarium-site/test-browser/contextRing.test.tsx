import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import "@/i18n/pageCopilot";
import { chatContextOf } from "@/assistant/chatContext";
import { forgetTokenRatios } from "@/assistant/contextBudget";
import { createEmptyAssistantSession, type AssistantSession, type ContextCompaction, type ContextLastRequest } from "@/assistant/store";
import { ContextRing, SlashMenu, slashCommandOf, slashMatches, useSlashMenu, type SlashCommandName } from "@/components/assistant/context/ContextRing";
import { CompactionMarker, ContextBreakdown, TooLargeNotice } from "@/components/assistant/context/ContextParts";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";

// #122, the parts of the chat that show its context: the ring next to Send in its four states (in colour and in words, its numbers on hover and on focus), the popover of
// what the next message carries, the menu of the slash commands, the marker of a compaction with «Undo for the next message», and the notice of a message that does not fit.

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(async () => {
  forgetTokenRatios();
  await i18n.changeLanguage("en");
});
afterEach(() => cleanup());

const settings = {
  ...DEFAULT_SETTINGS,
  aiIntegrations: [{ id: "fake", name: "Fake", provider: "openai", endpoint: "https://fake.test/v1", apiKey: "sk-fake-0123456789abcdef", chatModels: [{ id: "big", name: "big", capabilities: ["default", "copilot"], supportsToolCalls: true, maxInputTokens: 128_000, maxOutputTokens: 8_000, pricing: { inputPerMTok: 2, cachedPerMTok: 0.5, outputPerMTok: 8 } }] }],
  taskRouting: { copilot: { primary: { integrationId: "fake", model: "big" }, fallbacks: [] } },
} as AppSettings;

const last: ContextLastRequest = { integrationId: "fake", model: "big", shape: { system: 3_000, tools: 600, files: 8_000, pageState: 400, attachments: 0, summary: 0, conversation: 2_000, request: 50, results: 0, other: 0 }, usage: { inputTokens: 15_000, cachedInputTokens: 6_000, outputTokens: 700 }, attachmentsKey: "", summaryKey: "", at: "2026-11-27T10:00:00.000Z" };

/** A chat of ten messages of `words` words each, after a request of the Copilot. */
function chat(words: number, extra: Partial<AssistantSession> = {}): AssistantSession {
  return { ...createEmptyAssistantSession("Chat"), contextLast: last, messages: Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, role: (index % 2 ? "assistant" : "user") as "user" | "assistant", text: "parola ".repeat(words) })), ...extra };
}

/** The chat whose next request is in `state`: the fewest words a message that bring it there. */
function chatIn(state: "full" | "over"): AssistantSession {
  for (let words = 500; words < 20_000; words += 100) {
    if (chatContextOf({ session: chat(words), settings, draft: "" }).estimate.state === state) return chat(words);
  }
  throw new Error(`no chat is ${state}`);
}

function ring(session: AssistantSession, options: { compacting?: boolean; canCompact?: boolean; onCompact?: () => void } = {}) {
  const context = chatContextOf({ session, settings, draft: "", compacting: options.compacting });
  render(<MemoryRouter><div><ContextRing context={context} canCompact={options.canCompact ?? true} onCompact={options.onCompact ?? vi.fn()} currency="USD" /></div></MemoryRouter>);
  return { context, button: () => document.querySelector<HTMLButtonElement>("[data-context-ring] > button")! };
}

describe("the context ring", () => {
  it("says the share of the window the next message takes, with its numbers and where the window comes from, on hover and on focus; Escape hides them", () => {
    const { context, button } = ring(chat(200));
    const { estimate } = context;
    expect(estimate.state).toBe("normal");
    const label = `${estimate.percent}% of the context (${estimate.total.toLocaleString("en-US")} of 128,000 tokens), window from the model's configuration`;
    expect(button()).toHaveAccessibleName(label);
    expect(button()).toHaveTextContent(`${estimate.percent}%`);
    expect(document.querySelector("[data-context-ring]")).toHaveAttribute("data-context-ring", "normal");
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    fireEvent.focus(button());
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent(label);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    fireEvent.pointerEnter(button());
    expect(screen.getByRole("tooltip", { hidden: true })).toBeInTheDocument();
    fireEvent.pointerLeave(button());
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  });

  it("says its state in words as well as in colour: getting full, compacting, over the window", () => {
    // Past 85% of the point where the chat compacts, before it.
    const full = ring(chatIn("full"));
    expect(full.context.estimate.state).toBe("full");
    expect(full.button()).toHaveTextContent("Getting full");
    expect(full.button().getAttribute("aria-label")).toMatch(/\. Getting full$/);
    expect(full.button().className).toContain("text-amber-800");
    cleanup();
    const compacting = ring(chatIn("full"), { compacting: true });
    expect(compacting.button()).toHaveTextContent("Compacting…");
    expect(compacting.button().getAttribute("aria-label")).toMatch(/\. Compacting…$/);
    cleanup();
    const over = ring(chatIn("over"));
    expect(over.context.estimate.state).toBe("over");
    expect(over.button()).toHaveTextContent(`${over.context.estimate.percent}%Over`);
    expect(over.button().getAttribute("aria-label")).toMatch(/\. Over the window$/);
    expect(over.button().className).toContain("text-red-700");
  });

  it("before the first message says that the instructions, the page and the tools are counted after it", () => {
    const { button } = ring({ ...createEmptyAssistantSession("Chat") });
    expect(button().getAttribute("aria-label")).toContain("The instructions, the page and the tools are counted after the first message.");
    expect(button().getAttribute("aria-label")).toContain("window from the model's configuration");
  });

  it("opens with a press what the next message carries, part by part, with the cached share, the cost and «Compact now»; Escape closes it and gives the focus back", async () => {
    const onCompact = vi.fn();
    const { context, button } = ring(chat(400), { onCompact });
    fireEvent.click(button());
    expect(button()).toHaveAttribute("aria-expanded", "true");
    const dialog = await screen.findByRole("dialog", { name: "Context of the next message" });
    expect(button()).toHaveAttribute("aria-controls", dialog.id);
    await waitFor(() => expect(dialog).toHaveFocus());
    const rows = (await within(dialog).findAllByRole("row")).slice(1);
    expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual(["Instructions and tools", "Canon and files", "Page state", "Attachments and material", "Compacted summary", "Conversation", "Your message"]);
    expect(within(rows[1]).getAllByRole("cell")[0]).toHaveTextContent(context.estimate.parts.files.toLocaleString("en-US"));
    expect(dialog).toHaveTextContent("big on Fake: a window of 128,000 tokens, from the model's configuration.");
    expect(dialog).toHaveTextContent(`Estimated cached share: ${Math.round((context.estimate.cacheable / context.estimate.total) * 100)}%`);
    expect(dialog).toHaveTextContent("Last request: 40% served from the provider's cache (6,000 of 15,000 tokens).");
    expect(dialog).toHaveTextContent(/Next message: about \$0\.0\d+ of input\./);
    expect(dialog).toHaveTextContent(/About \$0\.0056 more for an answer as long as the last one\./);
    expect(within(dialog).getByRole("link", { name: "Compaction settings" })).toHaveAttribute("href", "/app/settings/tools");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button()).toHaveFocus();
    expect(button()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button());
    fireEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Compact now" }));
    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button()).toHaveFocus();
  });

  it("closes when something else is pressed, and offers no compaction when there is nothing to compact", async () => {
    const { button } = ring(chat(100), { canCompact: false });
    fireEvent.click(button());
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("button", { name: "Compact now" })).toBeDisabled();
    expect(dialog).toHaveTextContent("Nothing to compact yet: the last messages always go as they are.");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("speaks Italian", async () => {
    await i18n.changeLanguage("it");
    const { context, button } = ring(chatIn("full"));
    expect(button()).toHaveAccessibleName(`${context.estimate.percent}% del contesto (${context.estimate.total.toLocaleString("it-IT")} di 128.000 token), finestra da configurazione del modello. Quasi pieno`);
    fireEvent.click(button());
    const dialog = await screen.findByRole("dialog", { name: "Contesto del prossimo messaggio" });
    expect(await within(dialog).findByRole("button", { name: "Compatta ora" })).toBeInTheDocument();
  });
});

function SlashHarness({ onRun }: { onRun: (command: SlashCommandName) => void }) {
  const [draft, setDraft] = useState("");
  const menu = useSlashMenu(draft, (command) => { onRun(command); setDraft(""); }, (command) => setDraft(command));
  return (
    <div className="relative">
      <SlashMenu menu={menu} onRun={(command) => { onRun(command); setDraft(""); }} />
      <textarea aria-label="Message" {...menu.fieldProps} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { menu.onKeyDown(event); }} />
    </div>
  );
}

describe("the slash commands", () => {
  it("are what a message of one word that starts with «/» is", () => {
    expect(slashCommandOf("/compact")).toBe("/compact");
    expect(slashCommandOf("  /Context ")).toBe("/context");
    expect(slashCommandOf("/compact now")).toBeNull();
    expect(slashMatches("/")).toEqual(["/compact", "/context"]);
    expect(slashMatches("/con")).toEqual(["/context"]);
    expect(slashMatches("/x")).toEqual([]);
    expect(slashMatches("hello /")).toEqual([]);
  });

  it("open a menu of options as «/» is typed: the arrows move through it while the box keeps the focus, Enter runs one, Tab writes it, Escape closes it", () => {
    const onRun = vi.fn();
    render(<SlashHarness onRun={onRun} />);
    const box = screen.getByRole("textbox", { name: "Message" });
    box.focus();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box, { target: { value: "/" } });
    const list = screen.getByRole("listbox", { name: "Commands" });
    const options = within(list).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["/compactSummarise the older part of the conversation now", "/contextShow what the next message carries, part by part"]);
    expect(box).toHaveAttribute("aria-controls", list.id);
    expect(box).toHaveAttribute("aria-activedescendant", options[0].id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box).toHaveAttribute("aria-activedescendant", options[1].id);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box, "it wraps around").toHaveAttribute("aria-activedescendant", options[0].id);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onRun).toHaveBeenCalledWith("/context");
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: "/com" } });
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box).toHaveValue("/compact");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box).not.toHaveAttribute("aria-activedescendant");
    fireEvent.change(box, { target: { value: "/compact please" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box, { target: { value: "/" } });
    fireEvent.click(within(screen.getByRole("listbox")).getAllByRole("option")[0]);
    expect(onRun).toHaveBeenLastCalledWith("/compact");
  });
});

const compaction = (extra: Partial<ContextCompaction> = {}): ContextCompaction => ({ id: "c1", throughMessageId: "m5", messageCount: 6, coveredCount: 6, summary: "- The author wants a darker ending.", source: "model", trigger: "auto", at: "2026-11-27T10:00:00.000Z", beforeTokens: 112_345, afterTokens: 21_000, ...extra });

describe("the marker of a compaction", () => {
  it("says what was summarised, shows the summary on request, and undoes it for the next message while it is the one in force", () => {
    const onUndo = vi.fn();
    const { rerender } = render(<CompactionMarker compaction={compaction()} active canUndo onUndo={onUndo} />);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Context compacted: 6 messages summarised");
    expect(note).toHaveTextContent("The next requests carry about 21,000 tokens instead of 112,345.");
    const show = within(note).getByRole("button", { name: "Show the summary" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(show);
    expect(within(note).getByRole("button", { name: "Hide the summary" })).toHaveAttribute("aria-expanded", "true");
    expect(note).toHaveTextContent("The author wants a darker ending.");
    fireEvent.click(within(note).getByRole("button", { name: "Undo for the next message" }));
    expect(onUndo).toHaveBeenCalledWith(true);
    rerender(<CompactionMarker compaction={compaction({ skipNext: true, trigger: "manual", coveredCount: 1, source: "fallback" })} active canUndo onUndo={onUndo} />);
    expect(note).toHaveTextContent("Context compacted on request: 1 message summarised");
    expect(note).toHaveTextContent("Made without a model (the model did not answer)");
    expect(within(note).getByRole("status")).toHaveTextContent("The next message carries these messages as they are, once.");
    fireEvent.click(within(note).getByRole("button", { name: "Keep it compacted" }));
    expect(onUndo).toHaveBeenLastCalledWith(false);
    rerender(<CompactionMarker compaction={compaction()} active={false} canUndo onUndo={onUndo} />);
    expect(within(note).queryByRole("button", { name: "Undo for the next message" }), "an older compaction is not the one in force").toBeNull();
    rerender(<CompactionMarker compaction={compaction()} active canUndo={false} onUndo={onUndo} />);
    expect(note).toHaveTextContent("These messages were archived to keep the chat within its size");
  });
});

describe("a message that does not fit", () => {
  it("says so with the numbers, that nothing was sent, and the options: material, shorter, a model with a larger window (or the window of this one)", () => {
    const onMaterial = vi.fn();
    const onShorten = vi.fn();
    render(<MemoryRouter><TooLargeNotice notice={{ total: 160_000, budget: 113_600, window: 128_000, source: "default", model: "gpt-5", message: 95_000, compacted: true }} onMaterial={onMaterial} onShorten={onShorten} onDismiss={vi.fn()} /></MemoryRouter>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("This message does not fit");
    expect(alert).toHaveTextContent("With it, the next request would be about 160,000 tokens, and gpt-5 has room for 113,600 (a window of 128,000 tokens, from the default (the model has none set)). Your message alone is about 95,000 tokens.");
    expect(alert).toHaveTextContent("The older part of the conversation is already compacted.");
    expect(alert).toHaveTextContent("Nothing was sent. You can:");
    fireEvent.click(within(alert).getByRole("button", { name: "Attach it as material" }));
    fireEvent.click(within(alert).getByRole("button", { name: "Shorten it" }));
    expect(onMaterial).toHaveBeenCalledTimes(1);
    expect(onShorten).toHaveBeenCalledTimes(1);
    expect(within(alert).getByRole("link", { name: "Choose a model with a larger window" })).toHaveAttribute("href", "/app/settings/ai-router");
    expect(within(alert).getByRole("link", { name: "Set this model's window" })).toHaveAttribute("href", "/app/settings/ai-integrations");
  });
});

describe("the breakdown on its own", () => {
  it("is what `/context` prints too, with the state in words", () => {
    const context = chatContextOf({ session: chat(400), settings, draft: "" });
    act(() => { render(<MemoryRouter><ContextBreakdown context={context} titleId="t" canCompact currency="USD" onCompact={vi.fn()} onClose={vi.fn()} /></MemoryRouter>); });
    expect(screen.getByText("Context in use")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "What the next message carries" })).toBeInTheDocument();
  });
});
