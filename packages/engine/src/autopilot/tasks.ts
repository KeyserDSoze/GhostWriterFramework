import { normalizeScore, requireStructuredFields, splitReasoningBlock } from "../ai/structured.js";
import { AI_CAPABILITIES, AiReplyRejectedError, type AiRequest, type AiResponse } from "../ai/types.js";
import {
  canonDetails,
  canonManifest,
  ghostwriterBlock,
  isThinDocument,
  loadChapterParagraphs,
  loadGhostwriter,
  markedChapterText,
  mentionedCanon,
  readBody,
  readDocument,
  secretRules,
  type LoadedParagraph,
} from "../book/context.js";
import {
  AUTOPILOT_PLAN_FILE,
  BOOK_FILE,
  CONTEXT_FILE,
  OUTLINE_BOOK_FILE,
  OUTLINE_CHANGES_FILE,
  PLOT_FILE,
  STORY_DESIGN_FILE,
  TOTAL_RESUME_FILE,
  canonPath,
  canonSlug,
  chapterFilePath,
  chapterResumePath,
  chapterSlug,
  directorOpinionPath,
  formatOrdinal,
  isValidGhostwriterSlug,
  outlineChapterPath,
  paragraphFilePath,
  paragraphId,
  paragraphSlug,
  readerEvaluationPath,
  readerSummaryPath,
  type CanonKind,
} from "../book/paths.js";
import { chapterFreezeRecord, freezeChapterChanges, frozenChanges, markReviewedChanges, type ChapterFreeze } from "../book/freeze.js";
import type { BookSnapshot, ChapterInfo } from "../book/snapshot.js";
import type { BookFileChange, BookStore } from "../book/store.js";
import { OUTLINE_TITLE_MAX_CHARS, OutlineReader, outlineBookDigest, outlineEntryDigest, serializeOutlineBook, serializeOutlineChapter, type OutlineChapterEntry } from "../book/outline.js";
import { appendOutlineJournal, outlineJournalChaptersOf, type OutlineJournalSeen } from "../book/outline-journal.js";
import { askDirector, directorSystemPrompt, parseDirectorVerdict, renderDirectorOpinion, withheldApprovalNote, type DirectorOpinion } from "../director/opinion.js";
import { assertFrontmatterReadable, frontmatterString, parseMarkdown, renderMarkdown } from "../markdown/frontmatter.js";
import { directorPrompt, type DirectorProfile } from "../profiles/director.js";
import { evaluationStyleBlock, evaluationStyleInstruction, type EvaluationStyle } from "../profiles/evaluation-style.js";
import type { GhostwriterProfile } from "../profiles/ghostwriter.js";
import { readerPersonaSystemPrompt, type ReaderPersonaProfile } from "../profiles/readers.js";
import { currentRequest, unescapePromptData, untrustedData } from "../prompt/trust.js";
import {
  READER_EVALUATION_TOOL,
  READER_SUMMARY_TOOL,
  chapterReaderText,
  normalizeReaderEvaluationOutput,
  renderReaderEvaluationBody,
  renderReaderSummaryBody,
} from "../readers/evaluation.js";
import { sha256Hex } from "../util/hash.js";
import { asArray, asInteger, asNumber, asOneOf, asRecord, asString, asStringList } from "../util/json.js";
import { bulletList, clipText, countWords, isItalian, languageName, OUTPUT_TOKENS_CEILING, sceneCharacterLimit, scaleOutputTokens, tokensPerWord, truncate } from "../util/text.js";
import { chapterLines, layoutChapters, listSection, outlineList, type ChapterFormat } from "./outline.js";
import { legacyChapters, queuedMarkReviewed, startedReview } from "./frozen.js";
import { SCENES_PER_CHAPTER, batchesNamed, firstMissingChapter, importedChapters, isExtensionNote, nextPlanBatch, planRange, revisionBatchStarts, sceneFile, scenesForChapter, type TaskDescriptor } from "./planner.js";
import {
  CHAPTER_REVIEW_TOOL,
  CHAPTER_SUMMARY_TOOL,
  CONCEPT_TOOL,
  CONSOLIDATION_TOOL,
  FINDINGS_TOOL,
  IMPACT_TOOL,
  PLAN_REACTION_TOOL,
  PLAN_REVIEW_TOOL,
  PLAN_TOOL,
  SCENES_TOOL,
  SCENE_SUMMARY_TOOL,
  architectSystemPrompt,
  continuitySystemPrompt,
  specialistsSystemPrompt,
  writerSystemPrompt,
} from "./prompts.js";
import { MAX_BOOK_CHAPTERS, MAX_DIRECTOR_NOTES, CONCEPT_LOGLINE_CHARACTERS, closedRound, normalizeFinalReview, recordChapterRound } from "./state.js";
import { STORY_SO_FAR_MAX_WORDS, STORY_SO_FAR_TARGET_WORDS, pruneStorySnapshots, readStorySoFar, renderTotalResumeBody, storySoFarExcess } from "./story-so-far.js";
import type { AuthorIntervention, AutopilotMessageCode, AutopilotPlan, AutopilotState, FrozenChapterView, InsightTone, PlannedChapter, PlannedScene, ReviewDecision, ReviewFinding, RevisionRequest } from "./types.js";

export type TaskAi = (request: Omit<AiRequest, "signal">) => Promise<AiResponse>;

/** What an insight says besides its words: a code a client can say in its own language, and what it is about. */
export interface InsightExtra {
  code?: AutopilotMessageCode;
  chapterNumber?: number;
  ghostwriter?: string;
}

export interface TaskContext {
  bookId: string;
  store: BookStore;
  /** Working copy of the state owned by this step: tasks mutate it directly. */
  state: AutopilotState;
  snapshot: BookSnapshot;
  director: DirectorProfile;
  readerPanel: ReaderPersonaProfile[];
  language: string;
  task: TaskDescriptor;
  /** Author "next step" notes delivered to this step. */
  notes: AuthorIntervention[];
  now: () => Date;
  signal: AbortSignal;
  /** This is the repeat of a step whose reply was rejected: the request carries the reason. */
  rejectedBefore?: boolean;
  ai: TaskAi;
  insight: (tone: InsightTone, title: string, detail?: string, extra?: InsightExtra) => void;
  /** The book's evaluation style (`evaluation-guidelines.md`): the steps that judge use it. Absent or `null`: the book has none. */
  evaluationStyle?: EvaluationStyle | null;
  /** The book's outline, read through the run's cache. Absent: it is read from the snapshot. */
  outline?: OutlineReader;
}

export interface TaskResult {
  changes: BookFileChange[];
  summary: string;
}

// ─── Shared prompt fragments ────────────────────────────────────────────────

function bookHeader(ctx: TaskContext): string {
  const brief = ctx.state.brief;
  return [
    `BOOK: ${ctx.snapshot.book.title}`,
    `LANGUAGE: ${languageName(ctx.language)}`,
    brief.genre ? `GENRE: ${brief.genre}` : "",
    brief.audience ? `AUDIENCE: ${brief.audience}` : "",
  ].filter(Boolean).join("\n");
}

function briefBlock(ctx: TaskContext): string {
  const brief = ctx.state.brief;
  return [
    brief.idea ? `AUTHOR'S IDEA:\n${brief.idea}` : "",
    brief.synopsis ? `AUTHOR'S CHAPTER-BY-CHAPTER SYNOPSIS (binding):\n${brief.synopsis}` : "",
    `TARGET: about ${brief.wordsPerScene} words per scene.`,
  ].filter(Boolean).join("\n\n");
}

/** Author rules travel as instructions (they come from the author), never as repository data. */
function authorRules(ctx: TaskContext, includeNotes = true): string {
  const blocks: string[] = [];
  if (ctx.state.constraints.length) blocks.push(`Binding author rules:\n${bulletList(ctx.state.constraints)}`);
  if (includeNotes && ctx.notes.length) blocks.push(`Author notes for this step (they override your own choices):\n${bulletList(ctx.notes.map((note) => note.text))}`);
  return blocks.join("\n\n");
}

function directorGuidance(ctx: TaskContext): string {
  return ctx.state.directorNotes.length ? `DIRECTOR'S STANDING GUIDANCE:\n${bulletList(ctx.state.directorNotes)}` : "";
}

function directorTaste(profile: DirectorProfile): string {
  return [
    profile.priorities.length ? `Priorities:\n${bulletList(profile.priorities)}` : "",
    profile.taste.length ? `Taste:\n${bulletList(profile.taste)}` : "",
    profile.redLines.length ? `Red lines (never allowed):\n${bulletList(profile.redLines)}` : "",
    profile.body.trim() ? `Vision:\n${truncate(profile.body.trim(), 2500)}` : "",
  ].filter(Boolean).join("\n\n");
}

function chapterPlanBlock(chapter: PlannedChapter): string {
  return [
    `CHAPTER ${chapter.number}: ${chapter.title}`,
    chapter.summary ? `Summary: ${chapter.summary}` : "",
    chapter.goal ? `Purpose: ${chapter.goal}` : "",
    chapter.pov.length ? `Point of view: ${chapter.pov.join(", ")}` : "",
    chapter.keyEvents.length ? `Key events:\n${bulletList(chapter.keyEvents)}` : "",
    chapter.reveals.length ? `Reveals:\n${bulletList(chapter.reveals)}` : "",
  ].filter(Boolean).join("\n");
}

function scenePlanBlock(scene: PlannedScene, label = "THIS SCENE"): string {
  return [
    `${label} — Scene ${scene.number}: ${scene.title}`,
    scene.goal ? `Goal: ${scene.goal}` : "",
    scene.pov ? `Point of view: ${scene.pov}` : "",
    scene.location ? `Location: ${scene.location}` : "",
    scene.characters.length ? `Characters: ${scene.characters.join(", ")}` : "",
    scene.beats.length ? `Beats:\n${scene.beats.map((beat, index) => `${index + 1}. ${beat}`).join("\n")}` : "",
    scene.summary ? `Planned outcome: ${scene.summary}` : "",
  ].filter(Boolean).join("\n");
}

function data(sections: Array<string | false | undefined | null>): string {
  return untrustedData("repository_content", sections.filter((section): section is string => Boolean(section && section.trim())).join("\n\n"));
}

function request(lines: Array<string | false | undefined | null>): string {
  return currentRequest(lines.filter((line): line is string => Boolean(line && line.trim())).join("\n\n"));
}

/** A limit on the reply of a step, sized for a book in a Latin script and grown for the language of this one (unchanged for Italian and English). */
function outputLimit(ctx: TaskContext, tokens: number): number {
  return scaleOutputTokens(tokens, ctx.snapshot.book.language);
}

/** Tokens the reply of a scene may take: its words, each at what a word of the book's language costs, and room for what is not prose. */
function sceneOutputLimit(ctx: TaskContext, words: number): number {
  return Math.min(OUTPUT_TOKENS_CEILING, Math.ceil(words * tokensPerWord(ctx.snapshot.book.language)) + 800);
}

/**
 * Characters of a scene a prompt that judges or summarizes it keeps: what the book asks of a scene, with room for one that
 * runs over (`wordsPerScene`), and never less than `floor`, the limit these prompts had before (so nothing is cut that was not).
 * A scene over it keeps its start and its end.
 */
function sceneLimit(ctx: TaskContext, floor: number): number {
  return Math.max(floor, sceneCharacterLimit(ctx.state.brief.wordsPerScene));
}

/** The ghostwriter of a chapter. One the book names that is not a file name is skipped, and the author is told. */
function ghostwriterOf(ctx: TaskContext, chapter: ChapterInfo): Promise<GhostwriterProfile | null> {
  return loadGhostwriter(ctx.store, ctx.snapshot, chapter, undefined, {
    onInvalid: (slug) => ctx.insight(
      "warning",
      isItalian(ctx.language) ? `Il ghostwriter «${slug}» non è un nome di file valido: scrive quello predefinito` : `The ghostwriter «${slug}» is not a valid file name: the default one writes`,
      isItalian(ctx.language) ? "Correggi la riga `ghostwriter` del libro, del capitolo o della scena." : "Correct the `ghostwriter` line of the book, the chapter or the scene.",
    ),
  });
}

// ─── The outline (Scaletta) and the evaluation style ───────────────────────

const outlineReaders = new WeakMap<TaskContext, OutlineReader>();

/** The outline of the book: the run's reader (with its cache), or one over the snapshot for a step that runs on its own. */
function outlineOf(ctx: TaskContext): OutlineReader {
  if (ctx.outline) return ctx.outline;
  let reader = outlineReaders.get(ctx);
  if (!reader) {
    reader = OutlineReader.of(ctx.store, ctx.snapshot);
    outlineReaders.set(ctx, reader);
  }
  return reader;
}

/** What binds the autopilot in the outline: every entry but the autopilot's own untouched ones, and the description the author wrote. */
interface AuthorOutline {
  /** The working title and the description of the book, when the author wrote them. */
  book?: string;
  entries: Map<number, OutlineChapterEntry>;
  /** Something binds: only then a prompt carries the outline, so a book without one is asked what it always was. */
  any: boolean;
  /** The chapters of the book: the number of the last chapter entry of the outline, the autopilot's own entries included (0 without entries). */
  lastChapter: number;
}

/** Characters of the description of the book, of the entries of the chapters a step plans (shared among them), and of the list of the others. */
const OUTLINE_BOOK_CHARS = 3000;
const OUTLINE_BATCH_CHARS = 24_000;
const OUTLINE_CONTEXT_CHARS = 12_000;
const OUTLINE_ENTRY_MIN_CHARS = 400;

async function authorOutline(ctx: TaskContext): Promise<AuthorOutline> {
  const outline = outlineOf(ctx);
  if (outline.empty) return { entries: new Map(), any: false, lastChapter: 0 };
  const [book, chapters] = await Promise.all([outline.book(), outline.chapters()]);
  const entries = new Map(chapters.filter((entry) => !entry.intact).map((entry) => [entry.number, entry]));
  // The idea of the book is the description of the book: the brief's idea already travels in the book's header, so it is not said twice.
  const idea = ctx.state.brief.idea.trim();
  const body = book && book.body.trim() !== idea ? book.body : "";
  const description = book && !book.intact && (body || book.title)
    ? truncate([book.title ? `Working title: ${book.title}` : "", body].filter(Boolean).join("\n"), OUTLINE_BOOK_CHARS)
    : undefined;
  return { ...(description ? { book: description } : {}), entries, any: Boolean(description) || entries.size > 0, lastChapter: outline.last };
}

function entryHeading(entry: OutlineChapterEntry): string {
  return `Chapter ${entry.number} ${entry.title ? `«${entry.title}»` : "(no title yet: give it one)"}`;
}

const OUTLINE_ENTRIES: ChapterFormat<OutlineChapterEntry> = {
  render(entry, detail) {
    const head = `${entry.number}. ${entry.title || "(no title yet)"}`;
    if (detail === "title" || !entry.body) return head;
    return `${head} — ${truncate(entry.body.replace(/\s+/g, " "), detail === "full" ? 600 : 200)}`;
  },
  collapse(entries, titles) {
    const range = `Chapters ${entries[0].number}-${entries[entries.length - 1].number}`;
    return titles ? `${range}: ${entries.map((entry) => entry.title || "(no title yet)").join("; ")}` : `${range} (entries of the outline)`;
  },
};

function outlineBookSection(view: AuthorOutline): string {
  return view.book ? `AUTHOR'S OUTLINE, THE BOOK (binding):\n${view.book}` : "";
}

/** The entries of the chapters `from` to `to`, whole as far as their share of the budget allows. */
function outlineBatchSection(view: AuthorOutline, from: number, to: number): string {
  const entries = [...view.entries.values()].filter((entry) => entry.number >= from && entry.number <= to).sort((left, right) => left.number - right.number);
  if (!entries.length) return "";
  const share = Math.max(OUTLINE_ENTRY_MIN_CHARS, Math.floor(OUTLINE_BATCH_CHARS / entries.length));
  const label = from === to ? `CHAPTER ${from}` : `CHAPTERS ${from}-${to}`;
  return `AUTHOR'S OUTLINE, ${label} (binding):\n${entries.map((entry) => `${entryHeading(entry)}:\n${truncate(entry.body, share) || "(no text)"}`).join("\n\n")}`;
}

/** Other entries of the outline, condensed around `around` like every list of chapters. */
function outlineListSection(entries: OutlineChapterEntry[], around: number | undefined, label: string): string {
  return entries.length ? listSection(label, layoutChapters(entries, OUTLINE_ENTRIES, { around, maxChars: OUTLINE_CONTEXT_CHARS })) : "";
}

const OUTLINE_RULE = "Follow the author's outline (AUTHOR'S OUTLINE, in the data): the same chapters, in the same order, with the same hypothetical titles (refine a title only where the entry has none) and the same events. Enrich it, never change it.";
const OUTLINE_AND_SYNOPSIS = "The chapter-by-chapter synopsis of the brief still applies where the outline says nothing; where they differ, the outline wins.";

