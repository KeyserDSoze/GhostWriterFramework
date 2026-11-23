import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import * as testing from "../dist/testing.mjs";
import { adminLogin, gatedAi, until, withServer } from "./helpers.mjs";
import { seededBook } from "./fake-provider.mjs";
import { startOf } from "./hold.mjs";
import { HOUR, makeClock } from "./oauth-helpers.mjs";

// The health of the server (P12), in words: one line at the top that says whether all is well or what to look at, and under it the causes. Each cause is a fact of the server, and goes
// when the fact changes. `buildHealth` is the pure part (a list of facts in, a report out); the rest goes through the real server.

const { buildHealth, HEALTH_CHECKS } = testing;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const NOW = Date.parse("2026-11-22T10:00:00.000Z");

/** The facts of a server in good health, with what a test changes. */
const facts = (extra = {}) => ({
  now: NOW,
  startedAt: NOW - 3 * HOUR,
  maintenance: false,
  serverVersion: "0.1.9",
  engineVersion: "0.1.9",
  update: { available: false, reason: "up_to_date" },
  disk: { free: 50 * GIB, total: 200 * GIB },
  git: { available: true, githubBooks: 0 },
  tunnel: { enabled: false, process: "stopped", binaryAvailable: false },
  runs: { running: 0, max: 2, refused24h: 0 },
  spend: { paused: false, damaged: false },
  books: { total: 3, unreadable: 0, error: 0, stalled: 0 },
  ...extra,
});
const checkOf = (report, id) => report.checks.find((check) => check.id === id);
const statusOf = (extra, id) => checkOf(buildHealth(facts(extra)), id).status;

test("AI calls (health): the disk row tells what the records of the AI calls keep, whether they are held back by the disk, and whether the records of some books stopped in the last day and why", () => {
  const disk = { free: 50 * GIB, total: 200 * GIB };
  const row = (aiCalls, extra = {}) => checkOf(buildHealth(facts({ disk, aiCalls, ...extra })), "disk");
  assert.deepEqual(row(undefined).facts, { freeBytes: 50 * GIB, totalBytes: 200 * GIB, warnBelowBytes: GIB, badBelowBytes: 256 * MIB }, "nothing to tell: nothing said");
  assert.deepEqual(row({ bytes: 0 }).facts.aiCallBytes, undefined);
  assert.deepEqual(row({ bytes: 3 * MIB }).facts.aiCallBytes, 3 * MIB);
  assert.equal(row({ bytes: 3 * MIB }).status, "ok", "what they keep is not a cause");

  const held = row({ bytes: 3 * MIB, hold: { freeBytes: 500 * MIB, minFreeBytes: GIB } });
  assert.equal(held.facts.aiCallsMinFreeBytes, GIB, "the disk must have this much free before they are kept again");
  assert.equal(held.status, "warn", "records that are not being kept are a cause to look, also when the free space is not one");
  assert.equal(checkOf(buildHealth(facts({ disk, aiCalls: { hold: { minFreeBytes: GIB } } })), "disk").status, "warn");
  assert.equal(row({ hold: { freeBytes: 1 } }).facts.aiCallsMinFreeBytes, undefined, "a floor that is not a number is not told");
  assert.equal(buildHealth(facts({ disk: { free: 100 * MIB, total: 200 * GIB }, aiCalls: { hold: { minFreeBytes: GIB } } })).checks.find((check) => check.id === "disk").status, "bad", "and it does not make a bad disk better");

  const failed = (kind, books = 2, at = "2026-11-22T09:00:00.000Z") => row({ failed: { books, kind, at } });
  const disks = failed("disk");
  assert.deepEqual([disks.facts.aiCallsFailedBooks, disks.facts.aiCallsFailedKind, disks.facts.aiCallsFailedAt, disks.status], [2, "disk", "2026-11-22T09:00:00.000Z", "warn"]);
  assert.deepEqual([failed("error").facts.aiCallsFailedKind, failed("error").status], ["error", "warn"]);
  for (const nothing of [failed("other"), failed("disk", 0), failed("disk", -3), failed("disk", Number.NaN), failed(undefined), row({ failed: "yes" }), row({ failed: null })]) {
    assert.equal(nothing.facts.aiCallsFailedBooks, undefined);
    assert.equal(nothing.status, "ok", "a failure that is not one said in the words of the closed list is not told");
  }
  assert.equal(failed("disk", 1, "yesterday").facts.aiCallsFailedAt, undefined, "a time that is not a time is left out");
  assert.equal(failed("disk", 1, "yesterday").facts.aiCallsFailedBooks, 1, "and the count is still told");
  assert.equal(JSON.stringify(failed("error")).includes("EACCES"), false, "only closed words and numbers: never what a failure said");

  const unreadable = checkOf(buildHealth(facts({ disk: undefined, aiCalls: { bytes: 5 * MIB, hold: { minFreeBytes: GIB }, failed: { books: 1, kind: "disk", at: "2026-11-22T09:00:00.000Z" } } })), "disk");
  assert.deepEqual([unreadable.status, unreadable.facts], ["unknown", {}], "a disk that cannot be read says only that");
});

