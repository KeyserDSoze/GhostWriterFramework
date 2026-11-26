import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as engine from "../dist/index.js";
import * as frozen from "../dist/autopilot/frozen.js";
import * as outlineCheck from "../dist/autopilot/outline-check.js";

// What the state of the autopilot says about one chapter (is it written, is a revision or a decision working on it) is a few pure lines that two places need: the frozen chapters
// (frozen.ts) and the rule that tells the author what happens when an entry of the outline changes (outline-change.ts). They live in a module of their own, with no import but
// types, so that a page that only shows the outline does not carry the whole of the frozen chapters (the runner's state, its prompts, its transport) with it.
// The module is read with a dynamic import so that, before it exists, each test fails on its own.

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const chapterState = () => import("../dist/autopilot/chapter-state.js");

const scene = (status) => ({ number: 1, title: "A scene", goal: "", beats: [], characters: [], status, revisions: 0 });
const chapter = (extra = {}) => ({ number: 2, title: "Two", slug: "002-two", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "planned", scenes: [], ...extra });
const review = (extra = {}) => ({ id: "r", kind: "outline", number: 2, action: "rewrite-to-outline", fingerprint: "f", at: "2026-01-01T00:00:00.000Z", ...extra });
const STARTED = { at: "2026-01-01T00:00:00.000Z", phase: "rewrite", before: { title: "Two", summary: "", keyEvents: [] } };

// ─── What they say ──────────────────────────────────────────────────────────

test("a chapter counts as written when the author wrote it, the autopilot closed it, or one of its scenes is past planned", async () => {
  const { isPlannedChapterWritten } = await chapterState();
  assert.equal(isPlannedChapterWritten(chapter()), false, "nothing planned yet");
  assert.equal(isPlannedChapterWritten(chapter({ status: "writing", scenes: [scene("planned"), scene("planned")] })), false, "its scenes are planned, none written");
  assert.equal(isPlannedChapterWritten(chapter({ status: "writing", imported: false })), false);
  assert.equal(isPlannedChapterWritten(chapter({ status: "planned", scenes: [scene("planned"), scene("written")] })), true, "a scene is written, whatever the status says");
  assert.equal(isPlannedChapterWritten(chapter({ status: "review", scenes: [scene("reviewed")] })), true);
  assert.equal(isPlannedChapterWritten(chapter({ status: "done" })), true, "closed");
  assert.equal(isPlannedChapterWritten(chapter({ status: "planned", imported: true })), true, "written by the author before the autopilot took over");
});

test("the decision being carried out is the first one that has begun: the autopilot works on one change at a time", async () => {
  const { startedReview } = await chapterState();
  assert.equal(startedReview({}), undefined);
  assert.equal(startedReview({ pendingReviews: [] }), undefined);
  assert.equal(startedReview({ pendingReviews: [review({ id: "waits" })] }), undefined, "a decision that waits has not begun");
  const first = review({ id: "first", number: 3, started: STARTED });
  assert.equal(startedReview({ pendingReviews: [review({ id: "waits" }), first, review({ id: "second", number: 4, started: STARTED })] }), first);
});

test("the revision in progress has a chapter when it targets one of its scenes, rewrote it, or is about it alone", async () => {
  const { inRevision } = await chapterState();
  assert.equal(inRevision({ revision: null }, 2), false);
  assert.equal(inRevision({}, 2), false, "a state with no revision at all");
  const base = { id: "v", instruction: "x", createdAt: "2026-01-01T00:00:00.000Z", targets: null, cursor: 0 };
  assert.equal(inRevision({ revision: base }, 2), false, "the impact is not analyzed yet: no target");
  assert.equal(inRevision({ revision: { ...base, targets: [{ chapterNumber: 2, sceneNumber: 1, instruction: "y" }] } }, 2), true);
  assert.equal(inRevision({ revision: { ...base, targets: [{ chapterNumber: 3, sceneNumber: 1, instruction: "y" }] } }, 2), false);
  assert.equal(inRevision({ revision: { ...base, revisedChapters: [1, 2] } }, 2), true, "rewritten by an earlier revision, and reviewed again at the end of this one");
  assert.equal(inRevision({ revision: { ...base, revisedChapters: [1] } }, 2), false);
  assert.equal(inRevision({ revision: { ...base, onlyChapter: 2 } }, 2), true, "a written chapter rewritten to follow its new entry");
  assert.equal(inRevision({ revision: { ...base, onlyChapter: 3 } }, 2), false);
});

