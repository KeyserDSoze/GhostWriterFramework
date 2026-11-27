import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

// #121 in the panel: the request whose fallbacks a routing limit left out, sent again in one click after the limit is raised in the settings, the old value remembered and put
// back on request.

const mocks = vi.hoisted(() => ({ runAssistantPrompt: vi.fn(), saveSettingsNow: vi.fn(async () => true), book: null as null | Record<string, unknown>, refresh: vi.fn(async () => undefined) }));
vi.mock("@/drive/useSettings", async (original) => ({ ...await original<typeof import("@/drive/useSettings")>(), saveSettingsNow: mocks.saveSettingsNow }));
vi.mock("@/assistant/service", () => ({ appendAssistantNote: vi.fn(), applyParagraphRewrite: vi.fn(), compactAssistantSession: vi.fn(async ({ session }) => session), runAssistantPrompt: mocks.runAssistantPrompt }));
vi.mock("@/assistant/chatCloud", async (original) => ({ ...await original<typeof import("@/assistant/chatCloud")>(), listAssistantSessions: vi.fn(async () => []), saveAssistantSession: vi.fn(async () => ({ fileId: "f", revision: "r" })), loadAssistantSession: vi.fn(), deleteAssistantSession: vi.fn() }));
vi.mock("@/assistant/chatLocal", () => ({ listLocalChatSessions: vi.fn(async () => []), saveLocalChatSession: vi.fn(async () => undefined), loadLocalChatSession: vi.fn(), deleteLocalChatSession: vi.fn(async () => undefined) }));
vi.mock("@/assistant/context", async (original) => ({ ...await original<typeof import("@/assistant/context")>(), loadWriterContext: vi.fn(async () => ({ title: "Synopsis", summary: "", loadedFilePaths: [], availableFiles: [], relevantFiles: [], route: { kind: "other", pathname: "/" }, book: mocks.book, structure: null })) }));
vi.mock("@/assistant/mutationRefresh", async (original) => ({ ...await original<typeof import("@/assistant/mutationRefresh")>(), refreshBookAfterMutation: mocks.refresh }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false }) }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { createEmptyAssistantSession, useAssistantStore } from "@/assistant/store";
import { resetAssistantSessionIndex } from "@/assistant/sessionIndex";
import { AiProviderError } from "narrarium-engine";
import { useAuthStore } from "@/store/authStore";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  resetAssistantSessionIndex(null);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
  mocks.runAssistantPrompt.mockReset().mockImplementation(async () => ({ id: crypto.randomUUID(), role: "assistant", text: "Fatto." }));
  mocks.saveSettingsNow.mockClear();
  mocks.book = null;
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "writer-id", email: "writer@example.com", name: "Writer", picture: "" }, accessToken: "token", accessTokenExpiry: Date.now() + 60_000 });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "USD" } });
  useAssistantStore.setState({ open: true, busy: false, sessions: [], sessionAccountIdentity: null, sessionsLoading: false, currentSession: createEmptyAssistantSession("Synopsis") });
  await i18n.changeLanguage("en");
});

afterEach(() => cleanup());

/** A request whose first model failed, and whose fallbacks a routing limit kept out: what the router ends with. */
const leftOut = (budget: { limit: "tokens" | "cost"; estimated: number; allowed: number }) => Object.assign(new AiProviderError("HTTP 503: down.", 503), { budget });

const panel = () => render(<MemoryRouter initialEntries={["/app/books/book-1/outline"]}><AssistantPanel /></MemoryRouter>);
const composer = () => document.querySelector<HTMLTextAreaElement>("textarea")!;
const send = () => fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true });

