import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import * as core from "../dist/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { createChapter, doctorBook, initializeBookRepo, updateChapter, validateBook } = core;

// ─── E4b: the freeze record of a chapter (`frozen` in chapter.md) is part of the book format ─────────────────────────────

const RECORD = { at: "2026-01-01T00:00:00.000Z", by: "autopilot", digest: "0123456789abcdef", files: { "001-the-arrival.md": "fedcba9876543210" } };

async function withBook(run) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-frozen-"));
  try {
    await initializeBookRepo(rootPath, { title: "Frozen Book", language: "en" });
    await run(rootPath);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

const frontmatterOf = async (file) => parse(/^---\n([\s\S]*?)\n---/.exec(await readFile(file, "utf8"))[1]);

test("the schema says the shape of a freeze record, and chapter.md keeps whatever its `frozen` holds", () => {
  assert.deepEqual(core.chapterFreezeSchema.parse(RECORD), RECORD);
  assert.equal(core.chapterFreezeSchema.parse({ ...RECORD, by: "author" }).by, "author");
  for (const broken of [{ ...RECORD, by: "robot" }, { ...RECORD, digest: "" }, { ...RECORD, files: "none" }, { ...RECORD, files: { "001-a.md": 7 } }, { ...RECORD, at: "yesterday" }, "yes", true]) {
    assert.equal(core.chapterFreezeSchema.safeParse(broken).success, false, JSON.stringify(broken));
  }
  const chapter = { type: "chapter", id: "chapter:001-a", number: 1, title: "A" };
  assert.deepEqual(core.chapterSchema.parse({ ...chapter, frozen: RECORD }).frozen, RECORD);
  assert.equal(core.chapterSchema.parse({ ...chapter, frozen: "yes" }).frozen, "yes", "a record that cannot be read is kept as it is: never an error, never dropped");
  assert.equal(core.chapterSchema.parse(chapter).frozen, undefined);
});

test("updating a chapter keeps its record; a record that cannot be read is a warning of the doctor, never an error", async () => {
  await withBook(async (rootPath) => {
    const { chapterFilePath } = await createChapter(rootPath, { number: 1, title: "The Arrival" });
    const raw = await readFile(chapterFilePath, "utf8");
    await writeFile(chapterFilePath, raw.replace(/\n---\n/, `\nfrozen:\n  at: ${RECORD.at}\n  by: ${RECORD.by}\n  digest: "${RECORD.digest}"\n  files:\n    001-the-arrival.md: "${RECORD.files["001-the-arrival.md"]}"\n---\n`));
    await updateChapter(rootPath, { chapter: "001-the-arrival", frontmatterPatch: { summary: "Mira arrives." } });
    const updated = await frontmatterOf(chapterFilePath);
    assert.equal(updated.summary, "Mira arrives.");
    assert.deepEqual(updated.frozen, RECORD, "the record goes through an update untouched");
    let validation = await validateBook(rootPath);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    assert.ok(!(await doctorBook(rootPath)).issues.some((issue) => issue.code === "chapter-frozen-invalid"));

    await writeFile(chapterFilePath, (await readFile(chapterFilePath, "utf8")).replace(/frozen:\n(?: {2}.*\n)+/, "frozen: yes\n"));
    validation = await validateBook(rootPath);
    assert.equal(validation.valid, true, "a broken record never blocks the book");
    const doctor = await doctorBook(rootPath);
    const warning = doctor.issues.find((issue) => issue.code === "chapter-frozen-invalid");
    assert.ok(warning, JSON.stringify(doctor.issues));
    assert.equal(warning.severity, "warning");
    assert.equal(warning.path, "chapters/001-the-arrival/chapter.md");
  });
});
