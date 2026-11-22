import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as core from "../dist/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { buildNarrariumBookSnapshot, doctorBook, initializeBookRepo, searchBook, validateBook } = core;

async function withBook(run) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-outline-"));
  try {
    await initializeBookRepo(rootPath, { title: "Outline Book", language: "en" });
    await mkdir(path.join(rootPath, "outline", "chapters"), { recursive: true });
    await run(rootPath);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

const entry = (fields, body) => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n\n${body}\n`;

test("the outline is a part of the book: its paths, one file per chapter numbered like the chapter folders", () => {
  assert.equal(core.OUTLINE_DIRECTORY, "outline");
  assert.equal(core.OUTLINE_BOOK_FILE, "outline/book.md");
  assert.equal(core.OUTLINE_CHAPTERS_DIRECTORY, "outline/chapters");
  assert.equal(core.outlineChapterPath(7), "outline/chapters/007.md");
  assert.equal(core.outlineChapterPath(1500), "outline/chapters/1500.md");
  assert.equal(core.outlineChapterPath(7).split("/").pop(), `${core.chapterSlug(7, "x").slice(0, 3)}.md`, "the zero-padding of the chapter folders");
  assert.deepEqual(core.parseOutlineChapterPath("outline/chapters/012.md"), { number: 12, canonical: true });
  assert.deepEqual(core.parseOutlineChapterPath("outline/chapters/12.md"), { number: 12, canonical: false });
  assert.equal(core.parseOutlineChapterPath("outline/chapters/000.md"), null);
  assert.equal(core.parseOutlineChapterPath("outline/book.md"), null);
  assert.ok(core.CONTENT_GLOB.includes("outline/**/*.md"), "the outline is context, searched and validated like the rest");
});

test("the schemas of the outline keep every key, default the origin to the author and know only two origins", () => {
  const book = core.outlineBookSchema.parse({ type: "outline", id: "outline:book", title: "Working title", mood: "grim" });
  assert.equal(book.mood, "grim");
  assert.equal(core.outlineBookSchema.safeParse({ type: "outline", id: "outline:other" }).success, false);
  const chapter = core.outlineChapterSchema.parse({ type: "outline-chapter", id: "outline-chapter:007", number: 7, title: "The Lie", ghostwriter: "noir", origin: "autopilot", digest: "0123456789abcdef", extra: 1 });
  assert.deepEqual([chapter.origin, chapter.digest, chapter.extra], ["autopilot", "0123456789abcdef", 1]);
  assert.equal(core.outlineChapterSchema.parse({ type: "outline-chapter", id: "outline-chapter:001", number: 1 }).origin, "author");
  assert.equal(core.outlineChapterSchema.parse({ type: "outline-chapter", id: "outline-chapter:001", number: 1 }).title, undefined, "a hypothetical title may be missing");
  assert.equal(core.outlineChapterSchema.safeParse({ type: "outline-chapter", id: "outline-chapter:001", number: 1, origin: "robot" }).success, false);
  assert.equal(core.outlineChapterSchema.safeParse({ type: "chapter", id: "outline-chapter:001", number: 1 }).success, false);
});

test("validation reads the outline: a broken entry is an error, a ghostwriter that does not exist only a warning of the doctor", async () => {
  await withBook(async (rootPath) => {
    await writeFile(path.join(rootPath, "outline", "book.md"), entry({ type: "outline", id: "outline:book", title: "Working title" }, "A harbor built on glass hides a lie."));
    await writeFile(path.join(rootPath, "outline", "chapters", "001.md"), entry({ type: "outline-chapter", id: "outline-chapter:001", number: 1, title: "The Arrival", origin: "author" }, "Mira arrives at the harbor."));
    await writeFile(path.join(rootPath, "outline", "chapters", "002.md"), entry({ type: "outline-chapter", id: "outline-chapter:002", number: 2, title: "The Storm", ghostwriter: "ghost-of-nobody" }, "The storm breaks the wall."));
    let validation = await validateBook(rootPath);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    const doctor = await doctorBook(rootPath);
    assert.ok(doctor.issues.some((issue) => issue.severity === "warning" && issue.code === "outline-ghostwriter-missing" && issue.path === "outline/chapters/002.md"), JSON.stringify(doctor.issues));

    await writeFile(path.join(rootPath, "outline", "chapters", "003.md"), entry({ type: "outline-chapter", id: "outline-chapter:003", number: 3, origin: "robot" }, "Broken origin."));
    await writeFile(path.join(rootPath, "outline", "chapters", "004.md"), entry({ type: "outline-chapter", id: "outline-chapter:004", number: 9 }, "The name wins."));
    validation = await validateBook(rootPath);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.path === "outline/chapters/003.md"));
    assert.ok(!validation.errors.some((error) => error.path === "outline/chapters/004.md"), "a number that differs from the name is not an error: the name wins");
    const later = await doctorBook(rootPath);
    assert.ok(later.issues.some((issue) => issue.severity === "warning" && issue.code === "outline-number-mismatch" && issue.path === "outline/chapters/004.md"));
  });
});

test("the outline is searched like the rest of the book", async () => {
  await withBook(async (rootPath) => {
    await writeFile(path.join(rootPath, "outline", "chapters", "001.md"), entry({ type: "outline-chapter", id: "outline-chapter:001", number: 1, title: "The Arrival" }, "The lighthouse keeper hides the brass key."));
    const hits = await searchBook(rootPath, "brass key");
    assert.ok(hits.some((hit) => hit.path === "outline/chapters/001.md" && hit.type === "outline-chapter"));
  });
});

test("the snapshot of the core keeps the outline by its path, and a malformed entry never breaks it", () => {
  const snapshot = buildNarrariumBookSnapshot({
    profileId: "p",
    provider: "github",
    branch: "main",
    commitSha: "abc",
    documents: [
      { path: "book.md", rawMarkdown: "---\ntype: book\nid: book\ntitle: T\n---\n" },
      { path: "outline/book.md", rawMarkdown: "---\ntype: outline\nid: outline:book\n---\n\nThe book." },
      { path: "outline/chapters/001.md", rawMarkdown: "---\ntype: outline-chapter\nid: outline-chapter:001\nnumber: 1\ntitle: One\n---\n\nWhat happens." },
      { path: "outline/chapters/002.md", rawMarkdown: "Just text, written by hand." },
    ],
  });
  assert.equal(snapshot.documentsByPath["outline/chapters/001.md"].body, "What happens.");
  assert.equal(snapshot.documentsByPath["outline/chapters/002.md"].body, "Just text, written by hand.");
  assert.equal(snapshot.chapters.length, 0, "an outline entry is not a chapter");
});
