import type { AutopilotStateSummary } from "narrarium-engine";

/** The pages of a book that correct the profile files the autopilot reads, in the order the author meets them (the evaluation style is `evaluation-guidelines.md`). */
export type ProfilePage = "director" | "ghostwriters" | "readers" | "evaluationStyle";

export const PROFILE_PAGES: readonly ProfilePage[] = ["director", "ghostwriters", "readers", "evaluationStyle"];

/** The profile files whose problems stop a run: each line of the engine begins with one of them. */
const PROFILE_FILE = String.raw`(?:director\.md|evaluation-guidelines\.md|(?:ghostwriters|personas)\/[^\s:]+\.md)`;

/**
 * A run that waits for the author without a question to answer: the engine stops this way when a profile file (the director,
 * a ghostwriter, a simulated reader) has problems, before it spends anything. A director's question is `waiting-author` too, but it
 * carries the question; and so is a design that waits for the author to choose a pitch, which says so (`design.choosePitch`).
 */
export function isProfileProblemStop(summary: Pick<AutopilotStateSummary, "status" | "question" | "design"> | null | undefined): boolean {
  return summary?.status === "waiting-author" && !summary.question && !summary.design?.choosePitch;
}

/** The engine joins the problems of its message with this, after a heading, and says how many more there are in brackets. */
const SEPARATOR = " · ";
/** Where the first problem starts: every problem begins with the file it is about. */
const FIRST_PROBLEM = new RegExp(`${PROFILE_FILE}:\\s`);
/** The engine's own heading, in the two languages it writes in: the page has its own. */
const ENGINE_HEADING = /^(?:Correct (?:this profile|these profiles) before resuming|Correggi (?:il profilo|i profili) prima di riprendere):/;
/** "(and 4 more)" and "(e altri 4)": the problems the message does not list. */
const AND_MORE = /\s*(\((?:and \d+ more|e altri \d+)\))$/;

/**
 * The message of a run stopped for its profile files as lines to read: one for each problem, without the engine's heading and
 * with the count of the problems it does not list on a line of its own. Whatever the message says that is not recognised stays,
 * so nothing is ever lost.
 */
export function problemLines(message: string | null | undefined): string[] {
  const text = message?.trim();
  if (!text) return [];
  const parts = text.split(SEPARATOR);
  const lines: string[] = [];
  const first = FIRST_PROBLEM.exec(parts[0]);
  if (first && first.index > 0) {
    const heading = parts[0].slice(0, first.index).trim();
    if (!ENGINE_HEADING.test(heading)) lines.push(heading);
    parts[0] = parts[0].slice(first.index);
  }
  lines.push(...parts);
  const more = AND_MORE.exec(lines[lines.length - 1]);
  if (more && more.index > 0) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, more.index);
    lines.push(more[1]);
  }
  return lines.map((line) => line.trim()).filter(Boolean);
}

/** Whether a line is a problem of the engine (always English, naming a file) and not a sentence of the book's language. */
export function isProblemLine(line: string): boolean {
  return new RegExp(`^${PROFILE_FILE}:\\s`).test(line);
}

/**
 * The pages that correct the files the lines name, once each and in the order of the pages. When none is named in a way that is
 * recognised, all of them: the author is never left without a way to the files.
 */
