import { parseDocument, stringify } from "yaml";
import type { BookStructure, Chapter } from "@/types/book";
import type { BookEntry, BookExportScope, BookExportSettings } from "@/types/settings";
import { loadBinaryFileContent, loadFileContent } from "@/github/githubClient";
import { slugify } from "@/narrarium/canon";

const PARAGRAPH_BREAK_NEWLINES = 3;

interface ExportParagraph {
  number: string;
  title: string;
  summary?: string;
  frontmatterText?: string;
  body: string;
  asset?: ExportAsset;
}

interface ExportChapter {
  slug: string;
  number: number;
  title: string;
  summary?: string;
  frontmatterText?: string;
  body: string;
  paragraphs: ExportParagraph[];
  asset?: ExportAsset;
}

interface ExportAsset {
  path: string;
  altText?: string;
  caption?: string;
  orientation?: string;
  aspectRatio?: string;
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
}

interface ExportBookSnapshot {
  title: string;
  author: string;
  language: string;
  description?: string;
  frontmatterText?: string;
  chapters: ExportChapter[];
  wordCount: number;
  coverAsset?: ExportAsset;
}

export interface BookExportArtifact {
  format: BookExportFormat;
  fileName: string;
  mimeType: string;
  blob: Blob;
}

export type BookExportFormat = "docx" | "pdf" | "epub" | "package";

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; frontmatterText?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw.trim() };
  const doc = parseDocument(match[1]);
  const frontmatter = (doc.toJSON() as Record<string, unknown> | null) ?? {};
  return { frontmatter, frontmatterText: stringify(frontmatter).trimEnd(), body: match[2].trim() };
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function loadAsset(input: {
  token: string;
  book: BookEntry;
  branch: string;
  markdownPath: string;
}): Promise<ExportAsset | undefined> {
  const { token, book, branch, markdownPath } = input;
  const raw = await loadFileContent(token, book.owner, book.repo, markdownPath, branch).catch(() => null);
  if (!raw) return undefined;
  const document = parseFrontmatter(raw);
  const imagePath = asString(document.frontmatter.path);
  if (!imagePath) return undefined;
  const bytes = await loadBinaryFileContent(token, book.owner, book.repo, imagePath, branch).catch(() => null);
  if (!bytes) return undefined;
  const extension = imagePath.split(".").pop()?.toLowerCase() || "png";
  return {
    path: imagePath,
    altText: asString(document.frontmatter.alt_text) || undefined,
    caption: asString(document.frontmatter.caption) || undefined,
    orientation: asString(document.frontmatter.orientation) || undefined,
    aspectRatio: asString(document.frontmatter.aspect_ratio) || undefined,
    bytes,
    mimeType: imageMimeType(extension),
    extension,
  };
}

function imageMimeType(extension: string): string {
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/png";
}

function paragraphSlugFromPath(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
}

function scopeChapters(chapters: Chapter[], scope: BookExportScope, sampleChapters: number): Chapter[] {
  if (scope === "full") return chapters;
  return chapters.slice(0, Math.max(1, sampleChapters));
}

