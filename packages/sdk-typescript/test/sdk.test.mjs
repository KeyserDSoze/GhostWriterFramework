import test from "node:test";
import assert from "node:assert/strict";
import {
  AzureDevOpsRemoteProvider,
  BookManager,
  GitHubRemoteProvider,
  LocalStorageBookProfileStore,
  createEmptyBookSnapshot,
} from "../dist/index.js";

test("sdk package re-exports the dedicated remote SDK surface", () => {
  assert.equal(typeof BookManager, "function");
  assert.equal(typeof GitHubRemoteProvider, "function");
  assert.equal(typeof AzureDevOpsRemoteProvider, "function");
  assert.equal(typeof LocalStorageBookProfileStore, "function");

  const snapshot = createEmptyBookSnapshot({
    profileId: "profile",
    provider: "github",
    branch: "main",
    commitSha: "sha-1",
  });

  assert.equal(snapshot.commitSha, "sha-1");
});
