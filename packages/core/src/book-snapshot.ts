import matter from "gray-matter";
import {
  assetSchema,
  bookSchema,
  chapterDraftSchema,
  chapterSchema,
  characterSchema,
  contextSchema,
  factionSchema,
  guidelineSchema,
  itemSchema,
  locationSchema,
  paragraphDraftSchema,
  paragraphSchema,
  plotSchema,
  researchNoteSchema,
  secretSchema,
  timelineEventSchema,
} from "./schemas.js";
import { renderMarkdown } from "./templates.js";
import {
  createEmptyBookSnapshot,
  type NarrariumAnyDocument,
  type NarrariumBookSnapshot,
  type NarrariumChapterSnapshot,
  type NarrariumDocument,
  type NarrariumDocumentKind,
  type NarrariumDraftChapterSnapshot,
} from "./book-manager.js";

type LooseFrontmatter = Record<string, unknown>;

export interface BuildNarrariumBookSnapshotInput {
  profileId: string;
  provider: "github" | "azure-devops";
  branch: string;
  commitSha: string;
  ref?: string | null;
  loadedAt?: string | Date;
  documents: Array<{
    path: string;
    rawMarkdown: string;
  }>;
}

export function normalizeNarrariumDocumentPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function classifyNarrariumDocumentKind(path: string): NarrariumDocumentKind {
  const normalizedPath = normalizeNarrariumDocumentPath(path);

  if (normalizedPath === "book.md") return "book";
  if (normalizedPath === "plot.md") return "plot";
  if (normalizedPath === "context.md") return "context";
  if (normalizedPath.startsWith("guidelines/")) return "guideline";
  if (normalizedPath.startsWith("characters/")) return "character";
  if (normalizedPath.startsWith("items/")) return "item";
  if (normalizedPath.startsWith("locations/")) return "location";
  if (normalizedPath.startsWith("factions/")) return "faction";
  if (normalizedPath.startsWith("secrets/")) return "secret";
  if (normalizedPath === "timelines/main.md") return "timeline-main";
  if (normalizedPath.startsWith("timelines/events/")) return "timeline-event";
  if (normalizedPath.startsWith("chapters/") && normalizedPath.endsWith("/chapter.md")) return "chapter";
  if (normalizedPath.startsWith("chapters/")) return "paragraph";
  if (normalizedPath.startsWith("drafts/") && normalizedPath.endsWith("/chapter.md")) return "chapter-draft";
  if (normalizedPath.startsWith("drafts/")) return "paragraph-draft";
  if (normalizedPath.startsWith("resumes/")) return "resume";
  if (normalizedPath.startsWith("evaluations/")) return "evaluation";
  if (normalizedPath.startsWith("state/")) return "state";
  if (normalizedPath.startsWith("research/wikipedia/")) return "research-note";
  if (normalizedPath.startsWith("assets/")) return "asset";
  return "unknown";
}

export function parseNarrariumMarkdownDocument(path: string, rawMarkdown: string): NarrariumAnyDocument {
  const normalizedPath = normalizeNarrariumDocumentPath(path);
  const parsed = matter(rawMarkdown);
  const body = String(parsed.content ?? "").trim();
  const frontmatter = parsed.data as LooseFrontmatter;
  const kind = classifyNarrariumDocumentKind(normalizedPath);

  switch (kind) {
    case "book":
      return buildTypedDocument(kind, normalizedPath, bookSchema.parse(frontmatter), body, rawMarkdown);
    case "plot":
      return buildTypedDocument(kind, normalizedPath, plotSchema.parse(frontmatter), body, rawMarkdown);
    case "guideline":
      return buildTypedDocument(kind, normalizedPath, guidelineSchema.parse(frontmatter), body, rawMarkdown);
    case "character":
      return buildTypedDocument(kind, normalizedPath, characterSchema.parse(frontmatter), body, rawMarkdown);
    case "item":
      return buildTypedDocument(kind, normalizedPath, itemSchema.parse(frontmatter), body, rawMarkdown);
    case "location":
      return buildTypedDocument(kind, normalizedPath, locationSchema.parse(frontmatter), body, rawMarkdown);
    case "faction":
      return buildTypedDocument(kind, normalizedPath, factionSchema.parse(frontmatter), body, rawMarkdown);
    case "secret":
      return buildTypedDocument(kind, normalizedPath, secretSchema.parse(frontmatter), body, rawMarkdown);
    case "timeline-event":
      return buildTypedDocument(kind, normalizedPath, timelineEventSchema.parse(frontmatter), body, rawMarkdown);
    case "chapter":
      return buildTypedDocument(kind, normalizedPath, chapterSchema.parse(frontmatter), body, rawMarkdown);
    case "paragraph":
      return buildTypedDocument(kind, normalizedPath, paragraphSchema.parse(frontmatter), body, rawMarkdown);
    case "chapter-draft":
      return buildTypedDocument(kind, normalizedPath, chapterDraftSchema.parse(frontmatter), body, rawMarkdown);
    case "paragraph-draft":
      return buildTypedDocument(kind, normalizedPath, paragraphDraftSchema.parse(frontmatter), body, rawMarkdown);
    case "research-note":
      return buildTypedDocument(kind, normalizedPath, researchNoteSchema.parse(frontmatter), body, rawMarkdown);
    case "asset":
      return buildTypedDocument(kind, normalizedPath, assetSchema.parse(frontmatter), body, rawMarkdown);
    case "context":
      return buildTypedDocument(kind, normalizedPath, contextSchema.parse(frontmatter), body, rawMarkdown);
    case "timeline-main":
    case "resume":
    case "evaluation":
    case "state":
    case "unknown":
      return buildTypedDocument(kind, normalizedPath, frontmatter, body, rawMarkdown);
  }
}

