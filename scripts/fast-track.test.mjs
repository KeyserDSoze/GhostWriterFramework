import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import { DEFAULT_SECONDS, E2E_SECONDS, shardSpecs, specsOf } from "./e2e-shards.mjs";
import { QUICK_GUARDS, decideLane, fastTrackReason, lockfileChanges, packageJsonChanges, siteTestTargets } from "./release-lane.mjs";

const read = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = async (name) => parse(await read(`.github/workflows/${name}`));
const packageScripts = async () => JSON.parse(await read("package.json")).scripts;
const stepNames = (job) => (job.steps ?? []).map((step) => step.name);
const step = (job, name) => {
  const found = job.steps.find((entry) => entry.name === name);
  assert.ok(found, `step "${name}"`);
  return found;
};

// ---------------------------------------------------------------------------------------------
// The lane decision
// ---------------------------------------------------------------------------------------------

const QUICK = "Fix the label of the save button\n\nThe Italian text said the opposite.\n\nFast-Track: a wrong label, one string";
const siteFix = ["src/narrarium-site/src/components/SaveButton.tsx", "src/narrarium-site/src/i18n/it.json", "src/narrarium-site/package.json", "package-lock.json", "src/narrarium-site/src/content/patch-notes.json"];
const bumpOnly = { "src/narrarium-site/package.json": [] };

test("the Fast-Track trailer is read from the last paragraph of the message only, and needs a reason", () => {
  assert.equal(fastTrackReason(QUICK), "a wrong label, one string");
  assert.equal(fastTrackReason("Fix\n\nSigned-off-by: A <a@b.c>\nfast-track:   typo in a doc  "), "typo in a doc", "any case, among other trailers");
  assert.equal(fastTrackReason("Fast-Track: no body, so no trailer block"), null, "a subject is not a trailer");
  assert.equal(fastTrackReason("Fix\n\nFast-Track: in the body\n\nAnd more text after it."), null, "only the last paragraph holds trailers");
  assert.equal(fastTrackReason("Fix\n\nFast-Track:"), null, "a trailer without a reason is no trailer");
  assert.equal(fastTrackReason("Fix\n\nFast-Track-Not: x"), null);
  assert.equal(fastTrackReason("Fix\r\n\r\nFast-Track: windows line ends\r\n"), "windows line ends");
  assert.equal(fastTrackReason(undefined), null);
});

test("lanes: express when asked by hand, quick for a guarded-free change with the trailer, full otherwise", () => {
  assert.equal(decideLane({ express: true, message: QUICK, files: ["packages/server/src/server.ts"] }).lane, "express", "express is the author's call and needs no trailer");
  assert.deepEqual(decideLane({ message: QUICK, files: siteFix, packageChanges: bumpOnly, lockChanges: [] }), { lane: "quick", reason: "a wrong label, one string", refused: [] });
  assert.deepEqual(decideLane({ message: "Fix a label", files: siteFix, packageChanges: bumpOnly }), { lane: "full", reason: "no Fast-Track trailer", refused: [] });
  for (const files of [["docs/guide.md"], ["README.md", "AGENTS.md"], ["docs/it/guida.md"], ["e2e/local-first.spec.ts"], ["src/narrarium-site/test-browser/save.test.tsx"]]) {
    assert.equal(decideLane({ message: QUICK, files }).lane, "quick", files.join(", "));
  }
});