function stripMarkdownInline(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[([^\]]*)\]\([^\)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[>#]+\s*/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/[*_~]/g, "")
    .trim();
}

function markdownToPlainParagraphs(markdown: string, mode: BookExportSettings["lineBreakMode"] = "book"): string[] {
  const text = stripMarkdownInline(markdown).replace(/\r\n/g, "\n");
  if (mode === "source") return splitPlainBlocks(text, /\n{2,}/g);
  if (mode === "dialogue") {
    return text
      .split(/\n{2,}/g)
      .flatMap((block) => {
        const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
        if (lines.length > 1 && lines.some(isDialogueParagraph)) return lines;
        return [lines.join(" ").replace(/\s+/g, " ").trim()];
      })
      .filter(Boolean);
  }
  const separator = new RegExp(`\n{${Math.max(PARAGRAPH_BREAK_NEWLINES, 2)},}`, "g");
  return splitPlainBlocks(text, separator);
}

function splitPlainBlocks(text: string, separator: RegExp): string[] {
  return text
    .split(separator)
    .map((paragraph) => paragraph.replace(/\n+/g, " ").trim())
    .filter(Boolean);
}

function isDialogueParagraph(text: string): boolean {
  return /^[«“"—–]/.test(text.trim());
}

function countWords(chapters: ExportChapter[]): number {
  return chapters.reduce((total, chapter) => {
    return total + chapter.paragraphs.reduce((chapterTotal, paragraph) => chapterTotal + paragraph.body.split(/\s+/).filter(Boolean).length, 0);
  }, 0);
}

function outputBaseName(snapshot: ExportBookSnapshot, scope: BookExportScope): string {
  const base = slugify(snapshot.title || "book") || "book";
  return scope === "draft" ? `${base}-draft` : base;
}

export async function loadBookExportSnapshot(input: {
  token: string;
  book: BookEntry;
  branch: string;
  structure: BookStructure;
  scope: BookExportScope;
  exportSettings: BookExportSettings;
}): Promise<ExportBookSnapshot> {
  const { token, book, branch, structure, scope, exportSettings } = input;
  const includeImages = exportSettings.includeImages;
  const selectedChapters = scopeChapters(structure.chapters, scope, exportSettings.sampleChapters);
  if (selectedChapters.length === 0) throw new Error("No chapters available to export.");

  const bookRaw = await loadFileContent(token, book.owner, book.repo, "book.md", branch).catch(() => "");
  const bookDoc = parseFrontmatter(bookRaw);

  const chapters = await Promise.all(
    selectedChapters.map(async (chapter) => {
      const chapterDoc = parseFrontmatter(await loadFileContent(token, book.owner, book.repo, `${chapter.path}/chapter.md`, branch));
      const paragraphs = await Promise.all(
        chapter.paragraphs.map(async (paragraph) => {
          const doc = parseFrontmatter(await loadFileContent(token, book.owner, book.repo, paragraph.path, branch));
          return {
            number: paragraph.number,
            title: asString(doc.frontmatter.title, paragraph.title),
            summary: asString(doc.frontmatter.summary) || undefined,
            frontmatterText: exportSettings.includeFrontmatter ? doc.frontmatterText : undefined,
            body: doc.body,
            asset: includeImages ? await loadAsset({
              token,
              book,
              branch,
              markdownPath: `assets/chapters/${chapter.slug}/paragraphs/${paragraphSlugFromPath(paragraph.path)}/primary.md`,
            }) : undefined,
          } satisfies ExportParagraph;
        }),
      );
      return {
        slug: chapter.slug,
        number: asNumber(chapterDoc.frontmatter.number, Number(chapter.slug.slice(0, 3)) || 0),
        title: asString(chapterDoc.frontmatter.title, chapter.title),
        summary: asString(chapterDoc.frontmatter.summary) || undefined,
        frontmatterText: exportSettings.includeFrontmatter ? chapterDoc.frontmatterText : undefined,
        body: chapterDoc.body,
        paragraphs,
        asset: includeImages ? await loadAsset({ token, book, branch, markdownPath: `assets/chapters/${chapter.slug}/primary.md` }) : undefined,
      } satisfies ExportChapter;
    }),
  );

  const snapshot: ExportBookSnapshot = {
    title: asString(bookDoc.frontmatter.title, structure.title || book.name || book.repo),
    author: asString(bookDoc.frontmatter.author, "Unknown Author"),
    language: asString(bookDoc.frontmatter.language, "en"),
    description: asString(bookDoc.frontmatter.description) || undefined,
    frontmatterText: exportSettings.includeFrontmatter ? bookDoc.frontmatterText : undefined,
    chapters,
    wordCount: 0,
    coverAsset: includeImages ? await loadAsset({ token, book, branch, markdownPath: "assets/book/cover.md" }) : undefined,
  };
  snapshot.wordCount = countWords(chapters);
  return snapshot;
}

export async function buildBookExportArtifacts(input: {
  snapshot: ExportBookSnapshot;
  scope: BookExportScope;
  settings: BookExportSettings;
  formats: BookExportFormat[];
}): Promise<BookExportArtifact[]> {
  const { snapshot, scope, settings, formats } = input;
  const artifacts: BookExportArtifact[] = [];
  for (const format of formats) {
    if (format === "docx") artifacts.push(await buildDocxArtifact(snapshot, scope, settings));
    if (format === "pdf") artifacts.push(await buildPdfArtifact(snapshot, scope, settings));
    if (format === "epub") artifacts.push(await buildEpubArtifact(snapshot, scope, settings));
    if (format === "package") artifacts.push(await buildSubmissionPackageArtifact(snapshot, scope, settings, input.formats.includes("epub")));
  }
  return artifacts;
}

async function buildSubmissionPackageArtifact(snapshot: ExportBookSnapshot, scope: BookExportScope, settings: BookExportSettings, includeEpub: boolean): Promise<BookExportArtifact> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const manuscript = zip.folder("manuscript");
  const editorial = zip.folder("editorial");
  const assets = zip.folder("assets");
  if (!manuscript || !editorial || !assets) throw new Error("Failed to create submission package.");

  const docx = await buildDocxArtifact(snapshot, scope, settings);
  const pdf = await buildPdfArtifact(snapshot, scope, settings);
  manuscript.file(docx.fileName, await docx.blob.arrayBuffer());
  manuscript.file(pdf.fileName, await pdf.blob.arrayBuffer());
  if (includeEpub) {
    const epub = await buildEpubArtifact(snapshot, scope, settings);
    manuscript.file(epub.fileName, await epub.blob.arrayBuffer());
  }

  editorial.file("synopsis.md", buildSynopsis(snapshot, scope));
  editorial.file("pitch-letter.md", buildPitchLetter(snapshot, scope));
  editorial.file("author-bio.md", buildAuthorBio(snapshot));
  editorial.file("metadata.json", JSON.stringify(buildSubmissionMetadata(snapshot, scope), null, 2));
  editorial.file("readiness-report.md", buildSubmissionReadiness(snapshot));

  if (snapshot.coverAsset) assets.file(`cover.${snapshot.coverAsset.extension}`, snapshot.coverAsset.bytes);
  snapshot.chapters.forEach((chapter, index) => {
    if (chapter.asset) assets.file(`chapter-${index + 1}.${chapter.asset.extension}`, chapter.asset.bytes);
    chapter.paragraphs.forEach((paragraph, paragraphIndex) => {
      if (paragraph.asset) assets.file(`chapter-${index + 1}-scene-${paragraphIndex + 1}.${paragraph.asset.extension}`, paragraph.asset.bytes);
    });
  });

  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/zip" });
  return {
    format: "package",
    fileName: `${outputBaseName(snapshot, scope)}-submission-package.zip`,
    mimeType: "application/zip",
    blob,
  };
}

async function buildDocxArtifact(snapshot: ExportBookSnapshot, scope: BookExportScope, settings: BookExportSettings): Promise<BookExportArtifact> {
  const docx = await import("docx");
  const {
    AlignmentType,
    Document,
    Header,
    ImageRun,
    Packer,
    PageNumber,
    Paragraph,
    TextRun,
    convertInchesToTwip,
  } = docx;

  const children: InstanceType<typeof Paragraph>[] = [];

  const pushFrontmatter = (frontmatterText: string | undefined) => {
    if (!settings.includeFrontmatter || !frontmatterText?.trim()) return;
    const block = `---\n${frontmatterText.trim()}\n---`;
    children.push(new Paragraph({
      children: [new TextRun({ text: block, font: "Courier New", size: Math.max(16, settings.fontSize * 2 - 2) })],
      spacing: { before: 180, after: 180 },
    }));
  };

  const pushImage = (asset: ExportAsset | undefined, fallbackAlt: string) => {
    const type = docxImageType(asset?.extension);
    if (!asset || !type) return;
    const dimensions = fittedImageDimensions(asset, 432, 520);
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 240, after: asset.caption ? 60 : 240 },
      children: [new ImageRun({ type, data: asset.bytes, transformation: dimensions, altText: { name: fallbackAlt, title: asset.altText || fallbackAlt, description: asset.altText || fallbackAlt } })],
    }));
    if (asset.caption) {
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: asset.caption, font: settings.fontName, size: Math.max(16, settings.fontSize * 2 - 2), italics: true })], spacing: { after: 240 } }));
    }
  };

  if (settings.includeTitlePage) {
    children.push(new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text: snapshot.author, font: settings.fontName, size: settings.fontSize * 2 })] }));
    children.push(new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `Approx. ${roundWordCount(snapshot.wordCount)} words`, font: settings.fontName, size: settings.fontSize * 2 })] }));
    for (let i = 0; i < 8; i++) children.push(new Paragraph({}));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: snapshot.title, font: settings.fontName, size: settings.fontSize * 2, bold: true })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `by ${snapshot.author}`, font: settings.fontName, size: settings.fontSize * 2 })] }));
    pushFrontmatter(snapshot.frontmatterText);
    pushImage(snapshot.coverAsset, `${snapshot.title} cover`);
    children.push(new Paragraph({ pageBreakBefore: true }));
  } else {
    pushFrontmatter(snapshot.frontmatterText);
  }

  snapshot.chapters.forEach((chapter, chapterIndex) => {
    if (chapterIndex > 0 || !settings.includeTitlePage) {
      children.push(new Paragraph({ pageBreakBefore: true }));
    }
    const chapterHeading = chapter.number ? `Chapter ${chapter.number}` : chapter.title;
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: chapterHeading, font: settings.fontName, size: settings.fontSize * 2, bold: true })] }));
    if (chapter.number && chapter.title !== chapterHeading) {
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: chapter.title, font: settings.fontName, size: settings.fontSize * 2, italics: true })] }));
    }
    if (settings.showChapterSummary && chapter.summary) {
      children.push(new Paragraph({ children: [new TextRun({ text: chapter.summary, font: settings.fontName, size: settings.fontSize * 2, italics: true })], spacing: { after: 240 } }));
    }
    pushFrontmatter(chapter.frontmatterText);
    pushImage(chapter.asset, `${chapter.title} illustration`);
    chapter.paragraphs.forEach((paragraph, paragraphIndex) => {
      if (settings.showParagraphTitles && paragraph.title) {
        children.push(new Paragraph({ children: [new TextRun({ text: paragraph.title, font: settings.fontName, size: settings.fontSize * 2, bold: true })], spacing: { before: 240, after: 120 } }));
      } else if (paragraphIndex > 0) {
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: settings.sceneBreak, font: settings.fontName, size: settings.fontSize * 2 })], spacing: { before: 240, after: 240 } }));
      }
      pushFrontmatter(paragraph.frontmatterText);
      for (const plainParagraph of markdownToPlainParagraphs(paragraph.body, settings.lineBreakMode)) {
        children.push(new Paragraph({
          children: [new TextRun({ text: plainParagraph, font: settings.fontName, size: settings.fontSize * 2 })],
          alignment: settings.paragraphAlignment === "justified" ? AlignmentType.JUSTIFIED : AlignmentType.LEFT,
          spacing: { line: Math.round(settings.fontSize * 20 * settings.lineSpacing) },
          indent: { firstLine: convertInchesToTwip(settings.paragraphIndentInches) },
        }));
      }
      pushImage(paragraph.asset, `${paragraph.title} illustration`);
    });
  });

  const authorLast = snapshot.author.split(/\s+/).filter(Boolean).pop() ?? "AUTHOR";
  const shortTitle = snapshot.title.length > 30 ? snapshot.title.slice(0, 30).toUpperCase() : snapshot.title.toUpperCase();
  const header = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({ children: [`${authorLast} / ${shortTitle} / `, PageNumber.CURRENT], font: settings.fontName, size: settings.fontSize * 2 }),
        ],
      }),
    ],
  });

  const document = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(settings.marginInches),
            right: convertInchesToTwip(settings.marginInches),
            bottom: convertInchesToTwip(settings.marginInches),
            left: convertInchesToTwip(settings.marginInches),
          },
          size: settings.pageSize === "a4"
            ? { width: convertInchesToTwip(8.27), height: convertInchesToTwip(11.69) }
            : { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
        },
        titlePage: settings.includeTitlePage,
      },
      headers: { default: header },
      children,
    }],
  });

  const buffer = await Packer.toBlob(document);
  return {
    format: "docx",
    fileName: `${outputBaseName(snapshot, scope)}.docx`,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    blob: buffer,
  };
}