test("the autopilot has in its hands a chapter that is not closed, one a revision rewrites and the one whose decision is being carried out", async () => {
  const { inHands } = await chapterState();
  const closed = chapter({ status: "done", scenes: [scene("reviewed")] });
  const nobody = { revision: null, pendingReviews: [] };
  assert.equal(inHands(nobody, closed), false);
  assert.equal(inHands({ revision: null }, closed), false, "no decisions recorded at all");
  for (const status of ["planned", "writing", "review"]) assert.equal(inHands(nobody, chapter({ status })), true, `not closed: ${status}`);
  assert.equal(inHands({ revision: { id: "v", instruction: "x", createdAt: "x", targets: null, cursor: 0, onlyChapter: 2 }, pendingReviews: [] }, closed), true);
  assert.equal(inHands({ revision: null, pendingReviews: [review({ started: STARTED })] }, closed), true, "its decision is being carried out");
  assert.equal(inHands({ revision: null, pendingReviews: [review({ number: 3, started: STARTED })] }, closed), false, "another chapter's decision");
  assert.equal(inHands({ revision: null, pendingReviews: [review()] }, closed), false, "a decision that waits");
});

// ─── What they are called, and where ────────────────────────────────────────

test("the package, the frozen chapters and the outline check export the same functions as before: one function each, wherever it is read from", async () => {
  const module = await chapterState();
  for (const name of ["inRevision", "startedReview"]) {
    assert.equal(typeof engine[name], "function", `${name} is in the package`);
    assert.equal(engine[name], module[name], `${name}: the package`);
    assert.equal(frozen[name], module[name], `${name}: frozen.js`);
  }
  assert.equal(typeof engine.isPlannedChapterWritten, "function");
  assert.equal(engine.isPlannedChapterWritten, module.isPlannedChapterWritten, "isPlannedChapterWritten: the package");
  assert.equal(outlineCheck.isPlannedChapterWritten, module.isPlannedChapterWritten, "isPlannedChapterWritten: outline-check.js");
});

// ─── What a bundler has to carry ────────────────────────────────────────────

/** The modules of dist/ that `entry` imports, and the ones they import (what a bundler walks before it drops what nobody uses), as paths from dist/; packages as `pkg:name`. */
function closure(entry) {
  const found = new Set();
  const stack = [path.join(DIST, entry)];
  while (stack.length) {
    const file = stack.pop();
    const key = path.relative(DIST, file);
    if (found.has(key)) continue;
    found.add(key);
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const [, specifier] of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g)) {
      if (specifier.startsWith(".")) stack.push(path.resolve(path.dirname(file), specifier));
      else found.add(`pkg:${specifier}`);
    }
  }
  return [...found].sort();
}

test("the module of the chapter's state imports nothing: no module, no package, only types", () => {
  assert.deepEqual(closure("autopilot/chapter-state.js"), ["autopilot/chapter-state.js"]);
});

test("the rule of what the autopilot does when an entry changes needs the state of a chapter and nothing else: not the frozen chapters, not the run's state, not the transport", () => {
  assert.deepEqual(closure("autopilot/outline-change.js"), ["autopilot/chapter-state.js", "autopilot/outline-change.js", "autopilot/types.js"]);
});

test("the composer of the outline needs the outline (the design of its entries too), its paths, its frontmatter and the small utilities, and no other part of the autopilot", () => {
  const allowed = [/^autopilot\/outline-compose\.js$/, /^book\/outline\.js$/, /^book\/design\.js$/, /^book\/paths\.js$/, /^markdown\//, /^util\//, /^pkg:(?:yaml|narrarium\/slug)$/];
  const unexpected = closure("autopilot/outline-compose.js").filter((file) => !allowed.some((pattern) => pattern.test(file)));
  assert.deepEqual(unexpected, [], "something that is no part of the outline came in: a page that shows the outline would carry it");
});
