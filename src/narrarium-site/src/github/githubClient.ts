import { Octokit } from "@octokit/rest";
import { BookStructure, Chapter, Paragraph, BookFile, ResearchFile } from "@/types/book";
import { deleteLocalFile, getLocalFile, getLocalRepository, listLocalFiles, writeLocalBinary, writeLocalText } from "@/repository/localRepository";
import { buildInitialBookFiles } from "@/narrarium/bookScaffold";

export function createGitHubClient(token: string): Octokit {
  return new Octokit({ auth: token });
}

function githubContentUrl(owner: string, repo: string, path: string, ref?: string, cacheBust = false): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const params = new URLSearchParams();
  if (ref) params.set("ref", ref);
  if (cacheBust) params.set("_", String(Date.now()));
  const query = params.size ? `?${params.toString()}` : "";
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${query}`;
}

async function fetchContentJson(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
  fresh = false,
): Promise<{ content?: string; sha?: string }> {
  const response = await fetch(githubContentUrl(owner, repo, path, ref, fresh), {
    cache: fresh ? "no-store" : "default",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub content load ${path}: ${response.status}`);
  return await response.json() as { content?: string; sha?: string };
}

async function localRepoId(owner: string, repo: string, branch: string | undefined): Promise<string | null> {
  if (!branch) return null;
  const local = await getLocalRepository(owner, repo, branch).catch(() => null);
  return local?.id ?? null;
}

/** Decode base64 content returned by the GitHub contents API (UTF-8 safe). */
function decodeContent(content: string): string {
  const bytes = decodeBytes(content);
  return new TextDecoder("utf-8").decode(bytes);
}

