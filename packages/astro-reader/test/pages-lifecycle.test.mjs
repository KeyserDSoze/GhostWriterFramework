import assert from "node:assert/strict";
import test from "node:test";
import {
  PagesRequestError,
  disablePagesSite,
  dispatchPagesWorkflow,
  enablePagesSite,
  readLatestPagesRun,
  readPagesSite,
  readPagesWorkflowState,
  readReaderPasswordNames,
  writeReaderPasswordNames,
} from "../cli-dist/pages-lifecycle.js";

const repository = { owner: "ada", repo: "glass-harbor" };

/** An Octokit-style `request`: routes answered from a table; anything else is a test failure. Errors carry `status`, like Octokit's RequestError. */
function fakeGitHub(routes) {
  const calls = [];
  const request = async (route, parameters = {}) => {
    calls.push({ route, parameters });
    const answer = routes[route];
    if (answer === undefined) throw Object.assign(new Error(`unexpected ${route}`), { status: 599 });
    const result = typeof answer === "function" ? answer(parameters, calls) : answer;
    if (result.status >= 400) throw Object.assign(new Error(`HTTP ${result.status}`), { status: result.status });
    return result;
  };
  return { request, calls, routes: () => calls.map((call) => call.route) };
}

test("the status of Pages: the site, or null when Pages is off; any other refusal is an error", async () => {
  const on = fakeGitHub({ "GET /repos/{owner}/{repo}/pages": { status: 200, data: { build_type: "workflow", html_url: "https://ada.github.io/glass-harbor/", status: "built", public: true, cname: null } } });
  assert.deepEqual(await readPagesSite(on.request, repository), { buildType: "workflow", url: null, htmlUrl: "https://ada.github.io/glass-harbor/", status: "built", public: true, cname: null });
  assert.deepEqual(on.calls[0].parameters, repository);
  assert.equal(await readPagesSite(fakeGitHub({ "GET /repos/{owner}/{repo}/pages": { status: 404 } }).request, repository), null);
  await assert.rejects(readPagesSite(fakeGitHub({ "GET /repos/{owner}/{repo}/pages": { status: 403 } }).request, repository), (error) => error instanceof PagesRequestError && error.status === 403);
});

test("turning Pages on asks for a site built by Actions and resumes a paused workflow", async () => {
  const github = fakeGitHub({
    "POST /repos/{owner}/{repo}/pages": { status: 201, data: { build_type: "workflow", html_url: "https://ada.github.io/glass-harbor/" } },
    "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}": { status: 200, data: { state: "disabled_manually" } },
    "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable": { status: 204 },
  });
  const result = await enablePagesSite(github.request, repository);
  assert.equal(result.pages, "created");
  assert.equal(result.workflow, "resumed");
  assert.deepEqual(github.calls[0].parameters, { ...repository, build_type: "workflow" });
  assert.equal(github.calls[1].parameters.workflow_id, "deploy-reader-pages.yml");
});

test("Pages already on from a branch is switched to Actions; already on with Actions is left as it is", async () => {
  const legacy = fakeGitHub({
    "POST /repos/{owner}/{repo}/pages": { status: 409 },
    "GET /repos/{owner}/{repo}/pages": { status: 200, data: { build_type: "legacy" } },
    "PUT /repos/{owner}/{repo}/pages": { status: 204 },
    "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}": { status: 200, data: { state: "active" } },
  });
  const switched = await enablePagesSite(legacy.request, repository);
  assert.equal(switched.pages, "switched-to-workflow");
  assert.equal(switched.workflow, "active");
  assert.deepEqual(legacy.calls.find((call) => call.route === "PUT /repos/{owner}/{repo}/pages").parameters, { ...repository, build_type: "workflow" });

  const already = fakeGitHub({
    "POST /repos/{owner}/{repo}/pages": { status: 409 },
    "GET /repos/{owner}/{repo}/pages": { status: 200, data: { build_type: "workflow" } },
    "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}": { status: 404 },
  });
  const result = await enablePagesSite(already.request, repository);
  assert.equal(result.pages, "already-on");
  assert.equal(result.workflow, "missing");
  assert.ok(!already.routes().includes("PUT /repos/{owner}/{repo}/pages"));

  // A refusal (a private repository on a free plan, a token without the permission) is the caller's to explain.
  await assert.rejects(enablePagesSite(fakeGitHub({ "POST /repos/{owner}/{repo}/pages": { status: 422 } }).request, repository), (error) => error.status === 422);
});

test("turning Pages off by default keeps the workflow file, the list and the secrets: the site goes, the workflow is paused", async () => {
  const github = fakeGitHub({
    "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable": { status: 204 },
    "DELETE /repos/{owner}/{repo}/pages": { status: 204 },
  });
  const result = await disablePagesSite(github.request, repository);
  assert.deepEqual(result, { pages: "disabled", workflow: "paused", variable: "kept", removedSecrets: [], failures: [] });
  assert.deepEqual(github.routes(), ["PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable", "DELETE /repos/{owner}/{repo}/pages"]);
  assert.ok(!github.routes().some((route) => route.includes("/secrets/") || route.includes("/variables")), "no secret and no variable is touched");
  assert.ok(!github.routes().some((route) => route.includes("/contents/")), "the workflow file is not touched");
});

test("off when it is already off, and the workflow left running when asked", async () => {
  const github = fakeGitHub({ "DELETE /repos/{owner}/{repo}/pages": { status: 404 } });
  const result = await disablePagesSite(github.request, repository, { pauseWorkflow: false });
  assert.equal(result.pages, "already-off");
  assert.equal(result.workflow, "kept");
  assert.deepEqual(github.routes(), ["DELETE /repos/{owner}/{repo}/pages"]);
});

