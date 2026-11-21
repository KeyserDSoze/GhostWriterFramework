import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ENGINE_VERSION,
  ServerSentEventParser,
  createFetchAi,
  defaultDirector,
  directorPrompt,
  encodeServerSentEvent,
  normalizeServerUrl,
  parseDirector,
  parseJsonReply,
  parseMarkdown,
  pickAiRuntimeConfig,
  planFileSync,
  renderMarkdown,
  resolveAiCandidates,
  serializeDirector,
  syncBookStores,
  chapterReaderText,
  sha256Hex,
} from "../dist/index.js";
import { MemoryBookStore } from "../dist/testing/index.js";

test("engine version matches package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(ENGINE_VERSION, pkg.version);
});

test("parseJsonReply accepts fences and leading prose", () => {
  assert.deepEqual(parseJsonReply("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(parseJsonReply("Here it is: {\"a\": \"x } y\", \"b\": [1,2]} trailing"), { a: "x } y", b: [1, 2] });
  assert.throws(() => parseJsonReply("no json here"), /not valid JSON/);
});

test("markdown frontmatter round-trips and keeps unknown keys", () => {
  const raw = renderMarkdown({ type: "chapter", id: "chapter:001-a", number: 1, title: "A", custom: { x: 1 }, empty: "" }, "# A\n\nBody");
  const parsed = parseMarkdown(raw);
  assert.equal(parsed.frontmatter.title, "A");
  assert.deepEqual(parsed.frontmatter.custom, { x: 1 });
  assert.equal("empty" in parsed.frontmatter, false);
  assert.equal(parsed.body, "# A\n\nBody");
});

test("director profile defaults, parsing and serialization", () => {
  const italian = defaultDirector("it-IT");
  assert.equal(italian.language, "it");
  assert.equal(italian.autonomy, "ask-on-critical");
  const raw = serializeDirector({ ...italian, name: "Ada", strictness: 9, readerWeights: { "standard-critical": 3 }, redLines: ["Nessun lieto fine"] });
  const parsed = parseDirector(raw);
  assert.equal(parsed.name, "Ada");
  assert.equal(parsed.strictness, 9);
  assert.deepEqual(parsed.readerWeights, { "standard-critical": 3 });
  assert.deepEqual(parsed.redLines, ["Nessun lieto fine"]);
  assert.match(directorPrompt(parsed), /Red lines/);
  const clamped = parseDirector("---\nstrictness: 42\nautonomy: nonsense\nmax_review_rounds: 9\n---\n\nVision");
  assert.equal(clamped.strictness, 10);
  assert.equal(clamped.autonomy, "ask-on-critical");
  assert.equal(clamped.maxReviewRounds, 3);
  assert.equal(clamped.body, "Vision");
});

test("AI routing follows the web app rules", () => {
  const config = pickAiRuntimeConfig({
    aiIntegrations: [
      { id: "a", name: "A", provider: "openai", apiKey: "k", chatModels: [{ id: "m1", name: "gpt-a", capabilities: ["default"] }, { id: "m2", name: "gpt-dir", capabilities: ["director"] }] },
      { id: "b", name: "B", provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiKey: "k2", chatModels: [{ id: "m3", name: "gpt-b", capabilities: ["default", "review"] }] },
      { id: "c", name: "Copilot", provider: "m365_copilot", apiKey: "" },
    ],
    taskRouting: { review: { primary: { integrationId: "b", model: "gpt-b" }, fallbacks: [] } },
  });
  assert.deepEqual(resolveAiCandidates(config, "review").map((candidate) => candidate.model), ["gpt-b"]);
  assert.equal(resolveAiCandidates(config, "director")[0].model, "gpt-dir");
  assert.deepEqual(resolveAiCandidates(config, "autopilot").map((candidate) => candidate.model), ["gpt-a", "gpt-b"]);
  assert.equal(resolveAiCandidates(pickAiRuntimeConfig({}), "autopilot").length, 0);
});

function sse(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test("fetch client streams text, reads usage and falls back between candidates", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    if (requests.length === 1) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
    return new Response(sse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n",
      "\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"prompt_tokens_details\":{\"cached_tokens\":4}}}\n\ndata: [DONE]\n\n",
    ]), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const ai = createFetchAi(pickAiRuntimeConfig({
    costCurrency: "EUR",
    aiIntegrations: [
      { id: "a", name: "A", provider: "azure_openai", endpoint: "https://res.openai.azure.com/", apiKey: "key-a", apiVersion: "2024-10-21", chatModels: [{ id: "1", name: "dep-a", capabilities: ["default"], underlyingModel: "gpt-5-mini" }] },
      { id: "b", name: "B", provider: "openai", endpoint: "https://llm.example/v1", apiKey: "key-b", chatModels: [{ id: "2", name: "gpt-4o", capabilities: ["default"], pricing: { inputPerMTok: 1, cachedPerMTok: 0.5, outputPerMTok: 2 } }] },
    ],
  }), { fetch });
  const seen = [];
  const response = await ai.complete({ capability: "autopilot", label: "t", system: "s", user: "u", maxOutputTokens: 100, temperature: 0.5, onText: (text) => seen.push(text) });
  assert.equal(requests[0].url, "https://res.openai.azure.com/openai/deployments/dep-a/chat/completions?api-version=2024-10-21");
  assert.equal(requests[0].init.headers["api-key"], "key-a");
  assert.equal(requests[0].body.max_completion_tokens, 100);
  assert.equal("temperature" in requests[0].body, false);
  assert.equal(requests[1].url, "https://llm.example/v1/chat/completions");
  assert.equal(requests[1].init.headers.authorization, "Bearer key-b");
  assert.equal(requests[1].body.max_tokens, 100);
  assert.equal(requests[1].body.temperature, 0.5);
  assert.equal(response.text, "Hello");
  assert.deepEqual(seen.at(-1), "Hello");
  assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 });
  assert.equal(response.cost, (6 * 1 + 4 * 0.5 + 2 * 2) / 1_000_000);
  assert.equal(response.currency, "EUR");
});

