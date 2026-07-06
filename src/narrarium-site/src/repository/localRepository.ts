import type { BookStructure, BookFile, Chapter, Paragraph } from "@/types/book";

const DB_NAME = "narrarium-local-repositories";
const DB_VERSION = 1;

export type LocalFileStatus = "clean" | "modified" | "new" | "deleted";
export type LocalFileKind = "text" | "binary";

export interface LocalRepositoryMeta {
  id: string;
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  defaultBranch: string;
  remoteHeadSha: string;
  clonedAt: string;
  updatedAt: string;
  lastFetchAt?: string;
}

export interface LocalRepositoryFile {
  key: string;
  repoId: string;
  path: string;
  kind: LocalFileKind;
  text?: string;
  blob?: Blob;
  baseSha?: string;
  currentHash: string;
  status: LocalFileStatus;
  size: number;
  updatedAt: string;
}

export interface LocalRepoStatus {
  clean: number;
  modified: number;
  new: number;
  deleted: number;
  dirty: number;
}

function repoId(owner: string, repo: string, branch: string): string {
  return `${owner}/${repo}#${branch}`.toLowerCase();
}

function fileKey(id: string, path: string): string {
  return `${id}::${path}`;
}

function slugToTitle(slug: string): string {
  return slug
    .replace(/^\d{3}[-_]?/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase()) || slug;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("repositories")) {
        const repositories = db.createObjectStore("repositories", { keyPath: "id" });
        repositories.createIndex("bookId", "bookId", { unique: false });
        repositories.createIndex("remote", ["owner", "repo", "branch"], { unique: false });
      }
      if (!db.objectStoreNames.contains("files")) {
        const files = db.createObjectStore("files", { keyPath: "key" });
        files.createIndex("repoId", "repoId", { unique: false });
        files.createIndex("repoStatus", ["repoId", "status"], { unique: false });
      }
    };
  });
  return dbPromise;
}

function txStore<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = run(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
  }));
}

function allFromIndex<T>(storeName: string, indexName: string, query: IDBValidKey | IDBKeyRange): Promise<T[]> {
  return openDb().then((db) => new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).index(indexName).getAll(query);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  }));
}

async function hashText(text: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(text));
}

