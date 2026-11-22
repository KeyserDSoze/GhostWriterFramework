import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AUTOPILOT_RULE_ERROR_CODES, MAX_RULE_CHARACTERS, SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RULES, isAutopilotRuleErrorCode, serverSupportsAutopilotRules } from "narrarium-engine";
import * as testing from "../dist/testing.mjs";
import { until, withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { HELD, holdingAi, startOf } from "./hold.mjs";
import { attempt, declareLarge, rawApi } from "./api-helpers.mjs";

// The permanent rules of an autopilot (S5): `PUT` and `DELETE /api/v1/books/:id/autopilot/rules/:index`. The engine validates and decides
// (`rule_empty`, `rule_too_long`, `rule_duplicate`, `rule_not_found`, `rule_changed`); these tests are about what the routes accept, answer and keep out of the log.

const RULES = ["Never use the word suddenly.", "Write in the first person.", "Keep every chapter under four pages."];

const ruleRoute = (index, bookId = "b", query = "") => `/api/v1/books/${bookId}/autopilot/rules/${index}${query}`;
const stateFile = (server, bookId = "b") => path.join(server.data.bookDirectory(bookId), "autopilot", "state.json");
const readState = (server, bookId = "b") => readFile(stateFile(server, bookId), "utf8").catch(() => null);
const rulesOf = async (client, bookId = "b") => (await client.autopilot(bookId)).state.constraints;
const promptOf = (call) => `${call.system}\n${call.user}`;

/** Register a book and give it permanent rules the way the author does: `from_now` interventions. */
async function bookWithRules(client, rules = RULES, bookId = "b") {
  await seededBook(client, bookId);
  for (const text of rules) await client.intervene(bookId, { scope: "from_now", text });
  return bookId;
}

// ---------------------------------------------------------------------------------------------
// The flag
// ---------------------------------------------------------------------------------------------

test("S5: `info.features` announces `autopilot-rules`, next to the quick controls and what it announced before", async () => {
  await withServer(async (server) => {
    assert.equal(SERVER_FEATURE_AUTOPILOT_RULES, "autopilot-rules");
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_RULES), JSON.stringify(info.features));
    assert.equal(serverSupportsAutopilotRules(info), true);
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_CONTROLS), "the quick controls are still announced");
    for (const feature of ["autopilot", "director", "sync", "pairing", "updates", "spend"]) assert.ok(info.features.includes(feature), `${feature} is still announced`);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
  });
});

// ---------------------------------------------------------------------------------------------
// Editing and removing
// ---------------------------------------------------------------------------------------------

test("S5: PUT …/rules/:index replaces the text of one rule and answers the snapshot; the other rules, and what the author asked before, are as they were", async () => {
  await withServer(async (server, client) => {
    await bookWithRules(client);
    const before = (await client.autopilot("b")).state;
    assert.deepEqual(before.constraints, RULES);

    const answer = await client.updateRule("b", 1, "Write in the third person.", RULES[1]);
    assert.deepEqual(answer.state.constraints, [RULES[0], "Write in the third person.", RULES[2]], "only the rule at that index changed");
    assert.equal(answer.summary.constraints, 3);
    assert.equal(answer.running, false);
    assert.equal(answer.state.version, before.version + 1, "one saved change");
    assert.deepEqual(answer.state.interventions, before.interventions, "what the author asked is not rewritten");
    assert.deepEqual(JSON.parse(await readState(server)).constraints, answer.state.constraints, "it is saved in the book");

    const unchecked = await client.updateRule("b", 0, "Never use the word abruptly.");
    assert.equal(unchecked.state.constraints[0], "Never use the word abruptly.", "without `expectedText` there is nothing to check against");
    const spaces = await client.updateRule("b", 2, "  Keep every chapter short.  ", `  ${RULES[2]}  `);
    assert.equal(spaces.state.constraints[2], "Keep every chapter short.", "the spaces around the text are not part of a rule, nor of the text the author saw");
    const same = await client.updateRule("b", 2, "Keep every chapter short.", "Keep every chapter short.");
    assert.equal(same.state.version, spaces.state.version, "a text equal to the rule changes nothing and writes nothing");

    const raw = await (await rawApi(server))("PUT", ruleRoute(0), { text: "Never use the word suddenly.", expectedText: "Never use the word abruptly." });
    assert.equal(raw.status, 200, "the request the typed client makes is a plain PUT with a JSON body");
    assert.equal(raw.json.state.constraints[0], RULES[0]);
  });
});

