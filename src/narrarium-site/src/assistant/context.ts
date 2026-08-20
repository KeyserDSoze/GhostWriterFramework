import type { BookStructure, Chapter, Paragraph } from "@/types/book";
import type { AppSettings, BookEntry } from "@/types/settings";
import { loadFileContent } from "@/github/githubClient";
import { resolveBookToken } from "@/types/settings";
import { resolveAuthoritativeBranch } from "@/github/branchRules";
import { isRepositoryNotFoundError } from "@/repository/repositoryError";
import { canDiscloseSecretBody, isSecretPath, secretAccessMapForRoute, visibleSecretManifestEntries, type SecretAccess } from "@/assistant/secretPolicy";

export type AppRouteContext =
  | { kind: "app-home" }
  | { kind: "book"; bookId: string }
  | { kind: "book-dashboard"; bookId: string }
  | { kind: "book-assets"; bookId: string }
  | { kind: "book-ghostwriters"; bookId: string }
  | { kind: "book-evaluation-style"; bookId: string }
  | { kind: "book-simulated-readers"; bookId: string }
  | { kind: "reader"; bookId: string }
  | { kind: "book-export"; bookId: string }
  | { kind: "book-settings"; bookId: string }
  | { kind: "book-audit"; bookId: string }
  | { kind: "research"; bookId: string }
  | { kind: "research-detail"; bookId: string; researchSlug: string }
  | { kind: "canon"; bookId: string; section: string; slug: string }
  | { kind: "chapter"; bookId: string; chapterId: string }
  | { kind: "chapter-workspace"; bookId: string; chapterId: string; workspaceKind: string }
  | { kind: "paragraph"; bookId: string; chapterId: string; paragraphNum: string }
  | { kind: "paragraph-workspace"; bookId: string; chapterId: string; paragraphNum: string; workspaceKind: string }
  | { kind: "chapter-reader-evaluations"; bookId: string; chapterId: string }
  | { kind: "paragraph-reader-evaluations"; bookId: string; chapterId: string; paragraphNum: string }
  | { kind: "chapter-audit"; bookId: string; chapterId: string }
  | { kind: "paragraph-audit"; bookId: string; chapterId: string; paragraphNum: string }
  | { kind: "app-page"; page: string }
  | { kind: "other"; pathname: string };

export interface AvailableFile {
  path: string;
  role: string;
  exists: boolean;
  secretAccess?: Exclude<SecretAccess, "hidden">;
}

export interface LoadedWriterContext {
  route: AppRouteContext;
  book: BookEntry | null;
  structure: BookStructure | null;
  chapter: Chapter | null;
  paragraph: Paragraph | null;
  title: string;
  summary: string;
  availableFiles: AvailableFile[];
  relevantFiles: Array<{ path: string; content: string }>;
  loadedFilePaths: string[];
  noteTargetPath: string | null;
  branch?: string;
  branchReady: boolean;
}

