import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>,
  toast: vi.fn(),
  save: vi.fn(async () => true),
  saveNow: vi.fn(async () => true),
  verified: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }), saveSettingsNow: () => mocks.saveNow() }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()), verifiedServer: (options: unknown) => mocks.verified(options) }));

import i18n from "@/i18n";
import "@/i18n/costs";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { useAutopilotStore } from "@/autopilot/store";
import { resetTaskCosts, useTaskCosts, type TaskCost } from "@/autopilot/taskCosts";
import { useCostsStore } from "@/costs/costsStore";
import { ledgerRows } from "@/costs/ledger";
import { recordUsage, type UsageRecord } from "@/costs/recordUsage";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings } from "@/types/settings";
import { activityOf, freezeClock, runningStep, seedRun } from "./helpers/autopilotBand";
import { resetCosts } from "./helpers/costs";
import { LOCAL_BOOK, makeRuntime, t } from "./helpers/quickCommands";

const LIVE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });
const DONE = activityOf("write", { id: "step-1", title: "Writing scene 1 of chapter 5 «Scene 1»", chapterNumber: 5, sceneNumber: 1 });
const RUNNING = { status: "running", running: true, live: { activity: LIVE } } as const;
const SERVER_BOOK = { ...LOCAL_BOOK, autopilotHost: "server" as const };

/** An integration of the settings with a model that has no price. */
const PROXY = { id: "int-1", name: "LlmProxy", provider: "openai", endpoint: "https://proxy.example.test/v1", apiKey: "k", chatModels: [{ id: "m-free", name: "free-model" }, { id: "m-gpt", name: "gpt-5", pricing: { inputPerMTok: 1, outputPerMTok: 2 } }] } as unknown as AIIntegration;

const CALL: UsageRecord = { origin: "autopilot", bookId: "book-1", task: "step-1", capability: "autopilot", integrationId: "int-1", model: "gpt-5", usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 300 }, usageKnown: true, cost: 0.004, costKnown: true, priced: true, currency: "USD" };

