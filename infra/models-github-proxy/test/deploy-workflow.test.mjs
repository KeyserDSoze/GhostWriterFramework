import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(new URL("../../../.github/workflows/deploy-worker.yml", import.meta.url));
const scriptPath = fileURLToPath(new URL("../scripts/list-oauth-secrets.mjs", import.meta.url));

const readWorkflow = () => readFileSync(workflowPath, "utf8");

function stepsOf(workflow) {
  return workflow
    .split(/\r?\n(?=\s+- name:)/)
    .slice(1)
    .map((step) => step.trim());
}

describe("deploy-worker.yml", () => {
  it("also starts on changes anywhere under infra/ and on its own file", () => {
    const workflow = readWorkflow();
    assert.match(workflow, /^\s+- infra\/\*\*\s*$/m);
    assert.match(workflow, /^\s+- infra\/models-github-proxy\/\*\*\s*$/m);
    assert.match(workflow, /^\s+- \.github\/workflows\/deploy-worker\.yml\s*$/m);
  });

  it("runs the Worker tests, with no install, before the deploy step", () => {
    const steps = stepsOf(readWorkflow());
    const testIndex = steps.findIndex((step) => /run:\s*npm test\b/.test(step));
    const deployIndex = steps.findIndex((step) => step.includes("cloudflare/wrangler-action"));
    assert.ok(testIndex >= 0, "a step runs npm test");
    assert.ok(deployIndex >= 0, "a step deploys with wrangler-action");
    assert.ok(testIndex < deployIndex, "the tests run before the deploy");
    assert.match(steps[testIndex], /working-directory:\s*infra\/models-github-proxy/);
    assert.doesNotMatch(steps[testIndex], /npm (?:ci|install)/);
  });

  it("selects the configured OAuth secrets before the deploy step", () => {
    const steps = stepsOf(readWorkflow());
    const selectIndex = steps.findIndex((step) => /id:\s*oauth_secrets/.test(step));
    const deployIndex = steps.findIndex((step) => step.includes("cloudflare/wrangler-action"));
    assert.ok(selectIndex >= 0 && selectIndex < deployIndex);
    assert.match(steps[selectIndex], /run:\s*node infra\/models-github-proxy\/scripts\/list-oauth-secrets\.mjs/);
    assert.match(steps[selectIndex], /GOOGLE_CLIENT_SECRET:\s*\$\{\{\s*secrets\.GOOGLE_OAUTH_CLIENT_SECRET\s*\}\}/);
    assert.match(steps[selectIndex], /MICROSOFT_CLIENT_SECRET:\s*\$\{\{\s*secrets\.MICROSOFT_OAUTH_CLIENT_SECRET\s*\}\}/);
  });

  it("hands the secrets to wrangler-action under the Worker's names, listing only those that exist", () => {
    const steps = stepsOf(readWorkflow());
    const deploy = steps.find((step) => step.includes("cloudflare/wrangler-action"));
    assert.match(deploy, /^\s+secrets:\s*\$\{\{\s*steps\.oauth_secrets\.outputs\.names\s*\}\}\s*$/m);
    assert.match(deploy, /^\s+GOOGLE_CLIENT_SECRET:\s*\$\{\{\s*secrets\.GOOGLE_OAUTH_CLIENT_SECRET\s*\}\}\s*$/m);
    assert.match(deploy, /^\s+MICROSOFT_CLIENT_SECRET:\s*\$\{\{\s*secrets\.MICROSOFT_OAUTH_CLIENT_SECRET\s*\}\}\s*$/m);
    assert.match(deploy, /workingDirectory:\s*infra\/models-github-proxy/);
    assert.match(deploy, /command:\s*deploy/);
  });

  it("only ever reads secrets through the secrets context, never as literals", () => {
    for (const line of readWorkflow().split(/\r?\n/)) {
      if (/_CLIENT_SECRET\s*:/.test(line)) {
        assert.match(line, /\$\{\{\s*secrets\.[A-Z_]+\s*\}\}/, line);
      }
    }
  });
});

