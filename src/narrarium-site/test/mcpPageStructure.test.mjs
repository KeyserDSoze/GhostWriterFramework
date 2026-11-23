import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const SITE = new URL("../", import.meta.url);

/** Every source file of the app that matches, by its path from the site folder. */
async function importersOf(pattern) {
  const found = [];
  for (const entry of await readdir(new URL("src/", SITE), { recursive: true })) {
    const relative = `src/${entry.split("\\").join("/")}`;
    if (!/\.(ts|tsx)$/.test(relative) || relative.startsWith("src/lib/generated-")) continue;
    if (pattern.test(await readFile(new URL(relative, SITE), "utf8"))) found.push(relative);
  }
  return found.sort();
}

const source = (file) => readFile(new URL(file, SITE), "utf8");

test("the page for the MCP is a route of its own, so that what it carries does not weigh on the documentation routes", async () => {
  const router = await source("src/router.tsx");
  assert.match(router, /path: "\/mcp"[^\n]+lazy: component\(\(\) => import\("@\/pages\/public\/McpPage"\), "McpPage"\)/, "/mcp loads its own module and shows its McpPage");
  assert.doesNotMatch(router, /PublicDocs"\), "McpPage"/, "and not the documentation module");
  const docs = await source("src/pages/public/PublicDocs.tsx");
  assert.doesNotMatch(docs, /McpPage|BookMcp|mcpBook|mcpTools|ToolTable/, "the documentation pages carry nothing of it");
  const page = await source("src/pages/public/McpPage.tsx");
  assert.doesNotMatch(page, /pages\/public\/PublicDocs/, "the page does not pull the documentation module in");
  assert.match(page, /export function McpPage\(/);
});

test("the list of the tools is loaded by that page and by nothing else: one component reads it, and only the page renders that component", async () => {
  assert.deepEqual(await importersOf(/generated-mcp-book-tools/), ["src/components/public/BookMcpSection.tsx"]);
  assert.deepEqual(await importersOf(/components\/public\/BookMcpSection/), ["src/pages/public/McpPage.tsx"]);
  assert.deepEqual(await importersOf(/["']@\/i18n\/mcpBookPage["']/), ["src/pages/public/McpPage.tsx"], "its texts are registered by the page that shows them");
});

test("the hero of a public page is one component that the documentation index and the MCP page share", async () => {
  assert.deepEqual(await importersOf(/components\/public\/PageHero/), ["src/pages/public/McpPage.tsx", "src/pages/public/PublicDocs.tsx"]);
  assert.doesNotMatch(await source("src/pages/public/PublicDocs.tsx"), /function PageHero/, "it is no longer written twice");
});

test("the sentence under the title of the page lives with the page's own texts, not in the catalogues of the app entry", async () => {
  const entryEn = await source("src/i18n/locales/en.ts");
  const entryIt = await source("src/i18n/locales/it.ts");
  assert.doesNotMatch(entryEn, /mcpText/, "the old sentence about the local and public surfaces is gone from the English entry");
  assert.doesNotMatch(entryIt, /mcpText/, "and from the Italian one");
  assert.match(await source("src/pages/public/McpPage.tsx"), /t\("mcpBookPage\.intro"\)/);
});

test("the guide of a book's MCP and the public /mcp page point to each other, in both languages", async () => {
  for (const language of ["en", "it"]) {
    const guide = await source(`src/content/guides/book-mcp.${language}.md`);
    assert.match(guide, /\]\(\/mcp\)/, `the guide (${language}) links the public page that lists every tool`);
    assert.match(guide, /\[[^\]]+\]\(\/mcp\)[^\n]*(?:strument|tool)|(?:strument|tool)[^\n]*\[[^\]]+\]\(\/mcp\)/i, `and says what it finds there (${language})`);
  }
  const page = await source("src/components/public/BookMcpSection.tsx");
  assert.match(page, /to="\/docs\/book-mcp"/, "the page links the guide");
  assert.match(page, /to="\/docs\/server#mcp-for-each-book"/, "and the section of the personal server's documentation that holds the details");
});