export function serializeNarrariumDocument(document: NarrariumDocument): string {
  return renderMarkdown(document.frontmatter as Record<string, unknown>, document.body);
}

export function buildNarrariumBookSnapshot(input: BuildNarrariumBookSnapshotInput): NarrariumBookSnapshot {
  const snapshot = createEmptyBookSnapshot({
    profileId: input.profileId,
    provider: input.provider,
    branch: input.branch,
    commitSha: input.commitSha,
    ref: input.ref ?? null,
    loadedAt: input.loadedAt,
  });

  const chapterGroups = new Map<string, { chapter?: NarrariumDocument; paragraphs: NarrariumDocument[] }>();
  const draftGroups = new Map<string, { chapter?: NarrariumDocument; paragraphs: NarrariumDocument[] }>();

  for (const file of [...input.documents].sort((left, right) => left.path.localeCompare(right.path))) {
    const document = parseNarrariumMarkdownDocument(file.path, file.rawMarkdown);
    snapshot.documentsByPath[document.path] = document;

    switch (document.kind) {
      case "book":
        snapshot.book = document as typeof snapshot.book;
        break;
      case "plot":
        snapshot.plot = document as typeof snapshot.plot;
        break;
      case "context":
        snapshot.context = document as typeof snapshot.context;
        break;
      case "guideline":
        snapshot.guidelines.push(document as (typeof snapshot.guidelines)[number]);
        break;
      case "character":
        snapshot.characters.push(document as (typeof snapshot.characters)[number]);
        break;
      case "item":
        snapshot.items.push(document as (typeof snapshot.items)[number]);
        break;
      case "location":
        snapshot.locations.push(document as (typeof snapshot.locations)[number]);
        break;
      case "faction":
        snapshot.factions.push(document as (typeof snapshot.factions)[number]);
        break;
      case "secret":
        snapshot.secrets.push(document as (typeof snapshot.secrets)[number]);
        break;
      case "timeline-main":
        snapshot.timelineMain = document as typeof snapshot.timelineMain;
        break;
      case "timeline-event":
        snapshot.timelineEvents.push(document as (typeof snapshot.timelineEvents)[number]);
        break;
      case "chapter":
        registerChapterGroupDocument(chapterGroups, document.path, document, true);
        break;
      case "paragraph":
        registerChapterGroupDocument(chapterGroups, document.path, document, false);
        if (typeof document.frontmatter.id === "string" && document.frontmatter.id.trim()) {
          snapshot.paragraphsById[document.frontmatter.id] = document as (typeof snapshot.paragraphsById)[string];
        }
        break;
      case "chapter-draft":
        registerChapterGroupDocument(draftGroups, document.path, document, true);
        break;
      case "paragraph-draft":
        registerChapterGroupDocument(draftGroups, document.path, document, false);
        break;
      case "resume":
        snapshot.resumes.push(document);
        break;
      case "state":
        snapshot.stateDocuments.push(document);
        break;
      case "evaluation":
        snapshot.evaluations.push(document);
        break;
      case "research-note":
        snapshot.researchNotes.push(document as (typeof snapshot.researchNotes)[number]);
        break;
      case "asset":
        snapshot.assets.push(document as (typeof snapshot.assets)[number]);
        break;
      case "unknown":
        snapshot.otherDocuments.push(document);
        break;
    }
  }

  snapshot.guidelines.sort(compareDocuments);
  snapshot.characters.sort(compareDocuments);
  snapshot.items.sort(compareDocuments);
  snapshot.locations.sort(compareDocuments);
  snapshot.factions.sort(compareDocuments);
  snapshot.secrets.sort(compareDocuments);
  snapshot.timelineEvents.sort(compareDocuments);
  snapshot.resumes.sort(compareDocuments);
  snapshot.stateDocuments.sort(compareDocuments);
  snapshot.evaluations.sort(compareDocuments);
  snapshot.researchNotes.sort(compareDocuments);
  snapshot.assets.sort(compareDocuments);
  snapshot.otherDocuments.sort(compareDocuments);

  snapshot.chapters = finalizeChapterGroups(chapterGroups);
  snapshot.draftChapters = finalizeDraftGroups(draftGroups);

  for (const chapter of snapshot.chapters) {
    snapshot.chaptersBySlug[chapter.slug] = chapter;
  }

  return snapshot;
}

