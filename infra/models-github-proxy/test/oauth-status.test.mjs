import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { OAUTH_PROVIDERS, describeStatus, fetchOAuthStatus, normalizeBaseUrl, renderSummary } from "../scripts/oauth-status.mjs";

const summarizeScript = fileURLToPath(new URL("../scripts/summarize-oauth-status.mjs", import.meta.url));
const checkScript = fileURLToPath(new URL("../scripts/check-status.mjs", import.meta.url));

const BASE = "https://models-github-proxy.example.workers.dev";
const FAKE_SECRET = "FAKE-secret-that-must-never-be-printed-0123456789";

function answer(payload, status = 200) {
  return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
}

describe("normalizeBaseUrl", () => {
  it("keeps only the origin of an https URL", () => {
    assert.equal(normalizeBaseUrl(BASE), BASE);
    assert.equal(normalizeBaseUrl(`  ${BASE}/inference/?x=1#y `), BASE);
    assert.equal(normalizeBaseUrl("https://auth.narrarium.net/"), "https://auth.narrarium.net");
  });

  it("refuses anything else, and allows http only on loopback", () => {
    for (const value of [undefined, null, "", "  ", "not a url", "http://models.example.com", "ftp://x.example", "javascript:alert(1)", "https://user:pass@example.com", 42]) {
      assert.equal(normalizeBaseUrl(value), null, String(value));
    }
    assert.equal(normalizeBaseUrl("http://127.0.0.1:8787/x"), "http://127.0.0.1:8787");
    assert.equal(normalizeBaseUrl("http://localhost:8787"), "http://localhost:8787");
  });
});

