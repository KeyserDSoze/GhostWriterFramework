import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

// What the tests of the OAuth authorization server (S7 phase B) share: requests with a Host of our choice (fetch cannot set one: the passkey needs the public
// host), the pieces of the authorization code flow with PKCE, and the consent page read the way its script reads it.

export const PUBLIC_HOST = "api.example.test";
export const PUBLIC_URL = `https://${PUBLIC_HOST}`;
export const APP_REDIRECT = "https://claude.example/api/mcp/auth_callback";
export const LOCAL_REDIRECT = "http://127.0.0.1:8765/callback";

/** The owner tells the server its public address (what the tunnel serves): from then on a request with that Host is a public one. */
export const setPublic = (server) => server.data.updateConfig((config) => {
  config.publicUrl = PUBLIC_URL;
});

export const adminCode = async (server) => (await readFile(path.join(server.data.root, "private", "admin-code.txt"), "utf8")).trim();

/**
 * Requests to the API with a Host of our choice (`host`: a public address; none: this computer's own), the way a browser or an OAuth client sends them. A POST carries
 * the `Origin` of the host it goes to unless `origin` says another (`origin: "https://evil.example"`) or `false`. `json` and `form` set the body and its type.
 * Answers `{ status, headers, text, json, location }`; with `record` (an array) every answer is also pushed there, with its method and route.
 */
