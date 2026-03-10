import { z } from "zod";
import { ENTITY_TYPES } from "./constants.js";

const canonSchema = z.enum(["draft", "canon", "deprecated"]);
const imageOrientationSchema = z.enum(["portrait", "landscape", "square"]);

const yamlDateStringSchema = z.union([z.string(), z.date()]).transform((value) =>
  typeof value === "string" ? value : value.toISOString(),
);

const hiddenCanonFields = {
  secret_refs: z.array(z.string()).default([]),
  private_notes: z.string().optional(),
  reveal_in: z.string().optional(),
  known_from: z.string().optional(),
};

export const characterRoleTierSchema = z.enum([
  "main",
  "supporting",
  "secondary",
  "minor",
  "background",
]);

export const characterStoryRoleSchema = z.enum([
  "protagonist",
  "deuteragonist",
  "antagonist",
  "mentor",
  "ally",
  "love-interest",
  "foil",
  "comic-relief",
  "other",
]);

const baseSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    status: z.string().optional(),
    canon: canonSchema.default("draft"),
    tags: z.array(z.string()).default([]),
    refs: z.array(z.string()).default([]),
    sources: z.array(z.string()).default([]),
    historical: z.boolean().default(false),
  })
  .passthrough();

export const bookSchema = z
  .object({
    type: z.literal("book"),
    id: z.literal("book"),
    title: z.string().min(1),
    author: z.string().optional(),
    language: z.string().default("en"),
    genre: z.string().optional(),
    audience: z.string().optional(),
    canon: canonSchema.default("draft"),
  })
  .passthrough();

export const plotSchema = z
  .object({
    type: z.literal("plot"),
    id: z.literal("plot:main"),
    title: z.string().min(1),
  })
  .passthrough();

export const guidelineSchema = z
  .object({
    type: z.literal("guideline"),
    id: z.string().min(1),
    title: z.string().min(1),
    scope: z.string().default("global"),
  })
  .passthrough();

export const characterSchema = baseSchema
  .extend({
    type: z.literal("character"),
    ...hiddenCanonFields,
    name: z.string().min(1),
    aliases: z.array(z.string()).default([]),
    former_names: z.array(z.string()).default([]),
    current_identity: z.string().optional(),
    identity_shifts: z.array(z.string()).default([]),
    identity_arc: z.string().optional(),
    role_tier: characterRoleTierSchema.default("supporting"),
    story_role: characterStoryRoleSchema.default("other"),
    speaking_style: z.string().optional(),
    background_summary: z.string().optional(),
    function_in_book: z.string().optional(),
    age: z.number().int().nonnegative().optional(),
    occupation: z.string().optional(),
    origin: z.string().optional(),
    first_impression: z.string().optional(),
    arc: z.string().optional(),
    internal_conflict: z.string().optional(),
    external_conflict: z.string().optional(),
    traits: z.array(z.string()).default([]),
    mannerisms: z.array(z.string()).default([]),
    desires: z.array(z.string()).default([]),
    fears: z.array(z.string()).default([]),
    relationships: z.array(z.string()).default([]),
    factions: z.array(z.string()).default([]),
    home_location: z.string().optional(),
    introduced_in: z.string().optional(),
    timeline_ages: z.record(z.string(), z.number().int().nonnegative()).default({}),
  })
  .passthrough();

export const itemSchema = baseSchema
  .extend({
    type: z.literal("item"),
    ...hiddenCanonFields,
    name: z.string().min(1),
    item_kind: z.string().optional(),
    appearance: z.string().optional(),
    purpose: z.string().optional(),
    function_in_book: z.string().optional(),
    significance: z.string().optional(),
    origin_story: z.string().optional(),
    powers: z.array(z.string()).default([]),
    limitations: z.array(z.string()).default([]),
    owner: z.string().optional(),
    introduced_in: z.string().optional(),
  })
  .passthrough();

export const locationSchema = baseSchema
  .extend({
    type: z.literal("location"),
    ...hiddenCanonFields,
    name: z.string().min(1),
    location_kind: z.string().optional(),
    region: z.string().optional(),
    atmosphere: z.string().optional(),
    function_in_book: z.string().optional(),
    landmarks: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    factions_present: z.array(z.string()).default([]),
    based_on_real_place: z.boolean().default(false),
    timeline_ref: z.string().optional(),
  })
  .passthrough();

export const factionSchema = baseSchema
  .extend({
    type: z.literal("faction"),
    ...hiddenCanonFields,
    name: z.string().min(1),
    faction_kind: z.string().optional(),
    mission: z.string().optional(),
    ideology: z.string().optional(),
    function_in_book: z.string().optional(),
    public_image: z.string().optional(),
    hidden_agenda: z.string().optional(),
    leaders: z.array(z.string()).default([]),
    allies: z.array(z.string()).default([]),
    enemies: z.array(z.string()).default([]),
    methods: z.array(z.string()).default([]),
    base_location: z.string().optional(),
  })
  .passthrough();

