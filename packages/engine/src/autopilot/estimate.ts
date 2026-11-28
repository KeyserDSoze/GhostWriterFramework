import type { AiRuntimeConfig } from "../ai/config.js";
import { likelyTextTokens, resolveModelTokenBudgets } from "../ai/budget.js";
import { normalizePromptCaching } from "../ai/config.js";
import { servedFromCache } from "../ai/prompt-cache.js";
import { resolveAiCandidates } from "../ai/router.js";
import { REASONING_OUTPUT_MARGIN, STRUCTURED_OUTPUT_FLOOR, isReasoningModel } from "../ai/token-limit.js";
import { AI_CAPABILITIES } from "../ai/types.js";
import type { AiJsonSchema } from "../ai/types.js";
import { DIRECTOR_OPINION_TOOL, directorSystemPrompt } from "../director/opinion.js";
import { currentRequest, untrustedData } from "../prompt/trust.js";
import { brainstormerPrompt, defaultBrainstormer } from "../profiles/brainstormer.js";
import { defaultDirector, directorPrompt } from "../profiles/director.js";
import { builtinReaderPersonas, readerPersonaSystemPrompt } from "../profiles/readers.js";
import { READER_EVALUATION_TOOL, READER_SUMMARY_TOOL } from "../readers/evaluation.js";
import { asInteger, asNumber, asRecord } from "../util/json.js";
import { OUTPUT_TOKENS_CEILING, countWords, isItalian, languageCode, scaleOutputTokens, tokensPerWord } from "../util/text.js";
import { coherenceWindows } from "./design-coherence.js";
import { COHERENCE_WINDOW, DESIGN_REVIEW_BATCH_CHAPTERS } from "./design-review-types.js";
import { designRubricRule } from "./design-rubric.js";
import { designFlow, normalizeWorkflow, type DesignFlow } from "./design-state.js";
import { sumCappedRamp, sumWindowedList, windowedList } from "./estimate-math.js";
import { estimateTexts } from "./estimate-texts.js";
import { PLAN_BATCH_CHAPTERS, SCENES_PER_CHAPTER, bookChapters } from "./planner.js";
import {
  CHAPTER_REVIEW_TOOL, CHAPTER_SUMMARY_TOOL, CONCEPT_TOOL, CONSOLIDATION_TOOL, DESIGN_CHAPTER_REVIEW_TOOL, DESIGN_COHERENCE_TOOL, DESIGN_CONCEPT_TOOL, DESIGN_PITCHES_TOOL, DESIGN_PLAN_TOOL, DESIGN_REACTION_TOOL, DESIGN_REVIEW_TOOL, FINDINGS_TOOL, PLAN_REACTION_TOOL, PLAN_REVIEW_TOOL, PLAN_TOOL, SCENES_TOOL, SCENE_SUMMARY_TOOL,
  DESIGN_COHERENCE_ROLE, DESIGN_PANEL_ROLE, DESIGN_PITCHES_ROLE, PITCH_READER_ROLE,
  architectSystemPrompt, continuitySystemPrompt, designArchitectSystem, designPitchEvaluationTool, designReactionTool, designReviewTool, specialistsSystemPrompt, writerSystemPrompt,
} from "./prompts.js";
import { MAX_BOOK_CHAPTERS, MAX_DIRECTOR_NOTES, normalizeBrief, normalizeOptions } from "./state.js";
import { DESIGN_BATCH_CHAPTERS, DESIGN_DEFAULT_ROUNDS, REVIEW_MAX_ROUNDS, type AutopilotBrief, type AutopilotOptions, type AutopilotState, type DesignWorkflow } from "./types.js";

// What a run will cost before it starts. The estimate is arithmetic over the pipeline: it counts the calls the steps of the autopilot make (the formulas
// are written next to the step of `tasks.ts` and `planner.ts` they come from), weighs each call as the engine's router would weigh its prompt and as
// the replies of the schemas weigh, and prices the result with the models the author configured. Everything is closed-form: a book of five thousand
// chapters takes as long as one of five. It reads nothing and keeps nothing: no file, no clock, no network, no random number.

/** The capabilities of the router that the autopilot uses (`AI_CAPABILITIES`). */
export const ESTIMATE_CAPABILITIES = Object.freeze([
  AI_CAPABILITIES.writer,
  AI_CAPABILITIES.director,
  AI_CAPABILITIES.reader,
  AI_CAPABILITIES.readerSummary,
  AI_CAPABILITIES.specialist,
  AI_CAPABILITIES.summary,
] as const);

export type EstimateCapability = (typeof ESTIMATE_CAPABILITIES)[number];

/**
 * The kinds of call a run makes, in the order of the pipeline; the names are the ones the labels of the requests start with
 * (`autopilot:concept`, `autopilot:scenes:3`, `reader-evaluation:…`, `director:book`). Two of them are made inside a step of another kind:
 * `scene-summary` is asked by `write` and `repair`, after the scene.
 */
export const ESTIMATE_CALL_KINDS = Object.freeze([
  "design-pitches",
  "design-pitch-reader",
  "design-pitch-review",
  "concept",
  "summarize-imported",
  "plan",
  "plan-reader",
  "design-chapter-review",
  "design-coherence",
  "plan-review",
  "scenes",
  "write",
  "scene-summary",
  "reader",
  "readers-summary",
  "specialists",
  "director-review",
  "repair",
  "consolidate",
  "final",
] as const);

export type EstimateCallKind = (typeof ESTIMATE_CALL_KINDS)[number];

const CAPABILITY_OF: Record<EstimateCallKind, EstimateCapability> = {
  "design-pitches": AI_CAPABILITIES.writer,
  "design-pitch-reader": AI_CAPABILITIES.reader,
  "design-pitch-review": AI_CAPABILITIES.director,
  concept: AI_CAPABILITIES.writer,
  "summarize-imported": AI_CAPABILITIES.summary,
  plan: AI_CAPABILITIES.writer,
  "plan-reader": AI_CAPABILITIES.reader,
  "design-chapter-review": AI_CAPABILITIES.director,
  "design-coherence": AI_CAPABILITIES.specialist,
  "plan-review": AI_CAPABILITIES.director,
  scenes: AI_CAPABILITIES.writer,
  write: AI_CAPABILITIES.writer,
  "scene-summary": AI_CAPABILITIES.summary,
  reader: AI_CAPABILITIES.reader,
  "readers-summary": AI_CAPABILITIES.readerSummary,
  specialists: AI_CAPABILITIES.specialist,
  "director-review": AI_CAPABILITIES.director,
  repair: AI_CAPABILITIES.writer,
  consolidate: AI_CAPABILITIES.writer,
  final: AI_CAPABILITIES.director,
};

/**
 * The sizes the estimate assumes where it cannot know them, in words (a word is six characters, the space included). They are the estimate's own
 * assumptions, not measures of your book: pass what you have measured in `context`, and what a run has really spent will show where they are wrong.
 * A real model may be longer or shorter than the replies it assumes; the tests that check the estimate against the pipeline answer with replies of these sizes.
 */
export const ESTIMATE_TYPICAL = Object.freeze({
  /** The idea of the brief, when the author wrote none. */
  ideaWords: 60,
  /** What a book that is just begun holds in the files the concept reads: its description, the story design and the world context, all to be filled. */
  freshBookWords: 34,
  designWords: 700,
  worldWords: 250,
  /** The default ghostwriter profile (`defaultGhostwriter`): 906 characters, at six a word. What a book that did not write its own has. */
  ghostwriterWords: 150,
  /** The canon manifest: a line (kind, name, summary) for each entry, and a summary for the characters: about six characters and four other entries. */
  canonWords: 270,
  /** The rules of what may be revealed, which the writer and the reviewers read, and the lines of the secrets in the manifest and in the plan of the reveals. */
  secretsWords: 105,
  secretLineWords: 20,
  revealsWords: 45,
  /** The binding rules of the author and the evaluation style of the book (the whole block of a chapter's review; the review of the plan carries about half: the method and the severity). */
  rulesWords: 0,
  styleWords: 0,
  /** The standing guidance of the director when the plan is approved, and what each chapter adds to it, up to `MAX_DIRECTOR_NOTES` notes. */
  notesWords: 30,
  noteWords: 25,
  /** An entry of the author's outline. */
  outlineEntryWords: 60,
  /** One entry of the canon as the prompts that quote it give it (a heading and its body), and how many a scene, a repair and the specialists quote. */
  canonEntryWords: 45,
  canonEntriesScene: 4,
  canonEntriesSpecialists: 6,
  /**
   * A chapter of the plan as a block (title, summary, purpose, point of view, key events) and as a line of a list (number, title, summary); and the line of a chapter that is
   * closed, whose summary is the one the closing wrote (`consolidate`), a little longer than the plan's.
   */
  chapterWords: 130,
  chapterLineWords: 55,
  closedLineWords: 64,
  /** A scene of the plan as a block, and as a line. */
  sceneWords: 110,
  sceneLineWords: 25,
  /** The story so far: what a chapter adds to it, and the length it is asked to stay under (`STORY_SO_FAR_TARGET_WORDS`). */
  storyWordsPerChapter: 75,
  storyWordsTarget: 900,
  /**
   * The longest a list of chapters is in a prompt: 24 000 characters (`OUTLINE_MAX_CHARS`). A list that does not fit keeps the `listFullLines` lines around the chapter it is
   * about whole, and gives every other chapter a line of `titleLineWords`.
   */
  listCapWords: 4000,
  listFullLines: 30,
  titleLineWords: 5,
  /** The specialists' findings in a round, the proposals of the readers' summary, and the lines they make in the director's prompt. */
  findings: 5,
  findingWords: 55,
  readerProposals: 4,
  proposalWords: 35,
  /** A reader as one line of the director's prompt, and a fix the director accepts as the repair is told it. */
  readerLineWords: 55,
  fixWords: 25,
  /** A scene's summary. */
  summaryWords: 35,
  // The replies, in words.
  conceptWords: 1550,
  chapterReplyWords: 125,
  sceneReplyWords: 105,
  planReactionWords: 100,
  planReviewWords: 100,
  readerWords: 150,
  readersSummaryWords: 190,
  findingReplyWords: 48,
  directorBaseWords: 75,
  decisionWords: 20,
  consolidateBaseWords: 100,
  recapSceneWords: 25,
  importedSummaryWords: 60,
  finalWords: 330,
  /**
   * A design run (`EstimateInput.design`): the foundation of a design (the concept with the relationships, the items and the rules of the world), the design of one chapter
   * as the model writes it and as a prompt quotes it, the ledger of a secret in a batch, how many secrets a book has, a reader's reaction and the director's review.
   */
  designConceptWords: 2100,
  designChapterReplyWords: 330,
  designEntryWords: 260,
  designLedgerWords: 90,
  designSecrets: 3,
  designReactionWords: 260,
  designReviewWords: 520,
  /**
   * The reviews of a design (`EstimateDesign.workflow`): a pitch, the judgement of a pitch (a note and its rubric), the rubric of one subject (twelve criteria with their reasons,
   * issues and proposals), the review of a chapter with its rubric, the findings of one call of the analysis of the structure, and what the director decides about them.
   */
  designPitchWords: 150,
  designPitchJudgementWords: 330,
  designRubricWords: 560,
  designChapterReviewWords: 420,
  designCoherenceWords: 650,
  designDecisionWords: 60,
});