test("the explicit second choice deletes the list first, then every reader password secret, the older single one too", async () => {
  const github = fakeGitHub({
    "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable": { status: 204 },
    "DELETE /repos/{owner}/{repo}/pages": { status: 204 },
    "GET /repos/{owner}/{repo}/actions/variables/{name}": { status: 200, data: { name: "READER_PASSWORD_SECRETS", value: "READER_PASSWORD_001,READER_PASSWORD_002" } },
    "DELETE /repos/{owner}/{repo}/actions/variables/{name}": { status: 204 },
    "DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}": (parameters) => (parameters.secret_name === "NARRARIUM_READER_PASSWORD" ? { status: 404 } : { status: 204 }),
  });
  const result = await disablePagesSite(github.request, repository, { removePasswords: true });
  assert.equal(result.variable, "deleted");
  assert.deepEqual(result.removedSecrets, ["READER_PASSWORD_001", "READER_PASSWORD_002"]);
  assert.deepEqual(result.failures, []);
  const order = github.calls.map((call) => `${call.route.split(" ")[0]} ${call.parameters.name ?? call.parameters.secret_name ?? ""}`.trim());
  assert.deepEqual(order, [
    "PUT",
    "DELETE",
    "GET READER_PASSWORD_SECRETS",
    "DELETE READER_PASSWORD_SECRETS",
    "DELETE READER_PASSWORD_001",
    "DELETE READER_PASSWORD_002",
    "DELETE NARRARIUM_READER_PASSWORD",
  ]);
});

test("a refused step of the cleanup is reported and the others still run", async () => {
  const github = fakeGitHub({
    "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable": { status: 403 },
    "DELETE /repos/{owner}/{repo}/pages": { status: 204 },
    "GET /repos/{owner}/{repo}/actions/variables/{name}": { status: 200, data: { value: "READER_PASSWORD_001" } },
    "DELETE /repos/{owner}/{repo}/actions/variables/{name}": { status: 403 },
    "DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}": { status: 204 },
  });
  const result = await disablePagesSite(github.request, repository, { removePasswords: true });
  assert.equal(result.pages, "disabled");
  assert.equal(result.workflow, "kept");
  assert.equal(result.variable, "kept");
  assert.deepEqual(result.removedSecrets, ["READER_PASSWORD_001", "NARRARIUM_READER_PASSWORD"]);
  assert.deepEqual(result.failures, [{ step: "pause the Pages workflow", status: 403 }, { step: "delete READER_PASSWORD_SECRETS", status: 403 }]);
});

test("the list of password secrets: read, written (created when missing), emptied (deleted)", async () => {
  const github = fakeGitHub({
    "GET /repos/{owner}/{repo}/actions/variables/{name}": { status: 200, data: { value: "reader_password_002, READER_PASSWORD_001" } },
  });
  assert.deepEqual(await readReaderPasswordNames(github.request, repository), ["READER_PASSWORD_002", "READER_PASSWORD_001"]);
  assert.equal(await readReaderPasswordNames(fakeGitHub({ "GET /repos/{owner}/{repo}/actions/variables/{name}": { status: 404 } }).request, repository), null);

  const create = fakeGitHub({
    "PATCH /repos/{owner}/{repo}/actions/variables/{name}": { status: 404 },
    "POST /repos/{owner}/{repo}/actions/variables": { status: 201 },
  });
  assert.equal(await writeReaderPasswordNames(create.request, repository, ["READER_PASSWORD_001", "reader_password_002"]), "created");
  assert.deepEqual(create.calls[1].parameters, { ...repository, name: "READER_PASSWORD_SECRETS", value: "READER_PASSWORD_001,READER_PASSWORD_002" });

  const update = fakeGitHub({ "PATCH /repos/{owner}/{repo}/actions/variables/{name}": { status: 204 } });
  assert.equal(await writeReaderPasswordNames(update.request, repository, ["READER_PASSWORD_003"]), "updated");

  const empty = fakeGitHub({ "DELETE /repos/{owner}/{repo}/actions/variables/{name}": { status: 204 } });
  assert.equal(await writeReaderPasswordNames(empty.request, repository, []), "deleted");
  await assert.rejects(writeReaderPasswordNames(update.request, repository, ["bad-name"]));
});

test("the workflow is run on a ref, its state and its latest run are read", async () => {
  const github = fakeGitHub({
    "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches": { status: 204 },
    "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}": { status: 200, data: { state: "active" } },
    "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs": { status: 200, data: { workflow_runs: [{ id: 7, status: "completed", conclusion: "success", html_url: "https://github.com/ada/glass-harbor/actions/runs/7", created_at: "2026-11-24T10:00:00Z", event: "workflow_dispatch", head_sha: "abc" }] } },
  });
  await dispatchPagesWorkflow(github.request, repository, { ref: "main" });
  assert.deepEqual(github.calls[0].parameters, { ...repository, workflow_id: "deploy-reader-pages.yml", ref: "main" });
  assert.equal(await readPagesWorkflowState(github.request, repository), "active");
  assert.deepEqual(await readLatestPagesRun(github.request, repository), { id: 7, status: "completed", conclusion: "success", htmlUrl: "https://github.com/ada/glass-harbor/actions/runs/7", createdAt: "2026-11-24T10:00:00Z", event: "workflow_dispatch", headSha: "abc" });
  assert.equal(await readLatestPagesRun(fakeGitHub({ "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs": { status: 200, data: { workflow_runs: [] } } }).request, repository), null);
});
