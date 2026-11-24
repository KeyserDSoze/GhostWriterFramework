import { PAGES_WORKFLOW_FILE } from "./pages-workflow.js";
import {
  READER_PASSWORD_SECRETS_VARIABLE,
  formatReaderPasswordSecretNames,
  parseReaderPasswordSecretNames,
} from "./lib/reader-secret-names.js";

/**
 * GitHub Pages of a book repository, on and off, through any Octokit-style `request(route, parameters)` (`octokit.request` as it is): no
 * import of Octokit, Node or the DOM, so that the Narrarium site and a script use the same steps and the tests use a fake.
 *
 * Turning Pages off keeps, by default, the workflow file, the variable READER_PASSWORD_SECRETS and the password secrets: only the site is
 * taken down, and the workflow is paused (GitHub's «disable workflow») so that pushes do not run a build that would fail without a site.
 * The second, explicit choice (`removePasswords`) also deletes the variable and every reader password secret.
 *
 * Permissions (fine-grained token or GitHub App): Pages read/write and Administration read/write to turn Pages on and off; Actions
 * read/write to pause, resume and run the workflow; Variables read/write for READER_PASSWORD_SECRETS; Secrets read/write for the passwords.
 */

export type GitHubRequest = (route: string, parameters?: Record<string, unknown>) => Promise<{ status: number; data?: unknown }>;

export interface RepositoryRef {
  owner: string;
  repo: string;
}

export interface PagesSite {
  /** `workflow` (built by Actions, what the reader needs) or `legacy` (built from a branch). */
  buildType: string | null;
  url: string | null;
  htmlUrl: string | null;
  status: string | null;
  public: boolean | null;
  cname: string | null;
}

export class PagesRequestError extends Error {
  constructor(readonly step: string, readonly status: number | undefined, cause: unknown) {
    super(`GitHub refused «${step}»${status ? ` (${status})` : ""}.`);
    this.name = "PagesRequestError";
    this.cause = cause;
  }
}

/** The legacy single password secret: a reader password too, removed with the others. */
export const LEGACY_READER_PASSWORD_SECRET = "NARRARIUM_READER_PASSWORD";

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function toSite(data: unknown): PagesSite {
  const record = (data ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    buildType: text(record.build_type),
    url: text(record.url),
    htmlUrl: text(record.html_url),
    status: text(record.status),
    public: typeof record.public === "boolean" ? record.public : null,
    cname: text(record.cname),
  };
}

async function call<T>(step: string, run: () => Promise<T>, tolerated: number[] = []): Promise<T | { tolerated: number }> {
  try {
    return await run();
  } catch (error) {
    const status = statusOf(error);
    if (status !== undefined && tolerated.includes(status)) return { tolerated: status };
    throw new PagesRequestError(step, status, error);
  }
}

function isTolerated(value: unknown): value is { tolerated: number } {
  return Boolean(value && typeof value === "object" && "tolerated" in value);
}

/** The Pages site of the repository, or null when Pages is off. */
export async function readPagesSite(request: GitHubRequest, repository: RepositoryRef): Promise<PagesSite | null> {
  const response = await call("read Pages", () => request("GET /repos/{owner}/{repo}/pages", { ...repository }), [404]);
  return isTolerated(response) ? null : toSite(response.data);
}

export type WorkflowState = "active" | "paused" | "missing" | string;

/** The state of the Pages workflow: `active`, `paused` (disabled by hand or by `disablePagesSite`), `missing`, or what GitHub says. */
export async function readPagesWorkflowState(request: GitHubRequest, repository: RepositoryRef, workflowFile = PAGES_WORKFLOW_FILE): Promise<WorkflowState> {
  const response = await call("read the Pages workflow", () => request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}", { ...repository, workflow_id: workflowFile }), [404]);
  if (isTolerated(response)) return "missing";
  const state = String((response.data as { state?: unknown } | undefined)?.state ?? "");
  return state.startsWith("disabled") ? "paused" : state || "active";
}

