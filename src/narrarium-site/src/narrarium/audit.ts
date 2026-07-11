import { parseDocument, stringify } from "yaml";
import { completeToolRouted } from "@/assistant/router";
import type { LlmRunMetadata } from "@/assistant/llm";
import { createOrUpdateTextFile, deleteFile, readFileWithSha } from "@/github/githubClient";
import {
  buildBookAuditPath,
  buildChapterAuditPath,
  buildParagraphAuditPath,
  extractParagraphSlug,
  findOrphanAuditPaths,
} from "@/narrarium/auditPaths";
import type { BookFile, BookStructure, Chapter, Paragraph } from "@/types/book";
import {
  resolveBookAuditSettings,
  type AppSettings,
  type AuditDepth,
  type AuditSettings,
  type BookEntry,
} from "@/types/settings";

export type AuditScope = "book" | "chapter" | "paragraph";
export type AuditSeverity = "critical" | "high" | "medium" | "low" | "informational";
export type AuditCertainty = "confirmed" | "probable" | "possible" | "needs-context";
export type AuditFindingStatus = "open" | "resolved" | "ignored" | "false-positive" | "needs-review";
export type AuditRunState = "pending" | "preparingContext" | "running" | "synthesizing" | "completed" | "failed" | "cancelled";
export type AuditResult = "passed" | "passed-with-warnings" | "needs-review" | "failed";

export const AUDIT_CATEGORIES = [
  "timeline",
  "secret",
  "character",
  "character-voice",
  "character-knowledge",
  "relationship",
  "location",
  "item",
  "faction",
  "worldbuilding",
  "plot",
  "spatial-continuity",
  "narrative-continuity",
  "point-of-view",
  "writing-style",
  "terminology",
  "metadata",
  "missing-information",
  "punctuation-consistency",
  "other",
] as const;

export type BuiltInAuditCategory = (typeof AUDIT_CATEGORIES)[number];
export type AuditCategory = BuiltInAuditCategory | (string & Record<never, never>);

export interface AuditPosition {
  bookId: string;
  chapterId?: string;
  paragraphId?: string;
  textOffset?: number;
  excerpt?: string;
  heading?: string;
  sourcePath?: string;
}

export interface AuditSourceRef {
  path: string;
  chapterId?: string;
  paragraphId?: string;
  heading?: string;
  textOffset?: number;
}

export interface AuditFinding {
  id: string;
  stableKey: string;
  category: AuditCategory;
  severity: AuditSeverity;
  certainty: AuditCertainty;
  status: AuditFindingStatus;
  position: AuditPosition;
  description: string;
  evidence: string;
  structuredSourceRef: AuditSourceRef;
  conflictExplanation: string;
  correctionSuggestion: string;
  authorNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditSourceManifestEntry {
  path: string;
  hash: string;
  role: string;
}

export interface AuditTarget {
  scope: AuditScope;
  bookId: string;
  chapterId?: string;
  paragraphNum?: string;
}

export interface ResolvedAuditTarget extends AuditTarget {
  paragraphId?: string;
  title: string;
  targetId: string;
  reportPath: string;
  sourcePath: string;
  href: string;
  sourceHref: string;
}

export interface AuditReport {
  schemaVersion: number;
  type: "audit";
  id: string;
  scope: AuditScope;
  bookId: string;
  chapterId?: string;
  paragraphId?: string;
  paragraphNum?: string;
  targetId: string;
  targetTitle: string;
  reportPath: string;
  sourcePath: string;
  href: string;
  sourceHref: string;
  language: string;
  depth: AuditDepth;
  status: "completed";
  createdAt: string;
  updatedAt: string;
  sourceManifest: AuditSourceManifestEntry[];
  sourceHash: string;
  timelineVersion: string;
  secretsVersion: string;
  entityContextHash: string;
  contextSettings: AuditSettings;
  strategy: "hierarchical-complete-coverage";
  passCount: number;
  chunkCount: number;
  maxChunkCharacters: number;
  generationRuns: LlmRunMetadata[];
  requestIds: string[];
  providers: string[];
  integrationIds: string[];
  models: string[];
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost?: number;
  currency?: string;
  findings: AuditFinding[];
  executiveSummary: string;
  recommendedFixOrder: string[];
  finalAssessment: string;
  auditResult: AuditResult;
  missingContext: string[];
  body: string;
  stale?: boolean;
  currentSourceHash?: string;
}

export interface AuditProgress {
  state: AuditRunState;
  completedCalls: number;
  totalCalls: number;
  currentPass?: number;
  detail?: string;
}

interface AuditServiceBase {
  token: string;
  book: BookEntry;
  branch: string;
  structure: BookStructure;
  target: AuditTarget;
}

export interface RunAuditInput extends AuditServiceBase {
  settings: AppSettings;
  depth?: AuditDepth;
  signal?: AbortSignal;
  onProgress?: (progress: AuditProgress) => void;
}

export interface AuditDocument {
  path: string;
  role: string;
  group: string;
  content: string;
  hash: string;
}

export interface AuditContext {
  documents: AuditDocument[];
  sourceManifest: AuditSourceManifestEntry[];
  sourceHash: string;
  timelineVersion: string;
  secretsVersion: string;
  entityContextHash: string;
  missingContext: string[];
}

export interface AuditChunk {
  group: string;
  index: number;
  sourcePaths: string[];
  content: string;
}

interface ModelFinding {
  stableKey?: string;
  category?: string;
  severity?: string;
  certainty?: string;
  position?: Partial<AuditPosition>;
  description?: string;
  evidence?: string;
  structuredSourceRef?: Partial<AuditSourceRef>;
  conflictExplanation?: string;
  correctionSuggestion?: string;
}

interface AuditClaim {
  subject?: string;
  predicate?: string;
  value?: string;
  evidence?: string;
  sourcePath?: string;
}

interface AuditPassOutput {
  findings: ModelFinding[];
  executiveSummary: string;
  recommendedFixOrder: string[];
  finalAssessment: string;
  auditResult: AuditResult;
  missingContext: string[];
  coverageNotes: string[];
  claims: AuditClaim[];
}

const REPORT_SCHEMA_VERSION = 1;
const MAX_CHUNK_CHARACTERS = 45_000;
const ENTITY_ROLES = new Set(["character", "location", "item", "faction"]);
const SEVERITIES: AuditSeverity[] = ["critical", "high", "medium", "low", "informational"];
const CERTAINTIES: AuditCertainty[] = ["confirmed", "probable", "possible", "needs-context"];
const FINDING_STATUSES: AuditFindingStatus[] = ["open", "resolved", "ignored", "false-positive", "needs-review"];
const RESULTS: AuditResult[] = ["passed", "passed-with-warnings", "needs-review", "failed"];

const AUDIT_TOOL = {
  name: "submit_audit_pass",
  description: "Submit a strict, evidence-based audit pass over every supplied source segment.",
  parameters: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            stableKey: { type: "string", description: "Stable semantic key for the underlying issue, independent of prose wording." },
            category: { type: "string" },
            severity: { type: "string", enum: SEVERITIES },
            certainty: { type: "string", enum: CERTAINTIES },
            position: {
              type: "object",
              properties: {
                bookId: { type: "string" },
                chapterId: { type: "string" },
                paragraphId: { type: "string" },
                textOffset: { type: "number" },
                excerpt: { type: "string" },
                heading: { type: "string" },
                sourcePath: { type: "string" },
              },
              required: ["bookId", "sourcePath"],
              additionalProperties: false,
            },
            description: { type: "string" },
            evidence: { type: "string" },
            structuredSourceRef: {
              type: "object",
              properties: {
                path: { type: "string" },
                chapterId: { type: "string" },
                paragraphId: { type: "string" },
                heading: { type: "string" },
                textOffset: { type: "number" },
              },
              required: ["path"],
              additionalProperties: false,
            },
            conflictExplanation: { type: "string" },
            correctionSuggestion: { type: "string" },
          },
          required: ["stableKey", "category", "severity", "certainty", "position", "description", "evidence", "structuredSourceRef", "conflictExplanation", "correctionSuggestion"],
          additionalProperties: false,
        },
      },
      executiveSummary: { type: "string" },
      recommendedFixOrder: { type: "array", items: { type: "string" } },
      finalAssessment: { type: "string" },
      auditResult: { type: "string", enum: RESULTS },
      missingContext: { type: "array", items: { type: "string" } },
      coverageNotes: { type: "array", items: { type: "string" } },
      claims: {
        type: "array",
        description: "Compact source-grounded claims needed to detect contradictions in later synthesis passes.",
        items: {
          type: "object",
          properties: {
            subject: { type: "string" },
            predicate: { type: "string" },
            value: { type: "string" },
            evidence: { type: "string" },
            sourcePath: { type: "string" },
          },
          required: ["subject", "predicate", "value", "evidence", "sourcePath"],
          additionalProperties: false,
        },
      },
    },
    required: ["findings", "executiveSummary", "recommendedFixOrder", "finalAssessment", "auditResult", "missingContext", "coverageNotes", "claims"],
    additionalProperties: false,
  },
};