/** The sizes of the files of the book, in words, when the host has measured them (each defaults to `ESTIMATE_TYPICAL`). */
export interface EstimateContext {
  designWords?: number;
  worldWords?: number;
  ghostwriterWords?: number;
  /** The director's profile (`director.md`): its default is the default profile's own size. */
  directorWords?: number;
  canonWords?: number;
  secretsWords?: number;
  rulesWords?: number;
  notesWords?: number;
  styleWords?: number;
}

/** What the model of a capability is: how it is called, what a request may hold, what it costs, how fast it writes. Nothing here is a secret. */
export interface EstimateModel {
  model: string;
  provider?: string;
  underlyingModel?: string;
  /** The window of the model: a prompt and its answer together. Not declared: not checked. */
  maxInputTokens?: number;
  /** The largest answer the model can give. */
  maxOutputTokens?: number;
  pricing?: { inputPerMTok?: number; cachedPerMTok?: number; cacheWritePerMTok?: number; outputPerMTok?: number };
  /**
   * Whether the model caches the start of its prompts (`AiChatModelConfig.promptCaching`): `unsupported` counts on no saving, whatever the model's cached price. Any other word (or none) leaves it to
   * what is measured, else to the start of the requests that never changes.
   */
  promptCaching?: "unknown" | "supported" | "unsupported" | "learned";
  /**
   * The share of the input of this model that its provider served from its cache, as the host measured it in the calls it made (0 to 1: the tokens served, over the tokens sent, in its ledger). When there
   * is one, it is what the best case counts on, in place of the fixed start of the requests; nothing is counted for a model that declares no cached price, because it would cost the same.
   */
  cacheHitRate?: number;
  supportsReasoning?: boolean;
  tokensPerSecond?: number;
}

/** What the estimate counts on for a model's cache: nothing (no cached price, or a model declared as not caching), the fixed start of its requests when it meets the provider's minimum, or the share measured in the calls the host made. */
export type EstimateCacheBasis = "none" | "structural" | "measured";

export type EstimateCount = number | { min?: number; max?: number };

/**
 * What the reviews of the run will be, when the host knows. Without it the estimate is an interval: from the least the pipeline does (every chapter approved at its
 * first review, the plan at its first look) to the most (every round used, every scene repaired, the plan revised twice).
 */
export interface EstimateScenario {
  /** Rounds of review of a chapter, from 1 to the director's `maxReviewRounds` (or the review policy's). */
  rounds?: EstimateCount;
  /** Scenes repaired in a chapter, in all its rounds. */
  repairs?: EstimateCount;
  /** Times the director sends the plan back, from 0 to 2. */
  planRevisions?: EstimateCount;
}

/** Where the book is: a resume, or chapters added to a book, counts only what is left. */
export interface EstimateProgress {
  /** Chapters done (the first `chaptersDone` of the book). A chapter written halfway counts as whole. */
  chaptersDone?: number;
  /** Chapters of the approved plan (0 when there is no approved plan yet). */
  planned?: number;
  /** The concept is done. Not said: it is when there is a chapter or a plan. */
  conceptDone?: boolean;
  /** The director has judged the book as it is. */
  finalDone?: boolean;
  /** Chapters the author wrote that have no summary yet: each costs one call of the simple tasks. */
  withoutSummary?: number;
  /** Their words, in all (not said: the length of a chapter of the brief). */
  withoutSummaryWords?: number;
  /**
   * The chapters left are written already and are only reviewed again (a review of the book): no scenes are planned or written for them, only their review, the
   * repairs it asks for and their closing. Not said: they are written.
   */
  reviewOnly?: boolean;
  /**
   * Of the chapters left, how many a review of the book takes up only for the vote of their readers (the director's vote is at the target already, and the review has
   * targets for the readers): each is read by the readers, and reviewed whole only when a target is missed. In the least a run costs they cost their reading alone.
   */
  checkOnly?: number;
}

export interface EstimateOutline {
  /** Chapters the author wrote an entry for. */
  entries?: number;
  /** The number of the last of them. */
  lastChapter?: number;
  /** Their words, in all (not said: `ESTIMATE_TYPICAL.outlineEntryWords` for each). */
  words?: number;
}

/**
 * A design run (`StartOptions.design`): the concept, the design of every chapter in batches of `DESIGN_BATCH_CHAPTERS`, the readers and the director's reviews for the
 * rounds of its policy. Nothing is written and nothing is judged as a book: no scene, no review of a chapter, no final judgement.
 */
export interface EstimateDesign {
  /** The reviews of the design at most (its policy's `maxRounds`; `DESIGN_DEFAULT_ROUNDS` when it says nothing). */
  maxRounds?: number;
  /** In how many of the first reviews the readers read it (its policy's `readerRounds`; 1 when it says nothing). */
  readerRounds?: number;
  /** What the run does besides the plain design (`DesignWorkflow`): the rubric, the alternatives, the review of every chapter, the analysis of the structure. */
  workflow?: DesignWorkflow;
}

export interface EstimateInput {
  /** The brief of the form: the words of a scene, and the idea and the synopsis, which weigh in the prompts that carry them. The chapters are `outline`'s. */
  brief?: Partial<AutopilotBrief>;
  /** A design run instead of a run that writes (`EstimateDesign`; `true`: with the defaults of a design). */
  design?: EstimateDesign | boolean;
  /** The scenes a chapter is expected to have (the planner's rule gives 2 to 4 for each chapter); the middle of the range when missing. */
  scenesPerChapter?: number;
  /**
   * `readers`, `maxReaders`, `readersOnPlan`, `specialists` and the review policy (`review`: the rounds of a chapter, and the rounds the readers read in) change the
   * calls; the others (`pauseAfterPlan`, `chaptersPerRun`, the budgets…) do not.
   */
  options?: Partial<AutopilotOptions>;
  /** `maxReviewRounds` of the director's profile (1 to 3, 2 when it says nothing): the rounds of review of a chapter unless the review policy (`options.review.maxRounds`) says others. */
  maxReviewRounds?: number;
  /** The language of the book: its name or its code. The texts of the estimate are in Italian for an Italian book and in English for every other. */
  language?: string;
  /** The model of each capability, `null` or missing when there is none. */
  models?: Partial<Record<EstimateCapability, EstimateModel | null | undefined>>;
  outline?: EstimateOutline;
  progress?: EstimateProgress;
  scenario?: EstimateScenario;
  context?: EstimateContext;
  /** Readers in the panel that are enabled (the built-in panel has eight). */
  readerPanelSize?: number;
  /** The money of the prices; only passed on to the result. */
  currency?: string;
  /** Tokens a word of the book costs, when the host has measured it (not said: the engine's own factor for the language, `tokensPerWord`). */
  tokensPerWord?: number;
}

export interface EstimateRange {
  min: number;
  max: number;
}

export interface EstimateStep {
  capability: EstimateCapability;
  calls: EstimateRange;
  inputTokens: EstimateRange;
  outputTokens: EstimateRange;
}

export interface EstimateCapabilityResult {
  /** The model that is asked, `null` when there is none. */
  model: string | null;
  calls: EstimateRange;
  inputTokens: EstimateRange;
  /** The part of the input that a provider that caches the start of a request would bill at the cached price: counted only for a model that declares that price (and does not say it does not cache). */
  cachedInputTokens: EstimateRange;
  /** What `cachedInputTokens` counts on: the share the host measured for the model, the fixed start of its requests (when it holds the least a provider caches), or nothing. */
  cacheBasis: EstimateCacheBasis;
  outputTokens: EstimateRange;
  /** `null` when the model has no price (or there is no model); `{ min: 0, max: 0 }` when the capability makes no call. */
  cost: EstimateRange | null;
  /** `null` when the speed of the model is not known; `{ min: 0, max: 0 }` when the capability makes no call. */
  minutes: EstimateRange | null;
}

interface EstimateWarningBase {
  severity: "error" | "warning" | "info";
  /** The text, in the language of the book. */
  text: string;
}

/** What the interface needs to say something about a run before it starts. A structured warning has a stable `code` and its numbers; the text is only the engine's own wording. */
export type EstimateWarning =
  | (EstimateWarningBase & { code: "noModel"; capability: EstimateCapability })
  | (EstimateWarningBase & { code: "smallWindow"; capability: EstimateCapability; model: string; step: EstimateCallKind; window: number; inputBudget: number; typicalPrompt: number })
  | (EstimateWarningBase & { code: "smallOutput"; capability: EstimateCapability; model: string; step: EstimateCallKind; maxOutputTokens: number; typicalReply: number })
  | (EstimateWarningBase & { code: "noPrice"; capability: EstimateCapability; model: string })
  | (EstimateWarningBase & { code: "noSpeed"; capability: EstimateCapability; model: string })
  | (EstimateWarningBase & { code: "reasoningModel"; capability: EstimateCapability; model: string });

export type EstimateWarningCode = EstimateWarning["code"];

export interface EstimateResult {
  /** The language of the texts, as a code. */
  language: string;
  /** The chapters of the book (the outline can make it longer than the brief). */
  chapters: number;
  /** The chapters this run writes. */
  chaptersToWrite: number;
  /** The words it writes, at the length the brief asks. */
  words: number;
  calls: EstimateRange;
  inputTokens: EstimateRange;
  cachedInputTokens: EstimateRange;
  outputTokens: EstimateRange;
  /** `null` when a capability that makes calls has no price: then `unpriced` says which. */
  cost: (EstimateRange & { currency?: string }) | null;
  unpriced: EstimateCapability[];
  /** `null` when the speed of a model that is asked is not known: then `unmeasured` says which. */
  minutes: EstimateRange | null;
  unmeasured: EstimateCapability[];
  capabilities: Record<EstimateCapability, EstimateCapabilityResult>;
  steps: Record<EstimateCallKind, EstimateStep>;
  warnings: EstimateWarning[];
  assumptions: string[];
}

// ─── What the pipeline asks of the models ───────────────────────────────────

