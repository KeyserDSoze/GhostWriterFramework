import {
  DESIGN_ALTERNATIVES_MAX,
  DESIGN_ALTERNATIVES_MIN,
  DESIGN_CRITERIA,
  DESIGN_WEAK_SCORE,
  rubricTrend,
  serverSupportsDesignReview,
  type AutopilotDesign,
  type AutopilotState,
  type CoherenceFinding,
  type CoherenceSeverity,
  type DesignCriterionScore,
  type DesignPitch,
  type DesignPitchEvaluation,
  type DesignRubricSubject,
  type DesignStartInput,
  type DesignWorkflow,
  type ServerInfo,
} from "narrarium-engine";

/**
 * What the Studio shows of the reviews of a design (`AutopilotDesign.alternatives`, `rubric`, `reviewed`, `coherence`): the alternative pitches and the choice, the rubric of every
 * subject that was judged with how its scores went, and the findings of the analysis of the structure with what the author can do about each. Pure: nothing is read here
 * but the state, and the same state says the same.
 */

/** The release of the personal server that has the reviews of a design (`autopilot-design-review`). */
export const DESIGN_REVIEW_SERVER_VERSION = "0.1.28";

/** Whether the personal server announces the reviews of a design. A browser run has them always. */
export function serverHasDesignReview(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverSupportsDesignReview(info);
}

// ─── The workflow of the dialog ───────────────────────────────────────────────

/** What the dialog «Design the book» asks of the reviews. */
export interface WorkflowForm {
  alternatives: boolean;
  /** How many pitches, as it is typed. */
  alternativeCount: string;
  /** Who chooses among them. */
  pitchChoice: "director" | "author";
  chapterReview: boolean;
  coherence: boolean;
  rubric: boolean;
}

/** What the dialog offers first: all the reviews, three pitches, the director chooses. */
export const DEFAULT_WORKFLOW_FORM: WorkflowForm = { alternatives: true, alternativeCount: "3", pitchChoice: "director", chapterReview: true, coherence: true, rubric: true };

export const ALTERNATIVES_MIN = DESIGN_ALTERNATIVES_MIN;
export const ALTERNATIVES_MAX = DESIGN_ALTERNATIVES_MAX;

/** The form a design that went on says (`AutopilotDesign.workflow`): what it did is what the dialog offers again; a design that did none of it offers the defaults. */
export function workflowFormOf(design: Pick<AutopilotDesign, "workflow"> | null | undefined): WorkflowForm {
  const workflow = design?.workflow;
  if (!workflow) return DEFAULT_WORKFLOW_FORM;
  return {
    alternatives: (workflow.alternatives ?? 0) >= ALTERNATIVES_MIN,
    alternativeCount: String(workflow.alternatives ?? 3),
    pitchChoice: workflow.pitchChoice === "author" ? "author" : "director",
    chapterReview: workflow.chapterReview === true,
    coherence: workflow.coherence === true,
    rubric: workflow.rubric === true,
  };
}

export type WorkflowProblem = "alternatives";

/**
 * What the form asks of the reviews, checked: the workflow to send (`undefined` when the personal server cannot take it: the design is then the plain one) and what is wrong with
 * the form. The alternatives are proposed only for a book whose concept is not made (`alternativesAllowed`).
 */
export function readWorkflowForm(form: WorkflowForm, options: { supported: boolean; alternativesAllowed: boolean }): { workflow: DesignWorkflow | undefined; problem: WorkflowProblem | null } {
  if (!options.supported) return { workflow: undefined, problem: null };
  const typed = Number(form.alternativeCount.trim());
  const asked = form.alternatives && options.alternativesAllowed;
  const problem = asked && (!form.alternativeCount.trim() || !Number.isInteger(typed) || typed < ALTERNATIVES_MIN || typed > ALTERNATIVES_MAX) ? "alternatives" : null;
  const workflow: DesignWorkflow = {};
  if (form.rubric) workflow.rubric = true;
  if (form.chapterReview) workflow.chapterReview = true;
  if (form.coherence) workflow.coherence = true;
  if (asked && !problem) {
    workflow.alternatives = typed;
    if (form.pitchChoice === "author") workflow.pitchChoice = "author";
  }
  return { workflow, problem };
}

// ─── The alternatives ─────────────────────────────────────────────────────────

export interface PitchJudgement {
  /** `director`, or the slug of a reader. */
  by: string;
  name: string;
  overall: number | null;
  scores: Array<number | null>;
  note: string;
}

export interface PitchView {
  pitch: DesignPitch;
  /** The director's judgement and the readers' mean, when they judged. */
  director: PitchJudgement | null;
  readers: PitchJudgement[];
  readersMean: number | null;
  chosen: boolean;
  recommended: boolean;
}

