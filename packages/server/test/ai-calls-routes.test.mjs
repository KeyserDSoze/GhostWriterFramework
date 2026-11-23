import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import * as engine from "narrarium-engine";
import { DataDirectory, startNarrariumServer } from "../dist/testing.mjs";
import { BOOK, finalOf, headerOf, recordOf, writeCall } from "./ai-calls-contract.mjs";
import { rawApi } from "./api-helpers.mjs";
import { adminLogin, noRelease, withServer } from "./helpers.mjs";
import { READ_TOOLS, RUN_TOOLS, WRITE_TOOLS, mcpFixture } from "./mcp-helpers.mjs";
import { connectApp } from "./oauth-helpers.mjs";

// The routes of the AI call records of a personal server (the feature `autopilot-calls`), the engine's client that uses them, and what the server does around them: who may read and who may keep or delete,
// the pieces of text cut at the end of a character, the trash a removed book goes to, a restart in the middle of a call, a disk that is full, and the bytes the admin panel is told. Every test seeds the
// records through the server's own store (`server.calls`), the way the autopilot's recorder will, and reads them through the routes, the way a page does.

const posix = process.platform !== "win32";
const FAST = { aiCalls: { minFreeDiskBytes: 0 } };
const ROUTE = `/api/v1/books/${BOOK}/autopilot/calls`;
const TEXT = "Là, sul molo, il faro 💡 si accese — “finalmente”.\n";

const register = (client, bookId = BOOK) => client.registerBook(bookId, { title: `Book ${bookId}`, storage: { kind: "local" } });
const exists = (file) => lstat(file).then(() => true, () => false);
const taskIds = (count) => Array.from({ length: count }, (_, index) => `activity_t${index}`);
const bytesOfTask = (index) => [`System ${index}`, `User ${index}`, TEXT, `end ${index}`].reduce((total, text) => total + Buffer.byteLength(text), 0);

/** `count` tasks, a day apart (`activity_t0` the oldest), each with one call that has a system message, a user message and a response of two pieces; the tasks have ended. */
async function seedTasks(server, { count = 5, book = BOOK, prefix = "activity_t" } = {}) {
  for (let index = 0; index < count; index += 1) {
    const activityId = `${prefix}${index}`;
    const startedAt = `2026-11-2${index}T10:00:00.000Z`;
    const header = { bookId: book, title: `Task ${index}` };
    await server.calls.saveTask(headerOf(activityId, startedAt, { ...header, status: "running", endedAt: null }));
    await writeCall(server.calls, activityId, 1, { system: `System ${index}`, user: `User ${index}`, pieces: [TEXT, `end ${index}`], startedAt, book });
    await server.calls.saveTask(headerOf(activityId, startedAt, header));
  }
}

/** Every page of the list, followed through `next`: the ids in the order they came and the size of each page. */
async function pagesOf(api, limit) {
  const ids = [];
  const sizes = [];
  let before;
  for (let guard = 0; guard < 30; guard += 1) {
    const query = new URLSearchParams({ ...(limit === undefined ? {} : { limit: String(limit) }), ...(before === undefined ? {} : { before }) });
    const page = await api("GET", `${ROUTE}${query.size ? `?${query}` : ""}`);
    assert.equal(page.status, 200, page.text);
    ids.push(...page.json.tasks.map((task) => task.activityId));
    sizes.push(page.json.tasks.length);
    if (page.json.next === null) return { ids, sizes };
    before = page.json.next;
  }
  throw new Error("the pages do not end");
}

/** A text read through the route in pieces of `limit` bytes, followed through `next` until `done`; each piece is checked on the way. */
async function textOf(api, callId, query, limit) {
  const pieces = [];
  let from = 0;
  for (let guard = 0; guard < 5000; guard += 1) {
    const answer = await api("GET", `${ROUTE}/${callId}/text?${new URLSearchParams({ ...query, from: String(from), ...(limit === undefined ? {} : { limit: String(limit) }) })}`);
    assert.equal(answer.status, 200, answer.text);
    const piece = answer.json;
    assert.equal(piece.from, from, "a piece starts where the reader is");
    assert.equal(piece.text.includes("\ufffd"), false, `no half character (limit ${limit}, from ${from})`);
    assert.equal(Buffer.byteLength(piece.text), piece.next - piece.from, "and says how long it is, in bytes");
    if (limit !== undefined) assert.ok(Buffer.byteLength(piece.text) <= Math.max(limit, 4), `at most the limit (${limit})`);
    pieces.push(piece.text);
    if (piece.done) return pieces;
    assert.ok(piece.next > from, "it moves on");
    from = piece.next;
  }
  throw new Error("the text does not end");
}

// ---- the feature

test("AI calls (server): the server announces the feature, and the engine's client knows it from the info", async () => {
  await withServer(async (_server, client) => {
    const info = await client.info();
    assert.equal(engine.SERVER_FEATURE_AUTOPILOT_CALLS, "autopilot-calls");
    assert.ok(info.features.includes("autopilot-calls"));
    assert.equal(engine.serverHasCalls(info), true);
    assert.equal(JSON.stringify(info).toLowerCase().includes("ai-calls"), false, "and the info says nothing of what the records hold or where");
  }, FAST);
});

// ---- the list

test("AI calls (routes): the tasks of a book come newest first, a page at a time, and each page says where the next one begins", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await seedTasks(server);
    const api = await rawApi(server, ["read"]);
    const first = await api("GET", `${ROUTE}?limit=2`);
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(Object.keys(first.json).sort(), ["next", "tasks"]);
    assert.deepEqual(first.json.tasks[0], {
      bookId: BOOK, activityId: "activity_t4", title: "Task 4", kind: "write", chapter: 1, scene: null, status: "done",
      startedAt: "2026-11-24T10:00:00.000Z", endedAt: "2026-11-24T10:00:00.000Z", calls: 1, bytes: bytesOfTask(4), pinned: false,
    });
    const newest = ["activity_t4", "activity_t3", "activity_t2", "activity_t1", "activity_t0"];
    assert.deepEqual(await pagesOf(api, 2), { ids: newest, sizes: [2, 2, 1] });
    assert.deepEqual(await pagesOf(api, 1), { ids: newest, sizes: [1, 1, 1, 1, 1] });
    assert.deepEqual(await pagesOf(api, 100), { ids: newest, sizes: [5] }, "a hundred is the most a page holds");
    assert.deepEqual(await pagesOf(api), { ids: newest, sizes: [5] }, "and the page of a request that says nothing holds twenty");
    const past = await api("GET", `${ROUTE}?before=${encodeURIComponent("2026-11-20T10:00:00.000Z|activity_t0")}`);
    assert.deepEqual([past.status, past.json], [200, { tasks: [], next: null }], "after the last there is nothing, and no error");
    const all = await api("GET", `${ROUTE}?before=${encodeURIComponent("9999-12-31T00:00:00.000Z|a")}`);
    assert.equal(all.json.tasks.length, 5);
  }, FAST);
});

