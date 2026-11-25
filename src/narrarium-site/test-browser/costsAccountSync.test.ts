import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalAccountSnapshot } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { resolveAccountReconciliation, syncAllAccountReplicas, useAccountSyncStore } from "@/account/accountSync";
import { localDeviceId, localWorkspaceScope } from "@/account/deviceIdentity";
import type { AccountRemoteSnapshot, AccountSyncManifest, LocalAccountSnapshot } from "@/account/types";
import { addToLedger, ledgerRows, ledgerWriterId, type UsageDelta } from "@/costs/ledger";
import { addToLegacy, coveredPart, usageRows } from "@/costs/legacyCosts";
import { useCostsStore } from "@/costs/costsStore";
import { emptyCostsFile, type CostsFile } from "@/costs/model";
import { flushPendingUsage, recordUsage } from "@/costs/recordUsage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { resetCosts } from "./helpers/costs";

const github = vi.hoisted(() => ({ pull: vi.fn(), push: vi.fn(), remove: vi.fn() }));
vi.mock("@/account/sync/githubBackend", () => ({
  GitHubAccountRepositoryUnreachableError: class extends Error { readonly code = "GITHUB_ACCOUNT_REPOSITORY_UNREACHABLE"; },
  GitHubAccountRepositoryChangedError: class extends Error { readonly code = "GITHUB_ACCOUNT_REPOSITORY_CHANGED"; },
  GitHubAccountSyncBackend: class {
    kind = "github" as const;
    pull = github.pull;
    push = github.push;
    deleteRemoteData = github.remove;
  },
}));

const OTHER = ledgerWriterId("device-b", "2026-10-01T00:00:00.000Z");
const AT = new Date(2026, 10, 25, 9);

/** A call that device B records in its own copy of the costs, as this version does (ledger and legacy totals). */
function otherDeviceRecords(costs: CostsFile, cost: number, bookId = "book-1"): CostsFile {
  const delta: UsageDelta = { key: { period: "2026-11-25", bookId, source: "copilot", capability: "copilot", integrationId: "int-1", model: "gpt-5-mini", currency: "EUR" }, counters: { calls: 1, tasks: 1, inputTokens: 100, outputTokens: 10, cost } };
  return addToLegacy({ ...costs, ledger: addToLedger(costs.ledger, OTHER, [delta], AT, "EUR") }, bookId, "The Glass Harbor", coveredPart({ ...delta.key, ...delta.counters }));
}

const CALL = { capability: "autopilot", origin: "autopilot" as const, task: "activity-1", integrationId: "int-1", model: "gpt-5", usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 100 }, usageKnown: true, costKnown: true, priced: true, currency: "EUR" };

async function thisDeviceRecords(cost: number): Promise<void> {
  recordUsage({ ...CALL, bookId: "book-1", bookName: "The Glass Harbor", cost, task: `activity-${cost}` });
  await flushPendingUsage();
}

function remoteOf(data: LocalAccountSnapshot["data"], vectorClock: Record<string, number>, snapshotId: string): AccountRemoteSnapshot {
  const manifest: AccountSyncManifest = { application: "Narrarium", schemaVersion: 1, snapshotId, modifiedAtUtc: "2026-11-25T09:00:00.000Z", modifiedByDeviceId: "device-b", vectorClock };
  return { backend: "github", data, manifest, revision: snapshotId };
}

const money = (costs: CostsFile | undefined) => usageRows(costs ?? emptyCostsFile(), "EUR").filter((row) => row.currency === "EUR").reduce((sum, row) => sum + row.cost, 0);
const writersOf = (costs: CostsFile | undefined) => Object.keys(costs?.ledger?.writers ?? {}).sort();
const pushedCosts = () => (github.push.mock.calls[github.push.mock.calls.length - 1]?.[0] as LocalAccountSnapshot | undefined)?.data.costs;

