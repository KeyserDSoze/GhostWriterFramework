import { parseDocument, stringify } from "yaml";
import { completeToolRouted } from "@/assistant/router";
import type { LlmRunMetadata } from "@/assistant/llm";
import { loadFileContent } from "@/github/githubClient";
import { ghostwriterPrompt, parseGhostwriter } from "@/narrarium/ghostwriter";
import {
  hashReaderSource,
  latestNonStaleCompletedReaderEvaluations,
  parseReaderEvaluation,
  readerEvaluationSummaryPath,
  readerEvaluationTargetPrefixes,
  type ReaderEvaluationRecord,
  type ReaderEvaluationTarget,
} from "@/narrarium/readerEvaluations";
import {
  rewriteOperationManifestPath,
  rewriteOperationSnapshotPath,
  type RewriteOperationScope,
} from "@/narrarium/rewriteOperationPaths";
import {
  commitAndPushTextFileMutation,
  preflightRepositoryOperation,
  RepositoryConflictError,
  sha256Text,
  type RepositoryTextMutation,
} from "@/repository/safeRepositoryMutation";
import type { BookStructure, Chapter, Paragraph } from "@/types/book";
import type { AppSettings, BookEntry } from "@/types/settings";

export type RewriteOperationStatus = "preparing" | "rewriting" | "saving" | "completed" | "failed" | "cancelled" | "rollingBack" | "rolledBack" | "conflict";
export type RewriteModifiedFileStatus = "pending" | "completed" | "failed" | "kept-current" | "restored" | "conflict";
export type RewriteRollbackPolicy = "keep-current" | "force-restore" | "cancel";

export interface RewriteOperationProgress {
  completed: number;
  total: number;
  currentParagraphSlug?: string;
}

export interface RewriteConflict {
  path: string;
  expectedHash: string | null;
  currentHash: string | null;
  reason: string;
}

export interface RewriteModifiedFile {
  path: string;
  paragraphSlug: string;
  beforeSnapshotPath: string;
  generatedSnapshotPath: string;
  existedBefore: boolean;
  beforeHash: string | null;
  sourceDraftPath?: string;
  sourceDraftHash?: string | null;
  appliedHash?: string;
  status: RewriteModifiedFileStatus;
}

export interface RewriteGenerationRun {
  paragraphSlug: string;
  feedbackApplied: string[];
  metadata: LlmRunMetadata;
}

export interface RewriteOperationManifest {
  schemaVersion: 1;
  operationId: string;
  operation: "rewriteFromReaderFeedback";
  scope: RewriteOperationScope;
  bookId: string;
  chapterId: string;
  paragraphIds: string[];
  startedAt: string;
  completedAt: string | null;
  baseGitReference: string;
  resultGitReference: string | null;
  status: RewriteOperationStatus;
  createdAt: string;
  updatedAt: string;
  baseRemoteHeadSha: string;
  latestRemoteHeadSha: string;
  chapterSlug: string;
  paragraphSlug?: string;
  targetIds: string[];
  feedbackSummaryPath: string;
  feedbackSourceHash: string;
  staleFeedback: boolean;
  progress: RewriteOperationProgress;
  modifiedFiles: RewriteModifiedFile[];
  generationRuns: RewriteGenerationRun[];
  aggregateInputTokens: number;
  aggregateCachedInputTokens: number;
  aggregateOutputTokens: number;
  aggregateCost: number;
  currency?: string;
  conflicts: RewriteConflict[];
  error?: string;
}

export class MissingReaderFeedbackSummaryError extends Error {
  readonly code = "MISSING_READER_FEEDBACK_SUMMARY";
  constructor(readonly path: string) {
    super(`Reader feedback summary is required at ${path}.`);
    this.name = "MissingReaderFeedbackSummaryError";
  }
}

export class StaleReaderFeedbackConfirmationError extends Error {
  readonly code = "STALE_READER_FEEDBACK_CONFIRMATION_REQUIRED";
  constructor() {
    super("The reader feedback summary is stale and requires explicit confirmation.");
    this.name = "StaleReaderFeedbackConfirmationError";
  }
}

export interface RewriteRepositoryContext {
  token: string;
  book: BookEntry;
  branch: string;
  structure: BookStructure;
  settings: AppSettings;
}

export interface GeneratedFeedbackDraft {
  body: string;
  feedbackApplied: string[];
}

export interface ParagraphFeedbackProposal {
  operationId: string;
  chapterSlug: string;
  paragraphSlug: string;
  draftPath: string;
  legacyDraftPath: string;
  generatedBody: string;
  generatedDraftContent: string;
  feedbackApplied: string[];
  generation: LlmRunMetadata;
  staleFeedback: boolean;
  feedbackSummaryPath: string;
  feedbackSummaryHash: string;
  feedbackSourceHash: string;
  finalSourcePath: string;
  finalSourceHash: string;
  beforeDraftContent: string | null;
  currentDraftContent: string | null;
  beforeDraftHash: string | null;
  canonicalDraftExisted: boolean;
  legacyDraftHash: string | null;
}

export interface ReaderFeedbackSummaryState {
  path: string;
  stale: boolean;
}

const GENERATED_DRAFT_TOOL = {
  name: "generated_feedback_draft",
  description: "Return the revised prose body and a concise list of reader-feedback points that were applied.",
  parameters: {
    type: "object",
    properties: {
      body: { type: "string", description: "Finished prose body only. No frontmatter, commentary, headings, or code fences." },
      feedbackApplied: { type: "array", items: { type: "string" } },
    },
    required: ["body", "feedbackApplied"],
    additionalProperties: false,
  },
} as const;

function paragraphSlug(paragraph: Paragraph): string {
  return (paragraph.path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

function splitMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string; block: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw.trim(), block: null };
  let frontmatter: Record<string, unknown> = {};
  try { frontmatter = (parseDocument(match[1]).toJSON() as Record<string, unknown> | null) ?? {}; } catch { /* retain empty metadata */ }
  return { frontmatter, body: match[2].trim(), block: match[1] };
}

function replaceMarkdownBody(raw: string, body: string): string {
  const parts = splitMarkdown(raw);
  return parts.block === null ? `${body.trim()}\n` : `---\n${parts.block}\n---\n\n${body.trim()}\n`;
}

function canonicalDraftContent(chapter: Chapter, paragraph: Paragraph, finalRaw: string, body: string): string {
  const slug = paragraphSlug(paragraph);
  const finalFrontmatter = splitMarkdown(finalRaw).frontmatter;
  const frontmatter: Record<string, unknown> = {
    type: "paragraph-draft",
    id: `draft:paragraph:${chapter.slug}:${slug}`,
    paragraph: `paragraph:${chapter.slug}:${slug}`,
    chapter: `chapter:${chapter.slug}`,
    number: Number(paragraph.number) || finalFrontmatter.number || 0,
    title: finalFrontmatter.title || paragraph.title,
    canon: "draft",
  };
  if (finalFrontmatter.ghostwriter) frontmatter.ghostwriter = finalFrontmatter.ghostwriter;
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}

function renderManifest(manifest: RewriteOperationManifest): string {
  return `---\n${stringify({ type: "rewriteFromReaderFeedbackOperation", ...manifest }).trimEnd()}\n---\n\n# Rewrite from reader feedback\n\nStatus: ${manifest.status}\n`;
}

