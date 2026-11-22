import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const {
  AUTOPILOT_RULE_ERROR_CODES,
  AutopilotRuleError,
  AutopilotSession,
  NarrariumServerClient,
  SERVER_FEATURE_AUTOPILOT_CONTROLS,
  SERVER_FEATURE_AUTOPILOT_RULES,
  ServerRequestError,
  isAutopilotRuleErrorCode,
  serverSupportsAutopilotControls,
  serverSupportsAutopilotRules,
} = engine;

const BASE = "http://127.0.0.1:24242";

/** A personal server that answers every request with `answer(request)` and remembers each one. */
function fakeServer(answer) {
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const request = {
      method: init.method ?? "GET",
      path: url.pathname,
      search: url.search,
      expectedText: url.searchParams.get("expectedText"),
      authorization: init.headers?.authorization,
      contentType: init.headers?.["content-type"],
      accept: init.headers?.accept,
      body: init.body ? JSON.parse(init.body) : undefined,
      rawBody: init.body,
    };
    log.push(request);
    return answer(request);
  };
  return { fetch, log };
}

const client = (server) => new NarrariumServerClient({ baseUrl: BASE, token: "nrs_me", fetch: server.fetch });

/** The snapshot a server that knows the rules answers: the state, with the rules it holds now. */
const snapshot = (constraints = ["Never use the word suddenly."], extra = {}) => ({
  bookId: "my-book",
  state: { status: "paused", constraints },
  summary: { status: "paused", constraints: constraints.length },
  activities: [],
  live: null,
  running: false,
  host: null,
  ...extra,
});

const refuse = (status, code, message = "Refused.") => () => Response.json({ code, message }, { status });

// ─── The features a server announces ────────────────────────────────────────