export function resolveAuditTarget(structure: BookStructure, target: AuditTarget): ResolvedAuditTarget {
  const bookRoot = `/app/books/${encodeURIComponent(target.bookId)}`;
  if (target.scope === "book") {
    return {
      ...target,
      title: structure.title,
      targetId: `book:${target.bookId}`,
      reportPath: buildBookAuditPath(),
      sourcePath: "book.md",
      href: `${bookRoot}/audit`,
      sourceHref: bookRoot,
    };
  }

  const chapter = structure.chapters.find((entry) => entry.slug === target.chapterId);
  if (!chapter) throw new Error(`Chapter not found: ${target.chapterId ?? ""}`);
  const chapterRoot = `${bookRoot}/chapters/${encodeURIComponent(chapter.slug)}`;
  if (target.scope === "chapter") {
    return {
      ...target,
      chapterId: chapter.slug,
      title: chapter.title,
      targetId: `chapter:${chapter.slug}`,
      reportPath: buildChapterAuditPath(chapter.slug),
      sourcePath: `${chapter.path}/chapter.md`,
      href: `${chapterRoot}/audit`,
      sourceHref: chapterRoot,
    };
  }

  const paragraph = chapter.paragraphs.find((entry) => entry.number === target.paragraphNum);
  if (!paragraph) throw new Error(`Paragraph not found: ${target.paragraphNum ?? ""}`);
  const paragraphId = extractParagraphSlug(paragraph.path);
  const paragraphRoot = `${chapterRoot}/paragraphs/${encodeURIComponent(paragraph.number)}`;
  return {
    ...target,
    chapterId: chapter.slug,
    paragraphNum: paragraph.number,
    paragraphId,
    title: paragraph.title,
    targetId: `paragraph:${chapter.slug}:${paragraphId}`,
    reportPath: buildParagraphAuditPath(chapter.slug, paragraphId),
    sourcePath: paragraph.path,
    href: `${paragraphRoot}/audit`,
    sourceHref: paragraphRoot,
  };
}

export function auditTargetPath(structure: BookStructure, target: AuditTarget): string {
  return resolveAuditTarget(structure, target).reportPath;
}

export function auditTargetHref(structure: BookStructure, target: AuditTarget): string {
  return resolveAuditTarget(structure, target).href;
}

export function auditSourceHref(structure: BookStructure, target: AuditTarget): string {
  return resolveAuditTarget(structure, target).sourceHref;
}

