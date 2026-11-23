// A fake of LlmProxy's streaming endpoint, for tests: a real HTTP server (so `fetch` really streams over a real connection) that says what LlmProxy
// says. Read from its source (src/LlmProxy.Api/OpenAi/OpenAiEndpoints.cs, OpenAiResponseObservation.cs, Security/InferenceCorsMiddleware.cs, and the
// documentation docs/inference-runtime.md, docs/capacity-control.md), nothing from its configuration, keys or data:
//
//  - It is a pass-through. The body of a stream is the byte stream of the runtime behind it (vLLM, llama.cpp), copied as it arrives and flushed at
//    every read: `data: {chat.completion.chunk}\n\n` ... a chunk with `choices: []` and `usage` when the caller asked for `stream_options.include_usage`,
//    `data: [DONE]\n\n`. It adds no keep-alive comment, no event of its own, no `[DONE]` of its own and never an `error` event.
//  - When the runtime stops sending for `Gateway:UpstreamIdleTimeoutSeconds` (5 minutes unless changed), when its connection breaks, or when the capacity
//    lease is lost, after the first byte went out, it cannot send an error body any more: `context.Abort()`, the connection is reset (no `[DONE]`, no last
//    chunk), and the request is recorded as `upstream_stream_interrupted` / `capacity_lease_lost`.
//  - Before the first byte it answers JSON: `{ "error": { "message", "type", "code" } }` with 400, 401, 403, 413, 429 (+ `Retry-After`: `rate_limit_exceeded`,
//    `token_budget_exceeded`), 499, 502, 503 (+ `Retry-After`), 504.
//  - Its headers: `Cache-Control: no-cache`, `X-Accel-Buffering: no`, `X-LlmProxy-Request-Id`, the content headers of the runtime, chunked transfer; and, for a
//    browser (an `Origin` header), `Access-Control-Allow-Origin`, `Vary: Origin`, `Access-Control-Expose-Headers: X-LlmProxy-Request-Id, X-LlmProxy-Trace-Id, Retry-After`.
//  - Every request header of the caller goes on to the runtime but the credentials and the framing ones (`Authorization`, `Cookie`, `Host`, `Content-Length`,
//    `Content-Type`, `Content-Encoding`, ...): `Accept`, `Accept-Encoding`, `Origin`, `Referer`, `User-Agent` reach it.
//  - An output-token budget (a policy of the caller's key) caps `max_tokens` / `max_completion_tokens` and puts `max_tokens` in a request that has none; the
//    caller is only told by `finish_reason: "length"`.
//
// A scenario is addressed by the path of the base address: `http://127.0.0.1:<port>/<scenario>/v1`.
import http from "node:http";
import zlib from "node:zlib";

export const ID = "chatcmpl-9f3c1a7e2b5d4c68";
export const MODEL = "muse-glimmer-30b";
export const CREATED = 1763250000;

/** A `chat.completion.chunk` as vLLM writes it. */
export function chunk(choice, extra = {}) {
  return { id: ID, object: "chat.completion.chunk", created: CREATED, model: MODEL, choices: choice === undefined ? [] : [{ index: 0, ...choice }], ...extra };
}
export const role = () => chunk({ delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null });
export const text = (value) => chunk({ delta: { content: value }, logprobs: null, finish_reason: null });
export const thought = (value, field = "reasoning_content") => chunk({ delta: { [field]: value }, logprobs: null, finish_reason: null });
export const stop = (reason = "stop") => chunk({ delta: { content: "" }, logprobs: null, finish_reason: reason, stop_reason: null });
/** The usage chunk of `stream_options.include_usage`: no choice, the counts. */
export const counts = (prompt, completion, extra = {}) => chunk(undefined, { usage: { prompt_tokens: prompt, total_tokens: prompt + completion, completion_tokens: completion, ...extra } });
export const toolStart = (name, args = "") => chunk({ delta: { role: "assistant", content: null, tool_calls: [{ id: "chatcmpl-tool-7d1e", type: "function", index: 0, function: { name, arguments: args } }] }, logprobs: null, finish_reason: null });
export const toolArgs = (args) => chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, logprobs: null, finish_reason: null });