test("S5: DELETE …/rules/:index removes one rule, the rules after it move up, and the text the author saw, in the query, survives whatever characters it has", async () => {
  await withServer(async (server, client) => {
    await bookWithRules(client);
    const removed = await client.removeRule("b", 0, RULES[0]);
    assert.deepEqual(removed.state.constraints, [RULES[1], RULES[2]], "the rules after the one that was removed move up by one");
    assert.equal(removed.summary.constraints, 2);
    assert.equal(removed.running, false);
    assert.deepEqual(JSON.parse(await readState(server)).constraints, [RULES[1], RULES[2]]);
    const last = await client.removeRule("b", 1);
    assert.deepEqual(last.state.constraints, [RULES[1]], "without `expectedText` there is nothing to check against");

    const awkward = ["Evita «improvvisamente» & “all'improvviso”: #1? 100% = sì", "a/b\\c?d=e&f=g#h", "emoji 😀 and 日本語 and \n a line break", "+ plus and %41 percent"];
    for (const text of awkward) await client.intervene("b", { scope: "from_now", text });
    for (const text of awkward) {
      const next = await client.removeRule("b", 1, text);
      assert.ok(!next.state.constraints.includes(text), JSON.stringify(text));
    }
    assert.deepEqual(await rulesOf(client), [RULES[1]], "each was found by the text the client said, exactly");
  });
});

test("S5: every refusal of the engine is answered as it is, nothing is written, and every code of the engine is one of them", async () => {
  const seen = new Set();
  await withServer(async (server, client) => {
    await bookWithRules(client);
    await seededBook(client, "empty");
    const api = await rawApi(server);
    const put = (index, body) => api("PUT", ruleRoute(index), body);
    const del = (index, query = "") => api("DELETE", ruleRoute(index, "b", query));
    const edge = await put(0, { text: "x".repeat(MAX_RULE_CHARACTERS) });
    assert.equal(edge.status, 200, "a rule of exactly the longest length is a rule");
    assert.equal((await put(0, { text: RULES[0] })).status, 200);

    const before = await readState(server);
    const refused = async (label, response, status, code) => {
      assert.equal(response.status, status, `${label}: ${response.text.slice(0, 200)}`);
      assert.equal(response.json.code, code, label);
      assert.equal(typeof response.json.message, "string", label);
      assert.equal(await readState(server), before, `${label}: nothing was written`);
      seen.add(code);
      return response.json.message;
    };
    for (const text of ["", "   ", "\n\t "]) await refused(`empty ${JSON.stringify(text)}`, await put(0, { text }), 400, "rule_empty");
    assert.match(await refused("one over", await put(0, { text: "x".repeat(MAX_RULE_CHARACTERS + 1) }), 400, "rule_too_long"), new RegExp(`${MAX_RULE_CHARACTERS + 1} characters`), "the message tells how long the text is");
    assert.match(await refused("ten thousand", await put(0, { text: "r".repeat(10_000) }), 400, "rule_too_long"), /10000 characters/, "the text is not cut before the engine reads it");
    assert.match(await refused("a large one", await put(0, { text: "r".repeat(1_500_000) }), 400, "rule_too_long"), /1500000 characters/, "not even a large one");
    await refused("duplicate", await put(0, { text: RULES[1] }), 400, "rule_duplicate");
    await refused("duplicate, with spaces", await put(0, { text: `  ${RULES[2]}\n` }), 400, "rule_duplicate");
    assert.match(await refused("no such rule", await put(3, { text: "New." }), 404, "rule_not_found"), /rule number 4/);
    await refused("no such rule, far away", await put(9_007_199_254_740_991, { text: "New." }), 404, "rule_not_found");
    await refused("changed", await put(0, { text: "New.", expectedText: "Not what the author saw." }), 409, "rule_changed");
    await refused("changed, empty text", await put(0, { text: "New.", expectedText: "" }), 409, "rule_changed");
    await refused("delete: no such rule", await del(3), 404, "rule_not_found");
    await refused("delete: far away", await del(1_000_000_000), 404, "rule_not_found");
    await refused("delete: changed", await del(1, `?expectedText=${encodeURIComponent("Not what the author saw.")}`), 409, "rule_changed");
    await refused("delete: changed, empty", await del(1, "?expectedText="), 409, "rule_changed");

    // The typed client reports each as the error it always gives, with the status and the code of the server, and a host tells a rule's refusal by its code.
    for (const [call, status, code] of [[() => client.updateRule("b", 3, "New."), 404, "rule_not_found"], [() => client.removeRule("b", 0, "Not what the author saw."), 409, "rule_changed"], [() => client.updateRule("b", 0, " "), 400, "rule_empty"]]) {
      const typed = await attempt(call);
      assert.deepEqual([typed.status, typed.code], [status, code]);
      assert.equal(isAutopilotRuleErrorCode(typed.code), true, code);
    }
    assert.equal(isAutopilotRuleErrorCode((await attempt(() => client.updateRule("b", -1, "New."))).code), false, "a number that is no number of a rule is no rule that was not found: it is a bad request");

    const none = await api("PUT", ruleRoute(0, "empty"), { text: "New." });
    assert.deepEqual([none.status, none.json.code], [404, "rule_not_found"], "a book that never ran has no rule");
    assert.equal((await api("DELETE", ruleRoute(0, "empty"))).status, 404);
    assert.equal(await readState(server, "empty"), null, "and it is not given a state by being asked");
  });
  assert.deepEqual([...seen].sort(), [...AUTOPILOT_RULE_ERROR_CODES].sort(), "the five codes of the engine were all answered");
});

