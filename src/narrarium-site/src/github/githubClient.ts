import { Octokit } from "@octokit/rest";
import { BookStructure, Chapter, Paragraph, BookFile } from "@/types/book";

export function createGitHubClient(token: string): Octokit {
  return new Octokit({ auth: token });
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

/** Extract a frontmatter `title` field if present, otherwise fall back to slug. */
function titleFromFrontmatter(raw: string, fallback: string): string {
  const match = /^---[\s\S]*?^title:\s*(.+)$/m.exec(raw);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : fallback;
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

// ─── Load the full book structure from a repository ──────────────────────────

/** Extract a display name (title/name) from a markdown file's frontmatter block. */
function nameFromFrontmatter(raw: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const block = fm ? fm[1] : raw.slice(0, 600);
  const match = /^(?:title|name):\s*(.+)$/m.exec(block);
  if (!match) return undefined;
  const value = match[1].trim().replace(/^["']|["']$/g, "").trim();
  return value || undefined;
}

/**
 * Read frontmatter title/name for many files in a few GraphQL requests instead of
 * one REST call per file. Returns a map path → display name (only where found).
 */
async function fetchFrontmatterNames(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  paths: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
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
          if (name) result[p] = name;
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
  if (allPaths.includes("book.md")) {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path: "book.md", ref: branch });
      if ("content" in data) {
        const raw = decodeContent(data.content);
        title = titleFromFrontmatter(raw, repo);
        const descMatch = /^description:\s*(.+)$/m.exec(raw);
        description = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : "";
      }
    } catch { /* no book.md – use defaults */ }
  }

  // ── Frontmatter display names (chapters, paragraphs, canon) via GraphQL batch ──
  const canonPrefixes = ["characters", "locations", "factions", "items", "timelines", "secrets"];
  const canonPaths = allPaths.filter((p) => p.endsWith(".md") && canonPrefixes.some((prefix) => p.startsWith(`${prefix}/`)));
  const chapterMdPaths = allPaths.filter((p) => /^chapters\/[^/]+\/chapter\.md$/.test(p));
  const paragraphPaths = allPaths.filter((p) => /^chapters\/[^/]+\/\d{3}(?:-[^/]+)?\.md$/.test(p) && !p.includes("/drafts/"));
  const nameMap = await fetchFrontmatterNames(octokit, owner, repo, branch, [...chapterMdPaths, ...paragraphPaths, ...canonPaths]);

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
          name: nameMap[p],
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
        title: nameMap[p] ?? slugToTitle(filename.replace(/\.md$/, "")),
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
      title: nameMap[`${folder}/chapter.md`] ?? slugToTitle(slug),
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
    globalWritingStylePath: allPaths.find((p) =>
      p.match(/^guidelines\/(writing-style|style)\.md$/)
    ),
    voicesPath: allPaths.includes("guidelines/voices.md")
      ? "guidelines/voices.md"
      : undefined,
    ghostwriters: allPaths
      .filter((p) => /^ghostwriters\/[^/]+\.md$/.test(p))
      .map((p) => {
        const slug = p.replace(/^ghostwriters\//, "").replace(/\.md$/i, "");
        return { slug, path: p, name: slugToTitle(slug) };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    plotPath: allPaths.includes("plot.md") ? "plot.md" : undefined,
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
  const octokit = createGitHubClient(token);
  const params = ref ? { owner, repo, path, ref } : { owner, repo, path };
  const { data } = await octokit.rest.repos.getContent(params);
  if ("content" in data) return decodeContent(data.content);
  throw new Error(`${path} is not a file`);
}

export async function loadBinaryFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<Uint8Array> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}${query}`;
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.ok) return new Uint8Array(await response.arrayBuffer());

  // Fallback to the JSON contents API for small files or older API behaviour.
  const octokit = createGitHubClient(token);
  const params = ref ? { owner, repo, path, ref } : { owner, repo, path };
  const { data } = await octokit.rest.repos.getContent(params);
  if ("content" in data && data.content) return decodeBytes(data.content);
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

/** Read a file's text content and its current SHA (required for updates). */
export async function readFileWithSha(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<FileContent> {
  const octokit = createGitHubClient(token);
  const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
  if ("content" in data) {
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
  const octokit = createGitHubClient(token);
  const existing = await readFileWithSha(token, owner, repo, branch, path).catch(() => null);
  const { data } = await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: encodeBytes(bytes),
    sha: existing?.sha,
    branch,
  });
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
  return createFile(token, owner, repo, branch, path, content, message);
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
 * Files are renumbered by their 1-based position in `newOrderedParagraphs`.
 * Any paragraph in `oldParagraphs` absent from `newOrderedParagraphs` is deleted.
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
  const octokit = createGitHubClient(token);

  // Get HEAD commit and its tree
  const { data: branchData } = await octokit.rest.repos.getBranch({
    owner,
    repo,
    branch,
  });
  const currentCommitSha = branchData.commit.sha;
  const currentTreeSha = branchData.commit.commit.tree.sha;

  const { data: fullTree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: currentTreeSha,
    recursive: "1",
  });

  const getBlobSha = (p: string) =>
    fullTree.tree.find((n) => n.path === p)?.sha ?? null;

  type TreeEntry = {
    path: string;
    mode: "100644";
    type: "blob";
    sha: string | null;
  };
  const treeUpdates: TreeEntry[] = [];

  // Build the new result list and compute needed renames
  const result: Paragraph[] = [];
  const newOriginalPaths = new Set(newOrderedParagraphs.map((p) => p.path));

  for (let i = 0; i < newOrderedParagraphs.length; i++) {
    const p = newOrderedParagraphs[i];
    const newNumber = String(i + 1).padStart(3, "0");
    const oldFilename = p.path.split("/").pop()!;
    const m = oldFilename.match(/^(\d{3})(?:-(.+))?\.md$/);
    const slugPart = m?.[2]; // undefined for bare "001.md"
    const newFilename = slugPart
      ? `${newNumber}-${slugPart}.md`
      : `${newNumber}.md`;
    const newPath = `${chapterPath}/${newFilename}`;

    if (p.path !== newPath) {
      const sha = getBlobSha(p.path);
      if (sha) {
        treeUpdates.push({ path: p.path, mode: "100644", type: "blob", sha: null });
        treeUpdates.push({ path: newPath, mode: "100644", type: "blob", sha });
      }
    }

    // Handle draft files
    let newDraftPath: string | undefined;
    if (p.draftPath) {
      const draftFilename = p.draftPath.split("/").pop()!;
      const dm = draftFilename.match(/^(\d{3})(?:-(.+))?\.md$/);
      const draftSlug = dm?.[2];
      const newDraftFilename = draftSlug
        ? `${newNumber}-${draftSlug}.md`
        : `${newNumber}.md`;
      newDraftPath = `${chapterPath}/drafts/${newDraftFilename}`;

      if (p.draftPath !== newDraftPath) {
        const draftSha = getBlobSha(p.draftPath);
        if (draftSha) {
          treeUpdates.push({ path: p.draftPath, mode: "100644", type: "blob", sha: null });
          treeUpdates.push({ path: newDraftPath, mode: "100644", type: "blob", sha: draftSha });
        }
      }
    }

    result.push({
      number: newNumber,
      title: slugToTitle(newFilename.replace(/\.md$/, "")),
      path: newPath,
      draftPath: newDraftPath,
    });
  }

  // Delete paragraphs that were removed from the list
  for (const p of oldParagraphs) {
    if (!newOriginalPaths.has(p.path)) {
      treeUpdates.push({ path: p.path, mode: "100644", type: "blob", sha: null });
      if (p.draftPath) {
        treeUpdates.push({ path: p.draftPath, mode: "100644", type: "blob", sha: null });
      }
    }
  }

  if (treeUpdates.length === 0) return result;

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
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: newCommit.sha,
  });

  return result;
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
