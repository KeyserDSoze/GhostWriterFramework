import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as testing from "../dist/testing.mjs";
import { BOOK_TOOLS_FILE, describeBookTools, renderBookToolsJson } from "../scripts/mcp-tools-document.mjs";
import { withServer } from "./helpers.mjs";
import { READ_TOOLS, RUN_TOOLS, WRITE_TOOLS, issueToken, mcpClient, mcpFixture } from "./mcp-helpers.mjs";

// `mcp-tools.json` is the list of the tools of a book's MCP that the documentation of the site is made from (the public /mcp page). It is written by
// `npm run docs:tools` from the registry the endpoint lists, and these tests are what keeps it true: a tool that is added, renamed or changed without
// writing the file again fails here, with the command to run.

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const REGENERATE = "run `npm run docs:tools -w narrarium-server`";
const stale = (what) => `mcp-tools.json is out of date (${what}): ${REGENERATE}`;

const document = async () => JSON.parse(await readFile(BOOK_TOOLS_FILE, "utf8"));

test("mcp-tools.json is exactly what the script writes from the registry of the tools of a book's MCP", async () => {
  // A checkout that turns line ends into CRLF (Windows) must not make a true file stale.
  const written = (await readFile(BOOK_TOOLS_FILE, "utf8")).replace(/\r\n/g, "\n");
  assert.equal(written, renderBookToolsJson(testing.TOOLS), stale("it differs from what the registry gives"));
});

test("it is also what the endpoint itself publishes in tools/list, each tool with the permission that first shows it", async () => {
  const { tools } = await document();
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const published = async (scopes) => {
      const answer = (await mcpClient(server, slug, await issueToken(server, scopes.join("+"), scopes)).request("tools/list", {})).json.result;
      assert.equal(answer.nextCursor, undefined, "the whole list fits in a page");
      return answer.tools;
    };
    const read = await published(["read"]);
    const readWrite = await published(["read", "write"]);
    const readRun = await published(["read", "run"]);
    const everything = await published(["read", "write", "run"]);
    const names = (list) => list.map((tool) => tool.name);
    assert.deepEqual(names(read), READ_TOOLS);
    assert.deepEqual(names(readWrite).slice(READ_TOOLS.length), WRITE_TOOLS);
    assert.deepEqual(names(readRun).slice(READ_TOOLS.length), RUN_TOOLS);

    const permissionOf = (name) => (names(read).includes(name) ? "read" : names(readWrite).includes(name) ? "write" : names(readRun).includes(name) ? "run" : undefined);
    const expected = everything.map((tool) => ({
      name: tool.name,
      permission: permissionOf(tool.name),
      title: tool.title,
      description: tool.description,
      annotations: { readOnlyHint: tool.annotations.readOnlyHint, destructiveHint: tool.annotations.destructiveHint, idempotentHint: tool.annotations.idempotentHint },
      parameters: Object.keys(tool.inputSchema.properties).map((name) => ({ name, required: (tool.inputSchema.required ?? []).includes(name) })),
    }));
    assert.equal(tools.length, expected.length, stale(`the endpoint lists ${expected.length} tools, the file ${tools.length}`));
    for (const [index, tool] of expected.entries()) assert.deepEqual(tools[index], tool, stale(`${tool.name} is not what the endpoint lists`));
    assert.deepEqual(tools.map((tool) => tool.permission), [...READ_TOOLS.map(() => "read"), ...WRITE_TOOLS.map(() => "write"), ...RUN_TOOLS.map(() => "run")], "every tool has the permission its place in the list gives it");
  });
});

test("each tool says what a reader of the documentation needs: its name, permission, title, description, annotations and the names of its parameters", async () => {
  const { tools } = await document();
  assert.ok(tools.length >= 25, `the file lists the tools (saw ${tools.length})`);
  const seen = new Set();
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool), ["name", "permission", "title", "description", "annotations", "parameters"], tool.name);
    assert.match(tool.name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, tool.name);
    assert.equal(seen.has(tool.name), false, `${tool.name} is listed once`);
    seen.add(tool.name);
    assert.ok(["read", "write", "run"].includes(tool.permission), `${tool.name}: a permission of the server`);
    assert.ok(tool.title.length > 2 && tool.description.length > 60, `${tool.name} keeps its title and its description, as the model reads them`);
    assert.deepEqual(Object.keys(tool.annotations), ["readOnlyHint", "destructiveHint", "idempotentHint"], tool.name);
    for (const value of Object.values(tool.annotations)) assert.equal(typeof value, "boolean", tool.name);
    assert.equal(tool.annotations.readOnlyHint, tool.permission === "read", `${tool.name}: only what reads is read-only`);
    for (const parameter of tool.parameters) {
      assert.deepEqual(Object.keys(parameter), ["name", "required"], tool.name);
      assert.equal(typeof parameter.required, "boolean", `${tool.name}.${parameter.name}`);
    }
    assert.equal(new Set(tool.parameters.map((parameter) => parameter.name)).size, tool.parameters.length, `${tool.name}: each parameter once`);
  }
});

