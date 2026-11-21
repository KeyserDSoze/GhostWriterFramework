import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
// New exports are read through the namespace, so a missing one fails the test that needs it and nothing else.
import * as testing from "../dist/testing.mjs";

const { installOutboundNetwork } = testing;

/** A target that keeps what it was sent and answers by path: /redirect sends a 307, /redirect-301 a 301, anything else 200. */
async function target() {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: { ...request.headers }, rawHeaders: [...request.rawHeaders], body: Buffer.concat(chunks) });
      if (request.url.startsWith("/redirect")) {
        response.writeHead(request.url === "/redirect-301" ? 301 : 307, { location: "http://169.254.169.254/latest/meta-data", "content-type": "text/plain" });
        response.end("moved");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    seen,
    last: () => seen.at(-1),
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

async function withGuard(run) {
  const destination = await target();
  const original = globalThis.fetch;
  const restore = installOutboundNetwork(() => [`${destination.base}/v1`]);
  try {
    await run(destination);
  } finally {
    restore();
    await destination.close();
  }
  assert.equal(globalThis.fetch, original, "the real fetch is back");
}

// ---------------------------------------------------------------------------------------------
// C19: the guard keeps what a caller asked for
// ---------------------------------------------------------------------------------------------

test("C19: a Request object keeps its method, its headers and its body (the guard used to send a bare GET)", async () => {
  await withGuard(async (destination) => {
    const response = await fetch(new Request(`${destination.base}/v1/chat`, { method: "POST", headers: { authorization: "Bearer KEY", "x-a": "1", "content-type": "application/json" }, body: '{"a":1}' }));
    assert.equal(response.status, 200);
    const seen = destination.last();
    assert.equal(seen.method, "POST");
    assert.equal(seen.headers.authorization, "Bearer KEY");
    assert.equal(seen.headers["x-a"], "1");
    assert.equal(seen.body.toString(), '{"a":1}');
    assert.equal(seen.headers["content-length"], "7", "and it says how long the body is");
  });
});

test("C19: values in `init` take the place of those of the Request, as they do for the real fetch", async () => {
  await withGuard(async (destination) => {
    const request = new Request(`${destination.base}/v1/a`, { method: "POST", headers: { "x-from": "request", authorization: "Bearer one" }, body: "from the request" });
    await fetch(request, { method: "PUT", headers: { "x-from": "init" }, body: "from init" });
    const first = destination.last();
    assert.equal(first.method, "PUT");
    assert.equal(first.headers["x-from"], "init");
    assert.equal(first.headers.authorization, undefined, "init.headers replaces the Request's headers as a whole");
    assert.equal(first.body.toString(), "from init");
    await fetch(new Request(`${destination.base}/v1/b`, { method: "POST", body: "kept" }), { headers: { "x-only": "init" } });
    assert.equal(destination.last().body.toString(), "kept", "a body that init does not replace is kept");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => fetch(new Request(`${destination.base}/v1/c`, { signal: controller.signal })), (error) => error.name === "AbortError", "the Request's own signal is honoured");
  });
});

test("C19: redirect: \"manual\" hands the redirect to the caller, who can read where it points; it is never followed", async () => {
  await withGuard(async (destination) => {
    for (const path of ["/redirect", "/redirect-301"]) {
      const response = await fetch(`${destination.base}${path}`, { redirect: "manual" });
      assert.equal(response.status, path === "/redirect" ? 307 : 301);
      assert.equal(response.headers.get("location"), "http://169.254.169.254/latest/meta-data");
      assert.equal(await response.text(), "moved");
    }
    const viaRequest = await fetch(new Request(`${destination.base}/redirect`, { redirect: "manual" }));
    assert.equal(viaRequest.status, 307, "a Request's own redirect mode counts");
    assert.equal(destination.seen.length, 3, "only the three requests that were made: nothing followed the Location header");
    // The default (follow) and "error" still refuse: the guard never follows, whatever the caller said.
    await assert.rejects(() => fetch(`${destination.base}/redirect`), (error) => error.code === "redirect");
    await assert.rejects(() => fetch(`${destination.base}/redirect`, { redirect: "follow" }), (error) => error.code === "redirect");
    await assert.rejects(() => fetch(`${destination.base}/redirect`, { redirect: "error" }), (error) => error.code === "redirect");
    assert.equal(destination.seen.length, 6);
  });
});

