import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { acquireCloudWriteLease, beginCloudWrite, cloudWritesSuspended, completeCloudDeletion, completeCloudDeletionNothingToDelete, completeCloudDeletionTargetForTests, completedCloudDeletionGeneration, failCloudDeletion, fencedCloudDeletionMutation, registerCloudAccount, resumeCloudWrites, simulateCloudDeletionReloadForTests, suspendCloudWrites } from "../src/drive/cloudWriteBarrier.ts";

async function completeNonemptyDeletion(handle) {
  await completeCloudDeletionTargetForTests(handle);
  await completeCloudDeletion(handle, true);
}

async function completeEmptyDeletion(handle) {
  await completeCloudDeletionNothingToDelete(handle, "No verified owned folder exists in this test.");
  await completeCloudDeletion(handle, false);
}

test("deletion suspension waits for active writes to drain", async () => {
  const token = "drain-token";
  const endFirst = await beginCloudWrite("google", token);
  let suspended = false;
  let deletion;
  const waiting = suspendCloudWrites("google", token).then((handle) => { deletion = handle; suspended = true; });
  for (let attempt = 0; attempt < 20 && !await cloudWritesSuspended("google", token); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(suspended, false);
  assert.equal(await cloudWritesSuspended("google", token), true);
  endFirst();
  await waiting;
  assert.equal(suspended, true);
  await completeEmptyDeletion(deletion);
});

test("new autosaves fail while deletion keeps the account suspended", async () => {
  const token = "blocked-token";
  registerCloudAccount("google", token, "blocked-account");
  const deletion = await suspendCloudWrites("google", token);
  await assert.rejects(() => beginCloudWrite("google", token), /Cloud writes are suspended/);
  await completeNonemptyDeletion(deletion);
  await resumeCloudWrites("google", token, await completedCloudDeletionGeneration("google", token));
  const end = await beginCloudWrite("google", token);
  end();
});

test("write barriers are isolated by provider and account token", async () => {
  const token = "isolated-token";
  registerCloudAccount("google", token, "isolated-account");
  const deletion = await suspendCloudWrites("google", token);
  const endMicrosoft = await beginCloudWrite("microsoft", token);
  const endOtherGoogle = await beginCloudWrite("google", "other-token");
  endMicrosoft();
  endOtherGoogle();
  await completeNonemptyDeletion(deletion);
  await resumeCloudWrites("google", token, await completedCloudDeletionGeneration("google", token));
});

test("write suspension follows one account across refreshed tokens", async () => {
  registerCloudAccount("google", "old-token", "sub-writer");
  registerCloudAccount("google", "new-token", "sub-writer");
  const deletion = await suspendCloudWrites("google", "old-token");
  await assert.rejects(() => beginCloudWrite("google", "new-token"), /Cloud writes are suspended/);
  await completeNonemptyDeletion(deletion);
  await resumeCloudWrites("google", "new-token", await completedCloudDeletionGeneration("google", "new-token"));
  const end = await beginCloudWrite("google", "new-token");
  end();
});

test("same-email Google accounts remain isolated by immutable subject", async () => {
  registerCloudAccount("google", "subject-a-token", "sub-a");
  registerCloudAccount("google", "subject-b-token", "sub-b");
  const deletion = await suspendCloudWrites("google", "subject-a-token");
  const release = await beginCloudWrite("google", "subject-b-token");
  release();
  await completeEmptyDeletion(deletion);
});

test("exclusive leases serialize by provider account and allow provider parity", async () => {
  for (const provider of /** @type {const} */ (["google", "microsoft"])) {
    const token = `lease-${provider}`;
    const releaseFirst = await acquireCloudWriteLease(provider, token);
    let acquiredSecond = false;
    const second = acquireCloudWriteLease(provider, token).then((release) => { acquiredSecond = true; return release; });
    await Promise.resolve();
    assert.equal(acquiredSecond, false);
    releaseFirst();
    const releaseSecond = await second;
    assert.equal(acquiredSecond, true);
    releaseSecond();
  }
});

test("an aborted account-switch waiter never starts after the active lease", async () => {
  const release = await acquireCloudWriteLease("microsoft", "lease-abort");
  const controller = new AbortController();
  const waiting = acquireCloudWriteLease("microsoft", "lease-abort", controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  release();
  const releaseNext = await acquireCloudWriteLease("microsoft", "lease-abort");
  releaseNext();
});

test("ordinary writes are serialized for one account", async () => {
  const first = await beginCloudWrite("google", "serialized-token");
  let acquired = false;
  const waiting = beginCloudWrite("google", "serialized-token").then((release) => { acquired = true; return release; });
  await Promise.resolve();
  assert.equal(acquired, false);
  first();
  const second = await waiting;
  assert.equal(acquired, true);
  second();
});

for (const provider of /** @type {const} */ (["google", "microsoft"])) test(`${provider} expired deletion is reclaimed and stale owner is fenced`, async () => {
  const token = `crash-${provider}`;
  registerCloudAccount(provider, token, `subject-${provider}`);
  const stale = await suspendCloudWrites(provider, token);
  await failCloudDeletion(stale, new Error("simulated crash"));
  simulateCloudDeletionReloadForTests();
  const reclaimed = await suspendCloudWrites(provider, token);
  assert.ok(reclaimed.fence > stale.fence);
  await assert.rejects(() => fencedCloudDeletionMutation(stale, "https://example.test/stale", { method: "DELETE" }), /ownership|heartbeat/i);
  await assert.rejects(() => completeCloudDeletion(stale, true), /ownership/i);
  await completeEmptyDeletion(reclaimed);
});

for (const provider of /** @type {const} */ (["google", "microsoft"])) test(`${provider} provider failure allows immediate fenced retry without reload`, async () => {
  const token = `immediate-${provider}`;
  registerCloudAccount(provider, token, `subject-immediate-${provider}`);
  const failed = await suspendCloudWrites(provider, token);
  await failCloudDeletion(failed, new Error("provider error"));
  const retry = await suspendCloudWrites(provider, token);
  assert.ok(retry.fence > failed.fence);
  await assert.rejects(() => failCloudDeletion(failed, new Error("stale failure")), /ownership/i);
  await completeEmptyDeletion(retry);
});

for (const provider of /** @type {const} */ (["google", "microsoft"])) test(`${provider} stale fail owner cannot release current retry owner`, async () => {
  const token = `stale-fail-${provider}`;
  registerCloudAccount(provider, token, `subject-stale-${provider}`);
  const stale = await suspendCloudWrites(provider, token);
  await failCloudDeletion(stale, new Error("first failure"));
  const current = await suspendCloudWrites(provider, token);
  await assert.rejects(() => failCloudDeletion(stale, new Error("late stale failure")), /ownership/i);
  await assert.rejects(() => suspendCloudWrites(provider, token), /owns this account/);
  await completeEmptyDeletion(current);
});

test("live deletion owner blocks retry", async () => {
  registerCloudAccount("google", "live-delete", "sub-live");
  const active = await suspendCloudWrites("google", "live-delete");
  await assert.rejects(() => suspendCloudWrites("google", "live-delete"), /owns this account/);
  await completeEmptyDeletion(active);
});

test("partial deletion failure resumes and completes idempotently", async () => {
  registerCloudAccount("google", "partial-delete", "sub-partial");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const first = await suspendCloudWrites("google", "partial-delete");
  await fencedCloudDeletionMutation(first, "https://example.test/child-a", { method: "DELETE" });
  await failCloudDeletion(first, new Error("network interruption"));
  const retry = await suspendCloudWrites("google", "partial-delete");
  assert.equal(retry.completedTargets.includes("https://example.test/child-a"), true);
  await fencedCloudDeletionMutation(retry, "https://example.test/child-a", { method: "DELETE" });
  await fencedCloudDeletionMutation(retry, "https://example.test/child-b", { method: "DELETE" });
  await completeCloudDeletion(retry, true);
  assert.equal(await completedCloudDeletionGeneration("google", "partial-delete"), retry.operationId);
  globalThis.fetch = originalFetch;
});
