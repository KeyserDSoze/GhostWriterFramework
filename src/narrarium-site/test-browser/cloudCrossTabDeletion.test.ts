import { expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

it("drains a slow write in another module context before deletion takes ownership", async () => {
  vi.resetModules();
  const tabA = await import("@/drive/cloudWriteBarrier");
  vi.resetModules();
  const tabB = await import("@/drive/cloudWriteBarrier");
  const token = `cross-tab-${crypto.randomUUID()}`;
  const identity = `writer-${crypto.randomUUID()}`;
  tabA.registerCloudAccount("google", token, identity);
  tabB.registerCloudAccount("google", token, identity);

  const releaseA = await tabA.acquireCloudWriteLease("google", token);
  let finishWrite!: () => void;
  const providerResponse = new Promise<Response>((resolve) => { finishWrite = () => resolve(new Response(null, { status: 204 })); });
  vi.stubGlobal("fetch", vi.fn(() => providerResponse));
  const write = tabA.fencedCloudMutation("google", token, "https://example.test/slow-write", { method: "POST" });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

  let deletionOwned = false;
  const deletionPromise = tabB.suspendCloudWrites("google", token).then((handle) => { deletionOwned = true; return handle; });
  await vi.waitFor(async () => expect(await tabB.cloudWritesSuspended("google", token)).toBe(true));
  await expect(tabB.acquireCloudWriteLease("google", token)).rejects.toThrow(/suspended/);
  await new Promise((resolve) => setTimeout(resolve, 75));
  expect(deletionOwned).toBe(false);

  finishWrite();
  await expect(write).resolves.toMatchObject({ status: 204 });
  await releaseA();
  const deletion = await deletionPromise;
  expect(deletionOwned).toBe(true);
  await tabB.completeCloudDeletionNothingToDelete(deletion, "Test cleanup after drained write.");
  await tabB.resumeCloudWrites("google", token, deletion.operationId);
  vi.unstubAllGlobals();
});