export const secretSchema = baseSchema
  .extend({
    type: z.literal("secret"),
    ...hiddenCanonFields,
    title: z.string().min(1),
    secret_kind: z.string().optional(),
    function_in_book: z.string().optional(),
    stakes: z.string().optional(),
    protected_by: z.array(z.string()).default([]),
    false_beliefs: z.array(z.string()).default([]),
    reveal_strategy: z.string().optional(),
    holders: z.array(z.string()).default([]),
    timeline_ref: z.string().optional(),
  })
  .passthrough();

export const timelineEventSchema = baseSchema
  .extend({
    type: z.literal("timeline-event"),
    ...hiddenCanonFields,
    title: z.string().min(1),
    date: yamlDateStringSchema.optional(),
    participants: z.array(z.string()).default([]),
    significance: z.string().optional(),
    function_in_book: z.string().optional(),
    consequences: z.array(z.string()).default([]),
  })
  .passthrough();

export const assetSchema = baseSchema
  .extend({
    type: z.literal("asset"),
    subject: z.string().min(1),
    asset_kind: z.string().min(1).default("primary"),
    path: z.string().min(1),
    alt_text: z.string().optional(),
    caption: z.string().optional(),
    prompt_style_ref: z.string().optional(),
    orientation: imageOrientationSchema.default("portrait"),
    aspect_ratio: z.string().min(1).default("2:3"),
    provider: z.string().optional(),
    model: z.string().optional(),
  })
  .passthrough();

export const chapterSchema = z
  .object({
    type: z.literal("chapter"),
    id: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
    summary: z.string().optional(),
    pov: z.array(z.string()).default([]),
    timeline_ref: z.string().optional(),
    status: z.string().optional(),
    canon: canonSchema.default("draft"),
    tags: z.array(z.string()).default([]),
  })
  .passthrough();

export const chapterDraftSchema = z
  .object({
    type: z.literal("chapter-draft"),
    id: z.string().min(1),
    chapter: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
    summary: z.string().optional(),
    pov: z.array(z.string()).default([]),
    timeline_ref: z.string().optional(),
    status: z.string().optional(),
    canon: canonSchema.default("draft"),
    tags: z.array(z.string()).default([]),
  })
  .passthrough();

export const paragraphSchema = z
  .object({
    type: z.literal("paragraph"),
    id: z.string().min(1),
    chapter: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
    summary: z.string().optional(),
    viewpoint: z.string().optional(),
    tags: z.array(z.string()).default([]),
    canon: canonSchema.default("draft"),
  })
  .passthrough();

export const paragraphDraftSchema = z
  .object({
    type: z.literal("paragraph-draft"),
    id: z.string().min(1),
    paragraph: z.string().min(1),
    chapter: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
    summary: z.string().optional(),
    viewpoint: z.string().optional(),
    tags: z.array(z.string()).default([]),
    canon: canonSchema.default("draft"),
  })
  .passthrough();

export const researchNoteSchema = z
  .object({
    type: z.literal("research-note"),
    id: z.string().min(1),
    title: z.string().min(1),
    language: z.string().min(1),
    source_url: z.string().url(),
    retrieved_at: yamlDateStringSchema,
  })
  .passthrough();

export const entitySchemaMap = {
  character: characterSchema,
  item: itemSchema,
  location: locationSchema,
  faction: factionSchema,
  secret: secretSchema,
  "timeline-event": timelineEventSchema,
} as const;

export const entityTypeSchema = z.enum(ENTITY_TYPES);

export const anyKnownSchema = z.discriminatedUnion("type", [
  bookSchema,
  plotSchema,
  guidelineSchema,
  characterSchema,
  itemSchema,
  locationSchema,
  factionSchema,
  secretSchema,
  timelineEventSchema,
  assetSchema,
  chapterSchema,
  chapterDraftSchema,
  paragraphSchema,
  paragraphDraftSchema,
  researchNoteSchema,
]);

export type BookFrontmatter = z.infer<typeof bookSchema>;
export type PlotFrontmatter = z.infer<typeof plotSchema>;
export type GuidelineFrontmatter = z.infer<typeof guidelineSchema>;
export type CharacterFrontmatter = z.infer<typeof characterSchema>;
export type ItemFrontmatter = z.infer<typeof itemSchema>;
export type LocationFrontmatter = z.infer<typeof locationSchema>;
export type FactionFrontmatter = z.infer<typeof factionSchema>;
export type SecretFrontmatter = z.infer<typeof secretSchema>;
export type TimelineEventFrontmatter = z.infer<typeof timelineEventSchema>;
export type AssetFrontmatter = z.infer<typeof assetSchema>;
export type ChapterFrontmatter = z.infer<typeof chapterSchema>;
export type ChapterDraftFrontmatter = z.infer<typeof chapterDraftSchema>;
export type ParagraphFrontmatter = z.infer<typeof paragraphSchema>;
export type ParagraphDraftFrontmatter = z.infer<typeof paragraphDraftSchema>;
export type ResearchNoteFrontmatter = z.infer<typeof researchNoteSchema>;
export type EntityType = z.infer<typeof entityTypeSchema>;
