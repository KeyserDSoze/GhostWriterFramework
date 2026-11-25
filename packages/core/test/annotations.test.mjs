import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as core from "../dist/index.js";

const { createChapter, createParagraph, doctorBook, initializeBookRepo, searchBook, validateBook } = core;

/**
 * The annotations of the in-app reader are saved in the book: `annotations/chapters/<chapter>.yml` and `annotations/tags.yml`, YAML without
 * frontmatter (the format is the site's, docs/repository-spec.md «Annotations»). They are the author's notes, not the book: the checks of the
 * repository leave them out, so a book with annotations stays valid, and searching the book does not find them.
 */

const MARKER = "PRIVATE-ANNOTATION-MARKER";

const chapterFile = [
  "# Annotations of this chapter, written by Narrarium: one entry per marked passage, sorted by id. Do not rename this file by hand.",
  "",
  "version: 1",
  "chapter: chapter:001-the-gate",
  "annotations:",
  "  - id: a-mi4k2x1a-7f3k9q",
  "    paragraph: paragraph:001-the-gate:001-opening",
  "    quote: the gate stood open",
  "    prefix: ''",
  "    suffix: ' beneath a sky'",
  "    offset: 0",
  "    tag: rewrite",
  `    comment: ${MARKER} too flat`,
  "    status: open",
  "    createdAt: 2026-11-25T10:00:00.000Z",
  "    updatedAt: 2026-11-25T10:00:00.000Z",
  "    createdOnDevice: d-1a2b3c4d",
  "",
].join("\n");

const tagsFile = [
  "version: 1",
  "tags:",
  "  - id: pace-k3x9",
  `    name: ${MARKER} pace`,
  "    description: The pace slows here.",
  "    mark:",
  "      underline: dotted",
  "      color: sky",
  "      icon: clock",
  "    createdAt: 2026-11-25T10:00:00.000Z",
  "    updatedAt: 2026-11-25T10:00:00.000Z",
  "",
].join("\n");

test("a book with annotations is valid, the doctor says nothing of them and searching the book does not find them", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-annotations-"));
  try {
    await initializeBookRepo(rootPath, { title: "Annotated Book", language: "en" });
    await createChapter(rootPath, { number: 1, title: "The Gate" });
    await createParagraph(rootPath, { chapter: "chapter:001-the-gate", number: 1, title: "Opening", body: "The gate stood open beneath a sky the color of old steel." });
    await mkdir(path.join(rootPath, "annotations", "chapters"), { recursive: true });
    await writeFile(path.join(rootPath, "annotations", "chapters", "001-the-gate.yml"), chapterFile);
    await writeFile(path.join(rootPath, "annotations", "tags.yml"), tagsFile);

    const validation = await validateBook(rootPath);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    const doctor = await doctorBook(rootPath);
    assert.deepEqual(doctor.issues.filter((issue) => issue.path.startsWith("annotations/")), []);
    assert.equal(doctor.errors, 0, JSON.stringify(doctor.issues));
    assert.ok(!core.CONTENT_GLOB.some((pattern) => pattern.startsWith("annotations")), "annotations/ is not content of the book");

    const hits = await searchBook(rootPath, MARKER);
    assert.deepEqual(hits, []);
    assert.ok((await searchBook(rootPath, "old steel")).length > 0, "the scene itself is found");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});