describe("fetchOAuthStatus", () => {
  const instant = { delayMs: 0, sleep: async () => {} };

  it("reads the three booleans from GET /oauth/status, with a descriptive User-Agent", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return answer({ google: true, microsoft: false, github: false });
    };
    const result = await fetchOAuthStatus(BASE, { ...instant, fetchImpl });
    assert.deepEqual(result, { ok: true, flags: { google: true, microsoft: false, github: false } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/oauth/status`);
    assert.equal(calls[0].init.method, "GET");
    assert.match(new Headers(calls[0].init.headers).get("user-agent") ?? "", /narrarium/);
    assert.equal(calls[0].init.redirect, "manual");
  });

  it("retries while the Worker is still the old version (no github key), then succeeds", async () => {
    let attempt = 0;
    const sleeps = [];
    const fetchImpl = async () => {
      attempt += 1;
      return attempt < 3 ? answer({ google: false, microsoft: false }) : answer({ google: false, microsoft: false, github: false });
    };
    const result = await fetchOAuthStatus(BASE, { fetchImpl, attempts: 4, delayMs: 5000, sleep: async (ms) => sleeps.push(ms) });
    assert.equal(result.ok, true);
    assert.equal(result.flags.github, false);
    assert.equal(attempt, 3);
    assert.deepEqual(sleeps, [5000, 5000]);
  });

  it("gives up after the attempts and keeps what it saw, leaving a missing provider undefined", async () => {
    let attempts = 0;
    const result = await fetchOAuthStatus(BASE, {
      ...instant,
      attempts: 3,
      fetchImpl: async () => {
        attempts += 1;
        return answer({ google: true, microsoft: true });
      },
    });
    assert.equal(attempts, 3);
    assert.deepEqual(result, { ok: true, flags: { google: true, microsoft: true, github: undefined } });
  });

  it("recovers from a network error and from a 5xx", async () => {
    const replies = [() => Promise.reject(new TypeError("fetch failed")), () => answer("down", 503), () => answer({ google: true, microsoft: true, github: true })];
    const result = await fetchOAuthStatus(BASE, { ...instant, attempts: 3, fetchImpl: async () => replies.shift()() });
    assert.deepEqual(result, { ok: true, flags: { google: true, microsoft: true, github: true } });
  });

  it("reports a failure without throwing, and without echoing the answer", async () => {
    for (const fetchImpl of [
      async () => Promise.reject(new Error(`boom ${FAKE_SECRET}`)),
      async () => answer(`<html>${FAKE_SECRET}</html>`, 502),
      async () => answer(`not json ${FAKE_SECRET}`),
      async () => answer("[]"),
      async () => answer("null"),
    ]) {
      const result = await fetchOAuthStatus(BASE, { ...instant, attempts: 2, fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(typeof result.reason, "string");
      assert.ok(!result.reason.includes(FAKE_SECRET));
    }
  });

  it("ignores values that are not booleans", async () => {
    const result = await fetchOAuthStatus(BASE, { ...instant, attempts: 1, fetchImpl: async () => answer({ google: "yes", microsoft: 1, github: null }) });
    assert.deepEqual(result, { ok: true, flags: { google: undefined, microsoft: undefined, github: undefined } });
  });
});

describe("describeStatus", () => {
  const rowOf = (rows, key) => rows.find((row) => row.provider.key === key);

  it("says what to do for each provider that is not configured, naming the exact repository secret", () => {
    const rows = describeStatus({ google: false, microsoft: false, github: false });
    assert.match(rowOf(rows, "google").action, /GOOGLE_OAUTH_CLIENT_SECRET/);
    assert.match(rowOf(rows, "microsoft").action, /MICROSOFT_OAUTH_CLIENT_SECRET/);
    const github = rowOf(rows, "github").action;
    assert.match(github, /GH_APP_CLIENT_SECRET/);
    assert.match(github, /GITHUB_APP_CLIENT_ID/);
    assert.match(github, /wrangler\.toml/);
    for (const row of rows) {
      assert.equal(row.state, "not-configured");
      assert.equal(row.action.split(/(?<=\.)\s/).length, 1, `one sentence: ${row.action}`);
    }
  });

  it("marks a configured provider and has nothing to do for it", () => {
    const rows = describeStatus({ google: true, microsoft: false, github: undefined });
    assert.equal(rowOf(rows, "google").state, "configured");
    assert.equal(rowOf(rows, "google").label, "configured");
    assert.equal(rowOf(rows, "microsoft").state, "not-configured");
    assert.equal(rowOf(rows, "github").state, "unknown");
  });

  it("points at the client id when the secret was uploaded in this run but the provider is still off", () => {
    const rows = describeStatus({ google: true, microsoft: true, github: false }, { uploaded: ["GITHUB_APP_CLIENT_SECRET"] });
    const action = rowOf(rows, "github").action;
    assert.match(action, /GITHUB_APP_CLIENT_ID/);
    assert.doesNotMatch(action, /GH_APP_CLIENT_SECRET/);
  });

  it("speaks Italian when asked, with the same names", () => {
    const rows = describeStatus({ google: false, microsoft: true, github: false }, { language: "it" });
    assert.equal(rowOf(rows, "google").label, "NON configurato");
    assert.match(rowOf(rows, "google").action, /Imposta il secret GOOGLE_OAUTH_CLIENT_SECRET/);
    assert.equal(rowOf(rows, "microsoft").label, "configurato");
    assert.match(rowOf(rows, "github").action, /GH_APP_CLIENT_SECRET/);
  });

  it("covers exactly the providers the Worker reports", () => {
    assert.deepEqual(OAUTH_PROVIDERS.map((provider) => provider.key), ["google", "microsoft", "github"]);
    assert.ok(OAUTH_PROVIDERS.every((provider) => !provider.repositorySecret.startsWith("GITHUB_")));
  });
});

describe("renderSummary", () => {
  it("is a markdown table with a row per provider", () => {
    const text = renderSummary(describeStatus({ google: true, microsoft: false, github: false }), BASE);
    const lines = text.split("\n");
    assert.ok(lines.includes("| Provider | Status | Next action |"));
    assert.ok(lines.includes("| --- | --- | --- |"));
    assert.equal(lines.filter((line) => /^\| (Google|Microsoft|GitHub) \|/.test(line)).length, 3);
    assert.match(text, /\| Google \| ✅ configured \| Nothing to do\. \|/);
    assert.match(text, /\| GitHub \| ⚠️ not configured \|/);
    assert.ok(text.includes(`${BASE}/oauth/status`));
  });
});

// The scripts run as the workflow runs them: a separate process, a real HTTP answer on loopback.
describe("summarize-oauth-status.mjs (the workflow step)", () => {
  let server;
  let baseUrl;
  let behaviour;
  let requests;

  before(async () => {
    server = createServer((request, response) => {
      requests.push({ url: request.url, userAgent: request.headers["user-agent"] });
      const reply = behaviour(requests.length);
      response.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  function run(script, env, args = []) {
    const directory = mkdtempSync(join(tmpdir(), "oauth-status-"));
    const summary = join(directory, "summary.md");
    writeFileSync(summary, "");
    requests = [];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, OAUTH_STATUS_DELAY_MS: "0", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => {
        const written = readFileSync(summary, "utf8");
        rmSync(directory, { recursive: true, force: true });
        resolve({ status, stdout, stderr, summary: written });
      });
    });
  }

  it("writes the table for a fake status answer, with the next action for each missing provider", async () => {
    behaviour = () => ({ body: { google: true, microsoft: false, github: false } });
    const result = await run(summarizeScript, { WORKER_BASE_URL: `${baseUrl}/inference` });
    assert.equal(result.status, 0);
    assert.equal(requests[0].url, "/oauth/status");
    assert.match(result.summary, /\| Google \| ✅ configured \|/);
    assert.match(result.summary, /\| Microsoft \| ⚠️ not configured \| Set the repository secret MICROSOFT_OAUTH_CLIENT_SECRET/);
    assert.match(result.summary, /\| GitHub \| ⚠️ not configured \| Register the GitHub App.*GH_APP_CLIENT_SECRET/);
  });

  it("does not need a missing secret to succeed: every provider off still exits 0", async () => {
    behaviour = () => ({ body: { google: false, microsoft: false, github: false } });
    const result = await run(summarizeScript, { WORKER_BASE_URL: baseUrl });
    assert.equal(result.status, 0);
    assert.equal((result.summary.match(/⚠️ not configured/g) ?? []).length, 3);
  });

  it("uses the list of uploaded names to point at the client id", async () => {
    behaviour = () => ({ body: { google: true, microsoft: true, github: false } });
    const result = await run(summarizeScript, { WORKER_BASE_URL: baseUrl, UPLOADED_SECRETS: "GITHUB_APP_CLIENT_SECRET\n" });
    assert.match(result.summary, /GITHUB_APP_CLIENT_ID/);
  });

  it("retries while the new deploy propagates (the old answer has no github key)", async () => {
    behaviour = (count) => ({ body: count < 3 ? { google: true, microsoft: true } : { google: true, microsoft: true, github: true } });
    const result = await run(summarizeScript, { WORKER_BASE_URL: baseUrl, OAUTH_STATUS_ATTEMPTS: "5" });
    assert.equal(result.status, 0);
    assert.equal(requests.length, 3);
    assert.match(result.summary, /\| GitHub \| ✅ configured \|/);
  });

  it("fails soft when the Worker is down: exit 0, a warning, a line in the summary", async () => {
    behaviour = () => ({ status: 503, body: "down" });
    const result = await run(summarizeScript, { WORKER_BASE_URL: baseUrl, OAUTH_STATUS_ATTEMPTS: "2" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /::warning title=Sign-in status unavailable::/);
    assert.match(result.summary, /Could not read/);
    assert.equal(requests.length, 2);
  });

  it("fails soft when nothing listens or the variable is not set", async () => {
    const closed = await run(summarizeScript, { WORKER_BASE_URL: "http://127.0.0.1:9", OAUTH_STATUS_ATTEMPTS: "1" });
    assert.equal(closed.status, 0);
    assert.match(closed.stdout, /::warning/);

    for (const value of [undefined, "", "not a url", "http://example.com"]) {
      const result = await run(summarizeScript, value === undefined ? {} : { WORKER_BASE_URL: value });
      assert.equal(result.status, 0, String(value));
      assert.match(result.stdout, /::notice title=Sign-in status not checked::/);
      assert.match(result.summary, /VITE_GITHUB_MODELS_BASE/);
    }
  });

  it("never prints a secret value, even when the answer carries one", async () => {
    behaviour = () => ({ body: { google: true, microsoft: false, github: false, secret: FAKE_SECRET, client_secret: FAKE_SECRET } });
    const result = await run(summarizeScript, { WORKER_BASE_URL: baseUrl, GITHUB_APP_CLIENT_SECRET: FAKE_SECRET, GOOGLE_CLIENT_SECRET: FAKE_SECRET });
    for (const text of [result.stdout, result.stderr, result.summary]) assert.ok(!text.includes(FAKE_SECRET));
  });

  it("prints to stdout outside GitHub Actions, where there is no job summary", async () => {
    behaviour = () => ({ body: { google: true, microsoft: true, github: true } });
    const result = await run(summarizeScript, { WORKER_BASE_URL: baseUrl, GITHUB_STEP_SUMMARY: "" });
    assert.match(result.stdout, /\| GitHub \| ✅ configured \|/);
  });

  describe("check-status.mjs (the owner's command)", () => {
    it("says in words, in Italian by default, what is and is not configured", async () => {
      behaviour = () => ({ body: { google: true, microsoft: false, github: false } });
      const result = await run(checkScript, {}, [baseUrl]);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /Google: configurato/);
      assert.match(result.stdout, /Microsoft: NON configurato\. Imposta il secret MICROSOFT_OAUTH_CLIENT_SECRET/);
      assert.match(result.stdout, /GitHub: NON configurato\. Registra la GitHub App/);
      assert.match(result.stdout, /Alcuni accessi non sono ancora configurati/);
    });

    it("speaks English with --lang en and reads the URL from the environment", async () => {
      behaviour = () => ({ body: { google: true, microsoft: true, github: true } });
      const result = await run(checkScript, { VITE_GITHUB_MODELS_BASE: `${baseUrl}/` }, ["--lang", "en"]);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /GitHub: configured/);
      assert.match(result.stdout, /Everything is configured\./);
    });

    it("exits 2 with --strict while a provider is missing, 0 once everything is configured", async () => {
      behaviour = () => ({ body: { google: true, microsoft: true, github: false } });
      assert.equal((await run(checkScript, {}, [baseUrl, "--strict"])).status, 2);
      behaviour = () => ({ body: { google: true, microsoft: true, github: true } });
      assert.equal((await run(checkScript, {}, [baseUrl, "--strict"])).status, 0);
    });

    it("exits 1 when the Worker cannot be read, and 64 for a bad call", async () => {
      behaviour = () => ({ status: 500, body: "down" });
      const down = await run(checkScript, { OAUTH_STATUS_ATTEMPTS: "1" }, [baseUrl]);
      assert.equal(down.status, 1);
      assert.match(down.stderr, /Non riesco a leggere/);

      assert.equal((await run(checkScript, {}, ["--nope"])).status, 64);
      assert.equal((await run(checkScript, {}, [baseUrl, "--lang", "fr"])).status, 64);
      assert.equal((await run(checkScript, {}, ["http://example.com"])).status, 64);
    });
  });
});
