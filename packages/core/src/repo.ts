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
  SKILL_NAME,
  TIMELINE_MAIN_FILE,
  TOTAL_EVALUATION_FILE,
  TOTAL_RESUME_FILE,
} from "./constants.js";
import {
  assetSchema,
  bookSchema,
  characterSchema,
  chapterSchema,
  entitySchemaMap,
  factionSchema,
  guidelineSchema,
  itemSchema,
  locationSchema,
  paragraphSchema,
  researchNoteSchema,
  secretSchema,
  type BookFrontmatter,
  type AssetFrontmatter,
  type CharacterFrontmatter,
  type ChapterFrontmatter,
  type EntityType,
  type FactionFrontmatter,
  type GuidelineFrontmatter,
  type ItemFrontmatter,
  type LocationFrontmatter,
  type ParagraphFrontmatter,
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

type SearchHit = {
  path: string;
  score: number;
  title: string;
  type: string;
  excerpt: string;
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
  coreGuidelines: GuidelineDocument[];
  referencedGuidelines: GuidelineDocument[];
  unresolvedRefs: string[];
  metadataSignals: Array<{ key: string; value: string }>;
  showDontTell: boolean;
};

type ChapterReadResult = {
  metadata: ChapterFrontmatter;
  body: string;
  paragraphs: Array<{ path: string; metadata: ParagraphFrontmatter; body: string }>;
};

type ChapterParagraph = ChapterReadResult["paragraphs"][number];

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
  nextSteps: string[];
  missingParagraphSummaries: number;
  missingParagraphViewpoints: number;
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

type CreateCharacterProfileInput = {
  slug?: string;
  overwrite?: boolean;
  name: string;
  aliases?: string[];
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

type CreateItemProfileInput = {
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

type CreateLocationProfileInput = {
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

type CreateFactionProfileInput = {
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

type CreateSecretProfileInput = {
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

type CreateTimelineEventProfileInput = {
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

type RelatedCanonHit = {
  path: string;
  title: string;
  type: string;
  reason: string;
  score: number;
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
    GUIDELINE_FILES.style,
    renderMarkdown(
      guidelineSchema.parse({
        type: "guideline",
        id: "guideline:style",
        title: "Style Guide",
        scope: "global",
      }),
      "# Rules\n\n- Define sentence rhythm, tone, and taboo patterns.\n\n# Examples\n",
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
      "# Narration\n\nDefine default narrator rules and any alternate voices.\n",
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
      "# Blueprint\n\nDescribe act structure, pacing, and recurring motifs.\n",
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

  if (options.createSkills ?? true) {
    await ensureFile(
      root,
      `.opencode/skills/${SKILL_NAME}/SKILL.md`,
      skillTemplate,
      created,
    );
    await ensureFile(
      root,
      `.claude/skills/${SKILL_NAME}/SKILL.md`,
      skillTemplate,
      created,
    );
  }

  await ensureFile(
    root,
    "opencode.jsonc",
    [
      "{",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "narrarium": {',
      '      "type": "local",',
      '      "command": ["npx", "narrarium-mcp-server"],',
      '      "enabled": true,',
      '      "timeout": 15000',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
    created,
  );

  return { rootPath: root, created };
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
      aliases: input.aliases ?? [],
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
      secret_kind: input.secretKind,
      function_in_book: input.functionInBook,
      stakes: input.stakes,
      protected_by: input.protectedBy ?? [],
      false_beliefs: input.falseBeliefs ?? [],
      reveal_strategy: input.revealStrategy,
      holders: input.holders ?? [],
      reveal_in: input.revealIn,
      known_from: input.knownFrom,
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

  return {
    folderPath,
    chapterFilePath,
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
  const evaluationDirectory = path.join(root, "evaluations", "paragraphs", chapter);

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

  await ensureFile(
    root,
    toPosixPath(path.relative(root, path.join(evaluationDirectory, `${slug}.md`))),
    renderMarkdown(
      {
        type: "evaluation",
        id: `evaluation:paragraph:${chapter}:${slug}`,
        title: `Evaluation ${chapter} ${slug}`,
        chapter: `chapter:${chapter}`,
        paragraph: `paragraph:${chapter}:${slug}`,
      },
      "# Evaluation\n\nTrack paragraph quality, chapter fit, and revision notes here.\n",
    ),
    [],
  );

  return { filePath, paragraphId: `paragraph:${chapter}:${slug}` };
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

  if (oldFilePath !== newFilePath && (await pathExists(newFilePath))) {
    throw new Error(`Entity already exists at destination: ${newFilePath}`);
  }

  const validated = entitySchemaMap[options.kind].parse({
    ...(parsed.data as Record<string, unknown>),
    id: newId,
    [labelKey]: options.newNameOrTitle,
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

export async function syncChapterResume(
  rootPath: string,
  chapter: string,
): Promise<{ filePath: string; content: string }> {
  const root = path.resolve(rootPath);
  const chapterSlug = normalizeChapterReference(chapter);
  const chapterData = await readChapter(root, chapterSlug);
  const filePath = path.join(root, "resumes", "chapters", `${chapterSlug}.md`);
  const summary = chapterData.metadata.summary ?? summarizeText(chapterData.body, 220);

  const content = renderMarkdown(
    {
      type: "resume",
      id: `resume:chapter:${chapterSlug}`,
      title: `Resume ${chapterSlug}`,
      chapter: `chapter:${chapterSlug}`,
    },
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
    ].join("\n"),
  );

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return { filePath, content };
}

export async function syncTotalResume(
  rootPath: string,
): Promise<{ filePath: string; content: string; chapterCount: number }> {
  const root = path.resolve(rootPath);
  const chapters = await listChapters(root);
  const filePath = path.join(root, TOTAL_RESUME_FILE);

  const content = renderMarkdown(
    {
      type: "resume",
      id: "resume:total",
      title: "Total Resume",
    },
    [
      "# Book So Far",
      "",
      ...chapters.flatMap((chapter) => [
        `## Chapter ${formatOrdinal(chapter.metadata.number)} ${chapter.metadata.title}`,
        "",
        chapter.metadata.summary ?? "Add chapter summary here.",
        "",
      ]),
    ].join("\n"),
  );

  await writeFile(filePath, content, "utf8");
  return { filePath, content, chapterCount: chapters.length };
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
  const chapterBreakdowns: Array<{
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
    revisionUrgency: string;
    nextSteps: string[];
  }> = [];

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
      revisionUrgency: formatRevisionUrgency(draft.concerns.length, draft.nextSteps.length),
      nextSteps: draft.nextSteps,
    });

    collectGuidelineTitles(aggregatedStyles, draft.styleContext.coreGuidelines);
    collectGuidelineTitles(aggregatedStyles, draft.styleContext.referencedGuidelines);

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
  const criticalChapters = chapterBreakdowns.filter((chapter) => chapter.readabilityScore <= 5 || chapter.styleAlignmentScore <= 5);
  const activeStyleRefs = uniqueValues(
    [...aggregatedStyles.entries()].flatMap(([, titles]) => titles),
  );
  const styleSignals = [...aggregatedSignals.entries()]
    .filter(([, values]) => values.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));

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
      "",
      "# Global Scorecard",
      "",
      `- Reader readability: ${averageReadability}/10`,
      `- Beauty and memorability: ${averageBeauty}/10`,
      `- Style alignment: ${averageStyleAlignment}/10`,
      criticalChapters.length > 0
        ? `- Chapters needing immediate attention: ${criticalChapters.map((chapter) => formatOrdinal(chapter.number)).join(", ")}`
        : "- No chapter is currently flagged as urgent by the score thresholds.",
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
    const nextSteps = buildParagraphNextSteps(chapterData, paragraph, paragraphAnalysis, styleContext);

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
      nextSteps,
    };
  });

  const scorecard = buildChapterScorecard(chapterData, chapterAnalysis, paragraphInsights, styleContext);
  const strengths = collectEvaluationNotes(scorecard, "strengths", 5);
  const concerns = collectEvaluationNotes(scorecard, "concerns", 5);
  const nextSteps = buildChapterNextSteps(chapterData, chapterAnalysis, paragraphInsights, styleContext);

  return {
    chapterSlug,
    chapterData,
    styleContext,
    chapterAnalysis,
    paragraphInsights,
    scorecard,
    strengths,
    concerns,
    nextSteps,
    missingParagraphSummaries: paragraphInsights.filter((paragraph) => !paragraph.summaryPresent).length,
    missingParagraphViewpoints: paragraphInsights.filter((paragraph) => paragraph.viewpoint === "not set").length,
  };
}

async function resolveEvaluationStyleContext(
  root: string,
  chapterData: ChapterReadResult,
): Promise<EvaluationStyleContext> {
  const guidelines = await listGuidelines(root);
  const guidelineById = new Map(guidelines.map((guideline) => [guideline.frontmatter.id, guideline]));
  const coreGuidelines = ["guideline:style", "guideline:chapter-rules", "guideline:voices", "guideline:structure"]
    .map((id) => guidelineById.get(id))
    .filter((guideline): guideline is GuidelineDocument => Boolean(guideline));

  const metadataEntries = [chapterData.metadata, ...chapterData.paragraphs.map((paragraph) => paragraph.metadata)];
  const refs = uniqueValues(metadataEntries.flatMap((metadata) => extractStyleRefs(metadata as Record<string, unknown>)));
  const referencedGuidelines = refs
    .map((ref) => guidelineById.get(ref))
    .filter((guideline): guideline is GuidelineDocument => Boolean(guideline));
  const unresolvedRefs = refs.filter((ref) => !guidelineById.has(ref));
  const metadataSignals = uniqueSignalEntries(
    metadataEntries.flatMap((metadata) => extractStyleSignals(metadata as Record<string, unknown>)),
  );
  const styleTexts = [
    ...coreGuidelines.map((guideline) => guideline.body),
    ...referencedGuidelines.map((guideline) => guideline.body),
    ...metadataSignals.map((signal) => signal.value),
  ];

  return {
    coreGuidelines,
    referencedGuidelines,
    unresolvedRefs,
    metadataSignals,
    showDontTell: styleTexts.some((value) => containsShowDontTellText(value)),
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
      "",
      "# Scorecard",
      "",
      ...renderScorecardLines(draft.scorecard),
      "",
      "# Style Context",
      "",
      ...renderStyleContextLines(root, draft.styleContext),
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
        `- What works: ${paragraph.strengths.join("; ") || "No specific strength detected yet."}`,
        `- What to revise: ${paragraph.concerns.join("; ") || "No specific concern detected yet."}`,
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
): string {
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
      "",
      "# Scorecard",
      "",
      ...renderScorecardLines(paragraph.scorecard),
      "",
      "# Style Context",
      "",
      ...renderStyleContextLines(root, draft.styleContext),
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
  if (styleContext.coreGuidelines.length > 0 || styleContext.referencedGuidelines.length > 0) {
    styleAlignment += 1;
    styleStrengths.push("The evaluation has explicit guideline material to check against.");
  }
  if (styleContext.unresolvedRefs.length > 0) {
    styleAlignment -= 2;
    styleConcerns.push(`Some style references could not be resolved: ${styleContext.unresolvedRefs.join(", ")}.`);
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
  if (styleContext.coreGuidelines.length > 0 || styleContext.referencedGuidelines.length > 0) {
    styleAlignment += 1;
    styleStrengths.push("The scene can be checked against explicit style guidance.");
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
  if (styleContext.unresolvedRefs.length > 0) {
    styleAlignment -= 2;
    styleConcerns.push(`Some style references could not be resolved: ${styleContext.unresolvedRefs.join(", ")}.`);
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
  if (styleContext.unresolvedRefs.length > 0) {
    steps.push(`Create or fix the missing style references: ${styleContext.unresolvedRefs.join(", ")}.`);
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
    ...styleContext.coreGuidelines.map((guideline) => guideline.body),
    ...styleContext.referencedGuidelines.map((guideline) => guideline.body),
    ...styleContext.metadataSignals.map((signal) => signal.value),
  ]
    .join("\n")
    .toLowerCase();
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

  if (styleContext.coreGuidelines.length > 0) {
    lines.push(
      `- Core guidelines: ${styleContext.coreGuidelines
        .map((guideline) => `${guideline.frontmatter.id} (${toPosixPath(path.relative(root, guideline.path))})`)
        .join(", ")}`,
    );
  } else {
    lines.push("- Core guidelines: none found.");
  }

  if (styleContext.referencedGuidelines.length > 0) {
    lines.push(
      `- Referenced custom guidelines: ${styleContext.referencedGuidelines
        .map((guideline) => `${guideline.frontmatter.id} (${toPosixPath(path.relative(root, guideline.path))})`)
        .join(", ")}`,
    );
  } else {
    lines.push("- Referenced custom guidelines: none resolved.");
  }

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

  if (styleContext.unresolvedRefs.length > 0) {
    lines.push(`- Missing style references: ${styleContext.unresolvedRefs.join(", ")}`);
  }

  return lines;
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

export async function exportEpub(
  rootPath: string,
  options?: {
    outputPath?: string;
    title?: string;
    author?: string;
    language?: string;
  },
): Promise<{ outputPath: string; chapterCount: number }> {
  const root = path.resolve(rootPath);
  const book = await readBook(root);
  const chapters = await listChapters(root);
  const coverAsset = await readAsset(root, "book", "cover");

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

  for (const chapter of chapters) {
    const chapterData = await readChapter(root, chapter.slug);
    const chapterImageHtml = renderEpubAssetFigure(
      await readAsset(root, String(chapterData.metadata.id), "primary"),
      `${chapterData.metadata.title} illustration`,
    );
    const paragraphsHtml = (
      await Promise.all(
        chapterData.paragraphs.map(async (paragraph) => {
          const paragraphImageHtml = renderEpubAssetFigure(
            await readAsset(root, String(paragraph.metadata.id), "primary"),
            `${paragraph.metadata.title} illustration`,
          );
          return `<section><h2>${paragraph.metadata.title}</h2>${marked.parse(paragraph.body)}${paragraphImageHtml}</section>`;
        }),
      )
    ).join("\n");
    const chapterHtml = `<article><h1>${chapterData.metadata.title}</h1>${marked.parse(chapterData.body)}${chapterImageHtml}${paragraphsHtml}</article>`;
    content.push({ title: chapterData.metadata.title, content: chapterHtml });
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

function renderEpubAssetFigure(
  asset:
    | {
        imagePath: string;
        imageExists: boolean;
      }
    | null,
  alt: string,
): string {
  if (!asset?.imageExists) {
    return "";
  }

  return `<section class="epub-figure epub-figure-full"><img src="${pathToFileURL(asset.imagePath).href}" alt="${escapeHtml(alt)}" /></section>`;
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
    lang: "en" | "it";
    title: string;
    pageUrl: string;
    slug?: string;
    summary: string;
    body?: string;
  },
): Promise<string> {
  const root = path.resolve(rootPath);
  const slug = options.slug ?? slugify(options.title);
  const filePath = path.join(root, "research", "wikipedia", options.lang, `${slug}.md`);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    renderMarkdown(
      researchNoteSchema.parse({
        type: "research-note",
        id: `research:wikipedia:${options.lang}:${slug}`,
        title: options.title,
        language: options.lang,
        source_url: options.pageUrl,
        retrieved_at: new Date().toISOString(),
      }),
      `# Summary\n\n${options.summary}\n\n# Notes\n\n${options.body ?? "Add extracted facts and relevance here."}`,
    ),
    "utf8",
  );

  return filePath;
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

async function validateFile(root: string, filePath: string): Promise<void> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const relativePath = toPosixPath(path.relative(root, filePath));

  if (relativePath === BOOK_FILE) {
    bookSchema.parse(data);
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

  const entityEntry = Object.entries(ENTITY_TYPE_TO_DIRECTORY).find(([, directory]) =>
    relativePath.startsWith(`${directory}/`),
  );

  if (entityEntry) {
    const [type] = entityEntry;
    entitySchemaMap[type as EntityType].parse(data);
    return;
  }

  if (relativePath.startsWith("resumes/") || relativePath.startsWith("evaluations/") || relativePath.startsWith("timelines/")) {
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