async function hashBlob(blob: Blob): Promise<string> {
  return hashBytes(new Uint8Array(await blob.arrayBuffer()));
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function makeRepoId(owner: string, repo: string, branch: string): string {
  return repoId(owner, repo, branch);
}

export async function putLocalRepository(meta: Omit<LocalRepositoryMeta, "id" | "updatedAt">): Promise<LocalRepositoryMeta> {
  const now = new Date().toISOString();
  const full: LocalRepositoryMeta = { ...meta, id: repoId(meta.owner, meta.repo, meta.branch), updatedAt: now };
  await txStore("repositories", "readwrite", (store) => store.put(full));
  return full;
}

export async function getLocalRepository(owner: string, repo: string, branch: string): Promise<LocalRepositoryMeta | null> {
  return (await txStore<LocalRepositoryMeta | undefined>("repositories", "readonly", (store) => store.get(repoId(owner, repo, branch)))) ?? null;
}

export async function getLocalRepositoryByBook(bookId: string): Promise<LocalRepositoryMeta | null> {
  const rows = await allFromIndex<LocalRepositoryMeta>("repositories", "bookId", bookId);
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export async function listLocalFiles(repoIdValue: string): Promise<LocalRepositoryFile[]> {
  const files = await allFromIndex<LocalRepositoryFile>("files", "repoId", repoIdValue);
  return files.filter((file) => file.status !== "deleted").sort((a, b) => a.path.localeCompare(b.path));
}

export async function getLocalFile(repoIdValue: string, path: string): Promise<LocalRepositoryFile | null> {
  const file = await txStore<LocalRepositoryFile | undefined>("files", "readonly", (store) => store.get(fileKey(repoIdValue, path)));
  return file && file.status !== "deleted" ? file : null;
}

export async function putCleanLocalFile(input: {
  repoId: string;
  path: string;
  kind: LocalFileKind;
  text?: string;
  blob?: Blob;
  baseSha?: string;
  size: number;
}): Promise<LocalRepositoryFile> {
  const currentHash = input.kind === "text" ? await hashText(input.text ?? "") : await hashBlob(input.blob ?? new Blob());
  const file: LocalRepositoryFile = {
    key: fileKey(input.repoId, input.path),
    repoId: input.repoId,
    path: input.path,
    kind: input.kind,
    text: input.text,
    blob: input.blob,
    baseSha: input.baseSha,
    currentHash,
    status: "clean",
    size: input.size,
    updatedAt: new Date().toISOString(),
  };
  await txStore("files", "readwrite", (store) => store.put(file));
  return file;
}

export async function writeLocalText(repoIdValue: string, path: string, text: string): Promise<LocalRepositoryFile> {
  const existing = await txStore<LocalRepositoryFile | undefined>("files", "readonly", (store) => store.get(fileKey(repoIdValue, path)));
  const currentHash = await hashText(text);
  const file: LocalRepositoryFile = {
    key: fileKey(repoIdValue, path),
    repoId: repoIdValue,
    path,
    kind: "text",
    text,
    baseSha: existing?.baseSha,
    currentHash,
    status: existing && existing.status !== "new" ? (existing.currentHash === currentHash ? "clean" : "modified") : "new",
    size: new TextEncoder().encode(text).byteLength,
    updatedAt: new Date().toISOString(),
  };
  await txStore("files", "readwrite", (store) => store.put(file));
  return file;
}

export async function writeLocalBinary(repoIdValue: string, path: string, bytes: Uint8Array): Promise<LocalRepositoryFile> {
  const existing = await txStore<LocalRepositoryFile | undefined>("files", "readonly", (store) => store.get(fileKey(repoIdValue, path)));
  const blob = new Blob([bytesToArrayBuffer(bytes)]);
  const currentHash = await hashBytes(bytes);
  const file: LocalRepositoryFile = {
    key: fileKey(repoIdValue, path),
    repoId: repoIdValue,
    path,
    kind: "binary",
    blob,
    baseSha: existing?.baseSha,
    currentHash,
    status: existing && existing.status !== "new" ? (existing.currentHash === currentHash ? "clean" : "modified") : "new",
    size: bytes.byteLength,
    updatedAt: new Date().toISOString(),
  };
  await txStore("files", "readwrite", (store) => store.put(file));
  return file;
}

export async function deleteLocalFile(repoIdValue: string, path: string): Promise<void> {
  const existing = await txStore<LocalRepositoryFile | undefined>("files", "readonly", (store) => store.get(fileKey(repoIdValue, path)));
  if (!existing) return;
  if (existing.status === "new") {
    await txStore("files", "readwrite", (store) => store.delete(fileKey(repoIdValue, path)));
    return;
  }
  await txStore("files", "readwrite", (store) => store.put({ ...existing, status: "deleted", updatedAt: new Date().toISOString() }));
}

export async function localStatus(repoIdValue: string): Promise<LocalRepoStatus> {
  const files = await allFromIndex<LocalRepositoryFile>("files", "repoId", repoIdValue);
  const out: LocalRepoStatus = { clean: 0, modified: 0, new: 0, deleted: 0, dirty: 0 };
  for (const file of files) out[file.status] += 1;
  out.dirty = out.modified + out.new + out.deleted;
  return out;
}

function splitFrontmatter(raw: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return {};
  const title = /^title:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const name = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  return { title, name, description };
}

function textByPath(files: LocalRepositoryFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) if (file.kind === "text" && file.text !== undefined) map.set(file.path, file.text);
  return map;
}

export async function buildLocalBookStructure(meta: LocalRepositoryMeta): Promise<BookStructure> {
  const files = await listLocalFiles(meta.id);
  const allPaths = files.map((file) => file.path);
  const textMap = textByPath(files);
  const imageExtensions = ["png", "jpg", "jpeg", "webp", "gif"];
  const firstExistingImage = (basePath: string): string | undefined =>
    imageExtensions.map((extension) => `${basePath}.${extension}`).find((candidate) => allPaths.includes(candidate));
  const titleName = (path: string, fallback: string) => {
    const fm = splitFrontmatter(textMap.get(path) ?? "");
    return (typeof fm.title === "string" && fm.title) || (typeof fm.name === "string" && fm.name) || fallback;
  };
  const bookFm = splitFrontmatter(textMap.get("book.md") ?? "");

  const canonPrefixes = ["characters", "locations", "factions", "items", "timelines", "secrets"] as const;
  const filesUnder = (prefix: typeof canonPrefixes[number]): BookFile[] => allPaths
    .filter((p) => p.startsWith(`${prefix}/`) && p.endsWith(".md"))
    .map((p) => {
      const slug = (p.split("/").pop() ?? "").replace(/\.md$/i, "");
      const assetBase = prefix === "timelines" ? `assets/timelines/events/${slug}/primary` : `assets/${prefix}/${slug}/primary`;
      const file = files.find((entry) => entry.path === p);
      return { path: p, sha: file?.baseSha ?? file?.currentHash ?? "", size: file?.size ?? 0, name: titleName(p, slugToTitle(slug)), imagePath: firstExistingImage(assetBase) };
    });

  const chapterFolders = [...new Set(allPaths.filter((p) => p.startsWith("chapters/")).map((p) => p.split("/").slice(0, 2).join("/")))].sort();
  const chapters: Chapter[] = chapterFolders.map((folder) => {
    const slug = folder.replace("chapters/", "");
    const folderPaths = allPaths.filter((p) => p.startsWith(`${folder}/`));
    const paragraphFiles = folderPaths.filter((p) => /\/\d{3}(?:-[^/]+)?\.md$/.test(p) && !p.includes("/drafts/")).sort();
    const paragraphs: Paragraph[] = paragraphFiles.map((p) => {
      const filename = p.split("/").pop() ?? "";
      const num = filename.match(/^(\d{3})(?:-[^/]+)?\.md$/)?.[1] ?? "";
      const paragraphSlug = filename.replace(/\.md$/i, "");
      const draftPath = `${folder}/drafts/${filename}`;
      const scriptPath = `scripts/${slug}/${paragraphSlug}.md`;
      const evaluationPath = `evaluations/paragraphs/${slug}/${paragraphSlug}.md`;
      const imagePromptPath = `assets/chapters/${slug}/paragraphs/${paragraphSlug}/primary.md`;
      return {
        number: num,
        title: titleName(p, slugToTitle(filename.replace(/\.md$/, ""))),
        path: p,
        draftPath: allPaths.includes(draftPath) ? draftPath : undefined,
        scriptPath: allPaths.includes(scriptPath) ? scriptPath : undefined,
        evaluationPath: allPaths.includes(evaluationPath) ? evaluationPath : undefined,
        imagePromptPath: allPaths.includes(imagePromptPath) ? imagePromptPath : undefined,
        imagePath: firstExistingImage(`assets/chapters/${slug}/paragraphs/${paragraphSlug}/primary`),
      };
    });
    const imagePromptPath = `assets/chapters/${slug}/primary.md`;
    return {
      slug,
      path: folder,
      title: titleName(`${folder}/chapter.md`, slugToTitle(slug)),
      paragraphs,
      writingStylePath: folderPaths.find((p) => p.endsWith("writing-style.md")),
      draftPath: folderPaths.find((p) => p.endsWith("draft.md")),
      imagePromptPath: allPaths.includes(imagePromptPath) ? imagePromptPath : undefined,
      imagePath: firstExistingImage(`assets/chapters/${slug}/primary`),
      hasResume: allPaths.includes(`resumes/chapters/${slug}.md`),
      hasEvaluation: allPaths.includes(`evaluations/chapters/${slug}.md`),
    };
  });

  return {
    title: (typeof bookFm.title === "string" && bookFm.title) || meta.repo,
    description: typeof bookFm.description === "string" ? bookFm.description : "",
    owner: meta.owner,
    repo: meta.repo,
    defaultBranch: meta.defaultBranch,
    loadedBranch: meta.branch,
    bookCoverPath: firstExistingImage("assets/book/cover"),
    bookCoverPromptPath: allPaths.includes("assets/book/cover.md") ? "assets/book/cover.md" : undefined,
    chapters,
    characters: filesUnder("characters"),
    locations: filesUnder("locations"),
    factions: filesUnder("factions"),
    items: filesUnder("items"),
    timelines: filesUnder("timelines"),
    secrets: filesUnder("secrets"),
    globalWritingStylePath: allPaths.find((p) => p === "guidelines/writing-style.md" || p === "guidelines/style.md"),
    voicesPath: allPaths.find((p) => p === "guidelines/voices.md"),
    plotPath: allPaths.includes("plot.md") ? "plot.md" : undefined,
    ghostwriters: allPaths
      .filter((p) => /^ghostwriters\/[^/]+\.md$/.test(p))
      .map((p) => {
        const slug = p.replace(/^ghostwriters\//, "").replace(/\.md$/i, "");
        return { slug, path: p, name: titleName(p, slugToTitle(slug)) };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
