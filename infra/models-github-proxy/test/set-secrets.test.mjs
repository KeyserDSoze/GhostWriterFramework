import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/set-secrets.sh", import.meta.url));
const source = readFileSync(script, "utf8");

const hasBash = spawnSync("bash", ["--version"]).status === 0;
const bashTest = hasBash ? it : it.skip;

// Obviously fake values.
const GOOGLE = "GOCSPX-FAKE-google";
const GITHUB = "0123456789abcdef0123456789abcdef01234567-FAKE";
const MICROSOFT = "mS~8Q~FAKE-microsoft";
const MICROSOFT_SECRET_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

// A gh that records its arguments and what `secret set` receives on stdin, and never touches the network.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/args.log"
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo view") echo "me/book"; exit 0 ;;
  "secret list") echo "SOME_OTHER_SECRET"; exit 0 ;;
  "secret set") cat > "$FAKE_GH_DIR/stdin-$3"; echo "ok"; exit 0 ;;
  "workflow run") touch "$FAKE_GH_DIR/dispatched"; exit 0 ;;
  "run list")
    if [ -f "$FAKE_GH_DIR/dispatched" ]; then echo 101; else echo 100; fi
    exit 0 ;;
esac
exit 0
`;

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "set-secrets-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);
  return {
    directory,
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_GH_DIR: directory,
      SET_SECRETS_POLL_SECONDS: "0",
      HOME: directory,
    },
    log: () => (existsSync(join(directory, "args.log")) ? readFileSync(join(directory, "args.log"), "utf8") : ""),
    stdinOf: (name) => {
      const file = join(directory, `stdin-${name}`);
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function run(args, { input = "", env = {}, sandbox } = {}) {
  const result = spawnSync("bash", [script, ...args], { input, encoding: "utf8", env: { ...sandbox.env, ...env }, timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function withSandbox(body) {
  return () => {
    const sandbox = setup();
    try {
      body(sandbox);
    } finally {
      sandbox.cleanup();
    }
  };
}

const QUIET = ["--stdin", "--repo", "me/book", "--no-deploy", "--no-check"];

describe("set-secrets.sh --dry-run", () => {
  bashTest(
    "describes every step, asks nothing and calls neither gh nor the network",
    withSandbox((sandbox) => {
      const result = run(["--dry-run", "--repo", "me/book"], { sandbox });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\[dry-run\]/);
      for (const name of ["GOOGLE_OAUTH_CLIENT_SECRET", "MICROSOFT_OAUTH_CLIENT_SECRET", "GH_APP_CLIENT_SECRET"]) {
        assert.ok(result.stdout.includes(`gh secret set ${name} --repo me/book`), name);
      }
      assert.match(result.stdout, /gh workflow run deploy-worker\.yml --repo me\/book/);
      assert.match(result.stdout, /gh run watch .* --exit-status/);
      assert.match(result.stdout, /check-status\.mjs/);
      assert.equal(sandbox.log(), "", "gh was not called");
    }),
  );

  bashTest(
    "works without gh installed and without --repo, and honours --no-deploy and --no-check",
    withSandbox((sandbox) => {
      const result = run(["--dry-run", "--no-deploy", "--no-check"], { sandbox, env: { PATH: "/usr/bin:/bin" } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Non lancerei il deploy/);
      assert.doesNotMatch(result.stdout, /check-status/);
    }),
  );

  bashTest(
    "refuses an unknown option and a malformed repository",
    withSandbox((sandbox) => {
      assert.equal(run(["--dry-run", "--nope"], { sandbox }).status, 64);
      assert.equal(run(["--dry-run", "--repo", "not a repo"], { sandbox }).status, 64);
      assert.equal(run(["--dry-run", "--repo"], { sandbox }).status, 64);
    }),
  );

  bashTest(
    "prints its own documentation with --help",
    withSandbox((sandbox) => {
      const result = run(["--help"], { sandbox });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /HIDDEN input/);
      assert.match(result.stdout, /--dry-run/);
    }),
  );
});

describe("set-secrets.sh (with a fake gh)", () => {
  bashTest(
    "sets only the secrets that were given, through stdin, and never prints or passes a value",
    withSandbox((sandbox) => {
      const result = run(QUIET, { input: `${GOOGLE}\n\n${GITHUB}\n`, sandbox });
      assert.equal(result.status, 0, result.stderr);

      assert.equal(sandbox.stdinOf("GOOGLE_OAUTH_CLIENT_SECRET"), GOOGLE, "the value is read from stdin, without a newline");
      assert.equal(sandbox.stdinOf("GH_APP_CLIENT_SECRET"), GITHUB);
      assert.equal(sandbox.stdinOf("MICROSOFT_OAUTH_CLIENT_SECRET"), null, "a skipped secret is not set");

      const log = sandbox.log();
      assert.match(log, /^secret set GOOGLE_OAUTH_CLIENT_SECRET --repo me\/book$/m);
      assert.match(log, /^secret set GH_APP_CLIENT_SECRET --repo me\/book$/m);
      assert.doesNotMatch(log, /secret set MICROSOFT_OAUTH_CLIENT_SECRET/);
      for (const secret of [GOOGLE, GITHUB]) {
        assert.ok(!log.includes(secret), "no value on any gh command line");
        assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret), "no value on the screen");
      }
      assert.doesNotMatch(log, /--body|-b /);
      assert.match(result.stderr, /MICROSOFT_OAUTH_CLIENT_SECRET: saltato/);
      assert.match(result.stderr, /Segreti impostati ora: 2/);
      assert.doesNotMatch(log, /workflow run/, "no deploy without being asked");
    }),
  );

  bashTest(
    "trims spaces and a Windows carriage return from a pasted value",
    withSandbox((sandbox) => {
      run(QUIET, { input: `  ${GOOGLE}\r\n\n\n`, sandbox });
      assert.equal(sandbox.stdinOf("GOOGLE_OAUTH_CLIENT_SECRET"), GOOGLE);
    }),
  );

  bashTest(
    "does not upload a Microsoft Secret ID, which is not the secret's value",
    withSandbox((sandbox) => {
      const result = run(QUIET, { input: `\n${MICROSOFT_SECRET_ID}\n\n`, sandbox });
      assert.equal(result.status, 0);
      assert.equal(sandbox.stdinOf("MICROSOFT_OAUTH_CLIENT_SECRET"), null);
      assert.match(result.stderr, /ID del segreto/);

      const real = run(QUIET, { input: `\n${MICROSOFT}\n\n`, sandbox });
      assert.equal(real.status, 0);
      assert.equal(sandbox.stdinOf("MICROSOFT_OAUTH_CLIENT_SECRET"), MICROSOFT);
    }),
  );

  bashTest(
    "finds the repository with gh when --repo is not given",
    withSandbox((sandbox) => {
      run(["--stdin", "--no-deploy", "--no-check"], { input: `${GOOGLE}\n\n\n`, sandbox });
      assert.match(sandbox.log(), /^repo view /m);
      assert.match(sandbox.log(), /^secret set GOOGLE_OAUTH_CLIENT_SECRET --repo me\/book$/m);
    }),
  );

  bashTest(
    "with --deploy starts the workflow, waits for the new run and watches it",
    withSandbox((sandbox) => {
      const result = run(["--stdin", "--repo", "me/book", "--deploy", "--no-check"], { input: `${GOOGLE}\n\n\n`, sandbox });
      assert.equal(result.status, 0, result.stderr);
      const log = sandbox.log();
      assert.match(log, /^workflow run deploy-worker\.yml --repo me\/book$/m);
      assert.match(log, /^run watch 101 --repo me\/book --exit-status$/m);
      assert.ok(log.indexOf("secret set") < log.indexOf("workflow run"), "the secrets are set before the deploy");
    }),
  );

  bashTest(
    "needs a terminal for the hidden prompt unless --stdin is used",
    withSandbox((sandbox) => {
      const result = run(["--repo", "me/book", "--no-deploy", "--no-check"], { input: `${GOOGLE}\n`, sandbox });
      assert.equal(result.status, 64);
      assert.equal(sandbox.stdinOf("GOOGLE_OAUTH_CLIENT_SECRET"), null);
      assert.ok(!result.stdout.includes(GOOGLE) && !result.stderr.includes(GOOGLE));
    }),
  );

  bashTest(
    "stops when gh cannot set a secret",
    withSandbox((sandbox) => {
      writeFileSync(join(sandbox.directory, "bin", "gh"), '#!/bin/sh\ncase "$1 $2" in "secret set") cat >/dev/null; exit 1 ;; esac\nexit 0\n');
      const result = run(QUIET, { input: `${GOOGLE}\n\n\n`, sandbox });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Errore: gh secret set GOOGLE_OAUTH_CLIENT_SECRET non e' riuscito/);
      assert.ok(!result.stdout.includes(GOOGLE) && !result.stderr.includes(GOOGLE));
    }),
  );
});

describe("set-secrets.sh: final check", () => {
  let server;
  let baseUrl;
  before(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ google: true, microsoft: false, github: false }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  // spawnSync would block this process, and with it the fake Worker: the script is run asynchronously.
  function runAsync(sandbox, args, input) {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [script, ...args], { env: { ...sandbox.env, WORKER_BASE_URL: baseUrl, OAUTH_STATUS_DELAY_MS: "0" }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  bashTest("prints the status of the live Worker in words at the end", async () => {
    const sandbox = setup();
    try {
      const result = await runAsync(sandbox, ["--stdin", "--repo", "me/book", "--no-deploy"], "\n\n\n");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Google: configurato/);
      assert.match(result.stdout, /Microsoft: NON configurato\. Imposta il secret MICROSOFT_OAUTH_CLIENT_SECRET/);
      assert.match(result.stdout, /GitHub: NON configurato/);
    } finally {
      sandbox.cleanup();
    }
  });
});

describe("set-secrets.sh: the source", () => {
  it("reads secrets hidden and passes them through stdin only", () => {
    assert.match(source, /^#!\/usr\/bin\/env bash$/m);
    assert.match(source, /read -rs /);
    assert.match(source, /printf '%s' "\$secret_value" \| gh secret set "\$name" --repo "\$repo"/);
    assert.doesNotMatch(source, /--body|gh secret set [^\n]*\$secret_value/);
    assert.doesNotMatch(source, /\becho\b[^\n]*\$secret_value/);
    assert.doesNotMatch(source, /set -x|set -o xtrace/);
  });

  it("uses the repository secret name without the reserved GITHUB_ prefix", () => {
    assert.match(source, /"GH_APP_CLIENT_SECRET"/);
    assert.doesNotMatch(source, /gh secret set "?GITHUB_/);
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
