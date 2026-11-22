import http from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { until } from "./helpers.mjs";

// What the tests of the autopilot's rules and data share: requests with full control of the body, the headers and the address, the live
// stream followed in the background, and a search for a text in everything the server keeps.

/** The answer of a request that failed, as the typed client reports it. */
export const refusal = (error) => ({ status: error.status, code: error.code, message: error.message });
export const attempt = (action) => action().then(() => ({ status: 200 }), refusal);

/**
 * Requests that a typed client would never send, with the token of a client of `scopes`. `call(method, route, body, headers)` takes a body that
 * is a string (sent as it is) or a value (sent as JSON) and answers `{ status, json, text, headers }`; the route is the whole address, query included.
 */
export async function rawApi(server, scopes = ["read", "write", "run"]) {
  const { token } = await server.auth.issue("raw client", scopes);
  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(`${server.url}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text, headers: response.headers };
  };
  call.token = token;
  return call;
}

/** A request that declares a body over any limit and sends none: the answer comes from the headers alone, and there is no body to race against it. */
export function declareLarge(server, method, route, token, length = 3 * 1024 * 1024) {
  const target = new URL(server.url);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: target.hostname, port: target.port, path: route, method, agent: false, timeout: 15_000, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(length) } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        request.destroy();
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          json = null;
        }
        resolve({ status: response.statusCode, json });
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.flushHeaders();
  });
}

/** Follow the live stream in the background; `stop()` ends it. Resolves once the server has said hello. */
export async function followStream(client) {
  const controller = new AbortController();
  const messages = [];
  const following = client.stream((message) => messages.push(message), controller.signal).catch((error) => {
    if (error?.name !== "AbortError") throw error;
  });
  await until(() => messages.some((message) => message.event === "hello"), 30_000);
  return {
    messages,
    stop: async () => {
      controller.abort();
      await following;
    },
  };
}

/** The autopilot events of a stream, and the summaries that its `state` events carry. */
export const autopilotEvents = (messages) => messages.filter((message) => message.event === "autopilot").map((message) => message.data);
export const stateEvents = (messages) => autopilotEvents(messages).filter((event) => event.type === "state").map((event) => event.state);
export const bookEvents = (messages) => messages.filter((message) => message.event === "book").map((message) => message.data);

/** Every file under `directory` (the working copies of the books and the private folder included) that holds `needle`, as paths relative to it. */
export async function filesHolding(directory, needle) {
  const found = [];
  const wanted = Buffer.from(needle);
  const walk = async (current) => {
    // A folder can be gone by the time it is read (the server writes files and replaces them): what is not there holds nothing.
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && (await readFile(full).catch(() => Buffer.alloc(0))).includes(wanted)) found.push(path.relative(directory, full));
    }
  };
  await walk(directory);
  return found;
}

/** Everything git kept of a working copy, as text: every commit message and every change of every file (git packs its objects, so the files alone say nothing). */
export function historyOf(directory) {
  return execFileSync("git", ["-c", "core.quotepath=off", "-C", directory, "log", "--all", "-p", "--format=%H %s%n%b"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}
