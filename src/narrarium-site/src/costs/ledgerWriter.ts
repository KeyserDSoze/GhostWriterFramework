/**
 * Who writes in the usage ledger: a device and the local account store it writes in, which starts with the store (`createdAt`). A store made again (its
 * data was cleared, the account data deleted) is a new writer, so it never meets the numbering of the part it had before (see THE MERGE RULE in
 * `ledger.ts`). On its own so that the account store can name its writer without loading the ledger.
 */
export function ledgerWriterId(deviceId: string, createdAt: string): string {
  return `${deviceId}@${createdAt}`;
}
