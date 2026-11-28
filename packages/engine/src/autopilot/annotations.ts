import { appLanguage, builtinTag, liveAnnotations, parseBookTags, parseChapterAnnotations, serializeChapterAnnotations, tagCatalog, upsertAnnotation, annotationStatus, withStatus, annotationsChapterPath, chapterSlugOfAnnotationsPath, ANNOTATIONS_CHAPTERS_DIRECTORY, ANNOTATION_TAGS_PATH, liveTags, paragraphSlugOfRef, RESOLUTION_SUMMARY_MAX, type AnnotationTagDefinition } from "../annotations/index.js";
import type { BookSnapshot } from "../book/snapshot.js";
import type { BookFileChange, BookStore } from "../book/store.js";
import { paragraphFilePath, paragraphSlug } from "../book/paths.js";
import { authorHeldChapters } from "./frozen.js";
import { RevisionCampaignError, authorChapters } from "./campaign.js";
import { MAX_ANNOTATION_NOTES, MAX_CAMPAIGN_CHAPTERS, CAMPAIGN_NOTE_CHARACTERS } from "./state.js";
import type { AnnotationWork, AutopilotState, PlannedChapter, RevisionCampaign, RevisionRequest } from "./types.js";
import { randomId } from "../util/hash.js";
import { clipText, isItalian } from "../util/text.js";

/**
 * The annotations of the author as the input of the autopilot: the notes still open are what a campaign of reason `annotations` rewrites, chapter by chapter, through
 * the same machinery as every other revision (the chapter is rewritten scene by scene, then reviewed again by the director and the readers, and closed). The autopilot
 * never decides by itself to work on them: the author asks (`AutopilotSession.reviseAnnotations`), sees an estimate first, and the notes it answered are closed as
 * handled "by the autopilot", with what it did, when the scene is written.
 */

/** The longest instruction one note gives the ghostwriter. */
export const ANNOTATION_INSTRUCTION_CHARACTERS = 900;

/** One open note of the author, with the tag it carries resolved: what the autopilot reads of an annotation. */
export interface AnnotationNote {
  id: string;
  /** The chapter (its slug) and the scene (its slug) the passage was marked in. */
  chapter: string;
  paragraph: string;
  quote: string;
  comment: string;
  tag: string;
  tagName: string;
  tagDescription: string;
}

/** What the author asks: which notes (all the open ones when nothing narrows them), and for which chapters of the author's to work. */
export interface ReviseAnnotationsInput {
  /** Only these notes (their ids). */
  ids?: string[];
  /** Only the notes of these chapters (their slugs). */
  chapters?: string[];
  /** Chapters of the author's (written by hand, or frozen by the author) that the author chose to have rewritten too, by number. */
  include?: number[];
  /** The tags of the account (the app keeps them in the account settings): their descriptions say what the AI does for a note with that tag. */
  accountTags?: AnnotationTagDefinition[];
  /** The language of the instructions, `en` or `it`. */
  language?: string;
  /** The author's words for the director, for every chapter. */
  note?: string;
}

/** The notes a book has, open ones only, with their tags resolved. A tag that says to keep a passage (`keep`) is not a change to make: it is left out. */
export async function readAnnotationNotes(store: BookStore, input: Pick<ReviseAnnotationsInput, "ids" | "chapters" | "accountTags" | "language"> = {}): Promise<{ notes: AnnotationNote[]; unreadable: string[] }> {
  const language = appLanguage(input.language);
  const bookTags = await store.read(ANNOTATION_TAGS_PATH);
  const parsedTags = bookTags ? parseBookTags(bookTags.content) : null;
  const catalog = tagCatalog({ language, ...(input.accountTags ? { global: input.accountTags } : {}), ...(parsedTags?.ok ? { book: liveTags(parsedTags.file) } : {}) });
  const wanted = input.ids ? new Set(input.ids) : null;
  const inChapters = input.chapters ? new Set(input.chapters) : null;
  const notes: AnnotationNote[] = [];
  const unreadable: string[] = [];
  const files = (await store.list()).map((entry) => entry.path).filter((path) => path.startsWith(`${ANNOTATIONS_CHAPTERS_DIRECTORY}/`) && chapterSlugOfAnnotationsPath(path)).sort();
  for (const path of files) {
    const chapter = chapterSlugOfAnnotationsPath(path)!;
    if (inChapters && !inChapters.has(chapter)) continue;
    const file = await store.read(path);
    if (!file) continue;
    const parsed = parseChapterAnnotations(file.content, chapter);
    if (!parsed.ok) { unreadable.push(path); continue; }
    for (const annotation of liveAnnotations(parsed.file)) {
      if (annotationStatus(annotation.status) !== "open" || (wanted && !wanted.has(annotation.id)) || annotation.tag === "keep") continue;
      const tag = catalog.find((entry) => entry.id === annotation.tag) ?? builtinTag(annotation.tag, language);
      notes.push({ id: annotation.id, chapter, paragraph: paragraphSlugOfRef(annotation.paragraph), quote: annotation.quote, comment: annotation.comment, tag: annotation.tag, tagName: tag?.name ?? annotation.tag, tagDescription: tag?.description ?? "" });
    }
  }
  return { notes, unreadable };
}

