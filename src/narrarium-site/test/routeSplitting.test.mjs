import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/router.tsx", import.meta.url), "utf8");

test("every application route remains present behind a lazy boundary", () => {
  const routes = [
    "books", "books/add", "chats", "patch-notes", "books/:bookId", "books/:bookId/dashboard", "books/:bookId/assets", "books/:bookId/reader", "books/:bookId/export", "books/:bookId/research", "books/:bookId/research/:researchSlug", "books/:bookId/ghostwriters", "books/:bookId/evaluation-style", "books/:bookId/simulated-readers", "books/:bookId/settings", "books/:bookId/audit", "books/:bookId/canon/:section/:slug", "books/:bookId/chapters/:chapterId/workspace/:workspaceKind", "books/:bookId/chapters/:chapterId/drafts", "books/:bookId/chapters/:chapterId/scripts", "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/workspace/:workspaceKind", "books/:bookId/chapters/:chapterId/reader-evaluations", "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/reader-evaluations", "books/:bookId/chapters/:chapterId/audit", "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/audit", "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum/split", "books/:bookId/chapters/:chapterId", "books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum", "settings", "settings/ai-router", "settings/deep-search", "settings/tools", "settings/github", "settings/speech", "settings/repository", "reader-settings", "custom-actions", "migrate", "costs", "docs", "docs/:docSlug",
  ];
  for (const route of routes) assert.match(source, new RegExp(`path: ${JSON.stringify(route).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\n]+lazy:`), route);
});

test("the startup router has no static authenticated page imports", () => {
  assert.doesNotMatch(source, /^import .*@\/pages\//m);
  assert.doesNotMatch(source, /^import .*@\/components\/auth\/LoginScreen/m);
  assert.doesNotMatch(source, /^import .*@\/components\/layout\/Shell/m);
});