test("AI calls (routes): a request that is wrong in itself is a 400 that says what to send, and a book that is not there is a 404, whatever it is called", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await seedTasks(server, { count: 1 });
    const api = await rawApi(server);
    for (const query of ["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=abc", "limit=", "limit=1e2", "limit=0x10", "limit=99999999999", "before=has%20space", "before=..%2F..%2Fetc", `before=${"x".repeat(301)}`, "before="]) {
      const answer = await api("GET", `${ROUTE}?${query}`);
      assert.deepEqual([answer.status, answer.json.code], [400, "invalid_request"], query);
      assert.match(answer.json.message, /limit|before/);
    }
    assert.equal((await api("GET", `${ROUTE}?unknown=1&limit=5`)).status, 200, "a parameter nobody asked about is ignored");
    for (const [book, status, code] of [["nothing", 404, "book_not_found"], ["BOOK-1", 404, "book_not_found"], ["..%2F..%2Fx", 400, "invalid_book"], ["a%2Fb", 400, "invalid_book"], [".trash", 400, "invalid_book"]]) {
      for (const [method, route, body] of [["GET", `/api/v1/books/${book}/autopilot/calls`], ["PUT", `/api/v1/books/${book}/autopilot/calls/tasks/activity_t0/keep`, { pinned: true }], ["DELETE", `/api/v1/books/${book}/autopilot/calls`]]) {
        const answer = await api(method, route, body);
        assert.deepEqual([answer.status, answer.json.code], [status, code], `${method} ${book}`);
      }
    }
    assert.equal((await server.calls.totals(BOOK)).tasks, 1, "and nothing of the book that is there was touched");
    assert.equal((await api("GET", `${ROUTE}/tasks/activity_t0`)).status, 200, "the book that is there answers");
  }, FAST);
});

test("AI calls (routes): the records of a book are its own: another book lists none of them, finds no task of them and reads no text of them", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await register(client, "book-2");
    await seedTasks(server, { count: 2 });
    await seedTasks(server, { count: 1, book: "book-2", prefix: "activity_other" });
    const api = await rawApi(server);
    assert.deepEqual((await api("GET", `/api/v1/books/book-2/autopilot/calls`)).json.tasks.map((task) => task.activityId), ["activity_other0"]);
    assert.deepEqual((await api("GET", ROUTE)).json.tasks.map((task) => task.activityId), ["activity_t1", "activity_t0"]);
    assert.equal((await api("GET", `/api/v1/books/book-2/autopilot/calls/tasks/activity_t0`)).status, 404);
    assert.equal((await api("GET", `/api/v1/books/book-2/autopilot/calls/activity_t0-0001/text?field=system`)).status, 404);
    assert.equal((await api("PUT", `/api/v1/books/book-2/autopilot/calls/tasks/activity_t0/keep`, { pinned: true })).status, 404);
    assert.equal((await api("DELETE", `/api/v1/books/book-2/autopilot/calls`)).json.tasks, 1);
    assert.equal((await api("GET", ROUTE)).json.tasks.length, 2, "what was deleted in one book is deleted in that one");
  }, FAST);
});

// ---- the task

test("AI calls (routes): a task comes with its calls and what each says of itself, never with their texts, and one that is not there is a 404", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await seedTasks(server, { count: 3 });
    const api = await rawApi(server, ["read"]);
    const answer = await api("GET", `${ROUTE}/tasks/activity_t2`);
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(Object.keys(answer.json).sort(), ["calls", "header"]);
    assert.equal(answer.json.header.activityId, "activity_t2");
    assert.equal(answer.json.header.calls, 1);
    const [call] = answer.json.calls;
    assert.deepEqual([call.callId, call.status, call.seq, call.bookId, call.host], ["activity_t2-0001", "ok", 1, BOOK, "server"]);
    const text = JSON.stringify(answer.json);
    for (const word of ["System 2", "User 2", "faro", "end 2"]) assert.equal(text.includes(word), false, `"${word}" is the text of a call, and it is read through the route of the text`);
    const missing = await api("GET", `${ROUTE}/tasks/activity_nothing`);
    assert.deepEqual([missing.status, missing.json.code], [404, "call_task_not_found"]);
  }, FAST);
});

test("AI calls (routes): an id that is not the id of a task or of a call (a path, a dot, a space, a long one) is a 400, and nothing outside the records is ever opened", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await seedTasks(server, { count: 1 });
    const api = await rawApi(server);
    const bad = ["..%2F..%2Fetc%2Fpasswd", "..%2F", "a%2Fb", "a%5Cb", "a%20b", "a.b", "%00", "a%00b", "%C3%A9", "x".repeat(161), "%2e%2e%2f%2e%2e%2fsecret"];
    for (const id of bad) {
      for (const [method, route, body] of [
        ["GET", `${ROUTE}/tasks/${id}`],
        ["GET", `${ROUTE}/${id}/text?field=system`],
        ["PUT", `${ROUTE}/tasks/${id}/keep`, { pinned: true }],
      ]) {
        const answer = await api(method, route, body);
        assert.deepEqual([answer.status, answer.json?.code], [400, "invalid_request"], `${method} ${route.slice(0, 80)}`);
      }
    }
    const escape = await api("GET", `${ROUTE}/tasks/%E0%A4%A`);
    assert.deepEqual([escape.status, escape.json.code], [400, "invalid_path"], "an escape that is not one");
    assert.equal(await exists(server.data.aiCallsDirectory(BOOK)), true, "and the folder of the records is where it was");
  }, FAST);
});

// ---- the text

