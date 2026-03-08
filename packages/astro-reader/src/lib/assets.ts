import { readFile } from "node:fs/promises";
import path from "node:path";
import { readAsset } from "@ghostwriter/core";
import { getBookRoot } from "./book.js";

export type ReaderFigure = {
  src: string;
  alt: string;
  aspectRatio: string;
  orientation: "portrait" | "landscape" | "square";
};

export async function loadAssetFigure(subject: string, alt: string, assetKind?: string): Promise<ReaderFigure | null> {
  const asset = await readAsset(getBookRoot(), subject, assetKind);
  if (!asset || !asset.imageExists) {
    return null;
  }

  const buffer = await readFile(asset.imagePath);
  return {
    src: `data:${mimeTypeForExtension(path.extname(asset.imagePath))};base64,${buffer.toString("base64")}`,
    alt,
    aspectRatio: asset.metadata.aspect_ratio,
    orientation: asset.metadata.orientation,
  };
}

function mimeTypeForExtension(extension: string): string {
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
