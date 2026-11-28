import { referencedChapterNumber } from "../book/context.js";
import { outlineChapterPath } from "../book/paths.js";
import { serializeOutlineChapter, type OutlineReader } from "../book/outline.js";
import { readSecretLedger, type DesignCheckInput, type DesignFinding } from "../book/design.js";
import { findingText } from "../book/design-checks.js";
import { loadThreads, loadTimelineEvents } from "../book/design-load.js";
import type { BookSnapshot } from "../book/snapshot.js";
import type { BookFileChange, BookStore } from "../book/store.js";
import { parseMarkdown } from "../markdown/frontmatter.js";
import type { DirectorProfile } from "../profiles/director.js";
import { isItalian } from "../util/text.js";
import { isPlannedChapterWritten } from "./chapter-state.js";
import { readWorkflowInput } from "./design-state.js";
import { normalizeReviewPolicy } from "./review-policy.js";
import { MAX_BOOK_CHAPTERS, designActive, designMaxRounds } from "./state.js";
import { DESIGN_BATCH_CHAPTERS, type AutopilotDesign, type AutopilotState, type DesignOutcome, type DesignPolicy, type DesignStartInput } from "./types.js";

/**
 * The design run of the autopilot (`AutopilotDesign`): what a start asks of it, the rules of its reviews, how it ends. The steps are the autopilot's own (`concept`,
 * `plan`, `plan-reader`, `plan-review`), with the prompts of a design (`design-prompts.ts`); this module holds what decides, and is pure.
 */

/** The chapters of a design when neither the start nor the Synopsis says how many. */
export const DESIGN_DEFAULT_CHAPTERS = 12;
/** The most chapters a design run is asked for at once: a longer book is designed in more runs, or from a Synopsis that already has its entries. */
export const DESIGN_MAX_CHAPTERS = 500;

export type AutopilotDesignErrorCode = "invalid_request" | "design_written" | "design_no_description";

/**
 * A design run that cannot begin: what was asked is not one (`invalid_request`), the autopilot has already written chapters of the book (`design_written`: a design is
 * for a book whose chapters are not written yet), or the book has no description to design it from (`design_no_description`).
 */
export class AutopilotDesignError extends Error {
  constructor(readonly code: AutopilotDesignErrorCode, message: string) {
    super(message);
    this.name = "AutopilotDesignError";
  }
}

/**
 * What a start says of a design (`StartOptions.design`), checked: `true` or an object begins one (`DesignStartInput`), `false` ends the one that goes on, nothing says
 * nothing. Throws `AutopilotDesignError` (`invalid_request`) for anything else: a misspelt key would design a book other than the one asked.
 */
export function normalizeDesignStart(value: unknown): DesignStartInput | false | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === false) return false;
  if (value === true) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new AutopilotDesignError("invalid_request", "design must be true, false or { chapters?, review? }.");
  const source = value as Record<string, unknown>;
  const unknown = Object.keys(source).filter((key) => key !== "chapters" && key !== "review" && key !== "workflow");
  if (unknown.length) throw new AutopilotDesignError("invalid_request", `design does not take ${unknown.map((key) => `«${key}»`).join(", ")}: it takes chapters, review and workflow.`);
  const input: DesignStartInput = {};
  if (source.chapters !== undefined) {
    const chapters = source.chapters;
    if (typeof chapters !== "number" || !Number.isSafeInteger(chapters) || chapters < 1 || chapters > DESIGN_MAX_CHAPTERS) {
      throw new AutopilotDesignError("invalid_request", `design.chapters must be a whole number from 1 to ${DESIGN_MAX_CHAPTERS}.`);
    }
    input.chapters = chapters;
  }
  if (source.review !== undefined) {
    if (source.review !== null && (typeof source.review !== "object" || Array.isArray(source.review))) throw new AutopilotDesignError("invalid_request", "design.review must be { targetScore?, maxRounds?, readerRounds? } or null.");
    if (source.review && Object.keys(source.review).some((key) => key !== "targetScore" && key !== "maxRounds" && key !== "readerRounds")) {
      throw new AutopilotDesignError("invalid_request", "design.review takes targetScore, maxRounds and readerRounds.");
    }
    input.review = source.review as DesignStartInput["review"];
  }
  if (source.workflow !== undefined) {
    if (source.workflow === null) input.workflow = null;
    else {
      const read = readWorkflowInput(source.workflow);
      if ("error" in read) throw new AutopilotDesignError("invalid_request", read.error);
      input.workflow = read.workflow;
    }
  }
  return input;
}

