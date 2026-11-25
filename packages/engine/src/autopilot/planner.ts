import type { BookSnapshot, ChapterInfo } from "../book/snapshot.js";
import { chapterNumberFromSlug, chapterSlug, paragraphFilePath, paragraphSlug } from "../book/paths.js";
import type { DirectorProfile } from "../profiles/director.js";
import { countWords, isItalian } from "../util/text.js";
import { advancePendingReviews, frozenQuestionMessage, inRevision, isFrozenQuestion, needsFreezeStep, noteOutlineRewrite, startedReview, type PlannerFrozen } from "./frozen.js";
import type { AutopilotMessageCode, AutopilotPhase, AutopilotPlan, AutopilotState, AutopilotTaskKind, ChapterReview, InsightTone, PlannedChapter, PlannedScene } from "./types.js";

export interface PlannerReader {
  slug: string;
  name: string;
}

/** Something advancing the state found in the author's files that the author should know about. */
export interface PlanNote {
  /** The same for the same finding, so that a run can say it once however many steps it takes. */
  key: string;
  tone: InsightTone;
  title: string;
  detail?: string;
  /** A code a client can say in its own language, and the chapter it is about. */
  code?: AutopilotMessageCode;
  chapterNumber?: number;
}

export interface PlannerContext {
  snapshot: BookSnapshot;
  director: DirectorProfile;
  /** Enabled simulated readers, in panel order, already capped. */
  readers: PlannerReader[];
  language: string;
  /** The story design is still the empty scaffold. */
  storyDesignThin: boolean;
  /** Told what the reconciliation of the plan with the files found: a chapter followed into its renamed folder, a folder the autopilot will not write in, a rewrite with nothing left to rewrite. */
  report?: (note: PlanNote) => void;
  /** What the outline says, read by the runner before the step (absent: no outline, as before it existed). */
  outline?: PlannerOutline;
  /**
   * Given once the runner has settled the changes of frozen chapters for the step (`settleFrozenChanges`): advancing the state may then
   * start carrying out a decision about one. Absent: decisions are only finished, never started.
   */
  frozen?: PlannerFrozen;
}

/** What the planner knows of the outline (`outline/`): the runner reads it before every step, and the planner never reads a file. */
export interface PlannerOutline {
  /** The last chapter the author's outline asks for (0 when it asks for none): the book has at least this many chapters. */
  lastChapter: number;
  /**
   * Chapters of the plan whose entry of the outline the author changed (`changed`) or deleted (`removed`) since the plan followed it,
   * and that have nothing written yet: each is planned again, or taken out of the plan, before its scenes.
   */
  changed?: ReadonlyMap<number, "changed" | "removed">;
}

/**
 * The number of chapters the book has: the chapter entries of the outline, up to the last one (its number; with no number between two
 * entries, the planner plans that chapter freely, as the outline warns). Zero when the outline has no chapter: then nothing is planned.
 */
export function bookChapters(outline?: Pick<PlannerOutline, "lastChapter"> | null): number {
  return Math.max(0, outline?.lastChapter ?? 0);
}

/**
 * The scenes a chapter has is the planner's to decide, from the outline entry of the chapter (its text, `entryText`; or the summary and the
 * events of the plan when the entry has no text). The rule is deterministic: 2 scenes for a short text (up to 40 words), 3 up to 100 words,
 * 4 for more. The words per scene (`wordsPerScene` of the brief) apply to each of them.
 */
export const SCENES_PER_CHAPTER = { min: 2, max: 4 } as const;

export function scenesForChapter(entryText: string): number {
  const words = countWords(entryText);
  if (words <= 40) return SCENES_PER_CHAPTER.min;
  if (words <= 100) return 3;
  return SCENES_PER_CHAPTER.max;
}

export interface TaskDescriptor {
  kind: AutopilotTaskKind;
  phase: AutopilotPhase;
  title: string;
  reason: string;
  next: string;
  chapterNumber?: number;
  /** Folder of the chapter, for the one step that is about a chapter by its folder (`summarize-imported`): two folders can have one number. */
  chapterSlug?: string;
  sceneNumber?: number;
  reader?: string;
  readerName?: string;
  /** Pending "next step" author notes are delivered to this task. */
  acceptsNotes: boolean;
}

export type PlannedStep =
  | { kind: "task"; task: TaskDescriptor }
  | { kind: "stop"; status: "paused" | "waiting-author" | "completed"; message: string };

/** The steps that write: the author's "next step" notes go to the first of them, once. Closing a chapter and repairing a scene that is already written take none. */
const NOTE_TASKS = new Set<AutopilotTaskKind>(["concept", "plan", "replan", "scenes", "write", "revise"]);

function text(language: string, en: string, it: string): string {
  return isItalian(language) ? it : en;
}

function quoted(title: string | undefined): string {
  return title ? ` «${title}»` : "";
}

/**
 * Plain-language "what / why / next" of every step, in the book language. `from` and `to` (the chapters one batch of a
 * long plan covers) make the title of the plan task say which chapters it plans; without them it says how many chapters
 * the single batch of a short book plans.
 */
