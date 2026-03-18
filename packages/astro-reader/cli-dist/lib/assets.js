import { readFile } from "node:fs/promises";
import path from "node:path";
import { readAsset } from "narrarium";
import { getBookRoot } from "./book.js";
export async function loadAssetFigure(subject, alt, assetKind) {
    const asset = await readAsset(getBookRoot(), subject, assetKind);
    if (!asset || !asset.imageExists) {
        return null;
    }
    const buffer = await readFile(asset.imagePath);
    return {
        src: `data:${mimeTypeForExtension(path.extname(asset.imagePath))};base64,${buffer.toString("base64")}`,
        alt: typeof asset.metadata.alt_text === "string" && asset.metadata.alt_text.trim() ? asset.metadata.alt_text : alt,
        caption: typeof asset.metadata.caption === "string" && asset.metadata.caption.trim() ? asset.metadata.caption : undefined,
        aspectRatio: asset.metadata.aspect_ratio,
        orientation: asset.metadata.orientation,
    };
}
function mimeTypeForExtension(extension) {
    switch (extension.toLowerCase()) {
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".webp":
            return "image/webp";
        case ".gif":
            return "image/gif";
        case ".avif":
            return "image/avif";
        case ".svg":
            return "image/svg+xml";
        default:
            return "image/png";
    }
}
//# sourceMappingURL=assets.js.map