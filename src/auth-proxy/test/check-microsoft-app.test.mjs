import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_ALLOWED_REDIRECT_URIS } from "../src/config.js";

const script = fileURLToPath(new URL("../scripts/check-microsoft-app.sh", import.meta.url));
const source = readFileSync(script, "utf8");
const hasBash = spawnSync("bash", ["--version"]).status === 0;
const bashTest = hasBash ? it : it.skip;

const APP_ID = "a80b2024-b9e3-4cb1-8480-aac7f164a6eb";
const GRAPH = "00000003-0000-0000-c000-000000000000";
const MICROSOFT_CALLBACKS = DEFAULT_ALLOWED_REDIRECT_URIS.filter((uri) => uri.endsWith("/auth/microsoft-callback.html"));
const MSAL_POPUP = "https://narrarium.net/msal-popup.html";

// Made-up permission ids: the script must resolve names from `az ad sp show`, never from a built-in table.
const SCOPES = [
  ["11111111-0000-0000-0000-000000000001", "User.Read"],
  ["11111111-0000-0000-0000-000000000002", "Files.ReadWrite"],
  ["11111111-0000-0000-0000-000000000003", "offline_access"],
  ["11111111-0000-0000-0000-000000000004", "openid"],
  ["11111111-0000-0000-0000-000000000005", "profile"],
  ["11111111-0000-0000-0000-000000000006", "Mail.Read"],
];
const idOf = (name) => SCOPES.find(([, value]) => value === name)[0];

// A stand-in for `az` that answers only the read-only calls, from files, and records every call.
const FAKE_AZ = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_AZ_DIR/calls.log"
case "$*" in
  *"ad app show"*signInAudience*) cat "$FAKE_AZ_DIR/audience" ;;
  *"ad app show"*web.redirectUris*) cat "$FAKE_AZ_DIR/web" ;;
  *"ad app show"*spa.redirectUris*) cat "$FAKE_AZ_DIR/spa" ;;
  *"ad app show"*publicClient.redirectUris*) cat "$FAKE_AZ_DIR/public" ;;
  *"ad app show"*requiredResourceAccess*) cat "$FAKE_AZ_DIR/declared" ;;
  *"ad sp show"*) cat "$FAKE_AZ_DIR/scopes" ;;
  *"ad app credential list"*) cat "$FAKE_AZ_DIR/credentials" ;;
  *) echo "unexpected az call: $*" >&2; exit 2 ;;
