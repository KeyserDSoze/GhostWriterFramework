// Shared fakes of the transport tests (deadlines, streaming, configuration): server-sent events served by a fake `fetch`,
// a stream that the test feeds by hand, and the small tools to follow a call that is still going.

export const encoder = new TextEncoder();

export const data = (value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
export const DONE = "data: [DONE]\n\n";
/** An SSE comment: what a proxy sends to keep a connection open. It carries no event. */
export const COMMENT = ": keep-alive\n\n";
export const content = (text) => data({ choices: [{ delta: { content: text } }] });
export const reasoning = (text) => data({ choices: [{ delta: { reasoning_content: text } }] });
export const finish = (reason) => data({ choices: [{ delta: {}, finish_reason: reason }] });
export const usage = (prompt, completion) => data({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } });

/** A fragment of a function call: the first one names the function, the next ones carry more of the arguments. `index: undefined` leaves the index out. */
export function call(args, options = {}) {
  const index = "index" in options ? options.index : 0;
  return data({
    choices: [{
      delta: {
        tool_calls: [{
          ...(index === undefined ? {} : { index }),
          ...(options.name ? { id: options.id ?? "call_1", type: "function" } : {}),
          function: { ...(options.name ? { name: options.name } : {}), arguments: args },
        }],
      },
    }],
  });
}

export const SCHEMA = { name: "result", description: "A result", parameters: { type: "object", properties: { ok: { type: "boolean" }, note: { type: "string" } }, required: ["ok"] } };
export const ASK = { capability: "autopilot", label: "t", system: "SYS", user: "USR" };
export const JSON_ASK = { ...ASK, json: SCHEMA };

/** The integration of the owner's case: a slow ~30B model behind a proxy called "LlmProxy". A literal configuration is not picked, so tiny timeouts survive. */
export const integration = (extra = {}) => ({ id: "p", name: "LlmProxy", provider: "openai", endpoint: "http://llm.test/v1", apiKey: "sk-test-SECRET-0123456789", chatModels: [{ id: "m", name: "muse-glimmer-30b", capabilities: ["default"] }], ...extra });
export const configOf = (extra = {}, more = {}) => ({ aiIntegrations: [integration(extra)], ...more });

/** A body that the test feeds chunk by chunk. `state.cancels` counts how often the reader released it. */
export function live() {
  const state = { cancels: 0 };
  let controller;
  let closed = false;
  const body = new ReadableStream({
    start(source) {
      controller = source;
    },
    cancel() {
      state.cancels += 1;
      closed = true;
    },
  });
  return {
    body,
    state,
    send(...chunks) {
      for (const chunk of chunks) if (!closed) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
    end() {
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
    fail(error) {
      if (!closed) {
        closed = true;
        controller.error(error);
      }
    },
  };
}

export const eventStream = (body) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
export const jsonStream = (body) => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

/** A whole stream that is already complete: the chunks are delivered and the body closes. */
export function sse(chunks) {
  return eventStream(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

/** What a real `fetch` does when its signal aborts: the body that is being read fails. */
export function failWith(stream, signal) {
  signal?.addEventListener("abort", () => stream.fail(signal.reason), { once: true });
}

/** A `fetch` that never answers but honours its signal, like the real one. */
export const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
/** A `fetch` that never answers and ignores its signal: only the client's own race can end the wait. */
export const forever = () => new Promise(() => undefined);

/** A fetch that records what was sent and answers with `handler(call, number)`. */
export function recording(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    const entry = { url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(entry);
    return handler(entry, calls.length);
  };
  return { fetch, calls };
}

/** Let everything that can run without a timer run: a few turns of the event loop. */
export async function settle() {
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Follow a promise without awaiting it. */
export function track(promise) {
  const box = { done: false, value: undefined, error: undefined };
  promise.then((value) => {
    box.done = true;
    box.value = value;
  }, (error) => {
    box.done = true;
    box.error = error;
  });
  return box;
}

/** The timers set (and not yet fired or cleared) while it is in place: nothing may be left after a call. */
export function trackTimers() {
  const pending = new Set();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay, ...rest) => {
    const handle = realSet(() => {
      pending.delete(handle);
      callback(...rest);
    }, delay);
    pending.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    pending.delete(handle);
    realClear(handle);
  };
  return {
    pending,
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
