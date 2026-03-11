import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fg from "fast-glob";
import matter from "gray-matter";
import { marked } from "marked";
import {
  BOOK_DIRECTORIES,
  BOOK_FILE,
  CONTENT_GLOB,
  DEFAULT_CANON,
  ENTITY_TYPE_TO_DIRECTORY,
  ENTITY_TYPES,
  GUIDELINE_FILES,
  PLOT_FILE,
  SKILL_NAME,
  STORY_STATE_CURRENT_FILE,
  STORY_STATE_STATUS_FILE,
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
  entitySchemaMap,
  factionSchema,
  guidelineSchema,
  itemSchema,
  locationSchema,
  paragraphSchema,
  paragraphDraftSchema,
  plotSchema,
  researchNoteSchema,
  secretSchema,
  type BookFrontmatter,
  type AssetFrontmatter,
  type CharacterFrontmatter,
  type ChapterFrontmatter,
  type ChapterDraftFrontmatter,
  type EntityType,
  type FactionFrontmatter,
  type GuidelineFrontmatter,
  type ItemFrontmatter,
  type LocationFrontmatter,
  type ParagraphFrontmatter,
  type ParagraphDraftFrontmatter,
  type PlotFrontmatter,
  type SecretFrontmatter,
  type TimelineEventFrontmatter,
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
    GUIDELINE_FILES.prose,
    renderMarkdown(
      guidelineSchema.parse({
        type: "guideline",
        id: "guideline:prose",
        title: "Prose Defaults",
        scope: "prose",
      }),
      [
        "# Writing Mode",
        "",
        "- Default mode: novel prose.",
        "- Prioritize scene-based writing over summary whenever the moment matters emotionally or narratively.",
        "- Before drafting a chapter or paragraph, read this file, the relevant chapter files, matching drafts/, and the latest resumes/ for continuity.",
        "- This file defines the book-level prose default. If a chapter does not declare its own style profile, use this default together with guidelines/style.md and guidelines/voices.md.",
        "- Chapter-level style changes must be explicit in chapter frontmatter, not inferred.",
        "",
        "# Show, Don't Tell",
        "",
        "- Prefer action, concrete sensory detail, subtext, and consequence over explanatory narration.",
        "- State emotion directly only when restraint would make the moment less clear or less powerful.",
        "- Let readers infer motive from gesture, choice, rhythm, and contradiction.",
        "",
        "Example tell:",
        "She was angry.",
        "",
        "Example show:",
        "She folded the letter once, twice, and only stopped when the paper split under her thumbs.",
        "",
        "# Dialogue",
        "",
        "- In Italian-language projects, use guillemets like « ... » as the default dialogue marks unless the book says otherwise.",
        "- Keep dialogue anchored with gesture, interruption, and point-of-view awareness.",
        "- Avoid over-explaining what a line already implies.",
        "- Keep each speaker distinct in vocabulary, rhythm, and silence.",
        "",
        "# Scene Discipline",
        "",
        "- Every paragraph or scene should advance tension, revelation, choice, or consequence.",
        "- Re-read previous scenes in the chapter before adding new prose so voice, time, and causality stay aligned.",
        "- If a matching draft exists in drafts/, use it as scaffolding, not as a constraint against stronger prose.",
      ].join("\n"),
    ),
    created,
  );

  await ensureFile(
    root,
    GUIDELINE_FILES.style,
    renderMarkdown(
      guidelineSchema.parse({
        type: "guideline",
        id: "guideline:style",
        title: "Style Guide",
        scope: "global",
      }),
      [
        "# Book-Level Default Style",
        "",
        "- Define the default sentence rhythm, descriptive density, and tonal ceiling for the whole book.",
        "- If a chapter does not declare `style_refs`, `narration_person`, `narration_tense`, or `prose_mode`, this guide stays in force.",
        "- Chapter-specific style changes must be declared explicitly in chapter frontmatter.",
        "",
        "# Taboo Patterns",
        "",
        "- List habits the book should avoid globally.",
        "",
        "# Examples",
        "",
        "- Add default sentence and paragraph examples here.",
      ].join("\n"),
    ),
    created,
  );

  await ensureFile(
    root,
    GUIDELINE_FILES.chapterRules,
    renderMarkdown(
      guidelineSchema.parse({
        type: "guideline",
        id: "guideline:chapter-rules",
        title: "Chapter Rules",
        scope: "chapters",
      }),
      "# Rules\n\n- Define how chapters open, escalate, and close.\n",
    ),
    created,
  );

  await ensureFile(
    root,
    GUIDELINE_FILES.voices,
    renderMarkdown(
      guidelineSchema.parse({
        type: "guideline",
        id: "guideline:voices",
        title: "Voices",
        scope: "voice",
      }),
      [
        "# Default Narration",
        "",
        "- Define the default narrator distance, internality, and diction for the book.",
        "- Record how first-person, close-third, or omniscient moments should behave if they appear.",
        "",
        "# Alternate Voice Notes",
        "",
        "- If a chapter needs a distinct narrator or diction set, create a style profile in guidelines/styles/ and reference it explicitly from that chapter.",
      ].join("\n"),
    ),
    created,
  );

  await ensureFile(
    root,
    GUIDELINE_FILES.structure,
    renderMarkdown(
      guidelineSchema.parse({
        type: "guideline",
        id: "guideline:structure",
        title: "Structure",
        scope: "structure",
      }),
      "# Blueprint\n\nDescribe act structure, pacing, recurring motifs, and where deliberately different chapter styles belong in the book.\n",
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
    "guidelines/styles/README.md",
    renderMarkdown(
      guidelineSchema.parse({
        type: "guideline",
        id: "guideline:style-profiles",
        title: "Style Profiles",
        scope: "style-profiles",
      }),
      [
        "# Chapter Style Profiles",
        "",
        "Use files in this folder when a chapter should deliberately diverge from the book-level default style.",
        "",
        "## Rule",
        "",
        "- If a chapter does not declare a style override, the default book-level prose/style/voice guides apply.",
        "- If a chapter needs a different style, declare it explicitly in chapter frontmatter with `style_refs`, `narration_person`, `narration_tense`, and/or `prose_mode`.",
        "- Do not rely on the agent to infer a style change automatically.",
        "",
        "## Example chapter frontmatter",
        "",
        "```yaml",
        "style_refs:",
        "  - style:first-person-show",
        "narration_person: first",
        "narration_tense: past",
        "prose_mode:",
        "  - show-dont-tell",
        "  - tight-interiority",
        "```",
      ].join("\n"),
    ),
    created,
  );

  await ensureFile(
    root,
    "guidelines/styles/first-person-show.md",
    renderMarkdown(
      guidelineSchema.parse({
        type: "guideline",
        id: "style:first-person-show",
        title: "First Person Show",
        scope: "style-profile",
      }),
      [
        "# Use When",
        "",
        "- The chapter should feel intimate, immediate, and filtered through one character's lived experience.",
        "",
        "# Rules",
        "",
        "- Use first-person narration explicitly.",
        "- Prefer concrete action, sensory evidence, and subtext over explanation.",
        "- Let the narrator's bias and omissions shape what the reader sees.",
        "- Keep exposition compressed and emotional inference active.",
        "",
        "# Avoid",
        "",
        "- Detached summary paragraphs that break immediacy.",
        "- Over-explaining emotions the scene already demonstrates.",
      ].join("\n"),
    ),
    created,
  );

  await ensureFile(
    root,
    "guidelines/styles/third-person-descriptive.md",
    renderMarkdown(
      guidelineSchema.parse({
        type: "guideline",
        id: "style:third-person-descriptive",
        title: "Third Person Descriptive",
        scope: "style-profile",
      }),
      [
        "# Use When",
        "",
        "- The chapter should widen its lens and give more room to atmosphere, setting, and spatial clarity.",
        "",
        "# Rules",
        "",
        "- Use third-person narration explicitly.",
        "- Allow fuller scene description, but keep every descriptive block tied to mood, threat, or meaning.",
        "- Balance external detail with selective internal access.",
        "- Let setting and texture do structural work, not just ornament.",
        "",
        "# Avoid",
        "",
        "- Decorative description with no narrative pressure.",
        "- Sudden slips into first-person interior monologue unless the chapter rules allow it.",
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

  return { rootPath: root, created };
}

export async function upgradeBookRepo(
  rootPath: string,
  options?: { createSkills?: boolean },
): Promise<{
  rootPath: string;
  created: string[];
  updated: string[];
  backedUp: string[];
  backupRoot?: string;
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
  const backedUp: string[] = [];
  let backupRoot: string | undefined;

  for (const file of getManagedBookScaffoldFiles(options?.createSkills ?? true)) {
    const filePath = path.join(root, file.relativePath);
    const existingContent = await readFile(filePath, "utf8").catch(() => null);

    if (existingContent === file.content) {
      continue;
    }

    if (existingContent !== null) {
      backupRoot ??= path.join(root, ".narrarium-upgrade-backups", formatBackupStamp(new Date()));
      const backupPath = path.join(backupRoot, file.relativePath);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, existingContent, "utf8");
      backedUp.push(toPosixPath(path.relative(root, backupPath)));
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, "utf8");
    updated.push(toPosixPath(file.relativePath));
  }

  return {
    rootPath: root,
    created,
    updated,
    backedUp,
    backupRoot: backupRoot ? toPosixPath(path.relative(root, backupRoot)) : undefined,
  };
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
    renderMarkdown(frontmatter, options.body ?? defaultBodyForType("chapter")),
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
): Promise<{ folderPath: string; draftFilePath: string; draftId: string; chapterId: string }> {
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
    renderMarkdown(frontmatter, options.body ?? defaultBodyForType("chapter-draft")),
    "utf8",
  );

  return {
    folderPath,
    draftFilePath,
    draftId: `draft:chapter:${slug}`,
    chapterId: `chapter:${slug}`,
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
    renderMarkdown(frontmatter, options.body ?? defaultBodyForType("paragraph")),
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
): Promise<{ filePath: string; draftId: string; paragraphId: string }> {
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
    renderMarkdown(frontmatter, options.body ?? defaultBodyForType("paragraph-draft")),
    "utf8",
  );

  return {
    filePath,
    draftId: `draft:paragraph:${chapter}:${slug}`,
    paragraphId: `paragraph:${chapter}:${slug}`,
  };
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
  const movedAssetPaths = await moveAssetDirectoryIfPresent(root, oldParagraphId, newParagraphId);
  const updatedReferences = await replaceReferencesInMarkdownFiles(root, [
    [oldParagraphId, newParagraphId],
    [`asset:paragraph:${chapterSlugValue}:${oldParagraphSlug}:`, `asset:paragraph:${chapterSlugValue}:${newParagraphSlug}:`],
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
  const paragraphFiles = files.filter((filePath) => path.basename(filePath) !== "chapter.md");
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
  const paragraphFiles = files.filter((filePath) => path.basename(filePath) !== "chapter.md");
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

export async function buildChapterWritingContext(
  rootPath: string,
  chapter: string,
): Promise<{ text: string; files: string[] }> {
  const root = path.resolve(rootPath);
  const chapterSlugValue = normalizeChapterReference(chapter);
  const files = new Set<string>();
  const sections: string[] = [];
  const chapterData = await readChapter(root, chapterSlugValue).catch(() => null);
  const draft = await readChapterDraft(root, chapterSlugValue).catch(() => null);

  const prose = await readLooseMarkdownIfExists(path.join(root, GUIDELINE_FILES.prose));
  addContextSection(sections, files, root, prose, "Always-read prose guide", 1600);

  const styleGuide = await readLooseMarkdownIfExists(path.join(root, GUIDELINE_FILES.style));
  addContextSection(sections, files, root, styleGuide, "Default style guide", 1100);

  const voicesGuide = await readLooseMarkdownIfExists(path.join(root, GUIDELINE_FILES.voices));
  addContextSection(sections, files, root, voicesGuide, "Default voice guide", 1000);

  const chapterRules = await readLooseMarkdownIfExists(path.join(root, GUIDELINE_FILES.chapterRules));
  addContextSection(sections, files, root, chapterRules, "Chapter rules", 900);

  const structureGuide = await readLooseMarkdownIfExists(path.join(root, GUIDELINE_FILES.structure));
  addContextSection(sections, files, root, structureGuide, "Structure guide", 850);

  const styleContext = await buildEffectiveChapterStyleContext(root, chapterData?.metadata, draft?.metadata);
  sections.push(styleContext.summarySection);
  for (const relativePath of styleContext.files) {
    files.add(relativePath);
  }
  for (const profileDocument of styleContext.profileDocuments) {
    addContextSection(
      sections,
      files,
      root,
      profileDocument,
      `Explicit style profile ${String(profileDocument.frontmatter.id ?? path.basename(profileDocument.path, ".md"))}`,
      1000,
    );
  }

  const plot = await readPlot(root);
  if (plot) {
    addContextSection(sections, files, root, plot, "Rolling plot map", 1400);
  }

  const totalResume = await readLooseMarkdownIfExists(path.join(root, TOTAL_RESUME_FILE));
  addContextSection(sections, files, root, totalResume, "Book summary so far", 1200);

  const storyStateStatus = await readStoryStateStatus(root);
  const storyStateCurrent = await readLooseMarkdownIfExists(path.join(root, STORY_STATE_CURRENT_FILE));
  addContextSection(
    sections,
    files,
    root,
    storyStateCurrent,
    storyStateStatus.dirty ? "Structured story state (stale)" : "Structured story state",
    1050,
  );

  if (storyStateStatus.dirty) {
    const storyStateStatusDocument = await readLooseMarkdownIfExists(path.join(root, STORY_STATE_STATUS_FILE));
    addContextSection(sections, files, root, storyStateStatusDocument, "Story state sync status", 1000);
  }

  const chapterResume = await readLooseMarkdownIfExists(path.join(root, "resumes", "chapters", `${chapterSlugValue}.md`));
  addContextSection(sections, files, root, chapterResume, "Current chapter resume", 900);

  const chapters = await listChapters(root);
  const chapterIndex = chapters.findIndex((entry) => entry.slug === chapterSlugValue);
  const previousChapter = chapterIndex > 0 ? chapters[chapterIndex - 1] : null;
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
    files.add(toPosixPath(path.join("chapters", chapterSlugValue, "chapter.md")));
    sections.push(
      [
        "## Existing final chapter",
        "",
        `Source: ${toPosixPath(path.join("chapters", chapterSlugValue, "chapter.md"))}`,
        `- Title: ${chapterData.metadata.title}`,
        `- Summary: ${(chapterData.metadata.summary ?? summarizeText(chapterData.body, 240)) || "No summary yet."}`,
        `- POV: ${(chapterData.metadata.pov ?? []).join(", ") || "not set"}`,
        `- Narration person: ${chapterData.metadata.narration_person ?? "default book-level"}`,
        `- Narration tense: ${chapterData.metadata.narration_tense ?? "default book-level"}`,
        `- Prose modes: ${(chapterData.metadata.prose_mode ?? []).join(", ") || "default book-level"}`,
        `- Style refs: ${(chapterData.metadata.style_refs ?? []).join(", ") || "none"}`,
        `- Timeline: ${chapterData.metadata.timeline_ref ?? "not set"}`,
        `- Existing scenes: ${chapterData.paragraphs.map((paragraph) => `${formatOrdinal(paragraph.metadata.number)} ${paragraph.metadata.title}`).join("; ") || "none"}`,
      ].join("\n"),
    );
  }

  if (draft) {
    files.add(toPosixPath(path.join("drafts", chapterSlugValue, "chapter.md")));
    sections.push(
      [
        "## Matching chapter draft",
        "",
        `Source: ${toPosixPath(path.join("drafts", chapterSlugValue, "chapter.md"))}`,
        `- Summary: ${draft.metadata.summary ?? "No summary yet."}`,
        `- POV: ${(draft.metadata.pov ?? []).join(", ") || "not set"}`,
        `- Narration person: ${draft.metadata.narration_person ?? "default book-level"}`,
        `- Narration tense: ${draft.metadata.narration_tense ?? "default book-level"}`,
        `- Prose modes: ${(draft.metadata.prose_mode ?? []).join(", ") || "default book-level"}`,
        `- Style refs: ${(draft.metadata.style_refs ?? []).join(", ") || "none"}`,
        `- Timeline: ${draft.metadata.timeline_ref ?? "not set"}`,
        `- Draft scenes: ${draft.paragraphs.map((paragraph) => `${formatOrdinal(paragraph.metadata.number)} ${paragraph.metadata.title}`).join("; ") || "none"}`,
        "",
        summarizeText(draft.body, 1200) || "No chapter draft body yet.",
      ].join("\n"),
    );
  }

  return {
    text: [
      `# Chapter Writing Context for ${chapterSlugValue}`,
      "",
      "Read these before drafting or polishing the chapter prose.",
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
  const paragraphDraft = await readParagraphDraft(root, chapterSlugValue, paragraph);
  const chapterContext = await buildChapterWritingContext(root, chapterSlugValue);
  const files = new Set(chapterContext.files);
  files.add(toPosixPath(path.relative(root, paragraphDraft.path)));

  const finalChapter = await readChapter(root, chapterSlugValue).catch(() => null);
  const priorScenes = finalChapter
    ? finalChapter.paragraphs.filter((entry) => entry.metadata.number < paragraphDraft.metadata.number)
    : [];

  return {
    text: [
      chapterContext.text,
      "",
      "## Target paragraph draft",
      "",
      `Source: ${toPosixPath(path.relative(root, paragraphDraft.path))}`,
      `- Title: ${paragraphDraft.metadata.title}`,
      `- Summary: ${paragraphDraft.metadata.summary ?? "No summary yet."}`,
      `- Viewpoint: ${paragraphDraft.metadata.viewpoint ?? "not set"}`,
      "",
      summarizeText(paragraphDraft.body, 1400) || "No paragraph draft body yet.",
      "",
      "## Prior scenes in this chapter",
      "",
      bulletLines(
        priorScenes.length > 0
          ? priorScenes.map(
              (entry) => `${formatOrdinal(entry.metadata.number)} ${entry.metadata.title}: ${(entry.metadata.summary ?? summarizeText(entry.body, 160)) || "No summary yet."}`,
            )
          : ["No earlier final scenes in this chapter yet."],
      ),
    ].join("\n"),
    files: Array.from(files).sort(),
  };
}

export async function buildResumeBookContext(
  rootPath: string,
): Promise<{ text: string; files: string[] }> {
  const root = path.resolve(rootPath);
  const files = new Set<string>();
  const sections: string[] = [];

  const book = await readBook(root);
  const prose = await readLooseMarkdownIfExists(path.join(root, GUIDELINE_FILES.prose));
  const plot = await readPlot(root);
  const totalResume = await readLooseMarkdownIfExists(path.join(root, TOTAL_RESUME_FILE));
  const storyStateCurrent = await readLooseMarkdownIfExists(path.join(root, STORY_STATE_CURRENT_FILE));
  const storyStateStatus = await readStoryStateStatus(root);
  const storyStateStatusDocument = storyStateStatus.dirty
    ? await readLooseMarkdownIfExists(path.join(root, STORY_STATE_STATUS_FILE))
    : null;
  const continuation = await readLooseMarkdownIfExists(path.join(root, "conversations", "CONTINUATION.md"));
  const resume = await readLooseMarkdownIfExists(path.join(root, "conversations", "RESUME.md"));

  addContextSection(sections, files, root, prose, "Always-read prose guide", 1500);
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
      "Use this to restart book work from repository state, exported conversation history, and current canon.",
      "",
      ...sections,
      "## Source files consulted",
      "",
      ...Array.from(files).sort().map((filePath) => `- ${filePath}`),
    ].join("\n"),
    files: Array.from(files).sort(),
  };
}

async function buildEffectiveChapterStyleContext(
  root: string,
  chapterMetadata?: Pick<ChapterFrontmatter, "style_refs" | "narration_person" | "narration_tense" | "prose_mode"> | null,
  draftMetadata?: Pick<ChapterDraftFrontmatter, "style_refs" | "narration_person" | "narration_tense" | "prose_mode"> | null,
): Promise<{
  summarySection: string;
  profileDocuments: Array<MarkdownDocument<GuidelineFrontmatter>>;
  files: string[];
}> {
  const styleRefs = (chapterMetadata?.style_refs?.length ? chapterMetadata.style_refs : draftMetadata?.style_refs) ?? [];
  const proseMode = (chapterMetadata?.prose_mode?.length ? chapterMetadata.prose_mode : draftMetadata?.prose_mode) ?? [];
  const narrationPerson = chapterMetadata?.narration_person ?? draftMetadata?.narration_person;
  const narrationTense = chapterMetadata?.narration_tense ?? draftMetadata?.narration_tense;
  const sourceLabel = chapterMetadata?.style_refs?.length || chapterMetadata?.narration_person || chapterMetadata?.narration_tense || chapterMetadata?.prose_mode?.length
    ? "chapter frontmatter"
    : draftMetadata?.style_refs?.length || draftMetadata?.narration_person || draftMetadata?.narration_tense || draftMetadata?.prose_mode?.length
      ? "chapter draft frontmatter"
      : "book-level defaults";
  const explicitOverride = styleRefs.length > 0 || Boolean(narrationPerson || narrationTense || proseMode.length > 0);
  const guidelineDocuments = styleRefs.length > 0 ? await listGuidelines(root) : [];
  const guidelinesById = new Map(guidelineDocuments.map((document) => [String(document.frontmatter.id).toLowerCase(), document]));
  const profileDocuments = styleRefs
    .map((reference) => guidelinesById.get(reference.toLowerCase()))
    .filter((document): document is MarkdownDocument<GuidelineFrontmatter> => Boolean(document));
  const unresolvedStyleRefs = styleRefs.filter((reference) => !guidelinesById.has(reference.toLowerCase()));
  const files = profileDocuments.map((document) => toPosixPath(path.relative(root, document.path)));
  const summarySection = [
    "## Effective chapter style",
    "",
    `- Explicit chapter override: ${explicitOverride ? "yes" : "no"}`,
    `- Source of current style instructions: ${sourceLabel}`,
    `- Narration person: ${narrationPerson ?? "default book-level"}`,
    `- Narration tense: ${narrationTense ?? "default book-level"}`,
    `- Prose modes: ${proseMode.join(", ") || "default book-level"}`,
    `- Style refs: ${styleRefs.join(", ") || "none"}`,
    ...(explicitOverride
      ? ["- This chapter asked for a style difference explicitly. Do not infer additional style drift beyond these instructions."]
      : ["- No explicit chapter style profile is set, so the default book-level prose, style, and voice guides apply."]),
    ...(unresolvedStyleRefs.length > 0
      ? [`- Missing style refs to review: ${unresolvedStyleRefs.join(", ")}`]
      : []),
  ].join("\n");

  return {
    summarySection,
    profileDocuments,
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
  const chapters = await listChapters(root);
  const storyStateTimeline = await buildStoryStateTimeline(root);
  const storyStateStatus = await readStoryStateStatus(root);
  const chapterRange = resolveQueryCanonChapterRange(chapters, normalizedQuestion, options?.fromChapter, options?.toChapter);
  const chapterScope = resolveQueryCanonChapterScope(
    chapters,
    normalizedQuestion,
    chapterRange?.endReference ?? options?.throughChapter,
  );
  const intent = detectQueryCanonIntent(normalizedQuestion, Boolean(chapterRange));
  const targets = await buildQueryCanonTargets(root, chapters);
  const subjectHint = formatQueryCanonSubject(normalizedQuestion);
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
  const sources = uniqueValues(
    [
      toPosixPath(path.relative(root, filePath)),
      toPosixPath(path.join("chapters", chapterSlugValue, "chapter.md")),
      ...(await pathExists(chapterResumePath) ? [toPosixPath(path.relative(root, chapterResumePath))] : []),
      ...(await pathExists(path.join(root, GUIDELINE_FILES.prose)) ? [GUIDELINE_FILES.prose] : []),
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
      ...(await pathExists(path.join(root, GUIDELINE_FILES.prose)) ? [GUIDELINE_FILES.prose] : []),
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

  await writeFile(filePath, renderMarkdown(validated, nextBody), "utf8");
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

  await writeFile(filePath, renderMarkdown(validated, nextBody), "utf8");
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

  await writeFile(filePath, renderMarkdown(validated, nextBody), "utf8");
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

  await writeFile(filePath, renderMarkdown(validated, nextBody), "utf8");
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

export async function syncChapterEvaluation(
  rootPath: string,
  chapter: string,
): Promise<{ filePath: string; content: string }> {
  const root = path.resolve(rootPath);
  const chapterSlug = normalizeChapterReference(chapter);
  const chapterData = await readChapter(root, chapterSlug);
  const filePath = path.join(root, "evaluations", "chapters", `${chapterSlug}.md`);

  const content = renderMarkdown(
    {
      type: "evaluation",
      id: `evaluation:chapter:${chapterSlug}`,
      title: `Evaluation ${chapterSlug}`,
      chapter: `chapter:${chapterSlug}`,
    },
    [
      "# Evaluation Snapshot",
      "",
      `- Scene count: ${chapterData.paragraphs.length}`,
      `- POV: ${(chapterData.metadata.pov ?? []).join(", ") || "not set"}`,
      `- Timeline: ${chapterData.metadata.timeline_ref ?? "not set"}`,
      `- Chapter summary present: ${chapterData.metadata.summary ? "yes" : "no"}`,
      "",
      "# Continuity Checks",
      "",
      "- Verify timeline references align with prior canon.",
      "- Verify secrets are not revealed too early.",
      "- Verify character voice matches guidelines and prior scenes.",
      "",
      "# Scene Inventory",
      "",
      ...chapterData.paragraphs.flatMap((paragraph) => [
        `## ${formatOrdinal(paragraph.metadata.number)} ${paragraph.metadata.title}`,
        "",
        (paragraph.metadata.summary ?? summarizeText(paragraph.body, 160)) || "Add scene evaluation notes here.",
        "",
      ]),
      "# Revision Questions",
      "",
      "- Which scene is weakest and why?",
      "- Where does pacing slow down?",
      "- What information should move earlier or later?",
      "- Which emotional beat needs stronger payoff?",
    ].join("\n"),
  );

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return { filePath, content };
}

export async function evaluateBook(
  rootPath: string,
  options?: { syncChapterEvaluations?: boolean },
): Promise<{ filePath: string; chapterCount: number; chapterEvaluationFiles: string[] }> {
  const root = path.resolve(rootPath);
  const chapters = await listChapters(root);
  const syncChapterEvaluations = options?.syncChapterEvaluations ?? true;
  const chapterEvaluationFiles: string[] = [];
  const chapterBreakdowns: Array<{
    title: string;
    number: number;
    sceneCount: number;
    hasSummary: boolean;
    hasPov: boolean;
    tagsCount: number;
  }> = [];

  for (const chapter of chapters) {
    const chapterData = await readChapter(root, chapter.slug);
    chapterBreakdowns.push({
      title: chapter.metadata.title,
      number: chapter.metadata.number,
      sceneCount: chapterData.paragraphs.length,
      hasSummary: Boolean(chapter.metadata.summary),
      hasPov: (chapter.metadata.pov ?? []).length > 0,
      tagsCount: (chapter.metadata.tags ?? []).length,
    });

    if (syncChapterEvaluations) {
      const result = await syncChapterEvaluation(root, chapter.slug);
      chapterEvaluationFiles.push(result.filePath);
    }
  }

  const totalScenes = chapterBreakdowns.reduce((sum, chapter) => sum + chapter.sceneCount, 0);
  const missingSummary = chapterBreakdowns.filter((chapter) => !chapter.hasSummary);
  const missingPov = chapterBreakdowns.filter((chapter) => !chapter.hasPov);
  const filePath = path.join(root, TOTAL_EVALUATION_FILE);

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
      "",
      "# Global Checks",
      "",
      "- Verify chronology across chapters and timeline files.",
      "- Verify major characters keep a consistent voice and motivation.",
      "- Verify secrets are only revealed after their allowed threshold.",
      "- Verify chapter openings and endings follow the style rules in guidelines/.",
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
      "- Review continuity against resumes/ and secrets/ after each major revision.",
    ].join("\n"),
  );

  await writeFile(filePath, content, "utf8");
  return { filePath, chapterCount: chapterBreakdowns.length, chapterEvaluationFiles };
}

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
        aliases: extractQueryCanonAliases("chapter", chapter.metadata, chapter.metadata.number),
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
            typeof chapterNumber === "number" ? `chapter ${chapterNumber}` : undefined,
            typeof chapterNumber === "number" ? `capitolo ${chapterNumber}` : undefined,
            humanizeQueryCanonToken(String(metadata.id).replace(/^chapter:/, "")),
          ]
        : []),
    ].filter((value): value is string => Boolean(value && value.trim())),
  );

  return values.filter((value) => normalizeQueryCanonSearch(value).length > 0);
}

