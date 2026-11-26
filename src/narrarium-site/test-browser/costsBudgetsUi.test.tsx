import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotLimitReached, AutopilotStateSummary } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>, save: vi.fn(async () => true) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/drive/useSettings")>()), saveSettingsNow: () => mocks.save() }));

import i18n from "@/i18n";
import "@/i18n/costs";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { LimitPanel } from "@/components/autopilot/LimitPanel";
import { BudgetNotice } from "@/components/costs/budget/BudgetNotice";
import { CostsIndicator } from "@/components/costs/CostsIndicator";
import { useAutopilotStore } from "@/autopilot/store";
import { appliedCapOf, rememberAppliedCap } from "@/costs/budgetCaps";
import { useCostsStore } from "@/costs/costsStore";
import { addToLedger, ledgerWriterId, localDay, type UsageDelta } from "@/costs/ledger";
import { emptyCostsFile } from "@/costs/model";
import { CostsPage } from "@/pages/CostsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry, type CostBudgets } from "@/types/settings";
import type { AutopilotOptions, AutopilotStats } from "narrarium-engine";
import { LOCAL_BOOK, seedBar } from "./helpers/quickCommands";

const WRITER = ledgerWriterId("device-a", "2026-11-01T00:00:00.000Z");
const today = localDay(new Date());
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const GLASS: BookEntry = { id: "book-1", name: "The Glass Harbor", owner: "acme", repo: "glass-harbor", storageMode: "github", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z" } as BookEntry;
const SERVED: BookEntry = { id: "book-3", name: "The Lighthouse", owner: "", repo: "", storageMode: "local-only", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z", autopilotHost: "server" } as BookEntry;

function spend(rows: Array<{ bookId?: string; cost: number; currency?: string; source?: string }>) {
  const deltas: UsageDelta[] = rows.map((row) => ({ key: { period: today, bookId: row.bookId ?? "book-1", source: row.source ?? "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: row.currency ?? "USD" }, counters: { calls: 1, tasks: 1, cost: row.cost } }));
  const file = { ...emptyCostsFile(), ledger: addToLedger(undefined, WRITER, deltas, new Date(), "USD") };
  useCostsStore.setState({ file, persisted: file });
}

function settings(costBudgets?: CostBudgets, patch: Record<string, unknown> = {}) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "USD", ...(costBudgets ? { costBudgets } : {}), books: [GLASS, SERVED], ...patch } });
}

/** What the autopilot of a book says, as the runtime puts it in the store. */
function autopilot(bookId: string, options: Partial<AutopilotOptions>, stats: Partial<AutopilotStats>) {
  const fullStats = { tasks: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, failures: 0, ...stats } as AutopilotStats;
  const state = { status: "paused", updatedAt: "2026-11-26T10:00:00.000Z", options: { budgetLimit: 0, ...options }, stats: fullStats };
  useAutopilotStore.setState((store) => ({ views: { ...store.views, [bookId]: { snapshot: { bookId, state, summary: { status: "paused", stats: fullStats, updatedAt: state.updatedAt, publish: "chapter" }, activities: [], live: null } } as never } }));
}

const budgetsOf = () => useSettingsStore.getState().settings.costBudgets;
const renderCosts = () => render(<MemoryRouter><CostsPage /></MemoryRouter>);
const panel = () => document.querySelector<HTMLElement>("[data-budgets-panel]")!;
const rowOf = (name: string) => screen.getByRole("rowheader", { name: new RegExp(name) }).closest("tr") as HTMLElement;

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  mocks.save = vi.fn(async () => true);
  mocks.runtime = { start: vi.fn(async () => undefined), allowBudgetOverrun: vi.fn(), refresh: vi.fn(async () => null), describeError: vi.fn((error: unknown) => String(error)) };
  useAutopilotStore.setState({ views: {}, summaries: {} });
  spend([{ cost: 3 }]);
  settings();
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useCostsStore.setState({ file: emptyCostsFile(), persisted: emptyCostsFile() });
});

