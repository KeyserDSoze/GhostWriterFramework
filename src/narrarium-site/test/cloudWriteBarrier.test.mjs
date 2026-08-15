import assert from "node:assert/strict";
import test from "node:test";
import { beginCloudWrite, cloudWritesSuspended, registerCloudAccount, resumeCloudWrites, suspendCloudWrites } from "../src/drive/cloudWriteBarrier.ts";

test("deletion suspension waits for active writes to drain", async () => {
  const token = "drain-token";
  const endFirst = beginCloudWrite("google", token);
  const endSecond = beginCloudWrite("google", token);
  let suspended = false;
  const waiting = suspendCloudWrites("google", token).then(() => { suspended = true; });
  await Promise.resolve();
  assert.equal(suspended, false);
  assert.equal(cloudWritesSuspended("google", token), true);
  endFirst();
  await Promise.resolve();
  assert.equal(suspended, false);
  endSecond();
  await waiting;
  assert.equal(suspended, true);
});

test("new autosaves fail while deletion keeps the account suspended", async () => {
  const token = "blocked-token";
  await suspendCloudWrites("google", token);
  assert.throws(() => beginCloudWrite("google", token), /Cloud writes are suspended/);
  resumeCloudWrites("google", token);
  const end = beginCloudWrite("google", token);
  end();
});

test("write barriers are isolated by provider and account token", async () => {
  const token = "isolated-token";
  await suspendCloudWrites("google", token);
  const endMicrosoft = beginCloudWrite("microsoft", token);
  const endOtherGoogle = beginCloudWrite("google", "other-token");
  endMicrosoft();
  endOtherGoogle();
  resumeCloudWrites("google", token);
});

test("write suspension follows one account across refreshed tokens", async () => {
  registerCloudAccount("google", "old-token", "writer@example.com");
  registerCloudAccount("google", "new-token", "writer@example.com");
  await suspendCloudWrites("google", "old-token");
  assert.throws(() => beginCloudWrite("google", "new-token"), /Cloud writes are suspended/);
  resumeCloudWrites("google", "new-token");
  const end = beginCloudWrite("google", "new-token");
  end();
});
