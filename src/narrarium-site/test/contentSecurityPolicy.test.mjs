import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { APP_CONTENT_SECURITY_POLICY, CSP_PLACEHOLDER, FRAME_SOURCES } from "../csp.ts";

/** @param {string} policy @returns {Map<string, string[]>} */
function parsePolicy(policy) {
  const directives = new Map();
  for (const part of policy.split(";").map((value) => value.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/);
    assert.ok(!directives.has(name), `${name} is written once`);
    directives.set(name, sources);
  }
  return directives;
}

const policy = parsePolicy(APP_CONTENT_SECURITY_POLICY);
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the app shell lets every sign-in frame it needs load: Google, Microsoft work and school, Microsoft personal accounts", () => {
  const frames = policy.get("frame-src");
  assert.ok(frames, "frame-src is set");
  for (const host of ["https://accounts.google.com", "https://login.microsoftonline.com", "https://login.live.com"]) {
    assert.ok(frames.includes(host), `${host} may be framed (MSAL's silent renewal of a personal account loads login.live.com)`);
  }
  assert.deepEqual(frames, [...FRAME_SOURCES]);
  assert.deepEqual([...frames].sort(), ["'self'", "https://accounts.google.com", "https://login.live.com", "https://login.microsoftonline.com"]);
});

test("the policy allows nothing it does not need", () => {
  const everySource = [...policy.values()].flat();
  assert.ok(!everySource.some((source) => source.includes("*") && !/^http:\/\/(?:127\.0\.0\.1|localhost):\*$/.test(source)), "no wildcard host");
  assert.ok(!everySource.includes("'unsafe-eval'"));
  assert.deepEqual(policy.get("script-src"), ["'self'", "'unsafe-inline'", "https://accounts.google.com"], "the one inline script is the theme bootstrap; no new inline or remote source");
  assert.deepEqual(policy.get("style-src"), ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(policy.get("default-src"), ["'self'"]);
  assert.deepEqual(policy.get("object-src"), ["'none'"]);
  assert.deepEqual(policy.get("form-action"), ["'none'"]);
  assert.deepEqual(policy.get("base-uri"), ["'self'"]);
  assert.ok(policy.has("upgrade-insecure-requests"));
  assert.ok(!policy.has("child-src"), "child-src would override frame-src and worker-src");
});

test("the token endpoints and the Graph and Google APIs are requests that connect-src already covers", () => {
  const connect = policy.get("connect-src");
  assert.ok(connect.includes("https:"), "login.microsoftonline.com, login.live.com, graph.microsoft.com and the Google endpoints are https");
  assert.ok(connect.includes("'self'"));
});

test("every HTML page of the site that has a policy has the one policy, or the locked-down one of the broker callback", async () => {
  const index = await read("../index.html");
  const metas = [...index.matchAll(/http-equiv="Content-Security-Policy" content="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(metas, [CSP_PLACEHOLDER], "index.html carries the placeholder, not a copy of the policy");
  const vite = await read("../vite.config.ts");
  assert.match(vite, /APP_CONTENT_SECURITY_POLICY/);
  assert.match(vite, /replaceAll\(CSP_PLACEHOLDER, APP_CONTENT_SECURITY_POLICY\)/);

  const callback = await read("../auth/microsoft-callback.html");
  assert.match(callback, /default-src 'none'/);
  assert.doesNotMatch(callback, /frame-src/);
  const popup = await read("../msal-popup.html");
  assert.doesNotMatch(popup, /Content-Security-Policy/, "the MSAL popup page has no policy of its own; it frames nothing");
});

test("no copy of the policy lives anywhere else in the site, the worker or the host configuration", async () => {
  for (const path of ["../public/sw.js", "../../../vercel.json", "../scripts/write-spa-fallback.mjs", "../scripts/generate-precache.mjs"]) {
    const text = await read(path).catch(() => "");
    assert.doesNotMatch(text, /frame-src|Content-Security-Policy/, path);
  }
});

/** Runs the build's policy check on a site whose index.html carries `policy`. */
async function checkBuiltPolicy(policy) {
  const root = await mkdtemp(path.join(tmpdir(), "narrarium-csp-"));
  try {
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "dist"));
    await cp(new URL("../scripts/assert-content-security-policy.mjs", import.meta.url), path.join(root, "scripts", "assert-content-security-policy.mjs"));
    await writeFile(path.join(root, "dist", "index.html"), `<html><head><meta http-equiv="Content-Security-Policy" content="${policy}" /></head></html>`);
    const run = spawnSync(process.execPath, [path.join(root, "scripts", "assert-content-security-policy.mjs")], { encoding: "utf8", env: { ...process.env, NARRARIUM_E2E_BUILD: "" } });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the build stops when the built policy no longer lets the Microsoft personal-account sign-in frame load", async () => {
  assert.equal((await checkBuiltPolicy(APP_CONTENT_SECURITY_POLICY)).status, 0);
  const without = APP_CONTENT_SECURITY_POLICY.replace(" https://login.live.com", "");
  const stopped = await checkBuiltPolicy(without);
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.output, /login\.live\.com/);
  assert.notEqual((await checkBuiltPolicy(APP_CONTENT_SECURITY_POLICY.replace("https://login.live.com", "%NARRARIUM_CSP%"))).status, 0, "an unfilled placeholder stops the build");
  assert.notEqual((await checkBuiltPolicy(`${APP_CONTENT_SECURITY_POLICY}; script-src 'unsafe-eval'`)).status, 0);
});

test("the production build runs that check", async () => {
  const pkg = JSON.parse(await read("../package.json"));
  assert.match(pkg.scripts.build, /node scripts\/assert-content-security-policy\.mjs$/);
});