test("S5: errorStatus maps every code of the engine's rule errors to a refusal, never to a 500", () => {
  for (const code of AUTOPILOT_RULE_ERROR_CODES) {
    const mapped = testing.errorStatus(new testing.AutopilotRuleError(code, `Message of ${code}.`));
    assert.ok(mapped.status >= 400 && mapped.status < 500, `${code}: ${mapped.status}`);
    assert.equal(mapped.code, code);
    assert.equal(mapped.message, `Message of ${code}.`);
  }
});

// ---------------------------------------------------------------------------------------------
// While the autopilot runs
// ---------------------------------------------------------------------------------------------

test("S5: a rule can be edited and removed while the autopilot runs: the step in flight is not repeated, and the next step has the rules as they are now", async () => {
  const ai = holdingAi(HELD, 1);
  const EDITED = "Never use the word abruptly.";
  try {
    await withServer(async (_server, client) => {
      await bookWithRules(client);
      await client.startAutopilot("b", startOf(1));
      await until(() => ai.isHeld(), 30_000);
      const edited = await client.updateRule("b", 0, EDITED, RULES[0]);
      assert.equal(edited.running, true, "the run goes on");
      assert.equal(edited.state.constraints[0], EDITED);
      const removed = await client.removeRule("b", 2, RULES[2]);
      assert.deepEqual(removed.state.constraints, [EDITED, RULES[1]]);
      assert.equal(removed.running, true);
      ai.release();
      const done = await finished(client, "b", 90_000);
      assert.equal(done.state.status, "completed", done.state.message ?? "");
      assert.deepEqual(done.state.constraints, [EDITED, RULES[1]], "what the step saved did not undo what the author saved");

      const held = ai.calls.findIndex((call) => call.label === HELD);
      assert.equal(ai.calls.filter((call) => call.label === HELD).length, 1, "the step that was running was not repeated");
      assert.ok(!(await client.events("b")).events.some((event) => event.type === "insight" && event.code === "conflictRetry"), "and nothing conflicted");
      const before = ai.calls.slice(0, held + 1).filter((call) => promptOf(call).includes(RULES[1]));
      assert.ok(before.length >= 4, "the steps before the change had the rules as they were");
      assert.ok(before.every((call) => promptOf(call).includes(RULES[0]) && promptOf(call).includes(RULES[2])), "all of them");
      const after = ai.calls.slice(held + 1).filter((call) => promptOf(call).includes(RULES[1]));
      assert.ok(after.length >= 1, "a step after the change reads the rules");
      assert.ok(after.every((call) => promptOf(call).includes(EDITED)), "it has the new text of the rule that was edited");
      assert.ok(after.every((call) => !promptOf(call).includes(RULES[0]) && !promptOf(call).includes(RULES[2])), "and neither the old text nor the rule that was removed");
    }, { ai });
  } finally {
    ai.release();
  }
});

