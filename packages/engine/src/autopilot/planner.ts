import type { BookSnapshot, ChapterInfo } from "../book/snapshot.js";
import { chapterNumberFromSlug, chapterSlug, paragraphFilePath, paragraphSlug } from "../book/paths.js";
import type { DirectorProfile } from "../profiles/director.js";
import { countWords, isItalian } from "../util/text.js";
import { advancePendingReviews, frozenQuestionMessage, inRevision, isFrozenQuestion, needsFreezeStep, noteOutlineRewrite, startedReview, type PlannerFrozen } from "./frozen.js";
import { bookRoundText } from "./book-round.js";
import { advanceRevisionCampaign, campaignChapter, chapterVote } from "./campaign.js";
import { readerGate, reviewMaxRounds, reviewReaderRounds, reviewWildcards, type ReaderTargets } from "./review-policy.js";
import { blockersText, readerStanding } from "./review-readers.js";
import { planBatchChapters } from "./design.js";
import { nextDesignReview, nextPitchStep } from "./design-flow.js";
import { designActive } from "./state.js";
import type { AutopilotInsightFigures, AutopilotMessageCode, AutopilotPhase, AutopilotPlan, AutopilotState, AutopilotTaskKind, ChapterReview, InsightTone, PlannedChapter, PlannedScene } from "./types.js";

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
  /** The numbers it is about (`AutopilotInsightFigures`). */
  figures?: AutopilotInsightFigures;
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
  | { kind: "stop"; status: "paused" | "waiting-author" | "completed"; message: string; code?: AutopilotMessageCode };

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
/** What the steps of a design run say (`AutopilotDesign`): the same steps as a plan, told as the design of the book they are. */
function describeDesignTask(kind: AutopilotTaskKind, language: string, params: { readerName?: string; chapters?: number; from?: number; to?: number }): Pick<TaskDescriptor, "title" | "reason" | "next"> | null {
  switch (kind) {
    case "concept":
      return {
        title: text(language, "Designing the book: premise, cast, world and secrets", "Progettazione del libro: premessa, personaggi, mondo e segreti"),
        reason: text(language, "The design starts from your description: the story, the characters and their arcs, the places, the rules of the world and the secrets.", "La progettazione parte dalla tua descrizione: la storia, i personaggi e i loro archi, i luoghi, le regole del mondo e i segreti."),
        next: text(language, "Design the chapters.", "Progettare i capitoli."),
      };
    case "plan": {
      const batch = params.from !== undefined && params.to !== undefined ? { from: params.from, to: params.to } : null;
      const one = batch?.from === batch?.to;
      return {
        title: batch
          ? text(language, one ? `Designing chapter ${batch.from}` : `Designing chapters ${batch.from}-${batch.to}`, one ? `Progettazione del capitolo ${batch.from}` : `Progettazione dei capitoli ${batch.from}-${batch.to}`)
          : text(language, `Designing ${params.chapters ?? ""} chapters`.replace("  ", " "), `Progettazione di ${params.chapters ?? ""} capitoli`.replace("  ", " ")),
        reason: text(language, "Every chapter gets its design (goal, point of view, events, scenes, conflicts, reveals, clues, ending), and every secret its ledger: no prose is written.", "Ogni capitolo riceve il suo progetto (obiettivo, punto di vista, eventi, scene, conflitti, rivelazioni, indizi, chiusura) e ogni segreto il suo registro: non si scrive prosa."),
        next: text(language, "The simulated readers and the director review the design.", "I lettori simulati e il direttore valutano il progetto."),
      };
    }
    case "plan-reader":
      return {
        title: text(language, `${params.readerName ?? "A reader"} reads the design`, `${params.readerName ?? "Un lettore"} legge il progetto`),
        reason: text(language, "The readers judge engagement, originality, pace, suspense and credibility, and must propose something better.", "I lettori giudicano coinvolgimento, originalità, ritmo, suspense e credibilità, e devono proporre qualcosa di meglio."),
        next: text(language, "The director decides on the design.", "Il direttore decide sul progetto."),
      };
    case "plan-review":
      return {
        title: text(language, "The director reviews the design", "Il direttore valuta il progetto"),
        reason: text(language, "The director approves the design, or asks for changes chapter by chapter; a critical inconsistency is fixed or asked to you.", "Il direttore approva il progetto, o chiede modifiche capitolo per capitolo; un'incoerenza critica si corregge o si chiede a te."),
        next: text(language, "The design waits for you: approve it, or start writing.", "Il progetto ti aspetta: approvalo, o inizia a scrivere."),
      };
    default:
      return null;
  }
}

