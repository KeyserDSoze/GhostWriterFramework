// Writes packages/server/mcp-tools.json from the tools that a book's MCP endpoint really lists (`tools/list`): the registry in src/mcp-tools.ts, read through
// the bundle that the tests use. Run it with `npm run docs:tools -w narrarium-server` after adding, renaming or changing a tool; the server's test fails
// until you have, and the site's generator (src/narrarium-site/scripts/generate-docs.mjs) reads the file for the public /mcp page.
import { writeFile } from "node:fs/promises";
import { TOOLS } from "../dist/testing.mjs";
import { BOOK_TOOLS_FILE, renderBookToolsJson } from "./mcp-tools-document.mjs";

await writeFile(BOOK_TOOLS_FILE, renderBookToolsJson(TOOLS), "utf8");
console.log(`mcp-tools.json: ${TOOLS.length} tools.`);
