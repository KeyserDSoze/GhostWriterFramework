import type { BookStructure, Chapter, Paragraph } from "@/types/book";
import type { AppSettings, BookEntry } from "@/types/settings";
import { loadFileContent } from "@/github/githubClient";
import { resolveBookToken } from "@/types/settings";

export type AppRouteContext =
  | { kind: "app-home" }
  | { kind: "book"; bookId: string }
  | { kind: "book-dashboard"; bookId: string }
  | { kind: "book-assets"; bookId: string }
  | { kind: "book-ghostwriters"; bookId: string }
  | { kind: "book-writing-style"; bookId: string }
  | { kind: "book-evaluation-style"; bookId: string }
  | { kind: "book-simulated-readers"; bookId: string }
  | { kind: "reader"; bookId: string }
  | { kind: "book-export"; bookId: string }
  | { kind: "book-settings"; bookId: string }
  | { kind: "research"; bookId: string }
  | { kind: "research-detail"; bookId: string; researchSlug: string }
  | { kind: "canon"; bookId: string; section: string; slug: string }
  | { kind: "chapter"; bookId: string; chapterId: string }
  | { kind: "chapter-workspace"; bookId: string; chapterId: string; workspaceKind: string }
  | { kind: "paragraph"; bookId: string; chapterId: string; paragraphNum: string }
  | { kind: "paragraph-workspace"; bookId: string; chapterId: string; paragraphNum: string; workspaceKind: string }
  | { kind: "chapter-reader-evaluations"; bookId: string; chapterId: string }
  | { kind: "paragraph-reader-evaluations"; bookId: string; chapterId: string; paragraphNum: string }
  | { kind: "other"; pathname: string };

export interface AvailableFile {
  path: string;
  role: string;
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
}

