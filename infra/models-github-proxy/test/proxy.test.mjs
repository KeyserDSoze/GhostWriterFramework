import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.js";
import { ALLOWED_ORIGIN, WORKER_URL, headersOf, useProviderStub } from "./helpers.mjs";

// Regression suite for the transparent CORS proxy: every non-/oauth/ path must keep
// behaving exactly as it did before the OAuth broker was added.

const TARGET = "https://models.github.ai";
const upstream = useProviderStub();

function proxyRequest(path, { method = "GET", headers = {}, body } = {}) {
  return new Request(`${WORKER_URL}${path}`, { method, headers, body });
}

function replyWith(body = "upstream-body", init = {}) {
  upstream.reply(() => new Response(body, init));
}

describe("transparent proxy: forwarding", () => {
  it("forwards path, query string, method and application headers to models.github.ai", async () => {
    replyWith(JSON.stringify([{ id: "model" }]), {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json", "X-Upstream": "kept" },
    });
    const response = await worker.fetch(
      proxyRequest("/catalog/models?limit=5&q=a%20b", {
        headers: {
          Authorization: "Bearer gh-token",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Origin: ALLOWED_ORIGIN,
        },
      }),
      {},
    );

    assert.equal(upstream.calls.length, 1);
    const [call] = upstream.calls;
    assert.equal(call.url, `${TARGET}/catalog/models?limit=5&q=a%20b`);
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.body, undefined);
    const headers = headersOf(call);
    assert.equal(headers.get("authorization"), "Bearer gh-token");
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    assert.equal(headers.get("x-github-api-version"), "2022-11-28");

    assert.equal(response.status, 200);
    assert.equal(response.statusText, "OK");
    assert.equal(response.headers.get("x-upstream"), "kept");
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(await response.text(), '[{"id":"model"}]');
  });

  it("streams the request body of POST, PUT, PATCH and DELETE and keeps the method", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      upstream.calls.length = 0;
      upstream.reply(async (call) => new Response(await new Response(call.init.body).text()));
      const response = await worker.fetch(
        proxyRequest("/inference/chat/completions", {
          method,
          headers: { "Content-Type": "application/json", Authorization: "Bearer gh-token" },
          body: JSON.stringify({ model: "openai/gpt-4.1", messages: [] }),
        }),
        {},
      );
      const [call] = upstream.calls;
      assert.equal(call.url, `${TARGET}/inference/chat/completions`);
      assert.equal(call.init.method, method);
      assert.equal(call.init.redirect, "manual");
      assert.equal(headersOf(call).get("content-type"), "application/json");
      assert.equal(await response.text(), '{"model":"openai/gpt-4.1","messages":[]}', `${method} body`);
    }
  });

  it("sends no body for GET and HEAD", async () => {
    for (const method of ["GET", "HEAD"]) {
      upstream.calls.length = 0;
      replyWith(null, { status: 200 });
      await worker.fetch(proxyRequest("/catalog/models", { method }), {});
      assert.equal(upstream.calls[0].init.method, method);
      assert.equal(upstream.calls[0].init.body, undefined);
    }
  });

  it("drops hop-by-hop headers and cookies and keeps every other header", async () => {
    replyWith("ok");
    await worker.fetch(
      proxyRequest("/inference/chat/completions", {
        method: "POST",
        body: "{}",
        headers: {
          Authorization: "Bearer gh-token",
          "Content-Type": "application/json",
          Origin: ALLOWED_ORIGIN,
          "X-Custom": "1",
          Cookie: "session=narrarium-cookie",
          Host: "attacker.example",
          Connection: "keep-alive",
          "Keep-Alive": "timeout=5",
          "Proxy-Authorization": "Basic abc",
          "Proxy-Authenticate": "Basic",
          TE: "trailers",
          Trailer: "Expires",
          "Transfer-Encoding": "chunked",
          Upgrade: "websocket",
        },
      }),
      {},
    );
    const names = [...headersOf(upstream.calls[0]).keys()].sort();
    assert.deepEqual(names, ["authorization", "content-type", "origin", "x-custom"]);
  });

  it("passes upstream errors and redirects through untouched", async () => {
    const cases = [
      { status: 404, statusText: "Not Found", headers: { "Content-Type": "application/json" }, body: '{"message":"nope"}' },
      { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "30" }, body: "slow down" },
      { status: 302, statusText: "Found", headers: { Location: "https://models.github.ai/elsewhere" }, body: null },
    ];
    for (const { body, ...init } of cases) {
      replyWith(body, init);
      const response = await worker.fetch(proxyRequest("/catalog/models"), {});
      assert.equal(response.status, init.status);
      assert.equal(response.statusText, init.statusText);
      for (const [name, value] of Object.entries(init.headers)) {
        assert.equal(response.headers.get(name), value);
      }
      assert.equal(await response.text(), body ?? "");
    }
  });

  it("works with the original one-argument signature and with an empty environment", async () => {
    replyWith("ok");
    const first = await worker.fetch(proxyRequest("/catalog/models"));
    const second = await worker.fetch(proxyRequest("/catalog/models"), {});
    assert.equal(await first.text(), "ok");
    assert.equal(await second.text(), "ok");
  });

  it("treats only the /oauth/ prefix as special", async () => {
    for (const path of ["/oauthx/foo", "/oauth.json", "/inference/oauth/token", "/foo/oauth/status", "/OAuth/status"]) {
      upstream.calls.length = 0;
      replyWith("proxied");
      const response = await worker.fetch(proxyRequest(path), {});
      assert.equal(upstream.calls.length, 1, path);
      assert.equal(upstream.calls[0].url, `${TARGET}${path}`);
      assert.equal(await response.text(), "proxied");
    }
  });
});

