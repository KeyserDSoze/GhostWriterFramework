import assert from "node:assert/strict";
import test from "node:test";
import { buildChapterResumeChunks, loadCompleteChapterSource, mergeResumeFrontmatter, resolveResumeChapter } from "../src/assistant/chapterSource.ts";

const chapter = {
  slug: "001-start", path: "chapters/001-start", title: "Start", hasResume: false, hasEvaluation: false,
  paragraphs: Array.from({ length: 15 }, (_, index) => ({ number: String(index + 1).padStart(3, "0"), title: `P${index + 1}`, path: `chapters/001-start/${String(index + 1).padStart(3, "0")}.md` })),
};

test("loads intro and every paragraph identically from chapter or paragraph routes", async () => {
  assert.equal(resolveResumeChapter({ chapter }), chapter);
  assert.equal(resolveResumeChapter({ chapter }), resolveResumeChapter({ chapter }));
  const requested = [];
  const parts = await loadCompleteChapterSource(chapter, async (path) => { requested.push(path); return `Body ${path}`; });
  assert.equal(parts.length, 16);
  assert.equal(requested[0], "chapters/001-start/chapter.md");
  assert.equal(requested[requested.length - 1], "chapters/001-start/015.md");
});

test("one failed required paragraph aborts complete source loading", async () => {
  await assert.rejects(() => loadCompleteChapterSource(chapter, async (path) => { if (path.endsWith("013.md")) throw new Error("network"); return "ok"; }), /013\.md/);
});

test("long chapters and oversized paragraphs are chunked without dropping sources", () => {
  const parts = [{ path: "intro", title: "Intro", content: "x".repeat(70_000) }, ...chapter.paragraphs.map((paragraph) => ({ path: paragraph.path, title: paragraph.title, content: "y".repeat(5_000) }))];
  const chunks = buildChapterResumeChunks(parts, 30_000);
  const combined = chunks.flat();
  assert.ok(chunks.length > 1);
  assert.equal(combined.filter((part) => part.path === "intro").reduce((sum, part) => sum + part.content.length, 0), 70_000);
  for (const paragraph of chapter.paragraphs) assert.ok(combined.some((part) => part.path === paragraph.path));
});

test("resume persistence preserves state changes while canonical identity wins", () => {
  assert.deepEqual(mergeResumeFrontmatter({ state_changes: [{ kind: "move" }], title: "Wrong", id: "wrong", type: "wrong" }, "001-start"), { state_changes: [{ kind: "move" }], title: "Resume 001-start", id: "resume:chapter:001-start", type: "resume" });
});