test("AI calls (routes): the text of a call is read by field and attempt, from a byte, and says where the next piece starts and whether more will come", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await seedTasks(server, { count: 3 });
    const api = await rawApi(server, ["read"]);
    const call = "activity_t2-0001";
    const one = (query) => api("GET", `${ROUTE}/${call}/text?${new URLSearchParams(query)}`);
    const system = await one({ field: "system" });
    assert.equal(system.status, 200, system.text);
    assert.deepEqual(system.json, { text: "System 2", from: 0, next: 8, size: 8, attempt: null, done: true });
    assert.deepEqual((await one({ field: "user" })).json, { text: "User 2", from: 0, next: 6, size: 6, attempt: null, done: true });
    const whole = TEXT + "end 2";
    const bytes = Buffer.byteLength(whole);
    const response = await one({ field: "response" });
    assert.deepEqual(response.json, { text: whole, from: 0, next: bytes, size: bytes, attempt: 1, done: true }, "the last response that has text, whole");
    assert.deepEqual((await one({ field: "response", attempt: "1" })).json, response.json);
    assert.deepEqual((await one({ field: "response", attempt: "2" })).json, { text: "", from: 0, next: 0, size: 0, attempt: 2, done: true }, "an attempt that gave no text is empty, not a 404");
    const middle = Buffer.from(whole).indexOf(Buffer.from("💡"));
    const cut = await one({ field: "response", from: String(middle + 2), limit: "6" });
    assert.equal(cut.json.from, middle, "from the middle of a character it starts at the character");
    assert.equal(cut.json.text, "💡 s".slice(0, "💡 s".length), "and takes whole characters");
    assert.ok(cut.json.next - cut.json.from <= 6 && !cut.json.done);
    const end = await one({ field: "response", from: String(bytes) });
    assert.deepEqual(end.json, { text: "", from: bytes, next: bytes, size: bytes, attempt: 1, done: true }, "at the end there is nothing more, and it says so");
    const past = await one({ field: "response", from: String(bytes + 1000) });
    assert.equal(past.status, 200);
    assert.deepEqual([past.json.text, past.json.done], ["", true]);
  }, FAST);
});

test("AI calls (routes): a text read in pieces of any size is the text, with every piece cut at the end of a character, while the call runs and after", async () => {
  await withServer(async (server, client) => {
    await register(client);
    const api = await rawApi(server, ["read"]);
    const text = "a é € 😀 日本語 — “quoted”\n".repeat(5);
    const activityId = "activity_pieces";
    const callId = engine.aiCallIdOf(activityId, 1);
    await server.calls.saveTask(headerOf(activityId, "2026-11-20T10:00:00.000Z", { status: "running", endedAt: null }));
    await server.calls.begin({ record: recordOf(callId, activityId, 1), system: text, user: text });
    await server.calls.append(callId, 1, 0, text);
    for (const limit of [1, 2, 3, 5, 16, 100, 100_000]) {
      for (const field of ["system", "response"]) {
        const pieces = [];
        let from = 0;
        for (let guard = 0; guard < 2000; guard += 1) {
          const answer = await api("GET", `${ROUTE}/${callId}/text?${new URLSearchParams({ field, from: String(from), limit: String(limit) })}`);
          assert.equal(answer.status, 200, answer.text);
          assert.equal(answer.json.done, false, "the call is still running: more may come");
          assert.equal(answer.json.text.includes("\ufffd"), false);
          assert.ok(Buffer.byteLength(answer.json.text) <= Math.max(limit, 4));
          pieces.push(answer.json.text);
          if (answer.json.next >= answer.json.size) break;
          from = answer.json.next;
        }
        assert.equal(pieces.join(""), text, `${field} while it runs, in pieces of ${limit}`);
      }
    }
    await server.calls.end(callId, finalOf());
    await server.calls.saveTask(headerOf(activityId, "2026-11-20T10:00:00.000Z"));
    for (const limit of [1, 3, 7, 1000]) {
      assert.equal((await textOf(api, callId, { field: "response" }, limit)).join(""), text, `the response of a call that ended, in pieces of ${limit}`);
      assert.equal((await textOf(api, callId, { field: "user" }, limit)).join(""), text);
    }
  }, FAST);
});

test("AI calls (routes): a call that is running says so (done: false) and gives what has come, then what is new from where the reader was; its end makes the last answer done", async () => {
  await withServer(async (server, client) => {
    await register(client);
    const api = await rawApi(server, ["read"]);
    const callId = engine.aiCallIdOf("activity_live", 1);
    await server.calls.saveTask(headerOf("activity_live", "2026-11-20T10:00:00.000Z", { status: "running", endedAt: null }));
    await server.calls.begin({ record: recordOf(callId, "activity_live", 1), system: "sys", user: "usr" });
    const ask = (from) => api("GET", `${ROUTE}/${callId}/text?field=response&from=${from}`);
    assert.deepEqual((await ask(0)).json, { text: "", from: 0, next: 0, size: 0, attempt: null, done: false }, "nothing has come yet");
    await server.calls.append(callId, 1, 0, "The harbor ");
    assert.deepEqual((await ask(0)).json, { text: "The harbor ", from: 0, next: 11, size: 11, attempt: 1, done: false });
    await server.calls.append(callId, 1, 11, "woke up");
    assert.deepEqual((await ask(11)).json, { text: "woke up", from: 11, next: 18, size: 18, attempt: 1, done: false }, "only what is new");
    assert.deepEqual((await ask(18)).json, { text: "", from: 18, next: 18, size: 18, attempt: 1, done: false }, "nothing new yet");
    const task = await api("GET", `${ROUTE}/tasks/activity_live`);
    assert.equal(task.json.calls[0].status, "running");
    assert.equal(task.json.header.status, "running");
    await server.calls.end(callId, finalOf());
    assert.deepEqual((await ask(18)).json, { text: "", from: 18, next: 18, size: 18, attempt: 1, done: true }, "the end: nothing more will come");
  }, FAST);
});