function decodeBytes(content: string): Uint8Array {
  const binary = atob(content.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert a Narrarium slug into a human-readable title.
 * Examples:
 *   "001-the-arrival"  → "The Arrival"
 *   "lyra-vale"        → "Lyra Vale"
 *   "001-at-the-gate"  → "At the Gate"
 */
export function slugToTitle(slug: string): string {
  return slug
    .replace(/^\d{3}-/, "")          // strip leading number prefix (001-)
    .replace(/-/g, " ")              // hyphens → spaces
    .replace(/\b\w/g, (c) => c.toUpperCase()); // Title Case
}

function frontmatterBlock(raw: string): string {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? raw.slice(0, 600);
}

function markdownBody(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  return (match ? match[1] : raw).trim();
}

function frontmatterString(raw: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}:\\s*(.+)$`, "m").exec(frontmatterBlock(raw));
  const value = match?.[1]?.trim().replace(/^["']|["']$/g, "").trim();
  return value || undefined;
}

/** Extract a frontmatter `title` field if present, otherwise fall back to slug. */
function titleFromFrontmatter(raw: string, fallback: string): string {
  return frontmatterString(raw, "title") ?? fallback;
}

// ─── List user repositories ───────────────────────────────────────────────────

export interface RepoSummary {
  id: number;
  full_name: string;
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  html_url: string;
  default_branch: string;
}

export async function listUserRepos(token: string): Promise<RepoSummary[]> {
  const octokit = createGitHubClient(token);
  const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
    per_page: 100,
    sort: "updated",
    // Explicitly request all visibility levels and affiliations so that
    // private repos owned by the user and org repos are included.
    // Classic PAT needs `repo` scope; fine-grained PAT needs
    // "All repositories" access to see private repos.
    visibility: "all",
    affiliation: "owner,collaborator,organization_member",
  });
  return repos.map((r) => ({
    id: r.id,
    full_name: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    description: r.description,
    html_url: r.html_url,
    default_branch: r.default_branch,
  }));
}

export interface CreateNarrariumBookRepositoryInput {
  name: string;
  title: string;
  private: boolean;
  language?: string;
  author?: string;
}

export async function createNarrariumBookRepository(token: string, input: CreateNarrariumBookRepositoryInput): Promise<RepoSummary> {
  const octokit = createGitHubClient(token);
  const repoName = input.name.trim();
  if (!repoName) throw new Error("Repository name is required.");

  const { data: repoData } = await octokit.rest.repos.createForAuthenticatedUser({
    name: repoName,
    private: input.private,
    auto_init: false,
    description: `Narrarium book: ${input.title.trim() || repoName}`,
  });

  const owner = repoData.owner.login;
  const repo = repoData.name;
  const branch = "main";
  const files = buildInitialBookFiles({ title: input.title, author: input.author, language: input.language });

  const { data: tree } = await octokit.rest.git.createTree({
    owner,
    repo,
    tree: files.map((file) => ({
      path: file.path,
      mode: "100644" as const,
      type: "blob" as const,
      content: file.content,
    })),
  });

  const { data: commit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: "init",
    tree: tree.sha,
    parents: [],
  });

  await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha });
  await octokit.rest.repos.update({ owner, repo, default_branch: branch }).catch(() => undefined);

  return {
    id: repoData.id,
    full_name: repoData.full_name,
    owner,
    name: repo,
    private: repoData.private,
    description: repoData.description,
    html_url: repoData.html_url,
    default_branch: branch,
  };
}

// ─── Load the full book structure from a repository ──────────────────────────

/** Extract a display name (title/name) from a markdown file's frontmatter block. */
function nameFromFrontmatter(raw: string): string | undefined {
  const block = frontmatterBlock(raw);
  const match = /^(?:title|name):\s*(.+)$/m.exec(block);
  if (!match) return undefined;
  const value = match[1].trim().replace(/^["']|["']$/g, "").trim();
  return value || undefined;
}

interface FrontmatterMetadata {
  name?: string;
  ghostwriter?: string;
}

/**
 * Read selected frontmatter fields for many files in a few GraphQL requests instead of
 * one REST call per file. Returns a map path -> parsed metadata.
 */
async function fetchFrontmatterMetadata(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  paths: string[],
): Promise<Record<string, FrontmatterMetadata>> {
  const result: Record<string, FrontmatterMetadata> = {};
  const unique = [...new Set(paths)].filter(Boolean);
  const CHUNK = 60;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const fields = chunk
      .map((p, idx) => {
        const expression = JSON.stringify(`${branch}:${p}`);
        return `f${idx}: object(expression: ${expression}) { ... on Blob { text } }`;
      })
      .join("\n");
    const query = `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ ${fields} } }`;
    try {
      const data = await octokit.graphql<{ repository: Record<string, { text?: string } | null> }>(query, { owner, repo });
      const repository = data.repository ?? {};
      chunk.forEach((p, idx) => {
        const text = repository[`f${idx}`]?.text;
        if (text) {
          const name = nameFromFrontmatter(text);
          const ghostwriter = frontmatterString(text, "ghostwriter");
          if (name || ghostwriter) result[p] = { name, ghostwriter };
        }
      });
    } catch {
      // GraphQL failed for this chunk (e.g. permissions) → leave those names to fall back.
    }
  }
  return result;
}

export async function loadBookStructure(
  token: string,
  owner: string,
  repo: string,
  ref?: string,
): Promise<BookStructure> {
  const octokit = createGitHubClient(token);

  // Fetch entire tree recursively (one API call)
  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoData.default_branch;
  const branch = ref || defaultBranch;

  const { data: treeData } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: branch,
    recursive: "1",
  });

  const allPaths = treeData.tree
    .filter((n) => n.type === "blob")
    .map((n) => n.path ?? "");

  const imageExtensions = ["png", "jpg", "jpeg", "webp", "gif"];
  const firstExistingImage = (basePath: string): string | undefined =>
    imageExtensions.map((extension) => `${basePath}.${extension}`).find((candidate) => allPaths.includes(candidate));

  // ── book.md ──────────────────────────────────────────────────────────────
  let title = repo;
  let description = "";
  let language: string | undefined;
  let ghostwriter: string | undefined;
  if (allPaths.includes("book.md")) {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path: "book.md", ref: branch });
      if ("content" in data) {
        const raw = decodeContent(data.content);
        title = titleFromFrontmatter(raw, repo);
        description = markdownBody(raw) || frontmatterString(raw, "description") || "";
        language = frontmatterString(raw, "language");
        ghostwriter = frontmatterString(raw, "ghostwriter");
      }
    } catch { /* no book.md – use defaults */ }
  }

  // ── Frontmatter display names (chapters, paragraphs, canon) via GraphQL batch ──
  const canonPrefixes = ["characters", "locations", "factions", "items", "timelines", "secrets"];
  const canonPaths = allPaths.filter((p) => p.endsWith(".md") && canonPrefixes.some((prefix) => p.startsWith(`${prefix}/`)));
  const chapterMdPaths = allPaths.filter((p) => /^chapters\/[^/]+\/chapter\.md$/.test(p));
  const paragraphPaths = allPaths.filter((p) => /^chapters\/[^/]+\/\d{3}(?:-[^/]+)?\.md$/.test(p) && !p.includes("/drafts/"));
  const notePaths = allPaths.filter((p) => /^notes\/[^/]+\.md$/.test(p));
  const personaPaths = allPaths.filter((p) => /^personas\/[^/]+\.md$/.test(p));
  const ghostwriterPaths = allPaths.filter((p) => /^ghostwriters\/[^/]+\.md$/.test(p));
  const metaMap = await fetchFrontmatterMetadata(octokit, owner, repo, branch, [...chapterMdPaths, ...paragraphPaths, ...canonPaths, ...notePaths, ...personaPaths, ...ghostwriterPaths]);

  // ── Canon sections ────────────────────────────────────────────────────────
  function filesUnder(prefix: string): BookFile[] {
    return allPaths
      .filter((p) => p.startsWith(`${prefix}/`) && p.endsWith(".md"))
      .map((p) => {
        const slug = (p.split("/").pop() ?? "").replace(/\.md$/i, "");
        // Canon assets mirror the canon path; timeline events live under assets/timelines/events/<slug>.
        const assetBase = prefix === "timelines"
          ? `assets/timelines/events/${slug}/primary`
          : `assets/${prefix}/${slug}/primary`;
        return {
          path: p,
          sha: treeData.tree.find((n) => n.path === p)?.sha ?? "",
          size: treeData.tree.find((n) => n.path === p)?.size ?? 0,
          name: metaMap[p]?.name,
          imagePath: firstExistingImage(assetBase),
        };
      });
  }

  // ── Chapters ─────────────────────────────────────────────────────────────
  const chapterFolders = [
    ...new Set(
      allPaths
        .filter((p) => p.startsWith("chapters/"))
        .map((p) => p.split("/").slice(0, 2).join("/"))
    ),
  ].sort();

  const chapters: Chapter[] = chapterFolders.map((folder) => {
    const slug = folder.replace("chapters/", "");
    const folderPaths = allPaths.filter((p) => p.startsWith(`${folder}/`));

    const paragraphFiles = folderPaths
      // Match 001.md OR 001-any-name.md, but not chapter.md / writing-style.md
      .filter((p) => /\/\d{3}(?:-[^/]+)?\.md$/.test(p) && !p.includes("/drafts/"))
      .sort();

    const paragraphs: Paragraph[] = paragraphFiles.map((p) => {
      const filename = p.split("/").pop() ?? "";
      const num = filename.match(/^(\d{3})(?:-[^/]+)?\.md$/)?.[1] ?? "";
      const paragraphSlug = filename.replace(/\.md$/i, "");
      // Draft lives in the drafts/ subfolder with the same filename
      const draftPath = `${folder}/drafts/${filename}`;
      const scriptPath = `scripts/${slug}/${paragraphSlug}.md`;
      const evaluationPath = `evaluations/paragraphs/${slug}/${paragraphSlug}.md`;
      const imagePromptPath = `assets/chapters/${slug}/paragraphs/${paragraphSlug}/primary.md`;
      return {
        number: num,
        title: metaMap[p]?.name ?? slugToTitle(filename.replace(/\.md$/, "")),
        path: p,
        draftPath: allPaths.includes(draftPath) ? draftPath : undefined,
        scriptPath: allPaths.includes(scriptPath) ? scriptPath : undefined,
        evaluationPath: allPaths.includes(evaluationPath) ? evaluationPath : undefined,
        imagePromptPath: allPaths.includes(imagePromptPath) ? imagePromptPath : undefined,
        imagePath: firstExistingImage(`assets/chapters/${slug}/paragraphs/${paragraphSlug}/primary`),
      };
    });

    const writingStylePath = folderPaths.find((p) =>
      p.endsWith("writing-style.md")
    );
    const draftPath = folderPaths.find((p) => p.endsWith("draft.md"));
    const imagePromptPath = `assets/chapters/${slug}/primary.md`;

    return {
      slug,
      path: folder,
      title: metaMap[`${folder}/chapter.md`]?.name ?? slugToTitle(slug),
      ghostwriter: metaMap[`${folder}/chapter.md`]?.ghostwriter,
      paragraphs,
      writingStylePath,
      draftPath,
      imagePromptPath: allPaths.includes(imagePromptPath) ? imagePromptPath : undefined,
      imagePath: firstExistingImage(`assets/chapters/${slug}/primary`),
      hasResume: allPaths.includes(`resumes/chapters/${slug}.md`),
      hasEvaluation: allPaths.includes(`evaluations/chapters/${slug}.md`),
    };
  });

  return {
    title,
    description,
    language,
    ghostwriter,
    owner,
    repo,
    defaultBranch,
    loadedBranch: branch,
    bookCoverPromptPath: allPaths.includes("assets/book/cover.md") ? "assets/book/cover.md" : undefined,
    bookCoverPath: firstExistingImage("assets/book/cover"),
    chapters,
    characters: filesUnder("characters"),
    locations: filesUnder("locations"),
    factions: filesUnder("factions"),
    items: filesUnder("items"),
    timelines: filesUnder("timelines"),
    secrets: filesUnder("secrets"),
    globalWritingStylePath: allPaths.find((p) => p === "writing-style.md")
      ?? allPaths.find((p) => p.match(/^guidelines\/(writing-style|style)\.md$/)),
    globalPunctuationStylePath: allPaths.includes("punctuation-style.md") ? "punctuation-style.md" : undefined,
    voicesPath: allPaths.includes("guidelines/voices.md")
      ? "guidelines/voices.md"
      : undefined,
    ghostwriters: allPaths
      .filter((p) => /^ghostwriters\/[^/]+\.md$/.test(p))
      .map((p) => {
        const slug = p.replace(/^ghostwriters\//, "").replace(/\.md$/i, "");
        return { slug, path: p, name: metaMap[p]?.name ?? slugToTitle(slug) };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    readerPersonas: personaPaths
      .map((p) => {
        const slug = p.replace(/^personas\//, "").replace(/\.md$/i, "");
        return { slug, path: p, name: metaMap[p]?.name ?? slugToTitle(slug) };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    readerEvaluationFiles: allPaths
      .filter((p) => /^evaluations\/readers\/.+\.md$/.test(p))
      .map((p) => ({ path: p, sha: treeData.tree.find((node) => node.path === p)?.sha ?? "", size: treeData.tree.find((node) => node.path === p)?.size ?? 0 })),
    plotPath: allPaths.includes("plot.md") ? "plot.md" : undefined,
    researchFiles: allPaths
      .filter((p) => /^research\/[^/]+\.md$/.test(p))
      .map((p): ResearchFile => {
        const slug = p.replace(/^research\//, "").replace(/\.md$/i, "");
        const rawTitle = nameFromFrontmatter(
          (() => {
            try { return ""; } catch { return ""; }
          })(),
        );
        return { path: p, sha: treeData.tree.find((n) => n.path === p)?.sha ?? "", slug, title: rawTitle ?? slug };
      })
      .sort((a, b) => b.slug.localeCompare(a.slug)),
    notesFiles: allPaths
      .filter((p) => /^notes\/[^/]+\.md$/.test(p))
      .map((p) => {
        const slug = p.replace(/^notes\//, "").replace(/\.md$/i, "");
        return { path: p, sha: treeData.tree.find((n) => n.path === p)?.sha ?? "", slug, title: metaMap[p]?.name ?? slugToTitle(slug) };
      })
      .sort((a, b) => b.slug.localeCompare(a.slug)),
  };
}

// ─── Load raw markdown content of a single file ──────────────────────────────

export async function loadFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<string> {
  const id = await localRepoId(owner, repo, ref);
  if (id) {
    const file = await getLocalFile(id, path);
    if (file?.kind === "text" && file.text !== undefined) return file.text;
    if (file?.kind === "binary" && file.blob) return new TextDecoder().decode(await file.blob.arrayBuffer());
  }
  const data = await fetchContentJson(token, owner, repo, path, ref);
  if (data.content) return decodeContent(data.content);
  throw new Error(`${path} is not a file`);
}

export async function loadBinaryFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<Uint8Array> {
  const id = await localRepoId(owner, repo, ref);
  if (id) {
    const file = await getLocalFile(id, path);
    if (file?.kind === "binary" && file.blob) return new Uint8Array(await file.blob.arrayBuffer());
    if (file?.kind === "text" && file.text !== undefined) return new TextEncoder().encode(file.text);
  }
  const response = await fetch(githubContentUrl(owner, repo, path, ref, true), {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.ok) return new Uint8Array(await response.arrayBuffer());

  // Fallback to the JSON contents API for small files or older API behaviour.
  const data = await fetchContentJson(token, owner, repo, path, ref, true);
  if (data.content) return decodeBytes(data.content);
  throw new Error(`${path} is not a file`);
}

// ─── Paragraph CRUD ───────────────────────────────────────────────────────────

/** UTF-8-safe base64 encoding for the GitHub API `content` field. */
function encodeContent(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return encodeBytes(bytes);
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export interface FileContent {
  content: string;
  sha: string;
}

function isShaUpdateError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /sha/i.test(message) && /(wasn'?t supplied|does not match|required)/i.test(message);
}

async function findFileShaFromTree(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<string | null> {
  const octokit = createGitHubClient(token);
  const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const tree = await octokit.rest.git.getTree({ owner, repo, tree_sha: ref.data.object.sha, recursive: "true" });
  const entry = tree.data.tree.find((item) => item.path === path && item.type === "blob");
  return entry?.sha ?? null;
}

/** Read a file's text content and its current SHA (required for updates). */
export async function readFileWithSha(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<FileContent> {
  const id = await localRepoId(owner, repo, branch);
  if (id) {
    const file = await getLocalFile(id, path);
    if (file?.kind === "text" && file.text !== undefined) return { content: file.text, sha: file.currentHash };
    if (file?.kind === "binary" && file.blob) return { content: new TextDecoder().decode(await file.blob.arrayBuffer()), sha: file.currentHash };
  }
  const data = await fetchContentJson(token, owner, repo, path, branch, true);
  if (data.content && data.sha) {
    return { content: decodeContent(data.content), sha: data.sha };
  }
  throw new Error(`${path} is not a file`);
}

/** Update an existing file. Returns the new blob SHA. */
export async function updateFile(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  sha: string,
  content: string,
  message: string,
): Promise<string> {
  const id = await localRepoId(owner, repo, branch);
  if (id) return (await writeLocalText(id, path, content)).currentHash;
  const octokit = createGitHubClient(token);
  const { data } = await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: encodeContent(content),
    sha,
    branch,
  });
  return data.content?.sha ?? sha;
}

export async function createOrUpdateBinaryFile(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  bytes: Uint8Array,
  message: string,
): Promise<string> {
  const id = await localRepoId(owner, repo, branch);
  if (id) return (await writeLocalBinary(id, path, bytes)).currentHash;
  const octokit = createGitHubClient(token);
  const existing = await readFileWithSha(token, owner, repo, branch, path).catch(() => null);
  const body = {
    owner,
    repo,
    path,
    message,
    content: encodeBytes(bytes),
    sha: existing?.sha,
    branch,
  };
  let data: Awaited<ReturnType<typeof octokit.rest.repos.createOrUpdateFileContents>>["data"];
  try {
    ({ data } = await octokit.rest.repos.createOrUpdateFileContents(body));
  } catch (err) {
    if (!isShaUpdateError(err)) throw err;
    const sha = await findFileShaFromTree(token, owner, repo, branch, path);
    if (!sha) throw err;
    ({ data } = await octokit.rest.repos.createOrUpdateFileContents({ ...body, sha }));
  }
  return data.content?.sha ?? existing?.sha ?? "";
}

/** Create a new file. Returns the blob SHA. */
export async function createFile(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  const id = await localRepoId(owner, repo, branch);
  if (id) {
    const existing = await getLocalFile(id, path);
    if (existing) throw new Error(`File already exists: ${path}`);
    return (await writeLocalText(id, path, content)).currentHash;
  }
  const octokit = createGitHubClient(token);
  const { data } = await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: encodeContent(content),
    branch,
  });
  return data.content?.sha ?? "";
}

/** Create the file when missing or update it in place, returning the new sha. */
export async function createOrUpdateTextFile(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  const existing = await readFileWithSha(token, owner, repo, branch, path).catch(() => null);
  if (existing) return updateFile(token, owner, repo, branch, path, existing.sha, content, message);
  try {
    return await createFile(token, owner, repo, branch, path, content, message);
  } catch (err) {
    if (!isShaUpdateError(err)) throw err;
    const sha = await findFileShaFromTree(token, owner, repo, branch, path);
    if (!sha) throw err;
    return updateFile(token, owner, repo, branch, path, sha, content, message);
  }
}

/** Create the file only if it does not exist yet. Returns true when created, false when it already existed. */
export async function createFileIfAbsent(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<boolean> {
  const existing = await readFileWithSha(token, owner, repo, branch, path).catch(() => null);
  if (existing) return false;
  await createFile(token, owner, repo, branch, path, content, message);
  return true;
}

/**
 * Commit a reorder (and optional deletion) of chapter paragraphs atomically.
 *
 * - `oldParagraphs`: current paragraph list as loaded from the store
 * - `newOrderedParagraphs`: desired order (may be shorter if a paragraph was deleted)
 *
 * Renumbers the paragraph files by their 1-based position and moves EVERY
 * paragraph-scoped companion file so nothing is orphaned: the paragraph `.md`,
 * its draft, its script, its evaluation, and its image assets. Removed
 * paragraphs delete all of those companions too. Slug references
 * (`paragraph:<chapter>:<slug>`) and the `number` field are rewritten repo-wide.
 *
 * Local-first: applies to IndexedDB when a working copy exists, else commits to GitHub.
 * Returns the updated `Paragraph[]` with new paths, numbers and titles.
 */
export async function reorderParagraphsInChapter(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  chapterPath: string,
  oldParagraphs: Paragraph[],
  newOrderedParagraphs: Paragraph[],
  commitMessage = "Reorder paragraphs",
): Promise<Paragraph[]> {
  const chapterSlug = chapterPath.replace(/^chapters\//, "");
  const escapedChapter = chapterSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const paragraphSlug = (path: string): string => (path.split("/").pop() ?? "").replace(/\.md$/i, "");

  // Build the slug remap and per-slug new number.
  const remapBySlug = new Map<string, string>(); // oldSlug -> newSlug (only when changed)
  const newNumberByNewSlug = new Map<string, number>();
  const result: Paragraph[] = [];

  newOrderedParagraphs.forEach((p, index) => {
    const newNumber = index + 1;
    const oldSlug = paragraphSlug(p.path);
    const m = oldSlug.match(/^(\d{3})(?:-(.+))?$/);
    const slugPart = m?.[2];
    const numStr = String(newNumber).padStart(3, "0");
    const newSlug = slugPart ? `${numStr}-${slugPart}` : numStr;
    newNumberByNewSlug.set(newSlug, newNumber);
    if (newSlug !== oldSlug) remapBySlug.set(oldSlug, newSlug);

    const rename = (path: string | undefined, build: (slug: string) => string): string | undefined =>
      path ? build(newSlug) : undefined;

    result.push({
      number: numStr,
      title: slugToTitle(newSlug),
      path: `${chapterPath}/${newSlug}.md`,
      draftPath: rename(p.draftPath, (s) => `${chapterPath}/drafts/${s}.md`),
      scriptPath: rename(p.scriptPath, (s) => `scripts/${chapterSlug}/${s}.md`),
      evaluationPath: rename(p.evaluationPath, (s) => `evaluations/paragraphs/${chapterSlug}/${s}.md`),
      imagePath: p.imagePath ? p.imagePath.replace(`/paragraphs/${paragraphSlug(p.path)}/`, `/paragraphs/${newSlug}/`) : undefined,
    });
  });

  const newSlugs = new Set(newOrderedParagraphs.map((p) => paragraphSlug(p.path)));
  const deleteSlugs = new Set(oldParagraphs.map((p) => paragraphSlug(p.path)).filter((slug) => !newSlugs.has(slug)));

  if (remapBySlug.size === 0 && deleteSlugs.size === 0) return result;

  // Classify a repo path to the paragraph slug it belongs to (or null).
  const slugOfPath = (path: string): string | null => {
    let m = new RegExp(`^drafts/${escapedChapter}/(\\d{3}(?:-[^/]+)?)\\.md$`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^chapters/${escapedChapter}/drafts/(\\d{3}(?:-[^/]+)?)\\.md$`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^chapters/${escapedChapter}/(\\d{3}(?:-[^/]+)?)\\.md$`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^scripts/${escapedChapter}/(\\d{3}(?:-[^/]+)?)\\.md$`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^evaluations/paragraphs/${escapedChapter}/(\\d{3}(?:-[^/]+)?)\\.md$`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^assets/chapters/${escapedChapter}/paragraphs/([^/]+)/`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^evaluations/readers/(?:paragraphs|selections)/${escapedChapter}/([^/]+)/`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^evaluations/readers/summaries/(?:paragraphs|selections)/${escapedChapter}/([^/]+)/`).exec(path);
    if (m) return m[1];
    return null;
  };

  // Compute the new path for a companion file when its paragraph slug is remapped.
  const remapPath = (path: string): string | null => {
    const slug = slugOfPath(path);
    if (!slug) return null;
    const newSlug = remapBySlug.get(slug);
    if (!newSlug) return null;
    // Replace the slug segment while keeping the surrounding path.
    if (path.startsWith(`drafts/${chapterSlug}/`)) return `drafts/${chapterSlug}/${newSlug}.md`;
    if (path.startsWith(`chapters/${chapterSlug}/drafts/`)) return `chapters/${chapterSlug}/drafts/${newSlug}.md`;
    if (path.startsWith(`chapters/${chapterSlug}/`)) return `chapters/${chapterSlug}/${newSlug}.md`;
    if (path.startsWith(`scripts/${chapterSlug}/`)) return `scripts/${chapterSlug}/${newSlug}.md`;
    if (path.startsWith(`evaluations/paragraphs/${chapterSlug}/`)) return `evaluations/paragraphs/${chapterSlug}/${newSlug}.md`;
    const readerMatch = new RegExp(`^(evaluations/readers/(?:paragraphs|selections)/${escapedChapter}/)[^/]+(/.*)$`).exec(path);
    if (readerMatch) return `${readerMatch[1]}${newSlug}${readerMatch[2]}`;
    const readerSummaryMatch = new RegExp(`^(evaluations/readers/summaries/(?:paragraphs|selections)/${escapedChapter}/)[^/]+(/.*)$`).exec(path);
    if (readerSummaryMatch) return `${readerSummaryMatch[1]}${newSlug}${readerSummaryMatch[2]}`;
    const assetMatch = new RegExp(`^(assets/chapters/${escapedChapter}/paragraphs/)[^/]+(/.*)$`).exec(path);
    if (assetMatch) return `${assetMatch[1]}${newSlug}${assetMatch[2]}`;
    return null;
  };

  const isDeletedPath = (path: string): boolean => {
    const slug = slugOfPath(path);
    return slug !== null && deleteSlugs.has(slug);
  };

  const rewriteRefs = (text: string): string => {
    let out = text;
    for (const [oldSlug, newSlug] of remapBySlug) {
      out = out.split(`paragraph:${chapterSlug}:${oldSlug}`).join(`paragraph:${chapterSlug}:${newSlug}`);
    }
    return out;
  };

  const fixNumber = (finalPath: string, text: string): string => {
    const m = new RegExp(`^chapters/${escapedChapter}/(\\d{3}(?:-[^/]+)?)\\.md$`).exec(finalPath);
    if (!m) return text;
    const num = newNumberByNewSlug.get(m[1]);
    if (!num) return text;
    if (/^number:\s*.*$/m.test(text)) return text.replace(/^number:\s*.*$/m, `number: ${num}`);
    return text;
  };

  // ── Local working copy ──────────────────────────────────────────────────────
  const id = await localRepoId(owner, repo, branch);
  if (id) {
    const files = await listLocalFiles(id);
    const textWrites: Array<{ path: string; text: string }> = [];
    const binaryWrites: Array<{ path: string; bytes: Uint8Array }> = [];
    const toDelete = new Set<string>();

    for (const file of files) {
      if (isDeletedPath(file.path)) {
        toDelete.add(file.path);
        continue;
      }
      const newPath = remapPath(file.path);
      const moved = newPath !== null && newPath !== file.path;
      const finalPath = newPath ?? file.path;

      if (file.kind === "text") {
        const original = file.text ?? "";
        let next = rewriteRefs(original);
        next = fixNumber(finalPath, next);
        if (moved || next !== original) {
          textWrites.push({ path: finalPath, text: next });
          if (moved) toDelete.add(file.path);
        }
      } else if (moved && file.blob) {
        binaryWrites.push({ path: finalPath, bytes: new Uint8Array(await file.blob.arrayBuffer()) });
        toDelete.add(file.path);
      }
    }

    const writePaths = new Set([...textWrites.map((w) => w.path), ...binaryWrites.map((w) => w.path)]);
    for (const path of toDelete) {
      if (writePaths.has(path)) continue;
      await deleteLocalFile(id, path);
    }
    for (const w of textWrites) await writeLocalText(id, w.path, w.text);
    for (const w of binaryWrites) await writeLocalBinary(id, w.path, w.bytes);
    return result;
  }

  // ── Remote: single atomic commit via the Git Trees API ──────────────────────
  const octokit = createGitHubClient(token);
  const { data: branchData } = await octokit.rest.repos.getBranch({ owner, repo, branch });
  const currentCommitSha = branchData.commit.sha;
  const currentTreeSha = branchData.commit.commit.tree.sha;

  const { data: fullTree } = await octokit.rest.git.getTree({ owner, repo, tree_sha: currentTreeSha, recursive: "1" });

  type TreeEntry = { path: string; mode: "100644"; type: "blob"; sha?: string | null; content?: string };
  const treeUpdates: TreeEntry[] = [];
  const isTextPath = (path: string) => /\.(md|json|txt|ya?ml)$/i.test(path);

  for (const node of fullTree.tree) {
    if (node.type !== "blob" || !node.path) continue;
    const path = node.path;

    if (isDeletedPath(path)) {
      treeUpdates.push({ path, mode: "100644", type: "blob", sha: null });
      continue;
    }

    const newPath = remapPath(path);
    const moved = newPath !== null && newPath !== path;
    const finalPath = newPath ?? path;

    if (moved) {
      treeUpdates.push({ path, mode: "100644", type: "blob", sha: null });
      if (isTextPath(path)) {
        const raw = await loadFileContent(token, owner, repo, path, branch).catch(() => null);
        const next = raw !== null ? fixNumber(finalPath, rewriteRefs(raw)) : null;
        if (next !== null) treeUpdates.push({ path: finalPath, mode: "100644", type: "blob", content: next });
        else if (node.sha) treeUpdates.push({ path: finalPath, mode: "100644", type: "blob", sha: node.sha });
      } else if (node.sha) {
        treeUpdates.push({ path: finalPath, mode: "100644", type: "blob", sha: node.sha });
      }
    } else if (isTextPath(path) && remapBySlug.size > 0) {
      const raw = await loadFileContent(token, owner, repo, path, branch).catch(() => null);
      if (raw !== null) {
        const next = rewriteRefs(raw);
        if (next !== raw) treeUpdates.push({ path, mode: "100644", type: "blob", content: next });
      }
    }
  }

  if (treeUpdates.length === 0) return result;

  const { data: newTree } = await octokit.rest.git.createTree({ owner, repo, base_tree: currentTreeSha, tree: treeUpdates });
  const { data: newCommit } = await octokit.rest.git.createCommit({ owner, repo, message: commitMessage, tree: newTree.sha, parents: [currentCommitSha] });
  await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: newCommit.sha });

  return result;
}