export function parseRewriteOperationManifest(path: string, raw: string, fallbackBookId = ""): RewriteOperationManifest {
  const parsed = splitMarkdown(raw).frontmatter as Partial<RewriteOperationManifest> & Record<string, unknown>;
  if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.operationId !== "string" || (parsed.scope !== "chapter" && parsed.scope !== "paragraph")) {
    throw new Error(`Invalid rewrite operation manifest: ${path}`);
  }
  const chapterSlug = typeof parsed.chapterSlug === "string"
    ? parsed.chapterSlug
    : typeof parsed.chapterId === "string" ? parsed.chapterId : "";
  if (!chapterSlug) throw new Error(`Invalid rewrite operation manifest: ${path}`);
  const createdAt = typeof parsed.createdAt === "string"
    ? parsed.createdAt
    : typeof parsed.startedAt === "string" ? parsed.startedAt : new Date(0).toISOString();
  const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : createdAt;
  const modifiedFiles = Array.isArray(parsed.modifiedFiles) ? parsed.modifiedFiles : [];
  const paragraphIds = Array.isArray(parsed.paragraphIds)
    ? parsed.paragraphIds.filter((value): value is string => typeof value === "string")
    : modifiedFiles.map((file) => file.paragraphSlug).filter(Boolean);
  const terminalSuccess = parsed.status === "completed" || parsed.status === "rolledBack";
  const hasCompletedAt = Object.prototype.hasOwnProperty.call(parsed, "completedAt");
  const hasResultGitReference = Object.prototype.hasOwnProperty.call(parsed, "resultGitReference");
  const latestReference = typeof parsed.latestRemoteHeadSha === "string" ? parsed.latestRemoteHeadSha : "";
  const baseReference = typeof parsed.baseRemoteHeadSha === "string" ? parsed.baseRemoteHeadSha : latestReference;
  return {
    ...parsed,
    operation: "rewriteFromReaderFeedback",
    bookId: typeof parsed.bookId === "string" ? parsed.bookId : fallbackBookId,
    chapterId: typeof parsed.chapterId === "string" ? parsed.chapterId : chapterSlug,
    chapterSlug,
    paragraphIds,
    startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : createdAt,
    completedAt: hasCompletedAt && (typeof parsed.completedAt === "string" || parsed.completedAt === null)
      ? parsed.completedAt
      : terminalSuccess ? updatedAt : null,
    baseGitReference: typeof parsed.baseGitReference === "string" ? parsed.baseGitReference : baseReference,
    resultGitReference: hasResultGitReference && (typeof parsed.resultGitReference === "string" || parsed.resultGitReference === null)
      ? parsed.resultGitReference
      : terminalSuccess ? latestReference || null : null,
    createdAt,
    updatedAt,
    baseRemoteHeadSha: baseReference,
    latestRemoteHeadSha: latestReference || baseReference,
    modifiedFiles,
  } as RewriteOperationManifest;
}

function aggregateRuns(manifest: RewriteOperationManifest): void {
  manifest.aggregateInputTokens = manifest.generationRuns.reduce((sum, run) => sum + run.metadata.inputTokens, 0);
  manifest.aggregateCachedInputTokens = manifest.generationRuns.reduce((sum, run) => sum + run.metadata.cachedInputTokens, 0);
  manifest.aggregateOutputTokens = manifest.generationRuns.reduce((sum, run) => sum + run.metadata.outputTokens, 0);
  manifest.aggregateCost = manifest.generationRuns.reduce((sum, run) => sum + (run.metadata.cost ?? 0), 0);
  manifest.currency = manifest.generationRuns.find((run) => run.metadata.currency)?.metadata.currency;
}

async function readOptional(context: RewriteRepositoryContext, path: string): Promise<string | null> {
  return loadFileContent(context.token, context.book.owner, context.book.repo, path, context.branch).catch(() => null);
}

async function loadParagraphSource(context: RewriteRepositoryContext, paragraph: Paragraph): Promise<{ raw: string; body: string; hash: string }> {
  const raw = await loadFileContent(context.token, context.book.owner, context.book.repo, paragraph.path, context.branch);
  return { raw, body: splitMarkdown(raw).body, hash: await sha256Text(raw) };
}

async function loadCurrentDraft(context: RewriteRepositoryContext, chapter: Chapter, paragraph: Paragraph): Promise<{
  canonicalPath: string;
  legacyPath: string;
  canonicalContent: string | null;
  sourceContent: string | null;
  canonicalHash: string | null;
  legacyHash: string | null;
}> {
  const slug = paragraphSlug(paragraph);
  const canonicalPath = `drafts/${chapter.slug}/${slug}.md`;
  const legacyPath = `${chapter.path}/drafts/${slug}.md`;
  const [canonicalContent, legacyContent] = await Promise.all([readOptional(context, canonicalPath), readOptional(context, legacyPath)]);
  return {
    canonicalPath,
    legacyPath,
    canonicalContent,
    sourceContent: canonicalContent ?? legacyContent,
    canonicalHash: canonicalContent === null ? null : await sha256Text(canonicalContent),
    legacyHash: legacyContent === null ? null : await sha256Text(legacyContent),
  };
}

async function chapterReaderTarget(context: RewriteRepositoryContext, chapter: Chapter): Promise<ReaderEvaluationTarget> {
  const files = await Promise.all(chapter.paragraphs.map((paragraph) => loadParagraphSource(context, paragraph)));
  const text = files.map((file, index) => `## ${chapter.paragraphs[index].title}\n\n${file.body}`).join("\n\n");
  return {
    type: "chapter",
    bookId: context.book.id,
    chapterId: chapter.slug,
    title: chapter.title,
    text,
    sourcePath: `${chapter.path}/chapter.md`,
    sourceVersion: files.map((file) => file.hash).join(":"),
  };
}

function paragraphReaderTarget(context: RewriteRepositoryContext, chapter: Chapter, paragraph: Paragraph, source: { body: string; hash: string }): ReaderEvaluationTarget {
  return {
    type: "paragraph",
    bookId: context.book.id,
    chapterId: chapter.slug,
    paragraphId: paragraphSlug(paragraph),
    title: paragraph.title,
    text: source.body,
    sourcePath: paragraph.path,
    sourceVersion: source.hash,
  };
}

async function loadFeedback(context: RewriteRepositoryContext, target: ReaderEvaluationTarget): Promise<{
  summary: ReaderEvaluationRecord;
  summaryRaw: string;
  summaryHash: string;
  sourceHash: string;
  evaluations: ReaderEvaluationRecord[];
}> {
  const sourceHash = await hashReaderSource(target.text);
  const summaryPath = readerEvaluationSummaryPath(target);
  const summaryFile = context.structure.readerEvaluationFiles.find((file) => file.path === summaryPath);
  const summaryRaw = summaryFile?.content ?? await readOptional(context, summaryPath);
  if (!summaryRaw) throw new MissingReaderFeedbackSummaryError(summaryPath);
  const summary = parseReaderEvaluation(summaryPath, summaryRaw, sourceHash);
  const expectedTargetId = target.type === "chapter"
    ? `chapter:${target.chapterId}`
    : `${target.type}:${target.chapterId}:${target.paragraphId ?? "chapter"}`;
  if (summary.status !== "completed" || summary.targetType !== target.type || summary.targetId !== expectedTargetId) {
    throw new MissingReaderFeedbackSummaryError(summaryPath);
  }
  summary.stale = !summary.sourceContentHash || summary.sourceContentHash !== sourceHash;
  const evaluations = await loadCurrentEvaluations(context, target, sourceHash, summaryPath);
  return {
    summary,
    summaryRaw,
    summaryHash: await sha256Text(summaryRaw),
    sourceHash,
    evaluations,
  };
}

