import {
  OUTLINE_COMPOSE_MAX_EDITS,
  OUTLINE_COMPOSE_MAX_FILES,
  OutlineComposeError,
  composeOutlineEdits,
  outlineEditNeedsHash,
  type ComposedOutlineEdits,
  type OutlineEntryInput,
  type OutlineSeriesEdit,
  type OutlineSeriesStep,
  type OutlineSource,
} from "narrarium-engine";
import { ToolError, conflictError, expectedHashOf } from "./mcp-kit.js";

/**
 * The edits of the outline (the Scaletta) as the MCP tool takes them, and what the tool says of them. The series is the engine's (`composeOutlineEdits`): each edit made on the
 * outline the one before left, the identity of every entry followed through the renumbering so that the hash a client read is checked against its own entry, only the files
 * that are needed read, one commit; the Outline page of the web app composes its edits with the same function. What stays here is what is the tool's: the shape of an edit
 * (`OutlineToolEdit`: flat, with a `kind`, as a model writes it), the rule that a text, an entry or a description is replaced only by someone who read it, and the words.
 */

/** Edits one call may make. */
export const OUTLINE_EDIT_MAX_EDITS = OUTLINE_COMPOSE_MAX_EDITS;
/** Files one call may change: an insert at the head of a long outline renames all of it, and that is for the app, where the author sees it and can undo it. */
export const OUTLINE_EDIT_MAX_FILES = OUTLINE_COMPOSE_MAX_FILES;

export type OutlineEditKind = "append" | "insert" | "move" | "remove" | "update" | "book";
export const OUTLINE_EDIT_KINDS: readonly OutlineEditKind[] = ["append", "insert", "move", "remove", "update", "book"];

/** An edit as a call gives it: its kind and what the kind takes. */
export interface OutlineToolEdit {
  kind: OutlineEditKind;
  at?: number;
  from?: number;
  to?: number;
  number?: number;
  renumber?: boolean;
  title?: string;
  body?: string;
  /** `null` (or an empty text) takes the ghostwriter away: the book's own writes the chapter. */
  ghostwriter?: string | null;
  expectedHash?: string;
}

const TAKES: Readonly<Record<OutlineEditKind, readonly string[]>> = {
  append: ["title", "body", "ghostwriter"],
  insert: ["at", "title", "body", "ghostwriter"],
  move: ["from", "to"],
  remove: ["number", "renumber", "expectedHash"],
  update: ["number", "title", "body", "ghostwriter", "expectedHash"],
  book: ["title", "body", "expectedHash"],
};
const REQUIRED: Readonly<Record<OutlineEditKind, readonly string[]>> = { append: [], insert: ["at"], move: ["from", "to"], remove: ["number"], update: ["number"], book: [] };

const invalid = (message: string): ToolError => new ToolError("invalid_input", message);

/** The edits of a call, looked at before anything is read: each kind takes its own properties, the ones it needs are there, and the one that is not for it is named. */
export function checkOutlineEdits(value: unknown): OutlineToolEdit[] {
  if (!Array.isArray(value)) throw invalid("`edits` must be a list of edits.");
  if (value.length === 0) throw invalid("There is nothing to do: send at least one edit.");
  if (value.length > OUTLINE_EDIT_MAX_EDITS) throw invalid(`A call makes at most ${OUTLINE_EDIT_MAX_EDITS} edits: send the rest in another call.`);
  return value.map((edit, index) => checkEdit(edit, index));
}

