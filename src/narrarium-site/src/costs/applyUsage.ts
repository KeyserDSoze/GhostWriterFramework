import { addToLedger } from "@/costs/ledger";
import { addToLegacy, coveredPart } from "@/costs/legacyCosts";
import type { CostsFile } from "@/costs/model";
import type { PendingUsage } from "@/costs/recordUsage";

/**
 * How records become costs: each in the ledger as part of `writerId`, and in the legacy totals of its book by the one rule of both (`coveredPart`).
 * Loaded with the first record (`recordUsage.ts`), so that the ledger is not part of what the app loads before it records anything.
 */
export function withRecords(file: CostsFile, records: readonly PendingUsage[], writerId: string): CostsFile {
  let next = file;
  for (const entry of records) {
    next = { ...next, ledger: addToLedger(next.ledger, writerId, [entry.delta], entry.at, entry.currency) };
    next = addToLegacy(next, entry.bookId, entry.bookName, coveredPart({ ...entry.delta.key, ...entry.delta.counters }), entry.legacy);
  }
  return next === file ? file : { ...next, updatedAt: (records[records.length - 1]?.at ?? new Date()).toISOString() };
}
