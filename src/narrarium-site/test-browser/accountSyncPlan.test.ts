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

  it("adopts the newest replica and updates the others, without asking, when only some replicas lag", () => {
    const plan = planAccountSync(local({ a: 2 }), [
      remote("onedrive", { a: 2 }, "old"),
      remote("google-drive", { a: 3 }, "new"),
      remote("github", { a: 2 }, "old"),
    ]);
    expect(plan).toMatchObject({ action: "pull-remote", authoritativeRemote: "google-drive" });
  });

  it("pushes, and does not ask again, when this device is ahead of replicas that differ from each other", () => {
    // What is left after choosing «the newest copy»: this device dominates both replicas, which are still different from one another.
    const plan = planAccountSync(local({ a: 3, b: 1 }), [
      remote("github", { a: 2 }, "github-old"),
      remote("google-drive", { a: 1 }, "drive-older"),
    ]);
    expect(plan.action).toBe("push-local");
  });

  it("takes the newest of several replicas that are newer than this device, whatever their order", () => {
    const behind = remote("github", { a: 3 }, "mid");
    const newest = remote("google-drive", { a: 4 }, "top");
    expect(planAccountSync(local({ a: 2 }), [behind, newest])).toMatchObject({ action: "pull-remote", authoritativeRemote: "google-drive" });
    expect(planAccountSync(local({ a: 2 }), [newest, behind])).toMatchObject({ action: "pull-remote", authoritativeRemote: "google-drive" });
  });

  it("still requires a decision when two replicas newer than this device conflict with each other", () => {
    const plan = planAccountSync(local({ a: 2 }), [remote("google-drive", { a: 3 }, "left"), remote("github", { a: 2, b: 1 }, "right")]);
    expect(plan.action).toBe("reconcile");
  });

  it("still requires a decision when a replica changed on its own since this device", () => {
    expect(planAccountSync(local({ a: 3 }), [remote("github", { a: 2, b: 1 })]).action).toBe("reconcile");
  });

  it("never chooses between concurrent vector clocks using wall-clock time", () => {
    const left = local({ a: 2 });
    left.manifest.modifiedAtUtc = "2030-01-01T00:00:00.000Z";
    const right = remote("github", { b: 2 });
    right.manifest.modifiedAtUtc = "2020-01-01T00:00:00.000Z";
    expect(planAccountSync(left, [right]).action).toBe("reconcile");
  });
});
