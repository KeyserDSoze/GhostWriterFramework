import { afterEach, describe, expect, it } from "vitest";
import { resetTokenRefreshLockForTests, withTokenRefreshLock } from "@/account/tokenRefreshLock";
import { installFakeLocks, type FakeLocks } from "./oauthTestKit";

let locks: FakeLocks | null = null;

afterEach(() => {
  locks?.uninstall();
  locks = null;
  resetTokenRefreshLockForTests();
});

/** Runs `count` jobs for a provider and reports the order in which they started and ended. */
async function runJobs(provider: "google" | "microsoft", count: number): Promise<string[]> {
  const events: string[] = [];
  await Promise.all(Array.from({ length: count }, (_unused, index) => withTokenRefreshLock(provider, async () => {
    events.push(`start ${index}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`end ${index}`);
  })));
  return events;
}

const oneAtATime = (count: number) => Array.from({ length: count }, (_unused, index) => [`start ${index}`, `end ${index}`]).flat();

describe("a single token renewal at a time", () => {
  it("takes the Web Lock called narrarium-token-refresh:<provider>, exclusively", async () => {
    locks = installFakeLocks();
    await withTokenRefreshLock("google", async () => undefined);
    await withTokenRefreshLock("microsoft", async () => undefined);
    expect(locks.requests).toEqual([
      { name: "narrarium-token-refresh:google", mode: "exclusive" },
      { name: "narrarium-token-refresh:microsoft", mode: "exclusive" },
    ]);
  });

  it("lets jobs for the same provider run one after the other", async () => {
    locks = installFakeLocks();
    expect(await runJobs("google", 3)).toEqual(oneAtATime(3));
  });

  it("does not make Google wait for Microsoft", async () => {
    locks = installFakeLocks();
    let releaseGoogle!: () => void;
    const google = withTokenRefreshLock("google", () => new Promise<void>((resolve) => { releaseGoogle = resolve; }));
    await expect(withTokenRefreshLock("microsoft", async () => "microsoft done")).resolves.toBe("microsoft done");
    releaseGoogle();
    await google;
  });

  it("hands back the job's answer, rethrows its failure, and still lets the next job run", async () => {
    locks = installFakeLocks();
    await expect(withTokenRefreshLock("google", async () => 42)).resolves.toBe(42);
    await expect(withTokenRefreshLock("google", async () => { throw new Error("refresh failed"); })).rejects.toThrow("refresh failed");
    await expect(withTokenRefreshLock("google", async () => "next")).resolves.toBe("next");
  });

  it("still serializes the jobs of this tab when the browser has no Web Locks", async () => {
    expect((navigator as unknown as { locks?: unknown }).locks).toBeUndefined();
    expect(await runJobs("google", 3)).toEqual(oneAtATime(3));
  });

  it("does not let a failed job poison the in-tab queue when there are no Web Locks", async () => {
    await expect(withTokenRefreshLock("google", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withTokenRefreshLock("google", async () => "fine")).resolves.toBe("fine");
  });

  it("falls back the same way when a lock manager exists but cannot be used", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: {} });
    try {
      expect(await runJobs("google", 2)).toEqual(oneAtATime(2));
    } finally {
      delete (navigator as unknown as { locks?: unknown }).locks;
    }
  });
});
