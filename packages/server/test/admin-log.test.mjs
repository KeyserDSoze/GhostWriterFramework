import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import * as testing from "../dist/testing.mjs";
import { rawApi } from "./api-helpers.mjs";
import { adminLogin, gatedAi, noRelease, releaseAvailable, until, withServer } from "./helpers.mjs";
import { seededBook } from "./fake-provider.mjs";
import { mcpBook, mcpFixture } from "./mcp-helpers.mjs";
import { SoftwarePasskey } from "./passkey-helpers.mjs";
import { PUBLIC_HOST, approveWithCode, connectApp, makeClock, registerPasskey, setPublic, startAuthorization, web } from "./oauth-helpers.mjs";

// The admin panel's action log (P12): what the owner and the clients change, one line each in `admin-log.jsonl` of the data folder, bounded like the MCP audit, private,
// with no secret, token, prompt or text of a book in it, and shown a page at a time. The module is read through the namespace, so that a missing export fails the
// test that needs it and nothing else.

const { AdminLog } = testing;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;

// ---------------------------------------------------------------------------------------------
// The module: one line per action, cleaned, bounded, grouped
// ---------------------------------------------------------------------------------------------

async function withLog(options, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "narrarium-admin-log-"));
  const file = path.join(dir, "admin-log.jsonl");
  const clock = makeClock();
  const lines = [];
  const log = new AdminLog(file, { now: clock.now, log: (line) => lines.push(line), ...options });
  try {
    await run(log, { dir, file, clock, lines });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const rowsOf = async (file) => (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const admin = { kind: "admin" };
const anonymous = { kind: "anonymous" };

test("P12 log: an action is one JSON line that says when, who, what, on what and how it went, and the file is private", async () => {
  await withLog({}, async (log, { file }) => {
    await log.record({ action: "token.issue", actor: admin, object: "3f2c0a1e", label: "Alessandro's MacBook", detail: "read,write", source: "local" });
    await log.record({ action: "admin.login", actor: anonymous, ok: false, code: "admin_login", source: "203.0.113.9" });
    const [issued, refused] = await rowsOf(file);
    assert.deepEqual(issued, { seq: 1, at: "2026-11-22T10:00:00.000Z", actor: { kind: "admin" }, action: "token.issue", object: "3f2c0a1e", label: "Alessandro's MacBook", detail: "read,write", ok: true, source: "local" });
    assert.deepEqual(refused, { seq: 2, at: "2026-11-22T10:00:00.000Z", actor: { kind: "anonymous" }, action: "admin.login", ok: false, code: "admin_login", source: "203.0.113.9" });
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600, "private to the user that runs the server");
  });
});

test("P12 log: a client is named by the label its owner gave it, and its id", async () => {
  await withLog({}, async (log, { file }) => {
    await log.record({ action: "mcp.on", actor: { kind: "client", id: "c-1", label: "Claude Code" }, object: "glass" });
    const [row] = await rowsOf(file);
    assert.deepEqual(row.actor, { kind: "client", id: "c-1", label: "Claude Code" });
    assert.equal(row.object, "glass");
  });
});

test("P12 log: a text of the user is cleaned and shortened the way the MCP audit does, and an id or a code is only what an id or a code can be", async () => {
  await withLog({}, async (log, { file }) => {
    const evil = "\u202eEvil\u0007 name\n" + "x".repeat(300);
    await log.record({
      action: "token.issue",
      actor: { kind: "client", id: "c\u0000-1" + "9".repeat(300), label: evil },
      object: "a b\u0000c/".repeat(100),
      label: `${evil}  with   spaces`,
      detail: `${"d".repeat(500)}\u202e`,
      code: "SOME CODE with spaces! " + "z".repeat(100),
      source: `203.0.113.9\u0007${"9".repeat(100)}`,
    });
    const text = await readFile(file, "utf8");
    assert.equal(CONTROL.test(text), false, "no control or direction-changing character reaches the file");
    assert.equal(text.split("\n").filter(Boolean).length, 1, "one line, whatever was in the text");
    const [row] = await rowsOf(file);
    assert.ok(Array.from(row.label).length <= 80 && row.label.startsWith("Evil name"), `the label is short and clean: ${row.label}`);
    assert.ok(Array.from(row.actor.label).length <= 80);
    assert.ok(row.actor.id.length <= 80 && !/\s/.test(row.actor.id));
    assert.ok(row.object.length <= 200 && !/\s/.test(row.object), "an id has no spaces");
    assert.ok(row.detail.length <= 120);
    assert.ok(row.code.length <= 40 && /^[A-Za-z0-9_.:-]+$/.test(row.code), `a code is one word: ${row.code}`);
    assert.ok(row.source.length <= 64 && /^[\x20-\x7e]+$/.test(row.source));
    assert.ok(text.length < 1500, "and the whole line stays small");
  });
});

test("P12 log: nothing is written that was not asked for (a token, a body, a prompt, a text of a book never reach the file, whoever passes them)", async () => {
  await withLog({}, async (log, { file }) => {
    await log.record({
      action: "token.issue",
      actor: { kind: "client", id: "c1", label: "Phone", token: "nrs_SECRET-TOKEN", secret: "SECRET-IN-ACTOR" },
      object: "c1",
      token: "nrs_SECRET-TOKEN",
      body: { text: "SECRET-BOOK-TEXT" },
      prompt: "SECRET-PROMPT",
      code_verifier: "SECRET-VERIFIER",
      password: "SECRET-ADMIN-CODE",
    });
    const text = await readFile(file, "utf8");
    for (const secret of ["SECRET-TOKEN", "SECRET-BOOK-TEXT", "SECRET-PROMPT", "SECRET-VERIFIER", "SECRET-ADMIN-CODE", "SECRET-IN-ACTOR"]) assert.equal(text.includes(secret), false, secret);
    const [row] = await rowsOf(file);
    assert.deepEqual(Object.keys(row).sort(), ["action", "actor", "at", "ok", "object", "seq"].sort());
    assert.deepEqual(Object.keys(row.actor).sort(), ["id", "kind", "label"]);
  });
});

test("P12 log: an action that is not in the list, or an actor that is nobody, is not written", async () => {
  await withLog({}, async (log, { file }) => {
    await log.record({ action: "files.read", actor: admin });
    await log.record({ action: "token.issue", actor: { kind: "wizard" } });
    await log.record({ action: "token.issue" });
    await log.record(undefined);
    assert.deepEqual(await rowsOf(file).catch(() => []), []);
    assert.deepEqual(await log.page({ limit: 20 }), { entries: [], nextBefore: null });
  });
});

test("P12 log: the file is cut back when it grows past its limit: the newest entries stay, the numbers are never reused, and it stays private", async () => {
  await withLog({ maxBytes: 8192, keepEntries: 20 }, async (log, { file }) => {
    for (let index = 0; index < 200; index += 1) await log.record({ action: "token.issue", actor: admin, object: `client-${index}`, label: `Client ${index}`, detail: "read,write,run" });
    const rows = await rowsOf(file);
    const size = (await stat(file)).size;
    assert.ok(size < 8192 + 400, `bounded: ${size} bytes`);
    assert.ok(rows.length >= 20 && rows.length <= 60, `${rows.length} entries kept`);
    assert.equal(rows.at(-1).object, "client-199", "the newest stays");
    assert.equal(rows.at(-1).seq, 200, "the number goes up with every action");
    assert.deepEqual(rows.map((row) => row.seq), rows.map((_, index) => rows[0].seq + index), "consecutive, oldest first");
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600, "a file that was cut back is as private as before");
  });
});

