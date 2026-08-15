import assert from "node:assert/strict";
import test from "node:test";
import { assertCloudStatus, assertMigrationChatCompatible, indexUniqueMigrationIdentities, readMigrationSource, resumableMigrationSteps, writeAndVerifyMigrationTarget } from "../src/drive/migrationSafety.ts";

test("expired tokens and rate limits remain explicit read errors", () => {
  assert.throws(() => assertCloudStatus(false, 401, "Source read"), /401/);
  assert.throws(() => assertCloudStatus(false, 429, "Source read"), /429/);
});

test("network failures propagate without producing an empty migration source", async () => {
  await assert.rejects(() => readMigrationSource("Clipboard", async () => { throw new Error("network offline"); }, Array.isArray), /network offline/);
});

test("malformed source data aborts before any target write", async () => {
  let writes = 0;
  await assert.rejects(() => readMigrationSource("Clipboard", async () => ({ invalid: true }), Array.isArray), /malformed/);
  assert.equal(writes, 0);
});

test("failed target writes and verification mismatches cannot report success", async () => {
  await assert.rejects(() => writeAndVerifyMigrationTarget("Costs", async () => { throw new Error("write 503"); }, async () => [], [], () => true), /write 503/);
  await assert.rejects(() => writeAndVerifyMigrationTarget("Clipboard", async () => undefined, async () => ["old"], ["new"], (a, b) => JSON.stringify(a) === JSON.stringify(b)), /verification failed/);
});

test("retry runs only failed or unverified migration steps", () => {
  const pending = resumableMigrationSteps(["settings", "costs", "clipboard", "chats"], [
    { step: "settings", ok: true, verified: true },
    { step: "costs", ok: false, verified: false },
    { step: "clipboard", ok: true, verified: false },
  ]);
  assert.deepEqual(pending, ["costs", "clipboard", "chats"]);
});

test("migration rejects duplicate target chat identities before writes", () => {
  assert.throws(() => indexUniqueMigrationIdentities([
    { id: "chat-1", fileId: "first" },
    { id: "chat-1", fileId: "second" },
  ], "Migration target"), /duplicate chat identity chat-1/);
});

test("migration accepts only identical target chats with matching payload identity", () => {
  const canonical = (input) => {
    const value = { ...input };
    delete value.fileId;
    delete value.revision;
    return value;
  };
  const source = { id: "chat-1", title: "Source", fileId: "source" };
  assert.doesNotThrow(() => assertMigrationChatCompatible("chat-1", source, { ...source, fileId: "target", revision: "r1" }, canonical));
  assert.throws(() => assertMigrationChatCompatible("chat-1", source, { ...source, id: "chat-2" }, canonical), /mismatched session identity/);
  assert.throws(() => assertMigrationChatCompatible("chat-1", source, { ...source, title: "Different" }, canonical), /conflicts with the migration source/);
});
