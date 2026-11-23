import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const siteRoot = fileURLToPath(new URL("..", import.meta.url));
/** Where the index lives: the imports of the texts are written relative to it, wherever the files are written. */
const libRoot = path.join(siteRoot, "src", "lib");
/** `NARRARIUM_DOCS_OUT` writes the files somewhere else, as they would be in `src/lib` (the tests compare a fresh run with what is committed). */
const outputRoot = process.env.NARRARIUM_DOCS_OUT ? path.resolve(process.env.NARRARIUM_DOCS_OUT) : libRoot;
const outputPath = path.join(outputRoot, "generated-docs.ts");
const publicMetaOutputPath = path.join(outputRoot, "generated-public-meta.ts");
/** The tools of a book's MCP, in a module of their own: only the public /mcp page loads it, so the index of the documents stays light. */
const bookToolsOutputPath = path.join(outputRoot, "generated-mcp-book-tools.ts");
/** The list the personal server writes (`npm run docs:tools -w narrarium-server`) from the tools its MCP endpoint really lists. */
const bookToolsSourcePath = path.join(workspaceRoot, "packages", "server", "mcp-tools.json");
const publicRoutesOutputPath = path.join(outputRoot, "public-doc-routes.json");
/** The texts of the guides of the app (`<slug>.<lang>.md`), from the root of the repository: their titles and summaries are in `src/lib/appDocs.ts`. */
const guidesRoot = "src/narrarium-site/src/content/guides";

const groupLabels = {
  guides: "Guides",
  overview: "Overview",
  reference: "Reference",
  packages: "Packages",
};