export function describeTask(kind: AutopilotTaskKind, language: string, params: { chapter?: PlannedChapter; scene?: PlannedScene; readerName?: string; round?: number; chapters?: number; from?: number; to?: number; outline?: "changed" | "removed" }): Pick<TaskDescriptor, "title" | "reason" | "next"> {
  const chapter = params.chapter;
  const scene = params.scene;
  const c = chapter?.number ?? 0;
  const s = scene?.number ?? 0;
  switch (kind) {
    case "concept":
      return {
        title: text(language, "Designing the concept of the book", "Progettazione del concept del libro"),
        reason: text(language, "Premise, cast, places and secrets must exist before planning chapters.", "Premessa, personaggi, luoghi e segreti devono esistere prima di pianificare i capitoli."),
        next: text(language, "Plan the chapters.", "Pianificare i capitoli."),
      };
    case "summarize-imported":
      return {
        title: text(language, `Summarizing chapter ${c}${quoted(chapter?.title)}, written by the author`, `Riassunto del capitolo ${c}${quoted(chapter?.title)}, scritto dall'autore`),
        reason: text(language, "The next chapters need the story so far: a chapter without a summary leaves the continuity blind.", "I capitoli successivi hanno bisogno della storia finora: un capitolo senza riassunto lascia la continuità cieca."),
        next: text(language, "Plan or write the chapters that follow.", "Pianificare o scrivere i capitoli successivi."),
      };
    case "plan": {
      const batch = params.from !== undefined && params.to !== undefined ? { from: params.from, to: params.to } : null;
      const one = batch?.from === batch?.to;
      return {
        title: batch
          ? text(language, one ? `Planning chapter ${batch.from}` : `Planning chapters ${batch.from}-${batch.to}`, one ? `Pianificazione del capitolo ${batch.from}` : `Pianificazione dei capitoli ${batch.from}-${batch.to}`)
          : text(language, `Planning ${params.chapters ?? ""} chapters`.replace("  ", " "), `Pianificazione di ${params.chapters ?? ""} capitoli`.replace("  ", " ")),
        reason: text(language, "Every chapter needs a purpose, escalation and causality before writing.", "Ogni capitolo ha bisogno di uno scopo, di un'escalation e di causalità prima della scrittura."),
        next: text(language, "Simulated readers and the director review the plan.", "I lettori simulati e il direttore valutano il piano."),
      };
    }
    case "plan-reader":
      return {
        title: text(language, `${params.readerName ?? "A reader"} reads the pitch and the plan`, `${params.readerName ?? "Un lettore"} legge il pitch e il piano`),
        reason: text(language, "The director weighs how the intended audience reacts before writing starts.", "Il direttore considera la reazione del pubblico prima di iniziare a scrivere."),
        next: text(language, "The director decides on the plan.", "Il direttore decide sul piano."),
      };
    case "plan-review":
      return {
        title: text(language, "The director reviews the concept and the plan", "Il direttore valuta concept e piano"),
        reason: text(language, "The director stands in for the author and approves or corrects the plan.", "Il direttore sostituisce l'autore e approva o corregge il piano."),
        next: text(language, "Plan the scenes of the first chapter.", "Pianificare le scene del primo capitolo."),
      };
    case "replan":
      return params.outline === "removed"
        ? {
          title: text(language, `Taking chapter ${c}${quoted(chapter?.title)} out of the plan`, `Il capitolo ${c}${quoted(chapter?.title)} esce dal piano`),
          reason: text(language, "You deleted its entry of the synopsis, and nothing of it is written yet.", "Hai cancellato la sua voce della Sinossi, e non ne è ancora scritto nulla."),
          next: text(language, "Go on with the next chapter: its number does not change.", "Proseguire con il capitolo successivo: il suo numero non cambia."),
        }
        : {
          title: text(language, `Planning chapter ${c}${quoted(chapter?.title)} again from your synopsis`, `Nuova pianificazione del capitolo ${c}${quoted(chapter?.title)} dalla tua Sinossi`),
          reason: text(language, "You changed its entry of the synopsis: its plan follows the new entry, and its scenes are planned again.", "Hai cambiato la sua voce della Sinossi: il suo piano segue la voce nuova, e le sue scene si ripianificano."),
          next: text(language, `Plan the scenes of chapter ${c}.`, `Pianificare le scene del capitolo ${c}.`),
        };
    case "scenes":
      return {
        title: text(language, `Planning the scenes of chapter ${c}${quoted(chapter?.title)}`, `Pianificazione delle scene del capitolo ${c}${quoted(chapter?.title)}`),
        reason: text(language, "Each scene needs a goal and beats so the prose stays focused.", "Ogni scena ha bisogno di un obiettivo e di passaggi perché la prosa resti mirata."),
        next: text(language, "Write the first scene.", "Scrivere la prima scena."),
      };
    case "write":
      return {
        title: text(language, `Writing scene ${s} of chapter ${c}${quoted(scene?.title)}`, `Scrittura della scena ${s} del capitolo ${c}${quoted(scene?.title)}`),
        reason: scene?.goal || text(language, "The scene plan is ready.", "Il piano della scena è pronto."),
        next: chapter && s < chapter.scenes.length
          ? text(language, `Write scene ${s + 1}.`, `Scrivere la scena ${s + 1}.`)
          : text(language, "Readers, specialists and the director review the chapter.", "Lettori, specialisti e direttore revisionano il capitolo."),
      };
    case "reader":
      return {
        title: text(language, `${params.readerName ?? "A reader"} reads chapter ${c}${quoted(chapter?.title)}`, `${params.readerName ?? "Un lettore"} legge il capitolo ${c}${quoted(chapter?.title)}`),
        reason: text(language, "Simulated readers read blind: no canon, no secrets, only the chapter.", "I lettori simulati leggono alla cieca: niente canone né segreti, solo il capitolo."),
        next: text(language, "Compare the readers' opinions.", "Confrontare le opinioni dei lettori."),
      };
    case "readers-summary":
      return {
        title: text(language, `Comparing the readers of chapter ${c}`, `Confronto dei lettori del capitolo ${c}`),
        reason: text(language, "Agreements and disagreements become proposals for the director.", "Convergenze e disaccordi diventano proposte per il direttore."),
        next: text(language, "Specialists check continuity, canon and style.", "Gli specialisti controllano continuità, canone e stile."),
      };
    case "specialists":
      return {
        title: text(language, `Specialists review chapter ${c} (round ${params.round ?? 1})`, `Gli specialisti revisionano il capitolo ${c} (giro ${params.round ?? 1})`),
        reason: text(language, "Continuity, canon, secrets, timeline, voice and style need an independent check.", "Continuità, canone, segreti, timeline, voce e stile richiedono un controllo indipendente."),
        next: text(language, "The director decides on every finding.", "Il direttore decide su ogni rilievo."),
      };
    case "director-review":
      return {
        title: text(language, `The director judges chapter ${c} (round ${params.round ?? 1})`, `Il direttore giudica il capitolo ${c} (giro ${params.round ?? 1})`),
        reason: text(language, "The director accepts or rejects every finding as the author would.", "Il direttore accetta o respinge ogni rilievo come farebbe l'autore."),
        next: text(language, "Apply the accepted fixes, or close the chapter.", "Applicare le correzioni accettate, oppure chiudere il capitolo."),
      };
    case "repair":
      return {
        title: text(language, `Applying the director's fixes to scene ${s} of chapter ${c}`, `Applicazione delle correzioni del direttore alla scena ${s} del capitolo ${c}`),
        reason: text(language, "Only fixes approved by the director are applied.", "Si applicano solo le correzioni approvate dal direttore."),
        next: text(language, "Continue with the remaining fixes or a new review round.", "Proseguire con le altre correzioni o con un nuovo giro di revisione."),
      };
    case "consolidate":
      return {
        title: text(language, `Closing chapter ${c}${quoted(chapter?.title)}`, `Chiusura del capitolo ${c}${quoted(chapter?.title)}`),
        reason: text(language, "Summary, recap, continuity and the story so far keep the next chapters consistent.", "Riassunto, recap, continuità e storia finora mantengono coerenti i capitoli successivi."),
        next: text(language, "Move to the next chapter.", "Passare al capitolo successivo."),
      };
    case "impact":
      return {
        title: text(language, "The director analyzes the impact of your revision", "Il direttore analizza l'impatto della tua revisione"),
        reason: text(language, "Only the scenes that must change are rewritten.", "Si riscrivono solo le scene che devono cambiare."),
        next: text(language, "Rewrite the affected scenes in reading order.", "Riscrivere le scene coinvolte in ordine di lettura."),
      };
    case "revise":
      return {
        title: text(language, `Rewriting scene ${s} of chapter ${c} for your revision`, `Riscrittura della scena ${s} del capitolo ${c} per la tua revisione`),
        reason: text(language, "The author asked to revise what is already written.", "L'autore ha chiesto di rivedere quanto già scritto."),
        next: text(language, "Review the revised chapters again.", "Rivedere di nuovo i capitoli modificati."),
      };
    case "final":
      return {
        title: text(language, "The director reviews the whole book", "Il direttore valuta l'intero libro"),
        reason: text(language, "Arcs, promises and open threads are checked once every chapter is approved.", "Archi, promesse e fili aperti si verificano quando tutti i capitoli sono approvati."),
        next: text(language, "The autopilot is complete.", "L'autopilot è completato."),
      };
    case "freeze":
      return {
        title: text(language, "Freezing the approved chapters", "Congelamento dei capitoli approvati"),
        reason: text(language, "A chapter approved by the director is frozen: a change you make to it afterwards is noticed, and you decide what to do with it.", "Un capitolo approvato dal direttore è congelato: una tua modifica successiva viene notata, e decidi tu cosa farne."),
        next: text(language, "Go on with the book.", "Proseguire con il libro."),
      };
  }
}

