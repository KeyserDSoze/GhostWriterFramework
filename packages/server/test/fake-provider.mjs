import http from "node:http";
import { createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import { until } from "./helpers.mjs";

/** The seed book of every test that runs the autopilot through a provider. */
export const seedChanges = () => Object.entries(seedBookFiles()).map(([file, content]) => ({ path: file, content }));

/** A short book that the autopilot writes in one run, and a brief that does not stop after the plan. */
export const ONE_CHAPTER = { brief: { idea: "A harbor of glass", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } };

/**
 * A stand-in for an OpenAI-compatible provider on 127.0.0.1. It answers what the autopilot asks (through the engine's own fake AI) and
 * reports `usage` the way a real provider does, so that what the server counts is known exactly: every call is `usage` tokens (100 in,
 * 50 out) unless the test says otherwise. `requests` keeps what arrived (path, headers, body); `respond(number, body)` (it may be async,
 * to hold a request) may answer a request itself (`{ status, body }`) or ask for a reply that is cut by the output limit (`"truncate"`,
 * billed as the tokens it used).
 */
export async function fakeProvider({ usage = { prompt_tokens: 100, completion_tokens: 50 }, respond, words } = {}) {
  const fake = createFakeAutopilotAi({ words });
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
    requests.push({ url: request.url, method: request.method, headers: { ...request.headers }, body });
    const decided = await respond?.(requests.length, body);
    if (decided && typeof decided === "object") {
      response.writeHead(decided.status, { "content-type": "application/json" });
      response.end(JSON.stringify(decided.body ?? {}));
      return;
    }
    const tool = body.tools?.[0]?.function;
    const reply = await fake.complete({
      capability: "autopilot",
      label: "http",
      system: body.messages?.[0]?.content ?? "",
      user: body.messages?.[1]?.content ?? "",
      ...(tool ? { json: tool } : {}),
      ...(body.stream ? { onText: () => undefined } : {}),
    });
    const truncated = decided === "truncate";
    const finish = truncated ? "length" : tool ? "tool_calls" : "stop";
    if (body.stream && !tool) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const half = Math.floor(reply.text.length / 2);
      const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
      response.write(frame({ choices: [{ index: 0, delta: { content: reply.text.slice(0, half) } }] }));
      response.write(frame({ choices: [{ index: 0, delta: { content: reply.text.slice(half) } }] }));
      response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }));
      response.end("data: [DONE]\n\n");
      return;
    }
    const message = tool
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool.name, arguments: JSON.stringify(reply.json) } }] }
      : { role: "assistant", content: reply.text };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "chatcmpl-test", object: "chat.completion", choices: [{ index: 0, finish_reason: finish, message }], usage }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    /** The origin: what an owner of the old versions approved. */
    origin: `http://127.0.0.1:${port}`,
    /** The base an integration is given (`endpoint`). */
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/** The AI configuration a client sends for `provider`: one OpenAI-compatible integration, a secret key, a model that may carry a price. */
export function aiConfigFor(provider, { apiKey = "sk-test-key-0123456789", pricing, extra = {} } = {}) {
  return {
    aiIntegrations: [{
      id: "p",
      name: "Local provider",
      provider: "openai",
      endpoint: provider.url,
      apiKey,
      chatModels: [{ id: "m", name: "gpt-test", capabilities: ["default"], ...(pricing ? { pricing } : {}) }],
    }],
    costCurrency: "USD",
    ...extra,
  };
}

/** Register a local book that holds the seed files, ready for the autopilot. */
export async function seededBook(client, bookId = "b") {
  await client.registerBook(bookId, { title: "Glass", storage: { kind: "local" } });
  await client.commitFiles(bookId, seedChanges(), "seed");
  return bookId;
}

/** Approve a base (an origin, or an origin and a path) the way the owner does in the panel. */
export async function approve(admin, ...bases) {
  const answer = await admin.call("POST", "/admin/api/ai/approve", { bases });
  if (answer.status !== 200) throw new Error(`approving ${bases.join(", ")} failed: ${answer.status} ${JSON.stringify(answer.body)}`);
}

/** Wait until the book's autopilot is not running, and answer its snapshot. */
export async function finished(client, bookId, timeoutMs = 30_000) {
  await until(async () => !(await client.autopilot(bookId)).running, timeoutMs);
  return client.autopilot(bookId);
}
