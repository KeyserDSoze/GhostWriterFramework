import { describe, expect, it } from "vitest";
import { ALL, activeFilters, buildGroups, csvCell, defaultFilters, filterRows, groupKey, inPeriod, matches, optionsOf, periodRange, sortGroups, toCsv, trendOf, type DashboardFilters } from "@/costs/dashboardModel";
import { USAGE_SOURCES, emptyCounters, type UsageRow } from "@/costs/ledger";
import { EARLIER } from "@/costs/legacyCosts";
import type { MoneyContext } from "@/costs/money";
import { cpuMs } from "./helpers/cpuTime";

const TODAY = "2026-11-26";
const EUR: MoneyContext = { display: "EUR", rates: [], relabels: [], locale: "en" };

const row = (patch: Partial<UsageRow>): UsageRow => ({ ...emptyCounters(), period: TODAY, bookId: "book-1", source: "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: "EUR", writer: "device@1", ...patch });
const filters = (patch: Partial<DashboardFilters>): DashboardFilters => ({ ...defaultFilters(), ...patch });

describe("the period of the dashboard", () => {
  it("covers this month, the last 30 days, a range of days whichever way it is given, or every row", () => {
    expect(periodRange({ kind: "month" }, TODAY)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(periodRange({ kind: "30d" }, TODAY)).toEqual({ from: "2026-10-28", to: TODAY });
    expect(periodRange({ kind: "custom", from: "2026-11-20", to: "2026-11-02" }, TODAY)).toEqual({ from: "2026-11-02", to: "2026-11-20" });
    expect(periodRange({ kind: "custom", from: "", to: "2026-11-02" }, TODAY)).toEqual({ from: "0000-01-01", to: "2026-11-02" });
    expect(periodRange({ kind: "all" }, TODAY)).toBeNull();
  });

  it("keeps a day by its date, a compacted month whole when the period touches it, and the «earlier» part only for every row", () => {
    expect(inPeriod({ period: "2026-11-01" }, { kind: "month" }, TODAY)).toBe(true);
    expect(inPeriod({ period: "2026-10-31" }, { kind: "month" }, TODAY)).toBe(false);
    expect(inPeriod({ period: "2026-10-31" }, { kind: "30d" }, TODAY)).toBe(true);
    expect(inPeriod({ period: "2026-10-27" }, { kind: "30d" }, TODAY)).toBe(false);
    expect(inPeriod({ period: "2026-06" }, { kind: "custom", from: "2026-06-20", to: "2026-07-05" }, TODAY), "a month the range touches").toBe(true);
    expect(inPeriod({ period: "2026-06" }, { kind: "custom", from: "2026-07-01", to: "2026-07-05" }, TODAY)).toBe(false);
    expect(inPeriod({ period: EARLIER }, { kind: "custom", from: "2000-01-01", to: "2099-12-31" }, TODAY)).toBe(false);
    expect(inPeriod({ period: EARLIER }, { kind: "all" }, TODAY)).toBe(true);
    expect(inPeriod({ period: "2026-06" }, { kind: "all" }, TODAY)).toBe(true);
  });
});

describe("the filters of the dashboard", () => {
  const rows = [
    row({ bookId: "book-1", source: "copilot", capability: "brainstorming", model: "gpt-5", integrationId: "int-1", currency: "EUR", cost: 1 }),
    row({ bookId: "book-2", source: "autopilot", capability: "director", model: "free-model", integrationId: "int-2", currency: "", unpricedCalls: 1 }),
    row({ bookId: "book-1", source: "media", capability: "image", model: "gpt-image", integrationId: "int-1", currency: "USD", cost: 0.5, period: "2026-10-02" }),
  ];

  it("keeps the rows of each choice: the book, the use, the task (Brainstorming among them), the model, the integration, the currency", () => {
    expect(filterRows(rows, filters({ period: { kind: "all" }, bookId: "book-1" }), TODAY)).toHaveLength(2);
    expect(filterRows(rows, filters({ source: "copilot" }), TODAY)).toEqual([rows[0]]);
    expect(filterRows(rows, filters({ capability: "brainstorming" }), TODAY)).toEqual([rows[0]]);
    expect(filterRows(rows, filters({ model: "free-model" }), TODAY)).toEqual([rows[1]]);
    expect(filterRows(rows, filters({ integrationId: "int-2" }), TODAY)).toEqual([rows[1]]);
    expect(filterRows(rows, filters({ period: { kind: "all" }, currency: "USD" }), TODAY)).toEqual([rows[2]]);
    expect(filterRows(rows, filters({}), TODAY), "this month by default").toEqual([rows[0], rows[1]]);
    expect(matches(rows[0], filters({ bookId: "book-1", source: "copilot", capability: "brainstorming" }), TODAY)).toBe(true);
  });

  it("counts the filters that name something, the period apart", () => {
    expect(activeFilters(defaultFilters())).toBe(0);
    expect(activeFilters(filters({ period: { kind: "all" }, bookId: "book-1", capability: "brainstorming" }))).toBe(2);
    expect(ALL).toBe("");
  });

  it("offers what the rows have, the uses in their order and a use a later version adds after them", () => {
    const options = optionsOf([...rows, row({ source: "a-use-of-tomorrow", currency: "GBP" })], USAGE_SOURCES);
    expect(options.bookIds).toEqual(["book-1", "book-2"]);
    expect(options.sources).toEqual(["autopilot", "copilot", "media", "a-use-of-tomorrow"]);
    expect(options.capabilities).toEqual(["autopilot", "brainstorming", "director", "image"]);
    expect(options.currencies, "a row without a price has no currency").toEqual(["EUR", "GBP", "USD"]);
    expect(options.integrationIds).toEqual(["int-1", "int-2"]);
  });
});

describe("the rows of the dashboard", () => {
  it("groups by book, by month (the «earlier» part on its own) and by use", () => {
    expect(groupKey({ bookId: "book-1", period: "2026-11-02", source: "copilot" }, "books")).toBe("book-1");
    expect(groupKey({ bookId: "book-1", period: "2026-11-02", source: "copilot" }, "months")).toBe("2026-11");
    expect(groupKey({ bookId: "book-1", period: "2026-06", source: "copilot" }, "months")).toBe("2026-06");
    expect(groupKey({ bookId: "book-1", period: EARLIER, source: "other" }, "months")).toBe(EARLIER);
    expect(groupKey({ bookId: "book-1", period: "2026-11-02", source: "copilot" }, "sources")).toBe("copilot");
  });

  it("sums each group by currency, never adding two, lists its models the most expensive first, and draws its trend from all its history", () => {
    const kept = [row({ cost: 1, calls: 2, tasks: 1 }), row({ cost: 0.5, currency: "USD", model: "gpt-mini", calls: 1 }), row({ bookId: "book-2", cost: 2 })];
    const history = [...kept, row({ period: "2026-09-10", cost: 3 }), row({ period: "2026-05", cost: 9 })];
    const groups = buildGroups(kept, history, "books", TODAY);
    const first = groups.find((group) => group.key === "book-1")!;
    expect(first.summary.money).toEqual({ EUR: 1, USD: 0.5 });
    expect(first.summary.calls).toBe(3);
    expect(first.models).toEqual([{ integrationId: "int-1", model: "gpt-5" }, { integrationId: "int-1", model: "gpt-mini" }]);
    expect(first.trend.map((point) => point.period)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(first.trend.find((point) => point.period === "2026-09")?.money, "a month before the period").toEqual({ EUR: 3 });
    expect(first.trend.find((point) => point.period === "2026-11")?.money).toEqual({ EUR: 1, USD: 0.5 });
    expect(first.trend.some((point) => point.period === "2026-05"), "six months only").toBe(false);
  });

  it("draws the trend of a month from the six months that end in it, so that a month the ledger compacted has one too, and none for the «earlier» part", () => {
    const rows = [row({ period: "2026-11-03", cost: 1 }), row({ period: "2026-11-20", cost: 0.5 }), row({ period: "2026-08", cost: 2 }), row({ period: "2026-06", cost: 4, bookId: "book-2" }), row({ period: "2026-03", cost: 9 })];
    const november = trendOf(rows, "months", "2026-11", TODAY);
    expect(november.map((point) => point.period)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(november[0].money, "every book's spend, whatever the group: a month is the history of all of it").toEqual({ EUR: 4 });
    expect(november[2].money).toEqual({ EUR: 2 });
    expect(november[5].money).toEqual({ EUR: 1.5 });
    const august = trendOf(rows, "months", "2026-08", TODAY);
    expect(august.map((point) => point.period)).toEqual(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
    expect(august[0].money, "a compacted month").toEqual({ EUR: 9 });
    expect(august[5].money).toEqual({ EUR: 2 });
    expect(trendOf(rows, "months", EARLIER, TODAY)).toEqual([]);
  });

  it("shows relabelled the amounts a relabel names, in the totals and in the trend", () => {
    const relabels = [{ from: "USD", to: "EUR", until: "2026-11-30T12:00:00.000Z" }];
    const [group] = buildGroups([row({ currency: "USD", cost: 1 })], [row({ currency: "USD", cost: 1 })], "books", TODAY, relabels);
    expect(group.summary.money).toEqual({ "USD>EUR": 1 });
    expect(group.trend[group.trend.length - 1].money).toEqual({ "USD>EUR": 1 });
  });

  it("orders by spend in the currency of the settings (converted at a rate where there is one, the rest after), by name, or by a count", () => {
    const groups = buildGroups([row({ bookId: "a", cost: 1 }), row({ bookId: "b", currency: "USD", cost: 5 }), row({ bookId: "c", cost: 3, calls: 9 })], [], "books", TODAY);
    const name = (key: string) => ({ a: "Alpha", b: "Bravo", c: "Charlie" } as Record<string, string>)[key];
    expect(sortGroups(groups, "spend", "descending", name, EUR).map((group) => group.key), "dollars without a rate count after euro").toEqual(["c", "a", "b"]);
    expect(sortGroups(groups, "spend", "descending", name, { ...EUR, rates: [{ from: "USD", to: "EUR", rate: 0.9 }] }).map((group) => group.key)).toEqual(["b", "c", "a"]);
    expect(sortGroups(groups, "name", "ascending", name, EUR).map((group) => group.key)).toEqual(["a", "b", "c"]);
    expect(sortGroups(groups, "name", "descending", name, EUR).map((group) => group.key)).toEqual(["c", "b", "a"]);
    expect(sortGroups(groups, "calls", "descending", name, EUR)[0].key).toBe("c");
  });

  it("orders the months by their date and not by their names in words, the «earlier» part before them all", () => {
    const groups = buildGroups([row({ period: "2026-09-02" }), row({ period: "2026-11-02" }), row({ period: "2026-06" }), row({ period: "2026-08" }), row({ period: EARLIER, writer: EARLIER })], [], "months", TODAY);
    const inWords = (key: string) => ({ "2026-09": "September 2026", "2026-11": "November 2026", "2026-06": "June 2026", "2026-08": "August 2026", [EARLIER]: "Earlier" } as Record<string, string>)[key];
    const byDate = (key: string) => (key === EARLIER ? "0000-00" : key);
    expect(sortGroups(groups, "name", "descending", byDate, EUR).map((group) => group.key), "the newest first").toEqual(["2026-11", "2026-09", "2026-08", "2026-06", EARLIER]);
    expect(sortGroups(groups, "name", "ascending", byDate, EUR).map((group) => group.key)).toEqual([EARLIER, "2026-06", "2026-08", "2026-09", "2026-11"]);
    expect(sortGroups(groups, "name", "descending", inWords, EUR).map((group) => group.key), "by the words it would be wrong").not.toEqual(["2026-11", "2026-09", "2026-08", "2026-06", EARLIER]);
  });
});

describe("the CSV of the dashboard", () => {
  it("quotes what has to be quoted and never lets a spreadsheet read a cell as a formula", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", twice')).toBe('"say ""hi"", twice"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@me")).toBe("'@me");
    expect(csvCell("-2,5")).toBe(`"'-2,5"`);
    expect(csvCell(12)).toBe("12");
    expect(csvCell(Number.NaN)).toBe("0");
  });

  it("writes one line for each row, newest first, with the names the person reads and every amount as recorded", () => {
    const csv = toCsv([
      row({ period: "2026-10-01", bookId: "book-1", cost: 0.1 + 0.2, calls: 2, tasks: 1, inputTokens: 100, outputTokens: 50 }),
      row({ period: TODAY, bookId: "book-2", source: "copilot", capability: "brainstorming", integrationId: "int-2", model: "m, 1", currency: "USD", estimatedCost: 0.002, unknownUsageCalls: 1 }),
      row({ period: EARLIER, bookId: "book-1", source: "other", capability: "", integrationId: "", model: "", writer: EARLIER, cost: 2 }),
    ], (id) => ({ "book-1": "The Glass Harbor", "book-2": "=Evil" } as Record<string, string>)[id] ?? id, (id) => (id === "int-2" ? "LlmProxy" : id));
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("period,book,source,capability,integration,model,currency,calls,tasks,input_tokens,cached_tokens,output_tokens,cost,estimated_cost,estimated_input_tokens,estimated_output_tokens,unpriced_calls,unknown_usage_calls");
    expect(lines[1]).toBe(`${TODAY},'=Evil,copilot,brainstorming,LlmProxy,"m, 1",USD,0,0,0,0,0,0,0.002,0,0,0,1`);
    expect(lines[2]).toBe("2026-10-01,The Glass Harbor,autopilot,autopilot,int-1,gpt-5,EUR,2,1,100,0,50,0.3,0,0,0,0,0");
    expect(lines[3]).toBe("earlier,The Glass Harbor,other,,,,EUR,0,0,0,0,0,2,0,0,0,0,0");
    expect(lines[lines.length - 1], "ends with a line break").toBe("");
  });
});

describe("a ledger of a heavy user", () => {
  it("is grouped, filtered, drawn and exported in a moment, thousands of rows in one group included", () => {
    const rows: UsageRow[] = [];
    for (let book = 0; book < 6; book += 1) {
      for (let dayNumber = 1; dayNumber <= 28; dayNumber += 1) {
        for (const source of ["autopilot", "copilot", "editor-actions", "audit", "reader-evaluation", "research"]) {
          for (const model of ["gpt-5", "gpt-5-mini", "gpt-image-2"]) {
            rows.push(row({ bookId: `book-${book}`, source, model, period: `2026-11-${String(dayNumber).padStart(2, "0")}`, cost: 0.01, calls: 3, tasks: 1, inputTokens: 1000, outputTokens: 300 }));
          }
        }
      }
    }
    for (let month = 1; month <= 8; month += 1) rows.push(...rows.slice(0, 1000).map((entry) => ({ ...entry, period: `2026-${String(month).padStart(2, "0")}` })));
    expect(rows.length).toBeGreaterThan(8000);
    let kept: UsageRow[] = [];
    let groups: ReturnType<typeof buildGroups> = [];
    let sources: ReturnType<typeof buildGroups> = [];
    let months: ReturnType<typeof buildGroups> = [];
    let csv = "";
    const took = cpuMs(() => {
      kept = filterRows(rows, filters({ period: { kind: "all" } }), TODAY);
      groups = buildGroups(kept, kept, "books", TODAY);
      sources = buildGroups(kept, kept, "sources", TODAY);
      months = buildGroups(kept, kept, "months", TODAY);
      sortGroups(groups, "spend", "descending", (key) => key, EUR);
      csv = toCsv(kept, (id) => id, (id) => id);
    });
    expect(groups).toHaveLength(6);
    expect(sources).toHaveLength(6);
    expect(months.length).toBeGreaterThan(1);
    expect(csv.split("\r\n").length).toBe(rows.length + 2);
    // The work, not the clock (a busy machine stretches the clock and not the work); it was quadratic in the size of a group before.
    expect(took).toBeLessThan(1500);
  });
});