export function parseAppRoute(pathname: string): AppRouteContext {
  const clean = pathname.replace(/\/+$/, "") || "/";
  if (clean === "/app" || clean === "/app/books") return { kind: "app-home" };
  if (clean === "/app/books/add") return { kind: "app-page", page: "books/add" };
  const appPage = /^\/app\/(chats|patch-notes|settings(?:\/[^/]+)?|reader-settings|custom-actions|migrate|costs|docs(?:\/.*)?)$/.exec(clean);
  if (appPage) return { kind: "app-page", page: decodeURIComponent(appPage[1]) };

  let match = /^\/app\/books\/([^/]+)\/reader$/.exec(clean);
  if (match) return { kind: "reader", bookId: decodeURIComponent(match[1]) };

  match = /^\/app\/books\/([^/]+)\/export$/.exec(clean);
  if (match) return { kind: "book-export", bookId: decodeURIComponent(match[1]) };

  match = /^\/app\/books\/([^/]+)\/dashboard$/.exec(clean);
  if (match) return { kind: "book-dashboard", bookId: decodeURIComponent(match[1]) };

  match = /^\/app\/books\/([^/]+)\/assets$/.exec(clean);
  if (match) return { kind: "book-assets", bookId: decodeURIComponent(match[1]) };

  match = /^\/app\/books\/([^/]+)\/ghostwriters$/.exec(clean);
  if (match) return { kind: "book-ghostwriters", bookId: decodeURIComponent(match[1]) };

  match = /^\/app\/books\/([^/]+)\/evaluation-style$/.exec(clean);
  if (match) return { kind: "book-evaluation-style", bookId: decodeURIComponent(match[1]) };

  match = /^\/app\/books\/([^/]+)\/simulated-readers$/.exec(clean);
  if (match) return { kind: "book-simulated-readers", bookId: decodeURIComponent(match[1]) };

  match = /^\/app\/books\/([^/]+)\/research\/([^/]+)$/.exec(clean);
  if (match) return { kind: "research-detail", bookId: decodeURIComponent(match[1]), researchSlug: decodeURIComponent(match[2]) };

  match = /^\/app\/books\/([^/]+)\/research$/.exec(clean);
  if (match) return { kind: "research", bookId: decodeURIComponent(match[1]) };

  match = /^\/app\/books\/([^/]+)\/settings$/.exec(clean);
  if (match) return { kind: "book-settings", bookId: decodeURIComponent(match[1]) };

  match = /^\/app\/books\/([^/]+)\/audit$/.exec(clean);
  if (match) return { kind: "book-audit", bookId: decodeURIComponent(match[1]) };

  match = /^\/app\/books\/([^/]+)\/canon\/([^/]+)\/([^/]+)$/.exec(clean);
  if (match) {
    return {
      kind: "canon",
      bookId: decodeURIComponent(match[1]),
      section: decodeURIComponent(match[2]),
      slug: decodeURIComponent(match[3]),
    };
  }

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)\/paragraphs\/([^/]+)\/workspace\/([^/]+)$/.exec(clean);
  if (match) {
    return {
      kind: "paragraph-workspace",
      bookId: decodeURIComponent(match[1]),
      chapterId: decodeURIComponent(match[2]),
      paragraphNum: decodeURIComponent(match[3]),
      workspaceKind: decodeURIComponent(match[4]),
    };
  }

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)\/paragraphs\/([^/]+)\/reader-evaluations$/.exec(clean);
  if (match) return { kind: "paragraph-reader-evaluations", bookId: decodeURIComponent(match[1]), chapterId: decodeURIComponent(match[2]), paragraphNum: decodeURIComponent(match[3]) };

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)\/paragraphs\/([^/]+)\/audit$/.exec(clean);
  if (match) return { kind: "paragraph-audit", bookId: decodeURIComponent(match[1]), chapterId: decodeURIComponent(match[2]), paragraphNum: decodeURIComponent(match[3]) };

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)\/reader-evaluations$/.exec(clean);
  if (match) return { kind: "chapter-reader-evaluations", bookId: decodeURIComponent(match[1]), chapterId: decodeURIComponent(match[2]) };

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)\/audit$/.exec(clean);
  if (match) return { kind: "chapter-audit", bookId: decodeURIComponent(match[1]), chapterId: decodeURIComponent(match[2]) };

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)\/workspace\/([^/]+)$/.exec(clean);
  if (match) {
    return {
      kind: "chapter-workspace",
      bookId: decodeURIComponent(match[1]),
      chapterId: decodeURIComponent(match[2]),
      workspaceKind: decodeURIComponent(match[3]),
    };
  }

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)\/(drafts|scripts)$/.exec(clean);
  if (match) {
    return {
      kind: "chapter",
      bookId: decodeURIComponent(match[1]),
      chapterId: decodeURIComponent(match[2]),
    };
  }

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)\/paragraphs\/([^/]+)\/split$/.exec(clean);
  if (match) {
    return {
      kind: "paragraph",
      bookId: decodeURIComponent(match[1]),
      chapterId: decodeURIComponent(match[2]),
      paragraphNum: decodeURIComponent(match[3]),
    };
  }

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)\/paragraphs\/([^/]+)$/.exec(clean);
  if (match) {
    return {
      kind: "paragraph",
      bookId: decodeURIComponent(match[1]),
      chapterId: decodeURIComponent(match[2]),
      paragraphNum: decodeURIComponent(match[3]),
    };
  }

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)$/.exec(clean);
  if (match) {
    return {
      kind: "chapter",
      bookId: decodeURIComponent(match[1]),
      chapterId: decodeURIComponent(match[2]),
    };
  }

  match = /^\/app\/books\/([^/]+)$/.exec(clean);
  if (match) return { kind: "book", bookId: decodeURIComponent(match[1]) };

  return { kind: "other", pathname };
}