// ---------------------------------------------------------------------------------------------
// What a request may be
// ---------------------------------------------------------------------------------------------

const BAD_INDEXES = ["-1", "1.5", "abc", "1e2", "01", "+1", "%201", "1%2F2", "NaN", "0x1", "1_000", "99999999999999999999", "%D9%A3"];

test("S5: the rule number in the address is a whole number from 0: anything else is a 400 invalid_request, and a number that names no rule is a 404", async () => {
  await withServer(async (server, client) => {
    await bookWithRules(client);
    const api = await rawApi(server);
    const before = await readState(server);
    for (const index of BAD_INDEXES) {
      for (const response of [await api("PUT", ruleRoute(index), { text: "New." }), await api("DELETE", ruleRoute(index))]) {
        assert.equal(response.status, 400, `${index}: ${response.text.slice(0, 200)}`);
        assert.equal(response.json.code, "invalid_request", index);
        assert.match(response.json.message, /whole number/, "it says what the number must be");
      }
    }
    assert.equal(await readState(server), before, "none of them wrote anything");
    assert.equal((await api("PUT", ruleRoute(0), { text: RULES[0] })).status, 200, "0 is the first rule");
    assert.equal((await api("PUT", ruleRoute(5), { text: "New." })).status, 404);

    const unknown = await api("PUT", ruleRoute("-1", "nope"), { text: "New." });
    assert.deepEqual([unknown.status, unknown.json.code], [404, "book_not_found"], "the book is looked for before the address is read");
    const unreadable = await api("PUT", ruleRoute("-1"), '{"text":');
    assert.deepEqual([unreadable.status, unreadable.json.code], [400, "invalid_request"], "and the address before the body");
  });
});

const BAD_PUT_BODIES = [
  {},
  { expectedText: "x" },
  { text: null },
  { text: 5 },
  { text: true },
  { text: [] },
  { text: ["New."] },
  { text: {} },
  { text: "New.", expectedText: null },
  { text: "New.", expectedText: 5 },
  { text: "New.", expectedText: ["x"] },
  { text: "New.", expectedText: {} },
  { text: "New.", expectedText: "x".repeat(10_001) },
  { text: "New.", extra: 1 },
  { text: "New.", index: 0 },
  { text: "New.", expected: RULES[0] },
  { txt: "New." },
  { rule: "New." },
];

test("S5: a PUT that is not { text, expectedText? } is a 400 invalid_request that says so, and nothing is written; the body is read as its neighbours' is", async () => {
  await withServer(async (server, client) => {
    await bookWithRules(client);
    const api = await rawApi(server);
    const before = await readState(server);
    for (const body of BAD_PUT_BODIES) {
      const response = await api("PUT", ruleRoute(0), body);
      assert.equal(response.status, 400, `${JSON.stringify(body).slice(0, 80)}: ${response.text.slice(0, 200)}`);
      assert.equal(response.json.code, "invalid_request", JSON.stringify(body).slice(0, 80));
      assert.match(response.json.message, /text/, "the message names the fields");
      assert.ok(response.json.message.length < 600, "and is short");
      assert.equal(await readState(server), before, `${JSON.stringify(body).slice(0, 80)} wrote nothing`);
    }
    const capped = await api("PUT", ruleRoute(0), { text: RULES[0], expectedText: "x".repeat(10_000) });
    assert.deepEqual([capped.status, capped.json.code], [409, "rule_changed"], "a text of the longest length the server takes is read, and does not match");

    for (const body of ["[]", "[1]", "5", '"New."', "true"]) {
      const response = await api("PUT", ruleRoute(0), body);
      assert.deepEqual([response.status, response.json.code], [400, "invalid_request"], body);
    }
    const broken = await api("PUT", ruleRoute(0), '{"text":');
    assert.deepEqual([broken.status, broken.json.code], [400, "invalid_json"]);
    assert.equal((await api("PUT", ruleRoute(0), '{"text":"New.","__proto__":{"x":1}}')).status, 400);
    const plain = await api("PUT", ruleRoute(0), JSON.stringify({ text: "New." }), { "content-type": "text/plain" });
    assert.deepEqual([plain.status, plain.json.code], [415, "unsupported_media_type"]);
    const large = await declareLarge(server, "PUT", ruleRoute(0), api.token);
    assert.deepEqual([large.status, large.json?.code], [413, "payload_too_large"]);
    assert.equal(await readState(server), before, "none of them wrote anything");
  });
});

