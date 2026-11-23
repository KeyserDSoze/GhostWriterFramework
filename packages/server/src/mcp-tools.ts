import { RUN_TOOLS } from "./mcp-autopilot.js";
import type { McpTool } from "./mcp-kit.js";
import { OUTLINE_READ_TOOLS, OUTLINE_WRITE_TOOLS } from "./mcp-outline.js";
import { READ_TOOLS } from "./mcp-read.js";
import { WRITE_TOOLS } from "./mcp-write.js";

/**
 * Every tool of a book's MCP, in the order `tools/list` gives them: what reads (`read`), then what changes the book (`write`), then what steers
 * its autopilot (`run`). The book is never an argument: it is the address the client called.
 *
 * Adding, renaming or changing a tool: run `npm run docs:tools -w narrarium-server`, which writes `mcp-tools.json` (what the public /mcp page of the site is made
 * from; `test/mcp-tools-docs.test.mjs` fails until you have), and give the tool its short line in English and in Italian in the site's `mcpBookTools.*.ts`.
 *
 * The tools of the outline (the Scaletta, the `outline/` folder) are `mcp-outline.ts`'s, and each comes after the tools of its permission: `read_outline` and
 * `read_outline_entry` read it, `edit_outline` is the only tool that writes it (`write_file` refuses the folder: see `mcp-policy.ts`).
 */
export const TOOLS: readonly McpTool[] = [...READ_TOOLS, ...OUTLINE_READ_TOOLS, ...WRITE_TOOLS, ...OUTLINE_WRITE_TOOLS, ...RUN_TOOLS];

export const toolNamed = (name: string): McpTool | undefined => TOOLS.find((tool) => tool.name === name);
