import {
  BIBLE_DECISIONS_FILE,
  BIBLE_THEMES_FILE,
  BIBLE_THREADS_FILE,
  BIBLE_WORLD_FILE,
  CONTEXT_FILE,
  STORY_DESIGN_FILE,
  designFindings,
  outlineDesignGaps,
  readBibleDecisions,
  readBibleThreads,
  referencedChapterNumber,
  parseMarkdown,
  readBibleThemes,
  readBibleWorld,
  ledgerChapter,
  readSecretLedger,
  type AutopilotState,
  type BibleDecisions,
  type BibleThemes,
  type BibleThreads,
  type BibleWorld,
  type DesignCheckTimelineEvent,
  type DesignFinding,
  type OutlineChapterEntry,
  type SecretLedger,
} from "narrarium-engine";
import type { OutlineFile } from "@/outline/outlineModel";

/**
 * The Bible of a book, composed from its own files: the description and the Synopsis (`outline/`), the story design and the world context, the cast, the places,
 * the factions, the items and the secrets with their ledger, and the two files of `bible/` that hold what has no other home (the themes and the tone, the rules of
 * the world). Nothing is copied: the Bible reads, and each part is edited where it lives. The deterministic checks of the design are the engine's (`designChecks`).
 */

/** The folders of the canon the Bible reads, in the order it shows them. */
export const BIBLE_FOLDERS = ["characters/", "locations/", "factions/", "items/", "secrets/", "bible/", "timelines/", "guidelines/"] as const;
/** The files at the root of the book it reads. */
export const BIBLE_ROOT_FILES = [STORY_DESIGN_FILE, CONTEXT_FILE] as const;

export type BibleSection = "characters" | "locations" | "factions" | "items";

export interface BibleCanonEntry {
  path: string;
  slug: string;
  name: string;
  /** The first lines of its body, without its heading. */
  summary: string;
  /** The fields worth a line, as label keys and values (the labels are the interface's). */
  facts: Array<{ key: string; value: string }>;
}

export interface BibleSecret {
  path: string;
  slug: string;
  title: string;
  truth: string;
  holders: string[];
  /** The chapter that reveals it: `reveal_in`, else the one the plan of the autopilot gives it (`planned`). */
  revealChapter?: number;
  planned: boolean;
  knownFrom?: number;
  ledger: SecretLedger;
}

/** An event of the timeline, as the Bible shows it. */
export interface BibleTimelineEvent extends DesignCheckTimelineEvent {
  path: string;
  /** The first lines of its text. */
  summary: string;
}

/** A guideline of the book (`guidelines/`), as the Bible shows it. */
export interface BibleGuideline {
  path: string;
  slug: string;
  title: string;
  summary: string;
}

export interface BibleData {
  storyDesign: string;
  context: string;
  themes: BibleThemes;
  themesFile?: OutlineFile;
  world: BibleWorld;
  worldFile?: OutlineFile;
  /** The decisions and the open questions (`bible/decisions.md`), and the problems found reading the file. */
  decisions: BibleDecisions;
  decisionsFile?: OutlineFile;
  decisionsProblems: string[];
  /** The threads of setup and payoff (`bible/threads.md`). */
  threads: BibleThreads;
  threadsFile?: OutlineFile;
  /** The events of the timeline, in the order of their dates (those without a date last, by title). */
  timeline: BibleTimelineEvent[];
  guidelines: BibleGuideline[];
  canon: Record<BibleSection, BibleCanonEntry[]>;
  secrets: BibleSecret[];
  /** The findings of the checks of the design (the secrets and the entries), and the designs that lack a key field. */
  findings: DesignFinding[];
}

const slugOf = (path: string) => path.split("/").pop()!.replace(/\.md$/i, "");