test("P12 health: a server in good health says so, and every check is there, in the order a person reads them", () => {
  const report = buildHealth(facts());
  assert.equal(report.overall, "ok");
  assert.deepEqual(report.attention, []);
  assert.equal(report.at, new Date(NOW).toISOString());
  assert.deepEqual(report.checks.map((check) => check.id), ["server", "versions", "disk", "git", "tunnel", "runs", "spend", "books", "error"]);
  assert.deepEqual(report.checks.map((check) => check.id), [...HEALTH_CHECKS]);
  assert.deepEqual(report.checks.map((check) => check.status), ["ok", "ok", "ok", "ok", "off", "ok", "ok", "ok", "ok"]);
  assert.deepEqual(checkOf(report, "server").facts, { startedAt: new Date(NOW - 3 * HOUR).toISOString(), uptimeMs: 3 * HOUR, maintenance: false });
  assert.deepEqual(checkOf(report, "versions").facts, { server: "0.1.9", engine: "0.1.9", update: "none" });
});

test("P12 health: the free space is judged against two thresholds, and a disk that cannot be read is said to be unknown, not fine", () => {
  const disk = (free) => statusOf({ disk: { free, total: 200 * GIB } }, "disk");
  assert.equal(disk(50 * GIB), "ok");
  assert.equal(disk(2 * GIB), "ok");
  assert.equal(disk(900 * MIB), "warn", "under a gibibyte");
  assert.equal(disk(100 * MIB), "bad", "under a quarter of one: the next commit may not fit");
  assert.equal(disk(0), "bad");
  assert.equal(statusOf({ disk: undefined }, "disk"), "unknown");
  const low = checkOf(buildHealth(facts({ disk: { free: 900 * MIB, total: 200 * GIB } })), "disk");
  assert.deepEqual(low.facts, { freeBytes: 900 * MIB, totalBytes: 200 * GIB, warnBelowBytes: GIB, badBelowBytes: 256 * MIB });
  assert.equal(buildHealth(facts({ disk: undefined })).overall, "ok", "not knowing is not a cause for attention");
});

test("P12 health: git matters when a book is on GitHub, and is a remark when there is none", () => {
  assert.equal(statusOf({ git: { available: true, githubBooks: 2 } }, "git"), "ok");
  assert.equal(statusOf({ git: { available: false, githubBooks: 2 } }, "git"), "warn", "books that cannot be synced");
  assert.equal(statusOf({ git: { available: false, githubBooks: 0 } }, "git"), "info", "only local books can be hosted");
  assert.deepEqual(checkOf(buildHealth(facts({ git: { available: false, githubBooks: 2 } })), "git").facts, { available: false, githubBooks: 2 });
});

test("P12 health: the Cloudflare connector: off when it is not used, well when it runs, a cause when it was meant to and does not", () => {
  const tunnel = (extra) => statusOf({ tunnel: { enabled: true, process: "running", binaryAvailable: true, hostname: "https://books.example.com", ...extra } }, "tunnel");
  assert.equal(tunnel({}), "ok");
  assert.equal(tunnel({ process: "stopped" }), "warn", "switched on and not running");
  assert.equal(tunnel({ process: "failed", lastErrorCode: "missing" }), "bad");
  assert.equal(statusOf({ tunnel: { enabled: false, process: "failed", binaryAvailable: false } }, "tunnel"), "off", "a connector nobody asked for is not a problem");
  assert.deepEqual(checkOf(buildHealth(facts({ tunnel: { enabled: true, process: "failed", binaryAvailable: false, lastErrorCode: "missing" } })), "tunnel").facts, { enabled: true, process: "failed", binaryAvailable: false, errorCode: "missing" });
});

