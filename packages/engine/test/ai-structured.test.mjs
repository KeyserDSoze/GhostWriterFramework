import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

const { AiProviderError, AiReplyRejectedError, AutopilotSession, askDirector, cleanProse, createFetchAi, parseStructuredText, pickAiRuntimeConfig, splitReasoningBlock, structuredFromReply, structuredReply } = engine;

const schema = { name: "director_review", description: "d", parameters: { type: "object", properties: { verdict: { type: "string" }, decisions: { type: "array" } }, required: ["verdict", "decisions"] } };
const answer = { verdict: "revise", decisions: [{ findingId: "S1-1", action: "accept" }] };
const ASK = { capability: "autopilot", label: "t", system: "s", user: "u" };

// ─── B15: a closing reasoning tag without an opening one ────────────────────

test("a reply that closes its reasoning without having opened it keeps only what follows the last closing tag", () => {
  assert.deepEqual(splitReasoningBlock("let me plan this scene</think>\n\nThe scene."), { reply: "The scene.", reasoningCharacters: "let me plan this scene".length });
  const several = splitReasoningBlock("first thoughts</think>more thoughts</think>\nFinal.");
  assert.equal(several.reply, "Final.", "everything up to the LAST closing tag goes");
  assert.ok(several.reasoningCharacters > 0);
  assert.equal(splitReasoningBlock("<think>a</think>b</think>Final").reply, "Final", "after a leading block too");
  assert.equal(splitReasoningBlock("hmm</thinking>Reply").reply, "Reply");
  assert.equal(splitReasoningBlock("hmm</REASONING>Reply").reply, "Reply");
  assert.equal(splitReasoningBlock("hmm</Think>   Reply").reply, "Reply");
  assert.equal(splitReasoningBlock("only reasoning</think>").reply, "");
  assert.equal(splitReasoningBlock("a</think>b<think>c</think>d").reply, "b<think>c</think>d", "a paired block later on is the model's own business");
  assert.deepEqual(splitReasoningBlock("Plain reply <think>quoted</think>"), { reply: "Plain reply <think>quoted</think>", reasoningCharacters: 0 });
  assert.deepEqual(splitReasoningBlock("A reply with no tags."), { reply: "A reply with no tags.", reasoningCharacters: 0 });
  assert.deepEqual(splitReasoningBlock(""), { reply: "", reasoningCharacters: 0 });
});

test("headless reasoning never becomes prose, a scene or a structured answer", () => {
  assert.equal(cleanProse("I should open on the harbor, then the glove.</think>\n# Scene 1\n\nShe ran."), "She ran.");
  assert.equal(cleanProse("only reasoning</think>"), "", "so the scene is rejected as empty");
  const text = `I will answer in JSON {"verdict":"draft"}</think>${JSON.stringify(answer)}`;
  assert.deepEqual(parseStructuredText(text, schema), answer);
});

test("the client drops headless reasoning from the reply and recognizes a reply that is only reasoning", async () => {
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [{ id: "a", name: "A", provider: "openai", endpoint: "http://a.test/v1", apiKey: "k", chatModels: [{ id: "1", name: "m", capabilities: ["default"] }] }] });
  const reply = (content, finish = "stop") => async () => Response.json({ choices: [{ message: { content }, finish_reason: finish }] });
  assert.equal((await createFetchAi(cfg, { fetch: reply("plan the reply</think>The scene begins.") }).complete(ASK)).text, "The scene begins.");
  const cut = await createFetchAi(cfg, { fetch: reply("plan the reply</think>", "length") }).complete(ASK).then(() => null, (error) => error);
  assert.match(cut.message, /while reasoning/);
  const empty = await createFetchAi(cfg, { fetch: reply("plan the reply</think>") }).complete(ASK).then(() => null, (error) => error);
  assert.match(empty.message, /finished after reasoning without a reply/);
});

// ─── B16: a forced tool call must carry the expected fields ─────────────────

