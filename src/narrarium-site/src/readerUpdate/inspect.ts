import type { Octokit } from "@octokit/rest";
import { bookStorageMode, type BookEntry } from "@/types/settings";
import { createTrackedGitHubClient } from "@/repository/githubRequest";
import { isUsableGitHubToken } from "@/github/remoteAvailability";
import { getLocalFile, getLocalRepository, listDirtyLocalFiles, listLocalFilesUnder, listUnpushedLocalCommits, sha256Text } from "@/repository/localRepository";
import { captureRepositoryOperationScope, currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { PAGES_WORKFLOW_PATH } from "@/github/bookRepository";
import { packageNameForTitle, type BookTemplate } from "@/narrarium/bookTemplate";
import { decideReaderUpdate, type ReaderUpdateDecision, type ReaderUpdateInputs } from "@/readerUpdate/decision";
import { READER_DIR, READER_PACKAGE_JSON, planReaderFolder } from "@/readerUpdate/folderPlan";
import { readPublishingBranch, type PublishingBranchRead } from "@/readerUpdate/publishingBranch";

/** What the check of a book's reader found, with what the commit of its update needs to be sure nothing changed in between. */
export interface ReaderUpdateInspection {
  decision: ReaderUpdateDecision;
  /** SHA-256 of the workflow in the working copy (`null`: it is not there). */
  workflowHash: string | null;
  checkedAt: number;
}

export interface InspectReaderUpdateInput {
  book: BookEntry;
  branch: string;
  token: string;
  remote?: ReaderUpdateInputs["remote"];
  /** The repository's default branch: the branch the workflow publishes from. When it is not `branch`, what it has is read too. */
  publishingBranch?: string;
  /** The client for GitHub (the site's tracked one by default; a fake in a test). */
  octokit?: Octokit;
  /**
   * Whether GitHub may be asked (for the publishing branch when it is not checked out here). `false` reads only this device: the places that are not on the
   * screen (the notice in a tab that has not been opened) must not make a request to GitHub as a side effect of a page being opened. Default: `true`.
   */
  readGitHub?: boolean;
  /** The site's template; it is a lazy chunk of its own, so it is loaded here and only here. */
  loadTemplate: () => Promise<BookTemplate>;
}

/**
 * Reads the working copy of the book on this device (never GitHub: the working copy is where every change starts) and decides whether its reader needs
 * updating. A book kept on this device only, or a branch that has no working copy here, is decided without reading anything.
 */
export async function inspectReaderUpdate(input: InspectReaderUpdateInput): Promise<ReaderUpdateInspection> {
  const { book, branch } = input;
  const base = { storage: bookStorageMode(book), branch, online: typeof navigator === "undefined" || navigator.onLine !== false, remote: input.remote, ...(input.publishingBranch ? { publishingBranch: input.publishingBranch } : {}) } as const;
  const checkedAt = Date.now();
  const nothing = (storage: ReaderUpdateInputs["storage"], workingCopy: boolean): ReaderUpdateInspection => ({
    decision: decideReaderUpdate({ ...base, storage, workingCopy, workflowText: undefined, folder: null, credential: false, localChanges: false }),
    workflowHash: null,
    checkedAt,
  });
  if (base.storage === "local-only") return nothing("local-only", false);
  const scope = captureRepositoryOperationScope();
  const identity = currentRepositoryScopeIdentity();
  const meta = identity ? await getLocalRepository(book.owner, book.repo, branch, scope).catch(() => null) : null;
  if (!meta || meta.cloneComplete !== true) return nothing("github", false);

  const workflow = await getLocalFile(meta.id, PAGES_WORKFLOW_PATH, scope);
  const workflowText = !workflow || workflow.status === "deleted" ? null : workflow.kind === "text" ? workflow.text ?? undefined : undefined;
  const readerFiles = await listLocalFilesUnder(meta.id, `${READER_DIR}/`, scope);
  const template = await input.loadTemplate();
  const folder = await planReaderFolder({
    template,
    existing: new Map(readerFiles.map((file) => [file.path, file.currentHash])),
    existingPackageJson: readerFiles.find((file) => file.path === READER_PACKAGE_JSON)?.text ?? null,
    fallbackPackageName: `${packageNameForTitle(book.repo)}-reader`,
    hash: sha256Text,
  });
  const credential = isUsableGitHubToken(input.token) && meta.remoteKind !== "none";
  const publishing = input.publishingBranch && input.publishingBranch !== branch
    ? await readPublishingSide({ ...input, publishingBranch: input.publishingBranch, template, credential, online: base.online, scope, identity })
    : undefined;
  const [dirty, ahead] = await Promise.all([listDirtyLocalFiles(meta.id), listUnpushedLocalCommits(meta.id)]);
  const readerPath = (path: string) => path === PAGES_WORKFLOW_PATH || path.startsWith(`${READER_DIR}/`);
  const unpublished = [...new Set([...dirty.map((file) => file.path), ...ahead.flatMap((commit) => commit.files.map((file) => file.path))].filter(readerPath))].sort();
  const decision = decideReaderUpdate({
    ...base,
    workingCopy: true,
    workflowText,
    folder,
    // The credential is the one decision of remoteAvailability: none, the local token, or one GitHub refused all leave the commit on this device.
    credential,
    ...(publishing !== undefined ? { publishing } : {}),
    localChanges: dirty.length > 0 || ahead.length > 0,
    unpublished,
  });
  return { decision, workflowHash: workflow && workflow.status !== "deleted" ? workflow.currentHash : null, checkedAt };
}

/**
 * What the publishing branch has when the author works on another one: its working copy on this device when there is one (the plan is then checked file by file,
 * like the working branch's), otherwise GitHub's own copy of the branch. Without a credential or a connection it is not read at all (`undefined`): nothing is
 * claimed of it, and the update stays on this device. A branch GitHub did not give is `"unreadable"`.
 */
async function readPublishingSide(input: InspectReaderUpdateInput & { publishingBranch: string; template: BookTemplate; credential: boolean; online: boolean; scope: ReturnType<typeof captureRepositoryOperationScope>; identity: ReturnType<typeof currentRepositoryScopeIdentity> }): Promise<PublishingBranchRead | "unreadable" | undefined> {
  const { book, publishingBranch, template, scope, identity } = input;
  const fallbackPackageName = `${packageNameForTitle(book.repo)}-reader`;
  const local = identity ? await getLocalRepository(book.owner, book.repo, publishingBranch, scope).catch(() => null) : null;
  if (local && local.cloneComplete === true) {
    const workflow = await getLocalFile(local.id, PAGES_WORKFLOW_PATH, scope);
    const readerFiles = await listLocalFilesUnder(local.id, `${READER_DIR}/`, scope);
    const folder = await planReaderFolder({ template, existing: new Map(readerFiles.map((file) => [file.path, file.currentHash])), existingPackageJson: readerFiles.find((file) => file.path === READER_PACKAGE_JSON)?.text ?? null, fallbackPackageName, hash: sha256Text });
    const present = workflow && workflow.status !== "deleted";
    if (present && workflow.kind !== "text") return "unreadable";
    return { branch: publishingBranch, source: "working-copy", headSha: local.remoteHeadSha, workflowText: present ? workflow.text ?? null : null, folder, workflowHash: present ? workflow.currentHash : null };
  }
  if (!input.credential || !input.online || input.readGitHub === false) return undefined;
  try { return await readPublishingBranch(input.octokit ?? createTrackedGitHubClient(input.token), { owner: book.owner, repo: book.repo }, publishingBranch, template, fallbackPackageName); }
  catch { return "unreadable"; }
}
