import { parseDocument } from "yaml";
import { completeTextRouted } from "@/assistant/router";
import { loadWriterContext, parseAppRoute } from "@/assistant/context";
import type { LlmMessage } from "@/assistant/llm";
import { loadFileContent } from "@/github/githubClient";
import { CANON_SECTION_ORDER } from "@/lib/canonSections";
import { ghostwriterPrompt } from "@/narrarium/ghostwriter";
import { loadGhostwriterProfile, stripFrontmatter } from "@/narrarium/pipeline";
import type { BookStructure, Chapter, Paragraph } from "@/types/book";
import { CHAT_CAPABILITIES, resolveBookToken, type AppSettings, type BookEntry, type ChatCapability, type CustomAction } from "@/types/settings";

export const ALL_TARGET_TYPES = "*";

const BASE_TARGET_TYPES = ["book", "chapter", "paragraph"];

export interface CustomActionTargetType {
  value: string;
  labelKey: string;
}

export interface CustomActionTargetContext {
  type: string;
  title: string;
  filePath?: string;
  book: BookEntry | null;
  structure: BookStructure | null;
  chapter: Chapter | null;
  paragraph: Paragraph | null;
  branch?: string;
  token: string;
}

export interface CustomActionPromptInput {
  action: CustomAction;
  pathname: string;
  settings: AppSettings;
  books: BookEntry[];
  structures: Record<string, BookStructure>;
  workingBranches: Record<string, string>;
  selection?: string;
  editorBody?: string;
}

interface MarkdownParts {
  frontmatter: string;
  frontmatterRecord: Record<string, unknown>;
  body: string;
  raw: string;
}

export function createBlankCustomAction(): CustomAction {
  return {
    id: crypto.randomUUID(),
    name: "",
    prompt: "",
    capability: "default",
    targetTypes: [ALL_TARGET_TYPES],
    activation: "selection",
    injections: {
      includeBody: true,
      includeFrontmatter: false,
      includeContext: true,
      includeWritingStyle: true,
      includeGhostwriter: true,
    },
    outputMode: "show",
    enabled: true,
  };
}

export function supportedCustomActionTargetTypes(): CustomActionTargetType[] {
  const canonTargets = CANON_SECTION_ORDER.map((section) => sectionTargetType(section));
  return [...BASE_TARGET_TYPES, ...canonTargets].map((value) => ({ value, labelKey: `customActions.targets.${value}` }));
}

export function customActionCapabilities(): ChatCapability[] {
  return CHAT_CAPABILITIES;
}

export function customActionAppliesToTarget(action: CustomAction, targetType: string): boolean {
  if (!action.enabled || !action.name.trim() || !action.prompt.trim()) return false;
  const targets = action.targetTypes?.length ? action.targetTypes : [ALL_TARGET_TYPES];
  return targets.includes(ALL_TARGET_TYPES) || targets.includes(targetType);
}

export function customActionActivationMatches(action: CustomAction, selection: string, canReplace: boolean): boolean {
  if (action.activation === "selection" && !selection.trim()) return false;
  if (action.outputMode === "replace" && !canReplace) return false;
  return true;
}

export function compatibleCustomActions(input: {
  actions: CustomAction[];
  targetType: string | null;
  selection: string;
  canReplace: boolean;
}): CustomAction[] {
  if (!input.targetType) return [];
  return input.actions.filter((action) =>
    customActionAppliesToTarget(action, input.targetType!) &&
    customActionActivationMatches(action, input.selection, input.canReplace),
  );
}

