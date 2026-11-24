import type { Octokit } from "@octokit/rest";
import { READER_PASSWORDS_VARIABLE, READER_WORKFLOW_FILE, READER_WORKFLOW_PATH, parseReaderVariable } from "@/readerAccess/contract";
import { ReaderFlowError, classifyReaderFailure, type ReaderStep } from "@/readerAccess/errors";

/**
 * The calls to GitHub the reader's access needs, one function each, over an Octokit client that the caller makes (the site's tracked client, or a fake in a
 * test). A call that fails throws a `ReaderFlowError` with the classified failure: GitHub's own message and the request never leave this module, so a
 * password (only ever in the sealed value) and a token cannot end up in an error.
 */
export interface RepositoryRef { owner: string; repo: string }

async function call<T>(step: ReaderStep, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { throw new ReaderFlowError(step, classifyReaderFailure(error, step)); }
}

function statusOf(error: unknown): number | undefined {
  return error instanceof ReaderFlowError && "status" in error.failure ? error.failure.status : undefined;
}

export interface RepositoryInfo { private: boolean; defaultBranch: string; htmlUrl: string; canAdminister: boolean; canPush: boolean }

export async function getRepositoryInfo(octokit: Octokit, repo: RepositoryRef): Promise<RepositoryInfo> {
  const { data } = await call("repository", () => octokit.rest.repos.get({ ...repo }));
  return { private: data.private, defaultBranch: data.default_branch || "main", htmlUrl: data.html_url, canAdminister: data.permissions?.admin === true, canPush: data.permissions?.push === true };
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
  try {
    const { data } = await call("variable-read", () => octokit.rest.actions.getRepoVariable({ ...repo, name: READER_PASSWORDS_VARIABLE }));
    return { names: parseReaderVariable(data.value), exists: true };
  } catch (error) {
    if (statusOf(error) === 404) return { names: [], exists: false };
    throw error;
  }
}

/** Writes the variable (creating it when it does not exist yet). An empty list deletes it: a variable with no value is not something to depend on. */
export async function writePasswordVariable(octokit: Octokit, repo: RepositoryRef, value: string, exists: boolean): Promise<{ exists: boolean }> {
  if (!value) {
    if (exists) {
      try { await call("variable-delete", () => octokit.rest.actions.deleteRepoVariable({ ...repo, name: READER_PASSWORDS_VARIABLE })); }
      catch (error) { if (statusOf(error) !== 404) throw error; }
    }
    return { exists: false };
  }
  if (exists) {
    try {
      await call("variable-write", () => octokit.rest.actions.updateRepoVariable({ ...repo, name: READER_PASSWORDS_VARIABLE, value }));
      return { exists: true };
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
  }
  try {
    await call("variable-write", () => octokit.rest.actions.createRepoVariable({ ...repo, name: READER_PASSWORDS_VARIABLE, value }));
  } catch (error) {
    // Created by someone in the meantime: it is there now, and an update is what was meant.
    if (statusOf(error) !== 409 && statusOf(error) !== 422) throw error;
    await call("variable-write", () => octokit.rest.actions.updateRepoVariable({ ...repo, name: READER_PASSWORDS_VARIABLE, value }));
  }
  return { exists: true };
}

/** Starts the publishing workflow on a branch (`workflow_dispatch` on the reader's workflow file). */
export async function dispatchWorkflow(octokit: Octokit, repo: RepositoryRef, ref: string): Promise<void> {
  await call("dispatch", () => octokit.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: READER_WORKFLOW_FILE, ref }));
}

export type RunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface WorkflowRun { id: number; state: RunState; url: string; createdAt: string; branch?: string }

function runState(status: string | null, conclusion: string | null): RunState {
  if (status === "completed") return conclusion === "success" ? "succeeded" : conclusion === "cancelled" ? "cancelled" : "failed";
  return status === "in_progress" ? "running" : "queued";
}

/** The newest runs of the reader's workflow. */
export async function latestRuns(octokit: Octokit, repo: RepositoryRef, limit = 5): Promise<WorkflowRun[]> {
  const { data } = await call("runs", () => octokit.rest.actions.listWorkflowRuns({ ...repo, workflow_id: READER_WORKFLOW_FILE, per_page: limit }));
  return data.workflow_runs.map((run) => ({ id: run.id, state: runState(run.status, run.conclusion), url: run.html_url, createdAt: run.created_at, ...(run.head_branch ? { branch: run.head_branch } : {}) }));
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
  try {
    const { data } = await call("pages-read", () => octokit.rest.repos.getPages({ ...repo }));
    return { status: "enabled", url: data.html_url ?? `https://${repo.owner}.github.io/${repo.repo}/`, buildType: data.build_type ?? null };
  } catch (error) {
    if (statusOf(error) === 404) return { status: "off" };
    throw error;
  }
}

/** Turns Pages on with the workflow as its source; Pages that is already on is the outcome that was wanted. */
export async function enablePages(octokit: Octokit, repo: RepositoryRef): Promise<void> {
  try { await call("pages-enable", () => octokit.rest.repos.createPagesSite({ ...repo, build_type: "workflow" })); }
  catch (error) { if (statusOf(error) !== 409) throw error; }
}

/** Turns Pages off; Pages that is already off is the outcome that was wanted. */
export async function disablePages(octokit: Octokit, repo: RepositoryRef): Promise<void> {
  try { await call("pages-disable", () => octokit.rest.repos.deletePagesSite({ ...repo })); }
  catch (error) { if (statusOf(error) !== 404) throw error; }
}
