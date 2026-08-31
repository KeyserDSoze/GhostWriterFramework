import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";
import {
  accountContentHash,
  compareAccountManifests,
  compareVectorClocks,
  initialAccountManifest,
  nextAccountManifest,
  reconciledAccountManifest,
  validateAccountManifest,
} from "@/account/vectorClock";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type SyncableAccountData } from "@/account/types";

describe("account vector clocks", () => {
  beforeEach(() => localStorage.clear());

  it("classifies equal, dominating and concurrent clocks without timestamps", () => {
    expect(compareVectorClocks({ a: 1 }, { a: 1 })).toBe("same");
    expect(compareVectorClocks({ a: 2, b: 1 }, { a: 1, b: 1 })).toBe("ahead");
    expect(compareVectorClocks({ a: 1 }, { a: 2 })).toBe("behind");
    expect(compareVectorClocks({ a: 2 }, { a: 1, b: 1 })).toBe("diverged");
  });

  it("increments only the current device and persists UTC timestamps", () => {
    const initial = initialAccountManifest("device-a", "2026-08-31T14:37:42.581+02:00");
    const next = nextAccountManifest(initial, "device-a", "2026-08-31T12:38:00.000Z");
    expect(next.vectorClock).toEqual({ "device-a": 1 });
    expect(next.modifiedAtUtc).toBe("2026-08-31T12:38:00.000Z");
    expect(next.modifiedAtUtc.endsWith("Z")).toBe(true);
    expect(validateAccountManifest(next)).toEqual(next);
  });

  it("creates a convergent reconciliation version from concurrent replicas", () => {
    const first = { ...initialAccountManifest("a"), vectorClock: { a: 4, b: 1 } };
    const second = { ...initialAccountManifest("b"), vectorClock: { a: 2, b: 7 } };
    const reconciled = reconciledAccountManifest([first, second], "c");
    expect(reconciled.vectorClock).toEqual({ a: 4, b: 7, c: 1 });
    expect(compareAccountManifests(reconciled, first)).toBe("ahead");
    expect(compareAccountManifests(reconciled, second)).toBe("ahead");
  });

  it("detects same-clock data corruption through deterministic content hashes", async () => {
    const data: SyncableAccountData = { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] };
    const reordered = { chats: [], clipboard: [], costs: data.costs, settings: data.settings, schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION } as SyncableAccountData;
    expect(await accountContentHash(data)).toBe(await accountContentHash(reordered));
    const manifest = { ...initialAccountManifest("a"), contentHash: await accountContentHash(data) };
    const changed = { ...manifest, contentHash: "0".repeat(64) };
    expect(compareAccountManifests(manifest, changed)).toBe("diverged");
  });
});