export const line = (value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
export const DONE = "data: [DONE]\n\n";

/** The error that a runtime writes into the stream when its own work fails after the first byte. */
export const runtimeError = (message, code = 500, type = "InternalServerError") => ({ error: { object: "error", message, type, param: null, code } });
/** The JSON error of LlmProxy itself, before the first byte. */
export const proxyError = (message, type, code) => JSON.stringify({ error: { message, type, code } });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What a scenario can do with the connection. `emit` writes events (objects, or text as it is), `send` writes raw bytes at once, `reset` breaks the
 * connection the way `context.Abort()` does, `end` closes it properly. Waits end with the connection.
 */
function connection(request, response, body, options, nth = 1) {
  const state = { head: false, bytes: 0, writes: 0, closed: false };
  /** The waits that are going on: the connection ending ends them all (one listener, however many waits there are). */
  const waiting = new Set();
  response.on("close", () => {
    state.closed = true;
    for (const stop of [...waiting]) stop();
  });
  const wait = (ms) => new Promise((resolve) => {
    if (state.closed) return resolve();
    const stop = () => {
      clearTimeout(timer);
      waiting.delete(stop);
      resolve();
    };
    const timer = setTimeout(stop, ms);
    waiting.add(stop);
  });
  const origin = request.headers.origin;
  const head = (extra = {}, status = 200) => {
    if (state.head) return;
    state.head = true;
    response.writeHead(status, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      "x-llmproxy-request-id": "0b7f0a52-6f0e-4a9e-9d57-7e8b3c0d7a11",
      ...(origin ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-expose-headers": "X-LlmProxy-Request-Id, X-LlmProxy-Trace-Id, Retry-After" } : {}),
      ...extra,
    });
    // vLLM sends the headers of a stream at once, before its first token: so does LlmProxy (`StartAsync`).
    response.flushHeaders();
  };
  const write = (data) => {
    if (state.closed) return false;
    head();
    state.bytes += Buffer.byteLength(data);
    state.writes += 1;
    return response.write(data);
  };
  return {
    request,
    response,
    body,
    state,
    options,
    /** Which request of its scenario this is, from 1: a scenario may fail the first ones and work after them. */
    nth,
    wait,
    head,
    /** Events, written one by one; a number is a wait in milliseconds. */
    async emit(...items) {
      for (const item of items) {
        if (state.closed) return;
        if (typeof item === "number") await wait(item);
        else write(typeof item === "string" && item.startsWith("data:") ? item : line(item));
      }
    },
    /** Bytes as they are: strings and buffers, a number is a wait. */
    async send(...items) {
      for (const item of items) {
        if (state.closed) return;
        if (typeof item === "number") await wait(item);
        else write(item);
      }
    },
    end: () => {
      head();
      if (!state.closed) response.end();
    },
    /** `context.Abort()`: the connection is reset, with no last chunk. */
    reset: () => {
      head();
      response.socket?.resetAndDestroy?.() ?? response.socket?.destroy();
    },
    /** A plain close of the socket without the end of the chunked body (what a killed process does). */
    drop: () => {
      head();
      response.socket?.destroy();
    },
    /** A JSON answer, as LlmProxy gives before the first byte. */
    json(status, payload, extra = {}) {
      state.head = true;
      // The CORS middleware of LlmProxy answers for its own errors too (it is what lets a browser read a 429 and its `Retry-After`).
      const cors = origin ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-expose-headers": "X-LlmProxy-Request-Id, X-LlmProxy-Trace-Id, Retry-After" } : {};
      response.writeHead(status, { "content-type": "application/json", "x-llmproxy-request-id": "0b7f0a52-6f0e-4a9e-9d57-7e8b3c0d7a11", ...cors, ...extra });
      response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    },
  };
}

/** Some words with accents, an emoji and a character of the supplementary planes: the multi-byte characters that a chunk boundary may cut. */
export const WORDS = ["Il ", "gabbiano ", "è ", "già ", "volato ", "via — ", "你好 ", "世界 ", "😀 ", "𝄞 ", "fine."];
export const WORDS_TEXT = WORDS.join("");

/** Every scenario: a name, what it is, and the script. */
export const SCENARIOS = {
  // ── What a healthy LlmProxy stream looks like ──────────────────────────────
  plain: async (c) => c.emit(role(), ...WORDS.map(text), stop(), counts(120, 44), DONE),
  "no-finish-reason": async (c) => c.emit(role(), ...WORDS.map(text), counts(120, 44), DONE),
  "usage-in-finish-chunk": async (c) => c.emit(role(), ...WORDS.map(text), chunk({ delta: {}, finish_reason: "stop" }, { usage: { prompt_tokens: 120, completion_tokens: 44, total_tokens: 164 }, timings: { predicted_n: 44 } }), DONE),
  "usage-null-everywhere": async (c) => c.emit(...[role(), ...WORDS.map(text), stop()].map((item) => ({ ...item, usage: null })), counts(120, 44), DONE),
  "usage-cached": async (c) => c.emit(role(), ...WORDS.map(text), stop(), counts(120, 44, { prompt_tokens_details: { cached_tokens: 100 } }), DONE),
  "usage-responses-names": async (c) => c.emit(role(), ...WORDS.map(text), stop(), chunk(undefined, { usage: { input_tokens: 120, output_tokens: 44, total_tokens: 164 } }), DONE),
  "usage-zero": async (c) => c.emit(role(), ...WORDS.map(text), stop(), counts(0, 0), DONE),
  "content-null": async (c) => c.emit(chunk({ delta: { role: "assistant", content: null } }), ...WORDS.flatMap((word) => [text(word), chunk({ delta: { content: null } })]), chunk({ delta: {} }), stop(), counts(5, 5), DONE),
  "reasoning-content": async (c) => c.emit(role(), thought("Pensiamo "), thought("un momento."), ...WORDS.map(text), stop(), counts(120, 80), DONE),
  "reasoning-field": async (c) => c.emit(role(), thought("Pensiamo ", "reasoning"), thought("un momento.", "reasoning"), ...WORDS.map(text), stop(), counts(120, 80), DONE),
  /** A runtime that is moving from `reasoning_content` to `reasoning` and sends the same words under both names. */
  "reasoning-both-names": async (c) => c.emit(role(), chunk({ delta: { reasoning_content: "Pensiamo ", reasoning: "Pensiamo " }, logprobs: null, finish_reason: null }), chunk({ delta: { reasoning_content: "un momento.", reasoning: "un momento." }, logprobs: null, finish_reason: null }), ...WORDS.map(text), stop(), DONE),
  "reasoning-only-length": async (c) => c.emit(role(), thought("Pensiamo "), thought("a lungo."), stop("length"), counts(120, 4096), DONE),
  "output-capped": async (c) => c.emit(role(), ...WORDS.map(text), stop("length"), counts(120, 8192), DONE),
  "empty-reply": async (c) => c.emit(role(), stop(), counts(120, 0), DONE),
  "long-reasoning": async (c) => c.emit(role(), ...Array.from({ length: 9000 }, (_, at) => thought(` pensiero ${at}`)), ...WORDS.map(text), stop(), counts(120, 9100), DONE),
  "tool-call": async (c) => c.emit(toolStart("result"), toolArgs('{"ok":'), toolArgs("true,"), toolArgs('"note":"Il gabbiano è già volato via — 你好 😀"}'), stop("tool_calls"), counts(120, 30), DONE),
  "tool-call-whole-first": async (c) => c.emit(toolStart("result", '{"ok":true,"note":"x"}'), stop("tool_calls"), counts(120, 30), DONE),
  "json-despite-stream": async (c) => c.json(200, { id: ID, object: "chat.completion", created: CREATED, model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: WORDS_TEXT }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 44, total_tokens: 164 } }),

  // ── How the lines come ─────────────────────────────────────────────────────
  crlf: async (c) => c.send(...[role(), ...WORDS.map(text), stop(), counts(120, 44)].map((item) => `data: ${JSON.stringify(item)}\r\n\r\n`), "data: [DONE]\r\n\r\n"),
  "cr-only": async (c) => c.send(...[role(), ...WORDS.map(text), stop(), counts(120, 44)].map((item) => `data: ${JSON.stringify(item)}\r\r`), "data: [DONE]\r\r"),
  "no-space": async (c) => c.send(...[role(), ...WORDS.map(text), stop(), counts(120, 44)].map((item) => `data:${JSON.stringify(item)}\n\n`), "data:[DONE]\n\n"),
  "no-blank-lines": async (c) => c.send(...[role(), ...WORDS.map(text), stop(), counts(120, 44)].map((item) => `data: ${JSON.stringify(item)}\n`), "data: [DONE]\n"),
  "last-line-without-newline": async (c) => c.send(...[role(), ...WORDS.map(text), stop(), counts(120, 44)].map(line), "data: [DONE]"),
  "comments": async (c) => c.send(": ping - 2026-11-23 16:00:00\n\n", line(role()), ": keep-alive\n\n", ...WORDS.map(text).flatMap((item, at) => (at % 3 === 0 ? [": ping\n\n", line(item)] : [line(item)])), line(stop()), line(counts(120, 44)), ": last\n\n", DONE),
  "comments-crlf": async (c) => c.send(": ping\r\n\r\n", ...[role(), ...WORDS.map(text), stop(), counts(120, 44)].flatMap((item) => [`data: ${JSON.stringify(item)}\r\n\r\n`, ": ping\r\n\r\n"]), "data: [DONE]\r\n\r\n"),
  "event-names": async (c) => c.send(...[role(), ...WORDS.map(text), stop(), counts(120, 44)].map((item) => `event: message\nid: 7\ndata: ${JSON.stringify(item)}\n\n`), "data: [DONE]\n\n"),
  "one-byte-chunks": async (c) => {
    const bytes = Buffer.from([role(), ...WORDS.map(text), stop(), counts(120, 44)].map(line).join("") + DONE);
    for (let at = 0; at < bytes.length; at += 1) await c.send(bytes.subarray(at, at + 1));
    c.end();
  },
  "awkward-chunks": async (c) => {
    // Cuts inside a multi-byte character, inside `data:`, between the two newlines and inside the JSON, in the order of the wire.
    const bytes = Buffer.from([role(), ...WORDS.map(text), stop(), counts(120, 44)].map(line).join("") + DONE);
    const cuts = new Set();
    for (const word of ["gabbiano", "你", "😀", "𝄞", "data: [DONE]", "prompt_tokens"]) {
      const at = bytes.indexOf(Buffer.from(word));
      if (at > 0) for (const offset of [1, 2, 3]) cuts.add(at + offset);
    }
    for (let at = 0; at < bytes.length; at += 1) if (bytes[at] === 0x0a && bytes[at + 1] === 0x0a) cuts.add(at + 1);
    const ordered = [...cuts].sort((a, b) => a - b);
    let from = 0;
    for (const cut of ordered) {
      await c.send(bytes.subarray(from, cut), 1);
      from = cut;
    }
    await c.send(bytes.subarray(from));
    c.end();
  },
  gzip: async (c) => {
    c.head({ "content-encoding": "gzip" });
    const gzip = zlib.createGzip();
    gzip.on("data", (piece) => c.state.closed || c.response.write(piece));
    for (const item of [role(), ...WORDS.map(text), stop(), counts(120, 44)].map(line).concat(DONE)) {
      gzip.write(item);
      gzip.flush();
      await c.wait(5);
    }
    gzip.end();
    await new Promise((resolve) => gzip.on("end", resolve));
    c.end();
  },

  // ── Time ───────────────────────────────────────────────────────────────────
  /** Tokens that come slowly and steadily (`options.gap` ms apart, a hundred of them): longer than any short idle limit, never silent for that long. */
  "slow-steady": async (c) => {
    await c.emit(role());
    for (let at = 0; at < 12; at += 1) await c.emit(WORDS.length ? text(WORDS[at % WORDS.length]) : text("x"), c.options.gap ?? 100);
    await c.emit(stop(), counts(120, 12), DONE);
    c.end();
  },
  /** A long prefill: nothing for a while, then the stream begins (the headers are out, as vLLM sends them at once). */
  "late-first-token": async (c) => {
    c.head();
    await c.wait(c.options.silence ?? 400);
    await c.emit(role(), ...WORDS.map(text), stop(), counts(120, 44), DONE);
    c.end();
  },
  /** A silence in the middle of the answer, shorter than the idle limit of the test, and then the rest. */
  "pause-in-the-middle": async (c) => {
    await c.emit(role(), text("Prima parte. "), c.options.silence ?? 300, text("Seconda parte."), stop(), counts(120, 44), DONE);
    c.end();
  },
  /** The runtime goes quiet and stays quiet with the connection open (a stuck node: LlmProxy would reset it after 5 minutes). */
  "dead-silence": async (c) => {
    await c.emit(role(), text("Il gabbiano "), text("è già volato "));
    await c.wait(60_000);
  },
  "dead-silence-before-first-token": async (c) => {
    c.head();
    await c.wait(60_000);
  },
  /** Nothing but comments for longer than the idle limit of the test, a hundred milliseconds apart, and then the answer: the connection is alive, the model is just slow. */
  "keep-alive-comments": async (c) => {
    c.head();
    for (let at = 0; at < 12; at += 1) await c.send(": ping\n\n", c.options.gap ?? 100);
    await c.emit(role(), ...WORDS.map(text), stop(), counts(120, 44), DONE);
    c.end();
  },

  // ── A runtime or a gateway that does not take `stream_options` ─────────────
  /** Refuses the request that carries `stream_options` (400, as an older Azure OpenAI or a strict gateway does), and streams the one that does not, with no usage chunk. */
  "refuses-usage-option": async (c) => {
    if (c.body && "stream_options" in c.body) {
      c.json(400, { error: { message: "Unrecognized request argument supplied: stream_options", type: "invalid_request_error", param: "stream_options", code: null } });
      return;
    }
    await c.emit(role(), ...WORDS.map(text), stop(), DONE);
    c.end();
  },
  /** Asks for the usage and says it does not do it (a runtime that ignores `stream_options`): the answer arrives, with no usage chunk. */
  "ignores-usage-option": async (c) => {
    await c.emit(role(), ...WORDS.map(text), stop(), DONE);
    c.end();
  },

  // ── A node that fails and then recovers ────────────────────────────────────
  /** The first two requests are cut after a few words (the connection is reset), the next ones are answered. */
  "reset-twice-then-ok": async (c) => {
    if (c.nth <= 2) {
      await c.emit(role(), ...WORDS.slice(0, 4).map(text), 60);
      c.reset();
      return;
    }
    await c.emit(role(), ...WORDS.map(text), stop(), counts(120, 44), DONE);
    c.end();
  },

  // ── Secrets must never come out of a diagnostic ────────────────────────────
  /** A model that repeats the key it was called with (a prompt that held it), far enough from the end that a window of the stream cuts it: then the connection breaks. */
  "echo-key": async (c) => {
    const key = String(c.request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    await c.emit(role(), text(`The key is ${key} and `), text("x".repeat(200)), text(` ${key}`), text("y".repeat(40)), 60);
    c.reset();
  },

  // ── What goes wrong after the first byte ───────────────────────────────────
  "error-event": async (c) => c.emit(role(), text("Il gabbiano "), text("è già volato "), runtimeError("CUDA error: an illegal memory access was encountered"), DONE),
  "error-event-no-done": async (c) => {
    await c.emit(role(), text("Il gabbiano "), runtimeError("Internal server error"));
    c.end();
  },
  "error-event-string": async (c) => c.emit(role(), text("Il gabbiano "), { error: "model overloaded, try again" }, DONE),
  "error-event-overloaded": async (c) => c.emit(role(), text("Il gabbiano "), runtimeError("The server is overloaded, please try again later", 503, "ServiceUnavailableError"), DONE),
  "error-event-bad-request": async (c) => c.emit(role(), runtimeError("This model's maximum context length is 131072 tokens", 400, "BadRequestError"), DONE),
  /** The same failure after the model began to write: a runtime that reports an invalid request in the middle of a stream (vLLM does, for an exception of its generator). */
  "error-event-bad-request-late": async (c) => c.emit(role(), text("Il gabbiano "), runtimeError("This model's maximum context length is 131072 tokens", 400, "BadRequestError"), DONE),
  "error-event-named": async (c) => c.send(line(role()), line(text("Il gabbiano ")), 'event: error\ndata: {"message":"The model crashed","code":"internal_error"}\n\n', DONE),
  "error-event-in-choice": async (c) => c.emit(role(), text("Il gabbiano "), chunk({ delta: {}, finish_reason: "error" }), DONE),
  "finish-abort": async (c) => c.emit(role(), text("Il gabbiano "), chunk({ delta: {}, finish_reason: "abort" }), counts(120, 3), DONE),
  "finish-content-filter": async (c) => c.emit(role(), text("Il gabbiano "), stop("content_filter"), counts(120, 3), DONE),
  "finish-unknown": async (c) => c.emit(role(), ...WORDS.map(text), stop("weird_reason"), counts(120, 44)),
  "eof-after-finish-no-done": async (c) => {
    await c.emit(role(), ...WORDS.map(text), stop(), counts(120, 44));
    c.end();
  },
  "eof-after-finish-before-usage": async (c) => {
    await c.emit(role(), ...WORDS.map(text), stop());
    c.end();
  },
  "eof-mid-answer": async (c) => {
    await c.emit(role(), ...WORDS.slice(0, 4).map(text));
    c.end();
  },
  "eof-mid-event": async (c) => {
    await c.emit(role(), ...WORDS.slice(0, 4).map(text));
    await c.send(`data: {"id":"${ID}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"tagl`);
    c.end();
  },
  "reset-mid-answer": async (c) => {
    await c.emit(role(), ...WORDS.slice(0, 4).map(text), 60);
    c.reset();
  },
  "reset-mid-event": async (c) => {
    await c.emit(role(), ...WORDS.slice(0, 4).map(text));
    await c.send(`data: {"id":"${ID}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"tagl`, 60);
    c.reset();
  },
  "reset-after-headers": async (c) => {
    c.head();
    await c.wait(60);
    c.reset();
  },
  "drop-mid-answer": async (c) => {
    await c.emit(role(), ...WORDS.slice(0, 4).map(text), 60);
    c.drop();
  },
  "reset-after-reasoning": async (c) => {
    await c.emit(role(), ...Array.from({ length: 200 }, (_, at) => thought(` pensiero ${at}`)), 60);
    c.reset();
  },
  "reset-mid-tool-call": async (c) => {
    await c.emit(toolStart("result"), toolArgs('{"ok":'), toolArgs("true,"), 60);
    c.reset();
  },
  /** A structured reply that is cut once and then answered whole: the first request is cut after two pieces of its arguments, the next ones are answered. */
  "tool-call-cut-then-ok": async (c) => {
    if (c.nth <= 1) {
      await c.emit(toolStart("result"), toolArgs('{"ok":'), toolArgs("true,"), 60);
      c.reset();
      return;
    }
    await c.emit(toolStart("result"), toolArgs('{"ok":true,"note":"Il gabbiano è già volato via — 你好 😀"}'), stop("tool_calls"), counts(120, 30), DONE);
    c.end();
  },

  // ── What LlmProxy answers before the first byte ────────────────────────────
  "rate-limited": async (c) => c.json(429, proxyError("Request rate limit exceeded for model 'muse'. Retry after 7 seconds.", "rate_limit_error", "rate_limit_exceeded"), { "retry-after": "7" }),
  "token-budget": async (c) => c.json(429, proxyError("Output-token budget exceeded for model 'muse'. Retry after 3600 seconds.", "rate_limit_error", "token_budget_exceeded"), { "retry-after": "3600" }),
  "capacity-exhausted": async (c) => c.json(503, proxyError("All deployments of model 'muse' are at capacity. Retry shortly.", "gateway_unavailable", "capacity_exhausted"), { "retry-after": "2" }),
  "model-not-running": async (c) => c.json(503, proxyError("The model 'muse' is not running.", "gateway_unavailable", "model_not_running")),
  "lease-lost-before-bytes": async (c) => c.json(503, proxyError("Distributed inference capacity lease safety was lost while the request was running. Retry shortly.", "gateway_unavailable", "capacity_lease_lost"), { "retry-after": "1" }),
  "upstream-unreachable": async (c) => c.json(502, proxyError("The inference runtime for model 'muse' could not be reached. Retry shortly.", "gateway_error", "upstream_unreachable")),
  "upstream-timeout": async (c) => c.json(504, proxyError("The inference runtime for model 'muse' did not answer in time. Retry shortly.", "gateway_error", "upstream_timeout")),
  "stream-interrupted-before-bytes": async (c) => c.json(502, proxyError("The inference response for model 'muse' was interrupted. Retry shortly.", "gateway_error", "upstream_stream_interrupted")),
  "bad-output-limit": async (c) => c.json(400, proxyError("'max_tokens' must be a positive integer when an output-token budget applies.", "invalid_request_error", "invalid_output_token_limit")),
  "unsupported-n": async (c) => c.json(400, proxyError("'n' greater than 1 is not supported when an output-token budget applies.", "invalid_request_error", "unsupported_n")),
  "too-large": async (c) => c.json(413, proxyError("The request body is larger than the 16777216 bytes this gateway accepts. Send a shorter conversation.", "invalid_request_error", "request_too_large")),
  "bad-key": async (c) => c.json(401, proxyError("The supplied API key is invalid, revoked or expired.", "authentication_error", "invalid_api_key")),
  "origin-not-allowed": async (c) => c.json(403, proxyError("This API key is not allowed to be used from this browser origin.", "invalid_request_error", "origin_not_allowed")),
  /** A page of Cloudflare's own edge, which the origin's CORS headers never reach: a browser cannot read it, and sees a failed fetch. */
  "cloudflare-524": async (c) => {
    c.state.head = true;
    c.response.writeHead(524, { "content-type": "text/html; charset=UTF-8" });
    c.response.end("<!DOCTYPE html><html><head><title>llm.example.com | 524: A timeout occurred</title></head><body><h1>A timeout occurred</h1></body></html>");
  },
};

