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
    `npx create-narrarium-book ${projectName}`,
    `--title ${quote(title)}`,
    `--language ${language}`,
    sample ? "--sample" : "",
    withReader ? `--with-reader --reader-dir ${readerDir}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const readerCommand = `npx narrarium-astro-reader ${readerDir} --book-root .. --package-name ${slugify(projectName)}-reader`;

  return [
    `Narrarium setup for ${projectName}`,
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
    "npx narrarium-mcp-server",
    "",
    "5. Recommended OpenCode flow:",
    "- enable the Narrarium MCP server locally",
    "- ask for book operations in natural language",
    "- let the agent use Narrarium tools to create canon, chapters, summaries, and evaluations",
    "",
    "Note: a Vercel-deployed Narrarium MCP is best for setup guidance, schema guidance, and Wikipedia research. Local filesystem writing still belongs to the local MCP server.",
  ].join("\n");
}

export function buildRepositorySpecSummary(): string {
  return [
    "Narrarium repository structure",
    "",
    "- book.md",
    "- guidelines/",
    "- guidelines/images.md for the shared visual style",
    "- guidelines/styles/ for explicit per-chapter prose profiles",
    "- characters/",
    "- items/",
    "- locations/",
    "- factions/",
    "- timelines/ and timelines/events/",
    "- secrets/",
    "- chapters/<nnn-slug>/chapter.md and numbered paragraph files",
    "- resumes/ and resumes/chapters/",
    "- state/, state/current.md, state/status.md, and state/chapters/",
    "- evaluations/ and evaluations/chapters/",
    "- research/wikipedia/en and research/wikipedia/it",
    "- assets/ with mirrored image folders such as assets/characters/<slug>/primary.png and primary.md",
    "",
    "Rules:",
    "- keep structured facts in frontmatter and prose in the markdown body",
    "- use stable ids like character:lyra-vale or chapter:001-the-arrival",
    "- search canon before inventing facts",
    "- use summaries and evaluations as first-class context",
    "- use book-level prose defaults unless a chapter explicitly declares style_refs, narration_person, narration_tense, or prose_mode",
    "- keep state snapshots manual: update chapter resume state_changes and run sync_story_state when continuity changes",
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
      "user-agent": "Narrarium-Framework/0.1 (MCP server)",
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
      "user-agent": "Narrarium-Framework/0.1 (MCP server)",
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
    .replace(/^-+|-+$/g, "") || "narrarium-book";
}
