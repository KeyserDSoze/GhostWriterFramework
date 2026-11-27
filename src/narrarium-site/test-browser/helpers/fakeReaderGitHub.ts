import type { Octokit } from "@octokit/rest";

export interface FakeFailure { status: number; message?: string; headers?: Record<string, string> }

export interface FakeReaderGitHub {
  octokit: Octokit;
  secrets: Map<string, string>;
  variable: { value: string | null };
  pages: { enabled: boolean; htmlUrl: string; plan?: boolean };
  workflowPresent: { value: boolean };
  workflowText: { value: string };
  /** `active` or `disabled_manually`, as GitHub says it. */
  workflowState: { value: string };
  runs: Array<{ id: number; status: string; conclusion: string | null; html_url: string; created_at: string; head_branch: string; head_sha?: string }>;
  /** The jobs of any run, and the annotations GitHub put on each job. */
  jobs: Array<{ id: number; name: string; conclusion: string | null; steps: unknown[] }>;
  annotations: Record<number, Array<{ message: string }>>;
  owner: { login: string; type: "User" | "Organization" };
  /** The repository's visibility; `unpublishOnPrivate`: GitHub stops serving Pages when it becomes private (a plan without Pages for private repositories). */
  repository: { private: boolean; admin: boolean; archived: boolean; unpublishOnPrivate: boolean };
  calls: Array<{ method: string; args: Record<string, unknown> }>;
  /** Makes the next calls of a method fail (the number of times given, or for ever). */
  fail(method: string, failure: FakeFailure, times?: number): void;
  clearFailures(): void;
  order(): string[];
}

/** A well-formed repository public key (32 bytes, base64): the real sealed box can run against it. */
export const FAKE_PUBLIC_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 9)));

const MUTATIONS = new Set(["update", "updatePagesSite", "enableWorkflow", "disableWorkflow", "createOrUpdateRepoSecret", "deleteRepoSecret", "createRepoVariable", "updateRepoVariable", "deleteRepoVariable", "createWorkflowDispatch", "createPagesSite", "deletePagesSite"]);

function requestError(failure: FakeFailure): Error {
  return Object.assign(new Error(failure.message ?? `HTTP ${failure.status}`), { status: failure.status, response: { headers: failure.headers ?? {} } });
}

