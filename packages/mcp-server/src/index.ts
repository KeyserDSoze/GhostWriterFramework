#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  assetSchema,
  buildChapterWritingContext,
  buildParagraphWritingContext,
  buildResumeBookContext,
  characterRoleTierSchema,
  characterStoryRoleSchema,
  createAssetPrompt,
  createChapter,
  createChapterDraft,
  createChapterFromDraft,
  createCharacterProfile,
  createEntity,
  createFactionProfile,
  createItemProfile,
  createLocationProfile,
  createParagraph,
  createParagraphDraft,
  createParagraphFromDraft,
  createSecretProfile,
  createTimelineEventProfile,
  evaluateBook,
  exportEpub,
  findWikipediaResearchSnapshot,
  initializeBookRepo,
  listRelatedCanon,
  queryCanon,
  readStoryStateStatus,
  readAsset,
  registerAsset,
  renameChapter,
  renameEntity,
  renameParagraph,
  reviseChapter,
  reviseParagraph,
  renderMarkdown,
  searchBook,
  saveBookWorkItem,
  saveChapterDraftWorkItem,
  syncAllResumes,
  syncParagraphEvaluation,
  syncChapterEvaluation,
  syncChapterResume,
  syncPlot,
  syncStoryState,
  syncTotalResume,
  promoteBookWorkItem,
  promoteChapterDraftWorkItem,
  updateChapter,
  updateChapterDraft,
  updateBookNotes,
  updateChapterDraftNotes,
  updateEntity,
  updateParagraph,
  updateParagraphDraft,
  validateBook,
  writeWikipediaResearchSnapshot,
} from "narrarium";
import {
  buildRepositorySpecSummary,
  buildSetupInstructions,
  fetchWikidataEntity,
  fetchWikipediaPage,
  searchWikipedia,
  type NormalizedWikidataClaims,
} from "./public-tools.js";

const server = new McpServer({
  name: "narrarium-local",
  version: "0.1.0",
});

const entityTypeSchema = z.enum([
  "character",
  "item",
  "location",
  "faction",
  "secret",
  "timeline-event",
]);

const imageOrientationSchema = z.enum(["portrait", "landscape", "square"]);
const imageProviderSchema = z.enum(["openai"]);
const revisionModeSchema = z.enum(["clarity", "pacing", "dialogue", "voice", "tension", "show-dont-tell", "redundancy"]);
const revisionIntensitySchema = z.enum(["light", "medium", "strong"]);
const wikipediaRefreshToolFields = {
  forceWikipediaRefresh: z.boolean().default(false),
  maxWikipediaSnapshotAgeDays: z.number().int().positive().optional(),
};
const hiddenCanonToolFields = {
  secretRefs: z.array(z.string()).default([]),
  privateNotes: z.string().optional(),
  revealIn: z.string().optional(),
  knownFrom: z.string().optional(),
};
const pronunciationToolFields = {
  pronunciation: z.string().optional(),
  spokenName: z.string().optional(),
  ttsLabel: z.string().optional(),
};
const hiddenCanonWizardSteps: WizardStep[] = [
  { key: "secretRefs", prompt: "List linked secret ids for this entry, if any.", type: "stringArray" },
  { key: "privateNotes", prompt: "Add private notes or hidden canon for this entry.", type: "string" },
  { key: "knownFrom", prompt: "From which chapter can the reader safely know this hidden information?", type: "string" },
  { key: "revealIn", prompt: "In which chapter should this hidden information be fully revealed?", type: "string" },
];
const pronunciationWizardSteps: WizardStep[] = [
  { key: "pronunciation", prompt: "Optional pronunciation guide for humans, such as LYE-rah VAYL.", type: "string" },
  { key: "spokenName", prompt: "Optional spoken name or simplified label the browser voice should read aloud.", type: "string" },
  { key: "ttsLabel", prompt: "Optional full TTS replacement if the browser should speak a different phrase than the visible name.", type: "string" },
];

const wizardKindSchema = z.enum([
  "character",
  "location",
  "faction",
  "item",
  "secret",
  "timeline-event",
  "chapter",
  "paragraph",
]);

type WizardKind = z.infer<typeof wizardKindSchema>;
type WizardStepType = "string" | "int" | "bool" | "stringArray";

type WizardStep = {
  key: string;
  prompt: string;
  type: WizardStepType;
  required?: boolean;
  condition?: (data: Record<string, unknown>) => boolean;
};

type WizardSession = {
  id: string;
  kind: WizardKind;
  rootPath: string;
  steps: WizardStep[];
  stepIndex: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

const wizardSessions = new Map<string, WizardSession>();

const wizardDefinitions: Record<WizardKind, WizardStep[]> = {
  character: [
    { key: "name", prompt: "What is the character's name?", type: "string", required: true },
    { key: "roleTier", prompt: "What is the role tier? main, supporting, secondary, minor, or background?", type: "string", required: true },
    { key: "storyRole", prompt: "What is the story role? protagonist, antagonist, mentor, ally, foil, love-interest, comic-relief, or other?", type: "string" },
    { key: "speakingStyle", prompt: "How does the character speak? Describe rhythm, vocabulary, tone, and verbal habits.", type: "string", required: true },
    { key: "backgroundSummary", prompt: "What shaped this character before the story begins?", type: "string", required: true },
    { key: "functionInBook", prompt: "What narrative function does this character serve in the book?", type: "string", required: true },
    ...pronunciationWizardSteps,
    { key: "age", prompt: "How old is the character, if known?", type: "int" },
    { key: "occupation", prompt: "What is their occupation, role, or public identity?", type: "string" },
    { key: "origin", prompt: "Where do they come from?", type: "string" },
    { key: "firstImpression", prompt: "What first impression should the reader get?", type: "string" },
    { key: "currentIdentity", prompt: "What identity or name are they currently presenting to the world?", type: "string" },
    { key: "formerNames", prompt: "List former names or identities tied to this character.", type: "stringArray" },
    { key: "identityShifts", prompt: "List major identity changes, disguises, or transformations.", type: "stringArray" },
    { key: "identityArc", prompt: "How does this character's identity evolve across the book?", type: "string" },
    { key: "traits", prompt: "List important traits, comma separated if needed.", type: "stringArray" },
    { key: "mannerisms", prompt: "List notable mannerisms or repeated behaviors.", type: "stringArray" },
    { key: "desires", prompt: "What does the character want?", type: "stringArray" },
    { key: "fears", prompt: "What does the character fear?", type: "stringArray" },
    { key: "internalConflict", prompt: "What internal conflict defines this character?", type: "string" },
    { key: "externalConflict", prompt: "What external conflict defines this character?", type: "string" },
    { key: "arc", prompt: "How should the character change across the book?", type: "string" },
    { key: "relationships", prompt: "List important relationships or tensions.", type: "stringArray" },
    { key: "factions", prompt: "List faction ids or names tied to this character.", type: "stringArray" },
    { key: "homeLocation", prompt: "What is the character's home location id or name?", type: "string" },
    { key: "introducedIn", prompt: "In which chapter is the character introduced?", type: "string" },
    ...hiddenCanonWizardSteps,
    { key: "historical", prompt: "Is this character historical or fact-checked? yes or no.", type: "bool" },
    { key: "wikipediaTitle", prompt: "If historical, what Wikipedia page should be used for verification?", type: "string", condition: (data) => Boolean(data.historical) },
  ],
  location: [
    { key: "name", prompt: "What is the location name?", type: "string", required: true },
    { key: "locationKind", prompt: "What kind of location is it? city, district, fortress, room, landscape, etc.", type: "string" },
    { key: "region", prompt: "What larger region, nation, or zone contains it?", type: "string" },
    { key: "atmosphere", prompt: "What should the place feel like on the page?", type: "string", required: true },
    { key: "functionInBook", prompt: "Why does this location matter narratively?", type: "string", required: true },
    ...pronunciationWizardSteps,
    { key: "landmarks", prompt: "List the key landmarks.", type: "stringArray" },
    { key: "risks", prompt: "List the dangers or pressures associated with this location.", type: "stringArray" },
    { key: "factionsPresent", prompt: "Which factions are active here?", type: "stringArray" },
    { key: "basedOnRealPlace", prompt: "Is it based on a real place or historical site? yes or no.", type: "bool" },
    { key: "timelineRef", prompt: "What timeline reference anchors this location, if any?", type: "string" },
    ...hiddenCanonWizardSteps,
    { key: "historical", prompt: "Should this location be fact-checked as historical or factual? yes or no.", type: "bool" },
    { key: "wikipediaTitle", prompt: "If fact-checked, what Wikipedia page should be used?", type: "string", condition: (data) => Boolean(data.historical) || Boolean(data.basedOnRealPlace) },
  ],
  faction: [
    { key: "name", prompt: "What is the faction name?", type: "string", required: true },
    { key: "factionKind", prompt: "What kind of faction is it? government, guild, cult, company, order, etc.", type: "string" },
    { key: "mission", prompt: "What does the faction want?", type: "string", required: true },
    { key: "ideology", prompt: "How does the faction justify itself?", type: "string", required: true },
    { key: "functionInBook", prompt: "What narrative pressure does this faction create?", type: "string", required: true },
    ...pronunciationWizardSteps,
    { key: "publicImage", prompt: "How is the faction perceived publicly?", type: "string" },
    { key: "hiddenAgenda", prompt: "What hidden agenda or private motive does it have?", type: "string" },
    { key: "leaders", prompt: "Who leads the faction?", type: "stringArray" },
    { key: "allies", prompt: "Who are its allies?", type: "stringArray" },
    { key: "enemies", prompt: "Who are its enemies?", type: "stringArray" },
    { key: "methods", prompt: "What methods does it use to get results?", type: "stringArray" },
    { key: "baseLocation", prompt: "What is the faction's base location?", type: "string" },
    ...hiddenCanonWizardSteps,
    { key: "historical", prompt: "Should this faction be checked against history or factual research? yes or no.", type: "bool" },
    { key: "wikipediaTitle", prompt: "If factual, what Wikipedia page should be used?", type: "string", condition: (data) => Boolean(data.historical) },
  ],
  item: [
    { key: "name", prompt: "What is the item name?", type: "string", required: true },
    { key: "itemKind", prompt: "What kind of item is it? artifact, weapon, document, relic, tool, etc.", type: "string" },
    { key: "appearance", prompt: "What does the item look like?", type: "string", required: true },
    { key: "purpose", prompt: "What does the item do or enable?", type: "string", required: true },
    { key: "functionInBook", prompt: "Why does the item matter to the story?", type: "string", required: true },
    ...pronunciationWizardSteps,
    { key: "significance", prompt: "Why is the item especially valuable or symbolic?", type: "string" },
    { key: "originStory", prompt: "Where does the item come from?", type: "string" },
    { key: "powers", prompt: "List powers or capabilities.", type: "stringArray" },
    { key: "limitations", prompt: "List limits, risks, or costs.", type: "stringArray" },
    { key: "owner", prompt: "Who currently owns or carries the item?", type: "string" },
    { key: "introducedIn", prompt: "Where is the item introduced?", type: "string" },
    ...hiddenCanonWizardSteps,
    { key: "historical", prompt: "Is this item historical or fact-checked? yes or no.", type: "bool" },
    { key: "wikipediaTitle", prompt: "If factual, what Wikipedia page should be used?", type: "string", condition: (data) => Boolean(data.historical) },
  ],
  secret: [
    { key: "title", prompt: "What is the secret title or short label?", type: "string", required: true },
    { key: "secretKind", prompt: "What kind of secret is it? identity, betrayal, crime, prophecy, origin, etc.", type: "string" },
    { key: "functionInBook", prompt: "Why does this secret exist in the story?", type: "string", required: true },
    { key: "stakes", prompt: "What changes if the secret is revealed or suppressed?", type: "string", required: true },
    ...pronunciationWizardSteps,
    { key: "protectedBy", prompt: "Who or what protects the secret?", type: "stringArray" },
    { key: "falseBeliefs", prompt: "What false beliefs does this secret create or preserve?", type: "stringArray" },
    { key: "revealStrategy", prompt: "How should the reveal be staged?", type: "string" },
    { key: "holders", prompt: "Who knows the truth?", type: "stringArray" },
    { key: "secretRefs", prompt: "List related secret ids for cross-reference, if any.", type: "stringArray" },
    { key: "privateNotes", prompt: "Add private notes that should stay off the main canon surface.", type: "string" },
    { key: "revealIn", prompt: "In which chapter should it be revealed?", type: "string" },
    { key: "knownFrom", prompt: "From which chapter can the reader safely know it?", type: "string" },
    { key: "timelineRef", prompt: "What timeline reference anchors the secret?", type: "string" },
    { key: "historical", prompt: "Does this secret depend on factual or historical verification? yes or no.", type: "bool" },
    { key: "wikipediaTitle", prompt: "If factual, what Wikipedia page should be used?", type: "string", condition: (data) => Boolean(data.historical) },
  ],
  "timeline-event": [
    { key: "title", prompt: "What is the event title?", type: "string", required: true },
    { key: "date", prompt: "What is the date or chronology marker?", type: "string" },
    { key: "participants", prompt: "Who participates in this event?", type: "stringArray" },
    { key: "significance", prompt: "Why is this event important?", type: "string" },
    { key: "functionInBook", prompt: "What is this event used for in the book?", type: "string" },
    ...pronunciationWizardSteps,
    { key: "consequences", prompt: "List the consequences of the event.", type: "stringArray" },
    ...hiddenCanonWizardSteps,
    { key: "historical", prompt: "Should this event be checked against history or factual research? yes or no.", type: "bool" },
    { key: "wikipediaTitle", prompt: "If factual, what Wikipedia page should be used?", type: "string", condition: (data) => Boolean(data.historical) },
  ],
  chapter: [
    { key: "number", prompt: "What chapter number should be created?", type: "int", required: true },
    { key: "title", prompt: "What is the chapter title?", type: "string", required: true },
    { key: "summary", prompt: "What is the chapter summary?", type: "string" },
    { key: "pov", prompt: "Which POV ids or names drive this chapter?", type: "stringArray" },
    { key: "styleRefs", prompt: "List explicit style profile ids for this chapter only, if it should diverge from the book default.", type: "stringArray" },
    { key: "narrationPerson", prompt: "If this chapter needs an explicit narration person, what is it? first, second, third, etc.", type: "string" },
    { key: "narrationTense", prompt: "If this chapter needs an explicit narration tense, what is it? past, present, etc.", type: "string" },
    { key: "proseMode", prompt: "List explicit prose modes for this chapter, such as show-dont-tell, tight-interiority, or descriptive-wide-lens.", type: "stringArray" },
    { key: "timelineRef", prompt: "What timeline reference should this chapter carry?", type: "string" },
    { key: "tags", prompt: "List chapter tags.", type: "stringArray" },
    { key: "body", prompt: "Optional chapter notes body or beat scaffold.", type: "string" },
  ],
  paragraph: [
    { key: "chapter", prompt: "Which chapter should contain this paragraph? Use chapter id or folder slug.", type: "string", required: true },
    { key: "number", prompt: "What paragraph number should be created?", type: "int", required: true },
    { key: "title", prompt: "What is the paragraph or scene title?", type: "string", required: true },
    { key: "summary", prompt: "What is the scene summary?", type: "string" },
    { key: "viewpoint", prompt: "Which viewpoint id or name drives this scene?", type: "string" },
    { key: "tags", prompt: "List scene tags.", type: "stringArray" },
    { key: "body", prompt: "Optional body text for the scene stub.", type: "string" },
  ],
};

server.tool(
  "init_book_repo",
  "Create the local Narrarium repository structure for a book project, including folders, guidelines, summaries, evaluations, and reusable skills.",
  {
    rootPath: z.string().min(1),
    title: z.string().min(1),
    author: z.string().optional(),
    language: z.string().default("en"),
    createSkills: z.boolean().default(true),
  },
  async ({ rootPath, title, author, language, createSkills }) => {
    const result = await initializeBookRepo(rootPath, {
      title,
      author,
      language,
      createSkills,
    });
    const plot = await syncPlot(rootPath);

    return textResponse(
      [
        `Initialized Narrarium book repo at ${result.rootPath}.`,
        `Created ${result.created.length} seed files and directories.`,
        result.created.length > 0 ? `Created files: ${result.created.join(", ")}` : "All seed files already existed.",
        `Synced plot at ${plot.filePath}.`,
      ].join("\n"),
    );
  },
);

server.tool(
  "setup_framework",
  "Return the exact npx commands and setup steps to bootstrap a new Narrarium project from scratch.",
  {
    projectName: z.string().optional(),
    title: z.string().optional(),
    language: z.string().default("en"),
    withReader: z.boolean().default(true),
    sample: z.boolean().default(false),
    readerDir: z.string().default("reader"),
  },
  async ({ projectName, title, language, withReader, sample, readerDir }) => {
    return textResponse(
      buildSetupInstructions({
        projectName,
        title,
        language,
        withReader,
        sample,
        readerDir,
      }),
    );
  },
);

server.tool(
  "repository_spec",
  "Return the Narrarium repository model and canon rules so clients can understand the book framework structure.",
  {},
  async () => textResponse(buildRepositorySpecSummary()),
);

server.tool(
  "start_wizard",
  "Start a multi-step guided wizard session for creating canon files or chapter structures. Use this when the user has not provided all required details yet.",
  {
    kind: wizardKindSchema,
    rootPath: z.string().min(1),
    seed: z.record(z.string(), z.unknown()).default({}),
  },
  async ({ kind, rootPath, seed }) => {
    const session = createWizardSession(kind, rootPath, seed);
    return textResponse(renderWizardResponse(session, "started"));
  },
);

server.tool(
  "wizard_answer",
  "Answer the current prompt in a running wizard session and receive the next guided question.",
  {
    sessionId: z.string().min(1),
    answer: z.unknown().optional(),
    skip: z.boolean().default(false),
  },
  async ({ sessionId, answer, skip }) => {
    const session = wizardSessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown wizard session: ${sessionId}`);
    }

    applyWizardAnswer(session, answer, skip);
    return textResponse(renderWizardResponse(session, "updated"));
  },
);

server.tool(
  "wizard_status",
  "Inspect the current state of a wizard session, including collected fields and the next question.",
  {
    sessionId: z.string().min(1),
  },
  async ({ sessionId }) => {
    const session = wizardSessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown wizard session: ${sessionId}`);
    }

    return textResponse(renderWizardResponse(session, "status"));
  },
);

