import { OUTLINE_BRIEF_FILE, clipText, type OutlineBriefReading } from "narrarium-engine";

/** Characters of the idea and of the synopsis the MCP tools show: the whole of each is in the book's files, which `read_outline` and `read_file` read in pages. */
export const BRIEF_IDEA_EXCERPT = 1200;
export const BRIEF_SYNOPSIS_EXCERPT = 600;

/**
 * The brief of the book as the MCP tools show it: the idea (the description of the book), the genre, the audience, the words of a scene, an
 * excerpt of the synopsis, and the number of chapters the Scaletta has (the brief has no number of chapters: the chapter entries of the
 * outline are the chapters). An excerpt says so: `ideaLength` and `ideaTruncated` tell how much of the idea the answer holds.
 */
export function briefView(reading: OutlineBriefReading, chapters: number): Record<string, unknown> {
  const idea = reading.brief.idea;
  return {
    path: OUTLINE_BRIEF_FILE,
    present: reading.hash !== undefined,
    ...(reading.hash ? { hash: reading.hash } : {}),
    ...(reading.unreadable ? { unreadable: true } : {}),
    ...(reading.bookUnreadable ? { ideaUnreadable: true } : {}),
    idea: clipText(idea, BRIEF_IDEA_EXCERPT),
    ideaLength: idea.length,
    ideaTruncated: idea.length > BRIEF_IDEA_EXCERPT,
    genre: reading.brief.genre,
    audience: reading.brief.audience,
    wordsPerScene: reading.brief.wordsPerScene,
    synopsisExcerpt: clipText(reading.brief.synopsis, BRIEF_SYNOPSIS_EXCERPT),
    synopsisLength: reading.brief.synopsis.length,
    chapters,
  };
}
