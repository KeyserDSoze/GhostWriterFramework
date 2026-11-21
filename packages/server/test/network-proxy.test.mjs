import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
// New exports are read through the namespace, so a missing one fails the test that needs it and nothing else.
import * as testing from "../dist/testing.mjs";
import { until } from "./helpers.mjs";
import { selfSignedCertificate } from "./tls-helpers.mjs";

const { installOutboundNetwork } = testing;
const ORIGIN = "https://api.approved.test";
const publicAddresses = async () => [{ address: "93.184.216.34", family: 4 }];

/** An HTTPS server on this computer that stands for `hostname`: the certificate it shows is valid for that name only. */
async function tlsTarget(hostname = "api.approved.test") {
  const credentials = selfSignedCertificate(hostname);
  const seen = [];
  const server = https.createServer(credentials, (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: { ...request.headers }, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, host: request.headers.host }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    ca: credentials.cert,
    seen,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/**
 * A forward proxy that knows CONNECT. It keeps what it is asked, and connects every tunnel to `targetPort` on this computer
 * (whatever host was asked for), unless it is told to refuse (`status`), to ask for credentials (`requireAuth`) or to say nothing (`hold`).
 */
async function fakeProxy({ targetPort, status = 200, requireAuth, hold = false, behave } = {}) {
  let target = targetPort;
  const connects = [];
  const plain = [];
  const crossed = [];
  const open = new Set();
  const server = http.createServer((request, response) => {
    plain.push(`${request.method} ${request.url}`);
    response.writeHead(400);
    response.end();
  });
  server.on("connect", (request, socket, head) => {
    connects.push({ url: request.url, headers: { ...request.headers } });
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("end", () => socket.end());
    socket.on("error", () => undefined);
    if (hold) {
      socket.resume();
      return;
    }
    if (behave) {
      behave(socket);
      return;
    }
    if (requireAuth && request.headers["proxy-authorization"] !== requireAuth) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"proxy\"\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (status !== 200) {
      socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const upstream = net.connect(target, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    socket.on("data", (chunk) => crossed.push(chunk));
    upstream.on("data", (chunk) => crossed.push(chunk));
    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    connects,
    plain,
    retarget: (port) => {
      target = port;
    },
    seenBytes: () => Buffer.concat(crossed).toString("latin1"),
    openTunnels: () => open.size,
    close: () => new Promise((resolve) => {
      for (const socket of open) socket.destroy();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/** The address of a port where nothing listens (a proxy that is not there). */
async function deadAddress() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

async function withProxy(options, run) {
  const target = await tlsTarget(options.hostname);
  const proxy = await fakeProxy({ targetPort: target.port, ...options.proxy });
  try {
    await run({ target, proxy });
  } finally {
    await proxy.close();
    await target.close();
  }
}

const guarded = (env, extra = {}) => installOutboundNetwork(() => [ORIGIN], { resolve: publicAddresses, env, ...extra });

// ---------------------------------------------------------------------------------------------
// R8: a proxy named by HTTPS_PROXY carries the guard's requests
// ---------------------------------------------------------------------------------------------

test("R8: with HTTPS_PROXY the guard asks the proxy for a tunnel to the approved origin and speaks TLS to the origin through it (the proxy sees only encrypted bytes)", async () => {
  await withProxy({}, async ({ target, proxy }) => {
    const restore = guarded({ HTTPS_PROXY: proxy.url }, { ca: target.ca });
    try {
      const response = await fetch(`${ORIGIN}/v1/chat?x=1`, { method: "POST", headers: { authorization: "Bearer SECRET-KEY", "content-type": "application/json" }, body: '{"model":"m"}' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, host: "api.approved.test" });
    } finally {
      restore();
    }
    assert.deepEqual(proxy.connects.map((entry) => entry.url), ["api.approved.test:443"]);
    assert.equal(proxy.connects[0].headers.host, "api.approved.test:443");
    assert.deepEqual(proxy.plain, []);
    assert.equal(target.seen.length, 1);
    const [seen] = target.seen;
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/v1/chat?x=1");
    assert.equal(seen.headers.authorization, "Bearer SECRET-KEY");
    assert.equal(seen.headers.host, "api.approved.test");
    assert.equal(seen.body, '{"model":"m"}');
    assert.ok(proxy.seenBytes().length > 200, "the traffic did cross the proxy");
    assert.equal(proxy.seenBytes().includes("SECRET-KEY"), false, "and the proxy could read none of it");
    assert.equal(proxy.seenBytes().includes("/v1/chat"), false);
  });
});

test("R8: the certificate of the origin is checked inside the tunnel, so a proxy cannot pass for the origin", async () => {
  const right = await tlsTarget("api.approved.test");
  const wrong = await tlsTarget("other.test");
  const proxy = await fakeProxy({ targetPort: right.port });
  const refused = (error) => error instanceof testing.OutboundNetworkError && error.code === "connection";
  try {
    // The certificate that belongs to the origin, and is trusted: it works.
    let restore = guarded({ HTTPS_PROXY: proxy.url }, { ca: [right.ca, wrong.ca] });
    try {
      const response = await fetch(`${ORIGIN}/v1/chat`);
      assert.equal(response.status, 200);
      await response.arrayBuffer();

      // The proxy connects the tunnel to a server whose certificate is trusted too, but belongs to another name: refused.
      proxy.retarget(wrong.port);
      await assert.rejects(fetch(`${ORIGIN}/v1/chat`), refused);
      assert.equal(wrong.seen.length, 0, "nothing was sent to it");
    } finally {
      restore();
    }
    // A certificate nobody trusts is refused as it is without a proxy.
    proxy.retarget(right.port);
    restore = guarded({ HTTPS_PROXY: proxy.url });
    try {
      await assert.rejects(fetch(`${ORIGIN}/v1/chat`), refused);
    } finally {
      restore();
    }
    assert.equal(right.seen.length, 1, "only the first request reached the origin");
  } finally {
    await proxy.close();
    await right.close();
    await wrong.close();
  }
});

test("R8: credentials in the proxy address go to the proxy only, in a header, and no error ever carries them", async () => {
  const user = "us er@corp";
  const password = "p:w/d";
  const header = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const address = (proxy, pass) => `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@127.0.0.1:${proxy.port}`;
  await withProxy({ proxy: { requireAuth: header } }, async ({ target, proxy }) => {
    let restore = guarded({ HTTPS_PROXY: address(proxy, password) }, { ca: target.ca });
    try {
      const response = await fetch(`${ORIGIN}/v1/chat`);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    } finally {
      restore();
    }
    assert.equal(proxy.connects[0].headers["proxy-authorization"], header);
    assert.equal(target.seen[0].headers["proxy-authorization"], undefined, "the origin never sees the proxy's credentials");

    // A wrong password: the proxy says 407, and the error says so without repeating what was sent.
    restore = guarded({ HTTPS_PROXY: address(proxy, "wrong:secret") }, { ca: target.ca });
    try {
      await assert.rejects(fetch(`${ORIGIN}/v1/chat`), (error) => {
        assert.ok(error instanceof testing.OutboundNetworkError);
        assert.equal(error.code, "connection");
        const everything = `${error.message} ${error.cause?.message ?? ""} ${error.stack}`;
        assert.match(error.message, /407/);
        for (const secret of ["wrong", "secret", encodeURIComponent("wrong:secret"), Buffer.from(`${user}:wrong:secret`).toString("base64"), "us er", encodeURIComponent(user)]) {
          assert.equal(everything.includes(secret), false, `${secret} must not appear`);
        }
        return true;
      });
    } finally {
      restore();
    }
  });
});

test("R8: a proxy that refuses the tunnel is one clear error with its status, and nothing is tried around it", async () => {
  await withProxy({ proxy: { status: 403 } }, async ({ target, proxy }) => {
    const restore = guarded({ HTTPS_PROXY: proxy.url }, { ca: target.ca });
    const started = Date.now();
    try {
      await assert.rejects(fetch(`${ORIGIN}/v1/chat`), (error) => {
        assert.ok(error instanceof testing.OutboundNetworkError);
        assert.equal(error.code, "connection");
        assert.match(error.message, /api\.approved\.test/);
        assert.match(error.message, /through the proxy/);
        assert.match(error.message, /403/);
        assert.equal(error.message.includes(String(proxy.port)), false, "the proxy's address is not repeated");
        return true;
      });
    } finally {
      restore();
    }
    assert.ok(Date.now() - started < 5_000, "no direct connection was attempted afterwards");
    assert.equal(proxy.connects.length, 1);
    assert.equal(target.seen.length, 0);
  });
});

test("R8: a proxy that is not there is one clear error, at once", async () => {
  const restore = guarded({ HTTPS_PROXY: await deadAddress() });
  const started = Date.now();
  try {
    await assert.rejects(fetch(`${ORIGIN}/v1/chat`), (error) => {
      assert.ok(error instanceof testing.OutboundNetworkError);
      assert.equal(error.code, "connection");
      assert.match(error.message, /through the proxy/);
      return true;
    });
  } finally {
    restore();
  }
  assert.ok(Date.now() - started < 5_000);
});

// ---------------------------------------------------------------------------------------------
// R8: what the guard checks, it still checks first
// ---------------------------------------------------------------------------------------------

test("R8: an origin that is not approved, a private address and a name that resolves to one never reach the proxy", async () => {
  await withProxy({}, async ({ target, proxy }) => {
    const resolveBy = { "rebinding.approved.test": [{ address: "10.0.0.7", family: 4 }], "mixed.approved.test": [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.9", family: 4 }] };
    const restore = installOutboundNetwork(
      () => [ORIGIN, "https://10.1.2.3", "https://rebinding.approved.test", "https://mixed.approved.test"],
      { resolve: async (name) => resolveBy[name] ?? publicAddresses(), env: { HTTPS_PROXY: proxy.url }, ca: target.ca },
    );
    try {
      await assert.rejects(fetch("https://not-approved.example/x"), (error) => error.code === "not_approved");
      await assert.rejects(fetch("https://10.1.2.3/x"), (error) => error.code === "private_address");
      await assert.rejects(fetch("https://rebinding.approved.test/x"), (error) => error.code === "private_address");
      await assert.rejects(fetch("https://mixed.approved.test/x"), (error) => error.code === "private_address");
    } finally {
      restore();
    }
    assert.deepEqual(proxy.connects, []);
    assert.deepEqual(proxy.plain, []);
  });
});

test("R8: a name this computer cannot resolve, or resolves too slowly, is left to the proxy, which resolves it", async () => {
  await withProxy({}, async ({ target, proxy }) => {
    const unresolvable = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND api.approved.test"), { code: "ENOTFOUND" });
    };
    let restore = guarded({ HTTPS_PROXY: proxy.url }, { ca: target.ca, resolve: unresolvable });
    try {
      const response = await fetch(`${ORIGIN}/v1/chat`);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    } finally {
      restore();
    }
    restore = guarded({ HTTPS_PROXY: proxy.url }, { ca: target.ca, resolve: () => new Promise(() => undefined), lookupTimeoutMs: 50 });
    try {
      const response = await fetch(`${ORIGIN}/v1/chat`);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    } finally {
      restore();
    }
    assert.equal(proxy.connects.length, 2);
  });
});

test("R8: an approved local model is never sent through a proxy, whatever the proxy variables say", async () => {
  const seen = [];
  const model = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("local model");
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const proxy = await fakeProxy({ targetPort: 1 });
  const base = `http://127.0.0.1:${model.address().port}`;
  const restore = installOutboundNetwork(() => [base], { env: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url, ALL_PROXY: proxy.url } });
  try {
    const response = await fetch(`${base}/v1/chat`);
    assert.equal(await response.text(), "local model");
  } finally {
    restore();
    await proxy.close();
    await new Promise((resolve) => {
      model.close(() => resolve());
      model.closeAllConnections();
    });
  }
  assert.deepEqual(seen, ["GET /v1/chat"]);
  assert.deepEqual(proxy.connects, []);
  assert.deepEqual(proxy.plain, []);
});

test("R8: the proxy is read from the process environment, at each request, when no environment is given", async () => {
  await withProxy({}, async ({ target, proxy }) => {
    const names = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    const restore = installOutboundNetwork(() => [ORIGIN], { resolve: publicAddresses, ca: target.ca });
    try {
      process.env.HTTPS_PROXY = proxy.url;
      const response = await fetch(`${ORIGIN}/v1/chat`);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      assert.equal(proxy.connects.length, 1);
    } finally {
      restore();
      for (const name of names) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// R8: when a proxy applies at all
// ---------------------------------------------------------------------------------------------

const applies = (url, env) => testing.proxyFor(new URL(url), env)?.host;

test("R8: HTTPS_PROXY is the variable that counts, in either case, and only an http proxy address can be used", () => {
  assert.equal(applies("https://api.approved.test/x", { HTTPS_PROXY: "http://proxy.corp:3128" }), "proxy.corp:3128");
  assert.equal(applies("https://api.approved.test/x", { https_proxy: "http://proxy.corp:3128" }), "proxy.corp:3128");
  assert.equal(applies("https://api.approved.test/x", { https_proxy: "http://lower:1", HTTPS_PROXY: "http://upper:2" }), "lower:1");
  assert.equal(applies("https://api.approved.test/x", { HTTPS_PROXY: "proxy.corp:3128" }), "proxy.corp:3128", "an address without a scheme is an http one, as curl takes it");
  assert.equal(applies("https://api.approved.test/x", { HTTPS_PROXY: "http://[::1]:3128" }), "[::1]:3128");
  assert.equal(applies("https://api.approved.test/x", { HTTPS_PROXY: " http://proxy.corp:3128 " }), "proxy.corp:3128");
  // Nothing is used that the guard cannot speak: the request then goes as it always did.
  assert.equal(applies("https://api.approved.test/x", {}), undefined);
  assert.equal(applies("https://api.approved.test/x", { HTTPS_PROXY: "" }), undefined);
  assert.equal(applies("https://api.approved.test/x", { HTTPS_PROXY: "   " }), undefined);
  assert.equal(applies("https://api.approved.test/x", { HTTP_PROXY: "http://proxy.corp:3128", http_proxy: "http://proxy.corp:3128" }), undefined, "HTTP_PROXY is for http destinations, and the guard has none to proxy");
  assert.equal(applies("https://api.approved.test/x", { HTTPS_PROXY: "socks5://proxy.corp:1080" }), undefined);
  assert.equal(applies("https://api.approved.test/x", { HTTPS_PROXY: "https://proxy.corp:443" }), undefined);
  assert.equal(applies("https://api.approved.test/x", { HTTPS_PROXY: "ftp://proxy.corp" }), undefined);
  assert.equal(applies("http://api.approved.test/x", { HTTPS_PROXY: "http://proxy.corp:3128" }), undefined);
});

test("R8: NO_PROXY keeps a destination off the proxy by host, by domain, by port and for all", () => {
  const through = (noProxy, url = "https://api.approved.test/x") => applies(url, { HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: noProxy }) === "proxy.corp:3128";
  assert.equal(through(""), true);
  assert.equal(through("other.test"), true);
  assert.equal(through("*"), false);
  assert.equal(through("api.approved.test"), false);
  assert.equal(through("API.Approved.TEST"), false);
  assert.equal(through("approved.test"), false, "a domain covers its hosts");
  assert.equal(through(".approved.test"), false);
  assert.equal(through("*.approved.test"), false);
  assert.equal(through("other.test, approved.test"), false);
  assert.equal(through("other.test approved.test"), false);
  assert.equal(through("proved.test"), true, "a domain is matched by whole labels");
  assert.equal(through("approved.test.evil"), true);
  assert.equal(through("test"), false);
  assert.equal(through("api.approved.test:443"), false);
  assert.equal(through("api.approved.test:8443"), true);
  assert.equal(through("api.approved.test:8443", "https://api.approved.test:8443/x"), false);
  assert.equal(through("10.0.0.1", "https://10.0.0.1/x"), false);
  assert.equal(applies("https://api.approved.test/x", { HTTPS_PROXY: "http://proxy.corp:3128", no_proxy: "approved.test" }), undefined, "in either case");
});

test("R8: this computer is never reached through a proxy", () => {
  const env = { HTTPS_PROXY: "http://proxy.corp:3128" };
  for (const url of ["https://localhost:8443/x", "https://127.0.0.1:8443/x", "https://[::1]:8443/x", "http://localhost:11434/x"]) assert.equal(applies(url, env), undefined, url);
});

// ---------------------------------------------------------------------------------------------
// R8: the tunnel's life
// ---------------------------------------------------------------------------------------------

test("R8: a proxy that misbehaves (answers 3xx, hangs up, resets, speaks garbage) ends in one clear error, and nothing is left to crash the process", async () => {
  const misbehaviours = {
    "a redirect": (socket) => socket.end("HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/\r\nContent-Length: 0\r\n\r\n"),
    "a hang-up after the tunnel was granted": (socket) => {
      socket.write("HTTP/1.1 200 OK\r\n\r\n");
      socket.end();
    },
    "a reset": (socket) => socket.destroy(),
    "no TLS after the tunnel was granted": (socket) => {
      socket.write("HTTP/1.1 200 OK\r\n\r\nthis is not TLS at all\r\n");
      setTimeout(() => socket.destroy(), 50);
    },
    "no HTTP at all": (socket) => {
      socket.write("hello\r\n\r\n");
      setTimeout(() => socket.destroy(), 50);
    },
  };
  const uncaught = [];
  const record = (error) => uncaught.push(error);
  process.on("uncaughtException", record);
  try {
    for (const [name, behave] of Object.entries(misbehaviours)) {
      const proxy = await fakeProxy({ behave });
      const restore = guarded({ HTTPS_PROXY: proxy.url });
      try {
        await assert.rejects(fetch(`${ORIGIN}/v1/chat`), (error) => error instanceof testing.OutboundNetworkError && error.code === "connection" && /through the proxy/.test(error.message), name);
      } finally {
        restore();
        await proxy.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    process.off("uncaughtException", record);
  }
  assert.deepEqual(uncaught, []);
});

test("R8: aborting while the tunnel is being made ends the request at once and closes the connection to the proxy", async () => {
  const proxy = await fakeProxy({ hold: true });
  const restore = guarded({ HTTPS_PROXY: proxy.url });
  try {
    const controller = new AbortController();
    const pending = fetch(`${ORIGIN}/v1/chat`, { signal: controller.signal });
    await until(() => proxy.connects.length === 1, 5_000);
    controller.abort();
    await assert.rejects(pending, (error) => error.name === "AbortError");
    await until(() => proxy.openTunnels() === 0, 5_000);
  } finally {
    restore();
    await proxy.close();
  }
});

test("R8: the tunnel is closed when the request is over", async () => {
  await withProxy({}, async ({ target, proxy }) => {
    const restore = guarded({ HTTPS_PROXY: proxy.url }, { ca: target.ca });
    try {
      const response = await fetch(`${ORIGIN}/v1/chat`);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      await until(() => proxy.openTunnels() === 0, 5_000);
    } finally {
      restore();
    }
  });
});