export function findingSourceHref(structure: BookStructure, target: ResolvedAuditTarget, finding: AuditFinding): string {
  const sourcePath = finding.structuredSourceRef.path || finding.position.sourcePath;
  const bookRoot = `/app/books/${encodeURIComponent(target.bookId)}`;
  if (sourcePath === "book.md") return bookRoot;
  for (const chapter of structure.chapters) {
    const chapterRoot = `/app/books/${encodeURIComponent(target.bookId)}/chapters/${encodeURIComponent(chapter.slug)}`;
    const paragraph = chapter.paragraphs.find((entry) => entry.path === sourcePath);
    if (paragraph) return `${chapterRoot}/paragraphs/${encodeURIComponent(paragraph.number)}`;
    if (`${chapter.path}/chapter.md` === sourcePath) return chapterRoot;
  }
  const referencedChapter = structure.chapters.find((chapter) => chapter.slug === finding.position.chapterId);
  if (referencedChapter) {
    const chapterRoot = `${bookRoot}/chapters/${encodeURIComponent(referencedChapter.slug)}`;
    const paragraph = referencedChapter.paragraphs.find((entry) => extractParagraphSlug(entry.path) === finding.position.paragraphId);
    return paragraph ? `${chapterRoot}/paragraphs/${encodeURIComponent(paragraph.number)}` : chapterRoot;
  }
  return target.sourceHref;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function aggregateManifest(entries: Array<Pick<AuditSourceManifestEntry, "path" | "hash">>): Promise<string> {
  return sha256(entries
    .map((entry) => `${entry.path}\0${entry.hash}`)
    .sort((left, right) => left.localeCompare(right))
    .join("\n"));
}

function chapterForTarget(structure: BookStructure, target: ResolvedAuditTarget): Chapter | undefined {
  return target.chapterId ? structure.chapters.find((chapter) => chapter.slug === target.chapterId) : undefined;
}

function paragraphForTarget(chapter: Chapter | undefined, target: ResolvedAuditTarget): Paragraph | undefined {
  return chapter?.paragraphs.find((paragraph) => paragraph.number === target.paragraphNum);
}

function entityName(file: BookFile): string {
  const slug = extractParagraphSlug(file.path).replace(/[-_]+/g, " ");
  return (file.name ?? slug).trim();
}

function textMentionsFile(text: string, file: BookFile): boolean {
  const haystack = text.toLocaleLowerCase();
  const name = entityName(file).toLocaleLowerCase();
  const slug = extractParagraphSlug(file.path).toLocaleLowerCase();
  return (name.length > 2 && haystack.includes(name)) || (slug.length > 2 && haystack.includes(slug));
}

export async function buildAuditContext(input: AuditServiceBase & { contextSettings?: AuditSettings }): Promise<AuditContext> {
  const target = resolveAuditTarget(input.structure, input.target);
  const auditSettings = input.contextSettings ?? resolveBookAuditSettings(input.book);
  const documents: AuditDocument[] = [];
  const missingContext: string[] = [];
  const seen = new Set<string>();

  const add = async (path: string | undefined, role: string, group: string, required = false) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    try {
      const file = await readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, path);
      documents.push({ path, role, group, content: file.content, hash: await sha256(file.content) });
    } catch (error) {
      if (required) throw error;
      missingContext.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const addFiles = async (files: BookFile[], role: string, group: string) => {
    for (const file of files) await add(file.path, role, group);
  };

  const addStyles = async (chapter: Chapter | undefined, group: string) => {
    if (!auditSettings.includeWritingStyle) return;
    await add(input.structure.globalWritingStylePath, "writing-style", group);
    await add(input.structure.globalPunctuationStylePath, "punctuation-style", group);
    await add(chapter?.writingStylePath, "chapter-writing-style", group);
  };

  const addEntityGroups = async (mentionText: string | null, group: string) => {
    const groups: Array<[boolean, BookFile[], string]> = [
      [auditSettings.includeCharacters, input.structure.characters, "character"],
      [auditSettings.includeLocations, input.structure.locations, "location"],
      [auditSettings.includeItems, input.structure.items, "item"],
      [auditSettings.includeFactions, input.structure.factions, "faction"],
    ];
    for (const [enabled, files, role] of groups) {
      if (!enabled) continue;
      await addFiles(mentionText === null ? files : files.filter((file) => textMentionsFile(mentionText, file)), role, group);
    }
  };

  const addTimelineAndSecrets = async (mentionText: string | null, group: string) => {
    if (auditSettings.includeTimeline) {
      const files = mentionText === null ? input.structure.timelines : input.structure.timelines.filter((file) => textMentionsFile(mentionText, file));
      await addFiles(files, "timeline", group);
    }
    if (auditSettings.includeSecrets) {
      const files = mentionText === null ? input.structure.secrets : input.structure.secrets.filter((file) => textMentionsFile(mentionText, file));
      await addFiles(files, "secret", group);
    }
  };

  if (target.scope === "book") {
    await add("book.md", "book", "book", true);
    await add(input.structure.plotPath ?? "plot.md", "plot", "book");
    if (auditSettings.includeSummary) await add("resumes/total.md", "book-summary", "book");
    await addStyles(undefined, "book");
    for (const chapter of input.structure.chapters) {
      const group = `chapter:${chapter.slug}`;
      await add(`${chapter.path}/chapter.md`, "chapter", group, true);
      for (const paragraph of chapter.paragraphs) await add(paragraph.path, "paragraph", group, true);
      if (auditSettings.includeWritingStyle) await add(chapter.writingStylePath, "chapter-writing-style", group);
      if (auditSettings.includeSummary && chapter.hasResume) await add(`resumes/chapters/${chapter.slug}.md`, "chapter-summary", group);
    }
    await addTimelineAndSecrets(null, "canon");
    await addEntityGroups(null, "canon");
  } else if (target.scope === "chapter") {
    const chapter = chapterForTarget(input.structure, target);
    if (!chapter) throw new Error(`Chapter not found: ${target.chapterId ?? ""}`);
    const group = `chapter:${chapter.slug}`;
    await add(`${chapter.path}/chapter.md`, "chapter", group, true);
    for (const paragraph of chapter.paragraphs) await add(paragraph.path, "paragraph", group, true);
    await addStyles(chapter, group);
    if (auditSettings.includeSummary && chapter.hasResume) await add(`resumes/chapters/${chapter.slug}.md`, "chapter-summary", group);

    const chapterIndex = input.structure.chapters.indexOf(chapter);
    const previous = chapterIndex > 0 ? input.structure.chapters[chapterIndex - 1] : undefined;
    if (previous && auditSettings.includePreviousContext) {
      await add(`${previous.path}/chapter.md`, "previous-chapter", `previous:${previous.slug}`);
      const lastParagraph = previous.paragraphs[previous.paragraphs.length - 1];
      await add(lastParagraph?.path, "previous-chapter-ending", `previous:${previous.slug}`);
    }
    if (previous && auditSettings.includeSummary && previous.hasResume) {
      await add(`resumes/chapters/${previous.slug}.md`, "previous-chapter-summary", `previous:${previous.slug}`);
    }
    const next = chapterIndex < input.structure.chapters.length - 1 ? input.structure.chapters[chapterIndex + 1] : undefined;
    if (next && auditSettings.includeNextContext) {
      await add(`${next.path}/chapter.md`, "next-chapter", `next:${next.slug}`);
      await add(next.paragraphs[0]?.path, "next-chapter-opening", `next:${next.slug}`);
    }
    const mentionText = documents.filter((doc) => doc.group === group).map((doc) => doc.content).join("\n");
    await addTimelineAndSecrets(null, "canon");
    await addEntityGroups(mentionText, "canon");
  } else {
    const chapter = chapterForTarget(input.structure, target);
    const paragraph = paragraphForTarget(chapter, target);
    if (!chapter || !paragraph) throw new Error(`Paragraph not found: ${target.paragraphNum ?? ""}`);
    const group = `paragraph:${target.paragraphId ?? paragraph.number}`;
    await add(`${chapter.path}/chapter.md`, "chapter", group, true);
    const paragraphIndex = chapter.paragraphs.indexOf(paragraph);
    if (auditSettings.includePreviousContext && paragraphIndex > 0) await add(chapter.paragraphs[paragraphIndex - 1].path, "previous-paragraph", group);
    await add(paragraph.path, "target-paragraph", group, true);
    if (auditSettings.includeNextContext && paragraphIndex < chapter.paragraphs.length - 1) await add(chapter.paragraphs[paragraphIndex + 1].path, "next-paragraph", group);
    await addStyles(chapter, group);
    if (auditSettings.includeSummary && chapter.hasResume) await add(`resumes/chapters/${chapter.slug}.md`, "chapter-summary", group);
    const mentionText = documents.map((doc) => doc.content).join("\n");
    await addTimelineAndSecrets(mentionText, "canon");
    await addEntityGroups(mentionText, "canon");
  }

  const sourceManifest = documents.map(({ path, hash, role }) => ({ path, hash, role }));
  const timeline = sourceManifest.filter((entry) => entry.role === "timeline");
  const secrets = sourceManifest.filter((entry) => entry.role === "secret");
  const entities = sourceManifest.filter((entry) => ENTITY_ROLES.has(entry.role));
  return {
    documents,
    sourceManifest,
    sourceHash: await aggregateManifest(sourceManifest),
    timelineVersion: await aggregateManifest(timeline),
    secretsVersion: await aggregateManifest(secrets),
    entityContextHash: await aggregateManifest(entities),
    missingContext,
  };
}

function sourceBlock(document: AuditDocument, part: number, total: number, content: string): string {
  return [
    `SOURCE PATH: ${document.path}`,
    `SOURCE ROLE: ${document.role}`,
    total > 1 ? `SOURCE PART: ${part}/${total}` : "",
    "SOURCE CONTENT (verbatim):",
    content,
  ].filter(Boolean).join("\n");
}

export function chunkAuditDocuments(documents: AuditDocument[], maxCharacters = MAX_CHUNK_CHARACTERS): AuditChunk[] {
  const chunks: AuditChunk[] = [];
  const grouped = new Map<string, AuditDocument[]>();
  for (const document of documents) grouped.set(document.group, [...(grouped.get(document.group) ?? []), document]);

  for (const [group, groupDocuments] of grouped) {
    const pieces: Array<{ path: string; text: string }> = [];
    for (const document of groupDocuments) {
      const headerAllowance = 500 + document.path.length + document.role.length;
      const contentLimit = Math.max(1_000, maxCharacters - headerAllowance);
      const total = Math.max(1, Math.ceil(document.content.length / contentLimit));
      for (let index = 0; index < total; index += 1) {
        const content = document.content.slice(index * contentLimit, (index + 1) * contentLimit);
        pieces.push({ path: document.path, text: sourceBlock(document, index + 1, total, content) });
      }
    }

    let texts: string[] = [];
    let paths: string[] = [];
    let size = 0;
    const flush = () => {
      if (!texts.length) return;
      chunks.push({ group, index: chunks.length, sourcePaths: [...new Set(paths)], content: texts.join("\n\n--- SOURCE BOUNDARY ---\n\n") });
      texts = [];
      paths = [];
      size = 0;
    };
    for (const piece of pieces) {
      if (texts.length && size + piece.text.length + 30 > maxCharacters) flush();
      texts.push(piece.text);
      paths.push(piece.path);
      size += piece.text.length + 30;
    }
    flush();
  }
  return chunks;
}

function systemPrompt(language: string, depth: AuditDepth, maxFindings: number, customPrompt: string, synthesis: boolean): string {
  const outputLanguage = language.toLocaleLowerCase().startsWith("it")
    ? "Italian"
    : language.toLocaleLowerCase().startsWith("en")
      ? "English"
      : language;
  const depthInstruction = depth === "quick"
    ? "Prioritize direct contradictions and high-impact defects, but inspect every supplied source."
    : depth === "deep"
      ? "Perform a deep, facet-focused inspection of chronology, canon, causality, reveals, voice, and supplied consistency rules."
      : "Perform a systematic consistency and logic inspection of every supplied source.";
  return [
    "You are Narrarium's critical manuscript audit engine. Be severe, exacting, and non-accommodating.",
    "Do not include generic praise, encouragement, diplomatic padding, or subjective taste presented as fact. Actively seek contradictions and unsupported claims.",
    "Every finding must cite concrete evidence and a real source path. Distinguish confirmed defects from probable or possible suspicions. Never invent an error, source, quotation, fact, or offset.",
    "When evidence is insufficient, use needs-context certainty and identify the missing context instead of asserting a defect.",
    "Do not modify manuscript text. Give a precise correction suggestion only; leave all changes to the author.",
    "Assess prose style and punctuation only for consistency with supplied style rules or the manuscript's established pattern, never according to generic stylistic preference.",
    [
      "Mandatory checks whenever the supplied sources make them applicable:",
      "- Timeline: chronology, dates, times, seasons, durations, travel/distance, ages, event order, and impossible simultaneous presence of a character or item.",
      "- Secrets: premature or missing reveals, impossible knowledge, use before discovery, unprepared/incoherent reveals, narrator leakage, and conflicts with known_from/reveal_in metadata.",
      "- Characters: personality, motivation, relationships, knowledge, acquired abilities, physical state, names/roles/titles, emotional reactions, location, and dialogue voice.",
      "- Locations: physical description, geography, distance, access routes, environmental changes, and unexplained elements.",
      "- Items: description, abilities, ownership, location, destruction/loss/delivery, and later reuse.",
      "- Factions: goals, ideology, membership/roles, alliances/enmities, strategy, decisions, and knowledge.",
      "- Narrative and spatial continuity: entrances/exits, action continuity, cause/effect, forgotten consequences, abandoned subplots, retroactive changes, impossible actions, and unresolved narrative promises.",
      "- Point of view, narrative person, tense, terminology, Writing Style, punctuation rules, worldbuilding rules, and discrepancies between prose and frontmatter/metadata.",
    ].join("\n"),
    `Use these categories whenever applicable: ${AUDIT_CATEGORIES.join(", ")}. Use "other" only when no listed category fits.`,
    "Audit Result must be: failed for any critical contradiction; needs-review for high/medium problems requiring author intervention; passed-with-warnings for only low/informational findings or unresolved context; passed only when no significant problem exists.",
    "Use stableKey as a compact semantic identity for the issue so equivalent findings remain stable across reruns. Do not generate IDs.",
    `Write ALL report prose, including findings, evidence explanations, correction suggestions, summaries, and assessments, in ${outputLanguage}. Never switch to another language.`,
    `${depthInstruction} Return at most ${maxFindings} distinct findings in this pass, ordered by severity.`,
    synthesis ? "This is a synthesis pass. Compare claims across all inputs, resolve duplicates, preserve source evidence, and detect cross-source contradictions. Do not discard a supported issue merely to shorten the result." : "This is a source audit pass. Cover all source content supplied in the user message, including every marked source part.",
    customPrompt.trim() ? `Additional author instructions (subordinate to the strict rules above):\n${customPrompt.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}

function normalizePassOutput(value: unknown): AuditPassOutput {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const strings = (key: string) => Array.isArray(raw[key]) ? (raw[key] as unknown[]).map(String).filter(Boolean) : [];
  const findings = Array.isArray(raw.findings) ? raw.findings.filter((entry): entry is ModelFinding => Boolean(entry && typeof entry === "object")) : [];
  const claims = Array.isArray(raw.claims) ? raw.claims.filter((entry): entry is AuditClaim => Boolean(entry && typeof entry === "object")) : [];
  const result = String(raw.auditResult ?? "passed") as AuditResult;
  return {
    findings,
    executiveSummary: String(raw.executiveSummary ?? ""),
    recommendedFixOrder: strings("recommendedFixOrder"),
    finalAssessment: String(raw.finalAssessment ?? ""),
    auditResult: RESULTS.includes(result) ? result : findings.length ? "needs-review" : "passed",
    missingContext: strings("missingContext"),
    coverageNotes: strings("coverageNotes"),
    claims,
  };
}

function packStrings(values: string[], maxCharacters: number): string[] {
  const segments: string[] = [];
  let current = "";
  for (const value of values) {
    const parts: string[] = [];
    if (value.length <= maxCharacters) parts.push(value);
    else for (let offset = 0; offset < value.length; offset += maxCharacters) parts.push(value.slice(offset, offset + maxCharacters));
    for (const part of parts) {
      if (current && current.length + part.length + 50 > maxCharacters) {
        segments.push(current);
        current = "";
      }
      current += `${current ? "\n\n--- AUDIT OUTPUT BOUNDARY ---\n\n" : ""}${part}`;
    }
  }
  if (current) segments.push(current);
  return segments;
}

function structuredOutputRecords(output: AuditPassOutput, outputIndex: number): string[] {
  return [
    JSON.stringify({
      outputIndex,
      kind: "assessment",
      executiveSummary: output.executiveSummary,
      recommendedFixOrder: output.recommendedFixOrder,
      finalAssessment: output.finalAssessment,
      auditResult: output.auditResult,
      missingContext: output.missingContext,
      coverageNotes: output.coverageNotes,
    }),
    ...output.findings.map((finding, findingIndex) => JSON.stringify({ outputIndex, kind: "finding", findingIndex, finding })),
    ...output.claims.map((claim, claimIndex) => JSON.stringify({ outputIndex, kind: "claim", claimIndex, claim })),
  ];
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted || (error instanceof Error && error.name === "AbortError"));
}

function depthFindingLimit(depth: AuditDepth, configured: number): number {
  if (depth === "quick") return Math.min(configured, 12);
  if (depth === "standard") return Math.min(configured, 30);
  return configured;
}

function reportLanguage(structure: BookStructure, settings: AppSettings, auditSettings: AuditSettings): string {
  if (auditSettings.reportLanguage === "en" || auditSettings.reportLanguage === "it") return auditSettings.reportLanguage;
  const bookLanguage = structure.language?.trim().toLocaleLowerCase();
  if (bookLanguage) return bookLanguage;
  return settings.ui.language?.toLocaleLowerCase().startsWith("it") ? "it" : "en";
}

function normalizedEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const normalized = String(value ?? "").trim().toLocaleLowerCase().replace(/[ _]+/g, "-") as T;
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizedText(value: unknown): string {
  return String(value ?? "").trim();
}

async function normalizeFinding(
  model: ModelFinding,
  target: ResolvedAuditTarget,
  now: string,
  previous: Map<string, AuditFinding>,
  allowedSourcePaths: ReadonlySet<string>,
): Promise<AuditFinding | null> {
  const description = normalizedText(model.description);
  const evidence = normalizedText(model.evidence);
  if (!description || !evidence) return null;
  const category = normalizedText(model.category).toLocaleLowerCase().replace(/[ _]+/g, "-") || "other";
  const sourcePath = normalizedText(model.structuredSourceRef?.path || model.position?.sourcePath) || target.sourcePath;
  if (!allowedSourcePaths.has(sourcePath)) return null;
  const stableKey = normalizedText(model.stableKey) || `${description}|${evidence}`;
  const identity = [stableKey, category, sourcePath, target.targetId].map((part) => part.toLocaleLowerCase().replace(/\s+/g, " ").trim()).join("|");
  const id = `audit-${(await sha256(identity)).slice(0, 20)}`;
  const old = previous.get(id);
  const chapterId = normalizedText(model.position?.chapterId || model.structuredSourceRef?.chapterId || target.chapterId) || undefined;
  const paragraphId = normalizedText(model.position?.paragraphId || model.structuredSourceRef?.paragraphId || target.paragraphId) || undefined;
  const textOffset = typeof model.position?.textOffset === "number" ? model.position.textOffset : typeof model.structuredSourceRef?.textOffset === "number" ? model.structuredSourceRef.textOffset : undefined;
  const heading = normalizedText(model.position?.heading || model.structuredSourceRef?.heading) || undefined;
  return {
    id,
    stableKey,
    category,
    severity: normalizedEnum(model.severity, SEVERITIES, "medium"),
    certainty: normalizedEnum(model.certainty, CERTAINTIES, "possible"),
    status: old?.status ?? "open",
    position: {
      bookId: target.bookId,
      chapterId,
      paragraphId,
      textOffset,
      excerpt: normalizedText(model.position?.excerpt) || undefined,
      heading,
      sourcePath,
    },
    description,
    evidence,
    structuredSourceRef: { path: sourcePath, chapterId, paragraphId, heading, textOffset },
    conflictExplanation: normalizedText(model.conflictExplanation),
    correctionSuggestion: normalizedText(model.correctionSuggestion),
    authorNote: old?.authorNote ?? "",
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
  };
}

function severityRank(severity: AuditSeverity): number {
  return SEVERITIES.indexOf(severity);
}

function aggregateRuns(runs: LlmRunMetadata[]): Pick<AuditReport, "requestIds" | "providers" | "integrationIds" | "models" | "inputTokens" | "cachedInputTokens" | "outputTokens" | "cost" | "currency"> {
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
  const costs = runs.map((run) => run.cost).filter((cost): cost is number => typeof cost === "number");
  return {
    requestIds: unique(runs.map((run) => run.requestId)),
    providers: unique(runs.map((run) => run.provider)),
    integrationIds: unique(runs.map((run) => run.integrationId)),
    models: unique(runs.map((run) => run.model)),
    inputTokens: runs.reduce((sum, run) => sum + run.inputTokens, 0),
    cachedInputTokens: runs.reduce((sum, run) => sum + run.cachedInputTokens, 0),
    outputTokens: runs.reduce((sum, run) => sum + run.outputTokens, 0),
    cost: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : undefined,
    currency: runs.find((run) => run.currency)?.currency,
  };
}

export async function runAudit(input: RunAuditInput): Promise<AuditReport> {
  const target = resolveAuditTarget(input.structure, input.target);
  const auditSettings = resolveBookAuditSettings(input.book);
  if (!auditSettings.enabled) throw new Error("Audit is disabled for this book.");
  const depth = input.depth ?? auditSettings.defaultDepth;
  const language = reportLanguage(input.structure, input.settings, auditSettings);
  const previousFile = await readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, target.reportPath).catch(() => null);
  const previousReport = previousFile ? parseAuditReport(target.reportPath, previousFile.content) : null;
  const previousFindings = new Map((previousReport?.findings ?? []).map((finding) => [finding.id, finding]));
  input.onProgress?.({ state: "preparingContext", completedCalls: 0, totalCalls: 0, detail: target.sourcePath });
  let context: AuditContext;
  try {
    assertNotAborted(input.signal);
    context = await buildAuditContext({ ...input, contextSettings: auditSettings });
    assertNotAborted(input.signal);
  } catch (error) {
    input.onProgress?.({ state: isAbort(error, input.signal) ? "cancelled" : "failed", completedCalls: 0, totalCalls: 0, detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  const chunks = chunkAuditDocuments(context.documents);
  if (!chunks.length) {
    const error = new Error("No source documents are available for this audit.");
    input.onProgress?.({ state: "failed", completedCalls: 0, totalCalls: 0, detail: error.message });
    throw error;
  }

  const maxFindings = depthFindingLimit(depth, auditSettings.maxFindings);
  const generationRuns: LlmRunMetadata[] = [];
  let completedCalls = 0;
  let totalCalls = chunks.length;
  let passCount = 0;
  const call = async (content: string, synthesis: boolean, label: string): Promise<AuditPassOutput> => {
    assertNotAborted(input.signal);
    input.onProgress?.({ state: synthesis ? "synthesizing" : "running", completedCalls, totalCalls, currentPass: passCount + 1, detail: label });
    const result = await completeToolRouted<AuditPassOutput>(input.settings, [
      { role: "system", content: systemPrompt(language, depth, maxFindings, auditSettings.customPrompt, synthesis) },
      { role: "user", content },
    ], "audit", AUDIT_TOOL, { signal: input.signal, label: `audit:${target.scope}:${label}` });
    generationRuns.push(result.metadata);
    completedCalls += 1;
    passCount += 1;
    input.onProgress?.({ state: synthesis ? "synthesizing" : "running", completedCalls, totalCalls, currentPass: passCount, detail: label });
    return normalizePassOutput(result.output);
  };

  const synthesize = async (outputs: AuditPassOutput[], label: string): Promise<AuditPassOutput> => {
    let current = outputs;
    let level = 1;
    while (current.length > 1) {
      if (level > 12) throw new Error("Audit synthesis did not converge within twelve levels.");
      const packed = packStrings(current.flatMap(structuredOutputRecords), MAX_CHUNK_CHARACTERS);
      totalCalls += packed.length;
      const next: AuditPassOutput[] = [];
      for (let index = 0; index < packed.length; index += 1) {
        next.push(await call([
          `SYNTHESIS LEVEL: ${level}`,
          `SYNTHESIS PART: ${index + 1}/${packed.length}`,
          "The following serialized audit outputs collectively cover the source. Reconcile them without dropping supported findings or claims:",
          packed[index],
        ].join("\n\n"), true, `${label}:${level}:${index + 1}`));
      }
      current = next;
      level += 1;
    }
    return current[0];
  };

  try {
    const mappedByGroup = new Map<string, AuditPassOutput[]>();
    for (const chunk of chunks) {
      const output = await call([
        `TARGET: ${target.scope} / ${target.title}`,
        `TARGET ID: ${target.targetId}`,
        `COMPLETE-COVERAGE GROUP: ${chunk.group}`,
        `SOURCE PATHS: ${chunk.sourcePaths.join(", ")}`,
        context.missingContext.length ? `KNOWN MISSING/INSUFFICIENT CONTEXT:\n${context.missingContext.join("\n")}` : "KNOWN MISSING/INSUFFICIENT CONTEXT: none detected while loading",
        chunk.content,
      ].join("\n\n"), false, `map:${chunk.group}:${chunk.index + 1}`);
      mappedByGroup.set(chunk.group, [...(mappedByGroup.get(chunk.group) ?? []), output]);
    }

    const groupOutputs: AuditPassOutput[] = [];
    for (const [group, outputs] of mappedByGroup) groupOutputs.push(outputs.length === 1 ? outputs[0] : await synthesize(outputs, `group:${group}`));
    const finalOutput = groupOutputs.length === 1 ? groupOutputs[0] : await synthesize(groupOutputs, "global");
    assertNotAborted(input.signal);

    const now = new Date().toISOString();
    const allowedSourcePaths = new Set(context.sourceManifest.map((entry) => entry.path));
    const normalized = await Promise.all(finalOutput.findings.map((finding) => normalizeFinding(finding, target, now, previousFindings, allowedSourcePaths)));
    const uniqueFindings = new Map<string, AuditFinding>();
    for (const finding of normalized) {
      if (!finding) continue;
      const existing = uniqueFindings.get(finding.id);
      if (!existing || severityRank(finding.severity) < severityRank(existing.severity)) uniqueFindings.set(finding.id, finding);
    }
    const threshold = severityRank(auditSettings.severityThreshold);
    const findings = [...uniqueFindings.values()]
      .filter((finding) => severityRank(finding.severity) <= threshold)
      .sort((left, right) => severityRank(left.severity) - severityRank(right.severity) || left.category.localeCompare(right.category))
      .slice(0, auditSettings.maxFindings);
    const missingContext = [...new Set([...context.missingContext, ...finalOutput.missingContext].filter(Boolean))];
    const auditResult: AuditResult = findings.some((finding) => finding.severity === "critical")
      ? "failed"
      : findings.some((finding) => finding.severity === "high" || finding.severity === "medium")
        ? "needs-review"
        : findings.length || missingContext.length
          ? "passed-with-warnings"
          : "passed";
    const runTotals = aggregateRuns(generationRuns);
    const report: AuditReport = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      type: "audit",
      id: `audit:${target.targetId}`,
      scope: target.scope,
      bookId: target.bookId,
      chapterId: target.chapterId,
      paragraphId: target.paragraphId,
      paragraphNum: target.paragraphNum,
      targetId: target.targetId,
      targetTitle: target.title,
      reportPath: target.reportPath,
      sourcePath: target.sourcePath,
      href: target.href,
      sourceHref: target.sourceHref,
      language,
      depth,
      status: "completed",
      createdAt: previousReport?.createdAt || now,
      updatedAt: now,
      sourceManifest: context.sourceManifest,
      sourceHash: context.sourceHash,
      timelineVersion: context.timelineVersion,
      secretsVersion: context.secretsVersion,
      entityContextHash: context.entityContextHash,
      contextSettings: auditSettings,
      strategy: "hierarchical-complete-coverage",
      passCount,
      chunkCount: chunks.length,
      maxChunkCharacters: MAX_CHUNK_CHARACTERS,
      generationRuns,
      ...runTotals,
      findings,
      executiveSummary: finalOutput.executiveSummary,
      recommendedFixOrder: finalOutput.recommendedFixOrder,
      finalAssessment: finalOutput.finalAssessment,
      auditResult,
      missingContext,
      body: "",
      stale: false,
      currentSourceHash: context.sourceHash,
    };
    report.body = renderAuditBody(report);
    assertNotAborted(input.signal);
    await createOrUpdateTextFile(input.token, input.book.owner, input.book.repo, input.branch, target.reportPath, serializeAuditReport(report), `Update ${target.scope} audit: ${target.title}`);
    input.onProgress?.({ state: "completed", completedCalls, totalCalls: completedCalls, currentPass: passCount, detail: target.reportPath });
    return report;
  } catch (error) {
    input.onProgress?.({ state: isAbort(error, input.signal) ? "cancelled" : "failed", completedCalls, totalCalls, currentPass: passCount, detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function frontmatterRecord(report: AuditReport): Record<string, unknown> {
  const count = (severity: AuditSeverity) => report.findings.filter((finding) => finding.severity === severity).length;
  return {
    schemaVersion: report.schemaVersion,
    type: report.type,
    id: report.id,
    scope: report.scope,
    bookId: report.bookId,
    chapterId: report.chapterId,
    paragraphId: report.paragraphId,
    paragraphNum: report.paragraphNum,
    targetId: report.targetId,
    targetTitle: report.targetTitle,
    reportPath: report.reportPath,
    sourcePath: report.sourcePath,
    href: report.href,
    sourceHref: report.sourceHref,
    language: report.language,
    depth: report.depth,
    auditDepth: report.depth,
    severityThreshold: report.contextSettings.severityThreshold,
    status: report.status,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    sourceManifest: report.sourceManifest,
    sourceHash: report.sourceHash,
    sourceContentHash: report.sourceHash,
    sourceContentVersion: report.sourceHash,
    sourceUpdatedAt: report.updatedAt,
    gitCommit: "",
    timelineVersion: report.timelineVersion,
    secretsVersion: report.secretsVersion,
    entityContextHash: report.entityContextHash,
    contextSettings: report.contextSettings,
    strategy: report.strategy,
    passCount: report.passCount,
    chunkCount: report.chunkCount,
    maxChunkCharacters: report.maxChunkCharacters,
    routerTask: "audit",
    generationRuns: report.generationRuns,
    requestIds: report.requestIds,
    providers: report.providers,
    integrationIds: report.integrationIds,
    models: report.models,
    provider: report.providers[0] ?? "",
    model: report.models[0] ?? "",
    inputTokens: report.inputTokens,
    cachedInputTokens: report.cachedInputTokens,
    outputTokens: report.outputTokens,
    estimatedCost: report.cost,
    finalCost: report.cost,
    currency: report.currency,
    findings: report.findings,
    executiveSummary: report.executiveSummary,
    recommendedFixOrder: report.recommendedFixOrder,
    finalAssessment: report.finalAssessment,
    auditResult: report.auditResult,
    missingContext: report.missingContext,
    issueCount: report.findings.length,
    criticalCount: count("critical"),
    highCount: count("high"),
    mediumCount: count("medium"),
    lowCount: count("low"),
    informationalCount: count("informational"),
    passed: report.auditResult === "passed" || report.auditResult === "passed-with-warnings",
    stale: report.stale ?? false,
  };
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => [key, removeUndefined(entry)]));
}

export function serializeAuditReport(report: AuditReport): string {
  return `---\n${stringify(removeUndefined(frontmatterRecord(report))).trimEnd()}\n---\n\n${renderAuditBody(report).trim()}\n`;
}

function localizedReportLabels(language: string) {
  const it = language.toLocaleLowerCase().startsWith("it");
  return it ? {
    summary: "Sintesi esecutiva",
    result: "Esito audit",
    critical: "Problemi critici",
    high: "Problemi ad alta priorita",
    other: "Altri problemi",
    categories: "Sezioni per categoria",
    missing: "Contesto mancante/insufficiente",
    fixOrder: "Ordine di correzione consigliato",
    assessment: "Valutazione finale",
    none: "Nessuno.",
    strategy: "Strategia",
    passes: "passaggi",
  } : {
    summary: "Executive Summary",
    result: "Audit Result",
    critical: "Critical Issues",
    high: "High Priority Issues",
    other: "Other Issues",
    categories: "Category Sections",
    missing: "Missing/Insufficient Context",
    fixOrder: "Recommended Fix Order",
    assessment: "Final Assessment",
    none: "None.",
    strategy: "Strategy",
    passes: "passes",
  };
}

const CATEGORY_LABELS: Record<"en" | "it", Record<BuiltInAuditCategory, string>> = {
  en: {
    timeline: "Timeline Findings",
    secret: "Secret Findings",
    character: "Character Findings",
    "character-voice": "Character Voice Findings",
    "character-knowledge": "Character Knowledge Findings",
    relationship: "Relationship Findings",
    location: "Location Findings",
    item: "Item Findings",
    faction: "Faction Findings",
    worldbuilding: "Worldbuilding",
    plot: "Plot Findings",
    "spatial-continuity": "Spatial Continuity Findings",
    "narrative-continuity": "Narrative Continuity Findings",
    "point-of-view": "Point of View Findings",
    "writing-style": "Style and Voice Findings",
    terminology: "Terminology Findings",
    metadata: "Metadata Findings",
    "missing-information": "Missing Information",
    "punctuation-consistency": "Punctuation Consistency Findings",
    other: "Other",
  },
  it: {
    timeline: "Finding Timeline",
    secret: "Finding Segreti",
    character: "Finding Personaggi",
    "character-voice": "Finding Voce dei personaggi",
    "character-knowledge": "Finding Conoscenze dei personaggi",
    relationship: "Finding Relazioni",
    location: "Finding Luoghi",
    item: "Finding Oggetti",
    faction: "Finding Fazioni",
    worldbuilding: "Worldbuilding",
    plot: "Finding Trama",
    "spatial-continuity": "Finding Continuita spaziale",
    "narrative-continuity": "Finding Continuita narrativa",
    "point-of-view": "Finding Punto di vista",
    "writing-style": "Finding Stile e voce",
    terminology: "Finding Terminologia",
    metadata: "Finding Metadati",
    "missing-information": "Informazioni mancanti",
    "punctuation-consistency": "Finding Coerenza della punteggiatura",
    other: "Altro",
  },
};

function categoryLabel(category: AuditCategory, language: string): string {
  const locale = language.toLocaleLowerCase().startsWith("it") ? "it" : "en";
  return category in CATEGORY_LABELS[locale] ? CATEGORY_LABELS[locale][category as BuiltInAuditCategory] : category;
}

function findingSummaryLine(finding: AuditFinding): string {
  return `- **${finding.severity} / ${finding.certainty}** [${finding.structuredSourceRef.path}] ${finding.description}`;
}

function findingDetail(finding: AuditFinding): string {
  return [
    `#### ${finding.description}`,
    `- ID: \`${finding.id}\``,
    `- Severity: ${finding.severity}`,
    `- Certainty: ${finding.certainty}`,
    `- Status: ${finding.status}`,
    `- Source: \`${finding.structuredSourceRef.path}\`${finding.structuredSourceRef.heading ? ` / ${finding.structuredSourceRef.heading}` : ""}`,
    `\n**Evidence**\n\n${finding.evidence}`,
    finding.conflictExplanation ? `\n**Conflict**\n\n${finding.conflictExplanation}` : "",
    finding.correctionSuggestion ? `\n**Correction suggestion**\n\n${finding.correctionSuggestion}` : "",
    finding.authorNote ? `\n**Author note**\n\n${finding.authorNote}` : "",
  ].filter(Boolean).join("\n");
}

export function renderAuditBody(report: AuditReport): string {
  const labels = localizedReportLabels(report.language);
  const critical = report.findings.filter((finding) => finding.severity === "critical");
  const high = report.findings.filter((finding) => finding.severity === "high");
  const other = report.findings.filter((finding) => finding.severity !== "critical" && finding.severity !== "high");
  const categories = [...new Set(report.findings.map((finding) => finding.category))];
  const list = (findings: AuditFinding[]) => findings.length ? findings.map(findingSummaryLine).join("\n") : labels.none;
  return [
    "# Audit",
    `\n## ${labels.summary}\n\n${report.executiveSummary || labels.none}`,
    `\n## ${labels.result}\n\n**${report.auditResult}**\n\n${labels.strategy}: ${report.strategy}; ${report.passCount} ${labels.passes}; ${report.chunkCount} chunks.`,
    `\n## ${labels.critical}\n\n${list(critical)}`,
    `\n## ${labels.high}\n\n${list(high)}`,
    `\n## ${labels.other}\n\n${list(other)}`,
    `\n## ${labels.categories}\n\n${categories.length ? categories.map((category) => `### ${categoryLabel(category, report.language)}\n\n${report.findings.filter((finding) => finding.category === category).map(findingDetail).join("\n\n")}`).join("\n\n") : labels.none}`,
    `\n## ${labels.missing}\n\n${report.missingContext.length ? report.missingContext.map((entry) => `- ${entry}`).join("\n") : labels.none}`,
    `\n## ${labels.fixOrder}\n\n${report.recommendedFixOrder.length ? report.recommendedFixOrder.map((entry, index) => `${index + 1}. ${entry}`).join("\n") : labels.none}`,
    `\n## ${labels.assessment}\n\n${report.finalAssessment || labels.none}`,
  ].join("\n").trim() + "\n";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function parseManifest(value: unknown): AuditSourceManifestEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(record).map((entry) => ({ path: normalizedText(entry.path), hash: normalizedText(entry.hash), role: normalizedText(entry.role) })).filter((entry) => entry.path && entry.hash);
}

function parseRuns(value: unknown): LlmRunMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.map(record).map((entry) => ({
    requestId: normalizedText(entry.requestId),
    task: "audit" as const,
    provider: normalizedText(entry.provider) as LlmRunMetadata["provider"],
    integrationId: normalizedText(entry.integrationId),
    model: normalizedText(entry.model),
    inputTokens: Number(entry.inputTokens ?? 0),
    cachedInputTokens: Number(entry.cachedInputTokens ?? 0),
    outputTokens: Number(entry.outputTokens ?? 0),
    cost: typeof entry.cost === "number" ? entry.cost : undefined,
    currency: normalizedText(entry.currency) || undefined,
  })).filter((entry) => entry.requestId);
}