test("P12 log: entries as long as they can be do not make the file cut itself back at every action", async () => {
  await withLog({ maxBytes: 8192, keepEntries: 1000 }, async (log, { file }) => {
    const long = "L".repeat(200);
    for (let index = 0; index < 60; index += 1) {
      await log.record({ action: "token.issue", actor: { kind: "client", id: `c-${index}`, label: long }, object: `object-${index}`.padEnd(200, "o"), label: long, detail: "d".repeat(120), code: "c".repeat(40), source: "9".repeat(60) });
    }
    const size = (await stat(file)).size;
    assert.ok(size < 8192 + 1200, `bounded: ${size}`);
    const rows = await rowsOf(file);
    assert.equal(rows.at(-1).seq, 60);
    assert.ok(rows.length >= 3, "more than the newest entry is kept");
    // After a cut the file has room for many more entries: it does not rewrite itself with every one of them.
    const sizes = [];
    for (let index = 0; index < 10; index += 1) {
      await log.record({ action: "token.revoke", actor: admin, object: `x-${index}` });
      sizes.push((await stat(file)).size);
    }
    assert.ok(sizes.filter((value, index) => index > 0 && value < sizes[index - 1]).length <= 1, `it was cut back at most once in ten small entries: ${sizes}`);
  });
});

test("P12 log: a failure that repeats is counted in its entry instead of filling the log, until something else happens or the time is over", async () => {
  await withLog({ failureGroupMs: 10 * 60_000, successGroupMs: 60_000 }, async (log, { file, clock }) => {
    const wrong = { action: "admin.login", actor: anonymous, ok: false, code: "admin_login", source: "203.0.113.9" };
    await log.record(wrong);
    clock.advance(5_000);
    await log.record({ ...wrong, source: "198.51.100.4" });
    clock.advance(5_000);
    await log.record(wrong);
    let rows = await rowsOf(file);
    assert.equal(rows.length, 1, "three wrong codes, one entry");
    assert.deepEqual([rows[0].seq, rows[0].count, rows[0].at, rows[0].last, rows[0].source], [1, 3, "2026-11-22T10:00:00.000Z", "2026-11-22T10:00:10.000Z", "203.0.113.9"], "the first time, the last time, and where the last one came from");

    clock.advance(11 * 60_000);
    await log.record(wrong);
    rows = await rowsOf(file);
    assert.equal(rows.length, 2, "after the window a new entry begins");
    assert.equal(rows[1].count, undefined, "a single one has no count");
    assert.equal(rows[1].seq, 2);

    await log.record({ action: "token.issue", actor: admin, object: "c1" });
    await log.record(wrong);
    rows = await rowsOf(file);
    assert.deepEqual(rows.map((row) => row.action), ["admin.login", "admin.login", "token.issue", "admin.login"], "something else in between ends the group");

    await log.record({ ...wrong, code: "too_many_attempts" });
    await log.record({ ...wrong, code: "too_many_attempts", actor: { kind: "device", label: "Phone" } });
    rows = await rowsOf(file);
    assert.equal(rows.length, 6, "another code, or another actor, is another thing");
  });
});

test("P12 log: an action that worked and is repeated at once (a double click) is one entry too, but only within a minute, and never for another object", async () => {
  await withLog({ failureGroupMs: 10 * 60_000, successGroupMs: 60_000 }, async (log, { file, clock }) => {
    const revoke = { action: "token.revoke", actor: admin, object: "c1", label: "Phone" };
    await log.record(revoke);
    await log.record(revoke);
    await log.record({ ...revoke, object: "c2" });
    clock.advance(61_000);
    await log.record({ ...revoke, object: "c2" });
    const rows = await rowsOf(file);
    assert.deepEqual(rows.map((row) => [row.object, row.count ?? 1]), [["c1", 2], ["c2", 1], ["c2", 1]]);
  });
});