export interface AlternativesView {
  pitches: PitchView[];
  /** The pitch the design is made of, who chose it and why. */
  selected: { id: string; by: "director" | "author"; reason: string; at: string } | null;
  recommended: { id: string; reason: string } | null;
  /** The director recommended one and the author has not chosen: the run waits for her. */
  waiting: boolean;
  /** A pitch can still be chosen: the concept is not made of one yet. */
  choosable: boolean;
}

const judgement = (evaluation: DesignPitchEvaluation): PitchJudgement => ({ by: evaluation.by, name: evaluation.name, overall: evaluation.overall, scores: evaluation.scores, note: evaluation.note });

/** The alternatives of the design as the Studio shows them; `null` when it proposed none. */
export function alternativesViewOf(state: Pick<AutopilotState, "design" | "concept"> | null | undefined): AlternativesView | null {
  const design = state?.design;
  const alternatives = design?.alternatives;
  if (!alternatives?.pitches.length) return null;
  const selected = alternatives.selected ?? null;
  const pitches = alternatives.pitches.map((pitch): PitchView => {
    const judged = (alternatives.evaluations[pitch.id] ?? []).map(judgement);
    const readers = judged.filter((entry) => entry.by !== "director");
    const scored = readers.map((entry) => entry.overall).filter((value): value is number => value !== null);
    return {
      pitch,
      director: judged.find((entry) => entry.by === "director") ?? null,
      readers,
      readersMean: scored.length ? Math.round((scored.reduce((sum, value) => sum + value, 0) / scored.length) * 10) / 10 : null,
      chosen: selected?.id === pitch.id,
      recommended: alternatives.recommended?.id === pitch.id,
    };
  });
  const choosable = !state?.concept.done;
  return { pitches, selected, recommended: alternatives.recommended ?? null, waiting: Boolean(alternatives.recommended) && !selected && choosable, choosable };
}

// ─── The rubric ───────────────────────────────────────────────────────────────

export type RubricSubjectKind = "design" | "reader" | "chapter" | "pitch";

export interface RubricReviewView {
  round: number;
  overall: number | null;
  at: string;
}

export interface RubricSubjectView {
  key: string;
  kind: RubricSubjectKind;
  /** The slug of a reader, the number of a chapter, the id of a pitch: absent for the design. */
  id?: string;
  chapter?: number;
  overall: number | null;
  /** The twelve scores of the latest review, in the order of `DESIGN_CRITERIA` (`null`: it did not apply). */
  scores: Array<number | null>;
  /** The overall of the review before the latest, and how the overall moved since the first review. */
  previous: number | null;
  trend: number | null;
  history: RubricReviewView[];
  /** The criteria under par, with what the judge said (whole for the design, a reader and a pitch; the weak ones only for a chapter). */
  weak: DesignCriterionScore[];
  /** Every criterion of the latest review, with its reason: only for the subjects that keep it whole (not for a chapter). */
  criteria: DesignCriterionScore[] | null;
}

function subjectView(key: string, subject: DesignRubricSubject): RubricSubjectView | null {
  const match = /^(design|reader|chapter|pitch)(?::(.+))?$/.exec(key);
  const latest = subject.history[subject.history.length - 1];
  if (!match || !latest) return null;
  const kind = match[1] as RubricSubjectKind;
  const before = subject.history.length > 1 ? subject.history[subject.history.length - 2] : undefined;
  return {
    key,
    kind,
    ...(match[2] ? { id: match[2] } : {}),
    ...(kind === "chapter" ? { chapter: Number(match[2]) } : {}),
    overall: latest.overall,
    scores: latest.scores,
    previous: before?.overall ?? null,
    trend: rubricTrend(subject),
    history: subject.history.map((entry) => ({ round: entry.round, overall: entry.overall, at: entry.at })),
    weak: subject.latest.filter((entry) => entry.score !== null && entry.score < DESIGN_WEAK_SCORE).sort((left, right) => (left.score ?? 0) - (right.score ?? 0)),
    criteria: kind === "chapter" ? null : subject.latest,
  };
}

export interface RubricView {
  design: RubricSubjectView | null;
  readers: RubricSubjectView[];
  chapters: RubricSubjectView[];
  pitches: RubricSubjectView[];
}

/** The subjects that were judged, grouped: the design, the readers, the chapters in order and the pitches. `null` when nothing was judged on the rubric. */
export function rubricViewOf(state: Pick<AutopilotState, "design"> | null | undefined): RubricView | null {
  const rubric = state?.design?.rubric;
  if (!rubric) return null;
  const subjects = Object.entries(rubric).map(([key, subject]) => subjectView(key, subject)).filter((view): view is RubricSubjectView => view !== null);
  if (!subjects.length) return null;
  return {
    design: subjects.find((subject) => subject.kind === "design") ?? null,
    readers: subjects.filter((subject) => subject.kind === "reader").sort((left, right) => (left.id ?? "").localeCompare(right.id ?? "")),
    chapters: subjects.filter((subject) => subject.kind === "chapter").sort((left, right) => (left.chapter ?? 0) - (right.chapter ?? 0)),
    pitches: subjects.filter((subject) => subject.kind === "pitch").sort((left, right) => (left.id ?? "").localeCompare(right.id ?? "")),
  };
}

