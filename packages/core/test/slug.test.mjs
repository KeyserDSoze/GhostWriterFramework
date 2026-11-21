import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { chapterSlug, createCharacterProfile, createChapter, initializeBookRepo, paragraphSlug, slugCode, slugify, slugifyAny, transliterate } from "../dist/index.js";
import * as slugModule from "../dist/slug.js";

test("slugs of Latin titles are exactly what they always were", () => {
  assert.equal(slugify("The Clockmaker's Daughter"), "the-clockmaker-s-daughter");
  assert.equal(chapterSlug(1, "The Arrival"), "001-the-arrival");
  assert.equal(paragraphSlug(12, "Città di sale"), "012-citta-di-sale");
  assert.equal(chapterSlug(1000, "The End"), "1000-the-end");
  // A title that already has a Latin slug keeps it, even when most of it is in another script.
  assert.equal(chapterSlug(1, "Глава 1"), "001-1");
  assert.equal(slugifyAny("José Smith", "character", true), "jose-smith");
});

test("Cyrillic and Greek titles become readable Latin slugs", () => {
  assert.equal(transliterate("Тихая гавань"), "tikhaya gavan");
  // The letters that carry a mark ("й", "ё", "ї") are read as letters, not as their base letter.
  assert.equal(transliterate("Тихий Ёжик"), "tikhiy yozhik");
  assert.equal(transliterate("Тихий Ёжик".normalize("NFD")), "tikhiy yozhik", "the same text typed with combining marks");
  assert.equal(chapterSlug(1, "Тихая гавань"), "001-tikhaya-gavan");
  assert.equal(slugifyAny("Щука і Їжак", "character", true), "shchuka-i-yizhak");
  assert.equal(slugifyAny("Ђорђе Јовановић", "character", true), "djordje-jovanovic");
  assert.equal(chapterSlug(3, "Η μικρή πόλη"), "003-i-mikri-poli");
  assert.equal(slugifyAny("Οδυσσέας", "character", true), "odysseas");
  assert.equal(slugifyAny("Μπαμπάς Ούρανος", "character", true), "mpampas-ouranos");
});

test("any other script falls back to a plain name, or to a stable code for names that must not collide", () => {
  assert.equal(chapterSlug(2, "海辺の町"), "002-chapter");
  assert.equal(paragraphSlug(3, "الميناء"), "003-scene");
  assert.equal(slugifyAny("   ", "scene"), "scene", "nothing to code");
  const first = slugifyAny("李明", "character", true);
  assert.match(first, /^character-[0-9a-z]{6,7}$/);
  assert.equal(slugifyAny("李明", "character", true), first, "the same name always gives the same slug");
  assert.notEqual(slugifyAny("王芳", "character", true), first, "another name gives another one");
  assert.equal(slugifyAny("李明", "location", true).startsWith("location-"), true);
});

test("the stable code never changes: it is part of file names that are already committed", () => {
  assert.equal(slugCode("李明"), "0crj2m");
  assert.equal(slugCode("Hello"), "uncsqj");
  // Case and Unicode form do not matter: the same name typed on another keyboard is the same entity.
  assert.equal(slugCode("ÉMILE"), slugCode("émile"));
  assert.equal(slugCode("e\u0301mile"), slugCode("\u00e9mile"));
  assert.match(slugCode("x"), /^[0-9a-z]{6,7}$/);
});

test("the new helpers are exported from both entry points", () => {
  for (const name of ["transliterate", "slugCode", "slugifyAny"]) {
    assert.equal(typeof slugModule[name], "function", name);
  }
});

test("a character with a Chinese name gets a file, a chapter with a Japanese title gets a folder the engine can read back", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-slug-"));
  try {
    await initializeBookRepo(rootPath, { title: "海辺の町", language: "ja" });
    const character = await createCharacterProfile(rootPath, { name: "李明", roleTier: "main", speakingStyle: "Quiet.", backgroundSummary: "A fisherman.", functionInBook: "Protagonist." });
    assert.match(path.basename(character.filePath), /^character-[0-9a-z]{6,7}\.md$/);
    assert.match(await readFile(character.filePath, "utf8"), /name: 李明/);
    const chapter = await createChapter(rootPath, { number: 1, title: "海辺の朝", summary: "Morning at the sea." });
    assert.equal(path.basename(chapter.folderPath), "001-chapter");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});