function descriptor(kind: AutopilotTaskKind, phase: AutopilotPhase, ctx: PlannerContext, params: Parameters<typeof describeTask>[2] & { reader?: string } = {}): TaskDescriptor {
  return {
    kind,
    phase,
    ...describeTask(kind, ctx.language, params),
    chapterNumber: params.chapter?.number,
    ...(kind === "summarize-imported" && params.chapter ? { chapterSlug: params.chapter.slug } : {}),
    sceneNumber: params.scene?.number,
    reader: params.reader,
    readerName: params.readerName,
    acceptsNotes: NOTE_TASKS.has(kind),
  };
}

/** Whether another batch follows this one: chapters still missing from the plan, or batches a revision has still to regenerate. */
function moreBatchesFollow(plan: AutopilotPlan | null, batch: PlanBatch): boolean {
  const present = new Set((plan?.chapters ?? []).map((chapter) => chapter.number));
  const removed = new Set(plan?.removedChapters ?? []);
  for (let number = batch.range.start; number <= batch.range.last; number += 1) {
    if (!present.has(number) && !removed.has(number) && (number < batch.from || number > batch.to)) return true;
  }
  return Boolean(plan?.revisionNotes.some((note) => !isExtensionNote(note))) && revisionBatchStarts(plan!, batch.range).some((start) => start !== batch.from);
}

