import {
  readFileWithSha,
  createOrUpdateTextFile,
} from "@/github/githubClient";
import { parseDocument, stringify } from "yaml";

export interface DraftFinalContext {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  chapterSlug: string;
  chapterPath: string;
  paragraphNumber: number;
  /** Final paragraph markdown path (chapters/<chapter>/NNN-slug.md). */
  finalPath: string;
  /** Draft markdown path; if omitted it is derived from the final path. */
  draftPath?: string;
  /** Paragraph title used when a header must be (re)built. */
  title: string;
}

export type SwitchOutcome =
  | { action: "promoted-to-final" }
  | { action: "promoted-to-draft" }
  | { action: "swapped" }
  | { action: "noop"; reason: "both-empty" | "source-empty" };

interface DocParts {
  frontmatter: Record<string, unknown>;
  body: string;
  exists: boolean;
}

function paragraphSlug(finalPath: string): string {
  return (finalPath.split("/").pop() ?? "").replace(/\.md$/i, "");
}

function splitDoc(raw: string): { fm: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { fm: {}, body: raw.trim() };
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseDocument(match[1]).toJSON();
    if (parsed && typeof parsed === "object") fm = parsed as Record<string, unknown>;
  } catch {
    fm = {};
  }
  return { fm, body: (match[2] ?? "").trim() };
}

async function readDoc(ctx: DraftFinalContext, path: string): Promise<DocParts> {
  try {
    const { content } = await readFileWithSha(ctx.token, ctx.owner, ctx.repo, ctx.branch, path);
    const { fm, body } = splitDoc(content);
    return { frontmatter: fm, body, exists: true };
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && (err as { status?: number }).status === 404) {
      return { frontmatter: {}, body: "", exists: false };
    }
    throw err;
  }
}

function isEmpty(doc: DocParts): boolean {
  return !doc.exists || doc.body.trim().length === 0;
}

/** Canonical frontmatter for a FINAL paragraph, preserving optional ghostwriter/title. */
function finalFrontmatter(ctx: DraftFinalContext, slug: string, source: Record<string, unknown>): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    type: "paragraph",
    id: `paragraph:${ctx.chapterSlug}:${slug}`,
    chapter: `chapter:${ctx.chapterSlug}`,
    number: ctx.paragraphNumber,
    title: (source.title as string) || ctx.title,
  };
  if (source.ghostwriter) fm.ghostwriter = source.ghostwriter;
  return fm;
}

/** Canonical frontmatter for a DRAFT paragraph, preserving optional ghostwriter/title. */
function draftFrontmatter(ctx: DraftFinalContext, slug: string, source: Record<string, unknown>): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    type: "paragraph-draft",
    id: `draft:paragraph:${ctx.chapterSlug}:${slug}`,
    paragraph: `paragraph:${ctx.chapterSlug}:${slug}`,
    chapter: `chapter:${ctx.chapterSlug}`,
    number: ctx.paragraphNumber,
    title: (source.title as string) || ctx.title,
    canon: "draft",
  };
  if (source.ghostwriter) fm.ghostwriter = source.ghostwriter;
  return fm;
}

function buildDoc(fm: Record<string, unknown>, body: string): string {
  return `---\n${stringify(fm).trim()}\n---\n\n${body.trim()}\n`;
}

/**
 * Move/swap prose between a paragraph's draft and its final file.
 *
 * - If the destination is empty, the source prose is copied there (source kept intact).
 * - If both sides have prose, their bodies are swapped; each file keeps the canonical
 *   header for its own type so both remain valid draft/final files.
 *
 * @param direction "toFinal" moves the draft into the final; "toDraft" moves the final into the draft.
 */
export async function switchDraftAndFinal(
  ctx: DraftFinalContext,
  direction: "toFinal" | "toDraft",
): Promise<SwitchOutcome> {
  const slug = paragraphSlug(ctx.finalPath);
  const draftPath = ctx.draftPath ?? `${ctx.chapterPath}/drafts/${slug}.md`;
  const finalPath = ctx.finalPath;

  const [draft, final] = await Promise.all([readDoc(ctx, draftPath), readDoc(ctx, finalPath)]);

  const draftEmpty = isEmpty(draft);
  const finalEmpty = isEmpty(final);

  if (draftEmpty && finalEmpty) return { action: "noop", reason: "both-empty" };

  const source = direction === "toFinal" ? draft : final;
  const dest = direction === "toFinal" ? final : draft;

  // Never overwrite a non-empty target with an empty source.
  if (isEmpty(source)) return { action: "noop", reason: "source-empty" };

  // Destination empty → promote (copy source prose, leave source intact).
  if (isEmpty(dest)) {
    if (direction === "toFinal") {
      await createOrUpdateTextFile(
        ctx.token, ctx.owner, ctx.repo, ctx.branch, finalPath,
        buildDoc(finalFrontmatter(ctx, slug, source.frontmatter), source.body),
        `Promote draft to final: ${finalPath}`,
      );
      return { action: "promoted-to-final" };
    }
    await createOrUpdateTextFile(
      ctx.token, ctx.owner, ctx.repo, ctx.branch, draftPath,
      buildDoc(draftFrontmatter(ctx, slug, source.frontmatter), source.body),
      `Copy final to draft: ${draftPath}`,
    );
    return { action: "promoted-to-draft" };
  }

  // Both non-empty → swap bodies, keeping each file's canonical header.
  await Promise.all([
    createOrUpdateTextFile(
      ctx.token, ctx.owner, ctx.repo, ctx.branch, finalPath,
      buildDoc(finalFrontmatter(ctx, slug, draft.frontmatter), draft.body),
      `Swap draft/final: ${finalPath}`,
    ),
    createOrUpdateTextFile(
      ctx.token, ctx.owner, ctx.repo, ctx.branch, draftPath,
      buildDoc(draftFrontmatter(ctx, slug, final.frontmatter), final.body),
      `Swap draft/final: ${draftPath}`,
    ),
  ]);
  return { action: "swapped" };
}
