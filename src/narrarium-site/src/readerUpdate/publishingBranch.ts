import type { Octokit } from "@octokit/rest";
import { PAGES_WORKFLOW_PATH } from "@/github/bookRepository";
import type { BookTemplate } from "@/narrarium/bookTemplate";
import { RepositoryConflictError, type RepositoryTextMutation } from "@/repository/safeRepositoryMutation";
import { READER_DIR, READER_PACKAGE_JSON, planReaderFolder, templateReaderVersion, type ReaderFolderPlan } from "@/readerUpdate/folderPlan";

/**
 * The branch the reader is published from, which is the branch of the Pages workflow: the repository's DEFAULT branch (main, master, or whatever the
 * repository calls it), because GitHub runs the workflow that lives there. It is read from the repository, never taken from a list of names.
 *
 * An update of the reader has to land there, or the published site (and every check of the workflow) stays old. When the branch is not checked out on this
 * device, it is read and written on GitHub itself, through the repository's Git data API: the files are read from the branch's tree, and the update is ONE
 * commit on the branch's head (every file at once, or none), moved forward without force, so it can only land on the head it was planned against.
 */
export interface PublishingBranchRead {
  branch: string;
  /** Where its files were read: the working copy of the branch on this device, or GitHub. */
  source: "working-copy" | "github";
  /** The head of the branch the plan is made against. */
  headSha: string | null;
  /** The workflow's text; `null`: the branch has none. */
  workflowText: string | null;
  folder: ReaderFolderPlan;
  /** SHA-256 of the workflow in the working copy (`null` for GitHub and for no workflow). */
  workflowHash: string | null;
}

/** The SHA-1 that Git gives a blob: what GitHub's tree lists, so that a file can be compared with the template without being downloaded. */
export async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
}

function decode(content: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\s/g, "")), (character) => character.charCodeAt(0)));
}

function statusOf(error: unknown): number | undefined {
  return error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined;
}

interface Target { owner: string; repo: string }

/** What was read for a head: a branch that has not moved is not read again (the check runs whenever the card is looked at). */
const READS = new Map<string, PublishingBranchRead>();

export function forgetPublishingBranchReads(): void {
  READS.clear();
}

/** The reader's folder and workflow as GitHub has them on a branch, planned against the template. Throws when GitHub cannot be read. */
export async function readPublishingBranch(octokit: Octokit, target: Target, branch: string, template: Pick<BookTemplate, "files" | "placeholders">, fallbackPackageName: string): Promise<PublishingBranchRead> {
  const ref = await octokit.rest.git.getRef({ ...target, ref: `heads/${branch}` });
  const headSha = ref.data.object.sha;
  const cacheKey = `${target.owner}/${target.repo}/${branch}/${headSha}/${fallbackPackageName}/${templateReaderVersion(template) ?? ""}/${Object.keys(template.files).length}`.toLowerCase();
  const cached = READS.get(cacheKey);
  if (cached) return cached;
  const commit = await octokit.rest.git.getCommit({ ...target, commit_sha: headSha });
  const root = await octokit.rest.git.getTree({ ...target, tree_sha: commit.data.tree.sha });
  const readerEntry = root.data.tree.find((entry) => entry.path === READER_DIR && entry.type === "tree");
  const existing = new Map<string, string>();
  if (readerEntry?.sha) {
    const sub = await octokit.rest.git.getTree({ ...target, tree_sha: readerEntry.sha, recursive: "1" });
    // A tree GitHub cut short would make files look missing, and the update would «add» what is already there: nothing is planned from it.
    if (sub.data.truncated) throw Object.assign(new Error("The reader folder is too large to be listed."), { status: 413 });
    for (const entry of sub.data.tree) if (entry.type === "blob" && entry.path && entry.sha) existing.set(`${READER_DIR}/${entry.path}`, entry.sha);
  }
  let workflowText: string | null = null;
  try {
    const { data } = await octokit.rest.repos.getContent({ ...target, path: PAGES_WORKFLOW_PATH, ref: headSha });
    if (!Array.isArray(data) && data.type === "file" && "content" in data && typeof data.content === "string") workflowText = decode(data.content);
  } catch (error) { if (statusOf(error) !== 404) throw error; }
  const packageSha = existing.get(READER_PACKAGE_JSON);
  let existingPackageJson: string | null = null;
  if (packageSha) existingPackageJson = decode((await octokit.rest.git.getBlob({ ...target, file_sha: packageSha })).data.content);
  const folder = await planReaderFolder({ template, existing, existingPackageJson, fallbackPackageName, hash: gitBlobSha });
  const read: PublishingBranchRead = { branch, source: "github", headSha, workflowText, folder, workflowHash: null };
  READS.set(cacheKey, read);
  return read;
}

