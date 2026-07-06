import { Octokit } from "@octokit/rest";
import type { BookEntry } from "@/types/settings";
import type { BookStructure } from "@/types/book";
import {
  buildLocalBookStructure,
  getLocalRepository,
  getLocalRepositoryByBook,
  putCleanLocalFile,
  putLocalRepository,
  type LocalRepositoryMeta,
} from "@/repository/localRepository";

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "yaml", "yml", "toml", "csv", "html", "css", "js", "ts", "tsx"]);

export interface LocalCloneProgress {
  done: number;
  total: number;
  path?: string;
}

function extension(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extension(path));
}

function rawContentUrl(owner: string, repo: string, path: string, ref: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function fetchRaw(token: string, owner: string, repo: string, branch: string, path: string): Promise<Uint8Array> {
  const response = await fetch(rawContentUrl(owner, repo, path, branch), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`Download ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function mapLimit<T>(items: T[], limit: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      await run(items[current], current);
    }
  });
  await Promise.all(workers);
}

export async function ensureLocalBookStructure(input: {
  bookId: string;
  book: BookEntry;
  token: string;
  branch?: string;
  onProgress?: (progress: LocalCloneProgress) => void;
}): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure; cloned: boolean }> {
  const octokit = new Octokit({ auth: input.token });
  const repoData = await octokit.rest.repos.get({ owner: input.book.owner, repo: input.book.repo });
  const defaultBranch = repoData.data.default_branch;
  const branch = input.branch || defaultBranch;
  const existing = await getLocalRepository(input.book.owner, input.book.repo, branch);
  if (existing) {
    return { meta: existing, structure: await buildLocalBookStructure(existing), cloned: false };
  }

  await navigator.storage?.persist?.().catch(() => false);
  const ref = await octokit.rest.git.getRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${branch}` });
  const headSha = ref.data.object.sha;
  const tree = await octokit.rest.git.getTree({ owner: input.book.owner, repo: input.book.repo, tree_sha: headSha, recursive: "1" });
  const blobs = tree.data.tree
    .filter((item) => item.type === "blob" && item.path)
    .map((item) => ({ path: item.path!, sha: item.sha, size: item.size ?? 0 }));
  const meta = await putLocalRepository({
    bookId: input.bookId,
    owner: input.book.owner,
    repo: input.book.repo,
    branch,
    defaultBranch,
    remoteHeadSha: headSha,
    clonedAt: new Date().toISOString(),
  });

  let done = 0;
  input.onProgress?.({ done, total: blobs.length });
  await mapLimit(blobs, 5, async (blob) => {
    const bytes = await fetchRaw(input.token, input.book.owner, input.book.repo, branch, blob.path);
    if (isTextPath(blob.path)) {
      await putCleanLocalFile({ repoId: meta.id, path: blob.path, kind: "text", text: new TextDecoder().decode(bytes), baseSha: blob.sha, size: bytes.byteLength });
    } else {
      await putCleanLocalFile({ repoId: meta.id, path: blob.path, kind: "binary", blob: new Blob([bytesToArrayBuffer(bytes)]), baseSha: blob.sha, size: bytes.byteLength });
    }
    done += 1;
    input.onProgress?.({ done, total: blobs.length, path: blob.path });
  });

  return { meta, structure: await buildLocalBookStructure(meta), cloned: true };
}

export async function getExistingLocalBookStructure(bookId: string): Promise<{ meta: LocalRepositoryMeta; structure: BookStructure } | null> {
  const meta = await getLocalRepositoryByBook(bookId);
  return meta ? { meta, structure: await buildLocalBookStructure(meta) } : null;
}