function detectQueryCanonIntent(question: string, hasRange: boolean): QueryCanonIntent {
  const lower = question.toLowerCase();

  if (/(first appear|first appears|first show|first mention|prima apparizione|compare per la prima volta|quando compare|quando appare)/.test(lower)) {
    return "first-appearance";
  }

  if (/(who knows|chi sa|chi conosce|who is aware)/.test(lower)) {
    return "secret-holders";
  }

  if (/(relationship|relation to|rapport|rapporto|trust|fid|ally|enemy|friend|feels about|relationship with)/.test(lower)) {
    return hasRange ? "state-relationship-arc" : "state-relationship";
  }

  if (/(condition|status|wound|wounds|injured|injury|hurt|ferit|condizion|come sta)/.test(lower)) {
    return hasRange ? "state-condition-arc" : "state-condition";
  }

  if (/(open loop|open loops|unresolved|unresolved thread|pending thread|questioni aperte|fili aperti|irrisolt)/.test(lower)) {
    return hasRange ? "state-open-loops-arc" : "state-open-loops";
  }

  if (/\bwhere\b|\bdove\b|si trova|located/.test(lower)) {
    return "state-location";
  }

  if (/cosa sa|what does .* know|what .* knows|knows after|sa dopo|sa di/.test(lower)) {
    return "state-knowledge";
  }

  if (/cosa ha|what does .* have|what .* carries|inventory|porta con|possiede|is carrying/.test(lower)) {
    return "state-inventory";
  }

  return "general";
}

