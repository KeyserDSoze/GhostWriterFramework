import { assertSafeBookPath, isTextBookPath } from "narrarium-engine";

/**
 * What the file tools of the MCP endpoint may reach in a book. A list of what is allowed, not of what is not: a book's repository also holds
 * what tools and CI run (`.github/workflows`, `.vscode/tasks.json`, `.opencode/plugins`…), and a model that was talked into writing there would
 * be running code on the author's computer or in their GitHub account. Everything that starts with a dot is out, in every folder.
 *
 * Where the tools of the Scaletta (`outline/`) will be added later: `outline` is already here, so `read_file` and `write_file` reach it today.
 */
const ROOT_FILES: ReadonlySet<string> = new Set([
  "book.md", "context.md", "ideas.md", "notes.md", "plot.md", "promoted.md", "story-design.md", "director.md", "evaluation-guidelines.md",
]);

/** The folders of a book whose text files can be read. */
const FOLDERS: ReadonlySet<string> = new Set([
  "guidelines", "ghostwriters", "characters", "items", "locations", "factions", "timelines", "secrets", "chapters", "audit", "drafts", "scripts",
  "resumes", "state", "evaluations", "operations", "personas", "research", "deepresearches", "assets", "outline", "autopilot", "conversations",
]);

/**
 * Folders that can be read and not written: the autopilot's own files (its state and activity are changed only through the autopilot, and its plan
 * is generated from them) and the exports of conversations (a record of what was said).
 */
const READ_ONLY_FOLDERS: ReadonlySet<string> = new Set(["autopilot", "conversations"]);

export type PathVerdict =
  | { ok: true; path: string; writable: boolean }
  | { ok: false; code: "invalid_path" | "forbidden"; message: string };

const forbid = (message: string): PathVerdict => ({ ok: false, code: "forbidden", message });

/** What a path may be used for: normalized, readable, writable, or refused with the reason. */
export function judgePath(requested: string): PathVerdict {
  let path: string;
  try {
    path = assertSafeBookPath(requested);
  } catch {
    return { ok: false, code: "invalid_path", message: "That is not a path inside the book: use a relative path such as `notes.md` or `chapters/001-arrival/chapter.md`, with no `..`, no drive and no `.git`." };
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return forbid("Hidden files and folders (`.github`, `.vscode`, `.opencode`, `.gitignore`…) are not part of the book's text: this endpoint does not read or write them.");
  if (segments.length === 1 && FOLDERS.has(path)) return { ok: false, code: "invalid_path", message: `\`${path}\` is a folder: use list_files with \`directory\` to see what is in it.` };
  if (segments.length === 1 ? !ROOT_FILES.has(path) : !FOLDERS.has(segments[0])) {
    return forbid(`\`${segments[0]}\` is not one of the book's own files. They are: ${[...ROOT_FILES].join(", ")}, and the folders ${[...FOLDERS].join(", ")}.`);
  }
  if (!isTextBookPath(path)) return { ok: false, code: "invalid_path", message: "Only text files of a book (.md, .markdown, .txt, .json, .yaml, .yml) can be read or written." };
  return { ok: true, path, writable: segments.length === 1 || !READ_ONLY_FOLDERS.has(segments[0]) };
}

/** A folder to list: the same rules, for a folder (a trailing slash is fine, and so is no folder at all: the whole book). */
export function judgeFolder(requested: string): { ok: true; folder: string } | { ok: false; code: "invalid_path" | "forbidden"; message: string } {
  const text = requested.trim().replace(/\/+$/, "");
  if (!text) return { ok: true, folder: "" };
  const verdict = judgePath(`${text}/x.md`);
  return verdict.ok ? { ok: true, folder: verdict.path.slice(0, -"/x.md".length) } : verdict;
}

/** Whether a listed path of the book is one of the files these tools may read. */
export function readable(path: string): boolean {
  return judgePath(path).ok;
}