test("C19: a Host header (or a length or framing header) of the caller never reaches the destination", async () => {
  await withGuard(async (destination) => {
    await fetch(`${destination.base}/v1/h`, { method: "POST", headers: { host: "evil.example", Host: "evil.example", "content-length": "1", "transfer-encoding": "chunked", connection: "upgrade", upgrade: "websocket", "x-ok": "yes" }, body: "hello" });
    const seen = destination.last();
    assert.equal(seen.headers.host, `127.0.0.1:${destination.port}`, "the host of the approved address");
    assert.equal(seen.rawHeaders.filter((value) => value.toLowerCase() === "host").length, 1);
    assert.equal(seen.headers["content-length"], "5", "the length of the body that was sent");
    assert.equal(seen.headers["transfer-encoding"], undefined);
    assert.equal(seen.headers.upgrade, undefined);
    assert.equal(seen.headers["x-ok"], "yes", "ordinary headers pass");
    assert.equal(seen.body.toString(), "hello");
  });
});

test("C19: the bodies a real fetch accepts are sent as they are, and the ones the guard cannot buffer are refused", async () => {
  await withGuard(async (destination) => {
    const send = (body, headers = {}) => fetch(`${destination.base}/v1/b`, { method: "POST", headers, body });
    await send("text");
    assert.equal(destination.last().body.toString(), "text");
    await send(new Uint8Array([65, 66]));
    assert.equal(destination.last().body.toString(), "AB");
    await send(new TextEncoder().encode("CDE").buffer);
    assert.equal(destination.last().body.toString(), "CDE", "an ArrayBuffer");
    await send(new DataView(new TextEncoder().encode("xFGHx").buffer, 1, 3));
    assert.equal(destination.last().body.toString(), "FGH", "a view over part of a buffer");
    await send(new URLSearchParams({ a: "1", b: "x y" }));
    assert.equal(destination.last().body.toString(), "a=1&b=x+y");
    assert.match(destination.last().headers["content-type"], /^application\/x-www-form-urlencoded/);
    await send(new Blob(["blob!"], { type: "text/plain" }));
    assert.equal(destination.last().body.toString(), "blob!");
    assert.equal(destination.last().headers["content-type"], "text/plain");
    await send(new Blob(["x"], { type: "application/json" }), { "content-type": "application/vnd.test+json" });
    assert.equal(destination.last().headers["content-type"], "application/vnd.test+json", "a header of the caller wins");
    await send("");
    assert.equal(destination.last().body.length, 0);
    for (const body of [new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } }), new FormData()]) {
      await assert.rejects(() => fetch(`${destination.base}/v1/b`, { method: "POST", body, duplex: "half" }), (error) => error.code === "unsupported_body");
    }
    await assert.rejects(() => fetch(`${destination.base}/v1/b`, { method: "GET", body: "no body for a GET" }), TypeError);
  });
});

