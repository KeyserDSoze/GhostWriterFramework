import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_REDIRECT_URIS } from "../src/config.js";

const workerDir = fileURLToPath(new URL("../", import.meta.url));
const read = (name) => readFileSync(join(workerDir, name), "utf8");

// The public client ids already published in src/narrarium-site/src/config/publicClients.ts.
const PUBLIC_GOOGLE_CLIENT_ID = "91477716497-k7n97b2q9ic3nc75jpjmb0d3f73s1vgu.apps.googleusercontent.com";
const PUBLIC_MICROSOFT_CLIENT_ID = "a80b2024-b9e3-4cb1-8480-aac7f164a6eb";

function readVars(toml) {
  const vars = {};
  let inVars = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inVars = line === "[vars]";
      continue;
    }
    if (!inVars || line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(line);
    assert.ok(match, `unparseable [vars] line: ${line}`);
    vars[match[1]] = match[2];
  }
  return vars;
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".wrangler", "dist"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

describe("wrangler.toml", () => {
  const toml = read("wrangler.toml");
  const vars = readVars(toml);

  it("keeps the existing Worker settings", () => {
    assert.match(toml, /^name = "models-github-proxy"$/m);
    assert.match(toml, /^main = "src\/index\.js"$/m);
    assert.match(toml, /^workers_dev = true$/m);
  });

  it("declares the two public client ids", () => {
    assert.equal(vars.GOOGLE_CLIENT_ID, PUBLIC_GOOGLE_CLIENT_ID);
    assert.equal(vars.MICROSOFT_CLIENT_ID, PUBLIC_MICROSOFT_CLIENT_ID);
  });

  it("lists the same redirect URIs the code defaults to", () => {
    assert.deepEqual(vars.ALLOWED_REDIRECT_URIS.split(",").map((entry) => entry.trim()), DEFAULT_ALLOWED_REDIRECT_URIS);
    assert.deepEqual(DEFAULT_ALLOWED_REDIRECT_URIS, [
      "https://narrarium.net/auth/microsoft-callback.html",
      "https://www.narrarium.net/auth/microsoft-callback.html",
      "http://localhost:5173/auth/microsoft-callback.html",
      "http://localhost:4173/auth/microsoft-callback.html",
    ]);
  });

  it("declares the optional ALLOWED_ORIGINS_EXTRA, empty by default", () => {
    assert.equal(Object.hasOwn(vars, "ALLOWED_ORIGINS_EXTRA"), true);
    assert.equal(vars.ALLOWED_ORIGINS_EXTRA, "");
    assert.deepEqual(DEFAULT_ALLOWED_ORIGINS, [
      "https://narrarium.net",
      "https://www.narrarium.net",
      "http://localhost:5173",
      "http://localhost:4173",
    ]);
  });

  it("never holds a secret: the client secrets come only from the Worker environment", () => {
    for (const name of Object.keys(vars)) {
      assert.doesNotMatch(name, /SECRET|PASSWORD|TOKEN|PRIVATE|KEY/i, `[vars] ${name}`);
    }
    const uncommented = toml.split(/\r?\n/).filter((line) => !line.trim().startsWith("#"));
    assert.equal(uncommented.some((line) => /CLIENT_SECRET\s*=/.test(line)), false);
  });
});

describe("package.json", () => {
  const manifest = JSON.parse(read("package.json"));

  it("runs the suite with the built-in test runner and no dependency", () => {
    assert.equal(manifest.scripts.test, "node --test test/*.test.mjs");
    assert.equal(manifest.type, "module");
    assert.equal(manifest.dependencies, undefined);
    assert.deepEqual(Object.keys(manifest.devDependencies), ["wrangler"]);
  });

  it("keeps the dev and deploy scripts", () => {
    assert.equal(manifest.scripts.dev, "wrangler dev");
    assert.equal(manifest.scripts.deploy, "wrangler deploy");
  });
});

describe("no secret is committed with the Worker", () => {
  const files = listFiles(workerDir);

  it("contains no Google or Microsoft client secret, and no private key", () => {
    const patterns = {
      "Google client secret": /GOCSPX-[A-Za-z0-9_-]{20,}/,
      "Microsoft client secret value": /\b[A-Za-z0-9_.~-]{3}[0-9]Q~[A-Za-z0-9_.~-]{25,}/,
      "private key": /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    };
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const [label, pattern] of Object.entries(patterns)) {
        assert.doesNotMatch(text, pattern, `${label} in ${relative(workerDir, file)}`);
      }
    }
  });

  it("has no .dev.vars file and ignores it", () => {
    assert.equal(existsSync(join(workerDir, ".dev.vars")), false);
    assert.match(read(".gitignore"), /^\.dev\.vars$/m);
  });
});

describe("README.md", () => {
  const readme = read("README.md");

  it("documents the broker: contract, security model and the owner's steps", () => {
    for (const expected of [
      "Broker OAuth",
      "/oauth/status",
      "/oauth/google/token",
      "/oauth/microsoft/refresh",
      "ALLOWED_REDIRECT_URIS",
      "ALLOWED_ORIGINS_EXTRA",
      "GOOGLE_CLIENT_SECRET",
      "MICROSOFT_CLIENT_SECRET",
      "gh secret set GOOGLE_OAUTH_CLIENT_SECRET",
      "gh secret set MICROSOFT_OAUTH_CLIENT_SECRET",
      "gh workflow run deploy-worker.yml",
      "wrangler secret delete",
    ]) {
      assert.ok(readme.includes(expected), `the README mentions ${expected}`);
    }
  });

  it("tells the site to add client_info=1 to the Microsoft authorization request", () => {
    assert.match(readme, /client_info=1/);
    assert.match(readme, /clientInfo/);
    assert.match(readme, /homeAccountId/);
  });

  it("says that CORS is not authentication and that the rate limit is only best effort", () => {
    assert.match(readme, /CORS is (?:a browser-side guard, )?not authentication/i);
    assert.match(readme, /best[- ]effort/i);
  });
});
