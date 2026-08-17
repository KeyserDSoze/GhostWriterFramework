import { Octokit } from "@octokit/rest";
import { BookStructure, Chapter, Paragraph, BookFile, ResearchFile } from "@/types/book";
import { applyLocalFileChangesAtomically, deleteLocalFileAtomically, getLocalFile, getLocalRepository, listLocalFiles, mutateLocalTextFilesAtomically, renameLocalTextFileAtomically, sha256Text, writeLocalBinaryScoped, type LocalFileAtomicWrite, type LocalTextFileMutation } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { buildInitialBookFiles } from "@/narrarium/bookScaffold";
import {
  buildBookAuditPath,
  buildChapterAuditPath,
  buildParagraphAuditPath,
  extractParagraphSlug,
} from "@/narrarium/auditPaths";
import { isRewriteOperationManifestPath } from "@/narrarium/rewriteOperationPaths";
import { classifyRepositoryError, isRepositoryNotFoundError, optionalRepositoryRead, RepositoryError } from "@/repository/repositoryError";
import {
  resolveParagraphArtifactPaths,
  type ParagraphArtifactMetadata,
  type ParagraphArtifactTarget,
} from "@/narrarium/paragraphArtifacts";
import { planCanonicalScriptMutation, SCRIPT_PATH_PATTERN, type CanonicalScriptMutationResult } from "@/narrarium/canonicalScriptMutationPlan";
import { reconcileRemoteMutation, type IntendedRemoteRevision } from "@/repository/remoteMutationReconciliation";

type StructuralTextWrite = { path: string; text: string };

async function canonicalizeStructuralTextChanges(
  files: Array<{ path: string; kind: string; text?: string }>,
  deletePaths: Iterable<string>,
  writes: StructuralTextWrite[],
): Promise<{ mutations: Array<{ path: string; content: string | null; expectedCurrentHash?: string | null }>; result: CanonicalScriptMutationResult | null }> {
  const source = new Map(files.filter((file) => file.kind === "text" && file.text !== undefined).map((file) => [file.path, file.text!]));
  const prospective = new Map(source);
  for (const path of deletePaths) prospective.delete(path);
  for (const write of writes) prospective.set(write.path, write.text);
  const paths = new Set([...source.keys(), ...prospective.keys()]);
  const mutations = await Promise.all([...paths]
    .filter((path) => source.get(path) !== prospective.get(path))
    .map(async (path) => ({ path, content: prospective.get(path) ?? null, expectedCurrentHash: source.has(path) ? await sha256Text(source.get(path)!) : null })));
  if (!mutations.some((mutation) => SCRIPT_PATH_PATTERN.test(mutation.path))) return { mutations, result: null };
  const planned = await planCanonicalScriptMutation([...source].map(([path, content]) => ({ path, content })), mutations);
  return { mutations: planned.mutations, result: planned.result };
}