server.tool(
  "wizard_finalize",
  "Finalize a wizard session and write the corresponding file or folder into the local book repository.",
  {
    sessionId: z.string().min(1),
    slug: z.string().optional(),
    overwrite: z.boolean().default(false),
    frontmatter: z.record(z.string(), z.unknown()).default({}),
    body: z.string().optional(),
    wikipediaLang: z.string().min(2).default("en"),
    ...wikipediaRefreshToolFields,
  },
  async ({ sessionId, slug, overwrite, frontmatter, body, wikipediaLang, forceWikipediaRefresh, maxWikipediaSnapshotAgeDays }) => {
    const session = wizardSessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown wizard session: ${sessionId}`);
    }

    const result = await finalizeWizardSession(session, {
      slug,
      overwrite,
      frontmatter,
      body,
      lang: wikipediaLang,
      forceWikipediaRefresh,
      maxWikipediaSnapshotAgeDays,
    });
    wizardSessions.delete(sessionId);
    return textResponse(result);
  },
);

server.tool(
  "wizard_cancel",
  "Cancel a wizard session and discard its in-memory answers.",
  {
    sessionId: z.string().min(1),
  },
  async ({ sessionId }) => {
    const existed = wizardSessions.delete(sessionId);
    return textResponse(existed ? `Cancelled wizard session ${sessionId}.` : `Wizard session ${sessionId} was not active.`);
  },
);

server.tool(
  "character_wizard",
  "Return the Narrarium character creation checklist so the agent can gather the right information before creating a character file.",
  {
    name: z.string().optional(),
  },
  async ({ name }) => {
    const label = name?.trim() || "new character";
    return textResponse(
      [
        `Character wizard for ${label}`,
        "",
        "Required fields for create_character:",
        "1. Name",
        "2. Role tier: main, supporting, secondary, minor, background",
        "3. Speaking style: how they talk, rhythm, vocabulary, tone",
        "4. Background summary: what shaped them before the story starts",
        "5. Function in book: why this character exists in the story",
        "",
        "Strong optional fields:",
        "- Story role: protagonist, antagonist, mentor, ally, foil, love-interest, comic-relief, other",
        "- Age, occupation, origin, first impression",
        "- Current identity, former names, and identity shifts",
        "- Traits and mannerisms",
        "- Desires and fears",
        "- Internal and external conflict",
        "- Arc",
        "- Relationships",
        "- Factions, home location, first chapter",
        "- Hidden canon: linked secret ids, private notes, known-from, reveal chapter",
        "- Historical flag and Wikipedia title if factual verification is needed",
      ].join("\n"),
    );
  },
);

server.tool(
  "create_character",
  "Create a rich character file using the Narrarium character wizard fields. Use this instead of the generic entity tool when the user is adding a real story character.",
  {
    rootPath: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().optional(),
    aliases: z.array(z.string()).default([]),
    roleTier: characterRoleTierSchema,
    storyRole: characterStoryRoleSchema.default("other"),
    speakingStyle: z.string().min(1),
    backgroundSummary: z.string().min(1),
    functionInBook: z.string().min(1),
    age: z.number().int().nonnegative().optional(),
    occupation: z.string().optional(),
    origin: z.string().optional(),
    firstImpression: z.string().optional(),
    currentIdentity: z.string().optional(),
    formerNames: z.array(z.string()).default([]),
    identityShifts: z.array(z.string()).default([]),
    identityArc: z.string().optional(),
    arc: z.string().optional(),
    internalConflict: z.string().optional(),
    externalConflict: z.string().optional(),
    traits: z.array(z.string()).default([]),
    mannerisms: z.array(z.string()).default([]),
    desires: z.array(z.string()).default([]),
    fears: z.array(z.string()).default([]),
    relationships: z.array(z.string()).default([]),
    factions: z.array(z.string()).default([]),
    homeLocation: z.string().optional(),
    introducedIn: z.string().optional(),
    ...pronunciationToolFields,
    ...hiddenCanonToolFields,
    timelineAges: z.record(z.string(), z.number().int().nonnegative()).default({}),
    overwrite: z.boolean().default(false),
    historical: z.boolean().default(false),
    wikipediaTitle: z.string().optional(),
    wikipediaLang: z.string().min(2).default("en"),
    ...wikipediaRefreshToolFields,
    frontmatter: z.record(z.string(), z.unknown()).default({}),
  },
  async ({
    rootPath,
    name,
    slug,
    aliases,
    roleTier,
    storyRole,
    speakingStyle,
    backgroundSummary,
    functionInBook,
    age,
    occupation,
    origin,
    firstImpression,
    currentIdentity,
    formerNames,
    identityShifts,
    identityArc,
    arc,
    internalConflict,
    externalConflict,
    traits,
    mannerisms,
    desires,
    fears,
    relationships,
    factions,
    homeLocation,
    introducedIn,
    pronunciation,
    spokenName,
    ttsLabel,
    secretRefs,
    privateNotes,
    revealIn,
    knownFrom,
    timelineAges,
    overwrite,
    historical,
    wikipediaTitle,
    wikipediaLang,
    forceWikipediaRefresh,
    maxWikipediaSnapshotAgeDays,
    frontmatter,
  }) => {
    const { sources, note: wikipediaNote, wikidataClaims } = await collectHistoricalResearchSupport({
      historical,
      wikipediaTitle,
      rootPath,
      slug,
      lang: wikipediaLang,
      forceWikipediaRefresh,
      maxWikipediaSnapshotAgeDays,
    });

    const wikidataFields = wikidataClaims ? mapWikidataToCharacter(wikidataClaims) : {};
    const result = await createCharacterProfile(rootPath, {
      name,
      slug,
      aliases,
      roleTier,
      storyRole,
      speakingStyle,
      backgroundSummary,
      functionInBook,
      age,
      occupation,
      origin,
      firstImpression,
      currentIdentity,
      formerNames,
      identityShifts,
      identityArc,
      arc,
      internalConflict,
      externalConflict,
      traits,
      mannerisms,
      desires,
      fears,
      relationships,
      factions,
      homeLocation,
      introducedIn,
      pronunciation,
      spokenName,
      ttsLabel,
      secretRefs,
      privateNotes,
      revealIn,
      knownFrom,
      timelineAges,
      overwrite,
      historical,
      sources,
      frontmatter: { ...wikidataFields, ...frontmatter },
    });

    return textResponse(`Created character at ${result.filePath}.${wikipediaNote}`);
  },
);

server.tool(
  "location_wizard",
  "Return the Narrarium location creation checklist so the agent can gather the right details before creating a location file.",
  {
    name: z.string().optional(),
  },
  async ({ name }) =>
    textResponse(
      wizardChecklist({
        title: `Location wizard for ${name?.trim() || "new location"}`,
        requiredHeading: "Required fields for create_location:",
        required: [
          "Name",
          "Atmosphere: what the place feels like on the page",
          "Function in book: why this place matters to the story",
        ],
        optionalHeading: "Strong optional fields:",
        optional: [
          "Location kind, region, timeline reference",
          "Landmarks and risks",
          "Factions present",
          "Hidden canon: linked secret ids, private notes, known-from, reveal chapter",
          "Whether it is based on a real place or historical site",
          "Historical flag and Wikipedia title if factual verification is needed",
        ],
      }),
    ),
);

server.tool(
  "create_location",
  "Create a rich location file with atmosphere, story function, landmarks, risks, and optional historical research support.",
  {
    rootPath: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().optional(),
    locationKind: z.string().optional(),
    region: z.string().optional(),
    atmosphere: z.string().min(1),
    functionInBook: z.string().min(1),
    landmarks: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    factionsPresent: z.array(z.string()).default([]),
    basedOnRealPlace: z.boolean().default(false),
    timelineRef: z.string().optional(),
    ...pronunciationToolFields,
    ...hiddenCanonToolFields,
    overwrite: z.boolean().default(false),
    historical: z.boolean().default(false),
    wikipediaTitle: z.string().optional(),
    wikipediaLang: z.string().min(2).default("en"),
    ...wikipediaRefreshToolFields,
    frontmatter: z.record(z.string(), z.unknown()).default({}),
  },
  async ({
    rootPath,
    name,
    slug,
    locationKind,
    region,
    atmosphere,
    functionInBook,
    landmarks,
    risks,
    factionsPresent,
    basedOnRealPlace,
    timelineRef,
    pronunciation,
    spokenName,
    ttsLabel,
    secretRefs,
    privateNotes,
    revealIn,
    knownFrom,
    overwrite,
    historical,
    wikipediaTitle,
    wikipediaLang,
    forceWikipediaRefresh,
    maxWikipediaSnapshotAgeDays,
    frontmatter,
  }) => {
    const { sources, note, wikidataClaims } = await collectHistoricalResearchSupport({
      historical,
      wikipediaTitle,
      rootPath,
      slug,
      lang: wikipediaLang,
      forceWikipediaRefresh,
      maxWikipediaSnapshotAgeDays,
    });

    const wikidataFields = wikidataClaims ? mapWikidataToLocation(wikidataClaims) : {};
    const result = await createLocationProfile(rootPath, {
      name,
      slug,
      locationKind,
      region,
      atmosphere,
      functionInBook,
      landmarks,
      risks,
      factionsPresent,
      basedOnRealPlace,
      timelineRef,
      pronunciation,
      spokenName,
      ttsLabel,
      secretRefs,
      privateNotes,
      revealIn,
      knownFrom,
      overwrite,
      historical,
      sources,
      frontmatter: { ...wikidataFields, ...frontmatter },
    });

    return textResponse(`Created location at ${result.filePath}.${note}`);
  },
);

server.tool(
  "faction_wizard",
  "Return the Narrarium faction creation checklist so the agent can gather the right details before creating a faction file.",
  {
    name: z.string().optional(),
  },
  async ({ name }) =>
    textResponse(
      wizardChecklist({
        title: `Faction wizard for ${name?.trim() || "new faction"}`,
        requiredHeading: "Required fields for create_faction:",
        required: [
          "Name",
          "Mission: what the faction wants",
          "Ideology: how it justifies itself",
          "Function in book: what narrative pressure it creates",
        ],
        optionalHeading: "Strong optional fields:",
        optional: [
          "Faction kind, public image, hidden agenda",
          "Leaders, allies, enemies, methods",
          "Base location",
          "Hidden canon: linked secret ids, private notes, known-from, reveal chapter",
          "Historical flag and Wikipedia title if factual verification is needed",
        ],
      }),
    ),
);

server.tool(
  "create_faction",
  "Create a rich faction file with mission, ideology, methods, alliances, and optional historical research support.",
  {
    rootPath: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().optional(),
    factionKind: z.string().optional(),
    mission: z.string().min(1),
    ideology: z.string().min(1),
    functionInBook: z.string().min(1),
    publicImage: z.string().optional(),
    hiddenAgenda: z.string().optional(),
    leaders: z.array(z.string()).default([]),
    allies: z.array(z.string()).default([]),
    enemies: z.array(z.string()).default([]),
    methods: z.array(z.string()).default([]),
    baseLocation: z.string().optional(),
    ...pronunciationToolFields,
    ...hiddenCanonToolFields,
    overwrite: z.boolean().default(false),
    historical: z.boolean().default(false),
    wikipediaTitle: z.string().optional(),
    wikipediaLang: z.string().min(2).default("en"),
    ...wikipediaRefreshToolFields,
    frontmatter: z.record(z.string(), z.unknown()).default({}),
  },
  async ({
    rootPath,
    name,
    slug,
    factionKind,
    mission,
    ideology,
    functionInBook,
    publicImage,
    hiddenAgenda,
    leaders,
    allies,
    enemies,
    methods,
    baseLocation,
    pronunciation,
    spokenName,
    ttsLabel,
    secretRefs,
    privateNotes,
    revealIn,
    knownFrom,
    overwrite,
    historical,
    wikipediaTitle,
    wikipediaLang,
    forceWikipediaRefresh,
    maxWikipediaSnapshotAgeDays,
    frontmatter,
  }) => {
    const { sources, note, wikidataClaims } = await collectHistoricalResearchSupport({
      historical,
      wikipediaTitle,
      rootPath,
      slug,
      lang: wikipediaLang,
      forceWikipediaRefresh,
      maxWikipediaSnapshotAgeDays,
    });

    const wikidataFields = wikidataClaims ? mapWikidataToFaction(wikidataClaims) : {};
    const result = await createFactionProfile(rootPath, {
      name,
      slug,
      factionKind,
      mission,
      ideology,
      functionInBook,
      publicImage,
      hiddenAgenda,
      leaders,
      allies,
      enemies,
      methods,
      baseLocation,
      pronunciation,
      spokenName,
      ttsLabel,
      secretRefs,
      privateNotes,
      revealIn,
      knownFrom,
      overwrite,
      historical,
      sources,
      frontmatter: { ...wikidataFields, ...frontmatter },
    });

    return textResponse(`Created faction at ${result.filePath}.${note}`);
  },
);

server.tool(
  "item_wizard",
  "Return the Narrarium item creation checklist so the agent can gather the right details before creating an item file.",
  {
    name: z.string().optional(),
  },
  async ({ name }) =>
    textResponse(
      wizardChecklist({
        title: `Item wizard for ${name?.trim() || "new item"}`,
        requiredHeading: "Required fields for create_item:",
        required: [
          "Name",
          "Appearance",
          "Purpose: what the item does or enables",
          "Function in book: why the item matters to the story",
        ],
        optionalHeading: "Strong optional fields:",
        optional: [
          "Item kind, significance, origin story",
          "Owner and chapter of introduction",
          "Powers and limitations",
          "Hidden canon: linked secret ids, private notes, known-from, reveal chapter",
          "Historical flag and Wikipedia title if factual verification is needed",
        ],
      }),
    ),
);

server.tool(
  "create_item",
  "Create a rich item file with appearance, purpose, significance, ownership, and optional historical research support.",
  {
    rootPath: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().optional(),
    itemKind: z.string().optional(),
    appearance: z.string().min(1),
    purpose: z.string().min(1),
    functionInBook: z.string().min(1),
    significance: z.string().optional(),
    originStory: z.string().optional(),
    powers: z.array(z.string()).default([]),
    limitations: z.array(z.string()).default([]),
    owner: z.string().optional(),
    introducedIn: z.string().optional(),
    ...pronunciationToolFields,
    ...hiddenCanonToolFields,
    overwrite: z.boolean().default(false),
    historical: z.boolean().default(false),
    wikipediaTitle: z.string().optional(),
    wikipediaLang: z.string().min(2).default("en"),
    ...wikipediaRefreshToolFields,
    frontmatter: z.record(z.string(), z.unknown()).default({}),
  },
  async ({
    rootPath,
    name,
    slug,
    itemKind,
    appearance,
    purpose,
    functionInBook,
    significance,
    originStory,
    powers,
    limitations,
    owner,
    introducedIn,
    pronunciation,
    spokenName,
    ttsLabel,
    secretRefs,
    privateNotes,
    revealIn,
    knownFrom,
    overwrite,
    historical,
    wikipediaTitle,
    wikipediaLang,
    forceWikipediaRefresh,
    maxWikipediaSnapshotAgeDays,
    frontmatter,
  }) => {
    const { sources, note, wikidataClaims } = await collectHistoricalResearchSupport({
      historical,
      wikipediaTitle,
      rootPath,
      slug,
      lang: wikipediaLang,
      forceWikipediaRefresh,
      maxWikipediaSnapshotAgeDays,
    });

    const wikidataFields = wikidataClaims ? mapWikidataToItem(wikidataClaims) : {};
    const result = await createItemProfile(rootPath, {
      name,
      slug,
      itemKind,
      appearance,
      purpose,
      functionInBook,
      significance,
      originStory,
      powers,
      limitations,
      owner,
      introducedIn,
      pronunciation,
      spokenName,
      ttsLabel,
      secretRefs,
      privateNotes,
      revealIn,
      knownFrom,
      overwrite,
      historical,
      sources,
      frontmatter: { ...wikidataFields, ...frontmatter },
    });

    return textResponse(`Created item at ${result.filePath}.${note}`);
  },
);

server.tool(
  "secret_wizard",
  "Return the Narrarium secret creation checklist so the agent can gather the right details before creating a secret file.",
  {
    title: z.string().optional(),
  },
  async ({ title }) =>
    textResponse(
      wizardChecklist({
        title: `Secret wizard for ${title?.trim() || "new secret"}`,
        requiredHeading: "Required fields for create_secret:",
        required: [
          "Title",
          "Function in book: why this secret exists narratively",
          "Stakes: what changes if it is revealed or suppressed",
        ],
        optionalHeading: "Strong optional fields:",
        optional: [
          "Secret kind",
          "Who holds it and who protects it",
          "False beliefs created by the secret",
          "Reveal strategy, reveal chapter, known-from chapter, timeline reference",
          "Private notes and linked secret ids",
          "Historical flag and Wikipedia title if factual verification is needed",
        ],
      }),
    ),
);

server.tool(
  "create_secret",
  "Create a rich secret file with stakes, holders, protection, reveal strategy, and spoiler thresholds.",
  {
    rootPath: z.string().min(1),
    title: z.string().min(1),
    slug: z.string().optional(),
    secretKind: z.string().optional(),
    functionInBook: z.string().min(1),
    stakes: z.string().min(1),
    protectedBy: z.array(z.string()).default([]),
    falseBeliefs: z.array(z.string()).default([]),
    revealStrategy: z.string().optional(),
    holders: z.array(z.string()).default([]),
    ...pronunciationToolFields,
    secretRefs: z.array(z.string()).default([]),
    privateNotes: z.string().optional(),
    revealIn: z.string().optional(),
    knownFrom: z.string().optional(),
    timelineRef: z.string().optional(),
    overwrite: z.boolean().default(false),
    historical: z.boolean().default(false),
    wikipediaTitle: z.string().optional(),
    wikipediaLang: z.string().min(2).default("en"),
    ...wikipediaRefreshToolFields,
    frontmatter: z.record(z.string(), z.unknown()).default({}),
  },
  async ({
    rootPath,
    title,
    slug,
    secretKind,
    functionInBook,
    stakes,
    protectedBy,
    falseBeliefs,
    revealStrategy,
    holders,
    pronunciation,
    spokenName,
    ttsLabel,
    secretRefs,
    privateNotes,
    revealIn,
    knownFrom,
    timelineRef,
    overwrite,
    historical,
    wikipediaTitle,
    wikipediaLang,
    forceWikipediaRefresh,
    maxWikipediaSnapshotAgeDays,
    frontmatter,
  }) => {
    const { sources, note } = await collectHistoricalResearchSupport({
      historical,
      wikipediaTitle,
      rootPath,
      slug,
      lang: wikipediaLang,
      forceWikipediaRefresh,
      maxWikipediaSnapshotAgeDays,
    });

    const result = await createSecretProfile(rootPath, {
      title,
      slug,
      secretKind,
      functionInBook,
      stakes,
      protectedBy,
      falseBeliefs,
      revealStrategy,
      holders,
      pronunciation,
      spokenName,
      ttsLabel,
      secretRefs,
      privateNotes,
      revealIn,
      knownFrom,
      timelineRef,
      overwrite,
      historical,
      sources,
      frontmatter,
    });

    return textResponse(await appendPlotSyncNote(rootPath, `Created secret at ${result.filePath}.${note}`));
  },
);

server.tool(
  "timeline_event_wizard",
  "Return the Narrarium timeline event checklist so the agent can gather the right details before creating a timeline event file.",
  {
    title: z.string().optional(),
  },
  async ({ title }) =>
    textResponse(
      wizardChecklist({
        title: `Timeline event wizard for ${title?.trim() || "new event"}`,
        requiredHeading: "Required fields for create_timeline_event:",
        required: [
          "Title",
          "Optional date or chronology marker",
          "Participants",
          "Why the event matters and what it changes",
        ],
        optionalHeading: "Strong optional fields:",
        optional: [
          "Function in book",
          "Consequences",
          "Hidden canon: linked secret ids, private notes, known-from, reveal chapter",
          "Historical flag and Wikipedia title if factual verification is needed",
          "Use start_wizard with kind timeline-event for a true guided session",
        ],
      }),
    ),
);

server.tool(
  "create_timeline_event",
  "Create a timeline event file with participants, significance, consequences, and optional factual research support.",
  {
    rootPath: z.string().min(1),
    title: z.string().min(1),
    slug: z.string().optional(),
    date: z.string().optional(),
    participants: z.array(z.string()).default([]),
    significance: z.string().optional(),
    functionInBook: z.string().optional(),
    consequences: z.array(z.string()).default([]),
    ...pronunciationToolFields,
    ...hiddenCanonToolFields,
    overwrite: z.boolean().default(false),
    historical: z.boolean().default(false),
    wikipediaTitle: z.string().optional(),
    wikipediaLang: z.string().min(2).default("en"),
    ...wikipediaRefreshToolFields,
    frontmatter: z.record(z.string(), z.unknown()).default({}),
  },
  async ({
    rootPath,
    title,
    slug,
    date,
    participants,
    significance,
    functionInBook,
    consequences,
    pronunciation,
    spokenName,
    ttsLabel,
    secretRefs,
    privateNotes,
    revealIn,
    knownFrom,
    overwrite,
    historical,
    wikipediaTitle,
    wikipediaLang,
    forceWikipediaRefresh,
    maxWikipediaSnapshotAgeDays,
    frontmatter,
  }) => {
    const { sources, note } = await collectHistoricalResearchSupport({
      historical,
      wikipediaTitle,
      rootPath,
      slug,
      lang: wikipediaLang,
      forceWikipediaRefresh,
      maxWikipediaSnapshotAgeDays,
    });

    const result = await createTimelineEventProfile(rootPath, {
      title,
      slug,
      date,
      participants,
      significance,
      functionInBook,
      consequences,
      pronunciation,
      spokenName,
      ttsLabel,
      secretRefs,
      privateNotes,
      revealIn,
      knownFrom,
      overwrite,
      historical,
      sources,
      frontmatter,
    });

    return textResponse(await appendPlotSyncNote(rootPath, `Created timeline event at ${result.filePath}.${note}`));
  },
);

server.tool(
  "chapter_wizard",
  "Return the Narrarium chapter checklist so the agent can gather the right details before creating a chapter.",
  {
    title: z.string().optional(),
  },
  async ({ title }) =>
    textResponse(
      wizardChecklist({
        title: `Chapter wizard for ${title?.trim() || "new chapter"}`,
        requiredHeading: "Required fields for create_chapter:",
        required: [
          "Chapter number",
          "Chapter title",
        ],
        optionalHeading: "Strong optional fields:",
        optional: [
          "Summary",
          "POV ids",
          "Explicit style refs or narration mode if this chapter should differ from the book default",
          "Timeline reference",
          "Tags",
          "Notes body or beat scaffold",
          "If the prose is not ready yet, create a matching chapter draft first",
          "Use start_wizard with kind chapter for a true guided session",
        ],
      }),
    ),
);

server.tool(
  "paragraph_wizard",
  "Return the Narrarium paragraph or scene checklist so the agent can gather the right details before creating a paragraph file.",
  {
    title: z.string().optional(),
  },
  async ({ title }) =>
    textResponse(
      wizardChecklist({
        title: `Paragraph wizard for ${title?.trim() || "new scene"}`,
        requiredHeading: "Required fields for create_paragraph:",
        required: [
          "Target chapter id or slug",
          "Paragraph number",
          "Paragraph or scene title",
        ],
        optionalHeading: "Strong optional fields:",
        optional: [
          "Summary",
          "Viewpoint",
          "Tags",
          "Optional body text",
          "If the prose is not ready yet, create a matching paragraph draft first",
          "Use start_wizard with kind paragraph for a true guided session",
        ],
      }),
    ),
);

server.tool(
  "chapter_writing_context",
  "Assemble the point-in-time context that should be read before writing or polishing a chapter: prose defaults, scoped story-so-far context, prior chapter state, and matching chapter draft without leaking later story material. In prose, keep canon names as plain text instead of markdown links; the reader resolves visible mentions.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
  },
  async ({ rootPath, chapter }) => {
    const result = await buildChapterWritingContext(rootPath, chapter);
    return textResponse(result.text);
  },
);

server.tool(
  "paragraph_writing_context",
  "Assemble the point-in-time context that should be read before writing or polishing a paragraph: prose defaults, scoped story-so-far context, prior scenes only, and the matching paragraph draft or final paragraph without leaking later story material. In prose, keep canon names as plain text instead of markdown links; the reader resolves visible mentions.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    paragraph: z.string().min(1),
  },
  async ({ rootPath, chapter, paragraph }) => {
    const result = await buildParagraphWritingContext(rootPath, chapter, paragraph);
    return textResponse(result.text);
  },
);

server.tool(
  "revise_chapter",
  "Propose a chapter-level editorial pass without writing files. Use this when you want diagnosis plus scene-by-scene rewrite proposals for an existing final chapter. The result can also suggest merged state_changes review if multiple scenes touch continuity-sensitive beats.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    mode: revisionModeSchema,
    intensity: revisionIntensitySchema.default("medium"),
    preserveFacts: z.boolean().default(true),
  },
  async ({ rootPath, chapter, mode, intensity, preserveFacts }) => {
    const result = await reviseChapter(rootPath, {
      chapter,
      mode,
      intensity,
      preserveFacts,
    });
    const lines = [
      `Proposed chapter revision for ${result.chapter} at ${result.filePath}.`,
      `Mode: ${result.mode}`,
      `Intensity: ${result.intensity}`,
      `Preserve facts: ${result.preserveFacts ? "yes" : "no"}`,
      `Scene count: ${result.sceneCount}`,
      `Changed scene count: ${result.changedSceneCount}`,
      `Overall continuity impact: ${result.overallContinuityImpact}`,
      "Files written: no",
      ...(result.chapterDiagnosis.length > 0 ? ["Diagnosis:", ...result.chapterDiagnosis.map((note) => `- ${note}`)] : []),
      ...(result.revisionPlan.length > 0 ? ["Revision plan:", ...result.revisionPlan.map((note) => `- ${note}`)] : []),
      ...(result.suggestedStateChanges
        ? ["Suggested merged state_changes:", JSON.stringify(result.suggestedStateChanges, null, 2)]
        : []),
      "Scene proposals:",
      ...result.proposedParagraphs.flatMap((proposal) => [
        `- ${proposal.paragraph} :: ${proposal.title}`,
        `  Continuity impact: ${proposal.continuityImpact}`,
        `  Proposed body: ${proposal.proposedBody}`,
      ]),
      "Follow-up:",
      "- Apply any scene proposal manually with update_paragraph if you want to keep it.",
      ...(result.shouldReviewStateChanges
        ? ["- If you apply continuity-sensitive changes, review the suggested state_changes and run sync_story_state manually when ready."]
        : []),
      ...(result.sources.length > 0 ? ["Sources:", ...result.sources.map((source) => `- ${source}`)] : []),
    ];

    return textResponse(lines.join("\n"));
  },
);

server.tool(
  "revise_paragraph",
  "Propose a revision for an existing final paragraph without writing files. Use this for targeted editorial passes like clarity, pacing, tension, dialogue, voice, show-dont-tell, or redundancy cleanup. Show the proposal to the user first, then apply it with update_paragraph only after clear confirmation. The result can also suggest state_changes to review if the paragraph carries continuity-sensitive beats.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    paragraph: z.string().min(1),
    mode: revisionModeSchema,
    intensity: revisionIntensitySchema.default("medium"),
    preserveFacts: z.boolean().default(true),
  },
  async ({ rootPath, chapter, paragraph, mode, intensity, preserveFacts }) => {
    const result = await reviseParagraph(rootPath, {
      chapter,
      paragraph,
      mode,
      intensity,
      preserveFacts,
    });
    const lines = [
      `Proposed revision for ${result.paragraph} at ${result.filePath}.`,
      `Mode: ${result.mode}`,
      `Intensity: ${result.intensity}`,
      `Preserve facts: ${result.preserveFacts ? "yes" : "no"}`,
      `Continuity impact: ${result.continuityImpact}`,
      "Files written: no",
      ...(result.editorialNotes.length > 0 ? ["Notes:", ...result.editorialNotes.map((note) => `- ${note}`)] : []),
      ...(result.suggestedStateChanges
        ? ["Suggested state_changes:", JSON.stringify(result.suggestedStateChanges, null, 2)]
        : []),
      "Proposed body:",
      result.proposedBody,
      "Follow-up:",
      "- Ask the user whether they want to keep this proposal before applying it.",
      "- Apply the confirmed proposal with update_paragraph.",
      ...(result.shouldReviewStateChanges
        ? ["- If you apply the revision and keep the story beats, review the suggested state_changes and run sync_story_state manually when ready."]
        : []),
      ...(result.sources.length > 0 ? ["Sources:", ...result.sources.map((source) => `- ${source}`)] : []),
    ];

    return textResponse(lines.join("\n"));
  },
);

server.tool(
  "resume_book_context",
  "Assemble restart context for a book project using prose rules, stable context, summaries, and exported conversations. You can also scope it to a target chapter or paragraph so the canon only reflects the story up to that writing point.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().optional(),
    paragraph: z.string().optional(),
  },
  async ({ rootPath, chapter, paragraph }) => {
    const result = await buildResumeBookContext(rootPath, {
      chapter,
      paragraph,
    });
    return textResponse(result.text);
  },
);

server.tool(
  "create_entity",
  "Create a canonical entity markdown file inside the local book repository. Use this for quick stubs, items, locations, factions, secrets, and timeline events. Prefer create_character for full story characters.",
  {
    rootPath: z.string().min(1),
    kind: entityTypeSchema,
    slug: z.string().optional(),
    body: z.string().optional(),
    overwrite: z.boolean().default(false),
    frontmatter: z.record(z.string(), z.unknown()).default({}),
    historical: z.boolean().default(false),
    wikipediaTitle: z.string().optional(),
    wikipediaLang: z.string().min(2).default("en"),
    ...wikipediaRefreshToolFields,
  },
  async ({
    rootPath,
    kind,
    slug,
    body,
    overwrite,
    frontmatter,
    historical,
    wikipediaTitle,
    wikipediaLang,
    forceWikipediaRefresh,
    maxWikipediaSnapshotAgeDays,
  }) => {
    let wikipediaNote = "";
    let mergedFrontmatter: Record<string, unknown> = { ...frontmatter, historical };

    if (historical && wikipediaTitle) {
      const { sources, note } = await collectHistoricalResearchSupport({
        historical,
        wikipediaTitle,
        lang: wikipediaLang,
        rootPath,
        slug,
        forceWikipediaRefresh,
        maxWikipediaSnapshotAgeDays,
      });
      mergedFrontmatter = {
        ...mergedFrontmatter,
        sources: uniqueStrings([
          ...(Array.isArray(mergedFrontmatter.sources) ? mergedFrontmatter.sources.filter(isString) : []),
          ...sources,
        ]),
      };
      wikipediaNote = note;
    }

    const result = await createEntity(rootPath, kind, {
      slug,
      body,
      overwrite,
      frontmatter: mergedFrontmatter,
    });

    return textResponse(
      await maybeAppendPlotSyncNote(rootPath, kind, `Created ${kind} at ${result.filePath}.${wikipediaNote}`),
    );
  },
);

server.tool(
  "create_chapter",
  "Create a chapter folder, chapter metadata file, and paired resume and evaluation files in the local book repository. In prose bodies, keep canon names as plain text instead of markdown links to canon files.",
  {
    rootPath: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
    summary: z.string().optional(),
    pov: z.array(z.string()).default([]),
    styleRefs: z.array(z.string()).default([]),
    narrationPerson: z.string().optional(),
    narrationTense: z.string().optional(),
    proseMode: z.array(z.string()).default([]),
    timelineRef: z.string().optional(),
    tags: z.array(z.string()).default([]),
    body: z.string().optional(),
    overwrite: z.boolean().default(false),
    frontmatter: z.record(z.string(), z.unknown()).default({}),
  },
  async ({ rootPath, number, title, summary, pov, styleRefs, narrationPerson, narrationTense, proseMode, timelineRef, tags, body, overwrite, frontmatter }) => {
    const result = await createChapter(rootPath, {
      number,
      title,
      body,
      overwrite,
      frontmatter: {
        summary,
        pov,
        style_refs: styleRefs,
        narration_person: narrationPerson,
        narration_tense: narrationTense,
        prose_mode: proseMode,
        timeline_ref: timelineRef,
        tags,
        ...frontmatter,
      },
    });

    return textResponse(
      await appendChapterPathMaintenanceNote(rootPath, result.chapterFilePath, `Created chapter ${result.chapterId} at ${result.chapterFilePath}.`),
    );
  },
);

server.tool(
  "create_paragraph",
  "Create a numbered paragraph or scene markdown file inside an existing chapter folder. In prose bodies, keep canon names as plain text instead of markdown links to canon files.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string().optional(),
    overwrite: z.boolean().default(false),
    frontmatter: z.record(z.string(), z.unknown()).default({}),
  },
  async ({ rootPath, chapter, number, title, body, overwrite, frontmatter }) => {
    const result = await createParagraph(rootPath, {
      chapter,
      number,
      title,
      body,
      overwrite,
      frontmatter,
    });

    return textResponse(
      await appendParagraphPathMaintenanceNote(rootPath, result.filePath, `Created paragraph ${result.paragraphId} at ${result.filePath}.`),
    );
  },
);

server.tool(
  "create_chapter_draft",
  "Create a rough chapter draft inside drafts/ using the same chapter slug structure as the final chapter tree. Keep canon names as plain text in the draft prose instead of markdown links.",
  {
    rootPath: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
    summary: z.string().optional(),
    pov: z.array(z.string()).default([]),
    styleRefs: z.array(z.string()).default([]),
    narrationPerson: z.string().optional(),
    narrationTense: z.string().optional(),
    proseMode: z.array(z.string()).default([]),
    timelineRef: z.string().optional(),
    tags: z.array(z.string()).default([]),
    body: z.string().optional(),
    overwrite: z.boolean().default(false),
    frontmatter: z.record(z.string(), z.unknown()).default({}),
  },
  async ({ rootPath, number, title, summary, pov, styleRefs, narrationPerson, narrationTense, proseMode, timelineRef, tags, body, overwrite, frontmatter }) => {
    const result = await createChapterDraft(rootPath, {
      number,
      title,
      body,
      overwrite,
      frontmatter: {
        summary,
        pov,
        style_refs: styleRefs,
        narration_person: narrationPerson,
        narration_tense: narrationTense,
        prose_mode: proseMode,
        timeline_ref: timelineRef,
        tags,
        ...frontmatter,
      },
    });

    return textResponse(
      `Created chapter draft ${result.draftId} at ${result.draftFilePath}. Chapter notes live at ${result.notesFilePath}. Chapter ideas live at ${result.ideasFilePath}. Promoted archive lives at ${result.promotedFilePath}.`,
    );
  },
);

server.tool(
  "update_chapter_draft",
  "Update an existing chapter draft by patching its frontmatter and replacing or appending rough draft body content.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    frontmatterPatch: z.record(z.string(), z.unknown()).default({}),
    body: z.string().optional(),
    appendBody: z.string().optional(),
  },
  async ({ rootPath, chapter, frontmatterPatch, body, appendBody }) => {
    const result = await updateChapterDraft(rootPath, {
      chapter,
      frontmatterPatch,
      body,
      appendBody,
    });

    return textResponse(`Updated chapter draft at ${result.filePath}.`);
  },
);

server.tool(
  "update_book_notes",
  "Update the global working notes or story-design document. Use appendBody when the user asks you to keep a note without replacing the whole file.",
  {
    rootPath: z.string().min(1),
    target: z.enum(["notes", "story-design"]).default("notes"),
    frontmatterPatch: z.record(z.string(), z.unknown()).default({}),
    body: z.string().optional(),
    appendBody: z.string().optional(),
  },
  async ({ rootPath, target, frontmatterPatch, body, appendBody }) => {
    const result = await updateBookNotes(rootPath, {
      target,
      frontmatterPatch,
      body,
      appendBody,
    });

    return textResponse(`Updated ${target === "story-design" ? "story-design" : "book notes"} at ${result.filePath}.`);
  },
);

server.tool(
  "save_book_item",
  "Create or update a structured idea or note entry at book level. Use this for active idea queues and note queues rather than freeform body edits.",
  {
    rootPath: z.string().min(1),
    bucket: z.enum(["ideas", "notes"]),
    entryId: z.string().optional(),
    title: z.string().min(1),
    body: z.string().min(1),
    tags: z.array(z.string()).default([]),
    status: z.enum(["active", "review", "resolved", "rejected"]).default("active"),
  },
  async ({ rootPath, bucket, entryId, title, body, tags, status }) => {
    const result = await saveBookWorkItem(rootPath, {
      bucket,
      entryId,
      title,
      body,
      tags,
      status,
    });

    return textResponse(`Saved ${bucket.slice(0, -1)} entry ${result.entry.id} at ${result.filePath}.`);
  },
);

server.tool(
  "save_chapter_item",
  "Create or update a structured idea or note entry tied to a chapter draft.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    bucket: z.enum(["ideas", "notes"]),
    entryId: z.string().optional(),
    title: z.string().min(1),
    body: z.string().min(1),
    tags: z.array(z.string()).default([]),
    status: z.enum(["active", "review", "resolved", "rejected"]).default("active"),
  },
  async ({ rootPath, chapter, bucket, entryId, title, body, tags, status }) => {
    const result = await saveChapterDraftWorkItem(rootPath, {
      chapter,
      bucket,
      entryId,
      title,
      body,
      tags,
      status,
    });

    return textResponse(`Saved chapter ${bucket.slice(0, -1)} entry ${result.entry.id} at ${result.filePath}.`);
  },
);

server.tool(
  "update_chapter_notes",
  "Update or append chapter-specific working notes stored in drafts/<chapter>/notes.md. Use this when the user wants to keep or refine notes tied to a chapter draft.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    frontmatterPatch: z.record(z.string(), z.unknown()).default({}),
    body: z.string().optional(),
    appendBody: z.string().optional(),
  },
  async ({ rootPath, chapter, frontmatterPatch, body, appendBody }) => {
    const result = await updateChapterDraftNotes(rootPath, {
      chapter,
      frontmatterPatch,
      body,
      appendBody,
    });

    return textResponse(`Updated chapter notes at ${result.filePath}.`);
  },
);

server.tool(
  "promote_book_item",
  "Promote a structured book-level idea or note out of the active queue. You can move it into notes or story design, or archive it as promoted after you already used it in a draft.",
  {
    rootPath: z.string().min(1),
    source: z.enum(["ideas", "notes"]),
    entryId: z.string().min(1),
    promotedTo: z.string().min(1),
    target: z.enum(["notes", "story-design"]).optional(),
  },
  async ({ rootPath, source, entryId, promotedTo, target }) => {
    const result = await promoteBookWorkItem(rootPath, {
      source,
      entryId,
      promotedTo,
      target,
    });

    return textResponse(
      `Promoted ${source.slice(0, -1)} entry ${result.promotedEntry.id} to ${promotedTo}. Archived it at ${result.promotedFilePath}${result.targetFilePath ? ` and updated ${result.targetFilePath}` : ""}.`,
    );
  },
);

server.tool(
  "promote_chapter_item",
  "Promote a structured chapter-level idea or note out of the active queue. You can move it into chapter notes or archive it as promoted after using it in draft work.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    source: z.enum(["ideas", "notes"]),
    entryId: z.string().min(1),
    promotedTo: z.string().min(1),
    target: z.enum(["notes"]).optional(),
  },
  async ({ rootPath, chapter, source, entryId, promotedTo, target }) => {
    const result = await promoteChapterDraftWorkItem(rootPath, {
      chapter,
      source,
      entryId,
      promotedTo,
      target,
    });

    return textResponse(
      `Promoted chapter ${source.slice(0, -1)} entry ${result.promotedEntry.id} to ${promotedTo}. Archived it at ${result.promotedFilePath}${result.targetFilePath ? ` and updated ${result.targetFilePath}` : ""}.`,
    );
  },
);

server.tool(
  "create_paragraph_draft",
  "Create a rough paragraph or scene draft inside drafts/ using the same chapter tree as the final chapter.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string().optional(),
    overwrite: z.boolean().default(false),
    frontmatter: z.record(z.string(), z.unknown()).default({}),
  },
  async ({ rootPath, chapter, number, title, body, overwrite, frontmatter }) => {
    const result = await createParagraphDraft(rootPath, {
      chapter,
      number,
      title,
      body,
      overwrite,
      frontmatter,
    });

    return textResponse(
      `Created paragraph draft ${result.draftId} at ${result.filePath}. Chapter notes live at ${result.notesFilePath}. Chapter ideas live at ${result.ideasFilePath}. Promoted archive lives at ${result.promotedFilePath}.`,
    );
  },
);

server.tool(
  "update_paragraph_draft",
  "Update an existing paragraph draft by patching its frontmatter and replacing or appending rough scene content. Keep canon names as plain text in the draft prose instead of markdown links.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    paragraph: z.string().min(1),
    frontmatterPatch: z.record(z.string(), z.unknown()).default({}),
    body: z.string().optional(),
    appendBody: z.string().optional(),
  },
  async ({ rootPath, chapter, paragraph, frontmatterPatch, body, appendBody }) => {
    const result = await updateParagraphDraft(rootPath, {
      chapter,
      paragraph,
      frontmatterPatch,
      body,
      appendBody,
    });

    return textResponse(`Updated paragraph draft at ${result.filePath}.`);
  },
);

server.tool(
  "create_chapter_from_draft",
  "Promote a chapter draft into the final chapters/ tree. It copies structural frontmatter from drafts/, accepts polished body text if provided, and syncs plot.md after writing. Final prose should keep canon names as plain text instead of markdown links.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    body: z.string().optional(),
    overwrite: z.boolean().default(false),
    frontmatterPatch: z.record(z.string(), z.unknown()).default({}),
  },
  async ({ rootPath, chapter, body, overwrite, frontmatterPatch }) => {
    const result = await createChapterFromDraft(rootPath, {
      chapter,
      body,
      overwrite,
      frontmatterPatch,
    });

    return textResponse(await appendChapterPathMaintenanceNote(rootPath, result.filePath, `Created or updated chapter from draft at ${result.filePath} using ${result.draftPath}.`));
  },
);

server.tool(
  "create_paragraph_from_draft",
  "Promote a paragraph draft into the final chapters/ tree. It copies structural frontmatter from drafts/, accepts polished body text if provided, and syncs plot.md after writing. Final prose should keep canon names as plain text instead of markdown links.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    paragraph: z.string().min(1),
    body: z.string().optional(),
    overwrite: z.boolean().default(false),
    frontmatterPatch: z.record(z.string(), z.unknown()).default({}),
  },
  async ({ rootPath, chapter, paragraph, body, overwrite, frontmatterPatch }) => {
    const result = await createParagraphFromDraft(rootPath, {
      chapter,
      paragraph,
      body,
      overwrite,
      frontmatterPatch,
    });

    return textResponse(await appendParagraphPathMaintenanceNote(rootPath, result.filePath, `Created or updated paragraph from draft at ${result.filePath} using ${result.draftPath}.`));
  },
);

server.tool(
  "create_asset_prompt",
  "Create an asset prompt markdown file in the canonical assets tree for a book, entity, chapter, or paragraph image.",
  {
    rootPath: z.string().min(1),
    subject: z.string().min(1),
    assetKind: z.string().min(1).optional(),
    extension: z.string().min(1).default("png"),
    overwrite: z.boolean().default(false),
    promptStyleRef: z.string().default("guideline:images"),
    orientation: imageOrientationSchema.default("portrait"),
    aspectRatio: z.string().default("2:3"),
    provider: z.string().optional(),
    model: z.string().optional(),
    body: z.string().optional(),
    frontmatter: z.record(z.string(), z.unknown()).default({}),
  },
  async ({ rootPath, subject, assetKind, extension, overwrite, promptStyleRef, orientation, aspectRatio, provider, model, body, frontmatter }) => {
    const result = await createAssetPrompt(rootPath, {
      subject,
      assetKind,
      extension,
      overwrite,
      promptStyleRef,
      orientation,
      aspectRatio,
      provider,
      model,
      body,
      frontmatter,
    });

    return textResponse(`Created asset prompt ${result.assetId} at ${result.filePath}. Image target: ${result.imagePath}.`);
  },
);

server.tool(
  "register_asset",
  "Copy an existing image into the canonical assets tree and create its matching prompt metadata file.",
  {
    rootPath: z.string().min(1),
    subject: z.string().min(1),
    sourceFilePath: z.string().min(1),
    assetKind: z.string().min(1).optional(),
    extension: z.string().min(1).optional(),
    overwrite: z.boolean().default(false),
    promptStyleRef: z.string().default("guideline:images"),
    orientation: imageOrientationSchema.default("portrait"),
    aspectRatio: z.string().default("2:3"),
    provider: z.string().optional(),
    model: z.string().optional(),
    body: z.string().optional(),
    frontmatter: z.record(z.string(), z.unknown()).default({}),
  },
  async ({ rootPath, subject, sourceFilePath, assetKind, extension, overwrite, promptStyleRef, orientation, aspectRatio, provider, model, body, frontmatter }) => {
    const result = await registerAsset(rootPath, {
      subject,
      sourceFilePath,
      assetKind,
      extension,
      overwrite,
      promptStyleRef,
      orientation,
      aspectRatio,
      provider,
      model,
      body,
      frontmatter,
    });

    return textResponse(`Registered asset ${result.assetId} at ${result.filePath}. Image stored at ${result.imagePath}.`);
  },
);

server.tool(
  "generate_asset_image",
  "Generate an image for a canonical subject, save it into the assets tree, and keep the asset prompt metadata in sync.",
  {
    rootPath: z.string().min(1),
    subject: z.string().min(1),
    assetKind: z.string().min(1).optional(),
    prompt: z.string().optional(),
    provider: imageProviderSchema.default("openai"),
    model: z.string().default("gpt-image-1"),
    overwrite: z.boolean().default(false),
    promptStyleRef: z.string().optional(),
    orientation: imageOrientationSchema.optional(),
    aspectRatio: z.string().optional(),
  },
  async ({ rootPath, subject, assetKind, prompt, provider, model, overwrite, promptStyleRef, orientation, aspectRatio }) => {
    let asset = await readAsset(rootPath, subject, assetKind);

    if (!asset && !prompt) {
      throw new Error("Prompt is required the first time an asset image is generated for a subject.");
    }

    const effectivePrompt = (prompt ?? extractPromptSection(asset?.body ?? "")).trim();
    if (!effectivePrompt) {
      throw new Error("No prompt found. Provide prompt explicitly or store it under the # Prompt section of the asset markdown file.");
    }

    const effectiveOrientation = orientation ?? asset?.metadata.orientation ?? "portrait";
    const effectiveAspectRatio = aspectRatio ?? asset?.metadata.aspect_ratio ?? "2:3";
    const effectivePromptStyleRef = promptStyleRef ?? asset?.metadata.prompt_style_ref ?? "guideline:images";

    if (!asset) {
      await createAssetPrompt(rootPath, {
        subject,
        assetKind,
        extension: "png",
        promptStyleRef: effectivePromptStyleRef,
        orientation: effectiveOrientation,
        aspectRatio: effectiveAspectRatio,
        provider,
        model,
        body: buildAssetPromptBody(subject, effectivePrompt),
      });
      asset = await readAsset(rootPath, subject, assetKind);
    }

    if (!asset) {
      throw new Error("Failed to initialize asset metadata before image generation.");
    }

    if (asset.imageExists && !overwrite) {
      throw new Error(`Image already exists at ${asset.imagePath}. Set overwrite=true to replace it.`);
    }

    const imageBuffer = await generateImageBuffer({
      prompt: effectivePrompt,
      provider,
      model,
      orientation: effectiveOrientation,
      aspectRatio: effectiveAspectRatio,
    });

    await mkdir(path.dirname(asset.imagePath), { recursive: true });
    await writeFile(asset.imagePath, imageBuffer);

    const nextFrontmatter = assetSchema.parse({
      ...asset.metadata,
      prompt_style_ref: effectivePromptStyleRef,
      orientation: effectiveOrientation,
      aspect_ratio: effectiveAspectRatio,
      provider,
      model,
    });
    const nextBody = prompt ? buildAssetPromptBody(subject, effectivePrompt) : asset.body;
    await writeFile(asset.path, renderMarkdown(nextFrontmatter, nextBody), "utf8");

    return textResponse(`Generated ${provider} image for ${subject} at ${asset.imagePath} using ${model}.`);
  },
);

server.tool(
  "update_chapter",
  "Update an existing chapter metadata file and optional chapter notes body. Use this for summary, POV, tags, and chapter notes changes without touching chapter numbering or folder naming. In prose bodies, keep canon names as plain text instead of markdown links.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    frontmatterPatch: z.record(z.string(), z.unknown()).default({}),
    body: z.string().optional(),
    appendBody: z.string().optional(),
  },
  async ({ rootPath, chapter, frontmatterPatch, body, appendBody }) => {
    const result = await updateChapter(rootPath, {
      chapter,
      frontmatterPatch,
      body,
      appendBody,
    });

    return textResponse(await appendChapterPathMaintenanceNote(rootPath, result.filePath, `Updated chapter at ${result.filePath}.`));
  },
);

server.tool(
  "update_paragraph",
  "Apply an existing paragraph or scene revision after the user confirmed it. Use this for summary, viewpoint, tags, and body revisions without renumbering or renaming the file. Keep canon names as plain text instead of markdown links; the MCP layer refreshes plot and resume files after the update.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    paragraph: z.string().min(1),
    frontmatterPatch: z.record(z.string(), z.unknown()).default({}),
    body: z.string().optional(),
    appendBody: z.string().optional(),
  },
  async ({ rootPath, chapter, paragraph, frontmatterPatch, body, appendBody }) => {
    const result = await updateParagraph(rootPath, {
      chapter,
      paragraph,
      frontmatterPatch,
      body,
      appendBody,
    });

    return textResponse(await appendParagraphPathMaintenanceNote(rootPath, result.filePath, `Updated paragraph at ${result.filePath}.`));
  },
);

server.tool(
  "search_book",
  "Search the local book repository across canon, chapters, notes, summaries, and research before drafting or editing.",
  {
    rootPath: z.string().min(1),
    query: z.string().min(1),
    scopes: z.array(z.string()).optional(),
    limit: z.number().int().positive().max(25).default(10),
  },
  async ({ rootPath, query, scopes, limit }) => {
    const hits = await searchBook(rootPath, query, { scopes, limit });

    if (hits.length === 0) {
      return textResponse(`No matches found for "${query}".`);
    }

    const lines = hits.map(
      (hit, index) =>
        `${index + 1}. [${hit.type}] ${hit.title} :: ${hit.path}\n   ${hit.excerpt}`,
    );

    return textResponse(lines.join("\n"));
  },
);

server.tool(
  "query_canon",
  "Answer a natural-language canon question by combining structured state, summaries, chapters, and repository search. Use this for questions like where a character is, what they know, who holds a secret, when something first appears, or how a relationship/condition/open loop changes across a chapter range.",
  {
    rootPath: z.string().min(1),
    question: z.string().min(1),
    throughChapter: z.string().optional(),
    fromChapter: z.string().optional(),
    toChapter: z.string().optional(),
    limit: z.number().int().positive().max(12).default(6),
  },
  async ({ rootPath, question, throughChapter, fromChapter, toChapter, limit }) => {
    const result = await queryCanon(rootPath, question, { throughChapter, fromChapter, toChapter, limit });
    const lines = [
      `Answer: ${result.answer}`,
      `Confidence: ${result.confidence}`,
      `Intent: ${result.intent}`,
      ...(result.matchedTarget ? [`Matched target: ${result.matchedTarget}`] : []),
      ...(result.fromChapter ? [`From chapter: ${result.fromChapter}`] : []),
      ...(result.toChapter ? [`To chapter: ${result.toChapter}`] : []),
      ...(result.throughChapter ? [`Through chapter: ${result.throughChapter}`] : []),
      ...(result.notes.length > 0 ? ["Notes:", ...result.notes.map((note) => `- ${note}`)] : []),
      ...(result.sources.length > 0
        ? ["Sources:", ...result.sources.map((source, index) => `${index + 1}. [${source.type}] ${source.title} :: ${source.path} (${source.reason})`)]
        : []),
    ];

    return textResponse(lines.join("\n"));
  },
);

server.tool(
  "validate_book",
  "Validate Narrarium frontmatter and file placement rules inside the local book repository.",
  {
    rootPath: z.string().min(1),
  },
  async ({ rootPath }) => {
    const result = await validateBook(rootPath);

    if (result.valid) {
      return textResponse(`Validation passed. Checked ${result.checked} markdown files.`);
    }

    const errorLines = result.errors.map((error, index) => `${index + 1}. ${error.path}: ${error.message}`);
    return textResponse(
      `Validation failed. Checked ${result.checked} markdown files.\n${errorLines.join("\n")}`,
    );
  },
);

server.tool(
  "update_entity",
  "Update an existing entity file by patching frontmatter and optionally replacing or appending markdown body content. Use rename_entity when the slug, id, or asset folder must move.",
  {
    rootPath: z.string().min(1),
    kind: entityTypeSchema,
    slugOrId: z.string().min(1),
    frontmatterPatch: z.record(z.string(), z.unknown()).default({}),
    body: z.string().optional(),
    appendBody: z.string().optional(),
  },
  async ({ rootPath, kind, slugOrId, frontmatterPatch, body, appendBody }) => {
    const result = await updateEntity(rootPath, {
      kind,
      slugOrId,
      frontmatterPatch,
      body,
      appendBody,
    });

    return textResponse(await maybeAppendPlotSyncNote(rootPath, kind, `Updated ${kind} at ${result.filePath}.`));
  },
);

server.tool(
  "rename_entity",
  "Rename an entity in a safe way: update its slug and id, move its markdown file, and move any matching asset folder if present.",
  {
    rootPath: z.string().min(1),
    kind: entityTypeSchema,
    slugOrId: z.string().min(1),
    newNameOrTitle: z.string().min(1),
    newSlug: z.string().optional(),
  },
  async ({ rootPath, kind, slugOrId, newNameOrTitle, newSlug }) => {
    const result = await renameEntity(rootPath, {
      kind,
      slugOrId,
      newNameOrTitle,
      newSlug,
    });

    return textResponse(await maybeAppendPlotSyncNote(rootPath, kind, `Renamed ${kind} from ${result.oldPath} to ${result.newPath}. Updated ${result.updatedReferences} markdown files.${formatMovedAssetsNote(result.movedAssetPaths)}`));
  },
);

server.tool(
  "rename_chapter",
  "Rename a chapter title or number, move its folder, and move any matching chapter or paragraph asset folders if present.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    newTitle: z.string().min(1),
    newNumber: z.number().int().positive().optional(),
  },
  async ({ rootPath, chapter, newTitle, newNumber }) => {
    const result = await renameChapter(rootPath, {
      chapter,
      newTitle,
      newNumber,
    });

    return textResponse(await appendChapterPathMaintenanceNote(rootPath, result.newPath, `Renamed chapter from ${result.oldPath} to ${result.newPath}. Updated ${result.updatedReferences} markdown files.${formatMovedAssetsNote(result.movedAssetPaths)}`));
  },
);

server.tool(
  "rename_paragraph",
  "Rename a paragraph or scene title or number, move its markdown file, and move any matching paragraph asset folder if present.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    paragraph: z.string().min(1),
    newTitle: z.string().min(1),
    newNumber: z.number().int().positive().optional(),
  },
  async ({ rootPath, chapter, paragraph, newTitle, newNumber }) => {
    const result = await renameParagraph(rootPath, {
      chapter,
      paragraph,
      newTitle,
      newNumber,
    });

    return textResponse(await appendParagraphPathMaintenanceNote(rootPath, result.newPath, `Renamed paragraph from ${result.oldPath} to ${result.newPath}. Updated ${result.updatedReferences} markdown files.${formatMovedAssetsNote(result.movedAssetPaths)}`));
  },
);

server.tool(
  "list_related_canon",
  "List canon files that reference or mention a given id or query, useful before writing scenes or revising continuity.",
  {
    rootPath: z.string().min(1),
    idOrQuery: z.string().min(1),
    limit: z.number().int().positive().max(20).default(10),
  },
  async ({ rootPath, idOrQuery, limit }) => {
    const hits = await listRelatedCanon(rootPath, idOrQuery, { limit });

    if (hits.length === 0) {
      return textResponse(`No related canon files found for ${idOrQuery}.`);
    }

    return textResponse(
      hits
        .map((hit, index) => `${index + 1}. [${hit.type}] ${hit.title} :: ${hit.path} (${hit.reason})`)
        .join("\n"),
    );
  },
);

server.tool(
  "sync_resume",
  "Refresh a chapter resume or the total book resume from the current repository state without calling another model.",
  {
    rootPath: z.string().min(1),
    scope: z.enum(["chapter", "total"]),
    chapter: z.string().optional(),
  },
  async ({ rootPath, scope, chapter }) => {
    if (scope === "chapter") {
      if (!chapter) {
        throw new Error("chapter is required when scope is chapter.");
      }

      const result = await syncChapterResume(rootPath, chapter);
      return textResponse(`Synced chapter resume at ${result.filePath}.`);
    }

    const result = await syncTotalResume(rootPath);
    return textResponse(`Synced total resume at ${result.filePath} using ${result.chapterCount} chapters.`);
  },
);

server.tool(
  "sync_all_resumes",
  "Refresh every chapter resume and the total book resume in one pass.",
  {
    rootPath: z.string().min(1),
  },
  async ({ rootPath }) => {
    const result = await syncAllResumes(rootPath);
    return textResponse(
      `Synced ${result.chapterCount} chapter resumes and total resume at ${result.totalFilePath}.`,
    );
  },
);

server.tool(
  "sync_story_state",
  "Refresh state/current.md and per-chapter state snapshots from chapter resume state_changes. This stays manual by design and clears the stale story-state flag.",
  {
    rootPath: z.string().min(1),
  },
  async ({ rootPath }) => {
    const result = await syncStoryState(rootPath);
    return textResponse(
      `Synced story state at ${result.currentFilePath} and ${result.chapterFiles.length} chapter snapshot files. Status updated at ${result.statusFilePath}.`,
    );
  },
);

server.tool(
  "sync_plot",
  "Refresh the root plot.md file so it tracks chapter progression, revealed secrets, and timeline dates from current canon.",
  {
    rootPath: z.string().min(1),
  },
  async ({ rootPath }) => {
    const result = await syncPlot(rootPath);
    return textResponse(`Synced plot at ${result.filePath} using ${result.chapterCount} chapters.`);
  },
);

server.tool(
  "evaluate_chapter",
  "Refresh a full chapter evaluation by reading the whole chapter across all paragraph files, checking active style rules and custom chapter patterns, scoring quality, and writing next steps plus paragraph evaluation files.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
  },
  async ({ rootPath, chapter }) => {
    const result = await syncChapterEvaluation(rootPath, chapter);
    return textResponse(`Synced chapter evaluation at ${result.filePath} and refreshed paragraph evaluation files for that chapter.`);
  },
);

server.tool(
  "evaluate_paragraph",
  "Refresh the saved evaluation for a single paragraph while still using the full chapter as context, including scores, style checks, and concrete next steps.",
  {
    rootPath: z.string().min(1),
    chapter: z.string().min(1),
    paragraph: z.string().min(1),
  },
  async ({ rootPath, chapter, paragraph }) => {
    const result = await syncParagraphEvaluation(rootPath, chapter, paragraph);
    return textResponse(`Synced paragraph evaluation at ${result.filePath} using the whole chapter as context.`);
  },
);

server.tool(
  "evaluate_book",
  "Refresh the total book evaluation with chapter scorecards, style checks, and revision priorities, and optionally refresh all chapter and paragraph evaluations too.",
  {
    rootPath: z.string().min(1),
    syncChapterEvaluations: z.boolean().default(true),
  },
  async ({ rootPath, syncChapterEvaluations }) => {
    const result = await evaluateBook(rootPath, { syncChapterEvaluations });
    return textResponse(
      `Synced book evaluation at ${result.filePath} using ${result.chapterCount} chapters.${
        result.chapterEvaluationFiles.length > 0
          ? ` Also refreshed ${result.chapterEvaluationFiles.length} chapter evaluation files and ${result.paragraphEvaluationFiles.length} paragraph evaluation files.`
          : ""
      }`,
    );
  },
);

server.tool(
  "wikipedia_search",
  "Search English and the user's request language Wikipedia for historical or factual research before adding canon to the book repository.",
  {
    query: z.string().min(1),
    limit: z.number().int().positive().max(10).default(5),
    lang: z.string().min(2).default("en"),
  },
  async ({ query, limit, lang }) => {
    const secondaryLang = lang !== "en" ? lang : null;
    const langs = secondaryLang ? ["en", secondaryLang] : ["en"];
    const results = await Promise.allSettled(langs.map((l) => searchWikipedia(query, l, limit)));

    const seenTitles = new Set<string>();
    const merged: Array<{ title: string; snippet: string; url: string; lang: string }> = [];
    for (let i = 0; i < langs.length; i++) {
      const result = results[i];
      const entries = result.status === "fulfilled" ? result.value : [];
      for (const entry of entries) {
        if (!seenTitles.has(entry.title.toLowerCase())) {
          seenTitles.add(entry.title.toLowerCase());
          merged.push({ ...entry, lang: langs[i] });
        }
      }
    }

    if (merged.length === 0) {
      return textResponse(`No Wikipedia matches found for "${query}".`);
    }

    return textResponse(
      merged
        .map(
          (entry, index) =>
            `${index + 1}. [${entry.lang}] ${entry.title}\n   ${entry.snippet}\n   ${entry.url}`,
        )
        .join("\n"),
    );
  },
);

server.tool(
  "wikipedia_page",
  "Fetch English and the user's request language Wikipedia page summaries and save them into research/wikipedia inside the local book repository.",
  {
    title: z.string().min(1),
    rootPath: z.string().optional(),
    saveToResearch: z.boolean().default(true),
    slug: z.string().optional(),
    lang: z.string().min(2).default("en"),
    ...wikipediaRefreshToolFields,
  },
  async ({ title, lang, rootPath, saveToResearch, slug, forceWikipediaRefresh, maxWikipediaSnapshotAgeDays }) => {
    if (rootPath) {
      const existing = await findWikipediaResearchSnapshot(rootPath, { title, slug });
      if (existing && shouldReuseWikipediaSnapshot(existing, { forceWikipediaRefresh, maxWikipediaSnapshotAgeDays })) {
        return textResponse(
          `${existing.title}\n\nReused saved research snapshot from ${existing.relativePath}.\n\n${existing.body}\n\n${existing.sourceUrl}`,
        );
      }
    }

    const secondaryLang = lang !== "en" ? lang : null;
    const effectiveLang = lang;

    const [enResult, secondaryResult] = await Promise.allSettled([
      fetchWikipediaPage(title, "en"),
      secondaryLang
        ? fetchWikipediaPage(title, secondaryLang)
        : Promise.reject(new Error("no secondary lang")),
    ]);
    const enPage = enResult.status === "fulfilled" ? enResult.value : null;
    const secondaryPage = secondaryLang && secondaryResult.status === "fulfilled" ? secondaryResult.value : null;

    if (!enPage && !secondaryPage) {
      throw new Error(`Wikipedia page not found for "${title}".`);
    }

    const primary = enPage ?? secondaryPage!;
    const secondary = enPage && secondaryPage ? secondaryPage : null;

    // Fetch Wikidata structured data
    const wikidataId = enPage?.wikidataId;
    const wikidataClaims = wikidataId
      ? await fetchWikidataEntity(wikidataId, effectiveLang).catch(() => null)
      : null;

    let researchPath = "";

    if (saveToResearch) {
      if (!rootPath) {
        throw new Error("rootPath is required when saveToResearch is true.");
      }

      researchPath = await writeWikipediaResearchSnapshot(rootPath, {
        title: primary.title,
        pageUrl: primary.url,
        slug,
        summary: primary.extract,
        body: primary.description ? `Description: ${primary.description}` : undefined,
        secondarySummary: secondary?.extract,
        secondaryPageUrl: secondary?.url,
        secondaryLang: secondaryLang ?? undefined,
        wikidataSection: wikidataClaims ? formatWikidataSection(wikidataClaims) : undefined,
      });
    }

    const lines = [`${primary.title}\n${primary.description ?? ""}\n\n${primary.extract}\n\n${primary.url}`];
    if (secondary) {
      lines.push(`\n[${secondaryLang!.toUpperCase()}] ${secondary.title}\n${secondary.description ?? ""}\n\n${secondary.extract}\n\n${secondary.url}`);
    }
    if (wikidataClaims) {
      lines.push(`\n[Wikidata ${wikidataClaims.qid}] ${formatWikidataSection(wikidataClaims)}`);
    }
    if (researchPath) {
      lines.push(`\nSaved to ${researchPath}`);
    }

    return textResponse(lines.join(""));
  },
);

server.tool(
  "export_epub",
  "Export the current book repository into an EPUB file from the ordered chapter and paragraph markdown files.",
  {
    rootPath: z.string().min(1),
    outputPath: z.string().optional(),
    title: z.string().optional(),
    author: z.string().optional(),
    language: z.string().optional(),
  },
  async ({ rootPath, outputPath, title, author, language }) => {
    const result = await exportEpub(rootPath, {
      outputPath,
      title,
      author,
      language,
    });

    return textResponse(
      `Exported EPUB with ${result.chapterCount} chapters to ${result.outputPath}.`,
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

function textResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

async function appendPlotSyncNote(rootPath: string, baseText: string): Promise<string> {
  const result = await syncPlot(rootPath);
  return `${baseText} Plot synced at ${result.filePath}.`;
}

async function appendStoryMaintenanceNote(rootPath: string, chapter: string, baseText: string): Promise<string> {
  const [plot, chapterResume, totalResume] = await Promise.all([
    syncPlot(rootPath),
    syncChapterResume(rootPath, chapter),
    syncTotalResume(rootPath),
  ]);
  const storyStateStatus = await readStoryStateStatus(rootPath);

  return [
    baseText,
    `Plot synced at ${plot.filePath}.`,
    `Chapter resume synced at ${chapterResume.filePath}.`,
    `Total resume synced at ${totalResume.filePath}.`,
    formatStoryStateReminder(storyStateStatus),
  ]
    .filter(Boolean)
    .join(" ");
}

async function appendChapterPathMaintenanceNote(rootPath: string, chapterFilePath: string, baseText: string): Promise<string> {
  const chapterSlug = path.basename(path.dirname(chapterFilePath));
  return appendStoryMaintenanceNote(rootPath, chapterSlug, baseText);
}

async function appendParagraphPathMaintenanceNote(rootPath: string, paragraphFilePath: string, baseText: string): Promise<string> {
  const chapterSlug = path.basename(path.dirname(paragraphFilePath));
  return appendStoryMaintenanceNote(rootPath, chapterSlug, baseText);
}

async function maybeAppendPlotSyncNote(rootPath: string, kind: z.infer<typeof entityTypeSchema>, baseText: string): Promise<string> {
  if (kind !== "secret" && kind !== "timeline-event") {
    return baseText;
  }

  return appendPlotSyncNote(rootPath, baseText);
}

function formatStoryStateReminder(status: Awaited<ReturnType<typeof readStoryStateStatus>>): string {
  if (!status.dirty) {
    return "";
  }

  return `Story state marked stale at ${status.filePath}. Run sync_story_state manually when you want refreshed state/current.md and state/chapters/.`;
}

function extractPromptSection(body: string): string {
  const match = body.match(/^# Prompt\s*\n([\s\S]*)$/m);
  if (!match) {
    return "";
  }

  const afterHeading = match[1];
  const nextHeadingIndex = afterHeading.search(/^#\s/m);
  return (nextHeadingIndex === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIndex)).trim();
}

function buildAssetPromptBody(subject: string, prompt: string): string {
  return [
    "# Intent",
    "",
    `Generated asset prompt for ${subject}.`,
    "",
    "# Prompt",
    "",
    prompt,
    "",
    "# Notes",
    "",
    "Keep this image visually aligned with guidelines/images.md and existing recurring canon art.",
  ].join("\n");
}

async function generateImageBuffer(options: {
  prompt: string;
  provider: z.infer<typeof imageProviderSchema>;
  model: string;
  orientation: z.infer<typeof imageOrientationSchema>;
  aspectRatio: string;
}): Promise<Buffer> {
  switch (options.provider) {
    case "openai":
      return generateOpenAiImage(options);
    default:
      throw new Error(`Unsupported image provider: ${options.provider}`);
  }
}

async function generateOpenAiImage(options: {
  prompt: string;
  model: string;
  orientation: z.infer<typeof imageOrientationSchema>;
  aspectRatio: string;
}): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required to generate images with the OpenAI provider.");
  }

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      prompt: options.prompt,
      size: resolveOpenAiImageSize(options.orientation, options.aspectRatio),
    }),
  });

  const json = (await response.json()) as {
    error?: { message?: string };
    data?: Array<{ b64_json?: string }>;
  };

  if (!response.ok) {
    throw new Error(json.error?.message ?? `OpenAI image generation failed with status ${response.status}.`);
  }

  const base64 = json.data?.[0]?.b64_json;
  if (!base64) {
    throw new Error("OpenAI image generation returned no image payload.");
  }

  return Buffer.from(base64, "base64");
}

function resolveOpenAiImageSize(
  orientation: z.infer<typeof imageOrientationSchema>,
  aspectRatio: string,
): "1024x1536" | "1536x1024" | "1024x1024" {
  if (aspectRatio === "1:1" || orientation === "square") {
    return "1024x1024";
  }

  if (orientation === "landscape") {
    return "1536x1024";
  }

  return "1024x1536";
}

function formatMovedAssetsNote(movedAssetPaths: string[]): string {
  if (movedAssetPaths.length === 0) {
    return "";
  }

  return ` Moved asset path ${movedAssetPaths[0]} -> ${movedAssetPaths[1]}.`;
}

function wizardChecklist(options: {
  title: string;
  requiredHeading: string;
  required: string[];
  optionalHeading: string;
  optional: string[];
}): string {
  return [
    options.title,
    "",
    options.requiredHeading,
    ...options.required.map((entry, index) => `${index + 1}. ${entry}`),
    "",
    options.optionalHeading,
    ...options.optional.map((entry) => `- ${entry}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Wikidata helpers
// ---------------------------------------------------------------------------

function formatWikidataSection(claims: NormalizedWikidataClaims): string {
  const lines: string[] = [];
  lines.push(`- **QID**: ${claims.qid}`);
  if (claims.label) lines.push(`- **Label**: ${claims.label}`);
  if (claims.description) lines.push(`- **Description**: ${claims.description}`);
  if (claims.born) lines.push(`- **Born**: ${claims.born}`);
  if (claims.died) lines.push(`- **Died**: ${claims.died}`);
  if (claims.founded) lines.push(`- **Founded**: ${claims.founded}`);
  if (claims.dissolved) lines.push(`- **Dissolved**: ${claims.dissolved}`);
  if (claims.gender) lines.push(`- **Gender**: ${claims.gender}`);
  if (claims.nationality) lines.push(`- **Nationality**: ${claims.nationality}`);
  if (claims.occupation?.length) lines.push(`- **Occupation**: ${claims.occupation.join(", ")}`);
  if (claims.country) lines.push(`- **Country**: ${claims.country}`);
  if (claims.creator) lines.push(`- **Creator**: ${claims.creator}`);
  if (claims.coordinates) {
    lines.push(`- **Coordinates**: ${claims.coordinates.lat}, ${claims.coordinates.lng}`);
  }
  return lines.join("\n");
}

function mapWikidataToCharacter(claims: NormalizedWikidataClaims): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (claims.born) fields.born = claims.born;
  if (claims.died) fields.died = claims.died;
  if (claims.gender) fields.gender = claims.gender;
  if (claims.nationality) fields.nationality = claims.nationality;
  if (claims.occupation?.length) fields.wikidata_occupation = claims.occupation[0];
  return fields;
}

function mapWikidataToLocation(claims: NormalizedWikidataClaims): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (claims.coordinates) fields.coordinates = claims.coordinates;
  if (claims.country) fields.country = claims.country;
  return fields;
}