test("P12 log: the log is read a page at a time, newest first, by number, and can be limited to a kind of action or to what failed", async () => {
  await withLog({}, async (log) => {
    const kinds = [
      ["token.issue", true], ["mcp.on", true], ["admin.login", false], ["spend.limits", true], ["update.request", true],
      ["ai.approve", true], ["network.change", true], ["book.register", true], ["pairing.start", true], ["admin.code.set", true],
    ];
    for (let round = 0; round < 3; round += 1) {
      for (const [action, ok] of kinds) await log.record({ action, actor: ok ? admin : anonymous, ok, ...(ok ? {} : { code: `failed-${round}` }), object: `o-${round}` });
    }
    const first = await log.page({ limit: 12 });
    assert.deepEqual(first.entries.map((entry) => entry.seq), [30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19]);
    assert.equal(first.nextBefore, 19, "where the next page begins");
    const second = await log.page({ limit: 12, before: first.nextBefore });
    assert.deepEqual(second.entries.map((entry) => entry.seq), [18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7]);
    const last = await log.page({ limit: 12, before: second.nextBefore });
    assert.deepEqual(last.entries.map((entry) => entry.seq), [6, 5, 4, 3, 2, 1]);
    assert.equal(last.nextBefore, null, "nothing older");

    const access = await log.page({ limit: 50, type: "access" });
    assert.deepEqual(access.entries.map((entry) => entry.action), ["admin.code.set", "admin.login", "admin.code.set", "admin.login", "admin.code.set", "admin.login"]);
    assert.ok(access.entries.every((entry) => entry.type === "access"), "every entry says its kind");
    const clients = await log.page({ limit: 50, type: "clients" });
    assert.deepEqual(new Set(clients.entries.map((entry) => entry.action)), new Set(["token.issue", "pairing.start"]));
    assert.equal((await log.page({ limit: 50, type: "apps" })).entries.length, 3);
    assert.deepEqual((await log.page({ limit: 50, ok: false })).entries.map((entry) => entry.seq), [23, 13, 3]);
    assert.deepEqual((await log.page({ limit: 50, type: "access", ok: true })).entries.map((entry) => entry.action), ["admin.code.set", "admin.code.set", "admin.code.set"]);
    const filteredPages = [];
    let before;
    for (let guard = 0; guard < 5; guard += 1) {
      const page = await log.page({ limit: 2, type: "access", ...(before ? { before } : {}) });
      filteredPages.push(page.entries.map((entry) => entry.seq));
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    assert.deepEqual(filteredPages, [[30, 23], [20, 13], [10, 3]]);
    assert.deepEqual((await log.page({ limit: 0 })).entries, []);
  });
});

test("P12 log: a line that was cut, one that is not an entry and one that tries to reach a prototype are skipped, and the numbers go on after the highest", async () => {
  await withLog({}, async (log, { file }) => {
    const good = (seq, action = "token.issue") => JSON.stringify({ seq, at: "2026-11-22T09:00:00.000Z", actor: { kind: "admin" }, action, ok: true });
    const pollution = '{"seq":3,"__proto__":{"polluted":true},"action":"token.issue","actor":{"kind":"admin"},"at":"2026-11-22T09:00:00.000Z","ok":true}';
    await writeFile(file, [good(1), '{"seq":2,"at":"2026-11-22T09:00:0', "not json", pollution, JSON.stringify({ hello: "world" }), good(7, "mcp.on"), ""].join("\n"), { mode: 0o600 });
    const page = await log.page({ limit: 50 });
    assert.deepEqual(page.entries.map((entry) => entry.seq), [7, 1]);
    assert.equal({}.polluted, undefined);
    await log.record({ action: "ai.approve", actor: admin, object: "https://api.example/v1" });
    assert.equal((await log.page({ limit: 1 })).entries[0].seq, 8);
  });
});

test("P12 log: many actions at once are all written, each with its own number, in the order they came", async () => {
  await withLog({}, async (log, { file }) => {
    await Promise.all(Array.from({ length: 40 }, (_, index) => log.record({ action: "token.issue", actor: admin, object: `c-${index}` })));
    const rows = await rowsOf(file);
    assert.deepEqual(rows.map((row) => row.seq), Array.from({ length: 40 }, (_, index) => index + 1));
    assert.deepEqual(rows.map((row) => row.object), Array.from({ length: 40 }, (_, index) => `c-${index}`));
  });
});

test("P12 log: counting what failed since a time adds up the groups, and leaves out older entries", async () => {
  await withLog({}, async (log, { clock }) => {
    const refused = { action: "run.start", actor: { kind: "client", id: "c", label: "Narrarium" }, ok: false, code: "too_many_runs", object: "a" };
    await log.record(refused);
    await log.record(refused);
    clock.advance(60 * 60_000);
    await log.record({ ...refused, object: "b" });
    await log.record({ action: "run.start", actor: admin, ok: false, code: "spend_limit" });
    const since = clock.now().getTime() - 30 * 60_000;
    assert.equal(await log.count({ action: "run.start", ok: false, code: "too_many_runs", since }), 1);
    assert.equal(await log.count({ action: "run.start", ok: false, code: "too_many_runs", since: since - 2 * 60 * 60_000 }), 3, "a group counts every time it was repeated");
    assert.equal(await log.count({ action: "run.start", ok: false, since: 0 }), 4);
    assert.equal(await log.count({ action: "token.issue", since: 0 }), 0);
  });
});

test("P12 log: a log that cannot be written never fails what it records: it says so in the server's own log", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "narrarium-admin-log-"));
  const lines = [];
  try {
    const log = new AdminLog(dir, { log: (line) => lines.push(line) });
    await assert.doesNotReject(() => log.record({ action: "token.issue", actor: admin }));
    assert.ok(lines.some((line) => /admin log could not be written/i.test(line)), lines.join("\n"));
    assert.deepEqual(await log.page({ limit: 10 }), { entries: [], nextBefore: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The server: every action leaves its line
// ---------------------------------------------------------------------------------------------

const LOG_FILE = (server) => path.join(server.data.root, "admin-log.jsonl");
const WRONG_CODE = "wrong-admin-code-SECRET-31337-0123456789abcdef";
const ALL_SCOPES = ["read", "write", "run", "update"];

async function entries(owner, query = "") {
  const answer = await owner.call("GET", `/admin/api/log?limit=200${query}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
}
const actionsOf = (body) => body.entries.map((entry) => entry.action);
const times = (body, action) => body.entries.filter((entry) => entry.action === action).reduce((total, entry) => total + (entry.count ?? 1), 0);
function one(body, action, filter = () => true) {
  const found = body.entries.filter((entry) => entry.action === action && filter(entry));
  assert.equal(found.length, 1, `${action}: ${found.length} entries, among ${body.entries.map((entry) => `${entry.action}${entry.ok ? "" : "!"}`).join(", ")}`);
  return found[0];
}
const failed = (entry) => entry.ok === false;

function fakeCloudflared() {
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.pid = 41_000 + Math.floor(Math.random() * 1000);
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
    }
    return child;
  };
  return { spawn };
}

test("P12 log: the panel's sign-in is logged, wrong codes counted in one entry, and neither the code nor a wrong one is ever written", async () => {
  await withServer(async (server) => {
    const origin = server.adminUrl;
    const wrong = () => fetch(`${origin}/admin/api/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code: WRONG_CODE }) });
    for (let attempt = 0; attempt < 4; attempt += 1) assert.equal((await wrong()).status, 401);
    const owner = await adminLogin(server);
    const body = await entries(owner);
    const logins = body.entries.filter((entry) => entry.action === "admin.login");
    assert.equal(logins.length, 2, "one for the wrong codes, one for the right one");
    const [signedIn, refused] = logins;
    assert.deepEqual([signedIn.ok, signedIn.actor.kind, signedIn.source, signedIn.count], [true, "admin", "local", undefined]);
    assert.deepEqual([refused.ok, refused.actor.kind, refused.code, refused.count, refused.source], [false, "anonymous", "admin_login", 4, "local"]);
    assert.ok(Date.parse(refused.last) >= Date.parse(refused.at));
    assert.equal(refused.type, "access");
    const file = await readFile(LOG_FILE(server), "utf8");
    for (const secret of [WRONG_CODE, owner.code]) assert.equal(file.includes(secret), false, "no code in the file");
    assert.equal(JSON.stringify(body).includes(owner.code), false);
  });
});

