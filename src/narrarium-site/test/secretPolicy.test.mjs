import assert from "node:assert/strict";
import test from "node:test";
import { canDiscloseSecretBody, directSecretPath, isSecretPath, parseSecretThresholds, resolveSecretAccess, secretAccessMapForRoute, visibleSecretManifestEntries } from "../src/assistant/secretPolicy.ts";

const chapters = ["001-opening", "002-suspicion", "003-reveal"].map((slug) => ({ slug, path: `chapters/${slug}`, title: slug, paragraphs: [], hasResume: false, hasEvaluation: false }));

test("secret thresholds distinguish hidden, known, and revealed chapter access", () => {
  const thresholds = { knownFrom: "chapter:002-suspicion", revealIn: "chapter:003-reveal" };
  assert.equal(resolveSecretAccess({ thresholds, chapters, currentChapterSlug: "001-opening" }), "hidden");
  assert.equal(resolveSecretAccess({ thresholds, chapters, currentChapterSlug: "002-suspicion" }), "known");
  assert.equal(resolveSecretAccess({ thresholds, chapters, currentChapterSlug: "003-reveal" }), "revealed");
});

test("secret policy fails closed without progress, thresholds, or valid references", () => {
  assert.equal(resolveSecretAccess({ thresholds: {}, chapters, currentChapterSlug: "003-reveal" }), "hidden");
  assert.equal(resolveSecretAccess({ thresholds: { revealIn: "chapter:missing" }, chapters, currentChapterSlug: "003-reveal" }), "hidden");
  assert.equal(resolveSecretAccess({ thresholds: { revealIn: "chapter:003-reveal" }, chapters }), "hidden");
  assert.deepEqual(parseSecretThresholds("not frontmatter"), {});
  assert.deepEqual(parseSecretThresholds("---\nknown_from: chapter:002-suspicion\nreveal_in: chapter:003-reveal\n---\nTruth"), { knownFrom: "chapter:002-suspicion", revealIn: "chapter:003-reveal" });
});

test("only a direct secret canon route grants explicit author access", () => {
  assert.equal(directSecretPath({ kind: "canon", bookId: "book", section: "secrets", slug: "the-truth" }), "secrets/the-truth.md");
  assert.equal(directSecretPath({ kind: "chapter", bookId: "book", chapterId: "003-reveal" }), null);
  assert.equal(resolveSecretAccess({ thresholds: {}, chapters, directAuthorRoute: true }), "author");
  assert.equal(resolveSecretAccess({ thresholds: {}, chapters }), "hidden");
});

test("route policy applies structure metadata and author override to the selected secret only", () => {
  const structure = /** @type {any} */ ({
    chapters,
    secrets: [
      { path: "secrets/the-truth.md", knownFrom: "chapter:002-suspicion", revealIn: "chapter:003-reveal" },
      { path: "secrets/other-truth.md" },
    ],
  });
  const chapterAccess = secretAccessMapForRoute({ structure, route: { kind: "chapter", bookId: "book", chapterId: "002-suspicion" }, chapter: chapters[1] });
  assert.equal(chapterAccess.get("secrets/the-truth.md"), "known");
  assert.equal(chapterAccess.get("secrets/other-truth.md"), "hidden");

  const authorAccess = secretAccessMapForRoute({ structure, route: { kind: "canon", bookId: "book", section: "secrets", slug: "the-truth" }, chapter: null });
  assert.equal(authorAccess.get("secrets/the-truth.md"), "author");
  assert.equal(authorAccess.get("secrets/other-truth.md"), "hidden");
});

test("secret getter bodies require reveal or explicit author access", () => {
  assert.equal(canDiscloseSecretBody("hidden"), false);
  assert.equal(canDiscloseSecretBody("known"), false);
  assert.equal(canDiscloseSecretBody("revealed"), true);
  assert.equal(canDiscloseSecretBody("author"), true);
});

test("manifest excludes hidden secrets and marks threshold-safe entries", () => {
  const secrets = [{ path: "secrets/hidden-truth.md" }, { path: "secrets/known-truth.md" }];
  const manifest = visibleSecretManifestEntries(secrets, new Map([["secrets/known-truth.md", "known"]]));
  assert.equal(manifest.some((file) => file.path === "secrets/hidden-truth.md"), false);
  assert.equal(manifest.find((file) => file.path === "secrets/known-truth.md")?.secretAccess, "known");
});

test("searchable-file duplicates cannot put a hidden secret back in the manifest", () => {
  assert.equal(isSecretPath("secrets/accidental-leak.md"), true);
  assert.deepEqual(visibleSecretManifestEntries([{ path: "secrets/accidental-leak.md" }], new Map()), []);
});
