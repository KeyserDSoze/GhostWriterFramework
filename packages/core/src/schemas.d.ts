import { z } from "zod";
export declare const bookSchema: z.ZodObject<{
    type: z.ZodLiteral<"book">;
    id: z.ZodLiteral<"book">;
    title: z.ZodString;
    author: z.ZodOptional<z.ZodString>;
    language: z.ZodDefault<z.ZodString>;
    genre: z.ZodOptional<z.ZodString>;
    audience: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
}, z.core.$loose>;
export declare const guidelineSchema: z.ZodObject<{
    type: z.ZodLiteral<"guideline">;
    id: z.ZodString;
    title: z.ZodString;
    scope: z.ZodDefault<z.ZodString>;
}, z.core.$loose>;
export declare const characterSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
    historical: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodLiteral<"character">;
    name: z.ZodString;
    aliases: z.ZodDefault<z.ZodArray<z.ZodString>>;
    factions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    home_location: z.ZodOptional<z.ZodString>;
    introduced_in: z.ZodOptional<z.ZodString>;
    timeline_ages: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
}, z.core.$loose>;
export declare const itemSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
    historical: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodLiteral<"item">;
    name: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    introduced_in: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const locationSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
    historical: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodLiteral<"location">;
    name: z.ZodString;
    region: z.ZodOptional<z.ZodString>;
    timeline_ref: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const factionSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
    historical: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodLiteral<"faction">;
    name: z.ZodString;
    leaders: z.ZodDefault<z.ZodArray<z.ZodString>>;
    base_location: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const secretSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
    historical: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodLiteral<"secret">;
    title: z.ZodString;
    holders: z.ZodDefault<z.ZodArray<z.ZodString>>;
    reveal_in: z.ZodOptional<z.ZodString>;
    known_from: z.ZodOptional<z.ZodString>;
    timeline_ref: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const timelineEventSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
    historical: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodLiteral<"timeline-event">;
    title: z.ZodString;
    date: z.ZodOptional<z.ZodString>;
    participants: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$loose>;
