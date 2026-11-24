import type { Octokit } from "@octokit/rest";
import { createTrackedGitHubClient } from "@/repository/githubRequest";
import { classifyRepositoryError, type RepositoryErrorKind } from "@/repository/repositoryError";
import { RepositoryByteMeter, RepositoryLimitExceededError, bytesToBase64, utf8Bytes } from "@/repository/repositoryLimits";

/**
 * Creates a complete book repository on GitHub from the files of a book: the repository, its first commit with every file but the workflows, a
 * second commit with the Pages workflow alone, and, when asked, GitHub Pages. It is the one place that does it: the page that adds a book and the
 * «connect this book to GitHub» card of a book that lives on this device both call it, so that both make the same repository (the files come from
 * `@/narrarium/bookTemplate`; this module knows nothing of what a book is).
 *
 * The order is the one that leaves the least behind when something is refused:
 *  1. `GET /user`, then `GET /repos/{owner}/{repo}` (a name that is free answers 404), then the repository with `auto_init: false`;
 *  2. the FIRST COMMIT, every file that is not a workflow: text goes inline in `POST /git/trees` (no request for each file), binaries through
 *     `POST /git/blobs`, the tree in chunks chained with `base_tree` so that no request body is more than a few MB, `POST /git/commits`
 *     with no parent, `POST /git/refs`. GitHub's reference says no reference can be created on an empty repository, yet that is what this
 *     sequence has always done; so when GitHub refuses it (409/422, or «empty»), the same commit is published the way that is documented to
 *     work: `PUT /contents/README.md` makes the default branch, then `PATCH /git/refs/heads/{branch}` with `force: true` moves it to the commit
 *     we built (safe: the repository is new and one root commit is wanted). The direct way goes first because it is one request fewer and
 *     leaves no bootstrap commit behind when it works; the fallback runs at most once;
 *  3. GitHub Pages when asked (`POST /pages` with `build_type: "workflow"`), before the workflow lands so that its first run finds a site;
 *  4. the SECOND COMMIT: the workflow files alone, on top of the first. A token without the permission to write workflows is refused there, and
 *     that costs nothing: the repository stays, complete without them, and the result says `workflow: "not-allowed"`.
 * Whatever fails after the repository exists says so (`BookRepositoryError.repository`), so that the caller can retry the commit into the same
 * empty repository (`existing: "empty"`) or, only when the user asks, delete it (`deleteEmptyBookRepository`).
 */

export type BookRepositoryFile = { path: string; content: string } | { path: string; bytes: Uint8Array };

/** Which kind of credential made the request: a classic personal token (`ghp_`), a fine-grained one (`github_pat_`), or the user token of Narrarium's GitHub app (`ghu_`). */
export type GitHubTokenKind = "classic" | "fine-grained" | "app" | "unknown";

/** What a token is, from the prefix GitHub gives each kind. It decides only which words explain a refusal, never what is allowed: the creation is simply tried. */
export function classifyTokenKind(token: string): GitHubTokenKind {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghu_")) return "app";
  if (token.startsWith("ghp_") || token.startsWith("gho_")) return "classic";
  return "unknown";
}

/** The message of the one commit the fallback makes to give an empty repository its branch: it is how a retry knows that commit is ours and not someone's history. */
export const BOOTSTRAP_MESSAGE = "Initialize repository";

export const PAGES_WORKFLOW_PATH = ".github/workflows/deploy-reader-pages.yml";

/** Any file a token needs the permission to write workflows for: only the root `.github/workflows` runs, but GitHub is not known to look at which. */
export function isWorkflowPath(path: string): boolean {
  return /(^|\/)\.github\/workflows\/[^/]+$/.test(path);
}

/** A tree request carries at most this many bytes of content, and this many entries, so that none is more than a few MB. */
export const TREE_CHUNK_MAX_BYTES = 1_500_000;
export const TREE_CHUNK_MAX_ENTRIES = 150;
/** Blobs for binary files are the only request that grows with the number of files; they run a few at a time. */
const BLOB_CONCURRENCY = 3;

export type BookRepositoryStep = "preflight" | "repository" | "first-commit" | "pages" | "protection" | "workflow" | "done";
export interface BookRepositoryProgress { step: BookRepositoryStep; chunk?: number; chunks?: number }

