import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import {
  createChapter,
  createCharacterProfile,
  createPersona,
  exportEpub,
  findWikipediaResearchSnapshot,
  initializeBookRepo,
  renameEntity,
  slugCode,
  validateBook,
  writeWikipediaResearchSnapshot,
} from "../dist/index.js";

async function withBook(language, run) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-nonlatin-core-"));
  try {
    await initializeBookRepo(rootPath, { title: "海辺の町", language });
    await run(rootPath);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

const exists = (file) => access(file).then(() => true, () => false);

test("reader personas named in any script get a readable, stable, distinct file name", async () => {
  await withBook("ja", async (rootPath) => {
    const chinese = await createPersona(rootPath, { name: "好奇的读者", archetype: "curious" });
    const russian = await createPersona(rootPath, { name: "Строгий критик", archetype: "strict" });
    const other = await createPersona(rootPath, { name: "挑剔的读者", archetype: "picky" });
    assert.equal(path.basename(chinese.filePath), `reader-${slugCode("好奇的读者")}.md`);
    assert.equal(path.basename(russian.filePath), "strogiy-kritik.md");
    assert.notEqual(chinese.filePath, other.filePath);
  });
});

test("a Wikipedia snapshot for a title in another script is saved and found again", async () => {
  await withBook("ja", async (rootPath) => {
    const saved = await writeWikipediaResearchSnapshot(rootPath, { title: "ヴェネツィア", pageUrl: "https://ja.wikipedia.org/wiki/ヴェネツィア", summary: "水の都。", body: "Description: A city." });
    assert.match(path.basename(saved), /^research-[0-9a-z]{6,7}\.md$/);
    const found = await findWikipediaResearchSnapshot(rootPath, { title: "ヴェネツィア" });
    assert.equal(found?.filePath, saved);
  });
});

test("an entity can be renamed to a name in another script", async () => {
  await withBook("zh", async (rootPath) => {
    await createCharacterProfile(rootPath, { name: "Li Ming", roleTier: "main", speakingStyle: "Quiet.", backgroundSummary: "A fisherman.", functionInBook: "Protagonist." });
    const result = await renameEntity(rootPath, { kind: "character", slugOrId: "li-ming", newNameOrTitle: "李明" });
    assert.match(path.basename(result.newPath), new RegExp(`^character-${slugCode("李明")}\\.md$`));
    assert.equal(await exists(path.join(rootPath, "characters", "li-ming.md")), false);
    assert.match(await readFile(path.join(rootPath, "characters", `character-${slugCode("李明")}.md`), "utf8"), /name: 李明/);
  });
});

test("an EPUB of a book titled in another script gets a usable default file name", async () => {
  await withBook("ja", async (rootPath) => {
    await createChapter(rootPath, { number: 1, title: "朝", summary: "Morning at the sea.", body: "海の朝は静かだった。" });
    const result = await exportEpub(rootPath, {});
    assert.match(path.basename(result.outputPath), /^book-[0-9a-z]{6,7}\.epub$/);
    assert.equal(await exists(result.outputPath), true);
  });
});

test("a ghostwriter named in another script can be selected, a path in the name cannot", async () => {
  await withBook("ja", async (rootPath) => {
    await mkdir(path.join(rootPath, "ghostwriters"), { recursive: true });
    await writeFile(path.join(rootPath, "ghostwriters", "ミナト.md"), "---\ntype: ghostwriter\nid: ghostwriter:ミナト\nname: ミナト\nlanguage: Japanese\ntone: Quiet\ntemperature: 0.7\n---\n\nWrite quietly.\n", "utf8");
    const chapter = await createChapter(rootPath, { number: 1, title: "朝", summary: "Morning.", frontmatter: { ghostwriter: "ミナト" } });
    let report = await validateBook(rootPath);
    assert.deepEqual(report.errors.filter((error) => /ghostwriter/i.test(error.message)), []);
    const file = path.join(chapter.folderPath, "chapter.md");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace(/ghostwriter: .*/, "ghostwriter: ../x"), "utf8");
    report = await validateBook(rootPath);
    assert.ok(report.errors.some((error) => /Invalid ghostwriter slug/.test(error.message)));
    assert.equal((await readdir(rootPath)).includes("x"), false);
  });
});