test("P12 health: runs that were refused for lack of a place are a cause; a server that is simply full is only a remark", () => {
  assert.equal(statusOf({ runs: { running: 2, max: 2, refused24h: 0 } }, "runs"), "info");
  assert.equal(statusOf({ runs: { running: 1, max: 2, refused24h: 0 } }, "runs"), "ok");
  assert.equal(statusOf({ runs: { running: 2, max: 2, refused24h: 3 } }, "runs"), "warn");
  assert.deepEqual(checkOf(buildHealth(facts({ runs: { running: 2, max: 2, refused24h: 3 } })), "runs").facts, { running: 2, max: 2, refused24h: 3 });
});

test("P12 health: AI spending that is paused, a cap that is reached today, and a record that was damaged are causes", () => {
  assert.equal(statusOf({ spend: { paused: true, damaged: false } }, "spend"), "warn");
  assert.equal(statusOf({ spend: { paused: false, damaged: false, capReached: "cost-per-day" } }, "spend"), "warn");
  assert.equal(statusOf({ spend: { paused: false, damaged: true } }, "spend"), "warn");
  assert.deepEqual(checkOf(buildHealth(facts({ spend: { paused: true, damaged: false, capReached: "tokens-per-day" } })), "spend").facts, { paused: true, capReached: "tokens-per-day", damaged: false });
});

test("P12 health: books that cannot be read, that stopped with an error, or that look stalled are a cause, counted", () => {
  assert.equal(statusOf({ books: { total: 5, unreadable: 0, error: 0, stalled: 0 } }, "books"), "ok");
  for (const problem of [{ unreadable: 1 }, { error: 1 }, { stalled: 1 }]) assert.equal(statusOf({ books: { total: 5, unreadable: 0, error: 0, stalled: 0, ...problem } }, "books"), "warn", JSON.stringify(problem));
  assert.deepEqual(checkOf(buildHealth(facts({ books: { total: 5, unreadable: 1, error: 2, stalled: 1 } })), "books").facts, { total: 5, unreadable: 1, error: 2, stalled: 1 });
});

test("P12 health: the last error of the server is a cause for a day, and a remark after; it is told by when, which request, and where, never by what it said", () => {
  const error = (hoursAgo) => ({ lastError: { at: new Date(NOW - hoursAgo * HOUR).toISOString(), requestId: "a1b2c3d4", where: "api", route: "POST /api/v1/books/b/director/ask", name: "TypeError" } });
  assert.equal(statusOf({}, "error"), "ok");
  assert.equal(statusOf(error(2), "error"), "warn");
  assert.equal(statusOf(error(23), "error"), "warn");
  assert.equal(statusOf(error(25), "error"), "info");
  assert.deepEqual(checkOf(buildHealth(facts(error(2))), "error").facts, { at: new Date(NOW - 2 * HOUR).toISOString(), requestId: "a1b2c3d4", where: "api", route: "POST /api/v1/books/b/director/ask", name: "TypeError" });
});

test("P12 health: a new version is a remark, one that this server refuses is a cause, and one that cannot be looked for is a remark too", () => {
  const update = (extra) => statusOf({ update: extra }, "versions");
  assert.equal(update({ available: false, reason: "up_to_date" }), "ok");
  assert.equal(update({ available: false, reason: "not_published" }), "ok");
  assert.equal(update({ available: true, latestVersion: "0.1.10" }), "info");
  assert.equal(update({ available: false, reason: "no_trusted_release" }), "warn", "a release that fails its checks is something to look at");
  assert.equal(update({ available: false, reason: "unavailable" }), "info");
  assert.equal(update({ available: true, latestVersion: "0.1.10", pending: true }), "info");
  assert.equal(statusOf({ update: undefined }, "versions"), "ok", "no answer yet");
  assert.deepEqual(checkOf(buildHealth(facts({ update: { available: true, latestVersion: "0.1.10" } })), "versions").facts, { server: "0.1.9", engine: "0.1.9", update: "available", latest: "0.1.10" });
  assert.equal(checkOf(buildHealth(facts({ update: { available: false, reason: "no_trusted_release" } })), "versions").facts.update, "refused");
  assert.equal(checkOf(buildHealth(facts({ update: { available: true, latestVersion: "0.1.10", pending: true } })), "versions").facts.update, "pending");
});

