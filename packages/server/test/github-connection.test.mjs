import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NarrariumServerClient } from "narrarium-engine";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import { isBuiltInOutboundOrigin, startNarrariumServer } from "../dist/testing.mjs";
import { noRelease, until, withServer } from "./helpers.mjs";
import { rawApi } from "./api-helpers.mjs";
import { BROKER, CLIENT_ID, fakeWorld, readableFiles, secretsOf } from "./github-connection-fakes.mjs";

// The server's own connection to GitHub (device authorization, renewed by the server through the broker), against the real server in this process, a GitHub and a broker that live in
// the process too, and a clock the tests move. Nothing reaches the network.

const ROUTE = "/api/v1/github/connection";
const connectBody = (extra = {}) => ({ clientId: CLIENT_ID, broker: BROKER, ...extra });
const EIGHT_HOURS = 28_800_000;
const MARGIN = 10 * 60_000;

/** A server with the fake world, and an `api` for the raw routes. `run({ server, client, api, world, dataDir })`. */
async function scenario(run, { world = fakeWorld(), extra = {} } = {}) {
  await withServer(async (server, client, dataDir) => {
    const api = await rawApi(server);
    await run({ server, client, api, world, dataDir });
  }, { githubConnection: world.options, ...extra });
}

/** Start the connection and let the owner type the code: the server polls GitHub by itself until it is connected. */
async function connect({ server, api, world }, script = ["tokens"]) {
  world.script.push(...script);
  const started = await api("POST", ROUTE, connectBody());
  assert.equal(started.status, 200, started.text);
  await until(() => server.githubConnection.status().state === "connected");
  return started.json;
}

const status = (server) => server.githubConnection.status();

// ---------------------------------------------------------------------------------------------
// The feature, the permissions, and the device flow
// ---------------------------------------------------------------------------------------------

test("G1: the server announces server-github-connection, reads as disconnected, and asks for the right permission on each route", async () => {
  await scenario(async ({ server, api }) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes("server-github-connection"), JSON.stringify(info.features));
    assert.deepEqual((await api("GET", ROUTE)).json, { state: "disconnected" });
    const reader = await rawApi(server, ["read"]);
    assert.equal((await reader("GET", ROUTE)).status, 200, "reading needs read");
    for (const [method, body] of [["POST", connectBody()], ["DELETE", undefined]]) {
      const refused = await reader(method, ROUTE, body);
      assert.equal(refused.status, 403, `${method} needs write`);
    }
    const anonymous = await fetch(`${server.url}${ROUTE}`);
    assert.equal(anonymous.status, 401);
  });
});