function mapWikidataToFaction(claims: NormalizedWikidataClaims): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (claims.founded) fields.founded = claims.founded;
  if (claims.dissolved) fields.dissolved = claims.dissolved;
  if (claims.country) fields.country = claims.country;
  return fields;
}

function mapWikidataToItem(claims: NormalizedWikidataClaims): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (claims.creator) fields.creator = claims.creator;
  if (claims.founded) fields.created = claims.founded;
  return fields;
}

async function collectHistoricalResearchSupport(options: {
  historical: boolean;
  wikipediaTitle?: string;
  lang?: string;
  rootPath: string;
  slug?: string;
  forceWikipediaRefresh?: boolean;
  maxWikipediaSnapshotAgeDays?: number;
}): Promise<{ sources: string[]; note: string; wikidataClaims?: NormalizedWikidataClaims }> {
  if (!options.historical || !options.wikipediaTitle) {
    return { sources: [], note: "" };
  }

  const existing = await findWikipediaResearchSnapshot(options.rootPath, {
    title: options.wikipediaTitle,
    slug: options.slug,
  });
  if (existing && shouldReuseWikipediaSnapshot(existing, options)) {
    return {
      sources: [existing.sourceUrl],
      note: ` Reused existing research snapshot at ${existing.relativePath}.`,
    };
  }

  const secondaryLang = options.lang && options.lang !== "en" ? options.lang : null;
  const effectiveLang = options.lang ?? "en";

  const [enResult, secondaryResult] = await Promise.allSettled([
    fetchWikipediaPage(options.wikipediaTitle, "en"),
    secondaryLang
      ? fetchWikipediaPage(options.wikipediaTitle, secondaryLang)
      : Promise.reject(new Error("no secondary lang")),
  ]);
  const enPage = enResult.status === "fulfilled" ? enResult.value : null;
  const secondaryPage = secondaryLang && secondaryResult.status === "fulfilled" ? secondaryResult.value : null;

  if (!enPage && !secondaryPage) {
    throw new Error(`Wikipedia page not found for "${options.wikipediaTitle}".`);
  }

  const primary = enPage ?? secondaryPage!;
  const secondary = enPage && secondaryPage ? secondaryPage : null;

  // Fetch Wikidata in parallel with snapshot write
  const wikidataId = enPage?.wikidataId;
  const wikidataClaimsResult = wikidataId
    ? await fetchWikidataEntity(wikidataId, effectiveLang).catch(() => null)
    : null;
  const wikidataClaims = wikidataClaimsResult ?? undefined;

  const researchPath = await writeWikipediaResearchSnapshot(options.rootPath, {
    title: primary.title,
    pageUrl: primary.url,
    slug: options.slug,
    summary: primary.extract,
    body: primary.description ? `Description: ${primary.description}` : undefined,
    secondarySummary: secondary?.extract,
    secondaryPageUrl: secondary?.url,
    secondaryLang: secondaryLang ?? undefined,
    wikidataSection: wikidataClaims ? formatWikidataSection(wikidataClaims) : undefined,
  });

  return {
    sources: [primary.url, ...(secondary ? [secondary.url] : [])],
    note: ` Saved research snapshot to ${researchPath}.`,
    wikidataClaims,
  };
}