/** The ghostwriter an entry names, when the book has it. One it does not have is said (with its code), and the book's writes the chapter. */
function outlineGhostwriter(ctx: TaskContext, entry: OutlineChapterEntry | undefined): string | undefined {
  const slug = entry?.ghostwriter;
  if (!entry || !slug) return undefined;
  if (isValidGhostwriterSlug(slug) && ctx.snapshot.ghostwriterSlugs.includes(slug)) return slug;
  const italian = isItalian(ctx.language);
  ctx.insight(
    "warning",
    italian ? `La Sinossi del capitolo ${entry.number} indica il ghostwriter «${slug}», che non esiste: lo scrive quello del libro` : `The synopsis of chapter ${entry.number} names the ghostwriter «${slug}», which does not exist: the book's ghostwriter writes it`,
    italian ? `Crea ghostwriters/${slug}.md, oppure correggi la voce della Sinossi.` : `Create ghostwriters/${slug}.md, or correct the entry of the synopsis.`,
    { code: "outlineGhostwriter", chapterNumber: entry.number, ghostwriter: slug },
  );
  return undefined;
}

/** What the autopilot writes in the outline for a chapter: its title, then its summary and its key events as a list. */
function outlineContentOf(chapter: PlannedChapter): { title: string; body: string; ghostwriter?: string } {
  const body = [chapter.summary.trim(), chapter.keyEvents.length ? bulletList(chapter.keyEvents) : ""].filter(Boolean).join("\n\n");
  return { title: chapter.title, body, ...(chapter.ghostwriter ? { ghostwriter: chapter.ghostwriter } : {}) };
}

/**
 * The outline after a plan: a planned chapter without an entry gets one, as the autopilot's (`origin: autopilot`, with the `digest`
 * of what it wrote); a chapter the author wrote gets one only when it has none, with its summary; an entry of the autopilot that
 * nobody touched follows the new plan of its chapter; an entry of the author is never touched. Every chapter remembers the digest
 * of its entry as it is after this step, so that a later change of the author is recognized; a written chapter the plan knew keeps
 * the digest it followed, so that a change nobody decided about yet is not taken for followed. With `fillOutline` off nothing is
 * written. `outline/book.md` is written once, when it is missing, with the logline of the concept. The entries it writes are a series
 * of the journal of the Synopsis (`outline/changes.yml`), by the autopilot, in the same commit.
 */
async function fillOutline(ctx: TaskContext, planned: PlannedChapter[], imported: PlannedChapter[]): Promise<BookFileChange[]> {
  const fill = ctx.state.options.fillOutline !== false;
  const outline = outlineOf(ctx);
  const entries = new Map((await outline.chapters()).map((entry) => [entry.number, entry]));
  const changes: BookFileChange[] = [];
  const was = new Map<number, OutlineJournalSeen>();
  const now = new Map<number, OutlineJournalSeen>();
  const write = async (chapter: PlannedChapter, existing?: OutlineChapterEntry) => {
    const content = outlineContentOf(chapter);
    const digest = await outlineEntryDigest(content);
    if (!existing || digest !== existing.contentDigest) {
      changes.push({
        path: existing?.path ?? outlineChapterPath(chapter.number),
        content: serializeOutlineChapter({ number: chapter.number, ...content, origin: "autopilot", digest, frontmatter: existing?.frontmatter }),
        expectedHash: existing ? existing.hash : null,
      });
      if (existing) was.set(chapter.number, { title: existing.title, digest: existing.contentDigest });
      now.set(chapter.number, { title: content.title, digest });
    }
    chapter.outlineDigest = digest;
  };
  for (const chapter of imported) {
    const entry = entries.get(chapter.number);
    if (entry) chapter.outlineDigest ??= entry.contentDigest;
    else if (fill && chapter.summary.trim()) await write(chapter);
    else delete chapter.outlineDigest;
  }
  for (const chapter of planned) {
    const entry = entries.get(chapter.number);
    if (entry && !(entry.intact && fill)) chapter.outlineDigest = entry.contentDigest;
    else if (fill) await write(chapter, entry ?? undefined);
    else delete chapter.outlineDigest;
  }
  if (fill && !outline.index.book) {
    const body = clipText(ctx.state.concept.logline || ctx.state.brief.idea, CONCEPT_LOGLINE_CHARACTERS).trim();
    if (body) changes.push({ path: OUTLINE_BOOK_FILE, content: serializeOutlineBook({ body, origin: "autopilot", digest: await outlineBookDigest({ body }) }), expectedHash: null });
  }
  const { chapters, more } = outlineJournalChaptersOf(was, now, ctx.language);
  if (chapters.length) {
    const journal = await ctx.store.read(OUTLINE_CHANGES_FILE);
    const at = ctx.now();
    changes.push({
      path: OUTLINE_CHANGES_FILE,
      // The id comes from the moment of the step: one runner writes at a time, and a run with a fixed clock writes the same file.
      content: appendOutlineJournal(journal?.content, { id: `autopilot-${at.getTime().toString(36)}`, at: at.toISOString(), by: "autopilot", chapters, ...(more ? { more } : {}) }, at),
      expectedHash: journal?.hash ?? null,
    });
  }
  return changes;
}

/** The style a step that judges is given, among the data, and the instruction to judge with it; nothing without a style. */
function evaluationStyleOf(ctx: TaskContext, kind: Parameters<typeof evaluationStyleInstruction>[0]): { block: string; rule: string } {
  const block = evaluationStyleBlock(ctx.evaluationStyle, { criteria: kind !== "plan" });
  return block ? { block, rule: evaluationStyleInstruction(kind) } : { block: "", rule: "" };
}

const MAX_NOTE_CHARACTERS = 400;