// ─── Chapter reordering ───────────────────────────────────────────────────────

export interface ChapterReorderEntry {
  /** Chapter folder slug, e.g. "001-una-stella-e-nata". */
  slug: string;
}

/**
 * Reorder chapters by renumbering their folder slug prefix (001-, 002-, …).
 * Moves every file that lives under a renamed chapter across the six chapter-scoped
 * path prefixes (chapters/, scripts/, assets/chapters/, evaluations/paragraphs/,
 * resumes/chapters/*.md, evaluations/chapters/*.md), updates the `number` field in
 * each moved chapter.md, and rewrites `chapter:<slug>` / `paragraph:<slug>:`
 * references repo-wide so canon links stay intact.
 *
 * Local-first: applies to IndexedDB when a working copy exists, else commits to GitHub.
 * Returns the old→new slug remap that was applied.
 */
export async function reorderChaptersInBook(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  newOrderedChapters: ChapterReorderEntry[],
  commitMessage = "Reorder chapters",
): Promise<Map<string, string>> {
  // Build old→new slug remap and the new number per (new) slug.
  const remap = new Map<string, string>();
  const newNumberForNewSlug = new Map<string, number>();

  newOrderedChapters.forEach((chapter, index) => {
    const newNumber = index + 1;
    const titlePart = chapter.slug.replace(/^\d{3}(?:-)?/, "");
    const newSlug = titlePart ? `${String(newNumber).padStart(3, "0")}-${titlePart}` : String(newNumber).padStart(3, "0");
    newNumberForNewSlug.set(newSlug, newNumber);
    if (newSlug !== chapter.slug) remap.set(chapter.slug, newSlug);
  });

  if (remap.size === 0) return remap;

  // Map a repo path to its new path if it belongs to a remapped chapter.
  const remapPath = (path: string): string | null => {
    for (const [oldSlug, newSlug] of remap) {
      const prefixes = [
        `chapters/${oldSlug}/`,
        `drafts/${oldSlug}/`,
        `scripts/${oldSlug}/`,
        `assets/chapters/${oldSlug}/`,
        `evaluations/paragraphs/${oldSlug}/`,
        `evaluations/readers/chapters/${oldSlug}/`,
        `evaluations/readers/paragraphs/${oldSlug}/`,
        `evaluations/readers/selections/${oldSlug}/`,
        `evaluations/readers/summaries/chapters/${oldSlug}/`,
        `evaluations/readers/summaries/paragraphs/${oldSlug}/`,
        `evaluations/readers/summaries/selections/${oldSlug}/`,
      ];
      for (const prefix of prefixes) {
        if (path.startsWith(prefix)) {
          return newSlug ? `${prefix.slice(0, prefix.length - oldSlug.length - 1)}${newSlug}/${path.slice(prefix.length)}` : path;
        }
      }
      if (path === `resumes/chapters/${oldSlug}.md`) return `resumes/chapters/${newSlug}.md`;
      if (path === `evaluations/chapters/${oldSlug}.md`) return `evaluations/chapters/${newSlug}.md`;
      if (path === `state/chapters/${oldSlug}.md`) return `state/chapters/${newSlug}.md`;
    }
    return null;
  };

  // Rewrite slug references inside file content.
  const rewriteRefs = (text: string): string => {
    let out = text;
    for (const [oldSlug, newSlug] of remap) {
      out = out.split(`chapter:${oldSlug}`).join(`chapter:${newSlug}`);
      out = out.split(`paragraph:${oldSlug}:`).join(`paragraph:${newSlug}:`);
    }
    return out;
  };

  // Chapter number lives in chapters/<slug>/chapter.md — update it after moving.
  const fixChapterNumber = (finalPath: string, text: string): string => {
    const match = /^chapters\/([^/]+)\/chapter\.md$/.exec(finalPath);
    if (!match) return text;
    const num = newNumberForNewSlug.get(match[1]);
    if (!num) return text;
    if (/^number:\s*.*$/m.test(text)) return text.replace(/^number:\s*.*$/m, `number: ${num}`);
    return text;
  };

  // ── Local working copy ──────────────────────────────────────────────────────
  const id = await localRepoId(owner, repo, branch);
  if (id) {
    const files = await listLocalFiles(id);
    const textWrites: Array<{ path: string; text: string }> = [];
    const binaryWrites: Array<{ path: string; bytes: Uint8Array }> = [];
    const toDelete = new Set<string>();

    for (const file of files) {
      const newPath = remapPath(file.path);
      const moved = newPath !== null && newPath !== file.path;
      const finalPath = newPath ?? file.path;

      if (file.kind === "text") {
        const original = file.text ?? "";
        let next = rewriteRefs(original);
        next = fixChapterNumber(finalPath, next);
        if (moved || next !== original) {
          textWrites.push({ path: finalPath, text: next });
          if (moved) toDelete.add(file.path);
        }
      } else if (moved && file.blob) {
        binaryWrites.push({ path: finalPath, bytes: new Uint8Array(await file.blob.arrayBuffer()) });
        toDelete.add(file.path);
      }
    }

    const writePaths = new Set([...textWrites.map((w) => w.path), ...binaryWrites.map((w) => w.path)]);
    for (const path of toDelete) {
      if (writePaths.has(path)) continue;
      await deleteLocalFile(id, path);
    }
    for (const w of textWrites) await writeLocalText(id, w.path, w.text);
    for (const w of binaryWrites) await writeLocalBinary(id, w.path, w.bytes);
    return remap;
  }

  // ── Remote: single atomic commit via the Git Trees API ──────────────────────
  const octokit = createGitHubClient(token);
  const { data: branchData } = await octokit.rest.repos.getBranch({ owner, repo, branch });
  const currentCommitSha = branchData.commit.sha;
  const currentTreeSha = branchData.commit.commit.tree.sha;

  const { data: fullTree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: currentTreeSha,
    recursive: "1",
  });

  type TreeEntry = { path: string; mode: "100644"; type: "blob"; sha?: string | null; content?: string };
  const treeUpdates: TreeEntry[] = [];

  const blobs = fullTree.tree.filter((node) => node.type === "blob" && node.path);
  const isTextPath = (path: string) => /\.(md|json|txt|ya?ml|opf|ncx|xhtml|css|html)$/i.test(path);

  for (const node of blobs) {
    const path = node.path!;
    const newPath = remapPath(path);
    const moved = newPath !== null && newPath !== path;
    const finalPath = newPath ?? path;
    const affectsRefs = isTextPath(path);

    if (moved) {
      // Remove the old path.
      treeUpdates.push({ path, mode: "100644", type: "blob", sha: null });
      if (affectsRefs) {
        const raw = await loadFileContent(token, owner, repo, path, branch).catch(() => null);
        const next = raw !== null ? fixChapterNumber(finalPath, rewriteRefs(raw)) : null;
        if (next !== null) treeUpdates.push({ path: finalPath, mode: "100644", type: "blob", content: next });
        else if (node.sha) treeUpdates.push({ path: finalPath, mode: "100644", type: "blob", sha: node.sha });
      } else if (node.sha) {
        treeUpdates.push({ path: finalPath, mode: "100644", type: "blob", sha: node.sha });
      }
    } else if (affectsRefs) {
      // Not moved, but may reference a remapped chapter.
      const raw = await loadFileContent(token, owner, repo, path, branch).catch(() => null);
      if (raw !== null) {
        const next = rewriteRefs(raw);
        if (next !== raw) treeUpdates.push({ path, mode: "100644", type: "blob", content: next });
      }
    }
  }

  if (treeUpdates.length === 0) return remap;

  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: currentTreeSha,
    tree: treeUpdates,
  });
  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: newTree.sha,
    parents: [currentCommitSha],
  });
  await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: newCommit.sha });

  return remap;
}