/** The chapters of the plan the autopilot has written prose for (the author's own, `imported`, do not count). */
export function chaptersWrittenByAutopilot(state: Pick<AutopilotState, "plan">): number[] {
  return (state.plan?.chapters ?? []).filter((chapter) => !chapter.imported && isPlannedChapterWritten(chapter)).map((chapter) => chapter.number);
}

function policyOf(update: DesignStartInput["review"], base: DesignPolicy | undefined): DesignPolicy | undefined {
  if (update === null) return undefined;
  const policy = normalizeReviewPolicy(update ?? {}, base);
  if (!policy) return undefined;
  const { targetScore, maxRounds, readerRounds } = policy;
  const design: DesignPolicy = {};
  if (targetScore !== undefined) design.targetScore = targetScore;
  if (maxRounds !== undefined) design.maxRounds = maxRounds;
  if (readerRounds !== undefined) design.readerRounds = readerRounds;
  return Object.keys(design).length ? design : undefined;
}

/**
 * The state a start makes when it asks for a design (`StartOptions.design`), and the chapters the book is designed with. A design that goes on goes on (its policy and
 * its chapters as the start says them now); a new one begins with its reviews at zero, and a plan the director had approved is reviewed again. `options.pauseAfterPlan`
 * is turned on while the design goes on (`AutopilotDesign.pauseAfterPlan` keeps the author's). Throws `AutopilotDesignError` when the autopilot has written chapters
 * of the book, or the book has no description.
 */
export function beginDesign(state: AutopilotState, input: DesignStartInput, context: { now: string; outlineChapters: number; idea: string; language?: string }): { state: AutopilotState; chapters: number } {
  const italian = isItalian(context.language);
  const written = chaptersWrittenByAutopilot(state);
  if (written.length) {
    throw new AutopilotDesignError("design_written", italian
      ? `L'autopilot ha già scritto ${written.length === 1 ? "il capitolo" : "i capitoli"} ${written.join(", ")}: la progettazione è per un libro i cui capitoli non sono ancora scritti.`
      : `The autopilot has already written chapter${written.length === 1 ? "" : "s"} ${written.join(", ")}: a design is for a book whose chapters are not written yet.`);
  }
  if (!context.idea.trim()) {
    throw new AutopilotDesignError("design_no_description", italian
      ? "Il libro non ha una descrizione: scrivila nella Sinossi, poi progetta il libro."
      : "The book has no description: write it in the Synopsis, then design the book.");
  }
  const previous = state.design;
  const going = designActive(state) ? previous : undefined;
  const asked = input.chapters ?? going?.chapters ?? (context.outlineChapters || DESIGN_DEFAULT_CHAPTERS);
  const chapters = Math.min(MAX_BOOK_CHAPTERS, Math.max(context.outlineChapters, Math.min(DESIGN_MAX_CHAPTERS, Math.max(1, asked))));
  const review = policyOf(input.review, previous?.review);
  const next: AutopilotState = structuredClone(state);
  const pauseAfterPlan = going?.pauseAfterPlan ?? state.options.pauseAfterPlan;
  next.options = { ...next.options, pauseAfterPlan: true };
  const workflow = input.workflow === null ? undefined : input.workflow ?? previous?.workflow;
  const design: AutopilotDesign = {
    startedAt: going?.startedAt ?? context.now,
    chapters,
    ...(review ? { review } : {}),
    rounds: going?.rounds ?? [],
    ...(going?.escalated ? { escalated: true } : {}),
    pauseAfterPlan,
    ...(previous?.ledgers ? { ledgers: previous.ledgers } : {}),
    ...(workflow && Object.keys(workflow).length ? { workflow } : {}),
    ...(previous?.rubric ? { rubric: previous.rubric } : {}),
    ...(previous?.reviewed ? { reviewed: previous.reviewed } : {}),
  };
  next.design = design;
  if (!going && next.plan) {
    // A new design: the plan is reviewed again from its first round (a plan approved before is reopened; nothing of it is written).
    const { revisionBatches: _batches, ...plan } = next.plan;
    next.plan = { ...plan, approved: false, awaitingAuthor: false, rounds: 0, readersDone: false, readerReactions: [], revisionNotes: plan.approved ? [] : plan.revisionNotes };
    delete next.plan.skippedReaders;
    // The room of the wildcards looks at a new design again, before its first review.
    delete next.plan.wildcardsDone;
    delete next.plan.wildcardsMaterial;
  }
  return { state: next, chapters };
}