async function loadCurrentEvaluations(
  context: RewriteRepositoryContext,
  target: ReaderEvaluationTarget,
  sourceHash: string,
  excludedPath = readerEvaluationSummaryPath(target),
): Promise<ReaderEvaluationRecord[]> {
  const prefixes = readerEvaluationTargetPrefixes(target);
  const records = await Promise.all(context.structure.readerEvaluationFiles
    .filter((file) => file.path !== excludedPath && prefixes.some((prefix) => file.path.startsWith(prefix)))
    .map(async (file) => {
      const raw = file.content ?? await readOptional(context, file.path);
      return raw ? parseReaderEvaluation(file.path, raw, sourceHash) : null;
    }));
  return latestNonStaleCompletedReaderEvaluations(records
    .filter((record): record is ReaderEvaluationRecord => Boolean(record))
    .map((record) => ({ ...record, stale: !record.sourceContentHash || record.sourceContentHash !== sourceHash })));
}

async function loadWritingContext(
  context: RewriteRepositoryContext,
  chapter: Chapter,
  surrounding: { previous: string; next: string; alreadyRewritten?: string[] },
  relevanceText: string,
): Promise<string> {
  const load = (path?: string) => path ? readOptional(context, path) : Promise.resolve(null);
  const [globalStyle, chapterStyle, punctuation, totalResume, chapterResume] = await Promise.all([
    load(context.structure.globalWritingStylePath),
    load(chapter.writingStylePath),
    load(context.structure.globalPunctuationStylePath),
    load("resumes/total.md"),
    load(`resumes/chapters/${chapter.slug}.md`),
  ]);
  const ghostwriterSlug = chapter.ghostwriter || context.structure.ghostwriter;
  const ghostwriterEntry = context.structure.ghostwriters.find((entry) => entry.slug === ghostwriterSlug);
  const ghostwriterRaw = await load(ghostwriterEntry?.path);
  const searchable = relevanceText.toLowerCase();
  const canonFiles = [...context.structure.characters, ...context.structure.locations, ...context.structure.items, ...context.structure.factions, ...context.structure.timelines, ...context.structure.secrets]
    .filter((file) => {
      const slug = (file.path.split("/").pop() ?? "").replace(/\.md$/i, "");
      return searchable.includes((file.name ?? slug).toLowerCase()) || searchable.includes(slug.replace(/-/g, " ").toLowerCase());
    })
    .slice(0, 24);
  const canon = await Promise.all(canonFiles.map(async (file) => ({ path: file.path, raw: file.content ?? await readOptional(context, file.path) })));
  return [
    globalStyle ? `GLOBAL WRITING STYLE:\n${globalStyle}` : "",
    chapterStyle ? `CHAPTER WRITING STYLE:\n${chapterStyle}` : "",
    punctuation ? `BINDING PUNCTUATION STYLE:\n${punctuation}` : "",
    ghostwriterRaw && ghostwriterEntry ? `GHOSTWRITER:\n${ghostwriterPrompt(parseGhostwriter(ghostwriterEntry.slug, ghostwriterRaw))}` : "",
    totalResume ? `BOOK CONTINUITY:\n${totalResume}` : "",
    chapterResume ? `CHAPTER CONTINUITY:\n${chapterResume}` : "",
    surrounding.previous ? `IMMEDIATE PREVIOUS PARAGRAPH:\n${surrounding.previous}` : "",
    surrounding.next ? `IMMEDIATE NEXT PARAGRAPH:\n${surrounding.next}` : "",
    surrounding.alreadyRewritten?.length ? `ALREADY REWRITTEN DRAFTS IN THIS OPERATION:\n${surrounding.alreadyRewritten.join("\n\n---\n\n")}` : "",
    canon.length ? `RELEVANT CANON, TIMELINE, AND SECRET RECORDS (honor reveal thresholds; do not expose hidden facts early):\n${canon.map((entry) => `FILE ${entry.path}\n${entry.raw ?? ""}`).join("\n\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

async function generateParagraph(input: {
  context: RewriteRepositoryContext;
  chapter: Chapter;
  paragraph: Paragraph;
  draftBody: string;
  finalBody: string;
  chapterSummary: ReaderEvaluationRecord;
  paragraphSummary?: ReaderEvaluationRecord;
  evaluations: ReaderEvaluationRecord[];
  writingContext: string;
  signal?: AbortSignal;
}): Promise<{ output: GeneratedFeedbackDraft; metadata: LlmRunMetadata }> {
  const languageCode = input.context.structure.language ?? input.context.settings.ui.language;
  const language = languageCode.toLowerCase().startsWith("it") ? "Italian" : languageCode.toLowerCase().startsWith("en") ? "English" : languageCode;
  const result = await completeToolRouted<GeneratedFeedbackDraft>(input.context.settings, [
    {
      role: "system",
      content: `Rewrite one paragraph of finished narrative prose in ${language}. Return only the structured tool result. The body must contain prose only: no explanation, frontmatter, headings, labels, or markdown fences. Apply actionable reader feedback while preserving praised strengths, established canon, chronology, continuity, writing style, punctuation rules, POV, tense, and ghostwriter voice. Never invent unsupported facts. Never reveal a secret before its known_from/reveal_in threshold. If feedback conflicts with canon or continuity, preserve canon and continuity.`,
    },
    {
      role: "user",
      content: [
        input.writingContext,
        `REQUIRED TARGET FEEDBACK RECAP:\n${input.chapterSummary.body}`,
        input.paragraphSummary ? `PARAGRAPH FEEDBACK RECAP:\n${input.paragraphSummary.body}` : "",
        input.evaluations.length ? `CURRENT INDIVIDUAL READER EVALUATIONS:\n${input.evaluations.map((record) => `${record.readerName}:\n${record.body}`).join("\n\n")}` : "",
        `FINAL PARAGRAPH SOURCE (canon and continuity baseline):\n${input.finalBody}`,
        input.draftBody ? `CURRENT DRAFT TO REVISE:\n${input.draftBody}` : "No draft exists. Create one from the final source and feedback.",
      ].filter(Boolean).join("\n\n"),
    },
  ], "rewrite-from-reader-feedback", GENERATED_DRAFT_TOOL, { signal: input.signal, label: `rewrite-from-reader-feedback:${paragraphSlug(input.paragraph)}` });
  const body = result.output.body?.trim();
  if (!body) throw new Error("The model returned an empty draft body.");
  return { output: { body, feedbackApplied: result.output.feedbackApplied?.filter(Boolean) ?? [] }, metadata: result.metadata };
}

function resolveTarget(structure: BookStructure, chapterSlug: string, paragraphSlugValue?: string): { chapter: Chapter; paragraph?: Paragraph } {
  const chapter = structure.chapters.find((entry) => entry.slug === chapterSlug);
  if (!chapter) throw new Error(`Chapter not found: ${chapterSlug}`);
  if (!paragraphSlugValue) return { chapter };
  const paragraph = chapter.paragraphs.find((entry) => paragraphSlug(entry) === paragraphSlugValue);
  if (!paragraph) throw new Error(`Paragraph not found: ${chapterSlug}/${paragraphSlugValue}`);
  return { chapter, paragraph };
}

export async function inspectReaderFeedbackSummary(input: RewriteRepositoryContext & {
  chapterSlug: string;
  paragraphSlug?: string;
}): Promise<ReaderFeedbackSummaryState> {
  const { chapter, paragraph } = resolveTarget(input.structure, input.chapterSlug, input.paragraphSlug);
  if (paragraph) {
    const source = await loadParagraphSource(input, paragraph);
    const feedback = await loadFeedback(input, paragraphReaderTarget(input, chapter, paragraph, source));
    return { path: feedback.summary.path, stale: Boolean(feedback.summary.stale) };
  }
  const feedback = await loadFeedback(input, await chapterReaderTarget(input, chapter));
  return { path: feedback.summary.path, stale: Boolean(feedback.summary.stale) };
}

export async function prepareParagraphFeedbackProposal(input: RewriteRepositoryContext & {
  chapterSlug: string;
  paragraphSlug: string;
  signal?: AbortSignal;
}): Promise<ParagraphFeedbackProposal> {
  await preflightRepositoryOperation(input);
  const { chapter, paragraph } = resolveTarget(input.structure, input.chapterSlug, input.paragraphSlug);
  const final = await loadParagraphSource(input, paragraph!);
  const target = paragraphReaderTarget(input, chapter, paragraph!, final);
  const feedback = await loadFeedback(input, target);
  const draft = await loadCurrentDraft(input, chapter, paragraph!);
  const index = chapter.paragraphs.indexOf(paragraph!);
  const [previous, next] = await Promise.all([
    index > 0 ? loadParagraphSource(input, chapter.paragraphs[index - 1]).then((value) => value.body) : "",
    index + 1 < chapter.paragraphs.length ? loadParagraphSource(input, chapter.paragraphs[index + 1]).then((value) => value.body) : "",
  ]);
  const writingContext = await loadWritingContext(input, chapter, { previous, next }, `${final.body}\n${feedback.summary.body}`);
  const generated = await generateParagraph({
    context: input,
    chapter,
    paragraph: paragraph!,
    draftBody: splitMarkdown(draft.sourceContent ?? "").body,
    finalBody: final.body,
    chapterSummary: feedback.summary,
    paragraphSummary: undefined,
    evaluations: feedback.evaluations,
    writingContext,
    signal: input.signal,
  });
  const generatedDraftContent = draft.sourceContent
    ? replaceMarkdownBody(draft.sourceContent, generated.output.body)
    : canonicalDraftContent(chapter, paragraph!, final.raw, generated.output.body);
  return {
    operationId: crypto.randomUUID(),
    chapterSlug: chapter.slug,
    paragraphSlug: paragraphSlug(paragraph!),
    draftPath: draft.canonicalPath,
    legacyDraftPath: draft.legacyPath,
    generatedBody: generated.output.body,
    generatedDraftContent,
    feedbackApplied: generated.output.feedbackApplied,
    generation: generated.metadata,
    staleFeedback: Boolean(feedback.summary.stale),
    feedbackSummaryPath: feedback.summary.path,
    feedbackSummaryHash: feedback.summaryHash,
    feedbackSourceHash: feedback.sourceHash,
    finalSourcePath: paragraph!.path,
    finalSourceHash: final.hash,
    beforeDraftContent: draft.canonicalContent,
    currentDraftContent: draft.sourceContent,
    beforeDraftHash: draft.canonicalHash,
    canonicalDraftExisted: draft.canonicalContent !== null,
    legacyDraftHash: draft.legacyHash,
  };
}

function newManifest(input: {
  operationId: string;
  scope: RewriteOperationScope;
  bookId: string;
  head: string;
  chapterSlug: string;
  paragraphSlug?: string;
  targetIds: string[];
  feedbackSummaryPath: string;
  feedbackSourceHash: string;
  staleFeedback: boolean;
  modifiedFiles: RewriteModifiedFile[];
}): RewriteOperationManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    operationId: input.operationId,
    operation: "rewriteFromReaderFeedback",
    scope: input.scope,
    bookId: input.bookId,
    chapterId: input.chapterSlug,
    paragraphIds: input.modifiedFiles.map((file) => file.paragraphSlug),
    startedAt: now,
    completedAt: null,
    baseGitReference: input.head,
    resultGitReference: null,
    status: "preparing",
    createdAt: now,
    updatedAt: now,
    baseRemoteHeadSha: input.head,
    latestRemoteHeadSha: input.head,
    chapterSlug: input.chapterSlug,
    paragraphSlug: input.paragraphSlug,
    targetIds: input.targetIds,
    feedbackSummaryPath: input.feedbackSummaryPath,
    feedbackSourceHash: input.feedbackSourceHash,
    staleFeedback: input.staleFeedback,
    progress: { completed: 0, total: input.modifiedFiles.length },
    modifiedFiles: input.modifiedFiles,
    generationRuns: [],
    aggregateInputTokens: 0,
    aggregateCachedInputTokens: 0,
    aggregateOutputTokens: 0,
    aggregateCost: 0,
    conflicts: [],
  };
}

async function finalizeSuccessfulManifest(input: RewriteRepositoryContext & {
  manifest: RewriteOperationManifest;
  manifestPath: string;
  persistedManifestContent: string;
  resultCommitSha: string;
  status: "completed" | "rolledBack";
  message: string;
}): Promise<void> {
  const completedAt = new Date().toISOString();
  input.manifest.status = input.status;
  input.manifest.completedAt = completedAt;
  input.manifest.updatedAt = completedAt;
  input.manifest.resultGitReference = input.resultCommitSha;
  input.manifest.latestRemoteHeadSha = input.resultCommitSha;
  const finalized = await commitAndPushTextFileMutation({
    ...input,
    expectedRemoteHeadSha: input.resultCommitSha,
    message: input.message,
    mutations: [{
      path: input.manifestPath,
      content: renderManifest(input.manifest),
      expectedCurrentHash: await sha256Text(input.persistedManifestContent),
    }],
  });
  input.manifest.latestRemoteHeadSha = finalized.commitSha;
}

export async function applyParagraphFeedbackProposal(input: RewriteRepositoryContext & {
  proposal: ParagraphFeedbackProposal;
  confirmStaleFeedback?: boolean;
}): Promise<RewriteOperationManifest> {
  const proposal = input.proposal;
  if (proposal.staleFeedback && !input.confirmStaleFeedback) throw new StaleReaderFeedbackConfirmationError();
  resolveTarget(input.structure, proposal.chapterSlug, proposal.paragraphSlug);
  const preflight = await preflightRepositoryOperation(input);
  const manifestPath = rewriteOperationManifestPath("paragraph", proposal.chapterSlug, proposal.operationId, proposal.paragraphSlug);
  const beforePath = rewriteOperationSnapshotPath("paragraph", proposal.chapterSlug, proposal.operationId, proposal.paragraphSlug, "before", proposal.paragraphSlug);
  const generatedPath = rewriteOperationSnapshotPath("paragraph", proposal.chapterSlug, proposal.operationId, proposal.paragraphSlug, "generated", proposal.paragraphSlug);
  const modifiedFile: RewriteModifiedFile = {
    path: proposal.draftPath,
    paragraphSlug: proposal.paragraphSlug,
    beforeSnapshotPath: beforePath,
    generatedSnapshotPath: generatedPath,
    existedBefore: proposal.canonicalDraftExisted,
    beforeHash: proposal.beforeDraftHash,
    sourceDraftPath: proposal.canonicalDraftExisted ? proposal.draftPath : proposal.legacyDraftPath,
    sourceDraftHash: proposal.canonicalDraftExisted ? proposal.beforeDraftHash : proposal.legacyDraftHash,
    status: "pending",
  };
  const manifest = newManifest({
    operationId: proposal.operationId,
    scope: "paragraph",
    bookId: input.book.id,
    head: preflight.remoteHeadSha,
    chapterSlug: proposal.chapterSlug,
    paragraphSlug: proposal.paragraphSlug,
    targetIds: [`paragraph:${proposal.chapterSlug}:${proposal.paragraphSlug}`],
    feedbackSummaryPath: proposal.feedbackSummaryPath,
    feedbackSourceHash: proposal.feedbackSourceHash,
    staleFeedback: proposal.staleFeedback,
    modifiedFiles: [modifiedFile],
  });
  const checkpointContent = renderManifest(manifest);
  const checkpoint = await commitAndPushTextFileMutation({
    ...input,
    expectedRemoteHeadSha: preflight.remoteHeadSha,
    message: `Checkpoint reader feedback rewrite ${proposal.paragraphSlug}`,
    mutations: [
      { path: manifestPath, content: checkpointContent, expectedCurrentHash: null },
      { path: beforePath, content: proposal.beforeDraftContent ?? "---\ntype: rewriteSnapshot\nexists: false\n---\n", expectedCurrentHash: null },
      { path: proposal.draftPath, expectedCurrentHash: proposal.beforeDraftHash },
      { path: proposal.legacyDraftPath, expectedCurrentHash: proposal.legacyDraftHash },
      { path: proposal.feedbackSummaryPath, expectedCurrentHash: proposal.feedbackSummaryHash },
      { path: proposal.finalSourcePath, expectedCurrentHash: proposal.finalSourceHash },
    ],
  });
  manifest.status = "completed";
  manifest.updatedAt = new Date().toISOString();
  manifest.latestRemoteHeadSha = checkpoint.commitSha;
  manifest.progress = { completed: 1, total: 1, currentParagraphSlug: proposal.paragraphSlug };
  modifiedFile.appliedHash = await sha256Text(proposal.generatedDraftContent);
  modifiedFile.status = "completed";
  manifest.generationRuns.push({ paragraphSlug: proposal.paragraphSlug, feedbackApplied: proposal.feedbackApplied, metadata: proposal.generation });
  aggregateRuns(manifest);
  const appliedManifestContent = renderManifest(manifest);
  let resultCommitSha: string;
  try {
    const saved = await commitAndPushTextFileMutation({
      ...input,
      expectedRemoteHeadSha: checkpoint.commitSha,
      message: `Apply reader feedback draft ${proposal.paragraphSlug}`,
      mutations: [
        { path: proposal.draftPath, content: proposal.generatedDraftContent, expectedCurrentHash: proposal.beforeDraftHash },
        { path: generatedPath, content: proposal.generatedDraftContent, expectedCurrentHash: null },
        { path: manifestPath, content: appliedManifestContent, expectedCurrentHash: await sha256Text(checkpointContent) },
      ],
    });
    resultCommitSha = saved.commitSha;
  } catch (error) {
    manifest.status = error instanceof RepositoryConflictError ? "conflict" : "failed";
    manifest.error = error instanceof Error ? error.message : String(error);
    modifiedFile.status = manifest.status === "conflict" ? "conflict" : "failed";
    const failed = await commitAndPushTextFileMutation({
      ...input,
      expectedRemoteHeadSha: checkpoint.commitSha,
      message: `Record ${manifest.status} reader feedback rewrite ${proposal.paragraphSlug}`,
      mutations: [{ path: manifestPath, content: renderManifest(manifest), expectedCurrentHash: await sha256Text(checkpointContent) }],
    });
    manifest.latestRemoteHeadSha = failed.commitSha;
    return manifest;
  }
  await finalizeSuccessfulManifest({
    ...input,
    manifest,
    manifestPath,
    persistedManifestContent: appliedManifestContent,
    resultCommitSha,
    status: "completed",
    message: `Finalize reader feedback rewrite ${proposal.paragraphSlug}`,
  });
  return manifest;
}

export async function runChapterFeedbackRewrite(input: RewriteRepositoryContext & {
  chapterSlug: string;
  confirmed: boolean;
  confirmStaleFeedback?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: RewriteOperationProgress, manifest: RewriteOperationManifest) => void;
}): Promise<RewriteOperationManifest> {
  if (!input.confirmed) throw new Error("Explicit confirmation is required before rewriting a chapter.");
  const { chapter } = resolveTarget(input.structure, input.chapterSlug);
  const chapterTarget = await chapterReaderTarget(input, chapter);
  const chapterFeedback = await loadFeedback(input, chapterTarget);
  if (chapterFeedback.summary.stale && !input.confirmStaleFeedback) throw new StaleReaderFeedbackConfirmationError();
  const preflight = await preflightRepositoryOperation(input);
  const operationId = crypto.randomUUID();
  const manifestPath = rewriteOperationManifestPath("chapter", chapter.slug, operationId);
  const drafts = await Promise.all(chapter.paragraphs.map((paragraph) => loadCurrentDraft(input, chapter, paragraph)));
  const modifiedFiles = chapter.paragraphs.map((paragraph, index): RewriteModifiedFile => {
    const slug = paragraphSlug(paragraph);
    return {
      path: drafts[index].canonicalPath,
      paragraphSlug: slug,
      beforeSnapshotPath: rewriteOperationSnapshotPath("chapter", chapter.slug, operationId, slug, "before"),
      generatedSnapshotPath: rewriteOperationSnapshotPath("chapter", chapter.slug, operationId, slug, "generated"),
      existedBefore: drafts[index].canonicalContent !== null,
      beforeHash: drafts[index].canonicalHash,
      sourceDraftPath: drafts[index].canonicalContent !== null ? drafts[index].canonicalPath : drafts[index].legacyPath,
      sourceDraftHash: drafts[index].canonicalContent !== null ? drafts[index].canonicalHash : drafts[index].legacyHash,
      status: "pending",
    };
  });
  const manifest = newManifest({
    operationId,
    scope: "chapter",
    bookId: input.book.id,
    head: preflight.remoteHeadSha,
    chapterSlug: chapter.slug,
    targetIds: [`chapter:${chapter.slug}`, ...chapter.paragraphs.map((paragraph) => `paragraph:${chapter.slug}:${paragraphSlug(paragraph)}`)],
    feedbackSummaryPath: chapterFeedback.summary.path,
    feedbackSourceHash: chapterFeedback.sourceHash,
    staleFeedback: Boolean(chapterFeedback.summary.stale),
    modifiedFiles,
  });
  let manifestContent = renderManifest(manifest);
  const checkpointMutations: RepositoryTextMutation[] = [
    { path: manifestPath, content: manifestContent, expectedCurrentHash: null },
    { path: chapterFeedback.summary.path, expectedCurrentHash: chapterFeedback.summaryHash },
  ];
  for (let index = 0; index < modifiedFiles.length; index++) {
    checkpointMutations.push({
      path: modifiedFiles[index].beforeSnapshotPath,
      content: drafts[index].canonicalContent ?? "---\ntype: rewriteSnapshot\nexists: false\n---\n",
      expectedCurrentHash: null,
    });
    checkpointMutations.push({ path: drafts[index].canonicalPath, expectedCurrentHash: drafts[index].canonicalHash });
    checkpointMutations.push({ path: drafts[index].legacyPath, expectedCurrentHash: drafts[index].legacyHash });
  }
  const checkpoint = await commitAndPushTextFileMutation({ ...input, expectedRemoteHeadSha: preflight.remoteHeadSha, message: `Checkpoint chapter reader feedback rewrite ${chapter.slug}`, mutations: checkpointMutations });
  manifest.latestRemoteHeadSha = checkpoint.commitSha;
  manifest.status = "rewriting";
  let expectedHead = checkpoint.commitSha;
  const rewritten: string[] = [];

  try {
    for (let index = 0; index < chapter.paragraphs.length; index++) {
      if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const paragraph = chapter.paragraphs[index];
      const slug = paragraphSlug(paragraph);
      manifest.progress.currentParagraphSlug = slug;
      input.onProgress?.({ ...manifest.progress }, manifest);
      const final = await loadParagraphSource(input, paragraph);
      const paragraphTarget = paragraphReaderTarget(input, chapter, paragraph, final);
      let paragraphFeedback: Awaited<ReturnType<typeof loadFeedback>> | null = null;
      let paragraphEvaluations: ReaderEvaluationRecord[] = [];
      try { paragraphFeedback = await loadFeedback(input, paragraphTarget); } catch (error) {
        if (!(error instanceof MissingReaderFeedbackSummaryError)) throw error;
        paragraphEvaluations = await loadCurrentEvaluations(input, paragraphTarget, await hashReaderSource(paragraphTarget.text));
      }
      if (paragraphFeedback?.summary.stale) {
        paragraphEvaluations = paragraphFeedback.evaluations;
        paragraphFeedback = null;
      }
      const previous = index > 0 ? (rewritten[index - 1] ?? (await loadParagraphSource(input, chapter.paragraphs[index - 1])).body) : "";
      const next = index + 1 < chapter.paragraphs.length ? (await loadParagraphSource(input, chapter.paragraphs[index + 1])).body : "";
      const writingContext = await loadWritingContext(input, chapter, { previous, next, alreadyRewritten: rewritten }, `${chapterFeedback.summary.body}\n${paragraphFeedback?.summary.body ?? ""}\n${final.body}`);
      const generated = await generateParagraph({
        context: input,
        chapter,
        paragraph,
        draftBody: splitMarkdown(drafts[index].sourceContent ?? "").body,
        finalBody: final.body,
        chapterSummary: chapterFeedback.summary,
        paragraphSummary: paragraphFeedback?.summary,
        evaluations: paragraphFeedback?.evaluations ?? (paragraphEvaluations.length ? paragraphEvaluations : chapterFeedback.evaluations),
        writingContext,
        signal: input.signal,
      });
      const generatedContent = drafts[index].sourceContent
        ? replaceMarkdownBody(drafts[index].sourceContent!, generated.output.body)
        : canonicalDraftContent(chapter, paragraph, final.raw, generated.output.body);
      rewritten.push(generated.output.body);
      const nextManifest = structuredClone(manifest);
      nextManifest.status = index === chapter.paragraphs.length - 1 ? "completed" : "rewriting";
      nextManifest.progress.completed = index + 1;
      nextManifest.updatedAt = new Date().toISOString();
      nextManifest.modifiedFiles[index].appliedHash = await sha256Text(generatedContent);
      nextManifest.modifiedFiles[index].status = "completed";
      nextManifest.generationRuns.push({ paragraphSlug: slug, feedbackApplied: generated.output.feedbackApplied, metadata: generated.metadata });
      aggregateRuns(nextManifest);
      const nextManifestContent = renderManifest(nextManifest);
      const saved = await commitAndPushTextFileMutation({
        ...input,
        expectedRemoteHeadSha: expectedHead,
        message: `Rewrite draft from reader feedback ${chapter.slug}/${slug}`,
        mutations: [
          { path: drafts[index].canonicalPath, content: generatedContent, expectedCurrentHash: drafts[index].canonicalHash },
          { path: manifest.modifiedFiles[index].generatedSnapshotPath, content: generatedContent, expectedCurrentHash: null },
          { path: manifestPath, content: nextManifestContent, expectedCurrentHash: await sha256Text(manifestContent) },
          { path: paragraph.path, expectedCurrentHash: final.hash },
        ],
      });
      expectedHead = saved.commitSha;
      Object.assign(manifest, nextManifest, { latestRemoteHeadSha: saved.commitSha });
      manifestContent = nextManifestContent;
      input.onProgress?.({ ...manifest.progress }, manifest);
    }
  } catch (error) {
    manifest.status = error instanceof RepositoryConflictError ? "conflict" : input.signal?.aborted ? "cancelled" : "failed";
    manifest.error = error instanceof Error ? error.message : String(error);
    manifest.updatedAt = new Date().toISOString();
    const current = manifest.modifiedFiles[manifest.progress.completed];
    if (current && current.status === "pending") current.status = "failed";
    const failedContent = renderManifest(manifest);
    try {
      const saved = await commitAndPushTextFileMutation({
        ...input,
        expectedRemoteHeadSha: expectedHead,
        message: `Record ${manifest.status} reader feedback rewrite ${chapter.slug}`,
        mutations: [{ path: manifestPath, content: failedContent, expectedCurrentHash: await sha256Text(manifestContent) }],
      });
      manifest.latestRemoteHeadSha = saved.commitSha;
    } catch (saveError) {
      if (!(error instanceof RepositoryConflictError)) throw saveError;
    }
    return manifest;
  }
  await finalizeSuccessfulManifest({
    ...input,
    manifest,
    manifestPath,
    persistedManifestContent: manifestContent,
    resultCommitSha: expectedHead,
    status: "completed",
    message: `Finalize chapter reader feedback rewrite ${chapter.slug}`,
  });
  return manifest;
}

export async function resumeChapterFeedbackRewrite(input: RewriteRepositoryContext & {
  manifestPath: string;
  confirmed: boolean;
  confirmStaleFeedback?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: RewriteOperationProgress, manifest: RewriteOperationManifest) => void;
}): Promise<RewriteOperationManifest> {
  if (!input.confirmed) throw new Error("Explicit confirmation is required before resuming a chapter rewrite.");
  const manifestRaw = await loadFileContent(input.token, input.book.owner, input.book.repo, input.manifestPath, input.branch);
  const manifest = parseRewriteOperationManifest(input.manifestPath, manifestRaw, input.book.id);
  if (manifest.scope !== "chapter") throw new Error("Only chapter feedback rewrites can be resumed.");
  const { chapter } = resolveTarget(input.structure, manifest.chapterSlug);
  if (!manifest.modifiedFiles.some((file) => file.status === "pending" || file.status === "failed" || file.status === "conflict")) return manifest;

  const chapterFeedback = await loadFeedback(input, await chapterReaderTarget(input, chapter));
  if (chapterFeedback.summary.path !== manifest.feedbackSummaryPath || chapterFeedback.sourceHash !== manifest.feedbackSourceHash) {
    throw new RepositoryConflictError("The reader feedback or chapter source changed after this operation started.");
  }
  if (chapterFeedback.summary.stale && !input.confirmStaleFeedback) throw new StaleReaderFeedbackConfirmationError();
  const preflight = await preflightRepositoryOperation(input);
  let expectedHead = preflight.remoteHeadSha;
  let manifestContent = manifestRaw;
  const rewritten: string[] = [];

  for (let index = 0; index < chapter.paragraphs.length; index++) {
    const file = manifest.modifiedFiles[index];
    if (!file || file.paragraphSlug !== paragraphSlug(chapter.paragraphs[index])) throw new Error("The chapter structure no longer matches this rewrite operation.");
    if (file.status === "completed") {
      const current = await readOptional(input, file.path);
      if ((current === null ? null : await sha256Text(current)) !== (file.appliedHash ?? null)) throw new RepositoryConflictError(`Completed draft changed after this operation: ${file.path}`, file.path);
      const generated = await loadFileContent(input.token, input.book.owner, input.book.repo, file.generatedSnapshotPath, input.branch);
      rewritten[index] = splitMarkdown(generated).body;
    }
  }

  try {
    for (let index = 0; index < chapter.paragraphs.length; index++) {
      const file = manifest.modifiedFiles[index];
      if (file.status === "completed") continue;
      if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const paragraph = chapter.paragraphs[index];
      const slug = paragraphSlug(paragraph);
      manifest.status = "rewriting";
      manifest.progress.currentParagraphSlug = slug;
      manifest.progress.completed = manifest.modifiedFiles.filter((entry) => entry.status === "completed").length;
      input.onProgress?.({ ...manifest.progress }, manifest);

      const final = await loadParagraphSource(input, paragraph);
      const draft = await loadCurrentDraft(input, chapter, paragraph);
      if (draft.canonicalHash !== file.beforeHash) throw new RepositoryConflictError(`Pending draft changed after this operation started: ${file.path}`, file.path);
      const sourceHash = file.sourceDraftPath === draft.legacyPath ? draft.legacyHash : draft.canonicalHash;
      if (file.sourceDraftHash !== undefined && sourceHash !== file.sourceDraftHash) throw new RepositoryConflictError(`Source draft changed after this operation started: ${file.sourceDraftPath}`, file.sourceDraftPath);
      const paragraphTarget = paragraphReaderTarget(input, chapter, paragraph, final);
      let paragraphFeedback: Awaited<ReturnType<typeof loadFeedback>> | null = null;
      let paragraphEvaluations: ReaderEvaluationRecord[] = [];
      try { paragraphFeedback = await loadFeedback(input, paragraphTarget); } catch (error) {
        if (!(error instanceof MissingReaderFeedbackSummaryError)) throw error;
        paragraphEvaluations = await loadCurrentEvaluations(input, paragraphTarget, await hashReaderSource(paragraphTarget.text));
      }
      if (paragraphFeedback?.summary.stale) {
        paragraphEvaluations = paragraphFeedback.evaluations;
        paragraphFeedback = null;
      }
      const previous = index > 0 ? (rewritten[index - 1] ?? (await loadParagraphSource(input, chapter.paragraphs[index - 1])).body) : "";
      const next = index + 1 < chapter.paragraphs.length ? (await loadParagraphSource(input, chapter.paragraphs[index + 1])).body : "";
      const writingContext = await loadWritingContext(input, chapter, { previous, next, alreadyRewritten: rewritten.filter(Boolean) }, `${chapterFeedback.summary.body}\n${paragraphFeedback?.summary.body ?? ""}\n${final.body}`);
      const generated = await generateParagraph({
        context: input,
        chapter,
        paragraph,
        draftBody: splitMarkdown(draft.sourceContent ?? "").body,
        finalBody: final.body,
        chapterSummary: chapterFeedback.summary,
        paragraphSummary: paragraphFeedback?.summary,
        evaluations: paragraphFeedback?.evaluations ?? (paragraphEvaluations.length ? paragraphEvaluations : chapterFeedback.evaluations),
        writingContext,
        signal: input.signal,
      });
      const generatedContent = draft.sourceContent ? replaceMarkdownBody(draft.sourceContent, generated.output.body) : canonicalDraftContent(chapter, paragraph, final.raw, generated.output.body);
      const existingGeneratedSnapshot = await readOptional(input, file.generatedSnapshotPath);
      const existingGeneratedSnapshotHash = existingGeneratedSnapshot === null ? null : await sha256Text(existingGeneratedSnapshot);
      const nextManifest = structuredClone(manifest);
      nextManifest.modifiedFiles[index].status = "completed";
      nextManifest.modifiedFiles[index].appliedHash = await sha256Text(generatedContent);
      nextManifest.progress.completed = nextManifest.modifiedFiles.filter((entry) => entry.status === "completed").length;
      nextManifest.status = nextManifest.progress.completed === nextManifest.progress.total ? "completed" : "rewriting";
      nextManifest.updatedAt = new Date().toISOString();
      nextManifest.error = undefined;
      nextManifest.generationRuns.push({ paragraphSlug: slug, feedbackApplied: generated.output.feedbackApplied, metadata: generated.metadata });
      aggregateRuns(nextManifest);
      const nextContent = renderManifest(nextManifest);
      const saved = await commitAndPushTextFileMutation({
        ...input,
        expectedRemoteHeadSha: expectedHead,
        message: `Resume reader feedback draft ${chapter.slug}/${slug}`,
        mutations: [
          { path: file.path, content: generatedContent, expectedCurrentHash: file.beforeHash },
          { path: file.generatedSnapshotPath, content: generatedContent, expectedCurrentHash: existingGeneratedSnapshotHash },
          { path: input.manifestPath, content: nextContent, expectedCurrentHash: await sha256Text(manifestContent) },
          { path: paragraph.path, expectedCurrentHash: final.hash },
        ],
      });
      expectedHead = saved.commitSha;
      Object.assign(manifest, nextManifest, { latestRemoteHeadSha: saved.commitSha });
      manifestContent = nextContent;
      rewritten[index] = generated.output.body;
      input.onProgress?.({ ...manifest.progress }, manifest);
    }
  } catch (error) {
    manifest.status = error instanceof RepositoryConflictError ? "conflict" : input.signal?.aborted ? "cancelled" : "failed";
    manifest.error = error instanceof Error ? error.message : String(error);
    manifest.updatedAt = new Date().toISOString();
    const current = manifest.modifiedFiles.find((file) => file.paragraphSlug === manifest.progress.currentParagraphSlug);
    if (current && current.status !== "completed") current.status = manifest.status === "conflict" ? "conflict" : "failed";
    try {
      const failedContent = renderManifest(manifest);
      const saved = await commitAndPushTextFileMutation({
        ...input,
        expectedRemoteHeadSha: expectedHead,
        message: `Record ${manifest.status} resumed reader feedback rewrite ${chapter.slug}`,
        mutations: [{ path: input.manifestPath, content: failedContent, expectedCurrentHash: await sha256Text(manifestContent) }],
      });
      manifest.latestRemoteHeadSha = saved.commitSha;
    } catch (saveError) {
      if (!(error instanceof RepositoryConflictError)) throw saveError;
    }
    return manifest;
  }
  await finalizeSuccessfulManifest({
    ...input,
    manifest,
    manifestPath: input.manifestPath,
    persistedManifestContent: manifestContent,
    resultCommitSha: expectedHead,
    status: "completed",
    message: `Finalize resumed reader feedback rewrite ${chapter.slug}`,
  });
  return manifest;
}

export async function loadRewriteOperation(context: RewriteRepositoryContext, manifestPath: string): Promise<RewriteOperationManifest> {
  const raw = await loadFileContent(context.token, context.book.owner, context.book.repo, manifestPath, context.branch);
  return parseRewriteOperationManifest(manifestPath, raw, context.book.id);
}

export async function listRewriteOperations(context: RewriteRepositoryContext, target: { scope: RewriteOperationScope; chapterSlug: string; paragraphSlug?: string }): Promise<RewriteOperationManifest[]> {
  const manifests = context.structure.operationManifestFiles.filter((file) => {
    const prefix = target.scope === "chapter"
      ? `operations/rewrite-from-reader-feedback/chapters/${target.chapterSlug}/`
      : `operations/rewrite-from-reader-feedback/paragraphs/${target.chapterSlug}/${target.paragraphSlug}/`;
    return file.path.startsWith(prefix);
  });
  const loaded = await Promise.all(manifests.map(async (file) => {
    const raw = file.content ?? await readOptional(context, file.path);
    return raw ? parseRewriteOperationManifest(file.path, raw, context.book.id) : null;
  }));
  return loaded.filter((entry): entry is RewriteOperationManifest => Boolean(entry)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function loadLatestRewriteOperation(context: RewriteRepositoryContext, target: { scope: RewriteOperationScope; chapterSlug: string; paragraphSlug?: string }): Promise<RewriteOperationManifest | null> {
  return (await listRewriteOperations(context, target))[0] ?? null;
}

export function listChapterRewriteOperations(context: RewriteRepositoryContext, chapterSlug: string): Promise<RewriteOperationManifest[]> {
  return listRewriteOperations(context, { scope: "chapter", chapterSlug });
}

export function listParagraphRewriteOperations(context: RewriteRepositoryContext, chapterSlug: string, paragraphSlugValue: string): Promise<RewriteOperationManifest[]> {
  return listRewriteOperations(context, { scope: "paragraph", chapterSlug, paragraphSlug: paragraphSlugValue });
}

export function loadLatestChapterRewriteOperation(context: RewriteRepositoryContext, chapterSlug: string): Promise<RewriteOperationManifest | null> {
  return loadLatestRewriteOperation(context, { scope: "chapter", chapterSlug });
}

export function loadLatestParagraphRewriteOperation(context: RewriteRepositoryContext, chapterSlug: string, paragraphSlugValue: string): Promise<RewriteOperationManifest | null> {
  return loadLatestRewriteOperation(context, { scope: "paragraph", chapterSlug, paragraphSlug: paragraphSlugValue });
}

export async function restorePreviousDrafts(input: RewriteRepositoryContext & {
  manifestPath: string;
  policies?: Record<string, RewriteRollbackPolicy>;
  defaultPolicy?: RewriteRollbackPolicy;
}): Promise<{ manifest: RewriteOperationManifest; conflicts: RewriteConflict[] }> {
  const preflight = await preflightRepositoryOperation(input);
  const manifestRaw = await loadFileContent(input.token, input.book.owner, input.book.repo, input.manifestPath, input.branch);
  const manifest = parseRewriteOperationManifest(input.manifestPath, manifestRaw, input.book.id);
  const conflicts: RewriteConflict[] = [];
  const currentByPath = new Map<string, { content: string | null; hash: string | null }>();
  for (const file of manifest.modifiedFiles.filter((entry) => entry.status === "completed")) {
    const content = await readOptional(input, file.path);
    const hash = content === null ? null : await sha256Text(content);
    currentByPath.set(file.path, { content, hash });
    if (hash !== (file.appliedHash ?? null)) conflicts.push({ path: file.path, expectedHash: file.appliedHash ?? null, currentHash: hash, reason: "Draft changed after this operation." });
  }
  const defaultPolicy = input.defaultPolicy ?? "cancel";
  const cancelled = conflicts.some((conflict) => (input.policies?.[conflict.path] ?? defaultPolicy) === "cancel");
  manifest.conflicts = conflicts;
  manifest.updatedAt = new Date().toISOString();
  if (cancelled) {
    manifest.status = "conflict";
    const saved = await commitAndPushTextFileMutation({
      ...input,
      expectedRemoteHeadSha: preflight.remoteHeadSha,
      message: `Record rollback conflict ${manifest.operationId}`,
      mutations: [{ path: input.manifestPath, content: renderManifest(manifest), expectedCurrentHash: await sha256Text(manifestRaw) }],
    });
    manifest.latestRemoteHeadSha = saved.commitSha;
    return { manifest, conflicts };
  }

  manifest.status = "rolledBack";
  const mutations: RepositoryTextMutation[] = [];
  for (const file of manifest.modifiedFiles.filter((entry) => entry.status === "completed")) {
    const current = currentByPath.get(file.path)!;
    const conflict = conflicts.find((entry) => entry.path === file.path);
    const policy = input.policies?.[file.path] ?? defaultPolicy;
    if (conflict && policy === "keep-current") {
      file.status = "kept-current";
      continue;
    }
    const snapshot = await loadFileContent(input.token, input.book.owner, input.book.repo, file.beforeSnapshotPath, input.branch);
    mutations.push({ path: file.path, content: file.existedBefore ? snapshot : null, expectedCurrentHash: policy === "force-restore" ? undefined : current.hash });
    file.status = "restored";
  }
  const rollbackManifestContent = renderManifest(manifest);
  mutations.push({ path: input.manifestPath, content: rollbackManifestContent, expectedCurrentHash: await sha256Text(manifestRaw) });
  const saved = await commitAndPushTextFileMutation({
    ...input,
    expectedRemoteHeadSha: preflight.remoteHeadSha,
    message: `Restore drafts before reader feedback rewrite ${manifest.operationId}`,
    mutations,
  });
  await finalizeSuccessfulManifest({
    ...input,
    manifest,
    manifestPath: input.manifestPath,
    persistedManifestContent: rollbackManifestContent,
    resultCommitSha: saved.commitSha,
    status: "rolledBack",
    message: `Finalize rollback ${manifest.operationId}`,
  });
  return { manifest, conflicts };
}
