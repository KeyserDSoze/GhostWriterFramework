import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FROZEN_CHAPTER_ERROR_CODES, FROZEN_EDITS_MODES, SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_FROZEN, SERVER_FEATURE_AUTOPILOT_RULES, serverSupportsFrozenChapters } from "narrarium-engine";
import * as testing from "../dist/testing.mjs";
import { until, withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { FAST, HELD, fakeAi, holdingAi, startOf } from "./hold.mjs";
import { attempt, bookEvents, followStream, rawApi, stateEvents } from "./api-helpers.mjs";

// The frozen chapters of the engine (E4b) on the server: the setting `frozenEdits` among the live options, the three routes of the frozen
// chapters (`GET …/autopilot/frozen`, `POST …/autopilot/frozen/:number`, `POST …/chapters/:slug/freeze`), the refusals of the engine kept as
// they are, and the feature that says so. The engine decides; these tests are about what the routes accept, answer and pass on. They are light:
// four short runs of a book of one chapter of one scene, and the rest without any run.

const SCENE = "chapters/001-chapter-title-1/001-scene-1-title.md";
const CHAPTER = "001-chapter-title-1";
const optionsRoute = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/options`;
const frozenRoute = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/frozen`;
const decideRoute = (number, bookId = "b") => `/api/v1/books/${bookId}/autopilot/frozen/${number}`;
const freezeRoute = (slug = CHAPTER, bookId = "b") => `/api/v1/books/${bookId}/chapters/${slug}/freeze`;
const stateFile = (server, bookId = "b") => path.join(server.data.bookDirectory(bookId), "autopilot", "state.json");
const readState = (server, bookId = "b") => readFile(stateFile(server, bookId), "utf8").catch(() => null);
const savedOptions = async (server, bookId = "b") => JSON.parse(await readState(server, bookId)).options;

/** A book of one chapter that the autopilot wrote (and froze), whose scene the author then changed through the server. */
async function changedBook(client, bookId = "b") {
  await seededBook(client, bookId);
  await client.startAutopilot(bookId, startOf(1));
  assert.equal((await finished(client, bookId)).state.status, "completed");
  const [file] = await client.readFiles(bookId, [SCENE]);
  await client.commitFiles(bookId, [{ path: SCENE, content: `${file.content.trimEnd()}\n\nThe author's own new line.\n`, expectedHash: file.hash }], "the author edits a frozen chapter");
}

// ---------------------------------------------------------------------------------------------
// The feature, and the errors of the engine
// ---------------------------------------------------------------------------------------------

test("E4b: `info.features` announces `autopilot-frozen`, next to what it announced before", async () => {
  await withServer(async (server) => {
    assert.equal(SERVER_FEATURE_AUTOPILOT_FROZEN, "autopilot-frozen");
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_FROZEN), JSON.stringify(info.features));
    assert.equal(serverSupportsFrozenChapters(info), true);
    for (const feature of ["autopilot", "director", "sync", "pairing", "updates", "spend", SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RULES]) assert.ok(info.features.includes(feature), `${feature} is still announced`);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
  });
});

test("E4b: errorStatus maps every code of the engine's frozen-chapter errors to a refusal, never to a 500", () => {
  const expected = { chapter_not_found: 404, not_changed: 409, invalid_action: 400 };
  assert.deepEqual([...FROZEN_CHAPTER_ERROR_CODES].sort(), Object.keys(expected).sort());
  for (const code of FROZEN_CHAPTER_ERROR_CODES) {
    const mapped = testing.errorStatus(new testing.FrozenChapterError(code, `Message of ${code}.`));
    assert.deepEqual([mapped.status, mapped.code, mapped.message], [expected[code], code, `Message of ${code}.`]);
  }
});

// ---------------------------------------------------------------------------------------------
// The setting `frozenEdits`: live, and through configure and start
// ---------------------------------------------------------------------------------------------