function shouldReuseWikipediaSnapshot(
  snapshot: { retrievedAt: string },
  options: { forceWikipediaRefresh?: boolean; maxWikipediaSnapshotAgeDays?: number },
): boolean {
  if (options.forceWikipediaRefresh) {
    return false;
  }

  if (!options.maxWikipediaSnapshotAgeDays) {
    return true;
  }

  const retrievedAt = Date.parse(snapshot.retrievedAt);
  if (Number.isNaN(retrievedAt)) {
    return false;
  }

  const maxAgeMs = options.maxWikipediaSnapshotAgeDays * 24 * 60 * 60 * 1000;
  return Date.now() - retrievedAt <= maxAgeMs;
}

function createWizardSession(kind: WizardKind, rootPath: string, seed: Record<string, unknown>): WizardSession {
  const id = createWizardSessionId();
  const session: WizardSession = {
    id,
    kind,
    rootPath,
    steps: wizardDefinitions[kind],
    stepIndex: 0,
    data: { ...seed },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const next = getNextWizardStep(session);
  session.stepIndex = next.index;
  wizardSessions.set(id, session);
  return session;
}

function applyWizardAnswer(session: WizardSession, answer: unknown, skip: boolean): void {
  const next = getNextWizardStep(session);
  if (!next.step) {
    throw new Error(`Wizard session ${session.id} is already ready to finalize.`);
  }

  if (skip) {
    if (next.step.required) {
      throw new Error(`Cannot skip required field ${next.step.key}.`);
    }
    session.data[next.step.key] = null;
  } else {
    session.data[next.step.key] = parseWizardAnswer(next.step, answer);
  }

  session.updatedAt = new Date().toISOString();
  session.stepIndex = getNextWizardStep(session, next.index + 1).index;
}

function renderWizardResponse(session: WizardSession, state: "started" | "updated" | "status"): string {
  const next = getNextWizardStep(session);
  const completed = countAnsweredWizardSteps(session);
  const total = session.steps.filter((step) => step.condition?.(session.data) !== false).length;
  const lines = [
    `Wizard ${state}: ${session.kind}`,
    `Session: ${session.id}`,
    `Progress: ${completed}/${total}`,
    "",
  ];

  if (next.step) {
    lines.push(`Next field: ${next.step.key}`);
    lines.push(next.step.prompt);
    lines.push("");
  } else {
    lines.push("Wizard is complete and ready to finalize.");
    lines.push("Call wizard_finalize to create the file or folder.");
    lines.push("");
  }

  lines.push("Collected data:");
  lines.push(...formatWizardDataLines(session.data));
  return lines.join("\n");
}

async function finalizeWizardSession(
  session: WizardSession,
  options: {
    slug?: string;
    overwrite: boolean;
    frontmatter: Record<string, unknown>;
    body?: string;
    lang?: string;
    forceWikipediaRefresh?: boolean;
    maxWikipediaSnapshotAgeDays?: number;
  },
): Promise<string> {
  const pending = getNextWizardStep(session);
  if (pending.step) {
    throw new Error(`Wizard session ${session.id} is not complete. Next required field: ${pending.step.key}`);
  }

  const data = sanitizeWizardData(session.data);
  const historical = Boolean(data.historical);
  const wikipediaTitle = stringOrUndefined(data.wikipediaTitle);
  const research = await collectHistoricalResearchSupport({
    historical,
    wikipediaTitle,
    lang: options.lang,
    rootPath: session.rootPath,
    slug: options.slug,
    forceWikipediaRefresh: options.forceWikipediaRefresh,
    maxWikipediaSnapshotAgeDays: options.maxWikipediaSnapshotAgeDays,
  });

  switch (session.kind) {
    case "character": {
      const wikidataFields = research.wikidataClaims ? mapWikidataToCharacter(research.wikidataClaims) : {};
      const result = await createCharacterProfile(session.rootPath, {
        slug: options.slug,
        overwrite: options.overwrite,
        name: requireString(data.name, "name"),
        roleTier: requireCharacterRoleTier(data.roleTier),
        storyRole: stringOrUndefined(data.storyRole) as never,
        speakingStyle: requireString(data.speakingStyle, "speakingStyle"),
        backgroundSummary: requireString(data.backgroundSummary, "backgroundSummary"),
        functionInBook: requireString(data.functionInBook, "functionInBook"),
        age: numberOrUndefined(data.age),
        occupation: stringOrUndefined(data.occupation),
        origin: stringOrUndefined(data.origin),
        firstImpression: stringOrUndefined(data.firstImpression),
        currentIdentity: stringOrUndefined(data.currentIdentity),
        formerNames: stringArrayOrEmpty(data.formerNames),
        identityShifts: stringArrayOrEmpty(data.identityShifts),
        identityArc: stringOrUndefined(data.identityArc),
        arc: stringOrUndefined(data.arc),
        internalConflict: stringOrUndefined(data.internalConflict),
        externalConflict: stringOrUndefined(data.externalConflict),
        traits: stringArrayOrEmpty(data.traits),
        mannerisms: stringArrayOrEmpty(data.mannerisms),
        desires: stringArrayOrEmpty(data.desires),
        fears: stringArrayOrEmpty(data.fears),
        relationships: stringArrayOrEmpty(data.relationships),
        factions: stringArrayOrEmpty(data.factions),
        homeLocation: stringOrUndefined(data.homeLocation),
        introducedIn: stringOrUndefined(data.introducedIn),
        ...pronunciationInputFromData(data),
        ...hiddenCanonInputFromData(data),
        historical,
        sources: research.sources,
        body: options.body,
        frontmatter: { ...wikidataFields, ...options.frontmatter },
      });
      return appendPlotSyncNote(session.rootPath, `Created ${session.kind} at ${result.filePath}.${research.note}`);
    }
    case "location": {
      const wikidataFields = research.wikidataClaims ? mapWikidataToLocation(research.wikidataClaims) : {};
      const result = await createLocationProfile(session.rootPath, {
        slug: options.slug,
        overwrite: options.overwrite,
        name: requireString(data.name, "name"),
        locationKind: stringOrUndefined(data.locationKind),
        region: stringOrUndefined(data.region),
        atmosphere: requireString(data.atmosphere, "atmosphere"),
        functionInBook: requireString(data.functionInBook, "functionInBook"),
        landmarks: stringArrayOrEmpty(data.landmarks),
        risks: stringArrayOrEmpty(data.risks),
        factionsPresent: stringArrayOrEmpty(data.factionsPresent),
        basedOnRealPlace: Boolean(data.basedOnRealPlace),
        timelineRef: stringOrUndefined(data.timelineRef),
        ...pronunciationInputFromData(data),
        ...hiddenCanonInputFromData(data),
        historical,
        sources: research.sources,
        body: options.body,
        frontmatter: { ...wikidataFields, ...options.frontmatter },
      });
      return appendPlotSyncNote(session.rootPath, `Created ${session.kind} at ${result.filePath}.${research.note}`);
    }
    case "faction": {
      const wikidataFields = research.wikidataClaims ? mapWikidataToFaction(research.wikidataClaims) : {};
      const result = await createFactionProfile(session.rootPath, {
        slug: options.slug,
        overwrite: options.overwrite,
        name: requireString(data.name, "name"),
        factionKind: stringOrUndefined(data.factionKind),
        mission: requireString(data.mission, "mission"),
        ideology: requireString(data.ideology, "ideology"),
        functionInBook: requireString(data.functionInBook, "functionInBook"),
        publicImage: stringOrUndefined(data.publicImage),
        hiddenAgenda: stringOrUndefined(data.hiddenAgenda),
        leaders: stringArrayOrEmpty(data.leaders),
        allies: stringArrayOrEmpty(data.allies),
        enemies: stringArrayOrEmpty(data.enemies),
        methods: stringArrayOrEmpty(data.methods),
        baseLocation: stringOrUndefined(data.baseLocation),
        ...pronunciationInputFromData(data),
        ...hiddenCanonInputFromData(data),
        historical,
        sources: research.sources,
        body: options.body,
        frontmatter: { ...wikidataFields, ...options.frontmatter },
      });
      return `Created ${session.kind} at ${result.filePath}.${research.note}`;
    }
    case "item": {
      const wikidataFields = research.wikidataClaims ? mapWikidataToItem(research.wikidataClaims) : {};
      const result = await createItemProfile(session.rootPath, {
        slug: options.slug,
        overwrite: options.overwrite,
        name: requireString(data.name, "name"),
        itemKind: stringOrUndefined(data.itemKind),
        appearance: requireString(data.appearance, "appearance"),
        purpose: requireString(data.purpose, "purpose"),
        functionInBook: requireString(data.functionInBook, "functionInBook"),
        significance: stringOrUndefined(data.significance),
        originStory: stringOrUndefined(data.originStory),
        powers: stringArrayOrEmpty(data.powers),
        limitations: stringArrayOrEmpty(data.limitations),
        owner: stringOrUndefined(data.owner),
        introducedIn: stringOrUndefined(data.introducedIn),
        ...pronunciationInputFromData(data),
        ...hiddenCanonInputFromData(data),
        historical,
        sources: research.sources,
        body: options.body,
        frontmatter: { ...wikidataFields, ...options.frontmatter },
      });
      return `Created ${session.kind} at ${result.filePath}.${research.note}`;
    }
    case "secret": {
      const result = await createSecretProfile(session.rootPath, {
        slug: options.slug,
        overwrite: options.overwrite,
        title: requireString(data.title, "title"),
        secretKind: stringOrUndefined(data.secretKind),
        functionInBook: requireString(data.functionInBook, "functionInBook"),
        stakes: requireString(data.stakes, "stakes"),
        protectedBy: stringArrayOrEmpty(data.protectedBy),
        falseBeliefs: stringArrayOrEmpty(data.falseBeliefs),
        revealStrategy: stringOrUndefined(data.revealStrategy),
        holders: stringArrayOrEmpty(data.holders),
        ...pronunciationInputFromData(data),
        ...hiddenCanonInputFromData(data),
        timelineRef: stringOrUndefined(data.timelineRef),
        historical,
        sources: research.sources,
        body: options.body,
        frontmatter: options.frontmatter,
      });
      return `Created ${session.kind} at ${result.filePath}.${research.note}`;
    }
    case "timeline-event": {
      const result = await createTimelineEventProfile(session.rootPath, {
        slug: options.slug,
        overwrite: options.overwrite,
        title: requireString(data.title, "title"),
        date: stringOrUndefined(data.date),
        participants: stringArrayOrEmpty(data.participants),
        significance: stringOrUndefined(data.significance),
        functionInBook: stringOrUndefined(data.functionInBook),
        consequences: stringArrayOrEmpty(data.consequences),
        ...pronunciationInputFromData(data),
        ...hiddenCanonInputFromData(data),
        historical,
        sources: research.sources,
        body: options.body,
        frontmatter: options.frontmatter,
      });
      return `Created ${session.kind} at ${result.filePath}.${research.note}`;
    }
    case "chapter": {
      const result = await createChapter(session.rootPath, {
        number: requireNumber(data.number, "number"),
        title: requireString(data.title, "title"),
        body: options.body ?? stringOrUndefined(data.body),
        overwrite: options.overwrite,
        frontmatter: {
          summary: stringOrUndefined(data.summary),
          pov: stringArrayOrEmpty(data.pov),
          style_refs: stringArrayOrEmpty(data.styleRefs),
          narration_person: stringOrUndefined(data.narrationPerson),
          narration_tense: stringOrUndefined(data.narrationTense),
          prose_mode: stringArrayOrEmpty(data.proseMode),
          timeline_ref: stringOrUndefined(data.timelineRef),
          tags: stringArrayOrEmpty(data.tags),
          ...options.frontmatter,
        },
      });
      return appendChapterPathMaintenanceNote(session.rootPath, result.chapterFilePath, `Created ${session.kind} at ${result.chapterFilePath}.`);
    }
    case "paragraph": {
      const result = await createParagraph(session.rootPath, {
        chapter: requireString(data.chapter, "chapter"),
        number: requireNumber(data.number, "number"),
        title: requireString(data.title, "title"),
        body: options.body ?? stringOrUndefined(data.body),
        overwrite: options.overwrite,
        frontmatter: {
          summary: stringOrUndefined(data.summary),
          viewpoint: stringOrUndefined(data.viewpoint),
          tags: stringArrayOrEmpty(data.tags),
          ...options.frontmatter,
        },
      });
      return appendParagraphPathMaintenanceNote(session.rootPath, result.filePath, `Created ${session.kind} at ${result.filePath}.`);
    }
    default:
      throw new Error(`Unsupported wizard kind: ${session.kind}`);
  }
}

function getNextWizardStep(session: WizardSession, startIndex = session.stepIndex): { step: WizardStep | null; index: number } {
  for (let index = startIndex; index < session.steps.length; index += 1) {
    const step = session.steps[index];
    if (step.condition && !step.condition(session.data)) continue;
    if (hasWizardKey(session.data, step.key)) continue;
    return { step, index };
  }

  return { step: null, index: session.steps.length };
}

function countAnsweredWizardSteps(session: WizardSession): number {
  return session.steps.filter((step) => step.condition?.(session.data) !== false && hasWizardKey(session.data, step.key)).length;
}

function hasWizardKey(data: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, key);
}