test("a server says whether it can edit the permanent rules in the features it announces, and a host can ask without a risk", async () => {
  assert.equal(SERVER_FEATURE_AUTOPILOT_RULES, "autopilot-rules");
  assert.equal(typeof serverSupportsAutopilotRules, "function");
  const base = ["autopilot", "director", "sync", "pairing", "updates", "github"];
  assert.equal(serverSupportsAutopilotRules({ features: [...base, SERVER_FEATURE_AUTOPILOT_RULES] }), true);
  assert.equal(serverSupportsAutopilotRules({ features: base }), false, "a server from before them does not announce it");
  assert.equal(serverSupportsAutopilotRules({ features: [...base, SERVER_FEATURE_AUTOPILOT_CONTROLS] }), false, "the quick controls are another thing");
  assert.equal(serverSupportsAutopilotControls({ features: [...base, SERVER_FEATURE_AUTOPILOT_RULES] }), false, "and so are the rules");
  assert.equal(serverSupportsAutopilotRules({ features: [SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RULES] }), true);
  for (const info of [undefined, null, {}, { features: undefined }, { features: null }, { features: "autopilot-rules" }, { features: [1, null] }, { features: {} }, 7, "autopilot-rules"]) {
    assert.equal(serverSupportsAutopilotRules(info), false, JSON.stringify(info));
  }
  const server = fakeServer(() => Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.6", engineVersion: "0.1.6", serverId: "s", label: "x", git: true, features: [...base, SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RULES] }));
  const info = await client(server).info();
  assert.equal(serverSupportsAutopilotRules(info), true, "read from what the server's info answers");
  assert.equal(serverSupportsAutopilotControls(info), true);
});

// ─── Editing a rule ─────────────────────────────────────────────────────────

test("updateRule is a PUT of the new text, with the text the author saw to check it against, and answers the snapshot as configure does", async () => {
  const server = fakeServer(() => Response.json(snapshot(["Never use the word suddenly.", "Write in the first person."])));
  const api = client(server);
  assert.equal(typeof api.updateRule, "function");
  const answer = await api.updateRule("my-book", 1, "Write in the first person.", "Write in the third person.");
  assert.deepEqual(server.log[0], {
    method: "PUT",
    path: "/api/v1/books/my-book/autopilot/rules/1",
    search: "",
    expectedText: null,
    authorization: "Bearer nrs_me",
    contentType: "application/json",
    accept: "application/json",
    body: { text: "Write in the first person.", expectedText: "Write in the third person." },
    rawBody: JSON.stringify({ text: "Write in the first person.", expectedText: "Write in the third person." }),
  });
  assert.deepEqual(answer.state.constraints, ["Never use the word suddenly.", "Write in the first person."], "the answer is the snapshot, with nothing taken out of it");
  assert.equal(answer.summary.constraints, 2);

  await api.updateRule("my-book", 0, "Only the text.");
  assert.deepEqual(server.log[1].body, { text: "Only the text." }, "without the text the author saw, there is nothing to check against: only the new text goes");
  assert.equal("expectedText" in server.log[1].body, false);
  await api.updateRule("my-book", 0, "  Keep my spaces.  ", undefined);
  assert.deepEqual(server.log[2].body, { text: "  Keep my spaces.  " }, "the text is sent as it was given: the server's engine decides what a rule is");
  await api.updateRule("my-book", 4, "New.", "");
  assert.deepEqual(server.log[3].body, { text: "New.", expectedText: "" }, "an empty text the author saw is sent: it cannot match, and the server says so");
  assert.deepEqual(server.log.map((entry) => [entry.method, entry.path]), [["PUT", "/api/v1/books/my-book/autopilot/rules/1"], ["PUT", "/api/v1/books/my-book/autopilot/rules/0"], ["PUT", "/api/v1/books/my-book/autopilot/rules/0"], ["PUT", "/api/v1/books/my-book/autopilot/rules/4"]]);
});

test("removeRule is a DELETE of the rule at the index, with the text the author saw in the query, and sends no body", async () => {
  const server = fakeServer(() => Response.json(snapshot([])));
  const api = client(server);
  assert.equal(typeof api.removeRule, "function");
  const answer = await api.removeRule("my-book", 0, "Never use the word suddenly.");
  assert.deepEqual(server.log[0], {
    method: "DELETE",
    path: "/api/v1/books/my-book/autopilot/rules/0",
    search: "?expectedText=Never%20use%20the%20word%20suddenly.",
    expectedText: "Never use the word suddenly.",
    authorization: "Bearer nrs_me",
    contentType: undefined,
    accept: "application/json",
    body: undefined,
    rawBody: undefined,
  });
  assert.deepEqual(answer.state.constraints, []);

  await api.removeRule("my-book", 3);
  assert.equal(server.log[1].search, "", "without the text the author saw there is no query at all");
  assert.equal(server.log[1].path, "/api/v1/books/my-book/autopilot/rules/3");
  await api.removeRule("my-book", 2, undefined);
  assert.equal(server.log[2].search, "");
  await api.removeRule("my-book", 2, "");
  assert.equal(server.log[3].search, "?expectedText=", "an empty text is a text");
});

test("whatever characters the rule, the book and the index have, the request says them exactly: the text of a rule survives a query string", async () => {
  const server = fakeServer(() => Response.json(snapshot()));
  const api = client(server);
  const awkward = ["Evita «improvvisamente» & “all'improvviso”: #1? 100% = sì", "a/b\\c?d=e&f=g#h", "emoji 😀 and 日本語 and \n a line break", "+ plus and %41 percent"];
  for (const text of awkward) {
    await api.removeRule("my-book", 0, text);
    const sent = server.log.at(-1);
    assert.equal(sent.expectedText, text, JSON.stringify(text));
    assert.equal(sent.path, "/api/v1/books/my-book/autopilot/rules/0", "the text never leaks into the path");
    assert.equal(sent.search, new URL(`${BASE}/?expectedText=${encodeURIComponent(text)}`).search, "encoded as a query string is: whatever the platform's URL makes of it");
    await api.updateRule("my-book", 0, text, text);
    assert.deepEqual(server.log.at(-1).body, { text, expectedText: text });
  }
  const id = "my book/1?x";
  await api.updateRule(id, 12, "Text.");
  assert.equal(server.log.at(-1).path, `/api/v1/books/${encodeURIComponent(id)}/autopilot/rules/12`, "the book id is part of the path as it is everywhere else");
  assert.equal(engine.bookRoute(id, "/autopilot/rules/12"), server.log.at(-1).path);
});

// ─── What the server refuses ────────────────────────────────────────────────

const REFUSALS = [
  [400, "rule_empty", "The rule is empty."],
  [400, "rule_too_long", "The rule is 900 characters long: a rule is at most 800."],
  [400, "rule_duplicate", "Another rule already says this."],
  [404, "rule_not_found", "There is no rule number 4."],
  [409, "rule_changed", "The rule changed in the meantime: reload the rules and try again."],
  [503, "maintenance", "The server is about to restart for an update: try again in a minute."],
  [403, "scope", "This token does not have the run permission."],
  [404, "book_not_found", "This book is not on the server."],
  [401, "unauthorized", "The token is not valid."],
];

test("what the server refuses comes back as the error the client always gave, with the status and the code of the server, for both calls", async () => {
  for (const [status, code, message] of REFUSALS) {
    const api = client(fakeServer(refuse(status, code, message)));
    const expected = (error) => error instanceof ServerRequestError && error.status === status && error.code === code && error.message === message;
    await assert.rejects(() => api.updateRule("my-book", 1, "New."), expected, `${status} ${code} on update`);
    await assert.rejects(() => api.removeRule("my-book", 1, "Old."), expected, `${status} ${code} on remove`);
  }
});

test("the codes of the rule errors are one list the engine, the server and the host agree on, and the list is what the engine really throws", async () => {
  assert.deepEqual([...(AUTOPILOT_RULE_ERROR_CODES ?? [])].sort(), ["rule_changed", "rule_duplicate", "rule_empty", "rule_not_found", "rule_too_long"]);
  assert.equal(typeof isAutopilotRuleErrorCode, "function");
  for (const code of AUTOPILOT_RULE_ERROR_CODES ?? []) assert.equal(isAutopilotRuleErrorCode(code), true, code);
  for (const code of ["maintenance", "scope", "not_found", "book_not_found", "rule", "", undefined, null, 4, {}]) assert.equal(isAutopilotRuleErrorCode(code), false, JSON.stringify(code));

  const store = new MemoryBookStore(seedBookFiles());
  const session = new AutopilotSession({ bookId: "book", store, ai: createFakeAutopilotAi(), host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.configure({ options: { pauseAfterPlan: false } });
  await session.intervene({ scope: "from_now", text: "Never use the word suddenly." });
  await session.intervene({ scope: "from_now", text: "Write in the first person." });
  const codeOf = (action) => action().then(() => null, (error) => (error instanceof AutopilotRuleError ? error.code : `not a rule error: ${error?.message}`));
  const thrown = new Set([
    await codeOf(() => session.updateRule(0, "   ")),
    await codeOf(() => session.updateRule(0, "x".repeat(engine.MAX_RULE_CHARACTERS + 1))),
    await codeOf(() => session.updateRule(9, "New.")),
    await codeOf(() => session.updateRule(0, "New.", "Not what the author saw.")),
    await codeOf(() => session.updateRule(0, "Write in the first person.")),
    await codeOf(() => session.removeRule(9)),
    await codeOf(() => session.removeRule(1, "Not what the author saw.")),
  ]);
  assert.deepEqual([...thrown].sort(), [...AUTOPILOT_RULE_ERROR_CODES].sort(), "every code in the list is thrown by the engine, and nothing else is");
});

test("a server from before the rules answers 404 to the new route, and one that cannot be reached is unreachable: errors a host can tell from a refusal of a rule", async () => {
  const old = fakeServer(refuse(404, "not_found", "This route does not exist."));
  await assert.rejects(() => client(old).updateRule("my-book", 0, "New."), (error) => error instanceof ServerRequestError && error.status === 404 && error.code === "not_found");
  await assert.rejects(() => client(old).removeRule("my-book", 0), (error) => error instanceof ServerRequestError && error.status === 404 && error.code === "not_found");
  assert.equal(isAutopilotRuleErrorCode("not_found"), false, "it is not a rule that was not found");
  assert.equal(isAutopilotRuleErrorCode("rule_not_found"), true);

  const away = new NarrariumServerClient({ baseUrl: BASE, token: "nrs_me", fetch: async () => {
    throw new TypeError("fetch failed");
  } });
  await assert.rejects(() => away.updateRule("my-book", 0, "New."), (error) => error instanceof ServerRequestError && error.code === "unreachable");
  await assert.rejects(() => away.removeRule("my-book", 0, "Old."), (error) => error instanceof ServerRequestError && error.code === "unreachable");
});

test("the client does not judge an index: it asks, and the server answers rule_not_found for one that is none", async () => {
  const server = fakeServer((request) => (/\/rules\/\d+$/.test(request.path) ? Response.json(snapshot()) : Response.json({ code: "rule_not_found", message: "There is no such rule." }, { status: 404 })));
  const api = client(server);
  await api.removeRule("my-book", 5);
  for (const index of [-1, 1.5, Number.NaN]) {
    await assert.rejects(() => api.removeRule("my-book", index), (error) => error instanceof ServerRequestError && error.status === 404 && error.code === "rule_not_found", String(index));
  }
  assert.equal(server.log.length, 4, "every call went to the server");
});

// ─── The answer to a question of the director ───────────────────────────────

test("the answer to a question of the director can ask to be kept as a rule, and the client sends it as it is", async () => {
  const server = fakeServer(() => Response.json(snapshot(["Always in the first person."])));
  const api = client(server);
  await api.answer("my-book", { questionId: "question-1", answer: "Always in the first person.", asRule: true });
  assert.deepEqual(server.log[0].body, { questionId: "question-1", answer: "Always in the first person.", asRule: true });
  assert.equal(server.log[0].path, "/api/v1/books/my-book/autopilot/answer");
  await api.answer("my-book", { questionId: "question-1", answer: "Hopeful.", accept: false });
  assert.equal("asRule" in server.log[1].body, false, "a note used once is still the default: asRule is sent only when it is asked for");
});