export async function loadWriterContext(
  pathname: string,
  settings: AppSettings,
  books: BookEntry[],
  structures: Record<string, BookStructure>,
  workingBranches: Record<string, string>,
  requestedBranch?: string,
  readFile: typeof loadFileContent = loadFileContent,
  signal?: AbortSignal,
): Promise<LoadedWriterContext> {
  signal?.throwIfAborted();
  const route = parseAppRoute(pathname);
  const bookId = "bookId" in route ? route.bookId : null;
  const book = bookId ? books.find((entry) => entry.id === bookId) ?? null : null;
  const structure = bookId ? structures[bookId] ?? null : null;
  const chapter =
    structure && "chapterId" in route
      ? structure.chapters.find((entry) => entry.slug === route.chapterId) ?? null
      : null;
  const paragraph =
    chapter && "paragraphNum" in route
      ? chapter.paragraphs.find((entry) => entry.number === route.paragraphNum) ?? null
      : null;

  const token = book ? resolveBookToken(book, settings) : "";
  const branchResolution = bookId ? resolveAuthoritativeBranch({ activeBranch: book?.activeBranch, workingBranch: requestedBranch ?? workingBranches[bookId], loadedBranch: structure?.loadedBranch, defaultBranch: structure?.defaultBranch }) : null;
  const readBranch = branchResolution?.branch;
  const branchReady = Boolean(!structure || branchResolution?.structureMatches);
  const relevantFiles: Array<{ path: string; content: string }> = [];
  const loaded = new Set<string>();
  const secretAccess = structure ? secretAccessMapForRoute({ structure, route, chapter }) : new Map<string, SecretAccess>();
  const availableFiles = structure ? buildAvailableFileManifest(structure, secretAccess) : [];

  if (book && structure && token && branchReady) {
    const pushFile = async (path: string | undefined, required = false) => {
      if (!path || loaded.has(path)) return;
      if (isSecretPath(path) && !canDiscloseSecretBody(secretAccess.get(path) ?? "hidden")) return;
      try {
        const content = await readFile(token, book.owner, book.repo, path, readBranch, signal);
        signal?.throwIfAborted();
        relevantFiles.push({ path, content });
        loaded.add(path);
      } catch (error) {
        if (!required && isRepositoryNotFoundError(error)) return;
        throw error;
      }
    };

    const ghostwriterSlug = paragraph?.ghostwriter || chapter?.ghostwriter || structure.ghostwriter;
    await pushFile(structure.ghostwriters.find((entry) => entry.slug === ghostwriterSlug)?.path);
    await pushFile(structure.plotPath);

    if (chapter) {
      await pushFile("book.md");
      await pushFile(`resumes/chapters/${chapter.slug}.md`);
      await pushFile(`evaluations/chapters/${chapter.slug}.md`);
    }

    switch (route.kind) {
      case "book":
      case "book-dashboard":
      case "book-assets":
      case "book-ghostwriters":
      case "book-evaluation-style":
        await pushFile("evaluation-guidelines.md");
        await pushFile("book.md");
        break;
      case "book-simulated-readers":
        await Promise.all(structure.readerPersonas.map((entry) => pushFile(entry.path)));
        break;
      case "reader":
      case "book-export":
      case "research":
      case "research-detail":
      case "book-settings":
      case "app-home":
        await pushFile("book.md");
        await pushFile(structure.plotPath);
        if (route.kind === "research-detail") await pushFile(resolveResearchDetailPath(structure, route.researchSlug), true);
        break;
      case "book-audit":
        await pushFile("audit/book.md");
        await pushFile("book.md");
        break;
      case "chapter":
        await pushFile(`${chapter?.path}/chapter.md`, true);
        await Promise.all((chapter?.paragraphs ?? []).slice(0, 12).map((entry) => pushFile(entry.path)));
        break;
      case "chapter-workspace":
        await pushFile(`${chapter?.path}/chapter.md`, true);
        await pushFile(resolveWorkspacePath(chapter, null, route.workspaceKind));
        break;
      case "paragraph":
        await pushFile(`${chapter?.path}/chapter.md`);
        await pushFile(paragraph?.path, true);
        break;
      case "paragraph-workspace":
        await pushFile(paragraph?.path, true);
        await pushFile(resolveWorkspacePath(chapter, paragraph, route.workspaceKind));
        break;
      case "chapter-reader-evaluations":
        await Promise.all((chapter?.paragraphs ?? []).map((entry) => pushFile(entry.path)));
        break;
      case "paragraph-reader-evaluations":
        await pushFile(paragraph?.path, true);
        break;
      case "chapter-audit":
        await pushFile(`audit/chapters/${route.chapterId}/chapter.md`);
        await pushFile(`${chapter?.path}/chapter.md`);
        break;
      case "paragraph-audit": {
        const slug = paragraph ? (paragraph.path.split("/").pop() ?? "").replace(/\.md$/i, "") : route.paragraphNum;
        await pushFile(`audit/chapters/${route.chapterId}/paragraphs/${slug}.md`);
        await pushFile(paragraph?.path);
        break;
      }
      case "canon":
        await pushFile(resolveCanonPath(route.section, route.slug), route.section !== "secrets");
        break;
      default:
        break;
    }
  }

  return {
    route,
    book,
    structure,
    chapter,
    paragraph,
    title: buildContextTitle(route, structure, chapter, paragraph),
    summary: buildContextSummary(route, book, structure, chapter, paragraph),
    availableFiles,
    relevantFiles,
    loadedFilePaths: [...loaded],
    noteTargetPath: buildNoteTargetPath(route, chapter),
    branch: readBranch,
    branchReady,
  };
}