function parseWizardAnswer(step: WizardStep, answer: unknown): unknown {
  if (answer === undefined || answer === null) {
    if (step.required) {
      throw new Error(`Field ${step.key} requires an answer.`);
    }
    return null;
  }

  switch (step.type) {
    case "string": {
      const value = typeof answer === "string" ? answer.trim() : String(answer).trim();
      if (!value && step.required) {
        throw new Error(`Field ${step.key} requires a non-empty answer.`);
      }
      return value || null;
    }
    case "int": {
      const value = typeof answer === "number" ? answer : Number(String(answer).trim());
      if (!Number.isInteger(value)) {
        throw new Error(`Field ${step.key} requires an integer answer.`);
      }
      return value;
    }
    case "bool": {
      if (typeof answer === "boolean") return answer;
      const normalized = String(answer).trim().toLowerCase();
      if (["y", "yes", "true", "1"].includes(normalized)) return true;
      if (["n", "no", "false", "0"].includes(normalized)) return false;
      throw new Error(`Field ${step.key} requires yes/no or true/false.`);
    }
    case "stringArray": {
      if (Array.isArray(answer)) {
        return answer.map((value) => String(value).trim()).filter(Boolean);
      }
      const normalized = String(answer)
        .split(/\r?\n|,|;/)
        .map((value) => value.trim())
        .filter(Boolean);
      return normalized;
    }
    default:
      return answer;
  }
}

