import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ refresh: vi.fn(async () => null) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => runtime }));

import i18n from "@/i18n";
import "@/i18n/costs";
import type { AutopilotOptions, AutopilotStats } from "narrarium-engine";
import { useAutopilotStore } from "@/autopilot/store";
import { useCostsStore } from "@/costs/costsStore";
import { addToLedger, ledgerWriterId, localDay, type UsageDelta } from "@/costs/ledger";
import { addToLegacy, coveredPart } from "@/costs/legacyCosts";
import { emptyBucket, emptyCostsFile, type CostsFile } from "@/costs/model";
import { CostsPage } from "@/pages/CostsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type BookEntry, type CostExchangeRate } from "@/types/settings";

const WRITER = ledgerWriterId("device-a", "2026-11-01T00:00:00.000Z");
const today = localDay(new Date());
const lastYear = `${new Date().getFullYear() - 1}-03`;
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const GLASS: BookEntry = { id: "book-1", name: "The Glass Harbor", owner: "acme", repo: "glass-harbor", storageMode: "github", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z" } as BookEntry;
const SERVED: BookEntry = { id: "book-3", name: "The Lighthouse", owner: "", repo: "", storageMode: "local-only", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z", autopilotHost: "server" } as BookEntry;
const PROXY = { id: "int-1", name: "LlmProxy", provider: "openai", endpoint: "https://proxy.example.test/v1", apiKey: "k", chatModels: [] } as unknown as AIIntegration;

function costs(): CostsFile {
  const deltas: UsageDelta[] = [
    { key: { period: today, bookId: "book-1", source: "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: "EUR" }, counters: { calls: 4, tasks: 2, inputTokens: 4000, outputTokens: 900, cost: 0.12 } },
    { key: { period: today, bookId: "book-1", source: "copilot", capability: "brainstorming", integrationId: "int-1", model: "gpt-5", currency: "USD" }, counters: { calls: 1, tasks: 1, inputTokens: 500, outputTokens: 80, cost: 0.16 } },
    { key: { period: today, bookId: "book-1", source: "autopilot", capability: "director", integrationId: "int-2", model: "free-model", currency: "" }, counters: { calls: 3, tasks: 0, inputTokens: 900, unpricedCalls: 3 } },
    { key: { period: lastYear, bookId: "book-2", source: "research", capability: "deep-research", integrationId: "int-1", model: "gpt-5", currency: "EUR" }, counters: { calls: 2, tasks: 1, cost: 1 } },
  ];
  let file: CostsFile = { ...emptyCostsFile(), books: { "book-1": { ...emptyBucket(), bookId: "book-1", bookName: "The Glass Harbor", chatCost: 2 } } };
  for (const delta of deltas) {
    file = { ...file, ledger: addToLedger(file.ledger, WRITER, [delta], new Date(), "EUR") };
    file = addToLegacy(file, delta.key.bookId, undefined, coveredPart({ ...delta.key, ...delta.counters }));
  }
  return file;
}

function setSettings(costCurrency: string, costRates?: CostExchangeRate[]) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency, ...(costRates ? { costRates } : {}), aiIntegrations: [PROXY], books: [GLASS, SERVED] } });
}