test("C19: nothing else changed: the destination is still approved by origin, and an unapproved one is refused before anything is sent", async () => {
  await withGuard(async (destination) => {
    await assert.rejects(() => fetch(`http://127.0.0.1:${destination.port + 1}/v1`), (error) => error.code === "not_approved");
    await assert.rejects(() => fetch(new Request("https://example.com/")), (error) => error.code === "not_approved");
    await assert.rejects(() => fetch(`http://user:pass@127.0.0.1:${destination.port}/v1`), (error) => error.code === "not_approved");
    assert.equal(destination.seen.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// C19: every verified address is offered to the connection, not just the first
// ---------------------------------------------------------------------------------------------

test("C19: pinnedLookup offers all the verified addresses (or the first, or one family), so a dead first address does not end the request", () => {
  const addresses = [{ address: "2606:4700::6810:84e5", family: 6 }, { address: "104.16.132.229", family: 4 }, { address: "104.16.133.229", family: 4 }];
  const lookup = testing.pinnedLookup(addresses);
  const answer = (options) => new Promise((resolve, reject) => {
    const callback = (error, address, family) => (error ? reject(error) : resolve({ address, family }));
    if (options === undefined) lookup("host", callback);
    else lookup("host", options, callback);
  });
  return Promise.all([
    answer({ all: true }),
    answer({}),
    answer(undefined),
    answer({ family: 4 }),
    answer({ family: 6 }),
    answer({ family: "IPv4", all: true }),
    answer({ family: 0, all: true }),
  ]).then(([all, first, bare, four, six, nameFour, zero]) => {
    assert.deepEqual(all.address, addresses, "all of them, in the resolver's order");
    assert.deepEqual(first, { address: "2606:4700::6810:84e5", family: 6 });
    assert.deepEqual(bare, first);
    assert.deepEqual(four, { address: "104.16.132.229", family: 4 });
    assert.deepEqual(six, { address: "2606:4700::6810:84e5", family: 6 });
    assert.deepEqual(nameFour.address, addresses.slice(1));
    assert.deepEqual(zero.address, addresses);
    const only4 = testing.pinnedLookup([{ address: "104.16.132.229", family: 4 }]);
    return new Promise((resolve) => only4("host", { family: 6 }, (error) => resolve(error))).then((error) => {
      assert.equal(error.code, "ENOTFOUND", "a family that none of the addresses has is not served");
    });
  });
});

test("C19: a host name is resolved once, and one private address among several makes the whole answer unusable", async () => {
  const lookups = [];
  const answers = {
    "public.example": [{ address: "104.16.132.229", family: 4 }, { address: "2606:4700::6810:84e5", family: 6 }],
    "mixed.example": [{ address: "104.16.132.229", family: 4 }, { address: "10.0.0.5", family: 4 }],
    "private.example": [{ address: "192.168.1.20", family: 4 }],
    "empty.example": [],
  };
  const restore = installOutboundNetwork(() => Object.keys(answers).map((name) => `https://${name}`), {
    resolve: async (hostname) => {
      lookups.push(hostname);
      return answers[hostname];
    },
  });
  try {
    for (const name of ["mixed.example", "private.example", "empty.example"]) {
      await assert.rejects(() => fetch(`https://${name}/v1`), (error) => error.code === "private_address", name);
    }
    assert.deepEqual(lookups, ["mixed.example", "private.example", "empty.example"], "one resolution per request, through the resolver that was given");
  } finally {
    restore();
  }
});

test("C19: an approved local model that listens only on the IPv6 loopback is reachable (localhost is both loopbacks, [::1] is one)", async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("v6");
  });
  const listening = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "::1", () => resolve(true));
  });
  if (!listening) {
    await new Promise((resolve) => server.close(resolve));
    return t.skip("this system has no IPv6 loopback");
  }
  const port = server.address().port;
  const restore = installOutboundNetwork(() => [`http://localhost:${port}`, `http://[::1]:${port}`]);
  try {
    assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), "v6", "localhost: 127.0.0.1 is refused, ::1 answers");
    assert.equal(await (await fetch(`http://[::1]:${port}/`)).text(), "v6", "[::1] itself");
  } finally {
    restore();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

test("C19: a connection refused by every address is one clear connection error, and the destination is named without its path", async () => {
  const closed = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const restore = installOutboundNetwork(() => [`http://127.0.0.1:${closed}`]);
  try {
    await assert.rejects(() => fetch(`http://127.0.0.1:${closed}/v1/secret-path?key=sk-x`), (error) => error.code === "connection" && !error.message.includes("secret-path") && !error.message.includes("sk-x"));
  } finally {
    restore();
  }
});
