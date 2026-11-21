import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { seedBookFiles } from "narrarium-engine/testing";
import { until, withServer } from "./helpers.mjs";

/** An AI that never answers by itself: it only ends when the request it was given is cancelled. */
function hangingAi() {
  const seen = { started: false, aborted: false };
  return {
    seen,
    ai: {
      complete: (request) => new Promise((_resolve, reject) => {
        seen.started = true;
        const abort = () => {
          seen.aborted = true;
          reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
        };
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener("abort", abort, { once: true });
      }),
    },
  };
}

test("asking the director stops its AI request when the caller goes away: a question that runs for minutes costs money", async () => {
  const { ai, seen } = hangingAi();
  await withServer(async (server) => {
    const { token } = await server.auth.issue("runner", ["read", "write", "run"]);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const call = (method, route, body) => fetch(`${server.url}${route}`, { method, headers, body: JSON.stringify(body) });
    assert.equal((await call("PUT", "/api/v1/books/b", { title: "B", storage: { kind: "local" } })).status, 200);
    const changes = Object.entries(seedBookFiles()).map(([file, content]) => ({ path: file, content }));
    assert.equal((await call("POST", "/api/v1/books/b/files/commit", { changes, message: "seed" })).status, 200);

    const target = new URL(`${server.url}/api/v1/books/b/director/ask`);
    const request = http.request({ host: target.hostname, port: target.port, path: target.pathname, method: "POST", headers }, () => undefined);
    request.on("error", () => undefined);
    request.end(JSON.stringify({ target: { kind: "book" }, question: "Does it hold together?" }));

    await until(() => seen.started, 10_000);
    assert.equal(seen.aborted, false, "the question is running");
    request.destroy();
    await until(() => seen.aborted, 5_000);
    assert.equal(seen.aborted, true, "the AI request was cancelled as soon as the caller left");
  }, { ai });
});