function wide(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: on && query.includes("min-width"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

/** What the autopilot of a book says, as the runtime puts it in the store. */
function autopilot(bookId: string, options: Partial<AutopilotOptions>, stats: Partial<AutopilotStats>, status: "paused" | "running" = "paused") {
  const fullStats = { tasks: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, failures: 0, ...stats } as AutopilotStats;
  const state = { status, updatedAt: "2026-11-26T10:00:00.000Z", options: { budgetLimit: 0, ...options }, stats: fullStats };
  useAutopilotStore.setState((store) => ({ views: { ...store.views, [bookId]: { snapshot: { bookId, state, summary: { status, stats: fullStats, updatedAt: state.updatedAt, publish: "chapter" }, activities: [], live: null, running: false, host: null } } as never } }));
}

/** The limit that stopped the autopilot of a book, in its saved state and in its summary, as the engine writes it. */
function stoppedBy(bookId: string, limit: { kind: "money" | "tokens" | "review-rounds"; used: number; limit: number; currency?: string }) {
  const reached = { ...limit, at: "2026-11-26T10:00:00.000Z" };
  act(() => useAutopilotStore.setState((store) => {
    const snapshot = (store.views[bookId] as unknown as { snapshot: { state: object; summary: object } }).snapshot;
    return { views: { ...store.views, [bookId]: { snapshot: { ...snapshot, state: { ...snapshot.state, limitReached: reached }, summary: { ...snapshot.summary, limitReached: reached } } } as never } };
  }));
}

const renderCosts = () => render(<MemoryRouter><CostsPage /></MemoryRouter>);
const table = () => screen.getByRole("table");
const rowOf = (name: string) => screen.getByRole("rowheader", { name: new RegExp(name) }).closest("tr") as HTMLElement;
const totals = () => document.querySelector<HTMLElement>("[data-costs-totals]")!;
/** The text of a part of the page as it reads: its elements apart, as the gaps of the layout set them. */
const spaced = (node: Node): string => (node.nodeType === Node.TEXT_NODE ? node.textContent ?? "" : [...node.childNodes].map((child) => (child.nodeType === Node.ELEMENT_NODE ? ` ${spaced(child)} ` : spaced(child))).join(""));
const words = (element: Element) => spaced(element).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  const file = costs();
  useCostsStore.setState({ file, persisted: file });
  setSettings("EUR");
  useAutopilotStore.setState({ views: {}, summaries: {} });
  wide(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the dashboard of the costs: one dense table", () => {
  it("has a row for each book with its spend by currency (never added), its tasks, calls and tokens, a trend and its budget, in a real table", () => {
    renderCosts();
    expect(table()).toHaveAccessibleName(t("costs.dashboard.table.caption", { rows: "books", period: "this month" }));
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Book", "Spend", "Tasks", "Calls", "Tokens", "Trend", "Budget"]);
    const glass = rowOf("The Glass Harbor");
    expect(words(within(glass).getAllByRole("cell")[0])).toContain("€0.12 + $0.16");
    expect(within(glass).getAllByRole("cell").slice(1, 4).map(words)).toEqual(["3", "8", "6.4K"]);
    expect(words(glass)).toContain("3 calls without a price");
    expect(within(glass).getByRole("img", { name: /Spend of the last six months: .*€0\.12 \+ \$0\.16/ })).toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: /book-2/ }), "a book that spent nothing this month has no row this month").toBeNull();
  });

  it("sorts by the header of a column, saying how with aria-sort", () => {
    renderCosts();
    const spend = screen.getByRole("columnheader", { name: "Spend" });
    expect(spend).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: "Book" })).toHaveAttribute("aria-sort", "none");
    fireEvent.click(within(spend).getByRole("button", { name: "Spend" }));
    expect(spend).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(within(screen.getByRole("columnheader", { name: "Book" })).getByRole("button", { name: "Book" }));
    expect(screen.getByRole("columnheader", { name: "Book" })).toHaveAttribute("aria-sort", "ascending");
    expect(spend).toHaveAttribute("aria-sort", "none");
  });

  it("switches its rows to the months (the «earlier» part apart) and to the uses", () => {
    renderCosts();
    choose(t("costs.dashboard.filters.period"), "all");
    fireEvent.click(screen.getByRole("radio", { name: "Months" }));
    expect(screen.getAllByRole("columnheader")[0]).toHaveTextContent("Month");
    const names = screen.getAllByRole("rowheader").map(words);
    expect(names[0], "the newest month first").toBe(new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(new Date()));
    expect(names[names.length - 1], "the part before the ledger last").toBe("Earlier");
    const months = names.slice(0, -1).map((name) => Date.parse(`1 ${name}`));
    expect(months, "by date, not by name").toEqual([...months].sort((left, right) => right - left));
    expect(screen.getAllByRole("img", { name: /^Spend of the last six months/ }).length, "every month has its trend, a compacted one too").toBe(names.length - 1);
    expect(screen.queryByRole("columnheader", { name: "Budget" }), "a budget is a book's").toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Uses" }));
    expect(screen.getAllByRole("rowheader").map(words)).toEqual(expect.arrayContaining(["Autopilot", "Copilot", "Research", "Other uses"]));
  });
});