export function profilePagesFor(lines: readonly string[]): ProfilePage[] {
  const found = new Set<ProfilePage>();
  for (const line of lines) {
    if (/^director\.md\b/.test(line)) found.add("director");
    else if (/^ghostwriters\//.test(line)) found.add("ghostwriters");
    else if (/^personas\//.test(line)) found.add("readers");
    else if (/^evaluation-guidelines\.md\b/.test(line)) found.add("evaluationStyle");
  }
  return found.size ? PROFILE_PAGES.filter((page) => found.has(page)) : [...PROFILE_PAGES];
}

export function profilePageRoute(bookId: string, page: ProfilePage): string {
  const root = `/app/books/${encodeURIComponent(bookId)}`;
  if (page === "director") return `${root}/director`;
  if (page === "evaluationStyle") return `${root}/evaluation-style`;
  return page === "ghostwriters" ? `${root}/ghostwriters` : `${root}/simulated-readers`;
}

/**
 * The page of the site that opens a file of the book, or `null` when there is none (or the path leaves the book): a route is never
 * made up for a file the site has no page for. The same files the audit opens, plus the profiles and the chapter documents.
 */
export function bookFileRoute(bookId: string, path: string | null | undefined): string | null {
  if (!path || path.includes("\\")) return null;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  const root = `/app/books/${encodeURIComponent(bookId)}`;
  const encode = encodeURIComponent;
  if (path === "book.md") return root;
  if (path === "director.md") return `${root}/director`;
  if (path === "evaluation-guidelines.md") return `${root}/evaluation-style`;
  if (path === "outline/book.md") return `${root}/outline`;
  if (/^ghostwriters\/[^/]+\.md$/.test(path)) return `${root}/ghostwriters`;
  if (/^personas\/[^/]+\.md$/.test(path)) return `${root}/simulated-readers`;
  let match: RegExpExecArray | null;
  if ((match = /^outline\/chapters\/(\d+)\.md$/.exec(path)) && Number(match[1]) > 0) return `${root}/outline#outline-chapter-${Number(match[1])}`;
  if ((match = /^(characters|locations|factions|items|secrets)\/([^/]+)\.md$/.exec(path))) return `${root}/canon/${match[1]}/${encode(match[2])}`;
  if ((match = /^timelines\/events\/([^/]+)\.md$/.exec(path))) return `${root}/canon/timelines/${encode(match[1])}`;
  if ((match = /^chapters\/([^/]+)\/chapter\.md$/.exec(path))) return `${root}/chapters/${encode(match[1])}`;
  if ((match = /^chapters\/([^/]+)\/(\d{3})(?:-[^/]+)?\.md$/.exec(path))) return `${root}/chapters/${encode(match[1])}/paragraphs/${match[2]}`;
  if ((match = /^resumes\/chapters\/([^/]+)\.md$/.exec(path))) return `${root}/chapters/${encode(match[1])}/workspace/resume`;
  if ((match = /^evaluations\/chapters\/([^/]+)\.md$/.exec(path))) return `${root}/chapters/${encode(match[1])}/workspace/evaluation`;
  if ((match = /^drafts\/([^/]+)\/chapter\.md$/.exec(path))) return `${root}/chapters/${encode(match[1])}/workspace/draft`;
  return null;
}

export interface ErrorFile {
  path: string;
  /** The message is the engine's refusal to rewrite a file whose front matter it cannot read: correcting that line is the way out. */
  frontmatter: boolean;
}

/** The refusal of the engine, in both languages: it names the file, which may have spaces in it, and the line. */
const REFUSAL = /(?:frontmatter of|frontmatter di) (.+?) \((?:line|riga) \d+: /g;
/**
 * A Markdown file named in a message, in any script, without the end of the sentence it ends. The character before it (group 1) is
 * not part of a name; there is no look-behind, which older browsers cannot even parse.
 */
const MARKDOWN_FILE = /(^|[^\p{L}\p{N}_./-])((?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]+\.md)(?![\p{L}\p{N}_-])/gu;

/** The files of the book a message names, once each, in the order it names them. */
export function filesInError(message: string | null | undefined): ErrorFile[] {
  const text = message ?? "";
  const found: Array<ErrorFile & { at: number }> = [];
  for (const match of text.matchAll(REFUSAL)) {
    if (!found.some((file) => file.path === match[1])) found.push({ path: match[1], frontmatter: true, at: match.index ?? 0 });
  }
  const refused = found.map((file) => file.path);
  for (const match of text.matchAll(MARKDOWN_FILE)) {
    const path = match[2];
    // A piece of a path that has a space in it is not a file of its own.
    if (found.some((file) => file.path === path) || refused.some((known) => known.includes(path))) continue;
    found.push({ path, frontmatter: false, at: (match.index ?? 0) + match[1].length });
  }
  return found.sort((left, right) => left.at - right.at).map(({ path, frontmatter }) => ({ path, frontmatter }));
}
