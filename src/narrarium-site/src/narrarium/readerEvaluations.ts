import { parseDocument, stringify } from "yaml";
import { completeToolRouted } from "@/assistant/router";
import type { LlmRunMetadata } from "@/assistant/llm";
import { createFile, deleteFile, loadFileContent, readFileWithSha, updateFile } from "@/github/githubClient";
import type { BookStructure } from "@/types/book";
import type { AppSettings, BookEntry } from "@/types/settings";
import { builtinReaderPersonas, mergeReaderPersonas, parseReaderPersona, readerPersonaSystemPrompt, serializeReaderPersona, type ReaderEvaluationDepth, type ReaderPersonaProfile } from "@/narrarium/readerPersona";

export type ReaderEvaluationTargetType = "chapter" | "paragraph" | "selection";

export interface ReaderEvaluationTarget {
  type: ReaderEvaluationTargetType;
  bookId: string;
  chapterId: string;
  paragraphId?: string;
  title: string;
  text: string;
  sourcePath: string;
  sourceVersion: string;
}

export interface ReaderEvaluationOutput {
  generalImpression: string;
  strengths: string[];
  weaknesses: string[];
  mostEffectiveMoment: string;
  mainProblem: string;
  prioritySuggestion: string;
  score: number;
  additionalNotes?: string;
}

export interface ReaderEvaluationRecord {
  path: string;
  id: string;
  targetType: ReaderEvaluationTargetType;
  targetId: string;
  readerId: string;
  readerName: string;
  readerType: string;
  createdAt: string;
  sourceContentHash: string;
  sourceContentVersion: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  score?: number;
  body: string;
  stale?: boolean;
  error?: string;
}

export interface ReaderEvaluationProgress {
  readerId: string;
  readerName: string;
  status: ReaderEvaluationRecord["status"];
  completed: number;
  total: number;
  error?: string;
}

const EVALUATION_TOOL = {
  name: "reader_evaluation",
  description: "Return a concise simulated-reader evaluation from the configured reader's point of view.",
  parameters: {
    type: "object",
    properties: {
      generalImpression: { type: "string" },
      strengths: { type: "array", items: { type: "string" } },
      weaknesses: { type: "array", items: { type: "string" } },
      mostEffectiveMoment: { type: "string" },
      mainProblem: { type: "string" },
      prioritySuggestion: { type: "string" },
      score: { type: "number", minimum: 1, maximum: 10 },
      additionalNotes: { type: "string" },
    },
    required: ["generalImpression", "strengths", "weaknesses", "mostEffectiveMoment", "mainProblem", "prioritySuggestion", "score"],
    additionalProperties: false,
  },
};

const SUMMARY_TOOL = {
  name: "reader_evaluation_summary",
  description: "Compare separate simulated-reader evaluations and return a concise panel summary.",
  parameters: {
    type: "object",
    properties: {
      consensus: { type: "array", items: { type: "string" } },
      disagreements: { type: "array", items: { type: "string" } },
      recurringStrengths: { type: "array", items: { type: "string" } },
      recurringProblems: { type: "array", items: { type: "string" } },
      prioritySuggestions: { type: "array", items: { type: "string" } },
      isolatedObservations: { type: "array", items: { type: "string" } },
      revisionPriorities: { type: "array", items: { type: "string" } },
      overallScore: { type: "number", minimum: 1, maximum: 10 },
    },
    required: ["consensus", "disagreements", "recurringStrengths", "recurringProblems", "prioritySuggestions", "isolatedObservations", "revisionPriorities", "overallScore"],
    additionalProperties: false,
  },
};

export async function loadReaderPersonas(input: { token: string; book: BookEntry; branch: string; structure: BookStructure }): Promise<ReaderPersonaProfile[]> {
  const overrides = await Promise.all(input.structure.readerPersonas.map(async (entry) => {
    const raw = await loadFileContent(input.token, input.book.owner, input.book.repo, entry.path, input.branch).catch(() => "");
    return raw ? parseReaderPersona(entry.slug, raw) : null;
  }));
  return mergeReaderPersonas(input.structure.language, overrides.filter((profile): profile is ReaderPersonaProfile => Boolean(profile)));
}

