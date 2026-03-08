import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import matter from "gray-matter";
import { marked } from "marked";
import {
  BOOK_DIRECTORIES,
  BOOK_FILE,
  CONTENT_GLOB,
  DEFAULT_CANON,
  ENTITY_TYPE_TO_DIRECTORY,
  GUIDELINE_FILES,
  SKILL_NAME,
  TIMELINE_MAIN_FILE,
  TOTAL_EVALUATION_FILE,
  TOTAL_RESUME_FILE,
} from "./constants.js";
import {
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
  type CharacterFrontmatter,
  type ChapterFrontmatter,
  type EntityType,
  type FactionFrontmatter,
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

type CreateEntityInput = {
  slug?: string;
  body?: string;
  overwrite?: boolean;
  frontmatter?: Record<string, unknown>;
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

  if (chapters.length === 0) {
    throw new Error("Cannot export EPUB: no chapters found.");
  }

  const epubModule = (await import("epub-gen-memory")) as unknown as {
    default: (options: Record<string, unknown>, content: Array<{ title: string; data: string }>) => Promise<Buffer>;
  };
  const title = options?.title ?? book?.frontmatter.title ?? path.basename(root);
  const author = options?.author ?? book?.frontmatter.author ?? "Unknown Author";
  const language = options?.language ?? book?.frontmatter.language ?? "en";
  const outputPath = path.resolve(options?.outputPath ?? path.join(root, "dist", `${slugify(title)}.epub`));

  const content = [] as Array<{ title: string; data: string }>;

  for (const chapter of chapters) {
    const chapterData = await readChapter(root, chapter.slug);
    const paragraphsHtml = chapterData.paragraphs
      .map((paragraph) => `<section><h2>${paragraph.metadata.title}</h2>${marked.parse(paragraph.body)}</section>`)
      .join("\n");
    const chapterHtml = `<article><h1>${chapterData.metadata.title}</h1>${marked.parse(chapterData.body)}${paragraphsHtml}</article>`;
    content.push({ title: chapterData.metadata.title, data: chapterHtml });
  }

  const bytes = await epubModule.default(
    {
      title,
      author,
      lang: language,
      css: "body { font-family: serif; line-height: 1.55; } h1, h2 { font-family: serif; }",
    },
    content,
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(bytes));

  return { outputPath, chapterCount: chapters.length };
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