async function updateStructuralRef(
  octokit: Octokit,
  input: { owner: string; repo: string; branch: string; expectedHeadSha: string; generatedCommitSha: string; revisions: IntendedRemoteRevision[]; signal?: AbortSignal },
): Promise<void> {
  try {
    await octokit.rest.git.updateRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}`, sha: input.generatedCommitSha, force: false, request: { signal: input.signal } });
  } catch (error) {
    const reconciled = await reconcileRemoteMutation({ octokit, owner: input.owner, repo: input.repo, branch: input.branch, generatedCommitSha: input.generatedCommitSha, revisions: input.revisions });
    if (reconciled.landed) return;
    if (reconciled.headSha && reconciled.headSha !== input.expectedHeadSha) throw new RepositoryError("The generated structural commit is not an ancestor of the remote head, or its intended revisions no longer match.", "conflict", "update", 409, { cause: error });
    throw error;
  }
}

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
  signal?: AbortSignal,
): Promise<{ content?: string; sha?: string }> {
  let response: Response;
  try {
    response = await fetch(githubContentUrl(owner, repo, path, ref, fresh), {
      cache: fresh ? "no-store" : "default",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal,
    });
  } catch (error) {
    const kind = typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
      ? "abort"
      : error instanceof TypeError ? "network" : "unknown";
    throw new RepositoryError(`GitHub content read failed for ${path}.`, kind, "read", undefined, { cause: error });
  }
  if (!response.ok) {
    const rateLimited = response.status === 429
      || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
    const kind = response.status === 404
      ? "not-found"
      : rateLimited ? "rate-limit"
        : response.status === 401 || response.status === 403 ? "auth"
          : response.status === 409 || response.status === 412 || response.status === 422 ? "conflict"
            : response.status >= 500 ? "network" : "unknown";
    throw new RepositoryError(`GitHub content read failed for ${path}: ${response.status}.`, kind, "read", response.status);
  }
  try {
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new TypeError("GitHub content response is not an object.");
    }
    const record = data as Record<string, unknown>;
    if ((record.content !== undefined && typeof record.content !== "string") || (record.sha !== undefined && typeof record.sha !== "string")) {
      throw new TypeError("GitHub content response has invalid content or sha fields.");
    }
    return { content: record.content as string | undefined, sha: record.sha as string | undefined };
  } catch (error) {
    if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") {
      throw new RepositoryError(`GitHub content read was aborted for ${path}.`, "abort", "read", undefined, { cause: error });
    }
    throw new RepositoryError(`GitHub returned malformed content JSON for ${path}.`, "malformed", "read", response.status, { cause: error });
  }
}

async function localRepoId(owner: string, repo: string, branch: string | undefined, scope: ReturnType<typeof captureRepositoryOperationScope>): Promise<string | null> {
  if (!branch) return null;
  let local: Awaited<ReturnType<typeof getLocalRepository>>;
  try { local = await getLocalRepository(owner, repo, branch, scope); } catch (error) { throw classifyRepositoryError(error, "read"); }
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
  paragraph?: string;
  knownFrom?: string;
  revealIn?: string;
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
          const paragraph = frontmatterString(text, "paragraph");
          const knownFrom = frontmatterString(text, "known_from");
          const revealIn = frontmatterString(text, "reveal_in");
          if (name || ghostwriter || paragraph || knownFrom || revealIn) result[p] = { name, ghostwriter, paragraph, knownFrom, revealIn };
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

  const auditFiles: BookFile[] = allPaths
    .filter((path) => path.startsWith("audit/") && path.endsWith(".md"))
    .map((path) => {
      const node = treeData.tree.find((entry) => entry.path === path);
      return { path, sha: node?.sha ?? "", size: node?.size ?? 0 };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const auditPathSet = new Set(auditFiles.map((file) => file.path));

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
  const paragraphArtifactPaths = allPaths.filter((p) =>
    /^(?:drafts\/[^/]+|chapters\/[^/]+\/drafts|scripts\/[^/]+)\/[^/]+\.md$/.test(p),
  );
  const notePaths = allPaths.filter((p) => /^notes\/[^/]+\.md$/.test(p));
  const personaPaths = allPaths.filter((p) => /^personas\/[^/]+\.md$/.test(p));
  const ghostwriterPaths = allPaths.filter((p) => /^ghostwriters\/[^/]+\.md$/.test(p));
  const metaMap = await fetchFrontmatterMetadata(octokit, owner, repo, branch, [...chapterMdPaths, ...paragraphPaths, ...paragraphArtifactPaths, ...canonPaths, ...notePaths, ...personaPaths, ...ghostwriterPaths]);

  const artifactTargets: ParagraphArtifactTarget[] = paragraphPaths.map((path) => {
    const parts = path.split("/");
    const paragraphSlug = (parts.pop() ?? "").replace(/\.md$/i, "");
    return {
      path,
      chapterSlug: parts[1] ?? "",
      paragraphSlug,
      title: metaMap[path]?.name ?? slugToTitle(paragraphSlug),
    };
  });
  const artifactMetadata: Record<string, ParagraphArtifactMetadata> = Object.fromEntries(
    paragraphArtifactPaths.map((path) => [path, { title: metaMap[path]?.name, paragraph: metaMap[path]?.paragraph }]),
  );
  const draftPaths = resolveParagraphArtifactPaths("draft", allPaths, artifactTargets, artifactMetadata);
  const scriptPaths = resolveParagraphArtifactPaths("script", allPaths, artifactTargets, artifactMetadata);

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
          knownFrom: metaMap[p]?.knownFrom,
          revealIn: metaMap[p]?.revealIn,
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
      const evaluationPath = `evaluations/paragraphs/${slug}/${paragraphSlug}.md`;
      const auditPath = buildParagraphAuditPath(slug, paragraphSlug);
      const imagePromptPath = `assets/chapters/${slug}/paragraphs/${paragraphSlug}/primary.md`;
      return {
        number: num,
        title: metaMap[p]?.name ?? slugToTitle(filename.replace(/\.md$/, "")),
        path: p,
        revision: treeData.tree.find((node) => node.path === p)?.sha,
        draftPath: draftPaths.get(p),
        scriptPath: scriptPaths.get(p),
        evaluationPath: allPaths.includes(evaluationPath) ? evaluationPath : undefined,
        auditPath: auditPathSet.has(auditPath) ? auditPath : undefined,
        imagePromptPath: allPaths.includes(imagePromptPath) ? imagePromptPath : undefined,
        imagePath: firstExistingImage(`assets/chapters/${slug}/paragraphs/${paragraphSlug}/primary`),
      };
    });

    const writingStylePath = folderPaths.find((p) =>
      p.endsWith("writing-style.md")
    );
    const draftPath = allPaths.includes(`drafts/${slug}/chapter.md`)
      ? `drafts/${slug}/chapter.md`
      : folderPaths.find((p) => p.endsWith("draft.md"));
    const imagePromptPath = `assets/chapters/${slug}/primary.md`;

    return {
      slug,
      path: folder,
      title: metaMap[`${folder}/chapter.md`]?.name ?? slugToTitle(slug),
      ghostwriter: metaMap[`${folder}/chapter.md`]?.ghostwriter,
      paragraphs,
      writingStylePath,
      draftPath,
      auditPath: auditPathSet.has(buildChapterAuditPath(slug)) ? buildChapterAuditPath(slug) : undefined,
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
    rootFiles: allPaths
      .filter((path) => !path.includes("/") && path.endsWith(".md"))
      .map((path) => ({ path, sha: treeData.tree.find((node) => node.path === path)?.sha ?? "", size: treeData.tree.find((node) => node.path === path)?.size ?? 0 })),
    firstClassFiles: allPaths
      .filter((path) => ["context.md", "ideas.md", "story-design.md", "notes.md", "promoted.md", "evaluation-guidelines.md", "state/current.md", "state/status.md", "state/script-ledger.md", "resumes/total.md", "evaluations/total.md"].includes(path))
      .map((path) => ({ path, sha: treeData.tree.find((node) => node.path === path)?.sha ?? "", size: treeData.tree.find((node) => node.path === path)?.size ?? 0 })),
    searchableFiles: allPaths
      .filter((path) => /\.(md|txt)$/i.test(path))
      .map((path) => ({ path, sha: treeData.tree.find((node) => node.path === path)?.sha ?? "", size: treeData.tree.find((node) => node.path === path)?.size ?? 0, role: path.startsWith("research/") ? "research" : path.startsWith("notes/") || path === "notes.md" ? "note" : path.startsWith("chapters/") ? "chapter or paragraph" : path.startsWith("characters/") || path.startsWith("locations/") || path.startsWith("factions/") || path.startsWith("items/") || path.startsWith("secrets/") || path.startsWith("timelines/") ? "canon" : "repository text" })),
    bookCoverPromptPath: allPaths.includes("assets/book/cover.md") ? "assets/book/cover.md" : undefined,
    bookCoverPath: firstExistingImage("assets/book/cover"),
    bookAuditPath: auditPathSet.has(buildBookAuditPath()) ? buildBookAuditPath() : undefined,
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
    operationManifestFiles: allPaths
      .filter(isRewriteOperationManifestPath)
      .map((p) => ({ path: p, sha: treeData.tree.find((node) => node.path === p)?.sha ?? "", size: treeData.tree.find((node) => node.path === p)?.size ?? 0 })),
    auditFiles,
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
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const scope = captureRepositoryOperationScope();
  const id = await settleOnAbort(localRepoId(owner, repo, ref, scope), signal);
  if (id) {
    const file = await settleOnAbort(getLocalFile(id, path, scope), signal);
    signal?.throwIfAborted();
    if (file?.kind === "text" && file.text !== undefined) return file.text;
    if (file?.kind === "binary" && file.blob) return new TextDecoder().decode(await settleOnAbort(file.blob.arrayBuffer(), signal));
  }
  const data = await fetchContentJson(token, owner, repo, path, ref, false, signal);
  signal?.throwIfAborted();
  if (data.content) {
    try { return decodeContent(data.content); } catch (error) { throw new RepositoryError(`GitHub returned malformed file content for ${path}.`, "malformed", "read", 200, { cause: error }); }
  }
  throw new RepositoryError(`${path} is not a file.`, "malformed", "read", 200);
}

function settleOnAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Read text from GitHub at an exact branch, tag, or commit without consulting IndexedDB. */
export async function loadRemoteFileContentAtRef(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  signal?: AbortSignal,
): Promise<FileContent> {
  const data = await fetchContentJson(token, owner, repo, path, ref, true, signal);
  if (data.content && data.sha) {
    try { return { content: decodeContent(data.content), sha: data.sha }; } catch (error) { throw new RepositoryError(`GitHub returned malformed file content for ${path}.`, "malformed", "read", 200, { cause: error }); }
  }
  throw new RepositoryError(`${path} is not a file at ${ref}.`, "malformed", "read", 200);
}

export async function loadBinaryFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<Uint8Array> {
  const scope = captureRepositoryOperationScope();
  const id = await localRepoId(owner, repo, ref, scope);
  if (id) {
    const file = await getLocalFile(id, path, scope);
    if (file?.kind === "binary" && file.blob) return new Uint8Array(await file.blob.arrayBuffer());
    if (file?.kind === "text" && file.text !== undefined) return new TextEncoder().encode(file.text);
  }
  let response: Response;
  try {
    response = await fetch(githubContentUrl(owner, repo, path, ref, true), { cache: "no-store", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28" } });
  } catch (error) {
    throw classifyRepositoryError(error, "read", path);
  }
  if (response.ok) {
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        const envelope = JSON.parse(new TextDecoder().decode(bytes)) as { content?: string; encoding?: string };
        if (typeof envelope.content === "string" && envelope.encoding === "base64") return decodeBytes(envelope.content);
        throw new RepositoryError(`GitHub returned JSON instead of binary content for ${path}.`, "malformed", "read", response.status);
      }
      return bytes;
    }
    catch (error) { throw classifyRepositoryError(error, "read", path); }
  }

  // Fallback to the JSON contents API for small files or older API behaviour.
  const data = await fetchContentJson(token, owner, repo, path, ref, true);
  if (data.content) {
    try { return decodeBytes(data.content); } catch (error) { throw new RepositoryError(`GitHub returned malformed binary content for ${path}.`, "malformed", "read", 200, { cause: error }); }
  }
  throw new RepositoryError(`${path} is not a file.`, "malformed", "read", 200);
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

export const isGitHubFileNotFoundError = isRepositoryNotFoundError;

function isShaUpdateError(err: unknown): boolean {
  if (err instanceof RepositoryError && err.cause) return isShaUpdateError(err.cause);
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
  signal?: AbortSignal,
): Promise<FileContent> {
  signal?.throwIfAborted();
  const scope = captureRepositoryOperationScope();
  const id = await localRepoId(owner, repo, branch, scope);
  signal?.throwIfAborted();
  if (id) {
    const file = await getLocalFile(id, path, scope);
    signal?.throwIfAborted();
    if (file?.kind === "text" && file.text !== undefined) return { content: file.text, sha: file.currentHash };
    if (file?.kind === "binary" && file.blob) return { content: new TextDecoder().decode(await file.blob.arrayBuffer()), sha: file.currentHash };
  }
  const data = await fetchContentJson(token, owner, repo, path, branch, true, signal);
  if (data.content && data.sha) {
    try { return { content: decodeContent(data.content), sha: data.sha }; } catch (error) { throw new RepositoryError(`GitHub returned malformed file content for ${path}.`, "malformed", "read", 200, { cause: error }); }
  }
  throw new RepositoryError(`${path} is not a file.`, "malformed", "read", 200);
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
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const scope = captureRepositoryOperationScope();
  const id = await localRepoId(owner, repo, branch, scope);
  if (id) {
    try {
      await mutateLocalTextFilesAtomically(id, scope, [{ path, content, expectedCurrentHash: sha }]);
      signal?.throwIfAborted();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("File changed since")) throw new RepositoryError(error.message, "conflict", "update", 409, { cause: error });
      throw classifyRepositoryError(error, "update", path);
    }
    return sha256Text(content);
  }
  const octokit = createGitHubClient(token);
  let data: Awaited<ReturnType<typeof octokit.rest.repos.createOrUpdateFileContents>>["data"];
  try {
    ({ data } = await octokit.rest.repos.createOrUpdateFileContents({ owner, repo, path, message, content: encodeContent(content), sha, branch, request: { signal } }));
  } catch (error) { throw classifyRepositoryError(error, "update", path); }
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
  const scope = captureRepositoryOperationScope();
  const id = await localRepoId(owner, repo, branch, scope);
  if (id) return (await writeLocalBinaryScoped(id, path, bytes, scope)).currentHash;
  const octokit = createGitHubClient(token);
  const existing = await optionalRepositoryRead(() => readFileWithSha(token, owner, repo, branch, path));
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
    if (!isShaUpdateError(err)) throw classifyRepositoryError(err, existing ? "update" : "create", path);
    const sha = await findFileShaFromTree(token, owner, repo, branch, path);
    if (!sha) throw classifyRepositoryError(err, existing ? "update" : "create", path);
    try { ({ data } = await octokit.rest.repos.createOrUpdateFileContents({ ...body, sha })); } catch (error) { throw classifyRepositoryError(error, "update", path); }
  }
  return data.content?.sha ?? existing?.sha ?? "";
}

export async function createOrUpdateTextAndBinaryFilesAtomically(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  text: { path: string; content: string };
  binary: { path: string; bytes: Uint8Array };
  message: string;
}): Promise<void> {
  const scope = captureRepositoryOperationScope();
  const id = await localRepoId(input.owner, input.repo, input.branch, scope);
  if (id) {
    const [textFile, binaryFile] = await Promise.all([getLocalFile(id, input.text.path, scope), getLocalFile(id, input.binary.path, scope)]);
    await applyLocalFileChangesAtomically(id, scope, [], [
      { path: input.text.path, kind: "text", text: input.text.content },
      { path: input.binary.path, kind: "binary", bytes: input.binary.bytes },
    ], new Map([
      [input.text.path, textFile?.currentHash ?? null],
      [input.binary.path, binaryFile?.currentHash ?? null],
    ]));
    return;
  }

  const octokit = createGitHubClient(input.token);
  const ref = await octokit.rest.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}` });
  const headSha = ref.data.object.sha;
  const commit = await octokit.rest.git.getCommit({ owner: input.owner, repo: input.repo, commit_sha: headSha });
  const binaryBlob = await octokit.rest.git.createBlob({ owner: input.owner, repo: input.repo, content: encodeBytes(input.binary.bytes), encoding: "base64" });
  const tree = await octokit.rest.git.createTree({
    owner: input.owner,
    repo: input.repo,
    base_tree: commit.data.tree.sha,
    tree: [
      { path: input.text.path, mode: "100644", type: "blob", content: input.text.content },
      { path: input.binary.path, mode: "100644", type: "blob", sha: binaryBlob.data.sha },
    ],
  });
  const next = await octokit.rest.git.createCommit({ owner: input.owner, repo: input.repo, message: input.message, tree: tree.data.sha, parents: [headSha] });
  await updateStructuralRef(octokit, {
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    expectedHeadSha: headSha,
    generatedCommitSha: next.data.sha,
    revisions: [
      { path: input.text.path, content: input.text.content },
      { path: input.binary.path, blobSha: binaryBlob.data.sha },
    ],
  });
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
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const scope = captureRepositoryOperationScope();
  const id = await localRepoId(owner, repo, branch, scope);
  if (id) {
    try {
      await mutateLocalTextFilesAtomically(id, scope, [{ path, content, expectedCurrentHash: null }]);
      signal?.throwIfAborted();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("File changed since")) throw new RepositoryError(`File already exists: ${path}`, "conflict", "create", 409, { cause: error });
      throw classifyRepositoryError(error, "create", path);
    }
    return sha256Text(content);
  }
  const octokit = createGitHubClient(token);
  let data: Awaited<ReturnType<typeof octokit.rest.repos.createOrUpdateFileContents>>["data"];
  try {
    ({ data } = await octokit.rest.repos.createOrUpdateFileContents({ owner, repo, path, message, content: encodeContent(content), branch, request: { signal } }));
  } catch (error) { throw classifyRepositoryError(error, "create", path); }
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
  const existing = await optionalRepositoryRead(() => readFileWithSha(token, owner, repo, branch, path));
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
  const existing = await optionalRepositoryRead(() => readFileWithSha(token, owner, repo, branch, path));
  if (existing) return false;
  await createFile(token, owner, repo, branch, path, content, message);
  return true;
}