/** A plan that fits one batch is one task as ever; a longer one is a task per batch, told apart by its first chapter. */
function planDescriptor(ctx: PlannerContext, plan: AutopilotPlan | null, batch: PlanBatch): TaskDescriptor {
  if (!batch.batched) return descriptor("plan", "plan", ctx, { chapters: batch.range.count });
  const task = { ...descriptor("plan", "plan", ctx, { chapters: batch.to - batch.from + 1, from: batch.from, to: batch.to }), chapterNumber: batch.from };
  return moreBatchesFollow(plan, batch) ? { ...task, next: text(ctx.language, "Plan the next chapters.", "Pianificare i capitoli successivi.") } : task;
}

function cloneState(state: AutopilotState): AutopilotState {
  return structuredClone(state);
}

function newReview(chapter: PlannedChapter, ctx: PlannerContext, readersEnabled: boolean, authorEdit = false): ChapterReview {
  return {
    chapterNumber: chapter.number,
    round: 1,
    readersPending: readersEnabled && !chapter.skipReaders ? ctx.readers.map((reader) => reader.slug) : [],
    readerScores: [],
    readersSummaryDone: false,
    findings: [],
    specialistsDone: false,
    directorDone: false,
    decisions: [],
    repairQueue: [],
    previousFixes: [],
    history: [],
    ...(authorEdit ? { authorEdit: true } : {}),
  };
}

/** Chapters already written by the author before the autopilot took over. */
export function importedChapters(snapshot: BookSnapshot): PlannedChapter[] {
  return snapshot.chapters
    .filter((chapter) => chapter.paragraphs.length > 0)
    .map((chapter) => ({
      number: chapter.number,
      title: chapter.title,
      slug: chapter.slug,
      summary: chapter.summary ?? "",
      goal: "",
      pov: chapter.pov,
      keyEvents: [],
      reveals: [],
      status: "done" as const,
      imported: true,
      scenes: chapter.paragraphs.map((paragraph) => ({
        number: paragraph.number,
        title: paragraph.title,
        goal: "",
        beats: [],
        characters: [],
        summary: paragraph.summary,
        status: "reviewed" as const,
        slug: paragraph.slug,
        path: paragraph.path,
        revisions: 0,
      })),
    }));
}

/**
 * The first chapter written by the author that has no summary yet: one a later chapter cannot be written after without a blind
 * "story so far". The chapters of the plan that are imported when there is a plan, else every chapter of the book that has prose
 * (nothing has been written by the autopilot before its plan is approved). A summary in the chapter's file counts, whatever the plan
 * says; a folder without scenes has nothing to summarize.
 */
export function nextImportedWithoutSummary(state: AutopilotState, snapshot: BookSnapshot): PlannedChapter | undefined {
  const candidates = state.plan ? state.plan.chapters.filter((chapter) => chapter.imported) : importedChapters(snapshot);
  const folders = new Map(snapshot.chapters.map((chapter) => [chapter.slug, chapter]));
  return candidates.find((chapter) => {
    const folder = folders.get(chapter.slug);
    return Boolean(folder?.paragraphs.length) && !chapter.summary.trim() && !folder?.summary;
  });
}

/** Chapters planned by one AI call: a longer plan is made of several, so that no reply outgrows the model's output. */
export const PLAN_BATCH_CHAPTERS = 20;

/** The chapters the autopilot has to plan: `count` of them from `start`, after the chapters already written in the book. */
export interface PlanRange {
  start: number;
  count: number;
  last: number;
}

/** A call of the plan task: the chapters `from` to `to`, out of a range that is `batched` when it takes more than one call. */
export interface PlanBatch {
  from: number;
  to: number;
  range: PlanRange;
  batched: boolean;
}

/**
 * The chapters the plan still has to cover: from the chapter after the last one written, to the book's last chapter. The count is taken
 * from the numbers, not from how many chapters are written: the written chapters need not be 1 to n (a book can continue at chapter 1200).
 */
export function planRange(imported: ReadonlyArray<{ number: number }>, targetChapters: number): PlanRange {
  const start = imported.reduce((highest, chapter) => Math.max(highest, chapter.number), 0) + 1;
  const count = Math.max(1, targetChapters - start + 1);
  return { start, count, last: start + count - 1 };
}

/** The first chapter of every batch of the range. */
export function planBatchStarts(range: PlanRange): number[] {
  return Array.from({ length: Math.ceil(range.count / PLAN_BATCH_CHAPTERS) }, (_, index) => range.start + index * PLAN_BATCH_CHAPTERS);
}

/** The first chapter of the batches a revision of this plan has still to regenerate: all of them when the plan does not say. */
export function revisionBatchStarts(plan: AutopilotPlan, range: PlanRange): number[] {
  const listed = (plan.revisionBatches ?? []).filter((start) => start >= range.start && start <= range.last);
  return listed.length ? listed : planBatchStarts(range);
}

/** The batches that hold the chapters a review names; all of them when a change names no chapter of the range. */
export function batchesNamed(range: PlanRange, chapterNumbers: number[]): number[] {
  if (!chapterNumbers.length || chapterNumbers.some((number) => number < range.start || number > range.last)) return planBatchStarts(range);
  return [...new Set(chapterNumbers.map((number) => range.start + Math.floor((number - range.start) / PLAN_BATCH_CHAPTERS) * PLAN_BATCH_CHAPTERS))].sort((left, right) => left - right);
}

function batchAt(range: PlanRange, from: number): PlanBatch {
  return range.count > PLAN_BATCH_CHAPTERS
    ? { from, to: Math.min(from + PLAN_BATCH_CHAPTERS - 1, range.last), range, batched: true }
    : { from: range.start, to: range.last, range, batched: false };
}