export function buildContextTitle(
  route: AppRouteContext,
  structure: BookStructure | null,
  chapter: Chapter | null,
  paragraph: Paragraph | null,
): string {
  switch (route.kind) {
    case "book": return structure?.title ?? "Book";
    case "book-dashboard": return "Book dashboard";
    case "book-assets": return "Book assets";
    case "book-ghostwriters": return "Ghostwriters";
    case "book-evaluation-style": return "Evaluation Style";
    case "book-simulated-readers":
      return "Simulated Readers";
    case "chapter-reader-evaluations":
    case "paragraph-reader-evaluations":
      return "Reader Evaluations";
    case "book-audit":
    case "chapter-audit":
    case "paragraph-audit":
      return "Audit";
    case "reader":
    case "research":
      return structure?.title ?? "Book";
    case "research-detail":
      return structure?.researchFiles.find((file) => file.slug === route.researchSlug)?.title ?? route.researchSlug;
    case "chapter":
    case "chapter-workspace":
      return chapter?.title ?? route.chapterId;
    case "paragraph":
    case "paragraph-workspace":
      return paragraph?.title ?? route.paragraphNum;
    case "canon":
      return `${route.section} / ${route.slug}`;
    case "book-export":
      return "Book export";
    case "book-settings":
      return "Book settings";
    case "app-home":
      return "Library";
    case "app-page":
      return route.page.split("/").pop()?.replace(/-/g, " ") ?? "Narrarium";
    default:
      return "Narrarium";
  }
}