// ─── Dev branch management ────────────────────────────────────────────────────
/**
 * Derive a deterministic git branch name from a Google email address.
 * "user.name+tag@gmail.com"  →  "dev-user.name-tag"
 */
export function emailToBranchName(email: string): string {
  const local = email
    .split("@")[0]
    .toLowerCase()
    .replace(/\+/g, "-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return `dev-${local}`;
}

/**
 * Ensure the personal dev branch exists, creating it from `baseBranch` if needed.
 * Returns the branch name.
 */
export async function ensureDevBranch(
  token: string,
  owner: string,
  repo: string,
  baseBranch: string,
  email: string,
): Promise<string> {
  const octokit = createGitHubClient(token);
  const branchName = emailToBranchName(email);

  try {
    await octokit.rest.repos.getBranch({ owner, repo, branch: branchName });
    return branchName; // already exists
  } catch (err: unknown) {
    if ((err as { status?: number })?.status !== 404) throw err;
  }

  // Branch not found → create from baseBranch
  const { data: base } = await octokit.rest.repos.getBranch({
    owner,
    repo,
    branch: baseBranch,
  });
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: base.commit.sha,
  });
  return branchName;
}

/**
 * Rename a file AND update its content in one atomic commit (Git Trees API).
 * Returns the blob SHA of the new file.
 */
