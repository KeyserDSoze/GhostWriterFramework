import { stringify } from "yaml";
import { createFile } from "@/github/githubClient";

// ─── Slug / id helpers (mirror packages/core utils) ──────────────────────────

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

// ─── Canon entity kinds ──────────────────────────────────────────────────────

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

/** Build a markdown document from frontmatter + body. */
function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = stringify(frontmatter).trimEnd();
  const trimmedBody = body.replace(/^\n+/, "");
  return `---\n${yaml}\n---\n\n${trimmedBody}\n`;
}

/** Remove undefined/empty values so frontmatter stays clean. */
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

// ─── Entity creation ─────────────────────────────────────────────────────────

export interface CreateEntityInput {
  kind: EntityKind;
  /** Name (character/item/location/faction) or title (secret/timeline-event). */
  label: string;
  summary?: string;
  extraFrontmatter?: Record<string, unknown>;
}

export interface CreatedFile {
  path: string;
  id: string;
  slug: string;
}

export async function createCanonEntity(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: CreateEntityInput,
): Promise<CreatedFile> {
  const slug = slugify(input.label);
  if (!slug) throw new Error("A valid name or title is required.");

  const directory = ENTITY_DIRECTORY[input.kind];
  const path = `${directory}/${slug}.md`;
  const id = `${input.kind}:${slug}`;

  const nameField =
    input.kind === "secret" || input.kind === "timeline-event"
      ? { title: input.label }
      : { name: input.label };

  const frontmatter = clean({
    type: input.kind,
    id,
    canon: "draft",
    ...nameField,
    ...(input.extraFrontmatter ?? {}),
  });

  const body = input.summary?.trim()
    ? `${input.summary.trim()}\n`
    : defaultEntityBody(input.kind, input.label);

  await createFile(
    token,
    owner,
    repo,
    branch,
    path,
    renderMarkdown(frontmatter, body),
    `Add ${input.kind} ${input.label}`,
  );

  return { path, id, slug };
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

// ─── Chapter creation ────────────────────────────────────────────────────────

export interface CreateChapterInput {
  number: number;
  title: string;
  summary?: string;
  pov?: string[];
}

export interface CreatedChapter {
  slug: string;
  id: string;
  chapterFilePath: string;
}

export async function createChapter(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: CreateChapterInput,
): Promise<CreatedChapter> {
  const slug = chapterSlug(input.number, input.title);
  const id = `chapter:${slug}`;
  const chapterFilePath = `chapters/${slug}/chapter.md`;

  const frontmatter = clean({
    type: "chapter",
    id,
    number: input.number,
    title: input.title,
    canon: "draft",
    summary: input.summary,
    pov: input.pov,
  });

  const body = `# ${input.title}\n\nStart the chapter here.\n`;

  await createFile(
    token,
    owner,
    repo,
    branch,
    chapterFilePath,
    renderMarkdown(frontmatter, body),
    `Add chapter ${formatOrdinal(input.number)}: ${input.title}`,
  );

  // Paired resume + evaluation stubs, mirroring the MCP createChapter behaviour.
  await createFile(
    token,
    owner,
    repo,
    branch,
    `resumes/chapters/${slug}.md`,
    renderMarkdown(
      { type: "resume", id: `resume:chapter:${slug}`, title: `Resume ${slug}` },
      "# Summary\n\nSummarize the chapter here.\n",
    ),
    `Add resume for chapter ${slug}`,
  ).catch(() => undefined);

  await createFile(
    token,
    owner,
    repo,
    branch,
    `evaluations/chapters/${slug}.md`,
    renderMarkdown(
      { type: "evaluation", id: `evaluation:chapter:${slug}`, title: `Evaluation ${slug}` },
      "# Evaluation\n\nEvaluate the chapter here.\n",
    ),
    `Add evaluation for chapter ${slug}`,
  ).catch(() => undefined);

  return { slug, id, chapterFilePath };
}
