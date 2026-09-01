import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { AccountCredentialError, useConnectionStore } from "@/account/connectionStore";
import { closeAccountLocalStoreForTests, loadLocalSyncConfiguration } from "@/account/accountLocalStore";
import { acquireMicrosoftConnectionToken } from "@/account/microsoftConnectionToken";
import { useAuthStore } from "@/store/authStore";

const msal = vi.hoisted(() => {
  const client = {
    getAllAccounts: vi.fn(),
    acquireTokenSilent: vi.fn(),
    setActiveAccount: vi.fn(),
  };
  return {
    client,
    instance: vi.fn(() => client),
    initialize: vi.fn(),
    silentRequest: vi.fn((account: unknown) => ({ account, scopes: ["User.Read", "Files.ReadWrite"] })),
  };
});

vi.mock("@/config/msal", () => ({
  microsoftMsalInstance: msal.instance,
  ensureMsalInitialized: msal.initialize,
  microsoftSilentRequest: msal.silentRequest,
  findMicrosoftAccountIn: (input: { homeAccountId?: string; localAccountId?: string }, accounts: Array<{ homeAccountId: string; localAccountId: string }>) =>
    accounts.find((account) => account.homeAccountId === input.homeAccountId && account.localAccountId === input.localAccountId) ?? null,
}));

const account = { homeAccountId: "home-1", localAccountId: "local-1", username: "writer@example.com" };

describe("Microsoft connection token refresh", () => {
  beforeEach(async () => {
    closeAccountLocalStoreForTests();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("narrarium-local-account");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
    localStorage.clear();
    sessionStorage.clear();
    useConnectionStore.setState({ hydrated: true, configuration: {} });
    useAuthStore.setState({ accessToken: null, accessTokenExpiry: null, provider: null, providerAccountId: null, user: null, rememberMe: false });
    msal.instance.mockClear().mockReturnValue(msal.client);
    msal.initialize.mockReset().mockResolvedValue(undefined);
    msal.silentRequest.mockClear();
    msal.client.getAllAccounts.mockReset().mockReturnValue([account]);
    msal.client.acquireTokenSilent.mockReset();
    msal.client.setActiveAccount.mockReset();
    await useConnectionStore.getState().connectMicrosoft({
      identity: { provider: "microsoft", providerAccountId: account.homeAccountId, displayName: "Writer" },
      accessToken: "expired-token",
      accessTokenExpiry: Date.now() - 1,
      homeAccountId: account.homeAccountId,
      localAccountId: account.localAccountId,
      rememberMe: true,
    });
  });

  it("silently renews and persists the token bound to the connected Microsoft identity", async () => {
    const expiresOn = new Date(Date.now() + 3_600_000);
    msal.client.acquireTokenSilent.mockResolvedValue({ accessToken: "fresh-token", expiresOn, account });

    await expect(acquireMicrosoftConnectionToken()).resolves.toBe("fresh-token");

    expect(msal.instance).toHaveBeenCalledWith(true);
    expect(msal.initialize).toHaveBeenCalledWith(msal.client);
    expect(msal.client.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ account, forceRefresh: true }));
    expect(msal.client.setActiveAccount).toHaveBeenCalledWith(account);
    expect(useConnectionStore.getState().configuration.microsoft).toMatchObject({ accessToken: "fresh-token" });
    expect((await loadLocalSyncConfiguration()).microsoft).toMatchObject({ accessToken: "fresh-token" });
  });

  it("requests explicit reauthentication only when MSAL requires interaction", async () => {
    msal.client.acquireTokenSilent.mockRejectedValue({ errorCode: "interaction_required" });

    const error = await acquireMicrosoftConnectionToken().catch((cause) => cause);
    expect(error).toBeInstanceOf(AccountCredentialError);
    expect(error).toMatchObject({ backend: "onedrive", reason: "expired" });
  });

  it("preserves non-authentication failures instead of turning them into a login request", async () => {
    const failure = new TypeError("network unavailable");
    msal.client.acquireTokenSilent.mockRejectedValue(failure);

    await expect(acquireMicrosoftConnectionToken()).rejects.toBe(failure);
  });
});
