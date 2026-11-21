import type { BookSnapshot } from "../book/snapshot.js";
import { chapterSlug } from "../book/paths.js";
import type { DirectorProfile } from "../profiles/director.js";
import { isItalian } from "../util/text.js";
import type { AutopilotPhase, AutopilotPlan, AutopilotState, AutopilotTaskKind, ChapterReview, PlannedChapter, PlannedScene } from "./types.js";

export interface PlannerReader {
  slug: string;
  name: string;
}

export interface PlannerContext {
  snapshot: BookSnapshot;
  director: DirectorProfile;
  /** Enabled simulated readers, in panel order, already capped. */
  readers: PlannerReader[];
  language: string;
  /** The story design is still the empty scaffold. */
  storyDesignThin: boolean;
}

export interface TaskDescriptor {
  kind: AutopilotTaskKind;
  phase: AutopilotPhase;
  title: string;
  reason: string;
  next: string;
  chapterNumber?: number;
  sceneNumber?: number;
  reader?: string;
  readerName?: string;
  /** Pending "next step" author notes are delivered to this task. */
  acceptsNotes: boolean;
}

export type PlannedStep =
  | { kind: "task"; task: TaskDescriptor }
  | { kind: "stop"; status: "paused" | "waiting-author" | "completed"; message: string };

const NOTE_TASKS = new Set<AutopilotTaskKind>(["concept", "plan", "scenes", "write", "repair", "revise", "consolidate"]);

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
export function describeTask(kind: AutopilotTaskKind, language: string, params: { chapter?: PlannedChapter; scene?: PlannedScene; readerName?: string; round?: number; chapters?: number; from?: number; to?: number }): Pick<TaskDescriptor, "title" | "reason" | "next"> {
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
  }
}

function descriptor(kind: AutopilotTaskKind, phase: AutopilotPhase, ctx: PlannerContext, params: Parameters<typeof describeTask>[2] & { reader?: string } = {}): TaskDescriptor {
  return {
    kind,
    phase,
    ...describeTask(kind, ctx.language, params),
    chapterNumber: params.chapter?.number,
    sceneNumber: params.scene?.number,
    reader: params.reader,
    readerName: params.readerName,
    acceptsNotes: NOTE_TASKS.has(kind),
  };
}