test("AI calls (routes): a response of several hundred kilobytes comes in answers of at most 256 KiB and joins back to the very same text", async () => {
  await withServer(async (server, client) => {
    await register(client);
    const api = await rawApi(server, ["read"]);
    const text = "Là, sul molo, il faro 💡 si accese.\n".repeat(16_000);
    const activityId = "activity_long";
    const callId = engine.aiCallIdOf(activityId, 1);
    await server.calls.saveTask(headerOf(activityId, "2026-11-20T10:00:00.000Z", { status: "running", endedAt: null }));
    await server.calls.begin({ record: recordOf(callId, activityId, 1), system: "", user: "" });
    let sent = 0;
    for (let offset = 0; offset < text.length; offset += 32_768) {
      const piece = text.slice(offset, offset + 32_768);
      await server.calls.append(callId, 1, sent, piece);
      sent += Buffer.byteLength(piece);
    }
    await server.calls.end(callId, finalOf());
    assert.equal(engine.SERVER_CALL_TEXT_MAX_BYTES, 256 * 1024);
    const pieces = [];
    let from = 0;
    for (;;) {
      const answer = await api("GET", `${ROUTE}/${callId}/text?field=response&from=${from}`);
      assert.equal(answer.status, 200);
      assert.ok(Buffer.byteLength(answer.json.text) <= 256 * 1024, "a piece is never more than a quarter of a megabyte");
      pieces.push(answer.json.text);
      if (answer.json.done) break;
      from = answer.json.next;
    }
    assert.ok(pieces.length >= 3, `${pieces.length} pieces for ${sent} bytes`);
    assert.equal(pieces.join(""), text);
    const over = await api("GET", `${ROUTE}/${callId}/text?field=response&limit=${256 * 1024 + 1}`);
    assert.deepEqual([over.status, over.json.code], [400, "invalid_request"], "a bigger piece cannot be asked for");
    assert.equal((await api("GET", `${ROUTE}/${callId}/text?field=response&limit=${256 * 1024}`)).status, 200);
  }, FAST);
});

test("AI calls (routes): a request for a text that is wrong in itself is a 400 that says what to send, and a call that is not kept is a 404", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await seedTasks(server, { count: 1 });
    const api = await rawApi(server);
    const call = "activity_t0-0001";
    for (const query of [
      "", "field=", "field=other", "field=system%2Fresponse", "field=SYSTEM", "field=response&attempt=0", "field=response&attempt=-1", "field=response&attempt=1.5", "field=response&attempt=257", "field=response&attempt=abc",
      "field=response&from=-1", "field=response&from=abc", "field=response&from=1.5", "field=response&from=9999999999", `field=response&from=${8 * 1024 * 1024 + 1}`,
      "field=response&limit=0", "field=response&limit=-5", "field=response&limit=abc", `field=response&limit=${256 * 1024 + 1}`,
    ]) {
      const answer = await api("GET", `${ROUTE}/${call}/text?${query}`);
      assert.deepEqual([answer.status, answer.json.code], [400, "invalid_request"], query);
    }
    assert.equal((await api("GET", `${ROUTE}/${call}/text?field=response&attempt=256`)).status, 200, "the last attempt that is allowed");
    assert.equal((await api("GET", `${ROUTE}/${call}/text?field=response&from=${8 * 1024 * 1024}`)).status, 200, "and the last byte that can be asked for");
    const missing = await api("GET", `${ROUTE}/activity_nothing-0001/text?field=system`);
    assert.deepEqual([missing.status, missing.json.code], [404, "call_not_found"]);
    assert.equal((await api("GET", `${ROUTE}/activity_t0-0002/text?field=system`)).status, 404, "a call of a task that is there, but never made");
  }, FAST);
});

// ---- who may do what

test("AI calls (routes): `read` reads, `run` keeps and deletes: a client that may only write, or has no token, is refused, and a refusal changes nothing", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await seedTasks(server, { count: 2 });
    const reads = [["GET", ROUTE], ["GET", `${ROUTE}/tasks/activity_t1`], ["GET", `${ROUTE}/activity_t1-0001/text?field=system`]];
    const writes = [["PUT", `${ROUTE}/tasks/activity_t1/keep`, { pinned: true }], ["DELETE", ROUTE]];
    const statuses = async (api, calls) => {
      const seen = [];
      for (const [method, route, body] of calls) {
        const answer = await api(method, route, body);
        seen.push([answer.status, answer.json?.code]);
      }
      return seen;
    };
    const allowed = new Array(3).fill([200, undefined]);
    const scope = [403, "scope"];

    const reader = await rawApi(server, ["read"]);
    assert.deepEqual(await statuses(reader, reads), allowed, "a client that reads, reads");
    assert.deepEqual(await statuses(reader, writes), [scope, scope], "and cannot keep or delete");
    const author = await rawApi(server, ["read", "write"]);
    assert.deepEqual(await statuses(author, reads), allowed);
    assert.deepEqual(await statuses(author, writes), [scope, scope], "writing the book is not running its autopilot");
    const writer = await rawApi(server, ["write"]);
    assert.deepEqual(await statuses(writer, [...reads, ...writes]), new Array(5).fill(scope));
    const runner = await rawApi(server, ["run"]);
    assert.deepEqual(await statuses(runner, reads), new Array(3).fill(scope), "a client that only runs does not read the records");
    assert.equal((await server.calls.listTasks(BOOK, { limit: 10 })).tasks.length, 2, "the refusals deleted nothing");
    assert.equal((await server.calls.readTask(BOOK, "activity_t1")).header.pinned, false, "and pinned nothing");

    for (const token of [undefined, "not-a-token", `${reader.token}x`]) {
      for (const [method, route, body] of [...reads, ...writes]) {
        const answer = await fetch(`${server.url}${route}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        assert.equal(answer.status, 401, `${method} ${route} with ${token ?? "no token"}`);
      }
    }

    const owner = await rawApi(server, ["read", "run"]);
    assert.deepEqual(await statuses(owner, writes), [[200, undefined], [200, undefined]], "read and run may do both");
    assert.deepEqual((await server.calls.totals(BOOK)).tasks, 0);
  }, FAST);
});

test("AI calls (routes): an app that connected through MCP reaches none of the routes, and the tools of the MCP endpoint neither list nor read the records", async () => {
  await withServer(async (server, client) => {
    const { slug, rpc } = await mcpFixture(server, client, { bookId: BOOK });
    await seedTasks(server, { count: 2 });
    const connected = await connectApp(server, { slug, scopes: ["read", "write", "run"] });
    const access = connected.tokens.access_token;
    assert.equal((await fetch(`${server.url}/mcp/${slug}`, { method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) })).status, 200, "the app's token is good for its book's MCP endpoint");
    for (const [method, route, body] of [
      ["GET", ROUTE], ["GET", `${ROUTE}/tasks/activity_t1`], ["GET", `${ROUTE}/activity_t1-0001/text?field=system`],
      ["PUT", `${ROUTE}/tasks/activity_t1/keep`, { pinned: true }], ["DELETE", ROUTE],
    ]) {
      const answer = await fetch(`${server.url}${route}`, { method, headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(answer.status, 401, `${method} ${route}: an OAuth token opens one book's MCP endpoint and nothing else`);
    }
    assert.equal((await server.calls.totals(BOOK)).tasks, 2, "and nothing was deleted");

    const listed = (await rpc.request("tools/list", {})).json.result.tools;
    assert.deepEqual(listed.map((tool) => tool.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS, ...RUN_TOOLS].sort(), "the tools are the ones that were reviewed: a tool for the records is a new tool, and a decision");
    assert.equal(/ai[- ]calls?\b|call records?|autopilot\/calls|ai-calls/i.test(JSON.stringify(listed)), false, "none of them speaks of the records");

    for (const path of ["ai-calls/totals.json", "../ai-calls/totals.json", "../ai-calls/tasks/2026/11/21/activity_t1.json", "/ai-calls/totals.json", "..\\ai-calls\\totals.json"]) {
      const answer = await rpc.call("read_file", { path });
      assert.equal(answer.isError, true, `${path} is not a file of the book`);
      assert.equal(/System 1|User 1|faro/.test(answer.text), false, "and no text of a call is in the refusal");
    }
    const files = await rpc.call("list_files", {});
    assert.equal(/ai-calls|activity_t/.test(files.text), false, "the records are beside the book's files, not among them");
    const status = await rpc.call("autopilot_status", {});
    assert.equal(/System 1|User 1|faro|activity_t1/.test(status.text), false);
  }, FAST);
});

