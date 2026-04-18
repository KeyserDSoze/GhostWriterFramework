import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fg from "fast-glob";
import matter from "gray-matter";
import { marked } from "marked";
import {
  BOOK_DIRECTORIES,
  BOOK_FILE,
  CONTEXT_FILE,
  CONTENT_GLOB,
  DEFAULT_CANON,
  ENTITY_TYPE_TO_DIRECTORY,
  ENTITY_TYPES,
  GUIDELINE_FILES,
  IDEAS_FILE,
  NOTES_FILE,
  PERSONAS_DIRECTORY,
  PERSONAS_REVIEW_FILENAME,
  PLOT_FILE,
  PROMOTED_FILE,
  SKILL_NAME,
  STORY_STATE_CURRENT_FILE,
  STORY_STATE_STATUS_FILE,
  STORY_DESIGN_FILE,
  TIMELINE_MAIN_FILE,
  TOTAL_EVALUATION_FILE,
  TOTAL_RESUME_FILE,
} from "./constants.js";
import {
  assetSchema,
  bookSchema,
  characterSchema,
  chapterSchema,
  chapterDraftSchema,
  contextSchema,
  entitySchemaMap,
  factionSchema,
  guidelineSchema,
  itemSchema,
  locationSchema,
  noteSchema,
  paragraphSchema,
  paragraphDraftSchema,
  personaSchema,
  plotSchema,
  researchNoteSchema,
  secretSchema,
  workItemEntrySchema,
  type BookFrontmatter,
  type AssetFrontmatter,
  type CharacterFrontmatter,
  type ChapterFrontmatter,
  type ChapterDraftFrontmatter,
  type ContextFrontmatter,
  type EntityType,
  type FactionFrontmatter,
  type GuidelineFrontmatter,
  type ItemFrontmatter,
  type LocationFrontmatter,
  type NoteFrontmatter,
  type ParagraphFrontmatter,
  type ParagraphDraftFrontmatter,
  type PersonaFrontmatter,
  type PlotFrontmatter,
  type SecretFrontmatter,
  type TimelineEventFrontmatter,
  type WorkItemEntryFrontmatter,
} from "./schemas.js";
import { skillTemplate } from "./skill-template.js";
import { defaultBodyForType, renderMarkdown } from "./templates.js";
import {
  chapterSlug,
  excerptAround,
  formatOrdinal,
  normalizeChapterReference,
  paragraphFilename,
  pathExists,
  slugify,
  toPosixPath,
} from "./utils.js";

type MarkdownDocument<T = Record<string, unknown>> = {
  frontmatter: T;
  body: string;
  path: string;
};

const SUPPORTED_REFERENCE_PATTERN = /\b(?:chapter:[a-z0-9-]+|paragraph:[a-z0-9-]+:[a-z0-9-]+|character:[a-z0-9-]+|location:[a-z0-9-]+|faction:[a-z0-9-]+|item:[a-z0-9-]+|secret:[a-z0-9-]+|timeline-event:[a-z0-9-]+|guideline:[a-z0-9-]+|style:[a-z0-9-]+)\b/gi;
const OPENCODE_INSTRUCTION_FILE = ".github/copilot-instructions.md";
const LEGACY_WRITING_GUIDELINE_FILES = [
  "guidelines/prose.md",
  "guidelines/style.md",
  "guidelines/voices.md",
  "guidelines/chapter-rules.md",
  "guidelines/structure.md",
] as const;
const LEGACY_WRITING_GUIDELINE_DIRECTORIES = ["guidelines/styles"] as const;
const QUERY_CANON_LEXICONS: Record<string, QueryCanonLexicon> = {
  en: {
    chapterAliases: ["chapter", "chap", "chap."],
    firstAppearancePhrases: ["first appear", "first appears", "first show", "first mention"],
    secretHolderPhrases: ["who knows", "who is aware"],
    relationshipPhrases: ["relationship", "relation to", "trust", "ally", "enemy", "friend", "feels about", "relationship with"],
    conditionPhrases: ["condition", "status", "wound", "wounds", "injured", "injury", "hurt"],
    openLoopPhrases: ["open loop", "open loops", "unresolved", "unresolved thread", "pending thread"],
    wherePhrases: ["where", "located"],
    knowledgePhrases: ["know", "knows", "knows after", "know after"],
    inventoryPhrases: ["inventory", "is carrying", "what carries", "have", "has"],
    betweenWords: ["between"],
    andWords: ["and"],
    fromWords: ["from"],
    toWords: ["to", "through"],
    stopWords: ["who", "what", "when", "where", "does", "did", "is", "are", "the", "a", "an", "after", "before", "know", "knows", "have", "has", "first", "appear", "appears", "show", "shows", "up"],
  },
  it: {
    chapterAliases: ["capitolo", "cap."],
    firstAppearancePhrases: ["prima apparizione", "compare per la prima volta", "quando compare", "quando appare"],
    secretHolderPhrases: ["chi sa", "chi conosce"],
    relationshipPhrases: ["rapporto", "fiducia", "si fida", "alleato", "nemico", "amico"],
    conditionPhrases: ["come sta", "condizione", "condizioni", "ferito", "ferita", "feriti", "ferite"],
    openLoopPhrases: ["questioni aperte", "fili aperti", "irrisolto", "irrisolti"],
    wherePhrases: ["dove", "si trova"],
    knowledgePhrases: ["cosa sa", "sa di", "sa dopo"],
    inventoryPhrases: ["cosa ha", "porta con", "possiede"],
    betweenWords: ["tra", "fra"],
    andWords: ["e"],
    fromWords: ["da", "dal"],
    toWords: ["a", "al", "fino al"],
    stopWords: ["chi", "cosa", "quando", "dove", "il", "lo", "la", "gli", "le", "un", "una", "sa", "sanno", "ha", "hanno", "compare", "appaiono", "apparizione", "prima", "volta", "al", "nel", "si", "trova"],
  },
};
const CANON_ENTITY_LINK_REFERENCE_PATTERN = /^(character|location|faction|item|secret|timeline-event):[a-z0-9-]+$/i;
const STORY_MARKDOWN_LINK_PATTERN = /(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;

type SearchHit = {
  path: string;
  score: number;
  title: string;
  type: string;
  excerpt: string;
};

export type QueryCanonConfidence = "high" | "medium" | "low";

export type QueryCanonIntent =
  | "state-location"
  | "state-knowledge"
  | "state-inventory"
  | "state-relationship"
  | "state-relationship-arc"
  | "state-condition"
  | "state-condition-arc"
  | "state-open-loops"
  | "state-open-loops-arc"
  | "secret-holders"
  | "first-appearance"
  | "general";

export type QueryCanonSource = {
  path: string;
  title: string;
  type: string;
  reason: string;
};

export type QueryCanonResult = {
  question: string;
  answer: string;
  confidence: QueryCanonConfidence;
  intent: QueryCanonIntent;
  sources: QueryCanonSource[];
  notes: string[];
  matchedTarget?: string;
  throughChapter?: string;
  fromChapter?: string;
  toChapter?: string;
};

export type RevisionMode =
  | "clarity"
  | "pacing"
  | "dialogue"
  | "voice"
  | "tension"
  | "show-dont-tell"
  | "redundancy";

export type RevisionIntensity = "light" | "medium" | "strong";

export type RevisionContinuityImpact = "none" | "possible" | "clear";

export type ReviseParagraphResult = {
  filePath: string;
  chapter: string;
  paragraph: string;
  mode: RevisionMode;
  intensity: RevisionIntensity;
  preserveFacts: boolean;
  originalBody: string;
  proposedBody: string;
  editorialNotes: string[];
  continuityImpact: RevisionContinuityImpact;
  suggestedStateChanges?: StoryStateChanges;
  shouldReviewStateChanges: boolean;
  sources: string[];
};

export type ReviseChapterSceneProposal = {
  filePath: string;
  paragraph: string;
  title: string;
  originalBody: string;
  proposedBody: string;
  editorialNotes: string[];
  continuityImpact: RevisionContinuityImpact;
  suggestedStateChanges?: StoryStateChanges;
  shouldReviewStateChanges: boolean;
  changed: boolean;
};

export type ReviseChapterResult = {
  filePath: string;
  chapter: string;
  chapterTitle: string;
  mode: RevisionMode;
  intensity: RevisionIntensity;
  preserveFacts: boolean;
  sceneCount: number;
  changedSceneCount: number;
  chapterDiagnosis: string[];
  revisionPlan: string[];
  proposedParagraphs: ReviseChapterSceneProposal[];
  overallContinuityImpact: RevisionContinuityImpact;
  suggestedStateChanges?: StoryStateChanges;
  shouldReviewStateChanges: boolean;
  sources: string[];
};

export type DialogueActionBeatReviewChoice = {
  choiceId: string;
  operation: "keep" | "replace" | "insert_before" | "insert_after" | "remove";
  label: string;
  proposedText: string;
  usesSaidFallback: boolean;
  addsNewAction: boolean;
  confidence: "low" | "medium" | "high";
  rationale: {
    psychology: string[];
    sceneSpace: string[];
    subtext: string[];
    relationshipDynamics: string[];
    canon: string[];
  };
};

export type DialogueActionBeatProposal = {
  beatId: string;
  order: number;
  speaker?: string;
  actedCharacter?: string;
  beatKind: "dialogue" | "action" | "gap";
  quoteText: string;
  currentBeatText?: string;
  anchor: {
    previousExcerpt?: string;
    currentExcerpt: string;
    nextExcerpt?: string;
  };
  purposeAssessment: "strong" | "weak" | "redundant" | "unclear" | "misaligned";
  diagnosis: string[];
  choices: DialogueActionBeatReviewChoice[];
  recommendedChoiceId: string;
};

export type DialogueActionTicSuggestion = {
  characterId: string;
  ticText: string;
  kind: "gesture" | "speech" | "avoidance" | "stress-response";
  confidence: "low" | "medium" | "high";
  reason: string;
  evidence: string[];
  recommendation: "observe_only" | "candidate_for_canon";
};

export type ReviewDialogueActionBeatsResult = {
  reviewId: string;
  filePath: string;
  chapter: string;
  paragraph: string;
  paragraphHash: string;
  originalBody: string;
  previewBody: string;
  continuityImpact: RevisionContinuityImpact;
  suggestedStateChanges?: StoryStateChanges;
  editorialNotes: string[];
  beatProposals: DialogueActionBeatProposal[];
  ticSuggestions: DialogueActionTicSuggestion[];
  sources: string[];
};

export type ApplyDialogueActionBeatsResult = {
  filePath: string;
  chapter: string;
  paragraph: string;
  reviewId: string;
  changedBeatCount: number;
  appliedSelections: Array<{
    beatId: string;
    choiceId: string;
    operation: DialogueActionBeatReviewChoice["operation"];
  }>;
  updatedBody: string;
  continuityImpact: RevisionContinuityImpact;
  suggestedStateChanges?: StoryStateChanges;
};

export type WikipediaResearchSnapshot = {
  filePath: string;
  relativePath: string;
  title: string;
  sourceUrl: string;
  retrievedAt: string;
  summary: string;
  body: string;
};

type CanonEntityDocument = {
  slug: string;
  path: string;
  metadata: Record<string, unknown>;
  body: string;
};

type GuidelineDocument = MarkdownDocument<GuidelineFrontmatter> & {
  slug: string;
};

type EvaluationStyleContext = {
  globalWritingStyle: GuidelineDocument | null;
  chapterWritingStyle: GuidelineDocument | null;
  draftWritingStyle: GuidelineDocument | null;
  metadataSignals: Array<{ key: string; value: string }>;
  expectationText: string;
  showDontTell: boolean;
  prefersShortSentences: boolean;
  prefersLyricalImagery: boolean;
  valuesDialogue: boolean;
  valuesPhysicality: boolean;
  valuesActiveSpace: boolean;
  valuesObjectFunction: boolean;
  valuesSubtext: boolean;
  valuesControlledProse: boolean;
};

type EvaluationCanonEntity = {
  kind: EntityType | "timeline-event";
  id: string;
  title: string;
  path: string;
  aliases: string[];
  coherenceHints: string[];
};

type EvaluationCanonContext = {
  entities: EvaluationCanonEntity[];
  byId: Map<string, EvaluationCanonEntity>;
};

type ChapterReadResult = {
  metadata: ChapterFrontmatter;
  body: string;
  paragraphs: Array<{ path: string; metadata: ParagraphFrontmatter; body: string }>;
};

type ChapterParagraph = ChapterReadResult["paragraphs"][number];

type DialogueCharacterProfile = {
  id: string;
  title: string;
  path: string;
  aliases: string[];
  speakingStyle?: string;
  traits: string[];
  mannerisms: string[];
  desires: string[];
  fears: string[];
  relationships: string[];
  backgroundSummary?: string;
  internalConflict?: string;
  externalConflict?: string;
};

type ParsedDialogueBeat = {
  beatId: string;
  order: number;
  quoteLineIndex: number;
  actionLineIndex: number | null;
  speakerId?: string;
  actedCharacterId?: string;
  quoteText: string;
  actionText?: string;
  startLineIndex: number;
  endLineIndex: number;
  previousExcerpt?: string;
  nextExcerpt?: string;
};

type InternalDialogueActionBeatChoice = DialogueActionBeatReviewChoice & {
  proposedBlock: string;
};

type InternalDialogueActionBeatProposal = Omit<DialogueActionBeatProposal, "choices"> & {
  startLineIndex: number;
  endLineIndex: number;
  choices: InternalDialogueActionBeatChoice[];
};

type QueryCanonLexicon = {
  chapterAliases: string[];
  firstAppearancePhrases: string[];
  secretHolderPhrases: string[];
  relationshipPhrases: string[];
  conditionPhrases: string[];
  openLoopPhrases: string[];
  wherePhrases: string[];
  knowledgePhrases: string[];
  inventoryPhrases: string[];
  betweenWords: string[];
  andWords: string[];
  fromWords: string[];
  toWords: string[];
  stopWords: string[];
};

type TextAnalysis = {
  plainText: string;
  wordCount: number;
  sentenceCount: number;
  paragraphCount: number;
  estimatedReadingMinutes: number;
  avgSentenceWords: number;
  avgParagraphWords: number;
  dialogueRatio: number;
  sensoryCueCount: number;
  tellingCueCount: number;
  lexicalDiversity: number;
  repeatedWordHotspots: string[];
  firstSentence: string;
  lastSentence: string;
};

type ScorecardEntry = {
  label: string;
  score: number;
  strengths: string[];
  concerns: string[];
};

type ParagraphEvaluationInsight = {
  slug: string;
  title: string;
  summary: string;
  summaryPresent: boolean;
  viewpoint: string;
  filePath: string;
  wordCount: number;
  estimatedReadingMinutes: number;
  dialogueRatio: number;
  sensoryCueCount: number;
  tellingCueCount: number;
  repeatedWordHotspots: string[];
  firstSentence: string;
  lastSentence: string;
  scorecard: ScorecardEntry[];
  strengths: string[];
  concerns: string[];
  editorialStrengths: string[];
  editorialConcerns: string[];
  canonStrengths: string[];
  canonConcerns: string[];
  objectiveScore: number;
  editorialScore: number;
  weightedScore: number;
  weightedVerdict: string;
  recommendedFocus: string;
  nextSteps: string[];
};

type ChapterEvaluationDraft = {
  chapterSlug: string;
  chapterData: Awaited<ReturnType<typeof readChapter>>;
  styleContext: EvaluationStyleContext;
  chapterAnalysis: TextAnalysis;
  paragraphInsights: ParagraphEvaluationInsight[];
  scorecard: ScorecardEntry[];
  strengths: string[];
  concerns: string[];
  editorialStrengths: string[];
  editorialConcerns: string[];
  canonStrengths: string[];
  canonConcerns: string[];
  objectiveScore: number;
  editorialScore: number;
  weightedScore: number;
  weightedVerdict: string;
  recommendedFocus: string;
  nextSteps: string[];
  missingParagraphSummaries: number;
  missingParagraphViewpoints: number;
};

type BookEvaluationChapterBreakdown = {
  slug: string;
  title: string;
  number: number;
  sceneCount: number;
  hasSummary: boolean;
  hasPov: boolean;
  tagsCount: number;
  missingParagraphSummaries: number;
  missingParagraphViewpoints: number;
  readabilityScore: number;
  beautyScore: number;
  styleAlignmentScore: number;
  objectiveScore: number;
  editorialScore: number;
  weightedScore: number;
  weightedVerdict: string;
  recommendedFocus: string;
  revisionUrgency: string;
  strengths: string[];
  concerns: string[];
  editorialStrengths: string[];
  editorialConcerns: string[];
  canonStrengths: string[];
  canonConcerns: string[];
  nextSteps: string[];
};

type WeightedVerdictExplanationInput = {
  objectiveScore: number;
  editorialScore: number;
  weightedScore: number;
  weightedVerdict: string;
  recommendedFocus: string;
  objectiveStrengths?: string[];
  objectiveConcerns?: string[];
  editorialStrengths?: string[];
  editorialConcerns?: string[];
  canonStrengths?: string[];
  canonConcerns?: string[];
  extraContextLines?: string[];
};

export type PrepareParagraphEvaluationResult = {
  rootPath: string;
  chapterSlug: string;
  paragraphSlug: string;
  paragraphText: string;
  wordCount: number;
  sentenceCount: number;
  avgSentenceWords: number;
  dialogueRatio: number;
  sensoryCueCount: number;
  tellingCueCount: number;
  lexicalDiversity: number;
  repeatedWordHotspots: string[];
  firstSentence: string;
  lastSentence: string;
  scorecard: Array<{ label: string; score: number; strengths: string[]; concerns: string[] }>;
  objectiveScore: number;
  objectiveStrengths: string[];
  objectiveConcerns: string[];
  styleFlags: {
    showDontTell: boolean;
    prefersShortSentences: boolean;
    prefersLyricalImagery: boolean;
    valuesDialogue: boolean;
    valuesPhysicality: boolean;
    valuesActiveSpace: boolean;
    valuesObjectFunction: boolean;
    valuesSubtext: boolean;
    valuesControlledProse: boolean;
  };
  styleGuidelinesText: string;
  canonMentions: Array<{ id: string; kind: string; title: string; aliases: string[]; coherenceHints: string[] }>;
  contextParagraphs: Array<{ slug: string; title: string; summary: string; viewpoint: string }>;
  instructions: string;
};

export type WriteParagraphEvaluationFromLlmInput = {
  editorialStrengths: string[];
  editorialConcerns: string[];
  canonStrengths: string[];
  canonConcerns: string[];
  nextSteps: string[];
  verdictExplanation: string;
};

type CreateEntityInput = {
  slug?: string;
  body?: string;
  overwrite?: boolean;
  frontmatter?: Record<string, unknown>;
};

type CreateAssetPromptInput = {
  subject: string;
  assetKind?: string;
  extension?: string;
  overwrite?: boolean;
  altText?: string;
  caption?: string;
  promptStyleRef?: string;
  orientation?: AssetFrontmatter["orientation"];
  aspectRatio?: string;
  provider?: string;
  model?: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
};

type RegisterAssetInput = CreateAssetPromptInput & {
  sourceFilePath: string;
};

type HiddenCanonInput = {
  secretRefs?: string[];
  privateNotes?: string;
  revealIn?: string;
  knownFrom?: string;
};

type PronunciationInput = {
  pronunciation?: string;
  spokenName?: string;
  ttsLabel?: string;
};

type CreateCharacterProfileInput = HiddenCanonInput & PronunciationInput & {
  slug?: string;
  overwrite?: boolean;
  name: string;
  aliases?: string[];
  formerNames?: string[];
  currentIdentity?: string;
  identityShifts?: string[];
  identityArc?: string;
  roleTier: CharacterFrontmatter["role_tier"];
  storyRole?: CharacterFrontmatter["story_role"];
  speakingStyle: string;
  backgroundSummary: string;
  functionInBook: string;
  age?: number;
  occupation?: string;
  origin?: string;
  firstImpression?: string;
  arc?: string;
  internalConflict?: string;
  externalConflict?: string;
  traits?: string[];
  mannerisms?: string[];
  desires?: string[];
  fears?: string[];
  relationships?: string[];
  factions?: string[];
  homeLocation?: string;
  introducedIn?: string;
  timelineAges?: Record<string, number>;
  historical?: boolean;
  sources?: string[];
  body?: string;
  frontmatter?: Record<string, unknown>;
};

type CreateItemProfileInput = HiddenCanonInput & PronunciationInput & {
  slug?: string;
  overwrite?: boolean;
  name: string;
  itemKind?: string;
  appearance: string;
  purpose: string;
  functionInBook: string;
  significance?: string;
  originStory?: string;
  powers?: string[];
  limitations?: string[];
  owner?: string;
  introducedIn?: string;
  historical?: boolean;
  sources?: string[];
  body?: string;
  frontmatter?: Record<string, unknown>;
};

type CreateLocationProfileInput = HiddenCanonInput & PronunciationInput & {
  slug?: string;
  overwrite?: boolean;
  name: string;
  locationKind?: string;
  region?: string;
  atmosphere: string;
  functionInBook: string;
  landmarks?: string[];
  risks?: string[];
  factionsPresent?: string[];
  basedOnRealPlace?: boolean;
  timelineRef?: string;
  historical?: boolean;
  sources?: string[];
  body?: string;
  frontmatter?: Record<string, unknown>;
};

type CreateFactionProfileInput = HiddenCanonInput & PronunciationInput & {
  slug?: string;
  overwrite?: boolean;
  name: string;
  factionKind?: string;
  mission: string;
  ideology: string;
  functionInBook: string;
  publicImage?: string;
  hiddenAgenda?: string;
  leaders?: string[];
  allies?: string[];
  enemies?: string[];
  methods?: string[];
  baseLocation?: string;
  historical?: boolean;
  sources?: string[];
  body?: string;
  frontmatter?: Record<string, unknown>;
};

type CreateSecretProfileInput = HiddenCanonInput & PronunciationInput & {
  slug?: string;
  overwrite?: boolean;
  title: string;
  secretKind?: string;
  functionInBook: string;
  stakes: string;
  protectedBy?: string[];
  falseBeliefs?: string[];
  revealStrategy?: string;
  holders?: string[];
  revealIn?: string;
  knownFrom?: string;
  timelineRef?: string;
  historical?: boolean;
  sources?: string[];
  body?: string;
  frontmatter?: Record<string, unknown>;
};

type CreateTimelineEventProfileInput = HiddenCanonInput & PronunciationInput & {
  slug?: string;
  overwrite?: boolean;
  title: string;
  date?: string;
  participants?: string[];
  significance?: string;
  functionInBook?: string;
  consequences?: string[];
  historical?: boolean;
  sources?: string[];
  body?: string;
  frontmatter?: Record<string, unknown>;
};

type CreateChapterDraftInput = {
  number: number;
  title: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
  overwrite?: boolean;
};

type CreateParagraphDraftInput = {
  chapter: string;
  number: number;
  title: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
  overwrite?: boolean;
};

type UpdateBookNoteInput = {
  target?: "notes" | "story-design";
  body?: string;
  appendBody?: string;
  frontmatterPatch?: Record<string, unknown>;
};

type UpdateChapterDraftNoteInput = {
  chapter: string;
  body?: string;
  appendBody?: string;
  frontmatterPatch?: Record<string, unknown>;
};

type WorkItemBucket = "ideas" | "notes" | "promoted";
type WorkItemEditableStatus = Extract<WorkItemEntryFrontmatter["status"], "active" | "review" | "resolved" | "rejected">;

type SaveBookWorkItemInput = {
  bucket: Exclude<WorkItemBucket, "promoted">;
  entryId?: string;
  title: string;
  body: string;
  tags?: string[];
  status?: WorkItemEditableStatus;
};

type SaveChapterDraftWorkItemInput = SaveBookWorkItemInput & {
  chapter: string;
};

type PromoteBookWorkItemInput = {
  source: Exclude<WorkItemBucket, "promoted">;
  entryId: string;
  promotedTo: string;
  target?: "notes" | "story-design";
};

type PromoteChapterDraftWorkItemInput = {
  chapter: string;
  source: Exclude<WorkItemBucket, "promoted">;
  entryId: string;
  promotedTo: string;
  target?: "notes";
};

type RelatedCanonHit = {
  path: string;
  title: string;
  type: string;
  reason: string;
  score: number;
};

export type DoctorIssue = {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
};

type StoryStateStatus = {
  dirty: boolean;
  lastStoryMutationAt?: string;
  lastStoryStateSyncAt?: string;
  changedPaths: string[];
  reason?: string;
};

export type StoryStateChanges = {
  locations?: Record<string, string>;
  knowledge_gain?: Record<string, string[]>;
  knowledge_loss?: Record<string, string[]>;
  inventory_add?: Record<string, string[]>;
  inventory_remove?: Record<string, string[]>;
  relationship_updates?: Record<string, Record<string, string>>;
  conditions?: Record<string, string[]>;
  wounds?: Record<string, string[]>;
  open_loops_add?: string[];
  open_loops_resolved?: string[];
};

type StoryStateSnapshot = {
  locations: Record<string, string>;
  knowledge: Record<string, string[]>;
  inventory: Record<string, string[]>;
  relationships: Record<string, Record<string, string>>;
  conditions: Record<string, string[]>;
  wounds: Record<string, string[]>;
  openLoops: string[];
};

type StoryStateTimelineEntry = {
  chapterSlug: string;
  chapterNumber: number;
  chapterTitle: string;
  resumePath: string;
  chapterPath: string;
  snapshot: StoryStateSnapshot;
  stateChanges?: StoryStateChanges;
};

type QueryCanonTarget = {
  kind: EntityType | "chapter";
  id: string;
  title: string;
  aliases: string[];
  path: string;
  metadata: Record<string, unknown>;
  body: string;
};

type QueryCanonAnswerDraft = {
  answer: string;
  confidence: QueryCanonConfidence;
  intent: QueryCanonIntent;
  sources: QueryCanonSource[];
  notes: string[];
};

type QueryCanonLookup = {
  targetsById: Map<string, QueryCanonTarget>;
  chaptersByRef: Map<string, { slug: string; number: number; title: string }>;
};

type QueryCanonChapterRange = {
  startReference: string;
  endReference: string;
  note?: string;
};

type ParagraphRevisionProposal = {
  body: string;
  notes: string[];
};

type RenameResult = {
  oldPath: string;
  newPath: string;
  updatedReferences: number;
  movedAssetPaths: string[];
};

type ParsedAssetSubject =
  | { type: "book"; subject: "book" }
  | { type: EntityType; subject: string; slug: string }
  | { type: "chapter"; subject: string; chapterSlug: string }
  | { type: "paragraph"; subject: string; chapterSlug: string; paragraphSlug: string };

export async function initializeBookRepo(
  rootPath: string,
  options: {
    title: string;
    author?: string;
    language?: string;
    createSkills?: boolean;
  },
): Promise<{ rootPath: string; created: string[] }> {
  const root = path.resolve(rootPath);
  const created: string[] = [];

  await mkdir(root, { recursive: true });

  for (const directory of BOOK_DIRECTORIES) {
    await mkdir(path.join(root, directory), { recursive: true });
  }

  await ensureFile(
    root,
    BOOK_FILE,
    renderMarkdown(
      bookSchema.parse({
        type: "book",
        id: "book",
        title: options.title,
        author: options.author,
        language: options.language ?? "en",
        canon: DEFAULT_CANON,
      }),
      defaultBodyForType("book"),
    ),
    created,
  );

  await ensureFile(
    root,
    CONTEXT_FILE,
    renderMarkdown(
      {
        type: "context",
        id: "context:book",
        title: "Book Context",
      },
      [
        "# Historical And Temporal Frame",
        "",
        "- Record the time period, historical pressures, and what people in this world can plausibly know or do.",
        "",
        "# Geographic Frame",
        "",
        "- Describe the core places, distances, climate, routes, and spatial constraints that should stay stable across the book.",
        "",
        "# Social And Political Frame",
        "",
        "- Note class pressure, institutions, factions, religion, law, trade, or any background power that shapes scenes before plot-specific events do.",
        "",
        "# Cultural Frame",
        "",
        "- Capture speech norms, etiquette, shame or honor systems, taboos, rituals, and values that affect behavior in-scene.",
        "",
        "# World Rules And Constraints",
        "",
        "- Write the non-negotiable facts of the setting here.",
        "- Keep stable background rules here, not scene-by-scene plot progression.",
        "",
        "# Recurring Background Pressures",
        "",
        "- List the invisible forces that should keep shaping scenes: surveillance, debt, weather, war pressure, scarcity, rumor, family duty, and so on.",
        "",
        "# Writing Implications",
        "",
        "- Translate the context above into concrete prose reminders for chapter and paragraph writing.",
        "- Example: travel is slow, information is delayed, public actions have social afterlife, violence has factional consequences.",
      ].join("\n"),
    ),
    created,
  );

  await ensureFile(
    root,
    IDEAS_FILE,
    renderMarkdown(
      noteSchema.parse({
        type: "note",
        id: "note:ideas",
        title: "Book Ideas",
        scope: "book",
        bucket: "ideas",
      }),
      defaultIdeasBody(),
    ),
    created,
  );

  await ensureFile(
    root,
    NOTES_FILE,
    renderMarkdown(
      noteSchema.parse({
        type: "note",
        id: "note:book",
        title: "Book Notes",
        scope: "book",
        bucket: "notes",
      }),
      defaultBookNotesBody(),
    ),
    created,
  );

  await ensureFile(
    root,
    PROMOTED_FILE,
    renderMarkdown(
      noteSchema.parse({
        type: "note",
        id: "note:promoted",
        title: "Promoted Items",
        scope: "book",
        bucket: "promoted",
      }),
      defaultPromotedBody(),
    ),
    created,
  );

  await ensureFile(
    root,
    STORY_DESIGN_FILE,
    renderMarkdown(
      noteSchema.parse({
        type: "note",
        id: "note:story-design",
        title: "Story Design",
        scope: "story-design",
        bucket: "story-design",
      }),
      defaultStoryDesignBody(),
    ),
    created,
  );

  await ensureFile(
    root,
    GUIDELINE_FILES.writingStyle,
    renderMarkdown(
      guidelineSchema.parse({
        type: "guideline",
        id: "guideline:writing-style",
        title: "Writing Style",
        scope: "writing-style",
      }),
      defaultWritingStyleBody(),
    ),
    created,
  );

  await ensureFile(
    root,
    GUIDELINE_FILES.images,
    renderMarkdown(
      guidelineSchema.parse({
        type: "guideline",
        id: "guideline:images",
        title: "Image Style",
        scope: "visuals",
      }),
      [
        "# Visual Direction",
        "",
        "- Default orientation: portrait",
        "- Default aspect ratio: 2:3",
        "- Keep recurring characters visually consistent across assets.",
        "- Use this file as the global visual style reference for all generated or imported images.",
        "",
        "# Style Anchors",
        "",
        "- Medium: define illustration, painting, photography, collage, or mixed-media expectations.",
        "- Palette: define dominant colors, forbidden colors, and saturation limits.",
        "- Light: define the usual lighting language and contrast level.",
        "- Camera: describe framing, lens feel, distance, and how portrait compositions should behave.",
        "- Continuity: define how recurring faces, clothing, symbols, and locations stay stable across images.",
        "",
        "# Recommended Prompts",
        "",
        "## Book Cover",
        "",
        "Template:",
        "<title or series name>, cover illustration, <main subject>, <setting>, <mood>, portrait orientation, 2:3 ratio, leave clean space for title typography, consistent with this book's visual language.",
        "",
        "## Character Portrait",
        "",
        "Template:",
        "Portrait of <character name>, <age or visual age>, <expression>, <distinctive features>, <clothing>, <lighting>, <background mood>, portrait orientation, 2:3 ratio, consistent face design for recurring canon art.",
        "",
        "## Chapter Illustration",
        "",
        "Template:",
        "Chapter-opening illustration for <chapter id or title>, showing <core dramatic image>, <location>, <time of day>, <mood>, portrait orientation, 2:3 ratio, cinematic composition, visually aligned with the rest of the book.",
        "",
        "## Scene Illustration",
        "",
        "Template:",
        "Scene illustration for <paragraph id or title>, <characters present>, <action>, <location>, <emotional beat>, portrait orientation, 2:3 ratio, preserve continuity with existing character and location assets.",
        "",
        "# Notes",
        "",
        "Document palette, medium, lighting, costume rules, and camera language here.",
      ].join("\n"),
    ),
    created,
  );

  await ensureFile(
    root,
    TIMELINE_MAIN_FILE,
    renderMarkdown(
      {
        type: "timeline",
        id: "timeline:main",
        title: "Main Timeline",
        canon: DEFAULT_CANON,
      },
      "# Timeline\n\nList major chronological anchors here.\n",
    ),
    created,
  );

  await ensureFile(
    root,
    PLOT_FILE,
    renderMarkdown(
      plotSchema.parse({
        type: "plot",
        id: "plot:main",
        title: "Story Plot",
      }),
      [
        "# Plot Overview",
        "",
        "No chapters yet. Keep this file in sync as the book grows.",
        "",
        "# Chapter Map",
        "",
        "Add chapters, then refresh this file so it tracks the book's progression, reveals, and timeline anchors.",
      ].join("\n"),
    ),
    created,
  );

  await ensureFile(
    root,
    TOTAL_RESUME_FILE,
    renderMarkdown(
      {
        type: "resume",
        id: "resume:total",
        title: "Total Resume",
      },
      "# Book So Far\n\nKeep an up-to-date summary of the entire book here.\n",
    ),
    created,
  );

  await ensureFile(
    root,
    STORY_STATE_STATUS_FILE,
    buildStoryStateStatusMarkdown(defaultStoryStateStatus()),
    created,
  );

  await ensureFile(
    root,
    STORY_STATE_CURRENT_FILE,
    buildCurrentStoryStateMarkdown(createEmptyStoryStateSnapshot(), {
      chapterCount: 0,
    }),
    created,
  );

  await ensureFile(
    root,
    TOTAL_EVALUATION_FILE,
    renderMarkdown(
      {
        type: "evaluation",
        id: "evaluation:total",
        title: "Total Evaluation",
      },
      "# Global Evaluation\n\nTrack continuity, pacing, style, and unresolved issues here.\n",
    ),
    created,
  );

  await ensureFile(
    root,
    "conversations/README.md",
    buildConversationsReadme(),
    created,
  );

  await ensureFile(
    root,
    "conversations/config.json",
    JSON.stringify({ saveSessionFiles: true }, null, 2) + "\n",
    created,
  );

  for (const file of getManagedBookScaffoldFiles(options.createSkills ?? true)) {
    await ensureFile(root, file.relativePath, file.content, created);
  }

  for (const file of getInitOnlyBookScaffoldFiles()) {
    await ensureFile(root, file.relativePath, file.content, created);
  }

  return { rootPath: root, created };
}

export async function upgradeBookRepo(
  rootPath: string,
  options?: { createSkills?: boolean },
): Promise<{
  rootPath: string;
  created: string[];
  updated: string[];
  migrated: string[];
}> {
  const root = path.resolve(rootPath);
  const book = await readBook(root);

  if (!book) {
    throw new Error(`Missing ${BOOK_FILE} in ${root}. Use create-narrarium-book for a new repo, or run the upgrade inside an existing Narrarium book.`);
  }

  const created = (await initializeBookRepo(root, {
    title: book.frontmatter.title,
    author: book.frontmatter.author,
    language: book.frontmatter.language,
    createSkills: options?.createSkills ?? true,
  })).created;

  const updated: string[] = [];

  for (const file of getManagedBookScaffoldFiles(options?.createSkills ?? true)) {
    const filePath = path.join(root, file.relativePath);
    const existingContent = await readFile(filePath, "utf8").catch(() => null);

    if (existingContent === file.content) {
      continue;
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, "utf8");
    updated.push(toPosixPath(file.relativePath));
  }

  const opencodeConfigPath = path.join(root, "opencode.jsonc");
  const existingOpencodeConfig = await readFile(opencodeConfigPath, "utf8").catch(() => null);
  if (existingOpencodeConfig) {
    const patched = ensureOpencodeInstructionEntry(existingOpencodeConfig);
    if (patched.updated) {
      await writeFile(opencodeConfigPath, patched.content, "utf8");
      updated.push("opencode.jsonc");
    }
  }

  for (const relativePath of LEGACY_WRITING_GUIDELINE_FILES) {
    const filePath = path.join(root, relativePath);
    if (await pathExists(filePath)) {
      await rm(filePath, { force: true });
      updated.push(toPosixPath(relativePath));
    }
  }

  for (const relativePath of LEGACY_WRITING_GUIDELINE_DIRECTORIES) {
    const directoryPath = path.join(root, relativePath);
    if (await pathExists(directoryPath)) {
      await rm(directoryPath, { recursive: true, force: true });
      updated.push(toPosixPath(relativePath));
    }
  }

  const migrated = await migrateLegacyStoryMarkdownLinks(root);

  const seededPersonas = await seedDefaultPersonas(root);
  for (const p of seededPersonas) {
    created.push(p);
  }

  return {
    rootPath: root,
    created,
    updated,
    migrated,
  };
}

async function migrateLegacyStoryMarkdownLinks(rootPath: string): Promise<string[]> {
  const root = path.resolve(rootPath);
  const files = await fg(["chapters/**/*.md", "drafts/**/*.md"], {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
  });
  const migrated: string[] = [];

  for (const filePath of files) {
    const raw = await readFile(filePath, "utf8");
    const parsed = matter(raw);
    const normalizedBody = normalizeStoryMarkdownBody(String(parsed.content ?? ""));
    if (normalizedBody === String(parsed.content ?? "")) {
      continue;
    }

    await writeFile(filePath, matter.stringify(normalizedBody, parsed.data), "utf8");
    migrated.push(toPosixPath(path.relative(root, filePath)));
  }

  return migrated.sort();
}

export async function createEntity(
  rootPath: string,
  kind: EntityType,
  input: CreateEntityInput,
): Promise<{ filePath: string; frontmatter: Record<string, unknown> }> {
  const root = path.resolve(rootPath);
  const schema = entitySchemaMap[kind];
  const providedFrontmatter = input.frontmatter ?? {};
  const label =
    typeof providedFrontmatter.name === "string"
      ? providedFrontmatter.name
      : typeof providedFrontmatter.title === "string"
        ? providedFrontmatter.title
        : undefined;

  if (!label && !input.slug) {
    throw new Error(`A name or title is required for ${kind}.`);
  }

  const slug = input.slug ?? slugify(label ?? "entry");
  const directory = ENTITY_TYPE_TO_DIRECTORY[kind];
  const filePath = path.join(root, directory, `${slug}.md`);

  if (!input.overwrite && (await pathExists(filePath))) {
    throw new Error(`File already exists: ${filePath}`);
  }

  const rawFrontmatter = {
    type: kind,
    id: `${kind}:${slug}`,
    canon: DEFAULT_CANON,
    ...providedFrontmatter,
  };

  const frontmatter = schema.parse(rawFrontmatter);
  const body = input.body ?? defaultBodyForType(kind);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, renderMarkdown(frontmatter, body), "utf8");

  return { filePath, frontmatter };
}

export async function createCharacterProfile(
  rootPath: string,
  input: CreateCharacterProfileInput,
): Promise<{ filePath: string; frontmatter: CharacterFrontmatter }> {
  const sources = uniqueValues(input.sources ?? []);
  const result = await createEntity(rootPath, "character", {
    slug: input.slug,
    overwrite: input.overwrite,
    body: input.body ?? buildCharacterBody(input),
    frontmatter: {
      name: input.name,
      ...buildHiddenCanonFrontmatter(input),
      ...buildPronunciationFrontmatter(input),
      aliases: input.aliases ?? [],
      former_names: input.formerNames ?? [],
      current_identity: input.currentIdentity,
      identity_shifts: input.identityShifts ?? [],
      identity_arc: input.identityArc,
      role_tier: input.roleTier,
      story_role: input.storyRole ?? "other",
      speaking_style: input.speakingStyle,
      background_summary: input.backgroundSummary,
      function_in_book: input.functionInBook,
      age: input.age,
      occupation: input.occupation,
      origin: input.origin,
      first_impression: input.firstImpression,
      arc: input.arc,
      internal_conflict: input.internalConflict,
      external_conflict: input.externalConflict,
      traits: input.traits ?? [],
      mannerisms: input.mannerisms ?? [],
      desires: input.desires ?? [],
      fears: input.fears ?? [],
      relationships: input.relationships ?? [],
      factions: input.factions ?? [],
      home_location: input.homeLocation,
      introduced_in: input.introducedIn,
      timeline_ages: input.timelineAges ?? {},
      historical: input.historical ?? false,
      sources,
      ...input.frontmatter,
    },
  });

  return {
    filePath: result.filePath,
    frontmatter: characterSchema.parse(result.frontmatter),
  };
}

export async function createItemProfile(
  rootPath: string,
  input: CreateItemProfileInput,
): Promise<{ filePath: string; frontmatter: ItemFrontmatter }> {
  const sources = uniqueValues(input.sources ?? []);
  const result = await createEntity(rootPath, "item", {
    slug: input.slug,
    overwrite: input.overwrite,
    body: input.body ?? buildItemBody(input),
    frontmatter: {
      name: input.name,
      ...buildHiddenCanonFrontmatter(input),
      ...buildPronunciationFrontmatter(input),
      item_kind: input.itemKind,
      appearance: input.appearance,
      purpose: input.purpose,
      function_in_book: input.functionInBook,
      significance: input.significance,
      origin_story: input.originStory,
      powers: input.powers ?? [],
      limitations: input.limitations ?? [],
      owner: input.owner,
      introduced_in: input.introducedIn,
      historical: input.historical ?? false,
      sources,
      ...input.frontmatter,
    },
  });

  return {
    filePath: result.filePath,
    frontmatter: itemSchema.parse(result.frontmatter),
  };
}

export async function createLocationProfile(
  rootPath: string,
  input: CreateLocationProfileInput,
): Promise<{ filePath: string; frontmatter: LocationFrontmatter }> {
  const sources = uniqueValues(input.sources ?? []);
  const result = await createEntity(rootPath, "location", {
    slug: input.slug,
    overwrite: input.overwrite,
    body: input.body ?? buildLocationBody(input),
    frontmatter: {
      name: input.name,
      ...buildHiddenCanonFrontmatter(input),
      ...buildPronunciationFrontmatter(input),
      location_kind: input.locationKind,
      region: input.region,
      atmosphere: input.atmosphere,
      function_in_book: input.functionInBook,
      landmarks: input.landmarks ?? [],
      risks: input.risks ?? [],
      factions_present: input.factionsPresent ?? [],
      based_on_real_place: input.basedOnRealPlace ?? false,
      timeline_ref: input.timelineRef,
      historical: input.historical ?? false,
      sources,
      ...input.frontmatter,
    },
  });

  return {
    filePath: result.filePath,
    frontmatter: locationSchema.parse(result.frontmatter),
  };
}

export async function createFactionProfile(
  rootPath: string,
  input: CreateFactionProfileInput,
): Promise<{ filePath: string; frontmatter: FactionFrontmatter }> {
  const sources = uniqueValues(input.sources ?? []);
  const result = await createEntity(rootPath, "faction", {
    slug: input.slug,
    overwrite: input.overwrite,
    body: input.body ?? buildFactionBody(input),
    frontmatter: {
      name: input.name,
      ...buildHiddenCanonFrontmatter(input),
      ...buildPronunciationFrontmatter(input),
      faction_kind: input.factionKind,
      mission: input.mission,
      ideology: input.ideology,
      function_in_book: input.functionInBook,
      public_image: input.publicImage,
      hidden_agenda: input.hiddenAgenda,
      leaders: input.leaders ?? [],
      allies: input.allies ?? [],
      enemies: input.enemies ?? [],
      methods: input.methods ?? [],
      base_location: input.baseLocation,
      historical: input.historical ?? false,
      sources,
      ...input.frontmatter,
    },
  });

  return {
    filePath: result.filePath,
    frontmatter: factionSchema.parse(result.frontmatter),
  };
}

export async function createSecretProfile(
  rootPath: string,
  input: CreateSecretProfileInput,
): Promise<{ filePath: string; frontmatter: SecretFrontmatter }> {
  const sources = uniqueValues(input.sources ?? []);
  const result = await createEntity(rootPath, "secret", {
    slug: input.slug,
    overwrite: input.overwrite,
    body: input.body ?? buildSecretBody(input),
    frontmatter: {
      title: input.title,
      ...buildHiddenCanonFrontmatter(input),
      ...buildPronunciationFrontmatter(input),
      secret_kind: input.secretKind,
      function_in_book: input.functionInBook,
      stakes: input.stakes,
      protected_by: input.protectedBy ?? [],
      false_beliefs: input.falseBeliefs ?? [],
      reveal_strategy: input.revealStrategy,
      holders: input.holders ?? [],
      timeline_ref: input.timelineRef,
      historical: input.historical ?? false,
      sources,
      ...input.frontmatter,
    },
  });

  return {
    filePath: result.filePath,
    frontmatter: secretSchema.parse(result.frontmatter),
  };
}

export async function createTimelineEventProfile(
  rootPath: string,
  input: CreateTimelineEventProfileInput,
): Promise<{ filePath: string; frontmatter: TimelineEventFrontmatter }> {
  const sources = uniqueValues(input.sources ?? []);
  const result = await createEntity(rootPath, "timeline-event", {
    slug: input.slug,
    overwrite: input.overwrite,
    body: input.body ?? buildTimelineEventBody(input),
    frontmatter: {
      title: input.title,
      ...buildHiddenCanonFrontmatter(input),
      ...buildPronunciationFrontmatter(input),
      date: input.date,
      participants: input.participants ?? [],
      significance: input.significance,
      function_in_book: input.functionInBook,
      consequences: input.consequences ?? [],
      historical: input.historical ?? false,
      sources,
      ...input.frontmatter,
    },
  });

  return {
    filePath: result.filePath,
    frontmatter: entitySchemaMap["timeline-event"].parse(result.frontmatter),
  };
}

export async function createChapter(
  rootPath: string,
  options: {
    number: number;
    title: string;
    body?: string;
    frontmatter?: Record<string, unknown>;
    overwrite?: boolean;
  },
): Promise<{ folderPath: string; chapterFilePath: string; chapterId: string }> {
  const root = path.resolve(rootPath);
  const slug = chapterSlug(options.number, options.title);
  const folderPath = path.join(root, "chapters", slug);
  const chapterFilePath = path.join(folderPath, "chapter.md");
  const resumeFilePath = path.join(root, "resumes/chapters", `${slug}.md`);
  const evaluationFilePath = path.join(root, "evaluations/chapters", `${slug}.md`);

  if (!options.overwrite && (await pathExists(chapterFilePath))) {
    throw new Error(`Chapter already exists: ${chapterFilePath}`);
  }

  await mkdir(folderPath, { recursive: true });

  const frontmatter = chapterSchema.parse({
    type: "chapter",
    id: `chapter:${slug}`,
    number: options.number,
    title: options.title,
    canon: DEFAULT_CANON,
    ...options.frontmatter,
  });

  await writeFile(
    chapterFilePath,
    renderMarkdown(frontmatter, normalizeStoryMarkdownBody(options.body ?? defaultBodyForType("chapter"))),
    "utf8",
  );

  await ensureFile(
    root,
    toPosixPath(path.relative(root, resumeFilePath)),
    renderMarkdown(
      {
        type: "resume",
        id: `resume:chapter:${slug}`,
        title: `Resume ${slug}`,
      },
      "# Summary\n\nSummarize the chapter here.\n",
    ),
    [],
  );

  await ensureFile(
    root,
    toPosixPath(path.relative(root, evaluationFilePath)),
    renderMarkdown(
      {
        type: "evaluation",
        id: `evaluation:chapter:${slug}`,
        title: `Evaluation ${slug}`,
      },
      "# Evaluation\n\nTrack chapter quality, continuity, and revision notes here.\n",
    ),
    [],
  );

  await markStoryStateDirty(root, {
    changedPaths: [toPosixPath(path.relative(root, chapterFilePath))],
    reason: "chapter-created",
  });

  return {
    folderPath,
    chapterFilePath,
    chapterId: `chapter:${slug}`,
  };
}

export async function createChapterDraft(
  rootPath: string,
  options: CreateChapterDraftInput,
): Promise<{ folderPath: string; draftFilePath: string; draftId: string; chapterId: string; notesFilePath: string; ideasFilePath: string; promotedFilePath: string }> {
  const root = path.resolve(rootPath);
  const slug = chapterSlug(options.number, options.title);
  const folderPath = path.join(root, "drafts", slug);
  const draftFilePath = path.join(folderPath, "chapter.md");

  if (!options.overwrite && (await pathExists(draftFilePath))) {
    throw new Error(`Chapter draft already exists: ${draftFilePath}`);
  }

  await mkdir(folderPath, { recursive: true });

  const frontmatter = chapterDraftSchema.parse({
    type: "chapter-draft",
    id: `draft:chapter:${slug}`,
    chapter: `chapter:${slug}`,
    number: options.number,
    title: options.title,
    canon: DEFAULT_CANON,
    ...options.frontmatter,
  });

  await writeFile(
    draftFilePath,
    renderMarkdown(frontmatter, normalizeStoryMarkdownBody(options.body ?? defaultBodyForType("chapter-draft"))),
    "utf8",
  );

  const workspaceFiles = await ensureChapterDraftWorkspaceFiles(root, slug);

  return {
    folderPath,
    draftFilePath,
    draftId: `draft:chapter:${slug}`,
    chapterId: `chapter:${slug}`,
    ...workspaceFiles,
  };
}

export async function createParagraph(
  rootPath: string,
  options: {
    chapter: string;
    number: number;
    title: string;
    body?: string;
    frontmatter?: Record<string, unknown>;
    overwrite?: boolean;
  },
): Promise<{ filePath: string; paragraphId: string }> {
  const root = path.resolve(rootPath);
  const chapter = normalizeChapterReference(options.chapter);
  const folderPath = path.join(root, "chapters", chapter);

  if (!(await pathExists(folderPath))) {
    throw new Error(`Chapter folder does not exist: ${folderPath}`);
  }

  const fileName = paragraphFilename(options.number, options.title);
  const filePath = path.join(folderPath, fileName);

  if (!options.overwrite && (await pathExists(filePath))) {
    throw new Error(`Paragraph already exists: ${filePath}`);
  }

  const slug = fileName.replace(/\.md$/i, "");
  const frontmatter = paragraphSchema.parse({
    type: "paragraph",
    id: `paragraph:${chapter}:${slug}`,
    chapter: `chapter:${chapter}`,
    number: options.number,
    title: options.title,
    canon: DEFAULT_CANON,
    ...options.frontmatter,
  });

  await writeFile(
    filePath,
    renderMarkdown(frontmatter, normalizeStoryMarkdownBody(options.body ?? defaultBodyForType("paragraph"))),
    "utf8",
  );

  await markStoryStateDirty(root, {
    changedPaths: [toPosixPath(path.relative(root, filePath))],
    reason: "paragraph-created",
  });

  return { filePath, paragraphId: `paragraph:${chapter}:${slug}` };
}

export async function createParagraphDraft(
  rootPath: string,
  options: CreateParagraphDraftInput,
): Promise<{ filePath: string; draftId: string; paragraphId: string; notesFilePath: string; ideasFilePath: string; promotedFilePath: string }> {
  const root = path.resolve(rootPath);
  const chapter = normalizeChapterReference(options.chapter);
  const folderPath = path.join(root, "drafts", chapter);

  await mkdir(folderPath, { recursive: true });

  const fileName = paragraphFilename(options.number, options.title);
  const filePath = path.join(folderPath, fileName);

  if (!options.overwrite && (await pathExists(filePath))) {
    throw new Error(`Paragraph draft already exists: ${filePath}`);
  }

  const slug = fileName.replace(/\.md$/i, "");
  const frontmatter = paragraphDraftSchema.parse({
    type: "paragraph-draft",
    id: `draft:paragraph:${chapter}:${slug}`,
    paragraph: `paragraph:${chapter}:${slug}`,
    chapter: `chapter:${chapter}`,
    number: options.number,
    title: options.title,
    canon: DEFAULT_CANON,
    ...options.frontmatter,
  });

  await writeFile(
    filePath,
    renderMarkdown(frontmatter, normalizeStoryMarkdownBody(options.body ?? defaultBodyForType("paragraph-draft"))),
    "utf8",
  );

  const workspaceFiles = await ensureChapterDraftWorkspaceFiles(root, chapter);

  return {
    filePath,
    draftId: `draft:paragraph:${chapter}:${slug}`,
    paragraphId: `paragraph:${chapter}:${slug}`,
    ...workspaceFiles,
  };
}

export async function updateBookNotes(
  rootPath: string,
  options: UpdateBookNoteInput = {},
): Promise<{ filePath: string; frontmatter: NoteFrontmatter }> {
  const root = path.resolve(rootPath);
  const target = options.target ?? "notes";

  if (target === "story-design") {
    return updateNoteDocument(root, {
      relativePath: STORY_DESIGN_FILE,
      baseFrontmatter: {
        type: "note",
        id: "note:story-design",
        title: "Story Design",
        scope: "story-design",
        bucket: "story-design",
      },
      defaultBody: defaultStoryDesignBody(),
      body: options.body,
      appendBody: options.appendBody,
      frontmatterPatch: options.frontmatterPatch,
    });
  }

  return updateNoteDocument(root, {
    relativePath: NOTES_FILE,
    baseFrontmatter: {
      type: "note",
      id: "note:book",
      title: "Book Notes",
      scope: "book",
      bucket: "notes",
    },
    defaultBody: defaultBookNotesBody(),
    body: options.body,
    appendBody: options.appendBody,
    frontmatterPatch: options.frontmatterPatch,
  });
}

export async function updateChapterDraftNotes(
  rootPath: string,
  options: UpdateChapterDraftNoteInput,
): Promise<{ filePath: string; frontmatter: NoteFrontmatter }> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(options.chapter);
  await ensureChapterDraftWorkspaceFile(root, chapterSlugValue, "notes");
  return updateNoteDocument(root, {
    relativePath: chapterDraftNotesRelativePath(chapterSlugValue),
    baseFrontmatter: {
      type: "note",
      id: `note:chapter-draft:notes:${chapterSlugValue}`,
      title: `Chapter Draft Notes ${chapterSlugValue}`,
      scope: "chapter-draft",
      bucket: "notes",
      chapter: `chapter:${chapterSlugValue}`,
    },
    defaultBody: defaultChapterDraftNotesBody(),
    body: options.body,
    appendBody: options.appendBody,
    frontmatterPatch: options.frontmatterPatch,
  });
}

export async function saveBookWorkItem(
  rootPath: string,
  options: SaveBookWorkItemInput,
): Promise<{ filePath: string; frontmatter: NoteFrontmatter; entry: WorkItemEntryFrontmatter }> {
  const root = path.resolve(rootPath);
  const relativePath = options.bucket === "ideas" ? IDEAS_FILE : NOTES_FILE;
  const baseFrontmatter =
    options.bucket === "ideas"
      ? {
          type: "note",
          id: "note:ideas",
          title: "Book Ideas",
          scope: "book",
          bucket: "ideas",
        }
      : {
          type: "note",
          id: "note:book",
          title: "Book Notes",
          scope: "book",
          bucket: "notes",
        };
  return upsertWorkItemInNoteDocument(root, {
    relativePath,
    baseFrontmatter,
    defaultBody: options.bucket === "ideas" ? defaultIdeasBody() : defaultBookNotesBody(),
    entryId: options.entryId,
    title: options.title,
    body: options.body,
    tags: options.tags,
    status: options.status,
  });
}

export async function saveChapterDraftWorkItem(
  rootPath: string,
  options: SaveChapterDraftWorkItemInput,
): Promise<{ filePath: string; frontmatter: NoteFrontmatter; entry: WorkItemEntryFrontmatter }> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(options.chapter);
  const bucket = options.bucket;
  await ensureChapterDraftWorkspaceFile(root, chapterSlugValue, bucket);
  return upsertWorkItemInNoteDocument(root, {
    relativePath: chapterDraftWorkspaceRelativePath(chapterSlugValue, bucket),
    baseFrontmatter: {
      type: "note",
      id: `note:chapter-draft:${bucket}:${chapterSlugValue}`,
      title: bucket === "ideas" ? `Chapter Draft Ideas ${chapterSlugValue}` : `Chapter Draft Notes ${chapterSlugValue}`,
      scope: "chapter-draft",
      bucket,
      chapter: `chapter:${chapterSlugValue}`,
    },
    defaultBody: bucket === "ideas" ? defaultChapterDraftIdeasBody() : defaultChapterDraftNotesBody(),
    entryId: options.entryId,
    title: options.title,
    body: options.body,
    tags: options.tags,
    status: options.status,
  });
}

export async function promoteBookWorkItem(
  rootPath: string,
  options: PromoteBookWorkItemInput,
): Promise<{ sourceFilePath: string; promotedFilePath: string; promotedEntry: WorkItemEntryFrontmatter; targetFilePath?: string }> {
  const root = path.resolve(rootPath);
  return promoteWorkItem(root, {
    sourceRelativePath: options.source === "ideas" ? IDEAS_FILE : NOTES_FILE,
    sourceBaseFrontmatter:
      options.source === "ideas"
        ? { type: "note", id: "note:ideas", title: "Book Ideas", scope: "book", bucket: "ideas" }
        : { type: "note", id: "note:book", title: "Book Notes", scope: "book", bucket: "notes" },
    sourceDefaultBody: options.source === "ideas" ? defaultIdeasBody() : defaultBookNotesBody(),
    promotedRelativePath: PROMOTED_FILE,
    promotedBaseFrontmatter: {
      type: "note",
      id: "note:promoted",
      title: "Promoted Items",
      scope: "book",
      bucket: "promoted",
    },
    promotedDefaultBody: defaultPromotedBody(),
    entryId: options.entryId,
    promotedTo: options.promotedTo,
    target: options.target,
  });
}

export async function promoteChapterDraftWorkItem(
  rootPath: string,
  options: PromoteChapterDraftWorkItemInput,
): Promise<{ sourceFilePath: string; promotedFilePath: string; promotedEntry: WorkItemEntryFrontmatter; targetFilePath?: string }> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(options.chapter);
  await ensureChapterDraftWorkspaceFile(root, chapterSlugValue, options.source);
  await ensureChapterDraftWorkspaceFile(root, chapterSlugValue, "promoted");
  return promoteWorkItem(root, {
    sourceRelativePath: chapterDraftWorkspaceRelativePath(chapterSlugValue, options.source),
    sourceBaseFrontmatter: {
      type: "note",
      id: `note:chapter-draft:${options.source}:${chapterSlugValue}`,
      title: options.source === "ideas" ? `Chapter Draft Ideas ${chapterSlugValue}` : `Chapter Draft Notes ${chapterSlugValue}`,
      scope: "chapter-draft",
      bucket: options.source,
      chapter: `chapter:${chapterSlugValue}`,
    },
    sourceDefaultBody: options.source === "ideas" ? defaultChapterDraftIdeasBody() : defaultChapterDraftNotesBody(),
    promotedRelativePath: chapterDraftPromotedRelativePath(chapterSlugValue),
    promotedBaseFrontmatter: {
      type: "note",
      id: `note:chapter-draft:promoted:${chapterSlugValue}`,
      title: `Chapter Draft Promoted ${chapterSlugValue}`,
      scope: "chapter-draft",
      bucket: "promoted",
      chapter: `chapter:${chapterSlugValue}`,
    },
    promotedDefaultBody: defaultChapterDraftPromotedBody(),
    entryId: options.entryId,
    promotedTo: options.promotedTo,
    target: options.target,
    chapterSlugValue,
  });
}

export async function createAssetPrompt(
  rootPath: string,
  options: CreateAssetPromptInput,
): Promise<{ filePath: string; imagePath: string; assetId: string }> {
  const root = path.resolve(rootPath);
  const prepared = prepareAssetTarget(root, options.subject, options.assetKind, options.extension);

  if (!options.overwrite && (await pathExists(prepared.markdownFilePath))) {
    throw new Error(`Asset prompt already exists: ${prepared.markdownFilePath}`);
  }

  await mkdir(path.dirname(prepared.markdownFilePath), { recursive: true });

  const frontmatter = assetSchema.parse({
    type: "asset",
    id: prepared.assetId,
    subject: prepared.parsedSubject.subject,
    asset_kind: prepared.assetKind,
    path: prepared.imageRelativePath,
    alt_text: options.altText,
    caption: options.caption,
    prompt_style_ref: options.promptStyleRef ?? "guideline:images",
    orientation: options.orientation ?? "portrait",
    aspect_ratio: options.aspectRatio ?? "2:3",
    provider: options.provider,
    model: options.model,
    canon: DEFAULT_CANON,
    ...options.frontmatter,
  });

  await writeFile(
    prepared.markdownFilePath,
    renderMarkdown(frontmatter, options.body ?? defaultBodyForType("asset")),
    "utf8",
  );

  return {
    filePath: prepared.markdownFilePath,
    imagePath: prepared.imageFilePath,
    assetId: prepared.assetId,
  };
}

export async function readAsset(
  rootPath: string,
  subject: string,
  assetKind?: string,
): Promise<{
  path: string;
  metadata: AssetFrontmatter;
  body: string;
  imagePath: string;
  imageExists: boolean;
} | null> {
  const root = path.resolve(rootPath);
  const prepared = prepareAssetTarget(root, subject, assetKind);

  if (!(await pathExists(prepared.markdownFilePath))) {
    return null;
  }

  const document = await readMarkdownFile(prepared.markdownFilePath, assetSchema);
  const imagePath = path.join(root, document.frontmatter.path);
  return {
    path: prepared.markdownFilePath,
    metadata: document.frontmatter,
    body: document.body,
    imagePath,
    imageExists: await pathExists(imagePath),
  };
}

export async function registerAsset(
  rootPath: string,
  options: RegisterAssetInput,
): Promise<{ filePath: string; imagePath: string; assetId: string }> {
  const root = path.resolve(rootPath);
  const sourceFilePath = path.resolve(options.sourceFilePath);

  if (!(await pathExists(sourceFilePath))) {
    throw new Error(`Asset source file does not exist: ${sourceFilePath}`);
  }

  const prepared = prepareAssetTarget(root, options.subject, options.assetKind, options.extension ?? path.extname(sourceFilePath));

  if (!options.overwrite && ((await pathExists(prepared.markdownFilePath)) || (await pathExists(prepared.imageFilePath)))) {
    throw new Error(`Asset already exists at ${prepared.imageFilePath}`);
  }

  await mkdir(path.dirname(prepared.imageFilePath), { recursive: true });
  await copyFile(sourceFilePath, prepared.imageFilePath);

  const frontmatter = assetSchema.parse({
    type: "asset",
    id: prepared.assetId,
    subject: prepared.parsedSubject.subject,
    asset_kind: prepared.assetKind,
    path: prepared.imageRelativePath,
    alt_text: options.altText,
    caption: options.caption,
    prompt_style_ref: options.promptStyleRef ?? "guideline:images",
    orientation: options.orientation ?? "portrait",
    aspect_ratio: options.aspectRatio ?? "2:3",
    provider: options.provider,
    model: options.model,
    canon: DEFAULT_CANON,
    ...options.frontmatter,
  });

  await writeFile(
    prepared.markdownFilePath,
    renderMarkdown(frontmatter, options.body ?? defaultBodyForType("asset")),
    "utf8",
  );

  return {
    filePath: prepared.markdownFilePath,
    imagePath: prepared.imageFilePath,
    assetId: prepared.assetId,
  };
}

export async function renameEntity(
  rootPath: string,
  options: {
    kind: EntityType;
    slugOrId: string;
    newNameOrTitle: string;
    newSlug?: string;
  },
): Promise<RenameResult> {
  const root = path.resolve(rootPath);
  const oldFilePath = resolveEntityFilePath(root, options.kind, options.slugOrId);

  if (!(await pathExists(oldFilePath))) {
    throw new Error(`Entity does not exist: ${oldFilePath}`);
  }

  const raw = await readFile(oldFilePath, "utf8");
  const parsed = matter(raw);
  const oldSlug = path.basename(oldFilePath, ".md");
  const nextSlug = normalizeRenameSlug(options.newSlug ?? options.newNameOrTitle);
  const newFilePath = path.join(root, ENTITY_TYPE_TO_DIRECTORY[options.kind], `${nextSlug}.md`);
  const labelKey = getEntityLabelKey(options.kind);
  const oldId = `${options.kind}:${oldSlug}`;
  const newId = `${options.kind}:${nextSlug}`;
  const currentData = parsed.data as Record<string, unknown>;
  const oldLabel = typeof currentData[labelKey] === "string" ? currentData[labelKey] : undefined;

  if (oldFilePath !== newFilePath && (await pathExists(newFilePath))) {
    throw new Error(`Entity already exists at destination: ${newFilePath}`);
  }

  const validated = entitySchemaMap[options.kind].parse({
    ...currentData,
    id: newId,
    [labelKey]: options.newNameOrTitle,
    ...(options.kind === "character"
      ? {
          aliases: uniqueValues([
            ...(Array.isArray(currentData.aliases) ? currentData.aliases.filter((value): value is string => typeof value === "string") : []),
            ...(oldLabel && oldLabel !== options.newNameOrTitle ? [oldLabel] : []),
          ]),
          former_names: uniqueValues([
            ...(Array.isArray(currentData.former_names) ? currentData.former_names.filter((value): value is string => typeof value === "string") : []),
            ...(oldLabel && oldLabel !== options.newNameOrTitle ? [oldLabel] : []),
          ]),
        }
      : {}),
  });

  if (oldFilePath !== newFilePath) {
    await rename(oldFilePath, newFilePath);
  }

  await writeFile(newFilePath, renderMarkdown(validated, String(parsed.content ?? "").trim()), "utf8");

  const movedAssetPaths = await moveAssetDirectoryIfPresent(root, oldId, newId);
  const updatedReferences = await replaceReferencesInMarkdownFiles(root, [
    [oldId, newId],
    [`asset:${options.kind}:${oldSlug}:`, `asset:${options.kind}:${nextSlug}:`],
    [assetDirectoryPrefix(oldId), assetDirectoryPrefix(newId)],
  ]);

  return {
    oldPath: oldFilePath,
    newPath: newFilePath,
    updatedReferences,
    movedAssetPaths,
  };
}

export async function renameChapter(
  rootPath: string,
  options: {
    chapter: string;
    newTitle: string;
    newNumber?: number;
  },
): Promise<RenameResult> {
  const root = path.resolve(rootPath);
  const oldFilePath = resolveChapterMetadataFilePath(root, options.chapter);

  if (!(await pathExists(oldFilePath))) {
    throw new Error(`Chapter does not exist: ${oldFilePath}`);
  }

  const oldChapterSlug = normalizeChapterReference(options.chapter);
  const raw = await readFile(oldFilePath, "utf8");
  const parsed = matter(raw);
  const current = chapterSchema.parse(parsed.data);
  const nextNumber = options.newNumber ?? current.number;
  const newChapterSlug = chapterSlug(nextNumber, options.newTitle);
  const oldFolderPath = path.join(root, "chapters", oldChapterSlug);
  const newFolderPath = path.join(root, "chapters", newChapterSlug);
  const newFilePath = path.join(newFolderPath, "chapter.md");

  if (oldFolderPath !== newFolderPath && (await pathExists(newFolderPath))) {
    throw new Error(`Chapter already exists at destination: ${newFolderPath}`);
  }

  if (oldFolderPath !== newFolderPath) {
    await rename(oldFolderPath, newFolderPath);
  }

  const validated = chapterSchema.parse({
    ...current,
    id: `chapter:${newChapterSlug}`,
    number: nextNumber,
    title: options.newTitle,
  });
  await writeFile(newFilePath, renderMarkdown(validated, String(parsed.content ?? "").trim()), "utf8");

  const oldResumePath = path.join(root, "resumes", "chapters", `${oldChapterSlug}.md`);
  const newResumePath = path.join(root, "resumes", "chapters", `${newChapterSlug}.md`);
  if (await pathExists(oldResumePath)) {
    if (oldResumePath !== newResumePath && (await pathExists(newResumePath))) {
      throw new Error(`Resume already exists at destination: ${newResumePath}`);
    }
    if (oldResumePath !== newResumePath) {
      await rename(oldResumePath, newResumePath);
    }

    const resumeRaw = await readFile(newResumePath, "utf8");
    const resumeParsed = matter(resumeRaw);
    await writeFile(
      newResumePath,
      renderMarkdown(
        {
          ...(resumeParsed.data as Record<string, unknown>),
          id: `resume:chapter:${newChapterSlug}`,
          title: `Resume ${newChapterSlug}`,
        },
        String(resumeParsed.content ?? "").trim(),
      ),
      "utf8",
    );
  }

  const oldEvaluationPath = path.join(root, "evaluations", "chapters", `${oldChapterSlug}.md`);
  const newEvaluationPath = path.join(root, "evaluations", "chapters", `${newChapterSlug}.md`);
  if (await pathExists(oldEvaluationPath)) {
    if (oldEvaluationPath !== newEvaluationPath && (await pathExists(newEvaluationPath))) {
      throw new Error(`Evaluation already exists at destination: ${newEvaluationPath}`);
    }
    if (oldEvaluationPath !== newEvaluationPath) {
      await rename(oldEvaluationPath, newEvaluationPath);
    }

    const evaluationRaw = await readFile(newEvaluationPath, "utf8");
    const evaluationParsed = matter(evaluationRaw);
    await writeFile(
      newEvaluationPath,
      renderMarkdown(
        {
          ...(evaluationParsed.data as Record<string, unknown>),
          id: `evaluation:chapter:${newChapterSlug}`,
          title: `Evaluation ${newChapterSlug}`,
        },
        String(evaluationParsed.content ?? "").trim(),
      ),
      "utf8",
    );
  }

  const oldChapterId = `chapter:${oldChapterSlug}`;
  const newChapterId = `chapter:${newChapterSlug}`;
  const movedAssetPaths = await moveAssetDirectoryIfPresent(root, oldChapterId, newChapterId);
  const updatedReferences = await replaceReferencesInMarkdownFiles(root, [
    [oldChapterId, newChapterId],
    [`paragraph:${oldChapterSlug}:`, `paragraph:${newChapterSlug}:`],
    [`asset:chapter:${oldChapterSlug}:`, `asset:chapter:${newChapterSlug}:`],
    [`asset:paragraph:${oldChapterSlug}:`, `asset:paragraph:${newChapterSlug}:`],
    [`resume:chapter:${oldChapterSlug}`, `resume:chapter:${newChapterSlug}`],
    [`evaluation:chapter:${oldChapterSlug}`, `evaluation:chapter:${newChapterSlug}`],
    [assetDirectoryPrefix(oldChapterId), assetDirectoryPrefix(newChapterId)],
  ]);

  await markStoryStateDirty(root, {
    changedPaths: [toPosixPath(path.relative(root, newFilePath))],
    reason: "chapter-renamed",
  });

  return {
    oldPath: oldFilePath,
    newPath: newFilePath,
    updatedReferences,
    movedAssetPaths,
  };
}

export async function renameParagraph(
  rootPath: string,
  options: {
    chapter: string;
    paragraph: string;
    newTitle: string;
    newNumber?: number;
  },
): Promise<RenameResult> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(options.chapter);
  const oldFilePath = await resolveParagraphFilePath(root, chapterSlugValue, options.paragraph);

  if (!(await pathExists(oldFilePath))) {
    throw new Error(`Paragraph does not exist: ${oldFilePath}`);
  }

  const raw = await readFile(oldFilePath, "utf8");
  const parsed = matter(raw);
  const current = paragraphSchema.parse(parsed.data);
  const oldParagraphSlug = path.basename(oldFilePath, ".md");
  const nextNumber = options.newNumber ?? current.number;
  const newParagraphSlug = paragraphFilename(nextNumber, options.newTitle).replace(/\.md$/i, "");
  const newFilePath = path.join(root, "chapters", chapterSlugValue, `${newParagraphSlug}.md`);

  if (oldFilePath !== newFilePath && (await pathExists(newFilePath))) {
    throw new Error(`Paragraph already exists at destination: ${newFilePath}`);
  }

  if (oldFilePath !== newFilePath) {
    await rename(oldFilePath, newFilePath);
  }

  const validated = paragraphSchema.parse({
    ...current,
    id: `paragraph:${chapterSlugValue}:${newParagraphSlug}`,
    number: nextNumber,
    title: options.newTitle,
  });
  await writeFile(newFilePath, renderMarkdown(validated, String(parsed.content ?? "").trim()), "utf8");

  const oldParagraphId = `paragraph:${chapterSlugValue}:${oldParagraphSlug}`;
  const newParagraphId = `paragraph:${chapterSlugValue}:${newParagraphSlug}`;
  const oldEvaluationPath = path.join(root, "evaluations", "paragraphs", chapterSlugValue, `${oldParagraphSlug}.md`);
  const newEvaluationPath = path.join(root, "evaluations", "paragraphs", chapterSlugValue, `${newParagraphSlug}.md`);

  if (await pathExists(oldEvaluationPath)) {
    await mkdir(path.dirname(newEvaluationPath), { recursive: true });
    if (oldEvaluationPath !== newEvaluationPath && (await pathExists(newEvaluationPath))) {
      throw new Error(`Paragraph evaluation already exists at destination: ${newEvaluationPath}`);
    }
    if (oldEvaluationPath !== newEvaluationPath) {
      await rename(oldEvaluationPath, newEvaluationPath);
    }

    const evaluationRaw = await readFile(newEvaluationPath, "utf8");
    const evaluationParsed = matter(evaluationRaw);
    await writeFile(
      newEvaluationPath,
      renderMarkdown(
        {
          ...(evaluationParsed.data as Record<string, unknown>),
          id: `evaluation:paragraph:${chapterSlugValue}:${newParagraphSlug}`,
          title: `Evaluation ${chapterSlugValue} ${newParagraphSlug}`,
          chapter: `chapter:${chapterSlugValue}`,
          paragraph: `paragraph:${chapterSlugValue}:${newParagraphSlug}`,
        },
        String(evaluationParsed.content ?? "").trim(),
      ),
      "utf8",
    );
  }

  const movedAssetPaths = await moveAssetDirectoryIfPresent(root, oldParagraphId, newParagraphId);
  const updatedReferences = await replaceReferencesInMarkdownFiles(root, [
    [oldParagraphId, newParagraphId],
    [`asset:paragraph:${chapterSlugValue}:${oldParagraphSlug}:`, `asset:paragraph:${chapterSlugValue}:${newParagraphSlug}:`],
    [
      `evaluation:paragraph:${chapterSlugValue}:${oldParagraphSlug}`,
      `evaluation:paragraph:${chapterSlugValue}:${newParagraphSlug}`,
    ],
    [assetDirectoryPrefix(oldParagraphId), assetDirectoryPrefix(newParagraphId)],
  ]);

  await markStoryStateDirty(root, {
    changedPaths: [toPosixPath(path.relative(root, newFilePath))],
    reason: "paragraph-renamed",
  });

  return {
    oldPath: oldFilePath,
    newPath: newFilePath,
    updatedReferences,
    movedAssetPaths,
  };
}

export async function readBook(
  rootPath: string,
): Promise<MarkdownDocument<BookFrontmatter> | null> {
  const bookPath = path.join(path.resolve(rootPath), BOOK_FILE);
  if (!(await pathExists(bookPath))) return null;
  return readMarkdownFile(bookPath, bookSchema);
}

export async function readPlot(
  rootPath: string,
): Promise<MarkdownDocument<PlotFrontmatter> | null> {
  const plotPath = path.join(path.resolve(rootPath), PLOT_FILE);
  if (!(await pathExists(plotPath))) return null;
  return readMarkdownFile(plotPath, plotSchema);
}

export async function listChapters(
  rootPath: string,
): Promise<Array<{ slug: string; path: string; metadata: ChapterFrontmatter }>> {
  const root = path.resolve(rootPath);
  const chaptersRoot = path.join(root, "chapters");

  if (!(await pathExists(chaptersRoot))) return [];

  const entries = await readdir(chaptersRoot, { withFileTypes: true });
  const chapterDirectories = entries.filter((entry) => entry.isDirectory());
  const results: Array<{ slug: string; path: string; metadata: ChapterFrontmatter }> = [];

  for (const entry of chapterDirectories) {
    const chapterPath = path.join(chaptersRoot, entry.name, "chapter.md");
    if (!(await pathExists(chapterPath))) continue;
    const document = await readMarkdownFile(chapterPath, chapterSchema);
    results.push({ slug: entry.name, path: chapterPath, metadata: document.frontmatter });
  }

  return results.sort((left, right) => left.metadata.number - right.metadata.number);
}

export async function readChapter(
  rootPath: string,
  chapter: string,
): Promise<{
  metadata: ChapterFrontmatter;
  body: string;
  paragraphs: Array<{ path: string; metadata: ParagraphFrontmatter; body: string }>;
}> {
  const root = path.resolve(rootPath);
  const chapterSlug = normalizeChapterReference(chapter);
  const folder = path.join(root, "chapters", chapterSlug);
  const chapterFile = path.join(folder, "chapter.md");

  if (!(await pathExists(chapterFile))) {
    throw new Error(`Missing chapter metadata file: ${chapterFile}`);
  }

  const chapterDocument = await readMarkdownFile(chapterFile, chapterSchema);
  const files = await fg("*.md", { cwd: folder, absolute: true, onlyFiles: true });
  const paragraphFiles = files.filter((filePath) => !["chapter.md", "writing-style.md", "notes.md", "ideas.md", "promoted.md"].includes(path.basename(filePath)));
  const paragraphs: Array<{ path: string; metadata: ParagraphFrontmatter; body: string }> = [];

  for (const filePath of paragraphFiles) {
    const paragraphDocument = await readMarkdownFile(filePath, paragraphSchema);
    paragraphs.push({
      path: filePath,
      metadata: paragraphDocument.frontmatter,
      body: paragraphDocument.body,
    });
  }

  paragraphs.sort((left, right) => left.metadata.number - right.metadata.number);

  return {
    metadata: chapterDocument.frontmatter,
    body: chapterDocument.body,
    paragraphs,
  };
}

export async function readChapterDraft(
  rootPath: string,
  chapter: string,
): Promise<{
  metadata: ChapterDraftFrontmatter;
  body: string;
  paragraphs: Array<{ path: string; metadata: ParagraphDraftFrontmatter; body: string }>;
}> {
  const root = path.resolve(rootPath);
  const chapterSlug = normalizeChapterReference(chapter);
  const folder = path.join(root, "drafts", chapterSlug);
  const chapterFile = path.join(folder, "chapter.md");

  if (!(await pathExists(chapterFile))) {
    throw new Error(`Missing chapter draft metadata file: ${chapterFile}`);
  }

  const chapterDocument = await readMarkdownFile(chapterFile, chapterDraftSchema);
  const files = await fg("*.md", { cwd: folder, absolute: true, onlyFiles: true });
  const paragraphFiles = files.filter((filePath) => !["chapter.md", "writing-style.md", "notes.md", "ideas.md", "promoted.md"].includes(path.basename(filePath)));
  const paragraphs: Array<{ path: string; metadata: ParagraphDraftFrontmatter; body: string }> = [];

  for (const filePath of paragraphFiles) {
    const paragraphDocument = await readMarkdownFile(filePath, paragraphDraftSchema);
    paragraphs.push({
      path: filePath,
      metadata: paragraphDocument.frontmatter,
      body: paragraphDocument.body,
    });
  }

  paragraphs.sort((left, right) => left.metadata.number - right.metadata.number);

  return {
    metadata: chapterDocument.frontmatter,
    body: chapterDocument.body,
    paragraphs,
  };
}

export async function readParagraphDraft(
  rootPath: string,
  chapter: string,
  paragraph: string,
): Promise<{ path: string; metadata: ParagraphDraftFrontmatter; body: string }> {
  const root = path.resolve(rootPath);
  const filePath = await resolveParagraphDraftFilePath(root, chapter, paragraph);

  if (!(await pathExists(filePath))) {
    throw new Error(`Paragraph draft does not exist: ${filePath}`);
  }

  const document = await readMarkdownFile(filePath, paragraphDraftSchema);
  return {
    path: filePath,
    metadata: document.frontmatter,
    body: document.body,
  };
}

export async function readParagraph(
  rootPath: string,
  chapter: string,
  paragraph: string,
): Promise<{ path: string; metadata: ParagraphFrontmatter; body: string }> {
  const root = path.resolve(rootPath);
  const filePath = await resolveParagraphFilePath(root, chapter, paragraph);

  if (!(await pathExists(filePath))) {
    throw new Error(`Paragraph does not exist: ${filePath}`);
  }

  const document = await readMarkdownFile(filePath, paragraphSchema);
  return {
    path: filePath,
    metadata: document.frontmatter,
    body: document.body,
  };
}

export async function buildChapterWritingContext(
  rootPath: string,
  chapter: string,
  options?: { throughParagraphNumber?: number },
): Promise<{ text: string; files: string[] }> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(chapter);
  const files = new Set<string>();
  const sections: string[] = [];
  const chapterData = await readChapter(root, chapterSlugValue).catch(() => null);
  const draft = await readChapterDraft(root, chapterSlugValue).catch(() => null);
  const throughParagraphNumber = options?.throughParagraphNumber;
  const chapters = await listChapters(root);
  const targetChapterNumber = chapterData?.metadata.number ?? draft?.metadata.number;
  const previousChapters =
    targetChapterNumber !== undefined
      ? chapters.filter((entry) => entry.metadata.number < targetChapterNumber)
      : chapters.filter((entry) => entry.slug !== chapterSlugValue);
  const previousChapter = previousChapters.at(-1) ?? null;

  const writingStyle = await readLooseMarkdownIfExists(path.join(root, GUIDELINE_FILES.writingStyle));
  addContextSection(sections, files, root, writingStyle, "Always-read writing style", 2200);

  const contextDocument = await readLooseMarkdownIfExists(path.join(root, CONTEXT_FILE));
  addContextSection(sections, files, root, contextDocument, "Stable book context", 1400);

  const storyDesign = await readLooseMarkdownIfExists(path.join(root, STORY_DESIGN_FILE));
  addContextSection(sections, files, root, storyDesign, "Story design", 1300);

  const bookNotes = await readLooseMarkdownIfExists(path.join(root, NOTES_FILE));
  addWorkItemSection(sections, files, root, bookNotes, "Book notes", 8, "No active book notes yet.");

  const styleContext = await buildEffectiveChapterStyleContext(root, chapterSlugValue, Boolean(chapterData), Boolean(draft));
  sections.push(styleContext.summarySection);
  for (const relativePath of styleContext.files) {
    files.add(relativePath);
  }
  for (const profileDocument of styleContext.documents) {
    addContextSection(
      sections,
      files,
      root,
      profileDocument,
      toPosixPath(path.relative(root, profileDocument.path)).startsWith("drafts/") ? "Chapter-specific writing style (draft)" : "Chapter-specific writing style",
      1600,
    );
  }

  const plot = await readPlot(root);
  addScopedChapterContextSection(
    sections,
    files,
    root,
    plot,
    `Plot map before this ${throughParagraphNumber !== undefined ? "paragraph" : "chapter"}`,
    previousChapters.length,
    previousChapters.length > 0 ? "No earlier chapter plot beats are summarized yet." : "No earlier chapters exist yet.",
  );

  const totalResume = await readLooseMarkdownIfExists(path.join(root, TOTAL_RESUME_FILE));
  addScopedChapterContextSection(
    sections,
    files,
    root,
    totalResume,
    `Story so far before this ${throughParagraphNumber !== undefined ? "paragraph" : "chapter"}`,
    previousChapters.length,
    previousChapters.length > 0 ? "No earlier chapter summary exists yet." : "No earlier chapters exist yet.",
  );

  if (previousChapter) {
    const stateSnapshot = await readLooseMarkdownIfExists(path.join(root, "state", "chapters", `${previousChapter.slug}.md`));
    addContextSection(sections, files, root, stateSnapshot, "Structured story state before this chapter", 1050);
  }

  if (throughParagraphNumber === undefined) {
    const chapterResume = await readLooseMarkdownIfExists(path.join(root, "resumes", "chapters", `${chapterSlugValue}.md`));
    addContextSection(sections, files, root, chapterResume, "Current chapter resume", 900);
  }

  if (previousChapter) {
    sections.push(
      [
        "## Previous chapter anchor",
        "",
        `Source: ${toPosixPath(path.join("chapters", previousChapter.slug, "chapter.md"))}`,
        `- Chapter ${formatOrdinal(previousChapter.metadata.number)} ${previousChapter.metadata.title}`,
        `- Summary: ${previousChapter.metadata.summary ?? "No summary yet."}`,
      ].join("\n"),
    );
    files.add(toPosixPath(path.join("chapters", previousChapter.slug, "chapter.md")));
  }

  if (chapterData) {
    const visibleExistingScenes =
      throughParagraphNumber !== undefined
        ? chapterData.paragraphs.filter((paragraph) => paragraph.metadata.number < throughParagraphNumber)
        : chapterData.paragraphs;
    files.add(toPosixPath(path.join("chapters", chapterSlugValue, "chapter.md")));
    sections.push(
      [
        "## Existing final chapter",
        "",
        `Source: ${toPosixPath(path.join("chapters", chapterSlugValue, "chapter.md"))}`,
        `- Title: ${chapterData.metadata.title}`,
        `- Summary: ${(chapterData.metadata.summary ?? summarizeText(chapterData.body, 240)) || "No summary yet."}`,
        `- POV: ${(chapterData.metadata.pov ?? []).join(", ") || "not set"}`,
        `- Timeline: ${chapterData.metadata.timeline_ref ?? "not set"}`,
        `- ${throughParagraphNumber !== undefined ? "Existing scenes before this paragraph" : "Existing scenes"}: ${visibleExistingScenes.map((paragraph) => `${formatOrdinal(paragraph.metadata.number)} ${paragraph.metadata.title}`).join("; ") || "none"}`,
      ].join("\n"),
    );
  }

  if (draft) {
    const visibleDraftScenes =
      throughParagraphNumber !== undefined
        ? draft.paragraphs.filter((paragraph) => paragraph.metadata.number < throughParagraphNumber)
        : draft.paragraphs;
    files.add(toPosixPath(path.join("drafts", chapterSlugValue, "chapter.md")));
    sections.push(
      [
        "## Matching chapter draft",
        "",
        `Source: ${toPosixPath(path.join("drafts", chapterSlugValue, "chapter.md"))}`,
        `- Summary: ${draft.metadata.summary ?? "No summary yet."}`,
        `- POV: ${(draft.metadata.pov ?? []).join(", ") || "not set"}`,
        `- Timeline: ${draft.metadata.timeline_ref ?? "not set"}`,
        `- ${throughParagraphNumber !== undefined ? "Draft scenes before this paragraph" : "Draft scenes"}: ${visibleDraftScenes.map((paragraph) => `${formatOrdinal(paragraph.metadata.number)} ${paragraph.metadata.title}`).join("; ") || "none"}`,
        "",
        summarizeText(draft.body, 1200) || "No chapter draft body yet.",
      ].join("\n"),
    );
  }

  const chapterDraftNotes = await readLooseMarkdownIfExists(path.join(root, chapterDraftNotesRelativePath(chapterSlugValue)));
  addWorkItemSection(sections, files, root, chapterDraftNotes, "Chapter draft notes", 8, "No active chapter draft notes yet.");

  return {
    text: [
      `# Chapter Writing Context for ${chapterSlugValue}`,
      "",
      "Read these before drafting or polishing the chapter prose.",
      "Write canon names as plain text in the prose body. Do not insert markdown links to canon files or reader routes; the reader resolves visible mentions automatically.",
      "",
      ...sections,
      "## Source files consulted",
      "",
      ...Array.from(files).sort().map((filePath) => `- ${filePath}`),
    ].join("\n"),
    files: Array.from(files).sort(),
  };
}

export async function buildParagraphWritingContext(
  rootPath: string,
  chapter: string,
  paragraph: string,
): Promise<{ text: string; files: string[] }> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(chapter);
  const paragraphDraft = await readParagraphDraft(root, chapterSlugValue, paragraph).catch(() => null);
  const paragraphFinal = await readParagraph(root, chapterSlugValue, paragraph).catch(() => null);

  if (!paragraphDraft && !paragraphFinal) {
    throw new Error(`Paragraph does not exist in drafts or final chapter: ${paragraph}`);
  }

  const targetNumber = paragraphDraft?.metadata.number ?? paragraphFinal?.metadata.number;
  const chapterContext = await buildChapterWritingContext(root, chapterSlugValue, {
    throughParagraphNumber: targetNumber,
  });
  const files = new Set(chapterContext.files);

  const finalChapter = await readChapter(root, chapterSlugValue).catch(() => null);
  const priorScenes = finalChapter
    ? finalChapter.paragraphs.filter((entry) => entry.metadata.number < (targetNumber ?? Number.MAX_SAFE_INTEGER))
    : [];
  const draftChapter = await readChapterDraft(root, chapterSlugValue).catch(() => null);
  const priorDraftScenes = draftChapter
    ? draftChapter.paragraphs.filter((entry) => entry.metadata.number < (targetNumber ?? Number.MAX_SAFE_INTEGER))
    : [];
  const priorSceneLines =
    priorScenes.length > 0
      ? priorScenes.map(
          (entry) => `${formatOrdinal(entry.metadata.number)} ${entry.metadata.title}: ${(entry.metadata.summary ?? summarizeText(entry.body, 160)) || "No summary yet."}`,
        )
      : priorDraftScenes.length > 0
        ? priorDraftScenes.map(
            (entry) => `${formatOrdinal(entry.metadata.number)} ${entry.metadata.title}: ${(entry.metadata.summary ?? summarizeText(entry.body, 160)) || "No summary yet."}`,
          )
        : ["No earlier scenes in this chapter yet."];

  if (paragraphFinal) {
    files.add(toPosixPath(path.relative(root, paragraphFinal.path)));
  }
  if (paragraphDraft) {
    files.add(toPosixPath(path.relative(root, paragraphDraft.path)));
  }

  return {
    text: [
      stripSourceFilesSection(chapterContext.text),
      "",
      ...(paragraphFinal
        ? [
            "## Current final paragraph",
            "",
            `Source: ${toPosixPath(path.relative(root, paragraphFinal.path))}`,
            `- Title: ${paragraphFinal.metadata.title}`,
            `- Summary: ${paragraphFinal.metadata.summary ?? "No summary yet."}`,
            `- Viewpoint: ${paragraphFinal.metadata.viewpoint ?? "not set"}`,
            "",
            summarizeText(paragraphFinal.body, 1400) || "No paragraph body yet.",
            "",
          ]
        : []),
      ...(paragraphDraft
        ? [
            "## Target paragraph draft",
            "",
            `Source: ${toPosixPath(path.relative(root, paragraphDraft.path))}`,
            `- Title: ${paragraphDraft.metadata.title}`,
            `- Summary: ${paragraphDraft.metadata.summary ?? "No summary yet."}`,
            `- Viewpoint: ${paragraphDraft.metadata.viewpoint ?? "not set"}`,
            "",
            summarizeText(paragraphDraft.body, 1400) || "No paragraph draft body yet.",
            "",
          ]
        : []),
      "## Prior scenes in this chapter before this paragraph",
      "",
      bulletLines(priorSceneLines),
      "",
      "## Source files consulted",
      "",
      ...Array.from(files).sort().map((filePath) => `- ${filePath}`),
    ].join("\n"),
    files: Array.from(files).sort(),
  };
}

export async function buildResumeBookContext(
  rootPath: string,
  options?: { chapter?: string; paragraph?: string },
): Promise<{ text: string; files: string[] }> {
  const root = path.resolve(rootPath);
  const files = new Set<string>();
  const sections: string[] = [];

  const book = await readBook(root);
  const targetChapter = options?.chapter?.trim();
  const targetParagraph = options?.paragraph?.trim();

  if (targetParagraph && !targetChapter) {
    throw new Error("resume_book_context requires a chapter when paragraph is provided.");
  }

  const continuation = await readLooseMarkdownIfExists(path.join(root, "conversations", "CONTINUATION.md"));
  const resume = await readLooseMarkdownIfExists(path.join(root, "conversations", "RESUME.md"));

  if (targetChapter) {
    const targetContext = targetParagraph
      ? await buildParagraphWritingContext(root, targetChapter, targetParagraph)
      : await buildChapterWritingContext(root, targetChapter);
    sections.push(stripSourceFilesSection(targetContext.text));
    for (const filePath of targetContext.files) {
      files.add(filePath);
    }
  } else {
    const writingStyle = await readLooseMarkdownIfExists(path.join(root, GUIDELINE_FILES.writingStyle));
    const contextDocument = await readLooseMarkdownIfExists(path.join(root, CONTEXT_FILE));
    const storyDesign = await readLooseMarkdownIfExists(path.join(root, STORY_DESIGN_FILE));
    const bookNotes = await readLooseMarkdownIfExists(path.join(root, NOTES_FILE));
    const plot = await readPlot(root);
    const totalResume = await readLooseMarkdownIfExists(path.join(root, TOTAL_RESUME_FILE));
    const storyStateCurrent = await readLooseMarkdownIfExists(path.join(root, STORY_STATE_CURRENT_FILE));
    const storyStateStatus = await readStoryStateStatus(root);
    const storyStateStatusDocument = storyStateStatus.dirty
      ? await readLooseMarkdownIfExists(path.join(root, STORY_STATE_STATUS_FILE))
      : null;

    addContextSection(sections, files, root, writingStyle, "Always-read writing style", 2200);
    addContextSection(sections, files, root, contextDocument, "Stable book context", 1400);
    addContextSection(sections, files, root, storyDesign, "Story design", 1300);
    addWorkItemSection(sections, files, root, bookNotes, "Book notes", 8, "No active book notes yet.");
    addContextSection(sections, files, root, plot, "Rolling plot map", 1400);
    addContextSection(sections, files, root, totalResume, "Book summary so far", 1100);
    addContextSection(
      sections,
      files,
      root,
      storyStateCurrent,
      storyStateStatus.dirty ? "Structured story state (stale)" : "Structured story state",
      1080,
    );
    addContextSection(sections, files, root, storyStateStatusDocument, "Story state sync status", 1070);
  }

  addContextSection(sections, files, root, resume, "Conversation resume", 1100);
  addContextSection(sections, files, root, continuation, "Conversation continuation", 1500);

  const latestConversationExports = await listLatestConversationExports(root, 3);
  if (latestConversationExports.length > 0) {
    sections.push(
      [
        "## Latest exported conversations",
        "",
        ...latestConversationExports.map((entry) => {
          files.add(entry.relativePath);
          return [`### ${entry.title}`, "", `Source: ${entry.relativePath}`, "", entry.excerpt].join("\n");
        }),
      ].join("\n"),
    );
  }

  return {
    text: [
      `# Resume Book Context${book ? ` for ${book.frontmatter.title}` : ""}`,
      "",
      targetChapter
        ? `Use this to restart book work before ${targetParagraph ? `paragraph ${targetParagraph} in ${normalizeChapterReference(targetChapter)}` : `chapter ${normalizeChapterReference(targetChapter)}`}, using point-in-time canon plus exported conversation history.`
        : "Use this to restart book work from repository state, exported conversation history, and current canon.",
      "",
      ...sections,
      "## Source files consulted",
      "",
      ...Array.from(files).sort().map((filePath) => `- ${filePath}`),
    ].join("\n"),
    files: Array.from(files).sort(),
  };
}

async function readWritingStyleDocuments(
  root: string,
  chapterSlugValue?: string,
  hasFinalChapter = false,
  hasDraftChapter = false,
): Promise<{
  global: GuidelineDocument | null;
  chapter: GuidelineDocument | null;
  draft: GuidelineDocument | null;
}> {
  const global = await readGuidelineIfExists(path.join(root, GUIDELINE_FILES.writingStyle));
  const chapter = chapterSlugValue && hasFinalChapter
    ? await readGuidelineIfExists(path.join(root, "chapters", chapterSlugValue, "writing-style.md"))
    : null;
  const draft = chapterSlugValue && hasDraftChapter
    ? await readGuidelineIfExists(path.join(root, "drafts", chapterSlugValue, "writing-style.md"))
    : null;

  return { global, chapter, draft };
}

async function readGuidelineIfExists(filePath: string): Promise<GuidelineDocument | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }

  const document = await readMarkdownFile(filePath, guidelineSchema);
  return {
    ...document,
    slug: path.basename(filePath, ".md"),
  };
}

async function listWritingStyleSourceFiles(root: string, chapterSlugValue?: string): Promise<string[]> {
  const styleDocuments = await readWritingStyleDocuments(root, chapterSlugValue, true, true);
  return [styleDocuments.global, styleDocuments.chapter, styleDocuments.draft]
    .filter((document): document is GuidelineDocument => Boolean(document))
    .map((document) => toPosixPath(path.relative(root, document.path)));
}

async function buildEffectiveChapterStyleContext(
  root: string,
  chapterSlugValue: string,
  hasFinalChapter: boolean,
  hasDraftChapter: boolean,
): Promise<{
  summarySection: string;
  documents: GuidelineDocument[];
  files: string[];
}> {
  const { global: globalStyle, chapter: chapterStyle, draft: draftStyle } = await readWritingStyleDocuments(
    root,
    chapterSlugValue,
    hasFinalChapter,
    hasDraftChapter,
  );
  const documents = [chapterStyle, draftStyle].filter((document): document is GuidelineDocument => Boolean(document));
  const files = [globalStyle, ...documents]
    .filter((document): document is GuidelineDocument => Boolean(document))
    .map((document) => toPosixPath(path.relative(root, document.path)));
  const summarySection = [
    "## Effective chapter style",
    "",
    `- Always use the global writing style from ${GUIDELINE_FILES.writingStyle}.`,
    chapterStyle
      ? `- Chapter-specific writing style: ${toPosixPath(path.relative(root, chapterStyle.path))}`
      : "- Chapter-specific writing style: none in final chapter files.",
    draftStyle
      ? `- Draft-specific writing style: ${toPosixPath(path.relative(root, draftStyle.path))}`
      : "- Draft-specific writing style: none in chapter draft files.",
    documents.length > 0
      ? "- When a chapter-specific writing-style.md exists, treat it as an explicit local override/addendum on top of the global writing style."
      : "- No chapter-local writing-style.md is present, so the global writing style applies on its own.",
  ].join("\n");

  return {
    summarySection,
    documents,
    files,
  };
}

export async function createChapterFromDraft(
  rootPath: string,
  options: {
    chapter: string;
    body?: string;
    overwrite?: boolean;
    frontmatterPatch?: Record<string, unknown>;
  },
): Promise<{ filePath: string; draftPath: string; frontmatter: ChapterFrontmatter }> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(options.chapter);
  const draft = await readChapterDraft(root, chapterSlugValue);
  const finalFrontmatter = compactFrontmatterPatch({
    summary: draft.metadata.summary,
    pov: draft.metadata.pov,
    style_refs: draft.metadata.style_refs,
    narration_person: draft.metadata.narration_person,
    narration_tense: draft.metadata.narration_tense,
    prose_mode: draft.metadata.prose_mode,
    timeline_ref: draft.metadata.timeline_ref,
    tags: draft.metadata.tags,
    ...(options.frontmatterPatch ?? {}),
  });
  const targetPath = resolveChapterMetadataFilePath(root, chapterSlugValue);
  const body = options.body ?? draft.body;

  const result = await pathExists(targetPath)
    ? await updateChapter(root, {
        chapter: chapterSlugValue,
        frontmatterPatch: finalFrontmatter,
        body,
      })
    : await createChapter(root, {
        number: draft.metadata.number,
        title: draft.metadata.title,
        body,
        overwrite: options.overwrite,
        frontmatter: finalFrontmatter,
      }).then(async (created) => ({
        filePath: created.chapterFilePath,
        frontmatter: (await readChapter(root, chapterSlugValue)).metadata,
      }));

  return {
    filePath: result.filePath,
    draftPath: path.join(root, "drafts", chapterSlugValue, "chapter.md"),
    frontmatter: result.frontmatter,
  };
}

export async function createParagraphFromDraft(
  rootPath: string,
  options: {
    chapter: string;
    paragraph: string;
    body?: string;
    overwrite?: boolean;
    frontmatterPatch?: Record<string, unknown>;
  },
): Promise<{ filePath: string; draftPath: string; frontmatter: ParagraphFrontmatter }> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(options.chapter);
  const draft = await readParagraphDraft(root, chapterSlugValue, options.paragraph);
  const finalFrontmatter = compactFrontmatterPatch({
    summary: draft.metadata.summary,
    viewpoint: draft.metadata.viewpoint,
    tags: draft.metadata.tags,
    ...(options.frontmatterPatch ?? {}),
  });
  const targetPath = await resolveParagraphFilePath(root, chapterSlugValue, String(draft.metadata.paragraph ?? options.paragraph));
  const body = options.body ?? draft.body;

  const result = await pathExists(targetPath)
    ? await updateParagraph(root, {
        chapter: chapterSlugValue,
        paragraph: String(draft.metadata.paragraph ?? options.paragraph),
        frontmatterPatch: finalFrontmatter,
        body,
      })
    : await createParagraph(root, {
        chapter: chapterSlugValue,
        number: draft.metadata.number,
        title: draft.metadata.title,
        body,
        overwrite: options.overwrite,
        frontmatter: finalFrontmatter,
      }).then(async (created) => ({
        filePath: created.filePath,
        frontmatter: (await readMarkdownFile(created.filePath, paragraphSchema)).frontmatter,
      }));

  return {
    filePath: result.filePath,
    draftPath: draft.path,
    frontmatter: result.frontmatter,
  };
}

export async function listEntities(
  rootPath: string,
  kind: EntityType,
): Promise<CanonEntityDocument[]> {
  const root = path.resolve(rootPath);
  const directory = ENTITY_TYPE_TO_DIRECTORY[kind];
  const schema = entitySchemaMap[kind] as { parse: (value: unknown) => Record<string, unknown> };
  const files = await fg("*.md", {
    cwd: path.join(root, directory),
    absolute: true,
    onlyFiles: true,
  });

  const results: CanonEntityDocument[] = [];

  for (const filePath of files) {
    const document = await readMarkdownFile(filePath, schema);
    results.push({
      slug: path.basename(filePath, ".md"),
      path: filePath,
      metadata: document.frontmatter,
      body: document.body,
    });
  }

  return results.sort((left, right) => {
    const leftTitle = String(left.metadata.name ?? left.metadata.title ?? left.slug).toLowerCase();
    const rightTitle = String(right.metadata.name ?? right.metadata.title ?? right.slug).toLowerCase();
    return leftTitle.localeCompare(rightTitle);
  });
}

export async function readEntity(
  rootPath: string,
  kind: EntityType,
  slugOrId: string,
): Promise<CanonEntityDocument> {
  const root = path.resolve(rootPath);
  const filePath = resolveEntityFilePath(root, kind, slugOrId);
  const schema = entitySchemaMap[kind] as { parse: (value: unknown) => Record<string, unknown> };

  if (!(await pathExists(filePath))) {
    throw new Error(`Entity does not exist: ${filePath}`);
  }

  const document = await readMarkdownFile(filePath, schema);
  return {
    slug: path.basename(filePath, ".md"),
    path: filePath,
    metadata: document.frontmatter,
    body: document.body,
  };
}

export async function readTimelineMain(
  rootPath: string,
): Promise<{ metadata: Record<string, unknown>; body: string } | null> {
  const root = path.resolve(rootPath);
  const filePath = path.join(root, TIMELINE_MAIN_FILE);

  if (!(await pathExists(filePath))) {
    return null;
  }

  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  return {
    metadata: parsed.data as Record<string, unknown>,
    body: String(parsed.content ?? "").trim(),
  };
}

export async function searchBook(
  rootPath: string,
  query: string,
  options?: { scopes?: string[]; limit?: number },
): Promise<SearchHit[]> {
  const root = path.resolve(rootPath);
  const limit = options?.limit ?? 10;
  const requestedScopes = options?.scopes?.map((scope) => `${scope.replace(/\/$/, "")}/**/*.md`) ?? [];
  const patterns = requestedScopes.length > 0 ? requestedScopes : CONTENT_GLOB;

  const files = await fg(patterns, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
  });

  const lowerQuery = query.toLowerCase();
  const hits: SearchHit[] = [];

  for (const filePath of files) {
    const raw = await readFile(filePath, "utf8");
    const parsed = matter(raw);
    const relativePath = toPosixPath(path.relative(root, filePath));
    const body = String(parsed.content ?? "");
    const frontmatter = parsed.data as Record<string, unknown>;
    const title =
      typeof frontmatter.name === "string"
        ? frontmatter.name
        : typeof frontmatter.title === "string"
          ? frontmatter.title
          : relativePath;
    const haystack = `${relativePath}\n${title}\n${body}`.toLowerCase();

    if (!haystack.includes(lowerQuery)) continue;

    let score = 0;
    if (relativePath.toLowerCase().includes(lowerQuery)) score += 60;
    if (title.toLowerCase().includes(lowerQuery)) score += 50;
    if (String(frontmatter.id ?? "").toLowerCase().includes(lowerQuery)) score += 30;
    if (body.toLowerCase().includes(lowerQuery)) score += 20;

    hits.push({
      path: relativePath,
      score,
      title,
      type: typeof frontmatter.type === "string" ? frontmatter.type : "unknown",
      excerpt: excerptAround(body, query),
    });
  }

  return hits.sort((left, right) => right.score - left.score).slice(0, limit);
}

export async function queryCanon(
  rootPath: string,
  question: string,
  options?: { throughChapter?: string; fromChapter?: string; toChapter?: string; limit?: number },
): Promise<QueryCanonResult> {
  const root = path.resolve(rootPath);
  const normalizedQuestion = question.trim();

  if (!normalizedQuestion) {
    throw new Error("Question cannot be empty.");
  }

  const limit = options?.limit ?? 6;
  const book = await readBook(root);
  const lexicon = resolveQueryCanonLexicon(book?.frontmatter.language);
  const chapters = await listChapters(root);
  const storyStateTimeline = await buildStoryStateTimeline(root);
  const storyStateStatus = await readStoryStateStatus(root);
  const chapterRange = resolveQueryCanonChapterRange(chapters, normalizedQuestion, options?.fromChapter, options?.toChapter, lexicon);
  const chapterScope = resolveQueryCanonChapterScope(
    chapters,
    normalizedQuestion,
    chapterRange?.endReference ?? options?.throughChapter,
    lexicon,
  );
  const intent = detectQueryCanonIntent(normalizedQuestion, Boolean(chapterRange), lexicon);
  const targets = await buildQueryCanonTargets(root, chapters, lexicon);
  const subjectHint = formatQueryCanonSubject(normalizedQuestion, lexicon);
  const targetResolution = resolveQueryCanonTarget(filterQueryCanonTargetsForIntent(targets, intent), normalizedQuestion, subjectHint);
  const lookup = buildQueryCanonLookup(targets, chapters);
  const effectiveThroughChapter = chapterRange?.endReference ?? chapterScope.reference;
  const baseNotes = uniqueValues(
    [
      ...(storyStateStatus.dirty
        ? ["Structured story state is marked stale; answers use the latest chapter resume deltas rather than synced state/current.md."]
        : []),
      ...(chapterRange?.note ? [chapterRange.note] : []),
      ...(chapterScope.note ? [chapterScope.note] : []),
      ...(targetResolution.note ? [targetResolution.note] : []),
    ].filter(Boolean),
  );

  const structuredResult =
    (intent === "state-location"
      ? answerLocationQuery(root, targetResolution.target, effectiveThroughChapter, storyStateTimeline.entries, lookup)
      : intent === "state-knowledge"
        ? answerKnowledgeQuery(root, targetResolution.target, effectiveThroughChapter, storyStateTimeline.entries, lookup)
      : intent === "state-inventory"
          ? answerInventoryQuery(root, targetResolution.target, effectiveThroughChapter, storyStateTimeline.entries, lookup)
          : intent === "state-relationship"
            ? answerRelationshipQuery(
                root,
                targetResolution.target,
                resolveSecondaryQueryCanonTarget(filterQueryCanonTargetsForIntent(targets, intent), normalizedQuestion, targetResolution.target),
                effectiveThroughChapter,
                storyStateTimeline.entries,
                lookup,
              )
            : intent === "state-relationship-arc"
              ? answerRelationshipArcQuery(
                  root,
                  targetResolution.target,
                  resolveSecondaryQueryCanonTarget(filterQueryCanonTargetsForIntent(targets, intent), normalizedQuestion, targetResolution.target),
                  chapterRange,
                  storyStateTimeline.entries,
                  lookup,
                )
            : intent === "state-condition"
              ? answerConditionQuery(root, targetResolution.target, effectiveThroughChapter, storyStateTimeline.entries, lookup)
              : intent === "state-condition-arc"
                ? answerConditionArcQuery(root, targetResolution.target, chapterRange, storyStateTimeline.entries, lookup)
              : intent === "state-open-loops"
                ? answerOpenLoopsQuery(root, targetResolution.target, effectiveThroughChapter, storyStateTimeline.entries, lookup)
                : intent === "state-open-loops-arc"
                  ? answerOpenLoopsArcQuery(root, targetResolution.target, chapterRange, storyStateTimeline.entries, lookup)
          : intent === "secret-holders"
              ? answerSecretHoldersQuery(root, targetResolution.target, lookup)
              : intent === "first-appearance"
                ? await answerFirstAppearanceQuery(root, normalizedQuestion, targetResolution.target, effectiveThroughChapter, chapters, lookup)
                : answerGeneralTargetQuery(root, targetResolution.target, lookup)) ??
    (await answerFallbackCanonQuery(root, normalizedQuestion, targetResolution.target, limit));

  return {
    question: normalizedQuestion,
    answer: structuredResult.answer,
    confidence: structuredResult.confidence,
    intent: structuredResult.intent,
    sources: structuredResult.sources.slice(0, limit),
    notes: uniqueValues([...baseNotes, ...structuredResult.notes]),
    matchedTarget: targetResolution.target?.id,
    throughChapter: effectiveThroughChapter,
    fromChapter: chapterRange?.startReference,
    toChapter: chapterRange?.endReference,
  };
}

export async function reviseParagraph(
  rootPath: string,
  options: {
    chapter: string;
    paragraph: string;
    mode: RevisionMode;
    intensity?: RevisionIntensity;
    preserveFacts?: boolean;
  },
): Promise<ReviseParagraphResult> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(options.chapter);
  const filePath = await resolveParagraphFilePath(root, chapterSlugValue, options.paragraph);

  if (!(await pathExists(filePath))) {
    throw new Error(`Paragraph does not exist: ${filePath}`);
  }

  const paragraphDocument = await readMarkdownFile(filePath, paragraphSchema);
  const chapterData = await readChapter(root, chapterSlugValue);
  const normalizedFilePath = path.resolve(filePath).toLowerCase();
  const paragraphIndex = chapterData.paragraphs.findIndex(
    (entry) => path.resolve(entry.path).toLowerCase() === normalizedFilePath,
  );
  if (paragraphIndex === -1) {
    throw new Error(`Paragraph is missing from chapter index: ${filePath}`);
  }

  const previousParagraph = paragraphIndex > 0 ? chapterData.paragraphs[paragraphIndex - 1] : null;
  const nextParagraph = paragraphIndex < chapterData.paragraphs.length - 1 ? chapterData.paragraphs[paragraphIndex + 1] : null;
  const intensity = options.intensity ?? "medium";
  const preserveFacts = options.preserveFacts ?? true;
  const chapters = await listChapters(root);
  const targets = await buildQueryCanonTargets(root, chapters);
  const primaryTarget = resolveRevisionPrimaryTarget(
    targets,
    paragraphDocument.frontmatter.viewpoint,
    chapterData.metadata.pov,
    paragraphDocument.body,
  );
  const proposal = reviseMarkdownBody(paragraphDocument.body, {
    mode: options.mode,
    intensity,
    preserveFacts,
    viewpointLabel: primaryTarget?.title ?? paragraphDocument.frontmatter.viewpoint,
  });
  const suggestedStateChanges = suggestParagraphStateChanges(paragraphDocument.body, {
    primaryTarget,
    targets,
    paragraphTitle: paragraphDocument.frontmatter.title,
    chapterTitle: chapterData.metadata.title,
  });
  const continuityImpact = classifyRevisionContinuityImpact(suggestedStateChanges);
  const chapterResumePath = path.join(root, "resumes", "chapters", `${chapterSlugValue}.md`);
  const storyStateStatus = await readStoryStateStatus(root);
  const revisionStyleSources = await listWritingStyleSourceFiles(root, chapterSlugValue);
  const sources = uniqueValues(
    [
      toPosixPath(path.relative(root, filePath)),
      toPosixPath(path.join("chapters", chapterSlugValue, "chapter.md")),
      ...(await pathExists(chapterResumePath) ? [toPosixPath(path.relative(root, chapterResumePath))] : []),
      ...revisionStyleSources,
      ...(await pathExists(path.join(root, STORY_STATE_CURRENT_FILE)) ? [STORY_STATE_CURRENT_FILE] : []),
      ...(storyStateStatus.dirty ? [STORY_STATE_STATUS_FILE] : []),
      ...(previousParagraph ? [toPosixPath(path.relative(root, previousParagraph.path))] : []),
      ...(nextParagraph ? [toPosixPath(path.relative(root, nextParagraph.path))] : []),
    ],
  ).sort();

  return {
    filePath,
    chapter: `chapter:${chapterSlugValue}`,
    paragraph: paragraphDocument.frontmatter.id,
    mode: options.mode,
    intensity,
    preserveFacts,
    originalBody: paragraphDocument.body,
    proposedBody: proposal.body,
    editorialNotes: buildRevisionEditorialNotes({
      mode: options.mode,
      intensity,
      originalBody: paragraphDocument.body,
      proposedBody: proposal.body,
      proposalNotes: proposal.notes,
      continuityImpact,
      primaryTarget: primaryTarget?.title,
      previousParagraphTitle: previousParagraph?.metadata.title,
      nextParagraphTitle: nextParagraph?.metadata.title,
      preserveFacts,
    }),
    continuityImpact,
    suggestedStateChanges,
    shouldReviewStateChanges: continuityImpact !== "none",
    sources,
  };
}

export async function reviewDialogueActionBeats(
  rootPath: string,
  options: {
    chapter: string;
    paragraph: string;
    intensity?: RevisionIntensity;
    preserveDialogueWords?: boolean;
    allowMissingActionAdds?: boolean;
    allowSaidFallback?: boolean;
    includeTicSuggestions?: boolean;
  },
): Promise<ReviewDialogueActionBeatsResult> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(options.chapter);
  const filePath = await resolveParagraphFilePath(root, chapterSlugValue, options.paragraph);

  if (!(await pathExists(filePath))) {
    throw new Error(`Paragraph does not exist: ${filePath}`);
  }

  const paragraphDocument = await readMarkdownFile(filePath, paragraphSchema);
  const chapterData = await readChapter(root, chapterSlugValue);
  const chapters = await listChapters(root);
  const targets = await buildQueryCanonTargets(root, chapters);
  const primaryTarget = resolveRevisionPrimaryTarget(
    targets,
    paragraphDocument.frontmatter.viewpoint,
    chapterData.metadata.pov,
    paragraphDocument.body,
  );
  const characters = await listEntities(root, "character");
  const characterProfiles = buildDialogueCharacterProfiles(characters);
  const parsedBeats = parseDialogueActionBeats(paragraphDocument.body, characterProfiles);
  const intensity = options.intensity ?? "medium";
  const preserveDialogueWords = options.preserveDialogueWords ?? true;
  const allowMissingActionAdds = options.allowMissingActionAdds ?? true;
  const allowSaidFallback = options.allowSaidFallback ?? true;
  const includeTicSuggestions = options.includeTicSuggestions ?? true;
  const chapterResumePath = path.join(root, "resumes", "chapters", `${chapterSlugValue}.md`);
  const storyStateStatus = await readStoryStateStatus(root);
  const revisionStyleSources = await listWritingStyleSourceFiles(root, chapterSlugValue);
  const chapterStyleContext = await buildEffectiveChapterStyleContext(root, chapterSlugValue, true, true);
  const bookLanguage = normalizeBookLanguage((await readBook(root))?.frontmatter.language);

  const proposals = parsedBeats.map((beat) =>
    buildDialogueActionBeatProposal({
      beat,
      characterProfiles,
      paragraphBody: paragraphDocument.body,
      intensity,
      preserveDialogueWords,
      allowMissingActionAdds,
      allowSaidFallback,
      primaryTarget: primaryTarget?.title,
      language: bookLanguage,
    }),
  );
  const previewBody = applyDialogueActionBeatSelectionsToBody(
    paragraphDocument.body,
    proposals,
    proposals.map((proposal) => ({
      beatId: proposal.beatId,
      choiceId: proposal.recommendedChoiceId,
    })),
  );
  const suggestedStateChanges = suggestParagraphStateChanges(previewBody, {
    primaryTarget,
    targets,
    paragraphTitle: paragraphDocument.frontmatter.title,
    chapterTitle: chapterData.metadata.title,
  });
  const continuityImpact = classifyRevisionContinuityImpact(suggestedStateChanges);
  const paragraphHash = createParagraphReviewHash(paragraphDocument.body);
  const reviewId = createDialogueActionReviewId(filePath, paragraphHash, proposals.map((proposal) => `${proposal.beatId}:${proposal.recommendedChoiceId}`));
  const ticSuggestions = includeTicSuggestions
    ? buildDialogueActionTicSuggestions(proposals, characterProfiles, bookLanguage)
    : [];
  const sources = uniqueValues(
    [
      toPosixPath(path.relative(root, filePath)),
      toPosixPath(path.join("chapters", chapterSlugValue, "chapter.md")),
      ...(await pathExists(chapterResumePath) ? [toPosixPath(path.relative(root, chapterResumePath))] : []),
      ...revisionStyleSources,
      ...(await pathExists(path.join(root, STORY_STATE_CURRENT_FILE)) ? [STORY_STATE_CURRENT_FILE] : []),
      ...(storyStateStatus.dirty ? [STORY_STATE_STATUS_FILE] : []),
      ...proposals.flatMap((proposal) => {
        const ids = [proposal.speaker, proposal.actedCharacter].filter((value): value is string => Boolean(value));
        return ids
          .map((id) => characterProfiles.find((profile) => profile.id === id)?.path)
          .filter((value): value is string => Boolean(value));
      }),
    ],
  ).sort();

  return {
    reviewId,
    filePath,
    chapter: `chapter:${chapterSlugValue}`,
    paragraph: paragraphDocument.frontmatter.id,
    paragraphHash,
    originalBody: paragraphDocument.body,
    previewBody,
    continuityImpact,
    suggestedStateChanges,
    editorialNotes: buildDialogueActionEditorialNotes({
      proposals,
      intensity,
      chapterStyleSummary: chapterStyleContext.summarySection,
    }),
    beatProposals: proposals.map(stripInternalDialogueActionBeatProposal),
    ticSuggestions,
    sources,
  };
}

export async function applyDialogueActionBeats(
  rootPath: string,
  options: {
    chapter: string;
    paragraph: string;
    reviewId: string;
    expectedParagraphHash: string;
    selections: Array<{ beatId: string; choiceId: string }>;
  },
): Promise<ApplyDialogueActionBeatsResult> {
  const review = await reviewDialogueActionBeats(rootPath, {
    chapter: options.chapter,
    paragraph: options.paragraph,
  });

  if (review.reviewId !== options.reviewId) {
    throw new Error("Dialogue beat review is stale. Run review_dialogue_action_beats again before applying changes.");
  }

  if (review.paragraphHash !== options.expectedParagraphHash) {
    throw new Error("Paragraph changed since the dialogue beat review was generated. Run the review again before applying changes.");
  }

  const internalProposals = await buildInternalDialogueActionBeatProposals(rootPath, {
    chapter: options.chapter,
    paragraph: options.paragraph,
  });
  const updatedBody = applyDialogueActionBeatSelectionsToBody(review.originalBody, internalProposals, options.selections);
  const changedBeatCount = options.selections.filter((selection) => {
    const proposal = internalProposals.find((item) => item.beatId === selection.beatId);
    if (!proposal) {
      return false;
    }

    return selection.choiceId !== proposal.recommendedChoiceId || proposal.choices.find((choice) => choice.choiceId === selection.choiceId)?.operation !== "keep";
  }).length;

  const updateResult = await updateParagraph(rootPath, {
    chapter: options.chapter,
    paragraph: options.paragraph,
    body: updatedBody,
  });
  const chapterSlugValue = normalizeChapterReference(options.chapter);
  const chapters = await listChapters(path.resolve(rootPath));
  const targets = await buildQueryCanonTargets(path.resolve(rootPath), chapters);
  const primaryTarget = resolveRevisionPrimaryTarget(
    targets,
    undefined,
    (await readChapter(path.resolve(rootPath), chapterSlugValue)).metadata.pov,
    updatedBody,
  );
  const suggestedStateChanges = suggestParagraphStateChanges(updatedBody, {
    primaryTarget,
    targets,
    paragraphTitle: (await readParagraph(path.resolve(rootPath), chapterSlugValue, options.paragraph)).metadata.title,
    chapterTitle: (await readChapter(path.resolve(rootPath), chapterSlugValue)).metadata.title,
  });

  return {
    filePath: updateResult.filePath,
    chapter: `chapter:${chapterSlugValue}`,
    paragraph: options.paragraph.startsWith("paragraph:") ? options.paragraph : (await readParagraph(path.resolve(rootPath), chapterSlugValue, options.paragraph)).metadata.id,
    reviewId: options.reviewId,
    changedBeatCount,
    appliedSelections: options.selections.map((selection) => {
      const proposal = internalProposals.find((item) => item.beatId === selection.beatId);
      const choice = proposal?.choices.find((item) => item.choiceId === selection.choiceId);
      return {
        beatId: selection.beatId,
        choiceId: selection.choiceId,
        operation: choice?.operation ?? "keep",
      };
    }),
    updatedBody,
    continuityImpact: classifyRevisionContinuityImpact(suggestedStateChanges),
    suggestedStateChanges,
  };
}

async function buildInternalDialogueActionBeatProposals(
  rootPath: string,
  options: { chapter: string; paragraph: string },
): Promise<InternalDialogueActionBeatProposal[]> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(options.chapter);
  const filePath = await resolveParagraphFilePath(root, chapterSlugValue, options.paragraph);
  const paragraphDocument = await readMarkdownFile(filePath, paragraphSchema);
  const chapterData = await readChapter(root, chapterSlugValue);
  const chapters = await listChapters(root);
  const targets = await buildQueryCanonTargets(root, chapters);
  const primaryTarget = resolveRevisionPrimaryTarget(
    targets,
    paragraphDocument.frontmatter.viewpoint,
    chapterData.metadata.pov,
    paragraphDocument.body,
  );
  const characters = await listEntities(root, "character");
  const characterProfiles = buildDialogueCharacterProfiles(characters);
  const parsedBeats = parseDialogueActionBeats(paragraphDocument.body, characterProfiles);
  const bookLanguage = normalizeBookLanguage((await readBook(root))?.frontmatter.language);

  return parsedBeats.map((beat) =>
    buildDialogueActionBeatProposal({
      beat,
      characterProfiles,
      paragraphBody: paragraphDocument.body,
      intensity: "medium",
      preserveDialogueWords: true,
      allowMissingActionAdds: true,
      allowSaidFallback: true,
      primaryTarget: primaryTarget?.title,
      language: bookLanguage,
    }),
  );
}

export async function reviseChapter(
  rootPath: string,
  options: {
    chapter: string;
    mode: RevisionMode;
    intensity?: RevisionIntensity;
    preserveFacts?: boolean;
  },
): Promise<ReviseChapterResult> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(options.chapter);
  const chapterData = await readChapter(root, chapterSlugValue);
  const chapterFilePath = resolveChapterMetadataFilePath(root, chapterSlugValue);
  const intensity = options.intensity ?? "medium";
  const preserveFacts = options.preserveFacts ?? true;
  const chapters = await listChapters(root);
  const targets = await buildQueryCanonTargets(root, chapters);
  const chapterResumePath = path.join(root, "resumes", "chapters", `${chapterSlugValue}.md`);
  const storyStateStatus = await readStoryStateStatus(root);
  const revisionStyleSources = await listWritingStyleSourceFiles(root, chapterSlugValue);

  const proposedParagraphs = chapterData.paragraphs.map((paragraph, index) => {
    const previousParagraph = index > 0 ? chapterData.paragraphs[index - 1] : null;
    const nextParagraph = index < chapterData.paragraphs.length - 1 ? chapterData.paragraphs[index + 1] : null;
    const primaryTarget = resolveRevisionPrimaryTarget(
      targets,
      paragraph.metadata.viewpoint,
      chapterData.metadata.pov,
      paragraph.body,
    );
    const proposal = reviseMarkdownBody(paragraph.body, {
      mode: options.mode,
      intensity,
      preserveFacts,
      viewpointLabel: primaryTarget?.title ?? paragraph.metadata.viewpoint,
    });
    const suggestedStateChanges = suggestParagraphStateChanges(paragraph.body, {
      primaryTarget,
      targets,
      paragraphTitle: paragraph.metadata.title,
      chapterTitle: chapterData.metadata.title,
    });
    const continuityImpact = classifyRevisionContinuityImpact(suggestedStateChanges);
    const changed = proposal.body !== paragraph.body;

    return {
      filePath: paragraph.path,
      paragraph: paragraph.metadata.id,
      title: paragraph.metadata.title,
      originalBody: paragraph.body,
      proposedBody: proposal.body,
      editorialNotes: buildRevisionEditorialNotes({
        mode: options.mode,
        intensity,
        originalBody: paragraph.body,
        proposedBody: proposal.body,
        proposalNotes: proposal.notes,
        continuityImpact,
        primaryTarget: primaryTarget?.title,
        previousParagraphTitle: previousParagraph?.metadata.title,
        nextParagraphTitle: nextParagraph?.metadata.title,
        preserveFacts,
      }),
      continuityImpact,
      suggestedStateChanges,
      shouldReviewStateChanges: continuityImpact !== "none",
      changed,
    } satisfies ReviseChapterSceneProposal;
  });

  const filteredParagraphs = proposedParagraphs.filter((proposal) => proposal.changed || proposal.shouldReviewStateChanges);
  const mergedStateChanges = mergeSuggestedStoryStateChanges(
    proposedParagraphs.map((proposal) => proposal.suggestedStateChanges),
  );
  const overallContinuityImpact = maxRevisionContinuityImpact(
    proposedParagraphs.map((proposal) => proposal.continuityImpact),
  );
  const sources = uniqueValues(
    [
      toPosixPath(path.relative(root, chapterFilePath)),
      ...chapterData.paragraphs.map((paragraph) => toPosixPath(path.relative(root, paragraph.path))),
      ...(await pathExists(chapterResumePath) ? [toPosixPath(path.relative(root, chapterResumePath))] : []),
      ...revisionStyleSources,
      ...(await pathExists(path.join(root, STORY_STATE_CURRENT_FILE)) ? [STORY_STATE_CURRENT_FILE] : []),
      ...(storyStateStatus.dirty ? [STORY_STATE_STATUS_FILE] : []),
    ],
  ).sort();

  return {
    filePath: chapterFilePath,
    chapter: `chapter:${chapterSlugValue}`,
    chapterTitle: chapterData.metadata.title,
    mode: options.mode,
    intensity,
    preserveFacts,
    sceneCount: chapterData.paragraphs.length,
    changedSceneCount: proposedParagraphs.filter((proposal) => proposal.changed).length,
    chapterDiagnosis: buildChapterRevisionDiagnosis({
      chapterTitle: chapterData.metadata.title,
      mode: options.mode,
      intensity,
      preserveFacts,
      chapterBody: chapterData.body,
      paragraphs: proposedParagraphs,
    }),
    revisionPlan: buildChapterRevisionPlan(proposedParagraphs),
    proposedParagraphs: filteredParagraphs.length > 0 ? filteredParagraphs : proposedParagraphs,
    overallContinuityImpact,
    suggestedStateChanges: mergedStateChanges,
    shouldReviewStateChanges: overallContinuityImpact !== "none",
    sources,
  };
}

function buildDialogueCharacterProfiles(characters: CanonEntityDocument[]): DialogueCharacterProfile[] {
  return characters.map((character) => {
    const metadata = character.metadata as Record<string, unknown>;
    const aliases = uniqueValues(
      [
        typeof metadata.name === "string" ? metadata.name : undefined,
        ...(Array.isArray(metadata.aliases) ? metadata.aliases.filter((value): value is string => typeof value === "string") : []),
        ...(Array.isArray(metadata.former_names) ? metadata.former_names.filter((value): value is string => typeof value === "string") : []),
        typeof metadata.current_identity === "string" ? metadata.current_identity : undefined,
      ].filter((value): value is string => Boolean(value && value.trim())),
    );

    return {
      id: String(metadata.id ?? `character:${character.slug}`),
      title: typeof metadata.name === "string" ? metadata.name : character.slug,
      path: toPosixPath(character.path),
      aliases,
      speakingStyle: typeof metadata.speaking_style === "string" ? metadata.speaking_style : undefined,
      traits: Array.isArray(metadata.traits) ? metadata.traits.filter((value): value is string => typeof value === "string") : [],
      mannerisms: Array.isArray(metadata.mannerisms) ? metadata.mannerisms.filter((value): value is string => typeof value === "string") : [],
      desires: Array.isArray(metadata.desires) ? metadata.desires.filter((value): value is string => typeof value === "string") : [],
      fears: Array.isArray(metadata.fears) ? metadata.fears.filter((value): value is string => typeof value === "string") : [],
      relationships: Array.isArray(metadata.relationships) ? metadata.relationships.filter((value): value is string => typeof value === "string") : [],
      backgroundSummary: typeof metadata.background_summary === "string" ? metadata.background_summary : undefined,
      internalConflict: typeof metadata.internal_conflict === "string" ? metadata.internal_conflict : undefined,
      externalConflict: typeof metadata.external_conflict === "string" ? metadata.external_conflict : undefined,
    };
  });
}

function parseDialogueActionBeats(body: string, characterProfiles: DialogueCharacterProfile[]): ParsedDialogueBeat[] {
  const lines = body.split("\n");
  const usedActionLines = new Set<number>();
  const beats: ParsedDialogueBeat[] = [];
  const sceneCharacters = extractSceneCharacterIds(body, characterProfiles);
  let lastSpeakerId: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isDialogueLine(line)) {
      continue;
    }

    const previousIndex = findAdjacentActionLine(lines, index, -1, usedActionLines);
    const nextIndex = previousIndex === null ? findAdjacentActionLine(lines, index, 1, usedActionLines) : null;
    const actionLineIndex = previousIndex ?? nextIndex;
    if (actionLineIndex !== null) {
      usedActionLines.add(actionLineIndex);
    }

    const actionText = actionLineIndex !== null ? lines[actionLineIndex].trim() : extractEmbeddedDialogueTag(line);
    const actorId = inferCharacterId(actionText ?? line, characterProfiles, lastSpeakerId, sceneCharacters);
    const speakerId = actorId ?? inferAlternatingSpeaker(lastSpeakerId, sceneCharacters);
    if (speakerId) {
      lastSpeakerId = speakerId;
    }

    const startLineIndex = actionLineIndex !== null && actionLineIndex < index ? actionLineIndex : index;
    const endLineIndex = actionLineIndex !== null && actionLineIndex > index ? actionLineIndex : index;
    beats.push({
      beatId: `beat-${beats.length + 1}`,
      order: beats.length + 1,
      quoteLineIndex: index,
      actionLineIndex,
      speakerId,
      actedCharacterId: actorId,
      quoteText: extractDialogueQuote(line),
      actionText,
      startLineIndex,
      endLineIndex,
      previousExcerpt: previousMeaningfulLine(lines, startLineIndex),
      nextExcerpt: nextMeaningfulLine(lines, endLineIndex),
    });
  }

  return beats;
}

function buildDialogueActionBeatProposal(input: {
  beat: ParsedDialogueBeat;
  characterProfiles: DialogueCharacterProfile[];
  paragraphBody: string;
  intensity: RevisionIntensity;
  preserveDialogueWords: boolean;
  allowMissingActionAdds: boolean;
  allowSaidFallback: boolean;
  primaryTarget?: string;
  language: string;
}): InternalDialogueActionBeatProposal {
  const speaker = input.beat.speakerId
    ? input.characterProfiles.find((profile) => profile.id === input.beat.speakerId)
    : undefined;
  const assessment = assessDialogueActionBeat(input.beat, speaker, input.paragraphBody, input.primaryTarget);
  const choices = buildDialogueActionBeatChoices({
    beat: input.beat,
    speaker,
    assessment,
    intensity: input.intensity,
    preserveDialogueWords: input.preserveDialogueWords,
    allowMissingActionAdds: input.allowMissingActionAdds,
    allowSaidFallback: input.allowSaidFallback,
    language: input.language,
  });
  const recommendedChoiceId =
    choices.find((choice) => !choice.usesSaidFallback && choice.operation !== "keep")?.choiceId ??
    choices.find((choice) => choice.usesSaidFallback)?.choiceId ??
    choices[0]?.choiceId ??
    `${input.beat.beatId}-keep`;

  return {
    beatId: input.beat.beatId,
    order: input.beat.order,
    speaker: input.beat.speakerId,
    actedCharacter: input.beat.actedCharacterId,
    beatKind: input.beat.actionText ? "action" : "gap",
    quoteText: input.beat.quoteText,
    currentBeatText: input.beat.actionText,
    anchor: {
      previousExcerpt: input.beat.previousExcerpt,
      currentExcerpt: buildCurrentDialogueExcerpt(input.beat),
      nextExcerpt: input.beat.nextExcerpt,
    },
    purposeAssessment: assessment.level,
    diagnosis: assessment.notes,
    choices,
    recommendedChoiceId,
    startLineIndex: input.beat.startLineIndex,
    endLineIndex: input.beat.endLineIndex,
  };
}

function assessDialogueActionBeat(
  beat: ParsedDialogueBeat,
  speaker: DialogueCharacterProfile | undefined,
  paragraphBody: string,
  primaryTarget?: string,
): {
  level: DialogueActionBeatProposal["purposeAssessment"];
  notes: string[];
  psychology: string[];
  sceneSpace: string[];
  subtext: string[];
  relationshipDynamics: string[];
  canon: string[];
} {
  const notes: string[] = [];
  const psychology: string[] = [];
  const sceneSpace: string[] = [];
  const subtext: string[] = [];
  const relationshipDynamics: string[] = [];
  const canon: string[] = [];
  const action = (beat.actionText ?? "").trim();
  const quote = beat.quoteText;

  if (!action) {
    notes.push("The line currently has no action beat around the spoken line.");
    if (beat.previousExcerpt || beat.nextExcerpt) {
      sceneSpace.push("A local beat could help anchor the exchange in space or pressure.");
    }
    if (speaker) {
      canon.push(`Speaker profile available: ${speaker.title}.`);
    }
    return {
      level: "unclear",
      notes,
      psychology,
      sceneSpace,
      subtext,
      relationshipDynamics,
      canon,
    };
  }

  const normalizedAction = action.toLowerCase();
  if (/(bellissim|mano destra|mano sinistra|suoi capelli|sua mano|suo sguardo)/i.test(normalizedAction)) {
    notes.push("The action over-explains body parts or appearance instead of focusing on dramatic function.");
  }
  if (/(sorrise|annu[iì]|guard[oò]|sospir[oò]|si sistem[oò] i capelli|alz[oò] le spalle)/i.test(normalizedAction)) {
    notes.push("The beat relies on a generic gesture that risks sounding decorative.");
  }
  if (/(si avvicin[oò]|arretr[oò]|indietreggi[oò]|sbatt|strinse|prese|lasci[oò]|occup|cedette spazio)/i.test(normalizedAction)) {
    sceneSpace.push("The beat changes distance or contact, which can carry power and tension.");
  }
  if (/(registro|muro|porta|sedia|bicchiere|lettera|tunica|anello|manica|muro|tavolo)/i.test(paragraphBody)) {
    sceneSpace.push("The scene already contains tangible objects or surfaces that can support a more purposeful beat.");
  }
  if (/(matto|felice|oggi|vuoi|non|mai|proprio)/i.test(quote.toLowerCase())) {
    subtext.push("The spoken line carries emotional pressure, so the beat should sharpen rather than duplicate it.");
  }
  if (speaker) {
    if (speaker.traits.length > 0) {
      psychology.push(`Traits in canon: ${speaker.traits.slice(0, 3).join(", ")}.`);
    }
    if (speaker.fears.length > 0) {
      psychology.push(`Fear pressure: ${speaker.fears.slice(0, 2).join(", ")}.`);
    }
    if (speaker.desires.length > 0) {
      relationshipDynamics.push(`Current desire pressure: ${speaker.desires.slice(0, 2).join(", ")}.`);
    }
    if (speaker.relationships.length > 0) {
      canon.push(`Known relationships: ${speaker.relationships.slice(0, 2).join(", ")}.`);
    }
    if (speaker.speakingStyle) {
      canon.push(`Speaking style: ${speaker.speakingStyle}.`);
    }
  }
  if (primaryTarget && speaker && primaryTarget !== speaker.title) {
    relationshipDynamics.push(`The paragraph viewpoint leans toward ${primaryTarget}, so the beat should stay readable from that perspective.`);
  }

  if (notes.length === 0 && (sceneSpace.length > 0 || subtext.length > 0 || psychology.length > 0)) {
    notes.push("The beat already does narrative work and can likely be tightened rather than replaced.");
    return {
      level: "strong",
      notes,
      psychology,
      sceneSpace,
      subtext,
      relationshipDynamics,
      canon,
    };
  }

  return {
    level: notes.length >= 2 ? "weak" : "misaligned",
    notes,
    psychology,
    sceneSpace,
    subtext,
    relationshipDynamics,
    canon,
  };
}

function buildDialogueActionBeatChoices(input: {
  beat: ParsedDialogueBeat;
  speaker?: DialogueCharacterProfile;
  assessment: ReturnType<typeof assessDialogueActionBeat>;
  intensity: RevisionIntensity;
  preserveDialogueWords: boolean;
  allowMissingActionAdds: boolean;
  allowSaidFallback: boolean;
  language: string;
}): InternalDialogueActionBeatChoice[] {
  const speakerLabel = input.speaker?.title ?? "The speaker";
  const quoteLine = input.beat.quoteText;
  const originalBlock = buildCurrentDialogueExcerpt(input.beat);
  const choices: InternalDialogueActionBeatChoice[] = [
    {
      choiceId: `${input.beat.beatId}-keep`,
      operation: "keep",
      label: "Keep current beat",
      proposedText: originalBlock,
      proposedBlock: originalBlock,
      usesSaidFallback: false,
      addsNewAction: false,
      confidence: input.assessment.level === "strong" ? "high" : "low",
      rationale: {
        psychology: input.assessment.psychology,
        sceneSpace: input.assessment.sceneSpace,
        subtext: input.assessment.subtext,
        relationshipDynamics: input.assessment.relationshipDynamics,
        canon: input.assessment.canon,
      },
    },
  ];

  const purposefulAction = buildPurposefulDialogueAction(input.speaker, input.beat, input.intensity, input.language);
  const purposefulBlock = input.beat.actionLineIndex !== null && input.beat.actionLineIndex < input.beat.quoteLineIndex
    ? `${purposefulAction}\n${quoteLine}`
    : input.beat.actionLineIndex !== null && input.beat.actionLineIndex > input.beat.quoteLineIndex
      ? `${quoteLine}\n${purposefulAction}`
      : `${purposefulAction}\n${quoteLine}`;

  if (input.beat.actionText) {
    choices.push({
      choiceId: `${input.beat.beatId}-replace-action`,
      operation: "replace",
      label: "Replace with a more purposeful action beat",
      proposedText: purposefulAction,
      proposedBlock: purposefulBlock,
      usesSaidFallback: false,
      addsNewAction: !Boolean(input.beat.actionText),
      confidence: input.assessment.level === "strong" ? "medium" : "high",
      rationale: buildDialogueActionRationale(input.speaker, input.assessment, "purposeful", input.language),
    });
  } else if (input.allowMissingActionAdds) {
    choices.push({
      choiceId: `${input.beat.beatId}-insert-action`,
      operation: "insert_before",
      label: "Add a purposeful action beat",
      proposedText: purposefulAction,
      proposedBlock: purposefulBlock,
      usesSaidFallback: false,
      addsNewAction: true,
      confidence: "medium",
      rationale: buildDialogueActionRationale(input.speaker, input.assessment, "insert", input.language),
    });
  }

  if (input.allowSaidFallback) {
    const saidBlock = formatDialogueWithSaidFallback(quoteLine, speakerLabel);
    choices.push({
      choiceId: `${input.beat.beatId}-said`,
      operation: input.beat.actionText ? "replace" : "insert_after",
      label: "Use a simple speech tag instead",
      proposedText: saidBlock,
      proposedBlock: saidBlock,
      usesSaidFallback: true,
      addsNewAction: false,
      confidence: input.assessment.level === "strong" ? "low" : "high",
      rationale: {
        psychology: [],
        sceneSpace: ["A simple tag keeps speaker clarity without forcing decorative motion."],
        subtext: [],
        relationshipDynamics: [],
        canon: input.speaker ? [`Fallback remains consistent with ${input.speaker.title}'s existing voice.`] : [],
      },
    });
  }

  return choices;
}

function buildDialogueActionRationale(
  speaker: DialogueCharacterProfile | undefined,
  assessment: ReturnType<typeof assessDialogueActionBeat>,
  mode: "purposeful" | "insert",
  language: string,
): DialogueActionBeatReviewChoice["rationale"] {
  const pack = dialogueBeatLanguagePack(language);
  return {
    psychology: assessment.psychology.length > 0
      ? assessment.psychology
      : speaker
        ? [pack.tieBeatToEmotion(speaker.title)]
        : [pack.useBodyOnlyIfMeaningful],
    sceneSpace: assessment.sceneSpace.length > 0
      ? assessment.sceneSpace
      : [mode === "insert" ? pack.addSpaceBeat : pack.replaceDecorationWithBlocking],
    subtext: assessment.subtext.length > 0
      ? assessment.subtext
      : [pack.subtextRule],
    relationshipDynamics: assessment.relationshipDynamics.length > 0
      ? assessment.relationshipDynamics
      : [pack.relationshipRule],
    canon: assessment.canon,
  };
}

function buildPurposefulDialogueAction(
  speaker: DialogueCharacterProfile | undefined,
  beat: ParsedDialogueBeat,
  intensity: RevisionIntensity,
  language: string,
): string {
  const pack = dialogueBeatLanguagePack(language);
  const label = speaker?.title ?? (normalizeBookLanguage(language) === "it" ? "Chi parla" : "The speaker");
  const profileText = [
    ...(speaker?.traits ?? []),
    ...(speaker?.fears ?? []),
    ...(speaker?.desires ?? []),
    speaker?.internalConflict,
    speaker?.externalConflict,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ")
    .toLowerCase();
  const quote = beat.quoteText.toLowerCase();
  const tenseCloser = intensity === "strong" ? pack.strong : intensity === "light" ? pack.light : pack.medium;

  if (/(anxious|anxiety|fear|nerv|timid|ansios|paur|insicur)/i.test(profileText)) {
    return pack.anxiousBeat(label, tenseCloser);
  }
  if (/(control|rigid|pride|proud|domin|authorit|controll|orgogli|autorit)/i.test(profileText)) {
    return pack.controlBeat(label, tenseCloser);
  }
  if (/(secret|guarded|diffiden|evasiv|guard|segre)/i.test(profileText)) {
    return pack.guardBeat(label, tenseCloser);
  }
  if (/(crazy|not today|never|matto|proprio oggi|mai)/i.test(quote)) {
    return pack.retreatBeat(label, tenseCloser);
  }
  if (/(vuoi|per favore|felice|do you want|please|happy)/i.test(quote)) {
    return pack.contactBeat(label, tenseCloser);
  }
  if (/(come stai|come va|benissimo|how are you|how's it going|great)/i.test(quote)) {
    return pack.measureBeat(label, tenseCloser);
  }

  return pack.defaultBeat(label, tenseCloser);
}

function buildDialogueActionTicSuggestions(
  proposals: InternalDialogueActionBeatProposal[],
  characterProfiles: DialogueCharacterProfile[],
  language = "en",
): DialogueActionTicSuggestion[] {
  const grouped = new Map<string, InternalDialogueActionBeatProposal[]>();
  for (const proposal of proposals) {
    if (!proposal.speaker) {
      continue;
    }

    const current = grouped.get(proposal.speaker) ?? [];
    current.push(proposal);
    grouped.set(proposal.speaker, current);
  }

  const suggestions: DialogueActionTicSuggestion[] = [];
  for (const [characterId, items] of grouped.entries()) {
    if (items.length < 2) {
      continue;
    }

    const profile = characterProfiles.find((entry) => entry.id === characterId);
    if (!profile || profile.mannerisms.length > 0) {
      continue;
    }

    const tic = suggestDialogueTic(profile, language);
    if (!tic) {
      continue;
    }

    suggestions.push({
      characterId,
      ticText: tic,
      kind: /sleeve|ring|thumb|manica|anello|pollice/.test(tic.toLowerCase()) ? "stress-response" : "gesture",
      confidence: items.length >= 3 ? "medium" : "low",
      reason: `${profile.title} has repeated dialogue pressure without an established recurring beat in canon.`,
      evidence: items.slice(0, 3).map((item) => item.quoteText),
      recommendation: items.length >= 3 ? "candidate_for_canon" : "observe_only",
    });
  }

  return suggestions;
}

function suggestDialogueTic(profile: DialogueCharacterProfile, language: string): string | null {
  const pack = dialogueBeatLanguagePack(language);
  const profileText = [
    ...profile.traits,
    ...profile.fears,
    profile.internalConflict,
    profile.externalConflict,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ")
    .toLowerCase();

  if (/(ansios|nerv|timid|paur)/i.test(profileText)) {
    return pack.anxiousTic;
  }
  if (/(controll|rigid|orgogli|domin)/i.test(profileText)) {
    return pack.controlTic;
  }
  if (/(guard|segre|diffiden)/i.test(profileText)) {
    return pack.guardTic;
  }

  return pack.defaultTic;
}

function dialogueBeatLanguagePack(language: string) {
  const isItalian = normalizeBookLanguage(language) === "it";
  return isItalian
    ? {
        strong: "secco",
        light: "appena",
        medium: "senza fretta",
        tieBeatToEmotion: (name: string) => `L'azione dovrebbe restare piu vicina alla pressione emotiva che grava su ${name}, invece di usare un gesto generico.`,
        useBodyOnlyIfMeaningful: "Use the body only when it reveals real emotional or relational pressure.",
        addSpaceBeat: "Add a beat that clarifies distance, contact, or occupation of space.",
        replaceDecorationWithBlocking: "Replace decoration with movement that truly changes how the line lands in space.",
        subtextRule: "The beat should add subtext or friction that the line alone does not already explain.",
        relationshipRule: "Let the beat show pressure, retreat, control, or resistance between the characters.",
        anxiousBeat: (label: string, closer: string) => `${label} si lisciò il bordo della manica ${closer}, evitando di fermarsi troppo a lungo sullo sguardo dell'altro.`,
        controlBeat: (label: string, closer: string) => `${label} ridusse la distanza ${closer} e lasciò che fosse il corpo a pretendere ascolto prima ancora delle parole.`,
        guardBeat: (label: string, closer: string) => `${label} spostò il peso di lato ${closer}, come per tenersi una via d'uscita anche mentre parlava.`,
        retreatBeat: (label: string, closer: string) => `${label} arretrò ${closer}, cercando nel muro una distanza che le parole non riuscivano più a dare.`,
        contactBeat: (label: string, closer: string) => `${label} allungò la mano ${closer}, più per forzare la risposta che per cercare davvero contatto.`,
        measureBeat: (label: string, closer: string) => `${label} inclinò il busto ${closer}, misurando la risposta prima ancora di lasciarla arrivare.`,
        defaultBeat: (label: string, closer: string) => `${label} spostò il peso ${closer}, usando la distanza tra i corpi per dare più pressione alla battuta.`,
        anxiousTic: "Si liscia il bordo della manica quando la tensione sale.",
        controlTic: "Raddrizza il polso prima di prendere la parola quando vuole riprendere il controllo.",
        guardTic: "Sposta il peso verso l'uscita più vicina quando la conversazione gli si stringe addosso.",
        defaultTic: "Misura la distanza tra i corpi prima di parlare quando la scena si tende.",
      }
    : {
        strong: "sharply",
        light: "lightly",
        medium: "without haste",
        tieBeatToEmotion: (name: string) => `The beat should stay closer to ${name}'s emotional pressure instead of using generic body business.`,
        useBodyOnlyIfMeaningful: "Use body language only if it reveals actual emotional or relational pressure.",
        addSpaceBeat: "Add a beat that clarifies distance, touch, or occupation of space.",
        replaceDecorationWithBlocking: "Replace decorative motion with blocking that changes how the line lands in space.",
        subtextRule: "The beat should add subtext or friction that the line itself does not already explain.",
        relationshipRule: "Let the beat show pressure, retreat, control, or resistance between the speakers.",
        anxiousBeat: (label: string, closer: string) => `${label} smoothed the edge of a sleeve ${closer}, careful not to hold the other gaze for too long.`,
        controlBeat: (label: string, closer: string) => `${label} shortened the distance ${closer}, letting the body demand attention before the words did.`,
        guardBeat: (label: string, closer: string) => `${label} shifted sideways ${closer}, as if keeping an exit open even while speaking.`,
        retreatBeat: (label: string, closer: string) => `${label} stepped back ${closer}, letting the wall offer the distance the words no longer could.`,
        contactBeat: (label: string, closer: string) => `${label} reached out ${closer}, more to force an answer than to seek real contact.`,
        measureBeat: (label: string, closer: string) => `${label} leaned in ${closer}, measuring the answer before it had fully arrived.`,
        defaultBeat: (label: string, closer: string) => `${label} shifted weight ${closer}, using the distance between bodies to press the line harder.`,
        anxiousTic: "Smooths the edge of a sleeve whenever tension rises.",
        controlTic: "Straightens the wrist before speaking whenever control starts to slip.",
        guardTic: "Shifts weight toward the nearest exit when the conversation starts closing in.",
        defaultTic: "Measures the distance between bodies before speaking when the scene tightens.",
      };
}

function buildDialogueActionEditorialNotes(input: {
  proposals: InternalDialogueActionBeatProposal[];
  intensity: RevisionIntensity;
  chapterStyleSummary: string;
}): string[] {
  const weakCount = input.proposals.filter((proposal) => ["weak", "misaligned", "unclear"].includes(proposal.purposeAssessment)).length;
  const saidCount = input.proposals.filter((proposal) => proposal.choices.some((choice) => choice.usesSaidFallback)).length;
  return [
    `Reviewed ${input.proposals.length} dialogue beats with ${input.intensity} intensity.`,
    weakCount > 0
      ? `${weakCount} beats look decorative, weak, or under-motivated and should be tightened, replaced, or simplified.`
      : "Most beats already carry clear dramatic purpose.",
    saidCount > 0
      ? `${saidCount} beats also have a clean said-tag fallback when no purposeful action is justified.`
      : "No said-tag fallback was needed in the recommended pass.",
    summarizeText(input.chapterStyleSummary.replace(/^## Effective chapter style\n\n/, ""), 220) || "",
  ].filter(Boolean);
}

function stripInternalDialogueActionBeatProposal(proposal: InternalDialogueActionBeatProposal): DialogueActionBeatProposal {
  return {
    beatId: proposal.beatId,
    order: proposal.order,
    speaker: proposal.speaker,
    actedCharacter: proposal.actedCharacter,
    beatKind: proposal.beatKind,
    quoteText: proposal.quoteText,
    currentBeatText: proposal.currentBeatText,
    anchor: proposal.anchor,
    purposeAssessment: proposal.purposeAssessment,
    diagnosis: proposal.diagnosis,
    choices: proposal.choices.map(({ proposedBlock: _proposedBlock, ...choice }) => choice),
    recommendedChoiceId: proposal.recommendedChoiceId,
  };
}

function applyDialogueActionBeatSelectionsToBody(
  body: string,
  proposals: InternalDialogueActionBeatProposal[],
  selections: Array<{ beatId: string; choiceId: string }>,
): string {
  const lines = body.split("\n");
  const selectionsByBeat = new Map(selections.map((selection) => [selection.beatId, selection.choiceId]));

  for (const proposal of [...proposals].sort((left, right) => right.startLineIndex - left.startLineIndex)) {
    const choiceId = selectionsByBeat.get(proposal.beatId);
    if (!choiceId) {
      continue;
    }

    const choice = proposal.choices.find((item) => item.choiceId === choiceId);
    if (!choice || choice.operation === "keep") {
      continue;
    }

    const replacementLines = choice.proposedBlock.split("\n");
    lines.splice(proposal.startLineIndex, proposal.endLineIndex - proposal.startLineIndex + 1, ...replacementLines);
  }

  return lines.join("\n");
}

function createParagraphReviewHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

function createDialogueActionReviewId(filePath: string, paragraphHash: string, signatures: string[]): string {
  return createHash("sha256")
    .update([filePath, paragraphHash, ...signatures].join("|"))
    .digest("hex")
    .slice(0, 20);
}

function buildCurrentDialogueExcerpt(beat: ParsedDialogueBeat): string {
  return beat.actionLineIndex !== null && beat.actionLineIndex < beat.quoteLineIndex
    ? `${beat.actionText ?? ""}\n${beat.quoteText}`.trim()
    : beat.actionLineIndex !== null && beat.actionLineIndex > beat.quoteLineIndex
      ? `${beat.quoteText}\n${beat.actionText ?? ""}`.trim()
      : beat.quoteText;
}

function extractSceneCharacterIds(body: string, characterProfiles: DialogueCharacterProfile[]): string[] {
  const lowered = body.toLowerCase();
  return characterProfiles
    .filter((profile) => profile.aliases.some((alias) => lowered.includes(alias.toLowerCase())))
    .map((profile) => profile.id);
}

function inferCharacterId(
  text: string | undefined,
  characterProfiles: DialogueCharacterProfile[],
  lastSpeakerId: string | undefined,
  sceneCharacters: string[],
): string | undefined {
  if (text) {
    const lower = text.toLowerCase();
    const matching = characterProfiles.find((profile) => profile.aliases.some((alias) => lower.includes(alias.toLowerCase())));
    if (matching) {
      return matching.id;
    }
  }

  return inferAlternatingSpeaker(lastSpeakerId, sceneCharacters);
}

function inferAlternatingSpeaker(lastSpeakerId: string | undefined, sceneCharacters: string[]): string | undefined {
  if (sceneCharacters.length === 2 && lastSpeakerId) {
    return sceneCharacters.find((id) => id !== lastSpeakerId) ?? lastSpeakerId;
  }
  return sceneCharacters.length === 1 ? sceneCharacters[0] : undefined;
}

function findAdjacentActionLine(
  lines: string[],
  quoteLineIndex: number,
  direction: -1 | 1,
  usedActionLines: Set<number>,
): number | null {
  const candidateIndex = quoteLineIndex + direction;
  if (candidateIndex < 0 || candidateIndex >= lines.length) {
    return null;
  }

  const candidate = lines[candidateIndex].trim();
  if (!candidate || candidate.startsWith("#") || isDialogueLine(candidate) || usedActionLines.has(candidateIndex)) {
    return null;
  }

  return candidateIndex;
}

function previousMeaningfulLine(lines: string[], fromIndex: number): string | undefined {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    return line;
  }
  return undefined;
}

function nextMeaningfulLine(lines: string[], fromIndex: number): string | undefined {
  for (let index = fromIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    return line;
  }
  return undefined;
}

function isDialogueLine(line: string): boolean {
  return /[«“"].+[»”"]/u.test(line.trim());
}

function extractDialogueQuote(line: string): string {
  const match = line.match(/[«“"].+[»”"]/u);
  return match?.[0]?.trim() ?? line.trim();
}

function extractEmbeddedDialogueTag(line: string): string | undefined {
  const quote = extractDialogueQuote(line);
  const tag = line.replace(quote, "").trim();
  return tag.length > 0 ? tag : undefined;
}

function formatDialogueWithSaidFallback(quoteText: string, speakerLabel: string): string {
  const trimmed = quoteText.trim();
  return /[?!»”"]$/.test(trimmed)
    ? `${trimmed} disse ${speakerLabel}.`
    : `${trimmed}, disse ${speakerLabel}.`;
}

export async function updateEntity(
  rootPath: string,
  options: {
    kind: EntityType;
    slugOrId: string;
    frontmatterPatch?: Record<string, unknown>;
    body?: string;
    appendBody?: string;
  },
): Promise<{ filePath: string; frontmatter: Record<string, unknown> }> {
  const root = path.resolve(rootPath);
  const filePath = resolveEntityFilePath(root, options.kind, options.slugOrId);

  if (!(await pathExists(filePath))) {
    throw new Error(`Entity does not exist: ${filePath}`);
  }

  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  assertNoForbiddenPatchKeys(options.frontmatterPatch, ["type", "id"]);
  const mergedFrontmatter = {
    ...(parsed.data as Record<string, unknown>),
    ...(options.frontmatterPatch ?? {}),
  };
  const validated = entitySchemaMap[options.kind].parse(mergedFrontmatter);
  const nextBody =
    options.body !== undefined
      ? options.body
      : options.appendBody
        ? appendMarkdownSection(String(parsed.content ?? "").trim(), options.appendBody)
        : String(parsed.content ?? "").trim();

  await writeFile(filePath, renderMarkdown(validated, normalizeStoryMarkdownBody(nextBody)), "utf8");
  await markStoryStateDirty(root, {
    changedPaths: [toPosixPath(path.relative(root, filePath))],
    reason: "chapter-updated",
  });
  return { filePath, frontmatter: validated };
}

export async function updateChapter(
  rootPath: string,
  options: {
    chapter: string;
    frontmatterPatch?: Record<string, unknown>;
    body?: string;
    appendBody?: string;
  },
): Promise<{ filePath: string; frontmatter: ChapterFrontmatter }> {
  const root = path.resolve(rootPath);
  const filePath = resolveChapterMetadataFilePath(root, options.chapter);

  if (!(await pathExists(filePath))) {
    throw new Error(`Chapter does not exist: ${filePath}`);
  }

  assertNoForbiddenPatchKeys(options.frontmatterPatch, ["type", "id", "number", "title"]);

  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const mergedFrontmatter = {
    ...(parsed.data as Record<string, unknown>),
    ...(options.frontmatterPatch ?? {}),
  };
  const validated = chapterSchema.parse(mergedFrontmatter);
  const nextBody =
    options.body !== undefined
      ? options.body
      : options.appendBody
        ? appendMarkdownSection(String(parsed.content ?? "").trim(), options.appendBody)
        : String(parsed.content ?? "").trim();

  await writeFile(filePath, renderMarkdown(validated, normalizeStoryMarkdownBody(nextBody)), "utf8");
  await markStoryStateDirty(root, {
    changedPaths: [toPosixPath(path.relative(root, filePath))],
    reason: "paragraph-updated",
  });
  return { filePath, frontmatter: validated };
}

export async function updateChapterDraft(
  rootPath: string,
  options: {
    chapter: string;
    frontmatterPatch?: Record<string, unknown>;
    body?: string;
    appendBody?: string;
  },
): Promise<{ filePath: string; frontmatter: ChapterDraftFrontmatter }> {
  const root = path.resolve(rootPath);
  const filePath = resolveChapterDraftMetadataFilePath(root, options.chapter);

  if (!(await pathExists(filePath))) {
    throw new Error(`Chapter draft does not exist: ${filePath}`);
  }

  assertNoForbiddenPatchKeys(options.frontmatterPatch, ["type", "id", "chapter", "number", "title"]);

  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const mergedFrontmatter = {
    ...(parsed.data as Record<string, unknown>),
    ...(options.frontmatterPatch ?? {}),
  };
  const validated = chapterDraftSchema.parse(mergedFrontmatter);
  const nextBody =
    options.body !== undefined
      ? options.body
      : options.appendBody
        ? appendMarkdownSection(String(parsed.content ?? "").trim(), options.appendBody)
        : String(parsed.content ?? "").trim();

  await writeFile(filePath, renderMarkdown(validated, normalizeStoryMarkdownBody(nextBody)), "utf8");
  await markStoryStateDirty(root, {
    changedPaths: [toPosixPath(path.relative(root, filePath))],
    reason: "chapter-updated",
  });
  return { filePath, frontmatter: validated };
}

export async function updateParagraph(
  rootPath: string,
  options: {
    chapter: string;
    paragraph: string;
    frontmatterPatch?: Record<string, unknown>;
    body?: string;
    appendBody?: string;
  },
): Promise<{ filePath: string; frontmatter: ParagraphFrontmatter }> {
  const root = path.resolve(rootPath);
  const filePath = await resolveParagraphFilePath(root, options.chapter, options.paragraph);

  if (!(await pathExists(filePath))) {
    throw new Error(`Paragraph does not exist: ${filePath}`);
  }

  assertNoForbiddenPatchKeys(options.frontmatterPatch, ["type", "id", "chapter", "number", "title"]);

  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const mergedFrontmatter = {
    ...(parsed.data as Record<string, unknown>),
    ...(options.frontmatterPatch ?? {}),
  };
  const validated = paragraphSchema.parse(mergedFrontmatter);
  const nextBody =
    options.body !== undefined
      ? options.body
      : options.appendBody
        ? appendMarkdownSection(String(parsed.content ?? "").trim(), options.appendBody)
        : String(parsed.content ?? "").trim();

  await writeFile(filePath, renderMarkdown(validated, normalizeStoryMarkdownBody(nextBody)), "utf8");
  return { filePath, frontmatter: validated };
}

export async function updateParagraphDraft(
  rootPath: string,
  options: {
    chapter: string;
    paragraph: string;
    frontmatterPatch?: Record<string, unknown>;
    body?: string;
    appendBody?: string;
  },
): Promise<{ filePath: string; frontmatter: ParagraphDraftFrontmatter }> {
  const root = path.resolve(rootPath);
  const filePath = await resolveParagraphDraftFilePath(root, options.chapter, options.paragraph);

  if (!(await pathExists(filePath))) {
    throw new Error(`Paragraph draft does not exist: ${filePath}`);
  }

  assertNoForbiddenPatchKeys(options.frontmatterPatch, ["type", "id", "paragraph", "chapter", "number", "title"]);

  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const mergedFrontmatter = {
    ...(parsed.data as Record<string, unknown>),
    ...(options.frontmatterPatch ?? {}),
  };
  const validated = paragraphDraftSchema.parse(mergedFrontmatter);
  const nextBody =
    options.body !== undefined
      ? options.body
      : options.appendBody
        ? appendMarkdownSection(String(parsed.content ?? "").trim(), options.appendBody)
        : String(parsed.content ?? "").trim();

  await writeFile(filePath, renderMarkdown(validated, nextBody), "utf8");
  return { filePath, frontmatter: validated };
}

export async function listRelatedCanon(
  rootPath: string,
  idOrQuery: string,
  options?: { limit?: number },
): Promise<RelatedCanonHit[]> {
  const root = path.resolve(rootPath);
  const query = idOrQuery.toLowerCase();
  const files = await fg(CONTENT_GLOB, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
  });

  const hits: RelatedCanonHit[] = [];

  for (const filePath of files) {
    const raw = await readFile(filePath, "utf8");
    const parsed = matter(raw);
    const frontmatter = parsed.data as Record<string, unknown>;
    const body = String(parsed.content ?? "");
    const refs = Array.isArray(frontmatter.refs) ? frontmatter.refs.filter((value) => typeof value === "string") : [];
    const serializedFrontmatter = JSON.stringify(frontmatter).toLowerCase();
    const reasons: string[] = [];
    let score = 0;

    if (String(frontmatter.id ?? "").toLowerCase() === query) {
      continue;
    }

    if (refs.some((value) => value.toLowerCase() === query)) {
      reasons.push("frontmatter ref");
      score += 80;
    }
    if (serializedFrontmatter.includes(query)) {
      reasons.push("frontmatter mention");
      score += 40;
    }
    if (body.toLowerCase().includes(query)) {
      reasons.push("body mention");
      score += 25;
    }

    if (score === 0) continue;

    hits.push({
      path: toPosixPath(path.relative(root, filePath)),
      title:
        typeof frontmatter.name === "string"
          ? frontmatter.name
          : typeof frontmatter.title === "string"
            ? frontmatter.title
            : toPosixPath(path.relative(root, filePath)),
      type: typeof frontmatter.type === "string" ? frontmatter.type : "unknown",
      reason: uniqueValues(reasons).join(", "),
      score,
    });
  }

  return hits.sort((left, right) => right.score - left.score).slice(0, options?.limit ?? 12);
}

async function buildChapterResumeDocument(
  root: string,
  chapterSlug: string,
): Promise<{ filePath: string; content: string }> {
  const chapterData = await readChapter(root, chapterSlug);
  const filePath = path.join(root, "resumes", "chapters", `${chapterSlug}.md`);
  const summary = chapterData.metadata.summary ?? summarizeText(chapterData.body, 220);
  const existingResume = await readLooseMarkdownIfExists(filePath);
  const stateChanges = normalizeStoryStateChanges(existingResume?.frontmatter.state_changes);

  return {
    filePath,
    content: renderMarkdown(
      compactFrontmatterPatch({
        type: "resume",
        id: `resume:chapter:${chapterSlug}`,
        title: `Resume ${chapterSlug}`,
        chapter: `chapter:${chapterSlug}`,
        ...(stateChanges ? { state_changes: stateChanges } : {}),
      }),
      [
        "# Chapter Summary",
        "",
        summary || "Add a chapter-level summary here.",
        "",
        "# Scene Trail",
        "",
        ...chapterData.paragraphs.flatMap((paragraph) => [
          `## ${formatOrdinal(paragraph.metadata.number)} ${paragraph.metadata.title}`,
          "",
          (paragraph.metadata.summary ?? summarizeText(paragraph.body, 180)) || "Add a scene summary here.",
          "",
        ]),
        "# Canon Hooks",
        "",
        `- POV: ${(chapterData.metadata.pov ?? []).join(", ") || "not set"}`,
        `- Timeline: ${chapterData.metadata.timeline_ref ?? "not set"}`,
        `- Tags: ${(chapterData.metadata.tags ?? []).join(", ") || "none"}`,
        "",
        "# Story State Delta",
        "",
        "Keep continuity deltas in this file's `state_changes` frontmatter.",
        "",
        "- After rewriting chapter or paragraph prose, run `sync_story_state` manually to refresh `state/current.md` and `state/chapters/`.",
        "- Store only the structured delta for this chapter here, not the whole-book state.",
        "- Suggested keys: locations, knowledge_gain, knowledge_loss, inventory_add, inventory_remove, relationship_updates, conditions, wounds, open_loops_add, open_loops_resolved.",
      ].join("\n"),
    ),
  };
}

async function buildTotalResumeDocument(
  root: string,
): Promise<{ filePath: string; content: string; chapterCount: number }> {
  const chapters = await listChapters(root);
  const filePath = path.join(root, TOTAL_RESUME_FILE);
  const chapterSummaries: Array<{ number: number; title: string; summary: string }> = [];
  const storyStateStatus = await readStoryStateStatus(root);
  const currentStoryState = await readLooseMarkdownIfExists(path.join(root, STORY_STATE_CURRENT_FILE));
  const throughChapter =
    typeof currentStoryState?.frontmatter.through_chapter === "string" && currentStoryState.frontmatter.through_chapter.trim()
      ? currentStoryState.frontmatter.through_chapter.trim()
      : undefined;

  for (const chapter of chapters) {
    const chapterData = await readChapter(root, chapter.slug);
    chapterSummaries.push({
      number: chapter.metadata.number,
      title: chapter.metadata.title,
      summary: buildChapterOverviewSummary(chapterData),
    });
  }

  return {
    filePath,
    content: renderMarkdown(
      {
        type: "resume",
        id: "resume:total",
        title: "Total Resume",
      },
      [
        "# Book So Far",
        "",
        ...chapterSummaries.flatMap((chapter) => [
          `## Chapter ${formatOrdinal(chapter.number)} ${chapter.title}`,
          "",
          chapter.summary,
          "",
        ]),
        "# Story State Overview",
        "",
        `- Snapshot: ${STORY_STATE_CURRENT_FILE}`,
        `- Status: ${storyStateStatus.dirty ? "stale - run sync_story_state manually" : "clean"}`,
        `- Through chapter: ${throughChapter ?? (chapters.length > 0 ? "not synced yet" : "no chapters yet")}`,
        `- Pending changed paths: ${storyStateStatus.changedPaths.join(", ") || "none"}`,
      ].join("\n"),
    ),
    chapterCount: chapters.length,
  };
}

async function buildPlotDocument(
  root: string,
): Promise<{ filePath: string; content: string; chapterCount: number }> {
  const book = await readBook(root);
  const chapters = await listChapters(root);
  const secrets = await listEntities(root, "secret");
  const timelineEvents = await listEntities(root, "timeline-event");
  const filePath = path.join(root, PLOT_FILE);

  const chapterSections: string[] = [];
  for (const chapter of chapters) {
    const chapterData = await readChapter(root, chapter.slug);
    const chapterSummary = (chapter.metadata.summary ?? summarizeText(chapterData.body, 320)) || "Add chapter summary here.";
    const sceneLines = chapterData.paragraphs
      .map((paragraph) => paragraph.metadata.summary ?? summarizeText(paragraph.body, 190))
      .filter((value): value is string => Boolean(value && value.trim()))
      .slice(0, 4);
    const revealedSecrets = secrets.filter((secret) => matchesChapterReference(secret.metadata.reveal_in, chapter.slug));
    const datedEvents = collectChapterTimelineEvents(chapter, timelineEvents);

    chapterSections.push(
      [
        `## Chapter ${formatOrdinal(chapter.metadata.number)} ${chapter.metadata.title}`,
        "",
        chapterSummary,
        "",
        "### What Happens",
        "",
        bulletLines(sceneLines.length > 0 ? sceneLines : ["Add paragraph summaries or chapter summary details here."]),
        "",
        "### Secrets Revealed",
        "",
        bulletLines(
          revealedSecrets.length > 0
            ? revealedSecrets.map((secret) => formatPlotSecretLine(secret.metadata))
            : ["No secret reveal is explicitly tied to this chapter yet."],
        ),
        "",
        "### Dates And Timeline",
        "",
        bulletLines(
          datedEvents.length > 0
            ? datedEvents
            : [
                chapter.metadata.timeline_ref
                  ? `Timeline reference: ${chapter.metadata.timeline_ref}`
                  : "No chapter-level timeline anchor is set yet.",
              ],
        ),
        "",
      ].join("\n"),
    );
  }

  const unrevealedSecrets = secrets
    .filter((secret) => !secret.metadata.reveal_in || !matchesAnyChapter(secret.metadata.reveal_in, chapters.map((chapter) => chapter.slug)))
    .map((secret) => formatPlotSecretParkingLine(secret.metadata));

  return {
    filePath,
    content: renderMarkdown(
      plotSchema.parse({
        type: "plot",
        id: "plot:main",
        title: `${book?.frontmatter.title ?? "Book"} Plot`,
      }),
      [
        "# Plot Overview",
        "",
        `- Book: ${book?.frontmatter.title ?? "Untitled book"}`,
        `- Chapters tracked: ${chapters.length}`,
        `- Secrets tracked: ${secrets.length}`,
        `- Timeline events tracked: ${timelineEvents.length}`,
        "",
        "# Chapter Map",
        "",
        ...(chapterSections.length > 0 ? chapterSections : ["No chapters yet. Add chapters and scenes, then sync this file again.", ""]),
        "# Pending Or Unplaced Reveals",
        "",
        bulletLines(
          unrevealedSecrets.length > 0
            ? unrevealedSecrets
            : ["All current secrets are tied to a chapter reveal, or no secrets exist yet."],
        ),
      ].join("\n"),
    ),
    chapterCount: chapters.length,
  };
}

export async function readStoryStateStatus(
  rootPath: string,
): Promise<StoryStateStatus & { filePath: string }> {
  const root = path.resolve(rootPath);
  const filePath = path.join(root, STORY_STATE_STATUS_FILE);
  const document = await readLooseMarkdownIfExists(filePath);
  return {
    filePath,
    ...normalizeStoryStateStatus(document?.frontmatter),
  };
}

async function buildStoryStateTimeline(
  root: string,
): Promise<{ entries: StoryStateTimelineEntry[]; current: StoryStateSnapshot; chapterCount: number }> {
  const chapters = await listChapters(root);
  const entries: StoryStateTimelineEntry[] = [];
  let snapshot = createEmptyStoryStateSnapshot();

  for (const chapter of chapters) {
    const resumePath = path.join(root, "resumes", "chapters", `${chapter.slug}.md`);
    const resume = await readLooseMarkdownIfExists(resumePath);
    const stateChanges = normalizeStoryStateChanges(resume?.frontmatter.state_changes);
    snapshot = applyStoryStateChanges(snapshot, stateChanges);

    entries.push({
      chapterSlug: chapter.slug,
      chapterNumber: chapter.metadata.number,
      chapterTitle: chapter.metadata.title,
      resumePath,
      chapterPath: path.join(root, "chapters", chapter.slug, "chapter.md"),
      snapshot,
      stateChanges,
    });
  }

  return {
    entries,
    current: entries.at(-1)?.snapshot ?? createEmptyStoryStateSnapshot(),
    chapterCount: chapters.length,
  };
}

async function buildStoryStateDocuments(
  root: string,
): Promise<{
  currentFilePath: string;
  currentContent: string;
  chapterFiles: Array<{ filePath: string; content: string }>;
  chapterCount: number;
}> {
  const { entries, current, chapterCount } = await buildStoryStateTimeline(root);
  const chapterFiles: Array<{ filePath: string; content: string }> = [];
  for (const [index, entry] of entries.entries()) {
    const filePath = path.join(root, "state", "chapters", `${entry.chapterSlug}.md`);

    chapterFiles.push({
      filePath,
      content: renderMarkdown(
        compactFrontmatterPatch({
          type: "story-state",
          id: `story-state:chapter:${entry.chapterSlug}`,
          title: `Story State ${entry.chapterSlug}`,
          chapter: `chapter:${entry.chapterSlug}`,
          source_resume: `resume:chapter:${entry.chapterSlug}`,
          through_chapter: `chapter:${entry.chapterSlug}`,
          chapter_count: index + 1,
        }),
        buildStoryStateSnapshotBody(entry.snapshot, {
          heading: `Story State After Chapter ${formatOrdinal(entry.chapterNumber)} ${entry.chapterTitle}`,
          throughChapter: `chapter:${entry.chapterSlug}`,
          chapterCount: index + 1,
          changeLines: renderStoryStateChangeLines(entry.stateChanges),
        }),
      ),
    });
  }

  return {
    currentFilePath: path.join(root, STORY_STATE_CURRENT_FILE),
    currentContent: buildCurrentStoryStateMarkdown(current, {
      throughChapter: entries.at(-1) ? `chapter:${entries.at(-1)?.chapterSlug}` : undefined,
      chapterCount,
    }),
    chapterFiles,
    chapterCount,
  };
}

export async function syncChapterResume(
  rootPath: string,
  chapter: string,
): Promise<{ filePath: string; content: string }> {
  const root = path.resolve(rootPath);
  const chapterSlug = normalizeChapterReference(chapter);
  const { filePath, content } = await buildChapterResumeDocument(root, chapterSlug);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return { filePath, content };
}

export async function syncTotalResume(
  rootPath: string,
): Promise<{ filePath: string; content: string; chapterCount: number }> {
  const root = path.resolve(rootPath);
  const { filePath, content, chapterCount } = await buildTotalResumeDocument(root);
  await writeFile(filePath, content, "utf8");
  return { filePath, content, chapterCount };
}

export async function syncPlot(
  rootPath: string,
): Promise<{ filePath: string; content: string; chapterCount: number }> {
  const root = path.resolve(rootPath);
  const { filePath, content, chapterCount } = await buildPlotDocument(root);
  await writeFile(filePath, content, "utf8");
  return { filePath, content, chapterCount };
}

export async function syncAllResumes(
  rootPath: string,
): Promise<{ chapterFiles: string[]; totalFilePath: string; chapterCount: number }> {
  const root = path.resolve(rootPath);
  const chapters = await listChapters(root);
  const chapterFiles: string[] = [];

  for (const chapter of chapters) {
    const result = await syncChapterResume(root, chapter.slug);
    chapterFiles.push(result.filePath);
  }

  const total = await syncTotalResume(root);
  return {
    chapterFiles,
    totalFilePath: total.filePath,
    chapterCount: chapters.length,
  };
}

export async function syncStoryState(
  rootPath: string,
): Promise<{ statusFilePath: string; currentFilePath: string; chapterFiles: string[]; chapterCount: number }> {
  const root = path.resolve(rootPath);
  const { currentFilePath, currentContent, chapterFiles, chapterCount } = await buildStoryStateDocuments(root);
  const syncedAt = new Date().toISOString();

  for (const entry of chapterFiles) {
    await mkdir(path.dirname(entry.filePath), { recursive: true });
    await writeFile(entry.filePath, entry.content, "utf8");
  }

  await mkdir(path.dirname(currentFilePath), { recursive: true });
  await writeFile(currentFilePath, currentContent, "utf8");

  const existingStatus = await readStoryStateStatus(root);
  const nextStatus: StoryStateStatus = {
    dirty: false,
    lastStoryMutationAt: existingStatus.lastStoryMutationAt,
    lastStoryStateSyncAt: syncedAt,
    changedPaths: [],
  };

  await writeFile(existingStatus.filePath, buildStoryStateStatusMarkdown(nextStatus), "utf8");
  await syncTotalResume(root);

  return {
    statusFilePath: existingStatus.filePath,
    currentFilePath,
    chapterFiles: chapterFiles.map((entry) => entry.filePath),
    chapterCount,
  };
}

export async function syncParagraphEvaluation(
  rootPath: string,
  chapter: string,
  paragraph: string,
): Promise<{ filePath: string; content: string }> {
  const root = path.resolve(rootPath);
  const chapterSlug = normalizeChapterReference(chapter);
  const draft = await buildChapterEvaluationDraft(root, chapterSlug);
  const paragraphInsight = findParagraphInsight(draft.paragraphInsights, paragraph);
  const filePath = path.join(root, "evaluations", "paragraphs", chapterSlug, `${paragraphInsight.slug}.md`);
  const content = renderParagraphEvaluationContent(root, draft, paragraphInsight);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return { filePath, content };
}

export async function prepareParagraphEvaluation(
  rootPath: string,
  chapter: string,
  paragraph: string,
): Promise<PrepareParagraphEvaluationResult> {
  const root = path.resolve(rootPath);
  const chapterSlug = normalizeChapterReference(chapter);
  const draft = await buildChapterEvaluationDraft(root, chapterSlug);
  const paragraphInsight = findParagraphInsight(draft.paragraphInsights, paragraph);
  const paragraphData = draft.chapterData.paragraphs.find(
    (p) => path.basename(p.path, ".md") === paragraphInsight.slug,
  );
  const paragraphText = paragraphData?.body ?? "";
  const analysis = analyzeText(paragraphText);
  const canonContext = await buildEvaluationCanonContext(root);
  const mentions = findCanonMentions(paragraphText, canonContext.entities);
  const guidelinesParts = [
    draft.styleContext.globalWritingStyle?.body,
    draft.styleContext.chapterWritingStyle?.body,
    draft.styleContext.draftWritingStyle?.body,
    ...draft.styleContext.metadataSignals.map((signal) => signal.value),
  ].filter((text): text is string => Boolean(text?.trim()));
  const styleGuidelinesText = guidelinesParts.join("\n\n").trim();
  const inheritedViewpoint = (draft.chapterData.metadata.pov ?? []).join(", ") || "not set";
  const contextParagraphs = draft.chapterData.paragraphs
    .filter((p) => path.basename(p.path, ".md") !== paragraphInsight.slug)
    .map((p) => ({
      slug: path.basename(p.path, ".md"),
      title: p.metadata.title,
      summary: p.metadata.summary ?? "No summary.",
      viewpoint: p.metadata.viewpoint ?? inheritedViewpoint,
    }));
  const instructions = [
    "You are performing a hybrid LLM+heuristic editorial evaluation of the paragraph above.",
    "",
    "TASK: Read the paragraph text and the objective data carefully, then call write_paragraph_evaluation with:",
    "  - editorialStrengths: 1–4 specific editorial strengths you observe (voice, tension, imagery, pacing, subtext, etc.)",
    "  - editorialConcerns: 1–4 specific editorial weaknesses you observe",
    "  - canonStrengths: 0–3 ways the paragraph handles canon mentions well (skip if no canon entities appear)",
    "  - canonConcerns: 0–3 canon coherence issues you notice (wrong characterization, timeline inconsistency, etc.)",
    "  - nextSteps: 1–4 concrete revision actions for this paragraph",
    "  - verdictExplanation: 2–4 sentences explaining why the combined score lands where it does",
    "",
    "Base your editorial reading on the styleFlags and styleGuidelinesText provided.",
    "Do NOT invent canon facts. Only flag canonConcerns if you see a real inconsistency with the listed canonMentions.",
  ].join("\n");

  return {
    rootPath,
    chapterSlug,
    paragraphSlug: paragraphInsight.slug,
    paragraphText,
    wordCount: analysis.wordCount,
    sentenceCount: analysis.sentenceCount,
    avgSentenceWords: analysis.avgSentenceWords,
    dialogueRatio: analysis.dialogueRatio,
    sensoryCueCount: analysis.sensoryCueCount,
    tellingCueCount: analysis.tellingCueCount,
    lexicalDiversity: analysis.lexicalDiversity,
    repeatedWordHotspots: analysis.repeatedWordHotspots,
    firstSentence: analysis.firstSentence,
    lastSentence: analysis.lastSentence,
    scorecard: paragraphInsight.scorecard,
    objectiveScore: paragraphInsight.objectiveScore,
    objectiveStrengths: paragraphInsight.strengths,
    objectiveConcerns: paragraphInsight.concerns,
    styleFlags: {
      showDontTell: draft.styleContext.showDontTell,
      prefersShortSentences: draft.styleContext.prefersShortSentences,
      prefersLyricalImagery: draft.styleContext.prefersLyricalImagery,
      valuesDialogue: draft.styleContext.valuesDialogue,
      valuesPhysicality: draft.styleContext.valuesPhysicality,
      valuesActiveSpace: draft.styleContext.valuesActiveSpace,
      valuesObjectFunction: draft.styleContext.valuesObjectFunction,
      valuesSubtext: draft.styleContext.valuesSubtext,
      valuesControlledProse: draft.styleContext.valuesControlledProse,
    },
    styleGuidelinesText,
    canonMentions: mentions.map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      title: entity.title,
      aliases: entity.aliases,
      coherenceHints: entity.coherenceHints,
    })),
    contextParagraphs,
    instructions,
  };
}

export async function writeParagraphEvaluationFromLlm(
  rootPath: string,
  chapter: string,
  paragraph: string,
  llmInput: WriteParagraphEvaluationFromLlmInput,
): Promise<{ filePath: string; content: string }> {
  const root = path.resolve(rootPath);
  const chapterSlug = normalizeChapterReference(chapter);
  const draft = await buildChapterEvaluationDraft(root, chapterSlug);
  const paragraphInsight = findParagraphInsight(draft.paragraphInsights, paragraph);

  const editorialScore = buildEditorialScore(
    llmInput.editorialStrengths,
    llmInput.editorialConcerns,
    llmInput.canonStrengths,
    llmInput.canonConcerns,
  );
  const weightedScore = buildWeightedEvaluationScore(paragraphInsight.objectiveScore, editorialScore);
  const { verdict: weightedVerdict, focus: recommendedFocus } = buildWeightedVerdict({
    objectiveScore: paragraphInsight.objectiveScore,
    editorialScore,
    concerns: [...paragraphInsight.concerns, ...llmInput.editorialConcerns, ...llmInput.canonConcerns],
    editorialConcerns: [...llmInput.editorialConcerns, ...llmInput.canonConcerns],
  });

  const enrichedInsight: ParagraphEvaluationInsight = {
    ...paragraphInsight,
    editorialStrengths: llmInput.editorialStrengths,
    editorialConcerns: llmInput.editorialConcerns,
    canonStrengths: llmInput.canonStrengths,
    canonConcerns: llmInput.canonConcerns,
    nextSteps: llmInput.nextSteps.length > 0 ? llmInput.nextSteps : paragraphInsight.nextSteps,
    editorialScore,
    weightedScore,
    weightedVerdict,
    recommendedFocus,
  };

  const verdictExplanationLines = llmInput.verdictExplanation
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith("-") ? line : `- ${line}`));

  const filePath = path.join(root, "evaluations", "paragraphs", chapterSlug, `${enrichedInsight.slug}.md`);
  const content = renderParagraphEvaluationContent(root, draft, enrichedInsight, { verdictExplanationLines });

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return { filePath, content };
}

export async function syncChapterEvaluation(
  rootPath: string,
  chapter: string,
): Promise<{ filePath: string; content: string }> {
  const root = path.resolve(rootPath);
  const chapterSlug = normalizeChapterReference(chapter);
  const filePath = path.join(root, "evaluations", "chapters", `${chapterSlug}.md`);
  const draft = await buildChapterEvaluationDraft(root, chapterSlug);
  const content = renderChapterEvaluationContent(root, draft);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");

  for (const paragraphInsight of draft.paragraphInsights) {
    const paragraphFilePath = path.join(
      root,
      "evaluations",
      "paragraphs",
      chapterSlug,
      `${paragraphInsight.slug}.md`,
    );
    const paragraphContent = renderParagraphEvaluationContent(root, draft, paragraphInsight);
    await mkdir(path.dirname(paragraphFilePath), { recursive: true });
    await writeFile(paragraphFilePath, paragraphContent, "utf8");
  }

  return { filePath, content };
}

export async function evaluateBook(
  rootPath: string,
  options?: { syncChapterEvaluations?: boolean },
): Promise<{
  filePath: string;
  chapterCount: number;
  chapterEvaluationFiles: string[];
  paragraphEvaluationFiles: string[];
}> {
  const root = path.resolve(rootPath);
  const chapters = await listChapters(root);
  const syncChapterEvaluations = options?.syncChapterEvaluations ?? true;
  const chapterEvaluationFiles: string[] = [];
  const paragraphEvaluationFiles: string[] = [];
  const chapterBreakdowns: BookEvaluationChapterBreakdown[] = [];

  const aggregatedStyles = new Map<string, string[]>();
  const aggregatedSignals = new Map<string, string[]>();

  for (const chapter of chapters) {
    const draft = await buildChapterEvaluationDraft(root, chapter.slug);
    const readability = getScore(draft.scorecard, "Reader Readability");
    const beauty = getScore(draft.scorecard, "Beauty And Memorability");
    const styleAlignment = getScore(draft.scorecard, "Style Alignment");
    chapterBreakdowns.push({
      slug: chapter.slug,
      title: chapter.metadata.title,
      number: chapter.metadata.number,
      sceneCount: draft.chapterData.paragraphs.length,
      hasSummary: Boolean(chapter.metadata.summary),
      hasPov: (chapter.metadata.pov ?? []).length > 0,
      tagsCount: (chapter.metadata.tags ?? []).length,
      missingParagraphSummaries: draft.missingParagraphSummaries,
      missingParagraphViewpoints: draft.missingParagraphViewpoints,
      readabilityScore: readability,
      beautyScore: beauty,
      styleAlignmentScore: styleAlignment,
      objectiveScore: draft.objectiveScore,
      editorialScore: draft.editorialScore,
      weightedScore: draft.weightedScore,
      weightedVerdict: draft.weightedVerdict,
      recommendedFocus: draft.recommendedFocus,
      revisionUrgency: formatRevisionUrgency(draft.concerns.length + draft.editorialConcerns.length + draft.canonConcerns.length, draft.nextSteps.length),
      strengths: draft.strengths,
      concerns: draft.concerns,
      editorialStrengths: draft.editorialStrengths,
      editorialConcerns: draft.editorialConcerns,
      canonStrengths: draft.canonStrengths,
      canonConcerns: draft.canonConcerns,
      nextSteps: draft.nextSteps,
    });

    collectGuidelineTitles(aggregatedStyles, [
      draft.styleContext.globalWritingStyle,
      draft.styleContext.chapterWritingStyle,
      draft.styleContext.draftWritingStyle,
    ].filter((guideline): guideline is GuidelineDocument => Boolean(guideline)));

    for (const signal of draft.styleContext.metadataSignals) {
      const values = aggregatedSignals.get(signal.key) ?? [];
      values.push(signal.value);
      aggregatedSignals.set(signal.key, uniqueValues(values));
    }

    if (draft.styleContext.showDontTell) {
      const values = aggregatedSignals.get("show_dont_tell") ?? [];
      values.push("required");
      aggregatedSignals.set("show_dont_tell", uniqueValues(values));
    }

    if (syncChapterEvaluations) {
      const result = await syncChapterEvaluation(root, chapter.slug);
      chapterEvaluationFiles.push(result.filePath);
      paragraphEvaluationFiles.push(
        ...draft.paragraphInsights.map((paragraphInsight) =>
          path.join(root, "evaluations", "paragraphs", chapter.slug, `${paragraphInsight.slug}.md`),
        ),
      );
    }
  }

  const totalScenes = chapterBreakdowns.reduce((sum, chapter) => sum + chapter.sceneCount, 0);
  const missingSummary = chapterBreakdowns.filter((chapter) => !chapter.hasSummary);
  const missingPov = chapterBreakdowns.filter((chapter) => !chapter.hasPov);
  const missingParagraphSummaries = chapterBreakdowns.filter((chapter) => chapter.missingParagraphSummaries > 0);
  const missingParagraphViewpoints = chapterBreakdowns.filter((chapter) => chapter.missingParagraphViewpoints > 0);
  const filePath = path.join(root, TOTAL_EVALUATION_FILE);
  const averageReadability = averageScore(chapterBreakdowns.map((chapter) => chapter.readabilityScore));
  const averageBeauty = averageScore(chapterBreakdowns.map((chapter) => chapter.beautyScore));
  const averageStyleAlignment = averageScore(chapterBreakdowns.map((chapter) => chapter.styleAlignmentScore));
  const averageObjective = averageScore(chapterBreakdowns.map((chapter) => chapter.objectiveScore));
  const averageEditorial = averageScore(chapterBreakdowns.map((chapter) => chapter.editorialScore));
  const averageWeighted = averageScore(chapterBreakdowns.map((chapter) => chapter.weightedScore));
  const criticalChapters = chapterBreakdowns.filter((chapter) => chapter.editorialScore <= 6 || chapter.styleAlignmentScore <= 5);
  const overallVerdict = buildWeightedVerdict({
    objectiveScore: averageObjective,
    editorialScore: averageEditorial,
    concerns: criticalChapters.flatMap((chapter) => chapter.nextSteps),
    editorialConcerns: criticalChapters.flatMap((chapter) => [chapter.recommendedFocus]),
  });
  const activeStyleRefs = uniqueValues(
    [...aggregatedStyles.entries()].flatMap(([, titles]) => titles),
  );
  const styleSignals = [...aggregatedSignals.entries()]
    .filter(([, values]) => values.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const verdictConcernSource = criticalChapters.length > 0 ? criticalChapters : chapterBreakdowns;
  const weightedVerdictExplanation = buildWeightedVerdictExplanation({
    objectiveScore: averageObjective,
    editorialScore: averageEditorial,
    weightedScore: averageWeighted,
    weightedVerdict: overallVerdict.verdict,
    recommendedFocus: overallVerdict.focus,
    objectiveStrengths: chapterBreakdowns.flatMap((chapter) =>
      chapter.strengths.map((note) => `Chapter ${formatOrdinal(chapter.number)}: ${note}`),
    ),
    objectiveConcerns: verdictConcernSource.flatMap((chapter) =>
      chapter.concerns.map((note) => `Chapter ${formatOrdinal(chapter.number)}: ${note}`),
    ),
    editorialStrengths: chapterBreakdowns.flatMap((chapter) =>
      chapter.editorialStrengths.map((note) => `Chapter ${formatOrdinal(chapter.number)}: ${note}`),
    ),
    editorialConcerns: verdictConcernSource.flatMap((chapter) =>
      chapter.editorialConcerns.map((note) => `Chapter ${formatOrdinal(chapter.number)}: ${note}`),
    ),
    canonStrengths: chapterBreakdowns.flatMap((chapter) =>
      chapter.canonStrengths.map((note) => `Chapter ${formatOrdinal(chapter.number)}: ${note}`),
    ),
    canonConcerns: verdictConcernSource.flatMap((chapter) =>
      chapter.canonConcerns.map((note) => `Chapter ${formatOrdinal(chapter.number)}: ${note}`),
    ),
    extraContextLines: [
      criticalChapters.length > 0
        ? `Chapters pulling hardest on the verdict: ${criticalChapters.map((chapter) => `Chapter ${formatOrdinal(chapter.number)}`).join(", ")}.`
        : "No chapter is currently pulling the book into the urgent band.",
    ],
  });

  const content = renderMarkdown(
    {
      type: "evaluation",
      id: "evaluation:total",
      title: "Total Evaluation",
    },
    [
      "# Book Evaluation",
      "",
      `- Chapters: ${chapterBreakdowns.length}`,
      `- Scenes: ${totalScenes}`,
      `- Chapters missing summary: ${missingSummary.length}`,
      `- Chapters missing POV: ${missingPov.length}`,
      `- Paragraphs missing summary: ${chapterBreakdowns.reduce((sum, chapter) => sum + chapter.missingParagraphSummaries, 0)}`,
      `- Paragraphs missing viewpoint: ${chapterBreakdowns.reduce((sum, chapter) => sum + chapter.missingParagraphViewpoints, 0)}`,
      `- Average reader readability: ${averageReadability}/10`,
      `- Average beauty and memorability: ${averageBeauty}/10`,
      `- Average style alignment: ${averageStyleAlignment}/10`,
      `- Average objective score: ${averageObjective}/10`,
      `- Average editorial score: ${averageEditorial}/10`,
      `- Average weighted verdict score: ${averageWeighted}/10`,
      `- Overall weighted verdict: ${overallVerdict.verdict}`,
      `- Overall recommended focus: ${overallVerdict.focus}`,
      "",
      "# Global Scorecard",
      "",
      `- Reader readability: ${averageReadability}/10`,
      `- Beauty and memorability: ${averageBeauty}/10`,
      `- Style alignment: ${averageStyleAlignment}/10`,
      `- Objective score: ${averageObjective}/10`,
      `- Editorial score: ${averageEditorial}/10`,
      `- Weighted verdict score: ${averageWeighted}/10`,
      `- Overall weighted verdict: ${overallVerdict.verdict}`,
      `- Overall recommended focus: ${overallVerdict.focus}`,
      criticalChapters.length > 0
        ? `- Chapters needing immediate attention: ${criticalChapters.map((chapter) => formatOrdinal(chapter.number)).join(", ")}`
        : "- No chapter is currently flagged as urgent by the score thresholds.",
      "",
      "# Why the weighted verdict landed here",
      "",
      ...weightedVerdictExplanation,
      "",
      "# Style Context",
      "",
      activeStyleRefs.length > 0
        ? `- Active guideline references: ${activeStyleRefs.join(", ")}`
        : "- Active guideline references: none resolved yet, rely on guidelines/ defaults.",
      ...(styleSignals.length > 0
        ? styleSignals.map(([key, values]) => `- ${humanizeKey(key)}: ${values.join(", ")}`)
        : ["- Style signals from metadata: none detected."]),
      "",
      "# Global Checks",
      "",
      "- Verify chronology across chapters and timeline files.",
      "- Verify major characters keep a consistent voice and motivation.",
      "- Verify secrets are only revealed after their allowed threshold.",
      "- Verify chapter openings and endings follow the style rules in guidelines/.",
      "- Verify chapter and paragraph evaluations stay aligned with each other after revisions.",
      "",
      "# Chapter Breakdown",
      "",
      ...chapterBreakdowns.flatMap((chapter) => [
        `## Chapter ${formatOrdinal(chapter.number)} ${chapter.title}`,
        "",
        `- Scenes: ${chapter.sceneCount}`,
        `- Summary present: ${chapter.hasSummary ? "yes" : "no"}`,
        `- POV present: ${chapter.hasPov ? "yes" : "no"}`,
        `- Tag count: ${chapter.tagsCount}`,
        `- Paragraph summaries missing: ${chapter.missingParagraphSummaries}`,
        `- Paragraph viewpoints missing: ${chapter.missingParagraphViewpoints}`,
        `- Reader readability: ${chapter.readabilityScore}/10`,
        `- Beauty and memorability: ${chapter.beautyScore}/10`,
        `- Style alignment: ${chapter.styleAlignmentScore}/10`,
        `- Objective score: ${chapter.objectiveScore}/10`,
        `- Editorial score: ${chapter.editorialScore}/10`,
        `- Weighted verdict score: ${chapter.weightedScore}/10`,
        `- Weighted verdict: ${chapter.weightedVerdict}`,
        `- Recommended focus: ${chapter.recommendedFocus}`,
        `- Revision urgency: ${chapter.revisionUrgency}`,
        ...chapter.nextSteps.map((step) => `- Next step: ${step}`),
        "",
      ]),
      "# Revision Priorities",
      "",
      missingSummary.length > 0
        ? `- Add summaries for: ${missingSummary.map((chapter) => formatOrdinal(chapter.number)).join(", ")}`
        : "- Chapter summaries exist for all chapters.",
      missingPov.length > 0
        ? `- Add POV metadata for: ${missingPov.map((chapter) => formatOrdinal(chapter.number)).join(", ")}`
        : "- POV metadata exists for all chapters.",
      missingParagraphSummaries.length > 0
        ? `- Add paragraph summaries inside: ${missingParagraphSummaries.map((chapter) => formatOrdinal(chapter.number)).join(", ")}`
        : "- Paragraph summaries exist for all chapters.",
      missingParagraphViewpoints.length > 0
        ? `- Add paragraph viewpoints inside: ${missingParagraphViewpoints.map((chapter) => formatOrdinal(chapter.number)).join(", ")}`
        : "- Paragraph viewpoints exist for all chapters.",
      "- Review continuity against resumes/ and secrets/ after each major revision.",
      "- Re-run chapter and paragraph evaluations after structural edits so next steps stay current.",
    ].join("\n"),
  );

  await writeFile(filePath, content, "utf8");
  return { filePath, chapterCount: chapterBreakdowns.length, chapterEvaluationFiles, paragraphEvaluationFiles };
}

async function buildChapterEvaluationDraft(root: string, chapter: string): Promise<ChapterEvaluationDraft> {
  const chapterSlug = normalizeChapterReference(chapter);
  const chapterData = await readChapter(root, chapterSlug);
  const styleContext = await resolveEvaluationStyleContext(root, chapterData);
  const canonContext = await buildEvaluationCanonContext(root);
  const chapterText = chapterData.paragraphs.map((paragraph) => paragraph.body.trim()).filter(Boolean).join("\n\n");
  const chapterAnalysis = analyzeText(chapterText);
  const inheritedViewpoint = (chapterData.metadata.pov ?? []).join(", ") || "not set";

  const paragraphInsights: ParagraphEvaluationInsight[] = chapterData.paragraphs.map((paragraph) => {
    const paragraphAnalysis = analyzeText(paragraph.body);
    const summaryPresent = Boolean(paragraph.metadata.summary);
    const viewpoint = paragraph.metadata.viewpoint ?? inheritedViewpoint;
    const scorecard = buildParagraphScorecard(chapterData, paragraph, paragraphAnalysis, styleContext);
    const strengths = collectEvaluationNotes(scorecard, "strengths", 4);
    const concerns = collectEvaluationNotes(scorecard, "concerns", 4);
    const editorial = buildParagraphEditorialAssessment(chapterData, paragraph, paragraphAnalysis, styleContext);
    const canon = buildParagraphCanonAssessment(chapterData, paragraph, paragraphAnalysis, canonContext);
    const nextSteps = uniqueValues([
      ...buildParagraphNextSteps(chapterData, paragraph, paragraphAnalysis, styleContext),
      ...editorial.nextSteps,
      ...canon.nextSteps,
    ]);
    const objectiveScore = averageScore(scorecard.map((entry) => entry.score));
    const editorialScore = buildEditorialScore(editorial.strengths, editorial.concerns, canon.strengths, canon.concerns);
    const weightedScore = buildWeightedEvaluationScore(objectiveScore, editorialScore);
    const { verdict: weightedVerdict, focus: recommendedFocus } = buildWeightedVerdict({
      objectiveScore,
      editorialScore,
      concerns: [...concerns, ...editorial.concerns, ...canon.concerns],
      editorialConcerns: [...editorial.concerns, ...canon.concerns],
    });

    return {
      slug: path.basename(paragraph.path, ".md"),
      title: paragraph.metadata.title,
      summary:
        paragraph.metadata.summary ??
        summarizeText(stripMarkdown(paragraph.body), 180) ??
        "Add scene evaluation notes here.",
      summaryPresent,
      viewpoint,
      filePath: toPosixPath(path.relative(root, paragraph.path)),
      wordCount: paragraphAnalysis.wordCount,
      estimatedReadingMinutes: paragraphAnalysis.estimatedReadingMinutes,
      dialogueRatio: paragraphAnalysis.dialogueRatio,
      sensoryCueCount: paragraphAnalysis.sensoryCueCount,
      tellingCueCount: paragraphAnalysis.tellingCueCount,
      repeatedWordHotspots: paragraphAnalysis.repeatedWordHotspots,
      firstSentence: paragraphAnalysis.firstSentence,
      lastSentence: paragraphAnalysis.lastSentence,
      scorecard,
      strengths,
      concerns,
      editorialStrengths: editorial.strengths,
      editorialConcerns: editorial.concerns,
      canonStrengths: canon.strengths,
      canonConcerns: canon.concerns,
      objectiveScore,
      editorialScore,
      weightedScore,
      weightedVerdict,
      recommendedFocus,
      nextSteps,
    };
  });

  const scorecard = buildChapterScorecard(chapterData, chapterAnalysis, paragraphInsights, styleContext);
  const strengths = collectEvaluationNotes(scorecard, "strengths", 5);
  const concerns = collectEvaluationNotes(scorecard, "concerns", 5);
  const editorial = buildChapterEditorialAssessment(chapterData, chapterAnalysis, paragraphInsights, styleContext);
  const canon = buildChapterCanonAssessment(chapterData, chapterAnalysis, paragraphInsights, canonContext);
  const nextSteps = uniqueValues([
    ...buildChapterNextSteps(chapterData, chapterAnalysis, paragraphInsights, styleContext),
    ...editorial.nextSteps,
    ...canon.nextSteps,
  ]);
  const objectiveScore = averageScore(scorecard.map((entry) => entry.score));
  const editorialScore = buildEditorialScore(editorial.strengths, editorial.concerns, canon.strengths, canon.concerns);
  const weightedScore = buildWeightedEvaluationScore(objectiveScore, editorialScore);
  const { verdict: weightedVerdict, focus: recommendedFocus } = buildWeightedVerdict({
    objectiveScore,
    editorialScore,
    concerns: [...concerns, ...editorial.concerns, ...canon.concerns],
    editorialConcerns: [...editorial.concerns, ...canon.concerns],
  });

  return {
    chapterSlug,
    chapterData,
    styleContext,
    chapterAnalysis,
    paragraphInsights,
    scorecard,
    strengths,
    concerns,
    editorialStrengths: editorial.strengths,
    editorialConcerns: editorial.concerns,
    canonStrengths: canon.strengths,
    canonConcerns: canon.concerns,
    objectiveScore,
    editorialScore,
    weightedScore,
    weightedVerdict,
    recommendedFocus,
    nextSteps,
    missingParagraphSummaries: paragraphInsights.filter((paragraph) => !paragraph.summaryPresent).length,
    missingParagraphViewpoints: paragraphInsights.filter((paragraph) => paragraph.viewpoint === "not set").length,
  };
}

async function resolveEvaluationStyleContext(
  root: string,
  chapterData: ChapterReadResult,
): Promise<EvaluationStyleContext> {
  const { global, chapter, draft } = await readWritingStyleDocuments(
    root,
    chapterData.metadata.id.replace(/^chapter:/, ""),
    true,
    true,
  );
  const metadataEntries = [chapterData.metadata, ...chapterData.paragraphs.map((paragraph) => paragraph.metadata)];
  const metadataSignals = uniqueSignalEntries(
    metadataEntries.flatMap((metadata) => extractStyleSignals(metadata as Record<string, unknown>)),
  );
  const expectationText = [
    global?.body,
    chapter?.body,
    draft?.body,
    ...metadataSignals.map((signal) => signal.value),
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n")
    .toLowerCase();

  return {
    globalWritingStyle: global,
    chapterWritingStyle: chapter,
    draftWritingStyle: draft,
    metadataSignals,
    expectationText,
    showDontTell: containsShowDontTellText(expectationText),
    prefersShortSentences: containsAnyExpectation(expectationText, ["short sentence", "short sentences", "tight", "lean", "minimal", "frasi brevi"]),
    prefersLyricalImagery: containsAnyExpectation(expectationText, ["lyrical", "poetic", "lush", "liric"]),
    valuesDialogue: containsAnyExpectation(expectationText, ["dialogue", "dialogo", "speech tag", "action beat"]),
    valuesPhysicality: containsAnyExpectation(expectationText, ["physical", "physicality", "fisic", "body language", "azione fisica"]),
    valuesActiveSpace: containsAnyExpectation(expectationText, ["space", "distance", "spazio", "blocking", "occupation of space"]),
    valuesObjectFunction: containsAnyExpectation(expectationText, ["object", "objects", "oggetti", "props"]),
    valuesSubtext: containsAnyExpectation(expectationText, ["subtext", "sottotesto", "unspoken"]),
    valuesControlledProse: containsAnyExpectation(expectationText, ["controlled", "controllato", "not overwritten", "non iper-descrittivo", "precise", "preciso"]),
  };
}

async function listGuidelines(root: string): Promise<GuidelineDocument[]> {
  const files = await fg("guidelines/**/*.md", {
    cwd: root,
    absolute: true,
    onlyFiles: true,
  });

  const results: GuidelineDocument[] = [];
  for (const filePath of files) {
    const document = await readMarkdownFile(filePath, guidelineSchema);
    results.push({
      ...document,
      slug: path.basename(filePath, ".md"),
    });
  }

  return results.sort((left, right) => left.slug.localeCompare(right.slug));
}

function renderChapterEvaluationContent(root: string, draft: ChapterEvaluationDraft): string {
  const chapterSlug = draft.chapterSlug;
  const paragraphFiles = draft.paragraphInsights.map((paragraph) =>
    `evaluations/paragraphs/${chapterSlug}/${paragraph.slug}.md`,
  );
  const weightedVerdictExplanation = buildWeightedVerdictExplanation({
    objectiveScore: draft.objectiveScore,
    editorialScore: draft.editorialScore,
    weightedScore: draft.weightedScore,
    weightedVerdict: draft.weightedVerdict,
    recommendedFocus: draft.recommendedFocus,
    objectiveStrengths: draft.strengths,
    objectiveConcerns: draft.concerns,
    editorialStrengths: draft.editorialStrengths,
    editorialConcerns: draft.editorialConcerns,
    canonStrengths: draft.canonStrengths,
    canonConcerns: draft.canonConcerns,
  });

  return renderMarkdown(
    {
      type: "evaluation",
      id: `evaluation:chapter:${chapterSlug}`,
      title: `Evaluation ${chapterSlug}`,
      chapter: `chapter:${chapterSlug}`,
      paragraph_count: draft.chapterData.paragraphs.length,
      word_count: draft.chapterAnalysis.wordCount,
      readability: getScore(draft.scorecard, "Reader Readability"),
      beauty: getScore(draft.scorecard, "Beauty And Memorability"),
      style_alignment: getScore(draft.scorecard, "Style Alignment"),
      objective_score: draft.objectiveScore,
      editorial_score: draft.editorialScore,
      weighted_score: draft.weightedScore,
      weighted_verdict: draft.weightedVerdict,
      recommended_focus: draft.recommendedFocus,
    },
    [
      "# Evaluation Snapshot",
      "",
      `- Source used: all ${draft.chapterData.paragraphs.length} paragraph files were read together in chapter order.`,
      `- Paragraph evaluation files: ${paragraphFiles.join(", ") || "none"}`,
      `- Total words: ${draft.chapterAnalysis.wordCount}`,
      `- Estimated reading time: ${draft.chapterAnalysis.estimatedReadingMinutes} min`,
      `- POV: ${(draft.chapterData.metadata.pov ?? []).join(", ") || "not set"}`,
      `- Timeline: ${draft.chapterData.metadata.timeline_ref ?? "not set"}`,
      `- Chapter summary present: ${draft.chapterData.metadata.summary ? "yes" : "no"}`,
      `- Paragraph summaries missing: ${draft.missingParagraphSummaries}`,
      `- Paragraph viewpoints missing: ${draft.missingParagraphViewpoints}`,
      `- Objective score: ${draft.objectiveScore}/10`,
      `- Editorial score: ${draft.editorialScore}/10`,
      `- Weighted verdict: ${draft.weightedScore}/10 (${draft.weightedVerdict})`,
      `- Recommended focus: ${draft.recommendedFocus}`,
      "",
      "# Scorecard",
      "",
      ...renderScorecardLines(draft.scorecard),
      "",
      "# Style Context",
      "",
      ...renderStyleContextLines(root, draft.styleContext),
      "",
      "# Editorial Reading",
      "",
      ...renderBulletSection(draft.editorialStrengths, "No clear editorial strength was detected beyond the objective scorecard yet."),
      "",
      ...renderBulletSection(draft.editorialConcerns, "No major editorial concern was detected beyond the heuristic checks."),
      "",
      "# Canon Coherence",
      "",
      ...renderBulletSection(draft.canonStrengths, "No canon coherence strength was detected yet."),
      "",
      ...renderBulletSection(draft.canonConcerns, "No canon coherence concern was detected yet."),
      "",
      "# Why the weighted verdict landed here",
      "",
      ...weightedVerdictExplanation,
      "",
      "# What Works",
      "",
      ...renderBulletSection(draft.strengths, "No strong chapter-level advantages were detected yet."),
      "",
      "# Revision Concerns",
      "",
      ...renderBulletSection(draft.concerns, "No major chapter-level concerns were detected by the heuristic checks."),
      "",
      "# Next Steps",
      "",
      ...renderBulletSection(draft.nextSteps, "No immediate next step was generated."),
      "",
      "# Paragraph Breakdown",
      "",
      ...draft.paragraphInsights.flatMap((paragraph) => [
        `## ${paragraph.slug} ${paragraph.title}`,
        "",
        `- File: ${paragraph.filePath}`,
        `- Evaluation file: evaluations/paragraphs/${chapterSlug}/${paragraph.slug}.md`,
        `- Summary: ${paragraph.summary}`,
        `- Viewpoint: ${paragraph.viewpoint}`,
        `- Reader readability: ${getScore(paragraph.scorecard, "Reader Readability")}/10`,
        `- Beauty and memorability: ${getScore(paragraph.scorecard, "Beauty And Memorability")}/10`,
        `- Style alignment: ${getScore(paragraph.scorecard, "Style Alignment")}/10`,
        `- Objective score: ${paragraph.objectiveScore}/10`,
        `- Editorial score: ${paragraph.editorialScore}/10`,
        `- What works: ${paragraph.strengths.join("; ") || "No specific strength detected yet."}`,
        `- What to revise: ${paragraph.concerns.join("; ") || "No specific concern detected yet."}`,
        `- Canon coherence strengths: ${paragraph.canonStrengths.join("; ") || "No canon coherence strength detected yet."}`,
        `- Canon coherence concerns: ${paragraph.canonConcerns.join("; ") || "No canon coherence concern detected yet."}`,
        `- Next step: ${paragraph.nextSteps.join("; ") || "No next step generated."}`,
        "",
      ]),
      "# Continuity Checks",
      "",
      "- Verify timeline references align with prior canon.",
      "- Verify secrets are not revealed too early.",
      "- Verify character voice matches guidelines and prior scenes.",
      "- Verify paragraph evaluations still match the chapter after each revision pass.",
      "",
      "# Text Anchors",
      "",
      `- Opening line: ${draft.chapterAnalysis.firstSentence || "not available"}`,
      `- Closing line: ${draft.chapterAnalysis.lastSentence || "not available"}`,
    ].join("\n"),
  );
}

function renderParagraphEvaluationContent(
  root: string,
  draft: ChapterEvaluationDraft,
  paragraph: ParagraphEvaluationInsight,
  options?: { verdictExplanationLines?: string[] },
): string {
  const weightedVerdictExplanation = options?.verdictExplanationLines ?? buildWeightedVerdictExplanation({
    objectiveScore: paragraph.objectiveScore,
    editorialScore: paragraph.editorialScore,
    weightedScore: paragraph.weightedScore,
    weightedVerdict: paragraph.weightedVerdict,
    recommendedFocus: paragraph.recommendedFocus,
    objectiveStrengths: paragraph.strengths,
    objectiveConcerns: paragraph.concerns,
    editorialStrengths: paragraph.editorialStrengths,
    editorialConcerns: paragraph.editorialConcerns,
    canonStrengths: paragraph.canonStrengths,
    canonConcerns: paragraph.canonConcerns,
  });

  return renderMarkdown(
    {
      type: "evaluation",
      id: `evaluation:paragraph:${draft.chapterSlug}:${paragraph.slug}`,
      title: `Evaluation ${draft.chapterSlug} ${paragraph.slug}`,
      chapter: `chapter:${draft.chapterSlug}`,
      paragraph: `paragraph:${draft.chapterSlug}:${paragraph.slug}`,
      word_count: paragraph.wordCount,
      readability: getScore(paragraph.scorecard, "Reader Readability"),
      beauty: getScore(paragraph.scorecard, "Beauty And Memorability"),
      style_alignment: getScore(paragraph.scorecard, "Style Alignment"),
      objective_score: paragraph.objectiveScore,
      editorial_score: paragraph.editorialScore,
      weighted_score: paragraph.weightedScore,
      weighted_verdict: paragraph.weightedVerdict,
      recommended_focus: paragraph.recommendedFocus,
    },
    [
      "# Paragraph Evaluation",
      "",
      `- Source used: ${paragraph.filePath}, evaluated with the rest of chapter ${draft.chapterSlug} as context.`,
      `- Summary present: ${paragraph.summaryPresent ? "yes" : "no"}`,
      `- Viewpoint: ${paragraph.viewpoint}`,
      `- Word count: ${paragraph.wordCount}`,
      `- Estimated reading time: ${paragraph.estimatedReadingMinutes} min`,
      `- Dialogue ratio: ${paragraph.dialogueRatio}`,
      `- Sensory cues: ${paragraph.sensoryCueCount}`,
      `- Telling cues: ${paragraph.tellingCueCount}`,
      `- Objective score: ${paragraph.objectiveScore}/10`,
      `- Editorial score: ${paragraph.editorialScore}/10`,
      `- Weighted verdict: ${paragraph.weightedScore}/10 (${paragraph.weightedVerdict})`,
      `- Recommended focus: ${paragraph.recommendedFocus}`,
      "",
      "# Scorecard",
      "",
      ...renderScorecardLines(paragraph.scorecard),
      "",
      "# Style Context",
      "",
      ...renderStyleContextLines(root, draft.styleContext),
      "",
      "# Editorial Reading",
      "",
      ...renderBulletSection(paragraph.editorialStrengths, "No clear editorial strength was detected beyond the scorecard yet."),
      "",
      ...renderBulletSection(paragraph.editorialConcerns, "No major editorial concern was detected beyond the heuristic checks."),
      "",
      "# Canon Coherence",
      "",
      ...renderBulletSection(paragraph.canonStrengths, "No canon coherence strength was detected yet."),
      "",
      ...renderBulletSection(paragraph.canonConcerns, "No canon coherence concern was detected yet."),
      "",
      "# Why the weighted verdict landed here",
      "",
      ...weightedVerdictExplanation,
      "",
      "# What Works",
      "",
      ...renderBulletSection(paragraph.strengths, "No clear paragraph-level strength was detected yet."),
      "",
      "# Revision Concerns",
      "",
      ...renderBulletSection(paragraph.concerns, "No specific paragraph-level concern was detected by the heuristic checks."),
      "",
      "# Next Steps",
      "",
      ...renderBulletSection(paragraph.nextSteps, "No immediate paragraph-level next step was generated."),
      "",
      "# Chapter Fit",
      "",
      `- Chapter readability: ${getScore(draft.scorecard, "Reader Readability")}/10`,
      `- Chapter beauty and memorability: ${getScore(draft.scorecard, "Beauty And Memorability")}/10`,
      `- Chapter style alignment: ${getScore(draft.scorecard, "Style Alignment")}/10`,
      `- Paragraph summary: ${paragraph.summary}`,
      "",
      "# Text Anchors",
      "",
      `- Opening line: ${paragraph.firstSentence || "not available"}`,
      `- Closing line: ${paragraph.lastSentence || "not available"}`,
      paragraph.repeatedWordHotspots.length > 0
        ? `- Repeated word hotspots: ${paragraph.repeatedWordHotspots.join(", ")}`
        : "- Repeated word hotspots: none detected.",
    ].join("\n"),
  );
}

function buildChapterScorecard(
  chapterData: ChapterReadResult,
  chapterAnalysis: TextAnalysis,
  paragraphInsights: ParagraphEvaluationInsight[],
  styleContext: EvaluationStyleContext,
): ScorecardEntry[] {
  const paragraphReadability = averageScore(
    paragraphInsights.map((paragraph) => getScore(paragraph.scorecard, "Reader Readability")),
  );
  const paragraphBeauty = averageScore(
    paragraphInsights.map((paragraph) => getScore(paragraph.scorecard, "Beauty And Memorability")),
  );
  const paragraphStyle = averageScore(
    paragraphInsights.map((paragraph) => getScore(paragraph.scorecard, "Style Alignment")),
  );
  const missingViewpoints = paragraphInsights.filter((paragraph) => paragraph.viewpoint === "not set").length;
  const missingSummaries = paragraphInsights.filter((paragraph) => !paragraph.summaryPresent).length;
  const expectationText = buildStyleExpectationText(styleContext);

  const readabilityStrengths: string[] = [];
  const readabilityConcerns: string[] = [];
  let readability = paragraphReadability || 5;
  if (chapterAnalysis.avgSentenceWords >= 8 && chapterAnalysis.avgSentenceWords <= 22) {
    readability += 1;
    readabilityStrengths.push(`Average sentence length stays readable at ${chapterAnalysis.avgSentenceWords} words.`);
  } else if (chapterAnalysis.avgSentenceWords > 28) {
    readability -= 2;
    readabilityConcerns.push(`Average sentence length is heavy at ${chapterAnalysis.avgSentenceWords} words.`);
  }
  if (chapterAnalysis.repeatedWordHotspots.length > 2) {
    readability -= 1;
    readabilityConcerns.push(`Repeated terms may flatten the prose: ${chapterAnalysis.repeatedWordHotspots.join(", ")}.`);
  } else {
    readabilityStrengths.push("Diction stays varied enough to keep the prose moving.");
  }

  const beautyStrengths: string[] = [];
  const beautyConcerns: string[] = [];
  let beauty = paragraphBeauty || 5;
  if (chapterAnalysis.sensoryCueCount >= Math.max(2, Math.round(chapterAnalysis.wordCount / 140))) {
    beauty += 1;
    beautyStrengths.push("The chapter keeps concrete sensory detail on the page.");
  } else {
    beauty -= 1;
    beautyConcerns.push("The chapter could use more concrete sensory detail to leave a stronger impression.");
  }
  if (chapterAnalysis.firstSentence && chapterAnalysis.lastSentence && chapterAnalysis.firstSentence !== chapterAnalysis.lastSentence) {
    beauty += 1;
    beautyStrengths.push("The chapter has distinct opening and closing anchors.");
  }
  if (styleContext.showDontTell && chapterAnalysis.tellingCueCount > chapterAnalysis.sensoryCueCount) {
    beauty -= 1;
    beautyConcerns.push("Explicit explanation currently outweighs dramatized detail in several places.");
  }

  const structureStrengths: string[] = [];
  const structureConcerns: string[] = [];
  let structure = 6;
  if (chapterData.paragraphs.length > 0) {
    structure += 1;
    structureStrengths.push(`The chapter is broken into ${chapterData.paragraphs.length} scene units.`);
  } else {
    structure -= 3;
    structureConcerns.push("The chapter has no paragraph files to evaluate yet.");
  }
  if (chapterData.metadata.summary) {
    structure += 1;
    structureStrengths.push("The chapter summary clarifies the intended dramatic movement.");
  } else {
    structure -= 1;
    structureConcerns.push("The chapter summary is missing, so the intended movement is harder to verify quickly.");
  }
  if (missingSummaries > 0) {
    structure -= 1;
    structureConcerns.push(`${missingSummaries} paragraph evaluations lack summary metadata.`);
  }
  if (chapterAnalysis.avgParagraphWords > 220) {
    structure -= 1;
    structureConcerns.push(`Average scene length is dense at ${chapterAnalysis.avgParagraphWords} words.`);
  }

  const voiceStrengths: string[] = [];
  const voiceConcerns: string[] = [];
  let voice = 6;
  if ((chapterData.metadata.pov ?? []).length > 0) {
    voice += 1;
    voiceStrengths.push(`Chapter POV is explicit: ${(chapterData.metadata.pov ?? []).join(", ")}.`);
  } else {
    voice -= 1;
    voiceConcerns.push("Chapter POV metadata is missing.");
  }
  if (missingViewpoints === 0) {
    voice += 1;
    voiceStrengths.push("Every paragraph can be checked against an explicit viewpoint.");
  } else {
    voice -= 1;
    voiceConcerns.push(`${missingViewpoints} paragraphs do not expose a clear viewpoint.`);
  }
  if (expectationText.includes("voice") || expectationText.includes("narration")) {
    voice += 1;
    voiceStrengths.push("Voice-related guidance is present in the active guidelines.");
  }

  const styleStrengths: string[] = [];
  const styleConcerns: string[] = [];
  let styleAlignment = paragraphStyle || 5;
  if (styleContext.globalWritingStyle || styleContext.chapterWritingStyle || styleContext.draftWritingStyle) {
    styleAlignment += 1;
    styleStrengths.push("The evaluation has explicit writing-style material to check against.");
  }
  if (styleContext.showDontTell) {
    if (chapterAnalysis.sensoryCueCount >= chapterAnalysis.tellingCueCount) {
      styleAlignment += 1;
      styleStrengths.push("Show, don't tell is mostly supported by the current balance of concrete detail and exposition.");
    } else {
      styleAlignment -= 2;
      styleConcerns.push("Show, don't tell is active, but telling cues outnumber concrete sensory anchors.");
    }
  }
  styleAlignment += computeStyleExpectationAdjustment(chapterAnalysis, expectationText);

  const continuityStrengths: string[] = [];
  const continuityConcerns: string[] = [];
  let continuity = 6;
  if (chapterData.metadata.timeline_ref) {
    continuity += 1;
    continuityStrengths.push(`Timeline metadata is set to ${chapterData.metadata.timeline_ref}.`);
  }
  if (chapterData.metadata.summary) {
    continuity += 1;
    continuityStrengths.push("The chapter summary helps anchor intent against the rest of the book.");
  }
  if (chapterData.paragraphs.length > 0) {
    continuity += 1;
    continuityStrengths.push("The chapter has scene-level material that can be cross-checked against canon.");
  }
  if (!chapterData.metadata.timeline_ref) {
    continuityConcerns.push("Timeline metadata is not set, so chronology must be checked manually.");
  }
  if (missingViewpoints > 0 || missingSummaries > 0) {
    continuity -= 1;
    continuityConcerns.push("Missing scene metadata weakens future continuity checks.");
  }

  return [
    buildScorecardEntry("Reader Readability", readability, readabilityStrengths, readabilityConcerns),
    buildScorecardEntry("Beauty And Memorability", beauty, beautyStrengths, beautyConcerns),
    buildScorecardEntry("Structure And Pacing", structure, structureStrengths, structureConcerns),
    buildScorecardEntry("Viewpoint And Voice", voice, voiceStrengths, voiceConcerns),
    buildScorecardEntry("Style Alignment", styleAlignment, styleStrengths, styleConcerns),
    buildScorecardEntry("Continuity And Coherence", continuity, continuityStrengths, continuityConcerns),
  ];
}

function buildParagraphScorecard(
  chapterData: ChapterReadResult,
  paragraph: ChapterParagraph,
  analysis: TextAnalysis,
  styleContext: EvaluationStyleContext,
): ScorecardEntry[] {
  const expectationText = buildStyleExpectationText(styleContext);
  const summaryPresent = Boolean(paragraph.metadata.summary);
  const viewpointPresent = Boolean(paragraph.metadata.viewpoint || (chapterData.metadata.pov ?? []).length > 0);

  const readabilityStrengths: string[] = [];
  const readabilityConcerns: string[] = [];
  let readability = 6;
  if (analysis.avgSentenceWords >= 8 && analysis.avgSentenceWords <= 22) {
    readability += 2;
    readabilityStrengths.push(`Sentence length stays accessible at ${analysis.avgSentenceWords} words on average.`);
  } else if (analysis.avgSentenceWords > 28) {
    readability -= 2;
    readabilityConcerns.push(`Sentence length is heavy at ${analysis.avgSentenceWords} words on average.`);
  }
  if (analysis.lexicalDiversity >= 0.38) {
    readability += 1;
    readabilityStrengths.push("The wording is varied enough to avoid monotony.");
  }
  if (analysis.repeatedWordHotspots.length > 2) {
    readability -= 1;
    readabilityConcerns.push(`Repeated terms may blur the beat: ${analysis.repeatedWordHotspots.join(", ")}.`);
  }
  if (analysis.wordCount < 45) {
    readability -= 1;
    readabilityConcerns.push("The paragraph may be too brief to fully land its dramatic beat.");
  }

  const beautyStrengths: string[] = [];
  const beautyConcerns: string[] = [];
  let beauty = 6;
  if (analysis.sensoryCueCount >= Math.max(1, Math.round(analysis.wordCount / 120))) {
    beauty += 2;
    beautyStrengths.push("Concrete sensory detail gives the scene texture.");
  } else if (analysis.wordCount > 60) {
    beauty -= 1;
    beautyConcerns.push("The scene could use a more concrete image or sensation.");
  }
  if (analysis.firstSentence && analysis.lastSentence && analysis.firstSentence !== analysis.lastSentence) {
    beauty += 1;
    beautyStrengths.push("The scene opens and closes on distinct beats.");
  }
  if (styleContext.showDontTell && analysis.tellingCueCount > analysis.sensoryCueCount) {
    beauty -= 1;
    beautyConcerns.push("Explanation outweighs dramatized detail in this scene.");
  }

  const clarityStrengths: string[] = [];
  const clarityConcerns: string[] = [];
  let clarity = 6;
  if (analysis.wordCount >= 60) {
    clarity += 1;
    clarityStrengths.push("The scene has enough room to establish a clear beat.");
  }
  if (summaryPresent) {
    clarity += 1;
    clarityStrengths.push("The scene summary clarifies its role in revision passes.");
  } else {
    clarity -= 1;
    clarityConcerns.push("Summary metadata is missing for this scene.");
  }
  if (analysis.avgSentenceWords > 28) {
    clarity -= 1;
    clarityConcerns.push("Long sentences may soften the scene's clarity.");
  }

  const styleStrengths: string[] = [];
  const styleConcerns: string[] = [];
  let styleAlignment = 6;
  if (styleContext.globalWritingStyle || styleContext.chapterWritingStyle || styleContext.draftWritingStyle) {
    styleAlignment += 1;
    styleStrengths.push("The scene can be checked against explicit writing-style guidance.");
  }
  if (styleContext.showDontTell) {
    if (analysis.sensoryCueCount >= analysis.tellingCueCount) {
      styleAlignment += 1;
      styleStrengths.push("Show, don't tell is mostly respected in this scene.");
    } else {
      styleAlignment -= 2;
      styleConcerns.push("Show, don't tell is active, but the scene still explains too much directly.");
    }
  }
  styleAlignment += computeStyleExpectationAdjustment(analysis, expectationText);

  const fitStrengths: string[] = [];
  const fitConcerns: string[] = [];
  let chapterFit = 6;
  if (viewpointPresent) {
    chapterFit += 1;
    fitStrengths.push("Viewpoint is explicit here or inherited from the chapter.");
  } else {
    chapterFit -= 2;
    fitConcerns.push("Viewpoint is not explicit, which makes chapter-level voice checks harder.");
  }
  if (summaryPresent) {
    chapterFit += 1;
  }
  if ((chapterData.metadata.pov ?? []).length > 0 && paragraph.metadata.viewpoint) {
    const chapterPov = new Set(chapterData.metadata.pov ?? []);
    if (!chapterPov.has(paragraph.metadata.viewpoint)) {
      chapterFit -= 1;
      fitConcerns.push("The paragraph viewpoint differs from the chapter POV metadata; verify that the shift is intentional.");
    }
  }

  return [
    buildScorecardEntry("Reader Readability", readability, readabilityStrengths, readabilityConcerns),
    buildScorecardEntry("Beauty And Memorability", beauty, beautyStrengths, beautyConcerns),
    buildScorecardEntry("Scene Clarity", clarity, clarityStrengths, clarityConcerns),
    buildScorecardEntry("Style Alignment", styleAlignment, styleStrengths, styleConcerns),
    buildScorecardEntry("Chapter Fit", chapterFit, fitStrengths, fitConcerns),
  ];
}

function buildParagraphEditorialAssessment(
  chapterData: ChapterReadResult,
  paragraph: ChapterParagraph,
  analysis: TextAnalysis,
  styleContext: EvaluationStyleContext,
): { strengths: string[]; concerns: string[]; nextSteps: string[] } {
  const strengths: string[] = [];
  const concerns: string[] = [];
  const nextSteps: string[] = [];
  const movementCueCount = countPatternMatches(analysis.plainText, MOVEMENT_PATTERNS);
  const objectCueCount = countPatternMatches(analysis.plainText, OBJECT_PATTERNS);

  if (styleContext.valuesControlledProse) {
    if (analysis.avgSentenceWords <= 22) {
      strengths.push("Sentence control stays close to the book's controlled writing-style contract.");
    } else {
      concerns.push("The paragraph drifts away from the book's controlled prose contract with sentences that run too long.");
      nextSteps.push(`Tighten sentence control in ${path.basename(paragraph.path, ".md")} so the prose feels more disciplined.`);
    }
  }

  if (styleContext.valuesPhysicality) {
    if (movementCueCount > 0) {
      strengths.push("The paragraph uses physical movement instead of leaving tension entirely abstract.");
    } else {
      concerns.push("The writing style asks for purposeful physicality, but this paragraph stays mostly static.");
      nextSteps.push(`Add one purposeful physical beat to ${path.basename(paragraph.path, ".md")} that reveals tension or pressure.`);
    }
  }

  if (styleContext.valuesActiveSpace) {
    if (movementCueCount >= 2) {
      strengths.push("Blocking and distance cues help the scene use space actively.");
    } else {
      concerns.push("The writing style expects active space, but the scene does not yet make distance or blocking carry enough meaning.");
      nextSteps.push(`Clarify how bodies move or resist space inside ${path.basename(paragraph.path, ".md")}.`);
    }
  }

  if (styleContext.valuesObjectFunction) {
    if (objectCueCount > 0) {
      strengths.push("Objects or surfaces participate in the paragraph instead of staying decorative.");
    } else {
      concerns.push("The writing style values functional objects, but this paragraph does not yet make props or surfaces do narrative work.");
      nextSteps.push(`Let at least one object or surface in ${path.basename(paragraph.path, ".md")} carry pressure, status, or subtext.`);
    }
  }

  if (styleContext.valuesSubtext) {
    if (analysis.dialogueRatio > 0 && analysis.tellingCueCount <= analysis.sensoryCueCount + 1) {
      strengths.push("Dialogue and visible detail leave room for subtext instead of over-explaining it.");
    } else {
      concerns.push("The paragraph explains too much directly for a style that asks subtext to carry more weight.");
      nextSteps.push(`Reduce explicit explanation in ${path.basename(paragraph.path, ".md")} so action, silence, or contradiction can carry subtext.`);
    }
  }

  if (styleContext.valuesDialogue && analysis.dialogueRatio < 0.08) {
    concerns.push("The current style emphasizes dialogue pressure, but the paragraph has relatively little spoken friction on the page.");
  }

  return {
    strengths: uniqueValues(strengths).slice(0, 4),
    concerns: uniqueValues(concerns).slice(0, 4),
    nextSteps: uniqueValues(nextSteps).slice(0, 4),
  };
}

function buildChapterEditorialAssessment(
  chapterData: ChapterReadResult,
  chapterAnalysis: TextAnalysis,
  paragraphInsights: ParagraphEvaluationInsight[],
  styleContext: EvaluationStyleContext,
): { strengths: string[]; concerns: string[]; nextSteps: string[] } {
  const strengths: string[] = [];
  const concerns: string[] = [];
  const nextSteps: string[] = [];
  const movementCueCount = countPatternMatches(chapterAnalysis.plainText, MOVEMENT_PATTERNS);
  const objectCueCount = countPatternMatches(chapterAnalysis.plainText, OBJECT_PATTERNS);

  if (styleContext.valuesControlledProse) {
    if (chapterAnalysis.avgSentenceWords <= 22) {
      strengths.push("Chapter-level sentence control fits the book's controlled prose contract.");
    } else {
      concerns.push("Chapter-level prose runs looser than the active writing-style contract expects.");
      nextSteps.push(`Tighten long chapter sentences in ${chapterData.metadata.id} so the prose stays controlled.`);
    }
  }

  if (styleContext.valuesPhysicality && movementCueCount >= Math.max(2, chapterData.paragraphs.length)) {
    strengths.push("The chapter gives physical beats enough presence to keep tension embodied.");
  } else if (styleContext.valuesPhysicality) {
    concerns.push("The chapter-level writing style asks for purposeful physicality, but the chapter still feels under-blocked or under-bodied in places.");
    nextSteps.push(`Review the weakest scenes in ${chapterData.metadata.id} for missing physical pressure and blocking.`);
  }

  if (styleContext.valuesObjectFunction && objectCueCount > 0) {
    strengths.push("Objects or surfaces contribute meaningfully across the chapter.");
  } else if (styleContext.valuesObjectFunction) {
    concerns.push("The chapter does not yet make enough use of objects or surfaces as narrative pressure.");
  }

  if (styleContext.valuesSubtext) {
    const weakSubtextScenes = paragraphInsights.filter((paragraph) => paragraph.editorialConcerns.some((note) => note.includes("subtext")));
    if (weakSubtextScenes.length === 0) {
      strengths.push("Subtext survives at scene level without being over-explained too often.");
    } else {
      concerns.push(`Subtext is being over-explained in ${weakSubtextScenes.map((paragraph) => paragraph.slug).join(", ")}.`);
      nextSteps.push(`Let behavior and contradiction carry more subtext in ${weakSubtextScenes.map((paragraph) => paragraph.slug).join(", ")}.`);
    }
  }

  return {
    strengths: uniqueValues(strengths).slice(0, 5),
    concerns: uniqueValues(concerns).slice(0, 5),
    nextSteps: uniqueValues(nextSteps).slice(0, 5),
  };
}

async function buildEvaluationCanonContext(root: string): Promise<EvaluationCanonContext> {
  const entityKinds: EntityType[] = ["character", "location", "faction", "item", "timeline-event"];
  const entities = (
    await Promise.all(entityKinds.map((kind) => listEntities(root, kind)))
  ).flatMap((entries, index) => entries.map((entry) => buildEvaluationCanonEntity(entry, entityKinds[index])));

  return {
    entities,
    byId: new Map(entities.map((entity) => [entity.id.toLowerCase(), entity])),
  };
}

function buildEvaluationCanonEntity(entry: CanonEntityDocument, kind: EntityType): EvaluationCanonEntity {
  const metadata = entry.metadata as Record<string, unknown>;
  const title =
    typeof metadata.name === "string"
      ? metadata.name
      : typeof metadata.title === "string"
        ? metadata.title
        : entry.slug;
  const aliases = uniqueValues(
    [
      title,
      ...(Array.isArray(metadata.aliases) ? metadata.aliases.filter((value): value is string => typeof value === "string") : []),
      ...(Array.isArray(metadata.former_names) ? metadata.former_names.filter((value): value is string => typeof value === "string") : []),
      typeof metadata.current_identity === "string" ? metadata.current_identity : undefined,
    ].filter((value): value is string => Boolean(value && value.trim())),
  );
  const coherenceHints = [
    typeof metadata.speaking_style === "string" ? metadata.speaking_style : undefined,
    typeof metadata.background_summary === "string" ? metadata.background_summary : undefined,
    typeof metadata.function_in_book === "string" ? metadata.function_in_book : undefined,
    typeof metadata.atmosphere === "string" ? metadata.atmosphere : undefined,
    typeof metadata.mission === "string" ? metadata.mission : undefined,
    typeof metadata.ideology === "string" ? metadata.ideology : undefined,
    typeof metadata.purpose === "string" ? metadata.purpose : undefined,
    typeof metadata.significance === "string" ? metadata.significance : undefined,
    typeof metadata.significance === "string" ? metadata.significance : undefined,
  ].filter((value): value is string => Boolean(value && value.trim()));

  return {
    kind,
    id: String(metadata.id ?? `${kind}:${entry.slug}`),
    title,
    path: entry.path,
    aliases,
    coherenceHints,
  };
}

function buildParagraphCanonAssessment(
  chapterData: ChapterReadResult,
  paragraph: ChapterParagraph,
  analysis: TextAnalysis,
  canonContext: EvaluationCanonContext,
): { strengths: string[]; concerns: string[]; nextSteps: string[] } {
  const strengths: string[] = [];
  const concerns: string[] = [];
  const nextSteps: string[] = [];
  const body = analysis.plainText;
  const mentions = findCanonMentions(body, canonContext.entities);
  const viewpointId = paragraph.metadata.viewpoint || (chapterData.metadata.pov ?? [])[0];

  if (viewpointId) {
    const viewpoint = canonContext.byId.get(viewpointId.toLowerCase());
    if (viewpoint) {
      strengths.push(`Viewpoint character ${viewpoint.title} is present in canon and can be checked against the scene.`);
    } else {
      concerns.push(`Viewpoint reference ${viewpointId} does not resolve against canon.`);
    }
  }

  const locationMentions = mentions.filter((mention) => mention.kind === "location");
  const factionMentions = mentions.filter((mention) => mention.kind === "faction");
  const itemMentions = mentions.filter((mention) => mention.kind === "item");
  const timelineRef = chapterData.metadata.timeline_ref;

  if (timelineRef) {
    if (canonContext.byId.has(timelineRef.toLowerCase())) {
      strengths.push(`Timeline reference ${timelineRef} anchors chronology to canon.`);
    } else {
      concerns.push(`Timeline reference ${timelineRef} is missing from canon.`);
    }
  } else {
    concerns.push("Timeline metadata is missing, so chronology still depends on manual checking.");
  }

  if (locationMentions.length > 0) {
    strengths.push(`The paragraph references canonical location material: ${locationMentions.map((mention) => mention.title).join(", ")}.`);
    if (analysis.sensoryCueCount === 0) {
      concerns.push("A canonical location is present, but the paragraph gives it little sensory embodiment.");
      nextSteps.push(`Let the location pressure show on the page instead of naming it only in ${path.basename(paragraph.path, ".md")}.`);
    }
  }

  if (factionMentions.length > 0) {
    strengths.push(`Faction pressure can be checked against canon: ${factionMentions.map((mention) => mention.title).join(", ")}.`);
  }

  if (itemMentions.length > 0) {
    strengths.push(`The paragraph uses canonical item material: ${itemMentions.map((mention) => mention.title).join(", ")}.`);
    if (countPatternMatches(body, OBJECT_PATTERNS) === 0) {
      concerns.push("A canonical item is present, but the paragraph does not make the object function concrete on the page.");
    }
  }

  if (mentions.length === 0 && analysis.wordCount > 80) {
    concerns.push("The paragraph currently has few visible canon anchors, so its place inside the broader book may feel under-connected.");
  }

  return {
    strengths: uniqueValues(strengths).slice(0, 4),
    concerns: uniqueValues(concerns).slice(0, 4),
    nextSteps: uniqueValues(nextSteps).slice(0, 4),
  };
}

function buildChapterCanonAssessment(
  chapterData: ChapterReadResult,
  chapterAnalysis: TextAnalysis,
  paragraphInsights: ParagraphEvaluationInsight[],
  canonContext: EvaluationCanonContext,
): { strengths: string[]; concerns: string[]; nextSteps: string[] } {
  const strengths: string[] = [];
  const concerns: string[] = [];
  const nextSteps: string[] = [];
  const mentions = findCanonMentions(chapterAnalysis.plainText, canonContext.entities);
  const kinds = new Set(mentions.map((mention) => mention.kind));

  if ((chapterData.metadata.pov ?? []).length > 0) {
    const resolvedPov = (chapterData.metadata.pov ?? []).filter((id) => canonContext.byId.has(id.toLowerCase()));
    if (resolvedPov.length === (chapterData.metadata.pov ?? []).length) {
      strengths.push("All chapter POV references resolve cleanly against character canon.");
    } else {
      concerns.push("At least one chapter POV reference does not resolve cleanly against character canon.");
    }
  }

  if (chapterData.metadata.timeline_ref) {
    if (canonContext.byId.has(chapterData.metadata.timeline_ref.toLowerCase())) {
      strengths.push(`Chapter chronology is anchored by ${chapterData.metadata.timeline_ref}.`);
    } else {
      concerns.push(`Timeline reference ${chapterData.metadata.timeline_ref} does not resolve in canon.`);
    }
  } else {
    concerns.push("The chapter has no timeline_ref, so chronology coherence is weaker than it could be.");
  }

  if (kinds.size >= 3) {
    strengths.push("The chapter touches multiple canon layers, which helps the scene work feel grounded in the broader book.");
  }

  if (mentions.some((mention) => mention.kind === "location") && chapterAnalysis.sensoryCueCount === 0) {
    concerns.push("Locations are named in canon, but the chapter does not yet give them enough sensory embodiment.");
    nextSteps.push("Strengthen the chapter's location coherence by turning named places into felt spaces on the page.");
  }

  if (paragraphInsights.some((paragraph) => paragraph.canonConcerns.length > 0)) {
    const weakCanonScenes = paragraphInsights.filter((paragraph) => paragraph.canonConcerns.length > 0).map((paragraph) => paragraph.slug);
    concerns.push(`Canon coherence needs attention in ${weakCanonScenes.join(", ")}.`);
    nextSteps.push(`Review canon consistency first in ${weakCanonScenes.join(", ")}.`);
  }

  return {
    strengths: uniqueValues(strengths).slice(0, 5),
    concerns: uniqueValues(concerns).slice(0, 5),
    nextSteps: uniqueValues(nextSteps).slice(0, 5),
  };
}

function findCanonMentions(text: string, entities: EvaluationCanonEntity[]): EvaluationCanonEntity[] {
  const lower = text.toLowerCase();
  return entities.filter((entity) => entity.aliases.some((alias) => lower.includes(alias.toLowerCase())));
}

function buildEditorialScore(
  editorialStrengths: string[],
  editorialConcerns: string[],
  canonStrengths: string[],
  canonConcerns: string[],
): number {
  const score = 6 + editorialStrengths.length + canonStrengths.length - editorialConcerns.length - canonConcerns.length;
  return clampScore(score);
}

function buildWeightedEvaluationScore(objectiveScore: number, editorialScore: number): number {
  return roundToTenths(objectiveScore * 0.4 + editorialScore * 0.6);
}

function buildWeightedVerdict(input: {
  objectiveScore: number;
  editorialScore: number;
  concerns: string[];
  editorialConcerns: string[];
}): { verdict: string; focus: string } {
  const weighted = buildWeightedEvaluationScore(input.objectiveScore, input.editorialScore);
  const focus =
    input.editorialConcerns.some((entry) => /canon|timeline|location|character|faction|item/i.test(entry))
      ? "canon coherence"
      : input.editorialConcerns.length > 0
        ? "editorial alignment"
        : input.concerns.length > 0
          ? "objective cleanup"
          : "maintain current direction";

  if (weighted >= 8.5 && input.editorialConcerns.length === 0) {
    return { verdict: "strong", focus };
  }
  if (weighted >= 7) {
    return { verdict: "solid but refine", focus };
  }
  if (weighted >= 5.5) {
    return { verdict: "needs targeted revision", focus };
  }

  return { verdict: "priority revision", focus };
}

function buildWeightedVerdictExplanation(input: WeightedVerdictExplanationInput): string[] {
  const objectiveStrengths = input.objectiveStrengths ?? [];
  const objectiveConcerns = input.objectiveConcerns ?? [];
  const editorialStrengths = input.editorialStrengths ?? [];
  const editorialConcerns = input.editorialConcerns ?? [];
  const canonStrengths = input.canonStrengths ?? [];
  const canonConcerns = input.canonConcerns ?? [];
  const delta = roundToTenths(Math.abs(input.editorialScore - input.objectiveScore));
  const strongestPositive = uniqueValues([...editorialStrengths, ...canonStrengths, ...objectiveStrengths])[0];
  const strongestConcern = uniqueValues(
    input.recommendedFocus === "canon coherence"
      ? [...canonConcerns, ...editorialConcerns, ...objectiveConcerns]
      : [...editorialConcerns, ...canonConcerns, ...objectiveConcerns],
  )[0];
  const lines = [
    `- Weighted blend: ${input.weightedScore}/10, built from objective ${input.objectiveScore}/10 and editorial ${input.editorialScore}/10 with editorial carrying 60% of the result.`,
  ];

  if (delta >= 0.3) {
    lines.push(
      input.editorialScore > input.objectiveScore
        ? `- Editorial reading lifts the final score by ${delta} because editorial judgment counts more than the objective pass.`
        : `- Editorial reading lowers the final score by ${delta} because editorial judgment counts more than the objective pass.`,
    );
  } else {
    lines.push("- Objective and editorial readings stay close together, so the verdict mostly confirms the same direction from both passes.");
  }

  lines.push(
    strongestPositive
      ? `- Strongest signal in favor: ${strongestPositive}`
      : "- Strongest signal in favor: no single strength outweighed the combined score.",
  );
  lines.push(
    strongestConcern
      ? `- Strongest drag on the verdict: ${strongestConcern}`
      : "- Strongest drag on the verdict: nothing substantial is pulling against the current direction.",
  );

  if (input.extraContextLines?.length) {
    lines.push(...input.extraContextLines.map((line) => `- ${line}`));
  }

  lines.push(
    canonConcerns.length > 0
      ? `- That mix lands on ${input.weightedVerdict} with the focus on ${input.recommendedFocus}, and canon coherence is part of why the editorial side carries more weight here.`
      : `- That mix lands on ${input.weightedVerdict} with the focus on ${input.recommendedFocus}.`,
  );

  return lines;
}

function buildParagraphNextSteps(
  chapterData: ChapterReadResult,
  paragraph: ChapterParagraph,
  analysis: TextAnalysis,
  styleContext: EvaluationStyleContext,
): string[] {
  const steps: string[] = [];
  const paragraphSlug = path.basename(paragraph.path, ".md");

  if (!paragraph.metadata.summary) {
    steps.push(`Add a summary for ${paragraphSlug} so chapter evaluation stays precise.`);
  }
  if (!paragraph.metadata.viewpoint && (chapterData.metadata.pov ?? []).length === 0) {
    steps.push(`Set an explicit viewpoint for ${paragraphSlug} to anchor voice checks.`);
  }
  if (styleContext.showDontTell && analysis.tellingCueCount > analysis.sensoryCueCount) {
    steps.push(`Replace direct explanation in ${paragraphSlug} with observable action, dialogue, or sensory detail.`);
  }
  if (analysis.avgSentenceWords > 28) {
    steps.push(`Split or tighten the longest sentences in ${paragraphSlug}; the current average is ${analysis.avgSentenceWords} words.`);
  }
  if (analysis.repeatedWordHotspots.length > 2) {
    steps.push(`Vary repeated wording in ${paragraphSlug}, especially ${analysis.repeatedWordHotspots.join(", ")}.`);
  }
  if (analysis.sensoryCueCount === 0 && analysis.wordCount > 70) {
    steps.push(`Add one or two concrete sensory anchors to ${paragraphSlug} so the beat feels lived rather than summarized.`);
  }
  if (analysis.wordCount < 45) {
    steps.push(`Check whether ${paragraphSlug} needs one more concrete beat before the scene closes.`);
  }

  return uniqueValues(steps).slice(0, 4);
}

function buildChapterNextSteps(
  chapterData: ChapterReadResult,
  chapterAnalysis: TextAnalysis,
  paragraphInsights: ParagraphEvaluationInsight[],
  styleContext: EvaluationStyleContext,
): string[] {
  const steps: string[] = [];
  const missingSummarySlugs = paragraphInsights.filter((paragraph) => !paragraph.summaryPresent).map((paragraph) => paragraph.slug);
  const missingViewpointSlugs = paragraphInsights
    .filter((paragraph) => paragraph.viewpoint === "not set")
    .map((paragraph) => paragraph.slug);
  const weakReadability = pickWeakParagraphs(paragraphInsights, "Reader Readability");
  const weakStyle = pickWeakParagraphs(paragraphInsights, "Style Alignment");

  if (!chapterData.metadata.summary) {
    steps.push(`Add a chapter summary for ${chapterData.metadata.id} so the evaluation has a declared target.`);
  }
  if ((chapterData.metadata.pov ?? []).length === 0) {
    steps.push(`Set chapter POV metadata for ${chapterData.metadata.id} so voice checks stay explicit.`);
  }
  if (missingSummarySlugs.length > 0) {
    steps.push(`Add paragraph summaries for ${missingSummarySlugs.join(", ")}.`);
  }
  if (missingViewpointSlugs.length > 0) {
    steps.push(`Add paragraph viewpoints for ${missingViewpointSlugs.join(", ")}.`);
  }
  if (styleContext.showDontTell && chapterAnalysis.tellingCueCount > chapterAnalysis.sensoryCueCount) {
    steps.push("Rework the most explanatory passages so the chapter shows more through action, image, and dialogue.");
  }
  if (chapterAnalysis.avgSentenceWords > 24) {
    steps.push(`Tighten long sentences across the chapter; the current average is ${chapterAnalysis.avgSentenceWords} words.`);
  }
  if (weakReadability.length > 0) {
    steps.push(`Prioritize readability revisions in ${weakReadability.join(", ")}.`);
  }
  if (weakStyle.length > 0) {
    steps.push(`Check style alignment first in ${weakStyle.join(", ")}.`);
  }
  if (!chapterAnalysis.lastSentence) {
    steps.push("Strengthen the chapter ending so the final beat leaves a clear turn or consequence.");
  }

  return uniqueValues(steps).slice(0, 6);
}

function analyzeText(text: string): TextAnalysis {
  const plainText = stripMarkdown(text);
  const paragraphs = plainText.split(/\n\s*\n/g).map((entry) => entry.trim()).filter(Boolean);
  const sentences = plainText
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const words = extractWords(plainText);
  const wordCount = words.length;
  const sentenceCount = sentences.length;
  const paragraphCount = paragraphs.length;
  const quotedSegments = plainText.match(/["“”](.*?)["“”]/g) ?? [];
  const dialogueWords = extractWords(quotedSegments.join(" ")).length;
  const uniqueWordCount = new Set(words.map((word) => word.toLowerCase())).size;

  return {
    plainText,
    wordCount,
    sentenceCount,
    paragraphCount,
    estimatedReadingMinutes: Math.max(1, Math.ceil(wordCount / 180)),
    avgSentenceWords: sentenceCount > 0 ? roundToTenths(wordCount / sentenceCount) : 0,
    avgParagraphWords: paragraphCount > 0 ? roundToTenths(wordCount / paragraphCount) : 0,
    dialogueRatio: wordCount > 0 ? roundToTenths(dialogueWords / wordCount) : 0,
    sensoryCueCount: countPatternMatches(plainText, SENSORY_PATTERNS),
    tellingCueCount: countPatternMatches(plainText, TELLING_PATTERNS),
    lexicalDiversity: wordCount > 0 ? roundToTenths(uniqueWordCount / wordCount) : 0,
    repeatedWordHotspots: detectRepeatedWords(words),
    firstSentence: sentences[0] ?? summarizeText(plainText, 120),
    lastSentence: sentences[sentences.length - 1] ?? summarizeText(plainText, 120),
  };
}

function normalizeStoryMarkdownBody(body: string): string {
  return body.replace(STORY_MARKDOWN_LINK_PATTERN, (match, label: string, target: string) =>
    resolveCanonEntityLinkTarget(target) ? label : match,
  );
}

function resolveCanonEntityLinkTarget(target: string): string | null {
  const normalizedTarget = target.trim().replace(/^<|>$/g, "");
  if (!normalizedTarget) {
    return null;
  }

  if (CANON_ENTITY_LINK_REFERENCE_PATTERN.test(normalizedTarget)) {
    return normalizedTarget.toLowerCase();
  }

  const strippedOrigin = normalizedTarget
    .replace(/^[a-z]+:\/\/[^/]+/i, "")
    .split(/[?#]/, 1)[0]
    .replace(/\\/g, "/");
  const segments = strippedOrigin
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== "." && segment !== "..");

  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index]?.toLowerCase();
    if (!current) {
      continue;
    }

    if (current === "timelines" && segments[index + 1]?.toLowerCase() === "events") {
      const slug = normalizeCanonEntityLinkSlug(segments[index + 2]);
      if (slug) {
        return `timeline-event:${slug}`;
      }
      continue;
    }

    const kind = normalizeCanonEntityLinkKind(current);
    if (!kind) {
      continue;
    }

    const slug = normalizeCanonEntityLinkSlug(segments[index + 1]);
    if (slug) {
      return `${kind}:${slug}`;
    }
  }

  return null;
}

function normalizeCanonEntityLinkKind(segment: string): string | null {
  switch (segment.toLowerCase()) {
    case "character":
    case "characters":
      return "character";
    case "location":
    case "locations":
      return "location";
    case "faction":
    case "factions":
      return "faction";
    case "item":
    case "items":
      return "item";
    case "secret":
    case "secrets":
      return "secret";
    case "timeline":
    case "timeline-event":
      return "timeline-event";
    default:
      return null;
  }
}

function normalizeCanonEntityLinkSlug(segment: string | undefined): string | null {
  if (!segment) {
    return null;
  }

  const normalized = segment.replace(/\.md$/i, "").trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(normalized) ? normalized : null;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[\*_~]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function extractWords(text: string): string[] {
  return text.match(/[\p{L}\p{N}']+/gu) ?? [];
}

function countPatternMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((total, pattern) => total + (text.match(pattern)?.length ?? 0), 0);
}

function detectRepeatedWords(words: string[]): string[] {
  const counts = new Map<string, number>();
  for (const rawWord of words) {
    const word = rawWord.toLowerCase();
    if (word.length < 4 || COMMON_STOP_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([word, count]) => `${word} x${count}`);
}

function buildScorecardEntry(
  label: string,
  score: number,
  strengths: string[],
  concerns: string[],
): ScorecardEntry {
  return {
    label,
    score: clampScore(score),
    strengths: uniqueValues(strengths).slice(0, 3),
    concerns: uniqueValues(concerns).slice(0, 3),
  };
}

function collectEvaluationNotes(
  scorecard: ScorecardEntry[],
  key: "strengths" | "concerns",
  limit: number,
): string[] {
  const entries = scorecard
    .filter((entry) => (key === "strengths" ? entry.score >= 7 : entry.score <= 6))
    .flatMap((entry) => entry[key]);
  return uniqueValues(entries).slice(0, limit);
}

function buildStyleExpectationText(styleContext: EvaluationStyleContext): string {
  return [
    styleContext.globalWritingStyle?.body,
    styleContext.chapterWritingStyle?.body,
    styleContext.draftWritingStyle?.body,
    ...styleContext.metadataSignals.map((signal) => signal.value),
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n")
    .toLowerCase();
}

function containsAnyExpectation(expectationText: string, fragments: string[]): boolean {
  return fragments.some((fragment) => expectationText.includes(fragment.toLowerCase()));
}

function computeStyleExpectationAdjustment(analysis: TextAnalysis, expectationText: string): number {
  let adjustment = 0;

  if (
    expectationText.includes("short sentence") ||
    expectationText.includes("short sentences") ||
    expectationText.includes("frasi brevi") ||
    expectationText.includes("tight") ||
    expectationText.includes("lean") ||
    expectationText.includes("minimal")
  ) {
    adjustment += analysis.avgSentenceWords <= 18 ? 1 : -1;
  }

  if (
    expectationText.includes("lyrical") ||
    expectationText.includes("poetic") ||
    expectationText.includes("lush") ||
    expectationText.includes("liric")
  ) {
    adjustment += analysis.sensoryCueCount >= Math.max(1, Math.round(analysis.wordCount / 140)) ? 1 : -1;
  }

  if (expectationText.includes("dialogue") || expectationText.includes("dialogo")) {
    adjustment += analysis.dialogueRatio >= 0.12 ? 1 : -1;
  }

  return adjustment;
}

function renderScorecardLines(scorecard: ScorecardEntry[]): string[] {
  return scorecard.flatMap((entry) => [
    `- ${entry.label}: ${entry.score}/10`,
    ...(entry.strengths.length > 0 ? [`- ${entry.label} strengths: ${entry.strengths.join("; ")}`] : []),
    ...(entry.concerns.length > 0 ? [`- ${entry.label} concerns: ${entry.concerns.join("; ")}`] : []),
  ]);
}

function renderBulletSection(values: string[], fallback: string): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : [`- ${fallback}`];
}

function renderStyleContextLines(root: string, styleContext: EvaluationStyleContext): string[] {
  const lines: string[] = [];

  lines.push(
    styleContext.globalWritingStyle
      ? `- Global writing style: ${styleContext.globalWritingStyle.frontmatter.id} (${toPosixPath(path.relative(root, styleContext.globalWritingStyle.path))})`
      : "- Global writing style: none found.",
  );

  lines.push(
    styleContext.chapterWritingStyle
      ? `- Chapter writing style: ${styleContext.chapterWritingStyle.frontmatter.id} (${toPosixPath(path.relative(root, styleContext.chapterWritingStyle.path))})`
      : "- Chapter writing style: none.",
  );

  lines.push(
    styleContext.draftWritingStyle
      ? `- Draft writing style: ${styleContext.draftWritingStyle.frontmatter.id} (${toPosixPath(path.relative(root, styleContext.draftWritingStyle.path))})`
      : "- Draft writing style: none.",
  );

  if (styleContext.metadataSignals.length > 0) {
    lines.push(
      `- Metadata style signals: ${styleContext.metadataSignals
        .map((signal) => `${humanizeKey(signal.key)}=${signal.value}`)
        .join(", ")}`,
    );
  } else {
    lines.push("- Metadata style signals: none detected.");
  }

  lines.push(
    styleContext.showDontTell
      ? "- Show, don't tell check: active. The evaluation compares sensory cues against explicit telling cues."
      : "- Show, don't tell check: not explicitly requested by metadata or guideline text.",
  );

  lines.push(`- Editorial expectations: ${summarizeEditorialExpectations(styleContext)}`);

  return lines;
}

function summarizeEditorialExpectations(styleContext: EvaluationStyleContext): string {
  const values = [
    styleContext.showDontTell ? "show-don't-tell" : null,
    styleContext.valuesPhysicality ? "purposeful physicality" : null,
    styleContext.valuesActiveSpace ? "active spatial blocking" : null,
    styleContext.valuesObjectFunction ? "functional object use" : null,
    styleContext.valuesSubtext ? "subtext pressure" : null,
    styleContext.valuesDialogue ? "dialogue precision" : null,
    styleContext.valuesControlledProse ? "controlled prose" : null,
    styleContext.prefersShortSentences ? "tight sentence control" : null,
    styleContext.prefersLyricalImagery ? "lyrical imagery" : null,
  ].filter((value): value is string => Boolean(value));

  return values.join(", ") || "no special editorial emphasis detected";
}

function extractStyleRefs(metadata: Record<string, unknown>): string[] {
  const refKeys = [
    "style_ref",
    "style_refs",
    "guideline_ref",
    "guideline_refs",
    "evaluation_style_ref",
    "evaluation_style_refs",
    "writing_style_ref",
    "writing_style_refs",
    "chapter_style_ref",
    "chapter_style_refs",
    "custom_style_ref",
    "custom_style_refs",
    "refs",
  ];

  return uniqueValues(
    refKeys.flatMap((key) => readStringValues(metadata[key]).filter((value) => value.startsWith("guideline:"))),
  );
}

function extractStyleSignals(metadata: Record<string, unknown>): Array<{ key: string; value: string }> {
  const signalKeys = [
    "style",
    "style_note",
    "style_notes",
    "custom_style",
    "custom_styles",
    "writing_style",
    "writing_styles",
    "methodology",
    "methodologies",
    "writing_pattern",
    "writing_patterns",
    "style_pattern",
    "style_patterns",
    "narrative_mode",
    "narrative_modes",
    "tone",
    "voice",
    "register",
    "pacing_mode",
    "tags",
  ];

  const results = signalKeys.flatMap((key) =>
    readStringValues(metadata[key]).map((value) => ({ key, value })),
  );

  if (metadata.show_dont_tell === true || metadata.showDontTell === true) {
    results.push({ key: "show_dont_tell", value: "enabled" });
  }

  return results;
}

function readStringValues(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function uniqueSignalEntries(
  values: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> {
  const seen = new Set<string>();
  const results: Array<{ key: string; value: string }> = [];

  for (const value of values) {
    const normalizedKey = `${value.key.toLowerCase()}::${value.value.toLowerCase()}`;
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    results.push(value);
  }

  return results;
}

function containsShowDontTellText(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("show, don't tell") ||
    normalized.includes("show don't tell") ||
    normalized.includes("show-don't-tell") ||
    normalized.includes("mostra, non raccontare") ||
    normalized.includes("mostra non raccontare") ||
    normalized.includes("show_dont_tell")
  );
}

function pickWeakParagraphs(paragraphInsights: ParagraphEvaluationInsight[], label: string): string[] {
  return paragraphInsights
    .filter((paragraph) => getScore(paragraph.scorecard, label) <= 6)
    .sort((left, right) => getScore(left.scorecard, label) - getScore(right.scorecard, label))
    .slice(0, 2)
    .map((paragraph) => paragraph.slug);
}

function findParagraphInsight(
  insights: ParagraphEvaluationInsight[],
  paragraph: string,
): ParagraphEvaluationInsight {
  const normalized = paragraph.replace(/^paragraph:[^:]+:/, "").replace(/\.md$/i, "").trim();
  const match = insights.find((entry) => entry.slug === normalized);
  if (!match) {
    throw new Error(`Paragraph evaluation target not found: ${paragraph}`);
  }
  return match;
}

function getScore(scorecard: ScorecardEntry[], label: string): number {
  return scorecard.find((entry) => entry.label === label)?.score ?? 0;
}

function collectGuidelineTitles(bucket: Map<string, string[]>, guidelines: GuidelineDocument[]): void {
  for (const guideline of guidelines) {
    const values = bucket.get(guideline.slug) ?? [];
    values.push(`${guideline.frontmatter.id} (${guideline.frontmatter.title})`);
    bucket.set(guideline.slug, uniqueValues(values));
  }
}

function averageScore(values: number[]): number {
  if (values.length === 0) return 0;
  return roundToTenths(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function clampScore(value: number): number {
  return Math.max(1, Math.min(10, Math.round(value)));
}

function roundToTenths(value: number): number {
  return Math.round(value * 10) / 10;
}

function humanizeKey(value: string): string {
  if (value === "show_dont_tell") return "show don't tell";
  return value.replace(/[_-]+/g, " ");
}

function formatRevisionUrgency(concernCount: number, nextStepCount: number): string {
  if (concernCount >= 4 || nextStepCount >= 5) return "high";
  if (concernCount >= 2 || nextStepCount >= 3) return "medium";
  return "low";
}

const COMMON_STOP_WORDS = new Set([
  "about",
  "also",
  "ancora",
  "anche",
  "because",
  "come",
  "con",
  "cosa",
  "dalla",
  "dalle",
  "della",
  "delle",
  "dello",
  "degli",
  "dentro",
  "dopo",
  "dove",
  "from",
  "have",
  "into",
  "more",
  "nella",
  "nelle",
  "nello",
  "quella",
  "quello",
  "questa",
  "questo",
  "sono",
  "stata",
  "stato",
  "that",
  "their",
  "there",
  "they",
  "this",
  "very",
  "when",
  "with",
]);

const SENSORY_PATTERNS = [
  /\b(saw|seen|hear|heard|sound|voice|smell|scent|taste|touch|cold|warm|rough|soft|bright|dark|fog|rain|wind|salt|blood|shadow|glow|grit|ache|shiver|sweat|pulse|whisper)\w*\b/giu,
  /\b(vide|vede|ud[iì]|ascolt|odore|profum|gusto|tocca|fredd|cald|ruvid|morb|luce|buio|nebbia|piogg|vento|sale|sangue|ombra|bagliore|brivid|sudore|battit|sussurr)\w*\b/giu,
];

const TELLING_PATTERNS = [
  /\b(felt|feel|thought|think|knew|know|realized|realise|noticed|notice|remembered|remember|wanted|want|wondered|wonder|seemed|seem|decided|decide|understood|understand|believed|believe)\w*\b/giu,
  /\b(sent[iì]|pens|sape|cap[iì]|nota|notav|ricord|vole|sembr|decis|cred|comprese|capiva)\w*\b/giu,
];

const MOVEMENT_PATTERNS = [
  /\b(step|stepped|shift|shifted|lean|leaned|move|moved|approach|approached|retreat|retreated|backed|backed away|crossed|turned|reach|reached|withdrew|closed the distance|shortened the distance)\b/giu,
  /\b(pass|passò|spost|avvicin|arretr|indietregg|inclino|gir[oò]|allung[oò]|appoggi[oò]|urt[oò]|sbatt[eé]|si mosse)\w*\b/giu,
];

const OBJECT_PATTERNS = [
  /\b(glass|door|wall|table|chair|ring|sleeve|coat|letter|ledger|book|knife|blade|cup|window|threshold)\b/giu,
  /\b(muro|porta|tavolo|sedia|anello|manica|tunica|lettera|registro|libro|lama|coltello|bicchiere|finestra|soglia)\w*\b/giu,
];

export async function validateBook(rootPath: string): Promise<{
  valid: boolean;
  checked: number;
  errors: Array<{ path: string; message: string }>;
}> {
  const root = path.resolve(rootPath);
  const files = await fg(CONTENT_GLOB, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
  });

  const errors: Array<{ path: string; message: string }> = [];

  for (const filePath of files) {
    try {
      await validateFile(root, filePath);
    } catch (error) {
      errors.push({
        path: toPosixPath(path.relative(root, filePath)),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    valid: errors.length === 0,
    checked: files.length,
    errors,
  };
}

export async function doctorBook(rootPath: string): Promise<{
  ok: boolean;
  checked: number;
  errors: number;
  warnings: number;
  issues: DoctorIssue[];
}> {
  const root = path.resolve(rootPath);
  const issues: DoctorIssue[] = [];
  const seen = new Set<string>();
  const validation = await validateBook(root);

  for (const error of validation.errors) {
    addDoctorIssue(issues, seen, {
      severity: "error",
      code: "schema-invalid",
      path: error.path,
      message: error.message,
    });
  }

  const contentFiles = await fg(CONTENT_GLOB, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
  });
  const chapters = await listChapters(root);
  const chapterOrder = new Map(chapters.map((chapter) => [chapter.slug, chapter.metadata.number]));
  const validReferences = await buildReferenceLookup(root, chapters);
  const secretReferences = await buildEntityReferenceLookup(root, "secret");

  for (const filePath of contentFiles) {
    const relativePath = toPosixPath(path.relative(root, filePath));
    const raw = await readFile(filePath, "utf8");
    const parsed = matter(raw);
    const frontmatter = parsed.data as Record<string, unknown>;
    const body = String(parsed.content ?? "");

    for (const reference of collectSupportedReferences(frontmatter, body)) {
      if (validReferences.has(reference.toLowerCase())) continue;
      addDoctorIssue(issues, seen, {
        severity: "warning",
        code: "broken-reference",
        path: relativePath,
        message: `Reference points to missing canon: ${reference}`,
      });
    }

    const knownFrom = resolveChapterNumberFromReference(frontmatter.known_from, chapterOrder);
    const revealIn = resolveChapterNumberFromReference(frontmatter.reveal_in, chapterOrder);

    if (frontmatter.known_from !== undefined && knownFrom === null) {
      addDoctorIssue(issues, seen, {
        severity: "warning",
        code: "invalid-known-from",
        path: relativePath,
        message: `known_from does not match an existing chapter: ${String(frontmatter.known_from)}`,
      });
    }

    if (frontmatter.reveal_in !== undefined && revealIn === null) {
      addDoctorIssue(issues, seen, {
        severity: "warning",
        code: "invalid-reveal-in",
        path: relativePath,
        message: `reveal_in does not match an existing chapter: ${String(frontmatter.reveal_in)}`,
      });
    }

    if (knownFrom !== null && revealIn !== null && knownFrom > revealIn) {
      addDoctorIssue(issues, seen, {
        severity: "error",
        code: "spoiler-order",
        path: relativePath,
        message: `known_from resolves after reveal_in (${String(frontmatter.known_from)} > ${String(frontmatter.reveal_in)})`,
      });
    }

    const secretRefs = Array.isArray(frontmatter.secret_refs)
      ? frontmatter.secret_refs.filter((value): value is string => typeof value === "string")
      : [];
    for (const secretRef of secretRefs) {
      if (secretReferences.has(secretRef.toLowerCase())) continue;
      addDoctorIssue(issues, seen, {
        severity: "warning",
        code: "missing-secret-ref",
        path: relativePath,
        message: `secret_refs references a missing secret: ${secretRef}`,
      });
    }
  }

  const assetFiles = await fg("assets/**/*.md", {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
  });

  for (const filePath of assetFiles) {
    const relativePath = toPosixPath(path.relative(root, filePath));
    const document = await readMarkdownFile(filePath, assetSchema);
    const imagePath = path.join(root, document.frontmatter.path);
    const imageExists = await pathExists(imagePath);

    if (!imageExists) {
      addDoctorIssue(issues, seen, {
        severity: "warning",
        code: "missing-asset-image",
        path: relativePath,
        message: `Asset image is missing at ${document.frontmatter.path}`,
      });
    }

    if (imageExists && !String(document.frontmatter.alt_text ?? "").trim()) {
      addDoctorIssue(issues, seen, {
        severity: "warning",
        code: "missing-alt-text",
        path: relativePath,
        message: "Asset has an image file but no alt_text frontmatter.",
      });
    }
  }

  const expectedPlot = await buildPlotDocument(root).catch(() => null);
  const currentPlot = await readPlot(root);
  if (!currentPlot) {
    addDoctorIssue(issues, seen, {
      severity: "warning",
      code: "missing-plot",
      path: PLOT_FILE,
      message: "plot.md is missing. Run sync_plot to regenerate it.",
    });
  } else if (
    expectedPlot &&
    normalizeComparableMarkdown(await readFile(path.join(root, PLOT_FILE), "utf8")) !== normalizeComparableMarkdown(expectedPlot.content)
  ) {
    addDoctorIssue(issues, seen, {
      severity: "warning",
      code: "stale-plot",
      path: PLOT_FILE,
      message: "plot.md does not match the current canon state. Run sync_plot.",
    });
  }

  const expectedTotalResume = await buildTotalResumeDocument(root).catch(() => null);
  const currentTotalResume = await readLooseMarkdownIfExists(path.join(root, TOTAL_RESUME_FILE));
  if (!currentTotalResume) {
    addDoctorIssue(issues, seen, {
      severity: "warning",
      code: "missing-total-resume",
      path: TOTAL_RESUME_FILE,
      message: "resumes/total.md is missing. Run sync_resume or sync_all_resumes.",
    });
  } else if (
    expectedTotalResume &&
    normalizeComparableMarkdown(await readFile(path.join(root, TOTAL_RESUME_FILE), "utf8")) !== normalizeComparableMarkdown(expectedTotalResume.content)
  ) {
    addDoctorIssue(issues, seen, {
      severity: "warning",
      code: "stale-total-resume",
      path: TOTAL_RESUME_FILE,
      message: "resumes/total.md is out of sync with current chapters. Run sync_resume or sync_all_resumes.",
    });
  }

  for (const chapter of chapters) {
    const relativePath = toPosixPath(path.join("resumes", "chapters", `${chapter.slug}.md`));
    const expectedChapterResume = await buildChapterResumeDocument(root, chapter.slug).catch(() => null);
    const currentChapterResume = await readLooseMarkdownIfExists(path.join(root, relativePath));

    if (!currentChapterResume) {
      addDoctorIssue(issues, seen, {
        severity: "warning",
        code: "missing-chapter-resume",
        path: relativePath,
        message: `Chapter resume is missing for ${chapter.metadata.title}. Run sync_resume for ${chapter.slug}.`,
      });
      continue;
    }

    if (
      expectedChapterResume &&
      normalizeComparableMarkdown(await readFile(path.join(root, relativePath), "utf8")) !== normalizeComparableMarkdown(expectedChapterResume.content)
    ) {
      addDoctorIssue(issues, seen, {
        severity: "warning",
        code: "stale-chapter-resume",
        path: relativePath,
        message: `Chapter resume is out of sync for ${chapter.metadata.title}. Run sync_resume for ${chapter.slug}.`,
      });
    }
  }

  const currentStoryState = await readLooseMarkdownIfExists(path.join(root, STORY_STATE_CURRENT_FILE));
  const storyStateStatusDocument = await readLooseMarkdownIfExists(path.join(root, STORY_STATE_STATUS_FILE));
  const storyStateStatus = await readStoryStateStatus(root);

  if (!storyStateStatusDocument) {
    addDoctorIssue(issues, seen, {
      severity: "warning",
      code: "missing-story-state-status",
      path: STORY_STATE_STATUS_FILE,
      message: "state/status.md is missing. Run sync_story_state to regenerate it.",
    });
  }

  if (!currentStoryState) {
    addDoctorIssue(issues, seen, {
      severity: "warning",
      code: "missing-story-state-current",
      path: STORY_STATE_CURRENT_FILE,
      message: "state/current.md is missing. Run sync_story_state to regenerate it.",
    });
  }

  if (storyStateStatus.dirty) {
    addDoctorIssue(issues, seen, {
      severity: "warning",
      code: "stale-story-state",
      path: STORY_STATE_STATUS_FILE,
      message: "Story state is marked stale after story changes. Run sync_story_state manually.",
    });
  } else {
    const expectedStoryState = await buildStoryStateDocuments(root).catch(() => null);

    if (
      expectedStoryState &&
      currentStoryState &&
      normalizeComparableMarkdown(await readFile(path.join(root, STORY_STATE_CURRENT_FILE), "utf8")) !==
        normalizeComparableMarkdown(expectedStoryState.currentContent)
    ) {
      addDoctorIssue(issues, seen, {
        severity: "warning",
        code: "stale-story-state-current",
        path: STORY_STATE_CURRENT_FILE,
        message: "state/current.md is out of sync with chapter resume state_changes. Run sync_story_state.",
      });
    }

    for (const chapterSnapshot of expectedStoryState?.chapterFiles ?? []) {
      const relativePath = toPosixPath(path.relative(root, chapterSnapshot.filePath));
      const currentChapterState = await readLooseMarkdownIfExists(chapterSnapshot.filePath);

      if (!currentChapterState) {
        addDoctorIssue(issues, seen, {
          severity: "warning",
          code: "missing-story-state-chapter",
          path: relativePath,
          message: `Story state snapshot is missing for ${path.basename(relativePath, ".md")}. Run sync_story_state.`,
        });
        continue;
      }

      if (
        normalizeComparableMarkdown(await readFile(chapterSnapshot.filePath, "utf8")) !==
        normalizeComparableMarkdown(chapterSnapshot.content)
      ) {
        addDoctorIssue(issues, seen, {
          severity: "warning",
          code: "stale-story-state-chapter",
          path: relativePath,
          message: `Story state snapshot is out of sync for ${path.basename(relativePath, ".md")}. Run sync_story_state.`,
        });
      }
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;

  return {
    ok: errors === 0,
    checked: validation.checked,
    errors,
    warnings,
    issues,
  };
}

export async function exportEpub(
  rootPath: string,
  options?: {
    outputPath?: string;
    title?: string;
    author?: string;
    language?: string;
    includeCanonIndex?: boolean;
  },
): Promise<{ outputPath: string; chapterCount: number }> {
  const root = path.resolve(rootPath);
  const book = await readBook(root);
  const chapters = await listChapters(root);
  const coverAsset = await readAsset(root, "book", "cover");
  const includeCanonIndex = options?.includeCanonIndex ?? true;

  if (chapters.length === 0) {
    throw new Error("Cannot export EPUB: no chapters found.");
  }

  const epubModule = (await import("epub-gen-memory")) as unknown as {
    default:
      | ((options: Record<string, unknown>, content: Array<{ title: string; content: string }>) => Promise<Buffer>)
      | {
          default: (options: Record<string, unknown>, content: Array<{ title: string; content: string }>) => Promise<Buffer>;
        };
  };
  const title = options?.title ?? book?.frontmatter.title ?? path.basename(root);
  const author = options?.author ?? book?.frontmatter.author ?? "Unknown Author";
  const language = options?.language ?? book?.frontmatter.language ?? "en";
  const outputPath = path.resolve(options?.outputPath ?? path.join(root, "dist", `${slugify(title)}.epub`));

  const content = [] as Array<{ title: string; content: string }>;

  content.push({
    title: "Opening",
    content: renderEpubOpeningPage({
      title,
      author,
      language,
      coverAsset,
      chapterCount: chapters.length,
    }),
  });

  for (const chapter of chapters) {
    const chapterData = await readChapter(root, chapter.slug);
    const chapterImageHtml = renderEpubAssetFigure(await readAsset(root, String(chapterData.metadata.id), "primary"), `${chapterData.metadata.title} illustration`);
    const sceneIndexHtml = chapterData.paragraphs.length > 0
      ? `<nav><h2>Scenes</h2><ol>${chapterData.paragraphs
          .map((paragraph, index) => `<li><a href="#scene-${index + 1}">${escapeHtml(paragraph.metadata.title)}</a></li>`)
          .join("")}</ol></nav>`
      : "";
    const paragraphsHtml = (
      await Promise.all(
        chapterData.paragraphs.map(async (paragraph, index) => {
          const paragraphImageHtml = renderEpubAssetFigure(
            await readAsset(root, String(paragraph.metadata.id), "primary"),
            `${paragraph.metadata.title} illustration`,
          );
          const paragraphSummary = typeof paragraph.metadata.summary === "string" && paragraph.metadata.summary.trim()
            ? `<p><em>${escapeHtml(paragraph.metadata.summary)}</em></p>`
            : "";
          return `<section id="scene-${index + 1}"><h2>${escapeHtml(paragraph.metadata.title)}</h2>${paragraphSummary}${marked.parse(paragraph.body)}${paragraphImageHtml}</section>`;
        }),
      )
    ).join("\n");
    const chapterSummary = typeof chapterData.metadata.summary === "string" && chapterData.metadata.summary.trim()
      ? `<p><em>${escapeHtml(chapterData.metadata.summary)}</em></p>`
      : "";
    const chapterHtml = `<article><h1>${escapeHtml(chapterData.metadata.title)}</h1>${chapterSummary}${marked.parse(chapterData.body)}${chapterImageHtml}${sceneIndexHtml}${paragraphsHtml}</article>`;
    content.push({ title: chapterData.metadata.title, content: chapterHtml });
  }

  if (includeCanonIndex) {
    const canonIndexHtml = await renderEpubCanonIndex(root);
    if (canonIndexHtml) {
      content.push({ title: "Canon Index", content: canonIndexHtml });
    }
  }

  const renderEpub = typeof epubModule.default === "function" ? epubModule.default : epubModule.default.default;

  const bytes = await renderEpub(
    {
      title,
      author,
      lang: language,
      cover: coverAsset?.imageExists ? pathToFileURL(coverAsset.imagePath).href : undefined,
      css: [
        "body { font-family: serif; line-height: 1.55; }",
        "h1, h2 { font-family: serif; }",
        "nav ol { padding-left: 1.2rem; }",
        "figure { margin: 1.8rem 0; text-align: center; }",
        "figcaption { font-size: 0.9em; color: #555; }",
        ".epub-figure { margin: 2.2rem 0 0; page-break-inside: avoid; text-align: center; }",
        ".epub-figure.epub-figure-full { page-break-before: always; break-before: page; }",
        ".epub-figure img { display: block; width: 100%; max-height: 100vh; height: auto; object-fit: contain; }",
      ].join(" "),
    },
    content,
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(bytes));

  return { outputPath, chapterCount: chapters.length };
}

function defaultStoryStateStatus(): StoryStateStatus {
  return {
    dirty: false,
    changedPaths: [],
  };
}

function createEmptyStoryStateSnapshot(): StoryStateSnapshot {
  return {
    locations: {},
    knowledge: {},
    inventory: {},
    relationships: {},
    conditions: {},
    wounds: {},
    openLoops: [],
  };
}

function normalizeStoryStateStatus(frontmatter: Record<string, unknown> | undefined): StoryStateStatus {
  return {
    dirty: Boolean(frontmatter?.dirty),
    lastStoryMutationAt: normalizeOptionalString(frontmatter?.last_story_mutation_at),
    lastStoryStateSyncAt: normalizeOptionalString(frontmatter?.last_story_state_sync_at),
    changedPaths: uniqueValues(
      Array.isArray(frontmatter?.changed_paths)
        ? frontmatter.changed_paths.filter((value): value is string => typeof value === "string")
        : [],
    ).sort((left, right) => left.localeCompare(right)),
    reason: normalizeOptionalString(frontmatter?.reason),
  };
}

function buildStoryStateStatusMarkdown(status: StoryStateStatus): string {
  return renderMarkdown(
    compactFrontmatterPatch({
      type: "story-state-status",
      id: "story-state:status",
      title: "Story State Status",
      dirty: status.dirty,
      last_story_mutation_at: status.lastStoryMutationAt,
      last_story_state_sync_at: status.lastStoryStateSyncAt,
      changed_paths: status.changedPaths,
      reason: status.reason,
    }),
    [
      "# Story State Status",
      "",
      `- Dirty: ${status.dirty ? "yes" : "no"}`,
      `- Last story mutation: ${status.lastStoryMutationAt ?? "not recorded"}`,
      `- Last story state sync: ${status.lastStoryStateSyncAt ?? "not recorded"}`,
      `- Pending changed paths: ${status.changedPaths.join(", ") || "none"}`,
      `- Reason: ${status.reason ?? "not recorded"}`,
      "",
      "## Next Action",
      "",
      "Run `sync_story_state` manually after chapter or paragraph rewrites when you want refreshed state snapshots.",
    ].join("\n"),
  );
}

function buildCurrentStoryStateMarkdown(
  snapshot: StoryStateSnapshot,
  options: { throughChapter?: string; chapterCount: number },
): string {
  return renderMarkdown(
    compactFrontmatterPatch({
      type: "story-state",
      id: "story-state:current",
      title: "Current Story State",
      through_chapter: options.throughChapter,
      chapter_count: options.chapterCount,
    }),
    buildStoryStateSnapshotBody(snapshot, {
      heading: "Current Story State",
      throughChapter: options.throughChapter,
      chapterCount: options.chapterCount,
    }),
  );
}

function buildStoryStateSnapshotBody(
  snapshot: StoryStateSnapshot,
  options: {
    heading: string;
    throughChapter?: string;
    chapterCount: number;
    changeLines?: string[];
  },
): string {
  return [
    `# ${options.heading}`,
    "",
    `- Through chapter: ${options.throughChapter ?? "not synced yet"}`,
    `- Chapters covered: ${options.chapterCount}`,
    "",
    ...(options.changeLines
      ? [
          "## Chapter Delta",
          "",
          ...(options.changeLines.length > 0
            ? options.changeLines.map((line) => `- ${line}`)
            : ["- No `state_changes` recorded for this chapter yet."]),
          "",
        ]
      : []),
    ...renderStoryStateSection("Locations", renderStringRecordLines(snapshot.locations, " -> "), "No tracked locations."),
    ...renderStoryStateSection("Knowledge", renderStringArrayRecordLines(snapshot.knowledge), "No tracked knowledge."),
    ...renderStoryStateSection("Inventory", renderStringArrayRecordLines(snapshot.inventory), "No tracked inventory."),
    ...renderStoryStateSection("Relationships", renderRelationshipLines(snapshot.relationships), "No tracked relationship updates."),
    ...renderStoryStateSection("Conditions", renderStringArrayRecordLines(snapshot.conditions), "No tracked conditions."),
    ...renderStoryStateSection("Wounds", renderStringArrayRecordLines(snapshot.wounds), "No tracked wounds."),
    ...renderStoryStateSection("Open Loops", snapshot.openLoops, "No open loops tracked."),
  ].join("\n");
}

function renderStoryStateSection(title: string, lines: string[], emptyLabel: string): string[] {
  return [
    `## ${title}`,
    "",
    ...(lines.length > 0 ? lines.map((line) => `- ${line}`) : [`- ${emptyLabel}`]),
    "",
  ];
}

function renderStoryStateChangeLines(changes: StoryStateChanges | undefined): string[] {
  if (!changes) {
    return [];
  }

  return [
    ...renderStringRecordLines(changes.locations, " -> ").map((line) => `Locations: ${line}`),
    ...renderStringArrayRecordLines(changes.knowledge_gain).map((line) => `Knowledge gained: ${line}`),
    ...renderStringArrayRecordLines(changes.knowledge_loss).map((line) => `Knowledge removed: ${line}`),
    ...renderStringArrayRecordLines(changes.inventory_add).map((line) => `Inventory added: ${line}`),
    ...renderStringArrayRecordLines(changes.inventory_remove).map((line) => `Inventory removed: ${line}`),
    ...renderRelationshipLines(changes.relationship_updates).map((line) => `Relationships: ${line}`),
    ...renderStringArrayRecordLines(changes.conditions).map((line) => `Conditions: ${line}`),
    ...renderStringArrayRecordLines(changes.wounds).map((line) => `Wounds: ${line}`),
    ...(changes.open_loops_add ?? []).map((value) => `Open loop added: ${value}`),
    ...(changes.open_loops_resolved ?? []).map((value) => `Open loop resolved: ${value}`),
  ];
}

function renderStringRecordLines(record: Record<string, string> | undefined, joiner: string): string[] {
  return Object.entries(record ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${joiner}${value}`);
}

function renderStringArrayRecordLines(record: Record<string, string[]> | undefined): string[] {
  return Object.entries(record ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => `${key}: ${values.join(", ")}`);
}

function renderRelationshipLines(record: Record<string, Record<string, string>> | undefined): string[] {
  const lines: string[] = [];

  for (const [source, relationships] of Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    for (const [target, value] of Object.entries(relationships).sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`${source}: ${target} = ${value}`);
    }
  }

  return lines;
}

function normalizeStoryStateChanges(value: unknown): StoryStateChanges | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const normalized: StoryStateChanges = compactFrontmatterPatch({
    locations: normalizeStringRecord(input.locations),
    knowledge_gain: normalizeStringArrayRecord(input.knowledge_gain),
    knowledge_loss: normalizeStringArrayRecord(input.knowledge_loss),
    inventory_add: normalizeStringArrayRecord(input.inventory_add),
    inventory_remove: normalizeStringArrayRecord(input.inventory_remove),
    relationship_updates: normalizeNestedStringRecord(input.relationship_updates),
    conditions: normalizeStringArrayRecord(input.conditions),
    wounds: normalizeStringArrayRecord(input.wounds),
    open_loops_add: normalizeStringArray(input.open_loops_add),
    open_loops_resolved: normalizeStringArray(input.open_loops_resolved),
  }) as StoryStateChanges;

  return hasStoryStateChanges(normalized) ? normalized : undefined;
}

function hasStoryStateChanges(changes: StoryStateChanges): boolean {
  return Object.keys(changes).length > 0;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .flatMap(([key, entryValue]) => {
      const normalizedKey = key.trim();
      const normalizedValue = normalizeOptionalString(entryValue);
      return normalizedKey && normalizedValue ? [[normalizedKey, normalizedValue] as const] : [];
    })
    .sort(([left], [right]) => left.localeCompare(right));

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeStringArrayRecord(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .flatMap(([key, entryValue]) => {
      const normalizedKey = key.trim();
      const normalizedValue = normalizeStringArray(entryValue);
      return normalizedKey && normalizedValue ? [[normalizedKey, normalizedValue] as const] : [];
    })
    .sort(([left], [right]) => left.localeCompare(right));

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeNestedStringRecord(value: unknown): Record<string, Record<string, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .flatMap(([key, entryValue]) => {
      const normalizedKey = key.trim();
      const normalizedValue = normalizeStringRecord(entryValue);
      return normalizedKey && normalizedValue ? [[normalizedKey, normalizedValue] as const] : [];
    })
    .sort(([left], [right]) => left.localeCompare(right));

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = uniqueValues(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean),
  ).sort((left, right) => left.localeCompare(right));

  return normalized.length > 0 ? normalized : undefined;
}

function applyStoryStateChanges(snapshot: StoryStateSnapshot, changes: StoryStateChanges | undefined): StoryStateSnapshot {
  const next: StoryStateSnapshot = {
    locations: { ...snapshot.locations },
    knowledge: Object.fromEntries(
      Object.entries(snapshot.knowledge).map(([key, values]) => [key, [...values]]),
    ),
    inventory: Object.fromEntries(
      Object.entries(snapshot.inventory).map(([key, values]) => [key, [...values]]),
    ),
    relationships: Object.fromEntries(
      Object.entries(snapshot.relationships).map(([key, value]) => [key, { ...value }]),
    ),
    conditions: Object.fromEntries(
      Object.entries(snapshot.conditions).map(([key, values]) => [key, [...values]]),
    ),
    wounds: Object.fromEntries(
      Object.entries(snapshot.wounds).map(([key, values]) => [key, [...values]]),
    ),
    openLoops: [...snapshot.openLoops],
  };

  if (!changes) {
    return next;
  }

  for (const [key, value] of Object.entries(changes.locations ?? {})) {
    next.locations[key] = value;
  }

  applyArrayRecordChanges(next.knowledge, changes.knowledge_gain, "add");
  applyArrayRecordChanges(next.knowledge, changes.knowledge_loss, "remove");
  applyArrayRecordChanges(next.inventory, changes.inventory_add, "add");
  applyArrayRecordChanges(next.inventory, changes.inventory_remove, "remove");
  applyArrayRecordChanges(next.conditions, changes.conditions, "set");
  applyArrayRecordChanges(next.wounds, changes.wounds, "set");

  for (const [source, relationships] of Object.entries(changes.relationship_updates ?? {})) {
    next.relationships[source] = {
      ...(next.relationships[source] ?? {}),
      ...relationships,
    };
  }

  const openLoops = new Set(next.openLoops);
  for (const value of changes.open_loops_add ?? []) {
    openLoops.add(value);
  }
  for (const value of changes.open_loops_resolved ?? []) {
    openLoops.delete(value);
  }
  next.openLoops = [...openLoops].sort((left, right) => left.localeCompare(right));

  return next;
}

function applyArrayRecordChanges(
  target: Record<string, string[]>,
  changes: Record<string, string[]> | undefined,
  mode: "add" | "remove" | "set",
): void {
  for (const [key, values] of Object.entries(changes ?? {})) {
    if (mode === "set") {
      target[key] = [...values].sort((left, right) => left.localeCompare(right));
      continue;
    }

    const nextValues = new Set(target[key] ?? []);
    for (const value of values) {
      if (mode === "add") {
        nextValues.add(value);
      } else {
        nextValues.delete(value);
      }
    }

    const normalized = [...nextValues].sort((left, right) => left.localeCompare(right));
    if (normalized.length > 0) {
      target[key] = normalized;
    } else {
      delete target[key];
    }
  }
}

async function markStoryStateDirty(
  rootPath: string,
  options: { changedPaths: string[]; reason: string },
): Promise<void> {
  const root = path.resolve(rootPath);
  const current = await readStoryStateStatus(root);
  const nextStatus: StoryStateStatus = {
    dirty: true,
    lastStoryMutationAt: new Date().toISOString(),
    lastStoryStateSyncAt: current.lastStoryStateSyncAt,
    changedPaths: uniqueValues([...current.changedPaths, ...options.changedPaths]).sort((left, right) => left.localeCompare(right)),
    reason: options.reason,
  };

  await mkdir(path.dirname(current.filePath), { recursive: true });
  await writeFile(current.filePath, buildStoryStateStatusMarkdown(nextStatus), "utf8");
}

async function buildQueryCanonTargets(
  root: string,
  chapters: Array<{ slug: string; path: string; metadata: ChapterFrontmatter }>,
  lexicon: QueryCanonLexicon = resolveQueryCanonLexicon("en"),
): Promise<QueryCanonTarget[]> {
  const entityGroups = await Promise.all(ENTITY_TYPES.map((kind) => listEntities(root, kind)));
  const entityTargets = entityGroups.flatMap((documents, index) => {
    const kind = ENTITY_TYPES[index];
    return documents.map((document) => ({
      kind,
      id: String(document.metadata.id ?? `${kind}:${document.slug}`),
      title:
        typeof document.metadata.name === "string"
          ? document.metadata.name
          : typeof document.metadata.title === "string"
            ? document.metadata.title
            : document.slug,
      aliases: extractQueryCanonAliases(kind, document.metadata),
      path: document.path,
      metadata: document.metadata,
      body: document.body,
    }));
  });

  const chapterTargets = await Promise.all(
    chapters.map(async (chapter) => {
      const chapterData = await readChapter(root, chapter.slug);
      return {
        kind: "chapter" as const,
        id: String(chapter.metadata.id ?? `chapter:${chapter.slug}`),
        title: chapter.metadata.title,
        aliases: extractQueryCanonAliases("chapter", chapter.metadata, chapter.metadata.number, lexicon),
        path: chapter.path,
        metadata: chapter.metadata,
        body: chapterData.body,
      };
    }),
  );

  return [...entityTargets, ...chapterTargets];
}

function buildQueryCanonLookup(
  targets: QueryCanonTarget[],
  chapters: Array<{ slug: string; path: string; metadata: ChapterFrontmatter }>,
): QueryCanonLookup {
  return {
    targetsById: new Map(targets.map((target) => [target.id, target])),
    chaptersByRef: new Map(
      chapters.flatMap((chapter) => [
        [
          `chapter:${chapter.slug}`,
          { slug: chapter.slug, number: chapter.metadata.number, title: chapter.metadata.title },
        ] as const,
        [chapter.slug, { slug: chapter.slug, number: chapter.metadata.number, title: chapter.metadata.title }] as const,
      ]),
    ),
  };
}

function extractQueryCanonAliases(
  kind: EntityType | "chapter",
  metadata: Record<string, unknown>,
  chapterNumber?: number,
  lexicon: QueryCanonLexicon = resolveQueryCanonLexicon("en"),
): string[] {
  const values = uniqueValues(
    [
      typeof metadata.name === "string" ? metadata.name : undefined,
      typeof metadata.title === "string" ? metadata.title : undefined,
      typeof metadata.id === "string" ? metadata.id : undefined,
      typeof metadata.current_identity === "string" ? metadata.current_identity : undefined,
      typeof metadata.spoken_name === "string" ? metadata.spoken_name : undefined,
      typeof metadata.tts_label === "string" ? metadata.tts_label : undefined,
      ...(Array.isArray(metadata.aliases) ? metadata.aliases.filter((value): value is string => typeof value === "string") : []),
      ...(Array.isArray(metadata.former_names)
        ? metadata.former_names.filter((value): value is string => typeof value === "string")
        : []),
      ...(kind === "chapter" && typeof metadata.id === "string"
        ? [
            metadata.id,
            ...(typeof chapterNumber === "number"
              ? lexicon.chapterAliases.map((alias) => `${alias} ${chapterNumber}`)
              : []),
            humanizeQueryCanonToken(String(metadata.id).replace(/^chapter:/, "")),
          ]
        : []),
    ].filter((value): value is string => Boolean(value && value.trim())),
  );

  return values.filter((value) => normalizeQueryCanonSearch(value).length > 0);
}

function detectQueryCanonIntent(question: string, hasRange: boolean, lexicon: QueryCanonLexicon): QueryCanonIntent {
  const lower = question.toLowerCase();

  if (new RegExp(buildAlternationPattern(lexicon.firstAppearancePhrases), "i").test(lower)) {
    return "first-appearance";
  }

  if (new RegExp(buildAlternationPattern(lexicon.secretHolderPhrases), "i").test(lower)) {
    return "secret-holders";
  }

  if (new RegExp(buildAlternationPattern(lexicon.relationshipPhrases), "i").test(lower)) {
    return hasRange ? "state-relationship-arc" : "state-relationship";
  }

  if (new RegExp(buildAlternationPattern(lexicon.conditionPhrases), "i").test(lower)) {
    return hasRange ? "state-condition-arc" : "state-condition";
  }

  if (new RegExp(buildAlternationPattern(lexicon.openLoopPhrases), "i").test(lower)) {
    return hasRange ? "state-open-loops-arc" : "state-open-loops";
  }

  if (new RegExp(buildAlternationPattern(lexicon.wherePhrases), "i").test(lower)) {
    return "state-location";
  }

  if (matchesInventoryIntent(lower, lexicon)) {
    return "state-inventory";
  }

  if (matchesKnowledgeIntent(lower, lexicon)) {
    return "state-knowledge";
  }

  return "general";
}

function resolveQueryCanonChapterRange(
  chapters: Array<{ slug: string; path: string; metadata: ChapterFrontmatter }>,
  question: string,
  explicitFromChapter?: string,
  explicitToChapter?: string,
  lexicon: QueryCanonLexicon = resolveQueryCanonLexicon("en"),
): QueryCanonChapterRange | undefined {
  const explicitStart = explicitFromChapter ? resolveQueryCanonChapterReference(chapters, explicitFromChapter, lexicon) : {};
  const explicitEnd = explicitToChapter ? resolveQueryCanonChapterReference(chapters, explicitToChapter, lexicon) : {};
  const explicitNote = [explicitStart.note, explicitEnd.note].filter((value): value is string => Boolean(value)).join(" ");

  if (explicitStart.reference && explicitEnd.reference) {
    return normalizeQueryCanonChapterRange(chapters, explicitStart.reference, explicitEnd.reference, explicitNote || undefined);
  }

  const explicitRefs = [...question.matchAll(/\bchapter:[a-z0-9-]+\b/gi)].map((match) => match[0]);
  if (explicitRefs.length >= 2) {
    return normalizeQueryCanonChapterRange(chapters, explicitRefs[0], explicitRefs[1]);
  }

  const betweenNumberedMatch = question.match(
    new RegExp(
      `\\b(?:${buildAlternationPattern(lexicon.betweenWords)})\\s+(?:${buildAlternationPattern(lexicon.chapterAliases)})?\\s*(\\d{1,3})\\s+(?:${buildAlternationPattern(lexicon.andWords)})\\s+(?:${buildAlternationPattern(lexicon.chapterAliases)})?\\s*(\\d{1,3})\\b`,
      "i",
    ),
  );
  if (betweenNumberedMatch) {
    return normalizeQueryCanonChapterRange(chapters, betweenNumberedMatch[1], betweenNumberedMatch[2]);
  }

  const fromToNumberedMatch = question.match(
    new RegExp(
      `\\b(?:${buildAlternationPattern(lexicon.fromWords)})\\s+(?:${buildAlternationPattern(lexicon.chapterAliases)})?\\s*(\\d{1,3})\\s+(?:${buildAlternationPattern(lexicon.toWords)})\\s+(?:${buildAlternationPattern(lexicon.chapterAliases)})?\\s*(\\d{1,3})\\b`,
      "i",
    ),
  );
  if (fromToNumberedMatch) {
    return normalizeQueryCanonChapterRange(chapters, fromToNumberedMatch[1], fromToNumberedMatch[2]);
  }

  return undefined;
}

function normalizeQueryCanonChapterRange(
  chapters: Array<{ slug: string; path: string; metadata: ChapterFrontmatter }>,
  startValue: string,
  endValue: string,
  note?: string,
): QueryCanonChapterRange | undefined {
  const start = resolveQueryCanonChapterReference(chapters, startValue);
  const end = resolveQueryCanonChapterReference(chapters, endValue);
  const issues = [note, start.note, end.note].filter((value): value is string => Boolean(value));

  if (!start.reference || !end.reference) {
    return undefined;
  }

  const chapterNumbers = new Map(chapters.map((chapter) => [`chapter:${chapter.slug}`, chapter.metadata.number]));
  const startNumber = chapterNumbers.get(start.reference) ?? 0;
  const endNumber = chapterNumbers.get(end.reference) ?? 0;

  if (startNumber <= endNumber) {
    return {
      startReference: start.reference,
      endReference: end.reference,
      note: issues.join(" ") || undefined,
    };
  }

  return {
    startReference: end.reference,
    endReference: start.reference,
    note: uniqueValues([...issues, "Chapter range was reversed in the question, so the answer uses chronological order."]).join(" "),
  };
}

function resolveQueryCanonChapterScope(
  chapters: Array<{ slug: string; path: string; metadata: ChapterFrontmatter }>,
  question: string,
  explicitThroughChapter?: string,
  lexicon: QueryCanonLexicon = resolveQueryCanonLexicon("en"),
): { reference?: string; note?: string } {
  if (explicitThroughChapter) {
    return resolveQueryCanonChapterReference(chapters, explicitThroughChapter, lexicon);
  }

  const explicitId = question.match(/\bchapter:[a-z0-9-]+\b/i)?.[0];
  if (explicitId) {
    return resolveQueryCanonChapterReference(chapters, explicitId, lexicon);
  }

  const numberedMatch = question.match(new RegExp(`\\b(?:${buildAlternationPattern(lexicon.chapterAliases)})\\s*(\\d{1,3})\\b`, "i"));
  if (numberedMatch) {
    return resolveQueryCanonChapterReference(chapters, numberedMatch[0], lexicon);
  }

  return {};
}

function resolveQueryCanonChapterReference(
  chapters: Array<{ slug: string; path: string; metadata: ChapterFrontmatter }>,
  value: string,
  lexicon: QueryCanonLexicon = resolveQueryCanonLexicon("en"),
): { reference?: string; note?: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }

  const explicitId = trimmed.match(/\bchapter:[a-z0-9-]+\b/i)?.[0];
  if (explicitId) {
    const slug = normalizeChapterReference(explicitId);
    const chapter = chapters.find((entry) => entry.slug === slug);
    return chapter
      ? { reference: `chapter:${chapter.slug}` }
      : { note: `No chapter found matching ${explicitId}.` };
  }

  const numberedMatch = trimmed.match(new RegExp(`\\b(?:${buildAlternationPattern(lexicon.chapterAliases)})\\s*(\\d{1,3})\\b`, "i")) ??
    trimmed.match(/^(\d{1,3})$/);
  if (numberedMatch) {
    const chapterNumber = Number(numberedMatch[1]);
    const chapter = chapters.find((entry) => entry.metadata.number === chapterNumber);
    return chapter
      ? { reference: `chapter:${chapter.slug}` }
      : { note: `No chapter found matching chapter ${chapterNumber}.` };
  }

  if (/^[a-z0-9-]+$/i.test(trimmed)) {
    const slug = normalizeChapterReference(trimmed);
    const chapter = chapters.find((entry) => entry.slug === slug);
    return chapter
      ? { reference: `chapter:${chapter.slug}` }
      : { note: `No chapter found matching ${trimmed}.` };
  }

  return {};
}

function resolveQueryCanonTarget(
  targets: QueryCanonTarget[],
  question: string,
  subjectHint?: string,
): { target?: QueryCanonTarget; note?: string } {
  const ranked = rankQueryCanonTargets(targets, question, subjectHint);

  if (ranked.length === 0) {
    return {};
  }

  const best = ranked[0];
  const second = ranked[1];
  return {
    target: best.target,
    note:
      second && second.score >= best.score - 10
        ? `Query target may be ambiguous between ${best.target.id} and ${second.target.id}. Using ${best.target.id}.`
        : undefined,
  };
}

function resolveSecondaryQueryCanonTarget(
  targets: QueryCanonTarget[],
  question: string,
  primaryTarget: QueryCanonTarget | undefined,
  subjectHint?: string,
): QueryCanonTarget | undefined {
  if (!primaryTarget) {
    return undefined;
  }

  return rankQueryCanonTargets(targets, question, subjectHint)
    .map((entry) => entry.target)
    .find((target) => target.id !== primaryTarget.id);
}

function rankQueryCanonTargets(
  targets: QueryCanonTarget[],
  question: string,
  subjectHint?: string,
): Array<{ target: QueryCanonTarget; score: number }> {
  const lowerQuestion = question.toLowerCase();
  const normalizedQuestion = normalizeQueryCanonSearch(question);
  const lowerSubject = subjectHint?.toLowerCase() ?? "";
  const normalizedSubject = subjectHint ? normalizeQueryCanonSearch(subjectHint) : "";

  return targets
    .map((target) => ({
      target,
      score: Math.max(
        scoreQueryCanonTarget(target, lowerQuestion, normalizedQuestion),
        normalizedSubject ? scoreQueryCanonTarget(target, lowerSubject, normalizedSubject) + 20 : 0,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
}

function filterQueryCanonTargetsForIntent(
  targets: QueryCanonTarget[],
  intent: QueryCanonIntent,
): QueryCanonTarget[] {
  switch (intent) {
    case "state-location":
    case "state-knowledge":
    case "state-inventory":
    case "state-relationship":
    case "state-relationship-arc":
    case "state-condition":
    case "state-condition-arc":
      return targets.filter((target) => target.kind !== "chapter");
    case "state-open-loops":
    case "state-open-loops-arc":
      return targets;
    case "secret-holders":
      return targets.filter((target) => target.kind === "secret");
    default:
      return targets;
  }
}

function scoreQueryCanonTarget(target: QueryCanonTarget, lowerQuestion: string, normalizedQuestion: string): number {
  let score = 0;
  const directId = target.id.toLowerCase();
  if (lowerQuestion.includes(directId)) {
    score = Math.max(score, 180);
  }

  for (const candidate of uniqueValues([target.title, ...target.aliases])) {
    const normalizedCandidate = normalizeQueryCanonSearch(candidate);
    if (!normalizedCandidate) continue;

    if (normalizedQuestion === normalizedCandidate) {
      score = Math.max(score, 160);
    }

    if (normalizedQuestion.includes(normalizedCandidate)) {
      score = Math.max(score, 140);
    }

    const tokens = normalizedCandidate.split(" ").filter((token) => token.length >= 4);
    const matchedTokens = tokens.filter((token) => normalizedQuestion.includes(token));
    if (matchedTokens.length === tokens.length && tokens.length > 0) {
      score = Math.max(score, 120 + matchedTokens.length * 5);
    } else if (matchedTokens.length > 0) {
      score = Math.max(score, 70 + matchedTokens.length * 12);
    }
  }

  return score;
}

function answerLocationQuery(
  root: string,
  target: QueryCanonTarget | undefined,
  throughChapter: string | undefined,
  entries: StoryStateTimelineEntry[],
  lookup: QueryCanonLookup,
): QueryCanonAnswerDraft | null {
  if (!target) {
    return null;
  }

  const snapshotEntry = selectStoryStateEntry(entries, throughChapter);
  const location = snapshotEntry?.snapshot.locations[target.id];
  if (!snapshotEntry || !location) {
    return null;
  }

  const sourceEntry = [...storyStateEntriesUpTo(entries, throughChapter)]
    .reverse()
    .find((entry) => Boolean(entry.stateChanges?.locations?.[target.id]));

  return {
    answer: `${target.title} is in ${formatQueryCanonValue(location, lookup)}${
      throughChapter ? ` through ${formatQueryCanonChapterLabel(throughChapter, lookup)}` : ""
    }.`,
    confidence: "high",
    intent: "state-location",
    sources: uniqueQueryCanonSources(
      [
        sourceEntry ? buildQueryCanonSource(root, sourceEntry.resumePath, sourceEntry.chapterTitle, "resume", "story state location change") : null,
        sourceEntry ? buildQueryCanonSource(root, sourceEntry.chapterPath, sourceEntry.chapterTitle, "chapter", "chapter anchor") : null,
      ].filter((value): value is QueryCanonSource => Boolean(value)),
    ),
    notes: [],
  };
}

function answerKnowledgeQuery(
  root: string,
  target: QueryCanonTarget | undefined,
  throughChapter: string | undefined,
  entries: StoryStateTimelineEntry[],
  lookup: QueryCanonLookup,
): QueryCanonAnswerDraft | null {
  if (!target) {
    return null;
  }

  const snapshotEntry = selectStoryStateEntry(entries, throughChapter);
  const knowledge = snapshotEntry?.snapshot.knowledge[target.id] ?? [];
  if (knowledge.length === 0) {
    return null;
  }

  const sourceEntries = storyStateEntriesUpTo(entries, throughChapter)
    .filter((entry) => Boolean(entry.stateChanges?.knowledge_gain?.[target.id] || entry.stateChanges?.knowledge_loss?.[target.id]))
    .slice(-3);

  return {
    answer: `${target.title} knows ${joinQueryCanonList(knowledge.map((value) => formatQueryCanonValue(value, lookup)))}${
      throughChapter ? ` by ${formatQueryCanonChapterLabel(throughChapter, lookup)}` : ""
    }.`,
    confidence: "high",
    intent: "state-knowledge",
    sources: uniqueQueryCanonSources(
      sourceEntries.map((entry) => buildQueryCanonSource(root, entry.resumePath, entry.chapterTitle, "resume", "story state knowledge delta")),
    ),
    notes: [],
  };
}

function answerInventoryQuery(
  root: string,
  target: QueryCanonTarget | undefined,
  throughChapter: string | undefined,
  entries: StoryStateTimelineEntry[],
  lookup: QueryCanonLookup,
): QueryCanonAnswerDraft | null {
  if (!target) {
    return null;
  }

  const snapshotEntry = selectStoryStateEntry(entries, throughChapter);
  const inventory = snapshotEntry?.snapshot.inventory[target.id] ?? [];
  if (inventory.length === 0) {
    return null;
  }

  const sourceEntries = storyStateEntriesUpTo(entries, throughChapter)
    .filter((entry) => Boolean(entry.stateChanges?.inventory_add?.[target.id] || entry.stateChanges?.inventory_remove?.[target.id]))
    .slice(-3);

  return {
    answer: `${target.title} has ${joinQueryCanonList(inventory.map((value) => formatQueryCanonValue(value, lookup)))}${
      throughChapter ? ` by ${formatQueryCanonChapterLabel(throughChapter, lookup)}` : ""
    }.`,
    confidence: "high",
    intent: "state-inventory",
    sources: uniqueQueryCanonSources(
      sourceEntries.map((entry) => buildQueryCanonSource(root, entry.resumePath, entry.chapterTitle, "resume", "story state inventory delta")),
    ),
    notes: [],
  };
}

function answerRelationshipQuery(
  root: string,
  target: QueryCanonTarget | undefined,
  secondaryTarget: QueryCanonTarget | undefined,
  throughChapter: string | undefined,
  entries: StoryStateTimelineEntry[],
  lookup: QueryCanonLookup,
): QueryCanonAnswerDraft | null {
  if (!target) {
    return null;
  }

  const snapshotEntry = selectStoryStateEntry(entries, throughChapter);
  const allRelationships = snapshotEntry?.snapshot.relationships[target.id] ?? {};

  if (secondaryTarget) {
    const direct = allRelationships[secondaryTarget.id];
    const reverse = snapshotEntry?.snapshot.relationships[secondaryTarget.id]?.[target.id];
    const relation = direct ?? reverse;
    if (!relation) {
      return null;
    }

    const sourceEntries = storyStateEntriesUpTo(entries, throughChapter)
      .filter(
        (entry) =>
          Boolean(entry.stateChanges?.relationship_updates?.[target.id]?.[secondaryTarget.id]) ||
          Boolean(entry.stateChanges?.relationship_updates?.[secondaryTarget.id]?.[target.id]),
      )
      .slice(-3);

    const sentence = direct
      ? `${target.title}'s relationship with ${secondaryTarget.title} is ${humanizeQueryCanonToken(direct)}.`
      : `${secondaryTarget.title}'s relationship with ${target.title} is ${humanizeQueryCanonToken(reverse ?? relation)}.`;

    return {
      answer: `${sentence}${throughChapter ? ` ${formatQueryCanonChapterLabel(throughChapter, lookup)}.` : ""}`,
      confidence: "high",
      intent: "state-relationship",
      sources: uniqueQueryCanonSources(
        sourceEntries.map((entry) => buildQueryCanonSource(root, entry.resumePath, entry.chapterTitle, "resume", "story state relationship delta")),
      ),
      notes: [],
    };
  }

  const relationshipEntries = Object.entries(allRelationships);
  if (relationshipEntries.length === 0) {
    return null;
  }

  const sourceEntries = storyStateEntriesUpTo(entries, throughChapter)
    .filter((entry) => Boolean(entry.stateChanges?.relationship_updates?.[target.id]))
    .slice(-3);

  return {
    answer: `${target.title}'s current relationships: ${joinQueryCanonList(
      relationshipEntries.map(([relatedId, value]) => `${formatQueryCanonValue(relatedId, lookup)} = ${humanizeQueryCanonToken(value)}`),
    )}.`,
    confidence: "high",
    intent: "state-relationship",
    sources: uniqueQueryCanonSources(
      sourceEntries.map((entry) => buildQueryCanonSource(root, entry.resumePath, entry.chapterTitle, "resume", "story state relationship delta")),
    ),
    notes: [],
  };
}

function answerConditionQuery(
  root: string,
  target: QueryCanonTarget | undefined,
  throughChapter: string | undefined,
  entries: StoryStateTimelineEntry[],
  lookup: QueryCanonLookup,
): QueryCanonAnswerDraft | null {
  if (!target) {
    return null;
  }

  const snapshotEntry = selectStoryStateEntry(entries, throughChapter);
  const conditions = snapshotEntry?.snapshot.conditions[target.id] ?? [];
  const wounds = snapshotEntry?.snapshot.wounds[target.id] ?? [];
  if (conditions.length === 0 && wounds.length === 0) {
    return null;
  }

  const sourceEntries = storyStateEntriesUpTo(entries, throughChapter)
    .filter((entry) => Boolean(entry.stateChanges?.conditions?.[target.id] || entry.stateChanges?.wounds?.[target.id]))
    .slice(-3);

  const parts = [
    conditions.length > 0 ? `conditions ${joinQueryCanonList(conditions.map((value) => humanizeQueryCanonToken(value)))}` : undefined,
    wounds.length > 0 ? `wounds ${joinQueryCanonList(wounds.map((value) => humanizeQueryCanonToken(value)))}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    answer: `${target.title} currently has ${parts.join(" and ")}${
      throughChapter ? ` by ${formatQueryCanonChapterLabel(throughChapter, lookup)}` : ""
    }.`,
    confidence: "high",
    intent: "state-condition",
    sources: uniqueQueryCanonSources(
      sourceEntries.map((entry) => buildQueryCanonSource(root, entry.resumePath, entry.chapterTitle, "resume", "story state condition delta")),
    ),
    notes: [],
  };
}

function answerOpenLoopsQuery(
  root: string,
  target: QueryCanonTarget | undefined,
  throughChapter: string | undefined,
  entries: StoryStateTimelineEntry[],
  lookup: QueryCanonLookup,
): QueryCanonAnswerDraft | null {
  const snapshotEntry = selectStoryStateEntry(entries, throughChapter);
  const openLoops = snapshotEntry?.snapshot.openLoops ?? [];
  if (openLoops.length === 0) {
    return null;
  }

  const filteredLoops = target
    ? filterOpenLoopsForTarget(openLoops, target)
    : openLoops;
  const effectiveLoops = filteredLoops.length > 0 ? filteredLoops : openLoops;

  const sourceEntries = storyStateEntriesUpTo(entries, throughChapter)
    .filter((entry) => Boolean(entry.stateChanges?.open_loops_add?.length || entry.stateChanges?.open_loops_resolved?.length))
    .slice(-3);

  return {
    answer: target && filteredLoops.length > 0
      ? `Open loops tied to ${target.title}: ${joinQueryCanonList(effectiveLoops.map((value) => humanizeQueryCanonToken(value)))}.`
      : `Current open loops${throughChapter ? ` by ${formatQueryCanonChapterLabel(throughChapter, lookup)}` : ""}: ${joinQueryCanonList(
          effectiveLoops.map((value) => humanizeQueryCanonToken(value)),
        )}.`,
    confidence: "high",
    intent: "state-open-loops",
    sources: uniqueQueryCanonSources(
      sourceEntries.map((entry) => buildQueryCanonSource(root, entry.resumePath, entry.chapterTitle, "resume", "story state open loops delta")),
    ),
    notes: target
      ? filteredLoops.length > 0
        ? ["Open loops are global state; this answer filters loops that mention the matched target."]
        : ["Open loops are global state; no target-specific loop matched cleanly, so this answer returns the global open-loop list."]
      : [],
  };
}

function answerRelationshipArcQuery(
  root: string,
  target: QueryCanonTarget | undefined,
  secondaryTarget: QueryCanonTarget | undefined,
  range: QueryCanonChapterRange | undefined,
  entries: StoryStateTimelineEntry[],
  lookup: QueryCanonLookup,
): QueryCanonAnswerDraft | null {
  if (!target || !range) {
    return null;
  }

  const selected = selectStoryStateRange(entries, range);
  if (!selected) {
    return null;
  }

  const rangeLabel = `${formatQueryCanonChapterLabel(range.startReference, lookup)} and ${formatQueryCanonChapterLabel(range.endReference, lookup)}`;

  if (secondaryTarget) {
    const startRelation = readRelationshipValue(selected.startEntry.snapshot, target.id, secondaryTarget.id);
    const endRelation = readRelationshipValue(selected.endEntry.snapshot, target.id, secondaryTarget.id);
    const changeEntries = selected.entries
      .filter(
        (entry) =>
          Boolean(entry.stateChanges?.relationship_updates?.[target.id]?.[secondaryTarget.id]) ||
          Boolean(entry.stateChanges?.relationship_updates?.[secondaryTarget.id]?.[target.id]),
      )
      .map((entry) => `${formatQueryCanonChapterLabel(`chapter:${entry.chapterSlug}`, lookup)}: ${formatRelationshipCheckpoint(entry.snapshot, target.id, secondaryTarget.id, lookup)}`)
      .filter(Boolean);

    if (!startRelation.value && !endRelation.value && changeEntries.length === 0) {
      return null;
    }

    const answer = startRelation.value === endRelation.value
      ? `Between ${rangeLabel}, the tracked relationship between ${target.title} and ${secondaryTarget.title} stays ${humanizeQueryCanonToken(endRelation.value ?? "untracked")}.`
      : !startRelation.value
        ? `Between ${rangeLabel}, a tracked relationship between ${target.title} and ${secondaryTarget.title} emerges as ${humanizeQueryCanonToken(endRelation.value ?? "untracked")}.`
        : !endRelation.value
          ? `Between ${rangeLabel}, the tracked relationship between ${target.title} and ${secondaryTarget.title} drops from ${humanizeQueryCanonToken(startRelation.value)} to no tracked state.`
          : `Between ${rangeLabel}, the tracked relationship between ${target.title} and ${secondaryTarget.title} shifts from ${humanizeQueryCanonToken(startRelation.value)} to ${humanizeQueryCanonToken(endRelation.value)}.`;

    return {
      answer: `${answer}${changeEntries.length > 0 ? ` Notable updates: ${changeEntries.join("; ")}.` : ""}`,
      confidence: "high",
      intent: "state-relationship-arc",
      sources: uniqueQueryCanonSources(
        selected.entries
          .filter(
            (entry) =>
              Boolean(entry.stateChanges?.relationship_updates?.[target.id]?.[secondaryTarget.id]) ||
              Boolean(entry.stateChanges?.relationship_updates?.[secondaryTarget.id]?.[target.id]),
          )
          .map((entry) => buildQueryCanonSource(root, entry.resumePath, entry.chapterTitle, "resume", "story state relationship delta")),
      ),
      notes: [],
    };
  }

  const startRelationships = selected.startEntry.snapshot.relationships[target.id] ?? {};
  const endRelationships = selected.endEntry.snapshot.relationships[target.id] ?? {};
  if (Object.keys(startRelationships).length === 0 && Object.keys(endRelationships).length === 0) {
    return null;
  }

  return {
    answer: `Between ${rangeLabel}, ${target.title}'s tracked relationships move from ${formatRelationshipMap(startRelationships, lookup)} to ${formatRelationshipMap(endRelationships, lookup)}.`,
    confidence: "high",
    intent: "state-relationship-arc",
    sources: uniqueQueryCanonSources(
      selected.entries
        .filter((entry) => Boolean(entry.stateChanges?.relationship_updates?.[target.id]))
        .map((entry) => buildQueryCanonSource(root, entry.resumePath, entry.chapterTitle, "resume", "story state relationship delta")),
    ),
    notes: [],
  };
}

function answerConditionArcQuery(
  root: string,
  target: QueryCanonTarget | undefined,
  range: QueryCanonChapterRange | undefined,
  entries: StoryStateTimelineEntry[],
  lookup: QueryCanonLookup,
): QueryCanonAnswerDraft | null {
  if (!target || !range) {
    return null;
  }

  const selected = selectStoryStateRange(entries, range);
  if (!selected) {
    return null;
  }

  const startState = formatConditionCheckpoint(selected.startEntry.snapshot, target.id);
  const endState = formatConditionCheckpoint(selected.endEntry.snapshot, target.id);
  const changeEntries = selected.entries
    .filter((entry) => Boolean(entry.stateChanges?.conditions?.[target.id] || entry.stateChanges?.wounds?.[target.id]))
    .map((entry) => `${formatQueryCanonChapterLabel(`chapter:${entry.chapterSlug}`, lookup)}: ${formatConditionCheckpoint(entry.snapshot, target.id)}`)
    .filter((value) => !value.endsWith(": no tracked conditions or wounds"));

  if (startState === "no tracked conditions or wounds" && endState === "no tracked conditions or wounds" && changeEntries.length === 0) {
    return null;
  }

  const rangeLabel = `${formatQueryCanonChapterLabel(range.startReference, lookup)} and ${formatQueryCanonChapterLabel(range.endReference, lookup)}`;
  const answer = startState === endState
    ? `Between ${rangeLabel}, ${target.title}'s tracked condition state stays ${endState}.`
    : `Between ${rangeLabel}, ${target.title}'s tracked condition state moves from ${startState} to ${endState}.`;

  return {
    answer: `${answer}${changeEntries.length > 0 ? ` Notable updates: ${changeEntries.join("; ")}.` : ""}`,
    confidence: "high",
    intent: "state-condition-arc",
    sources: uniqueQueryCanonSources(
      selected.entries
        .filter((entry) => Boolean(entry.stateChanges?.conditions?.[target.id] || entry.stateChanges?.wounds?.[target.id]))
        .map((entry) => buildQueryCanonSource(root, entry.resumePath, entry.chapterTitle, "resume", "story state condition delta")),
    ),
    notes: [],
  };
}

function answerOpenLoopsArcQuery(
  root: string,
  target: QueryCanonTarget | undefined,
  range: QueryCanonChapterRange | undefined,
  entries: StoryStateTimelineEntry[],
  lookup: QueryCanonLookup,
): QueryCanonAnswerDraft | null {
  if (!range) {
    return null;
  }

  const selected = selectStoryStateRange(entries, range);
  if (!selected) {
    return null;
  }

  const startLoops = target
    ? filterOpenLoopsForTarget(selected.startEntry.snapshot.openLoops, target)
    : selected.startEntry.snapshot.openLoops;
  const endLoops = target
    ? filterOpenLoopsForTarget(selected.endEntry.snapshot.openLoops, target)
    : selected.endEntry.snapshot.openLoops;
  const opened = uniqueValues(
    selected.entries.flatMap((entry) => {
      const values = entry.stateChanges?.open_loops_add ?? [];
      return target ? filterOpenLoopsForTarget(values, target) : values;
    }),
  );
  const resolved = uniqueValues(
    selected.entries.flatMap((entry) => {
      const values = entry.stateChanges?.open_loops_resolved ?? [];
      return target ? filterOpenLoopsForTarget(values, target) : values;
    }),
  );

  const effectiveStartLoops = startLoops.length > 0 || !target ? startLoops : selected.startEntry.snapshot.openLoops;
  const effectiveEndLoops = endLoops.length > 0 || !target ? endLoops : selected.endEntry.snapshot.openLoops;
  const effectiveOpened = opened.length > 0 || !target
    ? opened
    : uniqueValues(selected.entries.flatMap((entry) => entry.stateChanges?.open_loops_add ?? []));
  const effectiveResolved = resolved.length > 0 || !target
    ? resolved
    : uniqueValues(selected.entries.flatMap((entry) => entry.stateChanges?.open_loops_resolved ?? []));

  if (effectiveStartLoops.length === 0 && effectiveEndLoops.length === 0 && effectiveOpened.length === 0 && effectiveResolved.length === 0) {
    return null;
  }

  const rangeLabel = `${formatQueryCanonChapterLabel(range.startReference, lookup)} and ${formatQueryCanonChapterLabel(range.endReference, lookup)}`;
  const usedTargetFilter = Boolean(target && (startLoops.length > 0 || endLoops.length > 0 || opened.length > 0 || resolved.length > 0));
  const scopeLabel = usedTargetFilter ? `open loops tied to ${target?.title}` : "global open loops";

  return {
    answer: `Between ${rangeLabel}, ${scopeLabel} move from ${joinQueryCanonList(effectiveStartLoops.map((value) => humanizeQueryCanonToken(value)))} to ${joinQueryCanonList(effectiveEndLoops.map((value) => humanizeQueryCanonToken(value)))}.${effectiveOpened.length > 0 ? ` Opened: ${joinQueryCanonList(effectiveOpened.map((value) => humanizeQueryCanonToken(value)))}.` : ""}${effectiveResolved.length > 0 ? ` Resolved: ${joinQueryCanonList(effectiveResolved.map((value) => humanizeQueryCanonToken(value)))}.` : ""}`,
    confidence: "high",
    intent: "state-open-loops-arc",
    sources: uniqueQueryCanonSources(
      selected.entries
        .filter((entry) => Boolean(entry.stateChanges?.open_loops_add?.length || entry.stateChanges?.open_loops_resolved?.length))
        .map((entry) => buildQueryCanonSource(root, entry.resumePath, entry.chapterTitle, "resume", "story state open loops delta")),
    ),
    notes: target
      ? usedTargetFilter
        ? ["Open loops are global state; this answer filters loops that mention the matched target."]
        : ["Open loops are global state; no target-specific loop matched cleanly, so this answer returns the global open-loop changes for the chapter range."]
      : [],
  };
}

function answerSecretHoldersQuery(
  root: string,
  target: QueryCanonTarget | undefined,
  lookup: QueryCanonLookup,
): QueryCanonAnswerDraft | null {
  if (!target || target.kind !== "secret") {
    return null;
  }

  const holders = normalizeStringArray(target.metadata.holders) ?? [];
  if (holders.length === 0) {
    return null;
  }

  const knownFrom = normalizeOptionalString(target.metadata.known_from);
  const revealIn = normalizeOptionalString(target.metadata.reveal_in);
  const timingNote = [
    knownFrom ? `Known from ${formatQueryCanonChapterLabel(knownFrom, lookup)}` : undefined,
    revealIn ? `revealed in ${formatQueryCanonChapterLabel(revealIn, lookup)}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("; ");

  return {
    answer: `Known holders for ${target.title}: ${joinQueryCanonList(
      holders.map((value) => formatQueryCanonValue(value, lookup)),
    )}.${timingNote ? ` ${timingNote}.` : ""}`,
    confidence: "high",
    intent: "secret-holders",
    sources: [buildQueryCanonSource(root, target.path, target.title, target.kind, "secret metadata")],
    notes: [],
  };
}

async function answerFirstAppearanceQuery(
  root: string,
  question: string,
  target: QueryCanonTarget | undefined,
  throughChapter: string | undefined,
  chapters: Array<{ slug: string; path: string; metadata: ChapterFrontmatter }>,
  lookup: QueryCanonLookup,
): Promise<QueryCanonAnswerDraft | null> {
  if (target) {
    const introducedIn = normalizeOptionalString(target.metadata.introduced_in);
    if (introducedIn) {
      return {
        answer: `${target.title} first appears in ${formatQueryCanonChapterLabel(introducedIn, lookup)}.`,
        confidence: "high",
        intent: "first-appearance",
        sources: [buildQueryCanonSource(root, target.path, target.title, target.kind, "introduced_in metadata")],
        notes: [],
      };
    }
  }

  const terms = buildQueryCanonSearchTerms(question, target);
  const mention = await findFirstCanonMention(root, chapters, terms, throughChapter);
  if (!mention) {
    return target
      ? {
          answer: `I could not find a first appearance for ${target.title}${
            throughChapter ? ` up to ${formatQueryCanonChapterLabel(throughChapter, lookup)}` : ""
          }.`,
          confidence: "low",
          intent: "first-appearance",
          sources: [buildQueryCanonSource(root, target.path, target.title, target.kind, "target file")],
          notes: ["Search fell back to text and resume matching."],
        }
      : null;
  }

  return {
    answer: `${target?.title ?? formatQueryCanonSubject(question)} first appears in Chapter ${formatOrdinal(
      mention.chapterNumber,
    )} ${mention.chapterTitle}.`,
    confidence: target ? "high" : "medium",
    intent: "first-appearance",
    sources: [mention.source],
    notes: [],
  };
}

function answerGeneralTargetQuery(
  root: string,
  target: QueryCanonTarget | undefined,
  lookup: QueryCanonLookup,
): QueryCanonAnswerDraft | null {
  if (!target) {
    return null;
  }

  if (target.kind === "chapter") {
    const summary =
      normalizeOptionalString(target.metadata.summary) ?? summarizeText(target.body, 240) ?? "No summary is recorded yet.";
    return {
      answer: `${target.title} is ${formatQueryCanonChapterLabel(target.id, lookup)}. ${summary}`,
      confidence: "medium",
      intent: "general",
      sources: [buildQueryCanonSource(root, target.path, target.title, "chapter", "chapter metadata and body")],
      notes: [],
    };
  }

  const details = [
    typeof target.metadata.current_identity === "string" ? `Current identity: ${target.metadata.current_identity}` : undefined,
    typeof target.metadata.background_summary === "string" ? `Background: ${target.metadata.background_summary}` : undefined,
    typeof target.metadata.function_in_book === "string" ? `Function in book: ${target.metadata.function_in_book}` : undefined,
    typeof target.metadata.speaking_style === "string" ? `Voice: ${target.metadata.speaking_style}` : undefined,
    typeof target.metadata.appearance === "string" ? `Appearance: ${target.metadata.appearance}` : undefined,
    typeof target.metadata.purpose === "string" ? `Purpose: ${target.metadata.purpose}` : undefined,
    typeof target.metadata.atmosphere === "string" ? `Atmosphere: ${target.metadata.atmosphere}` : undefined,
    typeof target.metadata.mission === "string" ? `Mission: ${target.metadata.mission}` : undefined,
    typeof target.metadata.ideology === "string" ? `Ideology: ${target.metadata.ideology}` : undefined,
    typeof target.metadata.stakes === "string" ? `Stakes: ${target.metadata.stakes}` : undefined,
    typeof target.metadata.significance === "string" ? `Significance: ${target.metadata.significance}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    answer: `${target.title} is a ${target.kind}. ${details.slice(0, 3).join(" ") || summarizeText(target.body, 260) || "No concise canon summary is available yet."}`,
    confidence: details.length > 0 ? "medium" : "low",
    intent: "general",
    sources: [buildQueryCanonSource(root, target.path, target.title, target.kind, "canon metadata")],
    notes: [],
  };
}

async function answerFallbackCanonQuery(
  root: string,
  question: string,
  target: QueryCanonTarget | undefined,
  limit: number,
): Promise<QueryCanonAnswerDraft> {
  const subject = (target?.title ?? formatQueryCanonSubject(question)) || question;
  const hits = await searchBook(root, subject, { limit });

  if (hits.length === 0) {
    return {
      answer: `I could not answer that from the current canon for "${subject}".`,
      confidence: "low",
      intent: "general",
      sources: [],
      notes: [target ? `No direct structured or metadata answer was found for ${target.id}.` : "No direct target matched in current canon."],
    };
  }

  return {
    answer: `Closest canon matches for "${subject}": ${hits
      .slice(0, 3)
      .map((hit) => `${hit.title} (${hit.type})`)
      .join("; ")}.`,
    confidence: target ? "medium" : "low",
    intent: "general",
    sources: uniqueQueryCanonSources(
      hits.map((hit) => ({
        path: hit.path,
        title: hit.title,
        type: hit.type,
        reason: "search hit",
      })),
    ),
    notes: [target ? `No direct structured answer was found for ${target.id}; falling back to repository search.` : "Falling back to repository search."],
  };
}

function selectStoryStateEntry(
  entries: StoryStateTimelineEntry[],
  throughChapter: string | undefined,
): StoryStateTimelineEntry | undefined {
  if (!throughChapter) {
    return entries.at(-1);
  }

  const chapterSlug = normalizeChapterReference(throughChapter);
  return entries.find((entry) => entry.chapterSlug === chapterSlug);
}

function storyStateEntriesUpTo(
  entries: StoryStateTimelineEntry[],
  throughChapter: string | undefined,
): StoryStateTimelineEntry[] {
  if (!throughChapter) {
    return entries;
  }

  const chapterSlug = normalizeChapterReference(throughChapter);
  const index = entries.findIndex((entry) => entry.chapterSlug === chapterSlug);
  return index === -1 ? entries : entries.slice(0, index + 1);
}

function selectStoryStateRange(
  entries: StoryStateTimelineEntry[],
  range: QueryCanonChapterRange,
): { startEntry: StoryStateTimelineEntry; endEntry: StoryStateTimelineEntry; entries: StoryStateTimelineEntry[] } | null {
  const startSlug = normalizeChapterReference(range.startReference);
  const endSlug = normalizeChapterReference(range.endReference);
  const startIndex = entries.findIndex((entry) => entry.chapterSlug === startSlug);
  const endIndex = entries.findIndex((entry) => entry.chapterSlug === endSlug);

  if (startIndex === -1 || endIndex === -1) {
    return null;
  }

  return {
    startEntry: entries[startIndex],
    endEntry: entries[endIndex],
    entries: entries.slice(startIndex, endIndex + 1),
  };
}

function readRelationshipValue(
  snapshot: StoryStateSnapshot,
  primaryId: string,
  secondaryId: string,
): { value?: string; direction: "direct" | "reverse" | null } {
  const direct = snapshot.relationships[primaryId]?.[secondaryId];
  if (direct) {
    return { value: direct, direction: "direct" };
  }

  const reverse = snapshot.relationships[secondaryId]?.[primaryId];
  if (reverse) {
    return { value: reverse, direction: "reverse" };
  }

  return { direction: null };
}

function formatRelationshipCheckpoint(
  snapshot: StoryStateSnapshot,
  primaryId: string,
  secondaryId: string,
  lookup: QueryCanonLookup,
): string {
  const relation = readRelationshipValue(snapshot, primaryId, secondaryId);
  if (!relation.value) {
    return "no tracked relationship";
  }

  return relation.direction === "direct"
    ? `${formatQueryCanonValue(primaryId, lookup)} -> ${formatQueryCanonValue(secondaryId, lookup)} = ${humanizeQueryCanonToken(relation.value)}`
    : `${formatQueryCanonValue(secondaryId, lookup)} -> ${formatQueryCanonValue(primaryId, lookup)} = ${humanizeQueryCanonToken(relation.value)}`;
}

function formatRelationshipMap(
  relationships: Record<string, string>,
  lookup: QueryCanonLookup,
): string {
  const entries = Object.entries(relationships).map(
    ([relatedId, value]) => `${formatQueryCanonValue(relatedId, lookup)} = ${humanizeQueryCanonToken(value)}`,
  );
  return joinQueryCanonList(entries);
}

function formatConditionCheckpoint(snapshot: StoryStateSnapshot, targetId: string): string {
  const conditions = snapshot.conditions[targetId] ?? [];
  const wounds = snapshot.wounds[targetId] ?? [];
  const parts = [
    conditions.length > 0 ? `conditions ${joinQueryCanonList(conditions.map((value) => humanizeQueryCanonToken(value)))}` : undefined,
    wounds.length > 0 ? `wounds ${joinQueryCanonList(wounds.map((value) => humanizeQueryCanonToken(value)))}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join(" and ") : "no tracked conditions or wounds";
}

async function findFirstCanonMention(
  root: string,
  chapters: Array<{ slug: string; path: string; metadata: ChapterFrontmatter }>,
  terms: string[],
  throughChapter: string | undefined,
): Promise<{ chapterNumber: number; chapterTitle: string; source: QueryCanonSource } | null> {
  const relevantChapters = storyStateEntriesUpTo(
    chapters.map((chapter) => ({
      chapterSlug: chapter.slug,
      chapterNumber: chapter.metadata.number,
      chapterTitle: chapter.metadata.title,
      resumePath: path.join(root, "resumes", "chapters", `${chapter.slug}.md`),
      chapterPath: chapter.path,
      snapshot: createEmptyStoryStateSnapshot(),
    })),
    throughChapter,
  );

  for (const chapter of relevantChapters) {
    const chapterData = await readChapter(root, chapter.chapterSlug);
    if (documentMatchesQueryCanonTerms(JSON.stringify(chapterData.metadata), chapterData.body, terms)) {
      return {
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.chapterTitle,
        source: buildQueryCanonSource(root, chapter.chapterPath, chapter.chapterTitle, "chapter", "chapter mention"),
      };
    }

    for (const paragraph of chapterData.paragraphs) {
      if (documentMatchesQueryCanonTerms(JSON.stringify(paragraph.metadata), paragraph.body, terms)) {
        return {
          chapterNumber: chapter.chapterNumber,
          chapterTitle: chapter.chapterTitle,
          source: buildQueryCanonSource(
            root,
            paragraph.path,
            paragraph.metadata.title,
            "paragraph",
            "paragraph mention",
          ),
        };
      }
    }

    const resume = await readLooseMarkdownIfExists(chapter.resumePath);
    if (resume && documentMatchesQueryCanonTerms(JSON.stringify(resume.frontmatter), resume.body, terms)) {
      return {
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.chapterTitle,
        source: buildQueryCanonSource(root, chapter.resumePath, chapter.chapterTitle, "resume", "chapter resume mention"),
      };
    }
  }

  return null;
}

function documentMatchesQueryCanonTerms(frontmatterText: string, body: string, terms: string[]): boolean {
  const combinedNormalized = normalizeQueryCanonSearch(`${frontmatterText}\n${body}`);
  const combinedLower = `${frontmatterText}\n${body}`.toLowerCase();
  return terms.some((term) => {
    const normalizedTerm = normalizeQueryCanonSearch(term);
    if (!normalizedTerm) {
      return false;
    }

    return term.includes(":") ? combinedLower.includes(term.toLowerCase()) : combinedNormalized.includes(normalizedTerm);
  });
}

function buildQueryCanonSearchTerms(question: string, target: QueryCanonTarget | undefined): string[] {
  if (target) {
    return uniqueValues(
      [
        target.id,
        target.title,
        ...target.aliases,
        target.id.includes(":") ? humanizeQueryCanonToken(target.id.split(":").at(-1) ?? target.id) : undefined,
      ].filter((value): value is string => Boolean(value && value.trim())),
    );
  }

  const subject = formatQueryCanonSubject(question);
  return subject ? [subject] : [question];
}

function filterOpenLoopsForTarget(openLoops: string[], target: QueryCanonTarget): string[] {
  const terms = buildQueryCanonSearchTerms(target.title, target).map((value) => normalizeQueryCanonSearch(value));

  return openLoops.filter((loop) => {
    const normalizedLoop = normalizeQueryCanonSearch(loop);
    return terms.some((term) => term && normalizedLoop.includes(term));
  });
}

function formatQueryCanonSubject(question: string, lexicon: QueryCanonLexicon = resolveQueryCanonLexicon("en")): string {
  const quoted = question.match(/["'“”](.+?)["'“”]/)?.[1];
  if (quoted) {
    return quoted.trim();
  }

  const stopWordsPattern = buildAlternationPattern(lexicon.stopWords);
  const chapterAliasPattern = buildAlternationPattern(lexicon.chapterAliases);
  return question
    .replace(new RegExp(`\\b(?:${stopWordsPattern})\\b`, "gi"), " ")
    .replace(new RegExp(`\\b(?:${chapterAliasPattern})\\s*\d{1,3}\\b`, "gi"), " ")
    .replace(/[?!.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesKnowledgeIntent(lower: string, lexicon: QueryCanonLexicon): boolean {
  if (/what does .* know|what .* knows|knows after|know after/i.test(lower)) {
    return true;
  }

  return new RegExp(buildAlternationPattern(lexicon.knowledgePhrases), "i").test(lower);
}

function matchesInventoryIntent(lower: string, lexicon: QueryCanonLexicon): boolean {
  if (/what does .* have|what .* carries|is carrying/i.test(lower)) {
    return true;
  }

  return new RegExp(buildAlternationPattern(lexicon.inventoryPhrases), "i").test(lower);
}

function formatQueryCanonValue(value: string, lookup: QueryCanonLookup): string {
  if (lookup.targetsById.has(value)) {
    return lookup.targetsById.get(value)?.title ?? value;
  }

  if (lookup.chaptersByRef.has(value)) {
    return formatQueryCanonChapterLabel(value, lookup);
  }

  return humanizeQueryCanonToken(value);
}

function formatQueryCanonChapterLabel(reference: string, lookup: QueryCanonLookup): string {
  const direct = lookup.chaptersByRef.get(reference);
  if (direct) {
    return `Chapter ${formatOrdinal(direct.number)} ${direct.title}`;
  }

  const normalized = reference.startsWith("chapter:") ? reference : `chapter:${normalizeChapterReference(reference)}`;
  const resolved = lookup.chaptersByRef.get(normalized);
  if (resolved) {
    return `Chapter ${formatOrdinal(resolved.number)} ${resolved.title}`;
  }

  return humanizeQueryCanonToken(reference);
}

function humanizeQueryCanonToken(value: string): string {
  const bare = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
  return bare.replace(/[_-]+/g, " ").trim() || value;
}

function joinQueryCanonList(values: string[]): string {
  if (values.length === 0) {
    return "nothing tracked yet";
  }

  if (values.length === 1) {
    return values[0];
  }

  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }

  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function buildQueryCanonSource(
  root: string,
  filePath: string,
  title: string,
  type: string,
  reason: string,
): QueryCanonSource {
  return {
    path: toPosixPath(path.relative(root, filePath)),
    title,
    type,
    reason,
  };
}

function uniqueQueryCanonSources(sources: QueryCanonSource[]): QueryCanonSource[] {
  const seen = new Set<string>();
  const results: QueryCanonSource[] = [];

  for (const source of sources) {
    const key = `${source.path}::${source.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(source);
  }

  return results;
}

function normalizeQueryCanonSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveRevisionPrimaryTarget(
  targets: QueryCanonTarget[],
  viewpoint: string | undefined,
  pov: string[] | undefined,
  body: string,
): QueryCanonTarget | undefined {
  for (const candidate of [viewpoint, ...(pov ?? [])].filter((value): value is string => Boolean(value && value.trim()))) {
    const direct = targets.find((target) => target.id === candidate);
    if (direct) {
      return direct;
    }

    const resolved = resolveQueryCanonTarget(targets.filter((target) => target.kind !== "chapter"), candidate, candidate);
    if (resolved.target) {
      return resolved.target;
    }
  }

  return findMatchedTargetsInText(targets.filter((target) => target.kind === "character"), body)[0];
}

function findMatchedTargetsInText(targets: QueryCanonTarget[], text: string): QueryCanonTarget[] {
  const normalizedText = normalizeQueryCanonSearch(text);
  const lowerText = text.toLowerCase();

  return targets
    .map((target) => {
      let score = lowerText.includes(target.id.toLowerCase()) ? 200 : 0;

      for (const candidate of uniqueValues([target.title, ...target.aliases])) {
        const normalizedCandidate = normalizeQueryCanonSearch(candidate);
        if (!normalizedCandidate) continue;

        if (normalizedText.includes(normalizedCandidate)) {
          score = Math.max(score, 80 + normalizedCandidate.length);
        }
      }

      return { target, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.target);
}

function reviseMarkdownBody(
  body: string,
  options: {
    mode: RevisionMode;
    intensity: RevisionIntensity;
    preserveFacts: boolean;
    viewpointLabel?: string;
  },
): ParagraphRevisionProposal {
  const blocks = body.trim().split(/\n\s*\n/);
  const notes: string[] = [];

  const revisedBlocks = blocks.map((block) => {
    const trimmed = block.trim();
    if (!trimmed || !isRevisionProseBlock(trimmed)) {
      return trimmed;
    }

    const revised = reviseProseBlock(trimmed, options);
    notes.push(...revised.notes);
    return revised.body;
  });

  return {
    body: revisedBlocks.join("\n\n").trim(),
    notes: uniqueValues(notes),
  };
}

function isRevisionProseBlock(block: string): boolean {
  return !/^(?:#{1,6}\s|```|[-*+]\s|\d+\.\s|>\s|\||!\[)/.test(block.trim());
}

function reviseProseBlock(
  text: string,
  options: {
    mode: RevisionMode;
    intensity: RevisionIntensity;
    preserveFacts: boolean;
    viewpointLabel?: string;
  },
): ParagraphRevisionProposal {
  let revised = normalizeRevisionSpacing(text);
  const notes: string[] = [];

  const apply = (transform: (value: string) => string, note: string): void => {
    const next = normalizeRevisionSpacing(transform(revised));
    if (next !== revised) {
      revised = next;
      notes.push(note);
    }
  };

  switch (options.mode) {
    case "clarity":
      apply(tightenCommonPhrases, "Tightens common filler phrases and indirect constructions.");
      apply((value) => removeRevisionFillerWords(value, options.intensity), "Cuts softeners so the beat reads more directly.");
      apply((value) => breakLongRevisionSentences(value, options.intensity), "Breaks chained sentences earlier so the action stays readable.");
      apply(dropRepeatedSentences, "Trims repeated emphasis that slows the beat down.");
      break;
    case "pacing":
      apply((value) => removeRevisionFillerWords(value, options.intensity), "Cuts slow lead-ins to move faster into the turn of the scene.");
      apply((value) => breakLongRevisionSentences(value, options.intensity === "light" ? "medium" : "strong"), "Shortens sentence rhythm so the scene lands faster.");
      apply(dropRepeatedSentences, "Removes repeated beats that stall momentum.");
      break;
    case "dialogue":
      apply(tightenDialogueFormatting, "Separates dialogue beats so each line lands more clearly.");
      apply(tightenCommonPhrases, "Tightens narration around the spoken exchange.");
      break;
    case "voice":
      apply(tightenFilterVerbs, "Pulls back filter verbs so the viewpoint feels more immediate.");
      apply(tightenCommonPhrases, "Keeps the narration closer to the scene instead of summary distance.");
      if (options.viewpointLabel) {
        notes.push(`Keeps the phrasing anchored to ${options.viewpointLabel}.`);
      }
      break;
    case "tension":
      apply(strengthenSoftPhrases, "Sharpens soft emotional wording into cleaner pressure cues.");
      apply((value) => removeRevisionFillerWords(value, options.intensity), "Removes cushioning words so the pressure hits sooner.");
      apply((value) => breakLongRevisionSentences(value, options.intensity === "light" ? "medium" : "strong"), "Uses shorter sentence rhythm to keep tension tighter.");
      break;
    case "show-dont-tell":
      apply(tightenFilterVerbs, "Reduces filter verbs that summarize the moment from a distance.");
      apply(replaceShowDontTellPatterns, "Rephrases telling constructions into more immediate scene language.");
      break;
    case "redundancy":
      apply(dropRepeatedSentences, "Removes duplicated emphasis and repeated beat language.");
      apply(tightenCommonPhrases, "Compresses repeated support phrasing around the core beat.");
      apply((value) => removeRevisionFillerWords(value, options.intensity), "Drops extra modifiers that restate what the sentence already implies.");
      break;
  }

  revised = capitalizeRevisionSentenceStarts(revised);
  return {
    body: revised,
    notes: uniqueValues(notes),
  };
}

function buildRevisionEditorialNotes(input: {
  mode: RevisionMode;
  intensity: RevisionIntensity;
  originalBody: string;
  proposedBody: string;
  proposalNotes: string[];
  continuityImpact: RevisionContinuityImpact;
  primaryTarget?: string;
  previousParagraphTitle?: string;
  nextParagraphTitle?: string;
  preserveFacts: boolean;
}): string[] {
  const metrics = analyzeRevisionTextMetrics(input.originalBody);
  const notes = [
    `This ${input.mode} pass stays ${input.intensity} and ${input.preserveFacts ? "keeps story facts stable" : "allows broader surface reshaping"}.`,
    ...input.proposalNotes,
    ...(input.mode === "dialogue" && !metrics.hasDialogue
      ? ["No direct dialogue appears in this paragraph, so the proposal tightens narration and beat spacing instead of reworking spoken exchange."]
      : []),
    ...(["clarity", "pacing", "tension"].includes(input.mode) && metrics.averageWordsPerSentence >= 18
      ? ["The original paragraph leans on long sentence chains, so the proposal breaks the beat earlier for readability."]
      : []),
    ...(input.mode === "redundancy" && metrics.repeatedSentenceCount > 0
      ? ["The original paragraph repeats emphasis, so the proposal trims duplicate sentence work."]
      : []),
    ...(input.primaryTarget ? [`The revision keeps the paragraph anchored to ${input.primaryTarget}.`] : []),
    ...(input.previousParagraphTitle || input.nextParagraphTitle
      ? [
          `The handoff stays visible${
            input.previousParagraphTitle || input.nextParagraphTitle
              ? ` between ${input.previousParagraphTitle ?? "this beat"} and ${input.nextParagraphTitle ?? "the next beat"}`
              : ""
          }.`,
        ]
      : []),
    ...(input.continuityImpact !== "none"
      ? ["This paragraph touches continuity-sensitive beats, so review the suggested state_changes before applying the revision and syncing story state."]
      : []),
    ...(input.proposedBody === input.originalBody
      ? ["The proposal stays close to the original because the paragraph is already fairly tight at the selected intensity."]
      : []),
  ];

  return uniqueValues(notes).slice(0, 5);
}

function buildChapterRevisionDiagnosis(input: {
  chapterTitle: string;
  mode: RevisionMode;
  intensity: RevisionIntensity;
  preserveFacts: boolean;
  chapterBody: string;
  paragraphs: ReviseChapterSceneProposal[];
}): string[] {
  const changedParagraphs = input.paragraphs.filter((paragraph) => paragraph.changed);
  const continuitySensitive = input.paragraphs.filter((paragraph) => paragraph.continuityImpact !== "none");
  const combinedMetrics = analyzeRevisionTextMetrics(
    [input.chapterBody, ...input.paragraphs.map((paragraph) => paragraph.originalBody)].join("\n\n"),
  );
  const notes = [
    `${input.chapterTitle} has ${input.paragraphs.length} scene${input.paragraphs.length === 1 ? "" : "s"}; this ${input.mode} pass changes ${changedParagraphs.length || 0} of them at ${input.intensity} intensity.`,
    ...(combinedMetrics.averageWordsPerSentence >= 18 && ["clarity", "pacing", "tension"].includes(input.mode)
      ? ["Across the chapter, sentence chains run long enough that the pass concentrates on earlier turns and tighter beat breaks."]
      : []),
    ...(input.mode === "dialogue" && !combinedMetrics.hasDialogue
      ? ["The chapter has little direct dialogue, so the pass mostly tightens narration and beat spacing rather than line delivery."]
      : []),
    ...(continuitySensitive.length > 0
      ? ["At least one scene carries continuity-sensitive beats, so the revision suggests state_changes to review before any manual apply."]
      : []),
    ...(input.preserveFacts
      ? ["The pass stays conservative on story facts and focuses on presentation, rhythm, and local scene pressure."]
      : ["The pass allows broader surface reshaping, so continuity review matters even more before applying changes."]),
  ];

  return uniqueValues(notes).slice(0, 5);
}

function buildChapterRevisionPlan(paragraphs: ReviseChapterSceneProposal[]): string[] {
  const changedParagraphs = paragraphs.filter((paragraph) => paragraph.changed || paragraph.shouldReviewStateChanges);
  if (changedParagraphs.length === 0) {
    return ["No major scene rewrite stands out at this intensity; if you still want a pass, try a stronger intensity or a different mode."];
  }

  return changedParagraphs.slice(0, 6).map((paragraph, index) => {
    const leadNote = paragraph.editorialNotes.find((note) => !note.startsWith("This ")) ?? paragraph.editorialNotes[0] ?? "Refine the scene beat.";
    return `${index + 1}. Revise ${paragraph.title}: ${leadNote}`;
  });
}

function analyzeRevisionTextMetrics(text: string): {
  hasDialogue: boolean;
  averageWordsPerSentence: number;
  repeatedSentenceCount: number;
} {
  const prose = text
    .split(/\n\s*\n/)
    .filter((block) => isRevisionProseBlock(block.trim()))
    .join(" ");
  const sentences = splitRevisionSentences(prose);
  const repeated = new Set<string>();
  const seen = new Set<string>();

  for (const sentence of sentences) {
    const normalized = normalizeQueryCanonSearch(sentence);
    if (!normalized) continue;
    if (seen.has(normalized)) {
      repeated.add(normalized);
    }
    seen.add(normalized);
  }

  return {
    hasDialogue: /["“”]/.test(text),
    averageWordsPerSentence:
      sentences.length > 0
        ? Math.round(
            sentences.reduce((sum, sentence) => sum + sentence.split(/\s+/).filter(Boolean).length, 0) /
              sentences.length,
          )
        : 0,
    repeatedSentenceCount: repeated.size,
  };
}

function suggestParagraphStateChanges(
  body: string,
  options: {
    primaryTarget?: QueryCanonTarget;
    targets: QueryCanonTarget[];
    paragraphTitle: string;
    chapterTitle: string;
  },
): StoryStateChanges | undefined {
  const lower = body.toLowerCase();
  const matchedTargets = findMatchedTargetsInText(options.targets.filter((target) => target.kind !== "chapter"), body);
  const matchedLocations = matchedTargets.filter((target) => target.kind === "location");
  const matchedItems = matchedTargets.filter((target) => target.kind === "item");
  const matchedRelations = matchedTargets.filter(
    (target) =>
      (target.kind === "character" || target.kind === "faction") &&
      target.id !== options.primaryTarget?.id,
  );

  const suggestion: StoryStateChanges = {};

  if (options.primaryTarget && matchedLocations.length > 0 && /(arrive|arrived|reach|reached|enter|entered|leave|left|return|returned|stand|stood|wait|paused|inside|into|through|toward|towards|at |in )/.test(lower)) {
    suggestion.locations = {
      [options.primaryTarget.id]: matchedLocations[0].id,
    };
  }

  const knowledgeGains = extractRevisionKnowledgePhrases(body);
  if (options.primaryTarget && knowledgeGains.length > 0) {
    suggestion.knowledge_gain = {
      [options.primaryTarget.id]: knowledgeGains,
    };
  }

  const inventoryAdd = matchedItems
    .filter((target) => isRevisionVerbNearTarget(body, target, /(grabbed|took|takes|held|carry|carried|kept|keeps|pocketed|received|caught)/i))
    .map((target) => target.id);
  if (options.primaryTarget && inventoryAdd.length > 0) {
    suggestion.inventory_add = {
      [options.primaryTarget.id]: uniqueValues(inventoryAdd),
    };
  }

  const inventoryRemove = matchedItems
    .filter((target) => isRevisionVerbNearTarget(body, target, /(dropped|drop|lost|lose|handed|gave|left|set down|surrendered)/i))
    .map((target) => target.id);
  if (options.primaryTarget && inventoryRemove.length > 0) {
    suggestion.inventory_remove = {
      [options.primaryTarget.id]: uniqueValues(inventoryRemove),
    };
  }

  const relationshipValue = detectRevisionRelationshipValue(lower);
  if (options.primaryTarget && matchedRelations.length > 0 && relationshipValue) {
    suggestion.relationship_updates = {
      [options.primaryTarget.id]: {
        [matchedRelations[0].id]: relationshipValue,
      },
    };
  }

  const conditions = detectRevisionConditions(lower);
  if (options.primaryTarget && conditions.length > 0) {
    suggestion.conditions = {
      [options.primaryTarget.id]: conditions,
    };
  }

  const wounds = detectRevisionWounds(lower);
  if (options.primaryTarget && wounds.length > 0) {
    suggestion.wounds = {
      [options.primaryTarget.id]: wounds,
    };
  }

  const openLoopsAdd = extractRevisionOpenLoops(body, "add");
  if (openLoopsAdd.length > 0) {
    suggestion.open_loops_add = openLoopsAdd;
  }

  const openLoopsResolved = extractRevisionOpenLoops(body, "resolved");
  if (openLoopsResolved.length > 0) {
    suggestion.open_loops_resolved = openLoopsResolved;
  }

  return hasStoryStateChanges(suggestion)
    ? (compactFrontmatterPatch(suggestion as Record<string, unknown>) as StoryStateChanges)
    : undefined;
}

function classifyRevisionContinuityImpact(
  suggestedStateChanges: StoryStateChanges | undefined,
): RevisionContinuityImpact {
  if (!suggestedStateChanges) {
    return "none";
  }

  return suggestedStateChanges.locations || suggestedStateChanges.inventory_add || suggestedStateChanges.inventory_remove || suggestedStateChanges.relationship_updates || suggestedStateChanges.wounds || suggestedStateChanges.open_loops_add || suggestedStateChanges.open_loops_resolved
    ? "clear"
    : "possible";
}

function maxRevisionContinuityImpact(
  values: RevisionContinuityImpact[],
): RevisionContinuityImpact {
  if (values.includes("clear")) {
    return "clear";
  }
  if (values.includes("possible")) {
    return "possible";
  }
  return "none";
}

function mergeSuggestedStoryStateChanges(
  suggestions: Array<StoryStateChanges | undefined>,
): StoryStateChanges | undefined {
  const merged: StoryStateChanges = {};

  for (const suggestion of suggestions) {
    if (!suggestion) continue;

    merged.locations = mergeStringRecords(merged.locations, suggestion.locations);
    merged.knowledge_gain = mergeStringArrayRecords(merged.knowledge_gain, suggestion.knowledge_gain);
    merged.knowledge_loss = mergeStringArrayRecords(merged.knowledge_loss, suggestion.knowledge_loss);
    merged.inventory_add = mergeStringArrayRecords(merged.inventory_add, suggestion.inventory_add);
    merged.inventory_remove = mergeStringArrayRecords(merged.inventory_remove, suggestion.inventory_remove);
    merged.relationship_updates = mergeNestedStringRecords(merged.relationship_updates, suggestion.relationship_updates);
    merged.conditions = mergeStringArrayRecords(merged.conditions, suggestion.conditions);
    merged.wounds = mergeStringArrayRecords(merged.wounds, suggestion.wounds);
    merged.open_loops_add = uniqueValues([...(merged.open_loops_add ?? []), ...(suggestion.open_loops_add ?? [])]).sort((left, right) => left.localeCompare(right));
    merged.open_loops_resolved = uniqueValues([...(merged.open_loops_resolved ?? []), ...(suggestion.open_loops_resolved ?? [])]).sort((left, right) => left.localeCompare(right));
  }

  return hasStoryStateChanges(merged)
    ? (compactFrontmatterPatch(merged as Record<string, unknown>) as StoryStateChanges)
    : undefined;
}

function mergeStringRecords(
  base: Record<string, string> | undefined,
  addition: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !addition) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries({ ...(base ?? {}), ...(addition ?? {}) }).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function mergeStringArrayRecords(
  base: Record<string, string[]> | undefined,
  addition: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!base && !addition) {
    return undefined;
  }

  const keys = uniqueValues([...Object.keys(base ?? {}), ...Object.keys(addition ?? {})]).sort((left, right) => left.localeCompare(right));
  const merged = Object.fromEntries(
    keys.map((key) => [
      key,
      uniqueValues([...(base?.[key] ?? []), ...(addition?.[key] ?? [])]).sort((left, right) => left.localeCompare(right)),
    ]),
  );

  return merged;
}

function mergeNestedStringRecords(
  base: Record<string, Record<string, string>> | undefined,
  addition: Record<string, Record<string, string>> | undefined,
): Record<string, Record<string, string>> | undefined {
  if (!base && !addition) {
    return undefined;
  }

  const keys = uniqueValues([...Object.keys(base ?? {}), ...Object.keys(addition ?? {})]).sort((left, right) => left.localeCompare(right));
  const merged = Object.fromEntries(
    keys.map((key) => [
      key,
      Object.fromEntries(
        Object.entries({ ...(base?.[key] ?? {}), ...(addition?.[key] ?? {}) }).sort(([left], [right]) => left.localeCompare(right)),
      ),
    ]),
  );

  return merged;
}

function tightenCommonPhrases(text: string): string {
  return text
    .replace(/\bin order to\b/gi, "to")
    .replace(/\bdue to the fact that\b/gi, "because")
    .replace(/\bat that point\b/gi, "then")
    .replace(/\bin the event that\b/gi, "if")
    .replace(/\bwas able to\b/gi, "could")
    .replace(/\bit seemed that\b/gi, "")
    .replace(/\bit was clear that\b/gi, "");
}

function removeRevisionFillerWords(text: string, intensity: RevisionIntensity): string {
  const fillers =
    intensity === "light"
      ? ["very", "really", "quite"]
      : intensity === "medium"
        ? ["very", "really", "quite", "rather", "somewhat"]
        : ["very", "really", "quite", "rather", "somewhat", "just", "almost", "a little", "a bit", "suddenly"];

  return fillers.reduce(
    (current, filler) => current.replace(new RegExp(`\\b${escapeRegExp(filler)}\\b\\s*`, "gi"), ""),
    text,
  );
}

function breakLongRevisionSentences(text: string, intensity: RevisionIntensity): string {
  const threshold = intensity === "light" ? 24 : intensity === "medium" ? 18 : 14;

  return splitRevisionSentences(text)
    .map((sentence) => {
      const words = sentence.split(/\s+/).filter(Boolean);
      if (words.length < threshold) {
        return sentence.trim();
      }

      return sentence
        .replace(/,\s+(and|but|so)\s+/i, ". ")
        .replace(/;\s+/g, ". ")
        .replace(/:\s+/g, ". ")
        .trim();
    })
    .join(" ");
}

function dropRepeatedSentences(text: string): string {
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const sentence of splitRevisionSentences(text)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const normalized = normalizeQueryCanonSearch(trimmed);
    const opening = normalized.split(" ").slice(0, 5).join(" ");
    if (seen.has(normalized) || (opening && kept.some((entry) => normalizeQueryCanonSearch(entry).startsWith(opening)))) {
      continue;
    }
    seen.add(normalized);
    kept.push(trimmed);
  }

  return kept.join(" ");
}

function tightenDialogueFormatting(text: string): string {
  return text.replace(/(["”][^"“”]+["”][^.!?]*[.!?])\s+(?=["“])/g, "$1\n\n");
}

function tightenFilterVerbs(text: string): string {
  return text
    .replace(/\bcould see\b/gi, "saw")
    .replace(/\bcould hear\b/gi, "heard")
    .replace(/\bcould feel\b/gi, "felt")
    .replace(/(^|[.!?]\s+)(?:she|he|they|[A-Z][a-z]+)\s+(?:realized|noticed|understood|knew)\s+that\s+/g, "$1")
    .replace(/(^|[.!?]\s+)(?:she|he|they|[A-Z][a-z]+)\s+saw\s+that\s+/g, "$1");
}

function replaceShowDontTellPatterns(text: string): string {
  return text
    .replace(/\b((?:she|he|they|[A-Z][a-z]+))\s+felt\s+(tired|exhausted|alert|cornered|afraid|angry|cold|weak)\b/gi, "$1 was $2")
    .replace(/\b((?:she|he|they|[A-Z][a-z]+))\s+felt\s+like\s+/gi, "$1 ");
}

function strengthenSoftPhrases(text: string): string {
  return text
    .replace(/\bvery tired\b/gi, "exhausted")
    .replace(/\bvery afraid\b/gi, "shaken")
    .replace(/\bvery angry\b/gi, "furious")
    .replace(/\ba little\b/gi, "")
    .replace(/\ba bit\b/gi, "");
}

function splitRevisionSentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [text.trim()];
}

function normalizeRevisionSpacing(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

function capitalizeRevisionSentenceStarts(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_match, prefix: string, char: string) => `${prefix}${char.toUpperCase()}`);
}

function extractRevisionKnowledgePhrases(text: string): string[] {
  const patterns = [
    /\b(?:realized|noticed|learned|discovered|understood|knew)\s+that\s+([^.!?]+)/gi,
    /\b(?:learned|discovered|understood)\s+([^.!?]+)/gi,
  ];

  const phrases: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const normalized = normalizeRevisionStatePhrase(match[1]);
      if (normalized) {
        phrases.push(normalized);
      }
    }
  }

  return uniqueValues(phrases).slice(0, 3);
}

function detectRevisionRelationshipValue(text: string): string | undefined {
  if (/(wary|wariness|suspicious|distrust)/.test(text) && /(trust|trusted|trusting)/.test(text)) {
    return "wary-trust";
  }
  if (/(guarded|careful)/.test(text) && /(loyal|loyalty)/.test(text)) {
    return "guarded-loyalty";
  }
  if (/(trust|trusted|trusting)/.test(text)) {
    return "trusting";
  }
  if (/(wary|wariness|suspicious|distrust)/.test(text)) {
    return "wary";
  }
  if (/(ally|allied|side with)/.test(text)) {
    return "allied";
  }
  if (/(hostile|resent|resented|angry at|betray)/.test(text)) {
    return "hostile";
  }

  return undefined;
}

function detectRevisionConditions(text: string): string[] {
  const conditions = [
    ...(text.includes("alert") ? ["alert"] : []),
    ...(text.includes("cornered") ? ["cornered"] : []),
    ...(text.includes("focused") ? ["focused"] : []),
    ...(text.includes("steady") ? ["steady"] : []),
    ...(text.includes("shaken") || text.includes("afraid") ? ["shaken"] : []),
    ...(text.includes("tired") || text.includes("exhausted") ? ["exhausted"] : []),
  ];

  return uniqueValues(conditions);
}

function detectRevisionWounds(text: string): string[] {
  const wounds = [
    ...(text.includes("cut palm") || text.includes("cut hand") ? ["cut-palm"] : []),
    ...(text.includes("bleeding") ? ["bleeding"] : []),
    ...(text.includes("bruised") ? ["bruised"] : []),
    ...(text.includes("burned") || text.includes("burnt") ? ["burned"] : []),
    ...(text.includes("limping") ? ["limping"] : []),
    ...(text.includes("injured") || text.includes("wounded") ? ["injured"] : []),
  ];

  return uniqueValues(wounds);
}

function extractRevisionOpenLoops(text: string, mode: "add" | "resolved"): string[] {
  const patterns =
    mode === "add"
      ? [
          /\b(?:must|need to|needs to|needed to|has to|had to|promised to|swore to|vowed to|decided to|set out to)\s+([^.!?]+)/gi,
        ]
      : [
          /\b(?:finally|at last|managed to|succeeded in|finished|completed)\s+([^.!?]+)/gi,
        ];

  const phrases: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const normalized = normalizeRevisionStatePhrase(match[1]);
      if (normalized) {
        phrases.push(normalized);
      }
    }
  }

  return uniqueValues(phrases).slice(0, 3);
}

function normalizeRevisionStatePhrase(value: string): string | undefined {
  const cleaned = value
    .replace(/\b(?:the|a|an|that|before|after|while|because|when|she|he|they)\b/gi, " ")
    .replace(/[^a-z0-9\s-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return undefined;
  }

  const words = cleaned.split(" ").filter((word) => word.length >= 3).slice(0, 8);
  if (words.length === 0) {
    return undefined;
  }

  return slugify(words.join(" "));
}

function isRevisionVerbNearTarget(text: string, target: QueryCanonTarget, verbPattern: RegExp): boolean {
  const lower = text.toLowerCase();
  const verbSource = verbPattern.source;

  return uniqueValues([target.title, ...target.aliases]).some((candidate) => {
    const escaped = escapeRegExp(candidate.toLowerCase());
    if (!escaped) {
      return false;
    }

    const pattern = new RegExp(`(?:${verbSource})[^.!?]{0,60}\\b${escaped}\\b|\\b${escaped}\\b[^.!?]{0,60}(?:${verbSource})`, "i");
    return pattern.test(lower);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function renderEpubAssetFigure(
  asset:
    | {
        metadata: AssetFrontmatter;
        imagePath: string;
        imageExists: boolean;
      }
    | null,
  alt: string,
): string {
  if (!asset?.imageExists) {
    return "";
  }

  const caption = typeof asset.metadata.caption === "string" && asset.metadata.caption.trim()
    ? `<figcaption>${escapeHtml(asset.metadata.caption)}</figcaption>`
    : "";
  const figureAlt = typeof asset.metadata.alt_text === "string" && asset.metadata.alt_text.trim() ? asset.metadata.alt_text : alt;

  return `<figure class="epub-figure epub-figure-full"><img src="${pathToFileURL(asset.imagePath).href}" alt="${escapeHtml(figureAlt)}" />${caption}</figure>`;
}

function renderEpubOpeningPage(input: {
  title: string;
  author: string;
  language: string;
  chapterCount: number;
  coverAsset:
    | {
        metadata: AssetFrontmatter;
        imagePath: string;
        imageExists: boolean;
      }
    | null;
}): string {
  return [
    "<article>",
    `<h1>${escapeHtml(input.title)}</h1>`,
    `<p><strong>Author:</strong> ${escapeHtml(input.author)}</p>`,
    `<p><strong>Language:</strong> ${escapeHtml(input.language)}</p>`,
    `<p><strong>Chapters:</strong> ${input.chapterCount}</p>`,
    renderEpubAssetFigure(input.coverAsset, `${input.title} cover`),
    "</article>",
  ].join("");
}

async function renderEpubCanonIndex(root: string): Promise<string> {
  const groups = await Promise.all([
    buildEpubCanonSection(root, "character", "Characters"),
    buildEpubCanonSection(root, "location", "Locations"),
    buildEpubCanonSection(root, "faction", "Factions"),
    buildEpubCanonSection(root, "item", "Items"),
    buildEpubCanonSection(root, "timeline-event", "Timeline"),
  ]);
  const sections = groups.filter(Boolean);
  if (sections.length === 0) {
    return "";
  }

  return `<article><h1>Canon Index</h1>${sections.join("")}</article>`;
}

async function buildEpubCanonSection(root: string, kind: EntityType, heading: string): Promise<string> {
  const entities = await listEntities(root, kind);
  if (entities.length === 0) {
    return "";
  }

  const rows = entities.map((entity) => {
    const label = String(entity.metadata.name ?? entity.metadata.title ?? entity.slug);
    const summary = summarizeText(
      typeof entity.metadata.function_in_book === "string"
        ? entity.metadata.function_in_book
        : typeof entity.metadata.significance === "string"
          ? entity.metadata.significance
          : entity.body,
      180,
    );
    return `<li><strong>${escapeHtml(label)}</strong>${summary ? ` - ${escapeHtml(summary)}` : ""}</li>`;
  });

  return `<section><h2>${escapeHtml(heading)}</h2><ul>${rows.join("")}</ul></section>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function writeWikipediaResearchSnapshot(
  rootPath: string,
  options: {
    title: string;
    pageUrl: string;
    slug?: string;
    summary: string;
    secondarySummary?: string;
    secondaryPageUrl?: string;
    secondaryLang?: string;
    wikidataSection?: string;
    body?: string;
  },
): Promise<string> {
  const root = path.resolve(rootPath);
  const slug = options.slug ?? slugify(options.title);
  const filePath = path.join(root, "research", "wikipedia", `${slug}.md`);
  const secondaryLangLabel = options.secondaryLang ? options.secondaryLang.toUpperCase() : "IT";
  const language = options.secondarySummary ? `en+${(options.secondaryLang ?? "it").toLowerCase()}` : "en";

  await mkdir(path.dirname(filePath), { recursive: true });

  const existingRaw = await readFile(filePath, "utf8").catch(() => null);

  let notesSection: string;
  if (existingRaw && options.secondarySummary) {
    // File exists: enrich with secondary language section and/or wikidata if not already present
    let enriched = existingRaw;
    let modified = false;

    if (!existingRaw.includes(`# Summary (${secondaryLangLabel})`) && !existingRaw.includes("# Summary (English)")) {
      enriched = enriched.trimEnd() + `\n\n# Summary (${secondaryLangLabel})\n\n${options.secondarySummary}${options.secondaryPageUrl ? `\n\nSource: ${options.secondaryPageUrl}` : ""}`;
      modified = true;
    }

    if (options.wikidataSection && !existingRaw.includes("# Structured Data (Wikidata)")) {
      enriched = enriched.trimEnd() + `\n\n# Structured Data (Wikidata)\n\n${options.wikidataSection}`;
      modified = true;
    }

    if (!modified) return filePath;
    await writeFile(filePath, enriched, "utf8");
    return filePath;
  }

  let bodyContent = options.body ?? "Add extracted facts and relevance here.";
  if (options.secondarySummary) {
    bodyContent += `\n\n# Summary (${secondaryLangLabel})\n\n${options.secondarySummary}${options.secondaryPageUrl ? `\n\nSource: ${options.secondaryPageUrl}` : ""}`;
  }
  if (options.wikidataSection) {
    bodyContent += `\n\n# Structured Data (Wikidata)\n\n${options.wikidataSection}`;
  }
  notesSection = bodyContent;

  await writeFile(
    filePath,
    renderMarkdown(
      researchNoteSchema.parse({
        type: "research-note",
        id: `research:wikipedia:${slug}`,
        title: options.title,
        language,
        source_url: options.pageUrl,
        retrieved_at: new Date().toISOString(),
      }),
      `# Summary\n\n${options.summary}\n\n# Notes\n\n${notesSection}`,
    ),
    "utf8",
  );

  return filePath;
}

export async function findWikipediaResearchSnapshot(
  rootPath: string,
  options: {
    title: string;
    slug?: string;
  },
): Promise<WikipediaResearchSnapshot | null> {
  const root = path.resolve(rootPath);
  const researchRoot = path.join(root, "research", "wikipedia");

  const candidateSlugs = uniqueValues(
    [options.slug, slugify(options.title)]
      .filter((value): value is string => Boolean(value && value.trim()))
      .map((value) => value.trim().toLowerCase()),
  );

  // Primary: flat research/wikipedia/{slug}.md
  if (await pathExists(researchRoot)) {
    for (const candidateSlug of candidateSlugs) {
      const candidatePath = path.join(researchRoot, `${candidateSlug}.md`);
      if (await pathExists(candidatePath)) {
        const document = await readMarkdownFile(candidatePath, researchNoteSchema);
        return {
          filePath: candidatePath,
          relativePath: toPosixPath(path.relative(root, candidatePath)),
          title: document.frontmatter.title,
          sourceUrl: document.frontmatter.source_url,
          retrievedAt: document.frontmatter.retrieved_at,
          summary: summarizeText(document.body, 280) || document.frontmatter.title,
          body: document.body,
        };
      }
    }

    const files = await fg("*.md", { cwd: researchRoot, absolute: true, onlyFiles: true });
    const normalizedTitle = options.title.trim().toLowerCase();

    for (const filePath of files) {
      const document = await readMarkdownFile(filePath, researchNoteSchema).catch(() => null);
      if (!document) continue;

      if (document.frontmatter.title.trim().toLowerCase() === normalizedTitle) {
        return {
          filePath,
          relativePath: toPosixPath(path.relative(root, filePath)),
          title: document.frontmatter.title,
          sourceUrl: document.frontmatter.source_url,
          retrievedAt: document.frontmatter.retrieved_at,
          summary: summarizeText(document.body, 280) || document.frontmatter.title,
          body: document.body,
        };
      }
    }
  }

  return null;
}

async function ensureFile(
  root: string,
  relativePath: string,
  content: string,
  created: string[],
): Promise<void> {
  const filePath = path.join(root, relativePath);
  if (await pathExists(filePath)) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  created.push(toPosixPath(relativePath));
}

async function readMarkdownFile<T>(
  filePath: string,
  schema: { parse: (value: unknown) => T },
): Promise<MarkdownDocument<T>> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  return {
    frontmatter: schema.parse(parsed.data),
    body: String(parsed.content ?? "").trim(),
    path: filePath,
  };
}

async function readLooseMarkdownIfExists(filePath: string): Promise<MarkdownDocument<Record<string, unknown>> | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }

  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  return {
    frontmatter: parsed.data as Record<string, unknown>,
    body: String(parsed.content ?? "").trim(),
    path: filePath,
  };
}

async function validateFile(root: string, filePath: string): Promise<void> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const relativePath = toPosixPath(path.relative(root, filePath));

  if (relativePath === BOOK_FILE) {
    bookSchema.parse(data);
    return;
  }

  if (relativePath === PLOT_FILE) {
    plotSchema.parse(data);
    return;
  }

  if (relativePath === CONTEXT_FILE) {
    contextSchema.parse(data);
    return;
  }

  if ([IDEAS_FILE, NOTES_FILE, PROMOTED_FILE, STORY_DESIGN_FILE].includes(relativePath)) {
    noteSchema.parse(data);
    return;
  }

  if (relativePath.startsWith("guidelines/")) {
    guidelineSchema.parse(data);
    return;
  }

  if (relativePath.startsWith("research/wikipedia/")) {
    researchNoteSchema.parse(data);
    return;
  }

  if (relativePath.startsWith("assets/")) {
    assetSchema.parse(data);
    return;
  }

  if (relativePath.startsWith("chapters/") && path.basename(filePath) === "chapter.md") {
    chapterSchema.parse(data);
    return;
  }

  if (relativePath.startsWith("chapters/") && path.basename(filePath) === "writing-style.md") {
    guidelineSchema.parse(data);
    return;
  }

  if (relativePath.startsWith("chapters/")) {
    paragraphSchema.parse(data);
    return;
  }

  if (relativePath.startsWith("drafts/") && path.basename(filePath) === "chapter.md") {
    chapterDraftSchema.parse(data);
    return;
  }

  if (relativePath.startsWith("drafts/") && path.basename(filePath) === "writing-style.md") {
    guidelineSchema.parse(data);
    return;
  }

  if (relativePath.startsWith("drafts/") && ["notes.md", "ideas.md", "promoted.md"].includes(path.basename(filePath))) {
    noteSchema.parse(data);
    return;
  }

  if (relativePath.startsWith("drafts/")) {
    paragraphDraftSchema.parse(data);
    return;
  }

  const entityEntry = Object.entries(ENTITY_TYPE_TO_DIRECTORY).find(([, directory]) =>
    relativePath.startsWith(`${directory}/`),
  );

  if (entityEntry) {
    const [type] = entityEntry;
    entitySchemaMap[type as EntityType].parse(data);
    return;
  }

  if (
    relativePath.startsWith("resumes/") ||
    relativePath.startsWith("state/") ||
    relativePath.startsWith("evaluations/") ||
    relativePath.startsWith("timelines/")
  ) {
    if (typeof data.type !== "string") {
      throw new Error(`Missing type in frontmatter for ${relativePath}`);
    }
    return;
  }

  const stats = await stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Not a regular file: ${relativePath}`);
  }
}

function prepareAssetTarget(root: string, subject: string, assetKindInput?: string, extensionInput?: string) {
  const parsedSubject = parseAssetSubject(subject);
  const assetKind = normalizeAssetKind(assetKindInput ?? defaultAssetKindForSubject(parsedSubject));
  const extension = normalizeAssetExtension(extensionInput ?? "png");
  const assetDirectory = resolveAssetDirectory(root, parsedSubject);
  const imageFilePath = path.join(assetDirectory, `${assetKind}.${extension}`);
  const markdownFilePath = path.join(assetDirectory, `${assetKind}.md`);
  const imageRelativePath = toPosixPath(path.relative(root, imageFilePath));

  return {
    parsedSubject,
    assetKind,
    assetId: buildAssetId(parsedSubject, assetKind),
    imageFilePath,
    markdownFilePath,
    imageRelativePath,
  };
}

function parseAssetSubject(subject: string): ParsedAssetSubject {
  const normalized = subject.trim();

  if (normalized === "book") {
    return { type: "book", subject: "book" };
  }

  if (normalized.startsWith("chapter:")) {
    return {
      type: "chapter",
      subject: `chapter:${normalizeChapterReference(normalized)}`,
      chapterSlug: normalizeChapterReference(normalized),
    };
  }

  if (normalized.startsWith("paragraph:")) {
    const [, chapterPart, paragraphPart] = normalized.split(":");
    if (!chapterPart || !paragraphPart) {
      throw new Error(`Invalid paragraph subject: ${subject}`);
    }

    return {
      type: "paragraph",
      subject: `paragraph:${chapterPart}:${paragraphPart}`,
      chapterSlug: chapterPart,
      paragraphSlug: paragraphPart,
    };
  }

  const entityKind = ENTITY_TYPES.find((candidate) => normalized.startsWith(`${candidate}:`));
  if (!entityKind) {
    throw new Error(`Unsupported asset subject: ${subject}`);
  }

  return {
    type: entityKind,
    subject: normalized,
    slug: normalized.slice(`${entityKind}:`.length),
  };
}

function resolveAssetDirectory(root: string, subject: ParsedAssetSubject): string {
  switch (subject.type) {
    case "book":
      return path.join(root, "assets", "book");
    case "chapter":
      return path.join(root, "assets", "chapters", subject.chapterSlug);
    case "paragraph":
      return path.join(root, "assets", "chapters", subject.chapterSlug, "paragraphs", subject.paragraphSlug);
    default:
      return path.join(root, "assets", ENTITY_TYPE_TO_DIRECTORY[subject.type], subject.slug);
  }
}

function assetDirectoryPrefix(subject: string): string {
  const parsed = parseAssetSubject(subject);
  return `${toPosixPath(path.relative(".", resolveAssetDirectory(".", parsed)))}/`;
}

function buildAssetId(subject: ParsedAssetSubject, assetKind: string): string {
  switch (subject.type) {
    case "book":
      return `asset:book:${assetKind}`;
    case "chapter":
      return `asset:chapter:${subject.chapterSlug}:${assetKind}`;
    case "paragraph":
      return `asset:paragraph:${subject.chapterSlug}:${subject.paragraphSlug}:${assetKind}`;
    default:
      return `asset:${subject.type}:${subject.slug}:${assetKind}`;
  }
}

function defaultAssetKindForSubject(subject: ParsedAssetSubject): string {
  return subject.type === "book" ? "cover" : "primary";
}

function normalizeAssetKind(value: string): string {
  const normalized = slugify(value);
  if (!normalized) {
    throw new Error("Asset kind must contain at least one alphanumeric character.");
  }
  return normalized;
}

function normalizeAssetExtension(value: string): string {
  const normalized = value.replace(/^\./, "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("Asset extension cannot be empty.");
  }
  return normalized;
}

function normalizeRenameSlug(value: string): string {
  const normalized = slugify(value);
  if (!normalized) {
    throw new Error("Rename target must produce a non-empty slug.");
  }
  return normalized;
}

function getEntityLabelKey(kind: EntityType): "name" | "title" {
  return kind === "secret" || kind === "timeline-event" ? "title" : "name";
}

async function moveAssetDirectoryIfPresent(root: string, oldSubject: string, newSubject: string): Promise<string[]> {
  const oldDirectory = resolveAssetDirectory(root, parseAssetSubject(oldSubject));
  const newDirectory = resolveAssetDirectory(root, parseAssetSubject(newSubject));

  if (oldDirectory === newDirectory || !(await pathExists(oldDirectory))) {
    return [];
  }

  if (await pathExists(newDirectory)) {
    throw new Error(`Asset destination already exists: ${newDirectory}`);
  }

  await mkdir(path.dirname(newDirectory), { recursive: true });
  await rename(oldDirectory, newDirectory);
  return [oldDirectory, newDirectory];
}

async function replaceReferencesInMarkdownFiles(root: string, replacements: Array<[string, string]>): Promise<number> {
  const filtered = replacements
    .filter(([from, to]) => from && to && from !== to)
    .sort((left, right) => right[0].length - left[0].length);

  if (filtered.length === 0) {
    return 0;
  }

  const files = await fg(CONTENT_GLOB, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
  });
  let updatedCount = 0;

  for (const filePath of files) {
    const original = await readFile(filePath, "utf8");
    let next = original;

    for (const [from, to] of filtered) {
      next = next.split(from).join(to);
    }

    if (next === original) continue;
    await writeFile(filePath, next, "utf8");
    updatedCount += 1;
  }

  return updatedCount;
}

function resolveEntityFilePath(root: string, kind: EntityType, slugOrId: string): string {
  const slug = slugOrId.includes(":") ? slugOrId.slice(slugOrId.indexOf(":") + 1) : slugOrId;
  return path.join(root, ENTITY_TYPE_TO_DIRECTORY[kind], `${slug}.md`);
}

function resolveChapterMetadataFilePath(root: string, chapter: string): string {
  const chapterSlug = normalizeChapterReference(chapter);
  return path.join(root, "chapters", chapterSlug, "chapter.md");
}

function resolveChapterDraftMetadataFilePath(root: string, chapter: string): string {
  const chapterSlug = normalizeChapterReference(chapter);
  return path.join(root, "drafts", chapterSlug, "chapter.md");
}

async function resolveParagraphFilePath(root: string, chapter: string, paragraph: string): Promise<string> {
  const chapterSlug = normalizeChapterReference(chapter);
  const chapterFolder = path.join(root, "chapters", chapterSlug);
  const normalized = paragraph
    .replace(/^paragraph:[^:]+:/, "")
    .replace(/\.md$/i, "")
    .trim();

  const directPath = path.join(chapterFolder, `${normalized}.md`);
  if (await pathExists(directPath)) {
    return directPath;
  }

  const files = await fg("*.md", { cwd: chapterFolder, absolute: true, onlyFiles: true });
  const filePath = files.find((candidate) => path.basename(candidate, ".md") === normalized);
  if (filePath) {
    return filePath;
  }

  return directPath;
}

async function resolveParagraphDraftFilePath(root: string, chapter: string, paragraph: string): Promise<string> {
  const chapterSlug = normalizeChapterReference(chapter);
  const chapterFolder = path.join(root, "drafts", chapterSlug);
  const normalized = paragraph
    .replace(/^paragraph:[^:]+:/, "")
    .replace(/^draft:paragraph:[^:]+:/, "")
    .replace(/\.md$/i, "")
    .trim();

  const directPath = path.join(chapterFolder, `${normalized}.md`);
  if (await pathExists(directPath)) {
    return directPath;
  }

  const files = await fg("*.md", { cwd: chapterFolder, absolute: true, onlyFiles: true });
  const filePath = files.find((candidate) => path.basename(candidate, ".md") === normalized);
  if (filePath) {
    return filePath;
  }

  return directPath;
}

function assertNoForbiddenPatchKeys(
  frontmatterPatch: Record<string, unknown> | undefined,
  forbiddenKeys: string[],
): void {
  if (!frontmatterPatch) return;

  for (const key of forbiddenKeys) {
    if (Object.prototype.hasOwnProperty.call(frontmatterPatch, key)) {
      throw new Error(`Cannot patch protected frontmatter key: ${key}`);
    }
  }
}

function buildCharacterBody(input: CreateCharacterProfileInput): string {
  return [
    "# Overview",
    "",
    `${input.name} is a ${input.roleTier} character whose story role is ${input.storyRole ?? "other"}. ${input.functionInBook}`,
    "",
    "# Voice",
    "",
    input.speakingStyle,
    "",
    "# Backstory",
    "",
    input.backgroundSummary,
    "",
    "# Role In Story",
    "",
    bulletLines([
      `Role tier: ${input.roleTier}`,
      `Story role: ${input.storyRole ?? "other"}`,
      input.occupation ? `Occupation: ${input.occupation}` : undefined,
      input.origin ? `Origin: ${input.origin}` : undefined,
      input.age !== undefined ? `Age: ${input.age}` : undefined,
    ]),
    "",
    "# Function In Book",
    "",
    input.functionInBook,
    "",
    "# Motivations And Fears",
    "",
    bulletLines([
      ...toPrefixedList("Desire", input.desires),
      ...toPrefixedList("Fear", input.fears),
      input.internalConflict ? `Internal conflict: ${input.internalConflict}` : undefined,
      input.externalConflict ? `External conflict: ${input.externalConflict}` : undefined,
      input.arc ? `Arc: ${input.arc}` : undefined,
    ]),
    "",
    "# Relationships",
    "",
    bulletLines(input.relationships),
    "",
    "# Identity And Change",
    "",
    bulletLines([
      input.currentIdentity ? `Current identity: ${input.currentIdentity}` : undefined,
      ...toPrefixedList("Former name", input.formerNames),
      ...toPrefixedList("Identity shift", input.identityShifts),
      input.identityArc ? `Identity arc: ${input.identityArc}` : undefined,
    ]),
    "",
    "# Public Knowledge",
    "",
    bulletLines([
      input.firstImpression ? `First impression: ${input.firstImpression}` : undefined,
      ...(input.traits ?? []),
      ...toPrefixedList("Mannerism", input.mannerisms),
    ]),
    "",
    "# Private Knowledge",
    "",
    input.internalConflict ?? "Add private motives, secrets, and contradictions here.",
    "",
    "# Arc Notes",
    "",
    input.arc ?? "Describe how the character changes across the book.",
    "",
    "# Open Questions",
    "",
    "- What could destabilize this character?",
    "- Which chapter should deepen their voice or backstory?",
  ].join("\n");
}

function buildHiddenCanonFrontmatter(input: HiddenCanonInput) {
  return {
    secret_refs: uniqueValues(input.secretRefs ?? []),
    private_notes: input.privateNotes,
    reveal_in: input.revealIn,
    known_from: input.knownFrom,
  };
}

function buildPronunciationFrontmatter(input: PronunciationInput) {
  return {
    pronunciation: input.pronunciation,
    spoken_name: input.spokenName,
    tts_label: input.ttsLabel,
  };
}

function buildItemBody(input: CreateItemProfileInput): string {
  return [
    "# Overview",
    "",
    `${input.name} exists in the story because ${input.functionInBook.toLowerCase()}.`,
    "",
    "# Appearance",
    "",
    input.appearance,
    "",
    "# Properties",
    "",
    bulletLines([
      input.itemKind ? `Kind: ${input.itemKind}` : undefined,
      input.purpose ? `Purpose: ${input.purpose}` : undefined,
      input.significance ? `Significance: ${input.significance}` : undefined,
      ...toPrefixedList("Power", input.powers),
      ...toPrefixedList("Limitation", input.limitations),
    ]),
    "",
    "# Function In Book",
    "",
    input.functionInBook,
    "",
    "# Ownership",
    "",
    bulletLines([
      input.owner ? `Current owner: ${input.owner}` : undefined,
      input.introducedIn ? `Introduced in: ${input.introducedIn}` : undefined,
    ]),
    "",
    "# Origin Story",
    "",
    input.originStory ?? "Describe where the item comes from and why it matters.",
    "",
    "# Story Use",
    "",
    bulletLines([
      input.purpose,
      input.functionInBook,
      input.significance,
    ]),
  ].join("\n");
}

function buildLocationBody(input: CreateLocationProfileInput): string {
  return [
    "# Overview",
    "",
    `${input.name} serves the story as ${input.functionInBook.toLowerCase()}.`,
    "",
    "# Atmosphere",
    "",
    input.atmosphere,
    "",
    "# Key Details",
    "",
    bulletLines([
      input.locationKind ? `Kind: ${input.locationKind}` : undefined,
      input.region ? `Region: ${input.region}` : undefined,
      input.timelineRef ? `Timeline: ${input.timelineRef}` : undefined,
      input.basedOnRealPlace ? "Based on a real place or historical setting." : undefined,
    ]),
    "",
    "# Function In Book",
    "",
    input.functionInBook,
    "",
    "# Landmarks And Risks",
    "",
    bulletLines([
      ...toPrefixedList("Landmark", input.landmarks),
      ...toPrefixedList("Risk", input.risks),
      ...toPrefixedList("Faction present", input.factionsPresent),
    ]),
    "",
    "# Story Use",
    "",
    bulletLines([
      input.functionInBook,
      input.atmosphere,
    ]),
  ].join("\n");
}

function buildFactionBody(input: CreateFactionProfileInput): string {
  return [
    "# Overview",
    "",
    `${input.name} exists in the story as ${input.functionInBook.toLowerCase()}.`,
    "",
    "# Goals",
    "",
    input.mission,
    "",
    "# Ideology",
    "",
    input.ideology,
    "",
    "# Function In Book",
    "",
    input.functionInBook,
    "",
    "# Resources",
    "",
    bulletLines([
      input.factionKind ? `Kind: ${input.factionKind}` : undefined,
      input.baseLocation ? `Base location: ${input.baseLocation}` : undefined,
      input.publicImage ? `Public image: ${input.publicImage}` : undefined,
      input.hiddenAgenda ? `Hidden agenda: ${input.hiddenAgenda}` : undefined,
      ...toPrefixedList("Method", input.methods),
      ...toPrefixedList("Leader", input.leaders),
    ]),
    "",
    "# Allies And Enemies",
    "",
    bulletLines([
      ...toPrefixedList("Ally", input.allies),
      ...toPrefixedList("Enemy", input.enemies),
    ]),
  ].join("\n");
}

function buildSecretBody(input: CreateSecretProfileInput): string {
  return [
    "# What Is Hidden",
    "",
    input.title,
    "",
    "# Function In Book",
    "",
    input.functionInBook,
    "",
    "# Who Knows",
    "",
    bulletLines([
      input.secretKind ? `Kind: ${input.secretKind}` : undefined,
      ...toPrefixedList("Holder", input.holders),
      ...toPrefixedList("Protected by", input.protectedBy),
      input.knownFrom ? `Known from: ${input.knownFrom}` : undefined,
      input.revealIn ? `Revealed in: ${input.revealIn}` : undefined,
      input.timelineRef ? `Timeline reference: ${input.timelineRef}` : undefined,
    ]),
    "",
    "# Reveal Strategy",
    "",
    input.revealStrategy ?? "Describe how and when this secret should surface.",
    "",
    "# Consequences",
    "",
    bulletLines([
      `Stakes: ${input.stakes}`,
      ...toPrefixedList("False belief", input.falseBeliefs),
    ]),
  ].join("\n");
}

function buildTimelineEventBody(input: CreateTimelineEventProfileInput): string {
  return [
    "# Event",
    "",
    input.title,
    "",
    "# Participants",
    "",
    bulletLines(input.participants),
    "",
    "# Consequences",
    "",
    bulletLines([
      input.significance ? `Significance: ${input.significance}` : undefined,
      input.functionInBook ? `Function in book: ${input.functionInBook}` : undefined,
      ...toPrefixedList("Consequence", input.consequences),
      input.date ? `Date: ${input.date}` : undefined,
    ]),
  ].join("\n");
}

function buildOpencodeProjectConfig(): string {
  return [
    "{",
    '  "$schema": "https://opencode.ai/config.json",',
    `  "instructions": ["${OPENCODE_INSTRUCTION_FILE}"],`,
    '  "default_agent": "build",',
    '  "agent": {',
    '    "build": {',
    '      "temperature": 0.45,',
    '      "top_p": 1,',
    '      "options": {',
    '        "reasoningEffort": "high",',
    '        "reasoningSummary": "detailed",',
    '        "textVerbosity": "high",',
    '        "include": ["reasoning.encrypted_content", "usage"]',
    '      }',
    '    },',
    '    "plan": {',
    '      "temperature": 0.2,',
    '      "top_p": 1,',
    '      "options": {',
    '        "reasoningEffort": "high",',
    '        "reasoningSummary": "detailed",',
    '        "textVerbosity": "high",',
    '        "include": ["reasoning.encrypted_content", "usage"]',
    '      }',
    '    }',
    '  },',
    '  "watcher": {',
    '    "ignore": ["conversations/sessions/**", "conversations/*.json"]',
    '  },',
    '  "mcp": {',
    '    "narrarium": {',
    '      "type": "local",',
    '      "command": ["npx", "narrarium-mcp-server"],',
    '      "enabled": true,',
    '      "timeout": 15000',
    '    }',
    '  }',
    '}',
    '',
  ].join("\n");
}

function ensureOpencodeInstructionEntry(content: string): { content: string; updated: boolean } {
  if (content.includes(OPENCODE_INSTRUCTION_FILE)) {
    return { content, updated: false };
  }

  const parsed = tryParseJsoncObject(content);
  if (!parsed) {
    return { content, updated: false };
  }

  const existingInstructions = Array.isArray(parsed.instructions)
    ? parsed.instructions.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  if (existingInstructions.includes(OPENCODE_INSTRUCTION_FILE)) {
    return { content, updated: false };
  }

  parsed.instructions = [...existingInstructions, OPENCODE_INSTRUCTION_FILE];
  return {
    content: `${JSON.stringify(parsed, null, 2)}\n`,
    updated: true,
  };
}

function tryParseJsoncObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stripJsonComments(content));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stripJsonComments(content: string): string {
  let result = "";
  let inString = false;
  let isEscaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];

    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
        result += current;
      }
      continue;
    }

    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += current;
      if (isEscaped) {
        isEscaped = false;
      } else if (current === "\\") {
        isEscaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    result += current;
  }

  return result;
}

function buildConversationsReadme(): string {
  return [
    "---",
    "type: note",
    "id: conversations:index",
    "title: Conversations",
    "---",
    "",
    "# Conversations",
    "",
    "Use this folder for portable exports of OpenCode or other writing conversations tied to the book.",
    "",
    "- These files are working history, not canon.",
    "- Keep the conversations that matter for continuity, intent, or major creative decisions.",
    "- Do not treat a conversation as source of truth until the relevant canon is written into markdown files elsewhere in the repo.",
  ].join("\n");
}

function buildVscodeMcpConfig(): string {
  return [
    "{",
    '  "servers": {',
    '    "narrarium": {',
    '      "command": "npx",',
    '      "args": ["narrarium-mcp-server"]',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}

function buildGithubCopilotInstructions(): string {
  // Same content as skillTemplate but without the YAML frontmatter block,
  // since .github/copilot-instructions.md must be plain markdown.
  return [
    "# Narrarium Book Workflow",
    "",
    "## Mission",
    "",
    "Treat the repository as the canonical source of truth for the book.",
    "",
    "## Folder model",
    "",
    "- `context.md` for stable historical, social, geographic, and world-context constraints that should stay in view while writing",
    "- `ideas.md` for unstable ideas that still need review before they become notes, design decisions, or draft material",
    "- `story-design.md` for the initial book design: arcs, reveals, interwoven threads, and ending shape",
    "- `notes.md` for reviewed working notes and reminders that are ready to influence drafting",
    "- `promoted.md` for archived ideas and notes that were already moved into notes, design, or draft work",
    "- `characters/`, `items/`, `locations/`, `factions/`, `timelines/`, `secrets/`",
    "- `chapters/<nnn-slug>/chapter.md` for chapter metadata",
    "- `chapters/<nnn-slug>/<nnn-slug>.md` for paragraph or scene files",
    "- `drafts/<nnn-slug>/chapter.md`, matching scene drafts, and `drafts/<nnn-slug>/{ideas,notes,promoted}.md` for rough chapter work",
    "- `plot.md` for the rolling book map: chapter progression, reveals, and timeline anchors",
    "- `conversations/` for exported writing chats, resume files, and continuation prompts",
    "- `resumes/` for running summaries",
    "- `state/` for structured continuity snapshots and sync status",
    "- `evaluations/` for critique and continuity checks",
    "- `guidelines/writing-style.md` for the always-on writing and review contract of the book",
    "",
    "## Working rules",
    "",
    "1. Search canon before inventing new facts.",
    "2. Prefer updating existing files over duplicating information.",
    "3. Keep frontmatter explicit and stable.",
    "4. Use ids like `character:lyra-vale` and `chapter:001-the-arrival`.",
    "5. When a request is historical or factual, use Wikipedia tools before writing canon.",
    "6. After major changes, update summaries or evaluations if they are now stale.",
    "",
    "## Tool usage",
    "",
    "- Use `init_book_repo` to scaffold a new repository.",
    "- Use `start_wizard`, `wizard_answer`, and `wizard_finalize` for true guided creation flows when the brief is incomplete.",
    "- Use `character_wizard` before creating a major character if data is incomplete.",
    "- Use `location_wizard`, `faction_wizard`, `item_wizard`, and `secret_wizard` before creating rich canon files when the brief is incomplete.",
    "- Use `timeline_event_wizard`, `chapter_wizard`, and `paragraph_wizard` for those structures when needed.",
    "- Use `create_character` for full character files.",
    "- Use `create_location`, `create_faction`, `create_item`, `create_secret`, and `create_timeline_event` for rich canon files.",
    "- Use `create_chapter_draft` and `create_paragraph_draft` when roughing scenes before final prose.",
    "- Use `chapter_writing_context` and `paragraph_writing_context` before drafting polished prose from rough material or revising final prose.",
    "- Treat chapter and paragraph writing context as point-in-time context: use only the story up to that chapter or scene, not later story material.",
    "- Use `revise_chapter` when you want a proposal-only diagnosis and scene revision plan for an existing final chapter before deciding what to apply manually.",
    "- Use `revise_paragraph` when you want a proposal-only editorial pass on an existing final scene before deciding whether to apply it with `update_paragraph`.",
    "- When revising a final paragraph, show the `revise_paragraph` proposal, ask the user whether they want to keep it, and call `update_paragraph` only after clear confirmation.",
    "- Use `review_dialogue_action_beats` when the user wants a beat-by-beat review of dialogue-adjacent actions instead of a full scene rewrite.",
    "- Use `apply_dialogue_action_beats` only after the user confirmed which beat-level proposals to keep.",
    "- Use `resume_book_context` when restarting work from exported conversation history.",
    "- Use `save_book_item` and `save_chapter_item` for structured ideas and notes, and `promote_book_item` / `promote_chapter_item` when reviewed material leaves the active queue.",
    "- Use `update_book_notes` and `update_chapter_notes` when the user asks to edit the support documents themselves instead of individual structured entries.",
    "- Use `update_chapter` and `update_paragraph` for existing story structure files.",
    "- Use `update_chapter_draft` and `update_paragraph_draft` when iterating on rough drafts.",
    "- Use `create_chapter_from_draft` and `create_paragraph_from_draft` to promote drafts into final story files.",
    "- Use `create_entity` for other canon files or quick stubs.",
    "- Use `update_entity` when patching existing canon.",
    "- Use `sync_plot` after story-structure changes if it was not already refreshed automatically.",
    "- Use `sync_resume` and `evaluate_chapter` after structural changes.",
    "- Use `sync_story_state` manually after chapter or paragraph rewrites when continuity snapshots should be refreshed.",
    "- Use `sync_all_resumes` and `evaluate_book` after larger structural passes.",
    "- Use repository search before drafting new chapters.",
    "- Before fetching Wikipedia again, check whether `research/wikipedia/` already has the needed snapshot and reuse it when possible; use explicit refresh controls when the snapshot should be bypassed.",
    "- Use Wikipedia search and page tools for historical entities, places, timelines, or factual references.",
    "",
      "## Writing discipline",
      "",
      "- Do not reveal secrets before their `known_from` or `reveal_in` point.",
      "- Respect chapter numbering and paragraph numbering.",
      "- Keep prose in body content and structured facts in frontmatter.",
      "- In chapter and paragraph prose, write character, item, location, faction, secret, and timeline-event names as plain text. Do not insert markdown links to canon files or reader routes; the reader resolves visible mentions automatically.",
      "- Always read `guidelines/writing-style.md` before drafting or revising chapter and paragraph prose.",
      "- If `chapters/<chapter>/writing-style.md` or `drafts/<chapter>/writing-style.md` exists, treat it as an explicit chapter-local addendum or override on top of the global writing-style file.",
    "- Before writing or rewriting a scene, review `context.md`, `story-design.md`, `notes.md`, any matching chapter draft notes, the relevant prior chapter content, the scoped summaries for story so far, the global `guidelines/writing-style.md`, any chapter-specific `writing-style.md`, any point-in-time state snapshot available before that point, and any matching files in `drafts/`.",
    "- Treat `ideas.md` as unstable material under review; do not treat active ideas as accepted canon or default drafting instructions unless the user asks you to use them.",
    "- Treat notes, ideas, and promoted archives as working support material, not canon. If something becomes a stable fact, move it into the correct canon file.",
    "- Keep `plot.md` aligned with chapter summaries, secret reveals, and timeline references.",
    "- After `update_paragraph`, assume plot and resume files were refreshed automatically by the MCP layer, and review `sync_story_state` separately only when continuity snapshots must be updated.",
    "- If stylistic guidance is missing, update `guidelines/writing-style.md` or add a chapter-local `writing-style.md` instead of inventing a new style ad hoc.",
  ].join("\n");
}

function resolveQueryCanonLexicon(language?: string): QueryCanonLexicon {
  const normalized = normalizeBookLanguage(language);
  const english = QUERY_CANON_LEXICONS.en;
  const localized = QUERY_CANON_LEXICONS[normalized];

  if (!localized || normalized === "en") {
    return english;
  }

  return {
    chapterAliases: uniqueValues([...english.chapterAliases, ...localized.chapterAliases]),
    firstAppearancePhrases: uniqueValues([...english.firstAppearancePhrases, ...localized.firstAppearancePhrases]),
    secretHolderPhrases: uniqueValues([...english.secretHolderPhrases, ...localized.secretHolderPhrases]),
    relationshipPhrases: uniqueValues([...english.relationshipPhrases, ...localized.relationshipPhrases]),
    conditionPhrases: uniqueValues([...english.conditionPhrases, ...localized.conditionPhrases]),
    openLoopPhrases: uniqueValues([...english.openLoopPhrases, ...localized.openLoopPhrases]),
    wherePhrases: uniqueValues([...english.wherePhrases, ...localized.wherePhrases]),
    knowledgePhrases: uniqueValues([...english.knowledgePhrases, ...localized.knowledgePhrases]),
    inventoryPhrases: uniqueValues([...english.inventoryPhrases, ...localized.inventoryPhrases]),
    betweenWords: uniqueValues([...english.betweenWords, ...localized.betweenWords]),
    andWords: uniqueValues([...english.andWords, ...localized.andWords]),
    fromWords: uniqueValues([...english.fromWords, ...localized.fromWords]),
    toWords: uniqueValues([...english.toWords, ...localized.toWords]),
    stopWords: uniqueValues([...english.stopWords, ...localized.stopWords]),
  };
}

function normalizeBookLanguage(language?: string): string {
  const normalized = (language ?? "en").trim().toLowerCase();
  return normalized.split(/[-_]/)[0] || "en";
}

function buildAlternationPattern(values: string[]): string {
  return values
    .slice()
    .sort((left, right) => right.length - left.length)
    .map((value) => escapeRegExp(value).replace(/\s+/g, "\\s+"))
    .join("|");
}

// Files synced on every upgrade: skill templates, commands, plugins, readmes.
// Do NOT include user-editable config files here.
function getManagedBookScaffoldFiles(createSkills: boolean): Array<{ relativePath: string; content: string }> {
  return [
    { relativePath: ".github/copilot-instructions.md", content: buildGithubCopilotInstructions() },
    ...(createSkills
      ? [
          { relativePath: `.opencode/skills/${SKILL_NAME}/SKILL.md`, content: skillTemplate },
          { relativePath: `.claude/skills/${SKILL_NAME}/SKILL.md`, content: skillTemplate },
        ]
      : []),
    { relativePath: ".opencode/commands/resume-book.md", content: buildResumeBookCommand() },
    { relativePath: ".opencode/plugins/conversation-export.js", content: buildConversationExportPlugin() },
    { relativePath: "conversations/README.md", content: buildConversationsReadme() },
  ];
}

// Files created once and never overwritten on upgrade.
// These are user-editable config files (opencode, vscode MCP, etc.).
function getInitOnlyBookScaffoldFiles(): Array<{ relativePath: string; content: string }> {
  return [
    { relativePath: "opencode.jsonc", content: buildOpencodeProjectConfig() },
    { relativePath: ".vscode/mcp.json", content: buildVscodeMcpConfig() },
  ];
}

function buildResumeBookCommand(): string {
  return [
    "---",
    "description: Resume book work globally or from a target chapter/paragraph",
    "agent: build",
    "---",
    "Resume work on this Narrarium book.",
    "",
    "Argument format:",
    "- `/resume-book` for the latest overall book state",
    "- `/resume-book chapter:002-ledger-suspicion` to resume before a target chapter",
    "- `/resume-book chapter:002-ledger-suspicion 002-tense-exchange` to resume before a target paragraph",
    "- Any remaining text after the target should be treated as the actual follow-up request.",
    "",
    "Before doing anything else:",
    "1. Parse `$ARGUMENTS`: if the first token starts with `chapter:`, use it as the chapter target; if the next token looks like a paragraph id or slug, use it as the paragraph target; everything after that is the follow-up request.",
    "2. Call the `resume_book_context` MCP tool with the scoped `chapter` and optional `paragraph` when a target was provided; otherwise call it without scope.",
    "3. Read the files it references, especially `context.md`, `story-design.md`, `notes.md`, any scoped chapter draft notes, `guidelines/writing-style.md`, any chapter-specific `writing-style.md`, scoped story summaries, `state/current.md`, `state/status.md` when present, and the latest files in `conversations/`.",
    "4. Briefly restate where the book stands, what the latest conversation was doing, and the next best actions.",
    "5. Then continue with the parsed follow-up request if one is present.",
    "6. If no extra request is present, ask for the next book task only after giving the short status recap.",
    "",
    "Prefer continuity over novelty. Respect `known_from`, `reveal_in`, and the writing-style rules.",
  ].join("\n");
}

function buildConversationExportPlugin(): string {
  return [
    'import { mkdir, readFile, writeFile } from "node:fs/promises";',
    'import path from "node:path";',
    '',
    'const MAX_RESUME_LENGTH = 900;',
    'const MAX_CONTINUATION_LENGTH = 1400;',
    'const pending = new Map();',
    '',
    'export const ConversationExportPlugin = async ({ client, worktree, directory }) => {',
    '  const root = worktree || directory;',
    '  const conversationsDir = path.join(root, "conversations");',
    '  const sessionsDir = path.join(conversationsDir, "sessions");',
    '',
    '  return {',
    '    event: async ({ event }) => {',
    '      if (!event || (event.type !== "session.idle" && event.type !== "session.updated")) {',
    '        return;',
    '      }',
    '',
    '      const sessionId = extractSessionId(event);',
    '      if (!sessionId) {',
    '        return;',
    '      }',
    '',
    '      if (pending.has(sessionId)) {',
    '        clearTimeout(pending.get(sessionId));',
    '      }',
    '',
    '      const timer = setTimeout(() => {',
    '        void exportConversation(client, conversationsDir, sessionsDir, sessionId);',
    '        pending.delete(sessionId);',
    '      }, event.type === "session.updated" ? 1200 : 250);',
    '',
    '      pending.set(sessionId, timer);',
    '    },',
    '  };',
    '};',
    '',
    'async function exportConversation(client, conversationsDir, sessionsDir, sessionId) {',
    '  const config = await loadConversationsConfig(conversationsDir);',
    '  const saveSessionFiles = config.saveSessionFiles !== false;',
    '',
    '  const session = unwrap(await client.session.get({ path: { id: sessionId } }));',
    '  const messages = unwrap(await client.session.messages({ path: { id: sessionId } }));',
    '',
    '  if (!session || !Array.isArray(messages)) {',
    '    return;',
    '  }',
    '',
    '  const title = session.title || `session-${sessionId}`;',
    '  const stamp = formatDateForFile(session.updatedAt || session.createdAt || Date.now());',
    '  const slug = slugify(title);',
    '  const baseName = `${stamp}--${slug}--${sessionId}`;',
    '',
    '  const structuredMessages = messages.map((entry) => ({',
    '    id: entry.info?.id || "",',
    '    role: entry.info?.role || entry.info?.type || "assistant",',
    '    createdAt: entry.info?.createdAt || null,',
    '    parts: Array.isArray(entry.parts) ? entry.parts : [],',
    '    text: messageText(Array.isArray(entry.parts) ? entry.parts : []),',
    '  }));',
    '',
    '  let sessionFilePath = null;',
    '',
    '  if (saveSessionFiles) {',
    '    await mkdir(sessionsDir, { recursive: true });',
    '    const markdownPath = path.join(sessionsDir, `${baseName}.md`);',
    '    const jsonPath = path.join(sessionsDir, `${baseName}.json`);',
    '    const markdown = renderConversationMarkdown({',
    '      sessionId,',
    '      title,',
    '      createdAt: session.createdAt || null,',
    '      updatedAt: session.updatedAt || null,',
    '      messages: structuredMessages,',
    '    });',
    '    await writeFile(markdownPath, markdown, "utf8");',
    '    await writeFile(jsonPath, JSON.stringify({ session, messages: structuredMessages }, null, 2) + "\\n", "utf8");',
    '    sessionFilePath = markdownPath;',
    '  }',
    '',
    '  const latestUser = findLatestMessage(structuredMessages, "user");',
    '  const latestAssistant = findLatestMessage(structuredMessages, "assistant");',
    '  const latestExcerpt = summarizeText(latestAssistant?.text || latestUser?.text || "", MAX_RESUME_LENGTH);',
    '  const resumeExportLine = sessionFilePath',
    '    ? `- Export: ${toPosix(path.relative(conversationsDir, sessionFilePath))}`',
    '    : null;',
    '  await writeFile(',
    '    path.join(conversationsDir, "RESUME.md"),',
    '    [',
    '      "# Conversation Resume",',
    '      "",',
    '      `- Latest session: ${title}` ,',
    '      `- Session id: ${sessionId}` ,',
    '      `- Updated: ${formatDateForDisplay(session.updatedAt || session.createdAt || Date.now())}` ,',
    '      ...(resumeExportLine ? [resumeExportLine] : []),',
    '      "",',
    '      "## Latest user intent",',
    '      "",',
    '      summarizeText(latestUser?.text || "No user message captured yet.", MAX_RESUME_LENGTH),',
    '      "",',
    '      "## Latest assistant state",',
    '      "",',
    '      latestExcerpt || "No assistant response captured yet.",',
    '    ].join("\\n"),',
    '    "utf8",',
    '  );',
    '',
    '  const continuationSessionLine = sessionFilePath',
    '    ? `7. conversations/sessions/${baseName}.md`',
    '    : null;',
    '  await writeFile(',
    '    path.join(conversationsDir, "CONTINUATION.md"),',
    '    [',
    '      "# Continuation",',
    '      "",',
    '      "Use this file when restarting work in a fresh OpenCode session.",',
    '      "",',
    '      "## Read first",',
    '      "",',
      '      "1. guidelines/writing-style.md",',
      '      "2. plot.md",',
      '      "3. resumes/total.md",',
      '      "4. state/current.md",',
      '      "5. state/status.md if it shows dirty: true",',
      '      "6. Any chapter-specific writing-style.md or matching files in drafts/",',
    '      ...(continuationSessionLine ? [continuationSessionLine] : []),',
    '      "",',
    '      "## Current conversation snapshot",',
    '      "",',
    '      `- Session: ${title}` ,',
    '      `- Session id: ${sessionId}` ,',
    '      `- Updated: ${formatDateForDisplay(session.updatedAt || session.createdAt || Date.now())}` ,',
    '      "",',
    '      "## Latest user request",',
    '      "",',
    '      summarizeText(latestUser?.text || "No user request captured yet.", MAX_CONTINUATION_LENGTH),',
    '      "",',
    '      "## Latest assistant response",',
    '      "",',
    '      summarizeText(latestAssistant?.text || "No assistant response captured yet.", MAX_CONTINUATION_LENGTH),',
    '      "",',
    '      "## Resume prompt",',
    '      "",',
    '      "Run `/resume-book` or ask OpenCode to resume work from repository state, exported conversations, plot, resumes, state snapshots, and drafts before continuing.",',
    '    ].join("\\n"),',
    '    "utf8",',
    '  );',
    '}',
    '',
    'async function loadConversationsConfig(conversationsDir) {',
    '  try {',
    '    const raw = await readFile(path.join(conversationsDir, "config.json"), "utf8");',
    '    return JSON.parse(raw);',
    '  } catch {',
    '    return {};',
    '  }',
    '}',
    '',
    'function renderConversationMarkdown({ sessionId, title, createdAt, updatedAt, messages }) {',
    '  return [',
    '    "---",',
    '    "type: conversation-export",',
    '    `id: conversation:${sessionId}` ,',
    '    `title: ${escapeYaml(title)}` ,',
    '    `created_at: ${createdAt || ""}` ,',
    '    `updated_at: ${updatedAt || ""}` ,',
    '    "---",',
    '    "",',
    '    "# Conversation Export",',
    '    "",',
    '    ...messages.flatMap((message, index) => [',
    '      `## ${index + 1}. ${capitalize(message.role)}` ,',
    '      "",',
    '      message.text || "No plain-text content.",',
    '      "",',
    '    ]),',
    '  ].join("\\n");',
    '}',
    '',
    'function findLatestMessage(messages, role) {',
    '  for (let index = messages.length - 1; index >= 0; index -= 1) {',
    '    if (messages[index].role === role) return messages[index];',
    '  }',
    '  return null;',
    '}',
    '',
    'function extractSessionId(event) {',
    '  const props = event.properties || {};',
    '  return props.id || props.sessionID || props.sessionId || props.session?.id || props.info?.id || null;',
    '}',
    '',
    'function unwrap(result) {',
    '  return result && typeof result === "object" && "data" in result ? result.data : result;',
    '}',
    '',
    'function formatDateForFile(value) {',
    '  const date = new Date(value);',
    '  const safe = Number.isNaN(date.getTime()) ? new Date() : date;',
    '  return [',
    '    safe.getUTCFullYear(),',
    '    String(safe.getUTCMonth() + 1).padStart(2, "0"),',
    '    String(safe.getUTCDate()).padStart(2, "0"),',
    '    "-",',
    '    String(safe.getUTCHours()).padStart(2, "0"),',
    '    String(safe.getUTCMinutes()).padStart(2, "0"),',
    '  ].join("");',
    '}',
    '',
    'function formatDateForDisplay(value) {',
    '  const date = new Date(value);',
    '  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();',
    '}',
    '',
    'function slugify(value) {',
    '  return String(value || "conversation")',
    '    .toLowerCase()',
    '    .replace(/[^a-z0-9]+/g, "-")',
    '    .replace(/^-+|-+$/g, "") || "conversation";',
    '}',
    '',
    'function summarizeText(value, maxLength) {',
    '  const text = String(value || "").replace(/\s+/g, " ").trim();',
    '  if (!text) return "";',
    '  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3).trim()}...`;',
    '}',
    '',
    'function messageText(parts) {',
    '  if (!Array.isArray(parts)) return "";',
    '  return parts',
    '    .map((part) => {',
    '      if (!part || typeof part !== "object") return "";',
    '      if (part.type === "text") return part.text || "";',
    '      if (typeof part.text === "string") return part.text;',
    '      try {',
    '        return JSON.stringify(part, null, 2);',
    '      } catch {',
    '        return String(part.type || "part");',
    '      }',
    '    })',
    '    .filter(Boolean)',
    '    .join("\\n\\n");',
    '}',
    '',
    'function toPosix(value) {',
    '  return value.split(path.sep).join("/");',
    '}',
    '',
    'function escapeYaml(value) {',
    '  return JSON.stringify(String(value || ""));',
    '}',
    '',
    'function capitalize(value) {',
    '  const text = String(value || "message");',
    '  return text.charAt(0).toUpperCase() + text.slice(1);',
    '}',
    '',
  ].join("\n");
}

function addContextSection(
  sections: string[],
  files: Set<string>,
  root: string,
  document: MarkdownDocument<Record<string, unknown>> | MarkdownDocument<PlotFrontmatter> | null,
  heading: string,
  maxLength: number,
): void {
  if (!document) {
    return;
  }

  const relativePath = toPosixPath(path.relative(root, document.path));
  files.add(relativePath);
  sections.push(
    [
      `## ${heading}`,
      "",
      `Source: ${relativePath}`,
      "",
      summarizeText(document.body, maxLength) || "No body content yet.",
    ].join("\n"),
  );
}

function addWorkItemSection(
  sections: string[],
  files: Set<string>,
  root: string,
  document: MarkdownDocument<Record<string, unknown>> | null,
  heading: string,
  entryLimit: number,
  emptyMessage: string,
): void {
  if (!document) {
    return;
  }

  const relativePath = toPosixPath(path.relative(root, document.path));
  files.add(relativePath);
  const entries = extractActiveWorkItemEntries(document.frontmatter).slice(0, entryLimit);
  const bodyIntro = summarizeText(document.body, 280);
  sections.push(
    [
      `## ${heading}`,
      "",
      `Source: ${relativePath}`,
      "",
      ...(bodyIntro ? [bodyIntro, ""] : []),
      entries.length > 0
        ? bulletLines(
            entries.map((entry) => {
              const tags = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
              const body = summarizeText(entry.body, 220) || "No details yet.";
              return `${entry.title}${tags}: ${body}`;
            }),
          )
        : emptyMessage,
    ].join("\n"),
  );
}

function extractActiveWorkItemEntries(frontmatter: Record<string, unknown>): WorkItemEntryFrontmatter[] {
  const entries = Array.isArray(frontmatter.entries) ? frontmatter.entries : [];
  return entries
    .map((entry) => workItemEntrySchema.safeParse(entry))
    .filter((entry): entry is { success: true; data: WorkItemEntryFrontmatter } => entry.success)
    .map((entry) => entry.data)
    .filter((entry) => ["active", "review"].includes(entry.status));
}

function addScopedChapterContextSection(
  sections: string[],
  files: Set<string>,
  root: string,
  document: MarkdownDocument<Record<string, unknown>> | MarkdownDocument<PlotFrontmatter> | null,
  heading: string,
  chapterCount: number,
  emptyMessage: string,
): void {
  if (!document) {
    return;
  }

  const relativePath = toPosixPath(path.relative(root, document.path));
  const scopedBody = buildScopedChapterContextBody(document.body, chapterCount, emptyMessage);
  files.add(relativePath);
  sections.push(
    [
      `## ${heading}`,
      "",
      `Source: ${relativePath}`,
      "",
      scopedBody,
    ].join("\n"),
  );
}

function buildScopedChapterContextBody(body: string, chapterCount: number, emptyMessage: string): string {
  const normalizedBody = String(body ?? "").trim();
  if (!normalizedBody) {
    return emptyMessage;
  }

  const chapterMatches = Array.from(normalizedBody.matchAll(/^## Chapter .*$/gm));
  if (chapterMatches.length === 0) {
    return summarizeText(normalizedBody, 1200) || emptyMessage;
  }

  const intro = normalizedBody.slice(0, chapterMatches[0].index ?? 0).trim();
  if (chapterCount <= 0) {
    return [intro, emptyMessage].filter(Boolean).join("\n\n");
  }

  const availableCount = Math.min(chapterCount, chapterMatches.length);
  const lastIncludedMatch = chapterMatches[availableCount - 1];
  const nextChapterMatch = chapterMatches[availableCount];
  const nextTopLevelHeadingIndex = findNextTopLevelHeadingIndex(normalizedBody, (lastIncludedMatch.index ?? 0) + 1);
  const endIndex = nextChapterMatch?.index ?? nextTopLevelHeadingIndex ?? normalizedBody.length;
  const scopedSections = normalizedBody.slice(chapterMatches[0].index ?? 0, endIndex).trim();

  return [intro, scopedSections].filter(Boolean).join("\n\n");
}

function findNextTopLevelHeadingIndex(body: string, fromIndex: number): number | null {
  const searchBody = body.slice(fromIndex);
  const match = /^# (?!#).*/m.exec(searchBody);
  return match?.index !== undefined ? fromIndex + match.index : null;
}

function stripSourceFilesSection(text: string): string {
  const marker = "\n## Source files consulted\n";
  const index = text.indexOf(marker);
  return index === -1 ? text : text.slice(0, index).trimEnd();
}

function chapterDraftWorkspaceRelativePath(chapterSlugValue: string, bucket: WorkItemBucket): string {
  const fileName = bucket === "ideas" ? "ideas.md" : bucket === "promoted" ? "promoted.md" : "notes.md";
  return toPosixPath(path.join("drafts", chapterSlugValue, fileName));
}

function chapterDraftNotesRelativePath(chapterSlugValue: string): string {
  return chapterDraftWorkspaceRelativePath(chapterSlugValue, "notes");
}

function chapterDraftIdeasRelativePath(chapterSlugValue: string): string {
  return chapterDraftWorkspaceRelativePath(chapterSlugValue, "ideas");
}

function chapterDraftPromotedRelativePath(chapterSlugValue: string): string {
  return chapterDraftWorkspaceRelativePath(chapterSlugValue, "promoted");
}

async function ensureChapterDraftWorkspaceFiles(root: string, chapterSlugValue: string): Promise<{
  notesFilePath: string;
  ideasFilePath: string;
  promotedFilePath: string;
}> {
  const notesFilePath = await ensureChapterDraftWorkspaceFile(root, chapterSlugValue, "notes");
  const ideasFilePath = await ensureChapterDraftWorkspaceFile(root, chapterSlugValue, "ideas");
  const promotedFilePath = await ensureChapterDraftWorkspaceFile(root, chapterSlugValue, "promoted");
  return { notesFilePath, ideasFilePath, promotedFilePath };
}

async function ensureChapterDraftWorkspaceFile(root: string, chapterSlugValue: string, bucket: WorkItemBucket): Promise<string> {
  const relativePath = chapterDraftWorkspaceRelativePath(chapterSlugValue, bucket);
  const absolutePath = path.join(root, relativePath);

  await mkdir(path.dirname(absolutePath), { recursive: true });
  if (!(await pathExists(absolutePath))) {
    const title =
      bucket === "ideas"
        ? `Chapter Draft Ideas ${chapterSlugValue}`
        : bucket === "promoted"
          ? `Chapter Draft Promoted ${chapterSlugValue}`
          : `Chapter Draft Notes ${chapterSlugValue}`;
    const frontmatter = noteSchema.parse({
      type: "note",
      id: `note:chapter-draft:${bucket}:${chapterSlugValue}`,
      title,
      scope: "chapter-draft",
      bucket,
      chapter: `chapter:${chapterSlugValue}`,
    });
    const body =
      bucket === "ideas"
        ? defaultChapterDraftIdeasBody()
        : bucket === "promoted"
          ? defaultChapterDraftPromotedBody()
          : defaultChapterDraftNotesBody();
    await writeFile(absolutePath, renderMarkdown(frontmatter, body), "utf8");
  }

  return absolutePath;
}

async function updateNoteDocument(
  root: string,
  options: {
    relativePath: string;
    baseFrontmatter: Record<string, unknown>;
    defaultBody: string;
    body?: string;
    appendBody?: string;
    frontmatterPatch?: Record<string, unknown>;
  },
): Promise<{ filePath: string; frontmatter: NoteFrontmatter }> {
  const filePath = path.join(root, options.relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });

  const existingRaw = await readFile(filePath, "utf8").catch(() => null);
  const parsed = existingRaw ? matter(existingRaw) : { data: {}, content: options.defaultBody };
  const currentBody = String(parsed.content ?? "").trim();
  const nextBody =
    options.body !== undefined
      ? options.body
      : options.appendBody
        ? appendMarkdownSection(currentBody, options.appendBody)
        : currentBody || options.defaultBody;

  const frontmatter = noteSchema.parse({
    ...options.baseFrontmatter,
    ...(parsed.data as Record<string, unknown>),
    ...(options.frontmatterPatch ?? {}),
  });

  await writeFile(filePath, renderMarkdown(frontmatter, nextBody), "utf8");
  return { filePath, frontmatter };
}

async function upsertWorkItemInNoteDocument(
  root: string,
  options: {
    relativePath: string;
    baseFrontmatter: Record<string, unknown>;
    defaultBody: string;
    entryId?: string;
    title: string;
    body: string;
    tags?: string[];
    status?: WorkItemEntryFrontmatter["status"];
  },
): Promise<{ filePath: string; frontmatter: NoteFrontmatter; entry: WorkItemEntryFrontmatter }> {
  const filePath = path.join(root, options.relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });

  const existingRaw = await readFile(filePath, "utf8").catch(() => null);
  const parsed = existingRaw ? matter(existingRaw) : { data: {}, content: options.defaultBody };
  const currentBody = String(parsed.content ?? "").trim() || options.defaultBody;
  const currentFrontmatter = noteSchema.parse({
    ...options.baseFrontmatter,
    ...(parsed.data as Record<string, unknown>),
  });
  const entries = [...(currentFrontmatter.entries ?? [])];
  const now = new Date().toISOString();
  const entryId = options.entryId ?? buildWorkItemId(currentFrontmatter.bucket);
  const existingIndex = entries.findIndex((entry) => entry.id === entryId);
  const nextEntry = workItemEntrySchema.parse({
    ...(existingIndex >= 0 ? entries[existingIndex] : {}),
    id: entryId,
    title: options.title,
    body: options.body,
    tags: options.tags ?? (existingIndex >= 0 ? entries[existingIndex].tags : []),
    status: options.status ?? (existingIndex >= 0 ? entries[existingIndex].status : "active"),
    created_at: existingIndex >= 0 ? entries[existingIndex].created_at : now,
    updated_at: now,
  });

  if (existingIndex >= 0) {
    entries[existingIndex] = nextEntry;
  } else {
    entries.push(nextEntry);
  }

  const frontmatter = noteSchema.parse({
    ...currentFrontmatter,
    entries,
  });
  await writeFile(filePath, renderMarkdown(frontmatter, currentBody), "utf8");
  return { filePath, frontmatter, entry: nextEntry };
}

async function promoteWorkItem(
  root: string,
  options: {
    sourceRelativePath: string;
    sourceBaseFrontmatter: Record<string, unknown>;
    sourceDefaultBody: string;
    promotedRelativePath: string;
    promotedBaseFrontmatter: Record<string, unknown>;
    promotedDefaultBody: string;
    entryId: string;
    promotedTo: string;
    target?: "notes" | "story-design";
    chapterSlugValue?: string;
  },
): Promise<{ sourceFilePath: string; promotedFilePath: string; promotedEntry: WorkItemEntryFrontmatter; targetFilePath?: string }> {
  const sourceFilePath = path.join(root, options.sourceRelativePath);
  const source = await readOrCreateNoteDocument(root, {
    relativePath: options.sourceRelativePath,
    baseFrontmatter: options.sourceBaseFrontmatter,
    defaultBody: options.sourceDefaultBody,
  });
  const sourceEntries = [...source.frontmatter.entries];
  const sourceIndex = sourceEntries.findIndex((entry) => entry.id === options.entryId);
  if (sourceIndex === -1) {
    throw new Error(`Work item ${options.entryId} not found in ${options.sourceRelativePath}`);
  }

  const entry = sourceEntries[sourceIndex];
  sourceEntries.splice(sourceIndex, 1);
  const sourceFrontmatter = noteSchema.parse({
    ...source.frontmatter,
    entries: sourceEntries,
  });
  await writeFile(sourceFilePath, renderMarkdown(sourceFrontmatter, source.body), "utf8");

  let targetFilePath: string | undefined;
  if (options.target === "notes") {
    const targetRelativePath = options.chapterSlugValue ? chapterDraftNotesRelativePath(options.chapterSlugValue) : NOTES_FILE;
    const targetBaseFrontmatter = options.chapterSlugValue
      ? {
          type: "note",
          id: `note:chapter-draft:notes:${options.chapterSlugValue}`,
          title: `Chapter Draft Notes ${options.chapterSlugValue}`,
          scope: "chapter-draft",
          bucket: "notes",
          chapter: `chapter:${options.chapterSlugValue}`,
        }
      : {
          type: "note",
          id: "note:book",
          title: "Book Notes",
          scope: "book",
          bucket: "notes",
        };
    const savedTarget = await upsertWorkItemInNoteDocument(root, {
      relativePath: targetRelativePath,
      baseFrontmatter: targetBaseFrontmatter,
      defaultBody: options.chapterSlugValue ? defaultChapterDraftNotesBody() : defaultBookNotesBody(),
      title: entry.title,
      body: entry.body,
      tags: entry.tags,
      status: "active",
    });
    targetFilePath = savedTarget.filePath;
  } else if (options.target === "story-design") {
    const result = await updateBookNotes(root, {
      target: "story-design",
      appendBody: formatPromotedStoryDesignSection(entry),
    });
    targetFilePath = result.filePath;
  }

  const promoted = await upsertWorkItemInNoteDocument(root, {
    relativePath: options.promotedRelativePath,
    baseFrontmatter: options.promotedBaseFrontmatter,
    defaultBody: options.promotedDefaultBody,
    title: entry.title,
    body: entry.body,
    tags: entry.tags,
    status: "promoted",
    entryId: entry.id,
  });

  const promotedEntry = workItemEntrySchema.parse({
    ...promoted.entry,
    source_kind: options.sourceRelativePath.includes("ideas") ? "idea" : "note",
    promoted_to: options.promotedTo,
    promoted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const promotedFrontmatter = noteSchema.parse({
    ...promoted.frontmatter,
    entries: promoted.frontmatter.entries.map((entryItem) => (entryItem.id === promotedEntry.id ? promotedEntry : entryItem)),
  });
  const promotedFilePath = path.join(root, options.promotedRelativePath);
  await writeFile(promotedFilePath, renderMarkdown(promotedFrontmatter, (await readOrCreateNoteDocument(root, {
    relativePath: options.promotedRelativePath,
    baseFrontmatter: options.promotedBaseFrontmatter,
    defaultBody: options.promotedDefaultBody,
  })).body), "utf8");

  return {
    sourceFilePath,
    promotedFilePath,
    promotedEntry,
    targetFilePath,
  };
}

async function readOrCreateNoteDocument(
  root: string,
  options: { relativePath: string; baseFrontmatter: Record<string, unknown>; defaultBody: string },
): Promise<{ filePath: string; frontmatter: NoteFrontmatter; body: string }> {
  const filePath = path.join(root, options.relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  const existingRaw = await readFile(filePath, "utf8").catch(() => null);
  const parsed = existingRaw ? matter(existingRaw) : { data: {}, content: options.defaultBody };
  const frontmatter = noteSchema.parse({
    ...options.baseFrontmatter,
    ...(parsed.data as Record<string, unknown>),
  });
  const body = String(parsed.content ?? "").trim() || options.defaultBody;
  if (!existingRaw) {
    await writeFile(filePath, renderMarkdown(frontmatter, body), "utf8");
  }
  return { filePath, frontmatter, body };
}

function buildWorkItemId(bucket: string): string {
  return `${bucket}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatPromotedStoryDesignSection(entry: WorkItemEntryFrontmatter): string {
  return [`## Promoted: ${entry.title}`, "", entry.body.trim() || "No body."]
    .filter((value) => value.length > 0)
    .join("\n");
}

function defaultWritingStyleBody(): string {
  return [
    "Act as a narrative editor experienced in historical fiction and high-tension scenes.",
    "",
    "This file defines the book's writing and review contract. Read it before drafting or revising any chapter or paragraph.",
    "",
    "# Invariants",
    "",
    "- Do not change scene content without a real narrative reason.",
    "- Do not change the meaning of conflict, intention, or information.",
    "- Do not alter dialogue that already works.",
    "- Do not rewrite for the sake of sounding more literary.",
    "- Intervene only when the page gains clarity, tension, rhythm, physicality, or narrative density.",
    "",
    "# Objective",
    "",
    "Push the prose toward something that is:",
    "",
    "- visual when it matters",
    "- fast when it should move quickly",
    "- physical in key moments",
    "- clear without unnecessary explanation",
    "- dynamic in space",
    "- controlled rather than overwritten",
    "",
    "The reader should see what matters, understand without being over-guided, and never feel delayed by ornamental prose.",
    "",
    "# Core Principle",
    "",
    "Not everything should be shown.",
    "",
    "Use this rule:",
    "- key moments -> show (action, physicality, detail, subtext)",
    "- transitions and information -> tell (fast, quiet, clean)",
    "",
    "Strong prose does not always show more. It shows better where pressure matters and tells quickly where delay would weaken the scene.",
    "",
    "# 1. Show, Don't Tell (targeted use)",
    "",
    "Move toward show when:",
    "- tension is rising",
    "- conflict is active",
    "- something changes",
    "- the reader needs to feel the weight of the moment",
    "",
    "Allow tell when:",
    "- rapid context is enough",
    "- the prose is bridging one dramatic unit to the next",
    "- the information matters less than the pressure of the scene",
    "",
    "Weak example:",
    "- He was furious.",
    "",
    "Stronger example:",
    "- He tightened his grip on the glass until it trembled.",
    "",
    "# 2. Remove unnecessary explanation",
    "",
    "Remove:",
    "- obvious interpretation",
    "- doubled explanation",
    "- sentences that repeat what is already visible",
    "- commentary that explains subtext instead of letting it work",
    "",
    "Do not sacrifice clarity just to show more. If a line must stay quick and informative, let it stay quick and informative.",
    "",
    "# 3. Intelligent physicality",
    "",
    "Add physicality only when it:",
    "- increases tension",
    "- reveals emotional state",
    "- changes the relationship between characters",
    "- shifts the pressure of the exchange",
    "",
    "Avoid:",
    "- random gestures",
    "- filler motion",
    "- movement used only to avoid `said`",
    "- repeated stock gestures",
    "",
    "# 4. Variety of action",
    "",
    "Alternate:",
    "- micro: eyes, fingers, breath",
    "- macro: movement in space",
    "- objects: concrete interaction",
    "- posture: dominance, withdrawal, resistance, collapse",
    "",
    "Every action must do work. If it does not change how the line or moment is read, it is not enough.",
    "",
    "# 5. Active space",
    "",
    "Space is not neutral background. It must participate in the scene.",
    "",
    "Characters should be able to:",
    "- move closer",
    "- move away",
    "- occupy space",
    "- surrender space",
    "- use doors, walls, tables, thresholds, and furniture as narrative pressure",
    "",
    "Space should reveal tension, power, and relationship.",
    "",
    "# 6. Objects with function",
    "",
    "Objects should be used, handled, or suffered.",
    "",
    "An object is useful when it:",
    "- clarifies status",
    "- shows control or agitation",
    "- creates contrast with the dialogue",
    "- makes the subtext physical",
    "",
    "Avoid decorative objects that do not carry dramatic value.",
    "",
    "# 7. Avoid weak phrasing",
    "",
    "Reduce or remove:",
    "- seemed",
    "- as if",
    "- almost",
    "- as though",
    "",
    "Keep them only when genuine ambiguity is necessary.",
    "",
    "# 8. Subtext",
    "",
    "Whenever possible:",
    "- replace explanation with behavior",
    "- let dialogue contradict action",
    "- let distance, hesitation, touch, silence, and objects carry pressure",
    "",
    "Subtext is strongest when the prose does not explain it aloud.",
    "",
    "# 9. Rhythm",
    "",
    "Alternate dialogue, brief action, and pause.",
    "",
    "Use rhythm to:",
    "- accelerate tension",
    "- slow down at points of weight",
    "- let a line land before the next one arrives",
    "",
    "Avoid long static blocks and sequences of interchangeable actions.",
    "",
    "# 10. Density",
    "",
    "Every sentence should do at least one of these things:",
    "- move the scene forward",
    "- show tension",
    "- reveal character",
    "- clarify dynamics",
    "",
    "If it does none of them, cut or simplify it.",
    "",
    "# Dialogue and narration",
    "",
    "- Keep original dialogue unless a change is genuinely necessary.",
    "- Define here how the book handles narrative person, POV distance, tense, and direct speech.",
    "- If one chapter needs special handling, add a `writing-style.md` file inside that chapter or draft chapter folder.",
    "- The global file remains active even when a local override exists.",
    "",
    "# Dialogue action beats",
    "",
    "- Use an action beat beside dialogue only when it gives the reader something that `said` cannot.",
    "- An action beat is strong when it clarifies space, psychology, power dynamics, subtext, or the use of objects in the scene.",
    "- If the action is decorative or exists only to avoid `said`, prefer a simple tag like `said` or `asked`, or no tag at all if turn-taking is already clear.",
    "- Avoid ornamental gestures, mechanical body mapping, and action that explains the body instead of using it to carry conflict.",
    "- When you add an action beat, make it reveal at least one of these things: the place, the distance, the unspoken tension, control, fear, resistance, desire, or status.",
    "",
    "Weak example:",
    "- Sergio moved his hair to one side. \"How are you?\"",
    "",
    "Why it is weak:",
    "- the gesture does not change the conflict",
    "- it does not clarify the relationship",
    "- it does not use space",
    "- it feels inserted only to avoid `said`",
    "",
    "Stronger example:",
    "- Sergio shortened the distance before speaking. \"How are you?\"",
    "",
    "Why it works better:",
    "- it turns space into pressure",
    "- it changes how the line is read",
    "- it clarifies the power dynamic",
    "",
    "Correct fallback when no useful beat exists:",
    "- \"How are you?\" said Sergio.",
    "",
    "# Recurring tics",
    "",
    "- If a character shows a possible recurring tic, use it sparingly and only if it matches the character's psychology.",
    "- Do not turn every scene into a display case of tics.",
    "- If a tic seems strong, observe it across multiple scenes or keep it in character notes before stabilizing it in canon.",
    "",
    "# Expected output for writing and review",
    "",
    "- In drafting: produce a scene that is clear, tense, concrete, and controlled.",
    "- In review: improve action, rhythm, rendering, and blocking without unnecessarily changing content.",
    "- Keep dialogue changes minimal when the dialogue already works.",
    "- Do not add explanation outside the prose itself.",
    "",
    "# Desired style",
    "",
    "- precise",
    "- concrete",
    "- controlled, not over-described",
    "- visual at key moments",
    "- fluid elsewhere",
    "- tension implied rather than declared",
  ].join("\n");
}

function defaultBookNotesBody(): string {
  return [
    "# Active Notes",
    "",
    "Use this file for general book notes, reminders, unresolved decisions, and anything that should stay visible outside a single chapter draft.",
    "",
    "## Open Questions",
    "",
    "- Add open questions here.",
    "",
    "## Continuity Reminders",
    "",
    "- Add continuity reminders here.",
    "",
    "## Future Ideas",
    "",
    "- Add future ideas here.",
  ].join("\n");
}

function defaultIdeasBody(): string {
  return [
    "# Active Ideas",
    "",
    "Use this file for unstable or exploratory ideas that still need review before they become notes, design decisions, or draft material.",
    "",
    "Promote reviewed ideas into notes, story design, or a draft workflow instead of leaving them active forever.",
  ].join("\n");
}

function defaultPromotedBody(): string {
  return [
    "# Promoted Items",
    "",
    "This file keeps the history of ideas and notes that were moved into notes, story design, or drafts so they leave the active queues without being lost.",
  ].join("\n");
}

function defaultStoryDesignBody(): string {
  return [
    "# Core Design",
    "",
    "Describe the core shape of the book and what kind of narrative engine keeps it moving.",
    "",
    "## Central Conflict",
    "",
    "- State the pressure that keeps the whole book in motion.",
    "",
    "## Main Arcs",
    "",
    "- Track the major arcs and how they should interweave.",
    "",
    "## Reveal Strategy",
    "",
    "- Note where secrets, reversals, and payoff chains should land.",
    "",
    "## Structural Beats",
    "",
    "- Capture the major movements of the book, even when chapter details are still provisional.",
    "",
    "## Ending Shape",
    "",
    "- Record the intended ending pressure, emotional landing, and what the final chapters must resolve.",
  ].join("\n");
}

function defaultChapterDraftNotesBody(): string {
  return [
    "# Chapter Notes",
    "",
    "Use this file for local draft notes tied to the chapter, including optional scene goals, reminders, and unresolved fixes.",
    "",
    "## Scene Goals",
    "",
    "- Add the intended scene goals here.",
    "",
    "## Risks And Continuity Checks",
    "",
    "- Add continuity risks or checks here.",
    "",
    "## Lines Or Images To Reuse",
    "",
    "- Add fragments, images, and phrasing worth carrying into final prose.",
  ].join("\n");
}

function defaultChapterDraftIdeasBody(): string {
  return [
    "# Chapter Ideas",
    "",
    "Use this file for unstable chapter-level ideas that still need review before becoming notes or draft material.",
  ].join("\n");
}

function defaultChapterDraftPromotedBody(): string {
  return [
    "# Chapter Promoted Items",
    "",
    "This file keeps promoted chapter ideas and notes after they were moved into chapter notes, story design, or draft work.",
  ].join("\n");
}

function buildChapterOverviewSummary(chapterData: {
  metadata: ChapterFrontmatter;
  body: string;
  paragraphs: Array<{ metadata: ParagraphFrontmatter; body: string }>;
}): string {
  if (chapterData.metadata.summary?.trim()) {
    return chapterData.metadata.summary;
  }

  const sceneSummaries = chapterData.paragraphs
    .map((paragraph) => paragraph.metadata.summary ?? summarizeText(paragraph.body, 140))
    .filter((value): value is string => Boolean(value && value.trim()))
    .slice(0, 3);

  if (sceneSummaries.length > 0) {
    return sceneSummaries.join(" ");
  }

  return summarizeText(chapterData.body, 260) || "Add chapter summary here.";
}

function compactFrontmatterPatch(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }),
  );
}

async function listLatestConversationExports(
  root: string,
  limit: number,
): Promise<Array<{ relativePath: string; title: string; excerpt: string }>> {
  const files = await fg("conversations/sessions/*.md", {
    cwd: root,
    absolute: true,
    onlyFiles: true,
  });

  const ranked = await Promise.all(
    files.map(async (filePath) => {
      const info = await stat(filePath);
      const document = await readLooseMarkdownIfExists(filePath);
      return {
        filePath,
        mtimeMs: info.mtimeMs,
        document,
      };
    }),
  );

  return ranked
    .filter((entry): entry is { filePath: string; mtimeMs: number; document: MarkdownDocument<Record<string, unknown>> } => Boolean(entry.document))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((entry) => ({
      relativePath: toPosixPath(path.relative(root, entry.filePath)),
      title:
        (typeof entry.document.frontmatter.title === "string" && entry.document.frontmatter.title) ||
        path.basename(entry.filePath, ".md"),
      excerpt: summarizeText(entry.document.body, 700) || "No conversation content yet.",
    }));
}

async function buildReferenceLookup(root: string, chapters?: Array<{ slug: string; metadata: ChapterFrontmatter }>): Promise<Set<string>> {
  const references = new Set<string>(["book", "plot:main"]);
  const chapterList = chapters ?? (await listChapters(root));

  for (const chapter of chapterList) {
    references.add(String(chapter.metadata.id ?? `chapter:${chapter.slug}`).toLowerCase());
    references.add(`chapter:${chapter.slug}`.toLowerCase());
    references.add(chapter.slug.toLowerCase());

    const chapterData = await readChapter(root, chapter.slug);
    for (const paragraph of chapterData.paragraphs) {
      const paragraphSlug = path.basename(paragraph.path, ".md");
      references.add(String(paragraph.metadata.id).toLowerCase());
      references.add(`paragraph:${chapter.slug}:${paragraphSlug}`.toLowerCase());
    }
  }

  for (const kind of ENTITY_TYPES) {
    const entities = await listEntities(root, kind);
    for (const entity of entities) {
      references.add(String(entity.metadata.id ?? `${kind}:${entity.slug}`).toLowerCase());
      references.add(`${kind}:${entity.slug}`.toLowerCase());
    }
  }

  const guidelines = await listGuidelines(root);
  for (const guideline of guidelines) {
    references.add(String(guideline.frontmatter.id).toLowerCase());
  }

  return references;
}

async function buildEntityReferenceLookup(root: string, kind: EntityType): Promise<Set<string>> {
  const references = new Set<string>();
  const entities = await listEntities(root, kind);
  for (const entity of entities) {
    references.add(String(entity.metadata.id ?? `${kind}:${entity.slug}`).toLowerCase());
    references.add(`${kind}:${entity.slug}`.toLowerCase());
  }
  return references;
}

function collectSupportedReferences(frontmatter: Record<string, unknown>, body: string): string[] {
  const references = new Set<string>();
  collectReferencesFromValue(frontmatter, references);

  for (const match of body.matchAll(SUPPORTED_REFERENCE_PATTERN)) {
    if (match[0]) {
      references.add(match[0]);
    }
  }

  return Array.from(references);
}

function collectReferencesFromValue(value: unknown, references: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(SUPPORTED_REFERENCE_PATTERN)) {
      if (match[0]) {
        references.add(match[0]);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectReferencesFromValue(entry, references);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectReferencesFromValue(entry, references);
    }
  }
}

function resolveChapterNumberFromReference(reference: unknown, chapterOrder: Map<string, number>): number | null {
  if (typeof reference !== "string") {
    return null;
  }

  for (const [slug, number] of chapterOrder.entries()) {
    if (matchesChapterReference(reference, slug)) {
      return number;
    }
  }

  return null;
}

function normalizeComparableMarkdown(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function addDoctorIssue(issues: DoctorIssue[], seen: Set<string>, issue: DoctorIssue): void {
  const key = `${issue.severity}:${issue.code}:${issue.path}:${issue.message}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  issues.push(issue);
}

function collectChapterTimelineEvents(
  chapter: { slug: string; metadata: ChapterFrontmatter },
  timelineEvents: CanonEntityDocument[],
): string[] {
  const chapterRef = typeof chapter.metadata.timeline_ref === "string" ? chapter.metadata.timeline_ref.trim() : "";
  const chapterId = `chapter:${chapter.slug}`;
  const matchingEvents = timelineEvents.filter((event) => {
    const eventId = String(event.metadata.id ?? "");
    const eventTitle = String(event.metadata.title ?? "");
    const participants = Array.isArray(event.metadata.participants) ? event.metadata.participants.map((value) => String(value)) : [];
    return [eventId, eventTitle, ...participants].some((value) => value === chapterRef || value === chapterId || value === chapter.slug);
  });

  if (matchingEvents.length === 0) {
    return chapterRef ? [`Timeline reference: ${chapterRef}`] : [];
  }

  return matchingEvents.map((event) => {
    const title = String(event.metadata.title ?? event.metadata.id ?? event.slug);
    const date = typeof event.metadata.date === "string" ? event.metadata.date : undefined;
    const significance = typeof event.metadata.significance === "string" ? event.metadata.significance : undefined;
    return [
      title,
      date ? `date ${date}` : undefined,
      significance ? summarizeText(significance, 120) : undefined,
    ]
      .filter(Boolean)
      .join(" - ");
  });
}

function formatPlotSecretLine(metadata: Record<string, unknown>): string {
  const title = String(metadata.title ?? metadata.id ?? "Unnamed secret");
  const revealStrategy = typeof metadata.reveal_strategy === "string" ? summarizeText(metadata.reveal_strategy, 130) : "reveal method not set";
  const holders = Array.isArray(metadata.holders) ? metadata.holders.map((value) => String(value)).filter(Boolean) : [];
  const knownFrom = typeof metadata.known_from === "string" ? metadata.known_from : undefined;
  return [
    `${title}`,
    `how: ${revealStrategy}`,
    `by: ${holders.join(", ") || "not set"}`,
    knownFrom ? `safe from: ${knownFrom}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

function formatPlotSecretParkingLine(metadata: Record<string, unknown>): string {
  const title = String(metadata.title ?? metadata.id ?? "Unnamed secret");
  const revealIn = typeof metadata.reveal_in === "string" ? metadata.reveal_in : "not assigned";
  return `${title} - reveal_in: ${revealIn}`;
}

function matchesAnyChapter(reference: unknown, chapterSlugs: string[]): boolean {
  return chapterSlugs.some((chapterSlugValue) => matchesChapterReference(reference, chapterSlugValue));
}

function matchesChapterReference(reference: unknown, chapterSlugValue: string): boolean {
  if (typeof reference !== "string") return false;
  const normalized = reference.trim();
  if (!normalized) return false;
  return [normalized, normalized.replace(/^chapter:/, ""), normalized.replace(/^chapters\//, "").replace(/\/chapter\.md$/, "")].includes(chapterSlugValue);
}

function appendMarkdownSection(existingBody: string, appended: string): string {
  if (!existingBody.trim()) return appended.trim();
  return `${existingBody.trim()}\n\n${appended.trim()}`;
}

function summarizeText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function bulletLines(values: Array<string | undefined> | undefined): string {
  const filtered = (values ?? []).filter((value): value is string => Boolean(value && value.trim()));
  return filtered.length > 0 ? filtered.map((value) => `- ${value}`).join("\n") : "- Add notes here.";
}

function toPrefixedList(prefix: string, values: string[] | undefined): string[] {
  return (values ?? []).map((value) => `${prefix}: ${value}`);
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

// ─── Persona types ────────────────────────────────────────────────────────────

export type CreatePersonaInput = {
  name: string;
  archetype: string;
  slug?: string;
  ageRange?: string;
  readingHabits?: string;
  values?: string[];
  dislikes?: string[];
  beautyFocus?: string[];
  readabilityFocus?: string[];
  emotionalTriggers?: string[];
  complexityTolerance?: number;
  pacingTolerance?: number;
  builtin?: boolean;
  tags?: string[];
  body?: string;
  overwrite?: boolean;
};

export type PersonaReviewInput = {
  /** Slug of the chapter to review */
  chapterSlug: string;
  /** Slugs of personas to use; if empty, uses all personas in the book */
  personaSlugs?: string[];
  /**
   * LLM-supplied review entries — one per persona.
   * The caller (MCP tool) reads the chapter prose and each persona profile,
   * then produces these structured reviews.
   */
  reviews: PersonaReviewEntry[];
};

export type PersonaReviewEntry = {
  personaSlug: string;
  personaName: string;
  /** 1–10 beauty score from this persona's perspective */
  beautyScore: number;
  /** 1–10 readability score from this persona's perspective */
  readabilityScore: number;
  /** 2–4 sentence overall impression */
  overallImpression: string;
  /** What this persona loved */
  strengths: string[];
  /** What this persona struggled with or disliked */
  concerns: string[];
  /** Concrete suggestions from this persona's point of view */
  suggestions: string[];
};

// ─── Default personas ─────────────────────────────────────────────────────────

export const DEFAULT_PERSONAS: Omit<CreatePersonaInput, "overwrite">[] = [
  {
    name: "The Casual Reader",
    archetype: "casual reader",
    slug: "casual-reader",
    ageRange: "25–45",
    readingHabits: "Reads for entertainment, mostly on evenings and weekends. Prefers page-turners and avoids dense prose.",
    values: ["engaging plot", "relatable characters", "emotional payoff", "clear writing"],
    dislikes: ["slow openings", "excessive description", "confusing timelines", "too many characters at once"],
    beautyFocus: ["vivid imagery", "memorable lines", "emotional resonance"],
    readabilityFocus: ["sentence clarity", "paragraph flow", "easy-to-follow dialogue"],
    emotionalTriggers: ["character in danger", "unexpected betrayal", "tender moments between characters"],
    complexityTolerance: 2,
    pacingTolerance: 2,
    builtin: true,
    tags: ["default"],
  },
  {
    name: "The Literary Critic",
    archetype: "literary critic",
    slug: "literary-critic",
    ageRange: "35–60",
    readingHabits: "Reads widely across genres and periods. Values craft, subtext, and originality above entertainment.",
    values: ["prose craft", "thematic depth", "originality", "subtext", "structural coherence"],
    dislikes: ["clichés", "flat characters", "on-the-nose dialogue", "unearned emotional beats"],
    beautyFocus: ["sentence rhythm", "metaphor quality", "voice distinctiveness", "tonal consistency"],
    readabilityFocus: ["paragraph architecture", "scene transitions", "point-of-view discipline"],
    emotionalTriggers: ["moral ambiguity", "language used as revelation", "earned catharsis"],
    complexityTolerance: 5,
    pacingTolerance: 5,
    builtin: true,
    tags: ["default"],
  },
  {
    name: "The Genre Fan",
    archetype: "genre fan",
    slug: "genre-fan",
    ageRange: "20–40",
    readingHabits: "Reads heavily within a specific genre. Has strong genre expectations and notices when conventions are broken.",
    values: ["genre conventions", "world-building consistency", "satisfying tropes", "fast pacing"],
    dislikes: ["genre-bending without payoff", "slow world-building", "weak antagonists", "unresolved plot threads"],
    beautyFocus: ["atmospheric description", "action clarity", "world-building detail"],
    readabilityFocus: ["action scene pacing", "exposition balance", "chapter hooks"],
    emotionalTriggers: ["high-stakes confrontations", "power reveals", "found-family moments"],
    complexityTolerance: 3,
    pacingTolerance: 2,
    builtin: true,
    tags: ["default"],
  },
  {
    name: "The Empathetic Reader",
    archetype: "empathetic reader",
    slug: "empathetic-reader",
    ageRange: "18–50",
    readingHabits: "Reads primarily for emotional connection. Cares deeply about characters and their inner lives.",
    values: ["emotional authenticity", "character interiority", "meaningful relationships", "vulnerability"],
    dislikes: ["emotionally flat characters", "rushed relationships", "trauma used as decoration", "unresolved emotional arcs"],
    beautyFocus: ["emotional language", "sensory detail tied to feeling", "authentic dialogue"],
    readabilityFocus: ["interiority clarity", "emotional scene pacing", "relationship dynamics"],
    emotionalTriggers: ["grief", "reconciliation", "self-discovery", "sacrifice"],
    complexityTolerance: 3,
    pacingTolerance: 4,
    builtin: true,
    tags: ["default"],
  },
  {
    name: "The Impatient Skimmer",
    archetype: "impatient skimmer",
    slug: "impatient-skimmer",
    ageRange: "16–30",
    readingHabits: "Reads quickly, often skips description-heavy passages. Needs constant forward momentum to stay engaged.",
    values: ["fast pacing", "punchy dialogue", "immediate stakes", "short chapters"],
    dislikes: ["long descriptions", "flashbacks", "internal monologue", "slow build-up"],
    beautyFocus: ["punchy sentences", "striking opening lines", "visual immediacy"],
    readabilityFocus: ["sentence length variety", "white space", "dialogue-to-prose ratio"],
    emotionalTriggers: ["immediate conflict", "cliffhangers", "snappy banter"],
    complexityTolerance: 1,
    pacingTolerance: 1,
    builtin: true,
    tags: ["default"],
  },
];

// ─── Persona functions ────────────────────────────────────────────────────────

export async function createPersona(
  rootPath: string,
  input: CreatePersonaInput,
): Promise<{ filePath: string; frontmatter: PersonaFrontmatter }> {
  const slug = input.slug ?? slugify(input.name);
  const filePath = path.join(rootPath, PERSONAS_DIRECTORY, `${slug}.md`);

  if (!input.overwrite && await pathExists(filePath)) {
    throw new Error(`Persona already exists at ${filePath}. Use overwrite: true to replace it.`);
  }

  await mkdir(path.join(rootPath, PERSONAS_DIRECTORY), { recursive: true });

  const frontmatter: Record<string, unknown> = {
    type: "persona",
    id: `persona:${slug}`,
    name: input.name,
    archetype: input.archetype,
    age_range: input.ageRange,
    reading_habits: input.readingHabits,
    values: input.values ?? [],
    dislikes: input.dislikes ?? [],
    beauty_focus: input.beautyFocus ?? [],
    readability_focus: input.readabilityFocus ?? [],
    emotional_triggers: input.emotionalTriggers ?? [],
    complexity_tolerance: input.complexityTolerance ?? 3,
    pacing_tolerance: input.pacingTolerance ?? 3,
    builtin: input.builtin ?? false,
    tags: input.tags ?? [],
  };

  const body = input.body ?? buildPersonaBody(input);
  const content = renderMarkdown(frontmatter, body);
  await writeFile(filePath, content, "utf8");

  return { filePath, frontmatter: personaSchema.parse(frontmatter) };
}

export async function loadPersonas(rootPath: string): Promise<Array<{ filePath: string; frontmatter: PersonaFrontmatter; body: string }>> {
  const dir = path.join(rootPath, PERSONAS_DIRECTORY);
  const exists = await pathExists(dir);
  if (!exists) return [];

  const files = await fg(`${toPosixPath(dir)}/*.md`);
  const results: Array<{ filePath: string; frontmatter: PersonaFrontmatter; body: string }> = [];

  for (const file of files.sort()) {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = matter(raw);
      const fm = personaSchema.parse({ ...parsed.data });
      results.push({ filePath: file, frontmatter: fm, body: parsed.content.trim() });
    } catch {
      // skip malformed files
    }
  }

  return results;
}

export async function seedDefaultPersonas(rootPath: string): Promise<string[]> {
  const created: string[] = [];
  for (const persona of DEFAULT_PERSONAS) {
    const slug = persona.slug ?? slugify(persona.name);
    const filePath = path.join(rootPath, PERSONAS_DIRECTORY, `${slug}.md`);
    if (await pathExists(filePath)) continue;
    const result = await createPersona(rootPath, { ...persona, overwrite: false });
    created.push(result.filePath);
  }
  return created;
}

export async function writePersonasReview(
  rootPath: string,
  chapterSlug: string,
  input: PersonaReviewInput,
): Promise<{ filePath: string }> {
  const filePath = path.join(rootPath, "evaluations", "chapters", chapterSlug, PERSONAS_REVIEW_FILENAME);
  await mkdir(path.dirname(filePath), { recursive: true });

  const now = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `---`,
    `type: personas-review`,
    `id: "personas-review:${chapterSlug}"`,
    `chapter: "${chapterSlug}"`,
    `updated_at: "${now}"`,
    `persona_count: ${input.reviews.length}`,
    `---`,
    ``,
    `# Personas Review — ${chapterSlug}`,
    ``,
    `*${input.reviews.length} reader persona${input.reviews.length === 1 ? "" : "s"} reviewed this chapter on ${now}.*`,
    ``,
  ];

  for (const review of input.reviews) {
    const beautyBar = ratingBar(review.beautyScore);
    const readabilityBar = ratingBar(review.readabilityScore);
    lines.push(`## ${review.personaName}`);
    lines.push(``);
    lines.push(`| Dimension | Score |`);
    lines.push(`|-----------|-------|`);
    lines.push(`| Beauty | ${beautyBar} ${review.beautyScore}/10 |`);
    lines.push(`| Readability | ${readabilityBar} ${review.readabilityScore}/10 |`);
    lines.push(``);
    lines.push(`### Overall impression`);
    lines.push(``);
    lines.push(review.overallImpression.trim());
    lines.push(``);
    if (review.strengths.length > 0) {
      lines.push(`### What worked`);
      lines.push(``);
      for (const s of review.strengths) lines.push(`- ${s}`);
      lines.push(``);
    }
    if (review.concerns.length > 0) {
      lines.push(`### What didn't work`);
      lines.push(``);
      for (const c of review.concerns) lines.push(`- ${c}`);
      lines.push(``);
    }
    if (review.suggestions.length > 0) {
      lines.push(`### Suggestions`);
      lines.push(``);
      for (const s of review.suggestions) lines.push(`- ${s}`);
      lines.push(``);
    }
    lines.push(`---`);
    lines.push(``);
  }

  await writeFile(filePath, lines.join("\n"), "utf8");
  return { filePath };
}

function buildPersonaBody(input: CreatePersonaInput): string {
  const sections: string[] = [];

  // ── Persona profile ──────────────────────────────────────────────────────
  // A narrative paragraph that helps an LLM understand who this reader is,
  // what they want from a book, and what will make them put it down.
  const profileParts: string[] = [];

  if (input.archetype) {
    profileParts.push(`**${input.name}** is a ${input.archetype}${input.ageRange ? ` (${input.ageRange})` : ""}.`);
  }
  if (input.readingHabits) {
    profileParts.push(input.readingHabits);
  }
  if (input.values && input.values.length > 0) {
    profileParts.push(`They value ${input.values.join(", ")}.`);
  }
  if (input.dislikes && input.dislikes.length > 0) {
    profileParts.push(`They lose patience with ${input.dislikes.join(", ")}.`);
  }
  if (input.emotionalTriggers && input.emotionalTriggers.length > 0) {
    profileParts.push(`They respond strongly to ${input.emotionalTriggers.join(", ")}.`);
  }

  const complexityLabel = input.complexityTolerance != null
    ? ["very low", "low", "moderate", "high", "very high"][Math.max(0, Math.min(4, input.complexityTolerance - 1))]
    : null;
  const pacingLabel = input.pacingTolerance != null
    ? ["very low", "low", "moderate", "high", "very high"][Math.max(0, Math.min(4, input.pacingTolerance - 1))]
    : null;

  if (complexityLabel || pacingLabel) {
    const tolerances: string[] = [];
    if (complexityLabel) tolerances.push(`complexity tolerance is ${complexityLabel}`);
    if (pacingLabel) tolerances.push(`pacing tolerance is ${pacingLabel}`);
    profileParts.push(`Their ${tolerances.join(" and ")}.`);
  }

  if (profileParts.length > 0) {
    sections.push(`## Persona profile\n\n${profileParts.join(" ")}`);
  }

  // ── Craft focus ──────────────────────────────────────────────────────────
  const craftParts: string[] = [];
  if (input.beautyFocus && input.beautyFocus.length > 0) {
    craftParts.push(`**Beauty focus:** ${input.beautyFocus.join(", ")}.`);
  }
  if (input.readabilityFocus && input.readabilityFocus.length > 0) {
    craftParts.push(`**Readability focus:** ${input.readabilityFocus.join(", ")}.`);
  }
  if (craftParts.length > 0) {
    sections.push(`## Craft focus\n\n${craftParts.join("\n\n")}`);
  }

  return sections.join("\n\n");
}

function ratingBar(score: number): string {
  const filled = Math.round(Math.max(0, Math.min(10, score)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}