function parseFinding(value: unknown, fallbackBookId: string): AuditFinding | null {
  const entry = record(value);
  const id = normalizedText(entry.id);
  if (!id) return null;
  const position = record(entry.position);
  const source = record(entry.structuredSourceRef);
  const sourcePath = normalizedText(source.path || position.sourcePath);
  return {
    id,
    stableKey: normalizedText(entry.stableKey) || id,
    category: normalizedText(entry.category) || "other",
    severity: normalizedEnum(entry.severity, SEVERITIES, "medium"),
    certainty: normalizedEnum(entry.certainty, CERTAINTIES, "possible"),
    status: normalizedEnum(entry.status, FINDING_STATUSES, "open"),
    position: {
      bookId: normalizedText(position.bookId) || fallbackBookId,
      chapterId: normalizedText(position.chapterId) || undefined,
      paragraphId: normalizedText(position.paragraphId) || undefined,
      textOffset: typeof position.textOffset === "number" ? position.textOffset : undefined,
      excerpt: normalizedText(position.excerpt) || undefined,
      heading: normalizedText(position.heading) || undefined,
      sourcePath,
    },
    description: normalizedText(entry.description),
    evidence: normalizedText(entry.evidence),
    structuredSourceRef: {
      path: sourcePath,
      chapterId: normalizedText(source.chapterId) || undefined,
      paragraphId: normalizedText(source.paragraphId) || undefined,
      heading: normalizedText(source.heading) || undefined,
      textOffset: typeof source.textOffset === "number" ? source.textOffset : undefined,
    },
    conflictExplanation: normalizedText(entry.conflictExplanation),
    correctionSuggestion: normalizedText(entry.correctionSuggestion),
    authorNote: normalizedText(entry.authorNote),
    createdAt: normalizedText(entry.createdAt),
    updatedAt: normalizedText(entry.updatedAt),
  };
}

