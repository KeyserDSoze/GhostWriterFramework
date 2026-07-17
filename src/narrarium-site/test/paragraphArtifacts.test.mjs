import assert from "node:assert/strict";
import test from "node:test";
import { resolveParagraphArtifactPaths } from "../src/narrarium/paragraphArtifacts.ts";

const target = (path, title) => {
  const [, chapterSlug, filename] = path.split("/");
  return { path, chapterSlug, paragraphSlug: filename.replace(/\.md$/, ""), title };
};

test("prefers the canonical draft over the legacy path", () => {
  const paragraph = target("chapters/001-arrival/001-at-the-gate.md", "At the Gate");
  const canonical = "drafts/001-arrival/001-at-the-gate.md";
  const legacy = "chapters/001-arrival/drafts/001-at-the-gate.md";
  const result = resolveParagraphArtifactPaths("draft", [canonical, legacy], [paragraph], {});

  assert.equal(result.get(paragraph.path), canonical);
});

test("finds a title-derived artifact for a paragraph with a bare ordinal filename", () => {
  const paragraph = target("chapters/001-arrival/001.md", "At the Gate");
  const script = "scripts/001-arrival/001-at-the-gate.md";
  const result = resolveParagraphArtifactPaths("script", [script], [paragraph], {
    [script]: { title: "At the Gate", paragraph: "paragraph:001-arrival:001-at-the-gate" },
  });

  assert.equal(result.get(paragraph.path), script);
});

test("uses exact frontmatter identity even when the artifact basename differs", () => {
  const paragraph = target("chapters/001-arrival/001-at-the-gate.md", "At the Gate");
  const draft = "drafts/001-arrival/001-old-name.md";
  const result = resolveParagraphArtifactPaths("draft", [draft], [paragraph], {
    [draft]: { title: "Old Name", paragraph: "paragraph:001-arrival:001-at-the-gate" },
  });

  assert.equal(result.get(paragraph.path), draft);
});

test("matches reordered artifacts by title instead of stale ordinals", () => {
  const first = target("chapters/001-arrival/001-first.md", "First");
  const second = target("chapters/001-arrival/002-second.md", "Second");
  const oldFirst = "scripts/001-arrival/002-first.md";
  const oldSecond = "scripts/001-arrival/001-second.md";
  const result = resolveParagraphArtifactPaths("script", [oldFirst, oldSecond], [first, second], {
    [oldFirst]: { title: "First" },
    [oldSecond]: { title: "Second" },
  });

  assert.equal(result.get(first.path), oldFirst);
  assert.equal(result.get(second.path), oldSecond);
});

test("does not guess when duplicate titles make the match ambiguous", () => {
  const first = target("chapters/001-arrival/001-first.md", "A Door");
  const second = target("chapters/001-arrival/002-second.md", "A Door");
  const oldFirst = "scripts/009-old/004-a-door.md";
  const oldSecond = "scripts/009-old/005-a-door.md";
  const result = resolveParagraphArtifactPaths("script", [oldFirst, oldSecond], [first, second], {
    [oldFirst]: { title: "A Door" },
    [oldSecond]: { title: "A Door" },
  });

  assert.equal(result.size, 0);
});

test("does not assign a stale duplicate to an unresolved paragraph with the same title", () => {
  const first = target("chapters/001-arrival/001-first.md", "A Door");
  const second = target("chapters/001-arrival/002-second.md", "A Door");
  const exact = "scripts/001-arrival/001-first.md";
  const staleDuplicate = "scripts/009-old/004-a-door.md";
  const result = resolveParagraphArtifactPaths("script", [exact, staleDuplicate], [first, second], {
    [staleDuplicate]: { title: "A Door" },
  });

  assert.equal(result.get(first.path), exact);
  assert.equal(result.has(second.path), false);
});