async function main() {
  const [referenceDocs, packageReadmes, guideDocs, appDocsSource, appGuides] = await Promise.all([
    fg("docs/**/*.md", { cwd: workspaceRoot, onlyFiles: true, ignore: ["docs/guide-*.md"] }),
    fg("packages/*/README.md", { cwd: workspaceRoot, onlyFiles: true }),
    fg("docs/guide-*.md", { cwd: workspaceRoot, onlyFiles: true }),
    readFile(path.join(siteRoot, "src", "lib", "appDocs.ts"), "utf8"),
    fg(`${guidesRoot}/*.md`, { cwd: workspaceRoot, onlyFiles: true }),
  ]);

  // Group localized guides by base slug (guide-x.it.md / guide-x.en.md → guide-x)
  const guideGroups = new Map();
  for (const sourcePath of guideDocs.sort()) {
    const file = path.basename(sourcePath, ".md"); // e.g. guide-1-how-it-works.it
    const langMatch = file.match(/\.(it|en)$/);
    const lang = langMatch ? langMatch[1] : "en";
    const baseSlug = langMatch ? file.slice(0, -(lang.length + 1)) : file;
    if (!guideGroups.has(baseSlug)) guideGroups.set(baseSlug, {});
    guideGroups.get(baseSlug)[lang] = sourcePath;
  }

  const sources = [
    ...[...guideGroups.entries()].map(([slug, langs], index) => ({
      localized: langs,
      group: "guides",
      slug,
      fallbackTitle: humanize(slug),
      order: index,
    })),
    {
      sourcePath: "README.md",
      group: "overview",
      slug: "framework",
      fallbackTitle: "Framework Overview",
      order: 50,
    },
    {
      sourcePath: "AGENTS.md",
      group: "overview",
      slug: "agent-rules",
      fallbackTitle: "Agent Rules",
      order: 51,
    },
    ...referenceDocs.sort().map((sourcePath, index) => ({
      sourcePath,
      group: "reference",
      slug: path.basename(sourcePath, ".md"),
      fallbackTitle: humanize(path.basename(sourcePath, ".md")),
      order: 100 + index,
    })),
    ...packageReadmes.sort().map((sourcePath, index) => {
      const packageName = sourcePath.split("/")[1];
      return {
        sourcePath,
        group: "packages",
        slug: packageName,
        fallbackTitle: packageTitle(packageName),
        order: 200 + index,
      };
    }),
  ];

  async function loadVariant(relPath, fallbackTitle) {
    const markdown = await readFile(path.join(workspaceRoot, relPath), "utf8");
    return {
      title: extractTitle(markdown) ?? fallbackTitle,
      summary: extractSummary(markdown),
      sourcePath: relPath,
    };
  }

  const docs = await Promise.all(
    sources.map(async (source) => {
      const translations = {};
      if (source.localized) {
        if (source.localized.it) translations.it = await loadVariant(source.localized.it, source.fallbackTitle);
        if (source.localized.en) translations.en = await loadVariant(source.localized.en, source.fallbackTitle);
        // Fill missing language from the other one.
        translations.it ??= translations.en;
        translations.en ??= translations.it;
      } else {
        const variant = await loadVariant(source.sourcePath, source.fallbackTitle);
        translations.en = variant;
        translations.it = variant;
      }
      const primary = translations.en ?? translations.it;
      return {
        title: primary.title,
        href: `/docs/${source.slug}`,
        slug: source.slug,
        group: source.group,
        groupLabel: groupLabels[source.group],
        sourcePath: primary.sourcePath,
        summary: primary.summary,
        translations,
        order: source.order,
      };
    }),
  );

  const mcpTools = await loadToolEntries();
  const mcpBookTools = await loadBookTools();
  const sortedEntries = docs.sort((left, right) => left.order - right.order).map(({ order: _order, ...entry }) => entry);
  // One loader for each text, by its source file: a document written once serves both languages with one chunk. Sorted, one line each, so that a
  // document added or removed on another branch is one line to merge.
  const texts = [...new Set([...sortedEntries.flatMap((entry) => Object.values(entry.translations).map((translation) => translation.sourcePath)), ...appGuides])].sort();
  const loaders = texts
    .map((sourcePath) => `  ${JSON.stringify(sourcePath)}: () => import(${JSON.stringify(`${path.relative(libRoot, path.join(workspaceRoot, sourcePath)).split(path.sep).join("/")}?raw`)}),\n`)
    .join("");
  const payload = `/* eslint-disable */\n` +
    `// This file is generated by scripts/generate-docs.mjs. Do not edit it manually.\n\n` +
    `export type DocGroup = "guides" | "overview" | "reference" | "packages";\n\n` +
    `export type DocLang = "it" | "en";\n\n` +
    `/** A document in one language: its title, its summary and the file its text comes from (loaded when the document is opened: see \`loadDocMarkdown\`). */\n` +
    `export type DocTranslation = {\n` +
    `  title: string;\n` +
    `  summary: string;\n` +
    `  sourcePath: string;\n` +
    `};\n\n` +
    `export type DocEntry = {\n` +
    `  title: string;\n` +
    `  href: string;\n` +
    `  slug: string;\n` +
    `  group: DocGroup;\n` +
    `  groupLabel: string;\n` +
    `  sourcePath: string;\n` +
    `  summary: string;\n` +
    `  translations: Partial<Record<DocLang, DocTranslation>>;\n` +
    `};\n\n` +
    `export type ToolEntry = {\n` +
    `  name: string;\n` +
    `  description: string;\n` +
    `  surface: "local" | "public";\n` +
    `  category: string;\n` +
    `};\n\n` +
    `/** The documents of the repository: titles and summaries only. The guides of the app are in \`appDocs.ts\`. */\n` +
    `export const docEntries: DocEntry[] = ${JSON.stringify(sortedEntries, null, 2)};\n\n` +
    `/**\n` +
    ` * The text of every document and guide, by its source file from the root of the repository: a chunk each, imported only when a page shows it\n` +
    ` * (and precached with the docs route by scripts/generate-precache.mjs). Nothing else imports these files: see test/docsLazyImports.test.mjs.\n` +
    ` */\n` +
    `export const docMarkdown: Record<string, () => Promise<{ default: string }>> = {\n${loaders}};\n\n` +
    `export const mcpTools: ToolEntry[] = ${JSON.stringify(mcpTools, null, 2)};\n`;

  await mkdir(outputRoot, { recursive: true });
  await writeFile(outputPath, payload, "utf8");
  await writeFile(bookToolsOutputPath, renderBookTools(mcpBookTools), "utf8");
  await writeFile(publicMetaOutputPath, `// This file is generated by scripts/generate-docs.mjs. Do not edit it manually.\nexport const PUBLIC_MCP_TOOL_COUNTS = ${JSON.stringify({ local: mcpTools.filter((tool) => tool.surface === "local").length, public: mcpTools.filter((tool) => tool.surface === "public").length })} as const;\n`, "utf8");
  const curatedSlugs = [...appDocsSource.matchAll(/entry\("([^"]+)"/g)].map((match) => match[1]);
  const generatedSlugs = docs.map((doc) => doc.slug);
  await writeFile(publicRoutesOutputPath, `${JSON.stringify([...new Set([...curatedSlugs, ...generatedSlugs])], null, 2)}\n`, "utf8");
}

const BOOK_TOOL_PERMISSIONS = ["read", "write", "run"];
const regenerateTools = "run `npm run docs:tools -w narrarium-server`";

/** The tools of a book's MCP, as the server wrote them, checked and rebuilt in one fixed shape (a list that is not what the page expects stops the build with the reason). */
async function loadBookTools() {
  const text = await readFile(bookToolsSourcePath, "utf8").catch(() => {
    throw new Error(`packages/server/mcp-tools.json cannot be read: ${regenerateTools}.`);
  });
  const list = JSON.parse(text);
  if (!Array.isArray(list?.tools) || list.tools.length === 0) throw new Error(`packages/server/mcp-tools.json has no tools: ${regenerateTools}.`);
  const names = new Set();
  return list.tools.map((tool) => {
    const fail = (reason) => {
      throw new Error(`packages/server/mcp-tools.json, ${tool?.name ?? "a tool"}: ${reason}. ${regenerateTools}.`);
    };
    if (typeof tool?.name !== "string" || !tool.name) fail("a tool without a name");
    if (names.has(tool.name)) fail("the tool is listed twice");
    names.add(tool.name);
    if (!BOOK_TOOL_PERMISSIONS.includes(tool.permission)) fail(`${JSON.stringify(tool.permission)} is not a permission (${BOOK_TOOL_PERMISSIONS.join(", ")})`);
    for (const field of ["title", "description"]) if (typeof tool[field] !== "string" || !tool[field].trim()) fail(`no ${field}`);
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint"]) if (typeof tool.annotations?.[hint] !== "boolean") fail(`${hint} is not true or false`);
    if (!Array.isArray(tool.parameters) || tool.parameters.some((parameter) => typeof parameter?.name !== "string" || typeof parameter.required !== "boolean")) fail("the parameters are not a list of names with true or false for required");
    return {
      name: tool.name,
      permission: tool.permission,
      title: tool.title,
      description: tool.description,
      annotations: { readOnlyHint: tool.annotations.readOnlyHint, destructiveHint: tool.annotations.destructiveHint, idempotentHint: tool.annotations.idempotentHint },
      parameters: tool.parameters.map((parameter) => ({ name: parameter.name, required: parameter.required })),
    };
  });
}

function renderBookTools(tools) {
  return `/* eslint-disable */\n` +
    `// This file is generated by scripts/generate-docs.mjs from packages/server/mcp-tools.json. Do not edit it manually.\n\n` +
    `export type BookToolPermission = ${BOOK_TOOL_PERMISSIONS.map((permission) => JSON.stringify(permission)).join(" | ")};\n\n` +
    `export type BookToolEntry = {\n` +
    `  name: string;\n` +
    `  permission: BookToolPermission;\n` +
    `  title: string;\n` +
    `  description: string;\n` +
    `  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };\n` +
    `  parameters: Array<{ name: string; required: boolean }>;\n` +
    `};\n\n` +
    `/**\n` +
    ` * The tools of a book's MCP on a personal server, in the order its endpoint lists them. The server writes the list (\`npm run docs:tools -w narrarium-server\`)\n` +
    ` * and its tests keep it true. Only the public /mcp page imports this module: see test/mcpBookTools.test.mjs.\n` +
    ` */\n` +
    `export const mcpBookTools: BookToolEntry[] = ${JSON.stringify(tools, null, 2)};\n`;
}

async function loadToolEntries() {
  const localTools = await parseToolFile(
    path.join(workspaceRoot, "packages", "mcp-server", "src", "index.ts"),
    "local",
  );
  const publicTools = await parseToolFile(
    path.join(workspaceRoot, "packages", "mcp-server", "src", "public-http-server.ts"),
    "public",
  );
  return [...localTools, ...publicTools].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

async function parseToolFile(filePath, surface) {
  const source = await readFile(filePath, "utf8");
  const matches = source.matchAll(/server\.tool\(\s*"([^"]+)"\s*,\s*"([\s\S]*?)"\s*,/g);
  const tools = [];
  for (const match of matches) {
    const name = match[1];
    const description = match[2].replace(/\s+/g, " ").trim();
    tools.push({ name, description, surface, category: toolCategory(name) });
  }
  return tools;
}

function packageTitle(value) {
  switch (value) {
    case "core":
      return "Core Package";
    case "mcp-server":
      return "MCP Server Package";
    case "create-narrarium-book":
      return "Create Book Package";
    case "astro-reader":
      return "Astro Reader Package";
    default:
      return humanize(value);
  }
}

function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function extractSummary(markdown) {
  const cleaned = markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\n\n+/)
    .map((block) => block.trim())
    .find(
      (block) =>
        block &&
        !block.startsWith("#") &&
        !block.startsWith("```") &&
        !block.startsWith("-") &&
        !block.startsWith("1."),
    );
  return cleaned ? cleaned.replace(/\s+/g, " ") : "Documentation entry.";
}

function humanize(value) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toolCategory(name) {
  if (name === "setup_framework" || name === "repository_spec" || name.startsWith("wikipedia_")) {
    return "Setup and research";
  }
  if (name.startsWith("start_wizard") || name.startsWith("wizard_") || name.endsWith("_wizard")) {
    return "Guided flows";
  }
  if (name === "init_book_repo" || name.startsWith("create_") || name.startsWith("register_") || name.startsWith("generate_")) {
    return "Creation and assets";
  }
  if (name.startsWith("update_") || name.startsWith("rename_")) {
    return "Updates and renames";
  }
  if (name.startsWith("search_") || name.startsWith("list_")) {
    return "Search and continuity";
  }
  if (name.startsWith("sync_") || name.startsWith("evaluate_") || name.startsWith("validate_") || name.startsWith("export_")) {
    return "Maintenance and output";
  }
  return "Other";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