/**
 * The batch the plan task runs next, or `null` when there is nothing to plan: the first chapter of the range that is not in
 * the plan yet, else the first batch a revision still has to regenerate. A range that fits one batch is always planned
 * whole. A chapter the author took out of the outline (`removedChapters`) is not missing.
 */
export function nextPlanBatch(plan: AutopilotPlan | null, range: PlanRange): PlanBatch | null {
  if (!plan) return batchAt(range, range.start);
  if (plan.approved) return null;
  const missing = firstMissingChapter(plan.chapters, range, plan.removedChapters);
  if (missing !== undefined) return batchAt(range, missing);
  return plan.revisionNotes.length ? batchAt(range, revisionBatchStarts(plan, range)[0]) : null;
}

/** The first chapter of the range that the chapters do not have, and that was not taken out of the plan. */
export function firstMissingChapter(chapters: ReadonlyArray<{ number: number }>, range: PlanRange, removed: readonly number[] = []): number | undefined {
  const present = new Set(chapters.map((chapter) => chapter.number));
  const gone = new Set(removed);
  for (let number = range.start; number <= range.last; number += 1) if (!present.has(number) && !gone.has(number)) return number;
  return undefined;
}

/** The note `extendPlanIfNeeded` leaves when the author raises the number of chapters of a finished book. */
export function extensionNote(targetChapters: number): string {
  return `Extend the book to ${targetChapters} chapters, continuing from the chapters already written.`;
}

/** Whether a revision note only asks for the book to be extended: planning the missing chapters is all it needs. */
export function isExtensionNote(note: string): boolean {
  return /^Extend the book to \d+ chapters, continuing from the chapters already written\.$/.test(note);
}

/** Where the file of a scene is, or would be: the path the plan knows, else the name the autopilot gives its scenes. */
export function sceneFile(chapter: PlannedChapter, scene: PlannedScene): string {
  return scene.path ?? paragraphFilePath(chapter.slug, paragraphSlug(scene.number, scene.title));
}

function hasWrittenScenes(chapter: PlannedChapter): boolean {
  return chapter.scenes.some((scene) => scene.status !== "planned");
}

/** The scenes of a done chapter as its folder has them: the plan follows the files, so that renaming or moving a finished chapter never reopens it. */
function followScenes(chapter: PlannedChapter, folder: ChapterInfo): void {
  const known = new Map(chapter.scenes.map((scene) => [scene.number, scene]));
  const scenes: PlannedScene[] = [];
  for (const paragraph of folder.paragraphs) {
    if (scenes.length && scenes[scenes.length - 1].number === paragraph.number) continue;
    const scene = known.get(paragraph.number);
    scenes.push(scene
      ? { ...scene, slug: paragraph.slug, path: paragraph.path, status: scene.status === "planned" ? "reviewed" : scene.status }
      : { number: paragraph.number, title: paragraph.title, goal: "", beats: [], characters: [], summary: paragraph.summary, status: "reviewed", slug: paragraph.slug, path: paragraph.path, revisions: 0 });
  }
  chapter.scenes = scenes;
}

/**
 * The folder of every chapter of the plan. The folder the plan knows (same slug) is the chapter's. When the author renamed
 * or reordered it, the folder that starts with the chapter's number (three digits or more) takes its place and the plan adopts
 * its slug and title. Two folders with one number are never both used: the plan's own is kept (else the first by name), and
 * the other is reported and left alone, so that nothing is ever written in it. A chapter not written yet follows only a stub
 * (the folder the plan made when it was approved, renamed): a folder that has scenes is somebody's text.
 */
function matchChapterFolders(chapters: PlannedChapter[], snapshot: BookSnapshot, language: string, approved: boolean, report: (note: PlanNote) => void): Map<PlannedChapter, ChapterInfo> {
  const bySlug = new Map<string, ChapterInfo>();
  const byNumber = new Map<number, ChapterInfo[]>();
  for (const entry of snapshot.chapters) {
    if (!bySlug.has(entry.slug)) bySlug.set(entry.slug, entry);
    const number = chapterNumberFromSlug(entry.slug);
    if (number === undefined) continue;
    const same = byNumber.get(number);
    if (same) same.push(entry);
    else byNumber.set(number, [entry]);
  }
  const folders = new Map<PlannedChapter, ChapterInfo>();
  const taken = new Set<ChapterInfo>();
  const lost: PlannedChapter[] = [];
  for (const chapter of chapters) {
    if (!chapter.slug) chapter.slug = chapterSlug(chapter.number, chapter.title);
    const known = bySlug.get(chapter.slug);
    if (known) {
      folders.set(chapter, known);
      taken.add(known);
    } else lost.push(chapter);
  }
  for (const chapter of lost) {
    // A chapter with prose in the book takes a folder that has scenes; one with none takes only a stub (the folder the plan made, renamed), never somebody's text.
    const written = hasWrittenScenes(chapter);
    const candidates = (byNumber.get(chapter.number) ?? []).filter((entry) => !taken.has(entry) && (written ? entry.paragraphs.length > 0 : approved && entry.paragraphs.length === 0));
    if (!candidates.length) continue;
    const folder = candidates.reduce((first, entry) => (entry.slug < first.slug ? entry : first));
    const before = chapter.slug;
    folders.set(chapter, folder);
    taken.add(folder);
    chapter.slug = folder.slug;
    if (folder.hash) chapter.title = folder.title;
    if (chapter.status === "done" || chapter.imported) followScenes(chapter, folder);
    report({
      key: `chapter-folder:${chapter.number}:${folder.slug}`,
      tone: "info",
      title: text(language, `Chapter ${chapter.number} is now in the folder «${folder.slug}»`, `Il capitolo ${chapter.number} è ora nella cartella «${folder.slug}»`),
      detail: text(language, `The folder «${before}» is gone: the autopilot follows the chapter by its number into «${folder.slug}».`, `La cartella «${before}» non c'è più: l'autopilot segue il capitolo, dal suo numero, in «${folder.slug}».`),
    });
  }
  const reported = new Set<ChapterInfo>();
  for (const folder of folders.values()) {
    const number = chapterNumberFromSlug(folder.slug);
    if (number === undefined) continue;
    for (const other of byNumber.get(number) ?? []) {
      if (other === folder || taken.has(other) || reported.has(other)) continue;
      reported.add(other);
      report({
        key: `chapter-folder-duplicate:${other.slug}`,
        tone: "warning",
        title: text(language, `Two folders for chapter ${number}: «${folder.slug}» is used, «${other.slug}» is left alone`, `Due cartelle per il capitolo ${number}: uso «${folder.slug}», «${other.slug}» resta com'è`),
        detail: text(language, `The autopilot never writes in «${other.slug}». Rename or remove it if it is a leftover.`, `L'autopilot non scrive mai in «${other.slug}». Rinominala o eliminala se è un residuo.`),
      });
    }
  }
  return folders;
}

