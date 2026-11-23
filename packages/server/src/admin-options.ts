/**
 * What a test can set in the admin panel's own views, to shorten what is long or to say what the computer would. Every one has a default that is the one to run with.
 */
export interface AdminPanelOptions {
  /** How long a run may say nothing before the panel says that it looks stalled (default ten minutes). */
  stalledAfterMs?: number;
  /** The free and the whole space of the file system the data folder is on, in bytes (default: what the system says). */
  disk?: () => Promise<{ free: number; total: number } | undefined>;
  /** How many updates the history keeps (default twenty). */
  historyMax?: number;
  /** How long the health report waits for the release check before it tells the versions as "no answer yet" (default four seconds). */
  releaseWaitMs?: number;
}