export function resolveCustomActionTarget(input: {
  pathname: string;
  settings: AppSettings;
  books: BookEntry[];
  structures: Record<string, BookStructure>;
  workingBranches: Record<string, string>;
}): CustomActionTargetContext | null {
  const route = parseAppRoute(input.pathname);
  const bookId = "bookId" in route ? route.bookId : undefined;
  const book = bookId ? input.books.find((entry) => entry.id === bookId) ?? null : null;
  const structure = bookId ? input.structures[bookId] ?? null : null;
  const chapter = structure && "chapterId" in route ? structure.chapters.find((entry) => entry.slug === route.chapterId) ?? null : null;
  const paragraph = chapter && "paragraphNum" in route ? chapter.paragraphs.find((entry) => entry.number === route.paragraphNum) ?? null : null;
  const branch = bookId ? (book?.activeBranch ?? input.workingBranches[bookId] ?? structure?.loadedBranch ?? structure?.defaultBranch) : undefined;
  const token = book ? resolveBookToken(book, input.settings) : "";

  switch (route.kind) {
    case "book":
    case "reader":
    case "research":
    case "research-detail":
    case "book-settings":
      return { type: "book", title: structure?.title ?? book?.name ?? "Book", filePath: "book.md", book, structure, chapter: null, paragraph: null, branch, token };
    case "chapter":
      return { type: "chapter", title: chapter?.title ?? route.chapterId, filePath: chapter ? `${chapter.path}/chapter.md` : undefined, book, structure, chapter, paragraph: null, branch, token };
    case "chapter-workspace":
      return { type: "chapter", title: chapter?.title ?? route.chapterId, filePath: resolveWorkspacePath(chapter, null, route.workspaceKind) ?? (chapter ? `${chapter.path}/chapter.md` : undefined), book, structure, chapter, paragraph: null, branch, token };
    case "paragraph":
      return { type: "paragraph", title: paragraph?.title ?? route.paragraphNum, filePath: paragraph?.path, book, structure, chapter, paragraph, branch, token };
    case "paragraph-workspace":
      return { type: "paragraph", title: paragraph?.title ?? route.paragraphNum, filePath: resolveWorkspacePath(chapter, paragraph, route.workspaceKind) ?? paragraph?.path, book, structure, chapter, paragraph, branch, token };
    case "canon":
      return { type: sectionTargetType(route.section), title: route.slug, filePath: resolveCanonPath(route.section, route.slug), book, structure, chapter: null, paragraph: null, branch, token };
    default:
      return null;
  }
}

export async function runCustomAction(input: CustomActionPromptInput): Promise<string> {
  const target = resolveCustomActionTarget(input);
  if (!target) throw new Error("No supported target for this custom action.");
  const doc = await loadTargetDocument(target, input.editorBody);
  const messages = await buildCustomActionMessages(input, target, doc);
  const response = await completeTextRouted(input.settings, messages, input.action.capability, { label: `custom-action:${input.action.name}` });
  return input.action.outputMode === "replace" ? response : response.trim();
}