test("P12 log: the sign-in that is refused because there were too many wrong codes is logged with its own code", async () => {
  await withServer(async (server) => {
    const origin = server.adminUrl;
    for (let attempt = 0; attempt < 12; attempt += 1) await fetch(`${origin}/admin/api/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code: WRONG_CODE }) });
    // Nobody waits for the file before being answered, so the file is read when all twelve are in it (a reader that asks the panel for the log is put behind them; this one has no session).
    let lines = [];
    await until(async () => {
      lines = (await readFile(LOG_FILE(server), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return lines.reduce((total, line) => total + (line.count ?? 1), 0) === 12;
    });
    assert.deepEqual(lines.map((line) => [line.code, line.count]), [["admin_login", 10], ["too_many_attempts", 2]]);
  });
});

test("P12 log: pairing and tokens: a code made, a device that asks, an approval, a refusal, a wrong code, a token issued, renewed and revoked, a device that leaves", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const ask = async (label) => {
      const started = await owner.call("POST", "/admin/api/pairing", {});
      assert.equal(started.status, 200);
      const nonce = randomBytes(32).toString("hex");
      const answer = await fetch(`${server.url}/api/v1/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: started.body.code, nonce, label }) });
      assert.equal(answer.status, 200);
      return { nonce, code: started.body.code, id: (await owner.call("GET", "/admin/api/status")).body.pairing.id };
    };
    const wrongCode = await fetch(`${server.url}/api/v1/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000000", nonce: randomBytes(32).toString("hex"), label: "Nobody" }) });
    assert.equal(wrongCode.status, 401, "no pairing is open");

    const first = await ask("Phone\u202e\u0007");
    assert.equal((await owner.call("POST", "/admin/api/pairing/approve", { id: first.id, allowUpdate: true })).status, 200);
    const clientId = (await owner.call("GET", "/admin/api/status")).body.clients.find((client) => client.label.startsWith("Phone")).id;
    const second = await ask("Stranger");
    assert.equal((await owner.call("POST", "/admin/api/pairing/cancel", {})).status, 200);

    const issued = await owner.call("POST", "/admin/api/token", { label: "Laptop", scopes: ["read", "write"] });
    const renewed = await owner.call("POST", "/admin/api/token", { label: "Laptop", scopes: ["read", "write"], replaceId: issued.body.clientId });
    assert.equal((await owner.call("POST", "/admin/api/revoke", { id: issued.body.clientId })).status, 200);
    const tablet = await owner.call("POST", "/admin/api/token", { label: "Tablet", scopes: ["read"] });
    const leaving = await fetch(`${server.url}/api/v1/session`, { method: "DELETE", headers: { authorization: `Bearer ${tablet.body.token}` } });
    assert.equal(leaving.status, 200);

    const body = await entries(owner);
    assert.equal(times(body, "pairing.start"), 2, "two codes were made");
    const requests = body.entries.filter((entry) => entry.action === "pairing.request");
    assert.deepEqual(requests.map((entry) => [entry.actor.kind, entry.actor.label]).reverse(), [["device", "Phone"], ["device", "Stranger"]], "the device is named by what it called itself, cleaned");
    assert.ok(requests.every((entry) => entry.source === "local" && entry.ok));
    const approval = one(body, "pairing.approve");
    assert.deepEqual([approval.actor.kind, approval.object, approval.label, approval.detail], ["admin", clientId, "Phone", "read,write,run,update"]);
    assert.equal(one(body, "pairing.reject").actor.kind, "admin");
    const attempt = one(body, "pairing.attempt");
    assert.deepEqual([attempt.ok, attempt.code, attempt.actor.kind, attempt.source], [false, "pairing_invalid", "anonymous", "local"]);

    const issue = one(body, "token.issue", (entry) => entry.label === "Laptop");
    assert.deepEqual([issue.actor.kind, issue.object, issue.detail], ["admin", issued.body.clientId, "read,write"]);
    assert.equal(one(body, "token.replace").object, issued.body.clientId);
    const revoke = one(body, "token.revoke");
    assert.deepEqual([revoke.object, revoke.label], [issued.body.clientId, "Laptop"]);
    const left = one(body, "client.disconnect");
    assert.deepEqual([left.actor.kind, left.actor.label, left.actor.id, left.object], ["client", "Tablet", tablet.body.clientId, undefined]);
    assert.ok(body.entries.every((entry) => entry.type));

    const text = await readFile(LOG_FILE(server), "utf8");
    for (const secret of [first.code, second.code, first.nonce, issued.body.token, renewed.body.token, tablet.body.token, owner.code]) assert.equal(text.includes(secret), false, "no code, nonce or token in the file");
  });
});

test("P12 log: the MCP switches, the address, the apps that were allowed, refused and revoked: by the owner or by a client, each with its name", async () => {
  await withServer(async (server, client) => {
    await mcpFixture(server, client);
    const owner = await adminLogin(server);
    const book = (change) => owner.call("POST", "/admin/api/mcp/book", { bookId: "glass", ...change });

    assert.equal((await book({ enabled: false })).status, 200);
    assert.equal((await book({ enabled: true })).status, 200);
    assert.equal((await book({ slug: "glass-harbor" })).status, 200);
    const connected = await connectApp(server, { slug: "glass-harbor", name: "Claude", scopes: ["read", "write"] });
    const w = web(server);
    const started = await startAuthorization(w, { slug: "glass-harbor", name: "ChatGPT" });
    const denied = await w.post("/oauth/authorize/deny", { json: { requestId: started.page.requestId }, headers: { "x-csrf-token": started.page.csrf } });
    assert.equal(denied.status, 200);
    const guess = await startAuthorization(w, { slug: "glass-harbor", name: "Guesser" });
    assert.equal((await approveWithCode(w, guess.page, { code: WRONG_CODE })).status, 401);

    const appsOf = async () => (await owner.call("GET", "/admin/api/mcp")).body.books.find((entry) => entry.bookId === "glass").apps;
    const claude = (await appsOf()).find((app) => app.name === "Claude");
    assert.equal((await owner.call("POST", "/admin/api/mcp/revoke", { id: claude.id })).status, 200);
    const second = await connectApp(server, { slug: "glass-harbor", name: "Gemini", scopes: ["read"] });
    const writer = await rawApi(server, ["read", "write"]);
    const gemini = (await appsOf()).find((app) => app.name === "Gemini");
    assert.equal((await writer("DELETE", `/api/v1/books/glass/mcp/clients/${gemini.id}`)).status, 200);
    assert.equal((await writer("PUT", "/api/v1/books/glass/mcp", { enabled: false })).status, 200);

    const body = await entries(owner);
    const mcp = body.entries.filter((entry) => ["mcp.on", "mcp.off", "mcp.address"].includes(entry.action)).reverse();
    assert.deepEqual(mcp.map((entry) => [entry.action, entry.actor.kind, entry.actor.label, entry.object, entry.detail]), [
      ["mcp.on", "client", "raw client", "glass", undefined],
      ["mcp.off", "admin", undefined, "glass", undefined],
      ["mcp.on", "admin", undefined, "glass", undefined],
      ["mcp.address", "admin", undefined, "glass", "glass-harbor"],
      ["mcp.off", "client", "raw client", "glass", undefined],
    ]);
    const approvals = body.entries.filter((entry) => entry.action === "oauth.approve" && entry.ok).reverse();
    assert.deepEqual(approvals.map((entry) => [entry.actor.kind, entry.label, entry.object, entry.detail]), [
      ["admin", "Claude", "glass", "admin-code read,write"],
      ["admin", "Gemini", "glass", "admin-code read"],
    ]);
    const refused = one(body, "oauth.approve", failed);
    assert.deepEqual([refused.actor.kind, refused.label, refused.code, refused.source], ["anonymous", "Guesser", "admin_login", "local"]);
    const deny = one(body, "oauth.deny");
    assert.deepEqual([deny.actor.kind, deny.label, deny.ok], ["anonymous", "ChatGPT", true], "nobody proved who they are to say no");
    const revoked = body.entries.filter((entry) => entry.action === "oauth.revoke").reverse();
    assert.deepEqual(revoked.map((entry) => [entry.actor.kind, entry.actor.label, entry.label, entry.object]), [["admin", undefined, "Claude", "glass"], ["client", "raw client", "Gemini", "glass"]]);

    const text = await readFile(LOG_FILE(server), "utf8");
    for (const secret of [connected.tokens.access_token, connected.tokens.refresh_token, second.tokens.access_token, second.tokens.refresh_token, connected.verifier, second.verifier, started.verifier, WRONG_CODE, owner.code]) {
      assert.equal(text.includes(secret), false, `not in the file: ${secret.slice(0, 12)}…`);
    }
  });
});

test("P12 log: passkeys: a link made, a passkey added, renamed and removed (the last one says so)", async () => {
  await withServer(async (server, client) => {
    await mcpFixture(server, client);
    await setPublic(server);
    const owner = await adminLogin(server);
    const w = web(server, { host: PUBLIC_HOST });
    const phone = new SoftwarePasskey();
    const link = await owner.call("POST", "/admin/api/passkeys/link", {});
    const ticket = new URL(link.body.url).hash.slice(1);
    assert.equal((await registerPasskey(w, ticket, phone, { label: "Phone" })).status, 200);
    const laptop = new SoftwarePasskey({ alg: -8 });
    const second = new URL((await owner.call("POST", "/admin/api/passkeys/link", {})).body.url).hash.slice(1);
    assert.equal((await registerPasskey(w, second, laptop, { label: "Laptop" })).status, 200);
    assert.equal((await owner.call("POST", "/admin/api/passkeys/rename", { id: laptop.id, label: "Work laptop" })).status, 200);
    assert.equal((await owner.call("POST", "/admin/api/passkeys/remove", { id: laptop.id })).status, 200);
    assert.equal((await owner.call("POST", "/admin/api/passkeys/remove", { id: phone.id })).status, 409, "the last one needs the owner to confirm");
    assert.equal((await owner.call("POST", "/admin/api/passkeys/remove", { id: phone.id, confirmLast: true })).status, 200);

    const body = await entries(owner);
    assert.equal(times(body, "passkey.link"), 2);
    assert.deepEqual(body.entries.filter((entry) => entry.action === "passkey.add").map((entry) => [entry.actor.kind, entry.label, entry.ok]).reverse(), [["admin", "Phone", true], ["admin", "Laptop", true]]);
    const renamed = one(body, "passkey.rename");
    assert.deepEqual([renamed.label, renamed.object], ["Work laptop", laptop.id.slice(0, 200)]);
    const removed = body.entries.filter((entry) => entry.action === "passkey.remove").reverse();
    assert.deepEqual(removed.map((entry) => [entry.label, entry.detail, entry.ok]), [["Work laptop", undefined, true], ["Phone", "last", true]]);
    const text = await readFile(LOG_FILE(server), "utf8");
    assert.equal(text.includes(ticket) || text.includes(second) || text.includes("publicKey"), false, "no ticket and no key");
  });
});

test("P12 log: AI endpoints approved, dismissed and taken away, the AI configuration a client sent, the limits of spending, the network and the admin code", async () => {
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    const KEY = "sk-PLANTED-API-KEY-5521";
    const config = { aiIntegrations: [{ id: "a", name: "OpenAI", provider: "openai", apiKey: KEY, chatModels: [{ id: "m", name: "gpt-4o", capabilities: ["default"] }] }] };
    await client.putAiConfig(config);
    assert.equal((await owner.call("POST", "/admin/api/ai/dismiss", { bases: ["https://api.openai.com/v1"] })).status, 200);
    await client.putAiConfig(config);
    assert.equal((await owner.call("POST", "/admin/api/ai/approve", { bases: ["https://api.openai.com/v1"] })).status, 200);

    assert.equal((await owner.call("POST", "/admin/api/spend", { paused: true })).status, 200);
    assert.equal((await owner.call("POST", "/admin/api/spend", { paused: false })).status, 200);
    assert.equal((await owner.call("POST", "/admin/api/spend", { maxTokensPerDay: 1000, maxCostPerRun: 2.5 })).status, 200);
    assert.equal((await owner.call("POST", "/admin/api/spend", { maxTokensPerDay: 1000 })).status, 200, "a request that changes nothing...");

    const form = (extra) => ({ allowedAiBases: ["https://api.openai.com/v1"], origins: [], publicUrl: "", adminPublicUrl: "", allowRemoteAdmin: false, ...extra });
    const wide = form({ origins: ["https://app.example"], publicUrl: "https://api.example.test", allowRemoteAdmin: true, adminPublicUrl: "https://admin.example.test" });
    assert.equal((await owner.call("POST", "/admin/api/network", wide)).status, 200);
    assert.equal((await owner.call("POST", "/admin/api/network", wide)).status, 200, "...or saves a form as it was");
    assert.equal((await owner.call("POST", "/admin/api/network", form({ allowedAiBases: ["https://llm.example/v1"] }))).status, 200);

    const typed = `${"n".repeat(40)}-new-admin-code-${"9".repeat(20)}`;
    assert.equal((await owner.call("POST", "/admin/api/admin-code/set", { code: typed })).status, 200);
    assert.equal((await owner.call("GET", "/admin/api/status")).status, 401, "every session ended with the old code");
    const second = await adminLogin(server);
    assert.equal(second.code, typed, "the new code is the one that works");
    const rotated = await second.call("POST", "/admin/api/admin-code/rotate", {});
    assert.equal(rotated.status, 200);

    const reader = await adminLogin(server);
    const body = await entries(reader);
    assert.equal(times(body, "ai.config"), 2);
    assert.ok(body.entries.filter((entry) => entry.action === "ai.config").every((entry) => entry.actor.kind === "client" && entry.actor.label === "test client"), "a client, with the name its owner gave it");
    const dismissed = one(body, "ai.dismiss");
    assert.deepEqual([dismissed.object, dismissed.actor.kind], ["https://api.openai.com/v1", "admin"]);
    assert.deepEqual(body.entries.filter((entry) => entry.action === "ai.approve").map((entry) => entry.object).reverse(), ["https://api.openai.com/v1", "https://llm.example/v1"]);
    assert.deepEqual(body.entries.filter((entry) => entry.action === "ai.revoke").map((entry) => entry.object), ["https://api.openai.com/v1"], "an approval that the form took away");

    assert.equal(one(body, "spend.pause").actor.kind, "admin");
    assert.equal(one(body, "spend.resume").actor.kind, "admin");
    assert.equal(one(body, "spend.limits").detail, "maxTokensPerDay 0->1000; maxCostPerRun 0->2.5", "which limits, from what to what");
    const network = body.entries.filter((entry) => entry.action === "network.change").reverse();
    assert.equal(network.length, 2, "the form saved as it was is not a change");
    assert.equal(network[0].detail, "origins; publicUrl=https://api.example.test; adminPublicUrl=https://admin.example.test");
    assert.equal(network[1].detail, "origins; publicUrl=none; adminPublicUrl=none");
    assert.deepEqual(body.entries.filter((entry) => entry.action === "network.remote").map((entry) => entry.detail).reverse(), ["on", "off"]);
    assert.equal(one(body, "admin.code.set").actor.kind, "admin");
    assert.equal(one(body, "admin.code.rotate").actor.kind, "admin");

    const text = await readFile(LOG_FILE(server), "utf8");
    for (const secret of [KEY, typed, rotated.body.code, reader.code]) assert.equal(text.includes(secret), false, "no key and no code in the file");
    assert.equal(JSON.stringify(body).includes(KEY), false);
  });
});

test("P12 log: the Cloudflare tunnel switched on, restarted and removed, and its token never written", async () => {
  const TOKEN = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";
  const fake = fakeCloudflared();
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    assert.equal((await owner.call("POST", "/admin/api/tunnel/configure", { token: TOKEN, hostname: "https://books.example.com" })).status, 200);
    assert.equal((await owner.call("POST", "/admin/api/tunnel/restart", {})).status, 200);
    assert.equal((await owner.call("POST", "/admin/api/tunnel/remove", {})).status, 200);
    const body = await entries(owner);
    assert.deepEqual(actionsOf(body).filter((action) => action.startsWith("tunnel.")).reverse(), ["tunnel.start", "tunnel.restart", "tunnel.remove"]);
    assert.ok(body.entries.filter((entry) => entry.action.startsWith("tunnel.")).every((entry) => entry.actor.kind === "admin" && entry.ok));
    assert.equal((await readFile(LOG_FILE(server), "utf8")).includes(TOKEN), false);
    assert.equal(JSON.stringify(body).includes(TOKEN), false);
  }, { tunnel: { findBinary: () => "/opt/cloudflared/bin/cloudflared", spawn: fake.spawn, detectOtherConnectors: async () => [] } });
});

test("P12 log: an update asked for by a client, a refusal for the owner, and the end of it when the supervisor has answered", async () => {
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    const accepted = await client.requestUpdate("0.2.0", testing.SERVER_VERSION);
    assert.equal(accepted.accepted, true);
    const refused = await owner.call("POST", "/admin/api/updates", { version: "0.2.0", installedVersion: testing.SERVER_VERSION });
    assert.equal(refused.status, 503, "an update is already waiting for the supervisor");

    const request = JSON.parse(await readFile(path.join(server.data.root, "private", "update-request.json"), "utf8"));
    await writeFile(path.join(server.data.root, "private", "update-result.json"), JSON.stringify({ schemaVersion: 1, requestId: request.requestId, state: "failed", outcome: "failed", version: "0.2.0", fromVersion: testing.SERVER_VERSION, at: new Date().toISOString(), message: testing.UPDATE_MESSAGES.failed }));
    await until(async () => actionsOf(await entries(owner)).includes("update.finish"));

    const body = await entries(owner);
    const asked = one(body, "update.request", (entry) => entry.ok);
    assert.deepEqual([asked.actor.kind, asked.actor.label, asked.object, asked.detail], ["client", "test client", "0.2.0", testing.SERVER_VERSION]);
    const no = one(body, "update.request", failed);
    assert.deepEqual([no.actor.kind, no.code, no.object], ["admin", "maintenance", "0.2.0"]);
    const finished = one(body, "update.finish");
    assert.deepEqual([finished.actor.kind, finished.ok, finished.code, finished.object, finished.detail], ["system", false, "failed", "0.2.0", testing.SERVER_VERSION]);
    await owner.call("GET", "/admin/api/updates/history");
    assert.equal(times(await entries(owner), "update.finish"), 1, "an answer is told once, however often it is read");
  }, { checkRelease: releaseAvailable("0.2.0"), supervised: true, scopes: ALL_SCOPES });
});

test("P12 log: books and runs: a book added and removed, a run started, paused, refused (no place left) and reset, each by the client that did it", async () => {
  const slow = gatedAi();
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    for (const id of ["a", "b", "c"]) await seededBook(client, id);
    const start = { brief: { idea: "A harbor", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false } };
    await client.startAutopilot("a", start);
    await slow.started;
    await client.startAutopilot("b", start);
    await assert.rejects(() => client.startAutopilot("c", start), (error) => error.status === 429 && error.code === "too_many_runs");
    await assert.rejects(() => client.resetAutopilot("a"), (error) => error.status === 409);
    await client.pauseAutopilot("a", "now");
    await client.pauseAutopilot("b", "now");
    slow.release();
    await until(async () => !(await client.autopilot("a")).running && !(await client.autopilot("b")).running);
    await client.resetAutopilot("a");
    await client.removeBook("c");

    const body = await entries(owner);
    const registered = body.entries.filter((entry) => entry.action === "book.register").reverse();
    assert.deepEqual(registered.map((entry) => [entry.object, entry.actor.label, entry.detail]), [["a", "test client", "local"], ["b", "test client", "local"], ["c", "test client", "local"]]);
    assert.deepEqual(body.entries.filter((entry) => entry.action === "run.start" && entry.ok).map((entry) => entry.object).reverse(), ["a", "b"]);
    const refused = one(body, "run.start", failed);
    assert.deepEqual([refused.object, refused.code, refused.actor.kind, refused.actor.label], ["c", "too_many_runs", "client", "test client"]);
    assert.deepEqual(body.entries.filter((entry) => entry.action === "run.pause").map((entry) => entry.object).reverse(), ["a", "b"]);
    assert.equal(one(body, "run.reset", failed).code, "busy");
    assert.equal(one(body, "run.reset", (entry) => entry.ok).object, "a");
    assert.deepEqual([one(body, "book.remove").object, one(body, "book.remove").actor.label], ["c", "test client"]);
  }, { ai: slow.ai });
});

test("P12 log: a client that asks for what its permissions do not allow leaves a refusal, with its name and the code", async () => {
  await withServer(async (server, client) => {
    await mcpBook(client, "glass");
    const owner = await adminLogin(server);
    const reader = await server.auth.issue("Read only", ["read"]);
    const writer = await server.auth.issue("Writer", ["read", "write"]);
    const send = (token, method, route, body) => fetch(`${server.url}${route}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await send(reader.token, "PUT", "/api/v1/books/glass/mcp", { enabled: true })).status, 403);
    assert.equal((await send(reader.token, "POST", "/api/v1/books/nothing/autopilot/start", {})).status, 403);
    assert.equal((await send(writer.token, "PUT", "/api/v1/books/glass/mcp", { enabled: "yes" })).status, 400);

    const body = await entries(owner);
    const refusal = one(body, "mcp.change", failed);
    assert.deepEqual([refusal.actor.kind, refusal.actor.label, refusal.code, refusal.object], ["client", "Read only", "scope", "glass"]);
    assert.equal(one(body, "run.start", failed).code, "scope");
    assert.equal(body.entries.some((entry) => entry.actor.label === "Writer"), false, "a request that is wrong in itself is not an event");
  });
});