esac
`;

function setup(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "check-ms-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "az"), FAKE_AZ);
  chmodSync(join(bin, "az"), 0o755);
  const files = {
    audience: "AzureADandPersonalMicrosoftAccount\n",
    web: `${MICROSOFT_CALLBACKS.join("\t")}\n`,
    spa: `${MSAL_POPUP}\n`,
    public: "\n",
    declared: `${["User.Read", "Files.ReadWrite", "offline_access", "openid", "profile"].map(idOf).join("\t")}\n`,
    scopes: `${SCOPES.map((pair) => pair.join("\t")).join("\n")}\n`,
    credentials: "narrarium-worker\t2099-01-01T00:00:00Z\n",
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
  return {
    directory,
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_AZ_DIR: directory, HOME: directory },
    calls: () => (existsSync(join(directory, "calls.log")) ? readFileSync(join(directory, "calls.log"), "utf8") : ""),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function run(sandbox, args = []) {
  const result = spawnSync("bash", [script, ...args], { encoding: "utf8", env: sandbox.env, timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function withSandbox(overrides, body) {
  return () => {
    const sandbox = setup(overrides);
    try {
      body(sandbox);
    } finally {
      sandbox.cleanup();
    }
  };
}

describe("check-microsoft-app.sh", () => {
  bashTest(
    "reports a complete registration as OK and exits 0",
    withSandbox({}, (sandbox) => {
      const result = run(sandbox);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`App registration Microsoft: ${APP_ID}`));
      for (const uri of MICROSOFT_CALLBACKS) assert.ok(result.stdout.includes(`OK        ${uri}`), uri);
      assert.match(result.stdout, /Tutto come previsto/);
      assert.match(result.stdout, /OK: User\.Read, Files\.ReadWrite e offline_access ci sono/);
      assert.ok(result.stdout.includes(MSAL_POPUP), "the SPA URIs are shown");
      assert.match(result.stdout, /narrarium-worker: scade il 2099-01-01T00:00:00Z \(valido\)/);
    }),
  );

  bashTest(
    "says which of the four callback URLs are missing and prints a command that MERGES, without running it",
    withSandbox({ web: `${MICROSOFT_CALLBACKS[0]}\thttps://old.example/keep-me\n` }, (sandbox) => {
      const result = run(sandbox);
      assert.equal(result.status, 3);
      assert.ok(result.stdout.includes(`OK        ${MICROSOFT_CALLBACKS[0]}`));
      for (const uri of MICROSOFT_CALLBACKS.slice(1)) assert.ok(result.stdout.includes(`MANCA     ${uri}`), uri);
      assert.match(result.stdout, /Altri URI Web gia' presenti/);
      const command = result.stdout.split("\n").find((line) => line.includes("az ad app update") && line.includes("--web-redirect-uris"));
      assert.ok(command, "a merge command is printed");
      assert.ok(command.includes("https://old.example/keep-me"), "the existing URI is kept");
      for (const uri of MICROSOFT_CALLBACKS) assert.ok(command.includes(uri), uri);
      assert.doesNotMatch(sandbox.calls(), /ad app update|permission add|credential reset|credential delete|admin-consent/);
    }),
  );

  bashTest(
    "flags a callback registered under Single-page application instead of Web",
    withSandbox({ web: `${MICROSOFT_CALLBACKS.slice(1).join("\t")}\n`, spa: `${MSAL_POPUP}\t${MICROSOFT_CALLBACKS[0]}\n` }, (sandbox) => {
      const result = run(sandbox);
      assert.equal(result.status, 3);
      assert.ok(result.stdout.includes(`SBAGLIATA ${MICROSOFT_CALLBACKS[0]}`));
      assert.match(result.stdout, /24 ore/);
    }),
  );

  bashTest(
    "names the permissions it cannot find, and tells how to add them without admin consent",
    withSandbox({ declared: `${idOf("User.Read")}\t${idOf("Mail.Read")}\n` }, (sandbox) => {
      const result = run(sandbox);
      assert.equal(result.status, 3);
      assert.match(result.stdout, /MANCANO \(necessari\): Files\.ReadWrite offline_access/);
      assert.match(result.stdout, /Mancano \(consigliati[^)]*\): openid profile/);
      assert.match(result.stdout, /^ {4}Mail\.Read$/m, "an extra permission is shown, not hidden");
      assert.match(result.stdout, /az ad app permission add --id .* --api 00000003-0000-0000-c000-000000000000 --api-permissions <ID>=Scope/);
      assert.match(result.stdout, /oauth2PermissionScopes\[\?value=='<NOME>'\]\.id/);
      assert.doesNotMatch(result.stdout, /admin-consent\b(?!')/ , "no admin consent is suggested");
    }),
  );

  bashTest(
    "needs a registration that accepts personal accounts",
    withSandbox({ audience: "AzureADMyOrg\n" }, (sandbox) => {
      const result = run(sandbox);
      assert.equal(result.status, 3);
      assert.match(result.stdout, /DA CORREGGERE: servono gli account personali/);
      assert.match(result.stdout, /--sign-in-audience AzureADandPersonalMicrosoftAccount/);
    }),
  );

  bashTest(
    "shows the expiry of the client secrets and flags an expired or a missing one, never a value",
    withSandbox({ credentials: "old\t2020-01-01T00:00:00Z\nnew\t2099-01-01T00:00:00Z\n" }, (sandbox) => {
      const result = run(sandbox);
      assert.equal(result.status, 3);
      assert.match(result.stdout, /old: scade il 2020-01-01T00:00:00Z \(SCADUTO\)/);
      assert.match(result.stdout, /new: scade il 2099-01-01T00:00:00Z \(valido\)/);
    }),
  );

  bashTest(
    "flags an app with no client secret at all",
    withSandbox({ credentials: "" }, (sandbox) => {
      const result = run(sandbox);
      assert.equal(result.status, 3);
      assert.match(result.stdout, /nessun client secret/);
    }),
  );

  bashTest(
    "only ever asks az for read-only calls",
    withSandbox({}, (sandbox) => {
      run(sandbox);
      const calls = sandbox.calls().trim().split("\n");
      assert.ok(calls.length >= 6);
      for (const call of calls) assert.match(call, /^ad (app show|sp show|app credential list) /, call);
    }),
  );

  bashTest(
    "reads the app id and the callbacks from wrangler.toml, and accepts --app-id",
    withSandbox({}, (sandbox) => {
      run(sandbox);
      assert.ok(sandbox.calls().includes(`--id ${APP_ID}`));
      const other = "22222222-2222-2222-2222-222222222222";
      const result = run(sandbox, ["--app-id", other]);
      assert.match(result.stdout, new RegExp(`App registration Microsoft: ${other}`));
      assert.equal(run(sandbox, ["--app-id", "nope"]).status, 64);
    }),
  );

  bashTest(
    "exits 1 with a hint when az cannot read the app (not signed in), and 127 without az",
    withSandbox({}, (sandbox) => {
      writeFileSync(join(sandbox.directory, "bin", "az"), "#!/bin/sh\necho 'Please run az login to setup account.' >&2\nexit 1\n");
      const failed = run(sandbox);
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /az login --allow-no-subscriptions/);

      const without = spawnSync("bash", [script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: sandbox.directory } });
      assert.equal(without.status, 127);
    }),
  );

  bashTest(
    "refuses an unknown option and prints its documentation with --help",
    withSandbox({}, (sandbox) => {
      assert.equal(run(sandbox, ["--nope"]).status, 64);
      const help = run(sandbox, ["--help"]);
      assert.equal(help.status, 0);
      assert.match(help.stdout, /never changes anything|It never changes anything/);
    }),
  );

  it("is read-only by construction: the source calls only az ad app show, az ad sp show and az ad app credential list", () => {
    const azCalls = [...source.matchAll(/\baz_read ([a-z ]+?) --/g)].map((match) => match[1].trim());
    assert.deepEqual([...new Set(azCalls)].sort(), ["ad app credential list", "ad app show", "ad sp show"]);
    assert.doesNotMatch(source.replace(/^\s*(?:echo|printf)\b.*$/gm, "").replace(/^.*\bdie\b.*$/gm, "").replace(/^#.*$/gm, ""), /\baz (?:ad app (?:update|permission|credential (?:reset|delete))|login)/);
  });

  bashTest("has valid syntax (bash -n)", () => {
    const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });

  const hasShellcheck = spawnSync("shellcheck", ["--version"]).status === 0;
  (hasShellcheck ? it : it.skip)("is clean for shellcheck", () => {
    const result = spawnSync("shellcheck", ["--shell=bash", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout);
  });
});