/** Same note despite case, punctuation, quotes or spacing. */
function noteKey(note: string): string {
  return normalizeForMatch(note).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function mergeNotes(existing: string[], incoming: string[]): string[] {
  const merged = [...existing];
  const keys = new Set(merged.map(noteKey));
  for (const raw of incoming) {
    const note = truncate(raw.replace(/\s+/g, " ").trim(), MAX_NOTE_CHARACTERS);
    const key = noteKey(note);
    if (!key || keys.has(key)) continue;
    keys.add(key);
    merged.push(note);
  }
  return merged.slice(-MAX_DIRECTOR_NOTES);
}

function chapterOf(ctx: TaskContext): PlannedChapter {
  const chapter = ctx.state.plan?.chapters.find((entry) => entry.number === ctx.task.chapterNumber);
  if (!chapter) throw new Error(`Chapter ${ctx.task.chapterNumber} is not in the plan.`);
  return chapter;
}

/** The director's verdict, tolerant of case, spacing and "approved"/"revision" variants; anything else rejects the reply. */
function verdictOf(value: unknown, subject: string): "approve" | "revise" {
  const verdict = parseDirectorVerdict(value);
  if (verdict) return verdict === "approve" ? "approve" : "revise";
  throw new AiReplyRejectedError(`${subject} was rejected: the field "verdict" must be "approve" or "revise".`);
}

/** Why an approval is not accepted as it was given, in the book's language. */
function withheldApproval(ctx: TaskContext, score: number, outcome: string): string {
  const needed = ctx.director.approvalScore;
  return isItalian(ctx.language)
    ? `Il direttore ha approvato con ${score}/10, sotto il punteggio di approvazione (${needed}/10): ${outcome}`
    : `The director approved with ${score}/10, below the approval score of ${needed}/10: ${outcome}`;
}

/** The story before a chapter (the whole book without one), keeping its most recent part. */
function storySoFar(ctx: TaskContext, beforeChapter: number | undefined, max: number): Promise<string> {
  return readStorySoFar(ctx.store, { chapters: ctx.state.plan?.chapters ?? importedChapters(ctx.snapshot), beforeChapter, max });
}

function sceneOf(chapter: PlannedChapter, number: number | undefined): PlannedScene {
  const scene = chapter.scenes.find((entry) => entry.number === number);
  if (!scene) throw new Error(`Scene ${number} is not in the plan of chapter ${chapter.number}.`);
  return scene;
}

function chapterFiles(ctx: TaskContext, chapter: PlannedChapter): ChapterInfo {
  return ctx.snapshot.chapters.find((entry) => entry.slug === chapter.slug)
    ?? { slug: chapter.slug, number: chapter.number, title: chapter.title, pov: chapter.pov, path: chapterFilePath(chapter.slug), paragraphs: [], ...(chapter.ghostwriter ? { ghostwriter: chapter.ghostwriter } : {}) };
}

/** A line that only labels the scene, in Latin script ("Scene 3:", "Scena 3."): the writer is asked for prose and nothing else. */
const LATIN_SCENE_HEADING = /^(?:scene|scena)\s+\d+\s*[:.—-]/i;
/** The same label in the other scripts ("Сцена 3.", "场景3：", "シーン 3 —", "第三场"). A sentence that merely starts with the word is not one. */
const OTHER_SCENE_HEADING = /^(?:(?:сцена|σκηνή|σκηνη|场景|場景|場面|シーン|장면|مشهد|סצנה|दृश्य|ฉาก)\s*[\p{Nd}〇一二三四五六七八九十]+\s*[:.：。—–-]|第\s*[\p{Nd}〇一二三四五六七八九十百]+\s*[场場幕节節]\s*(?:[:：.。—–-]|$))/iu;

/** Strip wrappers models sometimes add around prose, including a leading reasoning block. */
export function cleanProse(text: string): string {
  let value = splitReasoningBlock((text ?? "").trim()).reply;
  value = value.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  const lines = value.split(/\r?\n/);
  while (lines.length && (/^#{1,6}\s/.test(lines[0].trim()) || LATIN_SCENE_HEADING.test(lines[0].trim()) || OTHER_SCENE_HEADING.test(lines[0].trim()) || !lines[0].trim())) lines.shift();
  // The model repeats what it read, and what it read was escaped.
  return unescapePromptData(lines.join("\n").trim());
}

/** Prose that cannot become a scene is rejected (and the step retried with the reason). */
function assertProse(text: string, minimumWords: number): void {
  if (!text.trim()) throw new AiReplyRejectedError("The model returned an empty scene.");
  if (/^[{[]/.test(text.trim())) throw new AiReplyRejectedError("The model returned data instead of prose.");
  const words = countWords(text);
  if (words < minimumWords) throw new AiReplyRejectedError(`The scene is too short: ${words} words, at least ${minimumWords} expected.`);
}

function normalizeForMatch(text: string): string {
  return text.replace(/[«»“”„"]/g, "\"").replace(/[‘’`]/g, "'").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The change that rewrites `path` as `render` says (it receives the file as it is now, or `null`), or `null` when nothing changes.
 * A rewrite of a file whose frontmatter cannot be read is refused (`FrontmatterError`, naming the file and the line): it would
 * drop the keys that could not be read.
 */
async function changeFor(ctx: Pick<TaskContext, "store" | "language">, path: string, render: (existing: { frontmatter: Record<string, unknown>; body: string } | null) => string | null): Promise<BookFileChange | null> {
  const file = await ctx.store.read(path);
  const existing = file ? parseMarkdown(file.content) : null;
  const content = render(existing ? { frontmatter: existing.frontmatter, body: existing.body } : null);
  if (content === null) return null;
  if (file && file.content === content) return null;
  if (existing) assertFrontmatterReadable(path, existing, ctx.language);
  return { path, content, expectedHash: file?.hash ?? null };
}

/**
 * A step that is going to rewrite these files checks them before it asks the model anything: when the frontmatter of one cannot
 * be read it is refused here (`FrontmatterError`), not after a call that was paid for and cannot be saved.
 */
async function assertRewritable(ctx: Pick<TaskContext, "store" | "language">, paths: string[]): Promise<void> {
  for (const path of paths) {
    const file = await ctx.store.read(path);
    if (file) assertFrontmatterReadable(path, parseMarkdown(file.content), ctx.language);
  }
}

/** The ghostwriter that writes a chapter that names none: the book's, else the default profile, else the first. */
function bookGhostwriter(snapshot: BookSnapshot): string | undefined {
  return snapshot.book.ghostwriter ?? (snapshot.ghostwriterSlugs.includes("default") ? "default" : snapshot.ghostwriterSlugs[0]);
}

/** The `chapter.md` of a chapter the plan creates, with the chapter's own ghostwriter when it is not the book's. */
function chapterDocument(chapter: PlannedChapter, snapshot?: BookSnapshot): string {
  const ghostwriter = chapter.ghostwriter && (!snapshot || chapter.ghostwriter !== bookGhostwriter(snapshot)) ? chapter.ghostwriter : undefined;
  return renderMarkdown(
    { type: "chapter", id: `chapter:${chapter.slug}`, number: chapter.number, title: chapter.title, summary: chapter.summary, pov: chapter.pov, ...(ghostwriter ? { ghostwriter } : {}), canon: "draft" },
    `# ${chapter.title}\n\n${chapter.goal || chapter.summary || ""}`,
  );
}

function ensureChapterFile(ctx: TaskContext, chapter: PlannedChapter): BookFileChange | null {
  const path = chapterFilePath(chapter.slug);
  return ctx.snapshot.files.has(path) ? null : { path, content: chapterDocument(chapter, ctx.snapshot), expectedHash: null };
}

/** Human-readable mirror of the plan, refreshed whenever the plan changes. */
export function renderPlanMarkdown(state: AutopilotState, language: string): string {
  const italian = isItalian(language);
  const plan = state.plan;
  const status = (chapter: PlannedChapter) => {
    const labels = italian
      ? { planned: "pianificato", writing: "in scrittura", review: "in revisione", done: "approvato" }
      : { planned: "planned", writing: "writing", review: "in review", done: "approved" };
    return chapter.imported ? (italian ? "scritto dall'autore" : "written by the author") : labels[chapter.status];
  };
  const lines = [
    `# ${italian ? "Piano dell'autopilot" : "Autopilot plan"}`,
    "",
    italian ? "File generato dall'autopilot: lo stato completo è in `autopilot/state.json`." : "Generated by the autopilot: the full state lives in `autopilot/state.json`.",
    "",
    `- ${italian ? "Approvato dal direttore" : "Approved by the director"}: ${plan?.approved ? (italian ? "sì" : "yes") : (italian ? "no" : "no")}`,
    `- ${italian ? "Capitoli" : "Chapters"}: ${plan?.chapters.length ?? 0}`,
  ];
  for (const chapter of plan?.chapters ?? []) {
    lines.push("", `## ${formatOrdinal(chapter.number)} ${chapter.title} (${status(chapter)}${chapter.score ? ` · ${chapter.score}/10` : ""})`, "");
    if (chapter.summary) lines.push(chapter.summary, "");
    for (const scene of chapter.scenes) lines.push(`- ${scene.number}. ${scene.title}${scene.summary ? ` — ${scene.summary}` : scene.goal ? ` — ${scene.goal}` : ""}`);
  }
  if (state.directorNotes.length) lines.push("", `## ${italian ? "Indicazioni del direttore" : "Director's guidance"}`, "", bulletList(state.directorNotes));
  return `${lines.join("\n").trim()}\n`;
}

async function planFileChange(ctx: TaskContext): Promise<BookFileChange | null> {
  const content = renderPlanMarkdown(ctx.state, ctx.language);
  const file = await ctx.store.read(AUTOPILOT_PLAN_FILE);
  if (file?.content === content) return null;
  return { path: AUTOPILOT_PLAN_FILE, content, expectedHash: file?.hash ?? null };
}

async function renderPlot(ctx: TaskContext): Promise<BookFileChange | null> {
  const plan = ctx.state.plan;
  if (!plan) return null;
  const secrets = ctx.snapshot.canon.filter((entry) => entry.kind === "secret");
  const sections: string[] = [];
  for (const chapter of plan.chapters) {
    const sceneLines = chapter.scenes.map((scene) => scene.summary || scene.goal).filter((line): line is string => Boolean(line)).slice(0, 6);
    const revealed = secrets.filter((secret) => secret.revealIn === `chapter:${chapter.slug}`).map((secret) => secret.name);
    sections.push([
      `## Chapter ${formatOrdinal(chapter.number)} ${chapter.title}`,
      "",
      chapter.summary || "Add chapter summary here.",
      "",
      "### What Happens",
      "",
      bulletList(sceneLines.length ? sceneLines : chapter.keyEvents.length ? chapter.keyEvents : ["Not written yet."]),
      "",
      "### Secrets Revealed",
      "",
      bulletList(revealed.length ? revealed : chapter.reveals.length ? chapter.reveals : ["No secret reveal is explicitly tied to this chapter yet."]),
      "",
    ].join("\n"));
  }
  const placed = new Set(plan.chapters.map((chapter) => `chapter:${chapter.slug}`));
  const pending = secrets.filter((secret) => !secret.revealIn || !placed.has(secret.revealIn)).map((secret) => secret.name);
  const body = [
    "# Plot Overview",
    "",
    `- Book: ${ctx.snapshot.book.title}`,
    `- Chapters tracked: ${plan.chapters.length}`,
    `- Chapters approved: ${plan.chapters.filter((chapter) => chapter.status === "done").length}`,
    `- Secrets tracked: ${secrets.length}`,
    "",
    "# Chapter Map",
    "",
    ...sections,
    "# Pending Or Unplaced Reveals",
    "",
    bulletList(pending.length ? pending : ["All current secrets are tied to a chapter reveal, or no secrets exist yet."]),
  ].join("\n");
  return changeFor(ctx, PLOT_FILE, (existing) => renderMarkdown(
    { ...(existing?.frontmatter ?? {}), type: "plot", id: "plot:main", title: `${ctx.snapshot.book.title} Plot` },
    body,
  ));
}

function compact(changes: Array<BookFileChange | null>): BookFileChange[] {
  return changes.filter((change): change is BookFileChange => Boolean(change));
}

// ─── Concept ────────────────────────────────────────────────────────────────

async function runConcept(ctx: TaskContext): Promise<TaskResult> {
  const [bookBody, design, context, view] = await Promise.all([
    readBody(ctx.store, BOOK_FILE, 2500),
    readDocument(ctx.store, STORY_DESIGN_FILE),
    readDocument(ctx.store, CONTEXT_FILE),
    authorOutline(ctx),
  ]);
  // Both files are rewritten from what the model says: one whose frontmatter cannot be read is refused before the call.
  if (design) assertFrontmatterReadable(STORY_DESIGN_FILE, design.document, ctx.language);
  if (context && isThinDocument(context.document.body)) assertFrontmatterReadable(CONTEXT_FILE, context.document, ctx.language);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: "autopilot:concept",
    system: architectSystemPrompt(ctx.language),
    user: `${request([
      `Design the foundation of this novel from the author's brief, for about ${view.lastChapter} chapters.`,
      "Create 3 to 8 characters with clear desires, fears and arcs, the key locations, factions only when useful, and 1 to 5 secrets that drive the plot, each with the chapter where the reader learns it.",
      ctx.state.brief.synopsis ? "The author's chapter-by-chapter synopsis is binding: the concept must make it possible exactly as written." : "",
      view.any ? "The author's outline (AUTHOR'S OUTLINE, in the data) is binding too, and wins over the synopsis: the concept must make it possible exactly as written." : "",
      "Reuse the existing canon names instead of duplicating them.",
      authorRules(ctx),
    ])}\n\n${data([
      bookHeader(ctx),
      briefBlock(ctx),
      outlineBookSection(view),
      outlineListSection([...view.entries.values()], undefined, "AUTHOR'S OUTLINE, CHAPTER BY CHAPTER (binding)"),
      bookBody ? `BOOK DESCRIPTION:\n${bookBody}` : "",
      design?.document.body ? `CURRENT STORY DESIGN:\n${truncate(design.document.body, 4000)}` : "",
      context?.document.body ? `CURRENT WORLD CONTEXT:\n${truncate(context.document.body, 3000)}` : "",
      ctx.snapshot.canon.length ? `EXISTING CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: true })}` : "",
      `DIRECTOR (the author's taste):\n${directorTaste(ctx.director)}`,
    ])}`,
    json: CONCEPT_TOOL,
    maxOutputTokens: outputLimit(ctx, 9000),
    temperature: 0.8,
  });
  const output = requireStructuredFields(response.json, { storyDesign: "text" }, "The concept");
  const storyDesign = asString(output.storyDesign);
  const logline = asString(output.logline);
  const changes: Array<BookFileChange | null> = [];
  changes.push({
    path: STORY_DESIGN_FILE,
    content: renderMarkdown(
      design?.document.frontmatter && Object.keys(design.document.frontmatter).length ? design.document.frontmatter : { type: "note", id: "note:story-design", title: "Story Design", scope: "story-design", bucket: "story-design" },
      `${storyDesign.startsWith("#") ? "" : "# Story Design\n\n"}${logline && !storyDesign.includes(logline) ? `> ${logline}\n\n` : ""}${storyDesign}`,
    ),
    expectedHash: design?.file.hash ?? null,
  });
  const contextText = asString(output.context);
  if (contextText && (!context || isThinDocument(context.document.body))) {
    changes.push({
      path: CONTEXT_FILE,
      content: renderMarkdown(context?.document.frontmatter && Object.keys(context.document.frontmatter).length ? context.document.frontmatter : { type: "context", id: "context:book", title: "Book Context" }, contextText),
      expectedHash: context?.file.hash ?? null,
    });
  }
  const known: Array<{ kind: CanonKind; slug: string; names: string[] }> = ctx.snapshot.canon.map((entry) => ({ kind: entry.kind, slug: entry.slug, names: [entry.name, ...entry.aliases] }));
  const counts = { character: 0, other: 0 };
  // File names that are taken, whatever their case: the book's own, and the ones this step creates.
  const taken = new Set([...ctx.snapshot.files.keys()].map((name) => name.toLowerCase()));
  const italian = isItalian(ctx.language);
  const create = (kind: "character" | "location" | "faction" | "secret", name: string, frontmatter: Record<string, unknown>, body: string): string => {
    // An entity that already exists under this name, an alias or (for characters) a first name is reused, never duplicated.
    const existing = known.find((entry) => entry.kind === kind && sameCanonEntity(kind, name, entry.names));
    if (existing) return existing.slug;
    // Two different names can make one file name ("Café" and "Cafe!", "Игорь" and "Игор"): the later one gets -2, -3… and the book is told.
    const base = canonSlug(kind, name);
    let slug = base;
    for (let number = 2; taken.has(canonPath(kind, slug).toLowerCase()); number += 1) slug = `${base}-${number}`;
    const path = canonPath(kind, slug);
    taken.add(path.toLowerCase());
    known.push({ kind, slug, names: [name] });
    if (slug !== base) {
      ctx.insight("info", italian ? `«${name}» salvato come ${path}` : `«${name}» saved as ${path}`, italian ? `Il nome di file ${canonPath(kind, base)} era già usato da un altro elemento.` : `The file name ${canonPath(kind, base)} was already taken by another entry.`);
    }
    if (kind === "character") counts.character += 1;
    else counts.other += 1;
    const label = kind === "secret" ? { title: name } : { name };
    changes.push({ path, content: renderMarkdown({ type: kind, id: `${kind}:${slug}`, ...label, ...frontmatter, canon: "draft" }, body), expectedHash: null });
    return slug;
  };
  const characterSlug = (name: string) => known.find((entry) => entry.kind === "character" && sameCanonEntity("character", name, entry.names))?.slug ?? canonSlug("character", name);
  const characters = asArray(output.characters).slice(0, 10).map(asRecord);
  for (const character of characters) {
    const name = asString(character.name);
    if (!name) continue;
    create("character", name, {
      role_tier: asOneOf(character.roleTier, ["main", "supporting", "secondary", "minor"] as const, "supporting"),
      story_role: asOneOf(character.storyRole, ["protagonist", "deuteragonist", "antagonist", "mentor", "ally", "love-interest", "foil", "comic-relief", "other"] as const, "other"),
      speaking_style: asString(character.voice) || undefined,
      function_in_book: truncate(asString(character.description), 300) || undefined,
      arc: asString(character.arc) || undefined,
      desires: asString(character.desire) ? [asString(character.desire)] : undefined,
      fears: asString(character.fear) ? [asString(character.fear)] : undefined,
    }, `# ${name}\n\n${asString(character.description)}`);
  }
  for (const location of asArray(output.locations).slice(0, 10).map(asRecord)) {
    const name = asString(location.name);
    if (name) create("location", name, { atmosphere: asString(location.atmosphere) || undefined }, `# ${name}\n\n${asString(location.description)}`);
  }
  for (const faction of asArray(output.factions).slice(0, 6).map(asRecord)) {
    const name = asString(faction.name);
    if (name) create("faction", name, { mission: asString(faction.mission) || undefined }, `# ${name}\n\n${asString(faction.description)}`);
  }
  const secrets: AutopilotState["concept"]["secrets"] = [];
  for (const secret of asArray(output.secrets).slice(0, 8).map(asRecord)) {
    const title = asString(secret.title);
    if (!title) continue;
    const holders = asStringList(secret.holders, 10).map((holder) => `character:${characterSlug(holder)}`);
    const slug = create("secret", title, { holders, stakes: asString(secret.stakes) || undefined, status: "hidden" }, `# ${title}\n\n${asString(secret.truth)}`);
    const revealChapter = asInteger(secret.revealChapter, 0, 0, MAX_BOOK_CHAPTERS);
    secrets.push({ slug, title, revealChapter: revealChapter || undefined });
  }
  // The pitch of the book, kept for the description of the outline that the plan writes when the author has none.
  const pitch = clipText(logline || asString(output.premise), CONCEPT_LOGLINE_CHARACTERS).trim();
  ctx.state.concept = { done: true, generated: true, secrets, ...(pitch ? { logline: pitch } : {}) };
  if (logline) ctx.insight("ok", logline);
  const summary = italian
    ? `${counts.character} personaggi, ${counts.other} altri elementi di canone, ${secrets.length} segreti.`
    : `${counts.character} characters, ${counts.other} other canon entries, ${secrets.length} secrets.`;
  return { changes: compact(changes), summary: logline ? `${logline} — ${summary}` : summary };
}

// ─── Summaries of the chapters the author wrote ─────────────────────────────

/** What a summary keeps of the scenes of one chapter at the least, shared among them (as the director's review does); `sceneLimit` raises it for scenes of the length the book asks for. */
const IMPORTED_CHAPTER_CHARACTERS = 60000;

/**
 * One chapter the author wrote before the autopilot took over, summarized by the model of the simple tasks and saved in its
 * `chapter.md` (and in its resume, when it has none). The story so far of every chapter written after it is made of these
 * summaries, so the first chapter the autopilot writes no longer starts blind. One chapter a step, one commit a step: the step can
 * be repeated, and a run that stops goes on with the chapters that are left.
 */
async function runSummarizeImported(ctx: TaskContext): Promise<TaskResult> {
  const same = (entry: PlannedChapter) => entry.number === ctx.task.chapterNumber && (!ctx.task.chapterSlug || entry.slug === ctx.task.chapterSlug);
  const planned = ctx.state.plan?.chapters.find((entry) => entry.imported && same(entry));
  const chapter = planned ?? importedChapters(ctx.snapshot).find(same);
  if (!chapter) throw new Error(`Chapter ${ctx.task.chapterNumber} is not a chapter written by the author.`);
  const path = chapterFilePath(chapter.slug);
  const resumePath = chapterResumePath(chapter.slug);
  await assertRewritable(ctx, [path]);
  const paragraphs = await loadChapterParagraphs(ctx.store, chapterFiles(ctx, chapter));
  if (!paragraphs.length) throw new Error(`Chapter ${chapter.number} has no scenes to summarize.`);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.summary,
    label: `autopilot:summarize-imported:${chapter.number}`,
    system: continuitySystemPrompt(ctx.language),
    user: `${request([
      `Summarize chapter ${chapter.number}${chapter.title ? ` «${chapter.title}»` : ""} in two to four sentences: what happens and what changes.`,
      "The author wrote this chapter before the autopilot took over: summarize faithfully what the text contains and never invent events.",
    ])}\n\n${data([
      bookHeader(ctx),
      `CHAPTER TEXT:\n${markedChapterText(paragraphs, sceneLimit(ctx, Math.max(3000, Math.floor(IMPORTED_CHAPTER_CHARACTERS / paragraphs.length))))}`,
    ])}`,
    json: CHAPTER_SUMMARY_TOOL,
    maxOutputTokens: outputLimit(ctx, 600),
    temperature: 0.3,
  });
  const output = requireStructuredFields(response.json, { summary: "text" }, "The chapter summary");
  const summary = asString(output.summary);
  const changes: Array<BookFileChange | null> = [];
  changes.push(await changeFor(ctx, path, (existing) => existing
    ? renderMarkdown({ ...existing.frontmatter, summary }, existing.body)
    : renderMarkdown({ type: "chapter", id: `chapter:${chapter.slug}`, number: chapter.number, title: chapter.title, summary, canon: "draft" }, `# ${chapter.title}`)));
  // A resume the author or the core already made is left alone: only a chapter without one gets it.
  if (!(await ctx.store.read(resumePath))) {
    changes.push({ path: resumePath, content: renderMarkdown({ type: "resume", id: `resume:chapter:${chapter.slug}`, title: `Resume ${chapter.slug}`, chapter: `chapter:${chapter.slug}` }, `# Chapter Summary\n\n${summary}`), expectedHash: null });
  }
  if (planned) planned.summary = summary;
  // A chapter the author wrote, summarized after the plan was made, gets its entry of the outline when it has none.
  if (planned && ctx.state.options.fillOutline !== false && !outlineOf(ctx).has(chapter.number)) {
    const content = { title: chapter.title, body: summary };
    const digest = await outlineEntryDigest(content);
    changes.push({ path: outlineChapterPath(chapter.number), content: serializeOutlineChapter({ number: chapter.number, ...content, origin: "autopilot", digest }), expectedHash: null });
    planned.outlineDigest = digest;
  }
  ctx.insight("ok", isItalian(ctx.language) ? `Capitolo ${chapter.number} riassunto` : `Chapter ${chapter.number} summarized`, summary);
  return { changes: compact(changes), summary };
}

function normalizeName(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whether a proposed canon name is an entity that already exists: same name or alias once
 * normalized, or, for characters, a lone first name matching the first word of a fuller name
 * ("Mara" and "Mara Venturi"; not "Mara Rossi" and "Mara Venturi", nor a lone surname).
 */
export function sameCanonEntity(kind: CanonKind, name: string, existingNames: string[]): boolean {
  const candidate = normalizeName(name);
  if (!candidate) return false;
  const names = existingNames.map(normalizeName).filter(Boolean);
  if (names.includes(candidate)) return true;
  if (kind !== "character") return false;
  const firstWord = (value: string) => value.split(" ")[0];
  return names.some((existing) => (!candidate.includes(" ") && firstWord(existing) === candidate) || (!existing.includes(" ") && firstWord(candidate) === existing));
}

// ─── Plan ───────────────────────────────────────────────────────────────────

async function runPlan(ctx: TaskContext): Promise<TaskResult> {
  const previous = ctx.state.plan;
  // Chapters already in the book keep what the autopilot knew about them (the synopsis saved when they closed).
  const known = new Map((previous?.chapters ?? []).map((chapter) => [chapter.slug, chapter]));
  const imported = importedChapters(ctx.snapshot).map((chapter) => {
    const earlier = known.get(chapter.slug);
    const kept = earlier?.storySoFarAtClose ? { ...chapter, storySoFarAtClose: earlier.storySoFarAtClose, ...(earlier.score !== undefined ? { score: earlier.score } : {}) } : chapter;
    // The history of the rounds of a chapter that was reviewed outlives the plan being made again around it (the book is being extended), and so does the
    // entry of the outline it follows: a change of its entry that nobody decided about yet (asked, left for later) is still one after the plan.
    const followed = earlier?.outlineDigest ? { ...kept, outlineDigest: earlier.outlineDigest } : kept;
    return earlier?.rounds?.length ? { ...followed, rounds: earlier.rounds } : followed;
  });
  // The author's outline binds the plan: its chapters, its order, its titles, its events, and as many chapters as it has.
  const view = await authorOutline(ctx);
  const target = view.lastChapter;
  const range = planRange(imported, target);
  const batch = nextPlanBatch(previous, range);
  if (!batch) throw new Error("There is no chapter left to plan.");
  const { start: startNumber, last: lastNumber } = range;
  const { from, to, batched } = batch;
  const batchCount = to - from + 1;
  const [design, context, resume] = await Promise.all([
    readBody(ctx.store, STORY_DESIGN_FILE, 6000),
    readBody(ctx.store, CONTEXT_FILE, 2500),
    readStorySoFar(ctx.store, { chapters: imported, beforeChapter: startNumber, max: 4000 }),
  ]);
  const notes = previous?.revisionNotes ?? [];
  // A batch of a long plan is revised only when it already exists; a new one only learns the notes that ask for more than the extension.
  const existing = batched ? (previous?.chapters ?? []).filter((chapter) => !chapter.imported && chapter.number >= from && chapter.number <= to) : [];
  const revising = batched ? existing.length > 0 && notes.length > 0 : notes.length > 0;
  const changesToApply = notes.filter((note) => !isExtensionNote(note));
  const secretsPlan = ctx.state.concept.secrets.filter((secret) => secret.revealChapter).map((secret) => `- ${secret.title}: reveal in chapter ${secret.revealChapter}`).join("\n");
  const otherChapters = batched && previous ? { ...previous, chapters: previous.chapters.filter((chapter) => !chapter.imported && (chapter.number < from || chapter.number > to)) } : null;
  // The chapters of this call that the outline says nothing about, and the entries of the chapters not planned yet beyond it.
  const plannedNumbers = new Set((previous?.chapters ?? []).map((chapter) => chapter.number));
  const unlisted = view.any ? Array.from({ length: batchCount }, (_, index) => from + index).filter((number) => !view.entries.has(number)) : [];
  const ahead = [...view.entries.values()].filter((entry) => entry.number >= startNumber && (entry.number < from || entry.number > to) && !plannedNumbers.has(entry.number));
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: "autopilot:plan",
    system: architectSystemPrompt(ctx.language),
    user: `${request([
      revising
        ? `Revise the chapter plan (chapters ${from}-${to}) applying the director's changes:\n${bulletList(notes)}`
        : `Plan the next ${batchCount} chapters of the novel, numbered ${from} to ${to}.`,
      batched ? `The novel will have ${target} chapters in all and is planned in batches: this call covers only chapters ${from} to ${to}.` : "",
      batched ? (to < lastNumber ? `The story must not end before chapter ${lastNumber}: leave room for what the following chapters have to tell.` : `These are the last chapters of the book: close its arcs and end the story in chapter ${lastNumber}.`) : "",
      batched && revising ? `Apply only the changes that concern chapters ${from} to ${to} or the whole book: the other chapters are revised in their own call. Return every chapter of the range.` : "",
      batched && !revising && changesToApply.length ? `Apply the changes below that concern these chapters or the whole book:\n${bulletList(changesToApply)}` : "",
      view.any ? OUTLINE_RULE : ctx.state.brief.synopsis ? "Follow the author's chapter-by-chapter synopsis exactly: same chapters, same order, same events. Enrich, never change." : "",
      view.any && ctx.state.brief.synopsis ? OUTLINE_AND_SYNOPSIS : "",
      unlisted.length && unlisted.length < batchCount ? `The outline has no entry for ${unlisted.length === 1 ? `chapter ${unlisted[0]}` : `chapters ${unlisted.join(", ")}`}: plan ${unlisted.length === 1 ? "it" : "them"} so that the story leads from the entries before to the entries after.` : "",
      imported.length ? `Chapters 1-${startNumber - 1} are already written by the author: continue from them without changing them.` : "",
      "Every chapter must change something and raise the stakes; place every secret reveal in a specific chapter; vary the shape of chapters.",
      authorRules(ctx),
    ])}\n\n${data([
      bookHeader(ctx),
      briefBlock(ctx),
      outlineBookSection(view),
      outlineBatchSection(view, from, to),
      outlineListSection(ahead, from, "AUTHOR'S OUTLINE, THE CHAPTERS AFTER THESE (binding)"),
      design ? `STORY DESIGN:\n${design}` : "",
      context ? `WORLD CONTEXT:\n${context}` : "",
      `CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: true }) || "-"}`,
      secretsPlan ? `PLANNED REVEALS:\n${secretsPlan}` : "",
      imported.length ? listSection("CHAPTERS ALREADY WRITTEN", chapterLines(imported, { around: startNumber })) : "",
      resume ? `STORY SO FAR (before chapter ${startNumber}):\n${resume}` : "",
      batched ? (otherChapters?.chapters.length ? listSection(`PLAN SO FAR (the planned chapters outside ${from}-${to})`, outlineList(otherChapters, { around: from })) : "") : revising ? listSection("CURRENT PLAN", outlineList(previous, { around: startNumber })) : "",
      batched && revising ? `CURRENT VERSION OF CHAPTERS ${from}-${to} (revise it):\n${existing.map(chapterPlanBlock).join("\n\n")}` : "",
      `DIRECTOR (the author's taste):\n${directorTaste(ctx.director)}`,
    ])}`,
    json: PLAN_TOOL,
    maxOutputTokens: outputLimit(ctx, 9000),
    temperature: 0.7,
  });
  const output = requireStructuredFields(response.json, { chapters: "list" }, "The chapter plan");
  const proposed = asArray(output.chapters).map(asRecord).filter((chapter) => asString(chapter.title)).slice(0, batchCount);
  if (proposed.length < batchCount) throw new AiReplyRejectedError(`The chapter plan has ${proposed.length} chapters with a title, but ${batchCount} were requested (chapters ${from}-${to}).`);
  const planned: PlannedChapter[] = proposed.map((chapter, index) => {
    const number = from + index;
    // The hypothetical title of the author's entry is the chapter's: the model refines a title only where the entry has none.
    const entry = view.entries.get(number);
    const title = entry?.title ? clipText(entry.title, OUTLINE_TITLE_MAX_CHARS).trim() : asString(chapter.title);
    const ghostwriter = outlineGhostwriter(ctx, entry);
    return {
      number,
      title,
      slug: chapterSlug(number, title),
      summary: asString(chapter.summary),
      goal: asString(chapter.goal),
      pov: asStringList(chapter.pov, 6),
      keyEvents: asStringList(chapter.keyEvents, 12),
      reveals: asStringList(chapter.reveals, 8),
      status: "planned",
      scenes: [],
      ...(ghostwriter ? { ghostwriter } : {}),
    };
  });
  // The chapters of the range that are outside this batch stay as they are; the batch replaces what it covers.
  const kept = (previous?.chapters ?? []).filter((chapter) => !chapter.imported && chapter.number >= startNumber && chapter.number <= lastNumber && (chapter.number < from || chapter.number > to));
  const chapters = [...imported, ...[...kept, ...planned].sort((left, right) => left.number - right.number)];
  const changes: Array<BookFileChange | null> = [];
  if (previous) {
    const retained = new Set(chapters.map((chapter) => chapter.slug));
    for (const old of previous.chapters) {
      if (old.imported || retained.has(old.slug)) continue;
      const files = ctx.snapshot.chapters.find((chapter) => chapter.slug === old.slug);
      const hash = ctx.snapshot.files.get(chapterFilePath(old.slug));
      if (hash && (!files || files.paragraphs.length === 0)) changes.push({ path: chapterFilePath(old.slug), content: null, expectedHash: hash });
    }
  }
  // The notes are applied once the batches they concern are planned; the batches still to regenerate stay listed.
  let revisionNotes = notes;
  let revisionBatches: number[] | undefined;
  if (!batched) {
    revisionNotes = [];
  } else if (revising) {
    const pending = revisionBatchStarts(previous!, range).filter((start) => start !== from);
    if (pending.length) revisionBatches = pending;
    else revisionNotes = [];
  } else if (previous?.revisionBatches?.length) {
    revisionBatches = previous.revisionBatches;
  } else if (notes.length && notes.every(isExtensionNote) && firstMissingChapter(chapters, range) === undefined) {
    revisionNotes = [];
  }
  ctx.state.plan = {
    chapters,
    approved: false,
    rounds: previous?.rounds ?? 0,
    revisionNotes,
    ...(revisionBatches ? { revisionBatches } : {}),
    readerReactions: previous?.readerReactions ?? [],
    readersDone: previous?.readersDone ?? false,
    ...(previous?.skippedReaders?.length ? { skippedReaders: previous.skippedReaders } : {}),
    awaitingAuthor: false,
    ...(previous?.removedChapters?.length ? { removedChapters: previous.removedChapters } : {}),
  };
  // The outline is filled from the plan in the same commit: what the author did not write, the author can now correct.
  changes.push(...await fillOutline(ctx, planned, imported));
  changes.push(await planFileChange(ctx));
  // A batch of a long plan is reported under the chapters it covers; a short book's only batch, as ever, under their number.
  const italian = isItalian(ctx.language);
  const single = from === to;
  const covered = single ? `${from}` : `${from}-${to}`;
  let title = italian ? `${planned.length} capitoli pianificati` : `${planned.length} chapters planned`;
  if (batched) title = italian ? `${single ? "Capitolo" : "Capitoli"} ${covered} ${single ? "pianificato" : "pianificati"}` : `${single ? "Chapter" : "Chapters"} ${covered} planned`;
  ctx.insight("info", title, planned.slice(0, 8).map((chapter) => `${chapter.number}. ${chapter.title}`).join(" · "));
  const list = planned.map((chapter) => `${chapter.number}. ${chapter.title}`).join("; ");
  return {
    changes: compact(changes),
    summary: batched ? `${single ? "Chapter" : "Chapters"} ${covered}: ${list}` : list,
  };
}

/** Where a review of the whole plan looks first: the start of what is being planned, not the chapters the author wrote. */
function planFocus(plan: AutopilotPlan): number | undefined {
  return plan.chapters.find((chapter) => !chapter.imported)?.number;
}

/**
 * A reader's reply read by `read`, or the rejection that ended it when this is already the repeat of a rejected reply:
 * a reader whose reply stays incomplete does not hold the book up, it is skipped (see `skipReader`).
 */
async function readerReply<T>(ctx: TaskContext, reply: Promise<AiResponse>, read: (response: AiResponse) => T): Promise<{ response: AiResponse; value: T } | { skipped: AiReplyRejectedError }> {
  try {
    const response = await reply;
    return { response, value: read(response) };
  } catch (error) {
    if (ctx.rejectedBefore && error instanceof AiReplyRejectedError) return { skipped: error };
    throw error;
  }
}

/** The reader is left out and the author is told; the review goes on with the readers who answered. */
function skipReader(ctx: TaskContext, name: string, error: Error): TaskResult {
  const italian = isItalian(ctx.language);
  ctx.insight("warning", italian ? `${name} saltato: la risposta è rimasta incompleta anche dopo un nuovo tentativo.` : `${name} skipped: the reply stayed incomplete after a retry.`, error.message);
  return { changes: [], summary: italian ? `${name} saltato (risposta incompleta).` : `${name} skipped (incomplete reply).` };
}

async function runPlanReader(ctx: TaskContext): Promise<TaskResult> {
  const plan = ctx.state.plan!;
  const reader = ctx.readerPanel.find((entry) => entry.slug === ctx.task.reader);
  if (!reader) {
    plan.readersDone = true;
    return { changes: [], summary: "Reader not available." };
  }
  const design = await readBody(ctx.store, STORY_DESIGN_FILE, 2500);
  const asked = await readerReply(ctx, ctx.ai({
    capability: AI_CAPABILITIES.reader,
    label: `autopilot:plan-reader:${reader.slug}`,
    system: `${readerPersonaSystemPrompt(reader, languageName(ctx.language), "brief")}\n\nYou are reading the pitch and the chapter plan of a novel that is not written yet. React honestly as this reader would.`,
    user: `${request(["React as this reader: would you read this book? What excites you, what worries you, what would you wish for?"])}\n\n${data([
      bookHeader(ctx),
      ctx.state.brief.idea ? `PITCH:\n${ctx.state.brief.idea}` : "",
      design ? `PREMISE:\n${design}` : "",
      listSection("CHAPTER PLAN", outlineList(plan, { around: planFocus(plan) })),
    ])}`,
    json: PLAN_REACTION_TOOL,
    maxOutputTokens: outputLimit(ctx, 1500),
  }), (response) => requireStructuredFields(response.json, { interest: "score", reaction: "text" }, "The reader's reaction"));
  if ("skipped" in asked) {
    plan.skippedReaders = [...new Set([...(plan.skippedReaders ?? []), reader.slug])];
    return skipReader(ctx, reader.name, asked.skipped);
  }
  const output = asked.value;
  const reaction = {
    slug: reader.slug,
    name: reader.name,
    interest: Math.round(Math.max(1, normalizeScore(output.interest) ?? 5)),
    reaction: asString(output.reaction),
    concerns: asStringList(output.concerns, 8),
    wishes: asStringList(output.wishes, 8),
  };
  plan.readerReactions = [...plan.readerReactions.filter((entry) => entry.slug !== reader.slug), reaction];
  ctx.insight(reaction.interest >= 7 ? "ok" : reaction.interest >= 5 ? "info" : "warning", `${reader.name}: ${reaction.interest}/10`, reaction.reaction);
  return { changes: [], summary: `${reaction.interest}/10 — ${truncate(reaction.reaction, 240)}` };
}

async function runPlanReview(ctx: TaskContext): Promise<TaskResult> {
  const plan = ctx.state.plan!;
  // Approving the plan puts the chapter of its reveal into the secrets the concept made that have none: those must be readable first.
  const toRewrite: string[] = [];
  for (const secret of ctx.state.concept.secrets) {
    const path = canonPath("secret", secret.slug);
    if (!plan.chapters.some((entry) => entry.number === secret.revealChapter) || !ctx.snapshot.files.has(path)) continue;
    const file = await ctx.store.read(path);
    if (file && !frontmatterString(parseMarkdown(file.content).frontmatter, "reveal_in")) toRewrite.push(path);
  }
  await assertRewritable(ctx, toRewrite);
  const [design, view] = await Promise.all([readBody(ctx.store, STORY_DESIGN_FILE, 5000), authorOutline(ctx)]);
  const style = evaluationStyleOf(ctx, "plan");
  const lastRound = plan.rounds >= 2;
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.director,
    label: "autopilot:plan-review",
    system: directorSystemPrompt(ctx.director, ctx.language),
    user: `${request([
      `Review the concept and the chapter plan before any prose is written (review ${plan.rounds + 1}).`,
      "Approve when the plan delivers the brief and the vision with a satisfying shape; otherwise list precise changes chapter by chapter. Weigh the simulated readers by their weights: do not chase every opinion.",
      view.any ? "The author's outline (AUTHOR'S OUTLINE, in the data) binds the plan: never ask to change its chapters, their order, their titles or their events; ask only for what enriches them." : "",
      style.rule,
      lastRound ? "This is the final plan review: approve it and turn anything still imperfect into standing guidance." : "",
      ctx.director.autonomy === "full" ? "Never ask the author: decide." : "Ask the author (questionForAuthor) only for a critical choice you cannot settle from the vision and the author's rules.",
      authorRules(ctx, false),
    ])}\n\n${data([
      bookHeader(ctx),
      briefBlock(ctx),
      outlineBookSection(view),
      outlineListSection([...view.entries.values()], planFocus(plan), "AUTHOR'S OUTLINE (binding)"),
      style.block,
      design ? `STORY DESIGN:\n${design}` : "",
      `CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: true }) || "-"}`,
      listSection("CHAPTER PLAN", outlineList(plan, { around: planFocus(plan) })),
      plan.readerReactions.length
        ? `SIMULATED READERS:\n${plan.readerReactions.map((reaction) => `- ${reaction.name} (weight ${ctx.director.readerWeights[reaction.slug] ?? 1}): ${reaction.interest}/10 — ${reaction.reaction}${reaction.concerns.length ? ` Concerns: ${reaction.concerns.join("; ")}.` : ""}${reaction.wishes.length ? ` Wishes: ${reaction.wishes.join("; ")}.` : ""}`).join("\n")}`
        : "",
    ])}`,
    json: PLAN_REVIEW_TOOL,
    maxOutputTokens: outputLimit(ctx, 4000),
  });
  // Without a verdict and a score the plan is never approved by default.
  const output = requireStructuredFields(response.json, { verdict: "text", score: "score" }, "The director's plan review");
  const verdictGiven = verdictOf(output.verdict, "The director's plan review");
  const score = Math.round(normalizeScore(output.score)!);
  // The approval score is a rule of the director's profile, not only a line of the prompt.
  const withheld = verdictGiven === "approve" && score < ctx.director.approvalScore;
  const verdict = withheld ? "revise" : verdictGiven;
  const summaryText = asString(output.summary);
  const requested = asArray(output.changes).map(asRecord)
    .map((change) => ({ instruction: asString(change.instruction), chapterNumber: asInteger(change.chapterNumber, 0, 0, MAX_BOOK_CHAPTERS) }))
    .filter((change) => change.instruction);
  const changesRequested = requested.map((change) => `${change.chapterNumber ? `Chapter ${change.chapterNumber}: ` : ""}${change.instruction}`);
  const guidance = asStringList(output.guidance, 10);
  const changes: Array<BookFileChange | null> = [];
  const approved = verdict === "approve" || lastRound || changesRequested.length === 0;
  if (withheld) {
    ctx.insight("warning", withheldApproval(ctx, score, approved
      ? (isItalian(ctx.language) ? (lastRound ? "è l'ultima revisione del piano, che è approvato." : "non chiede modifiche, quindi il piano è approvato così com'è.") : (lastRound ? "this is the final plan review, so the plan is approved." : "no change is asked, so the plan is approved as it is."))
      : (isItalian(ctx.language) ? "il piano viene rivisto." : "the plan is revised.")));
  }
  if (!approved) {
    plan.rounds += 1;
    plan.revisionNotes = changesRequested;
    // Only the batches that hold the chapters the changes name are planned again; a change that names none concerns them all.
    plan.revisionBatches = batchesNamed(planRange(importedChapters(ctx.snapshot), view.lastChapter), requested.map((change) => change.chapterNumber));
    ctx.insight("warning", isItalian(ctx.language) ? `Il direttore chiede ${changesRequested.length} modifiche al piano` : `The director asks for ${changesRequested.length} plan changes`, changesRequested.slice(0, 3).join(" · "));
  } else {
    plan.approved = true;
    plan.revisionNotes = [];
    delete plan.revisionBatches;
    plan.awaitingAuthor = ctx.state.options.pauseAfterPlan || ctx.director.autonomy === "ask-always";
    ctx.state.directorNotes = mergeNotes(ctx.state.directorNotes, [...guidance, ...(lastRound ? changesRequested : [])]);
    for (const chapter of plan.chapters) if (!chapter.imported) changes.push(ensureChapterFile(ctx, chapter));
    for (const secret of ctx.state.concept.secrets) {
      const chapter = plan.chapters.find((entry) => entry.number === secret.revealChapter);
      const path = canonPath("secret", secret.slug);
      if (!chapter || !ctx.snapshot.files.has(path)) continue;
      changes.push(await changeFor(ctx, path, (existing) => {
        if (!existing || frontmatterString(existing.frontmatter, "reveal_in")) return null;
        return renderMarkdown({ ...existing.frontmatter, reveal_in: `chapter:${chapter.slug}`, known_from: `chapter:${chapter.slug}` }, existing.body);
      }));
    }
    ctx.insight("ok", isItalian(ctx.language) ? `Piano approvato dal direttore (${score}/10)` : `Plan approved by the director (${score}/10)`, summaryText);
  }
  const question = asRecord(output.questionForAuthor);
  if (ctx.director.autonomy !== "full" && asString(question.question)) {
    ctx.state.question = {
      id: `question-${ctx.now().getTime()}`,
      kind: "director",
      question: asString(question.question),
      context: summaryText,
      options: asStringList(question.options, 5),
      askedAt: ctx.now().toISOString(),
    };
  }
  changes.push(await planFileChange(ctx));
  return { changes: compact(changes), summary: `${approved ? "approve" : "revise"} ${score}/10 — ${summaryText}` };
}

// ─── The author changed the outline of a chapter not written yet ────────────

/**
 * The `chapter.md` of a chapter with no text yet, made or brought up to date with its new plan: title, summary, point of view and
 * the ghostwriter of the outline. A ghostwriter written by hand in a chapter the outline never gave one is left as it is.
 */
async function chapterStubChange(ctx: TaskContext, chapter: PlannedChapter, before: { title: string; goal: string; summary: string; ghostwriter?: string }): Promise<BookFileChange | null> {
  const path = chapterFilePath(chapter.slug);
  if (!ctx.snapshot.files.has(path)) return { path, content: chapterDocument(chapter, ctx.snapshot), expectedHash: null };
  const own = chapter.ghostwriter && chapter.ghostwriter !== bookGhostwriter(ctx.snapshot) ? chapter.ghostwriter : undefined;
  const oldBody = `# ${before.title}\n\n${before.goal || before.summary || ""}`.trim();
  return changeFor(ctx, path, (existing) => {
    const frontmatter: Record<string, unknown> = { ...(existing?.frontmatter ?? {}), title: chapter.title, summary: chapter.summary, pov: chapter.pov };
    if (own) frontmatter.ghostwriter = own;
    else if (before.ghostwriter) delete frontmatter.ghostwriter;
    const body = !existing || existing.body.trim() === oldBody ? `# ${chapter.title}\n\n${chapter.goal || chapter.summary || ""}` : existing.body;
    return renderMarkdown(frontmatter, body);
  });
}