export function buildContextSummary(
  route: AppRouteContext,
  book: BookEntry | null,
  structure: BookStructure | null,
  chapter: Chapter | null,
  paragraph: Paragraph | null,
): string {
  switch (route.kind) {
    case "book": return `Book context for ${structure?.title ?? book?.name ?? "book"}.`;
    case "book-dashboard": return `Dashboard for ${structure?.title ?? book?.name ?? "book"}.`;
    case "book-assets": return `Assets for ${structure?.title ?? book?.name ?? "book"}.`;
    case "book-ghostwriters": return `Ghostwriters for ${structure?.title ?? book?.name ?? "book"}.`;
    case "book-evaluation-style": return `Editing evaluation style for ${structure?.title ?? book?.name ?? "book"}.`;
    case "book-simulated-readers":
      return `Managing simulated readers for ${structure?.title ?? book?.name ?? "book"}.`;
    case "chapter-reader-evaluations":
      return `Simulated-reader evaluations for chapter ${chapter?.title ?? route.chapterId}.`;
    case "paragraph-reader-evaluations":
      return `Simulated-reader evaluations for paragraph ${paragraph?.title ?? route.paragraphNum}.`;
    case "book-audit":
      return `Audit report for ${structure?.title ?? book?.name ?? route.bookId}.`;
    case "chapter-audit":
      return `Audit report for chapter ${chapter?.title ?? route.chapterId}.`;
    case "paragraph-audit":
      return `Audit report for paragraph ${paragraph?.title ?? route.paragraphNum} in chapter ${chapter?.title ?? route.chapterId}.`;
    case "reader":
    case "book-export":
    case "research":
      return `${book?.owner}/${book?.repo}\nChapters: ${structure?.chapters.length ?? 0}`;
    case "research-detail":
      return `Research document ${route.researchSlug} in ${book?.owner}/${book?.repo}.`;
    case "chapter":
      return `Chapter ${chapter?.slug ?? route.chapterId} with ${chapter?.paragraphs.length ?? 0} paragraphs.`;
    case "paragraph":
      return `Paragraph ${paragraph?.number ?? route.paragraphNum} in chapter ${chapter?.slug ?? route.chapterId}.`;
    case "chapter-workspace":
      return `Workspace ${route.workspaceKind} for chapter ${chapter?.slug ?? route.chapterId}.`;
    case "paragraph-workspace":
      return `Workspace ${route.workspaceKind} for paragraph ${paragraph?.number ?? route.paragraphNum}.`;
    case "canon":
      return `Editing canon entity ${route.slug} in ${route.section}.`;
    case "book-settings":
      return `Settings for ${book?.name ?? route.bookId}.`;
    case "app-home":
      return "Narrarium library.";
    case "app-page":
      return `Narrarium application page: ${route.page}.`;
    default:
      return route.pathname;
  }
}

function buildNoteTargetPath(route: AppRouteContext, chapter: Chapter | null): string | null {
  if (route.kind === "chapter" || route.kind === "paragraph" || route.kind === "chapter-workspace" || route.kind === "paragraph-workspace" || route.kind === "chapter-audit" || route.kind === "paragraph-audit") {
    return chapter ? `drafts/${chapter.slug}/notes.md` : null;
  }
  if (route.kind === "book" || route.kind === "book-dashboard" || route.kind === "book-assets" || route.kind === "book-ghostwriters" || route.kind === "book-evaluation-style" || route.kind === "book-simulated-readers" || route.kind === "reader" || route.kind === "book-export" || route.kind === "research" || route.kind === "research-detail" || route.kind === "canon" || route.kind === "book-settings" || route.kind === "book-audit" || route.kind === "app-home") {
    return "notes.md";
  }
  return null;
}

function resolveCanonPath(section: string, slug: string): string | undefined {
  switch (section) {
    case "characters":
      return `characters/${slug}.md`;
    case "locations":
      return `locations/${slug}.md`;
    case "factions":
      return `factions/${slug}.md`;
    case "items":
      return `items/${slug}.md`;
    case "secrets":
      return `secrets/${slug}.md`;
    case "timelines":
      return `timelines/events/${slug}.md`;
    default:
      return undefined;
  }
}