function taskRecord(task: string, patch: Partial<TaskCost> = {}): TaskCost {
  return { bookId: "book-1", task, calls: 1, money: { USD: 0.01 }, estimated: {}, inputTokens: 1000, cachedTokens: 0, outputTokens: 300, estimatedTokens: 0, unpricedCalls: 0, unknownUsageCalls: 0, models: ["gpt-5"], unpriced: [], at: "2026-11-21T10:00:30.000Z", ...patch };
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

const bandOf = () => document.querySelector<HTMLElement>("[data-autopilot-band]") as HTMLElement;
const usageOf = () => bandOf().querySelector<HTMLElement>("[data-band-usage]") as HTMLElement;
const bookCostsOf = () => bandOf().querySelector<HTMLElement>("[data-band-book-costs]") as HTMLElement;
const patchSettings = (patch: Partial<AppSettings>) => act(() => { useSettingsStore.setState((state) => ({ settings: { ...state.settings, ...patch } })); });
/** The text of a part of the page as it reads: its elements apart, as the gaps of the layout set them, and the text of each element as it is. */
function words(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  return [...node.childNodes].map((child) => (child.nodeType === Node.ELEMENT_NODE ? ` ${words(child)} ` : words(child))).join("");
}
const text = (element: Element | null) => (element ? words(element) : "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

/** Opens the reasons of the warnings, as a click on them does. */
function openWarnings(): HTMLDetailsElement {
  const warnings = usageOf().querySelector<HTMLDetailsElement>("[data-cost-warnings]")!;
  fireEvent.click(warnings.querySelector("summary")!);
  // jsdom does not open a disclosure on a click of its summary, as a browser does.
  if (!warnings.open) act(() => { warnings.open = true; });
  return warnings;
}

/** Records calls the way the AI port does, and waits until the ledger of this tab shows them. */
async function record(...calls: UsageRecord[]) {
  const before = ledgerRows(useCostsStore.getState().file.ledger).reduce((sum, row) => sum + row.calls, 0);
  act(() => { for (const call of calls) recordUsage(call); });
  await waitFor(() => expect(ledgerRows(useCostsStore.getState().file.ledger).reduce((sum, row) => sum + row.calls, 0)).toBe(before + calls.length));
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  freezeClock();
  mocks.runtime = makeRuntime();
  mocks.book = LOCAL_BOOK;
  mocks.saveNow.mockReset().mockResolvedValue(true);
  mocks.verified.mockReset();
  resetCosts({ bookId: "book-1", bookName: LOCAL_BOOK.name });
  resetTaskCosts();
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetTaskCosts();
  resetCosts();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useUiStore.setState({ autopilotText: "full" });
  localStorage.clear();
  await i18n.changeLanguage("en");
});

describe("what the step that runs costs, in the band", () => {
  it("says beside the total what the step has spent so far, from this browser's record of its calls, and follows each call as it ends", async () => {
    seedRun({ ...RUNNING, activities: [DONE] });
    act(() => { useTaskCosts.setState({ tasks: { "book-1\u0000live-write": taskRecord("live-write", { money: { USD: 0.0123 }, calls: 3 }) } }); });
    render(<Page />);
    const step = usageOf().querySelector("[data-band-step-cost]");
    expect(text(step)).toBe("(this step $0.0123 · 3 calls)");

    act(() => { recordUsage({ ...CALL, task: "live-write", cost: 0.0077 }); });
    await waitFor(() => expect(text(usageOf().querySelector("[data-band-step-cost]"))).toBe("(this step $0.02 · 4 calls)"));
  });

  it("says apart what the calls of the step whose tokens were not reported are estimated to have cost, never as money spent", () => {
    seedRun({ ...RUNNING, activities: [DONE] });
    act(() => { useTaskCosts.setState({ tasks: { "book-1\u0000live-write": taskRecord("live-write", { money: {}, estimated: { USD: 0.0036 }, calls: 1, unknownUsageCalls: 1, inputTokens: 0, outputTokens: 0, estimatedTokens: 1200 }) } }); });
    render(<Page />);
    expect(text(usageOf().querySelector("[data-band-step-cost]"))).toBe("(this step — · 1 call · ≈ $0.0036 estimated)");
  });

  it("says what the engine said of the step when this browser has no record of its calls (a run of the server)", () => {
    seedRun({ status: "running", running: true, live: { activity: { ...LIVE, cost: 0.03 } } });
    render(<Page />);
    expect(text(usageOf().querySelector("[data-band-step-cost]"))).toBe("(this step $0.03)");
  });
});

describe("what the book costs, in the band", () => {
  it("says what this run, this month and the book to date cost, every use of the book included and no other book", async () => {
    seedRun({ ...RUNNING, activities: [DONE] });
    await record(
      // The run: a call of the step that ended, two of the step that runs (its first attempt, and the fallback that answered).
      { ...CALL, at: new Date("2026-11-21T09:00:00.000Z") },
      { ...CALL, task: "live-write", cost: 0.0023, at: new Date("2026-11-21T10:00:10.000Z") },
      { ...CALL, task: "live-write", integrationId: "int-2", cost: 0.01, at: new Date("2026-11-21T10:00:20.000Z") },
      // The other uses of the book: the Copilot this month, an action of the editor in August; and another book, which is not this one.
      { ...CALL, origin: "copilot", task: "copilot-1", capability: "copilot", cost: 0.001, at: new Date("2026-11-21T09:30:00.000Z") },
      { ...CALL, origin: undefined, task: undefined, capability: "editor-actions", cost: 0.1, at: new Date("2026-08-14T09:00:00.000Z") },
      { ...CALL, bookId: "book-2", task: "other", cost: 1, at: new Date("2026-11-21T09:00:00.000Z") },
    );
    render(<Page />);
    const line = bookCostsOf();
    expect(text(line)).toContain(`${t("costs.band.run")} $0.0163 3 calls`);
    expect(text(line)).toContain(`${t("costs.thisMonth")} $0.0173`);
    expect(text(line)).toContain(`${t("costs.band.toDate")} $0.1173`);
    expect(text(usageOf().querySelector("[data-band-step-cost]")), "the step that runs, with its fallback").toBe("(this step $0.0123 · 2 calls)");
    expect(line, "a book in this browser says nothing of a server").not.toHaveTextContent(t("costs.band.serverNote"));
  });

  it("follows the currency of the settings at once: a rate converts what was recorded, marked as converted", async () => {
    seedRun({ ...RUNNING, activities: [DONE], stats: { cost: 0.5, currency: "USD" } });
    await record({ ...CALL, at: new Date("2026-11-21T09:00:00.000Z") });
    render(<Page />);
    expect(text(usageOf())).toContain("Cost $0.50");
    expect(text(bookCostsOf())).toContain(`${t("costs.thisMonth")} $0.004`);

    patchSettings({ costCurrency: "EUR", costRates: [{ from: "USD", to: "EUR", rate: 0.9 }] });
    expect(text(usageOf())).toContain("Cost ≈ €0.45");
    expect(text(bookCostsOf())).toContain(`${t("costs.thisMonth")} ≈ €0.0036`);
    expect(bookCostsOf()).toHaveTextContent("converted at 1 USD = 0.9 EUR");

    patchSettings({ costRates: undefined });
    expect(text(usageOf()), "without a rate, what was recorded in USD is shown in USD").toContain("Cost $0.50");
  });
});

describe("the calls whose cost is not known, in the band", () => {
  it("names the calls without a price and without a token count, the models to fix, and the estimate apart, never added to the cost", async () => {
    seedRun({ ...RUNNING, activities: [DONE], stats: { cost: 0, usageUnknownCalls: 1, costUnknownCalls: 2 } });
    act(() => { useSettingsStore.setState((state) => ({ settings: { ...state.settings, aiIntegrations: [PROXY] } })); });
    await record(
      { ...CALL, model: "free-model", priced: false, cost: undefined, costKnown: false, at: new Date("2026-11-21T09:00:00.000Z") },
      { ...CALL, model: "free-model", priced: false, cost: undefined, costKnown: false, at: new Date("2026-11-21T09:10:00.000Z") },
      { ...CALL, usageKnown: false, costKnown: false, cost: 0.001, usage: { inputTokens: 400, cachedTokens: 0, outputTokens: 100 }, at: new Date("2026-11-21T09:20:00.000Z") },
    );
    render(<Page />);
    const summary = usageOf().querySelector("[data-cost-warnings] summary")!;
    expect(summary).toHaveTextContent(t("autopilot.progress.usageUnknown", { count: 1 }));
    expect(summary).toHaveTextContent(t("autopilot.progress.costUnknown", { count: 2 }));
    expect(summary).toHaveTextContent(t("costs.fix.why"));
    const warnings = openWarnings();
    expect(warnings).toHaveTextContent(t("autopilot.progress.usageUnknownHint"));
    expect(warnings).toHaveTextContent(t("autopilot.progress.costUnknownHint"));

    const model = warnings.querySelector<HTMLElement>('[data-unpriced-model="free-model"]')!;
    expect(text(model)).toContain("free-model · LlmProxy · 2 calls");
    expect(within(model).getByRole("link", { name: `${t("costs.fix.openPrices")} — free-model · LlmProxy` })).toHaveAttribute("href", "/app/settings/ai-integrations#model-price-int-1--m-free");
    expect(text(warnings.querySelector("[data-cost-estimate]"))).toBe(t("costs.fix.estimate", { estimate: t("costs.estimate.withCost", { tokens: "500", amount: "$0.001" }) }));
    expect(text(warnings.querySelector("[data-cost-estimate]"))).toBe("For these calls: ≈ 500 tokens and ≈ $0.001, estimated");
    expect(text(bookCostsOf()), "an estimate is never added to what was measured").toContain(`${t("costs.thisMonth")} —`);
  });

  it("sets the price of a model where its calls are told, saved at once for the next calls", async () => {
    seedRun({ ...RUNNING, activities: [DONE], stats: { cost: 0, costUnknownCalls: 1 } });
    act(() => { useSettingsStore.setState((state) => ({ settings: { ...state.settings, aiIntegrations: [PROXY] } })); });
    await record({ ...CALL, model: "free-model", priced: false, cost: undefined, costKnown: false, at: new Date("2026-11-21T09:00:00.000Z") });
    render(<Page />);
    openWarnings();
    const model = usageOf().querySelector<HTMLElement>('[data-unpriced-model="free-model"]')!;
    const open = within(model).getByRole("button", { name: `${t("costs.fix.setPrice")} — free-model · LlmProxy` });
    expect(open).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(open);
    const form = within(model).getByRole("form", { name: t("costs.fix.form", { model: "free-model · LlmProxy" }) });
    const save = within(form).getByRole("button", { name: t("costs.fix.save") });
    expect(save, "nothing to save before a price is typed").toBeDisabled();
    fireEvent.change(within(form).getByLabelText(t("costs.priceInput", { unit: "USD" })), { target: { value: "0,5" } });
    fireEvent.change(within(form).getByLabelText(t("costs.priceOutput", { unit: "USD" })), { target: { value: "1.5" } });
    fireEvent.click(save);

    await waitFor(() => expect(mocks.saveNow).toHaveBeenCalledTimes(1));
    const priced = useSettingsStore.getState().settings.aiIntegrations[0].chatModels?.find((entry) => entry.id === "m-free");
    expect(priced?.pricing).toEqual({ inputPerMTok: 0.5, outputPerMTok: 1.5 });
    expect(useSettingsStore.getState().settings.aiIntegrations[0].chatModels?.find((entry) => entry.id === "m-gpt")?.pricing, "the other models keep theirs").toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
    expect(await within(model).findByRole("status")).toHaveTextContent(t("costs.fix.saved", { model: "free-model" }));
  });

  it("says so when the price cannot be saved here, and keeps the way to AI Integrations", async () => {
    mocks.saveNow.mockRejectedValue(new Error("offline"));
    seedRun({ ...RUNNING, activities: [DONE], stats: { cost: 0, costUnknownCalls: 1 } });
    act(() => { useSettingsStore.setState((state) => ({ settings: { ...state.settings, aiIntegrations: [PROXY] } })); });
    await record({ ...CALL, model: "free-model", priced: false, cost: undefined, costKnown: false, at: new Date("2026-11-21T09:00:00.000Z") });
    render(<Page />);
    openWarnings();
    const model = usageOf().querySelector<HTMLElement>('[data-unpriced-model="free-model"]')!;
    fireEvent.click(within(model).getByRole("button", { name: `${t("costs.fix.setPrice")} — free-model · LlmProxy` }));
    fireEvent.change(within(model).getByLabelText(t("costs.priceInput", { unit: "USD" })), { target: { value: "2" } });
    fireEvent.submit(within(model).getByRole("form"));
    expect(await within(model).findByRole("status")).toHaveTextContent(t("costs.fix.failed"));
    expect(within(model).getByRole("link", { name: `${t("costs.fix.openPrices")} — free-model · LlmProxy` })).toBeInTheDocument();
  });
});

describe("a run that recorded its costs in another currency than the one of the prices", () => {
  it("offers once to show them in the currency of the prices: accepted, they are shown relabelled, marked, and it is not offered again", async () => {
    seedRun({ ...RUNNING, activities: [DONE], stats: { cost: 0.5, currency: "USD" } });
    patchSettings({ costCurrency: "EUR" });
    const { unmount } = render(<Page />);
    const offer = bandOf().querySelector<HTMLElement>("[data-relabel-suggestion]")!;
    expect(offer).toHaveTextContent(t("costs.relabel.suggest", { recorded: "USD", display: "EUR" }));
    expect(text(usageOf())).toContain("Cost $0.50");

    fireEvent.click(within(offer).getByRole("button", { name: t("costs.relabel.accept", { recorded: "USD", display: "EUR" }) }));
    await waitFor(() => expect(mocks.saveNow).toHaveBeenCalledTimes(1));
    expect(useSettingsStore.getState().settings.costRelabels).toEqual([{ from: "USD", to: "EUR", until: "2026-11-21T10:01:26.000Z" }]);
    await waitFor(() => expect(bandOf().querySelector("[data-relabel-suggestion]")).toBeNull());
    expect(text(usageOf())).toContain("Cost €0.50 (relabelled)");

    unmount();
    render(<Page />);
    expect(bandOf().querySelector("[data-relabel-suggestion]")).toBeNull();
  });

  it("is not offered again on this device once declined, and changes nothing", () => {
    seedRun({ ...RUNNING, activities: [DONE], stats: { cost: 0.5, currency: "USD" } });
    patchSettings({ costCurrency: "EUR" });
    const { unmount } = render(<Page />);
    fireEvent.click(within(bandOf().querySelector<HTMLElement>("[data-relabel-suggestion]")!).getByRole("button", { name: t("costs.relabel.decline", { recorded: "USD" }) }));
    expect(bandOf().querySelector("[data-relabel-suggestion]")).toBeNull();
    expect(useSettingsStore.getState().settings.costRelabels).toBeUndefined();
    expect(mocks.saveNow).not.toHaveBeenCalled();
    unmount();
    render(<Page />);
    expect(bandOf().querySelector("[data-relabel-suggestion]")).toBeNull();
    expect(text(usageOf())).toContain("Cost $0.50");
  });

  it("is not offered when the currencies are the same, or a rate already shows them in the currency of the prices", () => {
    seedRun({ ...RUNNING, activities: [DONE], stats: { cost: 0.5, currency: "USD" } });
    const { unmount } = render(<Page />);
    expect(bandOf().querySelector("[data-relabel-suggestion]")).toBeNull();
    unmount();
    patchSettings({ costCurrency: "EUR", costRates: [{ from: "USD", to: "EUR", rate: 0.9 }] });
    render(<Page />);
    expect(bandOf().querySelector("[data-relabel-suggestion]")).toBeNull();
  });
});

describe("a book whose autopilot runs on the personal server", () => {
  it("says that the cost of the run is the server's summary, and that the month and the book to date count the calls of the browsers", () => {
    mocks.book = SERVER_BOOK;
    seedRun({ ...RUNNING, book: SERVER_BOOK, server: "online", activities: [{ ...DONE, cost: 0.02 }], stats: { cost: 0.5, currency: "USD" } });
    render(<Page />);
    expect(bookCostsOf().querySelector("[data-band-server-costs]")).toHaveTextContent(t("costs.band.serverNote"));
    expect(text(bookCostsOf())).toContain(`${t("costs.band.run")} $0.02 ${t("costs.band.fromServer")}`);
    expect(bandOf().querySelector("[data-server-currency-note]"), "the server prices in the currency of the settings").toBeNull();
  });

  it("says in which currency the server prices when it is not the one of the settings, and sends it the current configuration on request", async () => {
    const putAiConfig = vi.fn(async () => ({ configured: true, updatedAt: "2026-11-21T10:01:26.000Z" }));
    mocks.verified.mockResolvedValue({ client: { aiStatus: vi.fn(async () => ({ configured: true })), putAiConfig }, info: {}, fingerprint: "f" });
    mocks.book = SERVER_BOOK;
    seedRun({ ...RUNNING, book: SERVER_BOOK, server: "online", activities: [DONE], stats: { cost: 0.5, currency: "USD" } });
    patchSettings({ costCurrency: "EUR" });
    render(<Page />);
    const note = bandOf().querySelector<HTMLElement>("[data-server-currency-note]")!;
    expect(note).toHaveTextContent(t("costs.server.recorded", { recorded: "USD", currency: "EUR" }));
    fireEvent.click(within(note).getByRole("button", { name: t("costs.server.send") }));
    await waitFor(() => expect(putAiConfig).toHaveBeenCalledTimes(1));
    expect((putAiConfig.mock.calls[0] as unknown as [{ costCurrency?: string }])[0].costCurrency).toBe("EUR");
    expect(await within(note).findByText(t("costs.server.sent", { currency: "EUR" }))).toBeInTheDocument();
  });

  it("cannot send while the server is not connected, and says so", () => {
    mocks.book = SERVER_BOOK;
    seedRun({ ...RUNNING, book: SERVER_BOOK, server: "offline", activities: [DONE], stats: { cost: 0.5, currency: "USD" } });
    patchSettings({ costCurrency: "EUR" });
    render(<Page />);
    const note = bandOf().querySelector<HTMLElement>("[data-server-currency-note]")!;
    expect(within(note).getByRole("button", { name: t("costs.server.send") })).toBeDisabled();
    expect(note).toHaveTextContent(t("costs.server.offline"));
  });
});

describe("the cost line in Italian", () => {
  it("says the book's costs and the step in Italian", async () => {
    await i18n.changeLanguage("it");
    seedRun({ ...RUNNING, activities: [DONE] });
    act(() => { useTaskCosts.setState({ tasks: { "book-1\u0000live-write": taskRecord("live-write", { money: { USD: 0.0123 }, calls: 3 }) } }); });
    render(<Page />);
    expect(text(usageOf().querySelector("[data-band-step-cost]"))).toBe("(questo passo 0,0123 USD · 3 chiamate)");
    expect(text(bookCostsOf())).toContain("Questa corsa");
    expect(text(bookCostsOf())).toContain("Libro finora");
  });
});