/** The most rounds of review of a chapter (the review policy's limit, `REVIEW_MAX_ROUNDS`). */
const MAX_ROUNDS = REVIEW_MAX_ROUNDS;
/** The most rounds a director's profile gives a chapter (`max_review_rounds`). */
const DIRECTOR_MAX_ROUNDS = 3;
/** The most times the plan is sent back (the third review of the plan is an approval). */
const MAX_PLAN_REVISIONS = 2;
/** A word of the book is six characters, the space included: what a limit in characters of a prompt is in words. */
const CHARS_PER_WORD = 6;
/** Tokens in a message besides its text, in the envelope of a function, and in a marker that opens a scene in a chapter's text. */
const MESSAGE_TOKENS = 4;
const FUNCTION_TOKENS = 8;
const SCENE_MARKER_TOKENS = 12;
/** Characters of the labels of a section of a prompt (its title, the lines that say what the next lines are), on average. */
const SECTION_LABEL_CHARS = 28;
/** Tokens a word of the book costs as the router counts a prompt: six characters (the space included) at four a token. */
const INPUT_TOKENS_PER_WORD = CHARS_PER_WORD / 4;
/** The tokens a word costs in the languages the engine's factor is built on (`TOKENS_PER_WORD`): the factor of another language is taken in proportion. */
const LATIN_TOKENS_PER_WORD = 2.4;
/** The most words of the director's taste a prompt carries: the lists of its profile and a vision cut at 2 500 characters (`directorTaste` in the steps of the writer). */
const MAX_TASTE_WORDS = 520;
const DEFAULT_PANEL_SIZE_FALLBACK = 8;

/**
 * The request lines of each kind, in characters, and how many labelled sections its data has, measured on the prompts the pipeline builds (`autopilot/tasks.ts`) in their
 * usual shape: no synopsis, no outline, no author's rules, one batch of the plan, a round that is not the last. What is in a section is counted in words; this is the English
 * text around it (the lines of the request and the titles of the sections, `SECTION_LABEL_CHARS` each).
 */
const REQUEST: Record<EstimateCallKind, { chars: number; sections: number }> = {
  "design-pitches": { chars: 184, sections: 4 },
  "design-pitch-reader": { chars: 1741, sections: 3 },
  "design-pitch-review": { chars: 2089, sections: 4 },
  "design-chapter-review": { chars: 1931, sections: 10 },
  "design-coherence": { chars: 179, sections: 9 },
  concept: { chars: 341, sections: 11 },
  "summarize-imported": { chars: 230, sections: 2 },
  plan: { chars: 191, sections: 12 },
  "plan-reader": { chars: 108, sections: 4 },
  "plan-review": { chars: 407, sections: 7 },
  scenes: { chars: 221, sections: 7 },
  write: { chars: 189, sections: 14 },
  "scene-summary": { chars: 76, sections: 0 },
  reader: { chars: 55, sections: 2 },
  "readers-summary": { chars: 47, sections: 3 },
  specialists: { chars: 142, sections: 8 },
  "director-review": { chars: 680, sections: 9 },
  repair: { chars: 302, sections: 9 },
  consolidate: { chars: 305, sections: 4 },
  final: { chars: 408, sections: 6 },
};

/** The limit the pipeline puts on the reply of a call, in tokens (for the language of a Latin script; `scaleOutputTokens` grows it for the others). The prose is limited by its words. */
const REPLY_LIMIT: Partial<Record<EstimateCallKind, number>> = {
  concept: 9000,
  "summarize-imported": 600,
  plan: 9000,
  "plan-reader": 1500,
  "plan-review": 4000,
  scenes: 5000,
  "scene-summary": 400,
  reader: 2500,
  "readers-summary": 2500,
  specialists: 5000,
  "director-review": 6000,
  consolidate: 5000,
  final: 4000,
};

/** The calls that are answered with prose, not with a function. */
const PROSE_KINDS: ReadonlySet<EstimateCallKind> = new Set<EstimateCallKind>(["write", "repair"]);

const TOOL_OF: Partial<Record<EstimateCallKind, AiJsonSchema>> = {
  "design-pitches": DESIGN_PITCHES_TOOL,
  "design-pitch-reader": designPitchEvaluationTool("reader"),
  "design-pitch-review": designPitchEvaluationTool("director"),
  "design-chapter-review": DESIGN_CHAPTER_REVIEW_TOOL,
  "design-coherence": DESIGN_COHERENCE_TOOL,
  concept: CONCEPT_TOOL,
  "summarize-imported": CHAPTER_SUMMARY_TOOL,
  plan: PLAN_TOOL,
  "plan-reader": PLAN_REACTION_TOOL,
  "plan-review": PLAN_REVIEW_TOOL,
  scenes: SCENES_TOOL,
  "scene-summary": SCENE_SUMMARY_TOOL,
  reader: READER_EVALUATION_TOOL,
  "readers-summary": READER_SUMMARY_TOOL,
  specialists: FINDINGS_TOOL,
  "director-review": CHAPTER_REVIEW_TOOL,
  consolidate: CONSOLIDATION_TOOL,
  final: DIRECTOR_OPINION_TOOL,
};

/** The limits of the replies of a design run that are not a plan's (`runConcept`, `runPlan`, `runPlanReader`, `runDesignReview` ask for more). */
const DESIGN_REPLY_LIMIT: Partial<Record<EstimateCallKind, number>> = {
  "design-pitches": 2600,
  "design-pitch-reader": 3700,
  "design-pitch-review": 4200,
  "design-chapter-review": 7440,
  "design-coherence": 11_850,
  concept: 12000,
  plan: 4000 + 1500 * DESIGN_BATCH_CHAPTERS,
  "plan-reader": 2500,
  "plan-review": 5000,
};

function replyLimitOf(kind: EstimateCallKind, designing: boolean): number | undefined {
  return (designing ? DESIGN_REPLY_LIMIT[kind] : undefined) ?? REPLY_LIMIT[kind];
}

const designTools = new Map<string, Partial<Record<EstimateCallKind, number>>>();

/** The tokens of the functions of a design run, for the steps that ask with them: the reader's and the director's carry the rubric, and the director's the decisions about findings, when the workflow asks. */
function designToolTokens(flow: Pick<DesignFlow, "rubric" | "coherence">): Partial<Record<EstimateCallKind, number>> {
  const key = `${flow.rubric}:${flow.coherence}`;
  let tokens = designTools.get(key);
  if (!tokens) {
    tokens = {
      concept: functionTokens(DESIGN_CONCEPT_TOOL),
      plan: functionTokens(DESIGN_PLAN_TOOL),
      "plan-reader": functionTokens(designReactionTool(flow.rubric)),
      "plan-review": functionTokens(designReviewTool({ rubric: flow.rubric, decisions: flow.coherence })),
    };
    designTools.set(key, tokens);
  }
  return tokens;
}

// ─── Sums over the chapters of a book ───────────────────────────────────────

/** What grows with the chapter number up to a limit: `min(cap, slope × (chapter − start))` tokens, nothing before `start` (the first chapter of the book by default). */
interface Ramp {
  slope: number;
  cap: number;
  start?: number;
}

/** The list of the chapters before the one a prompt is about (`lines` of the chapter number less one), laid out as `layoutChapters` does (see `windowedList`). */
interface ListRamp {
  line: number;
  title: number;
  full: number;
  cap: number;
}

/** The tokens of one call of a kind: what does not depend on the chapter, what grows with it, the lists of chapters it carries, and what is added once for the whole run. */
interface Prompt {
  base: number;
  ramps: Ramp[];
  lists: ListRamp[];
  once: number;
}

function prompt(base: number, ramps: Ramp[] = [], once = 0, lists: ListRamp[] = []): Prompt {
  return { base, ramps, lists, once };
}

function promptTotal(call: Prompt, from: number, to: number): number {
  const chapters = Math.max(0, to - from + 1);
  if (!chapters) return 0;
  return call.base * chapters + call.once
    + call.ramps.reduce((total, ramp) => total + sumCappedRamp(ramp.slope, ramp.cap, from - (ramp.start ?? 1) + 1, to - (ramp.start ?? 1) + 1), 0)
    + call.lists.reduce((total, list) => total + sumWindowedList(from - 1, to - 1, list.line, list.title, list.full, list.cap), 0);
}

function promptPeak(call: Prompt, chapter: number): number {
  return call.base
    + call.ramps.reduce((total, ramp) => total + Math.min(ramp.cap, ramp.slope * Math.max(0, chapter - (ramp.start ?? 1))), 0)
    + call.lists.reduce((total, list) => total + windowedList(chapter - 1, list.line, list.title, list.full, list.cap), 0);
}

// ─── The sizes of what does not depend on the book ──────────────────────────

interface Statics {
  /** Characters of the two wrappers of a request and of the line between them. */
  frame: number;
  /** The tokens of the system message and of the function of each kind (the message's envelope included), and of the director's profile in the prompts that quote it. */
  system: Record<EstimateCallKind, number>;
  tool: Record<EstimateCallKind, number>;
  /** The default director profile: its words, the tokens of its system prompt, and the tokens of the block of its taste that some prompts quote. */
  directorWords: number;
  directorProfileTokens: number;
  tasteTokens: number;
  tasteShare: number;
  readersEnabled: number;
  /** The system message of the architect in a design run: the architect's, the brainstormer's role and the default Brainstormer profile. */
  designArchitect: number;
}

const messageTokens = (text: string): number => Math.ceil(text.length / 4) + MESSAGE_TOKENS;
const functionTokens = (tool: AiJsonSchema | undefined): number => (tool ? likelyTextTokens(JSON.stringify([{ type: "function", function: tool }])) + FUNCTION_TOKENS : 0);

const staticCache = new Map<string, Statics>();

