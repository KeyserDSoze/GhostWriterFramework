import type { AutopilotStats, AutopilotStateSummary, ServerBookSummary } from "narrarium-engine";
import { bookAutopilotOf } from "@/autopilot/bookAutopilot";
import { addRecordedMoney, type MoneyTotals } from "@/costs/money";
import type { BookEntry, CostRelabel } from "@/types/settings";

/**
 * What the books that a personal server runs spent, as the server reports it: the autopilot's own count of each book (`stats`, over all its runs, in the currency the server priced it in),
 * from the summary this browser holds of the book (the one the server streams, or the state it downloaded) or from the server's list of its books. The server does not split what it counted by
 * month or day, so this is a total told apart: it is never added to the months and days of this browser's ledger, which do not hold these calls (see `unrecordedCosts` for the one place it
 * counts, the total budgets, less what the ledger already holds of the same book).
 */
export interface ServerBookSpend {
  bookId: string;
  currency: string;
  cost: number;
  /** The calls the server's count could not price (a model with no price, tokens it had to estimate): `cost` leaves them out, or estimates them. */
  unpricedCalls: number;
  calls: number;
}

export interface ServerSpend {
  /** The books that run on the server (the ones in the filter). */
  served: number;
  /** The books whose summary has been read: their cost is in `spend`. */
  books: ServerBookSpend[];
  /** The books that run on the server and whose summary this browser has not read (the server is off, or nothing was asked of it yet): their cost is not in `spend`. */
  unread: string[];
  spend: MoneyTotals;
  /** The calls of the books above that have no measured cost. */
  unpricedCalls: number;
}

/** What the store holds that tells of a book's autopilot on a server. */
export interface ServerSpendStore {
  views: Parameters<typeof bookAutopilotOf>[0]["views"];
  summaries: Record<string, AutopilotStateSummary>;
  server: { books: readonly ServerBookSummary[] };
}

/** The autopilot's count of one book on the server: the newest summary this browser holds, else what the server's list says of it; `null` when none has been read. */
export function autopilotStatsOf(store: ServerSpendStore, bookId: string): AutopilotStats | null {
  return bookAutopilotOf(store, bookId).stats ?? store.server.books.find((entry) => entry.bookId === bookId)?.autopilot?.stats ?? null;
}

/** The cost of the books that run on the personal server (all of them, or one), by currency and kept as the server told it. */
export function serverSpend(books: readonly BookEntry[], store: ServerSpendStore, context: { display: string; relabels?: readonly CostRelabel[] }, bookId = ""): ServerSpend {
  const served = books.filter((book) => book.autopilotHost === "server" && (bookId === "" || book.id === bookId));
  const entries: ServerBookSpend[] = [];
  const unread: string[] = [];
  let spend: MoneyTotals = {};
  let unpricedCalls = 0;
  for (const book of served) {
    const stats = autopilotStatsOf(store, book.id);
    if (!stats) {
      unread.push(book.id);
      continue;
    }
    const currency = stats.currency || context.display;
    entries.push({ bookId: book.id, currency, cost: stats.cost, unpricedCalls: stats.costUnknownCalls ?? 0, calls: stats.aiCalls });
    spend = addRecordedMoney(spend, currency, stats.cost, undefined, context.relabels);
    unpricedCalls += stats.costUnknownCalls ?? 0;
  }
  return { served: served.length, books: entries, unread, spend, unpricedCalls };
}