/** Apply related text writes/deletes atomically without implicitly pushing a local working copy. */
export async function mutateTextFilesAtomically(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  mutations: LocalTextFileMutation[],
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const scope = captureRepositoryOperationScope();
  const id = await localRepoId(owner, repo, branch, scope);
  if (id) {
    await mutateLocalTextFilesAtomically(id, scope, mutations);
    signal?.throwIfAborted();
    return;
  }

  const octokit = createGitHubClient(token);
  const { data: branchData } = await octokit.rest.repos.getBranch({ owner, repo, branch, request: { signal } });
  const head = branchData.commit.sha;
  const treeSha = branchData.commit.commit.tree.sha;
  for (const mutation of mutations) {
    if (mutation.expectedCurrentHash === undefined) continue;
    const current = await optionalRepositoryRead(() => loadRemoteFileContentAtRef(token, owner, repo, mutation.path, head, signal));
    const actual = current ? await sha256Text(current.content) : null;
    if (actual !== mutation.expectedCurrentHash) throw new RepositoryError(`File changed since it was read: ${mutation.path}`, "conflict", "update", 409);
  }
  const writes = mutations.filter((mutation) => mutation.content !== undefined);
  if (!writes.length) return;
  const { data: tree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: treeSha,
    tree: writes.map((mutation) => ({ path: mutation.path, mode: "100644" as const, type: "blob" as const, ...(mutation.content === null ? { sha: null } : { content: mutation.content }) })),
    request: { signal },
  });
  const { data: commit } = await octokit.rest.git.createCommit({ owner, repo, message, tree: tree.sha, parents: [head], request: { signal } });
  await updateStructuralRef(octokit, {
    owner,
    repo,
    branch,
    expectedHeadSha: head,
    generatedCommitSha: commit.sha,
    revisions: writes.map((mutation) => ({ path: mutation.path, content: mutation.content })),
    signal,
  });
}