function checkEdit(value: unknown, index: number): OutlineToolEdit {
  const where = `edits[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${where} must be an object: an edit has a \`kind\` and what the kind takes.`);
  const edit = value as Record<string, unknown>;
  const kind = edit.kind;
  if (typeof kind !== "string" || !(OUTLINE_EDIT_KINDS as readonly string[]).includes(kind)) {
    throw invalid(`${where}: ${typeof kind === "string" ? `"${kind.slice(0, 40)}"` : "that"} is not a kind of edit; the kinds are: ${OUTLINE_EDIT_KINDS.join(", ")}.`);
  }
  const typed = kind as OutlineEditKind;
  const takes = TAKES[typed];
  for (const key of Object.keys(edit)) {
    if (key === "kind" || takes.includes(key)) continue;
    const hash = key === "expectedHash" ? ` (${typed === "move" ? "a move changes no text" : `${typed === "append" ? "an appended" : "an inserted"} chapter is a new entry, which has no hash yet`})` : "";
    throw invalid(`${where} (${typed}) does not take \`${key}\`${hash}; ${typed} takes: ${takes.join(", ")}.`);
  }
  for (const key of REQUIRED[typed]) if (edit[key] === undefined) throw invalid(`${where} (${typed}): \`${key}\` is required.`);
  if (typed === "update" && edit.title === undefined && edit.body === undefined && edit.ghostwriter === undefined) throw invalid(`${where} (update) changes nothing: pass title, body or ghostwriter.`);
  if (typed === "book" && edit.title === undefined && edit.body === undefined) throw invalid(`${where} (book) changes nothing: pass title or body.`);
  if (edit.expectedHash !== undefined) {
    try {
      expectedHashOf(edit.expectedHash);
    } catch (error) {
      throw invalid(`${where} (${typed}): ${error instanceof Error ? error.message : "`expectedHash` is not a hash."}`);
    }
  }
  return edit as unknown as OutlineToolEdit;
}

// ─── The tool's edit as the engine's ───────────────────────────────────────

const entryOf = (edit: OutlineToolEdit): OutlineEntryInput => ({
  ...(edit.title !== undefined ? { title: edit.title } : {}),
  ...(edit.body !== undefined ? { body: edit.body } : {}),
  ...(edit.ghostwriter !== undefined ? { ghostwriter: edit.ghostwriter } : {}),
});

/** The edit of a call as the engine takes it in a series: the fields it gave, and the hash it was given (`checkOutlineEdits` has seen that the kind takes what is there). */
function seriesEditOf(edit: OutlineToolEdit): OutlineSeriesEdit {
  const hash = edit.expectedHash === undefined ? {} : { expectedHash: edit.expectedHash };
  switch (edit.kind) {
    case "append":
      return { kind: "append", entry: entryOf(edit) };
    case "insert":
      return { kind: "insert", at: edit.at as number, entry: entryOf(edit) };
    case "move":
      return { kind: "move", from: edit.from as number, to: edit.to as number };
    case "remove":
      return { kind: "remove", number: edit.number as number, ...(edit.renumber === true ? { renumber: true } : {}), ...hash };
    case "update":
      return { kind: "update", number: edit.number as number, entry: entryOf(edit), ...hash };
    default:
      return { kind: "book", ...(edit.title !== undefined ? { title: edit.title } : {}), ...(edit.body !== undefined ? { body: edit.body } : {}), ...hash };
  }
}

// ─── What the tool says ────────────────────────────────────────────────────

/** What an edit did, in a line, in the order of the series: what the answer calls `applied`, and what the commit says. */
export function appliedLine(step: OutlineSeriesStep): string {
  switch (step.kind) {
    case "append":
      return `append chapter ${step.number}`;
    case "insert":
      return `insert chapter ${step.at} (the following chapters move up one number)`;
    case "move":
      return step.unchanged ? `move chapter ${step.from} to ${step.to} (it is there already)` : `move chapter ${step.from} to ${step.to}`;
    case "remove":
      return `remove chapter ${step.number} (the following chapters ${step.renumber ? "move down one number" : "keep their numbers"})`;
    case "update":
      return `${step.created ? "create" : "update"} chapter ${step.number}: ${step.fields.map((field) => (field === "body" ? "text" : field)).join(", ")}`;
    default:
      return `${step.created ? "write" : "update"} the description of the book: ${step.fields.map((field) => (field === "body" ? "text" : field)).join(", ")}`;
  }
}

