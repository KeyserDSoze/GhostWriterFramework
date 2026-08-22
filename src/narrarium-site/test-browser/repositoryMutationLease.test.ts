import "fake-indexeddb/auto";
import { afterEach, expect, test } from "vitest";
import {
  acquireRepositoryMutationLease,
  releaseRepositoryMutationLease,
} from "@/repository/localRepository";

const repoId = `lease-test-${crypto.randomUUID()}`;

afterEach(async () => {
  // The lease is removed by each test; use a unique repository id so no
  // durable state can affect a later test or another browser context.
});

test("serializes a second context and ignores a stale release", async () => {
  const first = await acquireRepositoryMutationLease(repoId, "tab-a");
  let secondAcquired = false;
  const secondPromise = acquireRepositoryMutationLease(repoId, "tab-b").then((lease) => {
    secondAcquired = true;
    return lease;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(secondAcquired).toBe(false);

  await releaseRepositoryMutationLease(first);
  const second = await secondPromise;
  expect(second.fence).toBeGreaterThan(first.fence);

  await releaseRepositoryMutationLease(first);
  const thirdPromise = acquireRepositoryMutationLease(repoId, "tab-c");
  await new Promise((resolve) => setTimeout(resolve, 20));
  let thirdAcquired = false;
  void thirdPromise.then(() => { thirdAcquired = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(thirdAcquired).toBe(false);

  await releaseRepositoryMutationLease(second);
  await thirdPromise.then((third) => releaseRepositoryMutationLease(third));
});
