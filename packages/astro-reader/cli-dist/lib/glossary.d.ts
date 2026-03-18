type ReaderEntityKind = "character" | "location" | "faction" | "item" | "secret" | "timeline-event";
export type GlossaryEntry = {
    id: string;
    kind: ReaderEntityKind;
    kindLabel: string;
    label: string;
    spokenLabel: string;
    href: string;
    terms: string[];
    summary: string;
    meta: string[];
    metadataEntries: Array<{
        label: string;
        value: string;
    }>;
    mentions: Array<{
        label: string;
        href: string;
    }>;
    bodyHtml?: string;
    imageSrc?: string;
    imageAlt?: string;
    visibleFrom: number | null;
    revealedFrom: number | null;
};
export declare function loadCanonGlossary(chapterNumber?: number): Promise<GlossaryEntry[]>;
export {};
//# sourceMappingURL=glossary.d.ts.map