test("G2: the owner connects with a code typed on github.com: pending with the public code, then connected as the account, the pair kept only in the vault", async () => {
  await scenario(async ({ server, client, api, world, dataDir }) => {
    world.script.push("authorization_pending", "tokens");
    const asked = world.clock;
    const started = await client.connectGitHub({ clientId: CLIENT_ID, broker: `${BROKER}/` });
    assert.equal(started.state, "pending");
    assert.equal(started.broker, BROKER, "the origin of the broker is shown");
    assert.deepEqual(started.pending, { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: new Date(asked + 900_000).toISOString(), interval: 5 });
    assert.equal(JSON.stringify(started).includes(world.deviceCode), false, "the device code is never in an answer");
    assert.deepEqual(world.callsTo("device")[0].body, { client_id: CLIENT_ID }, "the server asks GitHub with the public client id, and nothing else");
    await until(() => status(server).state === "connected");

    const connected = await client.githubConnection();
    assert.equal(connected.state, "connected");
    assert.equal(connected.login, "octocat");
    assert.equal(connected.broker, BROKER);
    assert.equal(connected.accessTokenExpiresAt, new Date(world.clock + EIGHT_HOURS).toISOString());
    assert.ok(connected.refreshTokenExpiresAt && Date.parse(connected.refreshTokenExpiresAt) > Date.parse(connected.accessTokenExpiresAt));
    assert.ok(connected.connectedAt);
    assert.equal(connected.renewedAt, undefined, "not renewed yet");
    assert.equal(connected.pending, undefined);
    for (const secret of secretsOf(world)) assert.equal(JSON.stringify(connected).includes(secret), false, "no token in the status");

    const polls = world.callsTo("token");
    assert.equal(polls.length, 2);
    assert.deepEqual(polls[0].body, { client_id: CLIENT_ID, device_code: world.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    assert.equal(world.callsTo("api")[0].headers.authorization, `Bearer ${world.current.access}`, "the account's name is read with the new token");
    assert.ok(world.callsTo("api")[0].headers["user-agent"], "GitHub's API wants a user agent");

    const file = path.join(dataDir, "private", "github-connection.json");
    const text = await readFile(file, "utf8");
    for (const secret of secretsOf(world)) assert.equal(text.includes(secret), false, "the file holds the tokens encrypted");
    assert.ok(JSON.parse(text).encrypted.iv, "encrypted by the vault, as the other secrets are");
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600, "private to the user, as the other secrets");
    const stored = JSON.parse(await server.data.readGitHubConnection());
    assert.equal(stored.refreshToken, world.current.refresh);
    assert.equal(stored.accessToken, world.current.access);
    assert.equal(await server.githubConnection.accessToken(), world.current.access, "a book gets this token");
  });
});

test("G3: slow_down adds five seconds to the interval, and the wait that follows is the longer one", async () => {
  await scenario(async ({ server, api, world }) => {
    await connect({ server, api, world }, ["authorization_pending", "slow_down", "authorization_pending", "tokens"]);
    assert.deepEqual(world.waits, [5000, 5000, 10_000, 10_000], "the wait before each question: five seconds twice, then the longer one");
    assert.equal(world.callsTo("token").length, 4);
  });
});

test("G4: the owner refuses on github.com: nothing is stored, the problem says so, and the owner can try again", async () => {
  await scenario(async ({ server, api, world, dataDir }) => {
    world.script.push("access_denied");
    await api("POST", ROUTE, connectBody());
    await until(() => status(server).problem);
    assert.equal(status(server).state, "disconnected");
    assert.equal(status(server).problem.code, "access-denied");
    assert.match(status(server).problem.message, /refused on github\.com/);
    assert.equal(status(server).pending, undefined);
    await assert.rejects(readFile(path.join(dataDir, "private", "github-connection.json")), { code: "ENOENT" });
    world.script.push("tokens");
    assert.equal((await api("POST", ROUTE, connectBody())).status, 200, "a new try is allowed");
    await until(() => status(server).state === "connected");
    assert.equal(status(server).problem, undefined, "a connection that works has no old problem");
  });
});

test("G5: a code that expires (GitHub says so, or the clock passes it) ends the try with code-expired", async () => {
  await scenario(async ({ server, api, world }) => {
    world.script.push("expired_token");
    await api("POST", ROUTE, connectBody());
    await until(() => status(server).problem);
    assert.equal(status(server).problem.code, "code-expired");
    assert.equal(status(server).state, "disconnected");
  });
  const short = fakeWorld({ expiresIn: 12 });
  await scenario(async ({ server, api, world }) => {
    await api("POST", ROUTE, connectBody());
    await until(() => status(server).problem);
    assert.equal(status(server).problem.code, "code-expired", "the server stops asking once the code has expired");
    assert.ok(world.callsTo("token").length <= 3, "and does not keep asking");
  }, { world: short });
});

test("G6: the GitHub App without device flow: the answer to the start says exactly what to switch on, and no waiting begins", async () => {
  await scenario(async ({ server, api, world }) => {
    world.deviceReply = "device_flow_disabled";
    const started = await api("POST", ROUTE, connectBody());
    assert.equal(started.status, 200, "a refusal of GitHub is a status, not an error of the request");
    assert.equal(started.json.state, "disconnected");
    assert.equal(started.json.problem.code, "device-flow-disabled");
    assert.match(started.json.problem.message, /Enable Device Flow/);
    assert.equal(world.callsTo("token").length, 0, "nothing is polled");
    assert.equal(status(server).problem.code, "device-flow-disabled", "the status keeps saying it");
    assert.equal((await api("POST", ROUTE, connectBody())).status, 200, "and the owner can try again");
  });
});

test("G7: a token that does not expire is refused and nothing is stored: «Expire user authorization tokens» is off", async () => {
  await scenario(async ({ server, api, world, dataDir }) => {
    world.tokenKind = "plain";
    world.script.push("tokens");
    await api("POST", ROUTE, connectBody());
    await until(() => status(server).problem);
    assert.equal(status(server).state, "disconnected");
    assert.equal(status(server).problem.code, "expiring-tokens-off");
    assert.match(status(server).problem.message, /Expire user authorization tokens/);
    await assert.rejects(readFile(path.join(dataDir, "private", "github-connection.json")), { code: "ENOENT" }, "nothing was stored");
    assert.equal(world.callsTo("api").length, 0, "the token was not even used");
    assert.equal(JSON.stringify(await api("GET", ROUTE)).includes("NEVERENDING"), false);
    assert.equal(server.data.knownSecrets().some((secret) => secret.includes("NEVERENDING")), false);
  });
});

test("G8: a wrong client id, a GitHub that cannot be reached and an error nobody knows each say what they are, without quoting what GitHub described", async () => {
  await scenario(async ({ api, world }) => {
    const wrong = await api("POST", ROUTE, connectBody({ clientId: "Iv1.ffffffffffffffff" }));
    assert.equal(wrong.json.problem.code, "client-id-rejected");
    assert.match(wrong.json.problem.message, /Client ID/);
    world.deviceReply = 404;
    assert.equal((await api("POST", ROUTE, connectBody())).json.problem.code, "client-id-rejected", "an unknown app answers 404");
    world.deviceReply = "something_new";
    const unknown = await api("POST", ROUTE, connectBody());
    assert.equal(unknown.json.problem.code, "github-rejected");
    assert.match(unknown.json.problem.message, /something_new/, "its code is quoted");
    assert.equal(unknown.text.includes("SECRET-looking"), false, "its description never is");
    world.deviceReply = { nothing: "useful" };
    assert.equal((await api("POST", ROUTE, connectBody())).json.problem.code, "github-rejected");
    const original = world.fetch;
    world.options.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    world.deviceReply = undefined;
    assert.equal((await api("POST", ROUTE, connectBody())).json.problem.code, "github-unreachable");
    world.options.fetch = original;
  });
});

test("G8b: GitHub that cannot be reached while the owner is typing the code is asked again until the code expires", async () => {
  const world = fakeWorld();
  let down = true;
  const inner = world.fetch;
  world.options.fetch = async (url, init) => {
    if (String(url).includes("/login/oauth/access_token") && down) {
      world.calls.push({ service: "token", url });
      if (world.callsTo("token").length >= 3) down = false;
      throw new TypeError("fetch failed");
    }
    return inner(url, init);
  };
  await scenario(async ({ server, api }) => {
    world.script.push("tokens");
    await api("POST", ROUTE, connectBody());
    await until(() => status(server).state === "connected");
    assert.equal(status(server).problem, undefined);
  }, { world });
});

// ---------------------------------------------------------------------------------------------
// Pinning, and what a broker address may be
// ---------------------------------------------------------------------------------------------

test("G9: the client id and the broker are pinned: connecting while connected or waiting is refused, and a disconnect frees them", async () => {
  const world = fakeWorld();
  let release;
  world.hold = new Promise((resolve) => {
    release = resolve;
  });
  await scenario(async ({ server, api }) => {
    assert.equal((await api("POST", ROUTE, connectBody())).json.state, "pending");
    for (const body of [connectBody(), connectBody({ broker: "https://other-broker.example.net" }), connectBody({ clientId: "Iv1.aaaaaaaaaaaaaaaa" })]) {
      const refused = await api("POST", ROUTE, body);
      assert.equal(refused.status, 409);
      assert.equal(refused.json.code, "github_connection_exists");
    }
    assert.equal((await api("DELETE", ROUTE)).json.state, "disconnected", "a waiting connection is cancelled by a disconnect");
    world.script.push("tokens");
    assert.equal((await api("POST", ROUTE, connectBody({ broker: "https://other-broker.example.net" }))).json.state, "pending", "and then another broker may be used");
    release();
    await until(() => status(server).state === "connected");
    assert.equal(status(server).broker, "https://other-broker.example.net");
    const again = await api("POST", ROUTE, connectBody({ broker: "https://other-broker.example.net" }));
    assert.equal(again.status, 409, "connected: connecting again is refused, whatever it says");
  }, { world });
});

test("G9b: a disconnect while GitHub is still being asked for the code ends the try quietly: no problem is made up, nothing is polled", async () => {
  const world = fakeWorld();
  let release;
  world.deviceHold = new Promise((resolve) => {
    release = resolve;
  });
  await scenario(async ({ server, api }) => {
    const starting = api("POST", ROUTE, connectBody());
    await until(() => world.callsTo("device").length === 1);
    assert.equal((await api("DELETE", ROUTE)).json.state, "disconnected");
    release();
    const answer = await starting;
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { state: "disconnected" }, "cancelled: no problem to show");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(world.callsTo("token").length, 0, "nobody asked GitHub whether the code was typed");
    assert.deepEqual(status(server), { state: "disconnected" });
  }, { world });
});