test("S5: a DELETE takes one parameter, `expectedText`, once and not too long; anything else is a 400 invalid_request and nothing is removed", async () => {
  await withServer(async (server, client) => {
    await bookWithRules(client);
    const api = await rawApi(server);
    const before = await readState(server);
    const queries = ["?x=1", `?expectedtext=${encodeURIComponent(RULES[0])}`, `?expectedText=${encodeURIComponent(RULES[0])}&expectedText=other`, `?expectedText=${encodeURIComponent(RULES[0])}&x=1`, `?expectedText=${"x".repeat(10_001)}`, "?expected=x"];
    for (const query of queries) {
      const response = await api("DELETE", ruleRoute(0, "b", query));
      assert.equal(response.status, 400, `${query.slice(0, 60)}: ${response.text.slice(0, 200)}`);
      assert.equal(response.json.code, "invalid_request", query.slice(0, 60));
      assert.match(response.json.message, /expectedText/, "it names the parameter");
    }
    assert.equal(await readState(server), before, "a misspelt guard is refused, never read as no guard: nothing was removed");

    const longest = await api("DELETE", ruleRoute(0, "b", `?expectedText=${"x".repeat(10_000)}`));
    assert.deepEqual([longest.status, longest.json.code], [409, "rule_changed"], "the longest text the server takes is read, and does not match");
    for (const query of ["?expectedText=%ZZ", "?expectedText=%E0%A4%A", "?expectedText=%00", "?expectedText=%F0%9F"]) {
      const response = await api("DELETE", ruleRoute(0, "b", query));
      assert.deepEqual([response.status, response.json.code], [409, "rule_changed"], `${query}: an address that is not well made is a text that matches no rule`);
    }
    assert.equal(await readState(server), before);
    const exact = await api("DELETE", ruleRoute(0, "b", `?expectedText=${encodeURIComponent(`  ${RULES[0]}  `)}`));
    assert.equal(exact.status, 200, "the text the author saw is compared without the spaces around it");
    assert.deepEqual(exact.json.state.constraints, [RULES[1], RULES[2]]);
  });
});

// ---------------------------------------------------------------------------------------------
// Who may, when
// ---------------------------------------------------------------------------------------------

test("S5: the rules routes are for clients that may run the autopilot, from an origin that is allowed; an unknown book is a 404, and only PUT and DELETE are the routes", async () => {
  await withServer(async (server, client) => {
    await bookWithRules(client);
    const before = await readState(server);
    const body = { text: "New.", expectedText: RULES[0] };
    const query = `?expectedText=${encodeURIComponent(RULES[0])}`;
    for (const [method, route, sent] of [["PUT", ruleRoute(0), JSON.stringify(body)], ["DELETE", ruleRoute(0, "b", query), undefined]]) {
      const anonymous = await fetch(`${server.url}${route}`, { method, headers: { "content-type": "application/json" }, body: sent });
      assert.equal(anonymous.status, 401, method);
      for (const scopes of [["read"], ["read", "write"], ["write"]]) {
        const refused = await (await rawApi(server, scopes))(method, route, sent);
        assert.equal(refused.status, 403, `${method} ${scopes.join(",")}`);
        assert.equal(refused.json.code, "scope");
      }
      const api = await rawApi(server);
      const foreign = await api(method, route, sent, { origin: "https://evil.example" });
      assert.equal(foreign.status, 403, `${method}: a page from another origin cannot change a rule`);
      const preflight = await fetch(`${server.url}${route}`, { method: "OPTIONS", headers: { origin: "https://narrarium.net", "access-control-request-method": method, "access-control-request-headers": "authorization, content-type" } });
      assert.equal(preflight.status, 204, method);
      assert.match(preflight.headers.get("access-control-allow-methods"), new RegExp(method), "the browser may send it");
    }
    assert.equal(await readState(server), before, "none of them wrote anything");

    const runner = await rawApi(server, ["read", "run"]);
    assert.equal((await runner("PUT", ruleRoute(0), body)).status, 200, "the run scope is what it takes");
    const api = await rawApi(server);
    const allowed = await api("DELETE", ruleRoute(1, "b", `?expectedText=${encodeURIComponent(RULES[1])}`), undefined, { origin: "https://narrarium.net" });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://narrarium.net");
    assert.deepEqual(allowed.json.state.constraints, ["New.", RULES[2]]);

    for (const method of ["PUT", "DELETE"]) {
      const missing = await api(method, ruleRoute(0, "nope"), method === "PUT" ? body : undefined);
      assert.deepEqual([missing.status, missing.json.code], [404, "book_not_found"], method);
    }
    assert.equal((await api("POST", ruleRoute(0), body)).status, 404, "POST is not a route");
    assert.equal((await api("GET", ruleRoute(0))).status, 404, "nor is GET");
    assert.equal((await api("PUT", `/api/v1/books/b/autopilot/rules`, body)).status, 404, "a rule is asked for by its number");
  });
});