function staticsFor(language: string): Statics {
  const key = language === "it" ? "it" : "en";
  const cached = staticCache.get(key);
  if (cached) return cached;
  const director = defaultDirector(key);
  const system = (key === "it" ? "Italian" : "English");
  const bullets = (entries: string[]) => entries.map((entry) => `- ${entry}`).join("\n");
  const taste = [
    director.priorities.length ? `Priorities:\n${bullets(director.priorities)}` : "",
    director.taste.length ? `Taste:\n${bullets(director.taste)}` : "",
    director.redLines.length ? `Red lines (never allowed):\n${bullets(director.redLines)}` : "",
    director.body.trim() ? `Vision:\n${director.body.trim().slice(0, 2500)}` : "",
  ].filter(Boolean).join("\n\n");
  const profile = directorPrompt(director);
  const directorSystem = directorSystemPrompt(director, key);
  const personas = builtinReaderPersonas(key).filter((persona) => persona.enabled);
  const personaSystem = (depth: "brief" | "normal", extra = ""): number => {
    if (!personas.length) return MESSAGE_TOKENS;
    const total = personas.reduce((sum, persona) => sum + readerPersonaSystemPrompt(persona, system, depth).length + extra.length, 0);
    return Math.ceil(total / personas.length / 4) + MESSAGE_TOKENS;
  };
  const planReaderLine = "\n\nYou are reading the pitch and the chapter plan of a novel that is not written yet. React honestly as this reader would.";
  const brainstormer = brainstormerPrompt(defaultBrainstormer(key));
  const systems: Record<EstimateCallKind, number> = {
    "design-pitches": messageTokens(`${designArchitectSystem(key, brainstormer)}\n\n${DESIGN_PITCHES_ROLE}`),
    "design-pitch-reader": personaSystem("brief", `\n\n${PITCH_READER_ROLE}`),
    "design-pitch-review": messageTokens(directorSystem),
    "design-chapter-review": messageTokens(`${directorSystem}\n\n${DESIGN_PANEL_ROLE}`),
    "design-coherence": messageTokens(`${specialistsSystemPrompt(key)}\n\n${DESIGN_COHERENCE_ROLE}`),
    concept: messageTokens(architectSystemPrompt(key)),
    "summarize-imported": messageTokens(continuitySystemPrompt(key)),
    plan: messageTokens(architectSystemPrompt(key)),
    "plan-reader": personaSystem("brief", planReaderLine),
    "plan-review": messageTokens(directorSystem),
    scenes: messageTokens(architectSystemPrompt(key)),
    write: messageTokens(writerSystemPrompt(key)),
    "scene-summary": messageTokens(continuitySystemPrompt(key)),
    reader: personaSystem("normal"),
    "readers-summary": messageTokens(`Compare the separate simulated-reader evaluations. Preserve disagreements rather than flattening them. Return the summary in ${system}.`),
    specialists: messageTokens(specialistsSystemPrompt(key)),
    "director-review": messageTokens(directorSystem),
    repair: messageTokens(writerSystemPrompt(key)),
    consolidate: messageTokens(continuitySystemPrompt(key)),
    final: messageTokens(directorSystem),
  };
  const tools = Object.fromEntries(ESTIMATE_CALL_KINDS.map((kind) => [kind, functionTokens(TOOL_OF[kind])])) as Record<EstimateCallKind, number>;
  const statics: Statics = {
    frame: untrustedData("repository_content", "").length + currentRequest("").length + 2,
    system: systems,
    tool: tools,
    directorWords: countWords(profile),
    directorProfileTokens: Math.ceil(profile.length / 4),
    tasteTokens: Math.ceil(taste.length / 4),
    tasteShare: profile.length ? taste.length / profile.length : 0,
    designArchitect: messageTokens(designArchitectSystem(key, brainstormer)),
    readersEnabled: builtinReaderPersonas(key).filter((persona) => persona.enabled).length || DEFAULT_PANEL_SIZE_FALLBACK,
  };
  staticCache.set(key, statics);
  return statics;
}

// ─── The input, as the estimate reads it ────────────────────────────────────

function whole(value: unknown, fallback: number, min: number, max: number): number {
  return asInteger(value, fallback, min, max);
}

/** A size in words that the host measured: anything that is not a number of words (no text, not a number, below nothing) is the typical size. */
function knob(value: unknown, fallback: number): number {
  return asNumber(value, fallback, 0, 10_000_000);
}

function pin(value: unknown, fallback: [number, number], min: number, max: number): [number, number] {
  let low = fallback[0];
  let high = fallback[1];
  if (typeof value === "number" || typeof value === "string") {
    const single = asNumber(value, Number.NaN);
    if (!Number.isNaN(single)) low = high = single;
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    const range = value as Record<string, unknown>;
    const first = asNumber(range.min, Number.NaN);
    const last = asNumber(range.max, Number.NaN);
    if (!Number.isNaN(first)) low = first;
    if (!Number.isNaN(last)) high = last;
  }
  const clamp = (number: number) => Math.min(max, Math.max(min, Math.round(number)));
  low = clamp(low);
  high = clamp(high);
  return low <= high ? [low, high] : [high, low];
}

interface ResolvedModel {
  name: string;
  window?: number;
  maxOutput?: number;
  price?: { input: number; output: number; cached?: number; write?: number };
  /** The model is declared as not caching. */
  noCache: boolean;
  /** The share of its input that the provider served from its cache, as the host measured it: 0 to 1. */
  hitRate?: number;
  speed?: number;
  reasoning: boolean;
}

function priceOf(value: unknown): { input: number; output: number; cached?: number; write?: number } | undefined {
  const pricing = asRecord(value);
  const known = (price: unknown): price is number => typeof price === "number" && Number.isFinite(price) && price >= 0;
  if (!known(pricing.inputPerMTok) || !known(pricing.outputPerMTok)) return undefined;
  // A cache that costs more than the input it saves is no saving: the cached price is never above the input's.
  // A write that costs less than the input is no premium: a write price below the input's is not counted.
  return { input: pricing.inputPerMTok, output: pricing.outputPerMTok, ...(known(pricing.cachedPerMTok) ? { cached: Math.min(pricing.cachedPerMTok, pricing.inputPerMTok) } : {}), ...(known(pricing.cacheWritePerMTok) && pricing.cacheWritePerMTok > pricing.inputPerMTok ? { write: pricing.cacheWritePerMTok } : {}) };
}

function resolveModel(value: unknown): ResolvedModel | null {
  const source = asRecord(value);
  const name = typeof source.model === "string" ? source.model.trim() : "";
  if (!name) return null;
  const positive = (number: unknown): number | undefined => (typeof number === "number" && Number.isFinite(number) && number > 0 ? number : undefined);
  const provider = typeof source.provider === "string" ? source.provider : "";
  const underlying = typeof source.underlyingModel === "string" ? source.underlyingModel : undefined;
  const price = priceOf(source.pricing);
  const window = positive(source.maxInputTokens);
  const maxOutput = positive(source.maxOutputTokens);
  const speed = positive(source.tokensPerSecond);
  const rate = typeof source.cacheHitRate === "number" && Number.isFinite(source.cacheHitRate) ? Math.min(1, Math.max(0, source.cacheHitRate)) : undefined;
  return {
    name,
    noCache: normalizePromptCaching(source.promptCaching) === "unsupported",
    ...(rate !== undefined ? { hitRate: rate } : {}),
    ...(window ? { window } : {}),
    ...(maxOutput ? { maxOutput } : {}),
    ...(price ? { price } : {}),
    ...(speed ? { speed } : {}),
    reasoning: source.supportsReasoning === true || isReasoningModel(provider, name, underlying),
  };
}

/** The number of the last chapter an outline asks for, from what the host says of it. */
function outlineChaptersOf(outline: Record<string, unknown>): number {
  const last = whole(outline.lastChapter, 0, 0, MAX_BOOK_CHAPTERS);
  const entries = whole(outline.entries, 0, 0, MAX_BOOK_CHAPTERS);
  return Math.max(last, entries);
}

// ─── The estimate ───────────────────────────────────────────────────────────

interface KindPoint {
  calls: number;
  input: number;
  output: number;
  /** Tokens of the fixed start of the requests (the system message and the function) that a provider serves from its cache (the whole of it above the minimum it caches, none below), for the models that declare a cached price. */
  prefix: number;

}

type PointResult = Record<EstimateCallKind, KindPoint>;

/** The calls, tokens in and out of a run for one way the reviews turn out: `rounds` of review of each chapter, `repairs` scenes repaired in each, `revisions` of the plan. */
interface Point {
  rounds: number;
  repairs: number;
  revisions: number;
  /** The chapters a review of the book takes up only for the vote of their readers cost their reading alone (the best way it turns out), not a whole review. */
  light?: boolean;
}

const rangeOf = (min: number, max: number): EstimateRange => ({ min, max });
const roundRange = (min: number, max: number): EstimateRange => ({ min: Math.round(min), max: Math.round(max) });