test("P12 health: the summary lists only what needs a look, in the order of the checks, and a remark is not one of them", () => {
  const report = buildHealth(facts({
    disk: { free: 100 * MIB, total: 200 * GIB },
    git: { available: false, githubBooks: 0 },
    update: { available: true, latestVersion: "0.1.10" },
    tunnel: { enabled: true, process: "stopped", binaryAvailable: true },
    runs: { running: 2, max: 2, refused24h: 1 },
    maintenance: true,
  }));
  assert.equal(report.overall, "attention");
  assert.deepEqual(report.attention, ["disk", "tunnel", "runs"]);
  assert.equal(checkOf(report, "server").status, "info", "restarting for an update is a remark");
  assert.equal(checkOf(report, "server").facts.maintenance, true);
  assert.equal(checkOf(report, "git").status, "info");
  assert.equal(checkOf(report, "versions").status, "info");
});

test("P12 health: facts that are missing, odd or hostile never break the report", () => {
  assert.doesNotThrow(() => buildHealth({ now: NOW, startedAt: NOW, serverVersion: "0.1.9", engineVersion: "0.1.9" }));
  const report = buildHealth(facts({ disk: { free: Number.NaN, total: -1 }, runs: { running: "many", max: 0 }, books: undefined, tunnel: undefined, spend: undefined, git: undefined, lastError: { at: "not a time" } }));
  assert.equal(report.checks.length, 9);
  assert.ok(report.checks.every((check) => ["ok", "info", "warn", "bad", "off", "unknown"].includes(check.status)));
  assert.equal(buildHealth(facts({ startedAt: NOW + HOUR })).checks[0].facts.uptimeMs, 0, "a clock that went back is not a negative uptime");
});

test("P12 health: a request is told by its shape: no query, and no book, rule, chapter, client or slug", () => {
  const { routeShape } = testing;
  assert.equal(routeShape("post", "/api/v1/books/b/director/ask?token=SECRET-QUERY"), "POST /api/v1/books/:id/director/ask");
  assert.equal(routeShape("GET", "/api/v1/books/autopilot/autopilot/rules/my-rule"), "GET /api/v1/books/:id/autopilot/rules/:id", "a book that is called like a word of the address is still a book");
  assert.equal(routeShape("DELETE", "/api/v1/books/b/mcp/clients/abc123"), "DELETE /api/v1/books/:id/mcp/clients/:id");
  assert.equal(routeShape("POST", "/api/v1/books/b/chapters/chapter-01/freeze"), "POST /api/v1/books/:id/chapters/:id/freeze");
  assert.equal(routeShape("GET", "/api/v1/books/b/autopilot/calls?before=2026-11-20T10%3A00%3A00.000Z%7Cactivity_x"), "GET /api/v1/books/:id/autopilot/calls", "the records of the AI calls: no cursor, no task and no call in what the health says");
  assert.equal(routeShape("GET", "/api/v1/books/b/autopilot/calls/tasks/activity_1f2e3d"), "GET /api/v1/books/:id/autopilot/calls/tasks/:id");
  assert.equal(routeShape("GET", "/api/v1/books/b/autopilot/calls/activity_1f2e3d-0003/text?field=response&from=40"), "GET /api/v1/books/:id/autopilot/calls/:id/text");
  assert.equal(routeShape("PUT", "/api/v1/books/b/autopilot/calls/tasks/activity_1f2e3d/keep"), "PUT /api/v1/books/:id/autopilot/calls/tasks/:id/keep");
  assert.equal(routeShape("POST", "/mcp/my-private-slug"), "POST /mcp/:id");
  assert.equal(routeShape("GET", "/.well-known/oauth-protected-resource/mcp/my-private-slug"), "GET /.well-known/oauth-protected-resource/mcp/:id");
  assert.equal(routeShape("POST", "/admin/api/mcp/revoke"), "POST /admin/api/mcp/revoke");
  assert.equal(routeShape("POST", "/oauth/authorize/approve?code=SECRET-CODE"), "POST /oauth/authorize/approve");
  assert.equal(routeShape("GET", "/a/b/../../api/v1/info"), "GET /api/v1/info", "the way the server reads the address");
  assert.equal(routeShape("GET", undefined), "GET /");
  assert.equal(routeShape("GE T", "/x"), "? /:id", "a method that is not a word is not told");
  assert.equal(routeShape("GET", `/${"x".repeat(5000)}`), "GET /:id");
  assert.ok(routeShape("GET", `/${"a/".repeat(50)}`).split("/").length <= 12, "a long address is cut");
});

