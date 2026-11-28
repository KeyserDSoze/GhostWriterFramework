/**
 * A book with annotations for the tests of the pages that work on them: two chapters, three scenes, five annotations in different states, and a tag of
 * the book. The files are written the way the app writes them, so that the pages read them as they would read a real book.
 */

export const GATE = "001-the-gate";
export const BELL = "002-the-bell";
export const OPENING = "The gate stood open beneath a sky the color of old steel. Mara waited by the wall, counting the lanterns one by one, and nobody came.";
export const COURTYARD = "Inside, the courtyard smelled of rain and oranges. Somebody had left a lamp burning in the gatehouse window.";
export const RINGING = "The bell rang at dawn. Nobody had touched the rope.";

export function annotationEntry(chapter: string, id: string, paragraph: string, text: string, quote: string, extra: Record<string, string | Record<string, string>> = {}, offset?: number): string {
  const at = offset ?? text.indexOf(quote);
  const fields: Record<string, string | Record<string, string>> = { tag: "rewrite", comment: "", status: "open", ...extra };
  const lines = [
    `  - id: ${id}`,
    `    paragraph: paragraph:${chapter}:${paragraph}`,
    `    quote: ${JSON.stringify(quote)}`,
    `    prefix: ${JSON.stringify(text.slice(Math.max(0, at - 32), at))}`,
    `    suffix: ${JSON.stringify(text.slice(at + quote.length, at + quote.length + 32))}`,
    `    offset: ${at}`,
  ];
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") lines.push(`    ${key}: ${JSON.stringify(value)}`);
    else lines.push(`    ${key}:`, ...Object.entries(value).map(([name, inner]) => `      ${name}: ${JSON.stringify(inner)}`));
  }
  lines.push("    createdAt: 2026-11-25T10:00:00.000Z", "    updatedAt: 2026-11-25T10:00:00.000Z", "    createdOnDevice: d-1a2b3c4d");
  return lines.join("\n");
}

export const annotationsFile = (chapter: string, entries: string[]) => ["version: 1", `chapter: chapter:${chapter}`, "annotations:", ...entries, ""].join("\n");

export const IDS = { steel: "a-mi4k2000-aaaaaa", lanterns: "a-mi4k3000-bbbbbb", oranges: "a-mi4k4000-cccccc", gone: "a-mi4k5000-dddddd", rope: "a-mi4k6000-eeeeee" } as const;

export const GATE_ANNOTATIONS = annotationsFile(GATE, [
  annotationEntry(GATE, IDS.steel, "001-opening", OPENING, "the color of old steel", { comment: "Too familiar an image: find one of hers." }),
  annotationEntry(GATE, IDS.lanterns, "001-opening", OPENING, "counting the lanterns one by one", { tag: "keep", status: "handled", comment: "Done already.", resolution: { by: "ai", at: "2026-11-26T08:00:00.000Z", summary: "Rewrote the count." } }),
  annotationEntry(GATE, IDS.oranges, "002-the-courtyard", COURTYARD, "smelled of rain and oranges", { tag: "slow-pace-k3x9", status: "later", comment: "Shorter." }),
  // Cut from the text since: it was after the first passage.
  annotationEntry(GATE, IDS.gone, "001-opening", "The gate stood open beneath a sky the color of old steel. Somewhere far off there was a bell that nobody rang, ever, in all those years.", "a bell that nobody rang", { tag: "dislike", comment: "Cut in the last pass." }),
]);
export const BELL_ANNOTATIONS = annotationsFile(BELL, [
  annotationEntry(BELL, IDS.rope, "001-ringing", RINGING, "Nobody had touched the rope", { tag: "inconsistency", comment: "Who rang it, then? Mara was at the wall." }),
]);

export const BOOK_TAGS = "version: 1\ntags:\n  - id: slow-pace-k3x9\n    name: Slow pace\n    description: Cut what does not move the scene.\n    mark:\n      underline: dotted\n      color: teal\n      icon: clock\n    createdAt: 2026-11-25T10:00:00.000Z\n    updatedAt: 2026-11-25T10:00:00.000Z\n";

const scene = (chapter: string, slug: string, number: number, title: string, text: string) => ({
  path: `chapters/${chapter}/${slug}.md`,
  content: `---\ntype: paragraph\nid: paragraph:${chapter}:${slug}\nchapter: chapter:${chapter}\nnumber: ${number}\ntitle: ${title}\n---\n\n${text}\n`,
});

export const BOOK_FILES = [
  { path: `chapters/${GATE}/chapter.md`, content: `---\ntype: chapter\nid: chapter:${GATE}\nnumber: 1\ntitle: The Gate\n---\n\nThe first chapter.\n` },
  scene(GATE, "001-opening", 1, "Opening", OPENING),
  scene(GATE, "002-the-courtyard", 2, "The courtyard", COURTYARD),
  { path: `chapters/${BELL}/chapter.md`, content: `---\ntype: chapter\nid: chapter:${BELL}\nnumber: 2\ntitle: The Bell\n---\n\nThe second chapter.\n` },
  scene(BELL, "001-ringing", 1, "The ringing", RINGING),
  { path: `annotations/chapters/${GATE}.yml`, content: GATE_ANNOTATIONS },
  { path: `annotations/chapters/${BELL}.yml`, content: BELL_ANNOTATIONS },
  { path: "annotations/tags.yml", content: BOOK_TAGS },
];
