/**
 * The annotations of a book: passages the author marked while reading, each with a tag, an optional note and a status. They are saved in the book
 * (one file per chapter under `annotations/`, see `format.ts` and docs/repository-spec.md «Annotations»), so they travel with the book's sync.
 *
 * This module, `anchoring.ts` and `format.ts` know nothing of the browser or of the app: they are meant to move to the engine when the autopilot reads
 * the annotations (phase 4), and the management page and the triage (phases 2 and 3) build on them.
 */

/** Where an annotation is in the author's work: open (to look at), later (put aside for now), handled (done), dismissed (decided not to act). */
export const ANNOTATION_STATUSES = ["open", "later", "handled", "dismissed"] as const;
export type AnnotationStatus = (typeof ANNOTATION_STATUSES)[number];

/** A status still waiting for the author: what the badges count. */
export function isPendingStatus(status: AnnotationStatus): boolean {
  return status === "open" || status === "later";
}

/** A status this version knows, else `open`: a status written by a newer app is shown as open (and written back as it was). */
export function annotationStatus(raw: string): AnnotationStatus {
  return (ANNOTATION_STATUSES as readonly string[]).includes(raw) ? raw as AnnotationStatus : "open";
}

/**
 * Where the passage is, in the plain text of its scene (the paragraph file of Narrarium), the way the W3C Web Annotation model does it: the exact
 * text (TextQuoteSelector `exact`), up to `CONTEXT_LENGTH` characters before and after it, and where it started (TextPositionSelector `start`, a
 * fallback). The plain text is the text of the scene as the reader shows it, with every run of white space made one space (`textModel.ts`).
 */
export interface TextAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  /** The start of the quote in the plain text of the scene when it was marked (UTF-16 code units). */
  offset: number;
}

export interface Annotation extends TextAnchor {
  /** Stable for the life of the annotation: `a-<time in base 36>-<random>`, so the file sorted by id is in the order they were made. */
  id: string;
  /** The slug of the chapter (`001-the-gate`): the file the annotation is in. */
  chapter: string;
  /** The slug of the scene (`002-the-arrival`), the paragraph file the passage was marked in. */
  paragraph: string;
  /** The id of a tag: a built-in one, a tag of every book (Settings) or a tag of this book (`annotations/tags.yml`). */
  tag: string;
  /** The author's note; may be empty. */
  comment: string;
  /** The status as written: one of `ANNOTATION_STATUSES`, or one of a newer app (read with `annotationStatus`). */
  status: string;
  createdAt: string;
  updatedAt: string;
  /** An opaque short tag of the device that made it (not the device's own id). */
  createdOnDevice: string;
  /** Fields of a newer app, kept as they are. */
  extra?: Record<string, unknown>;
}

/** What is left of a deleted annotation in its file, so that a device that still has it does not bring it back when the two copies merge. */
export interface AnnotationTombstone {
  id: string;
  deletedAt: string;
  updatedAt: string;
  extra?: Record<string, unknown>;
}

export type AnnotationEntry = Annotation | AnnotationTombstone;

export function isTombstone(entry: AnnotationEntry): entry is AnnotationTombstone {
  return "deletedAt" in entry && typeof entry.deletedAt === "string";
}

// ─── Tags ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The line under the marked text: its style is one of the two signs of a tag that are not colour (the other is the icon). */
export const MARK_UNDERLINES = ["wavy", "double", "dashed", "dotted", "solid"] as const;
export type MarkUnderline = (typeof MARK_UNDERLINES)[number];
/** Colours that reach 3:1 against the page in both themes (`--mark-<colour>` in index.css; test/themeContrast.test.mjs). */
export const MARK_COLORS = ["amber", "rose", "violet", "sky", "emerald", "orange", "teal", "slate"] as const;
export type MarkColor = (typeof MARK_COLORS)[number];
export const MARK_ICONS = ["pen", "thumbs-down", "alert", "expand", "star", "flag", "question", "message", "scissors", "sparkles", "eye", "bookmark", "clock", "heart"] as const;
export type MarkIcon = (typeof MARK_ICONS)[number];

export interface MarkStyle {
  underline: MarkUnderline;
  color: MarkColor;
  icon: MarkIcon;
}