/** The edit as a message names it: its place in the call, and what it is. */
function whereIs(index: number, edit: OutlineToolEdit | undefined): string {
  const at = `edits[${index}]`;
  switch (edit?.kind) {
    case "move":
      return `${at} (move chapter ${edit.from} to ${edit.to})`;
    case "remove":
    case "update":
      return `${at} (${edit.kind} chapter ${edit.number})`;
    case "book":
      return `${at} (book)`;
    default:
      return at;
  }
}

/** The words of the tool for what the engine refused: the same codes, naming the edit by its place in the call and the tools that read what it needs. */
function toolErrorOf(error: OutlineComposeError, edits: readonly OutlineToolEdit[]): ToolError {
  const edit = error.index === undefined ? undefined : edits[error.index];
  const where = error.index === undefined ? "" : whereIs(error.index, edit);
  const label = error.subject === "book" ? "the description of the book" : `chapter ${error.number}`;
  switch (error.code) {
    case "not_found":
      return new ToolError("not_found", `${where}: the outline has no entry for chapter ${error.number}. read_outline lists the chapters that have one.`);
    case "expected_hash_required": {
      const replaces = edit?.kind === "remove" ? "an entry is removed only by someone who has read it" : edit?.kind === "book" ? "a new description replaces a whole text" : "a new text replaces a whole text";
      const readWith = edit?.kind === "book" ? "read_outline" : "read_outline_entry";
      return new ToolError("expected_hash_required", `${where}: ${replaces}, so pass the hash that ${readWith} gave for ${error.path} as expectedHash: that way a change made meanwhile is never overwritten. Read it first with ${readWith}.`);
    }
    case "conflict":
      if (error.reason === "removed") return new ToolError("conflict", `${where}: ${label} has no entry now (${error.path}), so the hash you gave cannot be its: it was removed since you read it. Read the outline again and retry. Nothing was written.`);
      if (error.reason === "made-in-series") return new ToolError("conflict", `${where}: ${label} is a new entry made by an earlier edit of this call, so the hash you gave (of an entry you read) is not its: the numbers of a series count the edits before them. Nothing was written.`);
      if (error.reason === "changed") return new ToolError("conflict", `${where}: the file changed since you read it (${error.path}): read it again and retry. Nothing was written.`);
      return conflictError(error.path ?? "the file");
    case "too_many_files":
      return new ToolError("too_many_files", `This change would touch at least ${error.count} files of the outline, and one call may touch at most ${error.limit}: ask the author to make it in the Narrarium app (the Outline page, where it can be undone), or make it in smaller steps. Nothing was written.`);
    case "too_many_edits":
      return invalid(`A call makes at most ${error.limit} edits: send the rest in another call.`);
    default:
      return invalid(error.message);
  }
}

export interface ComposedToolEdits extends ComposedOutlineEdits {
  /** One line for each edit, in order, saying what it did. */
  applied: string[];
}

/**
 * Make the edits of a call, in order, as the files of one commit (the engine's `composeOutlineEdits`, asked for the rule of this tool: the text of an entry that exists, an entry
 * that is deleted and the description of the book are replaced only with the hash that was read). Throws a `ToolError` for an edit that cannot be made (`not_found`), one whose
 * hash is missing (`expected_hash_required`) or is not the entry's (`conflict`), and a series that would change more than `maxFiles` files (`too_many_files`); nothing was
 * written then, for nothing is written here.
 */
export async function composeToolEdits(source: OutlineSource, edits: readonly OutlineToolEdit[], ghostwriters: readonly string[], options: { maxFiles?: number } = {}): Promise<ComposedToolEdits> {
  try {
    const composed = await composeOutlineEdits(source, edits.map(seriesEditOf), {
      ghostwriters,
      maxEdits: OUTLINE_EDIT_MAX_EDITS,
      maxFiles: options.maxFiles ?? OUTLINE_EDIT_MAX_FILES,
      requireHash: outlineEditNeedsHash,
    });
    return { ...composed, applied: composed.steps.map(appliedLine) };
  } catch (error) {
    if (error instanceof OutlineComposeError) throw toolErrorOf(error, edits);
    throw error;
  }
}