test("tool arguments that hold none of the expected fields are rejected, with the fields named", () => {
  for (const value of [{ foo: 1 }, { summary: "only a summary" }, { arguments: { foo: 1 } }]) {
    assert.throws(
      () => structuredReply(value, schema),
      (error) => error instanceof AiReplyRejectedError && error.retryable === true && /none of the expected fields/.test(error.message) && /"verdict"/.test(error.message) && /"decisions"/.test(error.message),
      JSON.stringify(value),
    );
  }
  assert.deepEqual(structuredReply({ verdict: "approve" }, schema), { verdict: "approve" }, "some of the expected fields: the task names what is missing");
  assert.deepEqual(structuredReply({ verdict: "approve", decisions: [], extra: 1 }, schema), { verdict: "approve", decisions: [], extra: 1 });
  assert.deepEqual(structuredReply({ result: JSON.stringify(answer) }, schema), answer, "a wrapper around the answer is still unwrapped first");
});

test("without a required list, at least one declared property must be present", () => {
  const open = { name: "result", description: "d", parameters: { type: "object", properties: { ok: { type: "boolean" }, why: { type: "string" } } } };
  assert.throws(() => structuredReply({ foo: 1 }, open), (error) => error instanceof AiReplyRejectedError && /none of the expected fields/.test(error.message) && /"ok"/.test(error.message));
  assert.deepEqual(structuredReply({ why: "because" }, open), { why: "because" });
  assert.deepEqual(structuredReply({ ok: false }, open), { ok: false });
  assert.throws(() => structuredReply({}, open), /empty/);
  const bare = { name: "free", description: "d", parameters: { type: "object" } };
  assert.deepEqual(structuredReply({ anything: 1 }, bare), { anything: 1 }, "a schema that declares nothing accepts any object");
});