describe("scripts/list-oauth-secrets.mjs (the deploy step must not fail for a missing secret)", () => {
  function run(env) {
    const directory = mkdtempSync(join(tmpdir(), "oauth-secrets-"));
    try {
      const output = join(directory, "github-output");
      writeFileSync(output, "");
      const result = spawnSync(process.execPath, [scriptPath], {
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env },
        encoding: "utf8",
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: readFileSync(output, "utf8") };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  function namesOf(output) {
    const lines = output.split("\n");
    const header = /^names<<(.+)$/.exec(lines[0]);
    assert.ok(header, `GITHUB_OUTPUT starts with names<<DELIMITER, got ${JSON.stringify(output)}`);
    const end = lines.indexOf(header[1], 1);
    assert.ok(end > 0, "the delimiter closes the value");
    return lines.slice(1, end);
  }

  const GOOGLE = "FAKE-google-secret-for-the-workflow-test";
  const MICROSOFT = "FAKE-microsoft-secret-for-the-workflow-test";

  it("lists both Worker secret names when both repository secrets exist", () => {
    const result = run({ GOOGLE_CLIENT_SECRET: GOOGLE, MICROSOFT_CLIENT_SECRET: MICROSOFT });
    assert.equal(result.status, 0);
    assert.deepEqual(namesOf(result.output), ["GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_SECRET"]);
    assert.doesNotMatch(result.stdout, /::notice|::warning|::error/);
  });

  it("lists only the secret that exists, and says which repository secret is missing", () => {
    const onlyGoogle = run({ GOOGLE_CLIENT_SECRET: GOOGLE, MICROSOFT_CLIENT_SECRET: "" });
    assert.equal(onlyGoogle.status, 0);
    assert.deepEqual(namesOf(onlyGoogle.output), ["GOOGLE_CLIENT_SECRET"]);
    assert.match(onlyGoogle.stdout, /MICROSOFT_OAUTH_CLIENT_SECRET/);
    assert.doesNotMatch(onlyGoogle.stdout, /GOOGLE_OAUTH_CLIENT_SECRET/);

    const onlyMicrosoft = run({ MICROSOFT_CLIENT_SECRET: MICROSOFT });
    assert.equal(onlyMicrosoft.status, 0);
    assert.deepEqual(namesOf(onlyMicrosoft.output), ["MICROSOFT_CLIENT_SECRET"]);
    assert.match(onlyMicrosoft.stdout, /GOOGLE_OAUTH_CLIENT_SECRET/);
  });

  it("succeeds with an empty list when no repository secret exists (GitHub passes an empty string)", () => {
    for (const env of [{}, { GOOGLE_CLIENT_SECRET: "", MICROSOFT_CLIENT_SECRET: "" }, { GOOGLE_CLIENT_SECRET: "  \n", MICROSOFT_CLIENT_SECRET: " " }]) {
      const result = run(env);
      assert.equal(result.status, 0, JSON.stringify(env));
      assert.deepEqual(namesOf(result.output), []);
      assert.match(result.stdout, /GOOGLE_OAUTH_CLIENT_SECRET/);
      assert.match(result.stdout, /MICROSOFT_OAUTH_CLIENT_SECRET/);
    }
  });

  it("never prints a secret value", () => {
    const result = run({ GOOGLE_CLIENT_SECRET: GOOGLE, MICROSOFT_CLIENT_SECRET: MICROSOFT });
    assert.equal(result.status, 0, "the script ran");
    for (const text of [result.stdout, result.stderr, result.output]) {
      assert.ok(!text.includes(GOOGLE) && !text.includes(MICROSOFT));
    }
  });

  it("still succeeds outside GitHub Actions, where GITHUB_OUTPUT is not set", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      env: { PATH: process.env.PATH, GOOGLE_CLIENT_SECRET: GOOGLE },
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /GOOGLE_CLIENT_SECRET/);
    assert.ok(!result.stdout.includes(GOOGLE));
  });
});