function parseAuditResult(value: unknown, findings: AuditFinding[]): AuditResult {
  const normalized = normalizedText(value).toLocaleLowerCase().replace(/[ _]+/g, "-");
  if (RESULTS.includes(normalized as AuditResult)) return normalized as AuditResult;
  // Migrate reports created by the initial Audit implementation.
  if (normalized === "issues-found") {
    return findings.some((finding) => finding.severity === "critical") ? "failed" : "needs-review";
  }
  if (normalized === "insufficient-context") return "passed-with-warnings";
  return findings.length ? "needs-review" : "passed";
}

export function parseAuditReport(path: string, raw: string): AuditReport | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = record(parseDocument(match[1]).toJSON());
  } catch {
    return null;
  }
  if (frontmatter.type !== "audit") return null;
  const bookId = normalizedText(frontmatter.bookId);
  const findings = Array.isArray(frontmatter.findings) ? frontmatter.findings.map((entry) => parseFinding(entry, bookId)).filter((entry): entry is AuditFinding => Boolean(entry)) : [];
  const contextSettings = { ...resolveBookAuditSettings({ auditSettings: record(frontmatter.contextSettings) } as unknown as BookEntry) };
  const generationRuns = parseRuns(frontmatter.generationRuns);
  const result = parseAuditResult(frontmatter.auditResult, findings);
  return {
    schemaVersion: Number(frontmatter.schemaVersion ?? REPORT_SCHEMA_VERSION),
    type: "audit",
    id: normalizedText(frontmatter.id) || path,
    scope: normalizedEnum(frontmatter.scope, ["book", "chapter", "paragraph"] as const, "book"),
    bookId,
    chapterId: normalizedText(frontmatter.chapterId) || undefined,
    paragraphId: normalizedText(frontmatter.paragraphId) || undefined,
    paragraphNum: normalizedText(frontmatter.paragraphNum) || undefined,
    targetId: normalizedText(frontmatter.targetId),
    targetTitle: normalizedText(frontmatter.targetTitle),
    reportPath: normalizedText(frontmatter.reportPath) || path,
    sourcePath: normalizedText(frontmatter.sourcePath),
    href: normalizedText(frontmatter.href),
    sourceHref: normalizedText(frontmatter.sourceHref),
    language: normalizedText(frontmatter.language) || "en",
    depth: normalizedEnum(frontmatter.depth, ["quick", "standard", "deep"] as const, "standard"),
    status: "completed",
    createdAt: normalizedText(frontmatter.createdAt),
    updatedAt: normalizedText(frontmatter.updatedAt),
    sourceManifest: parseManifest(frontmatter.sourceManifest),
    sourceHash: normalizedText(frontmatter.sourceHash),
    timelineVersion: normalizedText(frontmatter.timelineVersion),
    secretsVersion: normalizedText(frontmatter.secretsVersion),
    entityContextHash: normalizedText(frontmatter.entityContextHash),
    contextSettings,
    strategy: "hierarchical-complete-coverage",
    passCount: Number(frontmatter.passCount ?? generationRuns.length),
    chunkCount: Number(frontmatter.chunkCount ?? 0),
    maxChunkCharacters: Number(frontmatter.maxChunkCharacters ?? MAX_CHUNK_CHARACTERS),
    generationRuns,
    requestIds: stringArray(frontmatter.requestIds),
    providers: stringArray(frontmatter.providers),
    integrationIds: stringArray(frontmatter.integrationIds),
    models: stringArray(frontmatter.models),
    inputTokens: Number(frontmatter.inputTokens ?? 0),
    cachedInputTokens: Number(frontmatter.cachedInputTokens ?? 0),
    outputTokens: Number(frontmatter.outputTokens ?? 0),
    cost: typeof frontmatter.finalCost === "number" ? frontmatter.finalCost : typeof frontmatter.estimatedCost === "number" ? frontmatter.estimatedCost : undefined,
    currency: normalizedText(frontmatter.currency) || undefined,
    findings,
    executiveSummary: normalizedText(frontmatter.executiveSummary),
    recommendedFixOrder: stringArray(frontmatter.recommendedFixOrder),
    finalAssessment: normalizedText(frontmatter.finalAssessment),
    auditResult: result,
    missingContext: stringArray(frontmatter.missingContext),
    body: match[2].trim(),
  };
}