export function estimateAutopilotRun(input?: EstimateInput | null): EstimateResult {
  const source = asRecord(input);
  const languageText = typeof source.language === "string" && source.language.trim() ? source.language : "en";
  const language = languageCode(languageText);
  const italian = isItalian(language);
  const statics = staticsFor(language);
  const brief = normalizeBrief(source.brief);
  const options = normalizeOptions(source.options);
  const briefSource = asRecord(source.brief);
  const context = asRecord(source.context);
  const progress = asRecord(source.progress);
  const outline = asRecord(source.outline);
  const scenario = asRecord(source.scenario);
  const T = ESTIMATE_TYPICAL;
  // A design run: the plan of every chapter with its design, its readers and its reviews, and nothing written.
  const designing = source.design === true || (typeof source.design === "object" && source.design !== null && !Array.isArray(source.design));
  const designInput = asRecord(source.design);
  const designRounds = whole(designInput.maxRounds, DESIGN_DEFAULT_ROUNDS, 1, MAX_ROUNDS);
  const designReaderRounds = whole(designInput.readerRounds, 1, 1, MAX_ROUNDS);
  // What the run does besides the plain design: read as the engine reads it from a state, so that a workflow the engine would refuse is not estimated.
  const flow: DesignFlow = designing ? designFlow({ workflow: normalizeWorkflow(designInput.workflow) }) : { rubric: false, chapterReview: false, coherence: false, alternatives: 0, pitchChoice: "director" };
  const batchSize = designing ? DESIGN_BATCH_CHAPTERS : PLAN_BATCH_CHAPTERS;

  // The tokens a word costs, in the book's language: the engine's factor, or the host's own.
  const override = asNumber(source.tokensPerWord, Number.NaN);
  const tpw = Number.isFinite(override) && override > 0 ? override : tokensPerWord(languageText);
  const ratio = tpw / LATIN_TOKENS_PER_WORD;
  /** Tokens of `count` words of the book in a prompt. */
  const w = (count: number): number => count * INPUT_TOKENS_PER_WORD * ratio;

  // The scenes of each chapter are the planner's (`scenesForChapter`): the host says how many it expects, else the middle of the range.
  const scenes = whole(source.scenesPerChapter, Math.round((SCENES_PER_CHAPTER.min + SCENES_PER_CHAPTER.max) / 2), 1, 20);
  const sceneWords = brief.wordsPerScene;
  const chapterWords = scenes * sceneWords;
  // The rounds of the review policy, else the director's (1 to 3, as its profile keeps them); the readers read a chapter in its first rounds (the first only,
  // unless the policy says more).
  const maxRounds = options.review?.maxRounds !== undefined ? whole(options.review.maxRounds, 2, 1, MAX_ROUNDS) : whole(source.maxReviewRounds, 2, 1, DIRECTOR_MAX_ROUNDS);
  const readerRounds = whole(options.review?.readerRounds, 1, 1, MAX_ROUNDS);
  // Targets for the readers (`ReviewPolicy.readersTarget`, `readerTargets`) make them read the chapter again after its corrections.
  const readersGate = options.readers && (options.review?.readersTarget !== undefined || Object.keys(options.review?.readerTargets ?? {}).length > 0);

  // The book: the chapters of the outline (its chapter entries), or the chapters already planned when the outline has none.
  const outlineChapters = outlineChaptersOf(outline);
  const chapters = Math.min(MAX_BOOK_CHAPTERS, Math.max(outlineChapters, whole(progress.planned, 0, 0, MAX_BOOK_CHAPTERS)));
  const outlineEntries = whole(outline.entries, 0, 0, MAX_BOOK_CHAPTERS) || (outlineChapters > 0 ? outlineChapters : 0);
  const outlineWords = outlineEntries > 0 ? knob(outline.words, outlineEntries * T.outlineEntryWords) : 0;

  // Where it is.
  const withoutSummary = whole(progress.withoutSummary, 0, 0, MAX_BOOK_CHAPTERS);
  const written = Math.max(whole(progress.chaptersDone, 0, 0, MAX_BOOK_CHAPTERS), withoutSummary);
  const planned = whole(progress.planned, 0, 0, MAX_BOOK_CHAPTERS);
  const conceptDone = typeof progress.conceptDone === "boolean" ? progress.conceptDone : written > 0 || planned > 0;
  const finalDone = progress.finalDone === true;
  const toWrite = Math.max(0, chapters - written);
  const from = written + 1;
  const importedChapterWords = withoutSummary > 0 ? Math.max(1, knob(progress.withoutSummaryWords, withoutSummary * chapterWords) / withoutSummary) : chapterWords;

  // What is planned: a fresh plan for the chapters that are left, or the extension of a plan that is approved. Chapters the plan holds are not planned again.
  // A design plans every chapter that is not written, whatever plan there was: a design that is over is reviewed again from its plan.
  const extension = !designing && planned > 0 && chapters > planned;
  const planCount = designing ? toWrite : planned > 0 ? (extension ? chapters - planned : 0) : toWrite;
  const planBatches = planCount > 0 ? Math.ceil(planCount / batchSize) : 0;
  const freshPlan = (designing || planned === 0) && planCount > 0;

  // The readers: those of the panel that are enabled, as many as the author asks. The readers of the plan do not depend on the readers of the chapters.
  const panel = whole(source.readerPanelSize, statics.readersEnabled, 0, 1000);
  const chapterReaders = options.readers ? Math.min(options.maxReaders, panel) : 0;
  const planReaders = options.readersOnPlan ? Math.min(options.maxReaders, panel) : 0;
  const specialists = options.specialists ? 1 : 0;

  // The reviews.
  const rounds = pin(scenario.rounds, [1, maxRounds], 1, maxRounds);
  const repairs = pin(scenario.repairs, [Math.max(0, rounds[0] - 1), rounds[1] * scenes], 0, rounds[1] * scenes);
  const revisions = designing ? pin(scenario.planRevisions, [0, designRounds - 1], 0, designRounds - 1) : pin(scenario.planRevisions, [0, MAX_PLAN_REVISIONS], 0, MAX_PLAN_REVISIONS);
  // Chapters taken up only for the vote of their readers: a review of the book with targets for the readers, whose chapters' director votes are at the target.
  const checkOnly = chapterReaders > 0 && readersGate && progress.reviewOnly === true ? whole(progress.checkOnly, 0, 0, MAX_BOOK_CHAPTERS) : 0;
  const pinned = rounds[0] === rounds[1] && repairs[0] === repairs[1] && revisions[0] === revisions[1] && checkOnly === 0;

  // What the files of the book weigh, in words.
  const design = knob(context.designWords, T.designWords);
  const world = knob(context.worldWords, T.worldWords);
  const ghostwriter = knob(context.ghostwriterWords, T.ghostwriterWords);
  const canon = knob(context.canonWords, T.canonWords);
  const secrets = knob(context.secretsWords, T.secretsWords);
  const rules = knob(context.rulesWords, T.rulesWords);
  const notes = knob(context.notesWords, T.notesWords);
  // The standing guidance grows with the book, a note for a chapter, up to the twelve the state keeps.
  const notesRamp: Ramp = { slope: w(T.noteWords), cap: w(Math.max(0, MAX_DIRECTOR_NOTES * T.noteWords - notes)), start: from };
  const style = knob(context.styleWords, T.styleWords);
  const ideaWords = typeof briefSource.idea === "string" && briefSource.idea.trim() ? countWords(briefSource.idea) : T.ideaWords;
  const synopsisWords = typeof briefSource.synopsis === "string" && briefSource.synopsis.trim() ? countWords(briefSource.synopsis) : 0;
  const customDirector = context.directorWords !== undefined && Number.isFinite(asNumber(context.directorWords, Number.NaN));
  const directorWords = customDirector ? knob(context.directorWords, statics.directorWords) : statics.directorWords;

  /** The system message of a kind, with the director's profile as the author wrote it when it is not the default one. */
  const system = (kind: EstimateCallKind): number => {
    const base = designing && (kind === "concept" || kind === "plan") ? statics.designArchitect : statics.system[kind];
    if (!customDirector || (kind !== "plan-review" && kind !== "director-review" && kind !== "final")) return base;
    return base - statics.directorProfileTokens + w(directorWords);
  };
  /** The block of the director's taste that the writer's prompts carry. */
  const taste = customDirector ? w(Math.min(directorWords * statics.tasteShare, MAX_TASTE_WORDS)) : statics.tasteTokens;
  const tool = (kind: EstimateCallKind): number => (designing ? designToolTokens(flow)[kind] ?? statics.tool[kind] : statics.tool[kind]);
  /** The fixed part of the tokens of a call of this kind: the system message, the function, the envelope of the request and its text, the labels of the sections. */
  const scaffold = (kind: EstimateCallKind): number => {
    const request = REQUEST[kind];
    return system(kind) + tool(kind) + Math.ceil((statics.frame + request.chars + request.sections * SECTION_LABEL_CHARS) / 4) + MESSAGE_TOKENS;
  };
  const prefix = (kind: EstimateCallKind): number => system(kind) + tool(kind);

  // What a prompt carries of the story so far, in tokens a chapter adds and up to where it stops (the caller's limit in characters).
  const story = (capChars: number): Ramp => ({ slope: w(T.storyWordsPerChapter), cap: w(Math.min(T.storyWordsTarget, capChars / CHARS_PER_WORD)) });
  const line = w(T.chapterLineWords);
  const closedLine = w(T.closedLineWords);
  const titleLine = w(T.titleLineWords);
  const listCap = w(T.listCapWords);
  /** A list of `lines` chapters, one line each (`each` tokens), laid out within the budget of a list. */
  const list = (lines: number, each = line): number => windowedList(lines, each, titleLine, T.listFullLines, listCap);
  const earlierChapters: ListRamp = { line: closedLine, title: titleLine, full: T.listFullLines, cap: listCap };
  const chapterText = w(chapterWords) + scenes * SCENE_MARKER_TOKENS;
  // The entries of the canon that a prompt quotes in full (a heading and the body): the ones a scene names, the ones a chapter's text names. A book with no canon quotes none.
  const entriesOfScene = canon > 0 ? w(T.canonEntriesScene * (T.canonEntryWords + 4)) : 0;
  const entriesOfChapter = canon > 0 ? w(T.canonEntriesSpecialists * (T.canonEntryWords + 4)) : 0;
  const proposals = chapterReaders > 0 ? T.readerProposals : 0;
  const findingsLines = specialists ? T.findings : 0;

  // A design: the designs of the chapters a reader and the director read (16 000 characters at most), and the ledger of the secrets with the world.
  const designEntries = Math.min(chapters * T.designEntryWords, 16_000 / CHARS_PER_WORD);
  const designLedgerContext = T.designSecrets * (T.designLedgerWords + 50) + Math.min(world, 2500 / CHARS_PER_WORD) / 2;
  // The reviews of a design: the alternatives, the rubric that a request carries, a line for each chapter reviewed and for each finding that the director is told, the chapters one call of the analysis reads.
  const pitches = flow.alternatives;
  const rubricRequest = Math.ceil(designRubricRule("all").join("\n\n").length / 4);
  const chapterReviewLines = flow.chapterReview ? Math.min(chapters, 40) * 38 : 0;
  const findingLines = flow.coherence ? 12 * 45 : 0;
  const coherenceChapters = Math.min(toWrite, COHERENCE_WINDOW) * T.designEntryWords;
  const coherenceCalls = flow.coherence && toWrite > 0 ? coherenceWindows(Array.from({ length: toWrite }, (_, index) => index + 1)).length : 0;
  const chapterReviewBatches = flow.chapterReview && toWrite > 0 ? Math.ceil(toWrite / DESIGN_REVIEW_BATCH_CHAPTERS) : 0;

  // The outline, in the prompts that carry it: the description and the entries (12 000 characters at most), and the entries of a batch (24 000).
  const outlineWordsCapped = (cap: number): number => (outlineEntries > 0 ? w(Math.min(outlineWords, cap / CHARS_PER_WORD)) : 0);

  // ─── The prompts of each kind, in tokens ──────────────────────────────────
  const promptOf = (kind: EstimateCallKind): Prompt => {
    switch (kind) {
      case "concept":
        return prompt(scaffold(kind) + w(ideaWords + synopsisWords + T.freshBookWords + rules) + taste + outlineWordsCapped(12_000));
      case "summarize-imported":
        return prompt(scaffold(kind) + w(Math.min(importedChapterWords, 60_000 / CHARS_PER_WORD)) + scenes * SCENE_MARKER_TOKENS);
      case "design-pitches":
        return prompt(scaffold(kind) + w(ideaWords + synopsisWords + canon + rules));
      case "design-pitch-reader":
        return prompt(scaffold(kind) + w(ideaWords + pitches * (T.designPitchWords + 40)));
      case "design-pitch-review":
        return prompt(scaffold(kind) + w(ideaWords + synopsisWords + rules + pitches * (T.designPitchWords + 40) + planReaders * pitches * (T.designPitchJudgementWords / 4 + 14)) + taste);
      case "design-chapter-review": {
        // The chapters under review in full, the chapters beside them, the structure of the book in a line each, and what the panel knows of the book.
        const batch = Math.min(DESIGN_REVIEW_BATCH_CHAPTERS, Math.max(1, toWrite));
        return prompt(scaffold(kind) + w(ideaWords + synopsisWords + Math.min(design, 3000 / CHARS_PER_WORD) + canon + rules + (batch + 2) * T.designEntryWords + ghostwriter / 2 + designLedgerContext) + taste + list(chapters));
      }
      case "design-coherence":
        // Every chapter of a window of the structure, the secrets with their ledger, and the world.
        return prompt(scaffold(kind) + w(ideaWords + synopsisWords + Math.min(design, 3000 / CHARS_PER_WORD) + canon + rules + Math.min(coherenceChapters, 36_000 / CHARS_PER_WORD / 1.6) + designLedgerContext));
      case "plan-reader":
        return prompt(scaffold(kind) + w(ideaWords + Math.min(design, 2500 / CHARS_PER_WORD) + (designing ? designEntries + designLedgerContext : 0)) + list(chapters) + (designing && flow.rubric ? rubricRequest : 0));
      case "plan-review":
        return prompt(scaffold(kind) + w(ideaWords + synopsisWords + Math.min(design, 5000 / CHARS_PER_WORD) + canon + T.secretLineWords + style / 2 + rules + planReaders * ((designing ? T.designReactionWords + (flow.rubric ? T.designRubricWords : 0) : T.planReactionWords) + 14) + (designing ? designEntries + designLedgerContext + 250 + chapterReviewLines + findingLines : 0)) + list(chapters) + outlineWordsCapped(12_000) + (designing && flow.rubric ? rubricRequest : 0));
      case "scenes":
        // The chapter before and the chapter after, one line each; the last chapter of the book has no next one.
        return prompt(scaffold(kind) + w(notes + T.chapterWords + canon + secrets + rules + Math.min(design, 2500 / CHARS_PER_WORD)) + line, [story(5000), { slope: closedLine, cap: closedLine }, notesRamp], -line);
      case "scene-summary":
        return prompt(scaffold(kind) + w(sceneWords));
      case "reader":
        return prompt(scaffold(kind) + chapterText, [story(3000)]);
      case "readers-summary":
        return prompt(scaffold(kind) + w(chapterReaders * (T.readerWords + 27)));
      case "specialists":
        return prompt(scaffold(kind) + w(ghostwriter + style + T.chapterWords + scenes * T.sceneLineWords + canon + secrets + rules) + entriesOfChapter + chapterText, [], 0, [earlierChapters]);
      case "director-review": {
        const readerLines = chapterReaders * T.readerLineWords + (chapterReaders > 0 ? T.readersSummaryWords + 25 : 0);
        return prompt(scaffold(kind) + w(notes + style + T.chapterWords + scenes * T.sceneLineWords + secrets + rules + readerLines + findingsLines * T.findingWords + proposals * T.proposalWords) + chapterText, [story(4000), notesRamp]);
      }
      case "repair":
        return prompt(scaffold(kind) + w(T.fixWords + ghostwriter + notes + T.sceneWords + secrets + rules + Math.min(400, sceneWords) + Math.min(150, sceneWords) + sceneWords) + entriesOfScene, [notesRamp]);
      case "consolidate":
        return prompt(scaffold(kind) + w(T.chapterWords) + chapterText, [story(7000)]);
      default:
        return prompt(scaffold(kind));
    }
  };

  /** The prompt of the scene `k` of a chapter: what the writer reads before it writes. */
  const writePrompt = (k: number): Prompt => {
    const previousEnding = k > 1 ? Math.min(400, sceneWords) : 0;
    const base = scaffold("write")
      + w(ghostwriter + notes + Math.min(world, 2000 / CHARS_PER_WORD) + T.chapterWords + (k - 1) * (T.summaryWords + 6) + previousEnding + T.sceneWords + (k < scenes ? T.sceneWords : 0) + secrets + rules)
      + entriesOfScene + taste;
    // The first scene of a chapter that is not the first begins after the last scene of the chapter before.
    const ramps: Ramp[] = [story(5000), notesRamp];
    if (k === 1) ramps.push({ slope: w(250), cap: w(250) });
    return prompt(base, ramps);
  };

  // ─── The replies, in words ────────────────────────────────────────────────
  const replyCap = (kind: EstimateCallKind): number => {
    if (PROSE_KINDS.has(kind)) return OUTPUT_TOKENS_CEILING;
    return scaleOutputTokens(replyLimitOf(kind, designing) ?? OUTPUT_TOKENS_CEILING, languageText);
  };
  /** The tokens of a reply of `words` words, no more than the pipeline lets it be. */
  const reply = (kind: EstimateCallKind, words: number): number => Math.min(replyCap(kind), words * tpw);
  const storyOut = (first: number, last: number): number => sumCappedRamp(T.storyWordsPerChapter, T.storyWordsTarget, first + 1, last + 1) * tpw;

  // The plan: a call for each batch of twenty chapters, asked again for every batch after each revision the director asks for. A revision of a plan in one batch
  // carries the plan as it is; one of a plan in several carries the batch as it is and the lines of the others.
  const planCalls = (() => {
    const base = scaffold("plan") + w(ideaWords + synopsisWords + Math.min(design, 6000 / CHARS_PER_WORD) + Math.min(world, 2500 / CHARS_PER_WORD) + canon + T.secretLineWords + T.revealsWords + rules) + taste + outlineWordsCapped(36_000)
      // A design also reads the ledger of the secrets, the themes and the rules of the world, and the ghostwriter who will write the book.
      + (designing ? w(designLedgerContext + 250) : 0);
    const alreadyWritten = written > 0 ? list(written, closedLine) + w(Math.min(T.storyWordsTarget, 4000 / CHARS_PER_WORD, T.storyWordsPerChapter * written)) : 0;
    const notesOfChanges = w(3 * 25);
    const result = { fresh: 0, revised: 0, output: 0, peakFresh: 0, peakRevised: 0 };
    for (let batch = 1; batch <= planBatches; batch += 1) {
      const inBatch = Math.min(batchSize, planCount - batchSize * (batch - 1));
      const before = planBatches > 1 ? (designing ? 0 : planned) + batchSize * (batch - 1) : 0;
      const first = base + alreadyWritten + list(before) + (extension ? list(planned) + notesOfChanges : 0);
      const again = planBatches > 1
        ? base + alreadyWritten + w(inBatch * T.chapterWords) + list(chapters - inBatch) + notesOfChanges
        : base + alreadyWritten + list(chapters) + notesOfChanges;
      // A design that is revised also reads the design of the chapters it revises.
      const designAgain = designing ? w(inBatch * T.designEntryWords) : 0;
      result.fresh += first;
      result.revised += again + designAgain;
      result.output += designing ? reply("plan", inBatch * T.designChapterReplyWords + T.designSecrets * T.designLedgerWords + 10) : reply("plan", inBatch * T.chapterReplyWords + 10);
      result.peakFresh = Math.max(result.peakFresh, first);
      result.peakRevised = Math.max(result.peakRevised, again, first);
    }
    return result;
  })();

  // The director's last look at the whole book: its design, its plot map (a summary and the scenes of each chapter), the story so far, a line for each chapter and the notes.
  const plotMapWords = Math.min(4000 / CHARS_PER_WORD, 40 + chapters * (T.chapterLineWords + scenes * T.summaryWords + 20));
  const notesAtTheEnd = Math.min(MAX_DIRECTOR_NOTES * T.noteWords, notes + T.noteWords * toWrite);
  const finalPrompt = scaffold("final")
    + w(Math.min(design, 5000 / CHARS_PER_WORD) + plotMapWords + Math.min(T.storyWordsTarget, 7000 / CHARS_PER_WORD, T.storyWordsPerChapter * chapters) + notesAtTheEnd + rules + style)
    + list(chapters, w(T.closedLineWords + 4));

  /** The largest prompt a call of this kind has in the run, in tokens: in the last chapter, the last scene of a chapter, the largest batch of the plan. */
  const peakOf = (kind: EstimateCallKind): number => {
    if (kind === "write") return promptPeak(writePrompt(scenes), chapters);
    if (kind === "plan") return revisions[1] > 0 ? planCalls.peakRevised : planCalls.peakFresh;
    if (kind === "final") return finalPrompt;
    return promptPeak(promptOf(kind), chapters);
  };

  // ─── One way the reviews turn out ─────────────────────────────────────────
  const compute = ({ rounds: r, repairs: p, revisions: v, light }: Point): PointResult => {
    const points = Object.fromEntries(ESTIMATE_CALL_KINDS.map((kind) => [kind, { calls: 0, input: 0, output: 0, prefix: 0 }])) as PointResult;
    const add = (kind: EstimateCallKind, calls: number, input: number, output: number) => {
      const point = points[kind];
      point.calls += calls;
      point.input += input;
      point.output += output;
      point.prefix += servedFromCache(prefix(kind)) * calls;
    };
    // The alternatives of a design, before it is made: the pitches, what each reader thinks of them, and the director's choice.
    if (designing && pitches > 0 && !conceptDone) {
      add("design-pitches", 1, promptOf("design-pitches").base, reply("design-pitches", pitches * T.designPitchWords + 10));
      if (planReaders > 0) add("design-pitch-reader", planReaders, planReaders * promptOf("design-pitch-reader").base, planReaders * reply("design-pitch-reader", pitches * T.designPitchJudgementWords + 10));
      add("design-pitch-review", 1, promptOf("design-pitch-review").base, reply("design-pitch-review", pitches * T.designPitchJudgementWords + 60));
    }
    if (!conceptDone) add("concept", 1, promptOf("concept").base, reply("concept", designing ? T.designConceptWords : T.conceptWords));
    if (withoutSummary > 0) add("summarize-imported", withoutSummary, withoutSummary * promptOf("summarize-imported").base, withoutSummary * reply("summarize-imported", T.importedSummaryWords));

    if (planBatches > 0) {
      add("plan", planBatches * (1 + v), planCalls.fresh + v * planCalls.revised, planCalls.output * (1 + v));
      // The director's review of a design answers with the twelve criteria when the workflow asks, and with its decisions about the findings of the analysis.
      const reviewWords = designing ? T.designReviewWords + (flow.rubric ? T.designRubricWords : 0) + (flow.coherence ? T.designDecisionWords : 0) : T.planReviewWords;
      add("plan-review", 1 + v, (1 + v) * promptOf("plan-review").base, (1 + v) * reply("plan-review", reviewWords));
      // The chapters of a design are judged one batch after another; each revision judges them again, all of them at the most; the structure is analysed again after each.
      if (designing && chapterReviewBatches > 0) {
        add("design-chapter-review", chapterReviewBatches * (1 + v), chapterReviewBatches * (1 + v) * promptOf("design-chapter-review").base, chapterReviewBatches * (1 + v) * reply("design-chapter-review", (toWrite / chapterReviewBatches) * T.designChapterReviewWords + 10));
      }
      if (designing && coherenceCalls > 0) add("design-coherence", coherenceCalls * (1 + v), coherenceCalls * (1 + v) * promptOf("design-coherence").base, coherenceCalls * (1 + v) * reply("design-coherence", T.designCoherenceWords));
    }
    // The readers of a design read it before its first reviews, as many as its policy says.
    const readings = designing ? Math.min(designReaderRounds, 1 + v) : 1;
    if (freshPlan && planReaders > 0) add("plan-reader", planReaders * readings, planReaders * readings * promptOf("plan-reader").base, planReaders * readings * reply("plan-reader", designing ? T.designReactionWords + (flow.rubric ? T.designRubricWords : 0) : T.planReactionWords));

    // A design writes no chapter, and nobody judges a book that is not written.
    if (designing) return points;
    const count = toWrite;
    if (count > 0) {
      const to = chapters;
      // The chapters that are only read (their readers' vote is all a review of the book needs of them) and those that are reviewed whole.
      const read = light ? Math.min(checkOnly, count) : 0;
      const share = (count - read) / count;
      const perChapter = (kind: EstimateCallKind, calls: number, replyWords: number, call: Prompt = promptOf(kind), part: number = share) => {
        if (calls <= 0 || part <= 0) return;
        add(kind, calls * count * part, calls * promptTotal(call, from, to) * part, calls * count * part * reply(kind, replyWords));
      };
      // A chapter only reviewed again (a review of the book) has its scenes already: no plan of scenes, no writing, only the summaries of its repairs.
      const reviewOnly = progress.reviewOnly === true;
      if (!reviewOnly) {
        perChapter("scenes", 1, scenes * T.sceneReplyWords + 5);
        // The scenes: each is written with what the scenes before it did, and summarized after; a repair is summarized too.
        let writeInput = 0;
        for (let k = 1; k <= scenes; k += 1) writeInput += promptTotal(writePrompt(k), from, to);
        add("write", scenes * count, writeInput, scenes * count * reply("write", sceneWords));
      }
      perChapter("scene-summary", (reviewOnly ? 0 : scenes) + p, T.summaryWords);
      // The readers read in the first rounds the policy says, as many as the rounds of this scenario.
      const readingRounds = Math.min(readerRounds, r);
      // With targets for the readers they read again once the chapter was corrected, before it is closed (after each round, at the most, that corrected something).
      const closingReads = readersGate && p > 0 ? r : 0;
      perChapter("reader", chapterReaders * (readingRounds + closingReads), T.readerWords);
      perChapter("readers-summary", chapterReaders > 0 ? readingRounds + closingReads : 0, T.readersSummaryWords);
      // The chapters only read: their readers read them once, and the summary is made.
      if (read > 0) {
        perChapter("reader", chapterReaders, T.readerWords, promptOf("reader"), 1 - share);
        perChapter("readers-summary", 1, T.readersSummaryWords, promptOf("readers-summary"), 1 - share);
      }
      // The rounds after the first: the proposals of the readers are gone (counted in the first round only, also when the policy has them read again: a little
      // under) and the fixes of the round before are told to the specialists and to the director.
      const carried = r > 1 ? Math.min(scenes, p / (r - 1)) : 0;
      const fixes = w(carried * (T.fixWords + 3));
      const later = (call: Prompt, dropped = 0): Prompt => ({ ...call, base: call.base - dropped + fixes });
      const findingsReply = T.findings * T.findingReplyWords + 10;
      perChapter("specialists", specialists, findingsReply);
      perChapter("specialists", specialists * (r - 1), findingsReply, later(promptOf("specialists")));
      perChapter("director-review", 1, T.directorBaseWords + (findingsLines + proposals) * T.decisionWords);
      // The standing guidance (a note for a chapter) is asked for once, in the first round.
      perChapter("director-review", r - 1, T.directorBaseWords - T.noteWords + findingsLines * T.decisionWords, later(promptOf("director-review"), w(proposals * T.proposalWords)));
      // Each fix the director accepts is a remediation it writes out, for the repair to follow.
      if (p > 0) add("director-review", 0, 0, count * share * p * reply("director-review", T.fixWords));
      perChapter("repair", p, sceneWords);
      const closing = promptTotal(promptOf("consolidate"), from, to);
      add("consolidate", count * share, closing * share, count * share * reply("consolidate", T.consolidateBaseWords + scenes * T.recapSceneWords) + storyOut(from, to) * share);
    }
    if (count > 0 || !finalDone) add("final", 1, finalPrompt, reply("final", T.finalWords));
    return points;
  };

  const lowest = compute({ rounds: rounds[0], repairs: repairs[0], revisions: revisions[0], light: true });
  const highest = compute({ rounds: rounds[1], repairs: repairs[1], revisions: revisions[1] });

  // ─── The models ───────────────────────────────────────────────────────────
  const modelsInput = asRecord(source.models);
  const models = Object.fromEntries(ESTIMATE_CAPABILITIES.map((capability) => [capability, resolveModel(modelsInput[capability])])) as Record<EstimateCapability, ResolvedModel | null>;

  /** The largest answer a call of this kind may ask for, as the router sends it: the structured floor, the room for the reasoning, and the model's own maximum. */
  const requestLimit = (kind: EstimateCallKind, model: ResolvedModel): number => {
    const requested = PROSE_KINDS.has(kind) ? Math.min(OUTPUT_TOKENS_CEILING, Math.ceil(Math.max(sceneWords, kind === "repair" ? 300 : 0) * tpw) + 800) : scaleOutputTokens(replyLimitOf(kind, designing) ?? OUTPUT_TOKENS_CEILING, languageText);
    let limit = PROSE_KINDS.has(kind) ? requested : Math.max(requested, STRUCTURED_OUTPUT_FLOOR);
    if (model.reasoning) limit += REASONING_OUTPUT_MARGIN;
    return model.maxOutput ? Math.min(limit, model.maxOutput) : limit;
  };

  const steps = {} as Record<EstimateCallKind, EstimateStep>;
  const capabilityTotals = Object.fromEntries(ESTIMATE_CAPABILITIES.map((capability) => [capability, {
    calls: rangeOf(0, 0), inputTokens: rangeOf(0, 0), cachedInputTokens: rangeOf(0, 0), outputTokens: rangeOf(0, 0),
  }])) as Record<EstimateCapability, { calls: EstimateRange; inputTokens: EstimateRange; cachedInputTokens: EstimateRange; outputTokens: EstimateRange }>;
  /** What the estimate counts on for the cache of the model of a capability (see `EstimateCacheBasis`): nothing without a cached price or for a model declared as not caching. */
  const basisOf = (capability: EstimateCapability): EstimateCacheBasis => {
    const model = models[capability];
    if (model?.price?.cached === undefined || model.noCache) return "none";
    return model.hitRate !== undefined ? "measured" : "structural";
  };
  /** The tokens a cache is written with when it is cold, by capability: the part of the fixed start of the requests that a provider caches, which the worst case bills at the write price of a provider that charges more for it. */
  const coldWritten: Record<EstimateCapability, number> = Object.fromEntries(ESTIMATE_CAPABILITIES.map((capability) => [capability, 0])) as Record<EstimateCapability, number>;
  for (const kind of ESTIMATE_CALL_KINDS) {
    const capability = CAPABILITY_OF[kind];
    const low = lowest[kind];
    const high = highest[kind];
    // A reply is never more than the largest the model can give.
    const modelMax = models[capability]?.maxOutput;
    const outputLow = modelMax ? Math.min(low.output, low.calls * modelMax) : low.output;
    const outputHigh = modelMax ? Math.min(high.output, high.calls * modelMax) : high.output;
    steps[kind] = {
      capability,
      calls: rangeOf(low.calls, high.calls),
      inputTokens: roundRange(low.input, high.input),
      outputTokens: roundRange(outputLow, outputHigh),
    };
    const totals = capabilityTotals[capability];
    const basis = basisOf(capability);
    const rate = models[capability]?.hitRate ?? 0;
    const cached = basis === "none" ? [0, 0] : basis === "measured" ? [low.input * rate, high.input * rate] : [Math.min(low.prefix, low.input), Math.min(high.prefix, high.input)];
    if (!models[capability]?.noCache) coldWritten[capability] += Math.min(high.prefix, high.input);
    const sumInto = (target: EstimateRange, range: EstimateRange) => {
      target.min += range.min;
      target.max += range.max;
    };
    sumInto(totals.calls, steps[kind].calls);
    sumInto(totals.inputTokens, steps[kind].inputTokens);
    sumInto(totals.outputTokens, steps[kind].outputTokens);
    sumInto(totals.cachedInputTokens, roundRange(cached[0], cached[1]));
  }

  // ─── Money and time, by capability ────────────────────────────────────────
  const unpriced: EstimateCapability[] = [];
  const unmeasured: EstimateCapability[] = [];
  const capabilities = {} as Record<EstimateCapability, EstimateCapabilityResult>;
  let costMin = 0;
  let costMax = 0;
  let minutesMin = 0;
  let minutesMax = 0;
  for (const capability of ESTIMATE_CAPABILITIES) {
    const totals = capabilityTotals[capability];
    const model = models[capability];
    const idle = totals.calls.max === 0;
    let cost: EstimateRange | null = rangeOf(0, 0);
    let minutes: EstimateRange | null = rangeOf(0, 0);
    if (!idle) {
      if (!model?.price) {
        cost = null;
        unpriced.push(capability);
      } else {
        const { input, output, cached, write } = model.price;
        const cachedLow = cached === undefined ? 0 : totals.cachedInputTokens.min;
        // The worst case counts no cache, and a cold one: a provider that charges more for what it writes to its cache than for the input bills the start of every request at that price.
        const premium = write !== undefined && !model.noCache ? coldWritten[capability] * (write - input) : 0;
        cost = rangeOf(((totals.inputTokens.min - cachedLow) * input + cachedLow * (cached ?? input) + totals.outputTokens.min * output) / 1e6, (totals.inputTokens.max * input + premium + totals.outputTokens.max * output) / 1e6);
      }
      if (!model?.speed) {
        minutes = null;
        unmeasured.push(capability);
      } else {
        minutes = rangeOf(totals.outputTokens.min / model.speed / 60, totals.outputTokens.max / model.speed / 60);
      }
    }
    if (cost) {
      costMin += cost.min;
      costMax += cost.max;
    }
    if (minutes) {
      minutesMin += minutes.min;
      minutesMax += minutes.max;
    }
    capabilities[capability] = { model: model?.name ?? null, ...totals, cacheBasis: basisOf(capability), cost, minutes };
  }

  // ─── What the author should know before it starts ────────────────────────
  const text = estimateTexts(italian);
  const warnings: EstimateWarning[] = [];
  for (const capability of ESTIMATE_CAPABILITIES) {
    const totals = capabilityTotals[capability];
    if (totals.calls.max === 0) continue;
    const model = models[capability];
    if (!model) {
      warnings.push({ code: "noModel", severity: "error", capability, text: text.noModel(capability) });
      continue;
    }
    const kinds = ESTIMATE_CALL_KINDS.filter((kind) => CAPABILITY_OF[kind] === capability && highest[kind].calls > 0);
    if (model.window) {
      // The window is judged by the most demanding step: the largest prompt against what the engine leaves for a prompt once the step's own reply is reserved.
      let worst: { kind: EstimateCallKind; peak: number; budget: number } | null = null;
      for (const kind of kinds) {
        const peak = Math.round(peakOf(kind));
        const budget = resolveModelTokenBudgets(model.window, requestLimit(kind, model)).inputTokens;
        if (!worst || peak / Math.max(1, budget) > worst.peak / Math.max(1, worst.budget)) worst = { kind, peak, budget };
      }
      if (worst && worst.peak * 1.25 > worst.budget) {
        const fits = worst.peak <= worst.budget;
        warnings.push({ code: "smallWindow", severity: fits ? "warning" : "error", capability, model: model.name, step: worst.kind, window: model.window, inputBudget: worst.budget, typicalPrompt: worst.peak, text: text.smallWindow(capability, model.name, model.window, worst.budget, worst.peak, worst.kind, fits) });
      }
    }
    if (model.maxOutput) {
      let longest: { kind: EstimateCallKind; reply: number } | null = null;
      for (const kind of kinds) {
        const perCall = highest[kind].output / highest[kind].calls;
        if (!longest || perCall > longest.reply) longest = { kind, reply: perCall };
      }
      if (longest && Math.round(longest.reply) > model.maxOutput) {
        warnings.push({ code: "smallOutput", severity: "warning", capability, model: model.name, step: longest.kind, maxOutputTokens: model.maxOutput, typicalReply: Math.round(longest.reply), text: text.smallOutput(capability, model.name, model.maxOutput, Math.round(longest.reply), longest.kind) });
      }
    }
    if (!model.price) warnings.push({ code: "noPrice", severity: "warning", capability, model: model.name, text: text.noPrice(capability, model.name) });
    if (!model.speed) warnings.push({ code: "noSpeed", severity: "info", capability, model: model.name, text: text.noSpeed(capability, model.name) });
    if (model.reasoning) warnings.push({ code: "reasoningModel", severity: "info", capability, model: model.name, text: text.reasoningModel(capability, model.name) });
  }
  const gravity = { error: 0, warning: 1, info: 2 } as const;
  warnings.sort((left, right) => gravity[left.severity] - gravity[right.severity]);

  const sumKinds = (select: (step: EstimateStep) => EstimateRange): EstimateRange => ESTIMATE_CALL_KINDS.reduce((total, kind) => ({ min: total.min + select(steps[kind]).min, max: total.max + select(steps[kind]).max }), rangeOf(0, 0));
  const cachedTotal = ESTIMATE_CAPABILITIES.reduce((total, capability) => ({ min: total.min + capabilities[capability].cachedInputTokens.min, max: total.max + capabilities[capability].cachedInputTokens.max }), rangeOf(0, 0));
  const currency = typeof source.currency === "string" && source.currency.trim() ? source.currency.trim() : undefined;
  const label = (range: EstimateRange): string => `${range.min}-${range.max}`;
  const assumptions = text.assumptions({
    ...(designing ? { design: { batch: batchSize, rounds: designRounds, readerRounds: designReaderRounds, workflow: { rubric: flow.rubric, chapterReview: flow.chapterReview, coherence: flow.coherence, alternatives: flow.alternatives } } } : {}),
    chapters,
    written: Math.min(written, chapters),
    toWrite,
    scenes,
    wordsPerScene: sceneWords,
    words: toWrite * chapterWords,
    pinned,
    rounds: label(roundRange(rounds[0], rounds[1])),
    repairs: label(roundRange(repairs[0], repairs[1])),
    revisions: label(roundRange(revisions[0], revisions[1])),
    maxRounds,
    readers: chapterReaders,
    planReaders: planBatches > 0 && freshPlan ? planReaders : 0,
    panel,
    specialists: Boolean(specialists),
    tokensPerWord: tpw,
    inputPerWord: INPUT_TOKENS_PER_WORD * ratio,
    cached: ESTIMATE_CAPABILITIES.some((capability) => basisOf(capability) !== "none" && capabilityTotals[capability].calls.max > 0),
    ...(() => {
      const measured = ESTIMATE_CAPABILITIES.filter((capability) => basisOf(capability) === "measured" && capabilityTotals[capability].calls.max > 0);
      const rates = measured.map((capability) => Math.round((models[capability]?.hitRate ?? 0) * 100));
      return measured.length ? { cacheMeasured: { min: Math.min(...rates), max: Math.max(...rates) } } : {};
    })(),
    outlineWords: Math.round(outlineWords),
  });

  return {
    language,
    chapters,
    chaptersToWrite: designing ? 0 : toWrite,
    words: designing ? 0 : toWrite * chapterWords,
    calls: sumKinds((step) => step.calls),
    inputTokens: sumKinds((step) => step.inputTokens),
    cachedInputTokens: cachedTotal,
    outputTokens: sumKinds((step) => step.outputTokens),
    cost: unpriced.length ? null : { min: costMin, max: costMax, ...(currency ? { currency } : {}) },
    unpriced,
    minutes: unmeasured.length ? null : rangeOf(minutesMin, minutesMax),
    unmeasured,
    capabilities,
    steps,
    warnings,
    assumptions,
  };
}