export async function renameAndUpdateFile(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  oldPath: string,
  newPath: string,
  content: string,
  message: string,
): Promise<{ sha: string }> {
  const id = await localRepoId(owner, repo, branch);
  if (id) {
    await deleteLocalFile(id, oldPath);
    const file = await writeLocalText(id, newPath, content);
    return { sha: file.currentHash };
  }
  const octokit = createGitHubClient(token);

  const { data: branchData } = await octokit.rest.repos.getBranch({
    owner,
    repo,
    branch,
  });
  const currentCommitSha = branchData.commit.sha;
  const currentTreeSha = branchData.commit.commit.tree.sha;

  // Using `content` lets GitHub create the blob; sha: null deletes the old path
  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: currentTreeSha,
    tree: [
      { path: oldPath, mode: "100644", type: "blob", sha: null },
      { path: newPath, mode: "100644", type: "blob", content },
    ],
  });

  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [currentCommitSha],
  });
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: newCommit.sha,
  });

  const sha = newTree.tree.find((n) => n.path === newPath)?.sha ?? "";
  return { sha };
}

export interface BranchDiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previousFilename?: string;
}

export async function compareBranches(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<BranchDiffFile[]> {
  const octokit = createGitHubClient(token);
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${head}`,
  });
  return (data.files ?? []).map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch,
    previousFilename: file.previous_filename,
  }));
}

export async function deleteFile(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  sha: string,
  message: string,
): Promise<void> {
  const id = await localRepoId(owner, repo, branch);
  if (id) {
    await deleteLocalFile(id, path);
    return;
  }
  const octokit = createGitHubClient(token);
  await octokit.rest.repos.deleteFile({
    owner,
    repo,
    path,
    message,
    sha,
    branch,
  });
}

export async function revertFileToRef(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  baseRef: string,
): Promise<void> {
  const current = await readFileWithSha(token, owner, repo, branch, path).catch(() => null);
  const base = await readFileWithSha(token, owner, repo, baseRef, path).catch(() => null);

  if (base && current) {
    await updateFile(token, owner, repo, branch, path, current.sha, base.content, `Revert ${path} to ${baseRef}`);
    return;
  }

  if (base && !current) {
    await createFile(token, owner, repo, branch, path, base.content, `Restore ${path} from ${baseRef}`);
    return;
  }

  if (!base && current) {
    await deleteFile(token, owner, repo, branch, path, current.sha, `Remove ${path}`);
    return;
  }

  throw new Error(`No file content found for ${path} on ${branch} or ${baseRef}.`);
}

export interface BranchSummary {
  name: string;
  protected: boolean;
}

export async function listBranches(
  token: string,
  owner: string,
  repo: string,
): Promise<BranchSummary[]> {
  const octokit = createGitHubClient(token);
  const branches = await octokit.paginate(octokit.rest.repos.listBranches, {
    owner,
    repo,
    per_page: 100,
  });
  return branches
    .map((branch) => ({ name: branch.name, protected: branch.protected }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function createBranchFromBase(
  token: string,
  owner: string,
  repo: string,
  baseBranch: string,
  newBranch: string,
): Promise<string> {
  const octokit = createGitHubClient(token);
  const { data: base } = await octokit.rest.repos.getBranch({ owner, repo, branch: baseBranch });
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${newBranch}`,
    sha: base.commit.sha,
  });
  return newBranch;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  head: string;
  base: string;
}