async function buildPdfArtifact(snapshot: ExportBookSnapshot, scope: BookExportScope, settings: BookExportSettings): Promise<BookExportArtifact> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: settings.pageSize === "a4" ? "a4" : "letter" });
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const margin = settings.marginInches * 72;
  const contentWidth = width - margin * 2;
  const lineHeight = settings.fontSize * settings.lineSpacing;

  let pageNumber = 1;
  let y = margin;
  const baseFont = mapPdfFont(settings.fontName);
  doc.setFont(baseFont, "normal");
  doc.setFontSize(settings.fontSize);

  function drawHeader() {
    if (settings.includeTitlePage && pageNumber === 1) return;
    const authorLast = snapshot.author.split(/\s+/).filter(Boolean).pop() ?? "AUTHOR";
    const shortTitle = snapshot.title.length > 30 ? snapshot.title.slice(0, 30).toUpperCase() : snapshot.title.toUpperCase();
    doc.setFont(baseFont, "normal");
    doc.text(`${authorLast} / ${shortTitle} / ${pageNumber}`, width - margin, margin * 0.6, { align: "right" });
  }

  function newPage() {
    doc.addPage(settings.pageSize === "a4" ? "a4" : "letter");
    pageNumber += 1;
    y = margin;
    drawHeader();
  }

  function ensureSpace(lines = 1) {
    if (y + lines * lineHeight > height - margin) newPage();
  }

  function writeBlock(text: string, options?: { align?: "left" | "center"; italic?: boolean; bold?: boolean; firstLineIndent?: number }) {
    const indent = options?.firstLineIndent ?? 0;
    const lines = doc.splitTextToSize(text, contentWidth - indent);
    ensureSpace(lines.length + 1);
    doc.setFont(baseFont, options?.bold ? "bold" : options?.italic ? "italic" : "normal");
    if (options?.align === "center") {
      lines.forEach((line: string) => {
        doc.text(line, width / 2, y, { align: "center" });
        y += lineHeight;
      });
    } else {
      lines.forEach((line: string, index: number) => {
        doc.text(line, margin + (index === 0 ? indent : 0), y);
        y += lineHeight;
      });
    }
  }

  function writeFrontmatter(frontmatterText: string | undefined) {
    if (!settings.includeFrontmatter || !frontmatterText?.trim()) return;
    writeBlock(`---\n${frontmatterText.trim()}\n---`, { firstLineIndent: 0 });
  }

  function writeImage(asset: ExportAsset | undefined, fallbackAlt: string) {
    if (!asset) return;
    const format = pdfImageFormat(asset.extension);
    if (!format) return;
    const dimensions = fittedImageDimensions(asset, contentWidth, 360);
    ensureSpace(Math.ceil(dimensions.height / lineHeight) + (asset.caption ? 2 : 1));
    const x = margin + (contentWidth - dimensions.width) / 2;
    const dataUrl = bytesToDataUrl(asset.bytes, asset.mimeType);
    doc.addImage(dataUrl, format, x, y, dimensions.width, dimensions.height, fallbackAlt);
    y += dimensions.height + lineHeight * 0.6;
    if (asset.caption) writeBlock(asset.caption, { align: "center", italic: true });
  }

  if (settings.includeTitlePage) {
    writeBlock(snapshot.author);
    writeBlock(`Approx. ${roundWordCount(snapshot.wordCount)} words`, { align: "center" });
    y += lineHeight * 6;
    writeBlock(snapshot.title, { align: "center", bold: true });
    writeBlock(`by ${snapshot.author}`, { align: "center" });
    writeFrontmatter(snapshot.frontmatterText);
    writeImage(snapshot.coverAsset, `${snapshot.title} cover`);
    newPage();
  } else {
    drawHeader();
    writeFrontmatter(snapshot.frontmatterText);
  }

  snapshot.chapters.forEach((chapter, chapterIndex) => {
    if (chapterIndex > 0 || !settings.includeTitlePage) {
      if (chapterIndex > 0 || y > margin) newPage();
    }
    const heading = chapter.number ? `Chapter ${chapter.number}` : chapter.title;
    writeBlock(heading, { align: "center", bold: true });
    if (chapter.number && chapter.title !== heading) writeBlock(chapter.title, { align: "center", italic: true });
    if (settings.showChapterSummary && chapter.summary) writeBlock(chapter.summary, { italic: true });
    writeFrontmatter(chapter.frontmatterText);
    writeImage(chapter.asset, `${chapter.title} illustration`);
    chapter.paragraphs.forEach((paragraph, paragraphIndex) => {
      if (settings.showParagraphTitles && paragraph.title) {
        y += lineHeight * 0.5;
        writeBlock(paragraph.title, { bold: true });
      } else if (paragraphIndex > 0) {
        y += lineHeight * 0.5;
        writeBlock(settings.sceneBreak, { align: "center" });
      }
      writeFrontmatter(paragraph.frontmatterText);
      for (const plainParagraph of markdownToPlainParagraphs(paragraph.body, settings.lineBreakMode)) {
        writeBlock(plainParagraph, { firstLineIndent: settings.paragraphIndentInches * 72 });
      }
      writeImage(paragraph.asset, `${paragraph.title} illustration`);
    });
  });

  const blob = doc.output("blob");
  return {
    format: "pdf",
    fileName: `${outputBaseName(snapshot, scope)}.pdf`,
    mimeType: "application/pdf",
    blob,
  };
}