// ─── From what the host has ─────────────────────────────────────────────────

/** What a host knows of how fast its models write: `measuredSpeed` gives a map like this one. */
export type EstimateSpeeds = ReadonlyMap<string, { tokensPerSecond: number }> | Readonly<Record<string, { tokensPerSecond: number } | undefined>>;

/** The share of the input of each model that its provider served from its cache, as the host measured it in its ledger (0 to 1), by the name of the model. */
export type EstimateCacheHitRates = ReadonlyMap<string, number> | Readonly<Record<string, number | undefined>>;

function cacheHitRateOf(rates: EstimateCacheHitRates | undefined, model: string): number | undefined {
  if (!rates) return undefined;
  const value = rates instanceof Map ? rates.get(model) : Object.prototype.hasOwnProperty.call(rates, model) ? (rates as Readonly<Record<string, number | undefined>>)[model] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}

function speedOfModel(speeds: EstimateSpeeds | undefined, model: string): number | undefined {
  if (!speeds) return undefined;
  const entry = speeds instanceof Map ? speeds.get(model) : Object.prototype.hasOwnProperty.call(speeds, model) ? (speeds as Record<string, { tokensPerSecond: number } | undefined>)[model] : undefined;
  const speed = entry?.tokensPerSecond;
  return typeof speed === "number" && Number.isFinite(speed) && speed > 0 ? speed : undefined;
}

