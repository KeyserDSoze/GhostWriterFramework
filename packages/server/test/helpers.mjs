import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NarrariumServerClient } from "narrarium-engine";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import { startNarrariumServer } from "../dist/testing.mjs";

/** No registry access in tests: by default npm "has" nothing newer. */
export const noRelease = async (installedVersion) => ({ packageName: "narrarium-server", installedVersion, available: false, signed: false, reason: "not_published", message: "Not published." });

export const releaseAvailable = (latestVersion) => async (installedVersion) => ({ packageName: "narrarium-server", installedVersion, latestVersion, available: true, signed: true, message: `Version ${latestVersion} is available.` });

/** Registry metadata as npm serves it for a release of the server package. */
export function npmMetadata(version, { attested = true, signed = true, name = "narrarium-server", repository = "git+https://github.com/KeyserDSoze/GhostWriterFramework.git", directory = "packages/server", predicateType = "https://slsa.dev/provenance/v1" } = {}) {
  return {
    name,
    version,
    repository: { type: "git", url: repository, directory },
    dist: {
      integrity: `sha512-${"A".repeat(86)}==`,
      ...(signed ? { signatures: [{ keyid: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U", sig: `MEUCIQ${"a".repeat(60)}` }] } : {}),
      ...(attested ? { attestations: { url: `https://registry.npmjs.org/-/npm/v1/attestations/${name}@${version}`, provenance: { predicateType } } } : {}),
    },
  };
}

/** An AI that waits at its first call until `release()`: keeps an autopilot "running" on demand. */
export function gatedAi() {
  const inner = createFakeAutopilotAi();
  let release;
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  return {
    ai: {
      async complete(request) {
        entered();
        await gate;
        return inner.complete(request);
      },
    },
    started,
    release: () => release(),
  };
}

export async function until(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Start a server on free ports with a read/write/run client token. */
export async function withServer(run, extra = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-server-test-"));
  const server = await startNarrariumServer({ dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] }, ...extra });
  try {
    const { token } = await server.auth.issue("test client", extra.scopes ?? ["read", "write", "run"]);
    await run(server, new NarrariumServerClient({ baseUrl: server.url, token }), dataDir);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Follow the live stream until `done(message)` returns true. */
export async function waitForStream(client, done, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const messages = [];
  try {
    await client.stream((message) => {
      messages.push(message);
      if (done(message)) controller.abort();
    }, controller.signal);
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
  }
  return messages;
}

/** Sign in to the admin panel with the code in the data folder. */
export async function adminLogin(server) {
  const code = (await readFile(path.join(server.data.root, "private", "admin-code.txt"), "utf8")).trim();
  const origin = server.adminUrl;
  const login = await fetch(`${origin}/admin/api/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }) });
  if (!login.ok) throw new Error(`admin login failed: ${login.status}`);
  const { csrf } = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(`${origin}${route}`, {
      method,
      headers: { origin, cookie, "content-type": "application/json", ...(method === "POST" ? { "x-csrf-token": csrf } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { call, csrf, cookie, origin, code };
}