describe("the budgets in the dashboard", () => {
  it("says there is none and sets the budget of all the books from a form: a limit per month and in total, saved to the settings, shown at once", () => {
    renderCosts();
    expect(within(panel()).getByText(/No budget set/)).toBeInTheDocument();
    fireEvent.click(within(panel()).getByRole("button", { name: "Set a budget" }));
    const form = panel().querySelector<HTMLFormElement>("[data-budget-editor]")!;
    expect(within(form).getByRole("heading", { name: "Budget of all the books" })).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Per month (USD)"), { target: { value: "20" } });
    fireEvent.change(within(form).getByLabelText("In total (USD)"), { target: { value: "1.000,50" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save the budget" }));
    expect(budgetsOf()).toEqual({ global: { USD: { month: 20, total: 1000.5 } } });
    expect(panel().querySelector("[data-budget-editor]"), "the form closes").toBeNull();
    expect(within(panel()).getByText("Budget saved.")).toBeInTheDocument();
    const meters = within(panel()).getAllByRole("meter");
    expect(meters.map((meter) => meter.getAttribute("aria-valuetext"))).toEqual(["$3.00 of $20.00 per month (15%)", "$3.00 of $1,000.50 in total (0%)"]);
    expect(within(panel()).getByRole("button", { name: "Edit budgets" })).toHaveAttribute("aria-expanded", "false");
  });

  it("writes the budget to the account's store as every setting is, and says so when that fails while it still applies on this device", async () => {
    renderCosts();
    fireEvent.click(within(panel()).getByRole("button", { name: "Set a budget" }));
    fireEvent.change(within(panel()).getByLabelText("Per month (USD)"), { target: { value: "20" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Save the budget" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(within(panel()).getByText("Budget saved.")).toBeInTheDocument();
    mocks.save.mockRejectedValueOnce(new Error("offline store full"));
    fireEvent.click(within(panel()).getByRole("button", { name: "Edit budgets" }));
    fireEvent.change(within(panel()).getByLabelText("Per month (USD)"), { target: { value: "30" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Save the budget" }));
    expect(await within(panel()).findByText("It could not be saved to your account: it applies on this device until it is.")).toBeInTheDocument();
    expect(budgetsOf(), "it applies in this browser, so the next start counts it").toEqual({ global: { USD: { month: 30 } } });
  });

  it("checks the amounts as the engine will take them and does not save a form with a problem", () => {
    renderCosts();
    fireEvent.click(within(panel()).getByRole("button", { name: "Set a budget" }));
    const form = panel().querySelector<HTMLFormElement>("[data-budget-editor]")!;
    const month = within(form).getByLabelText("Per month (USD)");
    fireEvent.change(month, { target: { value: "-4" } });
    expect(month).toHaveAttribute("aria-invalid", "true");
    expect(within(form).getByText(/Enter an amount over 0, up to \$1,000,000\.00/)).toBeInTheDocument();
    const save = within(form).getByRole("button", { name: "Remove the budget" });
    expect(save, "nothing valid to save").toBeDisabled();
    fireEvent.change(month, { target: { value: "5000000" } });
    expect(month).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(month, { target: { value: "abc" } });
    expect(month).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(month, { target: { value: "12,5" } });
    expect(month).not.toHaveAttribute("aria-invalid");
    const warn = within(form).getByLabelText("Warn at (%)");
    fireEvent.change(warn, { target: { value: "100" } });
    expect(warn).toHaveAttribute("aria-invalid", "true");
    expect(within(form).getByRole("button", { name: "Save the budget" })).toBeDisabled();
    fireEvent.change(warn, { target: { value: "70" } });
    fireEvent.change(within(form).getByLabelText("What counts"), { target: { value: "autopilot" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save the budget" }));
    expect(budgetsOf()).toEqual({ warnAt: 70, counts: "autopilot", global: { USD: { month: 12.5 } } });
  });

  it("keeps a budget for each currency, adds one, and removes the limits of one", () => {
    settings({ global: { USD: { month: 20 } } });
    renderCosts();
    fireEvent.click(within(panel()).getByRole("button", { name: "Edit budgets" }));
    const form = panel().querySelector<HTMLFormElement>("[data-budget-editor]")!;
    fireEvent.change(within(form).getByLabelText("Another currency"), { target: { value: "eur" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    fireEvent.change(within(form).getByLabelText("In total (EUR)"), { target: { value: "50" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save the budget" }));
    expect(budgetsOf()).toEqual({ global: { EUR: { total: 50 }, USD: { month: 20 } } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Edit budgets" }));
    fireEvent.click(within(panel().querySelector<HTMLFormElement>("[data-budget-editor]")!).getByRole("button", { name: "Remove the limits in USD" }));
    fireEvent.click(within(panel().querySelector<HTMLFormElement>("[data-budget-editor]")!).getByRole("button", { name: "Save the budget" }));
    expect(budgetsOf()).toEqual({ global: { EUR: { total: 50 } } });
  });

  it("warns in words at the share, with the budget and its figures, not only by the colour of the bar", () => {
    settings({ global: { USD: { month: 3.5 } } });
    renderCosts();
    const notice = panel().querySelector<HTMLElement>("[data-budget-notice]")!;
    expect(notice).toHaveAttribute("data-budget-notice", "warn");
    expect(notice).toHaveTextContent("Budget warning. All books, per month: $3.00 of $3.50 (86%)");
    expect(panel().querySelector("[data-budget-notices]")).toHaveAttribute("role", "status");
    const meter = within(panel()).getByRole("meter", { name: "Budget of All books" });
    expect(meter).toHaveAttribute("aria-valuetext", "$3.00 of $3.50 per month (86%) — Warning");
    expect(within(notice).queryByRole("button", { name: /Raise it/ }), "a warning has nothing to raise yet").toBeNull();
  });

  it("says «Over budget» at the limit and raises it with one click to a limit that leaves room", () => {
    settings({ global: { USD: { month: 3 } } });
    renderCosts();
    const notice = panel().querySelector<HTMLElement>("[data-budget-notice]")!;
    expect(notice).toHaveAttribute("data-budget-notice", "over");
    expect(notice).toHaveTextContent("Over budget. All books, per month: $3.00 of $3.00 (100%)");
    fireEvent.click(within(notice).getByRole("button", { name: "Raise it to $4.50" }));
    expect(budgetsOf()).toEqual({ global: { USD: { month: 4.5 } } });
    expect(panel().querySelector("[data-budget-notice]"), "no longer over").toBeNull();
    expect(panel().querySelector("[data-budget-raised]")).toHaveTextContent("Raised: the per month budget of All books is now $4.50.");
  });

  it("puts the budget of a book in its row, with its own meter, and sets it from the settings of the book", () => {
    autopilot("book-1", { budgetLimit: 0 }, {});
    renderCosts();
    const row = rowOf("The Glass Harbor");
    expect(within(row).getByText("No budget")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: /The Glass Harbor/ }));
    const settingsRow = row.nextElementSibling as HTMLElement;
    fireEvent.click(within(settingsRow).getByRole("button", { name: "Set a budget for this book" }));
    const form = settingsRow.querySelector<HTMLFormElement>("[data-budget-editor]")!;
    expect(within(form).getByRole("heading", { name: "Budget of The Glass Harbor" })).toBeInTheDocument();
    expect(within(form).queryByLabelText("Warn at (%)"), "the share is of all the budgets").toBeNull();
    fireEvent.change(within(form).getByLabelText("In total (USD)"), { target: { value: "3.5" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save the budget" }));
    expect(budgetsOf()).toEqual({ books: { "book-1": { USD: { total: 3.5 } } } });
    const after = rowOf("The Glass Harbor");
    const meter = within(after).getByRole("meter", { name: "Budget of The Glass Harbor" });
    expect(meter).toHaveAttribute("aria-valuetext", "$3.00 of $3.50 in total (86%) — Warning");
    expect(within(after).getByText(/86% of \$3\.50 in total · Warning/)).toBeInTheDocument();
    expect(words(settingsRow)).toContain("Budget $3.50 in total");
    expect(screen.getByText("Budget saved.")).toBeInTheDocument();
  });

  it("keeps the autopilot's own cap beside the budget of the book, and the budget of all the books out of its row", () => {
    settings({ global: { USD: { month: 100 } }, books: { "book-1": { USD: { total: 10 } } } });
    renderCosts();
    expect(within(rowOf("The Glass Harbor")).getByRole("meter", { name: "Budget of The Glass Harbor" })).toHaveAttribute("aria-valuetext", "$3.00 of $10.00 in total (30%)");
    expect(panel()).toHaveTextContent("1 book has a budget of its own: it is in its row.");
    expect(within(panel()).getAllByRole("meter"), "the panel holds the budget of all the books").toHaveLength(1);
  });

  it("says what is not counted for want of an exchange rate, and that a budget with no rate cannot stop the autopilot", () => {
    spend([{ cost: 3 }, { cost: 40, currency: "JPY" }]);
    settings({ global: { USD: { total: 10 }, GBP: { total: 5 } } });
    renderCosts();
    expect(panel().querySelector("[data-budget-notes] summary")).toHaveTextContent("Notes on how it is counted (4)");
    const uncounted = panel().querySelector<HTMLElement>("[data-budget-uncounted]")!;
    expect(uncounted).toHaveTextContent("All books, in total (USD): not counted, for want of an exchange rate: ¥40.00.");
    expect(uncounted).toHaveTextContent("All books, in total (GBP): not counted, for want of an exchange rate: $3.00, ¥40.00.");
    expect(panel().querySelector("[data-budget-unlimited]")).toHaveTextContent("A budget in GBP cannot stop the autopilot, whose runs are priced in USD, without an exchange rate.");
    act(() => useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, costRates: [{ from: "JPY", to: "USD", rate: 0.1 }, { from: "GBP", to: "USD", rate: 1.3 }, { from: "JPY", to: "GBP", rate: 0.08 }] } }));
    expect(panel().querySelector("[data-budget-uncounted]")).toBeNull();
    expect(panel().querySelector("[data-budget-unlimited]")).toBeNull();
    expect(within(panel()).getAllByRole("meter").map((meter) => meter.getAttribute("aria-valuetext")).find((text) => text?.includes("of $10.00"))).toBe("$7.00 of $10.00 in total (70%)");
  });

  it("says that a book on the personal server counts by the server's summary in the total budgets, and that a month counts what this browser recorded", () => {
    settings({ global: { USD: { total: 100 } } });
    renderCosts();
    expect(panel().querySelector("[data-budget-notes] summary")).toHaveTextContent("Notes on how it is counted (1)");
    expect(panel().querySelector("[data-budget-server]")).toHaveTextContent(/monthly budget counts only what this browser recorded/);
  });

  it("is written in Italian", async () => {
    await i18n.changeLanguage("it");
    settings({ global: { USD: { month: 3 } } });
    renderCosts();
    const notice = panel().querySelector<HTMLElement>("[data-budget-notice]")!;
    expect(notice).toHaveTextContent("Budget superato. Tutti i libri, al mese:");
    expect(within(notice).getByRole("button", { name: /Alzalo a/ })).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "Modifica i budget" })).toBeInTheDocument();
  });
});

/** The text of an element as it reads: its elements apart, as the gaps of the layout set them. */
const spaced = (node: Node): string => (node.nodeType === Node.TEXT_NODE ? node.textContent ?? "" : [...node.childNodes].map((child) => (child.nodeType === Node.ELEMENT_NODE ? ` ${spaced(child)} ` : spaced(child))).join(""));
function words(element: Element) {
  return spaced(element).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

describe("the budget in the top bar", () => {
  const show = () => render(<MemoryRouter><CostsIndicator /></MemoryRouter>);

  it("says nothing of the budget while it is under the share it warns at", () => {
    settings({ global: { USD: { month: 100 } } });
    show();
    expect(document.querySelector("[data-costs-budget]")).toBeNull();
  });

  it("says it, with a sign, the share and, for a screen reader, which budget, when one is at the share or over it", () => {
    settings({ global: { USD: { month: 3.5 } } });
    show();
    const mark = document.querySelector<HTMLElement>("[data-costs-budget]")!;
    expect(mark).toHaveAttribute("data-costs-budget", "warn");
    expect(mark).toHaveTextContent("86%");
    expect(mark).toHaveTextContent("Warning — All books, per month: 86% of the budget used");
    expect(document.querySelector("[data-costs-indicator]")).toHaveAttribute("title", expect.stringContaining("Warning — All books, per month"));
    act(() => settings({ global: { USD: { month: 3 } } }));
    expect(document.querySelector("[data-costs-budget]")).toHaveAttribute("data-costs-budget", "over");
  });

  it("is there even when nothing was spent this month if a budget is over, and follows each new record", () => {
    settings({ global: { USD: { total: 3 } } });
    spend([{ cost: 3 }]);
    show();
    expect(document.querySelector("[data-costs-budget]")).toHaveAttribute("data-costs-budget", "over");
    act(() => spend([{ cost: 1 }]));
    expect(document.querySelector("[data-costs-budget]")).toBeNull();
  });
});

describe("the budget in the Autopilot of a book", () => {
  it("warns in a notice with the way to the budgets, and leaves it to the panel of the stop when the autopilot is stopped", () => {
    settings({ books: { "book-1": { USD: { total: 3.5 } } } });
    const { rerender } = render(<MemoryRouter><BudgetNotice bookId="book-1" bookName="The Glass Harbor" /></MemoryRouter>);
    const notice = document.querySelector<HTMLElement>("[data-budget-book-notice]")!;
    expect(notice).toHaveTextContent("Budget warning. The Glass Harbor, in total: $3.00 of $3.50 (86%).");
    expect(within(notice).getByRole("link", { name: "Open the budgets" })).toHaveAttribute("href", "/app/costs");
    rerender(<MemoryRouter><BudgetNotice bookId="book-1" bookName="The Glass Harbor" hidden /></MemoryRouter>);
    expect(document.querySelector("[data-budget-book-notice]")).toBeNull();
    rerender(<MemoryRouter><BudgetNotice bookId="book-2" bookName="Other" /></MemoryRouter>);
    expect(document.querySelector("[data-budget-book-notice]"), "the budget of another book").toBeNull();
  });
});

describe("the panel of a stop at the cap the budgets gave", () => {
  const AT = "2026-11-26T10:00:00.000Z";
  const STOP: AutopilotLimitReached = { kind: "money", used: 5.5, limit: 5.5, currency: "USD", at: AT };

  function stopped(limit: AutopilotLimitReached = STOP, budgets?: CostBudgets) {
    const { summary } = seedBar({ status: "paused" });
    // The book of the bar is the only one in the settings it seeds: the budgets are set after it.
    settings(budgets, { books: [LOCAL_BOOK] });
    const full = { ...(summary as AutopilotStateSummary), limitReached: limit };
    return render(<MemoryRouter><LimitPanel bookId={LOCAL_BOOK.id} summary={full} /></MemoryRouter>);
  }
  const marker = (applied: number) => ({ applied, own: 0, binding: { scope: "global" as const, bookId: "", period: "month" as const, currency: "USD", limit: 5 } });

  it("names the budget that stopped it, and raises that budget and starts the autopilot again with one click", async () => {
    spend([{ cost: 3, bookId: LOCAL_BOOK.id }, { cost: 2, bookId: "book-2", source: "copilot" }]);
    rememberAppliedCap(LOCAL_BOOK.id, marker(5.5));
    stopped(STOP, { global: { USD: { month: 5 } } });
    const region = screen.getByRole("region", { name: "The budget stopped the autopilot" });
    expect(region).toHaveAttribute("data-limit-panel", "budget");
    expect(region).toHaveTextContent("All books, per month: $5.00 of $5.00 are used. The autopilot paused before its next step.");
    const field = within(region).getByLabelText("New monthly limit (USD)");
    expect(field).toHaveValue("7.5");
    fireEvent.click(within(region).getByRole("button", { name: "Raise the budget to $7.50 and continue" }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith(LOCAL_BOOK.id, {}));
    expect(budgetsOf()).toEqual({ global: { USD: { month: 7.5 } } });
    expect(mocks.runtime.allowBudgetOverrun).not.toHaveBeenCalled();
  });

  it("refuses a new limit that does not leave room, or the autopilot would stop again at once", () => {
    spend([{ cost: 5 }]);
    rememberAppliedCap(LOCAL_BOOK.id, marker(5.5));
    stopped(STOP, { global: { USD: { month: 5 } } });
    const region = screen.getByRole("region", { name: "The budget stopped the autopilot" });
    const field = within(region).getByLabelText("New monthly limit (USD)");
    fireEvent.change(field, { target: { value: "4" } });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(region).toHaveTextContent("The new limit must be over what is spent ($5.00)");
    expect(within(region).getByRole("button", { name: /Raise the budget to/ })).toBeDisabled();
  });

  it("goes on anyway with one click, once, past the budgets, and changes no budget", async () => {
    spend([{ cost: 5 }]);
    rememberAppliedCap(LOCAL_BOOK.id, marker(5.5));
    stopped(STOP, { global: { USD: { month: 5 } } });
    fireEvent.click(within(screen.getByRole("region", { name: "The budget stopped the autopilot" })).getByRole("button", { name: "Continue anyway" }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith(LOCAL_BOOK.id, {}));
    expect(mocks.runtime.allowBudgetOverrun).toHaveBeenCalledWith(LOCAL_BOOK.id);
    expect(budgetsOf()).toEqual({ global: { USD: { month: 5 } } });
    expect(appliedCapOf(LOCAL_BOOK.id), "what the budgets did is for the start to decide").not.toBeNull();
  });

  it("leaves a stop at the cap of the person's own to the panel of the cap, and a stop whose budget is gone too", () => {
    spend([{ cost: 5 }]);
    stopped(STOP, { global: { USD: { month: 5 } } });
    expect(screen.getByRole("region", { name: "The money cap stopped the autopilot" })).toBeInTheDocument();
    cleanup();
    rememberAppliedCap(LOCAL_BOOK.id, marker(5.5));
    stopped(STOP, undefined);
    expect(screen.getByRole("region", { name: "The money cap stopped the autopilot" })).toBeInTheDocument();
  });
});
