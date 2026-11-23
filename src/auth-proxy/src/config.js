/**
 * Configuration shared by the transparent proxy and the OAuth token broker:
 * which origins may call the Worker and which redirect URIs (Microsoft and GitHub
 * callback pages) the broker may exchange an authorization code for.
 */

/** Origins allowed to use the Worker (production + www + local dev). */
export const DEFAULT_ALLOWED_ORIGINS = [
  "https://narrarium.net",
  "https://www.narrarium.net",
  "http://localhost:5173",
  "http://localhost:4173",
];

/** Redirect URIs of the Microsoft and GitHub sign-in callback pages the broker accepts by default. */
export const DEFAULT_ALLOWED_REDIRECT_URIS = [
  "https://narrarium.net/auth/microsoft-callback.html",
  "https://www.narrarium.net/auth/microsoft-callback.html",
  "http://localhost:5173/auth/microsoft-callback.html",
  "http://localhost:4173/auth/microsoft-callback.html",
  "https://narrarium.net/auth/github/callback",
  "https://www.narrarium.net/auth/github/callback",
  "http://localhost:5173/auth/github/callback",
  "http://localhost:4173/auth/github/callback",
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function splitList(value) {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// https anywhere; plain http only for the machine's own loopback addresses.
function hasSafeScheme(url) {
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

// ALLOWED_ORIGINS_EXTRA: comma separated; each entry is reduced to its origin, so a
// full site URL such as https://user.github.io/narrarium/ works. Wildcards are never expanded.
function extraOrigins(env) {
  const origins = [];
  for (const entry of splitList(env?.ALLOWED_ORIGINS_EXTRA)) {
    const url = parseUrl(entry);
    if (url && !entry.includes("*") && hasSafeScheme(url)) origins.push(url.origin);
  }
  return origins;
}

export function allowedOrigins(env) {
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins(env)]);
}

export function resolveAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  return origin && allowedOrigins(env).has(origin) ? origin : null;
}

function isUsableRedirectUri(entry) {
  const url = parseUrl(entry);
  return (
    url !== null &&
    hasSafeScheme(url) &&
    !/[\s*#]/.test(entry) &&
    url.username === "" &&
    url.password === ""
  );
}

/**
 * ALLOWED_REDIRECT_URIS: comma separated, compared as exact strings. When it holds any
 * text it replaces the defaults (entries that are not safe absolute URLs are dropped, so
 * a list with nothing usable refuses every redirect URI); when unset or blank the
 * defaults apply.
 */
export function allowedRedirectUris(env) {
  const configured = env?.ALLOWED_REDIRECT_URIS;
  if (typeof configured !== "string" || configured.trim() === "") return DEFAULT_ALLOWED_REDIRECT_URIS;
  return splitList(configured).filter(isUsableRedirectUri);
}