export interface EnablePagesResult {
  /** `created`: Pages turned on; `already-on`: it was, built by Actions; `switched-to-workflow`: it was on, built from a branch, and now by Actions. */
  pages: "created" | "already-on" | "switched-to-workflow";
  workflow: "resumed" | "active" | "missing";
  site: PagesSite | null;
}

/** Turns Pages on, built by GitHub Actions (`build_type: workflow`), and resumes the Pages workflow if it was paused. */
export async function enablePagesSite(request: GitHubRequest, repository: RepositoryRef, options: { workflowFile?: string } = {}): Promise<EnablePagesResult> {
  const workflowFile = options.workflowFile ?? PAGES_WORKFLOW_FILE;
  let pages: EnablePagesResult["pages"] = "created";
  let site: PagesSite | null = null;
  const created = await call("turn Pages on", () => request("POST /repos/{owner}/{repo}/pages", { ...repository, build_type: "workflow" }), [409]);
  if (isTolerated(created)) {
    site = await readPagesSite(request, repository);
    if (site && site.buildType !== "workflow") {
      await call("build Pages with Actions", () => request("PUT /repos/{owner}/{repo}/pages", { ...repository, build_type: "workflow" }));
      pages = "switched-to-workflow";
      site = { ...site, buildType: "workflow" };
    } else {
      pages = "already-on";
    }
  } else {
    site = toSite(created.data);
  }

  const state = await readPagesWorkflowState(request, repository, workflowFile);
  let workflow: EnablePagesResult["workflow"] = state === "missing" ? "missing" : "active";
  if (state === "paused") {
    await call("resume the Pages workflow", () => request("PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable", { ...repository, workflow_id: workflowFile }));
    workflow = "resumed";
  }
  return { pages, workflow, site };
}

export interface DisablePagesOptions {
  /** Pause the Pages workflow too (default): a push would otherwise run a build that fails without a site. */
  pauseWorkflow?: boolean;
  /** The explicit second choice: delete READER_PASSWORD_SECRETS and every reader password secret (the listed ones and NARRARIUM_READER_PASSWORD). */
  removePasswords?: boolean;
  workflowFile?: string;
}

export interface DisablePagesResult {
  pages: "disabled" | "already-off";
  workflow: "paused" | "kept" | "missing";
  variable: "deleted" | "kept" | "missing";
  /** The password secrets deleted. */
  removedSecrets: string[];
  /** What GitHub refused along the way (the steps after a refusal still run); empty when everything went through. */
  failures: Array<{ step: string; status?: number }>;
}

/**
 * Turns Pages off. By default the workflow file, the variable and the secrets stay (the workflow is only paused); with `removePasswords`
 * the variable is deleted first (so no build ever lists a secret that is gone), then the secrets.
 */
export async function disablePagesSite(request: GitHubRequest, repository: RepositoryRef, options: DisablePagesOptions = {}): Promise<DisablePagesResult> {
  const workflowFile = options.workflowFile ?? PAGES_WORKFLOW_FILE;
  const result: DisablePagesResult = { pages: "disabled", workflow: "kept", variable: "kept", removedSecrets: [], failures: [] };
  const attempt = async <T>(step: string, run: () => Promise<T>, tolerated: number[] = []) => {
    try {
      return await call(step, run, tolerated);
    } catch (error) {
      result.failures.push({ step, status: error instanceof PagesRequestError ? error.status : undefined });
      return undefined;
    }
  };

  if (options.pauseWorkflow !== false) {
    const paused = await attempt("pause the Pages workflow", () => request("PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable", { ...repository, workflow_id: workflowFile }), [404]);
    if (paused !== undefined) result.workflow = isTolerated(paused) ? "missing" : "paused";
  }

  const deleted = await call("turn Pages off", () => request("DELETE /repos/{owner}/{repo}/pages", { ...repository }), [404]);
  result.pages = isTolerated(deleted) ? "already-off" : "disabled";

  if (options.removePasswords) {
    let names: string[] = [];
    try {
      names = (await readReaderPasswordNames(request, repository)) ?? [];
    } catch (error) {
      result.failures.push({ step: "read READER_PASSWORD_SECRETS", status: error instanceof PagesRequestError ? error.status : undefined });
    }
    const removedVariable = await attempt("delete READER_PASSWORD_SECRETS", () => request("DELETE /repos/{owner}/{repo}/actions/variables/{name}", { ...repository, name: READER_PASSWORD_SECRETS_VARIABLE }), [404]);
    if (removedVariable !== undefined) result.variable = isTolerated(removedVariable) ? "missing" : "deleted";
    for (const name of [...new Set([...names, LEGACY_READER_PASSWORD_SECRET])]) {
      const removed = await attempt(`delete the secret ${name}`, () => request("DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}", { ...repository, secret_name: name }), [404]);
      if (removed !== undefined && !isTolerated(removed)) result.removedSecrets.push(name);
    }
  }
  return result;
}

