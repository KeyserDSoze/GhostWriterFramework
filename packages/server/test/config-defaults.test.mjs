import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import { DataDirectory, loadServerConfig, startNarrariumServer } from "../dist/testing.mjs";
import { adminLogin, noRelease, withServer } from "./helpers.mjs";

const noTunnel = { findBinary: () => undefined, detectOtherConnectors: async () => [] };
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const temporary = () => mkdtemp(path.join(os.tmpdir(), "narrarium-config-"));
const read = async (root) => JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));

/** A configuration file as the first versions of the server wrote them: there was no `allowRemoteAdmin` in it yet, and a remote panel was allowed. */
const legacyConfig = (extra = {}) => ({
  version: 2,
  serverId: randomUUID(),
  label: "Studio",
  apiPort: 0,
  adminPort: 0,
  origins: [],
  allowedAiBases: [],
  pendingAiBases: [],
  maxConcurrentRuns: 2,
  createdAt: new Date().toISOString(),
  ...extra,
});

function rawRequest(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
}

test("C17: a new data folder does not serve the admin panel on a public address until the owner turns that on", async () => {
  const root = await temporary();
  try {
    const config = await loadServerConfig(root);
    assert.equal(config.allowRemoteAdmin, false);
    assert.equal((await read(root)).allowRemoteAdmin, false, "and the file says so, explicitly");
    assert.equal((await DataDirectory.open(root)).config.allowRemoteAdmin, false);
  } finally {
    await remove(root);
  }
});

test("C17: a configuration file from before the setting existed keeps its behaviour (remote administration was allowed): it is written as true, once", async () => {
  const root = await temporary();
  try {
    const stored = legacyConfig({ publicUrl: "https://books.example.com", adminPublicUrl: "https://admin.example.com" });
    await writeFile(path.join(root, "config.json"), JSON.stringify(stored), { mode: 0o600 });
    const config = await loadServerConfig(root);
    assert.equal(config.allowRemoteAdmin, true, "nobody is locked out of the panel they reach from outside");
    assert.equal((await read(root)).allowRemoteAdmin, true, "written explicitly the first time it is loaded");
    assert.equal(config.serverId, stored.serverId, "nothing else changed");
    assert.equal(config.label, "Studio");
    await writeFile(path.join(root, "config.json"), JSON.stringify({ ...(await read(root)), allowRemoteAdmin: false }));
    assert.equal((await loadServerConfig(root)).allowRemoteAdmin, false, "once it is written, the owner's choice is respected");
    await writeFile(path.join(root, "config.json"), "{}");
    assert.equal((await loadServerConfig(root)).allowRemoteAdmin, true, "even an almost empty file of an earlier version");
    assert.equal((await read(root)).allowRemoteAdmin, true);
  } finally {
    await remove(root);
  }
});

test("C17: an explicit setting is never changed by loading, and a change made through updateConfig sticks", async () => {
  const root = await temporary();
  try {
    for (const value of [true, false]) {
      await writeFile(path.join(root, "config.json"), JSON.stringify(legacyConfig({ allowRemoteAdmin: value })), { mode: 0o600 });
      assert.equal((await loadServerConfig(root)).allowRemoteAdmin, value);
      assert.equal((await read(root)).allowRemoteAdmin, value);
    }
    const data = await DataDirectory.open(root);
    await data.updateConfig((config) => {
      config.allowRemoteAdmin = true;
    });
    assert.equal((await read(root)).allowRemoteAdmin, true);
    await data.updateConfig((config) => {
      config.label = "Renamed";
    });
    assert.equal((await read(root)).allowRemoteAdmin, true, "updating something else does not reset it");
    assert.equal((await DataDirectory.open(root)).config.allowRemoteAdmin, true);
  } finally {
    await remove(root);
  }
});

test("C17: through the server, a new install refuses the panel on its public hostname and an existing one still serves it", async () => {
  await withServer(async (server) => {
    await server.data.updateConfig((config) => {
      config.publicUrl = "https://books.example.com";
      config.adminPublicUrl = "https://admin.example.com";
    });
    assert.equal(server.data.config.allowRemoteAdmin, false);
    assert.equal(await rawRequest(`${server.adminUrl}/`, { host: "admin.example.com" }), 403, "a new install: not on the public address");
    assert.equal(await rawRequest(`${server.adminUrl}/`, { host: `127.0.0.1:${server.adminPort}` }), 200, "this computer still works");
    const admin = await adminLogin(server);
    assert.equal((await admin.call("GET", "/admin/api/status")).body.allowRemoteAdmin, false);
    // The owner turns it on in the panel, and it works.
    assert.equal((await admin.call("POST", "/admin/api/network", { publicUrl: "https://books.example.com", adminPublicUrl: "https://admin.example.com", allowRemoteAdmin: true })).status, 200);
    assert.equal(await rawRequest(`${server.adminUrl}/`, { host: "admin.example.com" }), 200);
  });

  const dataDir = await temporary();
  try {
    await writeFile(path.join(dataDir, "config.json"), JSON.stringify(legacyConfig({ publicUrl: "https://books.example.com", adminPublicUrl: "https://admin.example.com" })), { mode: 0o600 });
    const server = await startNarrariumServer({ dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: noTunnel });
    try {
      assert.equal(server.data.config.allowRemoteAdmin, true);
      assert.equal(await rawRequest(`${server.adminUrl}/`, { host: "admin.example.com" }), 200, "an install that was reached from outside before the update still is");
    } finally {
      await server.close();
    }
  } finally {
    await remove(dataDir);
  }
});

test("C17: the tunnel token given to the panel ends up in the vault and nowhere in clear in the data folder", async () => {
  const token = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoicGFuZWwtc2VjcmV0LTEyMzQ1Njc4OSJ9";
  await withServer(async (server) => {
    const admin = await adminLogin(server);
    // No cloudflared is installed in the test: the connector does not start, the token is stored all the same.
    const configured = await admin.call("POST", "/admin/api/tunnel/configure", { token, hostname: "https://books.example.com" });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal(JSON.stringify(configured.body).includes(token), false, "the answer does not echo it");
    assert.equal(JSON.stringify((await admin.call("GET", "/admin/api/status")).body).includes(token), false);
    const scan = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await scan(full);
        else if (entry.isFile()) {
          const text = await readFile(full, "latin1");
          for (const form of [token, Buffer.from(token).toString("base64")]) assert.equal(text.includes(form), false, `${path.relative(server.data.root, full)} holds the token`);
        }
      }
    };
    await scan(server.data.root);
    assert.ok(await readFile(path.join(server.data.root, "private", "cloudflare-tunnel-token.json"), "utf8"), "the vault's copy exists");
  });
});
