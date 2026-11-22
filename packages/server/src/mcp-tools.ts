import { RUN_TOOLS } from "./mcp-autopilot.js";
import type { McpTool } from "./mcp-kit.js";
import { READ_TOOLS } from "./mcp-read.js";
import { WRITE_TOOLS } from "./mcp-write.js";

/**
 * Every tool of a book's MCP, in the order `tools/list` gives them: what reads (`read`), then what changes the book (`write`), then what steers
 * its autopilot (`run`). The book is never an argument: it is the address the client called.
 *
 * Where the tools of the Scaletta (the `outline/` folder) will be added, when that work lands: a new array of tools here, or entries in one of the
 * three lists. `read_file` and `write_file` reach `outline/` already (see `mcp-policy.ts`).
 */
export const TOOLS: readonly McpTool[] = [...READ_TOOLS, ...WRITE_TOOLS, ...RUN_TOOLS];

export const toolNamed = (name: string): McpTool | undefined => TOOLS.find((tool) => tool.name === name);
