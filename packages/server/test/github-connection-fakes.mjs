import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

// A GitHub and a broker that live in the process: what the server's own connection talks to in the tests. Nothing reaches the network. The broker rotates the refresh token as GitHub does: a refresh
// token that was already used (or that nobody issued) is refused with `invalid_grant`, so a renewal that did not keep the new refresh token shows up as a connection that is lost.

export const CLIENT_ID = "Iv1.0123456789abcdef";
export const BROKER = "https://broker.example.com";
const DEVICE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * One fake GitHub with its broker, a clock the tests move and the way the device flow waits. `world.options` is what `startNarrariumServer` takes as `githubConnection`.
 * `world.pair()` issues a pair the way GitHub does, `world.script` is what GitHub answers, in order, when the server asks whether the owner typed the code (a string is an error code, `"tokens"`
 * is the owner having typed it; when nothing is left it says `authorization_pending`).
 */
export function fakeWorld(settings = {}) {
  const world = {
    clock: Date.parse("2026-11-28T10:00:00.000Z"),
    /** Every request that went out: where, how, with which headers and body. */
    calls: [],
    /** How long the device flow asked to wait each time. */
    waits: [],
    deviceCode: "dc_SECRET_DEVICE_CODE_0123456789abcdef",
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    expiresIn: 900,
    interval: 5,
    /** What the device-code endpoint answers instead of the code: an object, an error code, or a status. */
    deviceReply: undefined,
    script: [],
    login: "octocat",
    userStatus: 200,
    accessLifetime: 28_800,
    /** `ok`, `down` (the broker cannot be reached), `error` (HTTP 500), `not-configured` (501), `garbage` (a 200 that is not tokens), `slow` (never answers), `redirect`, `huge`. */
    broker: "ok",
    /** What the token endpoint gives: `expiring` (a pair), `plain` (an access token that does not end: the app has "Expire user authorization tokens" off). */
    tokenKind: "expiring",
    /** What `github/revoke-token` answers: 204, or another status. */
    revokeStatus: 204,
    issued: 0,
    refreshes: 0,
    current: undefined,
    validAccess: new Set(),
    hold: undefined,
    ...settings,
  };
  const set = () => `${String(++world.issued).padStart(2, "0")}`;
  world.pair = () => {
    const n = set();
    const pair = { access: `ghu_ACCESS${n}TOKENabcdefghijklmnopqrstuvwxyz0123`, refresh: `ghr_REFRESH${n}TOKENabcdefghijklmnopqrstuvwxyz0123456789` };
    world.current = pair;
    world.validAccess.add(pair.access);
    return pair;
  };
  /** The tokens the server has been given so far, for tests that look for them in what the server wrote. */
  world.everIssued = () => [...Array(world.issued).keys()].flatMap((index) => {
    const n = String(index + 1).padStart(2, "0");
    return [`ghu_ACCESS${n}TOKENabcdefghijklmnopqrstuvwxyz0123`, `ghr_REFRESH${n}TOKENabcdefghijklmnopqrstuvwxyz0123456789`];
  });
  world.advance = (ms) => {
    world.clock += ms;
  };
  world.sleep = async (ms) => {
    world.waits.push(ms);
    world.clock += ms;
    if (world.hold) await world.hold;
    await new Promise((resolve) => setImmediate(resolve));
  };
  const record = (service, url, init, body) => world.calls.push({ service, method: init.method ?? "GET", url, headers: Object.fromEntries(new Headers(init.headers)), body });
  world.callsTo = (service) => world.calls.filter((call) => call.service === service);
  world.fetch = async (input, init = {}) => {
    const url = String(input);
    const text = typeof init.body === "string" ? init.body : undefined;
    if (url === DEVICE_URL) {
      const form = Object.fromEntries(new URLSearchParams(text));
      record("device", url, init, form);
      if (world.deviceHold) await world.deviceHold;
      if (typeof world.deviceReply === "string") return json({ error: world.deviceReply });
      if (typeof world.deviceReply === "number") return json({ error: "Not Found" }, world.deviceReply);
      if (world.deviceReply) return json(world.deviceReply);
      if (form.client_id !== CLIENT_ID) return json({ error: "incorrect_client_credentials" });
      return json({ device_code: world.deviceCode, user_code: world.userCode, verification_uri: world.verificationUri, expires_in: world.expiresIn, interval: world.interval });
    }
    if (url === TOKEN_URL) {
      const form = Object.fromEntries(new URLSearchParams(text));
      record("token", url, init, form);
      const next = world.script.shift() ?? "authorization_pending";
      if (next === "tokens") {
        if (world.tokenKind === "plain") return json({ access_token: "ghu_NEVERENDINGtoken0123456789abcdefghijklmnop", token_type: "bearer", scope: "" });
        const pair = world.pair();
        return json({ access_token: pair.access, expires_in: world.accessLifetime, refresh_token: pair.refresh, refresh_token_expires_in: 15_897_600, token_type: "bearer", scope: "" });
      }
      if (typeof next === "string") return json({ error: next, error_description: "SECRET-looking description that must never be quoted", ...(next === "slow_down" ? { interval: world.interval + 5 } : {}) });
      return json(next);
    }
    if (url === USER_URL) {
      record("api", url, init, undefined);
      const bearer = /^Bearer (.+)$/.exec(new Headers(init.headers).get("authorization") ?? "")?.[1];
      if (!bearer || !world.validAccess.has(bearer)) return json({ message: "Bad credentials" }, 401);
      return world.userStatus === 200 ? json({ login: world.login, id: 1 }) : json({ message: "no" }, world.userStatus);
    }
    if (url.startsWith(`${BROKER}/oauth/github/`) || url.startsWith("http://127.0.0.1:") || url.startsWith("https://other-broker.example.net/")) {
      const route = url.slice(url.indexOf("/oauth/github/") + "/oauth/github/".length);
      const body = text ? JSON.parse(text) : {};
      record(`broker:${route}`, url, init, body);
      if (world.broker === "down") throw new TypeError("fetch failed");
      if (world.broker === "slow") return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      if (world.broker === "error") return json({ error: "internal_error", message: "boom" }, 500);
      if (world.broker === "not-configured") return json({ error: "not_configured", message: "GitHub sign-in is not configured on this server." }, 501);
      if (world.broker === "redirect") return new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } });
      if (world.broker === "huge") return new Response("x".repeat(200_000), { status: 200, headers: { "content-type": "application/json" } });
      if (route === "refresh") {
        world.refreshes += 1;
        if (world.broker === "garbage") return json({ hello: "world" });
        if (!world.current || body.refreshToken !== world.current.refresh) return json({ error: "invalid_grant", message: "GitHub rejected the authorization code or refresh token. Connect again." }, 400);
        const pair = world.pair();
        return json({ accessToken: pair.access, expiresIn: world.accessLifetime, refreshToken: pair.refresh, refreshTokenExpiresIn: 15_897_600 });
      }
      if (route === "revoke-token") return world.revokeStatus === 204 ? new Response(null, { status: 204 }) : json({ error: "not_found" }, world.revokeStatus);
      return json({ error: "not_found" }, 404);
    }
    throw new Error(`The fake world does not know ${url}`);
  };
  world.options = { fetch: world.fetch, now: () => new Date(world.clock), sleep: world.sleep, ...(settings.options ?? {}) };
  return world;
}

/** The tokens and the device code, as the tests look for them in what the server wrote and answered. */
export function secretsOf(world) {
  return [...world.everIssued(), world.deviceCode];
}

/** Every file under `root` (the data folder) as text, except what the vault encrypts on purpose: for a test that looks for a secret where it must not be. */
export async function readableFiles(root, skip = ["master.key", "master.key.bak"]) {
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        await walk(full);
      } else if (entry.isFile() && !skip.includes(entry.name) && (await stat(full)).size < 5_000_000) found.push({ file: path.relative(root, full), text: await readFile(full, "utf8").catch(() => "") });
    }
  };
  await walk(root);
  return found;
}