test("P12 health: the kind of an error is its name and nothing else", () => {
  const { errorKind } = testing;
  assert.equal(errorKind(new TypeError("SECRET")), "TypeError");
  assert.equal(errorKind(Object.assign(new Error("x"), { name: "Bad name! with <b>markup</b>" })), "Error", "a name that is not one");
  assert.equal(errorKind("a string that was thrown"), "NotAnError");
  assert.equal(errorKind(null), "NotAnError");
});

test("P12 health: the free space is asked of the system for the folder, and a folder that is not there is not known", async () => {
  const { diskSpace } = testing;
  const found = await diskSpace(os.tmpdir());
  assert.ok(found && Number.isFinite(found.free) && found.free >= 0 && found.total > 0 && found.total >= found.free, JSON.stringify(found));
  assert.equal(await diskSpace(path.join(os.tmpdir(), "narrarium-no-such-folder", "x")), undefined);
});

// ---------------------------------------------------------------------------------------------
// Through the server
// ---------------------------------------------------------------------------------------------

const health = async (owner) => {
  const answer = await owner.call("GET", "/admin/api/health");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
};
const status = async (owner, id) => checkOf(await health(owner), id);

/** A disk that the test can fill. */
const diskOf = (state) => async () => (state.free === undefined ? undefined : { free: state.free, total: 100 * GIB });

function fakeCloudflared() {
  const children = [];
  let pid = 42_000;
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.pid = (pid += 1);
    child.exitCode = null;
    child.stdout = Object.assign(new EventEmitter(), { resume() {} });
    child.stderr = Object.assign(new EventEmitter(), { resume() {} });
    child.finish = (code, signal = null) => {
      if (child.exitCode !== null) return;
      child.exitCode = code ?? 0;
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
    };
    child.kill = (signal) => {
      setImmediate(() => child.finish(null, signal));
      return true;
    };
    if (args[0] === "--version") {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("cloudflared version 2025.6.1 (built 2025-06-01-1200 UTC)\n"));
        child.finish(0);
      });
    } else children.push(child);
    return child;
  };
  return { spawn, children };
}

test("P12 health: a server in good health answers that all is well, how long it has been up and which versions it runs", async () => {
  const clock = makeClock();
  const disk = { free: 40 * GIB };
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const report = await health(owner);
    assert.equal(report.overall, "ok", JSON.stringify(report.checks.filter((check) => !["ok", "off"].includes(check.status))));
    assert.deepEqual(report.attention, []);
    assert.equal(checkOf(report, "server").facts.uptimeMs, 0);
    assert.deepEqual([checkOf(report, "versions").facts.server, checkOf(report, "versions").facts.engine, checkOf(report, "versions").facts.update], [testing.SERVER_VERSION, (await import("narrarium-engine")).ENGINE_VERSION, "none"]);
    assert.deepEqual(checkOf(report, "disk").facts.freeBytes, 40 * GIB);
    assert.equal(checkOf(report, "git").status, "ok", "git is installed where the tests run");
    assert.equal(checkOf(report, "tunnel").status, "off");
    clock.advance(2 * HOUR + 5 * 60_000);
    const later = await health(owner);
    assert.equal(checkOf(later, "server").facts.uptimeMs, 2 * HOUR + 5 * 60_000, "since the server started, by the server's own clock");
    assert.equal(checkOf(later, "server").facts.startedAt, "2026-11-22T10:00:00.000Z");
  }, { now: clock.now, admin: { disk: diskOf(disk) } });
});

test("P12 health: the free space of the data folder is a cause when it is low, and goes when there is room again", async () => {
  const disk = { free: 40 * GIB };
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    assert.equal((await status(owner, "disk")).status, "ok");
    disk.free = 700 * MIB;
    let report = await health(owner);
    assert.deepEqual([checkOf(report, "disk").status, report.overall, report.attention], ["warn", "attention", ["disk"]]);
    disk.free = 50 * MIB;
    assert.equal((await status(owner, "disk")).status, "bad");
    disk.free = undefined;
    report = await health(owner);
    assert.deepEqual([checkOf(report, "disk").status, report.overall], ["unknown", "ok"]);
    disk.free = 30 * GIB;
    report = await health(owner);
    assert.deepEqual([checkOf(report, "disk").status, report.overall, report.attention], ["ok", "ok", []]);
  }, { admin: { disk: diskOf(disk) } });
});

test("P12 health: the real disk is asked when nothing says otherwise, and answers with a number", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const disk = await status(owner, "disk");
    assert.ok(["ok", "warn", "bad"].includes(disk.status), disk.status);
    assert.ok(Number.isFinite(disk.facts.freeBytes) && disk.facts.freeBytes >= 0 && disk.facts.totalBytes >= disk.facts.freeBytes);
  });
});

