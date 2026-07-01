import { parseDocument, stringify } from "yaml";
import { readFileWithSha, updateFile } from "@/github/githubClient";
import { summarizeParagraphBody, summarizeChapterFromParagraphs, stripFrontmatter, type PipelineSource } from "@/narrarium/pipeline";
import type { AppSettings } from "@/types/settings";
import type { BookStructure, Chapter } from "@/types/book";

interface Ctx {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  settings: AppSettings;
  structure: BookStructure;
  chapter: Chapter;
}

function src(ctx: Ctx): PipelineSource {
  return { token: ctx.token, owner: ctx.owner, repo: ctx.repo, branch: ctx.branch, settings: ctx.settings, structure: ctx.structure, chapter: ctx.chapter };
}

function splitDoc(raw: string): { fm: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { fm: {}, body: raw };
  const doc = parseDocument(match[1]);
  return { fm: (doc.toJSON() as Record<string, unknown>) ?? {}, body: match[2] };
}

function joinDoc(fm: Record<string, unknown>, body: string): string {
  return `---\n${stringify(fm).trimEnd()}\n---\n\n${body.trim()}\n`;
}

async function writeSummary(ctx: Ctx, path: string, summary: string): Promise<void> {
  const { content, sha } = await readFileWithSha(ctx.token, ctx.owner, ctx.repo, ctx.branch, path);
  const { fm, body } = splitDoc(content);
  fm.summary = summary;
  await updateFile(ctx.token, ctx.owner, ctx.repo, ctx.branch, path, sha, joinDoc(fm, body), `Update summary: ${path}`);
}

export interface SummaryProposal {
  title: string;
  oldSummary: string;
  newSummary: string;
  apply: () => Promise<void>;
}

/** Generate a paragraph summary from its body; returns old/new + apply(). */
export async function proposeParagraphSummary(ctx: Ctx, paragraphNumber: string): Promise<SummaryProposal> {
  const paragraph = ctx.chapter.paragraphs.find((p) => p.number === paragraphNumber);
  if (!paragraph) throw new Error("Paragraph not found");
  const { content } = await readFileWithSha(ctx.token, ctx.owner, ctx.repo, ctx.branch, paragraph.path);
  const { fm } = splitDoc(content);
  const oldSummary = typeof fm.summary === "string" ? fm.summary : "";
  const newSummary = await summarizeParagraphBody(src(ctx), stripFrontmatter(content));
  return {
    title: paragraph.title,
    oldSummary,
    newSummary,
    apply: async () => { await writeSummary(ctx, paragraph.path, newSummary); },
  };
}

/**
 * Generate a chapter summary by aggregating paragraph summaries.
 * Missing paragraph summaries are generated from the paragraph body (and saved back).
 */
export async function proposeChapterSummary(ctx: Ctx): Promise<SummaryProposal> {
  const chapterMdPath = `${ctx.chapter.path}/chapter.md`;
  const parts: Array<{ title: string; summary: string }> = [];
  const toSave: Array<{ path: string; summary: string }> = [];

  for (const paragraph of ctx.chapter.paragraphs) {
    let content = "";
    try { content = (await readFileWithSha(ctx.token, ctx.owner, ctx.repo, ctx.branch, paragraph.path)).content; } catch { content = ""; }
    const { fm } = splitDoc(content);
    let summary = typeof fm.summary === "string" ? fm.summary.trim() : "";
    if (!summary && content.trim()) {
      summary = await summarizeParagraphBody(src(ctx), stripFrontmatter(content));
      toSave.push({ path: paragraph.path, summary });
    }
    if (summary) parts.push({ title: paragraph.title, summary });
  }

  const newSummary = parts.length
    ? await summarizeChapterFromParagraphs(src(ctx), parts)
    : "";

  let oldSummary = "";
  try {
    const { content } = await readFileWithSha(ctx.token, ctx.owner, ctx.repo, ctx.branch, chapterMdPath);
    const { fm } = splitDoc(content);
    oldSummary = typeof fm.summary === "string" ? fm.summary : "";
  } catch { /* no chapter.md yet */ }

  return {
    title: ctx.chapter.title,
    oldSummary,
    newSummary,
    apply: async () => {
      // Persist any freshly-generated paragraph summaries, then the chapter summary.
      for (const item of toSave) {
        await writeSummary(ctx, item.path, item.summary);
      }
      await writeSummary(ctx, chapterMdPath, newSummary);
    },
  };
}
