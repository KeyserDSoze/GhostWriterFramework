import { stringify } from "yaml";
import { createFile } from "@/github/githubClient";

export function slugifyNote(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase()
    .slice(0, 60);
}

function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.replace(/^\n+/, "").trimEnd()}\n`;
}

export interface CreateNoteInput {
  title: string;
  body: string;
}

export interface CreatedNote {
  path: string;
  slug: string;
  title: string;
}

/** Create a quick personal note as notes/<slug>.md. */
export async function createNote(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: CreateNoteInput,
): Promise<CreatedNote> {
  const title = input.title.trim() || "Untitled note";
  const base = slugifyNote(title) || "note";
  const now = new Date().toISOString();
  const slug = `${now.slice(0, 10)}-${base}`;
  const path = `notes/${slug}.md`;
  const frontmatter = {
    type: "note",
    id: `note:${slug}`,
    title,
    createdAt: now,
    updatedAt: now,
  };
  await createFile(token, owner, repo, branch, path, renderMarkdown(frontmatter, input.body), `Add note: ${title}`);
  return { path, slug, title };
}

export function renderNoteMarkdown(frontmatterRaw: string, body: string): string {
  return frontmatterRaw.trim() ? `---\n${frontmatterRaw.trim()}\n---\n\n${body.replace(/^\n+/, "")}` : body;
}

export function updateNoteFrontmatterField(frontmatterRaw: string, field: string, value: string): string {
  if (!frontmatterRaw.trim()) return frontmatterRaw;
  const regex = new RegExp(`^${field}:.*$`, "m");
  const escaped = JSON.stringify(value);
  if (regex.test(frontmatterRaw)) return frontmatterRaw.replace(regex, `${field}: ${escaped}`);
  return `${frontmatterRaw.trim()}\n${field}: ${escaped}`;
}
