import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_REDIRECT_URIS } from "../src/config.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const FILES = {
  italian: join(root, "infra", "models-github-proxy", "docs", "guida-cloudflare-e-accessi.it.md"),
  english: join(root, "infra", "models-github-proxy", "docs", "cloudflare-and-sign-in-setup.en.md"),
  readme: join(root, "infra", "models-github-proxy", "README.md"),
};
const text = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, readFileSync(file, "utf8")]));

const GITHUB_CALLBACKS = DEFAULT_ALLOWED_REDIRECT_URIS.filter((uri) => uri.endsWith("/auth/github/callback"));
const MICROSOFT_CALLBACKS = DEFAULT_ALLOWED_REDIRECT_URIS.filter((uri) => uri.endsWith("/auth/microsoft-callback.html"));

describe("the owner's guides", () => {
  it("exist in Italian and English and link to each other and to the Worker README", () => {
    assert.match(text.italian, /\(cloudflare-and-sign-in-setup\.en\.md\)/);
    assert.match(text.english, /\(guida-cloudflare-e-accessi\.it\.md\)/);
    assert.match(text.italian, /infra\/models-github-proxy\/README\.md/);
    assert.match(text.readme, /docs\/guida-cloudflare-e-accessi\.it\.md/);
    assert.match(text.readme, /docs\/cloudflare-and-sign-in-setup\.en\.md/);
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
      for (const origin of DEFAULT_ALLOWED_ORIGINS) assert.ok(text[key].includes(`\`${origin}\``), `${key}: ${origin}`);
    }
  });

  it("name the settings the plan requires", () => {
    for (const key of ["italian", "english"]) {
      for (const expected of [
        "GH_APP_CLIENT_SECRET",
        "GITHUB_APP_CLIENT_SECRET",
        "GITHUB_APP_CLIENT_ID",
        "set-secrets.sh",
        "check-status.mjs",
        "gh workflow run deploy-worker.yml",
        "/oauth/status",
        "Expire user authorization tokens",
        "Repository creation",
        "Workflows",
        "In production",
        "drive.appdata",
        "User.Read",
        "Files.ReadWrite",
        "offline_access",
        "workers.dev",
        "auth.narrarium.net",
        "OAUTH_RATE_LIMITER",
        "24 months",
      ]) {
        assert.ok(text[key].includes(expected), `${key} mentions ${expected}`);
      }
    }
  });

  it("have a Verifica line per step in the Italian guide, and cite official sources in both", () => {
    assert.ok((text.italian.match(/\*\*Verifica:?\*\*/g) ?? []).length >= 12);
    for (const key of ["italian", "english"]) {
      for (const host of ["developers.cloudflare.com", "docs.github.com", "learn.microsoft.com", "developers.google.com"]) {
        assert.ok(text[key].includes(host), `${key} cites ${host}`);
      }
      assert.match(text[key], /23 novembre 2026|2026-11-23/);
    }
    assert.match(text.italian, /Cosa non ho potuto verificare/);
    assert.match(text.english, /Not verified/);
  });

  it("never contain a secret, and never tell the owner to paste one on a command line", () => {
    const patterns = [/GOCSPX-[A-Za-z0-9_-]{10,}/, /\bgh[pousr]_[A-Za-z0-9]{36,}/, /cfut_[A-Za-z0-9]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b[A-Za-z0-9_.~-]{3}[0-9]Q~[A-Za-z0-9_.~-]{25,}/];
    for (const [key, value] of Object.entries(text)) {
      for (const pattern of patterns) assert.doesNotMatch(value, pattern, `${key}: ${pattern}`);
      assert.doesNotMatch(value, /gh secret set [A-Z_]+ (?:--body|-b)\b/, key);
      assert.doesNotMatch(value, /CLOUDFLARE_API_TOKEN=\S/, key);
    }
  });

  it("live outside docs/, which the site publishes as its public documents", () => {
    assert.ok(!existsSync(join(root, "docs", "guida-cloudflare-e-accessi.it.md")));
    assert.ok(!existsSync(join(root, "docs", "cloudflare-and-sign-in-setup.en.md")));
  });
});
