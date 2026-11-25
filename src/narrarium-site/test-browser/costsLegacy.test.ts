import { describe, expect, it } from "vitest";
import { addToLedger, ledgerRows, ledgerWriterId, type UsageDelta, type UsageKey } from "@/costs/ledger";
import { addToLegacy, coveredPart, earlierRows, EARLIER, mergeCostsFiles, usageRows } from "@/costs/legacyCosts";
import { emptyBucket, emptyCostsFile, type BookUsage, type CostsFile, type UsageBucket } from "@/costs/model";

const AT = new Date(2026, 10, 25, 10, 30);
const A = ledgerWriterId("device-a", "2026-11-01T00:00:00.000Z");
const B = ledgerWriterId("device-b", "2026-11-02T00:00:00.000Z");

const key = (patch: Partial<UsageKey> = {}): UsageKey => ({ period: "2026-11-25", bookId: "book-1", source: "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: "EUR", ...patch });
const priced = (cost: number, patch: Partial<UsageKey> = {}): UsageDelta => ({ key: key(patch), counters: { calls: 1, tasks: 1, inputTokens: 1000, cachedTokens: 100, outputTokens: 200, cost } });

/** What this version does for a call: its row in the device's part of the ledger, and the same in the legacy totals (`coveredPart`). */
function record(file: CostsFile, writer: string, delta: UsageDelta, details: Partial<UsageBucket> = {}): CostsFile {
  const next = { ...file, ledger: addToLedger(file.ledger, writer, [delta], AT, "EUR") };
  return addToLegacy(next, delta.key.bookId, "The Glass Harbor", coveredPart({ ...delta.key, ...delta.counters }), details);
}

/** What a client of 0.111.0 does for a priced call: `costsStore.record` of that version, which adds to the legacy totals and keeps every other key of the file. */
function olderClientRecords(file: CostsFile, bookId: string, delta: Partial<UsageBucket>, model?: string): CostsFile {
  const prev: BookUsage = { ...emptyBucket(), ...(file.books[bookId] ?? {}), bookId };
  const merged: BookUsage = { ...prev } as BookUsage;
  for (const [field, value] of Object.entries(delta)) (merged as unknown as Record<string, number>)[field] = ((prev as unknown as Record<string, number>)[field] ?? 0) + (value ?? 0);
  if (model) merged.models = { ...(prev.models ?? {}), [model]: Object.fromEntries(Object.entries({ ...emptyBucket(), ...(prev.models?.[model] ?? {}) }).map(([field, value]) => [field, value + ((delta as Record<string, number>)[field] ?? 0)])) as unknown as UsageBucket };
  else merged.models = prev.models;
  return { ...file, updatedAt: new Date().toISOString(), books: { ...file.books, [bookId]: merged } };
}

const legacyWith = (books: Record<string, Partial<BookUsage>>): CostsFile => ({ ...emptyCostsFile(), books: Object.fromEntries(Object.entries(books).map(([id, usage]) => [id, { ...emptyBucket(), bookId: id, ...usage } as BookUsage])) });
const cost = (rows: ReturnType<typeof usageRows>, currency = "EUR") => rows.filter((row) => row.currency === currency).reduce((sum, row) => sum + row.cost, 0);

describe("the legacy totals and the ledger: what this version adds to one it adds to the other", () => {
  it("adds a priced chat call's measured tokens and cost to its book and its model, as the legacy code did", () => {
    const file = record(emptyCostsFile(), A, priced(0.02));
    expect(file.books["book-1"]).toMatchObject({ bookName: "The Glass Harbor", inputTokens: 1000, cachedTokens: 100, outputTokens: 200, chatCost: 0.02 });
    expect(file.books["book-1"].models?.["gpt-5"]).toMatchObject({ inputTokens: 1000, cachedTokens: 100, outputTokens: 200, chatCost: 0.02 });
  });

  it("adds nothing to them for what they never counted: a call with no book, a model with no price, an estimate", () => {
    let file = record(emptyCostsFile(), A, { key: key({ bookId: "" }), counters: { calls: 1, inputTokens: 10, cost: 0.5 } });
    file = record(file, A, { key: key({ currency: "" }), counters: { calls: 1, inputTokens: 10, unpricedCalls: 1 } });
    file = record(file, A, { key: key(), counters: { calls: 1, unknownUsageCalls: 1, estimatedInputTokens: 900, estimatedCost: 0.4 } });
    expect(file.books).toEqual({});
    expect(ledgerRows(file.ledger).reduce((sum, row) => sum + row.calls, 0), "the ledger has all three").toBe(3);
  });

  it("puts the cost of an image, a voice or a transcription in its own field, and the counts only the legacy totals have beside it", () => {
    let file = record(emptyCostsFile(), A, { key: key({ capability: "image", source: "media", model: "gpt-image-1" }), counters: { calls: 1, inputTokens: 50, outputTokens: 4000, cost: 0.17 } }, { imageCount: 1, imageOutputTokens: 4000 });
    file = record(file, A, { key: key({ capability: "tts", source: "media", model: "tts-1" }), counters: { calls: 1, cost: 0.03 } }, { ttsChars: 2000 });
    expect(file.books["book-1"]).toMatchObject({ imageCost: 0.17, imageCount: 1, imageOutputTokens: 4000, ttsCost: 0.03, ttsChars: 2000, chatCost: 0, inputTokens: 0 });
  });
});

describe("migration: the legacy totals become the «earlier» part, and nothing is lost", () => {
  const legacy = legacyWith({
    "book-1": { bookName: "The Glass Harbor", inputTokens: 5000, cachedTokens: 0, outputTokens: 1000, chatCost: 0.1586, imageCost: 0.04, imageCount: 1, models: { "gpt-5": { ...emptyBucket(), inputTokens: 5000, outputTokens: 1000, chatCost: 0.1586 } } },
    "book-2": { chatCost: 1, inputTokens: 10, outputTokens: 1 },
  });

  it("shows a file without a ledger whole as «earlier», in the currency the settings have, model by model and media apart", () => {
    const rows = earlierRows(legacy, "EUR");
    expect(rows.every((row) => row.period === EARLIER && row.writer === EARLIER && row.currency === "EUR" && row.calls === 0)).toBe(true);
    expect(rows.find((row) => row.bookId === "book-1" && row.model === "gpt-5")).toMatchObject({ cost: 0.1586, inputTokens: 5000, outputTokens: 1000 });
    expect(rows.find((row) => row.bookId === "book-1" && row.capability === "image")).toMatchObject({ cost: 0.04 });
    expect(rows.find((row) => row.bookId === "book-2" && row.model === "")).toMatchObject({ cost: 1, inputTokens: 10 });
    expect(cost(rows)).toBeCloseTo(1.1986, 10);
  });

  it("keeps the «earlier» part the same while this version records: the new calls are the ledger's, never counted twice", () => {
    let file = record(legacy, A, priced(0.02));
    file = record(file, A, priced(0.03, { model: "gpt-5-mini" }));
    const rows = usageRows(file, "USD");
    expect(cost(rows.filter((row) => row.writer === EARLIER))).toBeCloseTo(1.1986, 10);
    expect(cost(rows)).toBeCloseTo(1.1986 + 0.05, 10);
    expect(file.ledger?.currency, "the «earlier» part keeps the currency the settings had when the ledger began").toBe("EUR");
    expect(rows.filter((row) => row.writer === EARLIER).every((row) => row.currency === "EUR"), "not the one of today").toBe(true);
  });

  it("finds what an older client added after the ledger began in the «earlier» part", () => {
    let file = record(legacy, A, priced(0.02));
    file = olderClientRecords(file, "book-1", { inputTokens: 300, outputTokens: 30, chatCost: 0.007 }, "gpt-5");
    const rows = usageRows(file, "EUR");
    expect(cost(rows)).toBeCloseTo(1.1986 + 0.02 + 0.007, 10);
    expect(rows.find((row) => row.writer === EARLIER && row.model === "gpt-5")).toMatchObject({ inputTokens: 5300, outputTokens: 1030 });
  });

  it("never shows less than nothing when the ledger holds more than the legacy totals of a copy", () => {
    const file = { ...legacyWith({ "book-1": { chatCost: 0.01 } }), ledger: addToLedger(undefined, A, [priced(0.5)], AT, "EUR") };
    expect(earlierRows(file, "EUR").filter((row) => row.bookId === "book-1")).toEqual([]);
  });

  it("shows the legacy totals whole beside a ledger of a newer version, which it cannot read and never counts", () => {
    const file = { ...legacy, ledger: { v: 2, anything: true } as unknown as CostsFile["ledger"] };
    expect(cost(usageRows(file, "EUR"))).toBeCloseTo(1.1986, 10);
  });
});

describe("costs that copies merge: the ledger of all of them, the legacy totals made whole on it", () => {
  // A shared copy: 100 earlier, then device A spends 10 and device B spends 20, offline. Whichever copy is kept, the total is 130.
  const shared = legacyWith({ "book-1": { chatCost: 100, inputTokens: 1_000_000, models: { "gpt-5": { ...emptyBucket(), chatCost: 100, inputTokens: 1_000_000 } } } });
  const onA = record(shared, A, priced(10));
  const onB = record(shared, B, priced(20, { model: "gpt-5-mini" }));

  for (const [name, selected, others] of [["A's copy", onA, [onB]], ["B's copy", onB, [onA]]] as const) {
    it(`keeps everything when ${name} is chosen`, () => {
      const merged = mergeCostsFiles(selected, others);
      expect(cost(usageRows(merged, "EUR"))).toBeCloseTo(130, 10);
      expect(merged.books["book-1"].chatCost, "the legacy totals an older client reads are whole too").toBeCloseTo(130, 10);
      expect(merged.books["book-1"].models?.["gpt-5"]?.chatCost).toBeCloseTo(110, 10);
      expect(merged.books["book-1"].models?.["gpt-5-mini"]?.chatCost).toBeCloseTo(20, 10);
      expect(cost(usageRows(merged, "EUR").filter((row) => row.writer === EARLIER))).toBeCloseTo(100, 10);
    });
  }

  it("gives the same costs whatever the order the copies meet in, and merging again changes nothing", () => {
    const one = mergeCostsFiles(onA, [onB]);
    const two = mergeCostsFiles(mergeCostsFiles(onB, [onA]), [onA, onB]);
    expect(cost(usageRows(one, "EUR"))).toBeCloseTo(cost(usageRows(two, "EUR")), 10);
    expect(mergeCostsFiles(one, [onA, onB])).toBe(one);
  });

  it("returns the chosen copy untouched when the others add nothing", () => {
    expect(mergeCostsFiles(onA, [shared])).toBe(onA);
    expect(mergeCostsFiles(shared, [legacyWith({})])).toBe(shared);
  });

  it("keeps the counts only the legacy totals have as the chosen copy has them", () => {
    const withImages = { ...onA, books: { ...onA.books, "book-1": { ...onA.books["book-1"], imageCount: 4, ttsChars: 900 } } };
    const merged = mergeCostsFiles(withImages, [onB]);
    expect(merged.books["book-1"]).toMatchObject({ imageCount: 4, ttsChars: 900 });
  });

  it("brings back a book that only the other copy's ledger knows, with its name", () => {
    const other = record(shared, B, priced(5, { bookId: "book-9" }));
    const named = { ...other, books: { ...other.books, "book-9": { ...other.books["book-9"], bookName: "Nine" } } };
    const merged = mergeCostsFiles(onA, [named]);
    expect(merged.books["book-9"]).toMatchObject({ bookName: "Nine", chatCost: 5 });
  });

  it("recovers the usage an older client dropped by keeping a copy whole: the device that recorded it merges it back", () => {
    // An older client resolves the conflict by taking A's copy as it is: B's part of the ledger is not in it.
    const keptWhole = onA;
    // Device B pulls it (it is newer) and merges its own costs into it, as the sync of this version does.
    const healed = mergeCostsFiles(keptWhole, [onB]);
    expect(cost(usageRows(healed, "EUR"))).toBeCloseTo(130, 10);
    expect(healed.books["book-1"].chatCost).toBeCloseTo(130, 10);
  });
});
