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

type HiddenCanonInput = {
  secretRefs?: string[];
  privateNotes?: string;
  revealIn?: string;
  knownFrom?: string;
};

type CreateCharacterProfileInput = HiddenCanonInput & {
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

type CreateItemProfileInput = HiddenCanonInput & {
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

type CreateLocationProfileInput = HiddenCanonInput & {
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

type CreateFactionProfileInput = HiddenCanonInput & {
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

type CreateSecretProfileInput = HiddenCanonInput & {
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

type CreateTimelineEventProfileInput = HiddenCanonInput & {
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
      '  "default_agent": "build",',
      '  "agent": {',
      '    "build": {',
      '      "temperature": 0.45,',
      '      "top_p": 1,',
      '      "options": {',
      '        "reasoningEffort": "high",',
      '        "reasoningSummary": "detailed",',
      '        "textVerbosity": "high",',
      '        "include": ["reasoning.encrypted_content", "usage"],',
      '        "store": true',
      '      }',
      '    },',
      '    "plan": {',
      '      "temperature": 0.2,',
      '      "top_p": 1,',
      '      "options": {',
      '        "reasoningEffort": "high",',
      '        "reasoningSummary": "detailed",',
      '        "textVerbosity": "high",',
      '        "include": ["reasoning.encrypted_content", "usage"],',
      '        "store": true',
      '      }',
      '    }',
      '  },',
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
      ...buildHiddenCanonFrontmatter(input),
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

  const prose = await readLooseMarkdownIfExists(path.join(root, GUIDELINE_FILES.prose));
  addContextSection(sections, files, root, prose, "Always-read prose guide", 1600);

  const plot = await readPlot(root);
  if (plot) {
    addContextSection(sections, files, root, plot, "Rolling plot map", 1400);
  }

  const totalResume = await readLooseMarkdownIfExists(path.join(root, TOTAL_RESUME_FILE));
  addContextSection(sections, files, root, totalResume, "Book summary so far", 1200);

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

  const chapterData = await readChapter(root, chapterSlugValue).catch(() => null);
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
        `- Timeline: ${chapterData.metadata.timeline_ref ?? "not set"}`,
        `- Existing scenes: ${chapterData.paragraphs.map((paragraph) => `${formatOrdinal(paragraph.metadata.number)} ${paragraph.metadata.title}`).join("; ") || "none"}`,
      ].join("\n"),
    );
  }

  const draft = await readChapterDraft(root, chapterSlugValue).catch(() => null);
  if (draft) {
    files.add(toPosixPath(path.join("drafts", chapterSlugValue, "chapter.md")));
    sections.push(
      [
        "## Matching chapter draft",
        "",
        `Source: ${toPosixPath(path.join("drafts", chapterSlugValue, "chapter.md"))}`,
        `- Summary: ${draft.metadata.summary ?? "No summary yet."}`,
        `- POV: ${(draft.metadata.pov ?? []).join(", ") || "not set"}`,
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

export async function syncPlot(
  rootPath: string,
): Promise<{ filePath: string; content: string; chapterCount: number }> {
  const root = path.resolve(rootPath);
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

  const content = renderMarkdown(
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