test("fetch client forces a tool call and falls back to JSON text when tools are unsupported", async () => {
  const bodies = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.tools) return Response.json({ choices: [{ message: { tool_calls: [{ function: { arguments: "{\"ok\":true}" } }] } }] });
    return Response.json({ choices: [{ message: { content: "Sure: {\"ok\": false}" } }] });
  };
  const schema = { name: "result", description: "d", parameters: { type: "object", properties: { ok: { type: "boolean" } } } };
  const withTools = createFetchAi(pickAiRuntimeConfig({ aiIntegrations: [{ id: "a", name: "A", provider: "openai", apiKey: "", chatModels: [{ id: "1", name: "m", capabilities: ["default"] }] }] }), { fetch });
  assert.deepEqual((await withTools.complete({ capability: "director", label: "t", system: "s", user: "u", json: schema })).json, { ok: true });
  assert.equal(bodies[0].tool_choice.function.name, "result");
  const withoutTools = createFetchAi(pickAiRuntimeConfig({ aiIntegrations: [{ id: "a", name: "A", provider: "openai", apiKey: "", chatModels: [{ id: "1", name: "m", capabilities: ["default"], supportsToolCalls: false }] }] }), { fetch });
  assert.deepEqual((await withoutTools.complete({ capability: "director", label: "t", system: "s", user: "u", json: schema })).json, { ok: false });
  assert.match(bodies[1].messages[0].content, /Reply with ONLY one JSON object/);
});

test("three-way file sync plan detects uploads, downloads and conflicts", () => {
  const base = new Map([["a.md", "1"], ["b.md", "1"], ["c.md", "1"], ["d.md", "1"]]);
  const local = new Map([["a.md", "2"], ["b.md", "1"], ["c.md", "3"], ["new.md", "9"], ["img.png", "x"]]);
  const remote = new Map([["a.md", "1"], ["b.md", "5"], ["c.md", "4"], ["d.md", "1"]]);
  const plan = planFileSync(local, remote, base);
  assert.deepEqual(plan.upload, [{ path: "a.md", hash: "2" }, { path: "d.md", hash: null }, { path: "new.md", hash: "9" }]);
  assert.deepEqual(plan.download, [{ path: "b.md", hash: "5" }]);
  assert.deepEqual(plan.conflicts, ["c.md"]);
});

test("syncBookStores moves files both ways and returns the new base", async () => {
  const local = new MemoryBookStore({ "book.md": "local book", "chapters/001-a/chapter.md": "same" });
  const remote = new MemoryBookStore({ "chapters/001-a/chapter.md": "same", "autopilot/state.json": "{}" });
  const first = await syncBookStores({ local, remote, base: new Map() });
  assert.deepEqual(first.uploaded, ["book.md"]);
  assert.deepEqual(first.downloaded, ["autopilot/state.json"]);
  assert.equal(remote.files.get("book.md"), "local book");
  assert.equal(local.files.get("autopilot/state.json"), "{}");
  remote.write("book.md", "remote edit");
  local.write("chapters/001-a/chapter.md", "local edit");
  const second = await syncBookStores({ local, remote, base: first.base });
  assert.deepEqual(second.downloaded, ["book.md"]);
  assert.deepEqual(second.uploaded, ["chapters/001-a/chapter.md"]);
  assert.equal(local.files.get("book.md"), "remote edit");
  local.write("book.md", "mine");
  remote.write("book.md", "theirs");
  const third = await syncBookStores({ local, remote, base: second.base });
  assert.deepEqual(third.conflicts, ["book.md"]);
  const resolved = await syncBookStores({ local, remote, base: third.base, resolveConflict: () => "remote" });
  assert.equal(local.files.get("book.md"), "theirs");
  assert.equal(resolved.base.get("book.md"), await sha256Hex("theirs"));
});

test("server-sent events encode and parse in chunks", () => {
  const frames = encodeServerSentEvent({ event: "heartbeat", data: { at: "now" } }, 7) + encodeServerSentEvent({ event: "hello", data: { serverId: "s", at: "t" } });
  const received = [];
  const parser = new ServerSentEventParser((event, data) => received.push([event, JSON.parse(data)]));
  for (let index = 0; index < frames.length; index += 5) parser.push(frames.slice(index, index + 5));
  assert.deepEqual(received, [["heartbeat", { at: "now" }], ["hello", { serverId: "s", at: "t" }]]);
});

test("server URLs are normalized", () => {
  assert.equal(normalizeServerUrl("localhost:24242/"), "http://localhost:24242");
  assert.equal(normalizeServerUrl("my.tunnel.example"), "https://my.tunnel.example");
  assert.throws(() => normalizeServerUrl("ftp://x"), /http or https/);
});

test("chapter reader text matches the web app's reader target", () => {
  const text = chapterReaderText([{ title: "One", raw: "---\ntitle: One\n---\n\nFirst." }, { title: "Two", raw: "Second." }]);
  assert.equal(text, "## One\n\nFirst.\n\n## Two\n\nSecond.");
});