/**
 * A chapter whose entry of the outline the author changed, or deleted, since it was planned, and of which nothing is written yet. It
 * is planned again following the new entry (its title, summary, purpose, events and ghostwriter; its scenes are planned again), or,
 * without an entry, it leaves the plan, and the book when its folder is empty. No other chapter is touched, and none is renumbered.
 */
async function runReplan(ctx: TaskContext): Promise<TaskResult> {
  const plan = ctx.state.plan!;
  const chapter = chapterOf(ctx);
  const italian = isItalian(ctx.language);
  const number = chapter.number;
  const entry = await outlineOf(ctx).chapter(number);
  const folder = ctx.snapshot.chapters.find((info) => info.slug === chapter.slug);
  const stubPath = chapterFilePath(chapter.slug);
  const stubHash = ctx.snapshot.files.get(stubPath);
  const written = Boolean(folder?.paragraphs.length);
  const changes: Array<BookFileChange | null> = [];

  if (!entry) {
    plan.chapters = plan.chapters.filter((item) => item !== chapter);
    plan.removedChapters = [...new Set([...(plan.removedChapters ?? []), number])].sort((left, right) => left - right);
    if (stubHash && !written) changes.push({ path: stubPath, content: null, expectedHash: stubHash });
    ctx.insight(
      "warning",
      italian ? `Il capitolo ${number} non è più nella Sinossi: esce dal piano` : `Chapter ${number} is no longer in the synopsis: it leaves the plan`,
      italian ? "I capitoli successivi mantengono il loro numero: rinumera la Sinossi se vuoi chiudere il vuoto." : "The following chapters keep their number: renumber the synopsis if you want to close the gap.",
      { code: "outlineRemoved", chapterNumber: number },
    );
    changes.push(await planFileChange(ctx));
    return { changes: compact(changes), summary: italian ? `Il capitolo ${number} è uscito dal piano: la sua voce della Sinossi è stata cancellata.` : `Chapter ${number} left the plan: its entry of the synopsis was deleted.` };
  }

  const [view, design, resume] = await Promise.all([authorOutline(ctx), readBody(ctx.store, STORY_DESIGN_FILE, 2500), storySoFar(ctx, number, 4000)]);
  const secretsPlan = ctx.state.concept.secrets.filter((secret) => secret.revealChapter).map((secret) => `- ${secret.title}: reveal in chapter ${secret.revealChapter}`).join("\n");
  const around = chapterLines(plan.chapters.filter((item) => item.number !== number), { around: number });
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: `autopilot:replan:${number}`,
    system: architectSystemPrompt(ctx.language),
    user: `${request([
      `The author changed the outline of chapter ${number}. Plan chapter ${number} again, numbered ${number} to ${number}, following the new entry (AUTHOR'S OUTLINE, CHAPTER ${number}): the same hypothetical title (refine it only if the entry has none) and the same events. Enrich it, never change it.`,
      "Keep it consistent with the other chapters, which do not change, and place the reveals the chapter has to hold.",
      authorRules(ctx),
    ])}\n\n${data([
      bookHeader(ctx),
      briefBlock(ctx),
      `AUTHOR'S OUTLINE, CHAPTER ${number} (the new entry, binding):\n${entryHeading(entry)}:\n${truncate(entry.body, OUTLINE_BATCH_CHARS) || "(no text)"}`,
      outlineBookSection(view),
      design ? `STORY DESIGN (excerpt):\n${design}` : "",
      `CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: true }) || "-"}`,
      secretsPlan ? `PLANNED REVEALS:\n${secretsPlan}` : "",
      around.text ? listSection("THE OTHER CHAPTERS OF THE PLAN", around) : "",
      resume ? `STORY SO FAR (before this chapter):\n${resume}` : "",
      `THE PLAN OF CHAPTER ${number} UNTIL NOW (replace it):\n${chapterPlanBlock(chapter)}`,
      `DIRECTOR (the author's taste):\n${directorTaste(ctx.director)}`,
    ])}`,
    json: PLAN_TOOL,
    maxOutputTokens: outputLimit(ctx, 3000),
    temperature: 0.7,
  });
  const output = requireStructuredFields(response.json, { chapters: "list" }, "The plan of the chapter");
  const proposal = asArray(output.chapters).map(asRecord).find((item) => asString(item.title) || asString(item.summary));
  if (!proposal) throw new AiReplyRejectedError(`The plan of chapter ${number} has no chapter: return chapter ${number} with its title, summary, goal, point of view, key events and reveals.`);
  const before = { title: chapter.title, goal: chapter.goal, summary: chapter.summary, ...(chapter.ghostwriter ? { ghostwriter: chapter.ghostwriter } : {}) };
  const title = entry.title ? clipText(entry.title, OUTLINE_TITLE_MAX_CHARS).trim() : asString(proposal.title) || chapter.title;
  const ghostwriter = outlineGhostwriter(ctx, entry);
  // A folder with somebody's text in it keeps its name; an empty one follows the new title, as a plan made again does.
  const slug = written ? chapter.slug : chapterSlug(number, title);
  if (slug !== chapter.slug && stubHash) changes.push({ path: stubPath, content: null, expectedHash: stubHash });
  Object.assign(chapter, {
    title,
    slug,
    summary: asString(proposal.summary),
    goal: asString(proposal.goal),
    pov: asStringList(proposal.pov, 6),
    keyEvents: asStringList(proposal.keyEvents, 12),
    reveals: asStringList(proposal.reveals, 8),
    status: "planned",
    scenes: [],
    outlineDigest: entry.contentDigest,
  });
  if (ghostwriter) chapter.ghostwriter = ghostwriter;
  else delete chapter.ghostwriter;
  delete chapter.skipReaders;
  changes.push(await chapterStubChange(ctx, chapter, before));
  changes.push(await planFileChange(ctx));
  ctx.insight(
    "info",
    italian ? `Hai cambiato la Sinossi del capitolo ${number}: lo ripianifico` : `You changed the synopsis of chapter ${number}: I am planning it again`,
    `${number}. ${title}${chapter.summary ? ` — ${chapter.summary}` : ""}`,
    { code: "outlineChanged", chapterNumber: number },
  );
  return { changes: compact(changes), summary: `${number}. ${title}${chapter.summary ? ` — ${truncate(chapter.summary, 240)}` : ""}` };
}

// ─── Scenes and prose ───────────────────────────────────────────────────────

async function runScenes(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const plan = ctx.state.plan!;
  const previous = plan.chapters.find((entry) => entry.number === chapter.number - 1);
  const next = plan.chapters.find((entry) => entry.number === chapter.number + 1);
  // The scenes of the chapter are the planner's: the rule reads the chapter's outline entry (or, without one, the plan of the chapter).
  const entry = await outlineOf(ctx).chapter(chapter.number);
  const target = scenesForChapter(entry?.body || [chapter.summary, chapter.goal, ...chapter.keyEvents].join("\n"));
  const [resume, design, secrets] = await Promise.all([
    storySoFar(ctx, chapter.number, 5000),
    readBody(ctx.store, STORY_DESIGN_FILE, 2500),
    secretRules(ctx.store, ctx.snapshot, chapter.number),
  ]);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: `autopilot:scenes:${chapter.number}`,
    system: architectSystemPrompt(ctx.language),
    user: `${request([
      `Break chapter ${chapter.number} «${chapter.title}» into ${target} scenes (one more or one fewer only if the chapter truly needs it).`,
      "Each scene has a goal and a turn, and leads into the next. Respect the reveal rules and the director's guidance.",
      authorRules(ctx),
    ])}\n\n${data([
      bookHeader(ctx),
      directorGuidance(ctx),
      chapterPlanBlock(chapter),
      previous ? `PREVIOUS CHAPTER: ${previous.number}. ${previous.title}${previous.summary ? ` — ${previous.summary}` : ""}` : "",
      next ? `NEXT CHAPTER (to set up): ${next.number}. ${next.title}${next.summary ? ` — ${next.summary}` : ""}` : "",
      resume ? `STORY SO FAR (before this chapter):\n${resume}` : "",
      design ? `STORY DESIGN (excerpt):\n${design}` : "",
      `CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: false }) || "-"}`,
      secrets ? `SECRETS AND REVEAL RULES:\n${secrets}` : "",
    ])}`,
    json: SCENES_TOOL,
    maxOutputTokens: outputLimit(ctx, 5000),
    temperature: 0.7,
  });
  const output = requireStructuredFields(response.json, { scenes: "list" }, "The scene plan");
  const scenes = asArray(output.scenes).map(asRecord).filter((scene) => asString(scene.title)).slice(0, SCENES_PER_CHAPTER.max);
  if (!scenes.length) throw new AiReplyRejectedError("The scene plan has no scene with a title.");
  chapter.scenes = scenes.map((scene, index) => ({
    number: index + 1,
    title: asString(scene.title),
    goal: asString(scene.goal),
    beats: asStringList(scene.beats, 12),
    pov: asString(scene.pov) || undefined,
    location: asString(scene.location) || undefined,
    characters: asStringList(scene.characters, 12),
    summary: asString(scene.summary) || undefined,
    status: "planned",
    revisions: 0,
  }));
  chapter.status = "writing";
  ctx.insight("info", isItalian(ctx.language) ? `Capitolo ${chapter.number}: ${chapter.scenes.length} scene` : `Chapter ${chapter.number}: ${chapter.scenes.length} scenes`, chapter.scenes.map((scene) => scene.title).join(" · "));
  const ghostwriter = await outlineGhostwriterArrived(ctx, chapter);
  return { changes: compact([ensureChapterFile(ctx, chapter), ghostwriter, await planFileChange(ctx)]), summary: chapter.scenes.map((scene) => `${scene.number}. ${scene.title}`).join("; ") };
}

/**
 * The ghostwriter the outline names for a chapter that is starting, when it did not exist at the time of the plan and exists now
 * (the author created it after being told): the chapter takes it, and its `chapter.md` says it. Nothing else of the plan changes.
 */
async function outlineGhostwriterArrived(ctx: TaskContext, chapter: PlannedChapter): Promise<BookFileChange | null> {
  const entry = await outlineOf(ctx).chapter(chapter.number);
  const slug = entry?.ghostwriter;
  if (!entry || entry.unreadable || !slug || slug === chapter.ghostwriter || entry.contentDigest !== chapter.outlineDigest) return null;
  if (!isValidGhostwriterSlug(slug) || !ctx.snapshot.ghostwriterSlugs.includes(slug)) return null;
  chapter.ghostwriter = slug;
  const path = chapterFilePath(chapter.slug);
  if (!ctx.snapshot.files.has(path) || slug === bookGhostwriter(ctx.snapshot)) return null;
  return changeFor(ctx, path, (existing) => (existing ? renderMarkdown({ ...existing.frontmatter, ghostwriter: slug }, existing.body) : null));
}

/** One or two sentences on what a scene does, for continuity; `null` when the summary call fails. */
async function summarizeScene(ctx: TaskContext, chapter: PlannedChapter, scene: PlannedScene, prose: string): Promise<string | null> {
  try {
    const response = await ctx.ai({
      capability: AI_CAPABILITIES.summary,
      label: `autopilot:scene-summary:${chapter.number}.${scene.number}`,
      system: continuitySystemPrompt(ctx.language),
      user: `${request(["Summarize this scene in one or two sentences: what happens and what changes."])}\n\n${data([prose])}`,
      json: SCENE_SUMMARY_TOOL,
      maxOutputTokens: outputLimit(ctx, 400),
    });
    return asString(asRecord(response.json).summary) || null;
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return null;
  }
}

async function sceneNeighbors(ctx: TaskContext, chapter: PlannedChapter, scene: PlannedScene): Promise<{ previousEnding: string; nextOpening: string; writtenSummaries: string }> {
  const previousScene = chapter.scenes.find((entry) => entry.number === scene.number - 1);
  const nextScene = chapter.scenes.find((entry) => entry.number === scene.number + 1);
  let previousEnding = "";
  if (previousScene?.path) {
    previousEnding = await readBody(ctx.store, previousScene.path, 2400, "end");
  } else if (scene.number === 1) {
    const previousChapter = ctx.state.plan?.chapters.find((entry) => entry.number === chapter.number - 1);
    const last = previousChapter?.scenes.filter((entry) => entry.path).at(-1);
    if (last?.path) previousEnding = await readBody(ctx.store, last.path, 1500, "end");
  }
  const nextOpening = nextScene?.path ? truncate(await readBody(ctx.store, nextScene.path, 100000), 900) : "";
  const writtenSummaries = chapter.scenes
    .filter((entry) => entry.number < scene.number && entry.status !== "planned")
    .map((entry) => `- Scene ${entry.number} «${entry.title}»: ${entry.summary ?? entry.goal}`)
    .join("\n");
  return { previousEnding, nextOpening, writtenSummaries };
}

async function runWrite(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const scene = sceneOf(chapter, ctx.task.sceneNumber);
  const nextScene = chapter.scenes.find((entry) => entry.number === scene.number + 1);
  const info = chapterFiles(ctx, chapter);
  const [ghostwriter, context, resume, secrets, neighbors] = await Promise.all([
    ghostwriterOf(ctx, info),
    readBody(ctx.store, CONTEXT_FILE, 2000),
    storySoFar(ctx, chapter.number, 5000),
    secretRules(ctx.store, ctx.snapshot, chapter.number),
    sceneNeighbors(ctx, chapter, scene),
  ]);
  const relevant = mentionedCanon(ctx.snapshot, [scene.beats.join(" "), scene.goal, scene.summary ?? ""].join(" "), 12, [...scene.characters, scene.location ?? "", scene.pov ?? ""]);
  const words = ctx.state.brief.wordsPerScene;
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: `autopilot:write:${chapter.number}.${scene.number}`,
    system: writerSystemPrompt(ctx.language),
    user: `${request([
      `Write scene ${scene.number} of chapter ${chapter.number} «${chapter.title}»: «${scene.title}». Target length: about ${words} words.`,
      "Follow the beats in order, start in motion, and end on a turn that leads into the next scene.",
      authorRules(ctx),
    ])}\n\n${data([
      bookHeader(ctx),
      `GHOSTWRITER PROFILE:\n${ghostwriterBlock(ghostwriter)}`,
      `DIRECTOR (the author's taste):\n${directorTaste(ctx.director)}`,
      directorGuidance(ctx),
      context ? `WORLD CONTEXT:\n${context}` : "",
      resume ? `STORY SO FAR (before this chapter):\n${resume}` : "",
      chapterPlanBlock(chapter),
      neighbors.writtenSummaries ? `SCENES ALREADY WRITTEN IN THIS CHAPTER:\n${neighbors.writtenSummaries}` : "",
      neighbors.previousEnding ? `PREVIOUS SCENE ENDING (continue seamlessly):\n${neighbors.previousEnding}` : "",
      scenePlanBlock(scene),
      nextScene ? scenePlanBlock(nextScene, "NEXT SCENE (set it up, do not write it)") : "",
      relevant.length ? `RELEVANT CANON:\n${await canonDetails(ctx.store, relevant)}` : "",
      secrets ? `SECRETS AND REVEAL RULES:\n${secrets}` : "",
    ])}`,
    maxOutputTokens: sceneOutputLimit(ctx, words),
    temperature: ghostwriter?.temperature ?? 0.8,
  });
  const prose = cleanProse(response.text);
  assertProse(prose, Math.min(150, Math.floor(words * 0.25)));
  const summary = await summarizeScene(ctx, chapter, scene, prose) ?? scene.summary ?? scene.goal;
  const slug = paragraphSlug(scene.number, scene.title);
  const path = paragraphFilePath(chapter.slug, slug);
  const content = renderMarkdown(
    { type: "paragraph", id: paragraphId(chapter.slug, slug), chapter: `chapter:${chapter.slug}`, number: scene.number, title: scene.title, summary, viewpoint: scene.pov, canon: "draft" },
    prose,
  );
  scene.status = "written";
  scene.slug = slug;
  scene.path = path;
  scene.summary = summary;
  scene.words = countWords(prose);
  if (chapter.scenes.every((entry) => entry.status !== "planned")) chapter.status = "review";
  ctx.insight("ok", isItalian(ctx.language) ? `Scena ${chapter.number}.${scene.number} scritta: ${scene.words} parole` : `Scene ${chapter.number}.${scene.number} written: ${scene.words} words`, summary);
  return {
    changes: compact([{ path, content, expectedHash: ctx.snapshot.files.get(path) ?? null }, ensureChapterFile(ctx, chapter), await planFileChange(ctx)]),
    summary: `${scene.words} words — ${summary}`,
  };
}

// ─── Chapter review ─────────────────────────────────────────────────────────

async function chapterSource(ctx: TaskContext, chapter: PlannedChapter): Promise<{ paragraphs: LoadedParagraph[]; readerText: string; sourceHash: string; sourceVersion: string }> {
  const paragraphs = await loadChapterParagraphs(ctx.store, chapterFiles(ctx, chapter));
  if (!paragraphs.length) throw new Error(`Chapter ${chapter.number} has no written scenes.`);
  const readerText = chapterReaderText(paragraphs.map((paragraph) => ({ title: paragraph.title, raw: paragraph.raw })));
  return { paragraphs, readerText, sourceHash: await sha256Hex(readerText), sourceVersion: paragraphs.map((paragraph) => paragraph.hash).join(":") };
}

async function runReader(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const review = ctx.state.review!;
  const slug = ctx.task.reader!;
  review.readersPending = review.readersPending.filter((entry) => entry !== slug);
  const reader = ctx.readerPanel.find((entry) => entry.slug === slug);
  if (!reader) return { changes: [], summary: "Reader not available." };
  const path = readerEvaluationPath({ kind: "chapter", chapter: chapter.slug }, reader.slug);
  await assertRewritable(ctx, [path]);
  const source = await chapterSource(ctx, chapter);
  const resume = await storySoFar(ctx, chapter.number, 3000);
  const asked = await readerReply(ctx, ctx.ai({
    capability: AI_CAPABILITIES.reader,
    label: `reader-evaluation:${reader.slug}`,
    system: readerPersonaSystemPrompt(reader, languageName(ctx.language), "normal"),
    user: `${currentRequest("Evaluate the target as the configured simulated reader.")}\n\n${untrustedData("repository_content", [
      `TARGET: chapter — ${chapter.title}`,
      resume ? `STORY SO FAR (before this chapter):\n${resume}` : "",
      source.readerText,
    ].filter(Boolean).join("\n\n"))}`,
    json: READER_EVALUATION_TOOL,
    maxOutputTokens: outputLimit(ctx, 2500),
  }), (reply) => normalizeReaderEvaluationOutput(requireStructuredFields(reply.json, { score: "score", generalImpression: "text" }, "The reader evaluation")));
  if ("skipped" in asked) {
    const skipped = skipReader(ctx, reader.name, asked.skipped);
    if (!review.readerScores.length && !review.readersPending.length) {
      ctx.insight("warning", isItalian(ctx.language) ? "Nessun lettore simulato ha risposto: la revisione prosegue senza." : "No simulated reader answered: the review goes on without them.");
    }
    return skipped;
  }
  const { response, value: output } = asked;
  const updatedAt = ctx.now().toISOString();
  const change = await changeFor(ctx, path, (existing) => renderMarkdown({
    ...(existing?.frontmatter ?? {}),
    id: `reader-evaluation:chapter:${chapter.slug}:chapter:${reader.slug}`,
    type: "readerEvaluation",
    createdAt: frontmatterString(existing?.frontmatter ?? {}, "createdAt") ?? updatedAt,
    updatedAt,
    targetType: "chapter",
    targetId: `chapter:${chapter.slug}`,
    bookId: ctx.bookId,
    chapterId: chapter.slug,
    readerId: reader.id,
    readerName: reader.name,
    readerType: reader.readerType,
    readerVersion: reader.version,
    language: ctx.language,
    evaluationDepth: "normal",
    sourceContentHash: source.sourceHash,
    sourceContentVersion: source.sourceVersion,
    sourceUpdatedAt: updatedAt,
    routerTask: "reader-evaluation",
    model: response.model,
    provider: response.provider,
    integrationId: response.integrationId,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    estimatedCost: response.cost,
    finalCost: response.cost,
    currency: response.currency,
    score: output.score,
    status: "completed",
    generatedBy: "autopilot",
  }, renderReaderEvaluationBody(output, ctx.language)));
  review.readerScores = [...review.readerScores.filter((entry) => entry.slug !== slug), { slug, name: reader.name, score: output.score, mainProblem: output.mainProblem, prioritySuggestion: output.prioritySuggestion, path }];
  ctx.insight(output.score >= 7 ? "ok" : output.score >= 5 ? "info" : "warning", `${reader.name}: ${output.score}/10`, output.mainProblem || output.generalImpression);
  return { changes: compact([change]), summary: `${output.score}/10 — ${truncate(output.generalImpression, 220)}` };
}

async function runReadersSummary(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const review = ctx.state.review!;
  const path = readerSummaryPath({ kind: "chapter", chapter: chapter.slug });
  await assertRewritable(ctx, [path]);
  const evaluations = await Promise.all(review.readerScores.map(async (score) => `READER: ${score.name}\nSCORE: ${score.score}\n${await readBody(ctx.store, score.path, 5000)}`));
  const source = await chapterSource(ctx, chapter);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.readerSummary,
    label: "reader-evaluation-summary",
    system: `Compare the separate simulated-reader evaluations. Preserve disagreements rather than flattening them. Return the summary in ${languageName(ctx.language)}.`,
    user: `${currentRequest("Summarize and compare these reader evaluations.")}\n\n${untrustedData("repository_content", evaluations.join("\n\n---\n\n"))}`,
    json: READER_SUMMARY_TOOL,
    maxOutputTokens: outputLimit(ctx, 2500),
  });
  const output = requireStructuredFields(response.json, { overallScore: "score" }, "The readers' summary");
  const overall = Math.round(Math.max(1, normalizeScore(output.overallScore) ?? 6) * 10) / 10;
  const updatedAt = ctx.now().toISOString();
  const change = await changeFor(ctx, path, (existing) => renderMarkdown({
    ...(existing?.frontmatter ?? {}),
    id: `reader-evaluation-summary:chapter:${chapter.slug}:chapter`,
    type: "readerEvaluationSummary",
    createdAt: frontmatterString(existing?.frontmatter ?? {}, "createdAt") ?? updatedAt,
    updatedAt,
    targetType: "chapter",
    targetId: `chapter:${chapter.slug}`,
    bookId: ctx.bookId,
    chapterId: chapter.slug,
    readerIds: review.readerScores.map((score) => ctx.readerPanel.find((reader) => reader.slug === score.slug)?.id ?? score.slug),
    readerCount: review.readerScores.length,
    language: ctx.language,
    sourceContentHash: source.sourceHash,
    sourceContentVersion: source.sourceVersion,
    routerTask: "reader-evaluation-summary",
    model: response.model,
    provider: response.provider,
    integrationId: response.integrationId,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    finalCost: response.cost,
    currency: response.currency,
    score: overall,
    status: "completed",
    refs: review.readerScores.map((score) => `reader-evaluation:chapter:${chapter.slug}:chapter:${score.slug}`),
    generatedBy: "autopilot",
  }, renderReaderSummaryBody(output, ctx.language)));
  const proposals = [...asStringList(output.revisionPriorities, 5), ...asStringList(output.recurringProblems, 3)]
    .filter((entry, index, list) => list.findIndex((other) => normalizeForMatch(other) === normalizeForMatch(entry)) === index)
    .slice(0, 6);
  const findings: ReviewFinding[] = proposals.map((problem, index) => ({
    id: `R${review.round}-${index + 1}`,
    source: "reader",
    category: "readers",
    severity: "major",
    anchored: false,
    problem,
    remediation: "",
  }));
  review.findings = [...review.findings.filter((finding) => finding.source !== "reader"), ...findings];
  review.readersSummaryDone = true;
  ctx.insight(overall >= 7 ? "ok" : overall >= 5 ? "info" : "warning", isItalian(ctx.language) ? `Lettori: ${overall}/10` : `Readers: ${overall}/10`, asStringList(output.consensus, 2).join(" · "));
  return { changes: compact([change]), summary: `${overall}/10 — ${findings.length} proposals for the director` };
}

async function runSpecialists(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const review = ctx.state.review!;
  const source = await chapterSource(ctx, chapter);
  const info = chapterFiles(ctx, chapter);
  const text = source.paragraphs.map((paragraph) => paragraph.body).join("\n");
  const [ghostwriter, secrets] = await Promise.all([ghostwriterOf(ctx, info), secretRules(ctx.store, ctx.snapshot, chapter.number)]);
  const relevant = mentionedCanon(ctx.snapshot, text, 16);
  const previousChapters = chapterLines(ctx.state.plan!.chapters.filter((entry) => entry.number < chapter.number), { around: chapter.number });
  const style = evaluationStyleOf(ctx, "specialists");
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.specialist,
    label: `autopilot:specialists:${chapter.number}`,
    system: specialistsSystemPrompt(ctx.language),
    user: `${request([
      `Review chapter ${chapter.number} «${chapter.title}» (review round ${review.round}). Return at most 12 findings, most important first, using the scene numbers of the markers.`,
      review.previousFixes.length ? `These fixes were applied after the previous round: verify them and report only remaining or new real problems.\n${bulletList(review.previousFixes)}` : "",
      style.rule,
      authorRules(ctx, false),
    ])}\n\n${data([
      bookHeader(ctx),
      `GHOSTWRITER PROFILE:\n${ghostwriterBlock(ghostwriter)}`,
      style.block,
      previousChapters.text ? listSection("PREVIOUS CHAPTERS", previousChapters) : "",
      chapterPlanBlock(chapter),
      `SCENE PLANS:\n${chapter.scenes.map((scene) => `- Scene ${scene.number} «${scene.title}»: ${scene.goal}`).join("\n")}`,
      `CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: false }) || "-"}`,
      relevant.length ? `CANON DETAILS:\n${await canonDetails(ctx.store, relevant, 600)}` : "",
      secrets ? `SECRETS AND REVEAL RULES:\n${secrets}` : "",
      `CHAPTER TEXT:\n${markedChapterText(source.paragraphs, sceneLimit(ctx, 14000))}`,
    ])}`,
    json: FINDINGS_TOOL,
    maxOutputTokens: outputLimit(ctx, 5000),
  });
  // A reply without the findings list is not "no problems": it is rejected.
  const output = requireStructuredFields(response.json, { findings: "list" }, "The specialists' review");
  const scenesByNumber = new Map(source.paragraphs.map((paragraph) => [paragraph.number, normalizeForMatch(paragraph.body)]));
  const whole = normalizeForMatch(text);
  const findings: ReviewFinding[] = asArray(output.findings).map(asRecord).slice(0, 12).map((finding, index) => {
    const sceneNumber = asInteger(finding.sceneNumber, 0, 0, 999);
    const evidence = asString(finding.evidence);
    const needle = normalizeForMatch(evidence);
    const anchored = needle.length >= 8 && ((scenesByNumber.get(sceneNumber) ?? whole).includes(needle) || whole.includes(needle));
    return {
      id: `S${review.round}-${index + 1}`,
      source: "specialist" as const,
      category: asString(finding.category) || "other",
      severity: asOneOf(finding.severity, ["critical", "major", "minor"] as const, "minor"),
      sceneNumber: sceneNumber || undefined,
      evidence: evidence || undefined,
      anchored,
      problem: asString(finding.problem),
      remediation: asString(finding.remediation),
    };
  }).filter((finding) => finding.problem);
  review.findings = [...review.findings.filter((finding) => finding.source !== "specialist"), ...findings];
  review.specialistsDone = true;
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const major = findings.filter((finding) => finding.severity === "major").length;
  for (const finding of findings.filter((entry) => entry.severity !== "minor").slice(0, 4)) {
    ctx.insight(finding.severity === "critical" ? "critical" : "warning", `${finding.category}${finding.sceneNumber ? ` · ${isItalian(ctx.language) ? "scena" : "scene"} ${finding.sceneNumber}` : ""}: ${truncate(finding.problem, 160)}`, finding.remediation);
  }
  if (!findings.length) ctx.insight("ok", isItalian(ctx.language) ? "Gli specialisti non trovano problemi" : "The specialists found no problems");
  return { changes: [], summary: `${findings.length} findings (${critical} critical, ${major} major) — ${asString(output.summary)}` };
}

function findingLine(finding: ReviewFinding): string {
  return [
    `[${finding.id}] ${finding.source}${finding.reader ? ` (${finding.reader})` : ""} · ${finding.severity} · ${finding.category}${finding.sceneNumber ? ` · scene ${finding.sceneNumber}` : ""}${finding.source === "specialist" && !finding.anchored ? " · UNANCHORED (evidence not found verbatim)" : ""}`,
    `Problem: ${finding.problem}`,
    finding.evidence ? `Evidence: «${finding.evidence}»` : "",
    finding.remediation ? `Proposed fix: ${finding.remediation}` : "",
  ].filter(Boolean).join("\n");
}

async function runDirectorReview(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const review = ctx.state.review!;
  await assertRewritable(ctx, [directorOpinionPath({ kind: "chapter", chapter: chapter.slug })]);
  const source = await chapterSource(ctx, chapter);
  const [resume, secrets, readersSummary] = await Promise.all([
    storySoFar(ctx, chapter.number, 4000),
    secretRules(ctx.store, ctx.snapshot, chapter.number),
    review.readerScores.length ? readBody(ctx.store, readerSummaryPath({ kind: "chapter", chapter: chapter.slug }), 2500) : Promise.resolve(""),
  ]);
  const maxRounds = ctx.director.maxReviewRounds;
  const last = review.round >= maxRounds;
  const perScene = sceneLimit(ctx, Math.max(3000, Math.floor(60000 / Math.max(1, source.paragraphs.length))));
  const style = evaluationStyleOf(ctx, "chapter");
  const authorNote = review.authorEdit ? startedReview(ctx.state)?.note : undefined;
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.director,
    label: `autopilot:director-review:${chapter.number}`,
    system: directorSystemPrompt(ctx.director, ctx.language),
    user: `${request([
      `Decide on chapter ${chapter.number} «${chapter.title}» (review round ${review.round} of ${maxRounds}).`,
      "For EVERY finding decide exactly once: accept it with a precise, minimal remediation for the ghostwriter and its scene number, or reject it with the reason. Reject unfounded or unanchored findings, findings against the vision or the author's rules, and single-reader taste the intended audience would not share.",
      `Score the chapter from 1 to 10. Verdict "approve" when it deserves at least ${ctx.director.approvalScore}/10 and nothing critical remains; otherwise "revise".`,
      style.rule,
      review.authorEdit
        ? "The author changed this chapter after it was approved: judge the chapter as it is now. The author's text stays as it is: no fix will be applied and there is no other round, so your accepted fixes are advice for the author."
        : last ? "This is the LAST review round: accepted fixes will be applied and the chapter closed without another review, so accept only what really matters." : "",
      authorNote ? `The author's note on the change: «${authorNote}»` : "",
      "Add standing guidance for the next chapters when this chapter taught you something.",
      ctx.director.autonomy === "full" ? "Never ask the author: decide." : "Ask the author (questionForAuthor) only for a critical matter you must not settle alone.",
      authorRules(ctx, false),
    ])}\n\n${data([
      bookHeader(ctx),
      directorGuidance(ctx),
      style.block,
      chapterPlanBlock(chapter),
      `SCENE PLANS:\n${chapter.scenes.map((scene) => `- Scene ${scene.number} «${scene.title}»: ${scene.goal}`).join("\n")}`,
      resume ? `STORY SO FAR (before this chapter):\n${resume}` : "",
      secrets ? `SECRETS AND REVEAL RULES:\n${secrets}` : "",
      review.readerScores.length
        ? `SIMULATED READERS:\n${review.readerScores.map((score) => `- ${score.name} (weight ${ctx.director.readerWeights[score.slug] ?? 1}): ${score.score}/10. Main problem: ${score.mainProblem}. Priority: ${score.prioritySuggestion}`).join("\n")}`
        : "",
      readersSummary ? `READERS PANEL SUMMARY:\n${readersSummary}` : "",
      review.previousFixes.length ? `FIXES APPLIED AFTER THE PREVIOUS ROUND:\n${bulletList(review.previousFixes)}` : "",
      `FINDINGS TO DECIDE:\n${review.findings.length ? review.findings.map(findingLine).join("\n\n") : "None."}`,
      `CHAPTER TEXT:\n${markedChapterText(source.paragraphs, perScene)}`,
    ])}`,
    json: CHAPTER_REVIEW_TOOL,
    maxOutputTokens: outputLimit(ctx, 6000),
  });
  const subject = "The director's chapter review";
  const output = requireStructuredFields(response.json, { verdict: "text", score: "score" }, subject);
  const italian = isItalian(ctx.language);
  const rawDecisions = asArray(output.decisions).map(asRecord);
  const findingIds = review.findings.map((finding) => finding.id);
  // Findings without decisions must never turn into a silent "all rejected, approved".
  if (findingIds.length && !rawDecisions.length) {
    throw new AiReplyRejectedError(`${subject} was rejected: the field "decisions" is missing or empty, but ${findingIds.length} findings need a decision (${findingIds.slice(0, 12).join(", ")}).`);
  }
  const idKey = (value: unknown) => asString(value).replace(/^\[|\]$/g, "").trim().toUpperCase();
  const byId = new Map(rawDecisions.map((decision) => [idKey(decision.findingId), decision]));
  if (findingIds.length && !findingIds.some((id) => byId.has(idKey(id)))) {
    throw new AiReplyRejectedError(`${subject} was rejected: no decision refers to a finding id. Use the ids ${findingIds.slice(0, 12).join(", ")}.`);
  }
  const verdictGiven = verdictOf(output.verdict, subject);
  const writtenScenes = new Set(chapter.scenes.filter((scene) => scene.status !== "planned").map((scene) => scene.number));
  const undecided: string[] = [];
  const unusable: string[] = [];
  const decisions: ReviewDecision[] = review.findings.map((finding) => {
    const decision = byId.get(idKey(finding.id));
    if (!decision) undecided.push(finding.id);
    const action = decision ? asOneOf(decision.action, ["accept", "reject"] as const, "reject") : "reject";
    const remediation = asString(decision?.remediation) || (action === "accept" ? finding.remediation : "");
    const sceneNumber = asInteger(decision?.sceneNumber, 0, 0, 999) || finding.sceneNumber;
    const applicable = action === "accept" && Boolean(remediation) && Boolean(sceneNumber) && writtenScenes.has(sceneNumber!);
    if (action === "accept" && !applicable) unusable.push(finding.id);
    return {
      findingId: finding.id,
      action: applicable ? "accept" : "reject",
      rationale: asString(decision?.rationale)
        || (!decision ? "No decision from the director: rejected by default." : action === "accept" && !applicable ? "Accepted without an applicable fix (remediation or written scene missing): not applied." : ""),
      remediation,
      sceneNumber: sceneNumber || undefined,
    };
  });
  asArray(output.extraFixes).map(asRecord).slice(0, 5).forEach((fix, index) => {
    const sceneNumber = asInteger(fix.sceneNumber, 0, 0, 999);
    const remediation = asString(fix.remediation);
    if (!remediation || !writtenScenes.has(sceneNumber)) return;
    decisions.push({ findingId: `D${review.round}-${index + 1}`, action: "accept", rationale: asString(fix.rationale), remediation, sceneNumber });
  });
  const accepted = decisions.filter((decision) => decision.action === "accept");
  const rejected = decisions.filter((decision) => decision.action === "reject");
  const score = Math.round(normalizeScore(output.score)! * 10) / 10;
  let verdict = verdictGiven;
  // The approval score is a rule of the director's profile, not only a line of the prompt.
  const withheld = verdict === "approve" && score < ctx.director.approvalScore;
  if (withheld) verdict = "revise";
  let withheldNote = withheld ? withheldApprovalNote(score, ctx.director.approvalScore, ctx.language) : "";
  if (verdict === "revise" && !accepted.length) {
    verdict = "approve";
    if (withheld) {
      withheldNote = withheldApproval(ctx, score, italian ? "non c'è alcuna correzione applicabile, quindi il capitolo è approvato così com'è." : "no fix could be applied, so the chapter is approved as it is.");
      ctx.insight("warning", withheldNote);
    } else {
      ctx.insight("warning", italian
        ? "Il direttore chiede una revisione senza correzioni applicabili: il capitolo è approvato così com'è."
        : "The director asked for a revision without any applicable fix: the chapter is approved as it is.");
    }
  } else if (withheld) {
    ctx.insight("warning", withheldApproval(ctx, score, italian ? "il capitolo è trattato come da rivedere." : "the chapter is treated as a revision."));
  }
  if (undecided.length) {
    ctx.insight("warning", italian ? `Rilievi senza decisione del direttore, respinti: ${undecided.join(", ")}` : `Findings the director did not decide, rejected: ${undecided.join(", ")}`);
  }
  if (unusable.length) {
    ctx.insight("warning", italian
      ? `Correzioni accettate ma non applicabili (manca la correzione o la scena scritta), respinte: ${unusable.join(", ")}`
      : `Fixes accepted without an applicable remediation or written scene, rejected: ${unusable.join(", ")}`);
  }
  const summaryText = asString(output.summary);
  review.decisions = decisions;
  review.directorDone = true;
  review.verdict = verdict;
  review.score = score;
  review.summary = summaryText;
  // The fixes of a review of the author's change are advice: the author's text is never rewritten for them.
  review.repairQueue = review.authorEdit ? [] : [...new Set(accepted.map((decision) => decision.sceneNumber!))].sort((left, right) => left - right);
  // The readers read the chapter once, in the first round of its review: their average is in the record of that round and of no other. The verdict is the one the plan acts on.
  recordChapterRound(chapter, closedRound({ director: score, readers: review.history.length === 0 ? review.readerScores.map((entry) => entry.score) : undefined, verdict, accepted: accepted.length, rejected: rejected.length }));
  review.history = [...review.history, { round: review.round, verdict, score, accepted: accepted.length, rejected: rejected.length }];
  ctx.state.directorNotes = mergeNotes(ctx.state.directorNotes, asStringList(output.guidance, 6));
  const question = asRecord(output.questionForAuthor);
  if (ctx.director.autonomy !== "full" && asString(question.question)) {
    ctx.state.question = {
      id: `question-${ctx.now().getTime()}`,
      kind: "director",
      question: asString(question.question),
      context: summaryText,
      options: asStringList(question.options, 5),
      chapterNumber: chapter.number,
      askedAt: ctx.now().toISOString(),
    };
  }
  const findingFor = (decision: ReviewDecision) => review.findings.find((finding) => finding.id === decision.findingId);
  const opinion: DirectorOpinion = {
    target: { kind: "chapter", chapter: chapter.slug },
    targetTitle: `${chapter.number}. ${chapter.title}`,
    verdict,
    score,
    summary: summaryText,
    strengths: asStringList(output.strengths, 8),
    concerns: accepted.map((decision) => {
      const finding = findingFor(decision);
      return {
        severity: finding?.severity ?? "major",
        issue: finding?.problem ?? decision.rationale,
        ...(finding?.evidence ? { evidence: finding.evidence } : {}),
        suggestion: `${decision.sceneNumber ? `${italian ? "Scena" : "Scene"} ${decision.sceneNumber}: ` : ""}${decision.remediation}`,
      };
    }),
    decisions: [...(withheldNote ? [withheldNote] : []), ...decisions.map((decision) => `${decision.action === "accept" ? (italian ? "Accettato" : "Accepted") : (italian ? "Respinto" : "Rejected")} ${decision.findingId}: ${decision.rationale || decision.remediation}`)],
    nextSteps: asStringList(output.guidance, 6),
    questionsForAuthor: asString(question.question) ? [asString(question.question)] : [],
    createdAt: ctx.now().toISOString(),
    source: "autopilot",
    directorName: ctx.director.name,
    model: response.model,
    provider: response.provider,
    usage: response.usage,
    cost: response.cost,
    currency: response.currency,
    sourceHash: source.sourceHash,
  };
  const opinionPath = directorOpinionPath({ kind: "chapter", chapter: chapter.slug });
  const opinionChange = await changeFor(ctx, opinionPath, () => renderDirectorOpinion(opinion, ctx.language));
  ctx.insight(verdict === "approve" ? "ok" : "warning", italian
    ? `Il direttore: ${verdict === "approve" ? "approvato" : "da rivedere"} (${score}/10), ${accepted.length} correzioni accettate, ${rejected.length} respinte`
    : `Director: ${verdict === "approve" ? "approved" : "revise"} (${score}/10), ${accepted.length} fixes accepted, ${rejected.length} rejected`, summaryText);
  for (const decision of accepted.slice(0, 4)) ctx.insight("info", `${italian ? "Correzione" : "Fix"} ${italian ? "scena" : "scene"} ${decision.sceneNumber}: ${truncate(decision.remediation, 160)}`, decision.rationale);
  return { changes: compact([opinionChange]), summary: `${verdict} ${score}/10 — ${accepted.length} accepted, ${rejected.length} rejected. ${summaryText}` };
}

/** The scene's file is gone (the author deleted it): there is nothing to rewrite, so the step is passed over and says so. */
function sceneGone(ctx: TaskContext, chapter: PlannedChapter, scene: PlannedScene): TaskResult {
  const path = sceneFile(chapter, scene);
  ctx.insight("warning", isItalian(ctx.language) ? `La scena ${chapter.number}.${scene.number} non esiste più (${path}): la riscrittura viene saltata` : `Scene ${chapter.number}.${scene.number} no longer exists (${path}): its rewrite is skipped`, isItalian(ctx.language) ? "Non c'è più nulla da riscrivere: l'autopilot prosegue." : "There is nothing left to rewrite there: the autopilot goes on.");
  return { changes: [], summary: `Skipped: ${path} no longer exists.` };
}

async function rewriteScene(ctx: TaskContext, chapter: PlannedChapter, scene: PlannedScene, instructions: string[], mode: "repair" | "revise"): Promise<{ change: BookFileChange; words: number; summary: string | null } | null> {
  const loaded = scene.path ? await readDocument(ctx.store, scene.path) : null;
  if (!scene.path || !loaded) return null;
  // The scene is rewritten with the keys it has now: if they cannot be read the file is refused, before the model is asked.
  assertFrontmatterReadable(scene.path, loaded.document, ctx.language);
  const info = chapterFiles(ctx, chapter);
  const [ghostwriter, secrets, neighbors] = await Promise.all([
    ghostwriterOf(ctx, info),
    secretRules(ctx.store, ctx.snapshot, chapter.number),
    sceneNeighbors(ctx, chapter, scene),
  ]);
  const originalWords = countWords(loaded.document.body);
  const relevant = mentionedCanon(ctx.snapshot, loaded.document.body, 10, [...scene.characters, scene.location ?? "", scene.pov ?? ""]);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: `autopilot:${mode}:${chapter.number}.${scene.number}`,
    system: writerSystemPrompt(ctx.language),
    user: `${request([
      mode === "repair"
        ? `Revise scene ${scene.number} of chapter ${chapter.number} «${scene.title}» applying ONLY these fixes approved by the director:`
        : `Rewrite scene ${scene.number} of chapter ${chapter.number} «${scene.title}» to honor the author's revision:`,
      instructions.map((instruction, index) => `${index + 1}. ${instruction}`).join("\n"),
      "Keep everything else as it is: events, facts, voice, rhythm, secrets and approximate length, unless an instruction requires otherwise. Return the complete revised scene.",
      authorRules(ctx),
    ])}\n\n${data([
      bookHeader(ctx),
      `GHOSTWRITER PROFILE:\n${ghostwriterBlock(ghostwriter)}`,
      directorGuidance(ctx),
      scenePlanBlock(scene),
      relevant.length ? `RELEVANT CANON:\n${await canonDetails(ctx.store, relevant)}` : "",
      secrets ? `SECRETS AND REVEAL RULES:\n${secrets}` : "",
      neighbors.previousEnding ? `PREVIOUS SCENE ENDING:\n${neighbors.previousEnding}` : "",
      neighbors.nextOpening ? `NEXT SCENE OPENING (keep it consistent):\n${neighbors.nextOpening}` : "",
      `CURRENT SCENE:\n${loaded.document.body}`,
    ])}`,
    maxOutputTokens: sceneOutputLimit(ctx, Math.max(originalWords, 300)),
    temperature: Math.min(0.7, ghostwriter?.temperature ?? 0.7),
  });
  const prose = cleanProse(response.text);
  assertProse(prose, Math.max(60, Math.floor(originalWords * 0.5)));
  // The summary must describe the scene as it is now: later chapters and reviews rely on it.
  const summary = await summarizeScene(ctx, chapter, scene, prose);
  const frontmatter = summary ? { ...loaded.document.frontmatter, summary } : loaded.document.frontmatter;
  return {
    change: { path: scene.path, content: renderMarkdown(frontmatter, prose), expectedHash: loaded.file.hash },
    words: countWords(prose),
    summary,
  };
}

async function runRepair(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const scene = sceneOf(chapter, ctx.task.sceneNumber);
  const review = ctx.state.review!;
  const instructions = review.decisions.filter((decision) => decision.action === "accept" && decision.sceneNumber === scene.number).map((decision) => decision.remediation);
  review.repairQueue = review.repairQueue.filter((number) => number !== scene.number);
  if (!instructions.length) return { changes: [], summary: "No fix to apply." };
  const rewritten = await rewriteScene(ctx, chapter, scene, instructions, "repair");
  if (!rewritten) return sceneGone(ctx, chapter, scene);
  const { change, words, summary } = rewritten;
  scene.revisions += 1;
  scene.words = words;
  if (summary) scene.summary = summary;
  ctx.insight("ok", isItalian(ctx.language) ? `Scena ${chapter.number}.${scene.number} corretta (${instructions.length})` : `Scene ${chapter.number}.${scene.number} revised (${instructions.length})`, instructions.join(" · "));
  return { changes: [change], summary: `${instructions.length} fixes applied, ${words} words.` };
}

async function runConsolidate(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const plan = ctx.state.plan!;
  const review = ctx.state.review;
  await assertRewritable(ctx, [chapterFilePath(chapter.slug), chapterResumePath(chapter.slug), TOTAL_RESUME_FILE, PLOT_FILE]);
  const source = await chapterSource(ctx, chapter);
  // Built from the chapters before this one only: never from a resume that already covers this chapter or later ones.
  const resume = await storySoFar(ctx, chapter.number, 7000);
  const firstChapter = !plan.chapters.some((entry) => entry.number < chapter.number);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: `autopilot:consolidate:${chapter.number}`,
    system: continuitySystemPrompt(ctx.language),
    user: `${request([
      `Close chapter ${chapter.number} «${chapter.title}»: write its summary, its recap (one bullet per scene, in order), the continuity delta, and the updated story so far including this chapter.`,
      `Keep the story so far under ${STORY_SO_FAR_TARGET_WORDS} words (hard limit: ${STORY_SO_FAR_MAX_WORDS}): compress the oldest chapters and keep the most recent ones more detailed.`,
    ])}\n\n${data([
      bookHeader(ctx),
      chapterPlanBlock(chapter),
      resume
        ? `STORY SO FAR (before this chapter):\n${resume}`
        : firstChapter ? "STORY SO FAR: this is the first chapter." : "STORY SO FAR (before this chapter): not available.",
      `CHAPTER TEXT:\n${markedChapterText(source.paragraphs, sceneLimit(ctx, 9000))}`,
    ])}`,
    json: CONSOLIDATION_TOOL,
    maxOutputTokens: outputLimit(ctx, 5000),
    temperature: 0.3,
  });
  const subject = "The chapter consolidation";
  const output = requireStructuredFields(response.json, { summary: "text", storySoFar: "text" }, subject);
  const summary = asString(output.summary);
  const recap = asString(output.recap) || summary;
  const storySoFarText = asString(output.storySoFar);
  const excess = storySoFarExcess(storySoFarText);
  if (excess) {
    throw new AiReplyRejectedError(`${subject} was rejected: "storySoFar" is ${excess.words} words long, ${excess.over} words over the ${STORY_SO_FAR_MAX_WORDS}-word limit. Rewrite it under ${STORY_SO_FAR_TARGET_WORDS} words.`);
  }
  const stateChanges = asRecord(output.stateChanges);
  const changes: Array<BookFileChange | null> = [];
  // The director approved it: the chapter is frozen as it was read for this closing, in the same commit. One the author wrote is frozen
  // only when the author froze it (it is closed again after a change was reviewed); who froze it does not change.
  const folder = ctx.snapshot.chapters.find((entry) => entry.slug === chapter.slug);
  const freezeBy = !chapter.imported ? (folder?.frozen?.by ?? "autopilot") : folder?.frozen?.by;
  const prefix = `chapters/${chapter.slug}/`;
  const scenes = source.paragraphs.map((paragraph) => ({ name: paragraph.path.startsWith(prefix) ? paragraph.path.slice(prefix.length) : paragraph.path.split("/").pop()!, body: paragraph.body }));
  const record = (body: string): { frozen: ChapterFreeze } | Record<string, never> => (freezeBy ? { frozen: chapterFreezeRecord({ at: ctx.now().toISOString(), by: freezeBy, chapterBody: body, scenes }) } : {});
  changes.push(await changeFor(ctx, chapterFilePath(chapter.slug), (existing) => existing
    ? renderMarkdown({ ...existing.frontmatter, summary, ...record(existing.body) }, existing.body)
    : renderMarkdown({ type: "chapter", id: `chapter:${chapter.slug}`, number: chapter.number, title: chapter.title, summary, canon: "draft", ...record(`# ${chapter.title}`) }, `# ${chapter.title}`)));
  changes.push(await changeFor(ctx, chapterResumePath(chapter.slug), (existing) => renderMarkdown({
    ...(existing?.frontmatter ?? {}),
    type: "resume",
    id: `resume:chapter:${chapter.slug}`,
    title: `Resume ${chapter.slug}`,
    chapter: `chapter:${chapter.slug}`,
    state_changes: Object.keys(stateChanges).length ? stateChanges : undefined,
  }, `# Chapter Summary\n\n${recap}`)));
  // One section per chapter, like Narrarium core: closing this chapter replaces only its own section.
  changes.push(await changeFor(ctx, TOTAL_RESUME_FILE, (existing) => renderMarkdown(
    { ...(existing?.frontmatter ?? {}), type: "resume", id: "resume:total", title: "Total Resume" },
    renderTotalResumeBody(existing?.body ?? "", plan.chapters, { number: chapter.number, title: chapter.title, summary }),
  )));
  chapter.summary = summary;
  chapter.status = "done";
  chapter.score = review?.score;
  chapter.skipReaders = undefined;
  chapter.storySoFarAtClose = storySoFarText;
  // Synopses saved by later chapters include the previous version of this one: they no longer apply.
  for (const later of plan.chapters) if (later.number > chapter.number) later.storySoFarAtClose = undefined;
  pruneStorySnapshots(plan.chapters);
  for (const scene of chapter.scenes) if (scene.status === "written") scene.status = "reviewed";
  ctx.state.review = null;
  changes.push(await renderPlot(ctx));
  changes.push(await planFileChange(ctx));
  ctx.insight("ok", isItalian(ctx.language) ? `Capitolo ${chapter.number} approvato${review?.score ? ` (${review.score}/10)` : ""}` : `Chapter ${chapter.number} approved${review?.score ? ` (${review.score}/10)` : ""}`, summary);
  return { changes: compact(changes), summary };
}