test("S5: a state file that cannot be read is a 409 state_corrupt, a commit that lost a race 409 conflict, an update about to start 503 maintenance, before the book is even looked for; none writes anything", async () => {
  await withServer(async (server, client) => {
    await bookWithRules(client);
    await bookWithRules(client, RULES, "damaged");
    const api = await rawApi(server);
    await client.commitFiles("damaged", [{ path: "autopilot/state.json", content: "{ this is not a state" }], "damaged");
    const damaged = [await api("PUT", ruleRoute(0, "damaged"), { text: "New." }), await api("DELETE", ruleRoute(0, "damaged"))];
    for (const response of damaged) assert.deepEqual([response.status, response.json.code], [409, "state_corrupt"]);
    assert.equal(await readState(server, "damaged"), "{ this is not a state", "the damaged file is left as it is for the author to see");

    const before = await readState(server);
    const original = testing.FileBookStore.prototype.commit;
    testing.FileBookStore.prototype.commit = async function () {
      throw Object.assign(new Error("The book changed in the meantime."), { name: "BookConflictError" });
    };
    try {
      for (const response of [await api("PUT", ruleRoute(0), { text: "New." }), await api("DELETE", ruleRoute(0))]) {
        assert.deepEqual([response.status, response.json.code], [409, "conflict"]);
      }
    } finally {
      testing.FileBookStore.prototype.commit = original;
    }
    assert.equal(await readState(server), before, "nothing was written");
    assert.equal((await api("PUT", ruleRoute(0), { text: "New." })).status, 200, "and the same request goes through once the conflict is gone");

    await server.books.requestUpdate(async () => undefined);
    const stopped = await readState(server);
    for (const [method, route, body] of [["PUT", ruleRoute(0), { text: "Newer." }], ["DELETE", ruleRoute(0), undefined], ["PUT", ruleRoute(0, "nope"), { text: "Newer." }], ["DELETE", ruleRoute(0, "nope"), undefined]]) {
      const response = await api(method, route, body);
      assert.deepEqual([response.status, response.json.code], [503, "maintenance"], `${method} ${route}`);
    }
    assert.equal(await readState(server), stopped);
  });
});

// ---------------------------------------------------------------------------------------------
// What the log keeps of it, and what a body nobody meant to send does
// ---------------------------------------------------------------------------------------------

