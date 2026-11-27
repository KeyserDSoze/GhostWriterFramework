import type { Octokit } from "@octokit/rest";
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
  type DisablePagesResult,
  type EnablePagesResult,
  type GitHubRequest,
  type WorkflowState,
} from "narrarium-astro-reader/github-pages";
import { READER_WORKFLOW_FILE, READER_WORKFLOW_PATH } from "@/readerAccess/contract";
import { ReaderFlowError, classifyReaderFailure, type ReaderStep } from "@/readerAccess/errors";

/**
 * The calls to GitHub the reader's access needs, one function each, over an Octokit client that the caller makes (the site's tracked client, or a fake in a
 * test). A call that fails throws a `ReaderFlowError` with the classified failure: GitHub's own message and the request never leave this module, so a
 * password (only ever in the sealed value) and a token cannot end up in an error.
 */
export interface RepositoryRef { owner: string; repo: string }

/**
 * What the reader package's Pages helpers do (Pages on and off, the workflow's state, the variable of the passwords, the start of a run and its latest run) is
 * not done twice here: they run over the client's `request`. This module keeps what the package does not have (the repository, the public key, the secrets,
 * the text of the workflow file) and turns every failure, the package's `PagesRequestError` included, into the classified one the screens explain.
 */
function requestOf(octokit: Octokit): GitHubRequest {
  return (route, parameters) => (octokit.request as unknown as (route: string, parameters?: Record<string, unknown>) => Promise<{ status: number; data?: unknown }>)(route, parameters);
}

function causeOf(error: unknown): unknown {
  return error instanceof PagesRequestError ? (error as { cause?: unknown }).cause ?? { status: error.status } : error;
}

async function call<T>(step: ReaderStep, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { throw new ReaderFlowError(step, classifyReaderFailure(causeOf(error), step)); }
}

function statusOf(error: unknown): number | undefined {
  return error instanceof ReaderFlowError && "status" in error.failure ? error.failure.status : undefined;
}

export interface RepositoryInfo { private: boolean; defaultBranch: string; htmlUrl: string; canAdminister: boolean; canPush: boolean; ownerLogin: string; ownerType: "User" | "Organization" }

export async function getRepositoryInfo(octokit: Octokit, repo: RepositoryRef): Promise<RepositoryInfo> {
  const { data } = await call("repository", () => octokit.rest.repos.get({ ...repo }));
  return { private: data.private, defaultBranch: data.default_branch || "main", htmlUrl: data.html_url, canAdminister: data.permissions?.admin === true, canPush: data.permissions?.push === true, ownerLogin: data.owner?.login ?? repo.owner, ownerType: data.owner?.type === "Organization" ? "Organization" : "User" };
}

export async function getPublicKey(octokit: Octokit, repo: RepositoryRef): Promise<{ keyId: string; key: string }> {
  const { data } = await call("public-key", () => octokit.rest.actions.getRepoPublicKey({ ...repo }));
  return { keyId: data.key_id, key: data.key };
}

/** `sealed` is the already encrypted value (base64): nothing in plain text reaches this module. */
export async function putSecret(octokit: Octokit, repo: RepositoryRef, name: string, sealed: string, keyId: string): Promise<void> {
  await call("secret-write", () => octokit.rest.actions.createOrUpdateRepoSecret({ ...repo, secret_name: name, encrypted_value: sealed, key_id: keyId }));
}

/** Deleting a secret that is already gone is the outcome that was wanted. */
export async function deleteSecret(octokit: Octokit, repo: RepositoryRef, name: string): Promise<void> {
  try { await call("secret-delete", () => octokit.rest.actions.deleteRepoSecret({ ...repo, secret_name: name })); }
  catch (error) { if (statusOf(error) !== 404) throw error; }
}

/** The names of the repository's secrets (never a value: GitHub does not give them). */
export async function listSecretNames(octokit: Octokit, repo: RepositoryRef): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const { data } = await call("secrets-list", () => octokit.rest.actions.listRepoSecrets({ ...repo, per_page: 100, page }));
    names.push(...data.secrets.map((secret) => secret.name));
    if (data.secrets.length < 100) break;
  }
  return names;
}

/** The names the variable lists, or an empty list when there is no variable. */
export async function readPasswordVariable(octokit: Octokit, repo: RepositoryRef): Promise<{ names: string[]; exists: boolean }> {
  const names = await call("variable-read", () => readReaderPasswordNames(requestOf(octokit), repo));
  return { names: names ?? [], exists: names !== null };
}

