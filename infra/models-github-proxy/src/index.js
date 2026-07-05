/**
 * Cloudflare Worker: CORS proxy for the GitHub Models API.
 *
 * The Narrarium web app is a pure browser front-end served from GitHub Pages.
 * GitHub Models (https://models.github.ai/*) does not send CORS headers, so the
 * browser blocks direct calls. This Worker endpoint adds
 * CORS headers scoped to the Narrarium origins, and transparently forwards every
 * request (path, query string, method, body, headers) to models.github.ai.
 *
 * NOTE: CORS is a browser guard, not authentication. A non-browser caller can
 * spoof the Origin header. If real protection is needed, add a shared token or a
 * Cloudflare Access policy in front of this Worker.
 */

const TARGET_ORIGIN = "https://models.github.ai";

/** Origins allowed to use the proxy (production + www + local dev). */
const ALLOWED_ORIGINS = new Set([
  "https://narrarium.net",
  "https://www.narrarium.net",
  "http://localhost:5173",
  "http://localhost:4173",
]);

// Header che non vanno proxyati perché sono legati al singolo hop HTTP.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function resolveAllowedOrigin(request) {
  const origin = request.headers.get("Origin");
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function corsHeaders(request, allowedOrigin) {
  const requestedHeaders =
    request.headers.get("Access-Control-Request-Headers") || "*";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
    "Access-Control-Allow-Headers": requestedHeaders,
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Headers",
  };
}

function upstreamHeaders(request) {
  const headers = new Headers(request.headers);

  for (const name of [...headers.keys()]) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      headers.delete(name);
    }
  }

  // Evita di mandare cookie di narrarium.net a GitHub.
  // Authorization, Content-Type, Accept e header custom restano.
  headers.delete("cookie");

  return headers;
}

export default {
  async fetch(request) {
    const allowedOrigin = resolveAllowedOrigin(request);

    // Browser preflight: only answer for allowed origins.
    if (request.method === "OPTIONS") {
      if (!allowedOrigin) return new Response("Forbidden origin", { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(request, allowedOrigin) });
    }

    // Browser requests carry an Origin header; block disallowed browser origins.
    // Non-browser callers (no Origin) are proxied without CORS headers.
    const origin = request.headers.get("Origin");
    if (origin && !allowedOrigin) {
      return new Response("Forbidden origin", { status: 403 });
    }

    const incomingUrl = new URL(request.url);
    const targetUrl = new URL(TARGET_ORIGIN);
    targetUrl.pathname = incomingUrl.pathname;
    targetUrl.search = incomingUrl.search;

    const init = {
      method: request.method,
      headers: upstreamHeaders(request),
      redirect: "manual",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    const upstream = await fetch(targetUrl.toString(), init);

    const responseHeaders = new Headers(upstream.headers);
    if (allowedOrigin) {
      for (const [key, value] of Object.entries(corsHeaders(request, allowedOrigin))) {
        responseHeaders.set(key, value);
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};
