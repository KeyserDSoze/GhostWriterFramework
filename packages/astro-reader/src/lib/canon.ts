import path from "node:path";
import { listChapters, listEntities, listRelatedCanon, readChapter, toPosixPath } from "@ghostwriter/core";
import { getBookRoot } from "./book.js";

type ReaderEntityKind =
  | "character"
  | "location"
  | "faction"
  | "item"
  | "secret"
  | "timeline-event";

export type CanonLink = {
  href: string;
  label: string;
  kind: string;
};

export type ValuePart =
  | { text: string; href?: undefined }
  | { text: string; href: string };

type ReferenceIndex = Map<string, CanonLink>;

const entityKinds: ReaderEntityKind[] = ["character", "location", "faction", "item", "secret", "timeline-event"];

let referenceIndexPromise: Promise<ReferenceIndex> | null = null;

export async function resolveValueParts(value: unknown): Promise<ValuePart[]> {
  const strings = Array.isArray(value) ? value : [value];
  const parts: ValuePart[] = [];

  for (const entry of strings) {
    if (entry === undefined || entry === null || entry === "") continue;
    if (parts.length > 0) parts.push({ text: ", " });

    if (typeof entry === "string") {
      const link = await resolveReference(entry);
      if (link) {
        parts.push({ text: link.label, href: link.href });
        continue;
      }
    }

    parts.push({ text: String(entry) });
  }

  return parts;
}

export async function loadRelatedCanonLinks(id: string, values: unknown): Promise<CanonLink[]> {
  const explicitRefs = collectReferenceStrings(values);
  const [resolvedRefs, relatedHits] = await Promise.all([
    Promise.all(explicitRefs.map((value) => resolveReference(value))),
    id ? listRelatedCanon(getBookRoot(), id, { limit: 8 }) : Promise.resolve([]),
  ]);

  const links: CanonLink[] = [];
  const seen = new Set<string>();

  for (const link of resolvedRefs) {
    if (!link || seen.has(link.href)) continue;
    seen.add(link.href);
    links.push(link);
  }

  for (const hit of relatedHits) {
    const href = resolveContentPathToHref(hit.path);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, label: hit.title, kind: hit.type });
  }

  return links;
}

export async function resolveReference(value: string): Promise<CanonLink | null> {
  const normalized = value.trim();
  if (!normalized) return null;

  const index = await loadReferenceIndex();
  const exact = index.get(normalized.toLowerCase());
  if (exact) return exact;

  return buildFallbackReference(normalized);
}

function collectReferenceStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectReferenceStrings(entry));
  }

  if (typeof value !== "string") return [];

  return isSupportedReference(value) ? [value] : [];
}

async function loadReferenceIndex(): Promise<ReferenceIndex> {
  referenceIndexPromise ??= buildReferenceIndex();
  return referenceIndexPromise;
}

async function buildReferenceIndex(): Promise<ReferenceIndex> {
  const index: ReferenceIndex = new Map();
  const root = getBookRoot();
  const entitiesByKind = await Promise.all(entityKinds.map((kind) => listEntities(root, kind)));

  entitiesByKind.forEach((entities, offset) => {
    const kind = entityKinds[offset];

    for (const entity of entities) {
      const label = String(entity.metadata.name ?? entity.metadata.title ?? entity.slug);
      const href = entityHref(kind, entity.slug);
      const id = String(entity.metadata.id ?? `${kind}:${entity.slug}`);
      setReference(index, id, { href, label, kind });
      setReference(index, `${kind}:${entity.slug}`, { href, label, kind });
    }
  });

  const chapters = await listChapters(root);
  for (const chapter of chapters) {
    const chapterId = String(chapter.metadata.id ?? `chapter:${chapter.slug}`);
    const chapterLink = { href: `/chapters/${chapter.slug}/`, label: chapter.metadata.title, kind: "chapter" };
    setReference(index, chapterId, chapterLink);
    setReference(index, `chapter:${chapter.slug}`, chapterLink);

    const chapterData = await readChapter(root, chapter.slug);
    for (const paragraph of chapterData.paragraphs) {
      const paragraphSlug = path.basename(paragraph.path, ".md");
      const href = `/chapters/${chapter.slug}/#scene-${paragraphSlug}`;
      const label = paragraph.metadata.title;
      setReference(index, String(paragraph.metadata.id), { href, label, kind: "paragraph" });
      setReference(index, `paragraph:${chapter.slug}:${paragraphSlug}`, { href, label, kind: "paragraph" });
    }
  }

  return index;
}

function setReference(index: ReferenceIndex, key: string, link: CanonLink) {
  index.set(key.toLowerCase(), link);
}

function entityHref(kind: ReaderEntityKind, slug: string): string {
  switch (kind) {
    case "timeline-event":
      return `/timeline/${slug}/`;
    default:
      return `/${kind}s/${slug}/`;
  }
}

function resolveContentPathToHref(filePath: string): string | null {
  const normalized = toPosixPath(filePath);

  const entityMatch = normalized.match(/^(characters|locations|factions|items|secrets|timelines\/events)\/([^/]+)\.md$/);
  if (entityMatch) {
    const section = entityMatch[1] === "timelines/events" ? "timeline" : entityMatch[1];
    return `/${section}/${entityMatch[2]}/`;
  }

  const chapterMatch = normalized.match(/^chapters\/([^/]+)\/chapter\.md$/);
  if (chapterMatch) {
    return `/chapters/${chapterMatch[1]}/`;
  }

  const paragraphMatch = normalized.match(/^chapters\/([^/]+)\/([^/]+)\.md$/);
  if (paragraphMatch) {
    return `/chapters/${paragraphMatch[1]}/#scene-${paragraphMatch[2]}`;
  }

  return null;
}

function buildFallbackReference(value: string): CanonLink | null {
  if (value.startsWith("chapter:")) {
    const slug = value.slice("chapter:".length);
    return { href: `/chapters/${slug}/`, label: humanizeSlug(slug), kind: "chapter" };
  }

  if (value.startsWith("paragraph:")) {
    const [, chapterSlug, paragraphSlug] = value.split(":");
    if (!chapterSlug || !paragraphSlug) return null;
    return {
      href: `/chapters/${chapterSlug}/#scene-${paragraphSlug}`,
      label: humanizeSlug(paragraphSlug),
      kind: "paragraph",
    };
  }

  for (const kind of entityKinds) {
    const prefix = `${kind}:`;
    if (!value.startsWith(prefix)) continue;
    const slug = value.slice(prefix.length);
    return { href: entityHref(kind, slug), label: humanizeSlug(slug), kind };
  }

  return null;
}

function isSupportedReference(value: string): boolean {
  return value.startsWith("chapter:") || value.startsWith("paragraph:") || entityKinds.some((kind) => value.startsWith(`${kind}:`));
}

function humanizeSlug(value: string): string {
  return value
    .replace(/^[0-9]+-/, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
