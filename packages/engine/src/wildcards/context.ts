import type { AiPort } from "../ai/types.js";
import { importedChapters } from "../autopilot/planner.js";
import { parseAutopilotState } from "../autopilot/state.js";
import { readStorySoFar } from "../autopilot/story-so-far.js";
import { canonManifest, loadChapterParagraphs, markedChapterText, readBody, referencedChapterNumber, secretRules } from "../book/context.js";
import { AUTOPILOT_STATE_FILE, OUTLINE_BOOK_FILE, STORY_DESIGN_FILE } from "../book/paths.js";
import { loadBookSnapshot, type BookSnapshot, type ChapterInfo } from "../book/snapshot.js";
import type { BookStore } from "../book/store.js";
import { mergeWildcards, parseWildcard, pickWildcardVoices, WILDCARD_DIRECTORY, wildcardFilePaths, type WildcardGroup, type WildcardPresetId, type WildcardProfile } from "../profiles/wildcards.js";
import { clipMiddle, isItalian, tail, truncate } from "../util/text.js";
import type { WildcardDecision, WildcardIdea, WildcardTarget } from "./ideas.js";
import { IDEAS_JOURNAL_FILE, parseIdeasJournal, rejectedIdeas, type IdeasJournal, type IdeasJournalAuthor, type IdeasJournalEntry } from "./journal.js";
import { runWildcardRoom, type WildcardRoomContext, type WildcardRoomInput, type WildcardRoomResult, type WildcardRoomSecrets, type WildcardVoiceEvent } from "./room.js";

/**
 * A consultation of the room, from the book: the wildcards in force for it, what each may know of the secrets, the material of what it is about and the
 * context every voice shares. The web app and the autopilot both consult through `consultWildcards`, so the room reads a book the same way in both.
 */

/** Characters of the list of the secrets the material may know, and of each truth in it. */
const THRESHOLD_SECRETS_MAX_CHARS = 12_000;
const SECRET_TRUTH_CHARS = 500;
/** Characters of a scene the room reads, as the autopilot's reviews read one. */
const SCENE_CHARS = 14_000;

/** The wildcards of a book: the built-in ones, then the author's account ones (`account`, from the host), then the book's `wildcards/*.md`. */
export async function loadWildcardPanel(store: BookStore, snapshot: BookSnapshot, options: { account?: readonly WildcardProfile[] } = {}): Promise<WildcardProfile[]> {
  const paths = wildcardFilePaths(snapshot.files.keys());
  const files = store.readMany ? await store.readMany(paths) : (await Promise.all(paths.map((path) => store.read(path)))).filter((file): file is NonNullable<typeof file> => Boolean(file));
  const book = files.map((file) => parseWildcard(file.path.slice(WILDCARD_DIRECTORY.length + 1, -3), file.content, file.path));
  return mergeWildcards(snapshot.book.language, { account: [...(options.account ?? [])], book });
}

/**
 * What the voices may know of the secrets at `chapter` (see `WildcardRoomSecrets`): for the `threshold` access only the secrets whose reveal (`reveal_in`,
 * else `known_from`, the rule the autopilot follows) is at or before it, with their truths; never one still hidden there, and none at all without a
 * chapter (a plan, a conversation). For the `author` access, every secret with its rule relative to the chapter (`secretRules`).
 */