test("S5: the text of a rule, which a DELETE carries in its address, is never written to the log; the address is, without it", async () => {
  const lines = [];
  const MARKER = "Marker-of-a-rule-4f9a7c1e-only-the-author-may-read";
  await withServer(async (server, client) => {
    await bookWithRules(client, [MARKER, ...RULES]);
    const api = await rawApi(server);
    const wrong = await api("DELETE", ruleRoute(1, "b", `?expectedText=${encodeURIComponent(MARKER)}`));
    assert.equal(wrong.status, 409, "(a refusal: the text is not the rule at that number)");
    assert.equal((await api("DELETE", ruleRoute(0, "b", `?expectedText=${encodeURIComponent(MARKER)}`))).status, 200);
    assert.equal((await api("DELETE", ruleRoute(0, "b", `?expectedtext=${encodeURIComponent(MARKER)}&x=1`))).status, 400);
    const encoded = await api("DELETE", ruleRoute(0, "b", `?expected%54ext=${encodeURIComponent(MARKER)}`));
    assert.equal(encoded.status, 409, "(the name of the parameter, written with an escape, is the parameter, and the text is not the rule at that number)");
    assert.equal((await client.updateRule("b", 0, `${MARKER} again`, RULES[0])).state.constraints[0], `${MARKER} again`);
  }, { log: (line) => lines.push(line) });
  const text = lines.join("\n");
  assert.ok(!text.includes(MARKER) && !text.includes(encodeURIComponent(MARKER)), "the rule is not in the log");
  assert.match(text, /DELETE \/api\/v1\/books\/b\/autopilot\/rules\/0\?\*\*\* 200 /, "but the request is: its method, address and answer, with stars where the query was");
  assert.match(text, /DELETE \/api\/v1\/books\/b\/autopilot\/rules\/1\?\*\*\* 409 /);
  assert.match(text, /DELETE \/api\/v1\/books\/b\/autopilot\/rules\/0\?\*\*\* 400 /, "whatever the query was");
  assert.match(text, /PUT \/api\/v1\/books\/b\/autopilot\/rules\/0 200 /);
});

const RAW_PUT_BODIES = [
  "[]", "[[]]", "5", "-1", "1e999", '"x"', "true", "{", "}", "{]", '{"text":', '{"text":"x",}', "nul", "NaN", "\u0000", "{}garbage", "{} {}",
  '{"__proto__":{"text":"x"}}', '{"constructor":{"prototype":{}}}', '{"prototype":1}', '{"text":"x","__proto__":{}}',
  '{"text":{"a":1}}', '{"text":[1,2]}', '{"text":null}', '{"text":"x","expectedText":{"a":1}}',
  `{"text":${"9".repeat(400)}}`, `{"text":"x","expectedText":${"[".repeat(5000)}${"]".repeat(5000)}}`, `{"text":"x","note":"${"y".repeat(200_000)}"}`,
  "null", "{}", "\ufeff{}",
];

test("S5: bodies and addresses that nobody meant to send never make the rules routes fail inside: every answer is a clear 4xx, and nothing changes", async () => {
  const lines = [];
  await withServer(async (server, client) => {
    await bookWithRules(client);
    const api = await rawApi(server);
    const before = await readState(server);
    for (const body of RAW_PUT_BODIES) {
      const response = await api("PUT", ruleRoute(0), body);
      const label = JSON.stringify(body.slice(0, 50));
      assert.ok(response.status >= 400 && response.status < 500, `${label}: ${response.status} ${response.text.slice(0, 200)}`);
      assert.equal(typeof response.json?.code, "string", label);
      assert.equal(typeof response.json?.message, "string", label);
      assert.notEqual(response.json.code, "internal", label);
    }
    assert.equal(await readState(server), before, "no body changed a rule");
    // Every address asks for the third rule: the first one asks it without a guard, and removes it; the others ask for what is no longer there, or are refused.
    const addresses = ["", "?", "?expectedText", "?expectedText=%", "?expectedText=%G1&expectedText=%G2", "?expectedText[]=x", "?=", "?&&&", "?expectedText=a%00b", `?expectedText=${"é".repeat(1500)}`, "#fragment", "?expectedText=x#y"];
    for (const address of addresses) {
      const response = await api("DELETE", ruleRoute(2, "b", address));
      const label = JSON.stringify(address.slice(0, 50));
      assert.ok(response.status < 500, `${label}: ${response.status} ${response.text.slice(0, 200)}`);
      if (response.status >= 400) assert.notEqual(response.json?.code, "internal", label);
    }
    assert.deepEqual(await rulesOf(client), [RULES[0], RULES[1]], "the third rule is the only one that went, and by the one address that asked for it without a guard");
  }, { log: (line) => lines.push(line) });
  assert.deepEqual(lines.filter((line) => /^Error /.test(line)), [], "no internal error was logged");
});