test("the trailer is refused, and the push goes the full lane, for every guarded kind of change", () => {
  const refusedFor = (files, extra = {}) => decideLane({ message: QUICK, files: [...siteFix, ...files], packageChanges: bumpOnly, ...extra });
  const cases = [
    ["packages/engine/src/autopilot/runner.ts", "the engine"],
    ["packages/server/src/server.ts", "the personal server"],
    ["packages/core/src/index.ts", "the core package"],
    ["packages/astro-reader/src/pages/index.astro", "the reader package"],
    ["packages/sdk-typescript/src/index.ts", "a published package"],
    ["packages/mcp-server/src/index.ts", "a published package"],
    ["packages/sdk-typescript/README.md", "a published package"],
    [".github/workflows/ci.yml", "the workflows"],
    [".github/actions/setup/action.yml", "the workflows"],
    ["scripts/release-lane.mjs", "the release and lane scripts"],
    ["playwright.config.ts", "the configuration of the checks"],
    ["src/narrarium-site/vite.config.ts", "the configuration of the checks"],
    ["src/narrarium-site/vitest.config.ts", "the configuration of the checks"],
    ["src/narrarium-site/scripts/assert-production-bundle.mjs", "the configuration of the checks"],
    ["e2e/helpers/stub.ts", "the configuration of the checks"],
    ["src/narrarium-site/src/account/credentialVault.ts", "authentication or security code"],
    ["src/narrarium-site/src/github/githubOAuth.ts", "authentication or security code"],
    ["src/narrarium-site/src/auth/accountScope.ts", "authentication or security code"],
    ["src/narrarium-site/auth/microsoft-callback.html", "authentication or security code"],
    ["src/narrarium-site/csp.ts", "authentication or security code"],
    ["src/narrarium-site/src/msalPopup.ts", "authentication or security code"],
    ["src/narrarium-site/src/readerAccess/passwordList.ts", "authentication or security code"],
    ["src/narrarium-site/src/costs/tokenBudget.ts", "authentication or security code"],
    ["src/narrarium-site/src/lib/sanitizeHtml.ts", "authentication or security code"],
    ["src/auth-proxy/worker.ts", "a service other than the site"],
    ["api/mcp.ts", "the serverless API"],
    ["vercel.json", "the serverless API"],
  ];
  for (const [file, reason] of cases) {
    const decision = refusedFor([file]);
    assert.equal(decision.lane, "full", file);
    assert.match(decision.reason, /^Fast-Track refused \(a wrong label, one string\)$/);
    assert.ok(decision.refused.some((why) => why.startsWith(`${reason}:`) && why.includes(file)), `${file}: ${decision.refused.join(" | ")}`);
  }
  // Every guard is exercised above.
  const reasons = new Set(cases.map(([, reason]) => reason));
  assert.deepEqual(QUICK_GUARDS.map((guard) => guard.reason).filter((reason) => !reasons.has(reason)), []);

  assert.match(refusedFor([], { packageChanges: { "src/narrarium-site/package.json": ["dependencies"] } }).refused.join(), /dependencies or scripts: src\/narrarium-site\/package.json changes dependencies/);
  assert.match(refusedFor([], { packageChanges: { "package.json": ["scripts"] } }).refused.join(), /package.json changes scripts/);
  assert.match(refusedFor([], { lockChanges: ["node_modules/react"] }).refused.join(), /dependencies: package-lock.json changes node_modules\/react/);
  assert.match(decideLane({ message: QUICK, files: null }).refused.join(), /not known/, "a new branch or a force push: the files are not known");
  assert.match(decideLane({ message: QUICK, files: [] }).refused.join(), /no file changed/);
  const many = decideLane({ message: QUICK, files: Array.from({ length: 8 }, (_, index) => `packages/engine/src/f${index}.ts`) });
  assert.match(many.refused[0], /f4\.ts, and 3 more$/, "a long list is cut, with the count");
});

test("a site release bump is no dependency change; a new or changed dependency is", () => {
  const pkg = (fields) => JSON.stringify({ name: "narrarium-site", version: "0.136.0", scripts: { build: "vite build" }, dependencies: { react: "^19.0.0" }, ...fields });
  assert.deepEqual(packageJsonChanges(pkg(), pkg({ version: "0.137.0" })), []);
  assert.deepEqual(packageJsonChanges(pkg(), pkg({ dependencies: { react: "^19.1.0" } })), ["dependencies"]);
  assert.deepEqual(packageJsonChanges(pkg(), pkg({ scripts: { build: "vite build --mode x" }, devDependencies: { vitest: "4" } })), ["devDependencies", "scripts"]);
  assert.deepEqual(packageJsonChanges(undefined, pkg()), ["dependencies", "name", "scripts"], "a new package.json is a change");

  const lock = (siteVersion, react = "19.0.0", rootVersion = "0.1.56") => JSON.stringify({
    name: "narrarium-framework",
    version: rootVersion,
    lockfileVersion: 3,
    packages: {
      "": { name: "narrarium-framework", version: rootVersion, workspaces: ["packages/*", "src/narrarium-site"] },
      "node_modules/narrarium-site": { resolved: "src/narrarium-site", link: true },
      "node_modules/react": { version: react, resolved: `https://registry.npmjs.org/react/-/react-${react}.tgz`, integrity: "sha512-x" },
      "src/narrarium-site": { name: "narrarium-site", version: siteVersion, dependencies: { react: "^19.0.0" } },
    },
  });
  assert.deepEqual(lockfileChanges(lock("0.136.0"), lock("0.137.0")), [], "the workspace version of a bump");
  assert.deepEqual(lockfileChanges(lock("0.136.0"), lock("0.137.0", "19.0.0", "0.1.57")), [], "and the root's");
  assert.deepEqual(lockfileChanges(lock("0.136.0"), lock("0.137.0", "19.1.0")), ["node_modules/react"]);
  const added = JSON.parse(lock("0.136.0"));
  added.packages["node_modules/left-pad"] = { version: "1.3.0" };
  assert.deepEqual(lockfileChanges(lock("0.136.0"), JSON.stringify(added)), ["node_modules/left-pad"]);
});