export type BookRepositoryWarningCode =
  | "bootstrap-path"
  | "branch-not-main"
  | "workflow-not-allowed"
  | "workflow-failed"
  | "workflow-rate-limit"
  | "pages-plan"
  | "pages-refused"
  | "pages-failed";

export interface BookRepositoryWarning { code: BookRepositoryWarningCode; status?: number; resetAt?: string }

export interface CreateCompleteBookRepositoryResult {
  id: number;
  owner: string;
  repo: string;
  defaultBranch: string;
  htmlUrl: string;
  private: boolean;
  committed: { files: number; bytes: number };
  /** `held`: the step before the workflow (`beforeWorkflow`) failed, so the workflow was NOT committed (see `CreateCompleteBookRepositoryInput.beforeWorkflow`). */
  workflow: "done" | "not-allowed" | "skipped" | "held";
  pages: "enabled" | "manual" | "skipped";
  /** The outcome of `beforeWorkflow`: `skipped` (or absent) when there was none, `failed` with whatever it threw. */
  beforeWorkflow?: { status: "skipped" | "done" } | { status: "failed"; error: unknown };
  warnings: BookRepositoryWarning[];
  /** The commit the branch is at, and the sha of every file that landed (a git blob hash, worked out here, not asked of GitHub). */
  headSha: string;
  shas: Record<string, string>;
  /** Which way the first commit went: `direct`, or `bootstrap` when GitHub refused the direct one. */
  firstCommitPath: "direct" | "bootstrap";
  /** False when the repository was already there (an empty one the caller chose, or one it asked to overwrite). */
  createdRepository: boolean;
  /** The workflow files that did not land, for the user to add by hand. */
  pendingWorkflow: Array<{ path: string; content: string }>;
  /** The kind of token that made the repository: it says which permission to give when a step was refused. */
  tokenKind?: GitHubTokenKind;
}

export type BookRepositoryErrorCode =
  | "invalid-name"
  | "no-files"
  | "name-taken"
  | "not-found"
  | "not-empty"
  | "owner-unavailable"
  | "cannot-create"
  | "create-rejected"
  | "credential-invalid"
  | "rate-limit"
  | "network"
  | "aborted"
  | "too-large"
  | "first-commit-failed"
  | "cannot-delete"
  | "unknown";

export interface BookRepositoryReference {
  owner: string;
  repo: string;
  htmlUrl: string;
  defaultBranch: string;
  /** True when this call made the repository (so deleting it later is something the user can be offered). */
  created: boolean;
}

export class BookRepositoryError extends Error {
  constructor(
    readonly code: BookRepositoryErrorCode,
    options: { status?: number; resetAt?: string; reason?: RepositoryErrorKind; repository?: BookRepositoryReference; detail?: string; cause?: unknown; tokenKind?: GitHubTokenKind } = {},
  ) {
    super(`BOOK_REPOSITORY_${code.replace(/-/g, "_").toUpperCase()}`);
    this.name = "BookRepositoryError";
    this.status = options.status;
    this.resetAt = options.resetAt;
    this.reason = options.reason;
    this.repository = options.repository;
    this.detail = options.detail;
    this.cause = options.cause;
    this.tokenKind = options.tokenKind;
  }
  /** Set when the refusal depends on what kind of token it was (the words for an app token name the permission to give). */
  readonly tokenKind?: GitHubTokenKind;
  readonly status?: number;
  readonly resetAt?: string;
  /** What GitHub's answer was classified as when the first commit failed: a rate limit, a credential that stopped working, the network... */
  readonly reason?: RepositoryErrorKind;
  /** Set when the repository exists and has no first commit: it can be filled again or deleted. */
  readonly repository?: BookRepositoryReference;
  readonly detail?: string;
  readonly cause?: unknown;
}

export function isBookRepositoryError(error: unknown, code?: BookRepositoryErrorCode): error is BookRepositoryError {
  return error instanceof BookRepositoryError && (code === undefined || error.code === code);
}

export type RepositoryNameProblem = "empty" | "too-long" | "characters" | "reserved";

/** What GitHub accepts as a repository name: letters, digits, dots, dashes and underscores, up to 100, not `.` or `..`, not ending in `.git`. */
export function repositoryNameProblem(name: string): RepositoryNameProblem | null {
  const value = name.trim();
  if (!value) return "empty";
  if (value.length > 100) return "too-long";
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return "characters";
  if (value === "." || value === ".." || /\.git$/i.test(value)) return "reserved";
  return null;
}

