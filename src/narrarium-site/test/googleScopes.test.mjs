import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = new URL("../src/", import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(name) && !full.includes(`${path.sep}i18n${path.sep}locales${path.sep}`)) files.push(full);
  }
})(root);
const read = (file) => readFileSync(file, "utf8");
const relative = (file) => path.relative(root, file);

test("the restricted «drive» scope is written in one place only, and never inside a list that a sign-in asks for", () => {
  const offenders = files.filter((file) => /googleapis\.com\/auth\/drive(?![.\w])/.test(read(file)) && relative(file) !== path.join("config", "googleAuth.ts"));
  assert.deepEqual(offenders.map(relative), []);
  const config = read(path.join(root, "config", "googleAuth.ts"));
  const signIn = /GOOGLE_SIGN_IN_SCOPES = \[([^\]]*)\]/.exec(config)?.[1] ?? "";
  assert.match(signIn, /GOOGLE_SCOPE_APPDATA/);
  assert.match(signIn, /GOOGLE_SCOPE_FILE/);
  assert.doesNotMatch(signIn, /FULL_DRIVE/);
});

test("every Google sign-in, connection and silent renewal asks for the default scopes and nothing wider", () => {
  const callers = files.filter((file) => /useGoogleLogin\(/.test(read(file)));
  assert.deepEqual(callers.map(relative).sort(), ["components/auth/AuthGuard.tsx", "components/auth/LoginScreen.tsx", "hooks/useTokenRefresh.ts", "pages/AccountSyncPage.tsx", "pages/MigratePage.tsx"]);
  for (const file of callers) {
    const text = read(file);
    const scopes = [...text.matchAll(/\bscope:\s*([^,\n]+)/g)].map((match) => match[1].trim());
    assert.ok(scopes.length > 0, `${relative(file)} names no scope`);
    for (const scope of scopes) assert.equal(scope, "GOOGLE_SIGN_IN_SCOPES", `${relative(file)}: ${scope}`);
    assert.match(text, /from "@\/config\/googleAuth"/);
  }
});

test("the only other request for a Google scope is the incremental one, and it is opened by a person's choice", () => {
  const consumers = files.filter((file) => /requestGoogleScope\(/.test(read(file)) && relative(file) !== path.join("account", "googleScopeConsent.ts"));
  assert.deepEqual(consumers.map(relative), ["components/auth/GoogleFullAccessNotice.tsx"]);
  const notice = read(consumers[0]);
  assert.match(notice, /requestGoogleScope\(GOOGLE_SCOPE_FULL_DRIVE/);
  // It runs from the button, never when the notice appears.
  assert.doesNotMatch(notice, /useEffect/);
});