/** What to ask of the ghostwriter for one note: the tag and what it means, the passage, and the author's words. */
export function annotationInstruction(note: Pick<AnnotationNote, "quote" | "comment" | "tagName" | "tagDescription">, language: string): string {
  const italian = isItalian(language);
  const parts = [
    `${italian ? "Nota del lettore" : "Reader's note"} — ${note.tagName}${note.tagDescription ? `: ${clipText(note.tagDescription, 240)}` : ""}`,
    `${italian ? "Passaggio" : "Passage"}: «${clipText(note.quote, 300)}»`,
    ...(note.comment.trim() ? [`${italian ? "Cosa dice l'autore" : "What the author says"}: ${clipText(note.comment.trim(), 400)}`] : []),
  ];
  return clipText(parts.join("\n"), ANNOTATION_INSTRUCTION_CHARACTERS);
}

/** The scene of a chapter of the plan that holds a scene file (by the slug of its file). */
function sceneByParagraph(chapter: PlannedChapter, paragraph: string): number | undefined {
  return chapter.scenes.find((scene) => {
    const file = scene.path ?? paragraphFilePath(chapter.slug, paragraphSlug(scene.number, scene.title));
    return (scene.slug ?? file.slice(file.lastIndexOf("/") + 1).replace(/\.md$/, "")) === paragraph;
  })?.number;
}

/**
 * A campaign that rewrites the passages of the notes, from what the author asked and the book as it is now. The notes are placed in the plan (a note whose scene is
 * not there any more is counted `unplaced`); those of a chapter the autopilot has not closed yet are counted `notYet` and left for later; the chapters of the author's
 * are held back unless included. Throws a `RevisionCampaignError`: `invalid_request`, `not_finished` (no approved plan: there is nothing the autopilot wrote), `campaign_active`,
 * `nothing_to_review` (no note is left to work).
 */
export function createAnnotationsCampaign(input: ReviseAnnotationsInput & { notes: readonly AnnotationNote[] }, state: AutopilotState, snapshot: BookSnapshot, now: Date, id: string = randomId("annotations")): RevisionCampaign {
  const refuse = (problem: string): never => {
    throw new RevisionCampaignError("invalid_request", problem);
  };
  if (!input || typeof input !== "object") refuse("A request is { ids?, chapters?, include?, accountTags?, language?, note? }.");
  if (input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.length > MAX_ANNOTATION_NOTES * 5 || input.ids.some((entry) => typeof entry !== "string"))) refuse("The notes are a list of ids.");
  if (input.chapters !== undefined && (!Array.isArray(input.chapters) || input.chapters.length > MAX_CAMPAIGN_CHAPTERS * 5 || input.chapters.some((entry) => typeof entry !== "string"))) refuse("The chapters are a list of chapter names.");
  if (input.include !== undefined && (!Array.isArray(input.include) || input.include.length > MAX_CAMPAIGN_CHAPTERS || input.include.some((number) => !Number.isSafeInteger(number) || number < 1))) refuse("The chapters to include are chapter numbers.");
  if (input.note !== undefined && typeof input.note !== "string") refuse("The note of a request is a text.");
  const plan = state.plan;
  if (!plan?.approved) throw new RevisionCampaignError("not_finished", "This book has no approved plan yet: the autopilot rewrites chapters it has written.");
  if (state.campaign || state.revision) throw new RevisionCampaignError("campaign_active", "Chapters are being revised already: wait until they are done, or cancel what waits.");
  const include = [...new Set(input.include ?? [])].sort((left, right) => left - right);
  const authors = authorChapters(state, snapshot);
  const { changedFrozen } = authorHeldChapters(snapshot);
  const work: AnnotationWork[] = [];
  const heldBack = new Set<number>();
  let unplaced = 0;
  let notYet = 0;
  for (const note of input.notes) {
    const chapter = plan.chapters.find((entry) => entry.slug === note.chapter);
    if (!chapter) { unplaced += 1; continue; }
    if (chapter.status !== "done") { notYet += 1; continue; }
    if (changedFrozen.has(chapter.slug) || (authors.has(chapter.number) && !include.includes(chapter.number))) { heldBack.add(chapter.number); continue; }
    const scene = sceneByParagraph(chapter, note.paragraph);
    if (scene === undefined) { unplaced += 1; continue; }
    if (work.length >= MAX_ANNOTATION_NOTES) break;
    work.push({ id: note.id, chapterNumber: chapter.number, sceneNumber: scene, instruction: annotationInstruction(note, input.language ?? "en") });
  }
  if (!work.length) throw new RevisionCampaignError("nothing_to_review", heldBack.size ? "The notes left are in chapters that are yours (written by hand or frozen by you): include them to have the autopilot work on them." : "There is no open note to work: they are handled, put off, in chapters not closed yet, or on text that is not in the book any more.");
  const numbers = [...new Set(work.map((entry) => entry.chapterNumber))].sort((left, right) => left - right);
  const note = input.note?.trim() ? clipText(input.note.trim(), CAMPAIGN_NOTE_CHARACTERS) : undefined;
  return {
    id,
    reason: "annotations",
    createdAt: now.toISOString(),
    ...(note ? { note } : {}),
    chapters: numbers.map((number) => ({ number, mode: "follow" as const, status: "waiting" as const })),
    annotations: {
      notes: work,
      ...(include.length ? { include } : {}),
      ...(heldBack.size ? { heldBack: [...heldBack].sort((left, right) => left - right) } : {}),
      ...(unplaced ? { unplaced } : {}),
      ...(notYet ? { notYet } : {}),
    },
  };
}