/** The body of a canon file without its heading, on one line, cut to `max` characters. */
function summaryOf(body: string, max = 280): string {
  const text = body.replace(/^#[^\n]*\n+/, "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" || typeof item === "number").map(String).join("; ");
  return "";
}

/** The fields of each kind that the Bible shows, in order: the keys of the frontmatter (the label is `design.bible.fields.<key>`). */
const FACTS: Record<BibleSection, readonly string[]> = {
  characters: ["story_role", "role_tier", "arc", "desires", "fears", "relationships", "function_in_book"],
  locations: ["atmosphere", "function_in_book"],
  factions: ["mission", "function_in_book"],
  items: ["significance", "function_in_book"],
};

/** The Bible of the files read (`files`: the folders of `BIBLE_FOLDERS` and the files of `BIBLE_ROOT_FILES`), with the entries of the Synopsis and the state of the autopilot. */
export function composeBible(input: { files: readonly OutlineFile[]; entries: readonly OutlineChapterEntry[]; state: Pick<AutopilotState, "concept" | "plan"> | null }): BibleData {
  const byPath = new Map(input.files.map((file) => [file.path, file]));
  const canon: BibleData["canon"] = { characters: [], locations: [], factions: [], items: [] };
  for (const section of Object.keys(canon) as BibleSection[]) {
    for (const file of input.files) {
      if (!file.path.startsWith(`${section}/`) || !file.path.endsWith(".md") || file.path.split("/").length !== 2) continue;
      const document = parseMarkdown(file.content);
      const name = textOf(document.frontmatter.name) || textOf(document.frontmatter.title) || slugOf(file.path);
      const facts = FACTS[section].map((key) => ({ key, value: textOf(document.frontmatter[key]) })).filter((fact) => fact.value);
      canon[section].push({ path: file.path, slug: slugOf(file.path), name, summary: summaryOf(document.body), facts });
    }
    canon[section].sort((left, right) => left.name.localeCompare(right.name));
  }
  const planned = new Map((input.state?.concept.secrets ?? []).map((secret) => [secret.slug, secret.revealChapter]));
  const secrets: BibleSecret[] = [];
  for (const file of input.files) {
    if (!/^secrets\/[^/]+\.md$/.test(file.path)) continue;
    const document = parseMarkdown(file.content);
    const slug = slugOf(file.path);
    const revealIn = ledgerChapter(textOf(document.frontmatter.reveal_in)) || undefined;
    const knownFrom = ledgerChapter(textOf(document.frontmatter.known_from)) || undefined;
    const plan = planned.get(slug);
    const holders = Array.isArray(document.frontmatter.holders) ? document.frontmatter.holders.filter((item): item is string => typeof item === "string") : [];
    secrets.push({
      path: file.path,
      slug,
      title: textOf(document.frontmatter.title) || textOf(document.frontmatter.name) || slug,
      truth: summaryOf(document.body, 600),
      holders,
      ...(revealIn ? { revealChapter: revealIn } : plan ? { revealChapter: plan } : knownFrom ? { revealChapter: knownFrom } : {}),
      planned: !revealIn && Boolean(plan),
      ...(knownFrom ? { knownFrom } : {}),
      ledger: readSecretLedger(document.frontmatter).ledger,
    });
  }
  secrets.sort((left, right) => (left.revealChapter ?? Number.MAX_SAFE_INTEGER) - (right.revealChapter ?? Number.MAX_SAFE_INTEGER) || left.title.localeCompare(right.title));
  const entries = input.entries.map((entry) => ({ number: entry.number, title: entry.title, ...(entry.design ? { design: entry.design } : {}) }));
  const lastPlanned = (input.state?.plan?.chapters ?? []).reduce((highest, chapter) => Math.max(highest, chapter.number), 0);
  const lastEntry = entries.reduce((highest, entry) => Math.max(highest, entry.number), 0);
  const threadsFile = byPath.get(BIBLE_THREADS_FILE);
  const decisionsFile = byPath.get(BIBLE_DECISIONS_FILE);
  const threads = readBibleThreads(threadsFile?.content).value;
  const decisions = readBibleDecisions(decisionsFile?.content);
  const timeline = timelineOf(input.files);
  const findings = [
    ...designFindings({
      chapters: entries,
      secrets: secrets.map((secret) => ({ slug: secret.slug, title: secret.title, holders: secret.holders, ledger: secret.ledger, ...(secret.revealChapter ? { revealChapter: secret.revealChapter } : {}), ...(secret.knownFrom ? { knownFromChapter: secret.knownFrom } : {}) })),
      characters: canon.characters.map((entry) => ({ slug: entry.slug, name: entry.name, aliases: aliasesOf(byPath.get(entry.path)) })),
      locations: canon.locations.map((entry) => ({ slug: entry.slug, name: entry.name, aliases: aliasesOf(byPath.get(entry.path)) })),
      timeline,
      threads: threads.threads,
      lastChapter: Math.max(lastEntry, lastPlanned),
    }),
    ...outlineDesignGaps(entries),
  ];
  const themesFile = byPath.get(BIBLE_THEMES_FILE);
  const worldFile = byPath.get(BIBLE_WORLD_FILE);
  return {
    storyDesign: parseMarkdown(byPath.get(STORY_DESIGN_FILE)?.content ?? "").body,
    context: parseMarkdown(byPath.get(CONTEXT_FILE)?.content ?? "").body,
    themes: readBibleThemes(themesFile?.content),
    ...(themesFile ? { themesFile } : {}),
    world: readBibleWorld(worldFile?.content),
    ...(worldFile ? { worldFile } : {}),
    decisions: decisions.value,
    ...(decisionsFile ? { decisionsFile } : {}),
    decisionsProblems: decisions.problems,
    threads,
    ...(threadsFile ? { threadsFile } : {}),
    timeline,
    guidelines: guidelinesOf(input.files),
    canon,
    secrets,
    findings,
  };
}

const dayText = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value).trim() : value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : "");

