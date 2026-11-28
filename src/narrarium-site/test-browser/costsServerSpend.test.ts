import { describe, expect, it } from "vitest";
import type { AutopilotStateSummary, AutopilotStats } from "narrarium-engine";
import { autopilotStatsOf, serverSpend, type ServerSpendStore } from "@/costs/serverSpend";
import type { BookEntry } from "@/types/settings";

const book = (id: string, host?: "server"): BookEntry => ({ id, name: id, owner: "", repo: "", storageMode: "local-only", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z", ...(host ? { autopilotHost: host } : {}) }) as BookEntry;

describe("what the personal server reports of its books", () => {
  const stats = (cost: number, extra: Partial<AutopilotStats> = {}): AutopilotStats => ({ tasks: 1, aiCalls: 4, inputTokens: 1, outputTokens: 1, cost, failures: 0, currency: "USD", ...extra }) as AutopilotStats;
  const store = (over: Partial<ServerSpendStore> = {}): ServerSpendStore => ({ views: {}, summaries: {}, server: { books: [] }, ...over });
  const summary = (stat: AutopilotStats) => ({ status: "paused", stats: stat, updatedAt: "2026-11-26T10:00:00.000Z" }) as unknown as AutopilotStateSummary;
  const books = [book("s1", "server"), book("s2", "server"), book("local")];

  it("is the autopilot's count of every book that runs there, by currency, kept apart", () => {
    const result = serverSpend(books, store({ summaries: { s1: summary(stats(1.5)), s2: summary(stats(2, { currency: "EUR", costUnknownCalls: 2 })) } }), { display: "USD" });
    expect(result.served).toBe(2);
    expect(result.books.map((entry) => [entry.bookId, entry.currency, entry.cost])).toEqual([["s1", "USD", 1.5], ["s2", "EUR", 2]]);
    expect(Object.values(result.spend).reduce((sum, value) => sum + value, 0)).toBe(3.5);
    expect(Object.keys(result.spend).length, "two currencies, never summed").toBe(2);
    expect(result.unpricedCalls).toBe(2);
    expect(result.unread).toEqual([]);
  });

  it("falls back to the server's list of its books, and says the books it has not read", () => {
    const listed = { bookId: "s1", autopilot: summary(stats(4)) } as never;
    const result = serverSpend(books, store({ server: { books: [listed] } }), { display: "USD" });
    expect(autopilotStatsOf(store({ server: { books: [listed] } }), "s1")?.cost).toBe(4);
    expect(result.books).toHaveLength(1);
    expect(result.unread).toEqual(["s2"]);
  });

  it("keeps to one book when it is asked for one, and ignores a book that runs in a browser", () => {
    const result = serverSpend(books, store({ summaries: { s1: summary(stats(1)), local: summary(stats(9)) } }), { display: "USD" }, "s1");
    expect(result.served).toBe(1);
    expect(result.books.map((entry) => entry.bookId)).toEqual(["s1"]);
    expect(serverSpend(books, store({ summaries: { local: summary(stats(9)) } }), { display: "USD" }, "local").served, "a local book is not the server's").toBe(0);
  });
});
