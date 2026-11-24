import type { LocalGitHubConnection } from "@/account/types";

/**
 * Whether a GitHub connection that is being made syncs the account (the private narrarium.settings repository). A connection that does not exist yet
 * syncs by itself, with the app and with a personal access token alike. A connection for the same GitHub account that is already here keeps the choice
 * the owner has made for it: one who switched it off stays off when signing in again. Another account starts afresh.
 */
export function accountSyncForNewGitHubConnection(existing: Pick<LocalGitHubConnection, "accountSyncEnabled" | "identity"> | undefined, accountId: string): boolean {
  return existing?.identity?.providerAccountId === accountId ? existing.accountSyncEnabled : true;
}