describe("the filters and the totals of the dashboard", () => {
  it("keeps the totals in sight, by currency, with the calls it cannot price, and says what the filters kept", async () => {
    renderCosts();
    expect(words(totals())).toContain("Spend €0.12 + $0.16");
    expect(words(totals())).toContain("Tasks 3");
    expect(words(totals())).toContain("3 calls without a price");
    choose(t("costs.dashboard.filters.source"), "copilot");
    expect(words(totals())).toContain("Spend $0.16");
    await waitFor(() => expect(screen.getByText("1 row · spend $0.16")).toBeInTheDocument());
    expect(screen.getByText("1 row · spend $0.16")).toHaveAttribute("role", "status");
  });

  it("filters by the task, Brainstorming among them, by the model, the integration, the currency and the period", () => {
    renderCosts();
    const task = screen.getByLabelText(t("costs.dashboard.filters.capability")) as HTMLSelectElement;
    expect([...task.options].map((option) => option.textContent), "what the rows have, whatever the period").toEqual(["All", "Autopilot", "Brainstorming", "Deep Research", "Director"]);
    choose(t("costs.dashboard.filters.capability"), "brainstorming");
    expect(words(totals())).toContain("Spend $0.16");
    choose(t("costs.dashboard.filters.capability"), "");
    choose(t("costs.dashboard.filters.currency"), "EUR");
    expect(words(totals())).toContain("Spend €0.12");
    choose(t("costs.dashboard.filters.currency"), "");
    choose(t("costs.dashboard.filters.model"), "free-model");
    expect(words(totals())).toContain("Spend —");
    expect(words(totals())).toContain("3 calls without a price");
    fireEvent.click(screen.getByRole("button", { name: /Clear the filters/ }));
    choose(t("costs.dashboard.filters.period"), "all");
    expect(words(totals())).toContain("Spend €3.12 + $0.16");
    expect(rowOf("book-2")).toBeInTheDocument();
    choose(t("costs.dashboard.filters.period"), "custom");
    fireEvent.change(screen.getByLabelText(t("costs.dashboard.filters.from")), { target: { value: `${lastYear}-01` } });
    fireEvent.change(screen.getByLabelText(t("costs.dashboard.filters.to")), { target: { value: `${lastYear}-28` } });
    expect(words(totals())).toContain("Spend €1.00");
  });

  it("converts at a rate of the settings, says so, and never adds a currency without one", () => {
    renderCosts();
    act(() => setSettings("EUR", [{ from: "USD", to: "EUR", rate: 0.5 }]));
    expect(words(totals())).toContain("≈ €0.20");
    expect(within(totals()).getByText(/converted at 1 USD = 0.5 EUR/)).toBeInTheDocument();
    act(() => setSettings("GBP"));
    expect(words(totals())).toContain("€0.12 + $0.16");
  });
});