describe("the usage of two devices meets in the account data", () => {
  let base: LocalAccountSnapshot;

  beforeEach(async () => {
    closeAccountLocalStoreForTests();
    await new Promise<void>((resolve) => { const request = indexedDB.deleteDatabase("narrarium-local-account"); request.onsuccess = () => resolve(); request.onerror = () => resolve(); });
    localStorage.clear();
    resetCosts();
    useAccountSyncStore.setState({ syncing: false, reconciliation: null });
    useConnectionStore.setState({ hydrated: true, configuration: {} });
    // The person's currency is EUR: the «earlier» part of the legacy totals is counted in it.
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "EUR" }, accountIdentity: localWorkspaceScope() });
    github.pull.mockReset();
    github.push.mockReset().mockResolvedValue({ revision: "pushed" });
    // The copy both devices start from: 100 spent before the ledger existed.
    const legacy = { ...emptyCostsFile(), books: { "book-1": { bookId: "book-1", bookName: "The Glass Harbor", inputTokens: 0, cachedTokens: 0, outputTokens: 0, chatCost: 100, imageCount: 0, imageInputTextTokens: 0, imageCachedInputTextTokens: 0, imageInputImageTokens: 0, imageCachedInputImageTokens: 0, imageOutputTokens: 0, imageCost: 0, ttsChars: 0, ttsCost: 0, sttHours: 0, sttCost: 0 } } };
    base = await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: legacy, clipboard: [], chats: [] });
    useCostsStore.getState().hydrate(base.data.costs);
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", identity: { provider: "github", providerAccountId: "1", displayName: "Writer", username: "writer" }, token: "token", rememberMe: true, accountSyncEnabled: true });
  });

  async function divergedCopies() {
    // Offline, this device spends 10 and device B spends 20 from the same copy.
    await thisDeviceRecords(10);
    const local = (await loadLocalAccountSnapshot())!;
    const remoteCosts = otherDeviceRecords(base.data.costs, 20);
    const remote = remoteOf({ ...base.data, costs: remoteCosts }, { ...base.manifest.vectorClock, "device-b": 1 }, "remote-b");
    github.pull.mockResolvedValue(remote);
    const result = await syncAllAccountReplicas();
    expect(result.reconciliation, "the copies diverged: the person is asked which to keep").toBe(true);
    return { local, remote };
  }

  for (const choice of ["github", "local"] as const) {
    it(`keeps the usage of both devices, once each, when the person keeps the ${choice === "github" ? "other device's" : "local"} copy`, async () => {
      await divergedCopies();
      await resolveAccountReconciliation(choice);
      const kept = (await loadLocalAccountSnapshot())!.data.costs;
      expect(writersOf(kept)).toEqual([OTHER, Object.keys(kept.ledger!.writers).find((id) => id.startsWith(localDeviceId()))!].sort());
      expect(money(kept), "100 earlier + 10 here + 20 there").toBeCloseTo(130, 9);
      expect(kept.books["book-1"].chatCost, "and the legacy totals that older clients read").toBeCloseTo(130, 9);
      expect(ledgerRows(kept.ledger).reduce((sum, row) => sum + row.calls, 0)).toBe(2);
      expect(money(pushedCosts()), "the copy sent to GitHub is the merged one").toBeCloseTo(130, 9);
    });
  }

  it("adopts a newer copy that already holds this device's usage as it is, without a new version", async () => {
    await thisDeviceRecords(10);
    const local = (await loadLocalAccountSnapshot())!;
    const remoteCosts = otherDeviceRecords(local.data.costs, 20);
    const remote = remoteOf({ ...local.data, costs: remoteCosts }, { ...local.manifest.vectorClock, "device-b": 1 }, "remote-newer");
    github.pull.mockResolvedValue(remote);
    await syncAllAccountReplicas();
    const after = (await loadLocalAccountSnapshot())!;
    expect(after.manifest.snapshotId, "adopted: the remote's own version").toBe("remote-newer");
    expect(money(after.data.costs)).toBeCloseTo(130, 9);
    expect(github.push).not.toHaveBeenCalled();
  });

  it("gives back to a newer copy the usage of this device that it lost, as a new version that is pushed", async () => {
    await thisDeviceRecords(10);
    await thisDeviceRecords(5);
    const local = (await loadLocalAccountSnapshot())!;
    // An older client chose the other copy whole: its clock is past this device's, but this device's part is not in its costs.
    const remoteCosts = otherDeviceRecords(base.data.costs, 20);
    const remote = remoteOf({ ...base.data, costs: remoteCosts }, { ...local.manifest.vectorClock, "device-b": 4 }, "older-client-choice");
    github.pull.mockResolvedValue(remote);
    await syncAllAccountReplicas();
    const after = (await loadLocalAccountSnapshot())!;
    expect(after.manifest.snapshotId).not.toBe("older-client-choice");
    expect(money(after.data.costs), "100 + 10 + 5 here + 20 there").toBeCloseTo(135, 9);
    expect(after.data.costs.books["book-1"].chatCost).toBeCloseTo(135, 9);
    expect(github.push).toHaveBeenCalledOnce();
    expect(money(pushedCosts())).toBeCloseTo(135, 9);
  });
});