export function parseAppRoute(pathname: string): AppRouteContext {
  const clean = pathname.replace(/\/+$/, "") || "/";
  if (clean === "/app" || clean === "/app/books") return { kind: "app-home" };

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

  match = /^\/app\/books\/([^/]+)\/writing-style$/.exec(clean);
  if (match) return { kind: "book-writing-style", bookId: decodeURIComponent(match[1]) };

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

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)\/reader-evaluations$/.exec(clean);
  if (match) return { kind: "chapter-reader-evaluations", bookId: decodeURIComponent(match[1]), chapterId: decodeURIComponent(match[2]) };

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)\/workspace\/([^/]+)$/.exec(clean);
  if (match) {
    return {
      kind: "chapter-workspace",
      bookId: decodeURIComponent(match[1]),
      chapterId: decodeURIComponent(match[2]),
      workspaceKind: decodeURIComponent(match[3]),
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
): Promise<LoadedWriterContext> {
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
  const readBranch = bookId ? (book?.activeBranch ?? workingBranches[bookId] ?? structure?.defaultBranch) : undefined;
  const availableFiles = structure ? buildAvailableFileManifest(structure) : [];
  const relevantFiles: Array<{ path: string; content: string }> = [];
  const loaded = new Set<string>();

  if (book && structure && token) {
    const pushFile = async (path: string | undefined) => {
      if (!path || loaded.has(path)) return;
      try {
        const content = await loadFileContent(token, book.owner, book.repo, path, readBranch);
        relevantFiles.push({ path, content });
        loaded.add(path);
      } catch {
        // Ignore missing optional files; the assistant works with what exists.
      }
    };

    await pushFile(structure.globalWritingStylePath);
    await pushFile(structure.globalPunctuationStylePath);
    await pushFile(structure.voicesPath);
    await pushFile(structure.plotPath);

    if (chapter) {
      await pushFile(chapter.writingStylePath);
      await pushFile(`resumes/chapters/${chapter.slug}.md`);
      await pushFile(`evaluations/chapters/${chapter.slug}.md`);
    }

    switch (route.kind) {
      case "book":
      case "book-dashboard":
      case "book-assets":
      case "book-ghostwriters":
      case "book-writing-style":
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
        break;
      case "chapter":
        await pushFile(`${chapter?.path}/chapter.md`);
        await Promise.all((chapter?.paragraphs ?? []).slice(0, 12).map((entry) => pushFile(entry.path)));
        break;
      case "chapter-workspace":
        await pushFile(`${chapter?.path}/chapter.md`);
        await pushFile(resolveWorkspacePath(chapter, null, route.workspaceKind));
        break;
      case "paragraph":
        await pushFile(`${chapter?.path}/chapter.md`);
        await pushFile(paragraph?.path);
        break;
      case "paragraph-workspace":
        await pushFile(paragraph?.path);
        await pushFile(resolveWorkspacePath(chapter, paragraph, route.workspaceKind));
        break;
      case "chapter-reader-evaluations":
        await Promise.all((chapter?.paragraphs ?? []).map((entry) => pushFile(entry.path)));
        break;
      case "paragraph-reader-evaluations":
        await pushFile(paragraph?.path);
        break;
      case "canon":
        await pushFile(resolveCanonPath(route.section, route.slug));
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
  };
}

function buildContextTitle(
  route: AppRouteContext,
  structure: BookStructure | null,
  chapter: Chapter | null,
  paragraph: Paragraph | null,
): string {
  switch (route.kind) {
    case "book":
    case "book-dashboard":
    case "book-assets":
    case "book-ghostwriters":
    case "book-writing-style":
    case "book-evaluation-style":
      return "Evaluation Style";
    case "book-simulated-readers":
      return "Simulated Readers";
    case "chapter-reader-evaluations":
    case "paragraph-reader-evaluations":
      return "Reader Evaluations";
    case "reader":
    case "research":
    case "research-detail":
      return structure?.title ?? "Book";
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
    default:
      return "Narrarium";
  }
}

function buildContextSummary(
  route: AppRouteContext,
  book: BookEntry | null,
  structure: BookStructure | null,
  chapter: Chapter | null,
  paragraph: Paragraph | null,
): string {
  switch (route.kind) {
    case "book":
    case "book-dashboard":
    case "book-assets":
    case "book-ghostwriters":
    case "book-writing-style":
    case "book-evaluation-style":
      return `Editing evaluation style for ${structure?.title ?? book?.name ?? "book"}.`;
    case "book-simulated-readers":
      return `Managing simulated readers for ${structure?.title ?? book?.name ?? "book"}.`;
    case "chapter-reader-evaluations":
      return `Simulated-reader evaluations for chapter ${chapter?.title ?? route.chapterId}.`;
    case "paragraph-reader-evaluations":
      return `Simulated-reader evaluations for paragraph ${paragraph?.title ?? route.paragraphNum}.`;
    case "reader":
    case "book-export":
    case "research":
    case "research-detail":
      return `${book?.owner}/${book?.repo}\nChapters: ${structure?.chapters.length ?? 0}`;
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
    default:
      return route.pathname;
  }
}

function buildNoteTargetPath(route: AppRouteContext, chapter: Chapter | null): string | null {
  if (route.kind === "chapter" || route.kind === "paragraph" || route.kind === "chapter-workspace" || route.kind === "paragraph-workspace") {
    return chapter ? `drafts/${chapter.slug}/notes.md` : null;
  }
  if (route.kind === "book" || route.kind === "book-dashboard" || route.kind === "book-assets" || route.kind === "book-ghostwriters" || route.kind === "book-writing-style" || route.kind === "book-evaluation-style" || route.kind === "book-simulated-readers" || route.kind === "reader" || route.kind === "book-export" || route.kind === "research" || route.kind === "research-detail" || route.kind === "canon" || route.kind === "book-settings" || route.kind === "app-home") {
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


function buildAvailableFileManifest(structure: BookStructure): AvailableFile[] {
  const files: AvailableFile[] = [];
  const add = (path: string | undefined, role: string) => {
    if (path) files.push({ path, role });
  };

  add("book.md", "book metadata");
  add(structure.plotPath, "plot");
  add(structure.globalWritingStylePath, "global writing style");
  add(structure.globalPunctuationStylePath, "global punctuation style");
  add(structure.voicesPath, "voices/style reference");
  structure.readerPersonas.forEach((file) => add(file.path, "simulated reader persona"));
  structure.readerEvaluationFiles.forEach((file) => add(file.path, file.path.includes("/summaries/") ? "reader evaluation summary" : "reader evaluation"));

  for (const chapter of structure.chapters) {
    add(`${chapter.path}/chapter.md`, "chapter metadata/body");
    add(chapter.writingStylePath, "chapter writing style");
    add(chapter.draftPath, "chapter draft");
    add(`resumes/chapters/${chapter.slug}.md`, "chapter resume");
    add(`evaluations/chapters/${chapter.slug}.md`, "chapter evaluation");
    for (const paragraph of chapter.paragraphs) {
      add(paragraph.path, "paragraph");
      add(paragraph.draftPath, "paragraph draft");
      const slug = (paragraph.path.split("/").pop() ?? "").replace(/\.md$/i, "");
      add(`scripts/${chapter.slug}/${slug}.md`, "scene script");
      add(`evaluations/paragraphs/${chapter.slug}/${slug}.md`, "paragraph evaluation");
    }
  }

  const canon = [
    ...structure.characters.map((file) => ({ path: file.path, role: "character" })),
    ...structure.locations.map((file) => ({ path: file.path, role: "location" })),
    ...structure.factions.map((file) => ({ path: file.path, role: "faction" })),
    ...structure.items.map((file) => ({ path: file.path, role: "item" })),
    ...structure.secrets.map((file) => ({ path: file.path, role: "secret" })),
    ...structure.timelines.map((file) => ({ path: file.path, role: "timeline event" })),
  ];
  files.push(...canon);

  return files.sort((a, b) => a.path.localeCompare(b.path));
}