describe("a book in the dashboard", () => {
  it("opens the settings of the book at a glance: GitHub, where it runs, its autopilot, its models, retry, resume, the calls kept, its budget", () => {
    autopilot("book-1", { budgetLimit: 5, longRetry: { everyMinutes: 30, cycles: 3 } }, { cost: 2, currency: "USD" });
    renderCosts();
    const open = within(rowOf("The Glass Harbor")).getByRole("button", { name: "The Glass Harbor — settings" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    const settings = document.getElementById(open.getAttribute("aria-controls")!)!;
    const text = words(settings);
    expect(text).toContain("GitHub acme/glass-harbor");
    expect(text).toContain("Runs in this browser");
    expect(text).toContain("Autopilot paused · publishes after every chapter");
    expect(text).toContain("Models gpt-5 (LlmProxy), free-model (int-2)");
    expect(text).toContain("Retry later every 30 min, 3 times");
    expect(text).toContain("Resume after a restart on");
    expect(text).toContain("Calls kept on this device on");
    expect(text).toContain("Budget $5.00");
    expect(within(settings).getByRole("link", { name: "Open the autopilot" })).toHaveAttribute("href", "/app/books/book-1/autopilot");
  });

  it("shows the budget of the autopilot, read-only, as a meter of what its own count spent", () => {
    autopilot("book-1", { budgetLimit: 5 }, { cost: 4.5, currency: "USD" });
    renderCosts();
    const meter = within(rowOf("The Glass Harbor")).getByRole("meter", { name: "Budget of the autopilot of The Glass Harbor" });
    expect(meter).toHaveAttribute("aria-valuenow", "90");
    expect(meter).toHaveAttribute("aria-valuetext", "$4.50 of $5.00 (90%)");
  });

  it("says the cap stopped the autopilot, with the numbers the engine compared at the stop and not a recount", () => {
    autopilot("book-1", { budgetLimit: 5 }, { cost: 4.4, currency: "USD" });
    stoppedBy("book-1", { kind: "money", used: 5.02, limit: 5, currency: "USD" });
    renderCosts();
    const row = rowOf("The Glass Harbor");
    const meter = within(row).getByRole("meter", { name: "Budget of the autopilot of The Glass Harbor" });
    expect(meter).toHaveAttribute("aria-valuenow", "100");
    expect(meter).toHaveAttribute("aria-valuetext", "$5.02 of $5.00 · stopped (100%)");
    expect(row.querySelector("[data-budget-stopped]")).not.toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "The Glass Harbor — settings" }));
    expect(words(document.querySelector("[data-book-settings]")!)).toContain("Autopilot paused · money cap reached · publishes after every chapter");
  });

  it("does not take the rounds of a review for a budget, and a token cap that stopped the run shows its numbers", () => {
    autopilot("book-1", { budgetLimit: 5 }, { cost: 2, currency: "USD" });
    stoppedBy("book-1", { kind: "review-rounds", used: 3, limit: 3 });
    renderCosts();
    const meter = within(rowOf("The Glass Harbor")).getByRole("meter", { name: "Budget of the autopilot of The Glass Harbor" });
    expect(meter, "the money cap has not been reached: the rounds were").toHaveAttribute("aria-valuetext", "$2.00 of $5.00 (40%)");
    cleanup();
    autopilot("book-1", { budgetLimit: 0, budgetTokens: 500_000 }, { inputTokens: 300_000, outputTokens: 100_000 });
    stoppedBy("book-1", { kind: "tokens", used: 501_200, limit: 500_000 });
    renderCosts();
    expect(within(rowOf("The Glass Harbor")).getByRole("meter")).toHaveAttribute("aria-valuetext", "501.2K of 500K tokens · stopped (100%)");
  });

  it("says «No budget» without one, and that it is being read before it is known", () => {
    renderCosts();
    expect(within(rowOf("The Glass Harbor")).getByText(t("costs.dashboard.budget.notReadLabel"))).toBeInTheDocument();
    act(() => autopilot("book-1", {}, {}));
    expect(within(rowOf("The Glass Harbor")).getByText("No budget")).toBeInTheDocument();
  });

  it("says «Not available» for a book whose autopilot could not be read, and not that it is still being read", async () => {
    runtime.refresh.mockRejectedValueOnce(new Error("The server does not answer."));
    renderCosts();
    await waitFor(() => expect(within(rowOf("The Glass Harbor")).getByText("Not available")).toBeInTheDocument());
    expect(within(rowOf("The Glass Harbor")).queryByText(t("costs.dashboard.budget.notReadLabel"))).toBeNull();
    fireEvent.click(within(rowOf("The Glass Harbor")).getByRole("button", { name: "The Glass Harbor — settings" }));
    expect(words(document.querySelector("[data-book-settings]")!)).toContain("Autopilot Not available");
  });

  it("reads the autopilot of every book the way the Autopilot page does", async () => {
    renderCosts();
    await waitFor(() => expect(runtime.refresh).toHaveBeenCalledWith("book-1", { join: true }));
    expect(runtime.refresh).toHaveBeenCalledWith("book-3", { join: true });
  });

  it("tells apart what the personal server counts of a book that runs there, never adding it to the totals", () => {
    const deltas: UsageDelta[] = [{ key: { period: today, bookId: "book-3", source: "copilot", capability: "copilot", integrationId: "int-1", model: "gpt-5", currency: "EUR" }, counters: { calls: 1, tasks: 1, cost: 0.01 } }];
    const file = { ...costs(), ledger: addToLedger(costs().ledger, WRITER, deltas, new Date(), "EUR") };
    useCostsStore.setState({ file, persisted: file });
    autopilot("book-3", {}, { cost: 0.5, currency: "USD", aiCalls: 3, inputTokens: 1000, outputTokens: 200 }, "running");
    renderCosts();
    expect(words(rowOf("The Lighthouse"))).toContain("Personal server: $0.50 · 3 calls · 1.2K tokens, from the server's summary, not in the totals");
    expect(words(totals())).toContain("Spend €0.13 + $0.16");
    const line = document.querySelector("[data-server-totals]");
    expect(line).toHaveTextContent("On your server: $0.50 over all the runs of 1 book, from the server's own count. It is not split by month, so it is not added to the totals above.");
    expect(line).toHaveTextContent("Included: the autopilot's calls of the books that run on your server. Not included: what your browsers recorded");
  });
});

describe("the CSV of the dashboard", () => {
  it("exports the rows the filters keep, as recorded, and says it is downloaded", async () => {
    const created: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (blob: Blob) => { created.push(blob); return "blob:costs"; }, revokeObjectURL: () => undefined }));
    renderCosts();
    choose(t("costs.dashboard.filters.capability"), "brainstorming");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(created).toHaveLength(1);
    const text = await created[0].text();
    expect(text.split("\r\n")[0]).toMatch(/^period,book,source,capability,/);
    expect(text).toContain(`${today},The Glass Harbor,copilot,brainstorming,LlmProxy,gpt-5,USD,1,1,500,0,80,0.16`);
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(2);
    expect(screen.getByText(t("costs.dashboard.exported"))).toBeInTheDocument();
  });
});

