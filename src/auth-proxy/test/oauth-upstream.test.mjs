import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OAUTH_ROUTES,
  assertError,
  installFakeTimers,
  jsonResponse,
  oauthCall,
  useProviderStub,
} from "./helpers.mjs";

const provider = useProviderStub();

const PROVIDER_ROUTES = OAUTH_ROUTES.filter((route) => route.upstream);
const TOKEN_ROUTES = PROVIDER_ROUTES.filter((route) => route.success === 200);
const UPSTREAM_TIMEOUT_MS = 10_000;

function streamOfSize(bytes, onPull = () => {}) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      onPull();
      const size = Math.min(1024, bytes - sent);
      if (size <= 0) {
        controller.close();
        return;
      }
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
}

for (const route of PROVIDER_ROUTES) {
  describe(`${route.label}: provider failures`, () => {
    const call = () => oauthCall(route.path, { json: route.request });

    it("answers 502 upstream_error when the provider fails, throttles or redirects", async () => {
      const failures = [
        ["a 500 response", () => new Response("Internal Server Error", { status: 500 })],
        ["a 503 HTML page", () => new Response("<html>down</html>", { status: 503, headers: { "Content-Type": "text/html" } })],
        ["a 429 response", () => jsonResponse(429, { error: "rate_limit_exceeded" })],
        ["a redirect", () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } })],
        ["a network error", () => Promise.reject(new TypeError("fetch failed: ECONNRESET"))],
      ];
      for (const [label, reply] of failures) {
        provider.reply(reply);
        const response = await call();
        assert.equal(response.status, 502, label);
        await assertError(response, 502, "upstream_error");
      }
      assert.equal(provider.calls.every((request) => request.init.redirect === "manual"), true);
    });

    it("answers 504 upstream_timeout when fetch reports an abort or a timeout", async () => {
      for (const name of ["AbortError", "TimeoutError"]) {
        provider.reply(() => Promise.reject(new DOMException("The operation timed out.", name)));
        const response = await call();
        await assertError(response, 504, "upstream_timeout");
      }
    });

    it("gives up after 10 seconds, aborts the request and answers 504", async (t) => {
      const clock = installFakeTimers(t);
      let signal;
      provider.reply((request) => {
        signal = request.init.signal;
        return new Promise(() => {});
      });
      const pending = call();
      await clock.fire(UPSTREAM_TIMEOUT_MS);
      await assertError(await pending, 504, "upstream_timeout");
      assert.ok(signal, "the request carries an AbortSignal");
      assert.equal(signal.aborted, true);
    });

    it("also bounds the time spent reading the provider's body", async (t) => {
      const clock = installFakeTimers(t);
      provider.reply(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"access_token":'));
              },
            }),
            { status: 200 },
          ),
      );
      const pending = call();
      await clock.fire(UPSTREAM_TIMEOUT_MS);
      await assertError(await pending, 504, "upstream_timeout");
    });

    it("arms a 10 second timer and clears it once the provider has answered", async (t) => {
      const clock = installFakeTimers(t);
      provider.reply(route.reply);
      const response = await call();
      assert.equal(response.status, route.success);
      const timers = clock.timers.filter((timer) => timer.delay === UPSTREAM_TIMEOUT_MS);
      assert.equal(timers.length, 1);
      assert.equal(timers[0].cleared, true);
    });

    it("refuses a response larger than the read limit, declared or streamed", async () => {
      provider.reply(() => new Response("{}", { status: 200, headers: { "Content-Length": String(70 * 1024) } }));
      await assertError(await call(), 502, "upstream_error");

      let pulls = 0;
      provider.reply(() => new Response(streamOfSize(10 * 1024 * 1024, () => (pulls += 1)), { status: 200 }));
      await assertError(await call(), 502, "upstream_error");
      assert.ok(pulls < 200, `read ${pulls} chunks of an oversized response`);
    });
  });
}

for (const route of TOKEN_ROUTES) {
  describe(`${route.label}: unexpected provider answers`, () => {
    const call = () => oauthCall(route.path, { json: route.request });

    it("answers 502 when a 200 response is not the expected token JSON", async () => {
      const bodies = [
        "<html>ok</html>",
        "",
        "null",
        "[]",
        '"access_token"',
        JSON.stringify({ expires_in: 3600 }),
        JSON.stringify({ access_token: "", expires_in: 3600 }),
        JSON.stringify({ access_token: 12345, expires_in: 3600 }),
        // GitHub reports errors in a 200 body: oauth-github.test.mjs covers how they are mapped.
        ...(route.label.startsWith("github") ? [] : [JSON.stringify({ error: "invalid_grant" })]),
      ];
      for (const body of bodies) {
        provider.reply(() => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
        const response = await call();
        assert.equal(response.status, 502, JSON.stringify(body));
        await assertError(response, 502, "upstream_error");
      }
    });

    it("answers 502 when expires_in is missing or unusable", async () => {
      for (const expiresIn of [undefined, null, 0, -5, "soon", "", true, [], {}]) {
        provider.reply(() => jsonResponse(200, { access_token: "ya29.token", refresh_token: "r", expires_in: expiresIn }));
        const response = await call();
        assert.equal(response.status, 502, `expires_in = ${JSON.stringify(expiresIn)}`);
      }
    });

    it("answers 502 for a 4xx without a recognisable OAuth error", async () => {
      for (const body of ["Bad Request", "", "{}", '{"error": {"nested": true}}', '{"error": 400}']) {
        provider.reply(() => new Response(body, { status: 400 }));
        const response = await call();
        await assertError(response, 502, "upstream_error");
      }
    });
  });
}

describe("provider response size", () => {
  it("accepts a large but reasonable token response", async () => {
    const accessToken = "a".repeat(20_000);
    provider.reply(() => jsonResponse(200, { access_token: accessToken, expires_in: 3599 }));
    const response = await oauthCall("/oauth/google/refresh", { json: { refreshToken: "r" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accessToken, accessToken);
  });
});