/** A tag defined by the author: for every book (Settings, in the account data) or for one book (in its `annotations/tags.yml`). */
export interface AnnotationTagDefinition {
  id: string;
  name: string;
  /** What the tag means, and the instruction for the AI when it handles an annotation with this tag. */
  description: string;
  mark: MarkStyle;
  createdAt: string;
  updatedAt: string;
  /** A tag of a book that was deleted: kept as a tombstone in the file for the merges, never shown. */
  deletedAt?: string;
  extra?: Record<string, unknown>;
}

export type TagScope = "builtin" | "global" | "book" | "missing";

/** A tag as the interface shows it, in the language of the app. */
export interface ResolvedTag {
  id: string;
  scope: TagScope;
  name: string;
  description: string;
  mark: MarkStyle;
}

export type BuiltinTagId = "rewrite" | "dislike" | "inconsistency" | "expand" | "keep";

interface BuiltinTag {
  id: BuiltinTagId;
  mark: MarkStyle;
  text: Record<"en" | "it", { name: string; description: string }>;
}

/** The tags every book has. Their ids are stable (they are written in the files); their names and descriptions follow the language of the app. */
export const BUILTIN_TAGS: readonly BuiltinTag[] = [
  {
    id: "rewrite",
    mark: { underline: "wavy", color: "amber", icon: "pen" },
    text: {
      en: { name: "To rewrite", description: "Rewrite this passage: keep what it says and the voice of the book, and make it clearer, more precise and stronger." },
      it: { name: "Da riscrivere", description: "Riscrivi questo passaggio: tieni ciò che dice e la voce del libro, e rendilo più chiaro, più preciso e più forte." },
    },
  },
  {
    id: "dislike",
    mark: { underline: "double", color: "rose", icon: "thumbs-down" },
    text: {
      en: { name: "Don't like it", description: "The author does not like this passage: find what does not work (image, rhythm, tone, word choice) and propose a different version." },
      it: { name: "Non mi piace", description: "All'autore questo passaggio non piace: trova cosa non funziona (immagine, ritmo, tono, scelta delle parole) e proponi una versione diversa." },
    },
  },
  {
    id: "inconsistency",
    mark: { underline: "dashed", color: "violet", icon: "alert" },
    text: {
      en: { name: "Inconsistency", description: "This passage contradicts the canon, the timeline or what happened before: find the contradiction and fix the passage so that it agrees with the book." },
      it: { name: "Incoerenza", description: "Questo passaggio contraddice il canone, la cronologia o ciò che è successo prima: trova la contraddizione e correggi il passaggio perché sia coerente con il libro." },
    },
  },
  {
    id: "expand",
    mark: { underline: "dotted", color: "sky", icon: "expand" },
    text: {
      en: { name: "To expand", description: "This passage is too thin: develop it (senses, gestures, thoughts, dialogue) without changing what happens." },
      it: { name: "Da espandere", description: "Questo passaggio è troppo esile: sviluppalo (sensi, gesti, pensieri, dialoghi) senza cambiare ciò che accade." },
    },
  },
  {
    id: "keep",
    mark: { underline: "solid", color: "emerald", icon: "star" },
    text: {
      en: { name: "Keep it", description: "The author likes this passage: keep it as it is in every rewrite, and learn from it." },
      it: { name: "Da tenere", description: "All'autore questo passaggio piace: tienilo com'è in ogni riscrittura, e prendilo a modello." },
    },
  },
];

export const BUILTIN_TAG_IDS: readonly string[] = BUILTIN_TAGS.map((tag) => tag.id);

/** The mark of a tag that is no longer defined (deleted in Settings, or a tag of another book): never only a colour, like every mark. */
export const MISSING_TAG_MARK: MarkStyle = { underline: "solid", color: "slate", icon: "question" };

export type AppLanguage = "en" | "it";

/** The language of the app as the tags know it: Italian, or English for anything else. */
export function appLanguage(language: string | undefined): AppLanguage {
  return language?.startsWith("it") ? "it" : "en";
}

export function builtinTag(id: string, language: AppLanguage): ResolvedTag | undefined {
  const tag = BUILTIN_TAGS.find((entry) => entry.id === id);
  if (!tag) return undefined;
  return { id: tag.id, scope: "builtin", ...tag.text[language], mark: tag.mark };
}

/**
 * Every tag an annotation of this book can have, in the order the menus show them: the built-in ones, the tags of every book in the order of Settings,
 * then the tags of this book by name. A tag of the book with the id of an earlier one is left out (ids are unique by construction: this only guards a
 * hand-edited file).
 */