test("the related tests are given the site's sources and component tests, relative to the site", () => {
  assert.deepEqual(siteTestTargets([...siteFix, "docs/x.md", "src/narrarium-site/test-browser/save.test.tsx", "src/narrarium-site/public/icon.png"]), [
    "src/components/SaveButton.tsx",
    "src/i18n/it.json",
    "src/content/patch-notes.json",
    "test-browser/save.test.tsx",
  ]);
  assert.deepEqual(siteTestTargets(null), []);
});

// ---------------------------------------------------------------------------------------------
// The workflows
// ---------------------------------------------------------------------------------------------

test("the deploy: one lane job decides; each lane publishes after its own gate; the express lane is manual, off by default", async () => {
  const deploy = await workflow("book-management-system.yml");
  const { inputs } = deploy.on.workflow_dispatch;
  assert.deepEqual([inputs.fast_track.type, inputs.fast_track.default], ["boolean", false]);
  assert.deepEqual([inputs.ref.type, inputs.ref.default], ["string", ""]);
  assert.deepEqual(Object.keys(deploy.jobs), ["lane", "quick", "quick-e2e", "checks", "publish-express", "publish-quick", "publish-full"]);

  const { jobs } = deploy;
  assert.match(step(jobs.lane, "Decide the lane").run, /node scripts\/release-lane\.mjs decide --event "\$EVENT" --base "\$BEFORE" --head "\$SHA" --express "\$EXPRESS"/);
  assert.equal(step(jobs.lane, "Decide the lane").env.BEFORE, "${{ github.event.before }}");
  assert.ok(!("ref" in (step(jobs.lane, "Checkout").with ?? {})), "the lane is decided by the scripts of the run's own commit, not of a rollback target");
  assert.match(step(jobs.lane, "Check the commit to publish").run, /merge-base --is-ancestor "\$sha" origin\/main/, "a rollback publishes a commit of main only");
  assert.match(step(jobs.lane, "Check the commit to publish").run, /EXPRESS" != "true"/, "a rollback is an express run");

  const gate = (name) => ({ needs: [jobs[name].needs].flat(), if: jobs[name].if, uses: jobs[name].uses, with: jobs[name].with });
  assert.deepEqual(gate("quick"), { needs: ["lane"], if: "${{ needs.lane.outputs.lane == 'quick' }}", uses: undefined, with: undefined });
  assert.deepEqual(gate("quick-e2e"), { needs: ["lane"], if: "${{ needs.lane.outputs.lane == 'quick' }}", uses: undefined, with: undefined });
  assert.deepEqual(gate("checks"), { needs: ["lane"], if: "${{ needs.lane.outputs.lane != 'express' }}", uses: "./.github/workflows/checks.yml", with: { ref: "${{ needs.lane.outputs.sha }}" } });
  assert.deepEqual(gate("publish-express"), { needs: ["lane"], if: "${{ needs.lane.outputs.lane == 'express' }}", uses: "./.github/workflows/pages.yml", with: { ref: "${{ needs.lane.outputs.sha }}", express: true } });
  assert.deepEqual(gate("publish-quick"), { needs: ["lane", "quick", "quick-e2e"], if: "${{ needs.lane.outputs.lane == 'quick' }}", uses: "./.github/workflows/pages.yml", with: { ref: "${{ needs.lane.outputs.sha }}" } });
  assert.deepEqual(gate("publish-full"), { needs: ["lane", "checks"], if: "${{ needs.lane.outputs.lane == 'full' }}", uses: "./.github/workflows/pages.yml", with: { ref: "${{ needs.lane.outputs.sha }}" } });
  // A publish job's `if` has no status function: GitHub adds success(), so it runs only when every job it needs passed.
  for (const name of ["publish-express", "publish-quick", "publish-full"]) {
    assert.doesNotMatch(jobs[name].if, /always\(\)|failure\(\)|cancelled\(\)|success\(\)/, name);
    assert.deepEqual(jobs[name].permissions, { contents: "read", pages: "write", "id-token": "write" }, name);
  }
  assert.deepEqual(deploy.permissions, { contents: "read" }, "only the publish jobs may write to Pages");
  assert.equal(deploy.concurrency.group, "github-pages-${{ github.ref }}", "a run of another branch never cancels a deploy of main");

  assert.match(step(jobs.quick, "Run the quick checks").run, /check-quick\.mjs --base "\$BASE" --head HEAD --parts tests$/);
  assert.match(step(jobs["quick-e2e"], "Run the smoke E2E").run, /check-quick\.mjs --base "\$BASE" --head HEAD --parts e2e$/);
});

test("the publication: build and upload are never conditional, and only a run of main publishes", async () => {
  const pages = await workflow("pages.yml");
  assert.deepEqual(Object.keys(pages.on.workflow_call.inputs), ["ref", "express"]);
  const { build, deploy } = pages.jobs;
  assert.equal(build.if, undefined);
  for (const name of ["Checkout", "Install dependencies", "Build Narrarium core, shared engine and book scaffolder", "Build Narrarium site", "Upload Pages artifact"]) {
    assert.equal(step(build, name).if, undefined, name);
  }
  assert.equal(step(build, "Checkout").with.ref, "${{ inputs.ref }}");
  assert.equal(step(build, "Say that the tests were skipped").if, "${{ inputs.express }}");
  assert.equal(step(build, "Build Narrarium site").env.SITE_BASE, "/");
  assert.ok(!stepNames(build).includes("Set up the workspace"), "a rollback builds an older commit, which may not have the setup action");
  assert.deepEqual([deploy.needs, deploy.if, deploy.environment.name], ["build", "${{ github.ref == 'refs/heads/main' }}", "github-pages"]);
  assert.deepEqual(build.permissions, { contents: "read", pages: "read" });
});

test("the full checks: the same suites as before, the component tests and the E2E in shards that add up to the whole", async () => {
  const checks = await workflow("checks.yml");
  assert.deepEqual(Object.keys(checks.jobs), ["policy", "packages", "server", "site-unit", "site-browser", "site-coverage", "e2e", "e2e-basename", "passed"]);
  const { jobs } = checks;
  const runs = (name) => jobs[name].steps.map((entry) => entry.run).filter(Boolean).join("\n");
  assert.match(runs("policy"), /npm run dependency:check/);
  assert.match(runs("packages"), /npm run build\nnpm run validate\nnpm run test:libraries/);
  assert.match(runs("server"), /npm run test -w narrarium-server/);
  assert.equal(step(jobs.packages, "Build workspace").env.SITE_BASE, "/");
  assert.match(runs("site-unit"), /npm run test:typecheck -w narrarium-site\nnpm run test:unit -w narrarium-site/);
  assert.deepEqual(jobs["site-browser"].strategy.matrix.shard, [1, 2, 3, 4]);
  assert.match(runs("site-browser"), /npm run test:browser -w narrarium-site -- --shard=\$\{\{ matrix\.shard \}\}\/4 --reporter=default --reporter=blob/);
  assert.equal(jobs["site-coverage"].needs, "site-browser");
  assert.equal(step(jobs["site-coverage"], "Merge the reports and apply the coverage thresholds").run, "npx vitest --merge-reports --coverage");
  assert.equal(step(jobs["site-coverage"], "Upload Narrarium site coverage").with.name, "narrarium-site-coverage");
  assert.deepEqual(jobs.e2e.strategy.matrix.shard, [1, 2, 3]);
  assert.match(runs("e2e"), /npm run test:e2e:build\nnode scripts\/e2e-shards\.mjs run \$\{\{ matrix\.shard \}\} 3/);
  assert.match(runs("e2e-basename"), /npm run test:e2e:basename/);
  assert.deepEqual([jobs.passed.needs, jobs.passed.if], [["policy", "packages", "server", "site-unit", "site-coverage", "e2e", "e2e-basename"], "${{ always() }}"]);
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(job.if ?? "${{ always() }}", "${{ always() }}", `${name} is never skipped`);
    for (const entry of job.steps) assert.equal(entry.if, undefined, `${name}: ${entry.name} is never skipped`);
    const checkout = job.steps.find((entry) => entry.uses?.startsWith("actions/checkout@"));
    if (name !== "passed") assert.equal(checkout.with.ref, "${{ inputs.ref || github.sha }}", `${name} checks the commit it is given`);
  }
  // The build variables of the deployed site reach the E2E build only: the component tests run without them (the broker's tests need it).
  assert.equal(checks.env, undefined);
  assert.equal(step(jobs.e2e, "Build E2E site").env.VITE_GITHUB_MODELS_BASE, "${{ vars.VITE_GITHUB_MODELS_BASE }}");
  assert.equal(step(jobs["site-browser"], "Run the component tests of this shard").env, undefined);
  // The thresholds of a shard are off; the merged report applies the ones of vitest.config.ts.
  assert.match(runs("site-browser"), /--coverage\.thresholds\.statements=0 --coverage\.thresholds\.branches=0 --coverage\.thresholds\.functions=0 --coverage\.thresholds\.lines=0/);
  assert.match(await read("src/narrarium-site/vitest.config.ts"), /thresholds: \{\s+perFile: true/);
});

test("CI runs the same checks, for what the deploy does not check: the two path lists are one", async () => {
  const ci = await workflow("ci.yml");
  const deploy = await workflow("book-management-system.yml");
  assert.deepEqual(ci.on.push["paths-ignore"], deploy.on.push.paths);
  assert.deepEqual(ci.on.push.branches, deploy.on.push.branches);
  assert.ok("pull_request" in ci.on && "workflow_dispatch" in ci.on);
  assert.deepEqual(ci.jobs, { checks: { name: "Checks", uses: "./.github/workflows/checks.yml" } });
  assert.ok(deploy.on.push.paths.includes(".github/workflows/book-management-system.yml") && deploy.on.push.paths.includes(".github/workflows/pages.yml"));
});

test("the E2E shards hold every file of the suite once, with times about even; the smoke subset is part of the suite", async () => {
  const scripts = await packageScripts();
  const suite = specsOf(scripts["test:e2e"]);
  assert.ok(suite.length >= 20);
  for (const total of [1, 2, 3, 4]) {
    const shards = shardSpecs(suite, total);
    assert.deepEqual(shards.flatMap((shard) => shard.files).sort(), [...suite].sort(), `${total} shards`);
    for (const shard of shards) assert.deepEqual(shard.files, suite.filter((file) => shard.files.includes(file)), "the suite's order");
  }
  const three = shardSpecs(suite, 3).map((shard) => shard.seconds);
  assert.ok(Math.max(...three) - Math.min(...three) <= 20, `even: ${three}`);
  assert.deepEqual(shardSpecs(["e2e/new.spec.ts", ...suite], 3).flatMap((shard) => shard.files).filter((file) => file === "e2e/new.spec.ts"), ["e2e/new.spec.ts"], `a new file (${DEFAULT_SECONDS} s) is never dropped`);
  assert.deepEqual(Object.keys(E2E_SECONDS).filter((file) => !suite.includes(file)), [], "no time for a file that left the suite");
  assert.throws(() => shardSpecs(suite, 0), /positive integer/);

  const smoke = specsOf(scripts["test:e2e:smoke"]);
  assert.ok(smoke.length >= 4 && smoke.every((file) => suite.includes(file)), "the smoke specs are files of the suite");
  assert.match(scripts["test:e2e:smoke"], /--grep '[^']+'/);
  assert.equal(scripts.test, "npm run test:packages && npm run test -w narrarium-site");
  assert.equal(scripts["test:packages"], "npm run test:libraries && npm run test -w narrarium-server", "the packages job and the server job run all of them");
  assert.equal(scripts["check:quick"], "node scripts/check-quick.mjs");
});

test("the setup action installs with npm ci and caches Chromium by Playwright version", async () => {
  const action = parse(await read(".github/actions/setup/action.yml"));
  const names = action.runs.steps.map((entry) => entry.name);
  assert.deepEqual(names, ["Setup Node", "Install dependencies", "Build the prerequisites", "Read the Playwright version", "Restore Chromium", "Install Chromium"]);
  assert.equal(action.runs.steps[0].with.cache, "npm");
  assert.equal(action.runs.steps[1].run, "npx --yes npm@12.0.2 ci");
  assert.equal(action.runs.steps[4].with.key, "playwright-chromium-${{ runner.os }}-${{ steps.playwright.outputs.version }}");
});