test("G10: a broker that could take a refresh token anywhere is refused: http (but on this computer), credentials, a query, a fragment, nothing", async () => {
  await scenario(async ({ api, world }) => {
    const invalid = [
      "http://broker.example.com", "ftp://broker.example.com", "https://user:pass@broker.example.com", "https://broker.example.com?x=1", "https://broker.example.com/#frag", "https://broker.example.com/?", "not a url", "//broker.example.com", "https://",
    ];
    for (const broker of invalid) {
      const refused = await api("POST", ROUTE, connectBody({ broker }));
      assert.equal(refused.status, 422, `${broker} is refused`);
      assert.equal(refused.json.code, "invalid_url");
    }
    for (const body of [{}, { clientId: CLIENT_ID }, { broker: BROKER }, { clientId: "x", broker: BROKER }, { clientId: "has space in it", broker: BROKER }, { clientId: 7, broker: BROKER }, { clientId: CLIENT_ID, broker: 5 }]) {
      assert.equal((await api("POST", ROUTE, body)).status, 400, JSON.stringify(body));
    }
    assert.equal(world.calls.length, 0, "nothing went out for any of them");
    for (const broker of ["http://127.0.0.1:8787", "http://localhost:8787/", "https://broker.example.com/base/"]) {
      const accepted = await api("POST", ROUTE, connectBody({ broker }));
      assert.equal(accepted.status, 200, broker);
      assert.equal(accepted.json.state, "pending");
      await api("DELETE", ROUTE);
    }
  });
});