/** The chapter reviews that said «revise», and how many chapters were reviewed. */
export function chapterReviewCounts(design: Pick<AutopilotDesign, "reviewed"> | null | undefined): { reviewed: number; weak: number } {
  const reviews = Object.values(design?.reviewed ?? {}).filter((review) => review.overall !== null);
  return { reviewed: reviews.length, weak: reviews.filter((review) => review.verdict === "revise").length };
}

/** The name a reader has: the one the readers' reactions of the plan carry, else its slug. */
export function readerNameOf(state: Pick<AutopilotState, "plan"> | null | undefined, slug: string): string {
  return state?.plan?.readerReactions.find((reaction) => reaction.slug === slug)?.name ?? slug;
}

/** The scores of a subject as the pairs of the criteria with their score: what a table of twelve rows says. */
export function criterionRows(scores: ReadonlyArray<number | null>): Array<{ criterion: (typeof DESIGN_CRITERIA)[number]; score: number | null; weak: boolean }> {
  return DESIGN_CRITERIA.map((criterion, index) => ({ criterion, score: scores[index] ?? null, weak: (scores[index] ?? 10) < DESIGN_WEAK_SCORE }));
}

// ─── The findings ─────────────────────────────────────────────────────────────

export interface FindingView {
  finding: CoherenceFinding;
  /** The chapters it is about, told: `2, 3`, or nothing for the whole book. */
  where: number[];
  /** What the author can do about it now. */
  canFix: boolean;
  canTake: boolean;
  canDismiss: boolean;
  canReopen: boolean;
}

export interface FindingsView {
  /** When the structure was analysed, and what the analysis said of it as a whole. */
  analysedAt: string;
  summary: string;
  /** Still to decide, the critical ones first. */
  open: FindingView[];
  /** The author asked the autopilot to fix them: the next design run does it. */
  fixing: FindingView[];
  /** The author took them. */
  mine: FindingView[];
  dismissed: FindingView[];
  fixed: FindingView[];
  counts: Record<CoherenceSeverity, number>;
}

const ORDER: Record<CoherenceSeverity, number> = { critical: 0, major: 1, minor: 2 };

function findingView(finding: CoherenceFinding): FindingView {
  return {
    finding,
    where: finding.chapters,
    canFix: finding.owner !== "author" && finding.status !== "fixing" && finding.status !== "fixed",
    canTake: finding.status !== "mine" && finding.status !== "fixed",
    canDismiss: finding.status !== "dismissed" && finding.status !== "fixed",
    canReopen: finding.status === "mine" || finding.status === "dismissed" || finding.status === "fixing",
  };
}

/** The findings of the analysis as the Studio shows them; `null` when the structure was never analysed. */
export function findingsViewOf(state: Pick<AutopilotState, "design"> | null | undefined): FindingsView | null {
  const coherence = state?.design?.coherence;
  if (!coherence) return null;
  const views = coherence.findings.map(findingView).sort((left, right) => ORDER[left.finding.severity] - ORDER[right.finding.severity] || (left.finding.chapters[0] ?? 0) - (right.finding.chapters[0] ?? 0));
  const inStatus = (status: CoherenceFinding["status"]) => views.filter((view) => view.finding.status === status);
  const open = inStatus("open");
  return {
    analysedAt: coherence.at,
    summary: coherence.summary,
    open,
    fixing: inStatus("fixing"),
    mine: inStatus("mine"),
    dismissed: inStatus("dismissed"),
    fixed: inStatus("fixed"),
    counts: { critical: open.filter((view) => view.finding.severity === "critical").length, major: open.filter((view) => view.finding.severity === "major").length, minor: open.filter((view) => view.finding.severity === "minor").length },
  };
}

/** Whether a finding is for the author alone: every chapter it revises is hers, so that the autopilot only proposes. */
export function findingIsAuthors(finding: Pick<CoherenceFinding, "owner">): boolean {
  return finding.owner === "author";
}

// ─── What can be asked of the reviews now ─────────────────────────────────────

/** Why a review of the design on request cannot begin now, or `null`: the book needs chapters, no design run may go on, and the server must have the reviews. */
export type ReviewBlock = "chapters" | "running" | "server" | "designing";

export function reviewBlockOf(input: { chapters: number; running: boolean; designing: boolean; serverWithoutReview: boolean }): ReviewBlock | null {
  if (input.serverWithoutReview) return "server";
  if (input.chapters < 1) return "chapters";
  if (input.designing) return "designing";
  if (input.running) return "running";
  return null;
}

/** The `design` of a start that asks for a review on request of the whole design (no chapter) or of chosen chapters. */
export function reviewRequest(chapters?: readonly number[]): DesignStartInput {
  return { reviewOnly: chapters?.length ? { chapters: [...chapters].sort((left, right) => left - right) } : {} };
}
