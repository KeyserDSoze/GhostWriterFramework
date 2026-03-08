import { z } from "zod";
import { ENTITY_TYPES } from "./constants.js";
const canonSchema = z.enum(["draft", "canon", "deprecated"]);
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
    name: z.string().min(1),
    aliases: z.array(z.string()).default([]),
    factions: z.array(z.string()).default([]),
    home_location: z.string().optional(),
    introduced_in: z.string().optional(),
    timeline_ages: z.record(z.string(), z.number().int().nonnegative()).default({}),
})
    .passthrough();
export const itemSchema = baseSchema
    .extend({
    type: z.literal("item"),
    name: z.string().min(1),
    owner: z.string().optional(),
    introduced_in: z.string().optional(),
})
    .passthrough();
export const locationSchema = baseSchema
    .extend({
    type: z.literal("location"),
    name: z.string().min(1),
    region: z.string().optional(),
    timeline_ref: z.string().optional(),
})
    .passthrough();
export const factionSchema = baseSchema
    .extend({
    type: z.literal("faction"),
    name: z.string().min(1),
    leaders: z.array(z.string()).default([]),
    base_location: z.string().optional(),
})
    .passthrough();
export const secretSchema = baseSchema
    .extend({
    type: z.literal("secret"),
    title: z.string().min(1),
    holders: z.array(z.string()).default([]),
    reveal_in: z.string().optional(),
    known_from: z.string().optional(),
    timeline_ref: z.string().optional(),
})
    .passthrough();
export const timelineEventSchema = baseSchema
    .extend({
    type: z.literal("timeline-event"),
    title: z.string().min(1),
    date: z.string().optional(),
    participants: z.array(z.string()).default([]),
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
export const researchNoteSchema = z
    .object({
    type: z.literal("research-note"),
    id: z.string().min(1),
    title: z.string().min(1),
    language: z.string().min(1),
    source_url: z.string().url(),
    retrieved_at: z.string().min(1),
})
    .passthrough();
export const entitySchemaMap = {
    character: characterSchema,
    item: itemSchema,
    location: locationSchema,
    faction: factionSchema,
    secret: secretSchema,
    "timeline-event": timelineEventSchema,
};
export const entityTypeSchema = z.enum(ENTITY_TYPES);
export const anyKnownSchema = z.discriminatedUnion("type", [
    bookSchema,
    guidelineSchema,
    characterSchema,
    itemSchema,
    locationSchema,
    factionSchema,
    secretSchema,
    timelineEventSchema,
    chapterSchema,
    paragraphSchema,
    researchNoteSchema,
]);
//# sourceMappingURL=schemas.js.map