// ---- keeping and deleting

test("AI calls (routes): a task is kept and let go, and says so in its header and in the totals; what is not a choice, or not a task, is refused", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await seedTasks(server, { count: 3 });
    const api = await rawApi(server);
    const keep = `${ROUTE}/tasks/activity_t1/keep`;
    const pinned = await api("PUT", keep, { pinned: true });
    assert.equal(pinned.status, 200, pinned.text);
    assert.deepEqual(pinned.json, { bookId: BOOK, activityId: "activity_t1", title: "Task 1", kind: "write", chapter: 1, scene: null, status: "done", startedAt: "2026-11-21T10:00:00.000Z", endedAt: "2026-11-21T10:00:00.000Z", calls: 1, bytes: bytesOfTask(1), pinned: true });
    assert.equal((await api("GET", `${ROUTE}/tasks/activity_t1`)).json.header.pinned, true);
    assert.deepEqual((await api("GET", ROUTE)).json.tasks.map((task) => [task.activityId, task.pinned]), [["activity_t2", false], ["activity_t1", true], ["activity_t0", false]]);
    assert.deepEqual(await server.calls.totals(BOOK), { bytes: bytesOfTask(0) + bytesOfTask(1) + bytesOfTask(2), tasks: 3, calls: 3, pinnedTasks: 1, pinnedBytes: bytesOfTask(1) });
    assert.equal((await api("PUT", keep, { pinned: true })).status, 200, "keeping what is kept is not an error");
    const free = await api("PUT", keep, { pinned: false });
    assert.deepEqual([free.status, free.json.pinned], [200, false]);
    assert.equal((await server.calls.totals(BOOK)).pinnedTasks, 0);

    for (const body of [{}, { pinned: "yes" }, { pinned: 1 }, { pinned: null }, [], "true", { keep: true }]) {
      const answer = await api("PUT", keep, body);
      assert.deepEqual([answer.status, answer.json.code], [400, "invalid_request"], JSON.stringify(body));
    }
    assert.equal((await api("PUT", keep, "{ not json")).status, 400);
    assert.equal((await api("PUT", keep)).status, 400, "a body is needed");
    const missing = await api("PUT", `${ROUTE}/tasks/activity_nothing/keep`, { pinned: true });
    assert.deepEqual([missing.status, missing.json.code], [404, "call_task_not_found"]);
    assert.equal(await server.calls.readTask(BOOK, "activity_nothing"), null, "and a task that is not there is not made by a pin");
    assert.equal((await api("PUT", `/api/v1/books/nothing/autopilot/calls/tasks/activity_t1/keep`, { pinned: true })).status, 404);
  }, FAST);
});

test("AI calls (routes): the records of a book are deleted, the pinned ones too, and the answer says what went; the book itself stays, and an admin log line says who did it", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await seedTasks(server, { count: 3 });
    const owner = await adminLogin(server);
    const api = await rawApi(server);
    const total = (await server.calls.totals(BOOK)).bytes;
    assert.equal((await api("PUT", `${ROUTE}/tasks/activity_t0/keep`, { pinned: true })).status, 200);
    assert.equal(await exists(server.data.aiCallsDirectory(BOOK)), true);

    const refused = await (await rawApi(server, ["read", "write"]))("DELETE", ROUTE);
    assert.equal(refused.status, 403);
    const wiped = await api("DELETE", ROUTE);
    assert.deepEqual([wiped.status, wiped.json], [200, { deleted: true, tasks: 3, calls: 3, bytes: total }]);
    assert.deepEqual((await api("GET", ROUTE)).json, { tasks: [], next: null });
    assert.equal((await api("GET", `${ROUTE}/tasks/activity_t0`)).status, 404);
    assert.equal((await api("GET", `${ROUTE}/activity_t0-0001/text?field=system`)).status, 404);
    assert.equal(await exists(server.data.aiCallsDirectory(BOOK)), false, "the folder of the records is gone");
    assert.deepEqual((await client.listBooks()).map((book) => book.bookId), [BOOK], "the book is where it was");
    assert.equal(await exists(path.join(server.data.bookDirectory(BOOK))), true, "with its working copy");
    const again = await api("DELETE", ROUTE);
    assert.deepEqual(again.json, { deleted: true, tasks: 0, calls: 0, bytes: 0 }, "deleting what is not there is done");
    assert.equal((await api("DELETE", `/api/v1/books/nothing/autopilot/calls`)).status, 404);
    // The book goes on: a new call is recorded afresh.
    await seedTasks(server, { count: 1, prefix: "activity_new" });
    assert.deepEqual((await api("GET", ROUTE)).json.tasks.map((task) => task.activityId), ["activity_new0"]);

    const log = (await owner.call("GET", "/admin/api/log?limit=200")).body.entries.filter((entry) => entry.action === "ai-calls.delete");
    const done = log.filter((entry) => entry.ok);
    assert.deepEqual(done.map((entry) => [entry.object, entry.detail, entry.actor.kind, entry.actor.label]).reverse(), [[BOOK, "3 tasks, 3 calls", "client", "raw client"], [BOOK, "0 tasks, 0 calls", "client", "raw client"]]);
    const no = log.filter((entry) => !entry.ok);
    assert.deepEqual(no.map((entry) => [entry.code, entry.object, entry.actor.label]), [["scope", BOOK, "raw client"]], "a client that was told no leaves a line, too");
    assert.equal(JSON.stringify(log).includes("System"), false, "and no line holds a text of a call");
  }, FAST);
});