export function tagCatalog(input: { language: AppLanguage; global?: readonly AnnotationTagDefinition[]; book?: readonly AnnotationTagDefinition[] }): ResolvedTag[] {
  const catalog: ResolvedTag[] = BUILTIN_TAGS.map((tag) => builtinTag(tag.id, input.language)!);
  const seen = new Set(catalog.map((tag) => tag.id));
  const add = (definitions: readonly AnnotationTagDefinition[], scope: "global" | "book") => {
    for (const definition of definitions) {
      if (definition.deletedAt || seen.has(definition.id) || !definition.name.trim()) continue;
      seen.add(definition.id);
      catalog.push({ id: definition.id, scope, name: definition.name.trim(), description: typeof definition.description === "string" ? definition.description : "", mark: normalizeMarkStyle(definition.mark) });
    }
  };
  add(input.global ?? [], "global");
  add([...(input.book ?? [])].sort((left, right) => left.name.localeCompare(right.name, input.language) || left.id.localeCompare(right.id)), "book");
  return catalog;
}

/** The tag of an annotation, or a stand-in that says the tag is gone: the annotation keeps its passage and its note. */
export function resolveTag(catalog: readonly ResolvedTag[], id: string, missingName: string): ResolvedTag {
  return catalog.find((tag) => tag.id === id) ?? { id, scope: "missing", name: missingName, description: "", mark: MISSING_TAG_MARK };
}

export const TAG_NAME_MAX = 40;
export const TAG_DESCRIPTION_MAX = 2000;
export const COMMENT_MAX = 4000;
/** The longest passage that can be marked: a scene's worth of text would make the file heavy and the mark meaningless. */
export const QUOTE_MAX = 3000;

/** The id of a new tag: readable in the files (a slug of its name) and unique (a short random part). */
export function createTagId(name: string, random: () => string = randomPart): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return `${slug || "tag"}-${random().slice(0, 4)}`;
}

/** The id of a new annotation: its time in base 36 (so a file sorted by id is in the order of creation) and a random part. */
export function createAnnotationId(now: number = Date.now(), random: () => string = randomPart): string {
  return `a-${now.toString(36)}-${random().slice(0, 6)}`;
}

function randomPart(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
}

export function isMarkStyle(value: unknown): value is MarkStyle {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (MARK_UNDERLINES as readonly unknown[]).includes(record.underline)
    && (MARK_COLORS as readonly unknown[]).includes(record.color)
    && (MARK_ICONS as readonly unknown[]).includes(record.icon);
}

/** A mark style that is always valid: what is unknown in it (a value of a newer app) is replaced by the stand-in's. */
export function normalizeMarkStyle(value: unknown): MarkStyle {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    underline: (MARK_UNDERLINES as readonly unknown[]).includes(record.underline) ? record.underline as MarkUnderline : MISSING_TAG_MARK.underline,
    color: (MARK_COLORS as readonly unknown[]).includes(record.color) ? record.color as MarkColor : MISSING_TAG_MARK.color,
    icon: (MARK_ICONS as readonly unknown[]).includes(record.icon) ? record.icon as MarkIcon : MISSING_TAG_MARK.icon,
  };
}

/**
 * The mark to write for a tag: what it shows, except where it still shows the stand-in for a value of a newer app (`stored`, as the data had it): that
 * value is written back as it was, so that an older app that changes something else of the tag does not take it away.
 */
export function markToWrite(stored: unknown, shown: MarkStyle): MarkStyle {
  if (!stored || typeof stored !== "object") return shown;
  const record = stored as Record<string, unknown>;
  const normalized = normalizeMarkStyle(record);
  const keep = <K extends keyof MarkStyle>(key: K): MarkStyle[K] => (typeof record[key] === "string" && record[key] !== normalized[key] && shown[key] === normalized[key]
    ? record[key] as MarkStyle[K]
    : shown[key]);
  return { underline: keep("underline"), color: keep("color"), icon: keep("icon") };
}

// ─── Counts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How many annotations wait for the author (open or later), in a chapter and in each of its scenes. */
export interface PendingCounts {
  total: number;
  byParagraph: Record<string, number>;
}

export function pendingCounts(annotations: readonly Annotation[]): PendingCounts {
  const counts: PendingCounts = { total: 0, byParagraph: {} };
  for (const annotation of annotations) {
    if (!isPendingStatus(annotationStatus(annotation.status))) continue;
    counts.total += 1;
    counts.byParagraph[annotation.paragraph] = (counts.byParagraph[annotation.paragraph] ?? 0) + 1;
  }
  return counts;
}