export async function saveReaderPersona(input: { token: string; book: BookEntry; branch: string; profile: ReaderPersonaProfile }): Promise<string> {
  const path = `personas/${input.profile.slug}.md`;
  const content = serializeReaderPersona({ ...input.profile, path });
  try {
    const existing = await readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, path);
    await updateFile(input.token, input.book.owner, input.book.repo, input.branch, path, existing.sha, content, `Update simulated reader ${input.profile.name}`);
  } catch {
    await createFile(input.token, input.book.owner, input.book.repo, input.branch, path, content, `Add simulated reader ${input.profile.name}`);
  }
  return path;
}

export async function deleteReaderPersonaOverride(input: { token: string; book: BookEntry; branch: string; profile: ReaderPersonaProfile }): Promise<void> {
  const path = input.profile.path ?? `personas/${input.profile.slug}.md`;
  const existing = await readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, path).catch(() => null);
  if (existing) await deleteFile(input.token, input.book.owner, input.book.repo, input.branch, path, existing.sha, `Remove simulated reader ${input.profile.name}`);
}

export async function hashReaderSource(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function targetPathParts(target: ReaderEvaluationTarget): string[] {
  if (target.type === "chapter") return ["chapters", target.chapterId];
  if (target.type === "paragraph") return ["paragraphs", target.chapterId, target.paragraphId ?? "unknown"];
  return ["selections", target.chapterId, target.paragraphId ?? "chapter"];
}

function evaluationPath(target: ReaderEvaluationTarget, reader: ReaderPersonaProfile): string {
  return ["evaluations", "readers", ...targetPathParts(target), `${reader.slug}.md`].join("/");
}

export function readerEvaluationPath(target: ReaderEvaluationTarget, reader: ReaderPersonaProfile): string {
  return evaluationPath(target, reader);
}

function legacyEvaluationPrefix(target: ReaderEvaluationTarget, reader: ReaderPersonaProfile): string {
  return ["evaluations", "readers", ...targetPathParts(target), reader.slug, ""].join("/");
}

function summaryPath(target: ReaderEvaluationTarget): string {
  const parts = targetPathParts(target);
  const leaf = parts.pop() ?? "summary";
  return ["evaluations", "readers", "summaries", ...parts, `${leaf}.md`].join("/");
}

function renderEvaluationBody(output: ReaderEvaluationOutput, language: string): string {
  const it = language.toLowerCase().startsWith("it");
  const labels = it
    ? ["Valutazione", "Impressione generale", "Punti di forza", "Punti di debolezza", "Momento più efficace", "Problema principale", "Suggerimento prioritario", "Punteggio", "Osservazioni aggiuntive"]
    : ["Evaluation", "General impression", "Strengths", "Weaknesses", "Most effective moment", "Main problem", "Priority suggestion", "Score", "Additional notes"];
  return [
    `# ${labels[0]}`,
    `\n## ${labels[1]}\n\n${output.generalImpression}`,
    `\n## ${labels[2]}\n\n${output.strengths.map((value) => `- ${value}`).join("\n")}`,
    `\n## ${labels[3]}\n\n${output.weaknesses.map((value) => `- ${value}`).join("\n")}`,
    `\n## ${labels[4]}\n\n${output.mostEffectiveMoment}`,
    `\n## ${labels[5]}\n\n${output.mainProblem}`,
    `\n## ${labels[6]}\n\n${output.prioritySuggestion}`,
    `\n## ${labels[7]}\n\n${output.score}/10`,
    output.additionalNotes ? `\n## ${labels[8]}\n\n${output.additionalNotes}` : "",
  ].filter(Boolean).join("\n").trim() + "\n";
}

function renderSummaryBody(output: Record<string, unknown>, language: string): string {
  const it = language.toLowerCase().startsWith("it");
  const sections: Array<[string, string]> = it
    ? [["consensus", "Convergenze"], ["disagreements", "Disaccordi"], ["recurringStrengths", "Punti di forza ricorrenti"], ["recurringProblems", "Problemi ricorrenti"], ["prioritySuggestions", "Suggerimenti prioritari"], ["isolatedObservations", "Osservazioni isolate"], ["revisionPriorities", "Priorità di revisione"]]
    : [["consensus", "Consensus"], ["disagreements", "Disagreements"], ["recurringStrengths", "Recurring strengths"], ["recurringProblems", "Recurring problems"], ["prioritySuggestions", "Priority suggestions"], ["isolatedObservations", "Isolated observations"], ["revisionPriorities", "Revision priorities"]];
  const lines = [`# ${it ? "Sintesi dei lettori simulati" : "Simulated readers summary"}`];
  for (const [key, label] of sections) {
    const values = Array.isArray(output[key]) ? output[key] as unknown[] : [];
    lines.push(`\n## ${label}\n\n${values.map((value) => `- ${String(value)}`).join("\n") || "-"}`);
  }
  lines.push(`\n## ${it ? "Punteggio complessivo" : "Overall score"}\n\n${Number(output.overallScore ?? 0)}/10`);
  return lines.join("\n").trim() + "\n";
}

function renderFile(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}

function createdAtFromFile(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return fallback;
  try {
    const frontmatter = (parseDocument(match[1]).toJSON() as Record<string, unknown> | null) ?? {};
    return typeof frontmatter.createdAt === "string" ? frontmatter.createdAt : fallback;
  } catch { return fallback; }
}

async function writeStableFile(input: { token: string; book: BookEntry; branch: string; path: string; content: string; message: string; existing?: { sha: string } | null }): Promise<void> {
  if (input.existing) await updateFile(input.token, input.book.owner, input.book.repo, input.branch, input.path, input.existing.sha, input.content, input.message);
  else await createFile(input.token, input.book.owner, input.book.repo, input.branch, input.path, input.content, input.message);
}

async function limitedMap<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = { status: "fulfilled", value: await run(items[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  });
  await Promise.all(workers);
  return results;
}

async function optionalContext(input: { token: string; book: BookEntry; branch: string; structure: BookStructure; target: ReaderEvaluationTarget; includeContext?: boolean }): Promise<string> {
  if (!input.includeContext) return "";
  const style = input.structure.globalWritingStylePath ? await loadFileContent(input.token, input.book.owner, input.book.repo, input.structure.globalWritingStylePath, input.branch).catch(() => "") : "";
  const resume = await loadFileContent(input.token, input.book.owner, input.book.repo, `resumes/chapters/${input.target.chapterId}.md`, input.branch).catch(() => "");
  const canon = [
    ...input.structure.characters.map((entry) => entry.name ?? entry.path),
    ...input.structure.locations.map((entry) => entry.name ?? entry.path),
    ...input.structure.items.map((entry) => entry.name ?? entry.path),
    ...input.structure.factions.map((entry) => entry.name ?? entry.path),
  ].slice(0, 80).join(", ");
  return [style ? `WRITING STYLE:\n${style}` : "", resume ? `CHAPTER RESUME:\n${resume}` : "", canon ? `RELEVANT CANON MANIFEST:\n${canon}` : ""].filter(Boolean).join("\n\n");
}

export async function runReaderEvaluations(input: {
  token: string;
  book: BookEntry;
  branch: string;
  structure: BookStructure;
  settings: AppSettings;
  target: ReaderEvaluationTarget;
  readers: ReaderPersonaProfile[];
  depth: ReaderEvaluationDepth;
  language?: string;
  includeContext?: boolean;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ReaderEvaluationProgress) => void;
}): Promise<{ completed: ReaderEvaluationRecord[]; failed: ReaderEvaluationRecord[] }> {
  const outputLanguage = input.language || input.structure.language || input.settings.ui.language || "en";
  const sourceHash = await hashReaderSource(input.target.text);
  const context = await optionalContext(input);
  let completedCount = 0;
  const records = await limitedMap(input.readers.filter((reader) => reader.enabled), input.concurrency ?? 2, async (reader) => {
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    input.onProgress?.({ readerId: reader.id, readerName: reader.name, status: "running", completed: completedCount, total: input.readers.length });
    const updatedAt = new Date().toISOString();
    const path = evaluationPath(input.target, reader);
    const existing = await readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, path).catch(() => null);
    const createdAt = createdAtFromFile(existing?.content, updatedAt);
    try {
      const result = await completeToolRouted<ReaderEvaluationOutput>(input.settings, [
        { role: "system", content: readerPersonaSystemPrompt(reader, outputLanguage, input.depth) },
        { role: "user", content: [`TARGET: ${input.target.type} — ${input.target.title}`, context, `TEXT TO EVALUATE:\n${input.target.text}`].filter(Boolean).join("\n\n") },
      ], "reader-evaluation", EVALUATION_TOOL, { signal: input.signal, label: `reader-evaluation:${reader.slug}` });
      const id = `reader-evaluation:${input.target.type}:${input.target.chapterId}:${input.target.paragraphId ?? "chapter"}:${reader.slug}`;
      const frontmatter = evaluationFrontmatter({ id, createdAt, updatedAt, input, reader, sourceHash, status: "completed", score: result.output.score, generation: result.metadata });
      await writeStableFile({ token: input.token, book: input.book, branch: input.branch, path, existing, content: renderFile(frontmatter, renderEvaluationBody(result.output, outputLanguage)), message: `Update reader evaluation ${reader.name}: ${input.target.title}` });
      const legacyPrefix = legacyEvaluationPrefix(input.target, reader);
      for (const legacy of input.structure.readerEvaluationFiles.filter((file) => file.path.startsWith(legacyPrefix))) {
        const old = await readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, legacy.path).catch(() => null);
        if (old) await deleteFile(input.token, input.book.owner, input.book.repo, input.branch, legacy.path, old.sha, `Remove legacy reader evaluation ${reader.name}`).catch(() => undefined);
      }
      completedCount += 1;
      const record: ReaderEvaluationRecord = { path, id, targetType: input.target.type, targetId: targetId(input.target), readerId: reader.id, readerName: reader.name, readerType: reader.readerType, createdAt, sourceContentHash: sourceHash, sourceContentVersion: input.target.sourceVersion, status: "completed", score: result.output.score, body: renderEvaluationBody(result.output, outputLanguage), stale: false };
      input.onProgress?.({ readerId: reader.id, readerName: reader.name, status: "completed", completed: completedCount, total: input.readers.length });
      return record;
    } catch (err) {
      completedCount += 1;
      const error = err instanceof Error ? err.message : String(err);
      const id = `reader-evaluation:${input.target.type}:${input.target.chapterId}:${input.target.paragraphId ?? "chapter"}:${reader.slug}`;
      const frontmatter = evaluationFrontmatter({ id, createdAt, updatedAt, input, reader, sourceHash, status: input.signal?.aborted ? "cancelled" : "failed", error });
      if (!existing) await createFile(input.token, input.book.owner, input.book.repo, input.branch, path, renderFile(frontmatter, `# Evaluation failed\n\n${error}`), `Record failed reader evaluation ${reader.name}`).catch(() => undefined);
      input.onProgress?.({ readerId: reader.id, readerName: reader.name, status: input.signal?.aborted ? "cancelled" : "failed", completed: completedCount, total: input.readers.length, error });
      throw Object.assign(new Error(error), { record: { path, id, targetType: input.target.type, targetId: targetId(input.target), readerId: reader.id, readerName: reader.name, readerType: reader.readerType, createdAt, sourceContentHash: sourceHash, sourceContentVersion: input.target.sourceVersion, status: input.signal?.aborted ? "cancelled" : "failed", body: "", error } satisfies ReaderEvaluationRecord });
    }
  });
  const completed = records.filter((result): result is PromiseFulfilledResult<ReaderEvaluationRecord> => result.status === "fulfilled").map((result) => result.value);
  const failed = records.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => (result.reason as { record?: ReaderEvaluationRecord }).record).filter((record): record is ReaderEvaluationRecord => Boolean(record));
  return { completed, failed };
}

