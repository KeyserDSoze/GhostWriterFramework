import { describe, expect, it } from "vitest";
import {
  addToLedger,
  COUNTER_FIELDS,
  compactWriter,
  decodeCounters,
  decodeKey,
  emptyCounters,
  encodeCounters,
  encodeKey,
  firstDailyMonth,
  ledgerRows,
  ledgerWriterId,
  localDay,
  mergeLedgers,
  newerPart,
  sameLedger,
  type LedgerWriter,
  type UsageDelta,
  type UsageKey,
  type UsageLedger,
} from "@/costs/ledger";

const AT = new Date(2026, 10, 25, 10, 30);
const key = (patch: Partial<UsageKey> = {}): UsageKey => ({ period: "2026-11-25", bookId: "book-1", source: "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: "EUR", ...patch });
const call = (patch: Partial<UsageKey> = {}, counters: UsageDelta["counters"] = { calls: 1, tasks: 1, inputTokens: 1000, outputTokens: 200, cost: 0.01 }): UsageDelta => ({ key: key(patch), counters });

/** The total of a counter over every row the ledger holds: what a person would read as «calls», «cost»… */
const total = (ledger: UsageLedger | undefined, field: (typeof COUNTER_FIELDS)[number]) => ledgerRows(ledger).reduce((sum, row) => sum + row[field], 0);

/** A device that records calls in its own part, offline, as the account store does: one change per record. */
function device(name: string, created = "2026-11-01T00:00:00.000Z") {
  const id = ledgerWriterId(`device-${name}`, created);
  return {
    id,
    record: (ledger: UsageLedger | undefined, ...deltas: UsageDelta[]) => deltas.reduce<UsageLedger | undefined>((current, delta) => addToLedger(current, id, [delta], AT, "EUR"), ledger) as UsageLedger,
  };
}

describe("the text of a row", () => {
  it("keeps every part of the key, the separator and the escape included", () => {
    const tricky = key({ bookId: "me/book|2", model: "deploy%7C|x", capability: "copilot" });
    expect(decodeKey(encodeKey(tricky))).toEqual(tricky);
    expect(encodeKey(tricky).split("|")).toHaveLength(7);
  });

  it("refuses a key it cannot read, so a row it does not understand is never counted", () => {
    expect(decodeKey("not a key")).toBeNull();
    expect(decodeKey("someday|book|autopilot|autopilot||m|EUR")).toBeNull();
  });

  it("writes the counters in a fixed order, without the zeros at the end, with money to ten decimals", () => {
    const counters = { ...emptyCounters(), calls: 2, tasks: 1, inputTokens: 1500, cost: 0.1 + 0.2 };
    expect(encodeCounters(counters)).toBe("2 1 1500 0 0 0.3");
    expect(decodeCounters("2 1 1500 0 0 0.3").counters).toEqual({ ...counters, cost: 0.3 });
  });

  it("keeps the numbers a newer version wrote after the ones it knows", () => {
    const decoded = decodeCounters("1 1 10 0 5 0.5 0 0 0 0 0 0 7 8");
    expect(decoded.extra).toEqual(["7", "8"]);
    expect(encodeCounters(decoded.counters, decoded.extra)).toBe("1 1 10 0 5 0.5 0 0 0 0 0 0 7 8");
  });

  it("reads nothing as zero rather than as a number it is not", () => {
    expect(decodeCounters("x -3 NaN").counters).toEqual(emptyCounters());
  });
});

describe("days and months", () => {
  it("are the calendar of the device that records", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("keep the days of the current month and of the two before it", () => {
    expect(firstDailyMonth(new Date(2026, 10, 25))).toBe("2026-09");
    expect(firstDailyMonth(new Date(2026, 1, 1))).toBe("2025-12");
  });
});

describe("a writer's part", () => {
  it("begins the ledger with the moment and the currency of the setting, and counts a change per record", () => {
    const a = device("a");
    const ledger = a.record(undefined, call(), call({ model: "gpt-5-mini" }, { calls: 1 }));
    expect(ledger).toMatchObject({ v: 1, since: AT.toISOString(), currency: "EUR" });
    expect(ledger.writers[a.id].seq).toBe(2);
    expect(total(ledger, "calls")).toBe(2);
    expect(total(ledger, "cost")).toBeCloseTo(0.01, 12);
  });

  it("adds a call of the same day, book, source, capability, integration, model and currency to the same row", () => {
    const a = device("a");
    const ledger = a.record(undefined, call(), call(), call({ currency: "USD" }));
    expect(Object.keys(ledger.writers[a.id].rows)).toHaveLength(2);
    expect(ledgerRows(ledger).find((row) => row.currency === "EUR")).toMatchObject({ calls: 2, tasks: 2, inputTokens: 2000, outputTokens: 400 });
  });

  it("never changes another writer's part, nor the ledger it was given", () => {
    const a = device("a");
    const b = device("b");
    const base = b.record(undefined, call());
    const frozen = JSON.stringify(base);
    const next = a.record(base, call());
    expect(JSON.stringify(base)).toBe(frozen);
    expect(next.writers[b.id]).toEqual(base.writers[b.id]);
  });

  it("leaves a ledger of a newer version as it is", () => {
    const future = { v: 2, rows: ["anything"] } as unknown as UsageLedger;
    expect(addToLedger(future, "w", [call()], AT, "EUR")).toBe(future);
  });
});

describe("compaction", () => {
  const old = (period: string, model = "gpt-5", cost = 0.5) => call({ period, model }, { calls: 1, tasks: 1, inputTokens: 100, cost });

  it("sums the days before the window into their months, with the same totals", () => {
    const writer: LedgerWriter = { seq: 7, rows: {} };
    for (const delta of [old("2026-07-01"), old("2026-07-31"), old("2026-08-15", "other"), old("2026-09-01"), old("2026-11-25")]) {
      writer.rows[encodeKey(delta.key)] = encodeCounters({ ...emptyCounters(), ...delta.counters });
    }
    const compacted = compactWriter(writer, AT);
    const periods = Object.keys(compacted.rows).map((text) => decodeKey(text)!.period).sort();
    expect(periods).toEqual(["2026-07", "2026-08", "2026-09-01", "2026-11-25"]);
    const ledger = (rows: Record<string, string>) => ({ v: 1, since: "", currency: "EUR", writers: { w: { seq: 1, rows } } }) as UsageLedger;
    for (const field of COUNTER_FIELDS) expect(total(ledger(compacted.rows), field)).toBeCloseTo(total(ledger(writer.rows), field), 12);
    expect(ledgerRows(ledger(compacted.rows)).find((row) => row.period === "2026-07")).toMatchObject({ calls: 2, inputTokens: 200, cost: 1 });
    expect(compacted.seq, "compaction is part of the change that triggered it").toBe(7);
  });

  it("does nothing, and returns the same part, when there is nothing to sum", () => {
    const writer: LedgerWriter = { seq: 1, rows: { [encodeKey(key())]: "1 1 10" } };
    expect(compactWriter(writer, AT)).toBe(writer);
    const once = compactWriter({ seq: 1, rows: { [encodeKey(key({ period: "2026-01-02" }))]: "1" } }, AT);
    expect(compactWriter(once, AT)).toBe(once);
  });

  it("keeps a writer's part bounded: a year of daily use is about twelve months and ninety days of rows", () => {
    const a = device("a");
    let ledger: UsageLedger | undefined;
    for (let day = 0; day < 365; day += 1) {
      const at = new Date(2025, 10, 26 + day);
      ledger = addToLedger(ledger, a.id, [call({ period: localDay(at) })], at, "EUR");
    }
    const rows = Object.keys(ledger!.writers[a.id].rows).length;
    expect(rows).toBeLessThanOrEqual(12 + 92);
    expect(total(ledger, "calls")).toBe(365);
  });
});

describe("the merge rule: two devices never count a call twice and never lose one", () => {
  it("merges two devices that recorded offline from the same copy: each part once, whatever the order", () => {
    const a = device("a");
    const b = device("b");
    const base = a.record(undefined, call());
    const onA = a.record(base, call(), call({ source: "copilot", capability: "copilot" }));
    const onB = b.record(base, call({ bookId: "book-2" }), call({ bookId: "book-2" }), call({ bookId: "book-2" }));
    const ab = mergeLedgers(onA, onB);
    const ba = mergeLedgers(onB, onA);
    expect(sameLedger(ab, ba)).toBe(true);
    expect(total(ab, "calls"), "1 shared + 2 of A + 3 of B, the shared call once").toBe(6);
    expect(ab!.writers[a.id].seq).toBe(3);
    expect(ab!.writers[b.id].seq).toBe(3);
  });

  it("is associative and idempotent: syncs in any grouping, and a merge made again, change nothing", () => {
    const [a, b, c] = [device("a"), device("b"), device("c")];
    const x = a.record(undefined, call(), call());
    const y = b.record(x, call());
    const z = c.record(y, call({ model: "m" }));
    const left = mergeLedgers(mergeLedgers(x, y), z);
    const right = mergeLedgers(x, mergeLedgers(y, z));
    expect(sameLedger(left, right)).toBe(true);
    expect(sameLedger(mergeLedgers(left, left), left)).toBe(true);
    expect(sameLedger(mergeLedgers(left, x), left), "an older copy merged again adds nothing").toBe(true);
    expect(total(left, "calls")).toBe(4);
  });

  it("takes the newest state of a writer whole: a stale copy of a part never brings back less, nor adds itself", () => {
    const a = device("a");
    const stale = a.record(undefined, call());
    const newer = a.record(stale, call(), call());
    expect(total(mergeLedgers(stale, newer), "calls")).toBe(3);
    expect(total(mergeLedgers(newer, stale), "calls")).toBe(3);
  });

  it("keeps a writer's state after compaction instead of adding its old days to its months", () => {
    const a = device("a");
    const july = new Date(2026, 6, 10);
    const before = addToLedger(undefined, a.id, [call({ period: "2026-07-10" })], july, "EUR");
    const after = addToLedger(before, a.id, [call()], AT, "EUR");
    expect(Object.keys(after.writers[a.id].rows).some((text) => text.startsWith("2026-07|")), "the day became its month").toBe(true);
    expect(total(mergeLedgers(before, after), "calls")).toBe(2);
  });

  it("chooses the same part on every device when two parts of one writer have the same number", () => {
    const left: LedgerWriter = { seq: 3, rows: { [encodeKey(key())]: "2" } };
    const right: LedgerWriter = { seq: 3, rows: { [encodeKey(key())]: "5" } };
    expect(newerPart(left, right)).toBe(right);
    expect(newerPart(right, left)).toBe(right);
    const one = mergeLedgers({ v: 1, since: "a", currency: "EUR", writers: { w: left } }, { v: 1, since: "a", currency: "EUR", writers: { w: right } });
    const two = mergeLedgers({ v: 1, since: "a", currency: "EUR", writers: { w: right } }, { v: 1, since: "a", currency: "EUR", writers: { w: left } });
    expect(sameLedger(one, two)).toBe(true);
  });

  it("keeps the beginning of the copy that began first, on every device", () => {
    const early = { v: 1, since: "2026-01-01T00:00:00.000Z", currency: "USD", writers: {} } as UsageLedger;
    const late = { v: 1, since: "2026-02-01T00:00:00.000Z", currency: "EUR", writers: {} } as UsageLedger;
    expect(mergeLedgers(late, early)).toMatchObject({ since: early.since, currency: "USD" });
    expect(mergeLedgers(early, late)).toMatchObject({ since: early.since, currency: "USD" });
  });

  it("never writes over a ledger of a newer version: it is passed on as it is", () => {
    const future = { v: 2, parts: {} };
    const a = device("a");
    expect(mergeLedgers(a.record(undefined, call()), future)).toBe(future);
    expect(mergeLedgers(undefined, undefined)).toBeUndefined();
  });

  it("a device whose store was made again is a new writer, so its new numbering never meets its old part", () => {
    const old = device("a", "2026-01-01T00:00:00.000Z");
    const fresh = device("a", "2026-11-20T09:00:00.000Z");
    expect(old.id).not.toBe(fresh.id);
    const synced = old.record(undefined, call(), call(), call());
    const restarted = fresh.record(undefined, call());
    expect(total(mergeLedgers(synced, restarted), "calls"), "the old part (3) and the new one (1): nothing dropped for having a lower number").toBe(4);
  });
});
