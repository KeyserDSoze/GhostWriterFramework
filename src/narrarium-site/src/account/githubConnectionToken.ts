import { accountBackendToken } from "@/account/connectionStore";
import { useConnectionStore } from "@/account/connectionStore";
import type { AcquireOptions } from "@/account/brokerAccessToken";

/**
 * The access token for syncing the account with GitHub (the `narrarium.settings` repository).
 *
 * A personal access token is used as it is. The token of the GitHub App lasts 8 hours: it is renewed through the broker when it has less than a minute
 * left (the code for that is loaded only for such a connection), and a sync that GitHub refused as expired is repeated with a renewed one.
 */
export async function acquireGitHubConnectionToken(options: AcquireOptions = {}): Promise<string> {
  if (useConnectionStore.getState().configuration.github?.credentialKind === "app") {
    const { acquireGitHubAppToken } = await import("@/account/githubAppToken");
    return acquireGitHubAppToken(options);
  }
  return accountBackendToken("github");
}