/**
 * Deterministic, AI-free transitions: reconcile the plan with the files the author may have
 * changed, skip what is not needed, open review cycles and advance review rounds.
 */
export function advanceState(input: AutopilotState, ctx: PlannerContext): AutopilotState {
  const state = cloneState(input);
  const { snapshot } = ctx;
  const report = ctx.report ?? (() => undefined);
  /** Scenes whose file the author removed during this pass, with the path they had. */
  const removed = new Map<string, string>();

  if (!state.concept.done && (snapshot.chapters.some((chapter) => chapter.paragraphs.length > 0) || !ctx.storyDesignThin)) {
    state.concept.done = true;
  }

  if (!state.plan && state.concept.done) {
    const imported = importedChapters(snapshot);
    if (imported.length && imported.reduce((highest, chapter) => Math.max(highest, chapter.number), 0) >= bookChapters(ctx.outline)) {
      state.plan = { chapters: imported, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
    }
  }

  if (state.plan) {
    // One lookup table instead of a scan of the snapshot per chapter: a book of thousands of chapters is advanced in linear time.
    const folders = matchChapterFolders(state.plan.chapters, snapshot, ctx.language, state.plan.approved, report);
    const editing = startedReview(state);
    for (const chapter of state.plan.chapters) {
      const files = folders.get(chapter);
      // A frozen chapter that is closed (or whose change the director is reviewing) follows its files: a scene the author deleted is a
      // change to ask about, never one to write again in silence.
      // (A chapter the revision in progress rewrites is the autopilot's until the revision is over, as any chapter it works on.)
      if (files?.frozen && !inRevision(state, chapter.number) && (chapter.status === "done" || (editing?.number === chapter.number && editing.started?.phase === "review" && chapter.status === "review"))) {
        followScenes(chapter, files);
        if (chapter.imported && !chapter.summary && files.summary) chapter.summary = files.summary;
        continue;
      }
      for (const scene of chapter.scenes) {
        if (scene.status !== "planned" && scene.path && !snapshot.files.has(scene.path)) {
          removed.set(`${chapter.number}.${scene.number}`, scene.path);
          scene.status = "planned";
          scene.path = undefined;
          scene.slug = undefined;
          scene.words = undefined;
        }
        if (scene.status === "planned" && files) {
          const existing = files.paragraphs.find((paragraph) => paragraph.number === scene.number);
          if (existing) {
            scene.status = "written";
            scene.path = existing.path;
            scene.slug = existing.slug;
            scene.summary = scene.summary ?? existing.summary;
          }
        }
      }
      // A summary the author wrote in the chapter's file reaches the plan (the story so far is built from it) without a call to the model.
      if (chapter.imported && !chapter.summary && files?.summary) chapter.summary = files.summary;
      if (chapter.imported) continue;
      const allWritten = chapter.scenes.length > 0 && chapter.scenes.every((scene) => scene.status !== "planned");
      if (chapter.status === "done" && !allWritten) chapter.status = chapter.scenes.length ? "writing" : "planned";
      if (chapter.status === "review" && !allWritten) chapter.status = chapter.scenes.length ? "writing" : "planned";
      if (chapter.status === "planned" && chapter.scenes.length) chapter.status = allWritten ? "review" : "writing";
      if (chapter.status === "writing" && allWritten) chapter.status = "review";
    }
  }

  if (state.review && state.plan) {
    const reviewed = state.plan.chapters.find((chapter) => chapter.number === state.review!.chapterNumber);
    if (!reviewed || reviewed.status !== "review") state.review = null;
    else state.review.repairQueue = state.review.repairQueue.filter((number, index, queue) => queue.indexOf(number) === index && reviewed.scenes.some((scene) => scene.number === number && scene.status !== "planned"));
  }

  if (state.revision?.targets) {
    // A rewrite whose scene is no longer in the book has nothing to rewrite: it is passed over, and the revision goes on.
    const { revision } = state;
    const targets = state.revision.targets;
    while (revision.cursor < targets.length) {
      const target = targets[revision.cursor];
      const chapter = state.plan?.chapters.find((entry) => entry.number === target.chapterNumber);
      const scene = chapter?.scenes.find((entry) => entry.number === target.sceneNumber);
      if (scene && scene.status !== "planned") break;
      const label = `${target.chapterNumber}.${target.sceneNumber}`;
      const path = chapter && scene ? removed.get(label) ?? sceneFile(chapter, scene) : undefined;
      report({
        key: `revision-target:${revision.id}:${label}`,
        tone: "warning",
        title: path
          ? text(ctx.language, `Scene ${label} no longer exists (${path}): its rewrite is skipped`, `La scena ${label} non esiste più (${path}): la sua riscrittura viene saltata`)
          : text(ctx.language, `Scene ${label} is not in the plan any more: its rewrite is skipped`, `La scena ${label} non è più nel piano: la sua riscrittura viene saltata`),
        detail: text(ctx.language, "There is nothing left to rewrite there: the revision goes on with the other scenes.", "Non c'è più nulla da riscrivere: la revisione prosegue con le altre scene."),
      });
      revision.cursor += 1;
    }
  }

  if (state.revision?.targets && state.revision.cursor >= state.revision.targets.length) {
    noteOutlineRewrite(state, state.revision);
    const affected = new Set([...state.revision.targets.map((target) => target.chapterNumber), ...(state.revision.revisedChapters ?? [])]);
    for (const chapter of state.plan?.chapters ?? []) {
      if (!affected.has(chapter.number) || !chapter.scenes.length) continue;
      // Only a chapter whose scenes are all written can be reviewed; the others finish writing first.
      const allWritten = chapter.scenes.every((scene) => scene.status !== "planned");
      chapter.status = allWritten ? "review" : "writing";
      chapter.skipReaders = true;
    }
    if (state.review && affected.has(state.review.chapterNumber)) state.review = null;
    state.revision = null;
  }

  // The decisions about the changes of frozen chapters: kept, finished, or started (the chapter goes back to review, before the plan).
  advancePendingReviews(state, snapshot, report, ctx.language, ctx.frozen);

  const current = editedChapter(state) ?? (state.plan?.approved ? state.plan.chapters.find((chapter) => chapter.status !== "done") : undefined);
  if (current?.status === "review") {
    const editing = startedReview(state);
    const authorEdit = editing?.number === current.number && editing.kind === "frozen" && editing.started?.phase === "review";
    if (!state.review || state.review.chapterNumber !== current.number) state.review = newReview(current, ctx, state.options.readers, authorEdit);
    const review = state.review;
    review.readersPending = review.readersPending.filter((slug) => ctx.readers.some((reader) => reader.slug === slug));
    if (!state.options.specialists) review.specialistsDone = true;
    // The review of the author's change is one round whose fixes are never applied: it goes to the closing, whatever the verdict.
    if (review.directorDone && review.verdict === "revise" && review.repairQueue.length === 0 && !review.authorEdit) {
      const maxRounds = ctx.director.maxReviewRounds;
      if (review.round < maxRounds) {
        review.round += 1;
        review.previousFixes = review.decisions
          .filter((decision) => decision.action === "accept" && decision.remediation)
          .map((decision) => `${decision.sceneNumber ? `Scene ${decision.sceneNumber}: ` : ""}${decision.remediation}`);
        review.findings = [];
        review.decisions = [];
        review.specialistsDone = !state.options.specialists;
        review.directorDone = false;
        review.verdict = undefined;
      } else {
        review.verdict = "approve";
        review.summary = [review.summary, isItalian(ctx.language)
          ? `Chiuso dal direttore dopo ${review.round} giri di revisione: le ultime correzioni accettate sono state applicate.`
          : `Closed by the director after ${review.round} review rounds: the last accepted fixes were applied.`].filter(Boolean).join(" ");
      }
    }
  }

  state.phase = phaseOf(state);
  return state;
}

/** The chapter of the decision being carried out, while the autopilot works on it (not closed again yet): it comes before the plan. */
function editedChapter(state: AutopilotState): PlannedChapter | undefined {
  const editing = startedReview(state);
  const chapter = editing ? state.plan?.chapters.find((entry) => entry.number === editing.number) : undefined;
  return chapter && chapter.status !== "done" ? chapter : undefined;
}

export function phaseOf(state: AutopilotState): AutopilotPhase {
  // A book that was complete stays complete while the director only reviews a change of the author's.
  if (state.finalDone && !state.plan?.chapters.some((chapter) => chapter.status !== "done")) return "completed";
  if (!state.concept.done) return "concept";
  if (!state.plan || !state.plan.approved) return "plan";
  const current = state.plan.chapters.find((chapter) => chapter.status !== "done");
  if (!current) return "final";
  return current.status === "review" ? "review" : "write";
}

/** The next AI step, or the reason to stop. Never calls AI and never mutates the state. */
export function nextStep(state: AutopilotState, ctx: PlannerContext): PlannedStep {
  const italian = isItalian(ctx.language);
  if (state.question) {
    if (isFrozenQuestion(state.question)) return { kind: "stop", status: "waiting-author", message: frozenQuestionMessage(state.question, ctx.language) };
    return { kind: "stop", status: "waiting-author", message: italian ? "Il direttore ha una domanda per te." : "The director has a question for you." };
  }

  // Without the model: the chapters an older engine approved are frozen once, and the changes marked as reviewed are frozen as they are.
  if (needsFreezeStep(state, ctx.snapshot)) return { kind: "task", task: descriptor("freeze", phaseOf(state), ctx) };

  if (state.revision) {
    if (!state.revision.targets) return { kind: "task", task: descriptor("impact", phaseOf(state), ctx) };
    const target = state.revision.targets[state.revision.cursor];
    if (target) {
      const chapter = state.plan?.chapters.find((entry) => entry.number === target.chapterNumber);
      const scene = chapter?.scenes.find((entry) => entry.number === target.sceneNumber);
      if (chapter && scene) return { kind: "task", task: descriptor("revise", "write", ctx, { chapter, scene }) };
    }
  }

  // A change of the author's being reviewed comes before the plan: its chapter is reviewed (or written again) first.
  const edited = editedChapter(state);
  if (edited) return chapterStep(edited, state, ctx);

  // The length of the book is its chapters in the outline: with none, there is nothing to plan, and the author writes them first.
  if (!state.plan?.approved && bookChapters(ctx.outline) === 0) {
    return { kind: "stop", status: "paused", message: italian ? "La Sinossi non ha capitoli: scrivi i capitoli nella Sinossi, poi riprendi." : "The synopsis has no chapters: write the chapters in the Synopsis, then resume." };
  }

  if (!state.concept.done) return { kind: "task", task: descriptor("concept", "concept", ctx) };

  const plan = state.plan;
  if (!plan || !plan.approved) {
    // Before anything is planned after them, the chapters the author wrote get the summaries the story so far is made of.
    const unsummarized = nextImportedWithoutSummary(state, ctx.snapshot);
    if (unsummarized) return { kind: "task", task: descriptor("summarize-imported", phaseOf(state), ctx, { chapter: unsummarized }) };
    const batch = nextPlanBatch(plan, planRange(importedChapters(ctx.snapshot), bookChapters(ctx.outline)));
    if (batch) return { kind: "task", task: planDescriptor(ctx, plan, batch) };
  }

  if (!plan) throw new Error("A book without a plan always has a batch to plan.");

  if (!plan.approved) {
    if (state.options.readersOnPlan && !plan.readersDone) {
      const reader = ctx.readers.find((entry) => !plan.readerReactions.some((reaction) => reaction.slug === entry.slug) && !plan.skippedReaders?.includes(entry.slug));
      if (reader) return { kind: "task", task: descriptor("plan-reader", "plan", ctx, { reader: reader.slug, readerName: reader.name }) };
    }
    return { kind: "task", task: descriptor("plan-review", "plan", ctx) };
  }

  if (plan.awaitingAuthor) {
    return { kind: "stop", status: "paused", message: italian ? "Il piano è pronto: rileggilo e riprendi quando vuoi." : "The plan is ready: read it and resume when you want." };
  }

  const chapter = plan.chapters.find((entry) => entry.status !== "done");
  if (!chapter && state.finalDone) return { kind: "stop", status: "completed", message: italian ? "Il libro è completo." : "The book is complete." };

  // ...and before anything is written, reviewed or judged after them, for a plan that was made without them.
  const unsummarized = nextImportedWithoutSummary(state, ctx.snapshot);
  if (unsummarized) return { kind: "task", task: descriptor("summarize-imported", phaseOf(state), ctx, { chapter: unsummarized }) };

  if (!chapter) return { kind: "task", task: descriptor("final", "final", ctx) };

  // The author changed (or deleted) the outline of this chapter since it was planned, and nothing of it is written: it follows the outline first.
  const outlineChange = ctx.outline?.changed?.get(chapter.number);
  if (outlineChange && !chapter.imported && !chapter.scenes.some((scene) => scene.status !== "planned")) {
    return { kind: "task", task: descriptor("replan", "write", ctx, { chapter, outline: outlineChange }) };
  }

  return chapterStep(chapter, state, ctx);
}

/** The next step of a chapter that is being written or reviewed: its scenes, its prose, its review round, its repairs, its closing. */
function chapterStep(chapter: PlannedChapter, state: AutopilotState, ctx: PlannerContext): PlannedStep {
  if (chapter.status === "planned" || !chapter.scenes.length) return { kind: "task", task: descriptor("scenes", "write", ctx, { chapter }) };

  if (chapter.status === "writing") {
    const scene = chapter.scenes.find((entry) => entry.status === "planned");
    if (scene) return { kind: "task", task: descriptor("write", "write", ctx, { chapter, scene }) };
  }

  const review = state.review;
  if (!review || review.chapterNumber !== chapter.number) {
    return { kind: "task", task: descriptor("specialists", "review", ctx, { chapter, round: 1 }) };
  }
  if (review.readersPending.length) {
    const slug = review.readersPending[0];
    const reader = ctx.readers.find((entry) => entry.slug === slug);
    return { kind: "task", task: descriptor("reader", "review", ctx, { chapter, reader: slug, readerName: reader?.name ?? slug }) };
  }
  if (review.readerScores.length && !review.readersSummaryDone) return { kind: "task", task: descriptor("readers-summary", "review", ctx, { chapter }) };
  if (!review.specialistsDone) return { kind: "task", task: descriptor("specialists", "review", ctx, { chapter, round: review.round }) };
  if (!review.directorDone) return { kind: "task", task: descriptor("director-review", "review", ctx, { chapter, round: review.round }) };
  if (review.repairQueue.length) {
    const scene = chapter.scenes.find((entry) => entry.number === review.repairQueue[0]);
    if (scene) return { kind: "task", task: descriptor("repair", "review", ctx, { chapter, scene }) };
  }
  return { kind: "task", task: descriptor("consolidate", "review", ctx, { chapter }) };
}