// ─── Author revision and final review ───────────────────────────────────────

interface WrittenChapter {
  number: number;
  chapter: PlannedChapter;
  /** The scenes of the chapter that are written. */
  scenes: PlannedScene[];
}

const WRITTEN_SCENES: ChapterFormat<WrittenChapter> = {
  render(entry, detail) {
    if (detail === "full") return entry.scenes.map((scene) => `- Chapter ${entry.number}, scene ${scene.number} «${scene.title}»: ${scene.summary ?? scene.goal}`).join("\n");
    return `- Chapter ${entry.number} «${entry.chapter.title}» (${entry.scenes.length} written scenes)${detail === "summary" && entry.chapter.summary ? `: ${entry.chapter.summary}` : ""}`;
  },
  collapse(entries, titles) {
    const range = `Chapters ${entries[0].number}-${entries[entries.length - 1].number}`;
    return titles ? `- ${range}: ${entries.map((entry) => entry.chapter.title).join("; ")}` : `- ${range} (${entries.reduce((sum, entry) => sum + entry.scenes.length, 0)} written scenes)`;
  },
};

/** The number of the chapter an instruction names in the other scripts: "главе 12", "κεφάλαιο 12", "第12章", "제12장", "الفصل 12", "פרק 12", "अध्याय 12", "บทที่ 12". */
const OTHER_CHAPTER_MENTIONS = [
  /(?<![\p{L}\p{N}_])(?:глав(?:а|ы|е|у|ой|ам|ами|ах)?|розділ(?:у|і|и|ів)?)\s*(\d{1,6})(?![\p{L}\p{N}_])/iu,
  /(?<![\p{L}\p{N}_])κεφ[αά]λα[ιί](?:ο|ου|α|ων)\s*(\d{1,6})(?![\p{L}\p{N}_])/iu,
  /[第제]\s*(\d{1,6})\s*[章장]|(?<![\p{N}])(\d{1,6})\s*[章장]/u,
  /(?<![\p{L}\p{N}_])[وبلف]?(?:ال)?فصل\s*(\d{1,6})(?![\p{L}\p{N}_])/u,
  /(?<![\p{L}\p{N}_])[בלה]?פרק\s*(\d{1,6})(?![\p{L}\p{N}_])/u,
  /(?<![\p{L}\p{N}_])अध्याय\s*(\d{1,6})(?![\p{L}\p{N}_])/u,
  /บทที่\s*(\d{1,6})/u,
];