test("AI calls (routes): a book that is being updated is not touched: keeping and deleting wait, reading does not", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await seedTasks(server, { count: 1 });
    const api = await rawApi(server);
    let during;
    await server.books.requestUpdate(async () => {
      during = [
        (await api("PUT", `${ROUTE}/tasks/activity_t0/keep`, { pinned: true })).json?.code,
        (await api("DELETE", ROUTE)).json?.code,
        (await api("GET", ROUTE)).status,
      ];
    });
    server.books.leaveMaintenance();
    assert.deepEqual(during, ["maintenance", "maintenance", 200]);
    assert.equal((await server.calls.totals(BOOK)).tasks, 1);
  }, FAST);
});

// ---- the engine's client

test("AI calls (engine client): the typed client lists, reads, keeps and deletes against a real server, in the shapes the engine defines", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await seedTasks(server, { count: 3 });
    const page = await client.listCalls(BOOK, { limit: 2 });
    assert.deepEqual(page.tasks.map((task) => task.activityId), ["activity_t2", "activity_t1"]);
    assert.equal(typeof page.next, "string");
    const rest = await client.listCalls(BOOK, { before: page.next, limit: 2 });
    assert.deepEqual([rest.tasks.map((task) => task.activityId), rest.next], [["activity_t0"], null]);
    assert.equal((await client.listCalls(BOOK)).tasks.length, 3);

    const task = await client.readCallTask(BOOK, "activity_t1");
    assert.equal(task.header.activityId, "activity_t1");
    assert.equal(task.calls.length, 1);
    const callId = task.calls[0].callId;
    assert.equal(callId, engine.aiCallIdOf("activity_t1", 1));

    assert.deepEqual(await client.readCallText(BOOK, callId, { field: "system" }), { text: "System 1", from: 0, next: 8, size: 8, attempt: null, done: true });
    const pieces = [];
    for (let from = 0, guard = 0; guard < 200; guard += 1) {
      const piece = await client.readCallText(BOOK, callId, { field: "response", attempt: 1, from, limit: 9 });
      pieces.push(piece.text);
      if (piece.done) break;
      from = piece.next;
    }
    assert.ok(pieces.length > 3);
    assert.equal(pieces.join(""), TEXT + "end 1");

    const header = await client.keepCallTask(BOOK, "activity_t1", true);
    assert.equal(header.pinned, true);
    assert.equal((await client.readCallTask(BOOK, "activity_t1")).header.pinned, true);

    const refusal = (code, status) => (error) => error instanceof engine.ServerRequestError && error.status === status && error.code === code;
    await assert.rejects(client.readCallTask(BOOK, "activity_nothing"), refusal("call_task_not_found", 404));
    await assert.rejects(client.readCallText(BOOK, "activity_nothing-0001", { field: "system" }), refusal("call_not_found", 404));
    await assert.rejects(client.keepCallTask(BOOK, "activity_nothing", true), refusal("call_task_not_found", 404));
    await assert.rejects(client.listCalls("nothing"), refusal("book_not_found", 404));
    await assert.rejects(client.listCalls(BOOK, { limit: 500 }), refusal("invalid_request", 400));
    await assert.rejects(client.readCallText(BOOK, callId, { field: "response", limit: 1_000_000 }), refusal("invalid_request", 400));

    const reading = new engine.NarrariumServerClient({ baseUrl: server.url, token: (await server.auth.issue("reader", ["read"])).token });
    assert.equal((await reading.listCalls(BOOK)).tasks.length, 3, "a client that reads, reads");
    assert.equal((await reading.readCallText(BOOK, callId, { field: "user" })).text, "User 1");
    await assert.rejects(reading.keepCallTask(BOOK, "activity_t1", false), refusal("scope", 403));
    await assert.rejects(reading.deleteCalls(BOOK), refusal("scope", 403));

    const deleted = await client.deleteCalls(BOOK);
    assert.deepEqual(deleted, { deleted: true, tasks: 3, calls: 3, bytes: bytesOfTask(0) + bytesOfTask(1) + bytesOfTask(2) });
    assert.deepEqual(await client.listCalls(BOOK), { tasks: [], next: null });
  }, FAST);
});

// ---- what the server leaves out and what it hides

test("AI calls (server): the keys of the AI integrations and the book's GitHub token are never written in the records, in a file or in an answer", async () => {
  const KEY = "sk-live-0123456789abcdefghijklmnop";
  const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
  await withServer(async (server, client, dataDir) => {
    await client.registerBook(BOOK, { title: "Secrets", storage: { kind: "local" }, githubToken: TOKEN });
    await client.putAiConfig({ aiIntegrations: [{ id: "a", name: "OpenAI", provider: "openai", apiKey: KEY, chatModels: [{ id: "m", name: "gpt-4o", capabilities: ["default"] }] }] });
    const api = await rawApi(server, ["read"]);
    const activityId = "activity_secret";
    const callId = engine.aiCallIdOf(activityId, 1);
    await server.calls.saveTask(headerOf(activityId, "2026-11-20T10:00:00.000Z", { title: `Using ${KEY}`, status: "running", endedAt: null }));
    await server.calls.begin({ record: recordOf(callId, activityId, 1, { label: `Call with ${TOKEN}` }), system: `The key is ${KEY}`, user: `Push with ${TOKEN}` });
    const reply = `I will use ${KEY} and then ${TOKEN}`;
    await server.calls.append(callId, 1, 0, reply);
    await server.calls.end(callId, finalOf("ok"));
    await server.calls.saveTask(headerOf(activityId, "2026-11-20T10:00:00.000Z", { title: `Using ${KEY}` }));

    const texts = [
      (await api("GET", `${ROUTE}/${callId}/text?field=system`)).json.text,
      (await api("GET", `${ROUTE}/${callId}/text?field=user`)).json.text,
      (await api("GET", `${ROUTE}/${callId}/text?field=response`)).json.text,
    ];
    assert.equal(texts[0], "The key is [redacted]");
    assert.equal(texts[1], "Push with [redacted]");
    assert.equal(Buffer.byteLength(texts[2]), Buffer.byteLength(reply), "a response keeps its length, so that the pieces after it still fit");
    const answers = JSON.stringify([texts, (await api("GET", ROUTE)).json, (await api("GET", `${ROUTE}/tasks/${activityId}`)).json]);
    for (const secret of [KEY, TOKEN]) assert.equal(answers.includes(secret), false, "no secret in an answer");

    const walk = async (directory) => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => (entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)])))).flat();
    for (const file of await walk(server.data.aiCallsDirectory(BOOK))) {
      const bytes = await readFile(file);
      const content = file.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
      for (const secret of [KEY, TOKEN]) assert.equal(content.includes(secret), false, `${path.relative(dataDir, file)} holds no secret`);
    }
  }, FAST);
});

