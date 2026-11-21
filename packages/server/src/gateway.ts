import { request as httpRequest, type Agent, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { pipeline } from "node:stream";

/** Headers that belong to one connection, not to the message: a proxy never passes them on. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "expect"]);
/** Who is calling: never dropped, not even when a `Connection` header names them (that would hide the caller from the API). */
const ALWAYS_FORWARDED = new Set(["authorization", "cf-connecting-ip"]);

/** The end-to-end headers of a message, for the request to the API and for the answer back. */
export function forwardedHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const dropped = new Set(HOP_BY_HOP);
  for (const entry of String(headers.connection ?? "").split(",")) {
    const name = entry.trim().toLowerCase();
    if (name) dropped.add(name);
  }
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (!ALWAYS_FORWARDED.has(name) && (dropped.has(name) || name.startsWith("proxy-"))) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

export interface GatewayTarget {
  /** The API's port on loopback. */
  port: number;
  /** The `Host` the API must see (it only answers to its own names). */
  host: string;
  /** Silence on the API connection after which the request is given up. */
  idleMs?: number;
}

/**
 * Relay one request to the API and its answer back. Whichever side goes away first, the other is closed at once: a live
 * stream whose browser left must not keep its slot on the API, and an API that fails must not leave the browser waiting.
 */
export function bridgeToApi(request: IncomingMessage, response: ServerResponse, target: GatewayTarget, agent: Agent): void {
  const upstream = httpRequest({
    hostname: "127.0.0.1",
    port: target.port,
    path: request.url ?? "/",
    method: request.method,
    agent,
    headers: { ...forwardedHeaders(request.headers), host: target.host, "x-narrarium-proxy": "admin-gateway" },
  }, (upstreamResponse) => {
    if (response.destroyed) {
      upstreamResponse.destroy();
      return;
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, forwardedHeaders(upstreamResponse.headers));
    // A stream may stay quiet for a while: the browser must see its headers now.
    response.flushHeaders();
    pipeline(upstreamResponse, response, () => upstream.destroy());
  });
  upstream.on("error", () => {
    if (response.writableEnded || response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const body = JSON.stringify({ code: "api_proxy", message: "The server API is not reachable." });
    response.writeHead(503, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), connection: "close" });
    response.end(body);
  });
  upstream.setTimeout(target.idleMs ?? 130_000, () => upstream.destroy(new Error("timeout")));
  // The browser left (or its connection failed): the API request ends with it, and so does a stream the API holds open.
  response.once("close", () => upstream.destroy());
  request.pipe(upstream);
}