/** The names READER_PASSWORD_SECRETS lists, or null when the variable does not exist. */
export async function readReaderPasswordNames(request: GitHubRequest, repository: RepositoryRef): Promise<string[] | null> {
  const response = await call("read READER_PASSWORD_SECRETS", () => request("GET /repos/{owner}/{repo}/actions/variables/{name}", { ...repository, name: READER_PASSWORD_SECRETS_VARIABLE }), [404]);
  if (isTolerated(response)) return null;
  return parseReaderPasswordSecretNames(String((response.data as { value?: unknown } | undefined)?.value ?? "")).names;
}

/**
 * Writes READER_PASSWORD_SECRETS (created when missing); an empty list deletes it, which makes the book public at the next build. The
 * secrets themselves are written by the caller (a sealed box with the repository's public key) BEFORE the list names them, and deleted
 * AFTER the list stops naming them, so that no build ever lists a secret that is not there.
 */
export async function writeReaderPasswordNames(request: GitHubRequest, repository: RepositoryRef, names: string[]): Promise<"created" | "updated" | "deleted" | "unchanged"> {
  const value = formatReaderPasswordSecretNames(names);
  if (!value) {
    const removed = await call("delete READER_PASSWORD_SECRETS", () => request("DELETE /repos/{owner}/{repo}/actions/variables/{name}", { ...repository, name: READER_PASSWORD_SECRETS_VARIABLE }), [404]);
    return isTolerated(removed) ? "unchanged" : "deleted";
  }
  const updated = await call("update READER_PASSWORD_SECRETS", () => request("PATCH /repos/{owner}/{repo}/actions/variables/{name}", { ...repository, name: READER_PASSWORD_SECRETS_VARIABLE, value }), [404]);
  if (!isTolerated(updated)) return "updated";
  await call("create READER_PASSWORD_SECRETS", () => request("POST /repos/{owner}/{repo}/actions/variables", { ...repository, name: READER_PASSWORD_SECRETS_VARIABLE, value }));
  return "created";
}

/** Runs the Pages workflow now (after a change of the passwords, or to publish again). */
export async function dispatchPagesWorkflow(request: GitHubRequest, repository: RepositoryRef, options: { ref: string; workflowFile?: string }): Promise<void> {
  await call("run the Pages workflow", () => request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", { ...repository, workflow_id: options.workflowFile ?? PAGES_WORKFLOW_FILE, ref: options.ref }));
}

export interface PagesRun {
  id: number;
  status: string | null;
  conclusion: string | null;
  htmlUrl: string | null;
  createdAt: string | null;
  event: string | null;
  headSha: string | null;
}

/** The latest run of the Pages workflow, or null when it never ran (or the file is missing). */
export async function readLatestPagesRun(request: GitHubRequest, repository: RepositoryRef, workflowFile = PAGES_WORKFLOW_FILE): Promise<PagesRun | null> {
  const response = await call("read the runs of the Pages workflow", () => request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", { ...repository, workflow_id: workflowFile, per_page: 1 }), [404]);
  if (isTolerated(response)) return null;
  const run = ((response.data as { workflow_runs?: Array<Record<string, unknown>> } | undefined)?.workflow_runs ?? [])[0];
  if (!run) return null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    id: Number(run.id),
    status: text(run.status),
    conclusion: text(run.conclusion),
    htmlUrl: text(run.html_url),
    createdAt: text(run.created_at),
    event: text(run.event),
    headSha: text(run.head_sha),
  };
}