/**
 * The empty entries (the autopilot's, `origin: autopilot` and no text) the Synopsis gets after its last entry up to `chapters`: the book has that many chapters, and the
 * plan fills them. None when the Synopsis reaches that far already.
 */
export function designPlaceholderChanges(outlineChapters: number, chapters: number): BookFileChange[] {
  const changes: BookFileChange[] = [];
  for (let number = outlineChapters + 1; number <= chapters; number += 1) {
    changes.push({ path: outlineChapterPath(number), content: serializeOutlineChapter({ number, origin: "autopilot" }), expectedHash: null });
  }
  return changes;
}

/** The design ends (`outcome`, at `now`): the run stops there, and `options.pauseAfterPlan` is the author's again. Mutates `state`. */
export function endDesign(state: AutopilotState, outcome: DesignOutcome, now: string): void {
  const design = state.design;
  if (!design || design.endedAt) return;
  if (typeof design.pauseAfterPlan === "boolean") state.options = { ...state.options, pauseAfterPlan: design.pauseAfterPlan };
  const { pauseAfterPlan: _pause, ...rest } = design;
  state.design = { ...rest, endedAt: now, outcome };
  // A revision of the plan that waits was cut in the batches of a design: the plan that goes on is cut in its own.
  if (state.plan?.revisionBatches) delete state.plan.revisionBatches;
}

/** Chapters one call of the plan takes: fewer while a design goes on, for a design says much more of every chapter. */
export function planBatchChapters(state: Pick<AutopilotState, "design"> | null | undefined, plain: number): number {
  return designActive(state) ? DESIGN_BATCH_CHAPTERS : plain;
}

/** The vote a design must reach: its policy's, else the director's approval score. */
export function designTarget(state: Pick<AutopilotState, "design">, director: Pick<DirectorProfile, "approvalScore">): number {
  return state.design?.review?.targetScore ?? director.approvalScore;
}

/** In how many of the first reviews of a design the simulated readers read it first: its policy's, else the first only. */
export function designReaderRounds(state: Pick<AutopilotState, "design">): number {
  return state.design?.review?.readerRounds ?? 1;
}

/** Whether the next review of the design is its last: the rounds of its policy are used once it is done. */
export function designLastRound(state: Pick<AutopilotState, "design" | "plan">): boolean {
  return (state.plan?.rounds ?? 0) >= designMaxRounds(state.design) - 1;
}

/**
 * Whether the reviews of a design have stopped improving: in the last two reviews, neither raised the best vote of the ones before it (the rule of the reviews of the
 * book). Needs three reviews at least.
 */