test("P12 log: what only reads, and what a client does all the time, leaves nothing", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const owner = await adminLogin(server);
    const before = (await entries(owner)).entries.length;
    await client.listBooks();
    await client.aiStatus();
    await client.autopilot("glass");
    await rpc.call("book_info");
    await owner.call("GET", "/admin/api/status");
    await owner.call("GET", "/admin/api/mcp");
    await owner.call("GET", "/admin/api/log");
    await client.commitFiles("glass", [{ path: "notes.md", content: "A note\n" }], "sync");
    assert.equal((await entries(owner)).entries.length, before, "reading, syncing a book and calling the tools of the MCP endpoint are not logged here");
  });
});

// ---------------------------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------------------------

test("P12 log: the route needs the admin session like every other, and answers only to the panel's own origin", async () => {
  await withServer(async (server) => {
    const origin = server.adminUrl;
    assert.equal((await fetch(`${origin}/admin/api/log`, { headers: { origin } })).status, 401, "no session");
    assert.equal((await fetch(`${origin}/admin/api/log`, { headers: { origin: "https://evil.example" } })).status, 403, "not from another site");
    const owner = await adminLogin(server);
    assert.equal((await owner.call("GET", "/admin/api/log")).status, 200);
    const clientToken = (await server.auth.issue("c", ALL_SCOPES)).token;
    assert.equal((await fetch(`${origin}/admin/api/log`, { headers: { origin, authorization: `Bearer ${clientToken}` } })).status, 401, "a client token is not an admin session");
    assert.equal((await fetch(`${server.url}/api/v1/log`, { headers: { authorization: `Bearer ${clientToken}` } })).status, 404, "and the clients' API has no such route");
  });
});