interface ApiFailure {
  status?: number;
  kind: RepositoryErrorKind;
  resetAt?: string;
  /** What GitHub said, lower case, for telling a few refusals apart: never shown, never stored. */
  message: string;
}

function failureOf(error: unknown): ApiFailure {
  const classified = classifyRepositoryError(error, "create");
  const record = error && typeof error === "object" ? error as { message?: unknown; response?: { data?: { message?: unknown; errors?: unknown } } } : {};
  const parts: string[] = [];
  if (typeof record.response?.data?.message === "string") parts.push(record.response.data.message);
  else if (typeof record.message === "string") parts.push(record.message);
  const errors = record.response?.data?.errors;
  if (Array.isArray(errors)) for (const entry of errors) parts.push(typeof entry === "string" ? entry : typeof (entry as { message?: unknown })?.message === "string" ? (entry as { message: string }).message : "");
  return { status: classified.status, kind: classified.kind, resetAt: classified.details?.rateLimitReset, message: parts.join(" ").slice(0, 600).toLowerCase() };
}

const isRateLimited = (failure: ApiFailure) => failure.kind === "rate-limit" || failure.kind === "abuse-limit";

/** The refusal GitHub gives when the Git Data API is used on a repository that has no branch yet. */
function isEmptyRepositoryRefusal(failure: ApiFailure): boolean {
  if (isRateLimited(failure) || failure.kind === "credential-invalid" || failure.kind === "network" || failure.kind === "abort") return false;
  return failure.status === 409 || failure.status === 422 || /\bempty\b/.test(failure.message);
}

function reference(repository: { owner: string; repo: string; htmlUrl: string; defaultBranch: string }, created: boolean): BookRepositoryReference {
  return { owner: repository.owner, repo: repository.repo, htmlUrl: repository.htmlUrl, defaultBranch: repository.defaultBranch, created };
}

/** A repository answer to a failure of the first commit: the repository exists and has none. */
function firstCommitFailure(error: unknown, repository: BookRepositoryReference): BookRepositoryError {
  if (error instanceof BookRepositoryError) return error.code === "first-commit-failed" ? error : new BookRepositoryError("first-commit-failed", { ...pick(error), repository });
  if (error instanceof RepositoryLimitExceededError) return new BookRepositoryError("too-large", { repository, cause: error });
  const failure = failureOf(error);
  return new BookRepositoryError("first-commit-failed", { status: failure.status, resetAt: failure.resetAt, reason: failure.kind, repository, cause: error });
}

function pick(error: BookRepositoryError) {
  return { status: error.status, resetAt: error.resetAt, reason: error.reason, cause: error.cause };
}

/** A failure before the repository exists, as the error the caller shows. */
function earlyFailure(error: unknown, fallback: BookRepositoryErrorCode): BookRepositoryError {
  if (error instanceof BookRepositoryError) return error;
  const failure = failureOf(error);
  if (error instanceof RepositoryLimitExceededError) return new BookRepositoryError("too-large", { cause: error });
  const options = { status: failure.status, resetAt: failure.resetAt, reason: failure.kind, cause: error };
  if (isRateLimited(failure)) return new BookRepositoryError("rate-limit", options);
  if (failure.kind === "credential-invalid") return new BookRepositoryError("credential-invalid", options);
  if (failure.kind === "network") return new BookRepositoryError("network", options);
  if (failure.kind === "abort") return new BookRepositoryError("aborted", options);
  return new BookRepositoryError(fallback, options);
}