describe("transparent proxy: CORS", () => {
  it("adds the CORS headers for an allowed origin and replaces the upstream Vary", async () => {
    replyWith("ok", { headers: { Vary: "Accept-Encoding" } });
    const response = await worker.fetch(proxyRequest("/catalog/models", { headers: { Origin: ALLOWED_ORIGIN } }), {});
    assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.equal(response.headers.get("access-control-allow-methods"), "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD");
    assert.equal(response.headers.get("access-control-allow-headers"), "*");
    assert.equal(response.headers.get("access-control-expose-headers"), "*");
    assert.equal(response.headers.get("access-control-max-age"), "86400");
    assert.equal(response.headers.get("vary"), "Origin, Access-Control-Request-Headers");
  });

  it("reflects the requested headers", async () => {
    replyWith("ok");
    const response = await worker.fetch(
      proxyRequest("/catalog/models", {
        headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Headers": "authorization, content-type, x-github-api-version" },
      }),
      {},
    );
    assert.equal(response.headers.get("access-control-allow-headers"), "authorization, content-type, x-github-api-version");
  });

  it("serves callers without an Origin header and adds no CORS headers", async () => {
    replyWith("ok", { headers: { Vary: "Accept-Encoding" } });
    const response = await worker.fetch(proxyRequest("/catalog/models"), {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("access-control-allow-methods"), null);
    assert.equal(response.headers.get("vary"), "Accept-Encoding");
  });

  it("allows the production, www and local development origins", async () => {
    for (const origin of ["https://narrarium.net", "https://www.narrarium.net", "http://localhost:5173", "http://localhost:4173"]) {
      replyWith("ok");
      const response = await worker.fetch(proxyRequest("/catalog/models", { headers: { Origin: origin } }), {});
      assert.equal(response.status, 200, origin);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
    }
  });

  it("refuses any other origin with a plain-text 403 and never calls upstream", async () => {
    for (const origin of ["https://evil.example", "https://narrarium.net.evil.example", "http://narrarium.net", "null"]) {
      for (const method of ["GET", "POST", "OPTIONS"]) {
        replyWith("must not be reached");
        const response = await worker.fetch(proxyRequest("/catalog/models", { method, headers: { Origin: origin } }), {});
        assert.equal(response.status, 403, `${method} ${origin}`);
        assert.equal(await response.text(), "Forbidden origin");
        assert.equal(response.headers.get("access-control-allow-origin"), null);
      }
    }
    assert.equal(upstream.calls.length, 0);
  });

  it("answers a preflight from an allowed origin with 204 and CORS headers, without calling upstream", async () => {
    const response = await worker.fetch(
      proxyRequest("/inference/chat/completions", {
        method: "OPTIONS",
        headers: {
          Origin: ALLOWED_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      }),
      {},
    );
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.equal(response.headers.get("access-control-allow-methods"), "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD");
    assert.equal(response.headers.get("access-control-allow-headers"), "authorization,content-type");
    assert.equal(response.headers.get("access-control-max-age"), "86400");
    assert.equal(await response.text(), "");
    assert.equal(upstream.calls.length, 0);
  });

  it("refuses a preflight without an Origin header", async () => {
    const response = await worker.fetch(proxyRequest("/catalog/models", { method: "OPTIONS" }), {});
    assert.equal(response.status, 403);
    assert.equal(await response.text(), "Forbidden origin");
    assert.equal(upstream.calls.length, 0);
  });

  it("lets ALLOWED_ORIGINS_EXTRA add origins to the proxy as well, without removing the defaults", async () => {
    const env = { ALLOWED_ORIGINS_EXTRA: "https://example.github.io" };
    replyWith("ok");
    const extra = await worker.fetch(proxyRequest("/catalog/models", { headers: { Origin: "https://example.github.io" } }), env);
    assert.equal(extra.headers.get("access-control-allow-origin"), "https://example.github.io");
    replyWith("ok");
    const builtIn = await worker.fetch(proxyRequest("/catalog/models", { headers: { Origin: ALLOWED_ORIGIN } }), env);
    assert.equal(builtIn.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    const refused = await worker.fetch(proxyRequest("/catalog/models", { headers: { Origin: "https://evil.example" } }), env);
    assert.equal(refused.status, 403);
  });
});