async function buildEpubArtifact(snapshot: ExportBookSnapshot, scope: BookExportScope, settings: BookExportSettings): Promise<BookExportArtifact> {
  const [{ marked }, { default: JSZip }] = await Promise.all([import("marked"), import("jszip")]);
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.folder("META-INF")?.file("container.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>`);

  const oebps = zip.folder("OEBPS");
  if (!oebps) throw new Error("Failed to create EPUB archive.");
  const epubFont = epubCssFontFamily(settings.fontFamily);
  oebps.file("styles.css", `body { font-family: ${epubFont}; line-height: ${settings.lineSpacing}; } h1, h2 { font-family: ${epubFont}; } article { margin: 0 auto; max-width: 40rem; } nav ol { padding-left: 1.2rem; } figure { margin: 2rem 0; text-align: center; page-break-inside: avoid; } figure img { max-width: 100%; height: auto; } figcaption { color: #555; font-size: 0.9em; margin-top: 0.5rem; } .frontmatter { border: 1px solid #ddd; background: #f7f7f7; padding: 0.75rem; white-space: pre-wrap; font-family: monospace; font-size: 0.85em; }`);
  oebps.folder("images");

  const imageItems: Array<{ id: string; fileName: string; mimeType: string; properties?: string }> = [];
  const addImage = (id: string, fileName: string, asset: ExportAsset): string => {
    const imagePath = `images/${fileName}.${asset.extension}`;
    oebps.file(imagePath, asset.bytes);
    imageItems.push({ id, fileName: imagePath, mimeType: asset.mimeType, properties: id === "cover-image" ? "cover-image" : undefined });
    return imagePath;
  };

  const coverPath = snapshot.coverAsset ? addImage("cover-image", "book-cover", snapshot.coverAsset) : undefined;
  oebps.file("opening.xhtml", wrapXhtml("Opening", `<article><h1>${escapeHtml(snapshot.title)}</h1><p><em>${escapeHtml(snapshot.author)}</em></p>${renderFrontmatterPre(snapshot.frontmatterText, settings)}${coverPath ? renderEpubFigure(coverPath, snapshot.coverAsset, `${snapshot.title} cover`) : ""}</article>`));

  const chapterFiles = snapshot.chapters.map((chapter, index) => {
    const fileName = `chapter-${index + 1}.xhtml`;
    const chapterImagePath = chapter.asset ? addImage(`chapter-${index + 1}-image`, `chapter-${index + 1}`, chapter.asset) : undefined;
    const sceneIndex = chapter.paragraphs.length > 0
      ? `<nav><h2>Scenes</h2><ol>${chapter.paragraphs.map((paragraph, sceneIndex) => `<li><a href="#scene-${sceneIndex + 1}">${escapeHtml(paragraph.title)}</a></li>`).join("")}</ol></nav>`
      : "";
    const paragraphsHtml = chapter.paragraphs.map((paragraph, sceneIndex) => {
      const paragraphImagePath = paragraph.asset ? addImage(`chapter-${index + 1}-scene-${sceneIndex + 1}-image`, `chapter-${index + 1}-scene-${sceneIndex + 1}`, paragraph.asset) : undefined;
      const summary = paragraph.summary ? `<p><em>${escapeHtml(paragraph.summary)}</em></p>` : "";
      return `<section id="scene-${sceneIndex + 1}"><h2>${escapeHtml(paragraph.title)}</h2>${summary}${renderFrontmatterPre(paragraph.frontmatterText, settings)}${marked.parse(paragraph.body, { async: false })}${paragraphImagePath ? renderEpubFigure(paragraphImagePath, paragraph.asset, `${paragraph.title} illustration`) : ""}</section>`;
    }).join("\n");
    const summary = chapter.summary ? `<p><em>${escapeHtml(chapter.summary)}</em></p>` : "";
    const body = chapter.body ? marked.parse(chapter.body, { async: false }) : "";
    const xhtml = wrapXhtml(chapter.title, `<article><h1>${escapeHtml(chapter.title)}</h1>${summary}${renderFrontmatterPre(chapter.frontmatterText, settings)}${body}${chapterImagePath ? renderEpubFigure(chapterImagePath, chapter.asset, `${chapter.title} illustration`) : ""}${sceneIndex}${paragraphsHtml}</article>`);
    oebps.file(fileName, xhtml);
    return { fileName, title: chapter.title };
  });

  const navXhtml = wrapXhtml("Contents", `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${chapterFiles.map((chapter) => `<li><a href="${chapter.fileName}">${escapeHtml(chapter.title)}</a></li>`).join("")}</ol></nav>`);
  oebps.file("nav.xhtml", navXhtml);
  oebps.file("toc.ncx", buildTocNcx(snapshot, chapterFiles));
  oebps.file("content.opf", buildContentOpf(snapshot, chapterFiles, imageItems));

  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" });
  return {
    format: "epub",
    fileName: `${outputBaseName(snapshot, scope)}.epub`,
    mimeType: "application/epub+zip",
    blob,
  };
}

function buildContentOpf(snapshot: ExportBookSnapshot, chapterFiles: Array<{ fileName: string; title: string }>, imageItems: Array<{ id: string; fileName: string; mimeType: string; properties?: string }>): string {
  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="styles.css" media-type="text/css"/>`,
    `<item id="opening" href="opening.xhtml" media-type="application/xhtml+xml"/>`,
    ...chapterFiles.map((chapter, index) => `<item id="chapter-${index + 1}" href="${chapter.fileName}" media-type="application/xhtml+xml"/>`),
    ...imageItems.map((image) => `<item id="${image.id}" href="${image.fileName}" media-type="${image.mimeType}"${image.properties ? ` properties="${image.properties}"` : ""}/>`),
  ].join("\n    ");
  const spine = [`<itemref idref="opening"/>`, ...chapterFiles.map((_, index) => `<itemref idref="chapter-${index + 1}"/>`)].join("\n    ");
  const coverMeta = imageItems.some((image) => image.id === "cover-image") ? `\n    <meta name="cover" content="cover-image"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:identifier id="bookid">urn:narrarium:${slugify(snapshot.title) || "book"}</dc:identifier>\n    <dc:title>${escapeXml(snapshot.title)}</dc:title>\n    <dc:creator>${escapeXml(snapshot.author)}</dc:creator>\n    <dc:language>${escapeXml(snapshot.language)}</dc:language>${coverMeta}\n  </metadata>\n  <manifest>\n    ${manifest}\n  </manifest>\n  <spine toc="ncx">\n    ${spine}\n  </spine>\n</package>`;
}

function buildTocNcx(snapshot: ExportBookSnapshot, chapterFiles: Array<{ fileName: string; title: string }>): string {
  const navPoints = chapterFiles
    .map((chapter, index) => `    <navPoint id="navPoint-${index + 1}" playOrder="${index + 1}">\n      <navLabel><text>${escapeXml(chapter.title)}</text></navLabel>\n      <content src="${chapter.fileName}"/>\n    </navPoint>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n  <head><meta name="dtb:uid" content="urn:narrarium:${slugify(snapshot.title) || "book"}"/></head>\n  <docTitle><text>${escapeXml(snapshot.title)}</text></docTitle>\n  <navMap>\n${navPoints}\n  </navMap>\n</ncx>`;
}

function wrapXhtml(title: string, bodyHtml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n  <head>\n    <title>${escapeXml(title)}</title>\n    <link rel="stylesheet" type="text/css" href="styles.css"/>\n  </head>\n  <body>${bodyHtml}</body>\n</html>`;
}

function renderEpubFigure(imagePath: string, asset: ExportAsset | undefined, fallbackAlt: string): string {
  if (!asset) return "";
  const alt = asset.altText?.trim() || fallbackAlt;
  const caption = asset.caption?.trim() ? `<figcaption>${escapeHtml(asset.caption)}</figcaption>` : "";
  return `<figure class="epub-figure"><img src="${escapeHtml(imagePath)}" alt="${escapeHtml(alt)}"/>${caption}</figure>`;
}

function renderFrontmatterPre(frontmatterText: string | undefined, settings: BookExportSettings): string {
  if (!settings.includeFrontmatter || !frontmatterText?.trim()) return "";
  return `<pre class="frontmatter">${escapeHtml(`---\n${frontmatterText.trim()}\n---`)}</pre>`;
}

function epubCssFontFamily(fontFamily: BookExportSettings["fontFamily"]): string {
  if (fontFamily === "sans") return "sans-serif";
  if (fontFamily === "mono") return "monospace";
  return "serif";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeXml(value: string): string {
  return escapeHtml(value).replace(/'/g, "&apos;");
}

function roundWordCount(value: number): number {
  return value > 500 ? Math.round(value / 100) * 100 : value;
}

function mapPdfFont(fontName: string): "times" | "courier" | "helvetica" {
  const normalized = fontName.trim().toLowerCase();
  if (normalized.includes("courier")) return "courier";
  if (normalized.includes("helvetica") || normalized.includes("arial")) return "helvetica";
  return "times";
}

function buildSynopsis(snapshot: ExportBookSnapshot, scope: BookExportScope): string {
  const chapters = snapshot.chapters.map((chapter) => {
    const summary = chapter.summary || chapter.paragraphs.map((paragraph) => paragraph.summary).filter(Boolean).join(" ") || "Summary to be completed.";
    return `## ${chapter.title}\n\n${summary}`;
  }).join("\n\n");
  return [`# Synopsis`, "", `Title: ${snapshot.title}`, `Author: ${snapshot.author}`, `Submission scope: ${scope}`, `Approx. word count: ${roundWordCount(snapshot.wordCount)}`, "", snapshot.description ?? "", "", chapters].join("\n").trim() + "\n";
}

function buildPitchLetter(snapshot: ExportBookSnapshot, scope: BookExportScope): string {
  return [
    "# Pitch Letter",
    "",
    "Dear Editor,",
    "",
    `Please find attached ${scope === "draft" ? "a sample submission package" : "the complete manuscript package"} for **${snapshot.title}** by ${snapshot.author}.`,
    "",
    snapshot.description || "[Add a concise hook or back-cover style paragraph here.]",
    "",
    `The included manuscript is approximately ${roundWordCount(snapshot.wordCount)} words in this export scope.`,
    "",
    "Thank you for your time and consideration.",
    "",
    "Sincerely,",
    snapshot.author,
  ].join("\n") + "\n";
}

function buildAuthorBio(snapshot: ExportBookSnapshot): string {
  return [`# Author Bio`, "", `${snapshot.author}`, "", "[Add author biography, publication history, platform, and contact details here.]"].join("\n") + "\n";
}

function buildSubmissionMetadata(snapshot: ExportBookSnapshot, scope: BookExportScope) {
  return {
    title: snapshot.title,
    author: snapshot.author,
    language: snapshot.language,
    description: snapshot.description,
    scope,
    wordCount: snapshot.wordCount,
    roundedWordCount: roundWordCount(snapshot.wordCount),
    chapterCount: snapshot.chapters.length,
    generatedAt: new Date().toISOString(),
  };
}

function buildSubmissionReadiness(snapshot: ExportBookSnapshot): string {
  const chapterImages = snapshot.chapters.filter((chapter) => chapter.asset).length;
  const paragraphCount = snapshot.chapters.reduce((sum, chapter) => sum + chapter.paragraphs.length, 0);
  const paragraphImages = snapshot.chapters.reduce((sum, chapter) => sum + chapter.paragraphs.filter((paragraph) => paragraph.asset).length, 0);
  return [
    "# Readiness Report",
    "",
    `- Title: ${snapshot.title}`,
    `- Author: ${snapshot.author}`,
    `- Chapters included: ${snapshot.chapters.length}`,
    `- Paragraphs included: ${paragraphCount}`,
    `- Approx. word count: ${roundWordCount(snapshot.wordCount)}`,
    `- Cover image: ${snapshot.coverAsset ? "yes" : "no"}`,
    `- Chapter images: ${chapterImages}/${snapshot.chapters.length}`,
    `- Paragraph images: ${paragraphImages}/${paragraphCount}`,
    "",
    "Generated by Narrarium.",
  ].join("\n") + "\n";
}

function parseAspectRatio(value: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value ?? "");
  if (!match) return 2 / 3;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return 2 / 3;
  return width / height;
}

function fittedImageDimensions(asset: ExportAsset, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const ratio = parseAspectRatio(asset.aspectRatio);
  let width = maxWidth;
  let height = width / ratio;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function docxImageType(extension: string | undefined): "jpg" | "png" | "gif" | "bmp" | null {
  if (extension === "jpg" || extension === "jpeg") return "jpg";
  if (extension === "png" || extension === "gif" || extension === "bmp") return extension;
  return null;
}

function pdfImageFormat(extension: string | undefined): "PNG" | "JPEG" | "WEBP" | null {
  if (extension === "jpg" || extension === "jpeg") return "JPEG";
  if (extension === "png") return "PNG";
  if (extension === "webp") return "WEBP";
  return null;
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return `data:${mimeType};base64,${btoa(binary)}`;
}
