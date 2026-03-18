export type ReaderFigure = {
    src: string;
    alt: string;
    caption?: string;
    aspectRatio: string;
    orientation: "portrait" | "landscape" | "square";
};
export declare function loadAssetFigure(subject: string, alt: string, assetKind?: string): Promise<ReaderFigure | null>;
//# sourceMappingURL=assets.d.ts.map