function targetId(target: ReaderEvaluationTarget): string {
  return target.type === "chapter" ? `chapter:${target.chapterId}` : target.type === "paragraph" ? `paragraph:${target.chapterId}:${target.paragraphId}` : `selection:${target.chapterId}:${target.paragraphId ?? "chapter"}`;
}

function evaluationFrontmatter(input: { id: string; createdAt: string; updatedAt: string; input: Parameters<typeof runReaderEvaluations>[0]; reader: ReaderPersonaProfile; sourceHash: string; status: string; score?: number; generation?: LlmRunMetadata; error?: string }): Record<string, unknown> {
  return {
    id: input.id,
    type: "readerEvaluation",
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    targetType: input.input.target.type,
    targetId: targetId(input.input.target),
    bookId: input.input.target.bookId,
    chapterId: input.input.target.chapterId,
    paragraphId: input.input.target.paragraphId,
    readerId: input.reader.id,
    readerName: input.reader.name,
    readerType: input.reader.readerType,
    readerVersion: input.reader.version,
    language: input.input.language || input.input.structure.language || input.input.settings.ui.language,
    evaluationDepth: input.input.depth,
    sourceContentHash: input.sourceHash,
    sourceContentVersion: input.input.target.sourceVersion,
    sourceUpdatedAt: input.updatedAt,
    routerTask: "reader-evaluation",
    model: input.generation?.model,
    provider: input.generation?.provider,
    integrationId: input.generation?.integrationId,
    inputTokens: input.generation?.inputTokens,
    outputTokens: input.generation?.outputTokens,
    estimatedCost: input.generation?.cost,
    finalCost: input.generation?.cost,
    currency: input.generation?.currency,
    score: input.score,
    status: input.status,
    error: input.error,
  };
}

