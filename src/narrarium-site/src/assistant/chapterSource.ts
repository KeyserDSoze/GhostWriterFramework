import type { Chapter } from "@/types/book";
import type { LoadedWriterContext } from "@/assistant/context";

export interface LoadedChapterPart { path: string; title: string; content: string; }

export async function loadCompleteChapterSource(chapter: Chapter, load: (path: string) => Promise<string>): Promise<LoadedChapterPart[]> {
  const requested = [{ path: `${chapter.path}/chapter.md`, title: chapter.title }, ...chapter.paragraphs.map((paragraph) => ({ path: paragraph.path, title: paragraph.title }))];
  const settled = await Promise.allSettled(requested.map(async (entry) => ({ ...entry, content: await load(entry.path) })));
  const failures = settled.flatMap((result, index) => result.status === "rejected" ? [requested[index].path] : []);
  if (failures.length) throw new Error(`Could not load complete chapter source: ${failures.join(", ")}`);
  return settled.map((result) => (result as PromiseFulfilledResult<LoadedChapterPart>).value);
}

export function buildChapterResumeChunks(parts: LoadedChapterPart[], maxChars = 30_000): LoadedChapterPart[][] {
  const expanded = parts.flatMap((part) => part.content.length <= maxChars
    ? [part]
    : Array.from({ length: Math.ceil(part.content.length / maxChars) }, (_, index) => ({
        ...part,
        title: `${part.title} [part ${index + 1}]`,
        content: part.content.slice(index * maxChars, (index + 1) * maxChars),
      })));
  const chunks: LoadedChapterPart[][] = [];
  let current: LoadedChapterPart[] = [];
  let size = 0;
  for (const part of expanded) {
    if (current.length && size + part.content.length > maxChars) { chunks.push(current); current = []; size = 0; }
    current.push(part); size += part.content.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function mergeResumeFrontmatter(existing: Record<string, unknown>, chapterSlug: string): Record<string, unknown> {
  return { ...existing, type: "resume", id: `resume:chapter:${chapterSlug}`, title: `Resume ${chapterSlug}` };
}

export function resolveResumeChapter(context: Pick<LoadedWriterContext, "chapter">): Chapter | null { return context.chapter; }