// ---- a book that is removed, and one that comes back

test("AI calls (trash): removing a book moves its records to the trash beside its working copy, under the same time, private, and they are served no more; a book of the same name starts with none", async () => {
  await withServer(async (server, client) => {
    await register(client, "n");
    await client.commitFiles("n", [{ path: "notes.md", content: "my notes\n" }], "notes");
    await seedTasks(server, { count: 2, book: "n" });
    assert.equal(await exists(server.data.aiCallsDirectory("n")), true);
    const api = await rawApi(server);
    assert.equal((await api("GET", `/api/v1/books/n/autopilot/calls`)).json.tasks.length, 2);

    assert.deepEqual(await client.removeBook("n"), { removed: true });
    const books = path.join(server.data.root, "books");
    assert.equal(await exists(path.join(books, "n")), false, "the book's folder is gone, the records' too");
    const trash = path.join(books, ".trash");
    const entries = (await readdir(trash)).sort();
    assert.equal(entries.length, 2, entries.join(", "));
    const [copy, records] = entries;
    assert.match(copy, /^n-\d{13}$/);
    assert.equal(records, `${copy}.ai-calls`, "the two belong together");
    assert.equal(await readFile(path.join(trash, copy, "notes.md"), "utf8"), "my notes\n");
    assert.deepEqual((await readdir(path.join(trash, records))).sort(), ["live", "tasks", "texts", "totals.json"]);
    assert.equal((await readFile(path.join(trash, records, "totals.json"), "utf8")).includes('"tasks": 2') || (await readFile(path.join(trash, records, "totals.json"), "utf8")).includes('"tasks":2'), true);
    if (posix) assert.equal((await lstat(path.join(trash, records))).mode & 0o777, 0o700, "private like the working copy beside it");

    assert.equal((await api("GET", `/api/v1/books/n/autopilot/calls`)).status, 404, "the book is not there");
    assert.deepEqual(await server.calls.totals("n"), { bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0 }, "and the store lets go of what it held");
    assert.equal(await server.calls.readTask("n", "activity_t0"), null);

    await register(client, "n");
    assert.deepEqual((await api("GET", `/api/v1/books/n/autopilot/calls`)).json, { tasks: [], next: null }, "the same name starts with no records");
    assert.equal(await exists(server.data.aiCallsDirectory("n")), false, "and none is made until a call is written");
    assert.equal((await readdir(trash)).length, 2, "what was thrown away is still there");
  }, FAST);
});

test("AI calls (trash): a book with no records leaves no entry of records in the trash, and one that has only records still leaves them", async () => {
  await withServer(async (server, client) => {
    await register(client, "plain");
    await client.removeBook("plain");
    const trash = path.join(server.data.root, "books", ".trash");
    assert.deepEqual((await readdir(trash)).filter((name) => name.endsWith(".ai-calls")), [], "nothing to keep, nothing in the trash for it");
    await register(client, "later");
    await seedTasks(server, { count: 1, book: "later" });
    await client.removeBook("later");
    assert.equal((await readdir(trash)).filter((name) => name.endsWith(".ai-calls")).length, 1);
  }, FAST);
});

test("AI calls (trash): the trash is emptied of a book's working copy and of its records together, when they are old, and not before", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-calls-trash-"));
  try {
    const data = await DataDirectory.open(dataDir);
    const trash = path.join(data.root, "books", ".trash");
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const old = now - 15 * day;
    const fresh = now - 2 * day;
    const names = [`b-${old}`, `b-${old}.ai-calls`, `c-${fresh}`, `c-${fresh}.ai-calls`, `d-${old}.ai-calls`];
    for (const name of names) {
      await mkdir(path.join(trash, name), { recursive: true });
      await writeFile(path.join(trash, name, "x.txt"), "x");
      await utimes(path.join(trash, name), new Date(now - 40 * day), new Date(now - 40 * day));
    }
    const server = await startNarrariumServer({ dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] }, ...FAST });
    try {
      assert.deepEqual((await readdir(trash)).sort(), [`c-${fresh}`, `c-${fresh}.ai-calls`].sort(), "the time in the name decides, for the records as for the working copy");
    } finally {
      await server.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("AI calls (trash): putting both trash entries back (the working copy and the records) and adding the book again brings its records back, as they were", async () => {
  await withServer(async (server, client) => {
    await register(client, "n");
    await client.commitFiles("n", [{ path: "notes.md", content: "my notes\n" }], "notes");
    await seedTasks(server, { count: 2, book: "n" });
    const api = await rawApi(server);
    const before = (await api("GET", `/api/v1/books/n/autopilot/calls`)).json;
    const textBefore = (await api("GET", `/api/v1/books/n/autopilot/calls/activity_t1-0001/text?field=response`)).json;
    await client.removeBook("n");

    const books = path.join(server.data.root, "books");
    const trash = path.join(books, ".trash");
    const [copy, records] = (await readdir(trash)).sort();
    await mkdir(path.join(books, "n"), { recursive: true });
    await rename(path.join(trash, copy), path.join(books, "n", "repo"));
    await rename(path.join(trash, records), path.join(books, "n", "ai-calls"));
    await register(client, "n");
    assert.equal(await readFile(path.join(server.data.bookDirectory("n"), "notes.md"), "utf8"), "my notes\n");
    assert.deepEqual((await api("GET", `/api/v1/books/n/autopilot/calls`)).json, before, "the same tasks, in the same order");
    assert.deepEqual((await api("GET", `/api/v1/books/n/autopilot/calls/activity_t1-0001/text?field=response`)).json, textBefore, "and the same texts");
    assert.deepEqual((await server.calls.totals("n")).tasks, 2);
  }, FAST);
});

// ---- the server stops and starts again

const boot = async (dataDir, extra = {}) => {
  const server = await startNarrariumServer({ dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] }, ...FAST, ...extra });
  const { token } = await server.auth.issue("test client", ["read", "write", "run"]);
  return { server, client: new engine.NarrariumServerClient({ baseUrl: server.url, token }) };
};

