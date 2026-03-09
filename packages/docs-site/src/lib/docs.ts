import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import { marked } from "marked";

export type DocGroup = "overview" | "reference" | "packages";

export type DocEntry = {
  title: string;
  href: string;
  slug: string[];
  group: DocGroup;
  groupLabel: string;
  sourcePath: string;
  summary: string;
  html: string;
};

export type ToolEntry = {
  name: string;
  description: string;
  surface: "local" | "public";
  category: string;
};

const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

let docsPromise: Promise<DocEntry[]> | null = null;
let toolsPromise: Promise<ToolEntry[]> | null = null;

export async function getDocEntries(): Promise<DocEntry[]> {
  docsPromise ??= loadDocEntries();
  return docsPromise;
}

export async function getDocGroups(): Promise<Array<{ key: DocGroup; label: string; docs: DocEntry[] }>> {
  const docs = await getDocEntries();
  const groups: DocGroup[] = ["overview", "reference", "packages"];
  return groups.map((key) => ({
    key,
    label: groupLabel(key),
    docs: docs.filter((entry) => entry.group === key),
  }));
}

export async function getDocBySlug(slug: string[]): Promise<DocEntry | undefined> {
  const docs = await getDocEntries();
  return docs.find((entry) => entry.slug.join("/") === slug.join("/"));
}

export async function getMcpTools(): Promise<ToolEntry[]> {
  toolsPromise ??= loadToolEntries();
  return toolsPromise;
}

export async function getOpencodeConfig(): Promise<string> {
  return readFile(path.join(workspaceRoot, "opencode.jsonc"), "utf8");
}

async function loadDocEntries(): Promise<DocEntry[]> {
  const packageReadmes = await fg("packages/*/README.md", {
    cwd: workspaceRoot,
    onlyFiles: true,
  });
  const referenceDocs = await fg("docs/**/*.md", {
    cwd: workspaceRoot,
    onlyFiles: true,
  });

  const sources = [
    { sourcePath: "README.md", group: "overview" as const, slug: ["framework"], fallbackTitle: "Framework Overview", order: 0 },
    { sourcePath: "AGENTS.md", group: "overview" as const, slug: ["agent-rules"], fallbackTitle: "Agent Rules", order: 1 },
    ...referenceDocs.sort().map((sourcePath, index) => ({
      sourcePath,
      group: "reference" as const,
      slug: [path.basename(sourcePath, ".md")],
      fallbackTitle: humanize(path.basename(sourcePath, ".md")),
      order: 100 + index,
    })),
    ...packageReadmes.sort().map((sourcePath, index) => {
      const packageName = sourcePath.split("/")[1];
      return {
        sourcePath,
        group: "packages" as const,
        slug: [packageName],
        fallbackTitle: packageTitle(packageName),
        order: 200 + index,
      };
    }),
  ];

  const docs = await Promise.all(
    sources.map(async (source) => {
      const absolutePath = path.join(workspaceRoot, source.sourcePath);
      const markdown = await readFile(absolutePath, "utf8");
      const title = extractTitle(markdown) ?? source.fallbackTitle;
      const html = await marked.parse(markdown);

      return {
        title,
        href: `/docs/${source.slug.join("/")}/`,
        slug: source.slug,
        group: source.group,
        groupLabel: groupLabel(source.group),
        sourcePath: source.sourcePath,
        summary: extractSummary(markdown),
        html,
        order: source.order,
      };
    }),
  );

  return docs
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...entry }) => entry);
}

async function loadToolEntries(): Promise<ToolEntry[]> {
  const localTools = await parseToolFile(path.join(workspaceRoot, "packages", "mcp-server", "src", "index.ts"), "local");
  const publicTools = await parseToolFile(path.join(workspaceRoot, "packages", "mcp-server", "src", "public-http-server.ts"), "public");
  return [...localTools, ...publicTools].sort((left, right) => left.name.localeCompare(right.name));
}

async function parseToolFile(filePath: string, surface: "local" | "public"): Promise<ToolEntry[]> {
  const source = await readFile(filePath, "utf8");
  const matches = source.matchAll(/server\.tool\(\s*"([^"]+)"\s*,\s*"([\s\S]*?)"\s*,/g);
  const tools: ToolEntry[] = [];

  for (const match of matches) {
    const name = match[1];
    const description = match[2].replace(/\s+/g, " ").trim();
    tools.push({
      name,
      description,
      surface,
      category: toolCategory(name),
    });
  }

  return tools;
}

function groupLabel(group: DocGroup): string {
  switch (group) {
    case "overview":
      return "Overview";
    case "reference":
      return "Reference";
    case "packages":
      return "Packages";
  }
}

function packageTitle(value: string): string {
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

function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function extractSummary(markdown: string): string {
  const cleaned = markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\n\n+/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith("#") && !block.startsWith("```") && !block.startsWith("-") && !block.startsWith("1."));

  return cleaned ? cleaned.replace(/\s+/g, " ") : "Documentation entry.";
}

function humanize(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toolCategory(name: string): string {
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