/** The events of the timeline (`timelines/events/`): the chapter an event is anchored to is `reveal_in`, else `known_from`. */
function timelineOf(files: readonly OutlineFile[]): BibleTimelineEvent[] {
  const events: BibleTimelineEvent[] = [];
  for (const file of files) {
    if (!/^timelines\/events\/[^/]+\.md$/.test(file.path)) continue;
    const document = parseMarkdown(file.content);
    const slug = slugOf(file.path);
    const date = dayText(document.frontmatter.date);
    const participants = Array.isArray(document.frontmatter.participants) ? document.frontmatter.participants.filter((item): item is string => typeof item === "string") : [];
    const chapter = referencedChapterNumber(textOf(document.frontmatter.reveal_in)) ?? referencedChapterNumber(textOf(document.frontmatter.known_from));
    events.push({ slug, path: file.path, title: textOf(document.frontmatter.title) || textOf(document.frontmatter.name) || slug, ...(date ? { date } : {}), participants, ...(chapter ? { chapter } : {}), summary: summaryOf(document.body) });
  }
  return events.sort((left, right) => (left.date && right.date ? left.date.localeCompare(right.date) : left.date ? -1 : right.date ? 1 : 0) || left.title.localeCompare(right.title));
}

function guidelinesOf(files: readonly OutlineFile[]): BibleGuideline[] {
  const guidelines: BibleGuideline[] = [];
  for (const file of files) {
    if (!/^guidelines\/[^/]+\.md$/.test(file.path)) continue;
    const document = parseMarkdown(file.content);
    const slug = slugOf(file.path);
    guidelines.push({ path: file.path, slug, title: textOf(document.frontmatter.title) || textOf(document.frontmatter.name) || slug, summary: summaryOf(document.body, 400) });
  }
  return guidelines.sort((left, right) => left.title.localeCompare(right.title));
}

function aliasesOf(file: OutlineFile | undefined): string[] {
  if (!file) return [];
  const aliases = parseMarkdown(file.content).frontmatter.aliases;
  return Array.isArray(aliases) ? aliases.filter((item): item is string => typeof item === "string") : [];
}

/** How many entries of the world the Bible has: the places, the factions and the items. */
export function worldEntries(data: Pick<BibleData, "canon">): number {
  return data.canon.locations.length + data.canon.factions.length + data.canon.items.length;
}

/** The canon page of an entry of the Bible, where it is edited. */
export function canonHref(bookId: string, path: string): string {
  const [section, file] = path.split("/");
  return `/app/books/${encodeURIComponent(bookId)}/canon/${section}/${encodeURIComponent(file.replace(/\.md$/i, ""))}`;
}