describe("the dashboard on a phone, and in Italian", () => {
  it("stacks the rows as cards, with the same figures and a way to sort them", () => {
    wide(false);
    renderCosts();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByLabelText(t("costs.dashboard.table.sortLabel")), "one row has no order to choose").toBeNull();
    choose(t("costs.dashboard.filters.period"), "all");
    const cards = screen.getByRole("list", { name: t("costs.dashboard.table.caption", { rows: "books", period: "all time" }) });
    const card = within(cards).getAllByRole("listitem")[0];
    expect(words(card)).toContain("The Glass Harbor");
    expect(words(card)).toContain("€0.12 + $0.16");
    expect(screen.getByLabelText(t("costs.dashboard.table.sortLabel"))).toBeInTheDocument();
  });

  it("says it all in Italian", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    renderCosts();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Libro", "Spesa", "Compiti", "Chiamate", "Token", "Andamento", "Budget"]);
    expect(words(totals())).toContain("3 chiamate senza prezzo");
    expect(screen.getByRole("radio", { name: "Mesi" })).toBeInTheDocument();
  });

  it("says when nothing was recorded at all, and when the filters keep nothing", () => {
    useCostsStore.setState({ file: emptyCostsFile(), persisted: emptyCostsFile() });
    renderCosts();
    expect(screen.getByText(t("costs.empty"))).toBeInTheDocument();
  });
});

describe("the room the page really has", () => {
  const widthOf = (pixels: number) => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: pixels, height: 100, x: 0, y: 0, top: 0, left: 0, right: pixels, bottom: 100, toJSON: () => ({}) } as DOMRect);

  it("shows the table where the page has room for its columns, even on a small window, and cards where it has not, even on a wide one", () => {
    wide(true);
    const narrow = widthOf(700);
    const first = renderCosts();
    expect(screen.queryByRole("table"), "a wide screen with a page of 700 px (a tablet upright, a laptop with the dossier open)").toBeNull();
    expect(screen.queryByRole("button", { name: "More filters" }), "the filters fold only below 600 px").toBeNull();
    first.unmount();
    narrow.mockRestore();
    wide(false);
    widthOf(900);
    renderCosts();
    expect(screen.getByRole("table"), "a small window whose page has 900 px").toBeInTheDocument();
  });

  it("keeps the filters in one row from 600 px and folds them below", () => {
    wide(true);
    const at = widthOf(650);
    const view = renderCosts();
    expect(screen.queryByRole("button", { name: "More filters" })).toBeNull();
    expect(screen.queryByRole("table"), "cards, with the filters all in sight").toBeNull();
    view.unmount();
    at.mockRestore();
    widthOf(500);
    renderCosts();
    expect(screen.getByRole("button", { name: "More filters" })).toBeInTheDocument();
  });
});

describe("the filters on a phone", () => {
  it("keeps only the period in sight and opens the others with «More filters», saying how many are set", () => {
    wide(false);
    renderCosts();
    const more = screen.getByRole("button", { name: "More filters" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText(t("costs.dashboard.filters.period"))).toBeVisible();
    const book = document.getElementById(more.getAttribute("aria-controls")!)!;
    expect(book).toHaveClass("hidden");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(book).not.toHaveClass("hidden");
    choose(t("costs.dashboard.filters.capability"), "brainstorming");
    expect(screen.getByRole("button", { name: "More filters · 1 filter" })).toBeInTheDocument();
    expect(words(totals())).toContain("Spend $0.16");
  });

  it("does not stick the totals to the top of a phone, where they would cover the rows", () => {
    wide(false);
    renderCosts();
    expect(totals().className).toContain("sm:sticky");
    expect(totals().className).not.toMatch(/(^|\s)sticky(\s|$)/);
  });
});

describe("the trend of a row that spent in a currency without a rate", () => {
  it("still has a shape, drawn by its own figures, and says every amount in its own currency", () => {
    renderCosts();
    choose(t("costs.dashboard.filters.currency"), "USD");
    fireEvent.click(screen.getByRole("radio", { name: "Uses" }));
    const spark = within(table()).getAllByRole("img", { name: /Spend of the last six months/ })[0];
    expect(spark.getAttribute("aria-label")).toMatch(/\$0\.16/);
    const bars = [...spark.querySelectorAll("rect")];
    expect(bars.some((bar) => Number(bar.getAttribute("height")) > 0), "a bar for the month that spent").toBe(true);
  });
});