/** GitHub refused to move a branch because the branch is protected (a pull request, a review or a status check is required, or a rule). */
export class ProtectedBranchError extends Error {
  readonly code = "READER_BRANCH_PROTECTED";
  constructor(readonly branch: string, /** GitHub's own message, trimmed: it says what the branch requires. */ readonly githubMessage: string) {
    super(`The branch ${branch} is protected.`);
    this.name = "ProtectedBranchError";
  }
}

const PROTECTED = /protected branch|required status check|must be made through a pull request|pull request is required|repository rule|rule violations?|review is required|required review|branch protection/i;

/** Whether a failure of a push to a branch is its protection speaking (and not a head that moved, or a network failure). */
export function isProtectedBranchRefusal(error: unknown): boolean {
  const status = statusOf(error);
  const message = error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "";
  return (status === 403 || status === 422 || status === 409) && PROTECTED.test(message);
}

export function githubMessageOf(error: unknown): string {
  const message = error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "";
  return message.replace(/\s+/g, " ").replace(/\s*-\s*https?:\/\/\S+$/i, "").trim().slice(0, 300);
}

type TreeEntry = { path: string; mode: "100644"; type: "blob"; content?: string; sha?: null };

function treeOf(mutations: readonly RepositoryTextMutation[]): TreeEntry[] {
  return mutations.filter((mutation) => mutation.content !== undefined).map((mutation) => ({ path: mutation.path, mode: "100644" as const, type: "blob" as const, ...(mutation.content === null ? { sha: null } : { content: mutation.content }) }));
}

async function makeCommit(octokit: Octokit, target: Target, baseHeadSha: string, message: string, mutations: readonly RepositoryTextMutation[]): Promise<string> {
  const base = await octokit.rest.git.getCommit({ ...target, commit_sha: baseHeadSha });
  const tree = await octokit.rest.git.createTree({ ...target, base_tree: base.data.tree.sha, tree: treeOf(mutations) });
  const commit = await octokit.rest.git.createCommit({ ...target, message, tree: tree.data.sha, parents: [baseHeadSha] });
  return commit.data.sha;
}

/**
 * ONE commit on a branch that is not checked out here: the files of the update, on the head the plan was made against, then the branch moved to it WITHOUT
 * force. A head that has moved since (the plan is stale) is a conflict and nothing is written; a protected branch is `ProtectedBranchError`, with GitHub's words.
 */
export async function commitUpdateToBranch(octokit: Octokit, target: Target, input: { branch: string; expectedHeadSha: string; message: string; mutations: readonly RepositoryTextMutation[] }): Promise<{ commitSha: string }> {
  const ref = await octokit.rest.git.getRef({ ...target, ref: `heads/${input.branch}` });
  if (ref.data.object.sha !== input.expectedHeadSha) throw new RepositoryConflictError(`The branch ${input.branch} changed after the check.`);
  const commitSha = await makeCommit(octokit, target, input.expectedHeadSha, input.message, input.mutations);
  try {
    await octokit.rest.git.updateRef({ ...target, ref: `heads/${input.branch}`, sha: commitSha, force: false });
  } catch (error) {
    if (isProtectedBranchRefusal(error)) throw new ProtectedBranchError(input.branch, githubMessageOf(error));
    if (statusOf(error) === 422 || statusOf(error) === 409) throw new RepositoryConflictError(`The branch ${input.branch} changed after the check.`);
    throw error;
  }
  return { commitSha };
}

export interface UpdatePullRequest { url: string; number: number; branch: string }

/**
 * The way that works when the publishing branch is protected: the update goes on a new branch made from the branch's head, and a pull request from it is
 * opened (it is the author's to merge, with the reviews and checks the branch asks for). A name that is taken gets a suffix; nothing is ever forced.
 */
export async function openUpdatePullRequest(octokit: Octokit, target: Target, input: { base: string; baseHeadSha: string; message: string; mutations: readonly RepositoryTextMutation[]; title: string; body: string; now?: () => Date }): Promise<UpdatePullRequest> {
  const day = (input.now?.() ?? new Date()).toISOString().slice(0, 10).replace(/-/g, "");
  let branch = `narrarium/update-reader-${day}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await octokit.rest.git.createRef({ ...target, ref: `refs/heads/${branch}`, sha: input.baseHeadSha });
      break;
    } catch (error) {
      if (statusOf(error) !== 422 || attempt >= 5) throw error;
      branch = `narrarium/update-reader-${day}-${attempt + 2}`;
    }
  }
  const commitSha = await makeCommit(octokit, target, input.baseHeadSha, input.message, input.mutations);
  await octokit.rest.git.updateRef({ ...target, ref: `heads/${branch}`, sha: commitSha, force: false });
  const { data } = await octokit.rest.pulls.create({ ...target, head: branch, base: input.base, title: input.title, body: input.body });
  return { url: data.html_url, number: data.number, branch };
}