/** Writes the variable, in the order given (created when it does not exist yet). An empty list deletes it: a variable with no value is not something to depend on. */
export async function writePasswordVariable(octokit: Octokit, repo: RepositoryRef, names: string[]): Promise<void> {
  await call(names.length ? "variable-write" : "variable-delete", () => writeReaderPasswordNames(requestOf(octokit), repo, names));
}

/** Starts the publishing workflow on a branch (`workflow_dispatch` on the reader's workflow file). */
export async function dispatchWorkflow(octokit: Octokit, repo: RepositoryRef, ref: string): Promise<void> {
  await call("dispatch", () => dispatchPagesWorkflow(requestOf(octokit), repo, { ref }));
}

export type RunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface WorkflowRun { id: number; state: RunState; url: string; createdAt: string; headSha?: string }

function runState(status: string | null, conclusion: string | null): RunState {
  if (status === "completed") return conclusion === "success" ? "succeeded" : conclusion === "cancelled" ? "cancelled" : "failed";
  return status === "in_progress" ? "running" : "queued";
}

/** The latest run of the reader's workflow (a list of none or one). */
export async function latestRuns(octokit: Octokit, repo: RepositoryRef): Promise<WorkflowRun[]> {
  const run = await call("runs", () => readLatestPagesRun(requestOf(octokit), repo));
  return run ? [{ id: run.id, state: runState(run.status, run.conclusion), url: run.htmlUrl ?? "", createdAt: run.createdAt ?? "", ...(run.headSha ? { headSha: run.headSha } : {}) }] : [];
}

/** A run of the publishing workflow with what is needed to tell which action made it: its trigger (`event`), branch and commit. */
export interface PublishingRun {
  id: number;
  state: RunState;
  event: string;
  branch: string;
  headSha: string;
  createdAt: string;
  /** When the run began to execute (it is `createdAt` until then). */
  startedAt: string;
  updatedAt: string;
  url: string;
}

interface RawRun {
  id: number; status: string | null; conclusion: string | null; event?: string; head_branch?: string | null; head_sha?: string; created_at?: string; run_started_at?: string; updated_at?: string; html_url?: string;
}

function publishingRun(run: RawRun): PublishingRun {
  return {
    id: run.id,
    state: runState(run.status, run.conclusion),
    event: run.event ?? "",
    branch: run.head_branch ?? "",
    headSha: run.head_sha ?? "",
    createdAt: run.created_at ?? "",
    startedAt: run.run_started_at ?? run.created_at ?? "",
    updatedAt: run.updated_at ?? run.created_at ?? "",
    url: run.html_url ?? "",
  };
}

/** The newest runs of the publishing workflow (newest first), optionally only the ones made by an event or that ended in a state. A workflow that never ran has none. */
export async function listPublishingRuns(octokit: Octokit, repo: RepositoryRef, options: { event?: string; success?: boolean; perPage?: number } = {}): Promise<PublishingRun[]> {
  try {
    const { data } = await call("runs", () => octokit.rest.actions.listWorkflowRuns({ ...repo, workflow_id: READER_WORKFLOW_FILE, per_page: options.perPage ?? 20, ...(options.event ? { event: options.event } : {}), ...(options.success ? { status: "success" as const } : {}) }));
    return (data.workflow_runs as RawRun[]).map(publishingRun);
  } catch (error) {
    if (statusOf(error) === 404) return [];
    throw error;
  }
}

/** One run by its id (the poll of a run that is already known). */
export async function getPublishingRun(octokit: Octokit, repo: RepositoryRef, runId: number): Promise<PublishingRun> {
  const { data } = await call("runs", () => octokit.rest.actions.getWorkflowRun({ ...repo, run_id: runId }));
  return publishingRun(data as unknown as RawRun);
}

/** What a run is doing now: the job and the step in progress (the first one that is not finished), and how many steps its job has. `null` when nothing is in progress yet. */
export interface RunProgress { job: string; step: string; index: number; total: number }

export async function readRunProgress(octokit: Octokit, repo: RepositoryRef, runId: number): Promise<RunProgress | null> {
  const { data } = await call("runs", () => octokit.rest.actions.listJobsForWorkflowRun({ ...repo, run_id: runId, per_page: 30 }));
  const job = data.jobs.find((entry) => entry.status === "in_progress") ?? data.jobs.find((entry) => entry.status === "queued");
  if (!job) return null;
  const steps = job.steps ?? [];
  const index = steps.findIndex((step) => step.status === "in_progress");
  if (index < 0) return { job: job.name, step: "", index: 0, total: steps.length };
  return { job: job.name, step: steps[index].name, index: index + 1, total: steps.length };
}

