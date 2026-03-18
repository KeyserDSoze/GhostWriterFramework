import type { EntityType } from "narrarium";
import { type ReaderFigure } from "./assets.js";
import { type CanonLink } from "./canon.js";
type CanonEntityDocument = {
    slug: string;
    metadata: Record<string, unknown>;
    body: string;
};
export type CanonIndexCard = {
    slug: string;
    label: string;
    eyebrow: string;
    summary: string;
    chips: string[];
    figure: ReaderFigure | null;
    locked: boolean;
    unlockHint?: string;
};
export type CanonPageView = {
    mode: "full" | "teaser" | "locked";
    title: string;
    eyebrow: string;
    description: string;
    metaEntries: Array<[string, unknown]>;
    figure: ReaderFigure | null;
    html?: string;
    relatedLinks: CanonLink[];
    storyLinks: CanonLink[];
    notice?: string;
};
export declare function buildPublicCanonIndexCards(kind: EntityType, entities: CanonEntityDocument[]): Promise<CanonIndexCard[]>;
export declare function countPublicCanonEntries(kind: EntityType, entities: CanonEntityDocument[]): Promise<number>;
export declare function buildCanonPageView(kind: EntityType, entity: CanonEntityDocument): Promise<CanonPageView>;
export declare function publicTimelineNotice(): string | null;
export {};
//# sourceMappingURL=public-canon.d.ts.map