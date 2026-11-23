import { COPY_GITHUB_BRANCH, CopyError, type CopyFile, type CopyTarget } from "../types";

/** The few GitHub operations the dedicated branch needs. `OctokitGitHubApi` implements them over the site's client; tests give a fake repository. */
export interface GitHubCopyApi {
  getRepository(): Promise<{ private: boolean }>;
  /** The head of the branch, or null when it does not exist yet. */
  getBranchHead(branch: string): Promise<{ commitSha: string; treeSha: string } | null>;
  createBlob(bytes: Uint8Array): Promise<string>;
  /** A tree with the entries, over `baseTree` (null for the first commit of an orphan branch). Returns its sha. */
  createTree(baseTree: string | null, entries: Array<{ path: string; blobSha: string }>): Promise<string>;
  createCommit(message: string, treeSha: string, parents: string[]): Promise<string>;
  createBranch(branch: string, commitSha: string): Promise<void>;
  /** Moves the branch forward without forcing: a head that is not an ancestor is refused (status 422). */
  updateBranch(branch: string, commitSha: string): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
}

const MAX_FILES_PER_COMMIT = 40;
const MAX_BYTES_PER_COMMIT = 24 * 1024 * 1024;

/**
 * The copies in a book's GitHub repository: a dedicated orphan branch, `narrarium-ai-calls`, never the working branch, with the files under `calls/`.
 * One commit per batch, fast-forward only: history is never rewritten. A public repository is refused, checked before every batch, because
 * GitHub keeps history after a deletion.
 */
export class GitHubCopyTarget implements CopyTarget {
  readonly kind = "github" as const;
  constructor(private readonly api: GitHubCopyApi, private readonly branch: string = COPY_GITHUB_BRANCH) {}

  async prepare(): Promise<void> {
    const repository = await this.api.getRepository();
    if (!repository.private) throw new CopyError("public-repository", "The repository is public, so the AI calls are not copied to it.");
  }

  async write(files: CopyFile[], onWritten: (taskId: string, bytes: number) => Promise<void>): Promise<void> {
    let batch: CopyFile[] = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.commit(batch, onWritten);
      batch = [];
      size = 0;
    };
    for (const file of files) {
      if (batch.length && (batch.length >= MAX_FILES_PER_COMMIT || size + file.bytes.length > MAX_BYTES_PER_COMMIT)) await flush();
      batch.push(file);
      size += file.bytes.length;
    }
    await flush();
  }

  private async commit(files: CopyFile[], onWritten: (taskId: string, bytes: number) => Promise<void>): Promise<void> {
    // A repository is public the moment its owner changes it: it is looked at again before every commit.
    await this.prepare();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const head = await this.api.getBranchHead(this.branch);
      const entries: Array<{ path: string; blobSha: string }> = [];
      for (const file of files) entries.push({ path: `calls/${file.path}`, blobSha: await this.api.createBlob(file.bytes) });
      const tree = await this.api.createTree(head?.treeSha ?? null, entries);
      if (!head || tree !== head.treeSha) {
        const message = `AI calls: ${files.length} task${files.length === 1 ? "" : "s"}`;
        const commit = await this.api.createCommit(message, tree, head ? [head.commitSha] : []);
        try {
          if (head) await this.api.updateBranch(this.branch, commit);
          else await this.api.createBranch(this.branch, commit);
        } catch (error) {
          const status = (error as { status?: number }).status;
          // Another device wrote to the branch between the read and the write: the batch is made again over the new head.
          if (attempt === 0 && (status === 422 || status === 409)) continue;
          throw error;
        }
      }
      for (const file of files) await onWritten(file.taskId, file.bytes.length);
      return;
    }
  }

  async removeDays(): Promise<void> {
    // GitHub's archive stops when it is full: history is never rewritten, so nothing is deleted to make room.
  }

  async removeAll(): Promise<void> {
    await this.api.deleteBranch(this.branch);
  }
}