/** The git hash of a blob, the same one GitHub gives the file: SHA-1 of `blob <length>\0` and the bytes. */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const all = new Uint8Array(header.byteLength + bytes.byteLength);
  all.set(header, 0);
  all.set(bytes, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", all));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const fileBytes = (file: BookRepositoryFile): Uint8Array => ("bytes" in file ? file.bytes : new TextEncoder().encode(file.content));

type TreeEntry = { path: string; mode: "100644"; type: "blob"; content?: string; sha?: string };

function planChunks(entries: Array<{ entry: TreeEntry; weight: number }>): TreeEntry[][] {
  const chunks: TreeEntry[][] = [];
  let current: TreeEntry[] = [];
  let weight = 0;
  for (const item of entries) {
    if (current.length && (current.length >= TREE_CHUNK_MAX_ENTRIES || weight + item.weight > TREE_CHUNK_MAX_BYTES)) {
      chunks.push(current);
      current = [];
      weight = 0;
    }
    current.push(item.entry);
    weight += item.weight;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function runPool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try { await work(item); } catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  if (failed) throw failure;
}

interface Target {
  octokit: Octokit;
  owner: string;
  repo: string;
  signal?: AbortSignal;
}

const request = (target: Target) => ({ request: { signal: target.signal } });

/** Writes the files as one commit: blobs for the binaries, the tree in chunks, then the commit. The files are not on any branch yet. */
async function buildCommit(
  target: Target,
  files: BookRepositoryFile[],
  options: { message: string; parents: string[]; baseTree?: string; onChunk?: (chunk: number, chunks: number) => void },
): Promise<{ commitSha: string; treeSha: string; shas: Record<string, string> }> {
  const shas: Record<string, string> = {};
  const items: Array<{ entry: TreeEntry; weight: number }> = [];
  const binaries: Array<{ file: Extract<BookRepositoryFile, { bytes: Uint8Array }>; index: number }> = [];
  for (const file of files) {
    shas[file.path] = await gitBlobSha(fileBytes(file));
    if ("bytes" in file) {
      binaries.push({ file, index: items.length });
      items.push({ entry: { path: file.path, mode: "100644", type: "blob" }, weight: file.path.length + 120 });
    } else {
      items.push({ entry: { path: file.path, mode: "100644", type: "blob", content: file.content }, weight: utf8Bytes(file.content) + file.path.length + 120 });
    }
  }
  await runPool(binaries, BLOB_CONCURRENCY, async ({ file, index }) => {
    target.signal?.throwIfAborted();
    const { data } = await target.octokit.rest.git.createBlob({ owner: target.owner, repo: target.repo, content: bytesToBase64(file.bytes), encoding: "base64", ...request(target) });
    items[index].entry.sha = data.sha;
  });
  const chunks = planChunks(items);
  let treeSha = options.baseTree;
  for (const [index, chunk] of chunks.entries()) {
    target.signal?.throwIfAborted();
    options.onChunk?.(index + 1, chunks.length);
    const { data } = await target.octokit.rest.git.createTree({ owner: target.owner, repo: target.repo, tree: chunk, ...(treeSha ? { base_tree: treeSha } : {}), ...request(target) });
    treeSha = data.sha;
  }
  if (!treeSha) throw new BookRepositoryError("no-files");
  const { data: commit } = await target.octokit.rest.git.createCommit({ owner: target.owner, repo: target.repo, message: options.message, tree: treeSha, parents: options.parents, ...request(target) });
  return { commitSha: commit.sha, treeSha, shas };
}

export type ExistingRepositoryPolicy = "error" | "empty" | "overwrite";

export interface CreateCompleteBookRepositoryInput {
  token: string;
  /** Tests give a fake; the page lets the service make its own client. */
  octokit?: Octokit;
  /** The login of the user or organization that owns the repository; the authenticated user when missing. */
  owner?: string;
  name: string;
  description?: string;
  visibility?: "private" | "public";
  files: BookRepositoryFile[];
  /** What to do when `owner/name` already exists: refuse (`error`), fill it if it is empty (`empty`), or replace its branch (`overwrite`). */
  existing?: ExistingRepositoryPolicy;
  /** False when the repository must be there already (a name that is free is then an error, `not-found`, and nothing is made). Default: true. */
  createIfMissing?: boolean;
  /** Turn GitHub Pages on for the repository (a refusal, or a private repository on a plan without Pages, leaves `pages: "manual"`). */
  pages?: "enable" | "skip";
  /**
   * Something that has to be in place before the workflow lands, run once the repository and Pages exist (the passwords of a protected reader: their secrets and
   * the variable that lists them, so that the very first publication already uses them). If it throws, the workflow is NOT committed (`workflow: "held"`,
   * the files stay in `pendingWorkflow`) and the error is in `beforeWorkflow`: landing the workflow without it would publish what the owner meant to protect.
   * It is not run when the book has no workflow file.
   */
  beforeWorkflow?: (context: { octokit: Octokit; owner: string; repo: string; branch: string }) => Promise<void>;
  commitMessage?: string;
  signal?: AbortSignal;
  onProgress?: (progress: BookRepositoryProgress) => void;
}

const statusOf = (error: unknown): number | undefined => failureOf(error).status;

function cleanDescription(value: string | undefined): string | undefined {
  const text = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 350);
  return text || undefined;
}

export async function createCompleteBookRepository(input: CreateCompleteBookRepositoryInput): Promise<CreateCompleteBookRepositoryResult> {
  const name = input.name.trim();
  if (repositoryNameProblem(name)) throw new BookRepositoryError("invalid-name", { detail: repositoryNameProblem(name) ?? undefined });
  const unique = new Map<string, BookRepositoryFile>();
  for (const file of input.files) unique.set(file.path, file);
  const files = [...unique.values()];
  if (!files.length) throw new BookRepositoryError("no-files");
  const meter = new RepositoryByteMeter("mutation");
  try {
    for (const file of files) meter.add("bytes" in file ? "binary" : "text", fileBytes(file).byteLength);
  } catch (error) {
    throw earlyFailure(error, "too-large");
  }
  const mainFiles = files.filter((file) => !isWorkflowPath(file.path));
  const workflowFiles = files.filter((file) => isWorkflowPath(file.path));
  if (!mainFiles.length) throw new BookRepositoryError("no-files");

  const octokit = input.octokit ?? createTrackedGitHubClient(input.token);
  const tokenKind = classifyTokenKind(input.token);
  const progress = (value: BookRepositoryProgress) => input.onProgress?.(value);
  const existingPolicy = input.existing ?? "error";
  const warnings: BookRepositoryWarning[] = [];
  const message = input.commitMessage ?? "Initialize Narrarium book";

  progress({ step: "repository" });
  let login: string;
  try {
    login = (await octokit.rest.users.getAuthenticated({ request: { signal: input.signal } })).data.login;
  } catch (error) {
    throw earlyFailure(error, "unknown");
  }
  const owner = (input.owner?.trim() || login);
  const forUser = owner.toLowerCase() === login.toLowerCase();
  const target: Target = { octokit, owner, repo: name, signal: input.signal };

  // Is the name free? A name that is free answers 404; one that is there is used only when the caller said it may be (an empty repository to fill).
  let found: { id: number; owner: { login: string }; name: string; html_url: string; default_branch: string; private: boolean } | null = null;
  try {
    found = (await octokit.rest.repos.get({ owner, repo: name, ...request(target) })).data;
  } catch (error) {
    if (statusOf(error) !== 404) throw earlyFailure(error, "unknown");
  }
  let created: boolean;
  let repository: { id: number; owner: string; repo: string; htmlUrl: string; defaultBranch: string; private: boolean };
  let parent: string | null = null;
  // A branch that is replaced keeps the history under it (the user asked to overwrite); a bootstrap commit of ours left by an earlier try is not history.
  let rewriteRoot = false;
  if (found) {
    if (existingPolicy === "error") throw new BookRepositoryError("name-taken");
    created = false;
    repository = { id: found.id, owner: found.owner?.login ?? owner, repo: found.name, htmlUrl: found.html_url, defaultBranch: found.default_branch || "main", private: found.private };
    try {
      parent = (await octokit.rest.git.getRef({ owner, repo: name, ref: `heads/${repository.defaultBranch}`, ...request(target) })).data.object.sha;
    } catch (error) {
      if (![404, 409].includes(statusOf(error) ?? 0)) throw earlyFailure(error, "unknown");
    }
    if (parent && existingPolicy !== "overwrite") {
      const head = await octokit.rest.git.getCommit({ owner, repo: name, commit_sha: parent, ...request(target) }).then((result) => result.data, () => null);
      if (!head || head.message !== BOOTSTRAP_MESSAGE || head.parents.length) throw new BookRepositoryError("not-empty");
      rewriteRoot = true;
    }
  } else {
    if (input.createIfMissing === false) throw new BookRepositoryError("not-found");
    created = true;
    try {
      const body = { name, private: (input.visibility ?? "private") === "private", auto_init: false, description: cleanDescription(input.description), ...request(target) };
      const { data } = forUser ? await octokit.rest.repos.createForAuthenticatedUser(body) : await octokit.rest.repos.createInOrg({ org: owner, ...body });
      repository = { id: data.id, owner: data.owner?.login ?? owner, repo: data.name, htmlUrl: data.html_url, defaultBranch: data.default_branch || "main", private: data.private };
    } catch (error) {
      const failure = failureOf(error);
      if (failure.status === 422 && /already exists|name.*taken/.test(failure.message)) throw new BookRepositoryError("name-taken", { status: 422, cause: error });
      if (failure.status === 422) throw new BookRepositoryError("create-rejected", { status: 422, cause: error });
      if (!isRateLimited(failure) && (failure.status === 403 || failure.status === 404)) throw new BookRepositoryError(forUser ? "cannot-create" : failure.status === 404 ? "owner-unavailable" : "cannot-create", { status: failure.status, reason: failure.kind, cause: error, tokenKind });
      throw earlyFailure(error, "unknown");
    }
  }
  target.owner = repository.owner;
  target.repo = repository.repo;
  const branch = repository.defaultBranch;
  const here = reference(repository, created);
  if (branch !== "main" && branch !== "master") warnings.push({ code: "branch-not-main" });

  // First commit.
  progress({ step: "first-commit" });
  let headSha: string;
  let treeSha: string;
  let shas: Record<string, string>;
  let firstCommitPath: "direct" | "bootstrap" = "direct";
  try {
    const onChunk = (chunk: number, chunks: number) => progress({ step: "first-commit", chunk, chunks });
    if (parent) {
      // Replacing a branch of a repository that is not empty: a commit on top of it with exactly these files.
      const built = await buildCommit(target, mainFiles, { message, parents: rewriteRoot ? [] : [parent], onChunk });
      await octokit.rest.git.updateRef({ owner: target.owner, repo: target.repo, ref: `heads/${branch}`, sha: built.commitSha, force: true, ...request(target) });
      ({ commitSha: headSha, treeSha, shas } = built);
    } else {
      let built: Awaited<ReturnType<typeof buildCommit>> | null = null;
      try {
        built = await buildCommit(target, mainFiles, { message, parents: [], onChunk });
        await octokit.rest.git.createRef({ owner: target.owner, repo: target.repo, ref: `refs/heads/${branch}`, sha: built.commitSha, ...request(target) });
      } catch (error) {
        if (!isEmptyRepositoryRefusal(failureOf(error))) throw error;
        firstCommitPath = "bootstrap";
        warnings.push({ code: "bootstrap-path" });
        const readme = mainFiles.find((file) => file.path === "README.md");
        const readmeText = readme && "content" in readme ? readme.content : `# ${name}\n`;
        await octokit.rest.repos.createOrUpdateFileContents({ owner: target.owner, repo: target.repo, path: "README.md", message: BOOTSTRAP_MESSAGE, content: bytesToBase64(new TextEncoder().encode(readmeText)), ...request(target) });
        built ??= await buildCommit(target, mainFiles, { message, parents: [], onChunk });
        await octokit.rest.git.updateRef({ owner: target.owner, repo: target.repo, ref: `heads/${branch}`, sha: built.commitSha, force: true, ...request(target) });
      }
      ({ commitSha: headSha, treeSha, shas } = built);
    }
  } catch (error) {
    const failure = firstCommitFailure(error, here);
    throw new BookRepositoryError(failure.code, { status: failure.status, resetAt: failure.resetAt, reason: failure.reason, repository: failure.repository, detail: failure.detail, cause: failure.cause, tokenKind });
  }
  const landed: Record<string, string> = { ...shas };
  let committedFiles = mainFiles.length;
  let committedBytes = mainFiles.reduce((total, file) => total + fileBytes(file).byteLength, 0);

  // Pages, before the workflow lands: the first run of the workflow finds the site already there.
  let pages: CreateCompleteBookRepositoryResult["pages"] = "skipped";
  if (input.pages === "enable") {
    progress({ step: "pages" });
    try {
      await octokit.rest.repos.createPagesSite({ owner: target.owner, repo: target.repo, build_type: "workflow", ...request(target) });
      pages = "enabled";
    } catch (error) {
      const failure = failureOf(error);
      if (failure.status === 409 || /already (?:exists|enabled)/.test(failure.message)) pages = "enabled";
      else {
        pages = "manual";
        const plan = /plan|upgrade|private/.test(failure.message) || (repository.private && (failure.status === 403 || failure.status === 422));
        warnings.push(isRateLimited(failure) ? { code: "pages-failed", status: failure.status, resetAt: failure.resetAt } : plan ? { code: "pages-plan", status: failure.status } : failure.status === 403 || failure.status === 404 ? { code: "pages-refused", status: failure.status } : { code: "pages-failed", status: failure.status });
      }
    }
  }

  // What has to be there before the workflow: if it cannot be, the workflow is held back (a workflow that lands without it publishes the reader without its passwords).
  let beforeWorkflow: CreateCompleteBookRepositoryResult["beforeWorkflow"] = { status: "skipped" };
  if (input.beforeWorkflow && workflowFiles.length) {
    progress({ step: "protection" });
    try {
      await input.beforeWorkflow({ octokit, owner: target.owner, repo: target.repo, branch });
      beforeWorkflow = { status: "done" };
    } catch (error) {
      beforeWorkflow = { status: "failed", error };
    }
  }

  // Second commit: the workflows alone.
  let workflow: CreateCompleteBookRepositoryResult["workflow"] = "skipped";
  let pendingWorkflow: Array<{ path: string; content: string }> = [];
  if (workflowFiles.length && beforeWorkflow.status === "failed") {
    workflow = "held";
    pendingWorkflow = workflowFiles.filter((file): file is { path: string; content: string } => "content" in file);
  } else if (workflowFiles.length) {
    progress({ step: "workflow" });
    try {
      const built = await buildCommit(target, workflowFiles, { message: "Add the GitHub Pages workflow", parents: [headSha], baseTree: treeSha });
      await octokit.rest.git.updateRef({ owner: target.owner, repo: target.repo, ref: `heads/${branch}`, sha: built.commitSha, force: false, ...request(target) });
      headSha = built.commitSha;
      workflow = "done";
      Object.assign(landed, built.shas);
      committedFiles += workflowFiles.length;
      committedBytes += workflowFiles.reduce((total, file) => total + fileBytes(file).byteLength, 0);
    } catch (error) {
      const failure = failureOf(error);
      pendingWorkflow = workflowFiles.filter((file): file is { path: string; content: string } => "content" in file);
      if (isRateLimited(failure)) {
        warnings.push({ code: "workflow-rate-limit", status: failure.status, resetAt: failure.resetAt });
      } else if (/workflow/.test(failure.message)) {
        workflow = "not-allowed";
        warnings.push({ code: "workflow-not-allowed", status: failure.status });
      } else if (failure.status === 403 || failure.status === 404 || failure.status === 422) {
        // Not said in words: the same update of the branch without the workflow says whether it is the workflow that is refused. A no-op update of
        // the branch to the commit it is at asks exactly that, and succeeds for any token that may write the branch.
        const refusedAlone = await octokit.rest.git.updateRef({ owner: target.owner, repo: target.repo, ref: `heads/${branch}`, sha: headSha, force: false, ...request(target) }).then(() => true, () => false);
        if (refusedAlone) {
          workflow = "not-allowed";
          warnings.push({ code: "workflow-not-allowed", status: failure.status });
        } else warnings.push({ code: "workflow-failed", status: failure.status });
      } else {
        warnings.push({ code: "workflow-failed", status: failure.status });
      }
    }
  }

  progress({ step: "done" });
  return {
    id: repository.id,
    owner: repository.owner,
    repo: repository.repo,
    defaultBranch: branch,
    htmlUrl: repository.htmlUrl,
    private: repository.private,
    committed: { files: committedFiles, bytes: committedBytes },
    workflow,
    pages,
    beforeWorkflow,
    warnings,
    headSha,
    shas: landed,
    firstCommitPath,
    createdRepository: created,
    pendingWorkflow,
    tokenKind,
  };
}

/**
 * Commits files on top of a branch of a repository that exists: what finishes a creation whose workflow was held back (`workflow: "held"`). One commit on
 * the head of the branch, no force; a branch that moved meanwhile is a refusal (409/422), never an overwrite. A token without the permission to write workflows
 * is refused here, as at the creation.
 */
export async function commitFilesToBranch(input: { token?: string; octokit?: Octokit; owner: string; repo: string; branch: string; files: BookRepositoryFile[]; message: string; signal?: AbortSignal }): Promise<{ commitSha: string }> {
  const octokit = input.octokit ?? createTrackedGitHubClient(input.token ?? "");
  const target: Target = { octokit, owner: input.owner, repo: input.repo, signal: input.signal };
  const head = (await octokit.rest.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}`, ...request(target) })).data.object.sha;
  const commit = (await octokit.rest.git.getCommit({ owner: input.owner, repo: input.repo, commit_sha: head, ...request(target) })).data;
  const built = await buildCommit(target, input.files, { message: input.message, parents: [head], baseTree: commit.tree.sha });
  await octokit.rest.git.updateRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}`, sha: built.commitSha, force: false, ...request(target) });
  return { commitSha: built.commitSha };
}