test("G11: the owner's list of brokers (githubConnection.allowedBrokerOrigins) is obeyed, and survives a restart of the server", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-ghconn-allow-"));
  const world = fakeWorld();
  const open = () => startNarrariumServer({ dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] }, githubConnection: world.options });
  try {
    let server = await open();
    await server.data.updateConfig((next) => {
      next.githubConnection = { allowedBrokerOrigins: ["https://broker.example.com/some/path", "http://broker.example.org", "garbage", "https://other-broker.example.net"] };
    });
    assert.deepEqual(server.data.config.githubConnection.allowedBrokerOrigins, ["https://broker.example.com", "https://other-broker.example.net"], "origins, in https, the rest dropped");
    await server.close();
    server = await open();
    try {
      const { token } = await server.auth.issue("t", ["read", "write"]);
      const client = new NarrariumServerClient({ baseUrl: server.url, token });
      assert.deepEqual(server.data.config.githubConnection.allowedBrokerOrigins, ["https://broker.example.com", "https://other-broker.example.net"], "the list is still there");
      const refused = await client.connectGitHub({ clientId: CLIENT_ID, broker: "https://evil.example.com" }).then(() => null, (error) => error);
      assert.equal(refused.status, 422);
      assert.match(refused.message, /allowedBrokerOrigins/);
      assert.equal(world.calls.length, 0);
      assert.equal((await client.connectGitHub({ clientId: CLIENT_ID, broker: `${BROKER}/` })).state, "pending");
      await client.disconnectGitHub();
      await server.data.updateConfig((next) => {
        next.githubConnection = { allowedBrokerOrigins: [] };
      });
      assert.equal((await client.connectGitHub({ clientId: CLIENT_ID, broker: BROKER }).then(() => null, (error) => error)).status, 422, "an empty list accepts none");
    } finally {
      await server.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("G12: the broker is reachable by the outbound guard once it is pinned, github.com always, and nothing else", async () => {
  assert.equal(isBuiltInOutboundOrigin(new URL("https://github.com/login/device/code")), true);
  assert.equal(isBuiltInOutboundOrigin(new URL("https://api.github.com/user")), true);
  assert.equal(isBuiltInOutboundOrigin(new URL("https://broker.example.com/oauth/github/refresh")), false, "a broker is not built in: it is the one the owner pinned");
  await scenario(async ({ server, api, world }) => {
    assert.deepEqual(server.allowedBases(), []);
    await connect({ server, api, world });
    assert.deepEqual(server.allowedBases(), [BROKER]);
    await api("DELETE", ROUTE);
    assert.deepEqual(server.allowedBases(), []);
  });
});

// ---------------------------------------------------------------------------------------------
// Renewing: the broker, the rotation, one at a time
// ---------------------------------------------------------------------------------------------

test("G13: a token that ends soon is renewed through the broker's refresh route, and the rotated pair is saved BEFORE the new token is used", async () => {
  await scenario(async ({ server, api, world }) => {
    await connect({ server, api, world });
    const first = { ...world.current };
    assert.equal(await server.githubConnection.accessToken(), first.access, "while it lasts, the same token");
    assert.equal(world.refreshes, 0, "and nothing is renewed early");

    world.advance(EIGHT_HOURS - MARGIN + 1000);
    const writes = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const write = server.data.writeGitHubConnection.bind(server.data);
    server.data.writeGitHubConnection = async (text) => {
      writes.push(JSON.parse(text));
      await gate;
      return write(text);
    };
    let used = false;
    const waiting = server.githubConnection.accessToken().then((token) => {
      used = true;
      return token;
    });
    try {
      await until(() => writes.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(used, false, "the new token is not handed out while its pair is not on disk");
      assert.equal(writes[0].refreshToken, world.current.refresh, "what is being saved is the rotated refresh token");
      assert.notEqual(writes[0].refreshToken, first.refresh);
      assert.equal(status(server).renewedAt, undefined, "and the status does not claim a renewal that is not saved");
    } finally {
      release();
    }
    const renewed = await waiting;
    server.data.writeGitHubConnection = write;
    assert.equal(renewed, world.current.access);
    assert.notEqual(renewed, first.access);
    assert.equal(world.refreshes, 1);
    const refresh = world.callsTo("broker:refresh")[0];
    assert.deepEqual(refresh.body, { refreshToken: first.refresh }, "the broker gets the refresh token, and nothing else");
    assert.equal(refresh.url, `${BROKER}/oauth/github/refresh`, "the route the browser uses");
    assert.equal(refresh.headers.origin, undefined, "a server sends no Origin: the Worker serves it as it serves curl");
    const stored = JSON.parse(await server.data.readGitHubConnection());
    assert.equal(stored.refreshToken, world.current.refresh, "the saved pair is the rotated one");
    const after = status(server);
    assert.equal(after.renewedAt, new Date(world.clock).toISOString());
    assert.equal(after.accessTokenExpiresAt, new Date(world.clock + EIGHT_HOURS).toISOString());
    assert.equal(after.state, "connected");
    assert.equal(after.problem, undefined);
    assert.equal(after.login, "octocat", "the account is kept across renewals");
    // And the next renewal works from the new refresh token: GitHub's rotation would refuse the old one.
    world.advance(EIGHT_HOURS - MARGIN + 1000);
    assert.equal(await server.githubConnection.accessToken(), world.current.access);
    assert.equal(world.refreshes, 2);
    assert.equal(status(server).state, "connected");
  });
});

test("G14: several renewals asked at once are one: one call to the broker, and every caller gets the same new token", async () => {
  await scenario(async ({ server, api, world }) => {
    await connect({ server, api, world });
    world.advance(EIGHT_HOURS - 5 * 60_000);
    const tokens = await Promise.all(Array.from({ length: 12 }, () => server.githubConnection.accessToken()));
    assert.equal(world.refreshes, 1, "GitHub rotates the refresh token: a second call would be refused and the connection lost");
    assert.equal(new Set(tokens).size, 1);
    assert.equal(tokens[0], world.current.access);
    assert.equal(status(server).state, "connected");
    // A caller that comes a moment later finds the renewed token: still one.
    await server.githubConnection.accessToken();
    assert.equal(world.refreshes, 1);
  });
});

test("G15: a server that restarts keeps its connection, and renews it with the pair it saved", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-ghconn-restart-"));
  const world = fakeWorld();
  const open = () => startNarrariumServer({ dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] }, githubConnection: world.options });
  try {
    let server = await open();
    let api = await rawApi(server);
    await connect({ server, api, world });
    const before = status(server);
    await server.close();

    server = await open();
    try {
      api = await rawApi(server);
      const same = (await api("GET", ROUTE)).json;
      assert.deepEqual(same, before, "the same connection, with no new sign-in");
      assert.equal(await server.githubConnection.accessToken(), world.current.access);
      world.advance(EIGHT_HOURS - MARGIN + 1);
      assert.equal(await server.githubConnection.accessToken(), world.current.access, "the saved refresh token still works");
      assert.equal(world.refreshes, 1);
      assert.equal(server.data.knownSecrets().includes(world.current.access), true, "and the tokens are among the secrets kept out of every record");
      assert.equal(server.data.knownSecrets().includes(world.current.refresh), true);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("G16: GitHub refuses the refresh token: the connection is lost, nothing usable is kept, books are told in words, and it survives a restart as lost", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-ghconn-lost-"));
  const world = fakeWorld();
  const open = () => startNarrariumServer({ dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] }, githubConnection: world.options });
  try {
    let server = await open();
    let api = await rawApi(server);
    await connect({ server, api, world });
    world.current = { access: "x", refresh: "somebody-else-used-it" };
    world.advance(EIGHT_HOURS);
    const failure = await server.githubConnection.accessToken().then(() => null, (error) => error);
    assert.equal(failure.status, 412);
    assert.equal(failure.code, "github_connection_required");
    assert.match(failure.message, /connect it again/i);
    const lost = status(server);
    assert.equal(lost.state, "needs-reconnect");
    assert.equal(lost.problem.code, "renewal-failed");
    assert.equal(lost.login, "octocat");
    assert.equal(lost.broker, BROKER);
    assert.equal(lost.accessTokenExpiresAt, undefined);
    const stored = JSON.parse(await server.data.readGitHubConnection());
    assert.equal(stored.state, "needs-reconnect");
    assert.equal(stored.accessToken, undefined, "nothing usable is kept");
    assert.equal(stored.refreshToken, undefined);
    assert.deepEqual(server.data.knownSecrets().filter((secret) => secret.startsWith("ghu_") || secret.startsWith("ghr_")), []);
    const calls = world.refreshes;
    await server.githubConnection.accessToken().catch(() => undefined);
    assert.equal(world.refreshes, calls, "a lost connection is not asked about again");
    await server.close();

    server = await open();
    try {
      api = await rawApi(server);
      assert.equal((await api("GET", ROUTE)).json.state, "needs-reconnect", "still lost after a restart");
      assert.equal((await api("POST", ROUTE, connectBody({ broker: "https://other-broker.example.net" }))).status, 409, "a lost connection stays pinned: disconnect first to change them");
      assert.equal((await api("POST", ROUTE, connectBody({ clientId: "Iv1.aaaaaaaaaaaaaaaa" }))).status, 409);
      world.current = undefined;
      world.script.push("tokens");
      assert.equal((await api("POST", ROUTE, connectBody())).json.state, "pending", "connecting again with what it is pinned to is allowed");
      await until(() => status(server).state === "connected");
      assert.equal(await server.githubConnection.accessToken(), world.current.access);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("G17: a broker that cannot be reached is tried again with a growing wait while the token lasts, and the token is used until it really ends", async () => {
  await scenario(async ({ server, api, world }) => {
    await connect({ server, api, world });
    const token = world.current.access;
    world.broker = "down";
    world.advance(EIGHT_HOURS - MARGIN + 1000);
    assert.equal(await server.githubConnection.accessToken(), token, "the old token still works: it is used");
    assert.equal(world.callsTo("broker:refresh").length, 1);
    assert.equal(status(server).problem.code, "broker-unreachable");
    assert.equal(status(server).state, "connected");
    assert.match(status(server).problem.message, /keeps using the current token/);
    await server.githubConnection.accessToken();
    assert.equal(world.callsTo("broker:refresh").length, 1, "not asked again at once");
    world.advance(31_000);
    await server.githubConnection.accessToken();
    assert.equal(world.callsTo("broker:refresh").length, 2, "asked again after the first wait (30 s)");
    world.advance(31_000);
    await server.githubConnection.accessToken();
    assert.equal(world.callsTo("broker:refresh").length, 2, "the second wait is twice as long");
    world.advance(30_000);
    await server.githubConnection.accessToken();
    assert.equal(world.callsTo("broker:refresh").length, 3);
    // It comes back: renewed, and the problem is gone.
    world.broker = "ok";
    world.advance(10 * 60_000);
    const renewed = await server.githubConnection.accessToken();
    assert.notEqual(renewed, token);
    assert.equal(status(server).problem, undefined);
    assert.equal(status(server).state, "connected");
  });
});

test("G18: a token that has ended and cannot be renewed fails the book with a clear 502, and a broker that is back brings it back", async () => {
  await scenario(async ({ server, api, world }) => {
    await connect({ server, api, world });
    world.broker = "down";
    world.advance(EIGHT_HOURS + 1000);
    const failure = await server.githubConnection.accessToken().then(() => null, (error) => error);
    assert.equal(failure.status, 502);
    assert.equal(failure.code, "github_connection_unavailable");
    assert.match(failure.message, /could not be renewed/);
    assert.equal(status(server).state, "connected", "not lost: the broker is down, not GitHub's refusal");
    world.broker = "ok";
    world.advance(10 * 60_000);
    assert.equal(await server.githubConnection.accessToken(), world.current.access);
  });
});

test("G19: what a broker may answer instead of tokens: not configured, an error, garbage, a redirect, a huge body: each is told in words and none loses the token or follows anywhere", async () => {
  const cases = [["not-configured", "broker-not-configured"], ["error", "broker-unreachable"], ["garbage", "renewal-failed"], ["redirect", "broker-unreachable"], ["huge", "broker-unreachable"], ["down", "broker-unreachable"]];
  for (const [mode, code] of cases) {
    await scenario(async ({ server, api, world }) => {
      await connect({ server, api, world });
      const token = world.current.access;
      world.broker = mode;
      world.advance(EIGHT_HOURS - MARGIN + 1000);
      assert.equal(await server.githubConnection.accessToken(), token, `${mode}: the old token goes on`);
      assert.equal(status(server).state, "connected", mode);
      assert.equal(status(server).problem.code, code, mode);
      assert.equal(JSON.stringify(status(server)).includes("boom"), false, "what the broker said in prose is never quoted");
      assert.equal(world.calls.filter((call) => /evil/.test(call.url)).length, 0, "no redirect was followed");
    });
  }
});

test("G20: a call that never answers is given up after the fixed time, and the old token goes on", async () => {
  const world = fakeWorld();
  await scenario(async ({ server, api }) => {
    await connect({ server, api, world });
    const token = world.current.access;
    world.broker = "slow";
    world.advance(EIGHT_HOURS - MARGIN + 1000);
    const started = Date.now();
    assert.equal(await server.githubConnection.accessToken(), token);
    assert.ok(Date.now() - started < 5000, "cut at the time the options give");
    assert.equal(status(server).problem.code, "broker-unreachable");
  }, { world: Object.assign(world, { options: { ...world.options, timeoutMs: 200 } }) });
});

test("G21: a renewal that cannot be saved is used from memory and saved again at the next use; the connection is not lost", async () => {
  await scenario(async ({ server, api, world }) => {
    await connect({ server, api, world });
    const write = server.data.writeGitHubConnection.bind(server.data);
    let failing = true;
    server.data.writeGitHubConnection = async (text) => {
      if (failing) throw new Error("disk full");
      return write(text);
    };
    world.advance(EIGHT_HOURS - MARGIN + 1000);
    const renewed = await server.githubConnection.accessToken();
    assert.equal(renewed, world.current.access);
    assert.equal(status(server).problem.code, "renewal-failed");
    assert.match(status(server).problem.message, /could not be saved/);
    failing = false;
    assert.equal(await server.githubConnection.accessToken(), renewed);
    await until(async () => JSON.parse(await server.data.readGitHubConnection()).refreshToken === world.current.refresh);
    await until(() => status(server).problem === undefined);
  });
});

test("G22: the server renews by itself, with no book asking: a timer wakes it up before the token ends", async () => {
  const world = fakeWorld({ accessLifetime: 3 });
  await scenario(async ({ server, api }) => {
    await connect({ server, api, world });
    // The broker was asked, and a moment later the server has stored its answer: the renewal is waited for, not the call that asks for it.
    await until(() => world.refreshes >= 1 && status(server).renewedAt, 8000);
    assert.equal(status(server).state, "connected");
    assert.ok(status(server).renewedAt);
  }, { world: Object.assign(world, { options: { fetch: world.fetch, sleep: world.sleep, renewMarginMs: 2000 } }) });
});

// ---------------------------------------------------------------------------------------------
// Disconnecting
// ---------------------------------------------------------------------------------------------

test("G23: disconnecting deletes the saved pair, asks the broker to revoke the server's own token (not the whole authorization), and a second disconnect is not an error", async () => {
  await scenario(async ({ server, client, api, world, dataDir }) => {
    await connect({ server, api, world });
    const token = world.current.access;
    const answer = await client.disconnectGitHub();
    assert.deepEqual(answer, { state: "disconnected" });
    await assert.rejects(readFile(path.join(dataDir, "private", "github-connection.json")), { code: "ENOENT" });
    const revoked = world.callsTo("broker:revoke-token");
    assert.equal(revoked.length, 1);
    assert.deepEqual(revoked[0].body, { token });
    assert.equal(world.callsTo("broker:revoke").length, 0, "the Worker's revoke route deletes the owner's whole authorization of the app, the browser's too: it is not used");
    assert.deepEqual(server.data.knownSecrets().filter((secret) => secret.startsWith("ghu_") || secret.startsWith("ghr_")), []);
    const failure = await server.githubConnection.accessToken().then(() => null, (error) => error);
    assert.equal(failure.code, "github_connection_required");
    assert.deepEqual(await client.disconnectGitHub(), { state: "disconnected" });
    assert.equal(world.callsTo("broker:revoke-token").length, 1, "nothing more to revoke");
  });
});

test("G24: a broker that cannot revoke (an older Worker, a Worker out of reach) never keeps the owner from disconnecting", async () => {
  for (const settings of [{ revokeStatus: 404 }, { broker: "down" }, { revokeStatus: 500 }]) {
    const lines = [];
    await scenario(async ({ server, client, api, world, dataDir }) => {
      await connect({ server, api, world });
      Object.assign(world, settings);
      assert.deepEqual(await client.disconnectGitHub(), { state: "disconnected" }, JSON.stringify(settings));
      await assert.rejects(readFile(path.join(dataDir, "private", "github-connection.json")), { code: "ENOENT" });
    }, { world: fakeWorld(), extra: { log: (line) => lines.push(line) } });
    assert.ok(lines.some((line) => /revoke/.test(line)), "and the log says that it ends by itself");
  }
});

test("G25: a disconnect while a renewal is in the middle of its save waits for it: the rotated pair is never written back after the delete", async () => {
  await scenario(async ({ server, client, api, world, dataDir }) => {
    await connect({ server, api, world });
    world.advance(EIGHT_HOURS - MARGIN + 1000);
    const write = server.data.writeGitHubConnection.bind(server.data);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let saving = false;
    server.data.writeGitHubConnection = async (text) => {
      if (text !== null) {
        saving = true;
        await gate;
      }
      return write(text);
    };
    const renewing = server.githubConnection.accessToken();
    await until(() => saving);
    const disconnecting = client.disconnectGitHub();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await renewing;
    assert.deepEqual(await disconnecting, { state: "disconnected" });
    await assert.rejects(readFile(path.join(dataDir, "private", "github-connection.json")), { code: "ENOENT" }, "the delete came last");
    assert.equal(status(server).state, "disconnected");
  });
});

test("G26: a stored file that cannot be read does not stop the server: the connection is said to need making again, and a disconnect clears it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-ghconn-damaged-"));
  const world = fakeWorld();
  const open = (log) => startNarrariumServer({ dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] }, githubConnection: world.options, log });
  try {
    let server = await open();
    const api = await rawApi(server);
    await connect({ server, api, world });
    await server.close();
    await writeFile(path.join(dataDir, "private", "github-connection.json"), "{ not json");
    const lines = [];
    server = await open((line) => lines.push(line));
    try {
      const again = await rawApi(server);
      const damaged = (await again("GET", ROUTE)).json;
      assert.equal(damaged.state, "needs-reconnect");
      assert.match(damaged.problem.message, /cannot be read/);
      assert.ok(lines.some((line) => /could not be read/.test(line)));
      assert.equal((await server.githubConnection.accessToken().then(() => null, (error) => error)).code, "github_connection_required");
      assert.equal((await again("DELETE", ROUTE)).json.state, "disconnected");
      await assert.rejects(readFile(path.join(dataDir, "private", "github-connection.json")), { code: "ENOENT" });
    } finally {
      await server.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

test("G27: the device code, the access token and the refresh token appear in no answer, no log line, no error, no stream and no file of the data folder", async () => {
  const lines = [];
  const world = fakeWorld();
  await scenario(async ({ server, client, api, world: fake, dataDir }) => {
    const seen = [];
    const answers = async (...calls) => {
      for (const call of calls) seen.push(JSON.stringify(await call()));
    };
    const controller = new AbortController();
    const streamed = [];
    const stream = client.stream((message) => streamed.push(message), controller.signal).catch(() => undefined);
    fake.script.push("authorization_pending", "slow_down", "tokens");
    await answers(() => client.githubConnection());
    seen.push((await api("POST", ROUTE, connectBody())).text);
    await until(() => status(server).state === "connected");
    // Renewals, one that fails, one lost, refused requests: every kind of answer the routes have.
    fake.advance(EIGHT_HOURS - MARGIN + 1000);
    await server.githubConnection.accessToken();
    fake.broker = "error";
    fake.advance(EIGHT_HOURS - MARGIN + 1000);
    await server.githubConnection.accessToken();
    fake.broker = "ok";
    seen.push((await api("POST", ROUTE, connectBody())).text, (await api("POST", ROUTE, { clientId: "x" })).text, (await api("GET", ROUTE)).text);
    await answers(() => client.listBooks(), () => client.githubConnection());
    fake.current = { access: "x", refresh: "somebody-else-used-it" };
    fake.advance(EIGHT_HOURS);
    await server.githubConnection.accessToken().catch((error) => seen.push(JSON.stringify({ code: error.code, message: error.message })));
    seen.push((await api("GET", ROUTE)).text);
    await client.disconnectGitHub();
    await new Promise((resolve) => setTimeout(resolve, 400));
    controller.abort();
    await stream;
    const everything = [...seen, ...lines, JSON.stringify(streamed), ...(await readableFiles(dataDir)).map((entry) => `${entry.file}\n${entry.text}`)];
    for (const secret of secretsOf(fake)) {
      assert.ok(secret.length > 20);
      assert.equal(everything.some((text) => text.includes(secret)), false, `${secret.slice(0, 12)}… was found`);
      assert.equal(everything.some((text) => text.includes(Buffer.from(secret).toString("base64"))), false, "nor its base64");
    }
    assert.equal(everything.some((text) => text.includes("SECRET-looking")), false, "nor what GitHub described");
    const log = (await readFile(path.join(dataDir, "admin-log.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(log.some((entry) => entry.action === "github.connect"), "the owner's log says that a connection was started");
    assert.ok(log.some((entry) => entry.action === "github.disconnect"), "and that it was ended");
    assert.equal(log.find((entry) => entry.action === "github.connect").object, BROKER);
  }, { world, extra: { log: (line) => lines.push(line) } });
});

test("G28: a client with only `read` sees the status with its public fields only, and cannot change it", async () => {
  await scenario(async ({ server, api, world }) => {
    const reader = await rawApi(server, ["read"]);
    await connect({ server, api, world });
    const seen = await reader("GET", ROUTE);
    assert.equal(seen.status, 200);
    assert.deepEqual(Object.keys(seen.json).sort(), ["accessTokenExpiresAt", "broker", "connectedAt", "login", "refreshTokenExpiresAt", "state"]);
    assert.equal((await reader("DELETE", ROUTE)).status, 403);
    assert.equal(status(server).state, "connected", "still connected");
  });
});
