import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { closeCredentialVaultForTests } from "@/account/credentialVault";
import { prepareLegacyGoogleChatImport } from "@/account/legacyGoogleChatImport";
import { resetTokenRefreshLockForTests } from "@/account/tokenRefreshLock";
import { emptyCostsFile } from "@/costs/model";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BROKER_BASE, SECRETS, createFakeNetwork, deleteDatabases, type FakeNetwork } from "./oauthTestKit";

const cloud = vi.hoisted(() => ({ list: vi.fn(), load: vi.fn(), hydrate: vi.fn() }));
vi.mock("@/assistant/chatCloud", () => ({ listAssistantSessionsStrict: cloud.list, loadAssistantSession: cloud.load, hydrateAssistantSessionArchive: cloud.hydrate }));
vi.mock("@/assistant/sessionIndex", () => ({ refreshAssistantSessionIndex: vi.fn().mockResolvedValue(undefined) }));

let net: FakeNetwork;

beforeEach(async () => {
  closeAccountLocalStoreForTests();
  closeCredentialVaultForTests();
  await deleteDatabases("narrarium-local-account", "narrarium-credential-vault");
  resetBrokerAvailabilityForTests();
  resetTokenRefreshLockForTests();
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
  cloud.list.mockReset().mockResolvedValue([]);
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeCredentialVaultForTests();
});

describe("reading the old Google Drive chats with long-lived credentials", () => {
  it("renews an expired access token first, so the import does not ask for a new login", async () => {
    net.reply("POST", `${BROKER_BASE}/oauth/google/refresh`, { accessToken: SECRETS.accessFresh, expiresIn: 3599 });
    await useConnectionStore.getState().connectGoogle({ identity: { provider: "google", providerAccountId: "google-1", displayName: "Writer" }, accessToken: SECRETS.access, accessTokenExpiry: Date.now() - 1_000, rememberMe: true, refreshToken: SECRETS.refresh });

    await prepareLegacyGoogleChatImport();

    expect(cloud.list).toHaveBeenCalledWith("google", SECRETS.accessFresh);
  });
});