test("E4b: PUT …/autopilot/options changes frozenEdits (ask, auto, notify), also while a run goes on; any other value is refused whole, and the message lists it", async () => {
  const ai = holdingAi(HELD, 1);
  try {
    await withServer(async (server, client) => {
      await seededBook(client, "b");
      for (const mode of FROZEN_EDITS_MODES) {
        const answer = await client.updateAutopilotOptions("b", { frozenEdits: mode });
        assert.equal(answer.state.options.frozenEdits, mode, "the answer is the snapshot, with the choice saved");
        assert.equal((await savedOptions(server)).frozenEdits, mode, "and it is in the book");
      }
      const both = await client.updateAutopilotOptions("b", { frozenEdits: "auto", publishEvery: "chapter" });
      assert.deepEqual([both.state.options.frozenEdits, both.state.options.publishEvery], ["auto", "chapter"], "with another setting in the same request");

      const api = await rawApi(server);
      const before = await readState(server);
      for (const body of [{ frozenEdits: "sometimes" }, { frozenEdits: "ASK" }, { frozenEdits: " notify" }, { frozenEdits: "" }, { frozenEdits: null }, { frozenEdits: 1 }, { frozenEdits: true }, { frozenEdits: ["ask"] }, { frozenEdits: {} }, { frozenEdits: "ask", pauseAfterEachChapter: "yes" }, { frozenEdits: "ask", readers: false }]) {
        const answer = await api("PUT", optionsRoute(), body);
        assert.deepEqual([answer.status, answer.json.code], [400, "invalid_request"], JSON.stringify(body));
        assert.match(answer.json.message, /frozenEdits \(ask, auto, notify\)/, "the message lists the setting and its values");
        assert.match(answer.json.message, /publishEvery/);
        assert.equal(await readState(server), before, `${JSON.stringify(body)} changed nothing, not even the part of it that was fine`);
      }

      await client.startAutopilot("b", { brief: startOf(1).brief, options: { ...FAST, frozenEdits: "ask", publishEvery: "step" } });
      await until(() => ai.isHeld(), 30_000);
      const live = await client.updateAutopilotOptions("b", { frozenEdits: "notify" });
      assert.equal(live.running, true, "the run goes on");
      assert.equal(live.state.options.frozenEdits, "notify");
      ai.release();
      const done = await finished(client, "b");
      assert.equal(done.state.status, "completed", done.state.lastError?.message);
      assert.equal(done.state.options.frozenEdits, "notify", "the run kept what the author chose while it ran");
      assert.equal(ai.calls.filter((call) => call.label === HELD).length, 1, "the step in flight was not repeated");
    }, { ai });
  } finally {
    ai.release();
  }
});

test("E4b: configure and start hand the options to the engine as they are: frozenEdits and fillOutline are not dropped", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    const configured = await client.configureAutopilot("b", { options: { frozenEdits: "notify", fillOutline: false } });
    assert.deepEqual([configured.state.options.frozenEdits, configured.state.options.fillOutline], ["notify", false]);
    assert.deepEqual([(await savedOptions(server)).frozenEdits, (await savedOptions(server)).fillOutline], ["notify", false]);

    await seededBook(client, "c");
    await client.startAutopilot("c", { brief: startOf(1).brief, options: { ...FAST, frozenEdits: "auto", fillOutline: false } });
    const done = await finished(client, "c");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    assert.deepEqual([done.state.options.frozenEdits, done.state.options.fillOutline], ["auto", false]);
    const { files } = await client.manifest("c");
    assert.deepEqual(files.map((file) => file.path).filter((path) => path.startsWith("outline/")).sort(), ["outline/_brief.md", "outline/book.md", "outline/chapters/001.md"], "fillOutline: false reached the run (it wrote no outline: the idea and the brief it was given, and the one entry the author wrote)");
  }, { ai: fakeAi(1) });
});

// ---------------------------------------------------------------------------------------------
// The routes of the frozen chapters
// ---------------------------------------------------------------------------------------------