/** Whether another batch follows this one: chapters still missing from the plan, or batches a revision has still to regenerate. */
function moreBatchesFollow(plan: AutopilotPlan | null, batch: PlanBatch): boolean {
  const present = new Set((plan?.chapters ?? []).map((chapter) => chapter.number));
  for (let number = batch.range.start; number <= batch.range.last; number += 1) {
    if (!present.has(number) && (number < batch.from || number > batch.to)) return true;
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

function newReview(chapter: PlannedChapter, ctx: PlannerContext, readersEnabled: boolean): ChapterReview {
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

export function planRange(imported: ReadonlyArray<{ number: number }>, targetChapters: number): PlanRange {
  const start = imported.reduce((highest, chapter) => Math.max(highest, chapter.number), 0) + 1;
  const count = Math.max(1, targetChapters - imported.length);
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
 * whole.
 */
export function nextPlanBatch(plan: AutopilotPlan | null, range: PlanRange): PlanBatch | null {
  if (!plan) return batchAt(range, range.start);
  if (plan.approved) return null;
  const missing = firstMissingChapter(plan.chapters, range);
  if (missing !== undefined) return batchAt(range, missing);
  return plan.revisionNotes.length ? batchAt(range, revisionBatchStarts(plan, range)[0]) : null;
}

/** The first chapter of the range that the chapters do not have. */
export function firstMissingChapter(chapters: ReadonlyArray<{ number: number }>, range: PlanRange): number | undefined {
  const present = new Set(chapters.map((chapter) => chapter.number));
  for (let number = range.start; number <= range.last; number += 1) if (!present.has(number)) return number;
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

/**
 * Deterministic, AI-free transitions: reconcile the plan with the files the author may have
 * changed, skip what is not needed, open review cycles and advance review rounds.
 */
export function advanceState(input: AutopilotState, ctx: PlannerContext): AutopilotState {
  const state = cloneState(input);
  const { snapshot } = ctx;

  if (!state.concept.done && (snapshot.chapters.some((chapter) => chapter.paragraphs.length > 0) || !ctx.storyDesignThin)) {
    state.concept.done = true;
  }

  if (!state.plan && state.concept.done) {
    const imported = importedChapters(snapshot);
    if (imported.length && imported.length >= state.brief.targetChapters) {
      state.plan = { chapters: imported, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
    }
  }

  if (state.plan) {
    // One lookup table instead of a scan of the snapshot per chapter: a book of thousands of chapters is advanced in linear time.
    const filesBySlug = new Map<string, BookSnapshot["chapters"][number]>();
    for (const entry of snapshot.chapters) if (!filesBySlug.has(entry.slug)) filesBySlug.set(entry.slug, entry);
    for (const chapter of state.plan.chapters) {
      if (!chapter.slug) chapter.slug = chapterSlug(chapter.number, chapter.title);
      const files = filesBySlug.get(chapter.slug);
      for (const scene of chapter.scenes) {
        if (scene.status !== "planned" && scene.path && !snapshot.files.has(scene.path)) {
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

  if (state.revision?.targets && state.revision.cursor >= state.revision.targets.length) {
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

  const current = state.plan?.approved ? state.plan.chapters.find((chapter) => chapter.status !== "done") : undefined;
  if (current?.status === "review") {
    if (!state.review || state.review.chapterNumber !== current.number) state.review = newReview(current, ctx, state.options.readers);
    const review = state.review;
    review.readersPending = review.readersPending.filter((slug) => ctx.readers.some((reader) => reader.slug === slug));
    if (!state.options.specialists) review.specialistsDone = true;
    if (review.directorDone && review.verdict === "revise" && review.repairQueue.length === 0) {
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

export function phaseOf(state: AutopilotState): AutopilotPhase {
  if (state.finalDone) return "completed";
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
    return { kind: "stop", status: "waiting-author", message: italian ? "Il direttore ha una domanda per te." : "The director has a question for you." };
  }

  if (state.revision) {
    if (!state.revision.targets) return { kind: "task", task: descriptor("impact", phaseOf(state), ctx) };
    const target = state.revision.targets[state.revision.cursor];
    if (target) {
      const chapter = state.plan?.chapters.find((entry) => entry.number === target.chapterNumber);
      const scene = chapter?.scenes.find((entry) => entry.number === target.sceneNumber);
      if (chapter && scene) return { kind: "task", task: descriptor("revise", "write", ctx, { chapter, scene }) };
    }
  }

  if (!state.concept.done) return { kind: "task", task: descriptor("concept", "concept", ctx) };

  const plan = state.plan;
  if (!plan || !plan.approved) {
    const batch = nextPlanBatch(plan, planRange(importedChapters(ctx.snapshot), state.brief.targetChapters));
    if (batch) return { kind: "task", task: planDescriptor(ctx, plan, batch) };
  }

  if (!plan) throw new Error("A book without a plan always has a batch to plan.");

  if (!plan.approved) {
    if (state.options.readersOnPlan && !plan.readersDone) {
      const reader = ctx.readers.find((entry) => !plan.readerReactions.some((reaction) => reaction.slug === entry.slug));
      if (reader) return { kind: "task", task: descriptor("plan-reader", "plan", ctx, { reader: reader.slug, readerName: reader.name }) };
    }
    return { kind: "task", task: descriptor("plan-review", "plan", ctx) };
  }

  if (plan.awaitingAuthor) {
    return { kind: "stop", status: "paused", message: italian ? "Il piano è pronto: rileggilo e riprendi quando vuoi." : "The plan is ready: read it and resume when you want." };
  }

  const chapter = plan.chapters.find((entry) => entry.status !== "done");
  if (!chapter) {
    if (!state.finalDone) return { kind: "task", task: descriptor("final", "final", ctx) };
    return { kind: "stop", status: "completed", message: italian ? "Il libro è completo." : "The book is complete." };
  }

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