export function describeTask(kind: AutopilotTaskKind, language: string, params: { chapter?: PlannedChapter; scene?: PlannedScene; readerName?: string; round?: number; chapters?: number; from?: number; to?: number; outline?: "changed" | "removed"; design?: boolean; reading?: "end" | "check" }): Pick<TaskDescriptor, "title" | "reason" | "next"> {
  const chapter = params.chapter;
  const scene = params.scene;
  const c = chapter?.number ?? 0;
  const s = scene?.number ?? 0;
  if (params.design) {
    const told = describeDesignTask(kind, language, params);
    if (told) return told;
  }
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
    case "design-chapter-review": {
      const batch = params.from !== undefined && params.to !== undefined ? { from: params.from, to: params.to } : null;
      const one = batch?.from === batch?.to;
      return {
        title: batch
          ? text(language, one ? `Reviewing the design of chapter ${batch.from}` : `Reviewing the design of chapters ${batch.from}-${batch.to}`, one ? `Revisione del progetto del capitolo ${batch.from}` : `Revisione del progetto dei capitoli ${batch.from}-${batch.to}`)
          : text(language, "Reviewing the design of the chapters", "Revisione del progetto dei capitoli"),
        reason: text(language, "The director, the ghostwriter who will write them and the readers judge every chapter with the chapters beside it, on the twelve criteria.", "Il direttore, il ghostwriter che li scriverà e i lettori giudicano ogni capitolo insieme ai capitoli accanto, sui dodici criteri."),
        next: text(language, "The director reviews the whole design.", "Il direttore valuta l'intero progetto."),
      };
    }
    case "design-pitches":
      return {
        title: text(language, "The Brainstormer proposes alternative pitches", "Il Brainstormer propone pitch alternativi"),
        reason: text(language, "Several different books can come from your idea: the Brainstormer proposes them before the design begins.", "Dalla tua idea possono nascere libri diversi: il Brainstormer li propone prima che la progettazione cominci."),
        next: text(language, "The readers and the director judge the pitches.", "I lettori e il direttore giudicano i pitch."),
      };
    case "design-pitch-review":
      return {
        title: text(language, "The readers and the director judge the pitches", "I lettori e il direttore giudicano i pitch"),
        reason: text(language, "Every pitch is scored on the twelve criteria, and one is chosen with its reason.", "Ogni pitch è valutato sui dodici criteri, e uno viene scelto con la sua motivazione."),
        next: text(language, "Design the book from the chosen pitch.", "Progettare il libro dal pitch scelto."),
      };
    case "design-coherence":
      return {
        title: text(language, "Analysing the whole structure of the design", "Analisi dell'intera struttura del progetto"),
        reason: text(language, "A story editor reads every chapter together for contradictions, plot holes, timeline problems, characters who act against themselves, repeated events, abandoned subplots and what is revealed too early.", "Un editor legge tutti i capitoli insieme per trovare contraddizioni, buchi di trama, problemi di cronologia, personaggi che agiscono contro se stessi, eventi ripetuti, sottotrame abbandonate e rivelazioni troppo presto."),
        next: text(language, "The director reviews the whole design.", "Il direttore valuta l'intero progetto."),
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
      // A reading of their own (after the corrections, or to know their vote): said as it is, so that nobody takes it for a repeat.
      if (params.reading) {
        return {
          title: text(language, `${params.readerName ?? "A reader"} reads chapter ${c}${quoted(chapter?.title)} again`, `${params.readerName ?? "Un lettore"} rilegge il capitolo ${c}${quoted(chapter?.title)}`),
          reason: params.reading === "end"
            ? text(language, "The chapter was corrected: the readers read it as it is, to see whether their targets are met.", "Il capitolo è stato corretto: i lettori lo leggono com'è ora, per vedere se i loro obiettivi sono raggiunti.")
            : text(language, "The review of the book needs the readers' vote on the chapter as it is: the director has nothing to add to it yet.", "La revisione del libro ha bisogno del voto dei lettori sul capitolo com'è ora: il direttore non ha ancora nulla da aggiungere."),
          next: text(language, "Compare their votes with their targets.", "Confrontare i loro voti con gli obiettivi."),
        };
      }
      return {
        title: text(language, `${params.readerName ?? "A reader"} reads chapter ${c}${quoted(chapter?.title)}`, `${params.readerName ?? "Un lettore"} legge il capitolo ${c}${quoted(chapter?.title)}`),
        reason: text(language, "Simulated readers read blind: no canon, no secrets, only the chapter.", "I lettori simulati leggono alla cieca: niente canone né segreti, solo il capitolo."),
        next: text(language, "Compare the readers' opinions.", "Confrontare le opinioni dei lettori."),
      };
    case "readers-summary":
      if (params.reading) {
        return {
          title: text(language, `Comparing the readers of chapter ${c} again`, `Nuovo confronto dei lettori del capitolo ${c}`),
          reason: text(language, "Their votes are checked against the targets, and what they still ask for goes to the director.", "I loro voti si confrontano con gli obiettivi, e ciò che chiedono ancora va al direttore."),
          next: text(language, "The chapter is closed, or the director makes another round of corrections.", "Il capitolo si chiude, oppure il direttore fa un altro giro di correzioni."),
        };
      }
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
    case "wildcards":
      return {
        title: text(language, "The wildcards look at the design", "I Fuori dal coro guardano il progetto"),
        reason: text(language, "Before the director's review, a few voices from outside the choir say why the book could fail and what would make it better; the director triages their ideas, and only the accepted ones go on, into the review.", "Prima della valutazione del direttore, alcune voci fuori dal coro dicono perché il libro potrebbe fallire e cosa lo renderebbe migliore; il direttore vaglia le loro idee, e solo quelle accolte proseguono, nella valutazione."),
        next: text(language, "The director reviews the design.", "Il direttore valuta il progetto."),
      };
    case "book-corrections":
      return {
        title: text(language, "The director lists the corrections of the whole book", "Il direttore elenca le correzioni del libro intero"),
        reason: text(language, "Every chapter has its targets and the book does not: the director says which chapters to change, what to change in each and why.", "Ogni capitolo ha i suoi obiettivi e il libro no: il direttore dice quali capitoli cambiare, cosa cambiare in ciascuno e perché."),
        next: text(language, "The corrections are carried out chapter by chapter, then the book is judged again.", "Le correzioni vengono eseguite capitolo per capitolo, poi il libro viene giudicato di nuovo."),
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
function moreBatchesFollow(plan: AutopilotPlan | null, batch: PlanBatch, size = PLAN_BATCH_CHAPTERS): boolean {
  const present = new Set((plan?.chapters ?? []).map((chapter) => chapter.number));
  const removed = new Set(plan?.removedChapters ?? []);
  for (let number = batch.range.start; number <= batch.range.last; number += 1) {
    if (!present.has(number) && !removed.has(number) && (number < batch.from || number > batch.to)) return true;
  }
  return Boolean(plan?.revisionNotes.some((note) => !isExtensionNote(note))) && revisionBatchStarts(plan!, batch.range, size).some((start) => start !== batch.from);
}

/** A plan that fits one batch is one task as ever; a longer one is a task per batch, told apart by its first chapter. */
function planDescriptor(ctx: PlannerContext, plan: AutopilotPlan | null, batch: PlanBatch, size = PLAN_BATCH_CHAPTERS, design = false): TaskDescriptor {
  if (!batch.batched) return descriptor("plan", "plan", ctx, { chapters: batch.range.count, design });
  const task = { ...descriptor("plan", "plan", ctx, { chapters: batch.to - batch.from + 1, from: batch.from, to: batch.to, design }), chapterNumber: batch.from };
  if (!moreBatchesFollow(plan, batch, size)) return task;
  return { ...task, next: design ? text(ctx.language, "Design the next chapters.", "Progettare i capitoli successivi.") : text(ctx.language, "Plan the next chapters.", "Pianificare i capitoli successivi.") };
}

function cloneState(state: AutopilotState): AutopilotState {
  return structuredClone(state);
}

/**
 * What a review of the chapter that has targets for the readers (`gated`) begins with: the readers read it first (unless the review skips them), and a `check` (a review of
 * the book that wants the vote of a chapter the director is content with) is only their reading: the director has nothing to decide until it shows a target is missed.
 */
function newReview(chapter: PlannedChapter, ctx: PlannerContext, readersEnabled: boolean, authorEdit = false, gated?: { check: boolean }): ChapterReview {
  const readers = readersEnabled && (!chapter.skipReaders || gated?.check === true) ? ctx.readers.map((reader) => reader.slug) : [];
  const check = gated?.check === true && readers.length > 0;
  return {
    chapterNumber: chapter.number,
    round: 1,
    readersPending: readers,
    ...(readers.length && !check ? { readersRound: 1 } : {}),
    ...(readers.length && gated ? { readText: 0 } : {}),
    ...(check ? { reading: "check" as const } : {}),
    readerScores: [],
    readersSummaryDone: false,
    findings: [],
    specialistsDone: check,
    directorDone: check,
    ...(check ? { verdict: "approve" as const } : {}),
    decisions: [],
    repairQueue: [],
    previousFixes: [],
    history: [],
    ...(authorEdit ? { authorEdit: true } : {}),
  };
}

/** Where the review of a chapter that is under way stands against the readers' targets: the votes the readers gave, as the targets read them. */
function readersStanding(review: ChapterReview, gate: ReaderTargets) {
  return readerStanding(review.readerScores.map((score) => ({ slug: score.slug, score: score.score })), gate);
}

/**
 * The end of the review of a chapter that has targets for the readers (`ReviewPolicy.readersTarget`, `readerTargets`): once the director approved and nothing waits to be
 * repaired, the readers read the chapter again if what they said is of the text before the corrections (the closing reading), and the chapter is closed when every target
 * is met. When one is not, the readers' corrections go to the director in another round, while the rounds allowed last and the corrections get closer to the targets; else
 * the chapter is closed all the same, and it says what stood in the way (`gateStop`). Idempotent: it is read again at every step until the chapter is closed.
 */
function advanceReadersGate(state: AutopilotState, chapter: PlannedChapter, review: ChapterReview, ctx: PlannerContext, report: (note: PlanNote) => void): void {
  const gate = readerGate(state, ctx.readers.map((reader) => reader.slug));
  if (!gate || review.authorEdit) return;
  if (!review.directorDone || review.verdict !== "approve" || review.repairQueue.length) return;
  if (review.readersPending.length || (review.readerScores.length && !review.readersSummaryDone)) return;
  const repairs = review.repairs ?? 0;
  if (review.readText !== repairs) {
    // What they said is of the text before the corrections (or they have not read it in this review): they read it as it is.
    review.readersPending = ctx.readers.map((reader) => reader.slug);
    review.readerScores = [];
    review.readersSummaryDone = false;
    review.readText = repairs;
    review.readRecorded = false;
    review.reading = "end";
    return;
  }
  const names = (slug: string) => ctx.readers.find((reader) => reader.slug === slug)?.name ?? slug;
  if (!review.readerScores.length) {
    report({
      key: `readers-unread:${chapter.number}:${review.round}:${chapter.rounds?.length ?? 0}`,
      tone: "warning",
      title: text(ctx.language, `No simulated reader gave a vote on chapter ${chapter.number}: their targets could not be checked`, `Nessun lettore simulato ha votato il capitolo ${chapter.number}: non ho potuto verificare i loro obiettivi`),
    });
    if (review.reading === "check") finishCheck(state, chapter);
    return;
  }
  const standing = readersStanding(review, gate);
  if (!standing.blockers.length) {
    if (review.reading === "check") finishCheck(state, chapter);
    return;
  }
  const previous = review.reads?.[review.reads.length - 1];
  if (review.round >= reviewMaxRounds(state, ctx.director) && review.reading !== "check") {
    review.gateStop = "rounds";
    return;
  }
  if (previous !== undefined && standing.shortfall >= previous) {
    review.gateStop = "plateau";
    return;
  }
  report({
    key: `readers-again:${chapter.number}:${review.round}:${review.reads?.length ?? 0}:${chapter.rounds?.length ?? 0}`,
    tone: "info",
    title: text(ctx.language, `Chapter ${chapter.number} is not there yet for the readers: ${blockersText(standing.blockers, ctx.language, names)}. Another round of corrections.`, `Il capitolo ${chapter.number} non è ancora arrivato per i lettori: ${blockersText(standing.blockers, ctx.language, names)}. Un altro giro di correzioni.`),
  });
  // Another round: the director reads the readers' corrections (the proposals of the closing reading stay among the findings) with what it fixed before; the readers do not
  // read again before it: they have just read the text as it is.
  const wasCheck = review.reading === "check";
  review.reads = [...(review.reads ?? []), standing.shortfall];
  if (!wasCheck) review.round += 1;
  review.previousFixes = review.decisions
    .filter((decision) => decision.action === "accept" && decision.remediation)
    .map((decision) => `${decision.sceneNumber ? `Scene ${decision.sceneNumber}: ` : ""}${decision.remediation}`);
  review.findings = review.findings.filter((finding) => finding.source === "reader");
  review.decisions = [];
  review.specialistsDone = !state.options.specialists;
  review.directorDone = false;
  review.verdict = undefined;
  review.reading = undefined;
}

/** A check of the readers' vote that found every target met: the chapter is as it was, closed again with no round and no closing of the text. */
function finishCheck(state: AutopilotState, chapter: PlannedChapter): void {
  chapter.status = "done";
  delete chapter.skipReaders;
  state.review = null;
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

/**
 * The first chapter of every batch of the range. `size` is the chapters of a batch: `PLAN_BATCH_CHAPTERS`, or `DESIGN_BATCH_CHAPTERS` while a design goes on
 * (`planBatchChapters`).
 */
export function planBatchStarts(range: PlanRange, size = PLAN_BATCH_CHAPTERS): number[] {
  return Array.from({ length: Math.ceil(range.count / size) }, (_, index) => range.start + index * size);
}

/** The first chapter of the batches a revision of this plan has still to regenerate: all of them when the plan does not say. */
export function revisionBatchStarts(plan: AutopilotPlan, range: PlanRange, size = PLAN_BATCH_CHAPTERS): number[] {
  const listed = (plan.revisionBatches ?? []).filter((start) => start >= range.start && start <= range.last);
  return listed.length ? listed : planBatchStarts(range, size);
}

/** The batches that hold the chapters a review names; all of them when a change names no chapter of the range. */
export function batchesNamed(range: PlanRange, chapterNumbers: number[], size = PLAN_BATCH_CHAPTERS): number[] {
  if (!chapterNumbers.length || chapterNumbers.some((number) => number < range.start || number > range.last)) return planBatchStarts(range, size);
  return [...new Set(chapterNumbers.map((number) => range.start + Math.floor((number - range.start) / size) * size))].sort((left, right) => left - right);
}

function batchAt(range: PlanRange, from: number, size = PLAN_BATCH_CHAPTERS): PlanBatch {
  return range.count > size
    ? { from, to: Math.min(from + size - 1, range.last), range, batched: true }
    : { from: range.start, to: range.last, range, batched: false };
}

/**
 * The batch the plan task runs next, or `null` when there is nothing to plan: the first chapter of the range that is not in
 * the plan yet, else the first batch a revision still has to regenerate. A range that fits one batch is always planned
 * whole. A chapter the author took out of the outline (`removedChapters`) is not missing.
 */
export function nextPlanBatch(plan: AutopilotPlan | null, range: PlanRange, size = PLAN_BATCH_CHAPTERS): PlanBatch | null {
  if (!plan) return batchAt(range, range.start, size);
  if (plan.approved) return null;
  const missing = firstMissingChapter(plan.chapters, range, plan.removedChapters);
  if (missing !== undefined) return batchAt(range, missing, size);
  return plan.revisionNotes.length ? batchAt(range, revisionBatchStarts(plan, range, size)[0], size) : null;
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
  // The chapters the author asked to revise now, for one reason, in order: the one being worked finished, the next started (before the plan).
  advanceRevisionCampaign(state, report, ctx.language, ctx.frozen && { ...ctx.frozen, readers: ctx.readers.map((reader) => reader.slug) });
  // A review of the book that waits for the author: the run stops (`nextStep`), and starting it again releases it.

  const current = editedChapter(state) ?? (state.plan?.approved ? state.plan.chapters.find((chapter) => chapter.status !== "done") : undefined);
  if (current?.status === "review") {
    const editing = startedReview(state);
    const authorEdit = editing?.number === current.number && editing.kind === "frozen" && editing.started?.phase === "review";
    if (!state.review || state.review.chapterNumber !== current.number) {
      // With targets for the readers, a chapter that a review of the book takes up only for their vote (the director's is at the target already) is first read by them alone.
      const gate = readerGate(state, ctx.readers.map((reader) => reader.slug));
      const target = state.campaign?.reason === "review-target" ? state.campaign.review?.targetScore : undefined;
      const vote = chapterVote(current);
      const check = Boolean(gate && !authorEdit && target !== undefined && vote !== null && vote >= target && campaignChapter(state)?.number === current.number);
      state.review = newReview(current, ctx, state.options.readers, authorEdit, gate ? { check } : undefined);
    }
    const review = state.review;
    review.readersPending = review.readersPending.filter((slug) => ctx.readers.some((reader) => reader.slug === slug));
    if (!state.options.specialists) review.specialistsDone = true;
    // The review of the author's change is one round whose fixes are never applied: it goes to the closing, whatever the verdict.
    if (review.directorDone && review.verdict === "revise" && review.repairQueue.length === 0 && !review.authorEdit) {
      // The rounds of the review policy (`options.review`, or the review of the book in progress), else the director's.
      const maxRounds = reviewMaxRounds(state, ctx.director);
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
        // The simulated readers read the chapter again in the first rounds the policy says (the first only, unless the author asked for more).
        if (state.options.readers && !current.skipReaders && review.round <= reviewReaderRounds(state) && ctx.readers.length) {
          review.readersPending = ctx.readers.map((reader) => reader.slug);
          review.readerScores = [];
          review.readersSummaryDone = false;
          review.readersRound = review.round;
          // Their votes are those of the new reading, which a round of the director records.
          if (readerGate(state, ctx.readers.map((reader) => reader.slug))) review.readText = review.repairs ?? 0;
          delete review.readRecorded;
        }
      } else {
        review.verdict = "approve";
        review.summary = [review.summary, isItalian(ctx.language)
          ? `Chiuso dal direttore dopo ${review.round} giri di revisione: le ultime correzioni accettate sono state applicate.`
          : `Closed by the director after ${review.round} review rounds: the last accepted fixes were applied.`].filter(Boolean).join(" ");
      }
    }
    // The readers' targets, when the review has them: the closing reading, and the chapter closed only when they are met (or the rounds, or a plateau, say otherwise).
    if (state.review === review) advanceReadersGate(state, current, review, ctx, report);
  }

  state.phase = phaseOf(state);
  return state;
}

/** The chapter of the decision being carried out, or of the campaign, while the autopilot works on it (not closed again yet): it comes before the plan. */
function editedChapter(state: AutopilotState): PlannedChapter | undefined {
  const editing = startedReview(state);
  const chapter = editing ? state.plan?.chapters.find((entry) => entry.number === editing.number) : undefined;
  return chapter && chapter.status !== "done" ? chapter : campaignChapter(state);
}

export function phaseOf(state: AutopilotState): AutopilotPhase {
  // A review of the book in a book-level round: the director is judging the whole book, whatever the chapters say.
  if (state.campaign?.review?.phase === "book") return "final";
  // A book that was complete stays complete while the director only reviews a change of the author's.
  if (state.finalDone && !state.plan?.chapters.some((chapter) => chapter.status !== "done")) return "completed";
  if (!state.concept.done) return "concept";
  if (!state.plan || !state.plan.approved) return "plan";
  const current = state.plan.chapters.find((chapter) => chapter.status !== "done");
  if (!current) return "final";
  return current.status === "review" ? "review" : "write";
}

/** What the run says when a review of the design on request is done: what it found. */
function designReviewedMessage(state: AutopilotState, italian: boolean): string {
  const design = state.design!;
  const chosen = design.reviewing?.chapters;
  const weak = (chosen ?? Object.keys(design.reviewed ?? {}).map(Number)).filter((number) => design.reviewed?.[String(number)]?.verdict === "revise").length;
  const open = design.coherence?.findings.filter((finding) => finding.status === "open" || finding.status === "fixing").length ?? 0;
  if (chosen) {
    const which = chosen.length === 1 ? `${italian ? "del capitolo" : "of chapter"} ${chosen[0]}` : `${italian ? "dei capitoli" : "of chapters"} ${chosen.join(", ")}`;
    return italian ? `Revisione del progetto ${which} completata: ${weak ? `${weak} con punti deboli` : "nessun punto debole"}.` : `Review of the design ${which} done: ${weak ? `${weak} with weak points` : "no weak point"}.`;
  }
  return italian
    ? `Revisione del progetto completata: ${open === 1 ? "un problema aperto" : `${open} problemi aperti`}, ${weak === 1 ? "un capitolo" : `${weak} capitoli`} con punti deboli.`
    : `Review of the design done: ${open === 1 ? "one open finding" : `${open} open findings`}, ${weak === 1 ? "one chapter" : `${weak} chapters`} with weak points.`;
}

/** What the run says when the design is ready: how many chapters, and what to do next. */
function designReadyMessage(state: AutopilotState, italian: boolean): string {
  const chapters = state.plan?.chapters.filter((chapter) => !chapter.imported).length ?? 0;
  return italian
    ? `Il progetto del libro è pronto: ${chapters === 1 ? "1 capitolo" : `${chapters} capitoli`}. Approvalo, o avvia l'autopilot per scrivere.`
    : `The design of the book is ready: ${chapters === 1 ? "1 chapter" : `${chapters} chapters`}. Approve it, or start the autopilot to write.`;
}

/** The next AI step, or the reason to stop. Never calls AI and never mutates the state. */
export function nextStep(state: AutopilotState, ctx: PlannerContext): PlannedStep {
  const italian = isItalian(ctx.language);
  // A review of the design on request (`AutopilotDesign.reviewing`): the chapters not judged as they are, then the analysis of the structure, and the run stops. It does nothing else, whatever waits.
  if (state.design?.reviewing) {
    const review = nextDesignReview(state, ctx.snapshot);
    if (review?.kind === "design-coherence") return { kind: "task", task: descriptor(review.kind, "plan", ctx) };
    if (review) return { kind: "task", task: { ...descriptor(review.kind, "plan", ctx, { from: review.from, to: review.to }), chapterNumber: review.from } };
    return { kind: "stop", status: "paused", message: designReviewedMessage(state, italian), code: "designReviewed" };
  }
  // A campaign held for the author (the rounds of a review of the book the author allowed are done): nothing goes on until the author starts the run again.
  if (state.campaign?.held && !state.revision && !state.review) {
    return { kind: "stop", status: "paused", message: state.campaign.held.message || (italian ? "La revisione aspetta te: riavvia l'autopilot per continuare." : "The review waits for you: start the autopilot again to go on."), code: "reviewHeld" };
  }
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

  // A book-level round of a review of the book: the director is asked for the corrections of the whole book, or the run stops for the author to decide on them.
  const bookRound = state.campaign?.reason === "review-target" && state.campaign.review?.phase === "book" ? state.campaign.review.book : undefined;
  if (bookRound?.status === "asking") return { kind: "task", task: descriptor("book-corrections", "final", ctx) };
  if (bookRound?.status === "proposed") {
    const told = bookRoundText(ctx.language, "proposed", { score: bookRound.verdict.score, target: state.campaign!.review!.targetScore, count: bookRound.corrections.length, chapters: new Set(bookRound.corrections.map((correction) => correction.chapter)).size });
    return { kind: "stop", status: "paused", message: told.title, code: "bookRoundProposed" };
  }

  // A change of the author's being reviewed comes before the plan: its chapter is reviewed (or written again) first.
  const edited = editedChapter(state);
  if (edited) return chapterStep(edited, state, ctx);

  // The length of the book is its chapters in the outline: with none, there is nothing to plan, and the author writes them first.
  if (!state.plan?.approved && bookChapters(ctx.outline) === 0) {
    return { kind: "stop", status: "paused", message: italian ? "La Sinossi non ha capitoli: scrivi i capitoli nella Sinossi, poi riprendi." : "The synopsis has no chapters: write the chapters in the Synopsis, then resume." };
  }

  if (!state.concept.done) {
    // A design with alternatives proposes them, has them judged and takes the choice before it designs anything.
    const pitch = designActive(state) ? nextPitchStep(state) : null;
    if (pitch === "pitches") return { kind: "task", task: descriptor("design-pitches", "concept", ctx) };
    if (pitch === "review") return { kind: "task", task: descriptor("design-pitch-review", "concept", ctx) };
    if (pitch === "choose") return { kind: "stop", status: "waiting-author", message: italian ? "Scegli il pitch da cui progettare il libro." : "Choose the pitch the book is designed from.", code: "designPitchChoice" };
    return { kind: "task", task: descriptor("concept", "concept", ctx) };
  }

  const plan = state.plan;
  const designing = designActive(state);
  const batchSize = planBatchChapters(state, PLAN_BATCH_CHAPTERS);
  if (!plan || !plan.approved) {
    // Before anything is planned after them, the chapters the author wrote get the summaries the story so far is made of.
    const unsummarized = nextImportedWithoutSummary(state, ctx.snapshot);
    if (unsummarized) return { kind: "task", task: descriptor("summarize-imported", phaseOf(state), ctx, { chapter: unsummarized }) };
    const batch = nextPlanBatch(plan, planRange(importedChapters(ctx.snapshot), bookChapters(ctx.outline)), batchSize);
    if (batch) return { kind: "task", task: planDescriptor(ctx, plan, batch, batchSize, designing) };
  }

  if (!plan) throw new Error("A book without a plan always has a batch to plan.");

  if (!plan.approved) {
    if (state.options.readersOnPlan && !plan.readersDone) {
      const reader = ctx.readers.find((entry) => !plan.readerReactions.some((reaction) => reaction.slug === entry.slug) && !plan.skippedReaders?.includes(entry.slug));
      if (reader) return { kind: "task", task: descriptor("plan-reader", "plan", ctx, { reader: reader.slug, readerName: reader.name, design: designing }) };
    }
    // A design run asks the room of the wildcards once, before the review of its plan, when the review policy turns it on: the director triages what it gives.
    if (designing && !plan.wildcardsDone && reviewWildcards(state).design) return { kind: "task", task: descriptor("wildcards", "plan", ctx, { design: true }) };
    // The chapters of a design that changed since they were reviewed are reviewed, before the director looks at the whole.
    const review = designing ? nextDesignReview(state, ctx.snapshot) : null;
    if (review?.kind === "design-coherence") return { kind: "task", task: descriptor(review.kind, "plan", ctx) };
    if (review) return { kind: "task", task: { ...descriptor(review.kind, "plan", ctx, { from: review.from, to: review.to }), chapterNumber: review.from } };
    return { kind: "task", task: descriptor("plan-review", "plan", ctx, { design: designing }) };
  }

  // A design run never goes past its plan: whatever left it approved, it stops here and waits for the author.
  if (designing) return { kind: "stop", status: "paused", message: designReadyMessage(state, italian), code: "designReady" };

  if (plan.awaitingAuthor) {
    if (state.design?.endedAt && state.design.outcome !== "author") return { kind: "stop", status: "paused", message: designReadyMessage(state, italian), code: "designReady" };
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
    return { kind: "task", task: descriptor("reader", "review", ctx, { chapter, reader: slug, readerName: reader?.name ?? slug, ...(review.reading ? { reading: review.reading } : {}) }) };
  }
  if (review.readerScores.length && !review.readersSummaryDone) return { kind: "task", task: descriptor("readers-summary", "review", ctx, { chapter, ...(review.reading ? { reading: review.reading } : {}) }) };
  if (!review.specialistsDone) return { kind: "task", task: descriptor("specialists", "review", ctx, { chapter, round: review.round }) };
  if (!review.directorDone) return { kind: "task", task: descriptor("director-review", "review", ctx, { chapter, round: review.round }) };
  if (review.repairQueue.length) {
    const scene = chapter.scenes.find((entry) => entry.number === review.repairQueue[0]);
    if (scene) return { kind: "task", task: descriptor("repair", "review", ctx, { chapter, scene }) };
  }
  return { kind: "task", task: descriptor("consolidate", "review", ctx, { chapter }) };
}