/** Whether the repository has the reader's workflow file, and its text (for the check that it is the current one). */
export async function readWorkflowFile(octokit: Octokit, repo: RepositoryRef, ref?: string): Promise<{ present: boolean; content?: string }> {
  try {
    const { data } = await call("workflow-read", () => octokit.rest.repos.getContent({ ...repo, path: READER_WORKFLOW_PATH, ...(ref ? { ref } : {}) }));
    if (Array.isArray(data) || data.type !== "file") return { present: false };
    const content = "content" in data && typeof data.content === "string" ? new TextDecoder().decode(Uint8Array.from(atob(data.content.replace(/\s/g, "")), (character) => character.charCodeAt(0))) : undefined;
    return { present: true, ...(content !== undefined ? { content } : {}) };
  } catch (error) {
    if (statusOf(error) === 404) return { present: false };
    throw error;
  }
}

export type PagesState =
  | { status: "enabled"; url: string; buildType: string | null }
  | { status: "off" };

export async function getPagesState(octokit: Octokit, repo: RepositoryRef): Promise<PagesState> {
  const site = await call("pages-read", () => readPagesSite(requestOf(octokit), repo));
  return site ? { status: "enabled", url: site.htmlUrl ?? `https://${repo.owner}.github.io/${repo.repo}/`, buildType: site.buildType } : { status: "off" };
}

/** `active`, `paused` (turned off by hand or by turning Pages off), `missing`, or what GitHub says; `null` when it could not be read. */
export async function getWorkflowState(octokit: Octokit, repo: RepositoryRef): Promise<WorkflowState> {
  return call("workflow-read", () => readPagesWorkflowState(requestOf(octokit), repo));
}

/** Turns Pages on with the workflow as its source (and resumes the workflow if it was paused); Pages already on is the outcome that was wanted. */
export async function enablePages(octokit: Octokit, repo: RepositoryRef): Promise<EnablePagesResult> {
  return call("pages-enable", () => enablePagesSite(requestOf(octokit), repo));
}

/** Turns Pages off (the workflow is paused); with `removePasswords` the variable and the reader's secrets go too. What GitHub refused along the way is in `failures`. */
export async function disablePages(octokit: Octokit, repo: RepositoryRef, options: { removePasswords?: boolean } = {}): Promise<DisablePagesResult> {
  return call("pages-disable", () => disablePagesSite(requestOf(octokit), repo, options));
}

/** A job of a run, with the annotations GitHub put on it (the reason a job that never started did not start is only there). */
export interface RunJobRead { id: number; name: string; conclusion: string | null; steps: number; annotations: string[] }
export interface RunFailureRead { runId: number; jobs: RunJobRead[]; /** The jobs could be listed but the annotations of at least one could not be read. */ annotationsUnreadable: boolean }

const MAX_JOBS = 5;

/**
 * Why a run failed, as far as GitHub says: its jobs, and the annotations of the ones that did not succeed (`GET /repos/{o}/{r}/check-runs/{job_id}/annotations`).
 * A job that did not start has no steps, and its only explanation is an annotation such as «The job was not started because an Actions budget is preventing
 * further use». Annotations need the «Checks» read permission; when they cannot be read the run is still reported, with `annotationsUnreadable`.
 */
export async function readRunFailure(octokit: Octokit, repo: RepositoryRef, runId: number): Promise<RunFailureRead> {
  const { data } = await call("run-failure", () => octokit.rest.actions.listJobsForWorkflowRun({ ...repo, run_id: runId, per_page: 30 }));
  const failed = data.jobs.filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped").slice(0, MAX_JOBS);
  let annotationsUnreadable = false;
  const jobs: RunJobRead[] = [];
  for (const job of failed) {
    let annotations: string[] = [];
    try {
      const { data: found } = await call("run-failure", () => octokit.rest.checks.listAnnotations({ ...repo, check_run_id: job.id, per_page: 50 }));
      annotations = found.map((annotation) => String(annotation.message ?? "")).filter(Boolean);
    } catch { annotationsUnreadable = true; }
    jobs.push({ id: job.id, name: job.name, conclusion: job.conclusion, steps: job.steps?.length ?? 0, annotations });
  }
  return { runId, jobs, annotationsUnreadable };
}
