import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import { DataDirectory, Vault, startNarrariumServer } from "../dist/testing.mjs";
import { noRelease } from "./helpers.mjs";

const posix = process.platform !== "win32";
const noTunnel = { findBinary: () => undefined, detectOtherConnectors: async () => [] };
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const temporary = () => mkdtemp(path.join(os.tmpdir(), "narrarium-vault-"));
const exists = (file) => stat(file).then(() => true, () => false);
const key = (root) => path.join(root, "private", "master.key");

test("R4: a vault key that is missing while encrypted secrets exist is an error with an explanation, not a new key that locks them for good", async () => {
  const root = await temporary();
  try {
    const data = await DataDirectory.open(root);
    await data.setBookToken("book", "ghp_precious_token");
    const identity = await readFile(path.join(root, "private", "identity.json"), "utf8");
    await rm(key(root));
    await rm(`${key(root)}.bak`, { force: true });
    await assert.rejects(
      () => Vault.open(root),
      (error) => /master\.key/.test(error.message) && /missing/i.test(error.message) && /identity\.json/.test(error.message) && /book-tokens\.json/.test(error.message) && /unreadable|never|not create/i.test(error.message),
    );
    assert.equal(await exists(key(root)), false, "no key was written");
    assert.equal(await readFile(path.join(root, "private", "identity.json"), "utf8"), identity, "and nothing else changed");
    await assert.rejects(() => DataDirectory.open(root), /master\.key/);
  } finally {
    await remove(root);
  }
});

test("R4: the explanation names the backup copy of the key when there is one, and copying it back recovers every secret", async () => {
  const root = await temporary();
  try {
    const data = await DataDirectory.open(root);
    await data.setBookToken("book", "ghp_precious_token");
    await data.saveAiConfig({ aiIntegrations: [{ id: "a", name: "OpenAI", provider: "openai", endpoint: "https://api.openai.com/v1", apiKey: "sk-keep-me", chatModels: [{ id: "m", name: "gpt", capabilities: ["default"] }] }] });
    assert.ok(await exists(`${key(root)}.bak`), "a copy of the key is kept next to it");
    assert.deepEqual(await readFile(`${key(root)}.bak`), await readFile(key(root)), "the same key");
    if (posix) assert.equal((await stat(`${key(root)}.bak`)).mode & 0o777, 0o600);
    const original = await readFile(key(root));
    await rm(key(root));
    await assert.rejects(() => Vault.open(root), (error) => /master\.key\.bak/.test(error.message));
    // The owner does what it says.
    await writeFile(key(root), original, { mode: 0o600 });
    const recovered = await DataDirectory.open(root);
    assert.equal(await recovered.bookToken("book"), "ghp_precious_token");
    assert.equal((await recovered.aiConfig()).config.aiIntegrations[0].apiKey, "sk-keep-me");
  } finally {
    await remove(root);
  }
});

test("R4: a missing key with nothing encrypted is still a first start: a key is created (and kept as a copy), as before", async () => {
  const root = await temporary();
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify({ version: 2 }));
    await Vault.open(root);
    assert.ok(await exists(key(root)));
    assert.ok(await exists(`${key(root)}.bak`));
    // Files that exist but hold no secret do not count: an empty token list is what removing the last book leaves behind.
    await rm(key(root));
    await rm(`${key(root)}.bak`);
    await writeFile(path.join(root, "private", "book-tokens.json"), JSON.stringify({ tokens: {} }));
    await Vault.open(root);
    assert.ok(await exists(key(root)), "a new key where there was nothing to lock");
  } finally {
    await remove(root);
  }
});

test("R4: an unreadable file that might hold secrets counts as one (when in doubt, no new key)", async () => {
  const root = await temporary();
  try {
    await Vault.open(root);
    await rm(key(root));
    await rm(`${key(root)}.bak`);
    await writeFile(path.join(root, "private", "ai.json"), "{ this is not json");
    await assert.rejects(() => Vault.open(root), /ai\.json/);
    assert.equal(await exists(key(root)), false);
  } finally {
    await remove(root);
  }
});

test("R4: an install from before the copy existed gets one at its next start, and an existing key or copy is never overwritten", async () => {
  const root = await temporary();
  try {
    await Vault.open(root);
    const original = await readFile(key(root));
    await rm(`${key(root)}.bak`);
    await Vault.open(root);
    assert.deepEqual(await readFile(`${key(root)}.bak`), original, "made from the key that is there");
    await writeFile(`${key(root)}.bak`, "something the owner put there");
    await Vault.open(root);
    assert.equal(await readFile(`${key(root)}.bak`, "utf8"), "something the owner put there", "never overwritten");
    assert.deepEqual(await readFile(key(root)), original, "and neither is the key");
  } finally {
    await remove(root);
  }
});

test("R4: the server does not start on a folder whose key is gone, says why, and writes nothing", async () => {
  const root = await temporary();
  try {
    const first = await startNarrariumServer({ dataDir: root, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: noTunnel });
    await first.close();
    const identity = await readFile(path.join(root, "private", "identity.json"), "utf8");
    await rm(key(root));
    await assert.rejects(
      () => startNarrariumServer({ dataDir: root, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: noTunnel }),
      /master\.key/,
    );
    assert.equal(await exists(key(root)), false);
    assert.equal(await readFile(path.join(root, "private", "identity.json"), "utf8"), identity, "the server's identity was not regenerated");
    // The lock is free again for the next try.
    await writeFile(key(root), await readFile(`${key(root)}.bak`), { mode: 0o600 });
    const again = await startNarrariumServer({ dataDir: root, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: noTunnel });
    assert.equal(again.data.fingerprint.length, 64);
    await again.close();
  } finally {
    await remove(root);
  }
});

test("R4: the server's own GitHub connection counts as an encrypted secret: with its key gone the server does not make a new one, and the saved pair comes back with the key", async () => {
  const root = await temporary();
  try {
    const data = await DataDirectory.open(root);
    await data.writeGitHubConnection(JSON.stringify({ version: 1, state: "connected", accessToken: "ghu_precious_access", refreshToken: "ghr_precious_refresh" }));
    assert.deepEqual(data.knownSecrets(), ["ghu_precious_access", "ghr_precious_refresh"], "the tokens are kept out of every record from the moment they are saved");
    const original = await readFile(key(root));
    await rm(key(root));
    await rm(`${key(root)}.bak`, { force: true });
    await assert.rejects(() => Vault.open(root), (error) => /github-connection\.json/.test(error.message));
    assert.equal(await exists(key(root)), false, "no key was written");
    await writeFile(key(root), original, { mode: 0o600 });
    const again = await DataDirectory.open(root);
    assert.equal(JSON.parse(await again.readGitHubConnection()).refreshToken, "ghr_precious_refresh");
    assert.deepEqual(again.knownSecrets(), ["ghu_precious_access", "ghr_precious_refresh"], "and they are known again when the folder is opened");
  } finally {
    await remove(root);
  }
});
