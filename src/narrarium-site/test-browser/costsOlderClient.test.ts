import { describe, expect, it } from "vitest";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type LocalAccountSnapshot } from "@/account/types";
import { accountContentHash, compareAccountManifests, initialAccountManifest, nextAccountManifest } from "@/account/vectorClock";
import { accountSyncEnvelope, parseAccountRepositoryFiles, parseAccountSyncEnvelope, serializeAccountRepository } from "@/account/serialization";
import { addToLedger, ledgerWriterId, type UsageDelta } from "@/costs/ledger";
import { addToLegacy, coveredPart, EARLIER, usageRows } from "@/costs/legacyCosts";
import { emptyBucket, emptyCostsFile, type BookUsage, type CostsFile, type UsageBucket } from "@/costs/model";
import { DEFAULT_SETTINGS } from "@/types/settings";

const WRITER = ledgerWriterId("device-new", "2026-11-01T00:00:00.000Z");
const AT = new Date(2026, 10, 25, 9);

function withLedger(): CostsFile {
  const delta: UsageDelta = { key: { period: "2026-11-25", bookId: "me/book", source: "autopilot", capability: "director", integrationId: "int|1", model: "gpt-5", currency: "EUR" }, counters: { calls: 3, tasks: 1, inputTokens: 5000, outputTokens: 700, cost: 0.0421, unknownUsageCalls: 1, estimatedInputTokens: 900, estimatedCost: 0.002 } };
  const unpriced: UsageDelta = { key: { ...delta.key, model: "free", currency: "" }, counters: { calls: 2, tasks: 0, inputTokens: 300, unpricedCalls: 2 } };
  let file: CostsFile = { ...emptyCostsFile(), updatedAt: "2026-11-25T09:00:00.000Z" };
  for (const entry of [delta, unpriced]) {
    file = { ...file, ledger: addToLedger(file.ledger, WRITER, [entry], AT, "EUR") };
    file = addToLegacy(file, entry.key.bookId, "The Glass Harbor", coveredPart({ ...entry.key, ...entry.counters }));
  }
  return file;
}

function snapshot(costs: CostsFile, clock: Record<string, number> = { "device-new": 1 }): LocalAccountSnapshot {
  return { dirty: true, manifest: { ...initialAccountManifest("device-new"), vectorClock: clock }, data: { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings: DEFAULT_SETTINGS, costs, clipboard: [], chats: [] } };
}

/**
 * What a client of 0.111.0 does with the account data it reads: it parses the files with the same code (unchanged), records a priced call the way its
 * costs store did (`record`: the legacy totals, with every other key of the file kept by the spread), and writes the data back.
 */
async function olderClientRecords(files: ReadonlyMap<string, string>, vectorClock: Record<string, number>) {
  const parsed = parseAccountRepositoryFiles(files);
  const costs = parsed.data.costs;
  const bookId = "me/book";
  const delta: Partial<UsageBucket> = { inputTokens: 400, cachedTokens: 0, outputTokens: 50, chatCost: 0.0123 };
  const prev: BookUsage = { ...emptyBucket(), ...(costs.books[bookId] ?? {}), bookId, bookName: costs.books[bookId]?.bookName };
  const merged = { ...prev, inputTokens: prev.inputTokens + 400, outputTokens: prev.outputTokens + 50, chatCost: prev.chatCost + 0.0123 } as BookUsage;
  const prevModel = { ...emptyBucket(), ...(prev.models?.["gpt-5"] ?? {}) };
  merged.models = { ...(prev.models ?? {}), "gpt-5": { ...prevModel, inputTokens: prevModel.inputTokens + 400, outputTokens: prevModel.outputTokens + 50, chatCost: prevModel.chatCost + (delta.chatCost ?? 0) } };
  const edited: CostsFile = { ...costs, updatedAt: "2026-11-26T10:00:00.000Z", books: { ...costs.books, [bookId]: merged } };
  return serializeAccountRepository({ dirty: true, manifest: nextAccountManifest({ ...parsed.manifest, vectorClock }, "device-old"), data: { ...parsed.data, costs: edited } });
}

describe("the usage ledger in the account data that syncs", () => {
  it("travels in costs.json with the schema versions as they were: no client is made to refuse the data", async () => {
    const serialized = await serializeAccountRepository(snapshot(withLedger()));
    expect(ACCOUNT_SYNC_SCHEMA_VERSION).toBe(1);
    expect(serialized.manifest.schemaVersion).toBe(1);
    const costs = JSON.parse(serialized.files.get("costs.json")!) as CostsFile;
    expect(costs).toMatchObject({ version: 1, currency: "EUR" });
    expect(costs.ledger).toEqual(withLedger().ledger);
    // One line a row: the file stays small and readable.
    const rows = Object.values(costs.ledger!.writers)[0].rows;
    for (const [key, value] of Object.entries(rows)) expect(serialized.files.get("costs.json")).toContain(`${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  });

  it("comes back from the files and from a cloud envelope the same, with the content hash that was written", async () => {
    const serialized = await serializeAccountRepository(snapshot(withLedger()));
    const parsed = parseAccountRepositoryFiles(serialized.files);
    expect(parsed.data.costs).toEqual(withLedger());
    expect(await accountContentHash(parsed.data)).toBe(serialized.manifest.contentHash);
    const envelope = await accountSyncEnvelope(snapshot(withLedger()));
    expect(parseAccountSyncEnvelope(JSON.parse(JSON.stringify(envelope))).data.costs).toEqual(withLedger());
  });

  it("is covered by the content hash, so a copy that differs only in it is a different copy", async () => {
    const without = await serializeAccountRepository(snapshot(emptyCostsFile()));
    const withIt = await serializeAccountRepository(snapshot(withLedger()));
    expect(without.manifest.contentHash).not.toBe(withIt.manifest.contentHash);
  });

  describe("an older client, which knows nothing of the ledger, neither loses nor mangles it", () => {
    it("keeps it exactly while it records into the legacy totals", async () => {
      const first = await serializeAccountRepository(snapshot(withLedger()));
      const second = await olderClientRecords(first.files, { "device-new": 1 });
      const back = parseAccountRepositoryFiles(second.files).data.costs;
      expect(back.ledger).toEqual(withLedger().ledger);
      expect(JSON.parse(second.files.get("costs.json")!).ledger).toEqual(JSON.parse(first.files.get("costs.json")!).ledger);
      expect(back.books["me/book"].chatCost).toBeCloseTo(0.0421 + 0.0123, 12);
    });

    it("is still a valid copy for this version: the hash matches, the clock moves on, and what the older client spent is in the «earlier» part", async () => {
      const first = await serializeAccountRepository(snapshot(withLedger()));
      const second = await olderClientRecords(first.files, { "device-new": 1 });
      const parsed = parseAccountRepositoryFiles(second.files);
      expect(await accountContentHash(parsed.data)).toBe(second.manifest.contentHash);
      expect(compareAccountManifests(second.manifest, first.manifest)).toBe("ahead");
      const rows = usageRows(parsed.data.costs, "EUR");
      const euros = (list: typeof rows) => list.filter((row) => row.currency === "EUR").reduce((sum, row) => sum + row.cost, 0);
      expect(euros(rows)).toBeCloseTo(0.0421 + 0.0123, 12);
      expect(euros(rows.filter((row) => row.writer === EARLIER)), "the older client's call, once").toBeCloseTo(0.0123, 12);
      expect(rows.reduce((sum, row) => sum + row.calls, 0), "its calls were never counted: only this version's").toBe(5);
    });
  });
});