test("E4b: a changed frozen chapter is asked about, its count reaches every summary, an empty answer is a 400 (never a 500), and the routes list it, decide it and freeze it by hand", async () => {
  await withServer(async (server, client) => {
    await changedBook(client);

    // The run asks; its count goes through the snapshot, the list of books and the live stream.
    const stream = await followStream(client);
    await client.startAutopilot("b");
    const asked = await finished(client, "b");
    assert.equal(asked.state.status, "waiting-author");
    assert.equal(asked.state.question.kind, "frozen-change");
    assert.equal(asked.summary.frozenChanges, 1);
    assert.equal((await client.listBooks()).find((book) => book.bookId === "b").autopilot.frozenChanges, 1);
    await until(() => bookEvents(stream.messages).some((book) => book.bookId === "b" && book.autopilot?.frozenChanges === 1), 30_000);
    assert.equal(stateEvents(stream.messages).at(-1).frozenChanges, 1, "the last state event of the run says it");
    await stream.stop();

    // An answer that chooses nothing is refused as the engine refuses it, and the question stays open.
    const api = await rawApi(server);
    const empty = await api("POST", "/api/v1/books/b/autopilot/answer", { questionId: asked.state.question.id, answer: "" });
    assert.deepEqual([empty.status, empty.json.code], [400, "invalid_action"], empty.text.slice(0, 300));
    assert.equal((await client.autopilot("b")).state.question?.id, asked.state.question.id);

    let status = await client.frozenStatus("b");
    assert.equal(status.mode, "ask");
    assert.deepEqual(status.changes.map((change) => [change.kind, change.number, change.slug, change.by, change.actions]), [["frozen", 1, CHAPTER, "autopilot", ["review-and-update", "review-only", "mark-reviewed"]]]);
    assert.deepEqual(status.changes[0].changed, { added: [], removed: [], modified: ["001-scene-1-title.md"], body: false });
    assert.deepEqual(status.pending, []);
    // A review is recorded for the next run (it closes the question); marking it reviewed replaces it, at once.
    status = await client.resolveFrozenChange("b", 1, "review-only", { note: "Keep the new line." });
    assert.deepEqual(status.changes.map((change) => change.pending?.action), ["review-only"]);
    assert.deepEqual(status.pending.map((entry) => [entry.number, entry.action, entry.note]), [[1, "review-only", "Keep the new line."]]);
    const decided = await client.autopilot("b");
    assert.equal(decided.state.question, null);
    assert.equal(decided.summary.frozenChanges, undefined, "a change with a decision does not wait for the author");
    status = await client.resolveFrozenChange("b", 1, "mark-reviewed");
    assert.deepEqual([status.changes, status.pending], [[], []]);
    const refusals = [
      [await attempt(() => client.resolveFrozenChange("b", 1, "mark-reviewed")), 409, "not_changed"],
      [await attempt(() => client.resolveFrozenChange("b", 9, "mark-reviewed")), 404, "chapter_not_found"],
      [await attempt(() => client.resolveFrozenChange("b", 1, "rewrite-everything")), 400, "invalid_action"],
      [await attempt(() => client.resolveFrozenChange("b", 1, "keep-text")), 409, "not_changed"],
    ];
    for (const [refused, status, code] of refusals) assert.deepEqual([refused.status, refused.code], [status, code], JSON.stringify(refused));

    // The author freezes and unfreezes it by hand.
    const unfrozen = await client.freezeChapter("b", CHAPTER, false);
    assert.deepEqual(unfrozen, { slug: CHAPTER, number: 1, frozen: null });
    const refrozen = await client.freezeChapter("b", CHAPTER, true);
    assert.deepEqual([refrozen.slug, refrozen.number, refrozen.frozen.by], [CHAPTER, 1, "author"]);
    assert.match(refrozen.frozen.digest, /^[0-9a-f]{16}$/);
    const missing = await attempt(() => client.freezeChapter("b", "404-nowhere", true));
    assert.deepEqual([missing.status, missing.code], [404, "chapter_not_found"]);
    assert.deepEqual((await client.frozenStatus("b")).changes, []);
  }, { ai: fakeAi(1) });
});