function resolveWorkspacePath(
  chapter: Chapter | null,
  paragraph: Paragraph | null,
  workspaceKind: string,
): string | undefined {
  if (!chapter) return undefined;
  if (!paragraph) {
    if (workspaceKind === "draft") return chapter.draftPath;
    if (workspaceKind === "resume") return `resumes/chapters/${chapter.slug}.md`;
    if (workspaceKind === "evaluation") return `evaluations/chapters/${chapter.slug}.md`;
    return undefined;
  }

  const slug = (paragraph.path.split("/").pop() ?? "").replace(/\.md$/i, "");
  if (workspaceKind === "draft") return paragraph.draftPath;
  if (workspaceKind === "script") return `scripts/${chapter.slug}/${slug}.md`;
  if (workspaceKind === "evaluation") return `evaluations/paragraphs/${chapter.slug}/${slug}.md`;
  return undefined;
}


export function resolveResearchDetailPath(structure: BookStructure, researchSlug: string): string | undefined {
  return structure.researchFiles.find((file) => file.slug === researchSlug)?.path;
}

export function buildAvailableFileManifest(structure: BookStructure, secretAccess: ReadonlyMap<string, SecretAccess> = new Map()): AvailableFile[] {
  const files: AvailableFile[] = [];
  const add = (path: string | undefined, role: string, exists = true) => {
    if (path) files.push({ path, role, exists });
  };

  add("book.md", "book metadata");
  const existingFirstClassPaths = new Set((structure.firstClassFiles ?? structure.rootFiles ?? []).map((file) => file.path));
  ["context.md", "ideas.md", "story-design.md", "notes.md", "promoted.md", "evaluation-guidelines.md", "state/current.md", "state/status.md", "state/script-ledger.md", "resumes/total.md", "evaluations/total.md"].forEach((path) => add(path, "first-class conventional file", existingFirstClassPaths.has(path)));
  add(structure.plotPath, "plot");
  structure.ghostwriters.forEach((file) => add(file.path, "ghostwriter"));
  structure.readerPersonas.forEach((file) => add(file.path, "simulated reader persona"));
  structure.readerEvaluationFiles.forEach((file) => add(file.path, file.path.includes("/summaries/") ? "reader evaluation summary" : "reader evaluation"));
  structure.auditFiles.forEach((file) => add(file.path, "audit report"));
  structure.researchFiles.forEach((file) => add(file.path, "research document"));
  structure.notesFiles.forEach((file) => add(file.path, "note"));
  structure.operationManifestFiles.forEach((file) => add(file.path, "operation manifest"));
  (structure.searchableFiles ?? []).filter((file) => !isSecretPath(file.path)).forEach((file) => add(file.path, file.role, true));

  for (const chapter of structure.chapters) {
    add(`${chapter.path}/chapter.md`, "chapter metadata/body");
    add(chapter.draftPath, "chapter draft");
    add(`resumes/chapters/${chapter.slug}.md`, "chapter resume", chapter.hasResume);
    add(`evaluations/chapters/${chapter.slug}.md`, "chapter evaluation", chapter.hasEvaluation);
    for (const paragraph of chapter.paragraphs) {
      add(paragraph.path, "paragraph");
      add(paragraph.draftPath, "paragraph draft");
      const slug = (paragraph.path.split("/").pop() ?? "").replace(/\.md$/i, "");
      add(`scripts/${chapter.slug}/${slug}.md`, "scene script", Boolean(paragraph.scriptPath));
      add(`evaluations/paragraphs/${chapter.slug}/${slug}.md`, "paragraph evaluation", Boolean(paragraph.evaluationPath));
    }
  }

  const canon = [
    ...structure.characters.map((file) => ({ path: file.path, role: "character", exists: true })),
    ...structure.locations.map((file) => ({ path: file.path, role: "location", exists: true })),
    ...structure.factions.map((file) => ({ path: file.path, role: "faction", exists: true })),
    ...structure.items.map((file) => ({ path: file.path, role: "item", exists: true })),
    ...visibleSecretManifestEntries(structure.secrets, secretAccess),
    ...structure.timelines.map((file) => ({ path: file.path, role: "timeline event", exists: true })),
  ];
  files.push(...canon);

  const byPath = new Map<string, AvailableFile>();
  for (const file of files) {
    const previous = byPath.get(file.path);
    if (!previous || (!previous.exists && file.exists)) byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
