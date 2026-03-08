export function buildSetupInstructions(options: {
  projectName?: string;
  title?: string;
  language?: string;
  withReader?: boolean;
  sample?: boolean;
  readerDir?: string;
}): string {
  const projectName = options.projectName?.trim() || "my-book";
  const title = options.title?.trim() || "My Book";
  const language = options.language?.trim() || "en";
  const withReader = options.withReader ?? true;
  const sample = options.sample ?? false;
  const readerDir = options.readerDir?.trim() || "reader";
  const createBookCommand = [
    `npx @ghostwriter/create-book ${projectName}`,
    `--title ${quote(title)}`,
    `--language ${language}`,
    sample ? "--sample" : "",
    withReader ? `--with-reader --reader-dir ${readerDir}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const readerCommand = `npx @ghostwriter/astro-reader ${readerDir} --book-root .. --package-name ${slugify(projectName)}-reader`;

  return [
    `GhostWriter setup for ${projectName}`,
    "",
    "1. Scaffold the book repository:",
    createBookCommand,
    "",
    "2. Move into the repository:",
    `cd ${projectName}`,
    "",
    "3. If you did not create the reader during setup, scaffold it later with:",
    readerCommand,
    "",
    "4. Run the local MCP server when you want repository-writing tools:",
    "npx @ghostwriter/mcp-server",
    "",
    "5. Recommended OpenCode flow:",
    "- enable the GhostWriter MCP server locally",
    "- ask for book operations in natural language",
    "- let the agent use GhostWriter tools to create canon, chapters, summaries, and evaluations",
    "",
    "Note: a Vercel-deployed GhostWriter MCP is best for setup guidance, schema guidance, and Wikipedia research. Local filesystem writing still belongs to the local MCP server.",
  ].join("\n");
}

export function buildRepositorySpecSummary(): string {
  return [
    "GhostWriter repository structure",
    "",
    "- book.md",
    "- guidelines/",
    "- characters/",
    "- items/",
    "- locations/",
    "- factions/",
    "- timelines/ and timelines/events/",
    "- secrets/",
    "- chapters/<nnn-slug>/chapter.md and numbered paragraph files",
    "- resumes/ and resumes/chapters/",
    "- evaluations/ and evaluations/chapters/",
    "- research/wikipedia/en and research/wikipedia/it",
    "- assets/",
    "",
    "Rules:",
    "- keep structured facts in frontmatter and prose in the markdown body",
    "- use stable ids like character:lyra-vale or chapter:001-the-arrival",
    "- search canon before inventing facts",
    "- use summaries and evaluations as first-class context",
    "- do not reveal secrets before known_from or reveal_in",
  ].join("\n");
}

export async function searchWikipedia(query: string, lang: "en" | "it", limit: number) {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", query);
  url.searchParams.set("utf8", "1");
  url.searchParams.set("format", "json");
  url.searchParams.set("srlimit", String(limit));

  const response = await fetch(url, {
    headers: {
      "user-agent": "GhostWriterFramework/0.1 (MCP server)",
    },
  });

  if (!response.ok) {
    throw new Error(`Wikipedia search failed with status ${response.status}.`);
  }

  const json = (await response.json()) as {
    query?: { search?: Array<{ title: string; snippet: string }> };
  };

  return (json.query?.search ?? []).map((entry) => ({
    title: entry.title,
    snippet: stripHtml(entry.snippet),
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(entry.title.replace(/ /g, "_"))}`,
  }));
}

export async function fetchWikipediaPage(title: string, lang: "en" | "it") {
  const url = new URL(
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
  );

  const response = await fetch(url, {
    headers: {
      "user-agent": "GhostWriterFramework/0.1 (MCP server)",
    },
  });

  if (!response.ok) {
    throw new Error(`Wikipedia page fetch failed with status ${response.status}.`);
  }

  const json = (await response.json()) as {
    title: string;
    description?: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
  };

  return {
    title: json.title,
    description: json.description,
    extract: json.extract ?? "",
    url:
      json.content_urls?.desktop?.page ??
      `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(json.title.replace(/ /g, "_"))}`,
  };
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "ghostwriter-book";
}