function otherChapterMention(instruction: string): string | undefined {
  const text = instruction.normalize("NFC");
  for (const pattern of OTHER_CHAPTER_MENTIONS) {
    const found = pattern.exec(text)?.slice(1).find(Boolean);
    if (found) return found;
  }
  return undefined;
}

/** The chapter a revision is about: its first target once known, else a chapter the author names, else the latest written one. */
function revisionFocus(revision: RevisionRequest, written: WrittenChapter[]): number | undefined {
  const target = revision.targets?.[0]?.chapterNumber;
  if (target) return target;
  const named = /\b(?:chapters?|capitol[oi]|cap\.)\s*(\d{1,6})\b/i.exec(revision.instruction)?.[1] ?? otherChapterMention(revision.instruction);
  return named ? Number(named) : written.at(-1)?.number;
}

/** What the autopilot knew of a chapter, for the analysis of the impact of a change of it. */
function chapterViewBlock(view: FrozenChapterView | undefined): string {
  if (!view) return "Not known.";
  return [
    `Title: ${view.title}`,
    view.summary ? `Summary: ${view.summary}` : "Summary: none.",
    view.keyEvents.length ? `Key events:\n${bulletList(view.keyEvents)}` : "",
    view.storySoFar ? `Story so far at its close:\n${view.storySoFar}` : "",
  ].filter(Boolean).join("\n");
}