/** The rewrite of a chapter that answers its notes, one target per scene, in the order of the scenes: what a revision begun by the campaign carries. */
export function annotationRevision(campaign: RevisionCampaign, chapter: PlannedChapter, at: string): RevisionRequest | null {
  const notes = (campaign.annotations?.notes ?? []).filter((note) => note.chapterNumber === chapter.number && chapter.scenes.some((scene) => scene.number === note.sceneNumber));
  if (!notes.length) return null;
  const scenes = [...new Set(notes.map((note) => note.sceneNumber))].sort((left, right) => left - right);
  return {
    id: `${campaign.id}-${chapter.number}`,
    instruction: `Rewrite the passages of chapter ${chapter.number} that the author marked, as their notes ask.`,
    createdAt: at,
    targets: scenes.map((sceneNumber) => {
      const mine = notes.filter((note) => note.sceneNumber === sceneNumber);
      return { chapterNumber: chapter.number, sceneNumber, instruction: [...(campaign.note ? [campaign.note] : []), ...mine.map((note, index) => (mine.length > 1 ? `(${index + 1}) ${note.instruction}` : note.instruction))].join("\n\n"), noteIds: mine.map((note) => note.id) };
    }),
    cursor: 0,
    onlyChapter: chapter.number,
  };
}

/**
 * The change to a chapter's annotations file that closes `ids` as handled by the autopilot, with what it did; `null` when nothing changes (the file is gone,
 * unreadable, or the notes are not open any more). The author's own edit to a note in the meantime is respected: only a note that is still open is closed.
 */
export async function closeAnnotations(store: BookStore, chapterSlug: string, ids: readonly string[], at: string, summary: string): Promise<BookFileChange | null> {
  const path = annotationsChapterPath(chapterSlug);
  const file = await store.read(path);
  if (!file) return null;
  const parsed = parseChapterAnnotations(file.content, chapterSlug);
  if (!parsed.ok) return null;
  let next = parsed.file;
  let changed = false;
  for (const annotation of liveAnnotations(parsed.file)) {
    if (!ids.includes(annotation.id) || annotationStatus(annotation.status) !== "open") continue;
    const closed = withStatus(annotation, "handled", at, { by: "autopilot", at, summary: clipText(summary, RESOLUTION_SUMMARY_MAX) });
    if (!closed) continue;
    next = upsertAnnotation(next, closed);
    changed = true;
  }
  return changed ? { path, content: serializeChapterAnnotations(next), expectedHash: file.hash } : null;
}

/** What the autopilot says it did for a scene, in the note's resolution. */
export function annotationSummary(chapterNumber: number, sceneNumber: number, language: string): string {
  return isItalian(language) ? `Riscritto dall'autopilota (scena ${chapterNumber}.${sceneNumber}) secondo la nota.` : `Rewritten by the autopilot (scene ${chapterNumber}.${sceneNumber}) as the note asks.`;
}