test("E4b: the frozen routes are for the clients that may; an update about to start is a 503 and an unknown book a 404, before anything else; a chapter.md that cannot be read is a 422", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    await client.commitFiles("b", [
      { path: "chapters/002-broken/chapter.md", content: "---\ntitle: [unclosed\n---\n\nBody.\n" },
      { path: "chapters/002-broken/001-a.md", content: "---\ntype: paragraph\nnumber: 1\ntitle: A\n---\n\nThe author's text.\n" },
    ], "a chapter whose frontmatter cannot be read");
    const decide = { action: "mark-reviewed" };
    const freeze = { frozen: true };
    for (const [method, route, body, scope] of [["GET", frozenRoute(), undefined, "read"], ["POST", decideRoute(1), decide, "run"], ["POST", freezeRoute("002-broken"), freeze, "write"]]) {
      const anonymous = await fetch(`${server.url}${route}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      assert.equal(anonymous.status, 401, `${method} ${route}`);
      const others = [["read"], ["write"], ["run"], ["read", "write"], ["read", "run"]].filter((scopes) => !scopes.includes(scope));
      for (const scopes of others) {
        const refused = await (await rawApi(server, scopes))(method, route, body);
        assert.deepEqual([refused.status, refused.json.code], [403, "scope"], `${method} ${route} with ${scopes.join(",")}`);
      }
      const allowed = await (await rawApi(server, [scope]))(method, route, body);
      assert.notEqual(allowed.status, 403, `${method} ${route}: the ${scope} permission is what it takes`);
    }
    const api = await rawApi(server);
    assert.deepEqual((await api("POST", freezeRoute("002-broken"), freeze)).json.code, "frontmatter_invalid");
    assert.equal((await api("POST", freezeRoute("002-broken"), freeze)).status, 422, "the author's chapter.md is never rewritten from what could be read of it");
    for (const [method, route, body] of [["GET", frozenRoute("nope")], ["POST", decideRoute(1, "nope"), decide], ["POST", freezeRoute(CHAPTER, "nope"), freeze]]) {
      const missing = await api(method, route, body);
      assert.deepEqual([missing.status, missing.json.code], [404, "book_not_found"], `${method} ${route}`);
    }
    assert.equal((await api("PUT", frozenRoute(), {})).status, 404, "GET is the route of the list");
    assert.equal((await api("GET", decideRoute(1))).status, 404, "POST is the route of a decision");
    assert.equal((await api("GET", freezeRoute())).status, 404);

    const before = await readFile(path.join(server.data.bookDirectory("b"), "chapters", "002-broken", "chapter.md"), "utf8");
    await server.books.requestUpdate(async () => undefined);
    for (const [route, body] of [[decideRoute(1), decide], [freezeRoute("002-broken"), freeze], [decideRoute(1, "nope"), decide], [freezeRoute(CHAPTER, "nope"), freeze], [decideRoute("x"), "not json"]]) {
      const response = await api("POST", route, body);
      assert.deepEqual([response.status, response.json.code], [503, "maintenance"], route);
    }
    assert.equal((await api("GET", frozenRoute())).status, 200, "the list is still read");
    assert.equal(await readFile(path.join(server.data.bookDirectory("b"), "chapters", "002-broken", "chapter.md"), "utf8"), before, "nothing was written");
  });
});

const ODD_BODIES = [
  "[]", "[[]]", "5", "-1", "1e999", '"x"', "true", "{", "}", "{]", '{"action":', '{"action":"mark-reviewed",}', "nul", "NaN", "\u0000", "{}garbage", "{} {}",
  '{"__proto__":{"action":"mark-reviewed"}}', '{"constructor":{"prototype":{}}}', '{"action":"mark-reviewed","__proto__":{}}',
  "null", "{}", "\ufeff{}", `{"action":${"9".repeat(400)}}`, `{"action":"mark-reviewed","note":"${"y".repeat(200_000)}"}`,
];

test("E4b: addresses and bodies nobody meant to send never make the frozen routes fail inside: every answer is a clear 4xx, and nothing is written", async () => {
  const lines = [];
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    const api = await rawApi(server);
    const clear = (response, label) => {
      assert.ok(response.status >= 400 && response.status < 500, `${label}: ${response.status} ${response.text.slice(0, 200)}`);
      assert.equal(typeof response.json?.code, "string", label);
      assert.equal(typeof response.json?.message, "string", label);
      assert.notEqual(response.json.code, "internal", label);
      return response;
    };
    const decisions = [
      [{}, "invalid_request"], [{ action: 5 }, "invalid_request"], [{ action: null }, "invalid_request"], [{ action: ["mark-reviewed"] }, "invalid_request"],
      [{ action: "everything" }, "invalid_action"], [{ action: "" }, "invalid_action"],
      [{ action: "mark-reviewed", kind: "chapter" }, "invalid_request"], [{ action: "mark-reviewed", kind: 1 }, "invalid_request"],
      [{ action: "mark-reviewed", note: 5 }, "invalid_request"], [{ action: "mark-reviewed", note: {} }, "invalid_request"],
      [{ action: "mark-reviewed", acton: "x" }, "invalid_request"], [{ action: "mark-reviewed", frozen: true }, "invalid_request"],
    ];
    for (const [body, code] of decisions) assert.equal(clear(await api("POST", decideRoute(1), body), JSON.stringify(body)).json.code, code, JSON.stringify(body));
    for (const number of ["0", "-1", "1.5", "01", "1e2", "abc", "%20", "%EF%BC%91", "9".repeat(30), "1%2F2", "%ZZ"]) {
      const response = clear(await api("POST", decideRoute(number), { action: "mark-reviewed" }), number);
      assert.ok(["invalid_request", "invalid_path"].includes(response.json.code), `${number}: ${response.json.code}`);
    }
    assert.equal(clear(await api("POST", decideRoute(7), { action: "mark-reviewed" }), "a chapter that is not there").json.code, "chapter_not_found");
    for (const body of ODD_BODIES) {
      clear(await api("POST", decideRoute(1), body), `decide ${JSON.stringify(body.slice(0, 50))}`);
      clear(await api("POST", freezeRoute(), body), `freeze ${JSON.stringify(body.slice(0, 50))}`);
    }
    for (const body of [{}, { frozen: "true" }, { frozen: 1 }, { frozen: null }, { frozen: [] }, { frozen: true, extra: 1 }, { freeze: true }]) {
      assert.equal(clear(await api("POST", freezeRoute(), body), JSON.stringify(body)).json.code, "invalid_request", JSON.stringify(body));
    }
    for (const slug of [".", "..", "%2E%2E", "a%2Fb", "%5C", "a%00b", "x".repeat(300), "%ZZ"]) clear(await api("POST", freezeRoute(slug), { frozen: true }), slug);
    // (Dot segments never reach a route: the address is normalized first, and is then no route at all.) What does reach it is refused by the route.
    for (const slug of ["a%2Fb", "%5C", "a%00b", "%0A", "x".repeat(300)]) assert.equal((await api("POST", freezeRoute(slug), { frozen: true })).json.code, "invalid_request", slug);
    assert.equal(clear(await api("POST", freezeRoute("001-not-there"), { frozen: false }), "a folder that is not there").json.code, "chapter_not_found");
    assert.equal((await api("GET", `${frozenRoute()}?anything=1`)).status, 200, "the list takes no parameter, and is not confused by one");
    assert.equal(await readState(server), null, "nothing wrote a state");
  }, { log: (line) => lines.push(line) });
  assert.deepEqual(lines.filter((line) => /^Error /.test(line)), [], "no internal error was logged");
});
