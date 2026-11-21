import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import * as testing from "../dist/testing.mjs";
import { adminLogin, gatedAi, noRelease, until, withServer } from "./helpers.mjs";

const { loadServerConfig, startNarrariumServer } = testing;
const noTunnel = { findBinary: () => undefined, detectOtherConnectors: async () => [] };
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const hostname = os.hostname();
const legacyLabel = `narrarium-server@${hostname}`;

/** A server whose configuration was written by an earlier version: its label is the default one, with the computer's name in it. */
async function withLegacyServer(run, label = legacyLabel, extra = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-label-"));
  await writeFile(path.join(dataDir, "config.json"), JSON.stringify({ version: 2, serverId: randomUUID(), label, apiPort: 0, adminPort: 0, origins: [], allowedAiBases: [], pendingAiBases: [], allowRemoteAdmin: false, maxConcurrentRuns: 2, createdAt: new Date().toISOString() }), { mode: 0o600 });
  const server = await startNarrariumServer({ dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: noTunnel, ...extra });
  try {
    await run(server, dataDir);
  } finally {
    await server.close();
    await remove(dataDir);
  }
}

test("C23: GET /info and GET / do not tell anybody the name of the computer", async () => {
  await withLegacyServer(async (server) => {
    for (const route of ["/api/v1/info", "/", "/api/v1/info?nonce=" + "ab".repeat(32)]) {
      const response = await fetch(`${server.url}${route}`);
      assert.equal(response.status, 200);
      const { label, message: _message, ...rest } = await response.json();
      assert.equal(label, "narrarium-server", `${route}: the neutral name`);
      assert.equal(JSON.stringify(rest).toLowerCase().includes(hostname.toLowerCase()) && hostname.length > 6, false, `${route} names the computer in another field: ${JSON.stringify(rest).slice(0, 200)}`);
    }
  });
});

test("C23: the owner, signed in, still sees the label that is stored", async () => {
  await withLegacyServer(async (server) => {
    const { token } = await server.auth.issue("owner's device", ["read"]);
    const session = await (await fetch(`${server.url}/api/v1/session`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(session.label, legacyLabel);
    const admin = await adminLogin(server);
    assert.equal((await admin.call("GET", "/admin/api/status")).body.label, legacyLabel);
    assert.equal(server.data.config.label, legacyLabel, "and nothing was rewritten on disk");
  });
});

test("C23: a label the owner chose is shown as chosen, also when it is not the default", async () => {
  await withLegacyServer(async (server) => {
    assert.equal((await (await fetch(`${server.url}/api/v1/info`)).json()).label, "Studio server");
  }, "Studio server");
  await withLegacyServer(async (server) => {
    assert.equal((await (await fetch(`${server.url}/api/v1/info`)).json()).label, `${hostname} (my studio)`, "the owner put it there themselves");
  }, `${hostname} (my studio)`);
});

test("C23: the default label of an earlier version is neutral whatever the name of the computer was: long, or since changed", async () => {
  // A configuration keeps a label to 80 characters when it reads it, so the default of a computer with a long name (a macOS runner's, say) is cut.
  const longName = "sat12-bq158-e0183361-2995-475f-b220-b2a6033bbad8-C22FD16FD7B4.local";
  const cut = `narrarium-server@${longName}`.slice(0, 80);
  assert.equal(cut.length, 80);
  await withLegacyServer(async (server) => {
    const { label } = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.equal(label, "narrarium-server", "the cut label is neutral too");
  }, `narrarium-server@${longName}`);
  await withLegacyServer(async (server) => {
    const { label } = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.equal(label, "narrarium-server", "the computer was renamed since: the old name is still not for anybody");
  }, "narrarium-server@a-computer-that-is-not-this-one");
  assert.equal(testing.publicLabel(cut, longName), "narrarium-server");
  assert.equal(testing.publicLabel("narrarium-server", "anything"), "narrarium-server");
  for (const chosen of ["Studio server", `${longName} (my studio)`, "narrarium-server (office)", "My narrarium-server@home"]) {
    assert.equal(testing.publicLabel(chosen, longName), chosen, `${chosen} is the owner's own`);
  }
});

test("C23: a new configuration starts with a label that does not contain the computer's name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-label-new-"));
  try {
    const config = await loadServerConfig(root);
    assert.equal(config.label, "narrarium-server", "neutral: no `@computer` after it");
  } finally {
    await remove(root);
  }
});

test("C23: the label written into a book's autopilot state (which is committed, and pushed to GitHub) has no computer name either", async () => {
  const slow = gatedAi();
  try {
    await withLegacyServer(async (server) => {
      const { token } = await server.auth.issue("writer", ["read", "write", "run"]);
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const call = (method, route, body) => fetch(`${server.url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      try {
        assert.equal((await call("PUT", "/api/v1/books/b", { title: "B", storage: { kind: "local" } })).status, 200);
        const seeded = await call("POST", "/api/v1/books/b/files/commit", { changes: Object.entries(seedBookFiles()).map(([file, content]) => ({ path: file, content })), message: "seed" });
        assert.equal(seeded.status, 200, await seeded.text());
        const started = await call("POST", "/api/v1/books/b/autopilot/start", { brief: { idea: "A harbor", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false } });
        assert.equal(started.status, 200, await started.text());
        await slow.started;
        const snapshot = await until(async () => {
          const answer = await (await call("GET", "/api/v1/books/b/autopilot")).json();
          return answer.state?.runner ? answer : undefined;
        });
        assert.equal(snapshot.state.runner.label, "narrarium-server", "no `@computer` in what is committed");
      } finally {
        // The run waits at the gate: it is let go and paused whatever the test found, or closing the server would wait for it.
        await call("POST", "/api/v1/books/b/autopilot/pause", { mode: "now" }).catch(() => undefined);
        slow.release();
      }
      await until(async () => !(await (await call("GET", "/api/v1/books/b/autopilot")).json()).running);
    }, legacyLabel, { ai: slow.ai });
  } finally {
    slow.release();
  }
});

test("C23: a data folder created by this version names no computer in /info either", async () => {
  await withServer(async (server) => {
    const { label } = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.equal(label, "narrarium-server");
  });
});