describe("a request whose fallbacks a routing limit left out", () => {
  it("says the failure, the limit that kept the fallbacks out and its numbers, raises it in one click and sends the request again once, then puts the old value back on request", async () => {
    mocks.runAssistantPrompt.mockReset()
      .mockImplementationOnce(async () => { throw leftOut({ limit: "cost", estimated: 6.1, allowed: 5 }); })
      .mockImplementationOnce(async () => ({ id: crypto.randomUUID(), role: "assistant", text: "Fatto." }));
    panel();
    fireEvent.change(composer(), { target: { value: "Ciao" } });
    send();
    const raise = await screen.findByRole("button", { name: "Raise the limit to $8.00 and send again" });
    const refusal = raise.closest("[data-routing-limit]")!.parentElement!;
    expect(refusal).toHaveTextContent("HTTP 503: down.");
    expect(refusal).toHaveTextContent("A routing limit left the fallbacks out");
    expect(refusal).toHaveTextContent("The fallbacks after the first model were not tried: they are estimated at $6.10 together, and the limit of the AI Router is $5.00 (“Maximum estimated route cost”, Settings › AI Router › Routing options).");
    expect(refusal).toHaveTextContent("The limit is changed in your settings, where you can put it back: it is now $5.00.");
    expect(within(refusal as HTMLElement).getByRole("link", { name: "Open the routing options" })).toHaveAttribute("href", "/app/settings/ai-router#routing-options");

    fireEvent.click(raise);
    expect(useSettingsStore.getState().settings.routingExecution).toMatchObject({ maxEstimatedCost: 8, raisedFrom: { maxEstimatedCost: 5 } });
    expect(mocks.saveSettingsNow, "saved as every setting is, to be there after a reload").toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.runAssistantPrompt).toHaveBeenCalledTimes(2));
    expect((mocks.runAssistantPrompt.mock.calls[1][0] as { prompt: string; settings: { routingExecution: { maxEstimatedCost: number } } })).toMatchObject({ prompt: "Ciao", settings: { routingExecution: { maxEstimatedCost: 8 } } });
    expect((await screen.findAllByText("Fatto.")).length).toBeGreaterThan(0);
    const messages = useAssistantStore.getState().currentSession!.messages;
    expect(messages.filter((message) => message.role === "user").map((message) => message.text), "the request is in the chat once").toEqual(["Ciao"]);
    expect((mocks.runAssistantPrompt.mock.calls[1][0] as { history: unknown[] }).history, "the model reads the chat as it was before the request").toEqual([]);
    expect(messages[1].text).toContain("The limit is now $8.00 (it was $5.00), and the request was sent again.");

    fireEvent.click(screen.getByRole("button", { name: "Put back $5.00" }));
    expect(useSettingsStore.getState().settings.routingExecution).toEqual(DEFAULT_SETTINGS.routingExecution);
    expect(mocks.saveSettingsNow).toHaveBeenCalledTimes(2);
    expect(useAssistantStore.getState().currentSession!.messages[1].text).toContain("The limit is back to $5.00.");
    expect(screen.queryByRole("button", { name: /Put back/ })).toBeNull();
  });

  it("is said on the page of a book too, where the request that failed loads the book again: that is not a change of the context that would drop it", async () => {
    mocks.book = { id: "book-1", name: "Le correnti di Ancona", owner: "", repo: "", tokenIndex: null, addedAt: "now" };
    // What the reload after a failure does to the store of the books: the structure goes, and comes back.
    mocks.refresh.mockImplementation(async () => {
      const generation = useBooksStore.getState().invalidateStructure("book-1");
      await Promise.resolve();
      useBooksStore.getState().setStructure("book-1", { title: "Le correnti di Ancona", chapters: [] } as never, generation);
    });
    mocks.runAssistantPrompt.mockReset().mockImplementationOnce(async () => { throw leftOut({ limit: "cost", estimated: 6.1, allowed: 5 }); });
    panel();
    fireEvent.change(composer(), { target: { value: "Ciao" } });
    send();
    expect(await screen.findByRole("button", { name: "Raise the limit to $8.00 and send again" })).toBeInTheDocument();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("says it in Italian", async () => {
    await i18n.changeLanguage("it");
    mocks.runAssistantPrompt.mockReset().mockImplementationOnce(async () => { throw leftOut({ limit: "tokens", estimated: 230_000, allowed: 200_000 }); });
    panel();
    fireEvent.change(composer(), { target: { value: "Ciao" } });
    send();
    expect(await screen.findByRole("button", { name: "Alza il limite a 300.000 e invia di nuovo" })).toBeInTheDocument();
    expect(screen.getAllByText(/I fallback dopo il primo modello non sono stati provati: userebbero circa 230\.000 token insieme, e il limite dell'AI Router è 200\.000/).length).toBeGreaterThan(0);
  });
});