export async function generateReaderEvaluationSummary(input: { token: string; book: BookEntry; branch: string; settings: AppSettings; target: ReaderEvaluationTarget; evaluations: ReaderEvaluationRecord[]; language?: string; signal?: AbortSignal }): Promise<ReaderEvaluationRecord> {
  const language = input.language || input.settings.ui.language;
  const createdAt = new Date().toISOString();
  const result = await completeToolRouted<Record<string, unknown>>(input.settings, [
    { role: "system", content: `Compare the separate simulated-reader evaluations. Preserve disagreements rather than flattening them. Return the summary in ${language}.` },
    { role: "user", content: input.evaluations.map((evaluation) => `READER: ${evaluation.readerName}\nSCORE: ${evaluation.score ?? "n/a"}\n${evaluation.body}`).join("\n\n---\n\n") },
  ], "reader-evaluation-summary", SUMMARY_TOOL, { signal: input.signal, label: "reader-evaluation-summary" });
  const path = summaryPath(input.target);
  const existing = await readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, path).catch(() => null);
  const originalCreatedAt = createdAtFromFile(existing?.content, createdAt);
  const id = `reader-evaluation-summary:${input.target.type}:${input.target.chapterId}:${input.target.paragraphId ?? "chapter"}`;
  const sourceHash = await hashReaderSource(input.target.text);
  const body = renderSummaryBody(result.output, language);
  const frontmatter = {
    id,
    type: "readerEvaluationSummary",
    createdAt: originalCreatedAt,
    updatedAt: createdAt,
    targetType: input.target.type,
    targetId: targetId(input.target),
    bookId: input.target.bookId,
    chapterId: input.target.chapterId,
    paragraphId: input.target.paragraphId,
    readerIds: input.evaluations.map((evaluation) => evaluation.readerId),
    readerCount: input.evaluations.length,
    language,
    sourceContentHash: sourceHash,
    sourceContentVersion: input.target.sourceVersion,
    routerTask: "reader-evaluation-summary",
    model: result.metadata.model,
    provider: result.metadata.provider,
    integrationId: result.metadata.integrationId,
    inputTokens: result.metadata.inputTokens,
    outputTokens: result.metadata.outputTokens,
    finalCost: result.metadata.cost,
    currency: result.metadata.currency,
    score: Number(result.output.overallScore ?? 0),
    status: "completed",
    refs: input.evaluations.map((evaluation) => evaluation.id),
  };
  await writeStableFile({ token: input.token, book: input.book, branch: input.branch, path, existing, content: renderFile(frontmatter, body), message: `Update reader evaluation summary: ${input.target.title}` });
  return { path, id, targetType: input.target.type, targetId: targetId(input.target), readerId: "summary", readerName: "Summary", readerType: "summary", createdAt: originalCreatedAt, sourceContentHash: sourceHash, sourceContentVersion: input.target.sourceVersion, status: "completed", score: Number(result.output.overallScore ?? 0), body, stale: false };
}

