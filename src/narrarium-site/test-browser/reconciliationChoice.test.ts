import { describe, expect, it } from "vitest";
import { newestReconciliationCandidate, rankReconciliationCandidates, type ReconciliationChoiceInput } from "@/account/reconciliationChoice";
import type { AccountSyncBackendKind } from "@/account/types";
import { initialAccountManifest } from "@/account/vectorClock";

function copy(id: "local" | AccountSyncBackendKind, modifiedAtUtc: string, vectorClock: Record<string, number>, snapshotId: string = id): ReconciliationChoiceInput {
  return { id, snapshot: { manifest: { ...initialAccountManifest("device"), snapshotId, modifiedAtUtc, vectorClock } } };
}

describe("which copy of the account is the newest", () => {
  it("is the one changed last", () => {
    const candidates = [copy("local", "2026-11-20T10:00:00.000Z", { a: 2 }), copy("github", "2026-11-22T10:00:00.000Z", { b: 3 }), copy("google-drive", "2026-11-21T10:00:00.000Z", { c: 1 })];
    expect(newestReconciliationCandidate(candidates)).toBe("github");
    expect(rankReconciliationCandidates(candidates).map((entry) => entry.id)).toEqual(["github", "google-drive", "local"]);
    expect(rankReconciliationCandidates(candidates).filter((entry) => entry.newest)).toHaveLength(1);
  });

  it("compares instants, not the way the dates are written", () => {
    const candidates = [copy("local", "2026-11-22T00:30:00.000+02:00", { a: 1 }), copy("github", "2026-11-21T23:00:00.000Z", { b: 1 })];
    expect(newestReconciliationCandidate(candidates)).toBe("github");
  });

  it("never proposes a copy that another copy has already caught up with, whatever its date says", () => {
    const behindWithLateDate = copy("onedrive", "2030-01-01T00:00:00.000Z", { a: 1 });
    const ahead = copy("github", "2026-11-22T10:00:00.000Z", { a: 2 });
    const ranking = rankReconciliationCandidates([behindWithLateDate, ahead, copy("local", "2026-11-21T10:00:00.000Z", { z: 1 })]);
    expect(ranking.find((entry) => entry.id === "onedrive")).toMatchObject({ superseded: true, newest: false });
    expect(ranking[0]).toMatchObject({ id: "github", newest: true, superseded: false });
  });

  it("settles a tie on the very same instant for this device first, then GitHub, Google Drive and OneDrive", () => {
    const when = "2026-11-22T10:00:00.000Z";
    const clocks = { onedrive: { d: 1 }, "google-drive": { c: 1 }, github: { b: 1 }, local: { a: 1 } } as const;
    const all = (["onedrive", "google-drive", "github", "local"] as const).map((id) => copy(id, when, { ...clocks[id] }));
    expect(rankReconciliationCandidates(all).map((entry) => entry.id)).toEqual(["local", "github", "google-drive", "onedrive"]);
    expect(newestReconciliationCandidate(all.filter((entry) => entry.id !== "local"))).toBe("github");
    expect(newestReconciliationCandidate(all.filter((entry) => entry.id === "google-drive" || entry.id === "onedrive"))).toBe("google-drive");
  });

  it("gives the same answer whatever the order the copies are listed in", () => {
    const candidates = [copy("local", "2026-11-22T10:00:00.000Z", { a: 1 }), copy("github", "2026-11-22T10:00:00.000Z", { b: 1 }), copy("google-drive", "2026-11-21T10:00:00.000Z", { c: 1 }), copy("onedrive", "bad date", { d: 1 })];
    const expected = rankReconciliationCandidates(candidates).map((entry) => entry.id);
    for (const order of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) expect(rankReconciliationCandidates(order.map((index) => candidates[index])).map((entry) => entry.id)).toEqual(expected);
  });

  it("settles two copies of the same instant and kind by their snapshot id", () => {
    const when = "2026-11-22T10:00:00.000Z";
    const a = copy("github", when, { x: 1 }, "snapshot-a");
    const b = copy("github", when, { y: 1 }, "snapshot-b");
    expect(rankReconciliationCandidates([b, a])[0].newest).toBe(true);
    expect(rankReconciliationCandidates([b, a]).map((entry) => entry.modifiedAtMs)).toEqual([Date.parse(when), Date.parse(when)]);
    expect(rankReconciliationCandidates([b, a])).toEqual(rankReconciliationCandidates([a, b]));
  });

  it("ranks a copy without a readable date last, and says so", () => {
    const ranking = rankReconciliationCandidates([copy("github", "someday", { a: 1 }), copy("local", "2001-01-01T00:00:00.000Z", { b: 1 })]);
    expect(ranking.map((entry) => entry.id)).toEqual(["local", "github"]);
    expect(ranking[1].modifiedAtMs).toBeNull();
    expect(newestReconciliationCandidate([copy("github", "someday", { a: 1 }), copy("onedrive", "never", { b: 1 })])).toBe("github");
  });

  it("has nothing to propose when there is nothing to choose from", () => {
    expect(newestReconciliationCandidate([])).toBeNull();
  });
});