/** Rename a final paragraph and every artifact owned by its chapter/slug. */
export async function renameParagraphWithCompanions(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  chapterPath: string,
  oldParagraph: Paragraph,
  newParagraphPath: string,
  updatedPrimaryContent: string,
  commitMessage: string,
  options: { expectedRemoteHeadSha?: string; expectedCurrentHash?: string; signal?: AbortSignal } = {},
): Promise<{ paragraph: Paragraph; canonical: CanonicalScriptMutationResult | null }> {
  options.signal?.throwIfAborted();
  const normalizedChapterPath = chapterPath.replace(/\/+$/, "");
  const chapterMatch = /^chapters\/([^/]+)$/.exec(normalizedChapterPath);
  if (!chapterMatch) throw new Error(`Invalid chapter path: ${chapterPath}`);
  const chapterSlug = chapterMatch[1];
  const oldSlug = extractParagraphSlug(oldParagraph.path);
  const newSlug = extractParagraphSlug(newParagraphPath);
  if (!oldSlug || !newSlug || newParagraphPath !== `${normalizedChapterPath}/${newSlug}.md`) {
    throw new Error(`Invalid paragraph destination: ${newParagraphPath}`);
  }
  if (oldParagraph.path !== `${normalizedChapterPath}/${oldSlug}.md`) {
    throw new Error(`Paragraph ${oldParagraph.path} does not belong to ${normalizedChapterPath}.`);
  }
  if (oldSlug === newSlug) throw new Error(`Paragraph slug is unchanged: ${oldSlug}`);

  const exactMoves = new Map<string, string>([
    [oldParagraph.path, newParagraphPath],
    [`drafts/${chapterSlug}/${oldSlug}.md`, `drafts/${chapterSlug}/${newSlug}.md`],
    [`${normalizedChapterPath}/drafts/${oldSlug}.md`, `${normalizedChapterPath}/drafts/${newSlug}.md`],
    [`scripts/${chapterSlug}/${oldSlug}.md`, `scripts/${chapterSlug}/${newSlug}.md`],
    [`evaluations/paragraphs/${chapterSlug}/${oldSlug}.md`, `evaluations/paragraphs/${chapterSlug}/${newSlug}.md`],
    [buildParagraphAuditPath(chapterSlug, oldSlug), buildParagraphAuditPath(chapterSlug, newSlug)],
    [`evaluations/readers/summaries/paragraphs/${chapterSlug}/${oldSlug}.md`, `evaluations/readers/summaries/paragraphs/${chapterSlug}/${newSlug}.md`],
    [`evaluations/readers/summaries/selections/${chapterSlug}/${oldSlug}.md`, `evaluations/readers/summaries/selections/${chapterSlug}/${newSlug}.md`],
  ]);
  const prefixMoves: Array<[string, string]> = [
    [`assets/chapters/${chapterSlug}/paragraphs/${oldSlug}/`, `assets/chapters/${chapterSlug}/paragraphs/${newSlug}/`],
    [`evaluations/readers/paragraphs/${chapterSlug}/${oldSlug}/`, `evaluations/readers/paragraphs/${chapterSlug}/${newSlug}/`],
    [`evaluations/readers/selections/${chapterSlug}/${oldSlug}/`, `evaluations/readers/selections/${chapterSlug}/${newSlug}/`],
    [`evaluations/readers/summaries/paragraphs/${chapterSlug}/${oldSlug}/`, `evaluations/readers/summaries/paragraphs/${chapterSlug}/${newSlug}/`],
    [`evaluations/readers/summaries/selections/${chapterSlug}/${oldSlug}/`, `evaluations/readers/summaries/selections/${chapterSlug}/${newSlug}/`],
    [`operations/rewrite-from-reader-feedback/paragraphs/${chapterSlug}/${oldSlug}/`, `operations/rewrite-from-reader-feedback/paragraphs/${chapterSlug}/${newSlug}/`],
  ];

  const remapPath = (path: string): string | null => {
    const exact = exactMoves.get(path);
    if (exact) return exact;
    for (const [oldPrefix, newPrefix] of prefixMoves) {
      if (path.startsWith(oldPrefix)) return `${newPrefix}${path.slice(oldPrefix.length)}`;
    }
    const chapterOperationSnapshot = new RegExp(`^(operations/rewrite-from-reader-feedback/chapters/${chapterSlug}/[^/]+/snapshots/)${oldSlug}-(before|generated)\\.md$`).exec(path);
    if (chapterOperationSnapshot) return `${chapterOperationSnapshot[1]}${newSlug}-${chapterOperationSnapshot[2]}.md`;
    return null;
  };

  const oldRef = `paragraph:${chapterSlug}:${oldSlug}`;
  const newRef = `paragraph:${chapterSlug}:${newSlug}`;
  const rewriteRefs = (text: string): string => text.split(oldRef).join(newRef);
  const rewriteMovedText = (text: string): string => {
    let next = rewriteRefs(text);
    const pathReplacements = [...exactMoves, ...prefixMoves].sort((left, right) => right[0].length - left[0].length);
    for (const [oldValue, newValue] of pathReplacements) next = next.split(oldValue).join(newValue);
    next = next.split(`script:${chapterSlug}:${oldSlug}`).join(`script:${chapterSlug}:${newSlug}`);
    next = next.split(`selection:${chapterSlug}:${oldSlug}`).join(`selection:${chapterSlug}:${newSlug}`);
    const escapedOldSlug = oldSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return next.replace(
      new RegExp(`(^[ \\t-]*(?:paragraphId|paragraph_id):\\s*)(["']?)${escapedOldSlug}\\2(?=\\s*(?:#.*)?$)`, "gm"),
      `$1$2${newSlug}$2`,
    );
  };

  const preflight = (paths: string[]): Set<string> => {
    const existingPaths = new Set(paths);
    const sourcePaths = new Set<string>();
    const destinationSources = new Map<string, string>();
    for (const path of paths) {
      const destination = remapPath(path);
      if (!destination || destination === path) continue;
      sourcePaths.add(path);
      const duplicate = destinationSources.get(destination);
      if (duplicate && duplicate !== path) {
        throw new Error(`Paragraph rename maps both ${duplicate} and ${path} to ${destination}.`);
      }
      destinationSources.set(destination, path);
    }
    if (!sourcePaths.has(oldParagraph.path)) throw new Error(`Paragraph file not found: ${oldParagraph.path}`);
    const destinationExactPaths = new Set(exactMoves.values());
    const destinationPrefixes = prefixMoves.map((move) => move[1]);
    const unrelatedDestination = paths.find((path) =>
      !sourcePaths.has(path)
      && (destinationExactPaths.has(path) || destinationPrefixes.some((prefix) => path.startsWith(prefix))));
    if (unrelatedDestination) {
      throw new Error(`Cannot rename paragraph: destination already contains ${unrelatedDestination}.`);
    }
    for (const [destination, source] of destinationSources) {
      if (existingPaths.has(destination) && !sourcePaths.has(destination)) {
        throw new Error(`Cannot rename ${source}: destination already exists at ${destination}.`);
      }
    }
    return sourcePaths;
  };

  const updatedParagraph = (sourcePaths: Set<string>): Paragraph => {
    const movedExistingPath = (path: string | undefined): string | undefined => {
      if (!path || !sourcePaths.has(path)) return undefined;
      return remapPath(path) ?? undefined;
    };
    const firstMoved = (paths: string[]): string | undefined => {
      const source = paths.find((path) => sourcePaths.has(path));
      return source ? remapPath(source) ?? undefined : undefined;
    };
    const assetPrefix = `assets/chapters/${chapterSlug}/paragraphs/${oldSlug}/`;
    const discoveredImage = [...sourcePaths].find((path) => path.startsWith(assetPrefix) && /\/primary\.(?:png|jpe?g|webp|gif)$/i.test(path));
    const finalContent = rewriteMovedText(updatedPrimaryContent);
    return {
      ...oldParagraph,
      title: titleFromFrontmatter(finalContent, slugToTitle(newSlug)),
      path: newParagraphPath,
      draftPath: movedExistingPath(oldParagraph.draftPath) ?? firstMoved([
        `drafts/${chapterSlug}/${oldSlug}.md`,
        `${normalizedChapterPath}/drafts/${oldSlug}.md`,
      ]),
      scriptPath: movedExistingPath(oldParagraph.scriptPath) ?? firstMoved([`scripts/${chapterSlug}/${oldSlug}.md`]),
      evaluationPath: movedExistingPath(oldParagraph.evaluationPath) ?? firstMoved([`evaluations/paragraphs/${chapterSlug}/${oldSlug}.md`]),
      auditPath: movedExistingPath(oldParagraph.auditPath) ?? firstMoved([buildParagraphAuditPath(chapterSlug, oldSlug)]),
      imagePath: movedExistingPath(oldParagraph.imagePath) ?? movedExistingPath(discoveredImage),
      imagePromptPath: movedExistingPath(oldParagraph.imagePromptPath) ?? firstMoved([`${assetPrefix}primary.md`]),
    };
  };

  const scope = captureRepositoryOperationScope();
  const localId = await localRepoId(owner, repo, branch, scope);
  if (localId) {
    const localMeta = await getLocalRepository(owner, repo, branch, scope);
    if (options.expectedRemoteHeadSha && localMeta?.remoteHeadSha !== options.expectedRemoteHeadSha) throw new RepositoryError("The local repository is based on a different remote head.", "conflict", "update", 409);
    const files = await listLocalFiles(localId);
    const sourcePaths = preflight(files.map((file) => file.path));
    const primaryFile = files.find((file) => file.path === oldParagraph.path);
    if (primaryFile?.kind !== "text") {
      throw new Error(`Paragraph file is not text: ${oldParagraph.path}`);
    }
    if (options.expectedCurrentHash && primaryFile.currentHash !== options.expectedCurrentHash) throw new RepositoryError(`File changed since it was read: ${oldParagraph.path}`, "conflict", "update", 409);
    const textWrites: StructuralTextWrite[] = [];
    const binaryWrites: LocalFileAtomicWrite[] = [];
    const deletes = new Set<string>();

    // Capture every original before opening the mutation transaction.
    for (const file of files) {
      const destination = remapPath(file.path);
      const moved = destination !== null && destination !== file.path;
      if (file.kind === "text") {
        const original = file.text ?? "";
        const source = file.path === oldParagraph.path ? updatedPrimaryContent : original;
        const next = moved ? rewriteMovedText(source) : rewriteRefs(source);
        if (moved || next !== original) {
          textWrites.push({ path: destination ?? file.path, text: next });
          if (moved) deletes.add(file.path);
        }
      } else if (moved) {
        if (!file.blob) throw new Error(`Missing local binary content: ${file.path}`);
        binaryWrites.push({ path: destination, kind: "binary", bytes: new Uint8Array(await file.blob.arrayBuffer()) });
        deletes.add(file.path);
      }
    }

    const canonical = await canonicalizeStructuralTextChanges(files, deletes, textWrites);
    options.signal?.throwIfAborted();
    const plannedDeletes = canonical.mutations.filter((mutation) => mutation.content === null).map((mutation) => mutation.path);
    const plannedWrites: LocalFileAtomicWrite[] = canonical.mutations.flatMap((mutation) => typeof mutation.content === "string" ? [{ path: mutation.path, kind: "text" as const, text: mutation.content }] : []);
    const writePaths = new Set([...plannedWrites, ...binaryWrites].map((write) => write.path));
    const binarySources = [...deletes].filter((path) => files.find((file) => file.path === path)?.kind === "binary");
    const expected = new Map(canonical.mutations.flatMap((mutation) => mutation.expectedCurrentHash === undefined ? [] : [[mutation.path, mutation.expectedCurrentHash] as const]));
    for (const path of [...binarySources, ...binaryWrites.map((write) => write.path)]) expected.set(path, files.find((file) => file.path === path)?.currentHash ?? null);
    await applyLocalFileChangesAtomically(localId, scope, new Set([...plannedDeletes, ...binarySources].filter((path) => !writePaths.has(path))), [...plannedWrites, ...binaryWrites], expected);
    return { paragraph: updatedParagraph(sourcePaths), canonical: canonical.result };
  }

  const octokit = createGitHubClient(token);
  try {
  const { data: branchData } = await octokit.rest.repos.getBranch({ owner, repo, branch });
  const currentCommitSha = branchData.commit.sha;
  options.signal?.throwIfAborted();
  if (options.expectedRemoteHeadSha && currentCommitSha !== options.expectedRemoteHeadSha) throw new RepositoryError("The remote branch changed before the paragraph rename.", "conflict", "update", 409);
  const currentTreeSha = branchData.commit.commit.tree.sha;
  const { data: fullTree } = await octokit.rest.git.getTree({ owner, repo, tree_sha: currentTreeSha, recursive: "1" });
  if (fullTree.truncated) throw new RepositoryError("Repository tree is truncated; paragraph rename cannot safely continue.", "malformed", "update");

  const blobs = fullTree.tree.filter((node) => node.type === "blob" && node.path);
  const sourcePaths = preflight(blobs.map((node) => node.path!));
  const isTextPath = (path: string) => /\.(?:md|mdx|json|txt|ya?ml|toml|xml|opf|ncx|xhtml|css|html|js|jsx|ts|tsx)$/i.test(path);
  type TreeEntry = { path: string; mode: "100644"; type: "blob"; sha?: string | null; content?: string };
  const binaryTreeUpdates: TreeEntry[] = [];
  const sourceTextFiles: Array<{ path: string; kind: "text"; text: string }> = [];
  const textWrites: StructuralTextWrite[] = [];
  const textDeletes = new Set<string>();

  for (const node of blobs) {
    const path = node.path!;
    const destination = remapPath(path);
    const moved = destination !== null && destination !== path;
    if (moved) {
      if (path === oldParagraph.path) {
        const current = await loadRemoteFileContentAtRef(token, owner, repo, path, currentCommitSha, options.signal);
        const original = current.content;
        if (options.expectedCurrentHash && current.sha !== options.expectedCurrentHash) throw new RepositoryError(`File changed since it was read: ${oldParagraph.path}`, "conflict", "update", 409);
        sourceTextFiles.push({ path, kind: "text", text: original });
        textDeletes.add(path);
        textWrites.push({ path: destination, text: rewriteMovedText(updatedPrimaryContent) });
      } else if (isTextPath(path)) {
        const original = (await loadRemoteFileContentAtRef(token, owner, repo, path, currentCommitSha, options.signal)).content;
        sourceTextFiles.push({ path, kind: "text", text: original });
        textDeletes.add(path);
        textWrites.push({ path: destination, text: rewriteMovedText(original) });
      } else if (node.sha) {
        binaryTreeUpdates.push({ path, mode: "100644", type: "blob", sha: null }, { path: destination, mode: "100644", type: "blob", sha: node.sha });
      }
    } else if (isTextPath(path)) {
      const original = (await loadRemoteFileContentAtRef(token, owner, repo, path, currentCommitSha, options.signal)).content;
      sourceTextFiles.push({ path, kind: "text", text: original });
      const next = rewriteRefs(original);
      if (next !== original) textWrites.push({ path, text: next });
    }
  }

  const canonical = await canonicalizeStructuralTextChanges(sourceTextFiles, textDeletes, textWrites);
  options.signal?.throwIfAborted();
  const treeUpdates: TreeEntry[] = [
    ...binaryTreeUpdates,
    ...canonical.mutations.map((mutation) => ({ path: mutation.path, mode: "100644" as const, type: "blob" as const, ...(mutation.content === null ? { sha: null } : { content: mutation.content }) })),
  ];

  const { data: newTree } = await octokit.rest.git.createTree({ owner, repo, base_tree: currentTreeSha, tree: treeUpdates });
  const { data: newCommit } = await octokit.rest.git.createCommit({ owner, repo, message: commitMessage, tree: newTree.sha, parents: [currentCommitSha] });
  await updateStructuralRef(octokit, { owner, repo, branch, expectedHeadSha: currentCommitSha, generatedCommitSha: newCommit.sha, revisions: treeUpdates.map((entry) => ({ path: entry.path, ...(entry.content !== undefined ? { content: entry.content } : { blobSha: entry.sha }) })), signal: options.signal });
  return { paragraph: updatedParagraph(sourcePaths), canonical: canonical.result };
  } catch (error) { throw classifyRepositoryError(error, "update", oldParagraph.path); }
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
  options: { expectedRemoteHeadSha?: string; expectedParagraphHashes?: Readonly<Record<string, string>>; signal?: AbortSignal } = {},
): Promise<{ paragraphs: Paragraph[]; canonical: CanonicalScriptMutationResult | null }> {
  options.signal?.throwIfAborted();
  const chapterSlug = chapterPath.replace(/^chapters\//, "");
  const escapedChapter = chapterSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Build the slug remap and per-slug new number.
  const remapBySlug = new Map<string, string>(); // oldSlug -> newSlug (only when changed)
  const newNumberByNewSlug = new Map<string, number>();
  const result: Paragraph[] = [];

  newOrderedParagraphs.forEach((p, index) => {
    const newNumber = index + 1;
    const oldSlug = extractParagraphSlug(p.path);
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
      draftPath: rename(p.draftPath, (s) => p.draftPath?.startsWith(`drafts/${chapterSlug}/`)
        ? `drafts/${chapterSlug}/${s}.md`
        : `${chapterPath}/drafts/${s}.md`),
      scriptPath: rename(p.scriptPath, (s) => `scripts/${chapterSlug}/${s}.md`),
      evaluationPath: rename(p.evaluationPath, (s) => `evaluations/paragraphs/${chapterSlug}/${s}.md`),
      auditPath: rename(p.auditPath, (s) => buildParagraphAuditPath(chapterSlug, s)),
      imagePath: p.imagePath ? p.imagePath.replace(`/paragraphs/${extractParagraphSlug(p.path)}/`, `/paragraphs/${newSlug}/`) : undefined,
      imagePromptPath: p.imagePromptPath ? p.imagePromptPath.replace(`/paragraphs/${extractParagraphSlug(p.path)}/`, `/paragraphs/${newSlug}/`) : undefined,
    });
  });

  const newSlugs = new Set(newOrderedParagraphs.map((p) => extractParagraphSlug(p.path)));
  const deleteSlugs = new Set(oldParagraphs.map((p) => extractParagraphSlug(p.path)).filter((slug) => !newSlugs.has(slug)));

  if (remapBySlug.size === 0 && deleteSlugs.size === 0) return { paragraphs: result, canonical: null };

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
    m = new RegExp(`^audit/chapters/${escapedChapter}/paragraphs/(\\d{3}(?:-[^/]+)?)\\.md$`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^assets/chapters/${escapedChapter}/paragraphs/([^/]+)/`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^evaluations/readers/(?:paragraphs|selections)/${escapedChapter}/([^/]+)/`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^evaluations/readers/summaries/(?:paragraphs|selections)/${escapedChapter}/([^/]+)/`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^evaluations/readers/summaries/(?:paragraphs|selections)/${escapedChapter}/([^/]+)\\.md$`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^operations/rewrite-from-reader-feedback/paragraphs/${escapedChapter}/([^/]+)/`).exec(path);
    if (m) return m[1];
    m = new RegExp(`^operations/rewrite-from-reader-feedback/chapters/${escapedChapter}/[^/]+/snapshots/([^/]+)-(?:before|generated)\\.md$`).exec(path);
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
    if (path.startsWith(`audit/chapters/${chapterSlug}/paragraphs/`)) return buildParagraphAuditPath(chapterSlug, newSlug);
    const readerMatch = new RegExp(`^(evaluations/readers/(?:paragraphs|selections)/${escapedChapter}/)[^/]+(/.*)$`).exec(path);
    if (readerMatch) return `${readerMatch[1]}${newSlug}${readerMatch[2]}`;
    const readerSummaryMatch = new RegExp(`^(evaluations/readers/summaries/(?:paragraphs|selections)/${escapedChapter}/)[^/]+(/.*)$`).exec(path);
    if (readerSummaryMatch) return `${readerSummaryMatch[1]}${newSlug}${readerSummaryMatch[2]}`;
    const exactReaderSummaryMatch = new RegExp(`^(evaluations/readers/summaries/(?:paragraphs|selections)/${escapedChapter}/)[^/]+(\\.md)$`).exec(path);
    if (exactReaderSummaryMatch) return `${exactReaderSummaryMatch[1]}${newSlug}${exactReaderSummaryMatch[2]}`;
    const paragraphOperationMatch = new RegExp(`^(operations/rewrite-from-reader-feedback/paragraphs/${escapedChapter}/)[^/]+(/.*)$`).exec(path);
    if (paragraphOperationMatch) return `${paragraphOperationMatch[1]}${newSlug}${paragraphOperationMatch[2]}`;
    const chapterOperationSnapshot = new RegExp(`^(operations/rewrite-from-reader-feedback/chapters/${escapedChapter}/[^/]+/snapshots/)[^/]+(-(before|generated)\\.md)$`).exec(path);
    if (chapterOperationSnapshot) return `${chapterOperationSnapshot[1]}${newSlug}${chapterOperationSnapshot[2]}`;
    const assetMatch = new RegExp(`^(assets/chapters/${escapedChapter}/paragraphs/)[^/]+(/.*)$`).exec(path);
    if (assetMatch) return `${assetMatch[1]}${newSlug}${assetMatch[2]}`;
    return null;
  };

  const isDeletedPath = (path: string): boolean => {
    const slug = slugOfPath(path);
    return slug !== null && deleteSlugs.has(slug);
  };

  const rewriteRefs = (text: string): string => {
    const replacements: Array<[string, string]> = [];
    for (const [oldSlug, newSlug] of remapBySlug) {
      replacements.push(
        [`paragraph:${chapterSlug}:${oldSlug}`, `paragraph:${chapterSlug}:${newSlug}`],
        [`chapters/${chapterSlug}/${oldSlug}.md`, `chapters/${chapterSlug}/${newSlug}.md`],
        [`drafts/${chapterSlug}/${oldSlug}.md`, `drafts/${chapterSlug}/${newSlug}.md`],
        [`chapters/${chapterSlug}/drafts/${oldSlug}.md`, `chapters/${chapterSlug}/drafts/${newSlug}.md`],
        [`scripts/${chapterSlug}/${oldSlug}.md`, `scripts/${chapterSlug}/${newSlug}.md`],
        [`evaluations/paragraphs/${chapterSlug}/${oldSlug}.md`, `evaluations/paragraphs/${chapterSlug}/${newSlug}.md`],
        [`evaluations/readers/summaries/paragraphs/${chapterSlug}/${oldSlug}.md`, `evaluations/readers/summaries/paragraphs/${chapterSlug}/${newSlug}.md`],
        [`evaluations/readers/summaries/selections/${chapterSlug}/${oldSlug}.md`, `evaluations/readers/summaries/selections/${chapterSlug}/${newSlug}.md`],
        [`operations/rewrite-from-reader-feedback/paragraphs/${chapterSlug}/${oldSlug}/`, `operations/rewrite-from-reader-feedback/paragraphs/${chapterSlug}/${newSlug}/`],
        [buildParagraphAuditPath(chapterSlug, oldSlug), buildParagraphAuditPath(chapterSlug, newSlug)],
        [`/${chapterSlug}/${oldSlug}/`, `/${chapterSlug}/${newSlug}/`],
        [`/paragraphs/${oldSlug}/`, `/paragraphs/${newSlug}/`],
      );
    }
    let out = text;
    const placeholders = replacements.map((_, index) => `__NARRARIUM_PARAGRAPH_REMAP_${index}_${crypto.randomUUID()}__`);
    replacements.forEach(([oldValue], index) => { out = out.split(oldValue).join(placeholders[index]); });
    replacements.forEach(([, newValue], index) => { out = out.split(placeholders[index]).join(newValue); });
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
  const scope = captureRepositoryOperationScope();
  const id = await localRepoId(owner, repo, branch, scope);
  if (id) {
    const localMeta = await getLocalRepository(owner, repo, branch, scope);
    if (options.expectedRemoteHeadSha && localMeta?.remoteHeadSha !== options.expectedRemoteHeadSha) throw new RepositoryError("The local repository is based on a different remote head.", "conflict", "update", 409);
    const files = await listLocalFiles(id);
    for (const [path, expected] of Object.entries(options.expectedParagraphHashes ?? {})) {
      const current = files.find((file) => file.path === path);
      if (!current || current.currentHash !== expected) throw new RepositoryError(`File changed since it was read: ${path}`, "conflict", "update", 409);
    }
    if (options.expectedRemoteHeadSha) {
      const remote = createGitHubClient(token);
      const ref = await remote.rest.git.getRef({ owner, repo, ref: `heads/${branch}`, request: { signal: options.signal } });
      if (ref.data.object.sha !== options.expectedRemoteHeadSha) throw new RepositoryError("The remote branch changed before the paragraph operation.", "conflict", "update", 409);
    }
    const textWrites: StructuralTextWrite[] = [];
    const binaryWrites: LocalFileAtomicWrite[] = [];
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
        binaryWrites.push({ path: finalPath, kind: "binary", bytes: new Uint8Array(await file.blob.arrayBuffer()) });
        toDelete.add(file.path);
      }
    }

    const canonical = await canonicalizeStructuralTextChanges(files, toDelete, textWrites);
    options.signal?.throwIfAborted();
    const plannedWrites: LocalFileAtomicWrite[] = canonical.mutations.flatMap((mutation) => typeof mutation.content === "string" ? [{ path: mutation.path, kind: "text" as const, text: mutation.content }] : []);
    const writePaths = new Set([...plannedWrites, ...binaryWrites].map((write) => write.path));
    const plannedDeletes = canonical.mutations.filter((mutation) => mutation.content === null).map((mutation) => mutation.path);
    const binarySources = [...toDelete].filter((path) => files.find((file) => file.path === path)?.kind === "binary");
    const expected = new Map(canonical.mutations.flatMap((mutation) => mutation.expectedCurrentHash === undefined ? [] : [[mutation.path, mutation.expectedCurrentHash] as const]));
    for (const path of [...binarySources, ...binaryWrites.map((write) => write.path)]) expected.set(path, files.find((file) => file.path === path)?.currentHash ?? null);
    await applyLocalFileChangesAtomically(id, scope, new Set([...plannedDeletes, ...binarySources].filter((path) => !writePaths.has(path))), [...plannedWrites, ...binaryWrites], expected);
    return { paragraphs: result, canonical: canonical.result };
  }

  // ── Remote: single atomic commit via the Git Trees API ──────────────────────
  const octokit = createGitHubClient(token);
  try {
  const { data: branchData } = await octokit.rest.repos.getBranch({ owner, repo, branch });
  const currentCommitSha = branchData.commit.sha;
  options.signal?.throwIfAborted();
  if (options.expectedRemoteHeadSha && currentCommitSha !== options.expectedRemoteHeadSha) throw new RepositoryError("The remote branch changed before the paragraph reorder.", "conflict", "update", 409);
  const currentTreeSha = branchData.commit.commit.tree.sha;

  const { data: fullTree } = await octokit.rest.git.getTree({ owner, repo, tree_sha: currentTreeSha, recursive: "1" });
  if (fullTree.truncated) throw new RepositoryError("Repository tree is truncated; paragraph reorder cannot safely continue.", "malformed", "update");

  type TreeEntry = { path: string; mode: "100644"; type: "blob"; sha?: string | null; content?: string };
  const binaryTreeUpdates: TreeEntry[] = [];
  const sourceTextFiles: Array<{ path: string; kind: "text"; text: string }> = [];
  const textWrites: StructuralTextWrite[] = [];
  const textDeletes = new Set<string>();
  const isTextPath = (path: string) => /\.(md|json|txt|ya?ml)$/i.test(path);

  for (const node of fullTree.tree) {
    if (node.type !== "blob" || !node.path) continue;
    const path = node.path;

    if (isDeletedPath(path)) {
      if (isTextPath(path)) {
        const current = await loadRemoteFileContentAtRef(token, owner, repo, path, currentCommitSha, options.signal);
        const expected = options.expectedParagraphHashes?.[path];
        if (expected && current.sha !== expected) throw new RepositoryError(`File changed since it was read: ${path}`, "conflict", "update", 409);
        const raw = current.content;
        sourceTextFiles.push({ path, kind: "text", text: raw });
        textDeletes.add(path);
      } else binaryTreeUpdates.push({ path, mode: "100644", type: "blob", sha: null });
      continue;
    }

    const newPath = remapPath(path);
    const moved = newPath !== null && newPath !== path;
    const finalPath = newPath ?? path;

    if (moved) {
      if (isTextPath(path)) {
        const raw = (await loadRemoteFileContentAtRef(token, owner, repo, path, currentCommitSha, options.signal)).content;
        sourceTextFiles.push({ path, kind: "text", text: raw });
        textDeletes.add(path);
        textWrites.push({ path: finalPath, text: fixNumber(finalPath, rewriteRefs(raw)) });
      } else if (node.sha) {
        binaryTreeUpdates.push({ path, mode: "100644", type: "blob", sha: null }, { path: finalPath, mode: "100644", type: "blob", sha: node.sha });
      }
    } else if (isTextPath(path)) {
      const raw = (await loadRemoteFileContentAtRef(token, owner, repo, path, currentCommitSha, options.signal)).content;
      sourceTextFiles.push({ path, kind: "text", text: raw });
      const next = rewriteRefs(raw);
      if (next !== raw) textWrites.push({ path, text: next });
    }
  }

  const canonical = await canonicalizeStructuralTextChanges(sourceTextFiles, textDeletes, textWrites);
  options.signal?.throwIfAborted();
  const treeUpdates: TreeEntry[] = [
    ...binaryTreeUpdates,
    ...canonical.mutations.map((mutation) => ({ path: mutation.path, mode: "100644" as const, type: "blob" as const, ...(mutation.content === null ? { sha: null } : { content: mutation.content }) })),
  ];

  if (treeUpdates.length === 0) return { paragraphs: result, canonical: canonical.result };

  const { data: newTree } = await octokit.rest.git.createTree({ owner, repo, base_tree: currentTreeSha, tree: treeUpdates });
  const { data: newCommit } = await octokit.rest.git.createCommit({ owner, repo, message: commitMessage, tree: newTree.sha, parents: [currentCommitSha] });
  await updateStructuralRef(octokit, { owner, repo, branch, expectedHeadSha: currentCommitSha, generatedCommitSha: newCommit.sha, revisions: treeUpdates.map((entry) => ({ path: entry.path, ...(entry.content !== undefined ? { content: entry.content } : { blobSha: entry.sha }) })), signal: options.signal });

  return { paragraphs: result, canonical: canonical.result };
  } catch (error) { throw classifyRepositoryError(error, "update", chapterPath); }
}

// ─── Chapter reordering ───────────────────────────────────────────────────────

export interface ChapterReorderEntry {
  /** Chapter folder slug, e.g. "001-una-stella-e-nata". */
  slug: string;
}

/**
 * Reorder chapters by renumbering their folder slug prefix (001-, 002-, …).
 * Moves every file that lives under a renamed chapter across the six chapter-scoped
 * path prefixes (chapters/, scripts/, assets/chapters/, evaluations/paragraphs/, audit/chapters/,
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
  options: { expectedRemoteHeadSha?: string; signal?: AbortSignal } = {},
): Promise<{ remap: Map<string, string>; canonical: CanonicalScriptMutationResult | null }> {
  options.signal?.throwIfAborted();
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

  if (remap.size === 0) return { remap, canonical: null };

  // Map a repo path to its new path if it belongs to a remapped chapter.
  const remapPath = (path: string): string | null => {
    for (const [oldSlug, newSlug] of remap) {
      const prefixes = [
        `chapters/${oldSlug}/`,
        `drafts/${oldSlug}/`,
        `scripts/${oldSlug}/`,
        `assets/chapters/${oldSlug}/`,
        `evaluations/paragraphs/${oldSlug}/`,
        `audit/chapters/${oldSlug}/`,
        `evaluations/readers/chapters/${oldSlug}/`,
        `evaluations/readers/paragraphs/${oldSlug}/`,
        `evaluations/readers/selections/${oldSlug}/`,
        `evaluations/readers/summaries/chapters/${oldSlug}/`,
        `evaluations/readers/summaries/paragraphs/${oldSlug}/`,
        `evaluations/readers/summaries/selections/${oldSlug}/`,
        `operations/rewrite-from-reader-feedback/chapters/${oldSlug}/`,
        `operations/rewrite-from-reader-feedback/paragraphs/${oldSlug}/`,
      ];
      for (const prefix of prefixes) {
        if (path.startsWith(prefix)) {
          return newSlug ? `${prefix.slice(0, prefix.length - oldSlug.length - 1)}${newSlug}/${path.slice(prefix.length)}` : path;
        }
      }
      if (path === `resumes/chapters/${oldSlug}.md`) return `resumes/chapters/${newSlug}.md`;
      if (path === `evaluations/chapters/${oldSlug}.md`) return `evaluations/chapters/${newSlug}.md`;
      if (path === `state/chapters/${oldSlug}.md`) return `state/chapters/${newSlug}.md`;
      if (path === `evaluations/readers/summaries/chapters/${oldSlug}.md`) return `evaluations/readers/summaries/chapters/${newSlug}.md`;
    }
    return null;
  };

  // Rewrite slug references inside file content.
  const rewriteRefs = (text: string): string => {
    const replacements: Array<[string, string]> = [];
    for (const [oldSlug, newSlug] of remap) {
      replacements.push(
        [`chapter:${oldSlug}`, `chapter:${newSlug}`],
        [`paragraph:${oldSlug}:`, `paragraph:${newSlug}:`],
        [`chapters/${oldSlug}/`, `chapters/${newSlug}/`],
        [`drafts/${oldSlug}/`, `drafts/${newSlug}/`],
        [`scripts/${oldSlug}/`, `scripts/${newSlug}/`],
        [`assets/chapters/${oldSlug}/`, `assets/chapters/${newSlug}/`],
        [`evaluations/paragraphs/${oldSlug}/`, `evaluations/paragraphs/${newSlug}/`],
        [`audit/chapters/${oldSlug}/`, `audit/chapters/${newSlug}/`],
        [`resumes/chapters/${oldSlug}.md`, `resumes/chapters/${newSlug}.md`],
        [`evaluations/chapters/${oldSlug}.md`, `evaluations/chapters/${newSlug}.md`],
        [`state/chapters/${oldSlug}.md`, `state/chapters/${newSlug}.md`],
        [`evaluations/readers/summaries/chapters/${oldSlug}.md`, `evaluations/readers/summaries/chapters/${newSlug}.md`],
        [`evaluations/readers/summaries/paragraphs/${oldSlug}/`, `evaluations/readers/summaries/paragraphs/${newSlug}/`],
        [`evaluations/readers/summaries/selections/${oldSlug}/`, `evaluations/readers/summaries/selections/${newSlug}/`],
        [`operations/rewrite-from-reader-feedback/chapters/${oldSlug}/`, `operations/rewrite-from-reader-feedback/chapters/${newSlug}/`],
        [`operations/rewrite-from-reader-feedback/paragraphs/${oldSlug}/`, `operations/rewrite-from-reader-feedback/paragraphs/${newSlug}/`],
      );
    }
    let out = text;
    const placeholders = replacements.map((_, index) => `__NARRARIUM_CHAPTER_REMAP_${index}_${crypto.randomUUID()}__`);
    replacements.forEach(([oldValue], index) => { out = out.split(oldValue).join(placeholders[index]); });
    replacements.forEach(([, newValue], index) => { out = out.split(placeholders[index]).join(newValue); });
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
  const scope = captureRepositoryOperationScope();
  const id = await localRepoId(owner, repo, branch, scope);
  if (id) {
    const localMeta = await getLocalRepository(owner, repo, branch, scope);
    if (options.expectedRemoteHeadSha && localMeta?.remoteHeadSha !== options.expectedRemoteHeadSha) throw new RepositoryError("The local repository is based on a different remote head.", "conflict", "update", 409);
    const files = await listLocalFiles(id);
    const textWrites: StructuralTextWrite[] = [];
    const binaryWrites: LocalFileAtomicWrite[] = [];
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
        binaryWrites.push({ path: finalPath, kind: "binary", bytes: new Uint8Array(await file.blob.arrayBuffer()) });
        toDelete.add(file.path);
      }
    }

    const canonical = await canonicalizeStructuralTextChanges(files, toDelete, textWrites);
    options.signal?.throwIfAborted();
    const plannedWrites: LocalFileAtomicWrite[] = canonical.mutations.flatMap((mutation) => typeof mutation.content === "string" ? [{ path: mutation.path, kind: "text" as const, text: mutation.content }] : []);
    const writePaths = new Set([...plannedWrites, ...binaryWrites].map((write) => write.path));
    const plannedDeletes = canonical.mutations.filter((mutation) => mutation.content === null).map((mutation) => mutation.path);
    const binarySources = [...toDelete].filter((path) => files.find((file) => file.path === path)?.kind === "binary");
    const expected = new Map(canonical.mutations.flatMap((mutation) => mutation.expectedCurrentHash === undefined ? [] : [[mutation.path, mutation.expectedCurrentHash] as const]));
    for (const path of [...binarySources, ...binaryWrites.map((write) => write.path)]) expected.set(path, files.find((file) => file.path === path)?.currentHash ?? null);
    await applyLocalFileChangesAtomically(id, scope, new Set([...plannedDeletes, ...binarySources].filter((path) => !writePaths.has(path))), [...plannedWrites, ...binaryWrites], expected);
    return { remap, canonical: canonical.result };
  }

  // ── Remote: single atomic commit via the Git Trees API ──────────────────────
  const octokit = createGitHubClient(token);
  try {
  const { data: branchData } = await octokit.rest.repos.getBranch({ owner, repo, branch });
  const currentCommitSha = branchData.commit.sha;
  options.signal?.throwIfAborted();
  if (options.expectedRemoteHeadSha && currentCommitSha !== options.expectedRemoteHeadSha) throw new RepositoryError("The remote branch changed before the chapter reorder.", "conflict", "update", 409);
  const currentTreeSha = branchData.commit.commit.tree.sha;

  const { data: fullTree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: currentTreeSha,
    recursive: "1",
  });
  if (fullTree.truncated) throw new RepositoryError("Repository tree is truncated; chapter reorder cannot safely continue.", "malformed", "update");

  type TreeEntry = { path: string; mode: "100644"; type: "blob"; sha?: string | null; content?: string };
  const binaryTreeUpdates: TreeEntry[] = [];
  const sourceTextFiles: Array<{ path: string; kind: "text"; text: string }> = [];
  const textWrites: StructuralTextWrite[] = [];
  const textDeletes = new Set<string>();

  const blobs = fullTree.tree.filter((node) => node.type === "blob" && node.path);
  const isTextPath = (path: string) => /\.(md|json|txt|ya?ml|opf|ncx|xhtml|css|html)$/i.test(path);

  for (const node of blobs) {
    const path = node.path!;
    const newPath = remapPath(path);
    const moved = newPath !== null && newPath !== path;
    const finalPath = newPath ?? path;
    const affectsRefs = isTextPath(path);

    if (moved) {
      if (affectsRefs) {
        const raw = (await loadRemoteFileContentAtRef(token, owner, repo, path, currentCommitSha, options.signal)).content;
        sourceTextFiles.push({ path, kind: "text", text: raw });
        textDeletes.add(path);
        textWrites.push({ path: finalPath, text: fixChapterNumber(finalPath, rewriteRefs(raw)) });
      } else if (node.sha) {
        binaryTreeUpdates.push({ path, mode: "100644", type: "blob", sha: null }, { path: finalPath, mode: "100644", type: "blob", sha: node.sha });
      }
    } else if (affectsRefs) {
      const raw = (await loadRemoteFileContentAtRef(token, owner, repo, path, currentCommitSha, options.signal)).content;
      sourceTextFiles.push({ path, kind: "text", text: raw });
      const next = rewriteRefs(raw);
      if (next !== raw) textWrites.push({ path, text: next });
    }
  }

  const canonical = await canonicalizeStructuralTextChanges(sourceTextFiles, textDeletes, textWrites);
  options.signal?.throwIfAborted();
  const treeUpdates: TreeEntry[] = [
    ...binaryTreeUpdates,
    ...canonical.mutations.map((mutation) => ({ path: mutation.path, mode: "100644" as const, type: "blob" as const, ...(mutation.content === null ? { sha: null } : { content: mutation.content }) })),
  ];

  if (treeUpdates.length === 0) return { remap, canonical: canonical.result };

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
  await updateStructuralRef(octokit, { owner, repo, branch, expectedHeadSha: currentCommitSha, generatedCommitSha: newCommit.sha, revisions: treeUpdates.map((entry) => ({ path: entry.path, ...(entry.content !== undefined ? { content: entry.content } : { blobSha: entry.sha }) })), signal: options.signal });

  return { remap, canonical: canonical.result };
  } catch (error) { throw classifyRepositoryError(error, "update"); }
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
  expectedCurrentHash?: string,
): Promise<{ sha: string }> {
  const scope = captureRepositoryOperationScope();
  const id = await localRepoId(owner, repo, branch, scope);
  if (id) {
    const current = await getLocalFile(id, oldPath, scope);
    const expected = expectedCurrentHash ?? current?.currentHash;
    if (!expected) throw new RepositoryError(`File not found: ${oldPath}`, "not-found", "update", 404);
    const file = await renameLocalTextFileAtomically({ repoId: id, scope, oldPath, newPath, content, expectedCurrentHash: expected });
    return { sha: file.currentHash };
  }
  const octokit = createGitHubClient(token);
  try {
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
  } catch (error) { throw classifyRepositoryError(error, "update", oldPath); }
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
  signal?: AbortSignal,
): Promise<BranchDiffFile[]> {
  const octokit = createGitHubClient(token);
  try {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${head}`,
    request: { signal },
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
  } catch (error) { throw classifyRepositoryError(error, "compare"); }
}

