import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serverIdentityMessage } from "narrarium-engine";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import { SERVER_VERSION, rotateLocalAdminCode, requestLocalClientToken, setLocalAdminCode, startNarrariumServer } from "../dist/testing.mjs";
import { noRelease, until, withServer } from "./helpers.mjs";

const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const serverEntry = fileURLToPath(new URL("../dist/server.mjs", import.meta.url));
const noTunnel = { findBinary: () => undefined, detectOtherConnectors: async () => [] };
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));

/** A data folder that a server has been started on once (so it has its admin code, its identity and its configuration), and no server now. */
async function preparedDataRoot() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-cli-identity-"));
  const server = await startNarrariumServer({ dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: noTunnel });
  const identity = { serverId: server.data.config.serverId, publicKey: server.data.publicKey };
  const code = (await readFile(path.join(dataDir, "private", "admin-code.txt"), "utf8")).trim();
  await server.close();
  return { dataDir, code, ...identity };
}

/** Whatever answers on a port instead of the server: it keeps every request it gets and answers with `answer(request, text)`. */
async function listener(answer) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: request.method, url: request.url, headers: { ...request.headers }, body: text });
      answer(request, response, text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    seen,
    everything: () => JSON.stringify(seen),
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/** The signed answer a server gives for a nonce, made with any key. */
function signedAnswer(nonce, serverId, keys) {
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { serverId, publicKey, nonce, signature: sign(null, Buffer.from(serverIdentityMessage(nonce, serverId, publicKey)), keys.privateKey).toString("base64") };
}

const nonceOf = (url) => new URL(url, "http://127.0.0.1").searchParams.get("nonce");

// ---------------------------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------------------------

test("C10: the admin listener signs a caller's nonce on GET /admin/api/identity, without a session and without naming the machine", async () => {
  await withServer(async (server) => {
    const nonce = "ab".repeat(32);
    const answer = await fetch(`${server.adminUrl}/admin/api/identity?nonce=${nonce}`);
    assert.equal(answer.status, 200);
    const proof = await answer.json();
    assert.equal(proof.nonce, nonce);
    assert.equal(proof.serverId, server.data.config.serverId);
    assert.equal(proof.publicKey, server.data.publicKey);
    assert.equal(proof.fingerprint, server.data.fingerprint);
    assert.equal(proof.signature, server.data.signIdentity(nonce), "the same signature the API gives");
    assert.deepEqual(Object.keys(proof).sort(), ["fingerprint", "name", "nonce", "publicKey", "serverId", "signature"], "the identity and nothing else: no label, nothing that names the computer");
    assert.equal((await fetch(`${server.adminUrl}/admin/api/identity`)).status, 400, "a nonce is needed");
    assert.equal((await fetch(`${server.adminUrl}/admin/api/identity?nonce=short`)).status, 400);
    assert.equal((await fetch(`${server.adminUrl}/admin/api/identity?nonce=${"zz".repeat(32)}`)).status, 400, "hexadecimal only");
    const foreign = await new Promise((resolve, reject) => {
      http.get(`${server.adminUrl}/admin/api/identity?nonce=${nonce}`, { headers: { host: "evil.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    assert.equal(foreign, 403, "a foreign Host never reaches it");
  });
});

test("C10: the identity challenge is limited per source (60 a minute), so it cannot be used to keep the panel busy", async () => {
  await withServer(async (server) => {
    const statuses = [];
    for (let index = 0; index < 63; index += 1) statuses.push((await fetch(`${server.adminUrl}/admin/api/identity?nonce=${"ef".repeat(32)}`)).status);
    assert.equal(statuses.filter((status) => status === 200).length, 60);
    assert.ok(statuses.slice(60).every((status) => status === 429));
    const login = await fetch(`${server.adminUrl}/admin/api/login`, { method: "POST", headers: { origin: server.adminUrl, "content-type": "application/json" }, body: JSON.stringify({ code: "x".repeat(43) }) });
    assert.equal(login.status, 401, "signing in is a different budget");
  });
});

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

test("C10: with the real server the CLI proves who it talks to before it sends anything, and signs out afterwards", async () => {
  await withServer(async (server) => {
    const calls = [];
    const fetchImpl = (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input).replace(server.adminUrl, "")}`);
      return fetch(input, init);
    };
    const sessionsBefore = server.auth.sessionCount;
    const issued = await requestLocalClientToken({ dataRoot: server.data.root, adminPort: server.adminPort, label: "Terminal", scopes: ["read"], fetchImpl });
    assert.match(issued.token, /^nrs_/);
    assert.match(calls[0], /^GET \/admin\/api\/identity\?nonce=[0-9a-f]{64}$/, `the first thing it does: ${calls[0]}`);
    assert.deepEqual(calls.slice(1).map((call) => call.split("?")[0]), ["POST /admin/api/login", "POST /admin/api/token", "POST /admin/api/logout"]);
    assert.equal(server.auth.sessionCount, sessionsBefore, "its admin session does not pile up: it signs out");
    const made = server.auth.list().clients.find((client) => client.id === issued.clientId);
    assert.equal(made.source, "local");
    assert.equal(made.userAgent, `narrarium-server-cli/${SERVER_VERSION}`, "the panel shows that this token was made by the command line");
    const codeBefore = (await readFile(path.join(server.data.root, "private", "admin-code.txt"), "utf8")).trim();
    const rotated = await rotateLocalAdminCode({ dataRoot: server.data.root, adminPort: server.adminPort });
    assert.notEqual(rotated, codeBefore);
    await setLocalAdminCode({ dataRoot: server.data.root, adminPort: server.adminPort, code: "d".repeat(40) });
    assert.equal((await readFile(path.join(server.data.root, "private", "admin-code.txt"), "utf8")).trim(), "d".repeat(40));
  });
});

test("C10: a program squatting on the admin port never receives the admin code (every way it can try to pass for the server)", async () => {
  const root = await preparedDataRoot();
  const real = generateKeyPairSync("ed25519");
  try {
    const squatters = {
      "answers everything with an error": (request, response) => json(response, 500, {}),
      "pretends to be a server that wants a login": (request, response) => json(response, 401, { code: "admin_session", message: "Sign in to the admin panel again." }),
      "accepts the login like a server would": (request, response) => json(response, 200, { csrf: "x".repeat(40) }),
      "signs with a key of its own": (request, response) => json(response, 200, signedAnswer(nonceOf(request.url), root.serverId, generateKeyPairSync("ed25519"))),
      "signs with the right server id and a key of its own": (request, response) => json(response, 200, signedAnswer(nonceOf(request.url) ?? "", root.serverId, real)),
      "gives the right key and an invented signature": (request, response) => json(response, 200, { serverId: root.serverId, publicKey: root.publicKey, nonce: nonceOf(request.url), signature: Buffer.alloc(64, 7).toString("base64") }),
      "gives the right key and no signature": (request, response) => json(response, 200, { serverId: root.serverId, publicKey: root.publicKey, nonce: nonceOf(request.url) }),
      "answers with something that is not JSON": (request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html>hello</html>");
      },
      "answers with a huge body": (request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ padding: "x".repeat(2_000_000) }));
      },
      "redirects somewhere else": (request, response) => {
        response.writeHead(307, { location: "http://127.0.0.1:1/admin/api/login" });
        response.end();
      },
    };
    for (const [name, answer] of Object.entries(squatters)) {
      const squatter = await listener(answer);
      try {
        await writeFile(path.join(root.dataDir, "config.json"), JSON.stringify({ version: 2, serverId: root.serverId, adminPort: squatter.port, apiPort: 0 }), { mode: 0o600 });
        await assert.rejects(
          () => requestLocalClientToken({ dataRoot: root.dataDir, adminPort: squatter.port, label: "Phone", scopes: ["read"] }),
          (error) => /identity|prove|not the narrarium-server/i.test(error.message) && /not sent|NOT sent/.test(error.message),
          `${name}: refused, and the message says why`,
        );
        assert.equal(squatter.everything().includes(root.code), false, `${name}: the admin code never reached it`);
        assert.equal(squatter.seen.some((entry) => entry.method === "POST"), false, `${name}: not a single POST`);
        assert.equal(squatter.seen.some((entry) => /login/.test(entry.url)), false, `${name}: it was never asked to sign in`);
        await assert.rejects(() => rotateLocalAdminCode({ dataRoot: root.dataDir, adminPort: squatter.port }), /identity|prove|not the narrarium-server/i, `${name}: rotating`);
        await assert.rejects(() => setLocalAdminCode({ dataRoot: root.dataDir, adminPort: squatter.port, code: "n".repeat(40) }), /identity|prove|not the narrarium-server/i, `${name}: setting`);
        assert.equal(squatter.everything().includes("n".repeat(40)), false, `${name}: the new code did not leak either`);
      } finally {
        await squatter.close();
      }
    }
  } finally {
    await remove(root.dataDir);
  }
});

test("C10: a signed answer that was recorded for another nonce is refused (no replay)", async () => {
  const root = await preparedDataRoot();
  try {
    // A real server of this very folder, asked once by "somebody else": the answer is genuine, but it is for their nonce.
    const genuine = await startNarrariumServer({ dataDir: root.dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: noTunnel });
    const recorded = await (await fetch(`${genuine.adminUrl}/admin/api/identity?nonce=${"c0".repeat(32)}`)).json();
    await genuine.close();
    const replayer = await listener((request, response) => json(response, 200, recorded));
    const retargeted = await listener((request, response) => json(response, 200, { ...recorded, nonce: nonceOf(request.url) }));
    try {
      for (const squatter of [replayer, retargeted]) {
        await assert.rejects(() => requestLocalClientToken({ dataRoot: root.dataDir, adminPort: squatter.port, label: "Phone", scopes: ["read"] }), /NOT sent/);
        assert.equal(squatter.everything().includes(root.code), false);
      }
    } finally {
      await Promise.all([replayer.close(), retargeted.close()]);
    }
  } finally {
    await remove(root.dataDir);
  }
});

test("C10: another narrarium-server on that port (a different data folder) is refused too", async () => {
  const mine = await preparedDataRoot();
  await withServer(async (other) => {
    await assert.rejects(
      () => requestLocalClientToken({ dataRoot: mine.dataDir, adminPort: other.adminPort, label: "Phone", scopes: ["read"] }),
      (error) => /another data folder|different data folder|--data-root/i.test(error.message) && /NOT sent/.test(error.message),
    );
    assert.equal(other.auth.sessionCount, 0, "it was not even asked to sign in");
  });
  await remove(mine.dataDir);
});

test("C10: a data folder that has never run a server has nothing to verify against, and is told so", async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "narrarium-cli-empty-"));
  try {
    const squatter = await listener((request, response) => json(response, 200, {}));
    try {
      await assert.rejects(() => requestLocalClientToken({ dataRoot: empty, adminPort: squatter.port, label: "Phone", scopes: ["read"] }), /start the server|never run|does not exist yet/i);
      assert.equal(squatter.seen.length, 0, "nothing was sent anywhere");
    } finally {
      await squatter.close();
    }
  } finally {
    await remove(empty);
  }
});

test("C10: a server that does not answer is reported as not running, quickly, and nothing is sent", async () => {
  const root = await preparedDataRoot();
  try {
    const silent = await listener(() => undefined);
    try {
      const started = Date.now();
      await assert.rejects(
        () => requestLocalClientToken({ dataRoot: root.dataDir, adminPort: silent.port, label: "Phone", scopes: ["read"], identityTimeoutMs: 300 }),
        (error) => /did not answer|not running|identity/i.test(error.message),
      );
      assert.ok(Date.now() - started < 5_000, "it gives up after the timeout");
      assert.equal(silent.everything().includes(root.code), false);
    } finally {
      await silent.close();
    }
    await assert.rejects(() => requestLocalClientToken({ dataRoot: root.dataDir, adminPort: 1, label: "x", scopes: ["read"] }), /not running/);
  } finally {
    await remove(root.dataDir);
  }
});

// ---------------------------------------------------------------------------------------------
// The commands, as the owner runs them
// ---------------------------------------------------------------------------------------------

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, NARRARIUM_SERVER_HOME: "", ...env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once("exit", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("C10: `client-token` run while a squatter holds the port exits with an explanation and the squatter never sees the code (the repro of the finding)", async () => {
  const root = await preparedDataRoot();
  const squatter = await listener((request, response) => json(response, 500, {}));
  try {
    await writeFile(path.join(root.dataDir, "config.json"), JSON.stringify({ version: 2, serverId: root.serverId, adminPort: squatter.port, apiPort: 0 }), { mode: 0o600 });
    const result = await runCli(["client-token", "--data-root", root.dataDir, "--label", "Phone"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not the narrarium-server of this data folder/i);
    assert.match(result.stderr, /NOT sent/);
    assert.equal(result.stdout.includes("nrs_"), false, "no token was printed");
    assert.equal(squatter.everything().includes(root.code), false, "the squatter never saw the admin code");
    assert.equal(squatter.seen.some((entry) => entry.method === "POST"), false);
  } finally {
    await squatter.close();
    await remove(root.dataDir);
  }
});

test("C10: `client-token` works against a server started the way the supervisor starts it (NARRARIUM_SUPERVISED=1, a separate process)", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-cli-supervised-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "narrarium-cli-home-"));
  await writeFile(path.join(dataDir, "config.json"), JSON.stringify({ version: 2, apiPort: 0, adminPort: 0 }), { mode: 0o600 });
  let stdout = "";
  const child = spawn(process.execPath, [serverEntry, "--data-root", dataDir], { env: { ...process.env, HOME: home, USERPROFILE: home, NARRARIUM_SUPERVISED: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.resume();
  try {
    const adminUrl = await until(() => /Admin panel:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1], 30_000);
    const adminPort = Number(new URL(adminUrl).port);
    // The CLI reads the ports from config.json: the supervisor's server was told to pick free ones, so write the real ones.
    const config = JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8"));
    await writeFile(path.join(dataDir, "config.json"), JSON.stringify({ ...config, adminPort }), { mode: 0o600 });
    const result = await runCli(["client-token", "--data-root", dataDir, "--label", "Under the supervisor", "--scope", "read"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Client token \(shown once\): nrs_/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await remove(dataDir, home);
  }
});

test("C10: the CLI still says plainly that nothing runs when nothing does", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "narrarium-cli-identity-"));
  try {
    const result = spawnSync(process.execPath, [cli, "client-token", "--data-root", path.join(parent, "never-started")], { encoding: "utf8", timeout: 60_000, env: { ...process.env, NARRARIUM_SERVER_HOME: "" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not exist yet|start the server|never run/i);
  } finally {
    await remove(parent);
  }
});