export async function loadAuditReport(input: AuditServiceBase): Promise<AuditReport | null> {
  const target = resolveAuditTarget(input.structure, input.target);
  const file = await readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, target.reportPath).catch(() => null);
  if (!file) return null;
  const report = parseAuditReport(target.reportPath, file.content);
  if (!report) throw new Error(`Invalid audit report: ${target.reportPath}`);
  try {
    const context = await buildAuditContext({ ...input, contextSettings: report.contextSettings });
    report.currentSourceHash = context.sourceHash;
    report.stale = report.sourceHash !== context.sourceHash;
  } catch {
    report.stale = true;
  }
  return report;
}

export async function deleteAudit(input: AuditServiceBase): Promise<void> {
  const target = resolveAuditTarget(input.structure, input.target);
  const existing = await readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, target.reportPath).catch(() => null);
  if (!existing) return;
  await deleteFile(input.token, input.book.owner, input.book.repo, input.branch, target.reportPath, existing.sha, `Delete ${target.scope} audit: ${target.title}`);
}

export async function updateAuditFinding(input: AuditServiceBase & { findingId: string; status?: AuditFindingStatus; authorNote?: string }): Promise<AuditReport> {
  const target = resolveAuditTarget(input.structure, input.target);
  const existing = await readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, target.reportPath);
  const report = parseAuditReport(target.reportPath, existing.content);
  if (!report) throw new Error(`Invalid audit report: ${target.reportPath}`);
  const index = report.findings.findIndex((finding) => finding.id === input.findingId);
  if (index < 0) throw new Error(`Audit finding not found: ${input.findingId}`);
  const current = report.findings[index];
  const now = new Date().toISOString();
  report.findings[index] = {
    ...current,
    status: input.status ?? current.status,
    authorNote: input.authorNote ?? current.authorNote,
    updatedAt: now,
  };
  report.updatedAt = now;
  report.body = renderAuditBody(report);
  await createOrUpdateTextFile(input.token, input.book.owner, input.book.repo, input.branch, target.reportPath, serializeAuditReport(report), `Update audit finding: ${current.description.slice(0, 72)}`);
  return report;
}

export { findOrphanAuditPaths };