/**
 * The model of each capability as the router would choose it (the first of `resolveAiCandidates`): its name, its window, its largest answer, its prices, whether it
 * reasons, and the speed `speeds` has for it. No key, no address: only what the estimate reads. A capability the configuration has no model for is not in the answer.
 */
export function estimateModelsFromConfig(config: AiRuntimeConfig | null | undefined, speeds?: EstimateSpeeds, caching?: EstimateCacheHitRates): Partial<Record<EstimateCapability, EstimateModel>> {
  const models: Partial<Record<EstimateCapability, EstimateModel>> = {};
  for (const capability of ESTIMATE_CAPABILITIES) {
    const model = estimateModelOf(config, capability, speeds, caching);
    if (model) models[capability] = model;
  }
  return models;
}

/** The model of one task as the router would choose it, as `estimateModelsFromConfig` describes it; `null` when the configuration has none for it. */
export function estimateModelOf(config: AiRuntimeConfig | null | undefined, capability: string, speeds?: EstimateSpeeds, caching?: EstimateCacheHitRates): EstimateModel | null {
  const configuration = asRecord(config);
  if (!Array.isArray(configuration.aiIntegrations)) return null;
  const usable = { ...configuration, aiIntegrations: configuration.aiIntegrations.filter((integration) => integration && typeof integration === "object") } as unknown as AiRuntimeConfig;
  let candidate: ReturnType<typeof resolveAiCandidates>[number] | undefined;
  try {
    candidate = resolveAiCandidates(usable, capability)[0];
  } catch {
    // A configuration the router cannot read has no model for this capability.
  }
  if (!candidate) return null;
  const model: EstimateModel = { model: candidate.model };
  if (candidate.integration.provider === "azure_openai") model.provider = "azure_openai";
  if (candidate.underlyingModel) model.underlyingModel = candidate.underlyingModel;
  if (candidate.maxInputTokens) model.maxInputTokens = candidate.maxInputTokens;
  if (candidate.maxOutputTokens) model.maxOutputTokens = candidate.maxOutputTokens;
  const pricing: NonNullable<EstimateModel["pricing"]> = {};
  for (const key of ["inputPerMTok", "cachedPerMTok", "cacheWritePerMTok", "outputPerMTok"] as const) {
    const price = candidate.pricing?.[key];
    if (typeof price === "number" && Number.isFinite(price)) pricing[key] = price;
  }
  if (Object.keys(pricing).length) model.pricing = pricing;
  if (candidate.supportsReasoning !== undefined) model.supportsReasoning = candidate.supportsReasoning;
  if (candidate.promptCaching) model.promptCaching = candidate.promptCaching;
  const rate = cacheHitRateOf(caching, candidate.model);
  if (rate !== undefined) model.cacheHitRate = rate;
  const speed = speedOfModel(speeds, candidate.model);
  if (speed) model.tokensPerSecond = speed;
  return model;
}