test("P12 log: the actions that write it still need the session and its token: a request without them changes nothing and logs nothing", async () => {
  await withServer(async (server) => {
    const origin = server.adminUrl;
    const owner = await adminLogin(server);
    for (const [route, body] of [["/admin/api/spend", { paused: true }], ["/admin/api/token", { label: "x", scopes: ["read"] }], ["/admin/api/admin-code/rotate", {}]]) {
      const noToken = await fetch(`${origin}${route}`, { method: "POST", headers: { origin, cookie: owner.cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(noToken.status, 403, route);
      const noCookie = await fetch(`${origin}${route}`, { method: "POST", headers: { origin, "content-type": "application/json", "x-csrf-token": owner.csrf }, body: JSON.stringify(body) });
      assert.equal(noCookie.status, 401, route);
      const foreign = await fetch(`${origin}${route}`, { method: "POST", headers: { origin: "https://evil.example", cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf }, body: JSON.stringify(body) });
      assert.equal(foreign.status, 403, route);
    }
    assert.deepEqual(actionsOf(await entries(owner)), ["admin.login"], "only the sign-in");
    assert.equal((await owner.call("GET", "/admin/api/status")).body.spend?.paused ?? false, false);
  });
});

test("P12 log: the route's numbers and filters are checked, a limit that is too high is the highest there is, and the page says where the next one begins", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    for (let index = 0; index < 25; index += 1) await owner.call("POST", "/admin/api/token", { label: `Client ${index}`, scopes: ["read"] });
    const first = (await owner.call("GET", "/admin/api/log?limit=10")).body;
    assert.equal(first.entries.length, 10);
    assert.equal(typeof first.nextBefore, "number");
    const second = (await owner.call("GET", `/admin/api/log?limit=10&before=${first.nextBefore}`)).body;
    assert.ok(second.entries.length === 10 && second.entries.every((entry) => entry.seq < first.nextBefore));
    assert.equal((await owner.call("GET", "/admin/api/log")).body.entries.length, 20, "twenty at first, like the MCP calls");
    assert.equal((await owner.call("GET", "/admin/api/log?limit=100000")).body.entries.length, 26, "a limit that is too high is the highest there is, not an error");
    for (const query of ["limit=0", "limit=abc", "before=abc", "before=0", "type=wizard", "ok=maybe"]) assert.equal((await owner.call("GET", `/admin/api/log?${query}`)).status, 400, query);
    assert.ok((await owner.call("GET", "/admin/api/log?type=clients")).body.entries.every((entry) => entry.type === "clients"));
    assert.equal((await owner.call("GET", "/admin/api/log?type=network")).body.entries.length, 0);
    assert.equal((await owner.call("GET", "/admin/api/log?ok=false")).body.entries.length, 0);
    assert.equal((await owner.call("GET", "/admin/api/log?ok=true&type=access")).body.entries.length, 1);
  });
});

