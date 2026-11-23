import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { outlineChapterPath, outlineEntryDigest, serializeOutlineBook, serializeOutlineChapter } from "narrarium-engine";
import { mcpFixture } from "./mcp-helpers.mjs";

// What the tests of the outline tools of a book's MCP endpoint (S9) share: entries made the way the engine writes them, an outline that has a little of everything
// (the author's entries and the autopilot's, intact and not, chapters that are written and one that is frozen, a gap, a file that cannot be read), and a way to
// count what a call reads from the book.

export const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** A call that worked: its first block, parsed. */
export const done = (answer, label = "") => {
  assert.equal(answer.status, 200, `${label} ${answer.text}`);
  assert.equal(answer.error, undefined, `${label} ${JSON.stringify(answer.error)}`);
  assert.equal(answer.isError, false, `${label} ${answer.text}`);
  return answer.data;
};

/** A call that the tool refused: an error result whose text starts with `[code]`. */
export const refused = (answer, code, pattern) => {
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.error, undefined, `a tool error was expected, not a protocol error: ${JSON.stringify(answer.error)}`);
  assert.equal(answer.isError, true, `an error was expected: ${answer.text}`);
  assert.ok(answer.text.startsWith(`[${code}]`), `[${code}] was expected, got: ${answer.text.slice(0, 300)}`);
  if (pattern) assert.match(answer.text, pattern);
};

/** A call that the protocol refused (the arguments do not fit the tool's schema): a JSON-RPC error -32602. */
export const invalid = (answer, pattern) => {
  assert.equal(answer.error?.code, -32602, `-32602 was expected: ${answer.text.slice(0, 300)}`);
  if (pattern) assert.match(answer.error.message, pattern);
};
export const onDisk = (server, file, bookId = "glass") => readFile(path.join(server.data.bookDirectory(bookId), file), "utf8");

/** The file of the entry of a chapter, as the engine writes it. `fields` are `{ title, body, ghostwriter, origin, digest }`. */
export const entryFile = (number, fields = {}) => ({ path: outlineChapterPath(number), content: serializeOutlineChapter({ number, ...fields }) });

/** An entry the autopilot wrote and nobody has touched since: it carries the digest of what it says, so the engine reads it as intact. */
export async function autopilotEntry(number, fields = {}) {
  return entryFile(number, { ...fields, origin: "autopilot", digest: await outlineEntryDigest(fields) });
}

export const bookFile = (fields = {}) => ({ path: "outline/book.md", content: serializeOutlineBook(fields) });

/** An entry whose frontmatter is not valid YAML: the engine reads its text and warns. */
export const brokenEntry = (number, body) => ({ path: outlineChapterPath(number), content: `---\ntype: outline-chapter\ntitle: "unterminated\nnumber: ${number}\n---\n\n${body}\n` });

/**
 * An outline that has a little of everything, for the book of `mcpFixture` (chapters 1 and 2 are written):
 *   book.md  the author's description, with a working title
 *   1        the author's, ghostwriter `default` (which the book has); chapter 1 is written and frozen
 *   2        the autopilot's, intact; chapter 2 is written
 *   3        written by the autopilot and changed since: it binds like the author's; no chapter 3 yet
 *   4        its frontmatter cannot be read
 *   (5)      no entry: a gap
 *   6        the author's, with a ghostwriter that the book does not have
 * and the old `outline/act-one.md` that the fixture book already has (not an entry).
 */
export async function mixedOutline() {
  return [
    bookFile({ title: "The Glass Harbor, working title", body: "A glassmaker's daughter comes home.\n\nThe harbor hides a debt." }),
    entryFile(1, { title: "Arrival", body: "Mira reaches the harbor at dusk and finds the quay empty.", ghostwriter: "default" }),
    await autopilotEntry(2, { title: "The Storm", body: "A wave takes the quay before the bell." }),
    entryFile(3, { title: "The Keeper", body: "Mira meets the keeper, who is afraid.", origin: "autopilot", digest: "0123456789abcdef" }),
    brokenEntry(4, "The keeper's debt comes out."),
    entryFile(6, { title: "The Glass Road", body: "A road of glass leads out of town.", ghostwriter: "ghost-one" }),
  ];
}

/** The fixture of the MCP tests with `files` committed to the book (the mixed outline unless told otherwise), and chapter 1 frozen when `freeze` is set. */
export async function outlineFixture(server, client, { files, freeze = true, ...options } = {}) {
  const fixture = await mcpFixture(server, client, options);
  const outline = files ?? await mixedOutline();
  await client.commitFiles(fixture.bookId, outline, "the outline");
  if (freeze) await client.freezeChapter(fixture.bookId, "001-arrival");
  return { ...fixture, files: outline };
}

/**
 * `count` entries (`Chapter N`, a text that says its number; the multiples of 997 mention a lantern) put in the book's working copy, `gaps` left out. They are written
 * to the folder, not committed (thousands of commits of files would take seconds of git): the tools read the working copy, which is all these tests are about.
 */
export async function bulkOutline(server, bookId, count, { gaps = [] } = {}) {
  const skipped = new Set(gaps);
  const root = server.data.bookDirectory(bookId);
  await mkdir(path.join(root, "outline", "chapters"), { recursive: true });
  const files = [];
  for (let number = 1; number <= count; number += 1) {
    if (!skipped.has(number)) files.push(entryFile(number, { title: `Chapter ${number}`, body: `What happens in chapter ${number}. ${number % 997 === 0 ? "The lantern goes out." : ""}`.trim() }));
  }
  for (let start = 0; start < files.length; start += 250) await Promise.all(files.slice(start, start + 250).map((file) => writeFile(path.join(root, file.path), file.content)));
  return files;
}

/** Count what a book's store is asked to read: `{ paths, outline }` (the paths of the outline among them); `stop()` puts the store back. */
export function countReads(server, bookId = "glass") {
  const { store } = server.books.get(bookId);
  const original = store.read;
  const paths = [];
  store.read = function read(file, ...rest) {
    paths.push(file);
    return original.call(this, file, ...rest);
  };
  return {
    paths,
    get outline() {
      return paths.filter((file) => file.startsWith("outline/"));
    },
    reset: () => void (paths.length = 0),
    stop: () => void (store.read = original),
  };
}