export function parseReaderEvaluation(path: string, raw: string, currentHash?: string): ReaderEvaluationRecord {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const frontmatter = match ? ((parseDocument(match[1]).toJSON() as Record<string, unknown> | null) ?? {}) : {};
  const value = (key: string) => String(frontmatter[key] ?? "");
  const status = value("status") as ReaderEvaluationRecord["status"] || "completed";
  const sourceContentHash = value("sourceContentHash");
  return {
    path,
    id: value("id") || path,
    targetType: value("targetType") as ReaderEvaluationTargetType,
    targetId: value("targetId"),
    readerId: value("readerId") || (value("type") === "readerEvaluationSummary" ? "summary" : "unknown"),
    readerName: value("readerName") || (value("type") === "readerEvaluationSummary" ? "Summary" : "Reader"),
    readerType: value("readerType") || (value("type") === "readerEvaluationSummary" ? "summary" : "custom"),
    createdAt: value("createdAt"),
    sourceContentHash,
    sourceContentVersion: value("sourceContentVersion"),
    status,
    score: typeof frontmatter.score === "number" ? frontmatter.score : undefined,
    body: match?.[2]?.trim() ?? raw.trim(),
    stale: Boolean(currentHash && sourceContentHash && currentHash !== sourceContentHash),
    error: value("error") || undefined,
  };
}

export function defaultReaders(language?: string): ReaderPersonaProfile[] {
  return builtinReaderPersonas(language);
}

export function findOrphanReaderEvaluationPaths(structure: BookStructure): string[] {
  const chapters = new Map(structure.chapters.map((chapter) => [chapter.slug, new Set(chapter.paragraphs.map((paragraph) => paragraphSlugFromPath(paragraph.path)))]));
  return structure.readerEvaluationFiles.map((file) => file.path).filter((path) => {
    const chapterMatch = /^evaluations\/readers\/(?:chapters|summaries\/chapters)\/([^/]+)\//.exec(path);
    if (chapterMatch) return !chapters.has(chapterMatch[1]);
    const paragraphMatch = /^evaluations\/readers\/(?:paragraphs|selections|summaries\/(?:paragraphs|selections))\/([^/]+)\/([^/]+)\//.exec(path);
    if (paragraphMatch) return !chapters.get(paragraphMatch[1])?.has(paragraphMatch[2]);
    return false;
  });
}

function paragraphSlugFromPath(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}