test("P12 log: nobody waits for the file: a device that asks to pair, a client that is refused or that changes a book, and a token that disconnects are answered at once, and the entry is in the log when it is asked for", async () => {
  // A write that takes its time (the entry is written, the answer of `record` comes late): whoever waits for it is slow, and the test says who.
  const original = AdminLog.prototype.record;
  AdminLog.prototype.record = function slow(input) {
    return original.call(this, input).then(() => new Promise((resolve) => setTimeout(resolve, 600)));
  };
  try {
    await withServer(async (server, client) => {
      const owner = await adminLogin(server);
      const quick = async (label, action) => {
        const started = Date.now();
        const answer = await action();
        const took = Date.now() - started;
        assert.ok(took < 400, `${label}: answered after ${took} ms, which is the time of the write: the answer waits for the log`);
        return answer;
      };
      const { body: pairing } = await owner.call("POST", "/admin/api/pairing", {});
      const ask = (code) => fetch(`${server.url}/api/v1/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, nonce: "b".repeat(64), label: "Laptop" }) });
      assert.equal((await quick("a device that asks to pair", () => ask(pairing.code))).status, 200);
      assert.equal((await quick("a code that is wrong", () => ask("000000000"))).status, 401);
      const reader = await rawApi(server, ["read"]);
      assert.equal((await quick("a client that is refused", () => reader("PUT", "/api/v1/books/nope", { title: "Nope", storage: { kind: "local" } }))).status, 403);
      const writer = await rawApi(server, ["read", "write"]);
      assert.equal((await quick("a client that changes a book", () => writer("PUT", "/api/v1/books/made", { title: "Made", storage: { kind: "local" } }))).status, 200);
      assert.equal((await quick("a client that disconnects itself", () => writer("DELETE", "/api/v1/session"))).status, 200);

      const text = JSON.stringify((await owner.call("GET", "/admin/api/log?limit=50")).body.entries.map((entry) => [entry.action, entry.ok, entry.code, entry.object]));
      for (const wanted of ["pairing.request", "pairing.attempt", "book.register", "client.disconnect"]) assert.ok(text.includes(wanted), `${wanted} is in the log by the time it is asked for: ${text}`);
      assert.ok(text.includes("book.register\",false") || text.includes("\"book.register\",false"), "and the refused one too");
    });
  } finally {
    AdminLog.prototype.record = original;
  }
});

test("P12 log: the log is there after the server restarts, and its numbers go on", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-admin-log-restart-"));
  const options = { dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] } };
  try {
    const first = await testing.startNarrariumServer(options);
    let seen;
    try {
      const owner = await adminLogin(first);
      await owner.call("POST", "/admin/api/token", { label: "Before", scopes: ["read"] });
      seen = (await entries(owner)).entries.map((entry) => entry.seq);
    } finally {
      await first.close();
    }
    const second = await testing.startNarrariumServer(options);
    try {
      const owner = await adminLogin(second);
      const body = await entries(owner);
      assert.ok(body.entries.some((entry) => entry.label === "Before"), "what was logged before is still there");
      assert.ok(body.entries[0].seq > Math.max(...seen), "and the new entries have new numbers");
    } finally {
      await second.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