export function web(server, { host, record } = {}) {
  const target = new URL(server.url);
  const own = host ? `https://${host}` : server.url;
  const send = (method, route, { json, form, body, headers = {}, origin } = {}) => new Promise((resolve, reject) => {
    const payload = json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form).toString() : body;
    const sent = origin === false || (origin === undefined && method === "GET") ? undefined : origin ?? own;
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: route,
      method,
      agent: false,
      headers: {
        ...(host ? { host } : {}),
        ...(sent ? { origin: sent } : {}),
        ...(json !== undefined ? { "content-type": "application/json" } : form !== undefined ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        const answer = { status: response.statusCode, headers: response.headers, text, json: parsed, location: response.headers.location };
        record?.push({ method, route, ...answer });
        resolve(answer);
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
  return { host, origin: own, get: (route, options) => send("GET", route, options), post: (route, options) => send("POST", route, options), send };
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Register an app (RFC 7591) as the apps do: public, with one redirect address. */
export async function registerApp(w, overrides = {}) {
  const answer = await w.post("/oauth/register", { json: { client_name: "Claude", redirect_uris: [APP_REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...overrides } });
  if (answer.status !== 201) throw new Error(`registering an app failed: ${answer.status} ${answer.text}`);
  return answer.json;
}

/** The address of an authorization request. A parameter given as `null` is left out (`undefined` is the default: one that is right). */
export function authorizeRoute({ clientId, redirectUri = APP_REDIRECT, challenge, state = "state-1", resource, scope, method = "S256", responseType = "code", extra = {} }) {
  const pairs = { response_type: responseType, client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: method, state, resource, scope, ...extra };
  const query = new URLSearchParams(Object.entries(pairs).filter(([, value]) => value !== undefined && value !== null));
  return `/oauth/authorize?${query}`;
}

const unescapeHtml = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** What the consent page tells its script: the `data-state` of its body, parsed. */
export function pageState(html) {
  const match = /<body[^>]*\sdata-state="([^"]*)"/.exec(html);
  if (!match) throw new Error(`no data-state in the page: ${html.slice(0, 300)}`);
  return JSON.parse(unescapeHtml(match[1]));
}

/** Open the consent page of a request: `{ status, headers, text, page }` (`page` is the state of the page, when there is a page). */
export async function openConsent(w, params, options = {}) {
  const answer = await w.get(authorizeRoute(params), options);
  return { ...answer, page: answer.status === 200 && /data-state=/.test(answer.text) ? pageState(answer.text) : undefined };
}

const csrfHeader = (page) => ({ "x-csrf-token": page.csrf });

/** Approve a request with the admin code. */
export const approveWithCode = (w, page, { code, scopes = ["read"], book, headers = {}, origin } = {}) =>
  w.post("/oauth/authorize/approve", { json: { requestId: page.requestId, scopes, ...(book ? { book } : {}), proof: { type: "admin-code", code } }, headers: { ...csrfHeader(page), ...headers }, ...(origin !== undefined ? { origin } : {}) });

/** Approve a request with a passkey: ask for the challenge (with what is being approved), sign it, answer. */
export async function approveWithPasskey(w, page, { passkey, scopes = ["read"], book, origin = PUBLIC_URL, rpId = PUBLIC_HOST }) {
  const options = await w.post("/oauth/authorize/challenge", { json: { requestId: page.requestId, scopes, ...(book ? { book } : {}) }, headers: csrfHeader(page) });
  if (options.status !== 200) return options;
  const credential = passkey.get({ challenge: options.json.publicKey.challenge, origin, rpId });
  return w.post("/oauth/authorize/approve", { json: { requestId: page.requestId, proof: { type: "passkey", credential } }, headers: csrfHeader(page) });
}

/** Register a passkey with a ticket (what the offer after an admin code, or a link of the admin panel, carries). */
export async function registerPasskey(w, ticket, passkey, { label = "Test phone", origin = PUBLIC_URL, rpId = PUBLIC_HOST } = {}) {
  const options = await w.post("/oauth/passkeys/options", { json: { ticket } });
  if (options.status !== 200) return options;
  const credential = passkey.create({ challenge: options.json.publicKey.challenge, origin, rpId });
  return w.post("/oauth/passkeys/register", { json: { ticket, label, credential } });
}

export const codeOf = (redirect) => new URL(redirect).searchParams.get("code");

/** The token endpoint, with a form as RFC 6749 says. */
export const token = (w, form) => w.post("/oauth/token", { form });

/** The code exchange of an authorization. */
export const exchange = (w, { code, verifier, clientId, redirectUri = APP_REDIRECT, resource }) =>
  token(w, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri, ...(resource ? { resource } : {}) });

export const refresh = (w, { refreshToken, clientId, resource, scope }) =>
  token(w, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, ...(resource ? { resource } : {}), ...(scope ? { scope } : {}) });

/** Register an app and open its consent page: `{ app, verifier, challenge, page, redirectUri, resource }` (`resource: null` names none). The page is the state of the page (see `pageState`). */
export async function startAuthorization(w, { slug, name = "Claude", redirectUri = w.host ? APP_REDIRECT : LOCAL_REDIRECT, scope, resource, state = "state-1", headers } = {}) {
  const app = await registerApp(w, { client_name: name, redirect_uris: [redirectUri] });
  const { verifier, challenge } = pkce();
  const target = resource === null ? undefined : resource ?? `${w.origin}/mcp/${slug}`;
  const opened = await openConsent(w, { clientId: app.client_id, redirectUri, challenge, resource: target, scope, state }, headers ? { headers } : {});
  if (!opened.page) throw new Error(`no consent page: ${opened.status} ${opened.text.slice(0, 300)}`);
  return { app, verifier, challenge, page: opened.page, redirectUri, resource: target, html: opened.text, headers: opened.headers };
}

/**
 * A whole authorization: register an app, open the consent page, approve (with the admin code, or with `passkey`), exchange the code. By default it goes to
 * this computer's own address; with `w = web(server, { host: PUBLIC_HOST })` (and `setPublic`) it goes to the public one, where a passkey works.
 * Answers what the app ends with: `{ app, tokens, approved, verifier, resource, redirectUri }`.
 */
export async function connectApp(server, { slug, name = "Claude", scopes = ["read"], scope, w = web(server), redirectUri = w.host ? APP_REDIRECT : LOCAL_REDIRECT, mcp, passkey }) {
  const app = await registerApp(w, { client_name: name, redirect_uris: [redirectUri] });
  const { verifier, challenge } = pkce();
  const resource = mcp ?? `${w.origin}/mcp/${slug}`;
  const opened = await openConsent(w, { clientId: app.client_id, redirectUri, challenge, resource, ...(scope !== undefined ? { scope } : {}) });
  if (!opened.page) throw new Error(`no consent page: ${opened.status} ${opened.text.slice(0, 200)}`);
  const approved = passkey ? await approveWithPasskey(w, opened.page, { passkey, scopes }) : await approveWithCode(w, opened.page, { code: await adminCode(server), scopes });
  if (approved.status !== 200) throw new Error(`approval failed: ${approved.status} ${approved.text}`);
  const tokens = await exchange(w, { code: codeOf(approved.json.redirect), verifier, clientId: app.client_id, redirectUri, resource });
  if (tokens.status !== 200) throw new Error(`token exchange failed: ${tokens.status} ${tokens.text}`);
  return { app, tokens: tokens.json, approved: approved.json, verifier, resource, redirectUri };
}

/**
 * The first passkey: an authorization with the admin code on the public address offers to register one, and the test registers `passkey` with the ticket.
 * Answers what `registerPasskey` answered, and the connection that made the offer (`connected`).
 */
export async function enrollPasskey(server, passkey, { slug, label = "Test phone" } = {}) {
  const w = web(server, { host: PUBLIC_HOST });
  const connected = await connectApp(server, { slug, name: "First app", w });
  const ticket = connected.approved.passkeyOffer?.ticket;
  if (!ticket) throw new Error(`the admin code did not offer a passkey: ${JSON.stringify(connected.approved)}`);
  const registered = await registerPasskey(w, ticket, passkey, { label });
  if (registered.status !== 200) throw new Error(`registering the passkey failed: ${registered.status} ${registered.text}`);
  return { registered: registered.json, connected, w };
}

/** A clock that the tests move: `now` goes to the server's `now` option, `advance(ms)` takes it forward. */
export function makeClock(start = "2026-11-22T10:00:00.000Z") {
  let time = Date.parse(start);
  return { now: () => new Date(time), advance: (ms) => void (time += ms) };
}
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A server's log lines, to look through for what must never be in them. */
export function logCollector() {
  const lines = [];
  return { lines, log: (line) => void lines.push(String(line)), text: () => lines.join("\n") };
}

/** The parameters of a `WWW-Authenticate: Bearer …` header. */
export function challengeParams(header) {
  const params = {};
  for (const match of String(header).matchAll(/([a-z_]+)="([^"]*)"/g)) params[match[1]] = match[2];
  return params;
}