async function buildCustomActionMessages(input: CustomActionPromptInput, target: CustomActionTargetContext, doc: MarkdownParts): Promise<LlmMessage[]> {
  const action = input.action;
  const selection = input.selection?.trim() ?? "";
  const targetText = action.activation === "selection" && selection ? selection : doc.body;
  const injected: string[] = [];

  if (action.injections.includeFrontmatter && doc.frontmatter.trim()) {
    injected.push(`FRONT MATTER / HEADER:\n${doc.frontmatter.trim()}`);
  }
  if (action.injections.includeBody && doc.body.trim()) {
    injected.push(`BODY:\n${doc.body.trim()}`);
  }
  if (action.injections.includeContext) {
    const context = await loadWriterContext(input.pathname, input.settings, input.books, input.structures, input.workingBranches);
    const files = context.relevantFiles
      .map((file) => `FILE: ${file.path}\n${file.content.trim()}`)
      .filter(Boolean)
      .join("\n\n---\n\n");
    injected.push([
      `NARRARIUM CONTEXT:\n${context.summary}`,
      files ? `RELEVANT FILES:\n${files}` : "",
    ].filter(Boolean).join("\n\n"));
  }
  if (action.injections.includeWritingStyle) {
    const style = await loadWritingStyle(target);
    if (style.trim()) injected.push(`WRITING STYLE:\n${style.trim()}`);
  }
  if (action.injections.includeGhostwriter) {
    const ghost = await loadGhostwriter(target, doc.frontmatterRecord, input.settings);
    if (ghost.trim()) injected.push(`GHOSTWRITER:\n${ghost.trim()}`);
  }

  const system = [
    "You execute a user-configured Narrarium Custom Action. Use the configured prompt and the provided target context. Respect visible canon and the user's language unless the prompt asks otherwise.",
    action.outputMode === "replace" ? replacementSystemPrompt() : "",
  ].filter(Boolean).join("\n\n");

  const user = [
    `CUSTOM ACTION NAME:\n${action.name}`,
    `CUSTOM ACTION PROMPT:\n${action.prompt.trim()}`,
    `TARGET:\nType: ${target.type}\nTitle: ${target.title}\nPath: ${target.filePath ?? "unknown"}`,
    selection ? `SELECTED TEXT:\n${selection}` : "",
    `TEXT TO PROCESS:\n${targetText.trim()}`,
    injected.length ? `INJECTED CONTEXT:\n${injected.join("\n\n---\n\n")}` : "",
  ].filter(Boolean).join("\n\n---\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function replacementSystemPrompt(): string {
  return [
    "This Custom Action is configured in Replace mode.",
    "Return exclusively the final replacement content.",
    "Do not include explanations, introductions, comments, descriptive text, unsolicited markdown, code fences, headings unless they are part of the replacement, or phrases like 'Here is the result'.",
    "The response must be ready to paste over the selected/current content as-is.",
  ].join("\n");
}

async function loadTargetDocument(target: CustomActionTargetContext, editorBody?: string): Promise<MarkdownParts> {
  let raw = "";
  if (target.book && target.token && target.branch && target.filePath) {
    raw = await loadFileContent(target.token, target.book.owner, target.book.repo, target.filePath, target.branch).catch(() => "");
  }
  const parsed = splitMarkdown(raw);
  return editorBody != null ? { ...parsed, body: editorBody } : parsed;
}

function splitMarkdown(raw: string): MarkdownParts {
  const match = raw.match(/^(---\r?\n([\s\S]*?)\r?\n---\r?\n?)([\s\S]*)$/);
  if (!match) return { frontmatter: "", frontmatterRecord: {}, body: raw, raw };
  let frontmatterRecord: Record<string, unknown> = {};
  try {
    const parsed = parseDocument(match[2]).toJSON();
    if (parsed && typeof parsed === "object") frontmatterRecord = parsed as Record<string, unknown>;
  } catch {
    frontmatterRecord = {};
  }
  return { frontmatter: match[1], frontmatterRecord, body: (match[3] ?? "").replace(/^\s*\n/, ""), raw };
}

async function loadWritingStyle(target: CustomActionTargetContext): Promise<string> {
  if (!target.book || !target.structure || !target.token || !target.branch) return "";
  const paths = [target.structure.globalWritingStylePath, target.chapter?.writingStylePath].filter(Boolean) as string[];
  const blocks = await Promise.all(paths.map(async (path) => {
    const raw = await loadFileContent(target.token, target.book!.owner, target.book!.repo, path, target.branch).catch(() => "");
    return raw ? `${path}:\n${stripFrontmatter(raw)}` : "";
  }));
  return blocks.filter(Boolean).join("\n\n");
}

async function loadGhostwriter(target: CustomActionTargetContext, frontmatter: Record<string, unknown>, settings: AppSettings): Promise<string> {
  if (!target.book || !target.structure || !target.token || !target.branch) return "";
  const slug = typeof frontmatter.ghostwriter === "string" ? frontmatter.ghostwriter : "";
  if (!slug) return "";
  const profile = await loadGhostwriterProfile({
    token: target.token,
    owner: target.book.owner,
    repo: target.book.repo,
    branch: target.branch,
    settings,
    structure: target.structure,
    chapter: target.chapter ?? undefined,
  }, slug).catch(() => null);
  return profile ? ghostwriterPrompt(profile) : "";
}

function resolveWorkspacePath(chapter: Chapter | null, paragraph: Paragraph | null, workspaceKind: string): string | undefined {
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

function resolveCanonPath(section: string, slug: string): string | undefined {
  if (section === "timelines") return `timelines/events/${slug}.md`;
  return `${section}/${slug}.md`;
}

function sectionTargetType(section: string): string {
  const explicit: Record<string, string> = {
    characters: "character",
    locations: "location",
    factions: "faction",
    items: "item",
    timelines: "timeline",
    secrets: "secret",
  };
  if (explicit[section]) return explicit[section];
  return section.replace(/ies$/, "y").replace(/s$/, "");
}