/**
 * Where a book is, read from the state of the autopilot: the chapters done, the chapters of the plan when it is approved, whether the concept and the judgement of
 * the whole book are done, and the chapters the author wrote that have no summary yet. What `EstimateInput.progress` takes for a book that is already started.
 */
export function estimateProgressFromState(state: Pick<AutopilotState, "plan" | "concept" | "finalDone"> | null | undefined): Required<Omit<EstimateProgress, "withoutSummaryWords" | "reviewOnly" | "checkOnly">> {
  const source = asRecord(state);
  const plan = asRecord(source.plan);
  const chapters = Array.isArray(plan.chapters) ? plan.chapters.map(asRecord) : [];
  const done = chapters.filter((chapter) => chapter.status === "done");
  return {
    chaptersDone: done.length,
    planned: plan.approved === true ? chapters.length : 0,
    conceptDone: asRecord(source.concept).done === true,
    finalDone: source.finalDone === true,
    withoutSummary: done.filter((chapter) => chapter.imported === true && !(typeof chapter.summary === "string" && chapter.summary.trim())).length,
  };
}

/**
 * Where a book is by its chapters alone, for a book the autopilot has not started (it has no state): every chapter with prose is the author's, so it is done, and the ones
 * with no summary each cost a call before the plan. `snapshot.chapters` is what it takes. For a book with a state, `estimateProgressFromState` is the one to use.
 */
export function estimateProgressFromChapters(chapters: ReadonlyArray<{ summary?: string | null; paragraphs?: ReadonlyArray<unknown> | null }> | null | undefined): Required<Pick<EstimateProgress, "chaptersDone" | "withoutSummary">> {
  const written = (Array.isArray(chapters) ? chapters : []).filter((chapter) => chapter && typeof chapter === "object" && Array.isArray(chapter.paragraphs) && chapter.paragraphs.length > 0);
  return {
    chaptersDone: written.length,
    withoutSummary: written.filter((chapter) => !(typeof chapter.summary === "string" && chapter.summary.trim())).length,
  };
}

/**
 * What the state knows of the words the prompts carry: the author's rules (`constraints`), and the standing guidance of the director (`directorNotes`) once the plan is
 * approved. What `EstimateInput.context` takes for a book that is already started, so that the estimate does not start from the typical notes of a book that has none.
 */
export function estimateContextFromState(state: Pick<AutopilotState, "constraints" | "directorNotes" | "plan"> | null | undefined): Pick<EstimateContext, "rulesWords" | "notesWords"> {
  const source = asRecord(state);
  const words = (list: unknown): number => (Array.isArray(list) ? list.reduce((total: number, entry) => total + (typeof entry === "string" ? countWords(entry) : 0), 0) : 0);
  return {
    rulesWords: words(source.constraints),
    ...(asRecord(source.plan).approved === true ? { notesWords: words(source.directorNotes) } : {}),
  };
}