test("P12 health: the Cloudflare connector is a cause when it was switched on and stopped, and goes when it runs again or is taken away", async () => {
  const TOKEN = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";
  const fake = fakeCloudflared();
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    assert.equal((await status(owner, "tunnel")).status, "off");
    assert.equal((await owner.call("POST", "/admin/api/tunnel/configure", { token: TOKEN, hostname: "https://books.example.com" })).status, 200);
    assert.deepEqual([(await status(owner, "tunnel")).status, (await status(owner, "tunnel")).facts.process], ["ok", "running"]);
    fake.children.at(-1).finish(1);
    await until(async () => (await status(owner, "tunnel")).status !== "ok");
    const stopped = await health(owner);
    assert.ok(["warn", "bad"].includes(checkOf(stopped, "tunnel").status), checkOf(stopped, "tunnel").status);
    assert.equal(stopped.overall, "attention");
    assert.ok(stopped.attention.includes("tunnel"));
    assert.equal((await owner.call("POST", "/admin/api/tunnel/restart", {})).status, 200);
    assert.equal((await status(owner, "tunnel")).status, "ok");
    assert.equal((await owner.call("POST", "/admin/api/tunnel/remove", {})).status, 200);
    assert.equal((await status(owner, "tunnel")).status, "off");
    assert.equal(JSON.stringify(await health(owner)).includes(TOKEN), false, "never the token");
  }, { tunnel: { findBinary: () => "/opt/cloudflared/bin/cloudflared", spawn: fake.spawn, detectOtherConnectors: async () => [] }, admin: { disk: diskOf({ free: 40 * GIB }) } });
});

test("P12 health: a run that was refused for lack of a place is a cause for a day, and goes with the day; a full server is only a remark", async () => {
  const slow = gatedAi();
  const clock = makeClock();
  await withServer(async (server, client) => {
    // Whatever fails below, the held calls are let go: a server cannot close while a call is held.
    try {
      const owner = await adminLogin(server);
      for (const id of ["a", "b", "c"]) await seededBook(client, id);
      await client.startAutopilot("a", startOf(1));
      await slow.started;
      await client.startAutopilot("b", startOf(1));
      let runs = await status(owner, "runs");
      assert.deepEqual([runs.status, runs.facts], ["info", { running: 2, max: 2, refused24h: 0 }], "full, and nobody was turned away");
      await assert.rejects(() => client.startAutopilot("c", startOf(1)), (error) => error.status === 429 && error.code === "too_many_runs");
      runs = await status(owner, "runs");
      assert.deepEqual([runs.status, runs.facts], ["warn", { running: 2, max: 2, refused24h: 1 }]);
      assert.ok((await health(owner)).attention.includes("runs"));
      clock.advance(25 * HOUR);
      runs = await status(owner, "runs");
      assert.deepEqual([runs.status, runs.facts.refused24h], ["info", 0], "a day later it is old news");
      await client.pauseAutopilot("a", "now");
      await client.pauseAutopilot("b", "now");
      slow.release();
      await until(async () => !(await client.autopilot("a")).running && !(await client.autopilot("b")).running);
      runs = await status(owner, "runs");
      assert.deepEqual([runs.status, runs.facts.running], ["ok", 0]);
    } finally {
      slow.release();
    }
  }, { ai: slow.ai, now: clock.now, admin: { disk: diskOf({ free: 40 * GIB }) } });
});

test("P12 health: AI spending that is paused or capped is a cause, and goes when the owner resumes or raises the cap", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    assert.equal((await status(owner, "spend")).status, "ok");
    await owner.call("POST", "/admin/api/spend", { paused: true });
    assert.deepEqual([(await status(owner, "spend")).status, (await status(owner, "spend")).facts.paused], ["warn", true]);
    await owner.call("POST", "/admin/api/spend", { paused: false });
    assert.equal((await status(owner, "spend")).status, "ok");
    await owner.call("POST", "/admin/api/spend", { maxTokensPerDay: 100 });
    server.spend.record({ usage: { inputTokens: 80, outputTokens: 40 }, usageKnown: true, cost: 0.01, costKnown: true, currency: "USD" });
    const capped = await status(owner, "spend");
    assert.deepEqual([capped.status, capped.facts.capReached], ["warn", "tokens-per-day"]);
    await owner.call("POST", "/admin/api/spend", { maxTokensPerDay: 100_000 });
    assert.equal((await status(owner, "spend")).status, "ok");
    await owner.call("POST", "/admin/api/spend", { maxTokensPerDay: 0, maxCostPerDay: 0.005 });
    assert.equal((await status(owner, "spend")).facts.capReached, "cost-per-day");
  }, { admin: { disk: diskOf({ free: 40 * GIB }) } });
});

