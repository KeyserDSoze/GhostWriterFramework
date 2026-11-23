import { fileURLToPath } from "node:url";

/**
 * The list of the tools of a book's MCP, as the documentation of the site reads it (the public /mcp page): written by `npm run docs:tools` from the
 * registry that the endpoint lists in `tools/list` (`src/mcp-tools.ts`), and checked against that endpoint by `test/mcp-tools-docs.test.mjs`.
 *
 * This module only decides what is written, so the script and the test share it. It keeps the registry's order (what reads, then what changes the book, then
 * what steers the autopilot), and nothing that changes from one run to the next: no date, no version, no path.
 */

/** Where the list is written: the root of the package, next to `package.json`. It is not in `files`, so the npm package does not carry it. */
export const BOOK_TOOLS_FILE = fileURLToPath(new URL("../mcp-tools.json", import.meta.url));

/** The permissions of the server, in the order the endpoint shows them. */
export const BOOK_TOOL_PERMISSIONS = ["read", "write", "run"];

/** One tool of the registry as the file keeps it: the endpoint's own words (name, title, description, the three annotations a person reads) and the names of its parameters. */
export function describeBookTool(tool) {
  if (!BOOK_TOOL_PERMISSIONS.includes(tool.scope)) throw new Error(`${tool.name}: ${JSON.stringify(tool.scope)} is not a permission of the server (${BOOK_TOOL_PERMISSIONS.join(", ")}): teach docs:tools about it`);
  const schema = tool.inputSchema ?? {};
  const required = new Set(schema.required ?? []);
  return {
    name: tool.name,
    permission: tool.scope,
    title: tool.title,
    description: tool.description,
    annotations: { readOnlyHint: tool.annotations.readOnlyHint, destructiveHint: tool.annotations.destructiveHint, idempotentHint: tool.annotations.idempotentHint },
    parameters: Object.keys(schema.properties ?? {}).map((name) => ({ name, required: required.has(name) })),
  };
}

export function describeBookTools(tools) {
  const names = new Set();
  return tools.map((tool) => {
    if (names.has(tool.name)) throw new Error(`${tool.name} is in the registry twice`);
    names.add(tool.name);
    return describeBookTool(tool);
  });
}

/** The text of `mcp-tools.json` for these tools: pretty-printed JSON with one newline at the end. */
export function renderBookToolsJson(tools) {
  return `${JSON.stringify({ generatedBy: "npm run docs:tools -w narrarium-server", tools: describeBookTools(tools) }, null, 2)}\n`;
}
