import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));

async function files(directory, accept) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(target, accept));
    else if (accept(target)) found.push(target);
  }
  return found;
}

// The browser never holds a GitHub client secret and never sends one to github.com: the app's secret lives in the Cloudflare Worker.
const FORBIDDEN = [/GITHUB_OAUTH_CLIENT_SECRET/, /CLIENT_SECRET_B64X3/, /decodeGitHubClientSecret/, /client_secret\s*[:=]/, /exchangeGitHubOAuthCode/];

test("no source file of the site carries a GitHub client secret, or a path that sends one", async () => {
  const sources = await files(path.join(siteRoot, "src"), (file) => /\.(?:ts|tsx)$/.test(file) && !/generated-docs\.ts$/.test(file) && !/[\\/]i18n[\\/]/.test(file));
  assert.ok(sources.length > 100);
  for (const file of sources) {
    const text = await readFile(file, "utf8");
    for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, `${path.relative(siteRoot, file)}: ${pattern}`);
  }
});

test("no source file posts to github.com's token endpoint", async () => {
  for (const file of await files(path.join(siteRoot, "src"), (target) => /\.(?:ts|tsx)$/.test(target) && !/[\\/]i18n[\\/]/.test(target))) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /login\/oauth\/access_token/, path.relative(siteRoot, file));
    assert.doesNotMatch(text, /login\/device\/code/, path.relative(siteRoot, file));
  }
});

test("the build has no GitHub client secret string either (when it was built)", async () => {
  const dist = path.join(siteRoot, "dist", "assets");
  const present = await stat(dist).then((entry) => entry.isDirectory(), () => false);
  if (!present) return;
  // The chunks of the documentation say the words «client secret» about OAuth in general; the code chunks must not.
  const code = await files(dist, (file) => file.endsWith(".js") && !/[\\/](?:doc-|generated-docs)/.test(file));
  assert.ok(code.length > 20);
  for (const file of code) {
    const text = await readFile(file, "utf8");
    for (const pattern of [/CLIENT_SECRET_B64X3/, /VITE_GITHUB_OAUTH_CLIENT_SECRET/, /login\/oauth\/access_token/, /login\/device\/code/]) assert.doesNotMatch(text, pattern, `${path.relative(siteRoot, file)}: ${pattern}`);
  }
});

test("the public build settings name the app's client id and its URL name, and no secret", async () => {
  const clients = await readFile(path.join(siteRoot, "src", "config", "publicClients.ts"), "utf8");
  assert.match(clients, /VITE_GITHUB_APP_CLIENT_ID/);
  assert.match(clients, /VITE_GITHUB_APP_SLUG/);
  assert.doesNotMatch(clients, /import\.meta\.env\.[A-Z_]*SECRET/);
  const env = await readFile(path.join(siteRoot, "src", "vite-env.d.ts"), "utf8");
  assert.doesNotMatch(env, /SECRET/);
});