export async function deleteFile(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  sha: string,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const scope = captureRepositoryOperationScope();
  const id = await localRepoId(owner, repo, branch, scope);
  if (id) {
    await deleteLocalFileAtomically(id, scope, path, sha);
    signal?.throwIfAborted();
    return;
  }
  const octokit = createGitHubClient(token);
  try {
    await octokit.rest.repos.deleteFile({ owner, repo, path, message, sha, branch, request: { signal } });
  } catch (error) { throw classifyRepositoryError(error, "delete", path); }
}

export async function revertFileToRef(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  baseRef: string,
): Promise<void> {
  const current = await optionalRepositoryRead(() => readFileWithSha(token, owner, repo, branch, path));
  const base = await optionalRepositoryRead(() => readFileWithSha(token, owner, repo, baseRef, path));

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

  throw new RepositoryError(`No file content found for ${path} on ${branch} or ${baseRef}.`, "not-found", "revert", 404);
}

export interface BranchSummary {
  name: string;
  protected: boolean;
}

export async function listBranches(
  token: string,
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<BranchSummary[]> {
  const octokit = createGitHubClient(token);
  let branches: Array<{ name: string; protected: boolean }>;
  try { branches = await octokit.paginate(octokit.rest.repos.listBranches, { owner, repo, per_page: 100, request: { signal } }); }
  catch (error) { throw classifyRepositoryError(error, "list"); }
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
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const octokit = createGitHubClient(token);
  const { data: base } = await octokit.rest.repos.getBranch({ owner, repo, branch: baseBranch, request: { signal } });
  signal?.throwIfAborted();
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${newBranch}`,
    sha: base.commit.sha,
    request: { signal },
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
  body?: string;
}

export async function listOpenPullRequests(
  token: string,
  owner: string,
  repo: string,
  head?: string,
  signal?: AbortSignal,
): Promise<PullRequestSummary[]> {
  const octokit = createGitHubClient(token);
  const pulls = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    head: head ? `${owner}:${head}` : undefined,
    per_page: 100,
    request: { signal },
  });
  return pulls.map((pull) => ({
    number: pull.number,
    title: pull.title,
    state: pull.state,
    htmlUrl: pull.html_url,
    head: pull.head.ref,
    base: pull.base.ref,
    body: pull.body ?? undefined,
  }));
}

export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  input: { title: string; body?: string; head: string; base: string },
  signal?: AbortSignal,
): Promise<PullRequestSummary> {
  const octokit = createGitHubClient(token);
  const { data } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
    request: { signal },
  });
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    htmlUrl: data.html_url,
    head: data.head.ref,
    base: data.base.ref,
    body: data.body ?? undefined,
  };
}

export async function getDefaultBranch(
  token: string,
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<string> {
  const octokit = createGitHubClient(token);
  const { data } = await octokit.rest.repos.get({ owner, repo, request: { signal } });
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
  signal?: AbortSignal,
): Promise<BranchCommitSummary[]> {
  const octokit = createGitHubClient(token);
  const commits = await octokit.paginate(octokit.rest.repos.listCommits, {
    owner,
    repo,
    sha: branch,
    per_page: 30,
    request: { signal },
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
