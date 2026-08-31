import { describe, expect, it } from "vitest";
import { planAccountSync } from "@/account/accountSync";
import { initialAccountManifest } from "@/account/vectorClock";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type AccountRemoteSnapshot, type LocalAccountSnapshot } from "@/account/types";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";

const data = { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] };
const local = (clock: Record<string, number>): LocalAccountSnapshot => ({ data, manifest: { ...initialAccountManifest("local"), vectorClock: clock }, dirty: true });
const remote = (backend: AccountRemoteSnapshot["backend"], clock: Record<string, number>, snapshotId: string = backend): AccountRemoteSnapshot => ({ backend, data, manifest: { ...initialAccountManifest(backend), snapshotId, vectorClock: clock } });

describe("multi-replica account sync planning", () => {
  it("pushes a local version that dominates every replica", () => {
    expect(planAccountSync(local({ a: 4, b: 2 }), [remote("google-drive", { a: 3, b: 2 })]).action).toBe("push-local");
  });

  it("pulls the sole causally newer replica", () => {
    const plan = planAccountSync(local({ a: 2 }), [remote("google-drive", { a: 3 })]);
    expect(plan).toMatchObject({ action: "pull-remote", authoritativeRemote: "google-drive" });
  });

  it("requires a decision when enabled providers hold different snapshots", () => {
    const plan = planAccountSync(local({ a: 2 }), [
      remote("google-drive", { a: 3 }, "new"),
      remote("onedrive", { a: 2 }, "old"),
      remote("github", { a: 2 }, "old"),
    ]);
    expect(plan.action).toBe("reconcile");
    expect(plan.comparisons).toEqual(expect.arrayContaining([
      { backend: "google-drive", comparison: "behind" },
      { backend: "onedrive", comparison: "same" },
    ]));
  });

  it("never chooses between concurrent vector clocks using wall-clock time", () => {
    const left = local({ a: 2 });
    left.manifest.modifiedAtUtc = "2030-01-01T00:00:00.000Z";
    const right = remote("github", { b: 2 });
    right.manifest.modifiedAtUtc = "2020-01-01T00:00:00.000Z";
    expect(planAccountSync(left, [right]).action).toBe("reconcile");
  });
});