test("the file is stable: the same registry gives the same text, in the order of tools/list, with no date and no machine in it", async () => {
  const first = renderBookToolsJson(testing.TOOLS);
  assert.equal(renderBookToolsJson([...testing.TOOLS]), first, "writing it twice gives one text");
  assert.ok(first.endsWith("}\n"), "it ends with one newline");
  assert.doesNotMatch(first, /\b20\d\d-\d\d-\d\d|\d\d:\d\d:\d\d|\/root\/|\/home\/|[A-Z]:\\\\/, "no date, no path of a machine");
  assert.deepEqual(describeBookTools(testing.TOOLS).map((tool) => tool.name), [...READ_TOOLS, ...WRITE_TOOLS, ...RUN_TOOLS], "the order of tools/list: what reads, then what changes the book, then what steers the autopilot");
  assert.equal(JSON.stringify(await document(), null, 2) + "\n", first, "the file is the pretty-printed JSON of that document, nothing else");
});

test("a tool that is changed in the registry changes the text, so the file cannot stay as it was", () => {
  const [first, ...rest] = testing.TOOLS;
  const base = renderBookToolsJson(testing.TOOLS);
  assert.notEqual(renderBookToolsJson([{ ...first, description: `${first.description} Changed.` }, ...rest]), base, "a description");
  assert.notEqual(renderBookToolsJson([{ ...first, annotations: { ...first.annotations, idempotentHint: !first.annotations.idempotentHint } }, ...rest]), base, "an annotation");
  assert.notEqual(renderBookToolsJson([{ ...first, scope: "run" }, ...rest]), base, "a permission");
  assert.notEqual(renderBookToolsJson([{ ...first, inputSchema: { ...first.inputSchema, properties: { ...first.inputSchema.properties, extra: { type: "string", description: "Another parameter." } } } }, ...rest]), base, "a parameter");
  assert.notEqual(renderBookToolsJson(rest), base, "a tool less");
  // A parameter that becomes required: a tool that has one, whose list of required names changes.
  const index = testing.TOOLS.findIndex((tool) => Object.keys(tool.inputSchema.properties).length > 0);
  const tool = testing.TOOLS[index];
  const [name] = Object.keys(tool.inputSchema.properties);
  const required = new Set(tool.inputSchema.required ?? []);
  required.has(name) ? required.delete(name) : required.add(name);
  const changed = testing.TOOLS.map((entry, at) => (at === index ? { ...tool, inputSchema: { ...tool.inputSchema, required: [...required] } } : entry));
  assert.notEqual(renderBookToolsJson(changed), base, "a parameter that becomes required, or optional");
  assert.throws(() => renderBookToolsJson([{ ...first, scope: "update" }]), /not a permission of the server/, "a permission that docs:tools does not know is an error, not a guess");
  assert.throws(() => renderBookToolsJson([first, first]), /twice/, "a tool twice in the registry");
});

test("the file is for the documentation of the site and stays out of the npm package", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.scripts["docs:tools"], "npm run docs:tools exists");
  assert.match(manifest.scripts["docs:tools"], /scripts\/docs-tools\.mjs/, "and runs the script");
  for (const entry of manifest.files) assert.doesNotMatch(entry, /mcp-tools|scripts|^\*|\.json$/, `${entry} does not put the file or the scripts in the package`);
  // What npm would really publish (only when the test runs through npm, which says where it is).
  if (!process.env.npm_execpath) return;
  const report = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: PACKAGE, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const paths = (Array.isArray(report) ? report : Object.values(report)).flatMap((entry) => entry.files.map((file) => file.path));
  assert.ok(paths.includes("dist/cli.mjs") && paths.includes("package.json"), "the check looks at the real package");
  assert.deepEqual(paths.filter((file) => /mcp-tools|^scripts\//.test(file)), [], "neither the list nor the script that writes it is published");
});

test("the README of the server tells whoever adds a tool what to do: write the list again, and give the tool its two lines on the site", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /npm run docs:tools -w narrarium-server/, "the command");
  assert.match(readme, /mcp-tools\.json/, "the file it writes");
  assert.match(readme, /mcpBookTools\.en\.ts/, "and the lines of the site that a new tool needs");
});