function buildTypedDocument<TFrontmatter>(
  kind: NarrariumDocumentKind,
  path: string,
  frontmatter: TFrontmatter,
  body: string,
  rawMarkdown: string,
): NarrariumDocument<TFrontmatter> {
  return {
    kind,
    path,
    frontmatter,
    body,
    rawMarkdown,
  };
}

function registerChapterGroupDocument(
  groups: Map<string, { chapter?: NarrariumDocument; paragraphs: NarrariumDocument[] }>,
  path: string,
  document: NarrariumDocument,
  isChapter: boolean,
): void {
  const slug = extractChapterSlug(path);
  const entry = groups.get(slug) ?? { paragraphs: [] };

  if (isChapter) {
    entry.chapter = document;
  } else {
    entry.paragraphs.push(document);
  }

  groups.set(slug, entry);
}

function finalizeChapterGroups(
  groups: Map<string, { chapter?: NarrariumDocument; paragraphs: NarrariumDocument[] }>,
): NarrariumChapterSnapshot[] {
  return Array.from(groups.entries())
    .filter(([, entry]) => Boolean(entry.chapter))
    .map(([slug, entry]) => ({
      slug,
      chapter: entry.chapter as NarrariumChapterSnapshot["chapter"],
      paragraphs: entry.paragraphs
        .slice()
        .sort(compareNumberedDocuments) as NarrariumChapterSnapshot["paragraphs"],
    }))
    .sort((left, right) => compareNumberedDocuments(left.chapter, right.chapter));
}

function finalizeDraftGroups(
  groups: Map<string, { chapter?: NarrariumDocument; paragraphs: NarrariumDocument[] }>,
): NarrariumDraftChapterSnapshot[] {
  return Array.from(groups.entries())
    .filter(([, entry]) => Boolean(entry.chapter))
    .map(([slug, entry]) => ({
      slug,
      chapter: entry.chapter as NarrariumDraftChapterSnapshot["chapter"],
      paragraphs: entry.paragraphs
        .slice()
        .sort(compareNumberedDocuments) as NarrariumDraftChapterSnapshot["paragraphs"],
    }))
    .sort((left, right) => compareNumberedDocuments(left.chapter, right.chapter));
}

function extractChapterSlug(path: string): string {
  const normalizedPath = normalizeNarrariumDocumentPath(path);
  const parts = normalizedPath.split("/");
  if (parts.length < 2) {
    throw new Error(`Cannot resolve chapter slug from path: ${path}`);
  }

  return parts[1];
}

function compareDocuments(left: NarrariumDocument, right: NarrariumDocument): number {
  return left.path.localeCompare(right.path);
}

function compareNumberedDocuments(left: NarrariumDocument, right: NarrariumDocument): number {
  return documentNumber(left) - documentNumber(right) || compareDocuments(left, right);
}

function documentNumber(document: NarrariumDocument): number {
  const value = (document.frontmatter as { number?: unknown }).number;
  return typeof value === "number" ? value : Number.MAX_SAFE_INTEGER;
}