test("P12 health: a book that stopped with an error or cannot be read is a cause, and goes when it is put right", async () => {
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    await seededBook(client, "good");
    await seededBook(client, "broken");
    assert.equal((await status(owner, "books")).status, "ok");
    await client.commitFiles("broken", [{ path: "autopilot/state.json", content: "{ not json" }], "damage");
    const books = await status(owner, "books");
    assert.deepEqual([books.status, books.facts], ["warn", { total: 2, unreadable: 1, error: 0, stalled: 0 }]);
    assert.ok((await health(owner)).attention.includes("books"));
    await client.resetAutopilot("broken");
    assert.equal((await status(owner, "books")).status, "ok");
  }, { admin: { disk: diskOf({ free: 40 * GIB }) } });
});

test("P12 health: the last error of the server is told by when, which request and where, without a word of what it said, and the request id finds it in the log", async () => {
  const lines = [];
  const clock = makeClock();
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    assert.equal((await status(owner, "error")).status, "ok");
    await seededBook(client, "b");
    const writer = await server.auth.issue("runner", ["read", "write", "run"]);
    const answer = await fetch(`${server.url}/api/v1/books/b/director/ask?secret-query=SECRET-QUERY`, { method: "POST", headers: { authorization: `Bearer ${writer.token}`, "content-type": "application/json" }, body: JSON.stringify({ target: { kind: "book" }, question: "Does it work?" }) });
    assert.equal(answer.status, 500);
    const { requestId } = await answer.json();
    const error = await status(owner, "error");
    assert.deepEqual([error.status, error.facts.requestId, error.facts.where, error.facts.route, error.facts.name, error.facts.at], ["warn", requestId, "api", "POST /api/v1/books/:id/director/ask", "Error", "2026-11-22T10:00:00.000Z"]);
    assert.ok(lines.some((line) => line.includes(requestId) && line.includes("SECRET-ERROR-TEXT")), "the log has the whole story, under that id");
    const text = JSON.stringify(await health(owner));
    for (const secret of ["SECRET-ERROR-TEXT", "SECRET-QUERY", "sk-secret", writer.token, owner.code]) assert.equal(text.includes(secret), false, `not in the report: ${secret}`);
    clock.advance(30 * HOUR);
    assert.equal((await status(owner, "error")).status, "info", "a day later it is a remark");
    assert.equal((await health(owner)).overall, "ok");
  }, {
    log: (line) => lines.push(line),
    now: clock.now,
    admin: { disk: diskOf({ free: 40 * GIB }) },
    ai: { complete: async () => { throw new Error("SECRET-ERROR-TEXT: key sk-secret-1234 rejected, see /home/owner/.secret"); } },
  });
});

test("P12 health: an error of the panel's own routes is the last error too", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    server.oauth.revokeGrant = async () => {
      throw new TypeError("SECRET-GRANT-TEXT");
    };
    const answer = await owner.call("POST", "/admin/api/mcp/revoke", { id: "x" });
    assert.equal(answer.status, 500);
    const error = await status(owner, "error");
    assert.deepEqual([error.status, error.facts.where, error.facts.route, error.facts.name], ["warn", "admin", "POST /admin/api/mcp/revoke", "TypeError"]);
    assert.equal(JSON.stringify(await health(owner)).includes("SECRET-GRANT-TEXT"), false);
  }, { admin: { disk: diskOf({ free: 40 * GIB }) } });
});

test("P12 health: a refusal on purpose (a limit, a permission, a book that is not there) is not an error of the server", async () => {
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    await assert.rejects(() => client.autopilot("nothing"), (error) => error.status === 404);
    const reader = await server.auth.issue("reader", ["read"]);
    assert.equal((await fetch(`${server.url}/api/v1/books/x/autopilot/start`, { method: "POST", headers: { authorization: `Bearer ${reader.token}` } })).status, 403);
    assert.equal((await fetch(`${server.url}/api/v1/ai`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await status(owner, "error")).status, "ok");
  }, { admin: { disk: diskOf({ free: 40 * GIB }) } });
});

