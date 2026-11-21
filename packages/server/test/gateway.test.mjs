import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { bridgeToApi } from "../dist/testing.mjs";
import { until } from "./helpers.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function shutdown(...servers) {
  return Promise.all(servers.map((server) => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
}

/**
 * A stand-in for the API behind the gateway: `onRequest(request, response, record)` is the whole behaviour, and `record`
 * says what the stand-in saw (the headers it received, the body, whether its connection closed early).
 */
async function withGateway(onRequest, run, { idleMs, port } = {}) {
  const seen = { requests: [], closed: 0 };
  const upstream = http.createServer((request, response) => {
    const record = { headers: request.headers, rawHeaders: request.rawHeaders, method: request.method, url: request.url, body: "", closed: false };
    seen.requests.push(record);
    response.on("close", () => {
      record.closed = true;
      seen.closed += 1;
    });
    request.on("data", (chunk) => {
      record.body += chunk;
    });
    onRequest(request, response, record);
  });
  const upstreamPort = await listen(upstream);
  const agent = new http.Agent({ keepAlive: false });
  const gateway = http.createServer((request, response) => bridgeToApi(request, response, { port: port ?? upstreamPort, host: "api.test:1234", ...(idleMs ? { idleMs } : {}) }, agent));
  const gatewayPort = await listen(gateway);
  try {
    await run({ gatewayPort, seen, upstream });
  } finally {
    agent.destroy();
    await shutdown(gateway, upstream);
  }
}

/** A request to the gateway; resolves with the head and the body, or with the error that ended it. */
function call(port, { method = "GET", path = "/api/v1/x", headers = {}, body, onResponse } = {}) {
  return new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (response) => {
      onResponse?.(response, request);
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8"), request }));
      response.on("error", (error) => resolve({ status: response.statusCode, error, request }));
      response.on("aborted", () => resolve({ status: response.statusCode, aborted: true, request }));
    });
    request.on("error", (error) => resolve({ error, request }));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test("gateway: the API sees end-to-end headers only, with its own Host, and still sees who is calling", async () => {
  await withGateway((request, response) => {
    response.writeHead(200, { "content-type": "application/json", "x-end-to-end": "yes", "proxy-authenticate": "Basic realm=x", te: "trailers", trailer: "x-sum", "keep-alive": "timeout=99" });
    response.end("{}");
  }, async ({ gatewayPort, seen }) => {
    const answer = await call(gatewayPort, {
      headers: {
        host: "admin.example.com",
        connection: "keep-alive, x-trace",
        "keep-alive": "timeout=5",
        te: "trailers",
        upgrade: "h2c",
        "proxy-authorization": "Basic Zm9vOmJhcg==",
        "proxy-connection": "keep-alive",
        "x-trace": "named in Connection: a hop header",
        authorization: "Bearer nrs_token",
        "cf-connecting-ip": "203.0.113.9",
        "x-custom": "end to end",
      },
    });
    assert.equal(answer.status, 200);
    const [received] = seen.requests;
    assert.equal(received.headers.authorization, "Bearer nrs_token");
    assert.equal(received.headers["cf-connecting-ip"], "203.0.113.9");
    assert.equal(received.headers["x-custom"], "end to end");
    assert.equal(received.headers.host, "api.test:1234", "the API is addressed by its own name");
    assert.equal(received.headers["x-narrarium-proxy"], "admin-gateway");
    for (const name of ["keep-alive", "te", "upgrade", "proxy-authorization", "proxy-connection", "x-trace"]) assert.equal(received.headers[name], undefined, `${name} is not forwarded`);
    assert.ok(!/x-trace/i.test(String(received.headers.connection ?? "")), "the Connection header the API sees is the gateway's own");

    assert.equal(answer.headers["x-end-to-end"], "yes");
    for (const name of ["proxy-authenticate", "te", "trailer"]) assert.equal(answer.headers[name], undefined, `${name} does not reach the browser`);
  });
});

test("gateway: naming cf-connecting-ip or authorization in Connection does not hide them from the API", async () => {
  await withGateway((request, response) => response.end("ok"), async ({ gatewayPort, seen }) => {
    await call(gatewayPort, { headers: { connection: "close, cf-connecting-ip, authorization", authorization: "Bearer t", "cf-connecting-ip": "198.51.100.1" } });
    assert.equal(seen.requests[0].headers.authorization, "Bearer t");
    assert.equal(seen.requests[0].headers["cf-connecting-ip"], "198.51.100.1");
  });
});

test("gateway: request bodies reach the API intact, with a length and chunked", async () => {
  await withGateway((request, response) => request.on("end", () => response.end("ok")), async ({ gatewayPort, seen }) => {
    const body = JSON.stringify({ title: "x".repeat(50_000) });
    assert.equal((await call(gatewayPort, { method: "PUT", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, body })).status, 200);
    assert.equal(seen.requests[0].body, body);
    const chunked = await new Promise((resolve) => {
      const request = http.request({ host: "127.0.0.1", port: gatewayPort, path: "/api/v1/x", method: "POST", agent: false, headers: { "transfer-encoding": "chunked", "content-type": "application/json" } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.write("{\"a\":");
      request.write("1}");
      request.end();
    });
    assert.equal(chunked, 200);
    assert.equal(seen.requests[1].body, "{\"a\":1}");
  });
});

test("gateway: when the browser leaves a live stream, the API request is closed at once (the slot it holds is released)", async () => {
  await withGateway((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("hello\n\n");
  }, async ({ gatewayPort, seen }) => {
    const opened = new Promise((resolve) => {
      call(gatewayPort, { path: "/api/v1/events", onResponse: (response, request) => response.once("data", () => resolve(request)) });
    });
    const request = await opened;
    assert.equal(seen.requests.length, 1);
    assert.equal(seen.requests[0].closed, false, "the stream is open on the API");
    request.destroy();
    await until(() => seen.requests[0].closed, 3_000);
  });
});

test("gateway: when the browser leaves before the API has answered, the API request is closed too", async () => {
  await withGateway(() => undefined, async ({ gatewayPort, seen }) => {
    const request = http.request({ host: "127.0.0.1", port: gatewayPort, path: "/api/v1/slow", agent: false });
    request.on("error", () => undefined);
    request.end();
    await until(() => seen.requests.length === 1, 3_000);
    assert.equal(seen.requests[0].closed, false);
    request.destroy();
    await until(() => seen.requests[0].closed, 3_000);
  });
});

test("gateway: when the browser leaves in the middle of an upload, the API request is closed", async () => {
  await withGateway(() => undefined, async ({ gatewayPort, seen }) => {
    const request = http.request({ host: "127.0.0.1", port: gatewayPort, path: "/api/v1/upload", method: "POST", agent: false, headers: { "content-length": "1000000" } });
    request.on("error", () => undefined);
    request.write("part of a body");
    await until(() => seen.requests.length === 1 && seen.requests[0].body.length > 0, 3_000);
    request.destroy();
    await until(() => seen.requests[0].closed, 3_000);
  });
});

test("gateway: when the API dies in the middle of an answer, the browser's connection is cut, not left waiting", async () => {
  await withGateway((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("one\n\n");
    setTimeout(() => request.socket.destroy(), 100);
  }, async ({ gatewayPort }) => {
    const answer = await call(gatewayPort, { path: "/api/v1/events" });
    assert.ok(answer.error || answer.aborted, "the browser sees the connection break");
  });
});

test("gateway: an API that cannot be reached is a 503 api_proxy answer", async () => {
  const closed = http.createServer();
  const deadPort = await listen(closed);
  await shutdown(closed);
  await withGateway(() => undefined, async ({ gatewayPort }) => {
    const answer = await call(gatewayPort);
    assert.equal(answer.status, 503);
    assert.equal(JSON.parse(answer.text).code, "api_proxy");
  }, { port: deadPort });
});

test("gateway: an API that goes quiet is given up after the idle time, with a 503", async () => {
  await withGateway(() => undefined, async ({ gatewayPort, seen }) => {
    const started = Date.now();
    const answer = await call(gatewayPort);
    assert.equal(answer.status, 503);
    assert.ok(Date.now() - started < 5_000);
    await until(() => seen.requests[0].closed, 3_000);
  }, { idleMs: 300 });
});
