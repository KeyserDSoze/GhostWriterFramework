import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { closeCredentialVaultForTests, loadRefreshToken } from "@/account/credentialVault";
import { deleteAllNarrariumLocalData } from "@/account/dataSafety";
import { emptyCostsFile } from "@/costs/model";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BROKER_BASE, SECRETS, createFakeNetwork, deleteDatabases, dumpIndexedDb, jsonResponse, type FakeNetwork } from "./oauthTestKit";

vi.mock("@/repository/localRepository", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/repository/localRepository")>()), deleteAllLocalRepositoryData: vi.fn(async () => undefined) }));
vi.mock("@/repository/localRewriteOperationStore", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/repository/localRewriteOperationStore")>()), deleteAllLocalRewriteOperationData: vi.fn(async () => undefined) }));
vi.mock("@/drive/cloudWriteBarrier", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/drive/cloudWriteBarrier")>()), deleteLocalCloudWriteBarrierData: vi.fn(async () => undefined) }));
vi.mock("@/config/msal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/config/msal")>()), clearMicrosoftAuthCaches: vi.fn(async () => undefined) }));

const HOME = "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42.72f988bf-86f1-41af-91ab-2d7cd011db47";
const REVOKE = `${BROKER_BASE}/oauth/google/revoke`;
let net: FakeNetwork;

const connectBoth = async (google: Record<string, unknown> = {}) => {
  await useConnectionStore.getState().connectGoogle({ identity: { provider: "google", providerAccountId: "g-1", displayName: "Writer" }, accessToken: SECRETS.access, rememberMe: true, refreshToken: SECRETS.refresh, ...google });
  await useConnectionStore.getState().connectMicrosoft({ identity: { provider: "microsoft", providerAccountId: HOME, displayName: "Writer" }, homeAccountId: HOME, localAccountId: HOME.split(".")[0], accessToken: SECRETS.access, rememberMe: true, refreshToken: SECRETS.refreshRotated });
};

beforeEach(async () => {
  closeAccountLocalStoreForTests();
  closeCredentialVaultForTests();
  await deleteDatabases("narrarium-local-account", "narrarium-credential-vault");
  localStorage.clear();
  sessionStorage.clear();
  resetBrokerAvailabilityForTests();
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeCredentialVaultForTests();
});

describe("deleting every local Narrarium datum", () => {
  it("revokes the long-lived Google credentials and removes every stored refresh token and the key that sealed them", async () => {
    net.on("POST", REVOKE, () => jsonResponse(null, 204));
    await connectBoth();
    expect(await dumpIndexedDb("narrarium-credential-vault")).not.toBe("");

    await deleteAllNarrariumLocalData("DELETE");

    expect(net.broker("/oauth/google/revoke")).toHaveLength(1);
    expect(net.broker("/oauth/google/revoke")[0].body).toEqual({ token: SECRETS.refresh });
    expect((await indexedDB.databases()).map((entry) => entry.name)).not.toContain("narrarium-credential-vault");
    expect((await indexedDB.databases()).map((entry) => entry.name)).not.toContain("narrarium-local-account");
    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();
    await expect(loadRefreshToken("microsoft", HOME)).resolves.toBeNull();
  });

  it("does not ask Microsoft to revoke anything: there is no way to do it from here", async () => {
    await connectBoth({ refreshToken: undefined });
    await deleteAllNarrariumLocalData("DELETE");
    expect(net.calls).toHaveLength(0);
  });

  it("still deletes everything when the revocation fails", async () => {
    await connectBoth();
    await expect(deleteAllNarrariumLocalData("DELETE")).resolves.toBeUndefined();
    expect((await indexedDB.databases()).map((entry) => entry.name)).not.toContain("narrarium-credential-vault");
    expect((await indexedDB.databases()).map((entry) => entry.name)).not.toContain("narrarium-local-account");
  });

  it("keeps the refresh tokens out of what is left in memory", async () => {
    await connectBoth();
    await deleteAllNarrariumLocalData("DELETE");
    expect(JSON.stringify(useConnectionStore.getState().configuration)).not.toContain(SECRETS.refresh);
    expect(JSON.stringify(useConnectionStore.getState().configuration)).not.toContain(SECRETS.refreshRotated);
  });

  it("still asks for the exact confirmation first, and touches nothing without it", async () => {
    await connectBoth();
    await expect(deleteAllNarrariumLocalData("delete")).rejects.toThrow(/DELETE/);
    expect(net.calls).toHaveLength(0);
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
  });
});