/** An in-memory GitHub that answers only the calls of the reader's access, records every call, and can be told to refuse any of them. */
export function createFakeReaderGitHub(): FakeReaderGitHub {
  const state = {
    secrets: new Map<string, string>(),
    variable: { value: null as string | null },
    pages: { enabled: false, htmlUrl: "https://me.github.io/book/" } as FakeReaderGitHub["pages"],
    workflowPresent: { value: true },
    workflowState: { value: "active" },
    /** The text of the workflow file: by default one that reads the passwords. */
    workflowText: { value: "name: Deploy reader\nenv:\n  PASSWORDS: ${{ vars.READER_PASSWORD_SECRETS }}\n" },
    runs: [] as FakeReaderGitHub["runs"],
    jobs: [] as FakeReaderGitHub["jobs"],
    annotations: {} as FakeReaderGitHub["annotations"],
    owner: { login: "me", type: "User" } as FakeReaderGitHub["owner"],
    repository: { private: true, admin: true, archived: false, unpublishOnPrivate: false } as FakeReaderGitHub["repository"],
    calls: [] as FakeReaderGitHub["calls"],
  };
  const failures = new Map<string, FakeFailure & { remaining: number }>();
  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    get: () => ({ data: { owner: state.owner, private: state.repository.private, visibility: state.repository.private ? "private" : "public", archived: state.repository.archived, default_branch: "main", html_url: "https://github.com/me/book", permissions: { admin: state.repository.admin, push: true, pull: true } } }),
    getRepoPublicKey: () => ({ data: { key_id: "key-1", key: FAKE_PUBLIC_KEY } }),
    createOrUpdateRepoSecret: (args) => { state.secrets.set(String(args.secret_name), String(args.encrypted_value)); return { data: {} }; },
    deleteRepoSecret: (args) => { if (!state.secrets.has(String(args.secret_name))) throw requestError({ status: 404 }); state.secrets.delete(String(args.secret_name)); return { data: {} }; },
    listRepoSecrets: () => ({ data: { total_count: state.secrets.size, secrets: [...state.secrets.keys()].map((name) => ({ name })) } }),
    getRepoVariable: () => { if (state.variable.value === null) throw requestError({ status: 404 }); return { data: { name: "READER_PASSWORD_SECRETS", value: state.variable.value } }; },
    createRepoVariable: (args) => { if (state.variable.value !== null) throw requestError({ status: 409 }); state.variable.value = String(args.value); return { data: {} }; },
    updateRepoVariable: (args) => { if (state.variable.value === null) throw requestError({ status: 404 }); state.variable.value = String(args.value); return { data: {} }; },
    deleteRepoVariable: () => { if (state.variable.value === null) throw requestError({ status: 404 }); state.variable.value = null; return { data: {} }; },
    createWorkflowDispatch: () => { state.runs.unshift({ id: state.runs.length + 1, status: "queued", conclusion: null, html_url: `https://github.com/me/book/actions/runs/${state.runs.length + 1}`, created_at: "2026-11-25T10:00:00Z", head_branch: "main" }); return { data: {} }; },
    update: (args) => {
      state.repository.private = args.private === true;
      if (state.repository.private && state.repository.unpublishOnPrivate) state.pages.enabled = false;
      return { data: {} };
    },
    listJobsForWorkflowRun: () => ({ data: { total_count: state.jobs.length, jobs: state.jobs } }),
    listAnnotations: (args) => ({ data: state.annotations[Number(args.check_run_id)] ?? [] }),
    listWorkflowRuns: () => ({ data: { workflow_runs: state.runs } }),
    getContent: () => {
      if (!state.workflowPresent.value) throw requestError({ status: 404 });
      return { data: { type: "file", content: btoa(state.workflowText.value) } };
    },
    getPages: () => { if (!state.pages.enabled) throw requestError({ status: 404 }); return { data: { html_url: state.pages.htmlUrl, build_type: "workflow" } }; },
    createPagesSite: () => {
      if (state.pages.plan) throw requestError({ status: 422, message: "Your current plan does not support GitHub Pages for this repository." });
      if (state.pages.enabled) throw requestError({ status: 409 });
      state.pages.enabled = true;
      return { data: {} };
    },
    updatePagesSite: () => { state.pages.enabled = true; return { data: {} }; },
    getWorkflow: () => { if (!state.workflowPresent.value) throw requestError({ status: 404 }); return { data: { state: state.workflowState.value } }; },
    enableWorkflow: () => { state.workflowState.value = "active"; return { data: {} }; },
    disableWorkflow: () => { if (!state.workflowPresent.value) throw requestError({ status: 404 }); state.workflowState.value = "disabled_manually"; return { data: {} }; },
    deletePagesSite: () => { if (!state.pages.enabled) throw requestError({ status: 404 }); state.pages.enabled = false; return { data: {} }; },
  };
  const ROUTES: Record<string, string> = {
    "GET /repos/{owner}/{repo}/pages": "getPages",
    "POST /repos/{owner}/{repo}/pages": "createPagesSite",
    "PUT /repos/{owner}/{repo}/pages": "updatePagesSite",
    "DELETE /repos/{owner}/{repo}/pages": "deletePagesSite",
    "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}": "getWorkflow",
    "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable": "enableWorkflow",
    "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable": "disableWorkflow",
    "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches": "createWorkflowDispatch",
    "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs": "listWorkflowRuns",
    "GET /repos/{owner}/{repo}/actions/variables/{name}": "getRepoVariable",
    "PATCH /repos/{owner}/{repo}/actions/variables/{name}": "updateRepoVariable",
    "POST /repos/{owner}/{repo}/actions/variables": "createRepoVariable",
    "DELETE /repos/{owner}/{repo}/actions/variables/{name}": "deleteRepoVariable",
    "DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}": "deleteRepoSecret",
  };
  const group = (names: string[]) => Object.fromEntries(names.map((name) => [name, async (args: Record<string, unknown> = {}) => {
    state.calls.push({ method: name, args });
    const failure = failures.get(name);
    if (failure && failure.remaining > 0) {
      failure.remaining -= 1;
      throw requestError(failure);
    }
    return handlers[name](args);
  }]));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    state.calls.push({ method: name, args });
    const failure = failures.get(name);
    if (failure && failure.remaining > 0) {
      failure.remaining -= 1;
      throw requestError(failure);
    }
    return handlers[name](args);
  };
  const octokit = {
    /** What the reader package's helpers call: a route and its parameters, answered by the same handlers (and counted under the same names) as the REST methods. */
    request: async (route: string, args: Record<string, unknown> = {}) => {
      const name = ROUTES[route];
      if (!name) throw new Error(`The fake GitHub does not know the route ${route}`);
      return call(name, args);
    },
    rest: {
      repos: group(["get", "update", "getContent", "getPages", "createPagesSite", "deletePagesSite"]),
      actions: group(["getRepoPublicKey", "createOrUpdateRepoSecret", "deleteRepoSecret", "listRepoSecrets", "getRepoVariable", "createRepoVariable", "updateRepoVariable", "deleteRepoVariable", "createWorkflowDispatch", "listWorkflowRuns", "listJobsForWorkflowRun"]),
      checks: group(["listAnnotations"]),
    },
  } as unknown as Octokit;
  return {
    octokit,
    ...state,
    fail(method, failure, times = Number.POSITIVE_INFINITY) { failures.set(method, { ...failure, remaining: times }); },
    clearFailures() { failures.clear(); },
    order: () => state.calls.filter((call) => MUTATIONS.has(call.method)).map((call) => call.method === "createOrUpdateRepoSecret" || call.method === "deleteRepoSecret" ? `${call.method}:${String(call.args.secret_name)}` : call.method),
  };
}
