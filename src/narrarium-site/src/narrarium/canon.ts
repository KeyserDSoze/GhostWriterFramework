import { stringify } from "yaml";
import { createFile, mutateTextFilesAtomically } from "@/github/githubClient";
import { validateCanonExtraFrontmatter } from "@/narrarium/canonFrontmatter";

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase();
}

export function formatOrdinal(value: number, width = 3): string {
  return String(value).padStart(width, "0");
}

export function chapterSlug(number: number, title: string): string {
  return `${formatOrdinal(number)}-${slugify(title)}`;
}

export function paragraphSlug(number: number, title: string): string {
  return `${formatOrdinal(number)}-${slugify(title)}`;
}

export type EntityKind =
  | "character"
  | "item"
  | "location"
  | "faction"
  | "secret"
  | "timeline-event";

export const ENTITY_DIRECTORY: Record<EntityKind, string> = {
  character: "characters",
  item: "items",
  location: "locations",
  faction: "factions",
  secret: "secrets",
  "timeline-event": "timelines/events",
};

export const ENTITY_LABEL: Record<EntityKind, string> = {
  character: "Character",
  item: "Item",
  location: "Location",
  faction: "Faction",
  secret: "Secret",
  "timeline-event": "Timeline event",
};

function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = stringify(frontmatter).trimEnd();
  const trimmedBody = body.replace(/^\n+/, "");
  return `---\n${yaml}\n---\n\n${trimmedBody}\n`;
}

function clean(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export interface CreateEntityInput {
  kind: EntityKind;
  label: string;
  summary?: string;
  body?: string;
  extraFrontmatter?: Record<string, unknown>;
}

export interface CreatedFile {
  path: string;
  id: string;
  slug: string;
}

export function buildCanonEntityDocument(input: CreateEntityInput): CreatedFile & { content: string } {
  const slug = slugify(input.label);
  if (!slug) throw new Error("A valid name or title is required.");
  const path = `${ENTITY_DIRECTORY[input.kind]}/${slug}.md`;
  const id = `${input.kind}:${slug}`;
  const nameField = input.kind === "secret" || input.kind === "timeline-event" ? { title: input.label } : { name: input.label };
  const validatedExtra = validateCanonExtraFrontmatter(input.kind, input.extraFrontmatter);
  const frontmatter = clean({ ...validatedExtra, type: input.kind, id, canon: "draft", ...nameField });
  const body = input.body?.trim() ? `${input.body.trim()}\n` : input.summary?.trim() ? `${input.summary.trim()}\n` : defaultEntityBody(input.kind, input.label);
  return { path, id, slug, content: renderMarkdown(frontmatter, body) };
}

export async function createCanonEntity(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: CreateEntityInput,
): Promise<CreatedFile> {
  const document = buildCanonEntityDocument(input);
  await createFile(token, owner, repo, branch, document.path, document.content, `Add ${input.kind} ${input.label}`);
  return { path: document.path, id: document.id, slug: document.slug };
}

function defaultEntityBody(kind: EntityKind, label: string): string {
  switch (kind) {
    case "character":
      return `# ${label}\n\nDescribe this character: voice, role, background, and function in the book.\n`;
    case "location":
      return `# ${label}\n\nDescribe this location: atmosphere, story function, landmarks, and risks.\n`;
    case "faction":
      return `# ${label}\n\nDescribe this faction: mission, ideology, methods, and alliances.\n`;
    case "item":
      return `# ${label}\n\nDescribe this item: appearance, purpose, significance, and ownership.\n`;
    case "secret":
      return `# ${label}\n\nDescribe this secret: stakes, holders, protection, and reveal strategy.\n`;
    case "timeline-event":
      return `# ${label}\n\nDescribe this event: participants, significance, and consequences.\n`;
  }
}

export interface CreateChapterInput {
  number: number;
  title: string;
  summary?: string;
  pov?: string[];
  body?: string;
}

export interface CreatedChapter {
  slug: string;
  id: string;
  chapterFilePath: string;
  changedPaths: string[];
}

export interface GeneratedDocument { path: string; content: string }

export function chapterCreationPaths(slug: string): [string, string, string] {
  return [
    `chapters/${slug}/chapter.md`,
    `resumes/chapters/${slug}.md`,
    `evaluations/chapters/${slug}.md`,
  ];
}

export function buildChapterDocuments(input: CreateChapterInput): CreatedChapter & { documents: GeneratedDocument[] } {
  const slug = chapterSlug(input.number, input.title);
  const id = `chapter:${slug}`;
  const [chapterFilePath, resumePath, evaluationPath] = chapterCreationPaths(slug);
  const frontmatter = clean({ type: "chapter", id, number: input.number, title: input.title, canon: "draft", summary: input.summary, pov: input.pov });
  const body = input.body?.trim() ? `${input.body.trim()}\n` : `# ${input.title}\n\nStart the chapter here.\n`;
  return {
    slug,
    id,
    chapterFilePath,
    changedPaths: [chapterFilePath, resumePath, evaluationPath],
    documents: [
      { path: chapterFilePath, content: renderMarkdown(frontmatter, body) },
      { path: resumePath, content: renderMarkdown({ type: "resume", id: `resume:chapter:${slug}`, title: `Resume ${slug}` }, "# Summary\n\nSummarize the chapter here.\n") },
      { path: evaluationPath, content: renderMarkdown({ type: "evaluation", id: `evaluation:chapter:${slug}`, title: `Evaluation ${slug}` }, "# Evaluation\n\nEvaluate the chapter here.\n") },
    ],
  };
}

export async function createChapter(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: CreateChapterInput,
): Promise<CreatedChapter> {
  const generated = buildChapterDocuments(input);
  await mutateTextFilesAtomically(token, owner, repo, branch, generated.documents.map((document) => ({ path: document.path, content: document.content, expectedCurrentHash: null })), `Add chapter ${formatOrdinal(input.number)}: ${input.title}`);
  return { slug: generated.slug, id: generated.id, chapterFilePath: generated.chapterFilePath, changedPaths: generated.changedPaths };
}

export interface CreateParagraphInput {
  chapterSlug: string;
  number: number;
  title: string;
  body?: string;
  summary?: string;
}

export interface CreatedParagraph {
  slug: string;
  id: string;
  paragraphFilePath: string;
}

export function buildParagraphDocument(input: CreateParagraphInput): CreatedParagraph & { content: string } {
  const slug = paragraphSlug(input.number, input.title);
  const id = `paragraph:${input.chapterSlug}:${slug}`;
  const paragraphFilePath = `chapters/${input.chapterSlug}/${slug}.md`;
  const frontmatter = clean({ type: "paragraph", id, chapter: `chapter:${input.chapterSlug}`, number: input.number, title: input.title, canon: "draft", summary: input.summary });
  const body = input.body?.trim() ? `${input.body.trim()}\n` : `# ${input.title}\n\nStart the paragraph here.\n`;
  return { slug, id, paragraphFilePath, content: renderMarkdown(frontmatter, body) };
}

export async function createParagraphDocument(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: CreateParagraphInput,
): Promise<CreatedParagraph> {
  const document = buildParagraphDocument(input);
  await createFile(token, owner, repo, branch, document.paragraphFilePath, document.content, `Add paragraph ${document.slug}`);
  return { slug: document.slug, id: document.id, paragraphFilePath: document.paragraphFilePath };
}
