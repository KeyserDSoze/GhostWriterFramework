import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_REDIRECT_URIS } from "../src/config.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const FILES = {
  italian: join(root, "src", "auth-proxy", "docs", "guida-auth-proxy.it.md"),
  english: join(root, "src", "auth-proxy", "docs", "auth-proxy-setup.en.md"),
  readme: join(root, "src", "auth-proxy", "README.md"),
};
const text = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, readFileSync(file, "utf8")]));

const GITHUB_CALLBACKS = DEFAULT_ALLOWED_REDIRECT_URIS.filter((uri) => uri.endsWith("/auth/github/callback"));
const MICROSOFT_CALLBACKS = DEFAULT_ALLOWED_REDIRECT_URIS.filter((uri) => uri.endsWith("/auth/microsoft-callback.html"));

describe("the owner's guides", () => {
  it("exist in Italian and English, link to each other, and are linked from the Worker README", () => {
    assert.match(text.italian, /\(auth-proxy-setup\.en\.md\)/);
    assert.match(text.english, /\(guida-auth-proxy\.it\.md\)/);
    assert.match(text.italian, /\.\.\/README\.md/);
    assert.match(text.readme, /docs\/guida-auth-proxy\.it\.md/);
    assert.match(text.readme, /docs\/auth-proxy-setup\.en\.md/);
  });

  it("have local links that resolve", () => {
    for (const [key, file] of Object.entries(FILES)) {
      for (const [, target] of text[key].matchAll(/\]\((?!https?:|#|mailto:)([^)\s#]+)(?:#[^)]*)?\)/g)) {
        assert.ok(existsSync(resolve(dirname(file), target)), `${key}: ${target}`);
      }
    }
  });

  it("list the exact callback URLs the Worker allows, for GitHub (four) and Microsoft (four)", () => {
    assert.equal(GITHUB_CALLBACKS.length, 4);
    assert.equal(MICROSOFT_CALLBACKS.length, 4);
    for (const key of ["italian", "english"]) {
      for (const uri of [...GITHUB_CALLBACKS, ...MICROSOFT_CALLBACKS]) assert.ok(text[key].includes(uri), `${key}: ${uri}`);
    }
  });

  it("list the Google JavaScript origins the Worker allows", () => {
    for (const key of ["italian", "english"]) {
      for (const origin of DEFAULT_ALLOWED_ORIGINS) assert.ok(text[key].includes(`\`${origin}\``) || text[key].includes(origin), `${key}: ${origin}`);
    }
  });

  it("walk the move in the required order: merge, deploy, secrets, status, variable, real test, delete the old Worker last", () => {
    for (const key of ["italian", "english"]) {
      const positions = [
        "deploy-auth-proxy.yml",
        "set-secrets.sh",
        "check-status.mjs",
        "gh variable set VITE_GITHUB_MODELS_BASE",
        "cf workers delete models-github-proxy",
      ].map((needle) => text[key].indexOf(needle));
      assert.ok(positions.every((position) => position >= 0), `${key}: ${positions}`);
      assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${key}: the steps are in order`);
      assert.ok(text[key].includes("npx wrangler delete models-github-proxy"), `${key}: the Wrangler equivalent`);
    }
  });

  it("name the settings and commands the plan requires", () => {
    for (const key of ["italian", "english"]) {
      for (const expected of [
        "GH_APP_CLIENT_SECRET",
        "GITHUB_APP_CLIENT_SECRET",
        "GITHUB_APP_CLIENT_ID",
        "check-microsoft-app.sh",
        "/oauth/status",
        "Expire user authorization tokens",
        "Repository creation",
        "In production",
        "drive.appdata",
        "User.Read",
        "Files.ReadWrite",
        "offline_access",
        "--sign-in-audience",
        "--web-redirect-uris",
        "az ad app permission add",
        "gcloud services enable drive.googleapis.com",
        "cf auth login",
        "cf accounts tokens permission-groups list",
        "cf accounts tokens create",
        "cf migrate",
        "npx wrangler tail",
        "cf observability tail",
        "OAUTH_RATE_LIMITER",
        "auth.narrarium.net",
        "workers.dev",
        "gh secret set",
      ]) {
        assert.ok(text[key].includes(expected), `${key} mentions ${expected}`);
      }
    }
  });

  it("correct the proposed procedure explicitly", () => {
    for (const key of ["italian", "english"]) {
      const value = text[key];
      assert.match(value, /account-wide/, `${key}: Workers Scripts Write is account-wide`);
      assert.match(value, /unmigrated|non migrato/, `${key}: never cf dev|build|deploy unmigrated`);
      assert.match(value, /OAUTH_RATE_LIMITER[^]*già|already/i, `${key}: the rate-limit binding already exists`);
      assert.match(value, /--append/, `${key}: credential reset needs --append`);
      assert.match(value, /replaces the whole list|sostituisce l'intera lista/, `${key}: --web-redirect-uris replaces`);
      assert.match(value, /Workers Logs/, `${key}: cf observability tail needs Workers Logs`);
      assert.doesNotMatch(value, /enabled\s*=\s*false/, `${key}: the Worker's observability is not changed`);
    }
  });

  it("never tell the owner to pass a secret as an argument", () => {
    for (const key of ["italian", "english"]) {
      for (const line of text[key].split("\n")) {
        if (/cf workers secrets update/.test(line)) assert.match(line, /NON usare|Non usare|forbidden|vietato|argument|argomento/i, `${key}: ${line}`);
      }
      assert.doesNotMatch(text[key], /gh secret set [A-Z_]+ (?:--body|-b)\b/, key);
      assert.doesNotMatch(text[key], /CLOUDFLARE_API_TOKEN=\S/, key);
    }
  });

  it("have a Verifica line per step in the Italian guide, and cite official sources in both", () => {
    assert.ok((text.italian.match(/\*\*Verifica:?\*\*/g) ?? []).length >= 14);
    for (const key of ["italian", "english"]) {
      for (const host of ["developers.cloudflare.com", "docs.github.com", "learn.microsoft.com", "developers.google.com", "cloud.google.com"]) {
        assert.ok(text[key].includes(host), `${key} cites ${host}`);
      }
      assert.match(text[key], /23 novembre 2026|2026-11-23/);
    }
    assert.match(text.italian, /Non verificato/);
    assert.match(text.english, /Not verified/);
  });

  it("never contain a secret", () => {
    const patterns = [/GOCSPX-[A-Za-z0-9_-]{10,}/, /\bgh[pousr]_[A-Za-z0-9]{36,}/, /cfut_[A-Za-z0-9]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b[A-Za-z0-9_.~-]{3}[0-9]Q~[A-Za-z0-9_.~-]{25,}/];
    for (const [key, value] of Object.entries(text)) {
      for (const pattern of patterns) assert.doesNotMatch(value, pattern, `${key}: ${pattern}`);
    }
  });

  it("live in src/auth-proxy/docs, not in docs/, which the site publishes as its public documents", () => {
    for (const name of readdirSync(join(root, "docs"))) {
      assert.doesNotMatch(name, /guida-auth-proxy|auth-proxy-setup|guida-cloudflare|cloudflare-and-sign-in/, name);
    }
  });
});

describe("no leftover mention of the old location or name", () => {
  const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git", ".wrangler", "coverage"]);
  function walk(directory) {
    const files = [];
    for (const name of readdirSync(directory)) {
      if (SKIP_DIRECTORIES.has(name)) continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) files.push(...walk(path));
      else files.push(path);
    }
    return files;
  }

  it("keeps `models-github-proxy` only where it is deliberate, and `infra/` nowhere in the Worker, workflow or public docs", () => {
    const worker = join(root, "src", "auth-proxy");
    const allowedName = new Set([
      join(worker, "README.md"),
      join(worker, "wrangler.toml"),
      join(worker, "docs", "guida-auth-proxy.it.md"),
      join(worker, "docs", "auth-proxy-setup.en.md"),
      join(worker, "test", "docs.test.mjs"),
      join(worker, "test", "deploy-workflow.test.mjs"),
      join(worker, "test", "config.test.mjs"),
    ]);
    for (const file of [...walk(worker), join(root, ".github", "workflows", "deploy-auth-proxy.yml"), join(root, "docs", "auth-session-persistence.md"), join(root, "docs", "github-oauth-static-client.md")]) {
      const content = readFileSync(file, "utf8");
      if (/models-github-proxy/.test(content)) assert.ok(allowedName.has(file), `the old Worker name appears in ${file}`);
      // The guides name the old folder once, deliberately, in the migration section.
      if (!file.includes(join("src", "auth-proxy", "docs"))) assert.doesNotMatch(content, /infra\/(?:models-github-proxy|\*\*)/, `the old path appears in ${file}`);
    }
  });
});