export declare const chapterSchema: z.ZodObject<{
    type: z.ZodLiteral<"chapter">;
    id: z.ZodString;
    number: z.ZodNumber;
    title: z.ZodString;
    summary: z.ZodOptional<z.ZodString>;
    pov: z.ZodDefault<z.ZodArray<z.ZodString>>;
    timeline_ref: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$loose>;
export declare const paragraphSchema: z.ZodObject<{
    type: z.ZodLiteral<"paragraph">;
    id: z.ZodString;
    chapter: z.ZodString;
    number: z.ZodNumber;
    title: z.ZodString;
    summary: z.ZodOptional<z.ZodString>;
    viewpoint: z.ZodOptional<z.ZodString>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
}, z.core.$loose>;
export declare const researchNoteSchema: z.ZodObject<{
    type: z.ZodLiteral<"research-note">;
    id: z.ZodString;
    title: z.ZodString;
    language: z.ZodString;
    source_url: z.ZodString;
    retrieved_at: z.ZodString;
}, z.core.$loose>;
export declare const entitySchemaMap: {
    readonly character: z.ZodObject<{
        id: z.ZodString;
        status: z.ZodOptional<z.ZodString>;
        canon: z.ZodDefault<z.ZodEnum<{
            draft: "draft";
            canon: "canon";
            deprecated: "deprecated";
        }>>;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
        historical: z.ZodDefault<z.ZodBoolean>;
        type: z.ZodLiteral<"character">;
        name: z.ZodString;
        aliases: z.ZodDefault<z.ZodArray<z.ZodString>>;
        factions: z.ZodDefault<z.ZodArray<z.ZodString>>;
        home_location: z.ZodOptional<z.ZodString>;
        introduced_in: z.ZodOptional<z.ZodString>;
        timeline_ages: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    }, z.core.$loose>;
    readonly item: z.ZodObject<{
        id: z.ZodString;
        status: z.ZodOptional<z.ZodString>;
        canon: z.ZodDefault<z.ZodEnum<{
            draft: "draft";
            canon: "canon";
            deprecated: "deprecated";
        }>>;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
        historical: z.ZodDefault<z.ZodBoolean>;
        type: z.ZodLiteral<"item">;
        name: z.ZodString;
        owner: z.ZodOptional<z.ZodString>;
        introduced_in: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    readonly location: z.ZodObject<{
        id: z.ZodString;
        status: z.ZodOptional<z.ZodString>;
        canon: z.ZodDefault<z.ZodEnum<{
            draft: "draft";
            canon: "canon";
            deprecated: "deprecated";
        }>>;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
        historical: z.ZodDefault<z.ZodBoolean>;
        type: z.ZodLiteral<"location">;
        name: z.ZodString;
        region: z.ZodOptional<z.ZodString>;
        timeline_ref: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    readonly faction: z.ZodObject<{
        id: z.ZodString;
        status: z.ZodOptional<z.ZodString>;
        canon: z.ZodDefault<z.ZodEnum<{
            draft: "draft";
            canon: "canon";
            deprecated: "deprecated";
        }>>;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
        historical: z.ZodDefault<z.ZodBoolean>;
        type: z.ZodLiteral<"faction">;
        name: z.ZodString;
        leaders: z.ZodDefault<z.ZodArray<z.ZodString>>;
        base_location: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    readonly secret: z.ZodObject<{
        id: z.ZodString;
        status: z.ZodOptional<z.ZodString>;
        canon: z.ZodDefault<z.ZodEnum<{
            draft: "draft";
            canon: "canon";
            deprecated: "deprecated";
        }>>;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
        historical: z.ZodDefault<z.ZodBoolean>;
        type: z.ZodLiteral<"secret">;
        title: z.ZodString;
        holders: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reveal_in: z.ZodOptional<z.ZodString>;
        known_from: z.ZodOptional<z.ZodString>;
        timeline_ref: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    readonly "timeline-event": z.ZodObject<{
        id: z.ZodString;
        status: z.ZodOptional<z.ZodString>;
        canon: z.ZodDefault<z.ZodEnum<{
            draft: "draft";
            canon: "canon";
            deprecated: "deprecated";
        }>>;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
        historical: z.ZodDefault<z.ZodBoolean>;
        type: z.ZodLiteral<"timeline-event">;
        title: z.ZodString;
        date: z.ZodOptional<z.ZodString>;
        participants: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$loose>;
};
export declare const entityTypeSchema: z.ZodEnum<{
    character: "character";
    item: "item";
    location: "location";
    faction: "faction";
    secret: "secret";
    "timeline-event": "timeline-event";
}>;
export declare const anyKnownSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"book">;
    id: z.ZodLiteral<"book">;
    title: z.ZodString;
    author: z.ZodOptional<z.ZodString>;
    language: z.ZodDefault<z.ZodString>;
    genre: z.ZodOptional<z.ZodString>;
    audience: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"guideline">;
    id: z.ZodString;
    title: z.ZodString;
    scope: z.ZodDefault<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    id: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
    historical: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodLiteral<"character">;
    name: z.ZodString;
    aliases: z.ZodDefault<z.ZodArray<z.ZodString>>;
    factions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    home_location: z.ZodOptional<z.ZodString>;
    introduced_in: z.ZodOptional<z.ZodString>;
    timeline_ages: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
}, z.core.$loose>, z.ZodObject<{
    id: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
    historical: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodLiteral<"item">;
    name: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    introduced_in: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    id: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
    historical: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodLiteral<"location">;
    name: z.ZodString;
    region: z.ZodOptional<z.ZodString>;
    timeline_ref: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    id: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
    historical: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodLiteral<"faction">;
    name: z.ZodString;
    leaders: z.ZodDefault<z.ZodArray<z.ZodString>>;
    base_location: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    id: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
    historical: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodLiteral<"secret">;
    title: z.ZodString;
    holders: z.ZodDefault<z.ZodArray<z.ZodString>>;
    reveal_in: z.ZodOptional<z.ZodString>;
    known_from: z.ZodOptional<z.ZodString>;
    timeline_ref: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    id: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    sources: z.ZodDefault<z.ZodArray<z.ZodString>>;
    historical: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodLiteral<"timeline-event">;
    title: z.ZodString;
    date: z.ZodOptional<z.ZodString>;
    participants: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"chapter">;
    id: z.ZodString;
    number: z.ZodNumber;
    title: z.ZodString;
    summary: z.ZodOptional<z.ZodString>;
    pov: z.ZodDefault<z.ZodArray<z.ZodString>>;
    timeline_ref: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodString>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"paragraph">;
    id: z.ZodString;
    chapter: z.ZodString;
    number: z.ZodNumber;
    title: z.ZodString;
    summary: z.ZodOptional<z.ZodString>;
    viewpoint: z.ZodOptional<z.ZodString>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    canon: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        canon: "canon";
        deprecated: "deprecated";
    }>>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"research-note">;
    id: z.ZodString;
    title: z.ZodString;
    language: z.ZodString;
    source_url: z.ZodString;
    retrieved_at: z.ZodString;
}, z.core.$loose>], "type">;
export type BookFrontmatter = z.infer<typeof bookSchema>;
export type GuidelineFrontmatter = z.infer<typeof guidelineSchema>;
export type CharacterFrontmatter = z.infer<typeof characterSchema>;
export type ItemFrontmatter = z.infer<typeof itemSchema>;
export type LocationFrontmatter = z.infer<typeof locationSchema>;
export type FactionFrontmatter = z.infer<typeof factionSchema>;
export type SecretFrontmatter = z.infer<typeof secretSchema>;
export type TimelineEventFrontmatter = z.infer<typeof timelineEventSchema>;
export type ChapterFrontmatter = z.infer<typeof chapterSchema>;
export type ParagraphFrontmatter = z.infer<typeof paragraphSchema>;
export type ResearchNoteFrontmatter = z.infer<typeof researchNoteSchema>;
export type EntityType = z.infer<typeof entityTypeSchema>;
//# sourceMappingURL=schemas.d.ts.map