export async function listOpenPullRequests(
  token: string,
  owner: string,
  repo: string,
  head?: string,
): Promise<PullRequestSummary[]> {
  const octokit = createGitHubClient(token);
  const pulls = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    head: head ? `${owner}:${head}` : undefined,
    per_page: 100,
  });
  return pulls.map((pull) => ({
    number: pull.number,
    title: pull.title,
    state: pull.state,
    htmlUrl: pull.html_url,
    head: pull.head.ref,
    base: pull.base.ref,
  }));
}

export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  input: { title: string; body?: string; head: string; base: string },
): Promise<PullRequestSummary> {
  const octokit = createGitHubClient(token);
  const { data } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
  });
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    htmlUrl: data.html_url,
    head: data.head.ref,
    base: data.base.ref,
  };
}

export async function getDefaultBranch(
  token: string,
  owner: string,
  repo: string,
): Promise<string> {
  const octokit = createGitHubClient(token);
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}

export interface BranchCommitSummary {
  sha: string;
  message: string;
  authorName: string;
  authoredAt: string;
  url: string;
}

export async function listBranchCommits(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<BranchCommitSummary[]> {
  const octokit = createGitHubClient(token);
  const commits = await octokit.paginate(octokit.rest.repos.listCommits, {
    owner,
    repo,
    sha: branch,
    per_page: 30,
  });
  return commits.map((commit) => ({
    sha: commit.sha,
    message: commit.commit.message.split("\n")[0] ?? commit.sha,
    authorName: commit.commit.author?.name ?? commit.author?.login ?? "Unknown",
    authoredAt: commit.commit.author?.date ?? new Date().toISOString(),
    url: commit.html_url,
  }));
}

export async function closePullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<void> {
  const octokit = createGitHubClient(token);
  await octokit.rest.pulls.update({ owner, repo, pull_number: number, state: "closed" });
}

export async function mergePullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number,
  commitTitle?: string,
): Promise<void> {
  const octokit = createGitHubClient(token);
  await octokit.rest.pulls.merge({
    owner,
    repo,
    pull_number: number,
    commit_title: commitTitle,
    merge_method: "merge",
  });
}