/** The request of the impact of a revision that comes from a change (of a frozen chapter, or of the outline of a written one), and its data. */
async function sourceImpactPrompt(ctx: TaskContext, revision: RevisionRequest, scenesList: ReturnType<typeof layoutChapters>): Promise<{ lines: string[]; sections: string[] } | null> {
  const source = revision.source;
  if (!source) return null;
  const number = source.chapterNumber;
  const chapter = ctx.state.plan?.chapters.find((entry) => entry.number === number);
  const title = quotedTitle(chapter?.title);
  const extra = revision.instruction.split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
  const notes = [
    source.note ? `The author's note on the change: «${source.note}»` : "",
    extra.length ? `The author also asked: «${extra.join(" ")}»` : "",
  ];
  const listed = scenesList.note ? "Some chapters are listed without their scenes: a scene of such a chapter can still be chosen by its chapter and scene number." : "";
  if (revision.onlyChapter === number) {
    const entry = await outlineOf(ctx).chapter(number);
    return {
      lines: [
        `The author changed the outline entry of chapter ${number}${title}, which is already written. Decide which written scenes of chapter ${number} must be rewritten so that the chapter follows the new entry (AUTHOR'S OUTLINE, CHAPTER ${number}, in the data), in reading order, with a precise instruction for each.`,
        "Choose the minimum set: keep what already follows the entry. Only the scenes of this chapter can be chosen.",
        ...notes,
        listed,
      ],
      sections: [
        entry ? `AUTHOR'S OUTLINE, CHAPTER ${number} (the new entry, binding):\n${entryHeading(entry)}:\n${truncate(entry.body, OUTLINE_BATCH_CHARS) || "(no text)"}` : "",
        source.before ? `THE PLAN OF CHAPTER ${number} UNTIL NOW:\n${chapterViewBlock(source.before)}` : "",
        listSection(`WRITTEN SCENES OF CHAPTER ${number}`, scenesList),
      ],
    };
  }
  const changed = source.kind === "frozen"
    ? `The author changed chapter ${number}${title} after it was approved. The author's text stands: chapter ${number} is never rewritten.`
    : `Chapter ${number}${title} was rewritten to follow the author's new outline entry. It stands as it is now: it is never rewritten here.`;
  return {
    lines: [
      changed,
      `Compare what the book knew of chapter ${number} BEFORE the change with what it is AFTER it, and decide which written scenes of the LATER chapters must change to stay consistent with it, in reading order, with a precise instruction for each. Choose the minimum set; when nothing later depends on the change, return no target.`,
      ...notes,
      listed,
    ],
    sections: [
      `CHAPTER ${number} BEFORE THE CHANGE (what the book knew of it when it was frozen):\n${chapterViewBlock(source.before)}`,
      `CHAPTER ${number} AFTER THE CHANGE (its new closing):\n${chapterViewBlock(source.after)}`,
      listSection("WRITTEN SCENES OF THE LATER CHAPTERS", scenesList),
    ],
  };
}