test("P12 health: a new version is a remark, one that this server will not offer is a cause, and the report follows the release check", async () => {
  let answer = { packageName: "narrarium-server", available: false, signed: false, reason: "up_to_date", message: "The server already runs the latest version." };
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    assert.equal((await status(owner, "versions")).status, "ok");
    answer = { packageName: "narrarium-server", available: true, signed: true, latestVersion: "0.9.9", message: "Version 0.9.9 is available." };
    await owner.call("POST", "/admin/api/updates", { version: "0.9.9", installedVersion: testing.SERVER_VERSION }).catch(() => undefined);
    // The panel's own check is remembered for ten minutes: an owner's request asks again.
    const available = await status(owner, "versions");
    assert.deepEqual([available.status, available.facts.update, available.facts.latest], ["info", "pending", "0.9.9"], "asked for: waiting for the supervisor");
    assert.equal((await health(owner)).overall, "ok", "a remark is not a cause");
    assert.equal(checkOf(await health(owner), "server").status, "info", "and the server is about to restart");
    assert.equal(checkOf(await health(owner), "server").facts.maintenance, true);
  }, { checkRelease: async (installedVersion) => ({ installedVersion, ...answer }), supervised: true, admin: { disk: diskOf({ free: 40 * GIB }) } });
  answer = { packageName: "narrarium-server", available: false, signed: false, reason: "no_trusted_release", message: "Version 0.2.0 is not offered: its provenance was rejected, the signing certificate names another workflow." };
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const refused = await status(owner, "versions");
    assert.deepEqual([refused.status, refused.facts.update], ["warn", "refused"]);
    assert.deepEqual((await health(owner)).attention, ["versions"]);
  }, { checkRelease: async (installedVersion) => ({ installedVersion, ...answer }), supervised: true, admin: { disk: diskOf({ free: 40 * GIB }) } });
});

test("P12 health: a registry that does not answer does not hold up the report: the versions say so, and the rest is told at once", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const started = Date.now();
    const report = await health(owner);
    assert.ok(Date.now() - started < 3000, `the report waited ${Date.now() - started} ms`);
    const versions = checkOf(report, "versions");
    assert.deepEqual([versions.status, versions.facts.update], ["ok", "unknown"], "no answer yet is not a cause for attention");
    assert.equal(checkOf(report, "disk").status, "ok");
    assert.equal(report.overall, "ok");
  }, { checkRelease: () => new Promise(() => undefined), admin: { disk: diskOf({ free: 40 * GIB }), releaseWaitMs: 50 } });
});

test("P12 health: the route needs the admin session, answers only to the panel's own origin, and the clients' API has no such route", async () => {
  await withServer(async (server) => {
    const origin = server.adminUrl;
    assert.equal((await fetch(`${origin}/admin/api/health`, { headers: { origin } })).status, 401);
    assert.equal((await fetch(`${origin}/admin/api/health`, { headers: { origin: "https://evil.example" } })).status, 403);
    const clientToken = (await server.auth.issue("c", ["read", "write", "run", "update"])).token;
    assert.equal((await fetch(`${origin}/admin/api/health`, { headers: { origin, authorization: `Bearer ${clientToken}` } })).status, 401);
    assert.equal((await fetch(`${server.url}/api/v1/health`, { headers: { authorization: `Bearer ${clientToken}` } })).status, 404);
    assert.equal((await fetch(`${server.url}/api/v1/info`)).status, 200);
    assert.equal(JSON.stringify(await (await fetch(`${server.url}/api/v1/info`)).json()).includes("uptime"), false, "what only the owner is told is not in the public answer");
  });
});

test("P12 health: with a book running, the report says how many runs and how many places, and a server that has no books has no problem with them", async () => {
  const slow = gatedAi();
  await withServer(async (server, client) => {
    try {
      const owner = await adminLogin(server);
      assert.deepEqual((await status(owner, "books")).facts, { total: 0, unreadable: 0, error: 0, stalled: 0 });
      await seededBook(client, "a");
      await client.startAutopilot("a", startOf(1));
      await slow.started;
      assert.deepEqual((await status(owner, "runs")).facts, { running: 1, max: 2, refused24h: 0 });
      await client.pauseAutopilot("a", "now");
      slow.release();
      await until(async () => !(await client.autopilot("a")).running);
    } finally {
      slow.release();
    }
  }, { ai: slow.ai, admin: { disk: diskOf({ free: 40 * GIB }) } });
});
