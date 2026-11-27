import { bookStorageMode, type BookEntry } from "@/types/settings";
import { isUsableGitHubToken } from "@/github/remoteAvailability";
import { getLocalFile, getLocalRepository, listDirtyLocalFiles, listLocalFilesUnder, listUnpushedLocalCommits, sha256Text } from "@/repository/localRepository";
import { captureRepositoryOperationScope, currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { PAGES_WORKFLOW_PATH } from "@/github/bookRepository";
import { packageNameForTitle, type BookTemplate } from "@/narrarium/bookTemplate";
import { decideReaderUpdate, type ReaderUpdateDecision, type ReaderUpdateInputs } from "@/readerUpdate/decision";
import { READER_DIR, READER_PACKAGE_JSON, planReaderFolder } from "@/readerUpdate/folderPlan";

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
  /** The site's template; it is a lazy chunk of its own, so it is loaded here and only here. */
  loadTemplate: () => Promise<BookTemplate>;
}

/**
 * Reads the working copy of the book on this device (never GitHub: the working copy is where every change starts) and decides whether its reader needs
 * updating. A book kept on this device only, or a branch that has no working copy here, is decided without reading anything.
 */
export async function inspectReaderUpdate(input: InspectReaderUpdateInput): Promise<ReaderUpdateInspection> {
  const { book, branch } = input;
  const base = { storage: bookStorageMode(book), branch, online: typeof navigator === "undefined" || navigator.onLine !== false, remote: input.remote } as const;
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
  const [dirty, ahead] = await Promise.all([listDirtyLocalFiles(meta.id), listUnpushedLocalCommits(meta.id)]);
  const readerPath = (path: string) => path === PAGES_WORKFLOW_PATH || path.startsWith(`${READER_DIR}/`);
  const unpublished = [...new Set([...dirty.map((file) => file.path), ...ahead.flatMap((commit) => commit.files.map((file) => file.path))].filter(readerPath))].sort();
  const decision = decideReaderUpdate({
    ...base,
    workingCopy: true,
    workflowText,
    folder,
    // The credential is the one decision of remoteAvailability: none, the local token, or one GitHub refused all leave the commit on this device.
    credential: isUsableGitHubToken(input.token) && meta.remoteKind !== "none",
    localChanges: dirty.length > 0 || ahead.length > 0,
    unpublished,
  });
  return { decision, workflowHash: workflow && workflow.status !== "deleted" ? workflow.currentHash : null, checkedAt };
}