test("AI calls (server): a server that stopped in the middle of a call starts again with that call interrupted, its text readable, and its task stopped; the records of the others are as they were", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-calls-restart-"));
  try {
    const callId = engine.aiCallIdOf("activity_cut", 1);
    {
      const { server, client } = await boot(dataDir);
      await register(client);
      await seedTasks(server, { count: 1 });
      await server.calls.saveTask(headerOf("activity_cut", "2026-11-25T10:00:00.000Z", { title: "Write chapter 2", status: "running", endedAt: null }));
      await server.calls.begin({ record: recordOf(callId, "activity_cut", 1, { timing: { startedAt: "2026-11-25T10:00:01.000Z", firstTextAt: null, endedAt: null } }), system: "the system", user: "the user" });
      await server.calls.append(callId, 1, 0, "Half of an answ");
      await server.close();
    }
    const { server, client } = await boot(dataDir);
    try {
      const page = await client.listCalls(BOOK);
      assert.deepEqual(page.tasks.map((task) => [task.activityId, task.status]), [["activity_cut", "stopped"], ["activity_t0", "done"]]);
      const task = await client.readCallTask(BOOK, "activity_cut");
      assert.equal(task.header.title, "Write chapter 2");
      assert.deepEqual([task.calls[0].status, task.calls[0].response.partial], ["interrupted", true]);
      assert.deepEqual(await client.readCallText(BOOK, callId, { field: "response" }), { text: "Half of an answ", from: 0, next: 15, size: 15, attempt: 1, done: true });
      assert.equal((await client.readCallText(BOOK, callId, { field: "system" })).text, "the system");
      assert.equal((await client.readCallText(BOOK, "activity_t0-0001", { field: "response" })).text, TEXT + "end 0", "a call that had ended is as it was");
      assert.deepEqual((await server.calls.totals(BOOK)).tasks, 2);
      assert.equal(JSON.stringify(await client.readCallTask(BOOK, "activity_t0")).includes("interrupted"), false);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ---- the disk

test("AI calls (server): short of disk nothing new is recorded, and what is kept is still read, pinned and deleted (deleting is what makes room)", async () => {
  let free = 10 * 1024 ** 3;
  await withServer(async (server, client) => {
    await register(client);
    await seedTasks(server, { count: 2 });
    const api = await rawApi(server);
    free = 100 * 1024 ** 2;
    const callId = engine.aiCallIdOf("activity_t1", 2);
    await assert.rejects(server.calls.begin({ record: recordOf(callId, "activity_t1", 2), system: "s", user: "u" }), (error) => error.name === "AiCallDiskFullError");
    await assert.rejects(server.calls.append("activity_t1-0001", 1, 5, "more"), (error) => error.name === "AiCallDiskFullError");
    assert.equal((await api("GET", ROUTE)).json.tasks.length, 2, "what is kept is listed");
    assert.equal((await api("GET", `${ROUTE}/activity_t1-0001/text?field=user`)).json.text, "User 1", "and read");
    assert.equal((await api("PUT", `${ROUTE}/tasks/activity_t1/keep`, { pinned: true })).json.pinned, true, "and pinned");
    assert.equal((await api("GET", `${ROUTE}/tasks/activity_t1`)).json.calls.length, 1, "and the call that was refused is not in its task");
    const wiped = await api("DELETE", ROUTE);
    assert.deepEqual([wiped.status, wiped.json.tasks], [200, 2], "and deleted");
    assert.equal(await exists(server.data.aiCallsDirectory(BOOK)), false);
  }, { aiCalls: { minFreeDiskBytes: 1024 ** 3, freeDiskBytes: () => free } });
});

test("AI calls (server): the defaults of a server are the engine's: two GiB a book, a GiB of free disk kept", async () => {
  await withServer(async (server) => {
    assert.ok(server.calls, "the store is part of the running server");
    assert.equal(engine.AI_CALL_BUDGETS.serverPerBookBytes, 2 * 1024 ** 3);
    assert.equal(engine.AI_CALL_BUDGETS.minFreeDiskBytes, 1024 ** 3);
  });
});

// ---- the admin panel is told how much the records keep

test("AI calls (admin panel): the health tells how much the records of all books keep, with the disk, and the books tell it each; nothing is said when there are none", async () => {
  await withServer(async (server, client) => {
    await register(client);
    await register(client, "book-2");
    const owner = await adminLogin(server);
    const health = async () => (await owner.call("GET", "/admin/api/health")).body.checks.find((check) => check.id === "disk");
    const runs = async () => Object.fromEntries((await owner.call("GET", "/admin/api/runs")).body.books.map((book) => [book.bookId, book]));
    assert.equal((await health()).facts.aiCallBytes, undefined, "no records, nothing to tell");
    assert.equal((await runs())[BOOK].aiCallBytes, undefined);

    await seedTasks(server, { count: 2 });
    await seedTasks(server, { count: 1, book: "book-2", prefix: "activity_other" });
    const first = bytesOfTask(0) + bytesOfTask(1);
    const second = bytesOfTask(0);
    const rows = await runs();
    assert.equal(rows[BOOK].aiCallBytes, first);
    assert.equal(rows["book-2"].aiCallBytes, second);
    assert.equal((await health()).facts.aiCallBytes, first + second, "the disk's facts add the books");
    assert.equal(typeof (await health()).facts.freeBytes, "number", "beside the free space, which they were told with");

    await server.calls.deleteBook(BOOK);
    assert.equal((await runs())[BOOK].aiCallBytes, undefined);
    assert.equal((await health()).facts.aiCallBytes, second);
    const secrets = JSON.stringify([(await owner.call("GET", "/admin/api/health")).body, (await owner.call("GET", "/admin/api/runs")).body]);
    assert.equal(/System|User \d|faro/.test(secrets), false, "only bytes: no text of a call is in what the panel is told");
  }, { ...FAST, admin: { disk: async () => ({ free: 40 * 1024 ** 3, total: 100 * 1024 ** 3 }) } });
});