function resolveQueryCanonChapterRange(
  chapters: Array<{ slug: string; path: string; metadata: ChapterFrontmatter }>,
  question: string,
  explicitFromChapter?: string,
  explicitToChapter?: string,
): QueryCanonChapterRange | undefined {
  const explicitStart = explicitFromChapter ? resolveQueryCanonChapterReference(chapters, explicitFromChapter) : {};
  const explicitEnd = explicitToChapter ? resolveQueryCanonChapterReference(chapters, explicitToChapter) : {};
  const explicitNote = [explicitStart.note, explicitEnd.note].filter((value): value is string => Boolean(value)).join(" ");

  if (explicitStart.reference && explicitEnd.reference) {
    return normalizeQueryCanonChapterRange(chapters, explicitStart.reference, explicitEnd.reference, explicitNote || undefined);
  }

  const explicitRefs = [...question.matchAll(/\bchapter:[a-z0-9-]+\b/gi)].map((match) => match[0]);
  if (explicitRefs.length >= 2) {
    return normalizeQueryCanonChapterRange(chapters, explicitRefs[0], explicitRefs[1]);
  }

  const betweenNumberedMatch = question.match(
    /\b(?:between|tra|fra)\s+(?:chapter|chap(?:ter)?|capitolo|cap\.?)?\s*(\d{1,3})\s+(?:and|e)\s+(?:chapter|chap(?:ter)?|capitolo|cap\.?)?\s*(\d{1,3})\b/i,
  );
  if (betweenNumberedMatch) {
    return normalizeQueryCanonChapterRange(chapters, betweenNumberedMatch[1], betweenNumberedMatch[2]);
  }

  const fromToNumberedMatch = question.match(
    /\b(?:from|da|dal)\s+(?:chapter|chap(?:ter)?|capitolo|cap\.?)?\s*(\d{1,3})\s+(?:to|through|a|al|fino al)\s+(?:chapter|chap(?:ter)?|capitolo|cap\.?)?\s*(\d{1,3})\b/i,
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
): { reference?: string; note?: string } {
  if (explicitThroughChapter) {
    return resolveQueryCanonChapterReference(chapters, explicitThroughChapter);
  }

  const explicitId = question.match(/\bchapter:[a-z0-9-]+\b/i)?.[0];
  if (explicitId) {
    return resolveQueryCanonChapterReference(chapters, explicitId);
  }

  const numberedMatch = question.match(/\b(?:chapter|chap(?:ter)?|capitolo|cap\.?)\s*(\d{1,3})\b/i);
  if (numberedMatch) {
    return resolveQueryCanonChapterReference(chapters, numberedMatch[0]);
  }

  return {};
}

function resolveQueryCanonChapterReference(
  chapters: Array<{ slug: string; path: string; metadata: ChapterFrontmatter }>,
  value: string,
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

  const numberedMatch = trimmed.match(/\b(?:chapter|chap(?:ter)?|capitolo|cap\.?)\s*(\d{1,3})\b/i) ??
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

function formatQueryCanonSubject(question: string): string {
  const quoted = question.match(/["'“”](.+?)["'“”]/)?.[1];
  if (quoted) {
    return quoted.trim();
  }

  return question
    .replace(/\b(?:who|what|when|where|does|did|is|are|the|a|an|after|before|know|knows|have|has|first|appear|appears|show|shows|up)\b/gi, " ")
    .replace(/\b(?:chi|cosa|quando|dove|il|lo|la|gli|le|un|una|sa|sanno|ha|hanno|compare|appaiono|apparizione|prima|volta|al|nel|si|trova)\b/gi, " ")
    .replace(/\b(?:chapter|chap(?:ter)?|capitolo|cap\.?)\s*\d{1,3}\b/gi, " ")
    .replace(/[?!.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

  if (relativePath.startsWith("chapters/")) {
    paragraphSchema.parse(data);
    return;
  }

  if (relativePath.startsWith("drafts/") && path.basename(filePath) === "chapter.md") {
    chapterDraftSchema.parse(data);
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
    "- `characters/`, `items/`, `locations/`, `factions/`, `timelines/`, `secrets/`",
    "- `chapters/<nnn-slug>/chapter.md` for chapter metadata",
    "- `chapters/<nnn-slug>/<nnn-slug>.md` for paragraph or scene files",
    "- `drafts/<nnn-slug>/chapter.md` and matching files for rough chapter and scene drafts",
    "- `plot.md` for the rolling book map: chapter progression, reveals, and timeline anchors",
    "- `conversations/` for exported writing chats, resume files, and continuation prompts",
    "- `resumes/` for running summaries",
    "- `state/` for structured continuity snapshots and sync status",
    "- `evaluations/` for critique and continuity checks",
    "- `guidelines/` for prose defaults, style, structure, and voices",
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
    "- Use `chapter_writing_context` and `paragraph_writing_context` before drafting polished prose from rough material.",
    "- Use `revise_chapter` when you want a proposal-only diagnosis and scene revision plan for an existing final chapter before deciding what to apply manually.",
    "- Use `revise_paragraph` when you want a proposal-only editorial pass on an existing final scene before deciding whether to apply it with `update_paragraph`.",
    "- Use `resume_book_context` when restarting work from exported conversation history.",
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
    "- Always read `guidelines/prose.md` before drafting new chapter or paragraph prose.",
    "- If a chapter declares `style_refs`, `narration_person`, `narration_tense`, or `prose_mode`, treat that as an explicit chapter-level override; otherwise follow the book-level default prose, style, and voice guides.",
    "- Before writing a scene, review the relevant prior chapter content, the latest summaries in `resumes/`, the current snapshot in `state/` when available, and any matching files in `drafts/`.",
    "- Keep `plot.md` aligned with chapter summaries, secret reveals, and timeline references.",
    "- If stylistic guidance is missing, inspect the rest of `guidelines/` before choosing a default.",
  ].join("\n");
}

function getManagedBookScaffoldFiles(createSkills: boolean): Array<{ relativePath: string; content: string }> {
  return [
    ...(createSkills
      ? [
          { relativePath: `.opencode/skills/${SKILL_NAME}/SKILL.md`, content: skillTemplate },
          { relativePath: `.claude/skills/${SKILL_NAME}/SKILL.md`, content: skillTemplate },
          { relativePath: ".github/copilot-instructions.md", content: buildGithubCopilotInstructions() },
        ]
      : []),
    { relativePath: "opencode.jsonc", content: buildOpencodeProjectConfig() },
    { relativePath: ".opencode/commands/resume-book.md", content: buildResumeBookCommand() },
    { relativePath: ".opencode/plugins/conversation-export.js", content: buildConversationExportPlugin() },
    { relativePath: "conversations/README.md", content: buildConversationsReadme() },
    { relativePath: ".vscode/mcp.json", content: buildVscodeMcpConfig() },
  ];
}

function buildResumeBookCommand(): string {
  return [
    "---",
    "description: Resume book work from repo state, plot, and exported conversations",
    "agent: build",
    "---",
    "Resume work on this Narrarium book.",
    "",
    "Before doing anything else:",
    "1. Call the `resume_book_context` MCP tool.",
    "2. Read the files it references, especially `guidelines/prose.md`, `plot.md`, `resumes/total.md`, `state/current.md`, `state/status.md` when present, and the latest files in `conversations/`.",
    "3. Briefly restate where the book stands, what the latest conversation was doing, and the next best actions.",
    "4. Then continue with this user request if one is present: $ARGUMENTS",
    "5. If no extra request is present, ask for the next book task only after giving the short status recap.",
    "",
    "Prefer continuity over novelty. Respect `known_from`, `reveal_in`, and all prose/style guidelines.",
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
    '      "1. guidelines/prose.md",',
    '      "2. plot.md",',
    '      "3. resumes/total.md",',
    '      "4. state/current.md",',
    '      "5. state/status.md if it shows dirty: true",',
    '      "6. Any matching files in drafts/",',
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

function formatBackupStamp(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    "-",
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join("");
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

async function listGuidelines(rootPath: string): Promise<Array<MarkdownDocument<GuidelineFrontmatter>>> {
  const root = path.resolve(rootPath);
  const files = await fg("guidelines/**/*.md", {
    cwd: root,
    absolute: true,
    onlyFiles: true,
  });

  const documents = await Promise.all(files.map((filePath) => readMarkdownFile(filePath, guidelineSchema)));
  return documents.sort((left, right) => left.path.localeCompare(right.path));
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