function sanitizeWizardData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }),
  );
}

function formatWizardDataLines(data: Record<string, unknown>): string[] {
  const sanitized = sanitizeWizardData(data);
  const entries = Object.entries(sanitized);
  if (entries.length === 0) return ["- No answers collected yet."];
  return entries.map(([key, value]) => `- ${key}: ${formatWizardValue(value)}`);
}

function formatWizardValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function requireString(value: unknown, key: string): string {
  const parsed = stringOrUndefined(value);
  if (!parsed) {
    throw new Error(`Wizard field ${key} is required.`);
  }
  return parsed;
}

function requireNumber(value: unknown, key: string): number {
  const parsed = numberOrUndefined(value);
  if (parsed === undefined) {
    throw new Error(`Wizard field ${key} is required.`);
  }
  return parsed;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hiddenCanonInputFromData(data: Record<string, unknown>) {
  return {
    secretRefs: stringArrayOrEmpty(data.secretRefs),
    privateNotes: stringOrUndefined(data.privateNotes),
    revealIn: stringOrUndefined(data.revealIn),
    knownFrom: stringOrUndefined(data.knownFrom),
  };
}

function pronunciationInputFromData(data: Record<string, unknown>) {
  return {
    pronunciation: stringOrUndefined(data.pronunciation),
    spokenName: stringOrUndefined(data.spokenName),
    ttsLabel: stringOrUndefined(data.ttsLabel),
  };
}

function stringArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function requireCharacterRoleTier(value: unknown) {
  return characterRoleTierSchema.parse(requireString(value, "roleTier"));
}

function createWizardSessionId(): string {
  return `wiz_${Math.random().toString(36).slice(2, 10)}`;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