/** Starts the fake. `requests` keeps what each call carried (headers and body) and `connections` how many sockets were opened. */
export async function startFakeLlmProxy(options = {}) {
  const requests = [];
  const open = new Set();
  let connections = 0;
  const server = http.createServer((request, response) => {
    const parts = [];
    request.on("data", (part) => parts.push(part));
    request.on("end", async () => {
      const raw = Buffer.concat(parts).toString("utf8");
      const url = new URL(request.url, "http://x");
      const match = /^\/([^/]+)\/v1\/chat\/completions$/.exec(url.pathname);
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "access-control-allow-origin": request.headers.origin ?? "*", vary: "Origin", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": request.headers["access-control-request-headers"] ?? "authorization, content-type", "access-control-max-age": "600" });
        response.end();
        return;
      }
      if (!match || request.method !== "POST") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(proxyError("Not found", "invalid_request_error", "not_found"));
        return;
      }
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = undefined;
      }
      const entry = { scenario: match[1], headers: request.headers, body, raw };
      requests.push(entry);
      const script = SCENARIOS[match[1]];
      if (!script) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(proxyError(`No scenario ${match[1]}`, "invalid_request_error", "not_found"));
        return;
      }
      const c = connection(request, response, body, options, requests.filter((other) => other.scenario === match[1]).length);
      entry.closed = new Promise((resolve) => response.on("close", resolve));
      try {
        await script(c);
        if (!c.state.closed && !response.writableEnded && !(match[1].startsWith("dead-silence"))) c.end();
      } catch (error) {
        if (!c.state.closed) response.destroy(error);
      }
    });
  });
  server.on("connection", (socket) => {
    connections += 1;
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await new Promise((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    base: (scenario) => `http://127.0.0.1:${port}/${scenario}/v1`,
    requests,
    get connections() {
      return connections;
    },
    async close() {
      for (const socket of open) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