export function designPlateau(design: Pick<AutopilotDesign, "rounds"> | undefined): boolean {
  const scores = (design?.rounds ?? []).map((round) => round.score);
  if (scores.length < 3) return false;
  const best = (list: number[]) => list.reduce((most, score) => Math.max(most, score), Number.NEGATIVE_INFINITY);
  const before = best(scores.slice(0, -2));
  return scores[scores.length - 2] <= before && scores[scores.length - 1] <= Math.max(before, scores[scores.length - 2]);
}

/**
 * What the deterministic checks of a design read (`designChecks`), from the book: every entry of the Synopsis with its design, every secret with its ledger and
 * its reveal (`reveal_in`, else the chapter the plan reveals it in, else `known_from`), the cast and the places of the canon.
 */
export async function loadDesignCheckInput(store: BookStore, snapshot: BookSnapshot, outline: OutlineReader, state: Pick<AutopilotState, "concept" | "plan">): Promise<DesignCheckInput> {
  const entries = await outline.chapters();
  const planned = new Map(state.concept.secrets.map((secret) => [secret.slug, secret.revealChapter]));
  const secrets = await Promise.all(snapshot.canon.filter((entry) => entry.kind === "secret").map(async (entry) => {
    const file = await store.read(entry.path);
    const frontmatter = file ? parseMarkdown(file.content).frontmatter : {};
    const holders = Array.isArray(frontmatter.holders) ? frontmatter.holders.filter((item): item is string => typeof item === "string") : [];
    const reveal = referencedChapterNumber(entry.revealIn) ?? planned.get(entry.slug) ?? referencedChapterNumber(entry.knownFrom);
    const knownFrom = referencedChapterNumber(entry.knownFrom);
    return {
      slug: entry.slug,
      title: entry.name,
      holders,
      ledger: readSecretLedger(frontmatter).ledger,
      ...(reveal ? { revealChapter: reveal } : {}),
      ...(knownFrom ? { knownFromChapter: knownFrom } : {}),
    };
  }));
  const canonOf = (kind: "character" | "location") => snapshot.canon.filter((entry) => entry.kind === kind).map((entry) => ({ slug: entry.slug, name: entry.name, aliases: entry.aliases }));
  const lastPlanned = (state.plan?.chapters ?? []).reduce((highest, chapter) => Math.max(highest, chapter.number), 0);
  const [timeline, threads] = await Promise.all([loadTimelineEvents(store, snapshot), loadThreads(store)]);
  return {
    chapters: entries.map((entry) => ({ number: entry.number, title: entry.title, ...(entry.design ? { design: entry.design } : {}) })),
    secrets,
    characters: canonOf("character"),
    locations: canonOf("location"),
    timeline,
    threads,
    lastChapter: Math.max(outline.last, lastPlanned),
  };
}

/** Findings told in an insight, at most: the rest are counted. */
const FINDINGS_IN_INSIGHT = 8;

/** The insight that tells the findings of the checks of a design: the warnings first. `null` when there is none. */
export function designFindingsInsight(findings: readonly DesignFinding[], language: string): { tone: "info" | "warning"; title: string; detail: string } | null {
  if (!findings.length) return null;
  const italian = isItalian(language);
  const ordered = [...findings].sort((left, right) => (left.severity === right.severity ? 0 : left.severity === "warning" ? -1 : 1));
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const shown = ordered.slice(0, FINDINGS_IN_INSIGHT).map((finding) => `- ${findingText(finding, language)}`);
  const more = findings.length - shown.length;
  return {
    tone: warnings ? "warning" : "info",
    title: italian
      ? `I controlli del progetto hanno trovato ${findings.length === 1 ? "una cosa" : `${findings.length} cose`} da guardare`
      : `The checks of the design found ${findings.length === 1 ? "one thing" : `${findings.length} things`} to look at`,
    detail: [...shown, ...(more > 0 ? [italian ? `- … e altre ${more}.` : `- … and ${more} more.`] : [])].join("\n"),
  };
}