export type BookRepositoryPreflightIssue = "no-repo-scope" | "public-only" | "no-workflow-scope" | "fine-grained" | "app-token" | "unknown-token";

export interface BookRepositoryPreflight {
  login: string;
  tokenKind: GitHubTokenKind;
  /** The scopes a classic token carries (`X-OAuth-Scopes`); empty for any other kind. */
  scopes: string[];
  organizations: string[];
  canCreate: "yes" | "no" | "unknown";
  canWriteWorkflows: "yes" | "no" | "unknown";
  issues: BookRepositoryPreflightIssue[];
}

/**
 * What the token seems able to do, read from what GitHub tells for free: the scopes of a classic token are in a header of `GET /user`; a
 * fine-grained token has no such header, so it says «unverified» and the creation is simply tried (and its refusals classified). It never blocks.
 */
export async function preflightBookRepository(input: { token: string; octokit?: Octokit; signal?: AbortSignal }): Promise<BookRepositoryPreflight> {
  const octokit = input.octokit ?? createTrackedGitHubClient(input.token);
  const user = await octokit.rest.users.getAuthenticated({ request: { signal: input.signal } }).catch((error) => { throw earlyFailure(error, "unknown"); });
  const header = (user.headers as Record<string, unknown>)["x-oauth-scopes"];
  const kind = classifyTokenKind(input.token);
  // The user token of a GitHub app carries no scopes: what it can do is the permissions of the app, which GitHub does not tell in advance either.
  const classic = typeof header === "string" && kind !== "app" && kind !== "fine-grained";
  const scopes = classic ? header.split(",").map((scope) => scope.trim()).filter(Boolean) : [];
  const issues: BookRepositoryPreflightIssue[] = [];
  let canCreate: BookRepositoryPreflight["canCreate"] = "unknown";
  let canWriteWorkflows: BookRepositoryPreflight["canWriteWorkflows"] = "unknown";
  if (classic) {
    const hasRepo = scopes.includes("repo");
    canCreate = hasRepo || scopes.includes("public_repo") ? "yes" : "no";
    canWriteWorkflows = scopes.includes("workflow") ? "yes" : "no";
    if (!hasRepo && scopes.includes("public_repo")) issues.push("public-only");
    else if (!hasRepo) issues.push("no-repo-scope");
    if (canWriteWorkflows === "no") issues.push("no-workflow-scope");
  } else {
    issues.push(kind === "fine-grained" ? "fine-grained" : kind === "app" ? "app-token" : "unknown-token");
  }
  const organizations = await octokit.rest.orgs.listForAuthenticatedUser({ per_page: 100, request: { signal: input.signal } }).then((result) => result.data.map((org) => org.login).sort((left, right) => left.localeCompare(right)), () => []);
  return { login: user.data.login, tokenKind: classic ? "classic" : kind, scopes, organizations, canCreate, canWriteWorkflows, issues };
}

/** Deletes a repository this flow made and could not fill: refused when it has a branch (it is not empty any more), and only ever on the user's own action. */
export async function deleteEmptyBookRepository(input: { token: string; octokit?: Octokit; owner: string; repo: string; defaultBranch?: string }): Promise<void> {
  const octokit = input.octokit ?? createTrackedGitHubClient(input.token);
  try {
    await octokit.rest.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.defaultBranch ?? "main"}` });
    throw new BookRepositoryError("not-empty");
  } catch (error) {
    if (error instanceof BookRepositoryError) throw error;
    if (![404, 409].includes(statusOf(error) ?? 0)) throw earlyFailure(error, "unknown");
  }
  try {
    await octokit.rest.repos.delete({ owner: input.owner, repo: input.repo });
  } catch (error) {
    const failure = failureOf(error);
    if (isRateLimited(failure) || failure.kind === "credential-invalid" || failure.kind === "network") throw earlyFailure(error, "cannot-delete");
    throw new BookRepositoryError("cannot-delete", { status: failure.status, cause: error });
  }
}