test("when the tool is ignored or answers the wrong thing, the JSON in the text is used", () => {
  assert.deepEqual(structuredFromReply({ toolArguments: "{\"foo\":1}", content: `Sure: ${JSON.stringify(answer)}`, schema }), answer);
  assert.deepEqual(structuredFromReply({ toolArguments: "", content: `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``, schema }), answer);
  assert.deepEqual(structuredFromReply({ toolArguments: "{\"summary\":\"x\"}", content: "<think>a</think>" + JSON.stringify(answer), schema }), answer);
  assert.throws(() => structuredFromReply({ toolArguments: "{\"foo\":1}", content: "", schema }), (error) => error instanceof AiReplyRejectedError && /none of the expected fields/.test(error.message));
  assert.throws(() => structuredFromReply({ toolArguments: "{\"foo\":1}", content: "I cannot do that.", schema }), AiReplyRejectedError);
});

test("the client moves on to the next candidate when the first one's tool call says nothing useful", async () => {
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [
    { id: "a", name: "A", provider: "openai", endpoint: "http://a.test/v1", apiKey: "k", chatModels: [{ id: "1", name: "weak-local", capabilities: ["default"] }] },
    { id: "b", name: "B", provider: "openai", endpoint: "http://b.test/v1", apiKey: "k", chatModels: [{ id: "2", name: "strong", capabilities: ["default"] }] },
  ] });
  const hosts = [];
  const fetch = async (url) => {
    hosts.push(new URL(url).hostname);
    const args = String(url).includes("a.test") ? "{\"summary\":\"only a summary\"}" : "{\"verdict\":\"approve\",\"decisions\":[]}";
    return Response.json({ choices: [{ message: { tool_calls: [{ function: { arguments: args } }] }, finish_reason: "tool_calls" }] });
  };
  const response = await createFetchAi(cfg, { fetch }).complete({ ...ASK, json: schema });
  assert.deepEqual(response.json, { verdict: "approve", decisions: [] });
  assert.equal(response.model, "strong");
  assert.deepEqual(hosts, ["a.test", "b.test"], "the second candidate was tried");
});

test("with Tools only off, a model that ignores the tool and answers in the text still works end to end", async () => {
  const cfg = pickAiRuntimeConfig({ aiToolsOnly: false, aiIntegrations: [{ id: "a", name: "A", provider: "openai", endpoint: "http://a.test/v1", apiKey: "k", chatModels: [{ id: "1", name: "m", capabilities: ["default"] }] }] });
  const fetch = async () => Response.json({ choices: [{ message: { content: `Here you go:\n${JSON.stringify(answer)}`, tool_calls: [{ function: { arguments: "{\"foo\":1}" } }] }, finish_reason: "stop" }] });
  assert.deepEqual((await createFetchAi(cfg, { fetch }).complete({ ...ASK, json: schema })).json, answer);
  const textOnly = async () => Response.json({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }] });
  assert.deepEqual((await createFetchAi(cfg, { fetch: textOnly }).complete({ ...ASK, json: schema })).json, answer);
});

const encoder = new TextEncoder();
function events(chunks) {
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** An OpenAI-compatible provider answering with the fake AI's replies; `respond` may take a request over. */
function provider(fake, respond) {
  const requests = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    const custom = respond?.(body, requests);
    if (custom) return custom;
    const tool = body.tools?.[0]?.function;
    const out = await fake.complete({ capability: "autopilot", label: "provider", system: body.messages[0].content, user: body.messages[1].content, json: tool });
    if (tool) return Response.json({ choices: [{ message: { content: null, tool_calls: [{ function: { arguments: JSON.stringify(out.json) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
    if (body.stream) return events([`data: ${JSON.stringify({ choices: [{ delta: { content: out.text } }] })}\n\n`, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n"]);
    return Response.json({ choices: [{ message: { content: out.text }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
  };
  return { fetch, requests };
}

const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const ONE_SCENE = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

async function runOver(host, cfg, start = ONE_SCENE, extra = {}) {
  const store = new MemoryBookStore(seedBookFiles());
  const emitted = [];
  const session = new AutopilotSession({ bookId: "book", store, ai: createFetchAi(cfg, { fetch: host.fetch }), host: "server", hostLabel: "test", retryDelayMs: 0, ...extra });
  session.subscribe((event) => emitted.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { state: (await session.snapshot()).state, events: emitted, store };
}

test("a tool call with unrelated keys is retried once with the reason, through the whole autopilot", async () => {
  let wrong = 0;
  const host = provider(createFakeAutopilotAi(), (body) => {
    if (body.tools?.[0]?.function.name !== "plan_review" || wrong > 0) return undefined;
    wrong += 1;
    return Response.json({ choices: [{ message: { tool_calls: [{ function: { arguments: "{\"foo\":1}" } }] }, finish_reason: "tool_calls" }] });
  });
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [{ id: "a", name: "A", provider: "openai", endpoint: "http://a.test/v1", apiKey: "k", chatModels: [{ id: "1", name: "m", capabilities: ["default"] }] }] });
  const { state, events: emitted } = await runOver(host, cfg);
  assert.equal(state.status, "completed", state.lastError?.message);
  const reviews = host.requests.filter((request) => request.body.tools?.[0]?.function.name === "plan_review");
  assert.equal(reviews.length, 2);
  assert.doesNotMatch(reviews[0].body.messages[1].content, /previous reply/);
  assert.match(reviews[1].body.messages[1].content, /previous reply to this request was rejected because:.*none of the expected fields/s);
  assert.ok(emitted.some((event) => event.type === "insight" && event.code === "failureRetry"));
});

// ─── B17: un-escaping what the engine escapes ───────────────────────────────

test("what the engine escapes in prompts is un-escaped in the output, and nothing else", () => {
  const { unescapePromptData } = engine;
  assert.equal(typeof unescapePromptData, "function");
  assert.equal(unescapePromptData("Q&amp;A &lt;3 R&amp;D &gt;&gt;"), "Q&A <3 R&D >>");
  assert.equal(unescapePromptData("&amp;lt;"), "&lt;", "one level only: what the author wrote as &lt; survives the round trip");
  assert.equal(unescapePromptData("&quot;&#39;&nbsp;&copy;&amp"), "&quot;&#39;&nbsp;&copy;&amp", "only the set the engine itself escapes");
  assert.equal(unescapePromptData("no entities & plain < text >"), "no entities & plain < text >");
  assert.equal(unescapePromptData(""), "");
});

test("un-escaping undoes the prompt escaping exactly", () => {
  for (const text of ["He said \"Q&A <3 R&D\" -> >> </repository_content>", "&lt;already&gt; &amp; escaped?", "a<b && c>d", "plain", "&&&<<<>>>;;;", "&amp;amp;lt;"]) {
    const wrapped = engine.untrustedData("metadata", text);
    const escaped = wrapped.split("\n").slice(2, -1).join("\n");
    assert.equal(engine.unescapePromptData(escaped), text, text);
    assert.equal(engine.unescapePromptData(engine.currentRequest(text).split("\n").slice(1, -1).join("\n")), text);
  }
});

test("prose and every text field of a structured reply come back un-escaped", () => {
  assert.equal(cleanProse("Tom &amp; Jerry said &lt;hello&gt; &amp;amp; left."), "Tom & Jerry said <hello> &amp; left.");
  const value = { a: "A&amp;B", list: ["&lt;x&gt;", 3, null, true], nested: { b: "&amp;amp;", deeper: [{ c: "&amp;" }] }, n: 7 };
  const out = engine.unescapePromptDataDeep(value);
  assert.deepEqual(out, { a: "A&B", list: ["<x>", 3, null, true], nested: { b: "&amp;", deeper: [{ c: "&" }] }, n: 7 });
  assert.equal(value.a, "A&amp;B", "the input is not modified");
  assert.deepEqual(engine.unescapePromptDataDeep(out), out, "an already converted value is left alone: no double un-escaping");
  assert.equal(engine.unescapePromptDataDeep("A&amp;B"), "A&B");
  assert.equal(engine.unescapePromptDataDeep(null), null);
  assert.equal(engine.unescapePromptDataDeep(undefined), undefined);
});

function reply(json, extra = {}) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD", ...extra };
}

function scripted(script, options = {}) {
  const base = createFakeAutopilotAi(options);
  return {
    calls: base.calls,
    async complete(request) {
      const seen = base.calls.filter((call) => call.label === request.label).length;
      const custom = script(request, seen);
      if (custom === undefined) return base.complete(request);
      base.calls.push(request);
      if (custom instanceof Error) throw custom;
      return custom;
    },
  };
}

async function runWith(ai, start = ONE_SCENE) {
  const store = new MemoryBookStore(seedBookFiles());
  const emitted = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  session.subscribe((event) => emitted.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { state: (await session.snapshot()).state, events: emitted, store };
}

test("the book never receives &amp; from the model: prose, summaries, design and canon are un-escaped", async () => {
  const ai = scripted((request) => {
    if (request.label === "autopilot:write:1.1") return reply(undefined, { text: "Mira &amp; Orrin met at the Q&amp;A of the harbor &lt;council&gt;. ".repeat(40), json: undefined });
    if (request.json?.name === "scene_summary") return reply({ summary: "Mira &amp; Orrin &lt;argue&gt;." });
    if (request.json?.name === "book_concept") return reply({ logline: "A tale of R&amp;D.", storyDesign: "# Story Design\n\nQ&amp;A at the harbor.", context: "# World\n\nSalt &amp; glass, a cold northern harbor in an age of sail where glass is the only trade that matters.", characters: [{ name: "Mira &amp; Co", description: "A founder." }], locations: [], factions: [], secrets: [] });
    return undefined;
  }, { reviewVerdict: () => "approve" });
  const { state, store } = await runWith(ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  const scene = store.files.get("chapters/001-chapter-title-1/001-scene-1-title.md");
  assert.match(scene, /Mira & Orrin met at the Q&A of the harbor <council>\./);
  assert.doesNotMatch(scene, /&amp;|&lt;|&gt;/);
  assert.equal(engine.parseMarkdown(scene).frontmatter.summary, "Mira & Orrin <argue>.");
  assert.match(store.files.get("story-design.md"), /Q&A at the harbor/);
  assert.doesNotMatch(store.files.get("story-design.md"), /&amp;/);
  assert.match(store.files.get("context.md"), /Salt & glass/);
  assert.ok(store.files.has("characters/mira-co.md"), "the canon file is named from the un-escaped name");
  assert.ok(!store.files.has("characters/mira-amp-co.md"));
  assert.doesNotMatch(JSON.stringify(state), /&amp;/);
});

test("the director's opinion, on demand or at the end of the book, is un-escaped once", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = { calls: [], async complete() { return reply({ verdict: "approve", score: 9, summary: "Great &amp; bold &lt;prose&gt;.", strengths: ["Voice &amp; pace"], concerns: [{ severity: "minor", issue: "R&amp;D scenes", suggestion: "Cut &lt;one&gt;" }], decisions: ["Keep &amp;amp; as is"], nextSteps: [] }); } };
  const { opinion } = await askDirector({ store, ai, target: { kind: "book" }, save: true });
  assert.equal(opinion.summary, "Great & bold <prose>.");
  assert.deepEqual(opinion.strengths, ["Voice & pace"]);
  assert.equal(opinion.concerns[0].issue, "R&D scenes");
  assert.equal(opinion.concerns[0].suggestion, "Cut <one>");
  assert.deepEqual(opinion.decisions, ["Keep &amp; as is"], "one level only");
  assert.doesNotMatch(store.files.get("evaluations/director/book.md"), /&lt;|&gt;|Great &amp;/);

  const final = scripted((request) => request.json?.name === "director_opinion" ? reply({ verdict: "approve", score: 9, summary: "A &amp;lt;b&amp;gt; tag.", strengths: [], concerns: [], decisions: [], nextSteps: [] }) : undefined, { reviewVerdict: () => "approve" });
  const run = await runWith(final);
  assert.match(run.store.files.get("evaluations/director/book.md"), /A &lt;b&gt; tag\./, "converted by the runner, not again by the director");
});

// ─── B23 / B24: secrets in messages ─────────────────────────────────────────

test("redactSecrets removes the configured keys in both forms and the usual credential shapes", () => {
  const { redactSecrets } = engine;
  assert.equal(typeof redactSecrets, "function");
  const key = "sk-proj-AbCdEf1234567890xyz";
  assert.equal(redactSecrets(`failed with key ${key} twice ${key}`, [key]), "failed with key [redacted] twice [redacted]");
  const odd = "a+b/c=d==Q";
  assert.equal(redactSecrets(`raw ${odd} and encoded ${encodeURIComponent(odd)} in a URL`, [odd]), "raw [redacted] and encoded [redacted] in a URL");
  assert.equal(redactSecrets("0123456789abcdef0123456789abcdef is an Azure key", ["0123456789abcdef0123456789abcdef"]), "[redacted] is an Azure key");

  assert.equal(redactSecrets("HTTP 401: Bearer abcdef0123456789 rejected"), "HTTP 401: Bearer [redacted] rejected");
  assert.equal(redactSecrets("authorization: Bearer abcdef0123456789"), "authorization: [redacted]");
  assert.equal(redactSecrets("api-key: 0123456789abcdef"), "api-key: [redacted]");
  assert.equal(redactSecrets("{\"api-key\":\"abc123XYZ\"}"), "{\"api-key\":\"[redacted]\"}");
  assert.equal(redactSecrets("x-api-key: abc123XYZ"), "x-api-key: [redacted]");
  assert.equal(redactSecrets("apikey=abc123XYZ&x=1"), "apikey=[redacted]&x=1");
  assert.equal(redactSecrets("GET https://g.example/v1/models?key=AIzaSyAbcdefghijklmnop&alt=json"), "GET https://g.example/v1/models?key=[redacted]&alt=json");
  assert.equal(redactSecrets("https://g.example/v1?alt=json&key=secret123"), "https://g.example/v1?alt=json&key=[redacted]");
  assert.equal(redactSecrets("https://g.example/v1?api_key=secret123"), "https://g.example/v1?api_key=[redacted]");
  assert.equal(redactSecrets("Incorrect API key provided: sk-abc123def456ghi789."), "Incorrect API key provided: sk-[redacted].");
  assert.equal(redactSecrets("key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt used"), "key sk-[redacted] used");
  assert.equal(redactSecrets(`token ghp_${"A1b2C3d4E5".repeat(4)} used`), "token [redacted] used");
  assert.equal(redactSecrets(`token github_pat_${"A1b2C3d4E5".repeat(4)} used`), "token [redacted] used");

  const plain = "openai gpt-4o: HTTP 503 — overloaded at https://api.openai.com/v1/chat/completions (the key words are plain)";
  assert.equal(redactSecrets(plain), plain, "ordinary messages are untouched");
  assert.equal(redactSecrets("the key is abc", ["abc"]), "the key is abc", "a secret too short to be one is not replaced everywhere");
  assert.equal(redactSecrets("", ["abcdefgh"]), "");
  assert.equal(redactSecrets("nothing here", []), "nothing here");
});

const KEY = "sk-live-0123456789ABCDEF";
const keyed = (extra = {}) => pickAiRuntimeConfig({ aiIntegrations: [{ id: "a", name: "A", provider: "openai", endpoint: "http://a.test/v1", apiKey: KEY, chatModels: [{ id: "1", name: "m", capabilities: ["default"] }], ...extra }] });

test("HTTP, stream and network errors never carry the API key", async () => {
  const echo = `Incorrect API key provided: ${KEY}. Retry with ${encodeURIComponent(KEY)} via Bearer ${KEY}, api-key: ${KEY}`;
  const http = await createFetchAi(keyed(), { fetch: async () => new Response(JSON.stringify({ error: { message: echo } }), { status: 401 }) }).complete(ASK).then(() => null, (error) => error);
  assert.ok(http instanceof AiProviderError);
  assert.equal(http.message.includes("0123456789ABCDEF"), false, http.message);
  assert.match(http.message, /\[redacted\]/);
  assert.match(http.message, /HTTP 401/);

  const raw = await createFetchAi(keyed(), { fetch: async () => new Response(`<html>bad key ${KEY}</html>`, { status: 400 }) }).complete(ASK).then(() => null, (error) => error);
  assert.equal(raw.message.includes("0123456789ABCDEF"), false);

  const streamed = await createFetchAi(keyed(), { fetch: async () => events([`data: ${JSON.stringify({ error: { message: echo, type: "invalid_request_error" } })}\n\n`]) }).complete({ ...ASK, onText: () => undefined }).then(() => null, (error) => error);
  assert.equal(streamed.message.includes("0123456789ABCDEF"), false);
  assert.match(streamed.message, /\[redacted\]/);

  const inBody = await createFetchAi(keyed(), { fetch: async () => Response.json({ error: { message: echo } }) }).complete(ASK).then(() => null, (error) => error);
  assert.equal(inBody.message.includes("0123456789ABCDEF"), false);

  const network = await createFetchAi(keyed(), { fetch: async () => { throw new Error(`connect ECONNREFUSED http://a.test/v1/chat/completions?key=${KEY}`); } }).complete(ASK).then(() => null, (error) => error);
  assert.equal(network.message.includes("0123456789ABCDEF"), false);
  assert.match(network.message, /\?key=\[redacted\]/);
  assert.equal(network.retryable, true);
});

test("an Azure key, which has no recognizable shape, is removed by value; the hooks see the clean message too", async () => {
  const azureKey = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [{ id: "az", name: "Az", provider: "azure_openai", endpoint: "https://r.openai.azure.com", apiKey: azureKey, chatModels: [{ id: "1", name: "dep", capabilities: ["default"] }] }] });
  const ends = [];
  const error = await createFetchAi(cfg, { fetch: async () => new Response(JSON.stringify({ error: { message: `Access denied due to invalid subscription key ${azureKey}` } }), { status: 401 }), onAttemptEnd: (end) => ends.push(end) }).complete(ASK).then(() => null, (failure) => failure);
  assert.equal(error.message.includes(azureKey), false);
  assert.equal(ends[0].error.includes(azureKey), false);
  assert.match(ends[0].error, /\[redacted\]/);
});

test("the key never reaches state.json, activity.json or the events of a run that failed because of it", async () => {
  const host = { fetch: async () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}`, type: "invalid_request_error", code: "invalid_api_key" } }), { status: 401 }) };
  const { state, events: emitted, store } = await runOver(host, keyed());
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /Incorrect API key/);
  assert.equal(JSON.stringify(state).includes("0123456789ABCDEF"), false);
  assert.equal(store.files.get("autopilot/state.json").includes("0123456789ABCDEF"), false);
  assert.equal(store.files.get("autopilot/activity.json").includes("0123456789ABCDEF"), false);
  assert.equal(JSON.stringify(emitted).includes("0123456789ABCDEF"), false);
  assert.ok(emitted.some((event) => event.type === "run-ended"));
});

test("errors from any other AI port are cleaned of the usual credential shapes before they are saved", async () => {
  const ai = scripted((request) => request.label === "autopilot:concept" ? new AiProviderError("HTTP 401 — Bearer sk-abcdefghijklmnop12345 was rejected; api-key: 0123456789abcdef; https://x.test/v1?key=secret999", 401, false) : undefined);
  const { state, events: emitted, store } = await runWith(ai);
  assert.equal(state.status, "error");
  for (const secret of ["abcdefghijklmnop12345", "0123456789abcdef", "secret999"]) {
    assert.equal(JSON.stringify(state).includes(secret), false, secret);
    assert.equal(store.files.get("autopilot/activity.json").includes(secret), false, secret);
    assert.equal(JSON.stringify(emitted).includes(secret), false, secret);
  }
  assert.match(state.lastError.message, /\[redacted\]/);
});
