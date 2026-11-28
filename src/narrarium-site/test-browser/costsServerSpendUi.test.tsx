import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AutopilotStats } from "narrarium-engine";

import i18n from "@/i18n";
import "@/i18n/costs";
import { ServerTotals } from "@/components/costs/dashboard/ServerTotals";
import { CostsIndicator } from "@/components/costs/CostsIndicator";
import { useAutopilotStore } from "@/autopilot/store";
import { useCostsStore } from "@/costs/costsStore";
import { addToLedger, ledgerWriterId, localDay, type UsageDelta } from "@/costs/ledger";
import { emptyCostsFile } from "@/costs/model";
import { useServerSpend } from "@/costs/useServerSpend";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const WRITER = ledgerWriterId("device-a", "2026-11-01T00:00:00.000Z");
const today = localDay(new Date());
const GLASS = { id: "book-1", name: "The Glass Harbor", owner: "", repo: "", storageMode: "local-only", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z" } as BookEntry;
const SERVED = { ...GLASS, id: "book-3", name: "The Lighthouse", autopilotHost: "server" } as BookEntry;
const SERVED_TOO = { ...GLASS, id: "book-4", name: "The Fog Bell", autopilotHost: "server" } as BookEntry;

function spend(rows: Array<{ bookId?: string; cost: number; currency?: string }>) {
  const deltas: UsageDelta[] = rows.map((row) => ({ key: { period: today, bookId: row.bookId ?? "book-1", source: "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: row.currency ?? "USD" }, counters: { calls: 1, tasks: 1, cost: row.cost } }));
  const file = { ...emptyCostsFile(), ledger: addToLedger(undefined, WRITER, deltas, new Date(), "USD") };
  useCostsStore.setState({ file, persisted: file });
}

function settings(books: BookEntry[] = [GLASS]) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "USD", books } });
}

function served(bookId: string, stats: Partial<AutopilotStats>) {
  const full = { tasks: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, failures: 0, ...stats } as AutopilotStats;
  const summary = { status: "running", stats: full, updatedAt: "2026-11-26T10:00:00.000Z" } as never;
  act(() => useAutopilotStore.setState((store) => ({ summaries: { ...store.summaries, [bookId]: summary } })));
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  settings();
  spend([]);
});

afterEach(() => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {} });
});

describe("the books that run on the personal server, in the top bar and on the dashboard", () => {
  const showPill = () => render(<MemoryRouter><CostsIndicator /></MemoryRouter>);
  const pill = () => document.querySelector<HTMLAnchorElement>("[data-costs-indicator]");

  it("puts what the server counted in a part of its own, never in today or this month", () => {
    settings([GLASS, SERVED]);
    spend([{ cost: 0.5 }]);
    served("book-3", { cost: 3.2, currency: "USD", aiCalls: 9 });
    showPill();
    const link = pill()!;
    expect(link.querySelector("[data-costs-month]")).toHaveTextContent("$0.50");
    expect(link.querySelector("[data-costs-today]")).toHaveTextContent("$0.50");
    expect(link.querySelector("[data-costs-server]")).toHaveTextContent("server $3.20");
    expect(link.querySelector("[data-costs-server]"), "a narrow bar leaves it to the title and the screen reader").toHaveClass("hidden", "xl:inline");
    expect(link.querySelector("[data-costs-server-note]")).toHaveTextContent("On your server: $3.20 in all, from the autopilot's own count of its runs, not split by day or month and not included in today or this month. Books not read yet are not counted.");
    expect(link.getAttribute("title")).toContain("On your server: $3.20 in all");
    expect(link).toHaveAccessibleName(/this month \$0\.50 On your server: \$3\.20 in all/);
  });

  it("shows up for a month with nothing in this browser when the server has spent", () => {
    settings([SERVED]);
    served("book-3", { cost: 1.25 });
    showPill();
    expect(pill()).not.toBeNull();
    expect(pill()!.querySelector("[data-costs-server]")).toHaveTextContent("server $1.25");
  });

  it("is not there when the server counted nothing and the browser spent nothing, and says a book it has not read", () => {
    settings([SERVED]);
    showPill();
    expect(pill(), "nothing read, nothing spent").toBeNull();
    cleanup();
    spend([{ cost: 0.5 }]);
    showPill();
    expect(pill()!.querySelector("[data-costs-server]")).toBeNull();
    expect(pill()!.querySelector("[data-costs-server-note]")).toHaveTextContent("On your server: the count of 1 book has not been read yet, so nothing is counted for it.");
  });

  it("keeps the currencies of the books apart on the dashboard and says what the figure holds and what it does not", () => {
    settings([GLASS, SERVED, SERVED_TOO]);
    served("book-3", { cost: 2, currency: "EUR", costUnknownCalls: 3 });
    function Line() {
      const server = useServerSpend();
      return <ServerTotals server={server} />;
    }
    render(<Line />);
    const line = document.querySelector("[data-server-totals]")!;
    expect(line).toHaveTextContent("On your server: €2.00 over all the runs of 1 book, from the server's own count. It is not split by month, so it is not added to the totals above.");
    expect(line.querySelector("[data-server-includes]")).toHaveTextContent("Included: the autopilot's calls of the books that run on your server. Not included: what your browsers recorded (it is in the table), and the server's calls that are not the autopilot's.");
    expect(line.querySelector("[data-server-unread]")).toHaveTextContent("1 book that runs on your server has not been read yet, so it is not in this figure.");
    expect(line.querySelector("[data-server-unpriced]")).toHaveTextContent("3 calls of the server have no price, so their cost is not in this figure.");
  });
});
