import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A GitHub (its device flow and the one call of its API that the server makes) and the broker of the Worker (its renewal and its revocation of one token), as two small http servers on
// this machine, which the real personal server of a spec talks to. Nothing reaches the network. The device flow is the one GitHub's: the server asks for a code, shows nothing itself, and asks for the
// answer at the interval it was given until the owner has typed the code (`approve`).

export const CLIENT_ID = "Iv1.e2eclientid00001";
export const ACCESS_TOKEN = "ghu_E2E_SERVER_ACCESS_TOKEN_0123456789";
export const REFRESH_TOKEN = "ghr_E2E_SERVER_REFRESH_TOKEN_0123456789";

export interface Recorded {
  method: string;
  path: string;
  form: Record<string, string>;
  json: unknown;
  authorization: string | null;
}

export interface FakeGitHub {
  url: string;
  /** What `startPersonalServer` takes as `githubConnection`. */
  options: { deviceUrl: string; tokenUrl: string; apiUrl: string };
  /** The page GitHub tells the owner to open, and how often it was opened. */
  verificationUri: string;
  visits: number;
  userCode: string;
  /** `ok`: the device flow works. `device-flow-disabled`: the app has no device flow, which GitHub says in its answer to the request for a code. */
  mode: "ok" | "device-flow-disabled";
  /** The owner types the code: the next answer to the server's question is the pair of tokens. */
  approve(): void;
  requests: Recorded[];
  close(): Promise<void>;
}

export interface FakeBroker {
  url: string;
  /** Every call of the server to the broker, in order (`refresh`, `revoke-token`). */
  requests: Recorded[];
  close(): Promise<void>;
}

async function read(request: IncomingMessage): Promise<{ text: string; form: Record<string, string>; json: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const type = request.headers["content-type"] ?? "";
  let json: unknown;
  if (type.includes("json")) try { json = JSON.parse(text); } catch { json = undefined; }
  return { text, form: type.includes("x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(text)) : {}, json };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

const close = (server: Server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });

export async function startFakeGitHub(): Promise<FakeGitHub> {
  let approved = false;
  const requests: Recorded[] = [];
  const fake = { visits: 0, mode: "ok" as FakeGitHub["mode"] };
  const server = createServer(async (request, response) => {
    const body = await read(request);
    const path = (request.url ?? "").split("?")[0];
    requests.push({ method: request.method ?? "GET", path, form: body.form, json: body.json, authorization: request.headers.authorization ?? null });
    const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.method === "GET" && path === "/login/device") {
      fake.visits += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Device activation</title><h1>Device Activation</h1><p>Enter the code displayed on your device.</p>");
      return;
    }
    if (request.method === "POST" && path === "/login/device/code") {
      if (fake.mode === "device-flow-disabled") return send(200, { error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" });
      if (body.form.client_id !== CLIENT_ID) return send(200, { error: "incorrect_client_credentials" });
      return send(200, { device_code: "dc_E2E_DEVICE_CODE_0123456789abcdef", user_code: "WDJB-MJHT", verification_uri: `${origin}/login/device`, expires_in: 900, interval: 1 });
    }
    if (request.method === "POST" && path === "/login/oauth/access_token") {
      if (!approved) return send(200, { error: "authorization_pending" });
      return send(200, { access_token: ACCESS_TOKEN, expires_in: 28_800, refresh_token: REFRESH_TOKEN, refresh_token_expires_in: 15_897_600, token_type: "bearer", scope: "" });
    }
    if (request.method === "GET" && path === "/user") {
      if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) return send(401, { message: "Bad credentials" });
      return send(200, { login: "octocat", id: 1 });
    }
    return send(404, { message: "Not Found" });
  });
  const origin = await listen(server);
  return {
    url: origin,
    options: { deviceUrl: `${origin}/login/device/code`, tokenUrl: `${origin}/login/oauth/access_token`, apiUrl: origin },
    verificationUri: `${origin}/login/device`,
    userCode: "WDJB-MJHT",
    get visits() { return fake.visits; },
    get mode() { return fake.mode; },
    set mode(value) { fake.mode = value; },
    approve: () => { approved = true; },
    requests,
    close: () => close(server),
  } as FakeGitHub;
}

export async function startFakeBroker(): Promise<FakeBroker> {
  const requests: Recorded[] = [];
  const server = createServer(async (request, response) => {
    const body = await read(request);
    const path = (request.url ?? "").split("?")[0];
    requests.push({ method: request.method ?? "GET", path, form: body.form, json: body.json, authorization: request.headers.authorization ?? null });
    if (path === "/oauth/github/revoke-token") { response.writeHead(204); response.end(); return; }
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_grant", message: "Nothing is renewed in a spec." }));
  });
  const url = await listen(server);
  return { url, requests, close: () => close(server) };
}