export async function wildcardRoomSecrets(store: BookStore, snapshot: BookSnapshot, chapter?: number): Promise<WildcardRoomSecrets> {
  const secrets = snapshot.canon.filter((entry) => entry.kind === "secret");
  if (!secrets.length) return { threshold: "", author: "" };
  const author = await secretRules(store, snapshot, chapter, SECRET_TRUTH_CHARS);
  if (chapter === undefined) return { threshold: "", author };
  const reached = secrets
    .map((secret) => ({ secret, reveal: referencedChapterNumber(secret.revealIn) ?? referencedChapterNumber(secret.knownFrom) }))
    .filter((entry): entry is { secret: typeof entry.secret; reveal: number } => entry.reveal !== undefined && entry.reveal <= chapter)
    .sort((left, right) => right.reveal - left.reveal);
  const lines: string[] = [];
  let size = 0;
  let left = 0;
  for (const entry of reached) {
    // The heading of the file only repeats the name.
    const truth = (await readBody(store, entry.secret.path, SECRET_TRUTH_CHARS)).replace(/^#{1,6}\s.*$/gm, "").replace(/\s+/g, " ").trim();
    const line = `- ${entry.secret.name}: revealed ${entry.reveal === chapter ? "in this chapter" : `in chapter ${entry.reveal}`}.${truth ? `\n  Truth: ${truth}` : ""}`;
    if (size + line.length + 1 > THRESHOLD_SECRETS_MAX_CHARS) {
      left += 1;
      continue;
    }
    lines.push(line);
    size += line.length + 1;
  }
  if (left) lines.push(`(Not listed, to keep this list short: ${left} more ${left === 1 ? "secret" : "secrets"} revealed earlier.)`);
  return { threshold: lines.join("\n"), author };
}

/** How a person names what the room reads, in the language of the book. */
export function wildcardTargetLabel(target: Omit<WildcardTarget, "label">, snapshot: BookSnapshot): string {
  const italian = isItalian(snapshot.book.language);
  const chapter = target.chapter !== undefined ? snapshot.chapters.find((entry) => entry.number === target.chapter) : undefined;
  const scene = chapter && target.paragraph !== undefined ? chapter.paragraphs.find((entry) => entry.number === target.paragraph) : undefined;
  const chapterLabel = chapter ? `${italian ? "Capitolo" : "Chapter"} ${chapter.number}: ${chapter.title}` : target.chapter !== undefined ? `${italian ? "Capitolo" : "Chapter"} ${target.chapter}` : "";
  const sceneLabel = scene ? `${italian ? "scena" : "scene"} ${scene.number}: ${scene.title}` : target.paragraph !== undefined ? `${italian ? "scena" : "scene"} ${target.paragraph}` : "";
  switch (target.kind) {
    case "selection":
      return [italian ? "Selezione" : "Selection", [chapterLabel, sceneLabel].filter(Boolean).join(", ")].filter(Boolean).join(" — ");
    case "paragraph":
      return [chapterLabel, sceneLabel].filter(Boolean).join(", ") || (italian ? "Scena" : "Scene");
    case "chapter":
      return chapterLabel || (italian ? "Capitolo" : "Chapter");
    case "book":
      return snapshot.book.title || (italian ? "Il libro" : "The book");
    case "plan":
      return italian ? "Il piano del libro" : "The plan of the book";
    case "conversation":
      return italian ? "La conversazione di Brainstorming" : "The Brainstorming conversation";
  }
}

function chapterOf(snapshot: BookSnapshot, number: number | undefined): ChapterInfo | undefined {
  return number === undefined ? undefined : snapshot.chapters.find((entry) => entry.number === number);
}

/**
 * The material of a target, read from the book: the selection with its scene around it, the scene, the chapter scene by scene, the book chapter by chapter (then
 * what the host adds about it: the director's judgement of a review that stalled).
 */
export async function wildcardMaterial(store: BookStore, snapshot: BookSnapshot, target: WildcardTarget, given?: string): Promise<string> {
  const chapter = chapterOf(snapshot, target.chapter);
  if (target.kind === "plan" || target.kind === "conversation") return given?.trim() ?? "";
  if (target.kind === "book") {
    const chapters = snapshot.chapters.map((entry) => `${entry.number}. ${entry.title}${entry.summary ? ` — ${truncate(entry.summary.replace(/\s+/g, " "), 600)}` : ""}${entry.paragraphs.length ? "" : " (not written yet)"}`).join("\n");
    return [chapters, given?.trim() ?? ""].filter(Boolean).join("\n\n");
  }
  if (!chapter) return given?.trim() ?? "";
  const paragraphs = await loadChapterParagraphs(store, chapter);
  if (target.kind === "chapter") {
    return [`CHAPTER ${chapter.number}: ${chapter.title}${chapter.summary ? `\nPlanned summary: ${chapter.summary}` : ""}`, paragraphs.length ? markedChapterText(paragraphs, SCENE_CHARS) : "(no scenes written yet)"].join("\n\n");
  }
  const index = paragraphs.findIndex((entry) => entry.number === target.paragraph);
  const scene = index >= 0 ? paragraphs[index] : undefined;
  if (target.kind === "paragraph") {
    if (!scene) return given?.trim() ?? "";
    const previous = index > 0 ? paragraphs[index - 1] : undefined;
    return [
      `CHAPTER ${chapter.number}: ${chapter.title}`,
      previous ? `END OF THE PREVIOUS SCENE:\n${tail(previous.body, 1_500)}` : "",
      `=== SCENE ${scene.number}: ${scene.title} ===\n${clipMiddle(scene.body, SCENE_CHARS * 2)}`,
    ].filter(Boolean).join("\n\n");
  }
  // A selection: the passage itself first, then the scene it is in, for what surrounds it.
  return [
    `THE SELECTED PASSAGE:\n${given?.trim() ?? ""}`,
    scene ? `THE SCENE IT IS IN (for context; the room talks about the passage) — scene ${scene.number}: ${scene.title}:\n${clipMiddle(scene.body, SCENE_CHARS)}` : "",
  ].filter(Boolean).join("\n\n");
}

/** What every voice shares about the book: its synopsis, the canon without the secrets, the story before what the room reads. */
export async function wildcardRoomContext(store: BookStore, snapshot: BookSnapshot, target: WildcardTarget): Promise<WildcardRoomContext> {
  const [outline, design, stateFile] = await Promise.all([
    readBody(store, OUTLINE_BOOK_FILE, 4_000),
    readBody(store, STORY_DESIGN_FILE, 4_000),
    store.read(AUTOPILOT_STATE_FILE),
  ]);
  const before = target.kind === "selection" || target.kind === "paragraph" || target.kind === "chapter" ? target.chapter : undefined;
  const storySoFar = before !== undefined
    ? await readStorySoFar(store, { chapters: parseAutopilotState(stateFile?.content)?.plan?.chapters ?? importedChapters(snapshot), beforeChapter: before, max: 5_000 })
    : "";
  const canon = canonManifest(snapshot, { includeSecrets: false, max: 60 });
  return {
    title: snapshot.book.title,
    language: snapshot.book.language,
    ...(outline || design ? { synopsis: outline || design } : {}),
    ...(canon ? { canon } : {}),
    ...(storySoFar ? { storySoFar } : {}),
  };
}

/** The chapter whose point of the story the secrets are told at: the target's, the last written one for the book, none for a plan or a conversation. */
export function wildcardSecretsChapter(snapshot: BookSnapshot, target: WildcardTarget): number | undefined {
  if (target.kind === "book") return [...snapshot.chapters].reverse().find((chapter) => chapter.paragraphs.length > 0)?.number;
  if (target.kind === "plan" || target.kind === "conversation") return undefined;
  return target.chapter;
}

/** The journal of the room of a book (`bible/ideas.yml`), empty when there is none. */
export async function loadIdeasJournal(store: BookStore): Promise<IdeasJournal> {
  return parseIdeasJournal((await store.read(IDEAS_JOURNAL_FILE))?.content);
}

export interface WildcardConsultInput extends Pick<WildcardRoomInput, "question" | "asker" | "maxIdeas" | "parallel" | "moneyCap" | "windowTokens" | "outputTokens" | "signal"> {
  store: BookStore;
  ai: AiPort;
  snapshot?: BookSnapshot;
  /** What the room reads; its `label` is made from the book when it is empty. */
  target: Omit<WildcardTarget, "label"> & { label?: string };
  /** The selected text (a selection), the material the host made itself (a plan, a conversation), or what it adds to the chapters of the book. */
  material?: string;
  /** The voices: these slugs (or ids), else a preset's, else the first enabled ones of `group` (provocateurs by default). */
  voices?: readonly string[];
  preset?: WildcardPresetId;
  group?: WildcardGroup;
  /** How many voices (default `WILDCARD_DEFAULT_VOICES`, at most `WILDCARD_MAX_VOICES`). */
  maxVoices?: number;
  /** The wildcards of the author's account, from the host (the personal server has none). */
  account?: readonly WildcardProfile[];
  /** A panel the host already loaded: used as it is, in place of `account` and the book's files. */
  panel?: readonly WildcardProfile[];
  /** Who asks: written in the journal entry. */
  by: IdeasJournalAuthor;
  /** The cache scope of the prompts (`<book>/wildcards` by default when `bookId` is given). */
  bookId?: string;
  now?: () => Date;
  onVoice?: (event: WildcardVoiceEvent) => void;
}

export interface WildcardConsultResult extends WildcardRoomResult {
  /** The consultation as the journal keeps it, without decisions: the host appends it once something is decided (`appendIdeasJournal`). */
  entry: IdeasJournalEntry;
  /** The voices asked, as profiles. */
  asked: WildcardProfile[];
  /** What is wrong with the wildcard files of the book (each naming its file): such a file is never asked. */
  warnings: string[];
}

/**
 * Consult the room about a part of a book: the voices asked (`pickWildcardVoices`), each told what it may know of the secrets, the material read from the
 * book, the ideas rejected before so that they are not given again. Nothing is written: the consultation goes into the journal with the decisions taken on it.
 */
export async function consultWildcards(input: WildcardConsultInput): Promise<WildcardConsultResult> {
  const snapshot = input.snapshot ?? await loadBookSnapshot(input.store);
  const panel = input.panel ? [...input.panel] : await loadWildcardPanel(input.store, snapshot, { account: input.account ?? [] });
  const asked = pickWildcardVoices(panel, { ...(input.voices?.length ? { slugs: input.voices } : {}), ...(input.preset ? { preset: input.preset } : {}), ...(input.group ? { group: input.group } : {}), ...(input.maxVoices ? { max: input.maxVoices } : {}) });
  const target: WildcardTarget = { ...input.target, label: input.target.label?.trim() || wildcardTargetLabel(input.target, snapshot) };
  const [material, context, secrets, journal] = await Promise.all([
    wildcardMaterial(input.store, snapshot, target, input.material),
    wildcardRoomContext(input.store, snapshot, target),
    wildcardRoomSecrets(input.store, snapshot, wildcardSecretsChapter(snapshot, target)),
    loadIdeasJournal(input.store),
  ]);
  const result = asked.length
    ? await runWildcardRoom({
      ai: input.ai,
      voices: asked,
      target,
      material,
      context,
      secrets,
      rejected: rejectedIdeas(journal),
      ...(input.question ? { question: input.question } : {}),
      ...(input.asker ? { asker: input.asker } : {}),
      ...(input.maxIdeas ? { maxIdeas: input.maxIdeas } : {}),
      ...(input.parallel ? { parallel: input.parallel } : {}),
      ...(input.moneyCap ? { moneyCap: input.moneyCap } : {}),
      ...(input.windowTokens ? { windowTokens: input.windowTokens } : {}),
      ...(input.outputTokens ? { outputTokens: input.outputTokens } : {}),
      ...(input.bookId ? { cacheKey: `${input.bookId}/wildcards` } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onVoice ? { onVoice: input.onVoice } : {}),
    })
    : { consultation: `room-${crypto.randomUUID()}`, target, voices: [], ideas: [], voicesOmitted: 0, cost: 0, capped: false };
  const at = (input.now ?? (() => new Date()))().toISOString();
  return {
    ...result,
    entry: { id: result.consultation, at, by: input.by, target, ...(input.preset ? { preset: input.preset } : {}), voices: asked.map((voice) => voice.slug), ideas: result.ideas },
    asked,
    warnings: panel.flatMap((profile) => profile.warnings ?? []),
  };
}

/** A consultation with decisions on its ideas (by id): the ones decided carry their decision, the others stay as they were. */
export function decideWildcardIdeas(entry: IdeasJournalEntry, decisions: ReadonlyMap<string, WildcardDecision> | Record<string, WildcardDecision>): IdeasJournalEntry {
  const read = (id: string): WildcardDecision | undefined => (decisions instanceof Map ? decisions.get(id) : (decisions as Record<string, WildcardDecision>)[id]);
  return { ...entry, ideas: entry.ideas.map((idea: WildcardIdea) => {
    const decision = read(idea.id);
    return decision ? { ...idea, decision } : idea;
  }) };
}
