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
export type FeedbackSourceMode = "panel-summary" | "reader-opinion";

export interface FeedbackSourceSelection {
  feedbackMode?: FeedbackSourceMode;
  feedbackPath?: string;
  readerId?: string;
  readerName?: string;
}

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
  finalSourcePath?: string;
  finalSourceHash?: string;
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
  feedbackMode: FeedbackSourceMode;
  feedbackPath: string;
  feedbackSummaryPath: string;
  feedbackReaderId?: string;
  feedbackReaderName?: string;
  feedbackSourceHash: string;
  feedbackFileHash?: string;
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

export class MissingReaderFeedbackOpinionError extends Error {
  readonly code = "MISSING_READER_FEEDBACK_OPINION";
  constructor(readonly path: string) {
    super(`A completed reader opinion is required at ${path}.`);
    this.name = "MissingReaderFeedbackOpinionError";
  }
}

export class StaleReaderFeedbackConfirmationError extends Error {
  readonly code = "STALE_READER_FEEDBACK_CONFIRMATION_REQUIRED";
  constructor() {
    super("The selected reader feedback is stale and requires explicit confirmation.");
    this.name = "StaleReaderFeedbackConfirmationError";
  }
}

export class RewriteFinalizationError extends Error {
  readonly code = "REWRITE_FINALIZATION_FAILED";
  readonly cause: unknown;
  constructor(readonly manifest: RewriteOperationManifest, readonly manifestPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`The drafts were saved, but finalizing the rewrite manifest failed: ${detail}`);
    this.name = "RewriteFinalizationError";
    this.cause = cause;
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
  feedbackMode: FeedbackSourceMode;
  feedbackPath: string;
  feedbackReaderId?: string;
  feedbackReaderName?: string;
  feedbackSummaryPath: string;
  feedbackSummaryHash: string;
  feedbackSourceHash: string;
  feedbackFileHash: string;
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
  feedbackMode: FeedbackSourceMode;
  readerId?: string;
  readerName?: string;
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
  const hasCompletedAt = Object.prototype.hasOwnProperty.call(parsed, "completedAt");
  const hasResultGitReference = Object.prototype.hasOwnProperty.call(parsed, "resultGitReference");
  const terminalMetadataComplete = hasCompletedAt && typeof parsed.completedAt === "string" && Boolean(parsed.completedAt)
    && hasResultGitReference && typeof parsed.resultGitReference === "string" && Boolean(parsed.resultGitReference);
  const statuses: RewriteOperationStatus[] = ["preparing", "rewriting", "saving", "completed", "failed", "cancelled", "rollingBack", "rolledBack", "conflict"];
  const parsedStatus: RewriteOperationStatus = typeof parsed.status === "string" && statuses.includes(parsed.status as RewriteOperationStatus)
    ? parsed.status as RewriteOperationStatus
    : "failed";
  const terminalFilesComplete = parsedStatus === "completed"
    ? modifiedFiles.length > 0 && modifiedFiles.every((file) => file.status === "completed")
    : parsedStatus === "rolledBack"
      ? modifiedFiles.every((file) => file.status === "restored" || file.status === "kept-current")
      : true;
  const terminalStateComplete = terminalMetadataComplete && terminalFilesComplete;
  const invalidTerminalState = (parsedStatus === "completed" || parsedStatus === "rolledBack") && !terminalStateComplete;
  const status: RewriteOperationStatus = (parsedStatus === "completed" || parsedStatus === "rolledBack") && !terminalStateComplete
    ? parsedStatus === "completed" && modifiedFiles.length > 0 && modifiedFiles.every((file) => file.status === "completed") ? "saving" : "failed"
    : parsedStatus;
  const latestReference = typeof parsed.latestRemoteHeadSha === "string" ? parsed.latestRemoteHeadSha : "";
  const baseReference = typeof parsed.baseRemoteHeadSha === "string" ? parsed.baseRemoteHeadSha : latestReference;
  const feedbackMode: FeedbackSourceMode = parsed.feedbackMode === "reader-opinion" ? "reader-opinion" : "panel-summary";
  const feedbackPath = typeof parsed.feedbackPath === "string"
    ? parsed.feedbackPath
    : typeof parsed.feedbackSummaryPath === "string" ? parsed.feedbackSummaryPath : "";
  return {
    ...parsed,
    operation: "rewriteFromReaderFeedback",
    bookId: typeof parsed.bookId === "string" ? parsed.bookId : fallbackBookId,
    chapterId: typeof parsed.chapterId === "string" ? parsed.chapterId : chapterSlug,
    chapterSlug,
    paragraphIds,
    startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : createdAt,
    completedAt: !invalidTerminalState && hasCompletedAt && (typeof parsed.completedAt === "string" || parsed.completedAt === null)
      ? parsed.completedAt
      : null,
    baseGitReference: typeof parsed.baseGitReference === "string" ? parsed.baseGitReference : baseReference,
    resultGitReference: !invalidTerminalState && hasResultGitReference && (typeof parsed.resultGitReference === "string" || parsed.resultGitReference === null)
      ? parsed.resultGitReference
      : null,
    status,
    createdAt,
    updatedAt,
    baseRemoteHeadSha: baseReference,
    latestRemoteHeadSha: latestReference || baseReference,
    feedbackMode,
    feedbackPath,
    feedbackSummaryPath: typeof parsed.feedbackSummaryPath === "string" ? parsed.feedbackSummaryPath : feedbackPath,
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

async function chapterReaderTarget(context: RewriteRepositoryContext, chapter: Chapter, frozenSources?: Array<{ raw: string; body: string; hash: string }>): Promise<ReaderEvaluationTarget> {
  const files = frozenSources ?? await Promise.all(chapter.paragraphs.map((paragraph) => loadParagraphSource(context, paragraph)));
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

interface LoadedFeedbackSource {
  mode: FeedbackSourceMode;
  primary: ReaderEvaluationRecord;
  raw: string;
  fileHash: string;
  sourceHash: string;
  evaluations: ReaderEvaluationRecord[];
}

function expectedReaderTargetId(target: ReaderEvaluationTarget): string {
  return target.type === "chapter"
    ? `chapter:${target.chapterId}`
    : `${target.type}:${target.chapterId}:${target.paragraphId ?? "chapter"}`;
}

function normalizedFeedbackMode(selection?: FeedbackSourceSelection): FeedbackSourceMode {
  return selection?.feedbackMode === "reader-opinion" ? "reader-opinion" : "panel-summary";
}

async function loadFeedbackSource(
  context: RewriteRepositoryContext,
  target: ReaderEvaluationTarget,
  selection?: FeedbackSourceSelection,
): Promise<LoadedFeedbackSource> {
  const sourceHash = await hashReaderSource(target.text);
  const mode = normalizedFeedbackMode(selection);
  const path = mode === "reader-opinion" ? selection?.feedbackPath ?? "" : selection?.feedbackPath ?? readerEvaluationSummaryPath(target);
  if (!path) throw new MissingReaderFeedbackOpinionError(path);
  const [opinionPrefix] = readerEvaluationTargetPrefixes(target);
  if (mode === "panel-summary" && path !== readerEvaluationSummaryPath(target)) throw new MissingReaderFeedbackSummaryError(path);
  if (mode === "reader-opinion" && !path.startsWith(opinionPrefix)) throw new MissingReaderFeedbackOpinionError(path);
  const file = context.structure.readerEvaluationFiles.find((entry) => entry.path === path);
  const raw = file?.content ?? await readOptional(context, path);
  if (!raw) {
    if (mode === "reader-opinion") throw new MissingReaderFeedbackOpinionError(path);
    throw new MissingReaderFeedbackSummaryError(path);
  }
  const primary = parseReaderEvaluation(path, raw, sourceHash);
  const validTarget = primary.status === "completed" && primary.targetType === target.type && primary.targetId === expectedReaderTargetId(target);
  const validReader = mode === "panel-summary"
    ? primary.readerId === "summary"
    : primary.readerId !== "summary" && Boolean(selection?.readerId) && primary.readerId === selection?.readerId;
  if (!validTarget || !validReader) {
    if (mode === "reader-opinion") throw new MissingReaderFeedbackOpinionError(path);
    throw new MissingReaderFeedbackSummaryError(path);
  }
  primary.stale = !primary.sourceContentHash || primary.sourceContentHash !== sourceHash;
  const evaluations = mode === "panel-summary" ? await loadCurrentEvaluations(context, target, sourceHash, path) : [];
  return {
    mode,
    primary,
    raw,
    fileHash: await sha256Text(raw),
    sourceHash,
    evaluations,
  };
}

async function loadFeedback(context: RewriteRepositoryContext, target: ReaderEvaluationTarget): Promise<LoadedFeedbackSource> {
  return loadFeedbackSource(context, target);
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

async function loadCurrentReaderOpinion(
  context: RewriteRepositoryContext,
  target: ReaderEvaluationTarget,
  readerId: string,
): Promise<{ record: ReaderEvaluationRecord; fileHash: string } | null> {
  const sourceHash = await hashReaderSource(target.text);
  const records = await loadCurrentEvaluations(context, target, sourceHash);
  const record = records.find((entry) => entry.readerId === readerId);
  if (!record) return null;
  const file = context.structure.readerEvaluationFiles.find((entry) => entry.path === record.path);
  const raw = file?.content ?? await readOptional(context, record.path);
  return raw ? { record, fileHash: await sha256Text(raw) } : null;
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
  feedbackMode: FeedbackSourceMode;
  primaryFeedback: ReaderEvaluationRecord;
  paragraphFeedback?: ReaderEvaluationRecord;
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
        input.feedbackMode === "panel-summary"
          ? `REQUIRED TARGET FEEDBACK RECAP:\n${input.primaryFeedback.body}`
          : `REQUIRED SELECTED READER OPINION (${input.primaryFeedback.readerName}):\n${input.primaryFeedback.body}`,
        input.paragraphFeedback
          ? input.feedbackMode === "panel-summary"
            ? `PARAGRAPH FEEDBACK RECAP:\n${input.paragraphFeedback.body}`
            : `PARAGRAPH-SPECIFIC OPINION FROM ${input.primaryFeedback.readerName}:\n${input.paragraphFeedback.body}`
          : "",
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
  feedbackSource?: FeedbackSourceSelection;
}): Promise<ReaderFeedbackSummaryState> {
  const { chapter, paragraph } = resolveTarget(input.structure, input.chapterSlug, input.paragraphSlug);
  if (paragraph) {
    const source = await loadParagraphSource(input, paragraph);
    const feedback = await loadFeedbackSource(input, paragraphReaderTarget(input, chapter, paragraph, source), input.feedbackSource);
    return { path: feedback.primary.path, stale: Boolean(feedback.primary.stale), feedbackMode: feedback.mode, readerId: feedback.primary.readerId, readerName: feedback.primary.readerName };
  }
  const feedback = await loadFeedbackSource(input, await chapterReaderTarget(input, chapter), input.feedbackSource);
  return { path: feedback.primary.path, stale: Boolean(feedback.primary.stale), feedbackMode: feedback.mode, readerId: feedback.primary.readerId, readerName: feedback.primary.readerName };
}

export async function prepareParagraphFeedbackProposal(input: RewriteRepositoryContext & {
  chapterSlug: string;
  paragraphSlug: string;
  feedbackSource?: FeedbackSourceSelection;
  signal?: AbortSignal;
}): Promise<ParagraphFeedbackProposal> {
  await preflightRepositoryOperation(input);
  const { chapter, paragraph } = resolveTarget(input.structure, input.chapterSlug, input.paragraphSlug);
  const final = await loadParagraphSource(input, paragraph!);
  const target = paragraphReaderTarget(input, chapter, paragraph!, final);
  const feedback = await loadFeedbackSource(input, target, input.feedbackSource);
  const draft = await loadCurrentDraft(input, chapter, paragraph!);
  const index = chapter.paragraphs.indexOf(paragraph!);
  const [previous, next] = await Promise.all([
    index > 0 ? loadParagraphSource(input, chapter.paragraphs[index - 1]).then((value) => value.body) : "",
    index + 1 < chapter.paragraphs.length ? loadParagraphSource(input, chapter.paragraphs[index + 1]).then((value) => value.body) : "",
  ]);
  const writingContext = await loadWritingContext(input, chapter, { previous, next }, `${final.body}\n${feedback.primary.body}`);
  const generated = await generateParagraph({
    context: input,
    chapter,
    paragraph: paragraph!,
    draftBody: splitMarkdown(draft.sourceContent ?? "").body,
    finalBody: final.body,
    feedbackMode: feedback.mode,
    primaryFeedback: feedback.primary,
    paragraphFeedback: undefined,
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
    staleFeedback: Boolean(feedback.primary.stale),
    feedbackMode: feedback.mode,
    feedbackPath: feedback.primary.path,
    feedbackReaderId: feedback.mode === "reader-opinion" ? feedback.primary.readerId : undefined,
    feedbackReaderName: feedback.mode === "reader-opinion" ? feedback.primary.readerName : undefined,
    feedbackSummaryPath: feedback.primary.path,
    feedbackSummaryHash: feedback.fileHash,
    feedbackSourceHash: feedback.sourceHash,
    feedbackFileHash: feedback.fileHash,
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
  feedbackMode: FeedbackSourceMode;
  feedbackPath: string;
  feedbackReaderId?: string;
  feedbackReaderName?: string;
  feedbackSourceHash: string;
  feedbackFileHash: string;
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
    feedbackMode: input.feedbackMode,
    feedbackPath: input.feedbackPath,
    feedbackSummaryPath: input.feedbackPath,
    feedbackReaderId: input.feedbackReaderId,
    feedbackReaderName: input.feedbackReaderName,
    feedbackSourceHash: input.feedbackSourceHash,
    feedbackFileHash: input.feedbackFileHash,
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
  const terminalManifest = structuredClone(input.manifest);
  terminalManifest.status = input.status;
  terminalManifest.completedAt = completedAt;
  terminalManifest.updatedAt = completedAt;
  terminalManifest.resultGitReference = input.resultCommitSha;
  terminalManifest.latestRemoteHeadSha = input.resultCommitSha;
  try {
    const finalized = await commitAndPushTextFileMutation({
      ...input,
      expectedRemoteHeadSha: input.resultCommitSha,
      message: input.message,
      mutations: [{
        path: input.manifestPath,
        content: renderManifest(terminalManifest),
        expectedCurrentHash: await sha256Text(input.persistedManifestContent),
      }],
    });
    terminalManifest.latestRemoteHeadSha = finalized.commitSha;
    Object.assign(input.manifest, terminalManifest);
  } catch (error) {
    input.manifest.error = `Finalization failed: ${error instanceof Error ? error.message : String(error)}`;
    throw new RewriteFinalizationError(input.manifest, input.manifestPath, error);
  }
}

export async function applyParagraphFeedbackProposal(input: RewriteRepositoryContext & {
  proposal: ParagraphFeedbackProposal;
  feedbackSource?: FeedbackSourceSelection;
  confirmStaleFeedback?: boolean;
}): Promise<RewriteOperationManifest> {
  const proposal = input.proposal;
  if (input.feedbackSource) {
    const mode = normalizedFeedbackMode(input.feedbackSource);
    if (mode !== proposal.feedbackMode
      || (input.feedbackSource.feedbackPath && input.feedbackSource.feedbackPath !== proposal.feedbackPath)
      || (mode === "reader-opinion" && input.feedbackSource.readerId !== proposal.feedbackReaderId)) {
      throw new RepositoryConflictError("The selected reader feedback changed after the proposal was generated.");
    }
  }
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
    finalSourcePath: proposal.finalSourcePath,
    finalSourceHash: proposal.finalSourceHash,
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
    feedbackMode: proposal.feedbackMode,
    feedbackPath: proposal.feedbackPath,
    feedbackReaderId: proposal.feedbackReaderId,
    feedbackReaderName: proposal.feedbackReaderName,
    feedbackSourceHash: proposal.feedbackSourceHash,
    feedbackFileHash: proposal.feedbackFileHash,
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
      { path: proposal.feedbackPath, expectedCurrentHash: proposal.feedbackFileHash },
      { path: proposal.finalSourcePath, expectedCurrentHash: proposal.finalSourceHash },
    ],
  });
  manifest.status = "saving";
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
        { path: proposal.feedbackPath, expectedCurrentHash: proposal.feedbackFileHash },
        { path: proposal.finalSourcePath, expectedCurrentHash: proposal.finalSourceHash },
        ...(!proposal.canonicalDraftExisted ? [{ path: proposal.legacyDraftPath, expectedCurrentHash: proposal.legacyDraftHash }] : []),
      ],
    });
    resultCommitSha = saved.commitSha;
  } catch (error) {
    manifest.status = error instanceof RepositoryConflictError ? "conflict" : "failed";
    manifest.error = error instanceof Error ? error.message : String(error);
    modifiedFile.status = manifest.status === "conflict" ? "conflict" : "failed";
    try {
      const failed = await commitAndPushTextFileMutation({
        ...input,
        expectedRemoteHeadSha: checkpoint.commitSha,
        message: `Record ${manifest.status} reader feedback rewrite ${proposal.paragraphSlug}`,
        mutations: [{ path: manifestPath, content: renderManifest(manifest), expectedCurrentHash: await sha256Text(checkpointContent) }],
      });
      manifest.latestRemoteHeadSha = failed.commitSha;
    } catch (saveError) {
      manifest.error += `\n\nAdditionally, recording this failure failed: ${saveError instanceof Error ? saveError.message : String(saveError)}`;
    }
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
  feedbackSource?: FeedbackSourceSelection;
  confirmed: boolean;
  confirmStaleFeedback?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: RewriteOperationProgress, manifest: RewriteOperationManifest) => void;
}): Promise<RewriteOperationManifest> {
  if (!input.confirmed) throw new Error("Explicit confirmation is required before rewriting a chapter.");
  const { chapter } = resolveTarget(input.structure, input.chapterSlug);
  const finalSources = await Promise.all(chapter.paragraphs.map((paragraph) => loadParagraphSource(input, paragraph)));
  const chapterTarget = await chapterReaderTarget(input, chapter, finalSources);
  const chapterFeedback = await loadFeedbackSource(input, chapterTarget, input.feedbackSource);
  if (chapterFeedback.primary.stale && !input.confirmStaleFeedback) throw new StaleReaderFeedbackConfirmationError();
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
      finalSourcePath: paragraph.path,
      finalSourceHash: finalSources[index].hash,
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
    feedbackMode: chapterFeedback.mode,
    feedbackPath: chapterFeedback.primary.path,
    feedbackReaderId: chapterFeedback.mode === "reader-opinion" ? chapterFeedback.primary.readerId : undefined,
    feedbackReaderName: chapterFeedback.mode === "reader-opinion" ? chapterFeedback.primary.readerName : undefined,
    feedbackSourceHash: chapterFeedback.sourceHash,
    feedbackFileHash: chapterFeedback.fileHash,
    staleFeedback: Boolean(chapterFeedback.primary.stale),
    modifiedFiles,
  });
  let manifestContent = renderManifest(manifest);
  const checkpointMutations: RepositoryTextMutation[] = [
    { path: manifestPath, content: manifestContent, expectedCurrentHash: null },
    { path: chapterFeedback.primary.path, expectedCurrentHash: chapterFeedback.fileHash },
  ];
  for (let index = 0; index < modifiedFiles.length; index++) {
    checkpointMutations.push({
      path: modifiedFiles[index].beforeSnapshotPath,
      content: drafts[index].canonicalContent ?? "---\ntype: rewriteSnapshot\nexists: false\n---\n",
      expectedCurrentHash: null,
    });
    checkpointMutations.push({ path: drafts[index].canonicalPath, expectedCurrentHash: drafts[index].canonicalHash });
    checkpointMutations.push({ path: drafts[index].legacyPath, expectedCurrentHash: drafts[index].legacyHash });
    checkpointMutations.push({ path: chapter.paragraphs[index].path, expectedCurrentHash: finalSources[index].hash });
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
      const final = finalSources[index];
      const paragraphTarget = paragraphReaderTarget(input, chapter, paragraph, final);
      let paragraphFeedback: Awaited<ReturnType<typeof loadFeedback>> | null = null;
      let paragraphEvaluations: ReaderEvaluationRecord[] = [];
      let selectedParagraphOpinion: Awaited<ReturnType<typeof loadCurrentReaderOpinion>> = null;
      if (chapterFeedback.mode === "reader-opinion") {
        selectedParagraphOpinion = await loadCurrentReaderOpinion(input, paragraphTarget, chapterFeedback.primary.readerId);
      } else {
        try { paragraphFeedback = await loadFeedback(input, paragraphTarget); } catch (error) {
          if (!(error instanceof MissingReaderFeedbackSummaryError)) throw error;
          paragraphEvaluations = await loadCurrentEvaluations(input, paragraphTarget, await hashReaderSource(paragraphTarget.text));
        }
        if (paragraphFeedback?.primary.stale) {
          paragraphEvaluations = paragraphFeedback.evaluations;
          paragraphFeedback = null;
        }
      }
      const previous = index > 0 ? (rewritten[index - 1] ?? finalSources[index - 1].body) : "";
      const next = index + 1 < chapter.paragraphs.length ? finalSources[index + 1].body : "";
      const paragraphOpinion = selectedParagraphOpinion?.record ?? paragraphFeedback?.primary;
      const writingContext = await loadWritingContext(input, chapter, { previous, next, alreadyRewritten: rewritten }, `${chapterFeedback.primary.body}\n${paragraphOpinion?.body ?? ""}\n${final.body}`);
      const generated = await generateParagraph({
        context: input,
        chapter,
        paragraph,
        draftBody: splitMarkdown(drafts[index].sourceContent ?? "").body,
        finalBody: final.body,
        feedbackMode: chapterFeedback.mode,
        primaryFeedback: chapterFeedback.primary,
        paragraphFeedback: paragraphOpinion,
        evaluations: chapterFeedback.mode === "reader-opinion" ? [] : paragraphFeedback?.evaluations ?? (paragraphEvaluations.length ? paragraphEvaluations : chapterFeedback.evaluations),
        writingContext,
        signal: input.signal,
      });
      const generatedContent = drafts[index].sourceContent
        ? replaceMarkdownBody(drafts[index].sourceContent!, generated.output.body)
        : canonicalDraftContent(chapter, paragraph, final.raw, generated.output.body);
      rewritten.push(generated.output.body);
      const nextManifest = structuredClone(manifest);
      nextManifest.status = index === chapter.paragraphs.length - 1 ? "saving" : "rewriting";
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
          { path: chapterFeedback.primary.path, expectedCurrentHash: chapterFeedback.fileHash },
          ...(drafts[index].canonicalContent === null ? [{ path: drafts[index].legacyPath, expectedCurrentHash: drafts[index].legacyHash }] : []),
          ...(selectedParagraphOpinion ? [{ path: selectedParagraphOpinion.record.path, expectedCurrentHash: selectedParagraphOpinion.fileHash }] : []),
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
    if (current && current.status === "pending") current.status = manifest.status === "conflict" ? "conflict" : "failed";
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
      manifest.error += `\n\nAdditionally, recording this failure failed: ${saveError instanceof Error ? saveError.message : String(saveError)}`;
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
  feedbackSource?: FeedbackSourceSelection;
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
  const allFilesCompleted = manifest.modifiedFiles.length > 0 && manifest.modifiedFiles.every((file) => file.status === "completed");
  if (allFilesCompleted && manifest.status === "saving") {
    const preflight = await preflightRepositoryOperation(input);
    await finalizeSuccessfulManifest({
      ...input,
      manifest,
      manifestPath: input.manifestPath,
      persistedManifestContent: manifestRaw,
      resultCommitSha: preflight.remoteHeadSha,
      status: "completed",
      message: `Finalize resumed reader feedback rewrite ${chapter.slug}`,
    });
    return manifest;
  }
  if (!manifest.modifiedFiles.some((file) => file.status === "pending" || file.status === "failed" || file.status === "conflict")) return manifest;

  const finalSources = await Promise.all(chapter.paragraphs.map((paragraph) => loadParagraphSource(input, paragraph)));
  for (let index = 0; index < chapter.paragraphs.length; index++) {
    const file = manifest.modifiedFiles[index];
    if (!file || file.paragraphSlug !== paragraphSlug(chapter.paragraphs[index])) throw new Error("The chapter structure no longer matches this rewrite operation.");
    if (!file.finalSourceHash || file.finalSourcePath !== chapter.paragraphs[index].path) {
      throw new RepositoryConflictError(`The rewrite checkpoint does not contain a frozen final source for ${chapter.paragraphs[index].path}.`, chapter.paragraphs[index].path);
    }
    if (finalSources[index].hash !== file.finalSourceHash) throw new RepositoryConflictError(`Final paragraph source changed after this operation started: ${file.finalSourcePath}`, file.finalSourcePath);
  }

  const manifestSelection: FeedbackSourceSelection = {
    feedbackMode: manifest.feedbackMode,
    feedbackPath: manifest.feedbackPath,
    readerId: manifest.feedbackReaderId,
    readerName: manifest.feedbackReaderName,
  };
  if (input.feedbackSource) {
    const requestedMode = normalizedFeedbackMode(input.feedbackSource);
    if (requestedMode !== manifest.feedbackMode
      || (input.feedbackSource.feedbackPath && input.feedbackSource.feedbackPath !== manifest.feedbackPath)
      || (requestedMode === "reader-opinion" && input.feedbackSource.readerId !== manifest.feedbackReaderId)) {
      throw new RepositoryConflictError("The selected reader feedback does not match the original operation.");
    }
  }
  const chapterFeedback = await loadFeedbackSource(input, await chapterReaderTarget(input, chapter, finalSources), manifestSelection);
  const feedbackHashChanged = chapterFeedback.sourceHash !== manifest.feedbackSourceHash
    || Boolean(manifest.feedbackFileHash && chapterFeedback.fileHash !== manifest.feedbackFileHash);
  if (chapterFeedback.primary.path !== manifest.feedbackPath
    || chapterFeedback.primary.readerId !== (manifest.feedbackMode === "reader-opinion" ? manifest.feedbackReaderId : "summary")
    || (manifest.feedbackReaderName && chapterFeedback.primary.readerName !== manifest.feedbackReaderName)
    || feedbackHashChanged) {
    throw new RepositoryConflictError("The reader feedback or chapter source changed after this operation started.");
  }
  if (chapterFeedback.primary.stale && !input.confirmStaleFeedback) throw new StaleReaderFeedbackConfirmationError();
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

      const final = finalSources[index];
      const draft = await loadCurrentDraft(input, chapter, paragraph);
      if (draft.canonicalHash !== file.beforeHash) throw new RepositoryConflictError(`Pending draft changed after this operation started: ${file.path}`, file.path);
      const sourceHash = file.sourceDraftPath === draft.legacyPath ? draft.legacyHash : draft.canonicalHash;
      if (file.sourceDraftHash !== undefined && sourceHash !== file.sourceDraftHash) throw new RepositoryConflictError(`Source draft changed after this operation started: ${file.sourceDraftPath}`, file.sourceDraftPath);
      const paragraphTarget = paragraphReaderTarget(input, chapter, paragraph, final);
      let paragraphFeedback: Awaited<ReturnType<typeof loadFeedback>> | null = null;
      let paragraphEvaluations: ReaderEvaluationRecord[] = [];
      let selectedParagraphOpinion: Awaited<ReturnType<typeof loadCurrentReaderOpinion>> = null;
      if (chapterFeedback.mode === "reader-opinion") {
        selectedParagraphOpinion = await loadCurrentReaderOpinion(input, paragraphTarget, chapterFeedback.primary.readerId);
      } else {
        try { paragraphFeedback = await loadFeedback(input, paragraphTarget); } catch (error) {
          if (!(error instanceof MissingReaderFeedbackSummaryError)) throw error;
          paragraphEvaluations = await loadCurrentEvaluations(input, paragraphTarget, await hashReaderSource(paragraphTarget.text));
        }
        if (paragraphFeedback?.primary.stale) {
          paragraphEvaluations = paragraphFeedback.evaluations;
          paragraphFeedback = null;
        }
      }
      const previous = index > 0 ? (rewritten[index - 1] ?? finalSources[index - 1].body) : "";
      const next = index + 1 < chapter.paragraphs.length ? finalSources[index + 1].body : "";
      const paragraphOpinion = selectedParagraphOpinion?.record ?? paragraphFeedback?.primary;
      const writingContext = await loadWritingContext(input, chapter, { previous, next, alreadyRewritten: rewritten.filter(Boolean) }, `${chapterFeedback.primary.body}\n${paragraphOpinion?.body ?? ""}\n${final.body}`);
      const generated = await generateParagraph({
        context: input,
        chapter,
        paragraph,
        draftBody: splitMarkdown(draft.sourceContent ?? "").body,
        finalBody: final.body,
        feedbackMode: chapterFeedback.mode,
        primaryFeedback: chapterFeedback.primary,
        paragraphFeedback: paragraphOpinion,
        evaluations: chapterFeedback.mode === "reader-opinion" ? [] : paragraphFeedback?.evaluations ?? (paragraphEvaluations.length ? paragraphEvaluations : chapterFeedback.evaluations),
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
      nextManifest.status = nextManifest.progress.completed === nextManifest.progress.total ? "saving" : "rewriting";
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
          { path: chapterFeedback.primary.path, expectedCurrentHash: chapterFeedback.fileHash },
          ...(file.sourceDraftPath && file.sourceDraftPath !== file.path ? [{ path: file.sourceDraftPath, expectedCurrentHash: file.sourceDraftHash }] : []),
          ...(selectedParagraphOpinion ? [{ path: selectedParagraphOpinion.record.path, expectedCurrentHash: selectedParagraphOpinion.fileHash }] : []),
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
      manifest.error += `\n\nAdditionally, recording this failure failed: ${saveError instanceof Error ? saveError.message : String(saveError)}`;
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

  manifest.status = "rollingBack";
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