function quotedTitle(title: string | undefined): string {
  return title ? ` «${title}»` : "";
}

async function runImpact(ctx: TaskContext): Promise<TaskResult> {
  const revision = ctx.state.revision!;
  const plan = ctx.state.plan;
  // A revision that comes from a change looks only where the change can reach: the later chapters, or the chapter rewritten to follow its
  // outline; one the autopilot decided by itself never rewrites a chapter the author wrote; and none rewrites a chapter whose own change of
  // the author's waits (its text is the author's until the author has decided about it).
  const authorEdited = revision.source ? new Set(frozenChanges(ctx.snapshot).map((change) => change.slug)) : new Set<string>();
  const reachable = (chapter: PlannedChapter) => (revision.afterChapter === undefined || chapter.number > revision.afterChapter)
    && (revision.onlyChapter === undefined || chapter.number === revision.onlyChapter)
    && !(revision.source?.auto && chapter.imported)
    && (revision.onlyChapter === chapter.number || !authorEdited.has(chapter.slug));
  const written: WrittenChapter[] = (plan?.chapters ?? []).filter(reachable).flatMap((chapter) => {
    const scenes = chapter.scenes.filter((scene) => scene.status !== "planned" && scene.path);
    return scenes.length ? [{ number: chapter.number, chapter, scenes }] : [];
  });
  if (!written.length) {
    revision.targets = [];
    return { changes: [], summary: revision.source ? "No written scene the change can reach." : "Nothing written yet: the instruction becomes a permanent rule." };
  }
  const design = await readBody(ctx.store, STORY_DESIGN_FILE, 3000);
  const focus = revision.afterChapter !== undefined ? written[0]?.number : revisionFocus(revision, written);
  const scenesList = layoutChapters(written, WRITTEN_SCENES, { around: focus });
  const fromChange = await sourceImpactPrompt(ctx, revision, scenesList);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.director,
    label: "autopilot:impact",
    system: directorSystemPrompt(ctx.director, ctx.language),
    user: fromChange
      ? `${request(fromChange.lines)}\n\n${data([bookHeader(ctx), design ? `STORY DESIGN:\n${design}` : "", ...fromChange.sections])}`
      : `${request([
        `The author asked to revise what is already written: «${revision.instruction}».`,
        "Decide which written scenes must change to honor it, in reading order, with a precise instruction for each. Choose the minimum set; include later scenes only when they depend on the change.",
        scenesList.note ? "Some chapters are listed without their scenes: a scene of such a chapter can still be chosen by its chapter and scene number." : "",
      ])}\n\n${data([
        bookHeader(ctx),
        design ? `STORY DESIGN:\n${design}` : "",
        listSection("WRITTEN SCENES", scenesList),
      ])}`,
    json: IMPACT_TOOL,
    maxOutputTokens: outputLimit(ctx, 3000),
  });
  const subject = "The revision impact";
  // Without the targets list the author's revision would be silently ignored.
  const output = requireStructuredFields(response.json, { targets: "list" }, subject);
  const proposedTargets = asArray(output.targets).map(asRecord);
  const valid = new Set(written.flatMap((entry) => entry.scenes.map((scene) => `${entry.number}:${scene.number}`)));
  revision.targets = proposedTargets
    .map((target) => ({ chapterNumber: asInteger(target.chapterNumber, 0, 0, MAX_BOOK_CHAPTERS), sceneNumber: asInteger(target.sceneNumber, 0, 0, 999), instruction: asString(target.instruction) || revision.instruction }))
    .filter((target, index, list) => valid.has(`${target.chapterNumber}:${target.sceneNumber}`) && list.findIndex((other) => other.chapterNumber === target.chapterNumber && other.sceneNumber === target.sceneNumber) === index)
    .sort((left, right) => left.chapterNumber - right.chapterNumber || left.sceneNumber - right.sceneNumber)
    .slice(0, 40);
  if (proposedTargets.length && !revision.targets.length) {
    throw new AiReplyRejectedError(`${subject} was rejected: none of its ${proposedTargets.length} targets is a written scene. Use the chapter and scene numbers of the WRITTEN SCENES list.`);
  }
  revision.cursor = 0;
  ctx.insight(revision.targets.length ? "warning" : "info", isItalian(ctx.language) ? `${revision.targets.length} scene da riscrivere` : `${revision.targets.length} scenes to rewrite`, asString(output.summary));
  return { changes: [], summary: `${revision.targets.length} scenes — ${asString(output.summary)}` };
}

async function runRevise(ctx: TaskContext): Promise<TaskResult> {
  const revision = ctx.state.revision!;
  const target = revision.targets![revision.cursor];
  const chapter = chapterOf(ctx);
  const scene = sceneOf(chapter, ctx.task.sceneNumber);
  const rewritten = await rewriteScene(ctx, chapter, scene, [target.instruction], "revise");
  if (!rewritten) {
    revision.cursor += 1;
    return sceneGone(ctx, chapter, scene);
  }
  const { change, words, summary } = rewritten;
  scene.revisions += 1;
  scene.words = words;
  if (summary) scene.summary = summary;
  revision.cursor += 1;
  ctx.insight("ok", isItalian(ctx.language) ? `Scena ${chapter.number}.${scene.number} riscritta` : `Scene ${chapter.number}.${scene.number} rewritten`, target.instruction);
  return { changes: [change], summary: `${words} words — ${target.instruction}` };
}

async function runFinal(ctx: TaskContext): Promise<TaskResult> {
  await assertRewritable(ctx, [directorOpinionPath({ kind: "book" })]);
  const result = await askDirector({
    store: ctx.store,
    ai: { complete: (aiRequest) => ctx.ai(aiRequest) },
    target: { kind: "book" },
    snapshot: ctx.snapshot,
    signal: ctx.signal,
    now: ctx.now,
    source: "autopilot",
    instruction: "Every chapter has been approved: judge the arcs, the promises made to the reader, the open threads and the ending, and list what the author should still consider.",
    ...(ctx.evaluationStyle ? { evaluationStyle: ctx.evaluationStyle } : {}),
  });
  ctx.state.finalDone = true;
  const finalReview = normalizeFinalReview({ verdict: result.opinion.verdict === "approve" ? "approve" : "revise", score: result.opinion.score, text: result.opinion.summary, at: result.opinion.createdAt });
  if (finalReview) ctx.state.finalReview = finalReview;
  else delete ctx.state.finalReview;
  const change = await changeFor(ctx, result.path, () => renderDirectorOpinion(result.opinion, ctx.language));
  ctx.insight(result.opinion.verdict === "approve" ? "ok" : "warning", isItalian(ctx.language) ? `Giudizio finale del direttore: ${result.opinion.score}/10` : `Director's final judgement: ${result.opinion.score}/10`, result.opinion.summary);
  return { changes: compact([change]), summary: `${result.opinion.verdict} ${result.opinion.score}/10 — ${result.opinion.summary}` };
}

/**
 * Freezing without the model: the chapters an older engine approved (once, the first time a state that does not know frozen chapters
 * runs; never a chapter the author wrote), and the changes the author marked as reviewed through a decision that waited for a run
 * (frozen as they are, unless they changed again since: then they are asked about again).
 */
async function runFreeze(ctx: TaskContext): Promise<TaskResult> {
  const at = ctx.now().toISOString();
  const italian = isItalian(ctx.language);
  const changes: BookFileChange[] = [];
  const done: string[] = [];
  if (!ctx.state.frozenSince) {
    const legacy = legacyChapters(ctx.state, ctx.snapshot);
    for (const folder of legacy) changes.push(...freezeChapterChanges(ctx.snapshot, folder.slug, "autopilot", at));
    ctx.state.frozenSince = at;
    if (legacy.length) {
      done.push(italian ? `${legacy.length} capitoli approvati congelati` : `${legacy.length} approved chapters frozen`);
      ctx.insight(
        "info",
        italian
          ? `${legacy.length === 1 ? "Il capitolo già approvato è congelato" : `I ${legacy.length} capitoli già approvati sono congelati`}: d'ora in poi una tua modifica viene notata`
          : `${legacy.length === 1 ? "The chapter already approved is frozen" : `The ${legacy.length} chapters already approved are frozen`}: from now on a change you make to them is noticed`,
        legacy.map((folder) => folder.slug).join(", "),
        { code: "frozenMigrated" },
      );
    }
  }
  const pending = queuedMarkReviewed(ctx.state);
  if (pending.length) {
    const current = new Map(frozenChanges(ctx.snapshot).map((change) => [change.number, change]));
    const plan = ctx.state.plan?.chapters ?? [];
    for (const entry of pending) {
      const slug = plan.find((chapter) => chapter.number === entry.number)?.slug;
      const change = current.get(entry.number);
      if (slug && change && change.slug === slug && change.fingerprint === entry.fingerprint) {
        changes.push(...markReviewedChanges(ctx.snapshot, slug, at));
        done.push(italian ? `capitolo ${entry.number} segnato come rivisto` : `chapter ${entry.number} marked as reviewed`);
        ctx.insight("ok", italian ? `Capitolo ${entry.number} segnato come rivisto: congelato così com'è` : `Chapter ${entry.number} marked as reviewed: frozen as it is`, undefined, { code: "frozenReviewed", chapterNumber: entry.number });
      }
    }
    const ids = new Set(pending.map((entry) => entry.id));
    const left = (ctx.state.pendingReviews ?? []).filter((entry) => !ids.has(entry.id));
    if (left.length) ctx.state.pendingReviews = left;
    else delete ctx.state.pendingReviews;
  }
  return { changes, summary: done.join("; ") || (italian ? "Nulla da congelare." : "Nothing to freeze.") };
}

export const TASK_EXECUTORS: Record<TaskDescriptor["kind"], (ctx: TaskContext) => Promise<TaskResult>> = {
  concept: runConcept,
  "summarize-imported": runSummarizeImported,
  plan: runPlan,
  "plan-reader": runPlanReader,
  "plan-review": runPlanReview,
  replan: runReplan,
  scenes: runScenes,
  write: runWrite,
  reader: runReader,
  "readers-summary": runReadersSummary,
  specialists: runSpecialists,
  "director-review": runDirectorReview,
  repair: runRepair,
  consolidate: runConsolidate,
  impact: runImpact,
  revise: runRevise,
  final: runFinal,
  freeze: runFreeze,
};
