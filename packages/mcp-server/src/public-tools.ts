// ---------------------------------------------------------------------------
// Wikidata types
// ---------------------------------------------------------------------------

type WikidataEntitiesResponse = {
  entities?: Record<
    string,
    {
      missing?: boolean;
      labels?: Record<string, { value: string }>;
      descriptions?: Record<string, { value: string }>;
      claims?: Record<
        string,
        Array<{
          mainsnak: {
            datavalue?: {
              value: unknown;
            };
          };
        }>
      >;
    }
  >;
};

export type NormalizedWikidataClaims = {
  qid: string;
  label?: string;
  description?: string;
  born?: string;
  died?: string;
  gender?: string;
  nationality?: string;
  occupation?: string[];
  coordinates?: { lat: number; lng: number };
  country?: string;
  founded?: string;
  dissolved?: string;
  creator?: string;
};

// ---------------------------------------------------------------------------
// Wikidata fetch helpers
// ---------------------------------------------------------------------------

function formatWikidataTime(time: string, precision: number): string {
  // Wikidata format: "+1452-04-15T00:00:00Z" or "-0043-01-01T00:00:00Z"
  const bce = time.startsWith("-");
  const abs = time.replace(/^[+-]/, "");
  const datePart = abs.split("T")[0] ?? "";
  const parts = datePart.split("-");
  const year = parseInt(parts[0] ?? "0", 10);
  const month = parts[1];
  const day = parts[2];

  let result: string;
  if (precision >= 11 && month && day) {
    result = `${year}-${month}-${day}`;
  } else if (precision === 10 && month) {
    result = `${year}-${month}`;
  } else {
    result = String(year);
  }

  return bce ? `${result} BC` : result;
}

async function fetchEntityLabels(qids: string[], lang: string): Promise<Record<string, string>> {
  if (qids.length === 0) return {};
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.searchParams.set("action", "wbgetentities");
  url.searchParams.set("ids", qids.join("|"));
  url.searchParams.set("props", "labels");
  url.searchParams.set("languages", lang === "en" ? "en" : `${lang}|en`);
  url.searchParams.set("format", "json");

  const response = await fetch(url, {
    headers: { "user-agent": "Narrarium-Framework/0.1 (MCP server)" },
  });
  if (!response.ok) return {};

  const json = (await response.json()) as WikidataEntitiesResponse;
  const result: Record<string, string> = {};
  for (const [qid, entity] of Object.entries(json.entities ?? {})) {
    const label = entity.labels?.[lang]?.value ?? entity.labels?.["en"]?.value;
    if (label) result[qid] = label;
  }
  return result;
}

export async function fetchWikidataEntity(qid: string, lang: string): Promise<NormalizedWikidataClaims | null> {
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.searchParams.set("action", "wbgetentities");
  url.searchParams.set("ids", qid);
  url.searchParams.set("props", "claims|labels|descriptions");
  url.searchParams.set("languages", lang === "en" ? "en" : `${lang}|en`);
  url.searchParams.set("format", "json");

  const response = await fetch(url, {
    headers: { "user-agent": "Narrarium-Framework/0.1 (MCP server)" },
  });
  if (!response.ok) return null;

  const json = (await response.json()) as WikidataEntitiesResponse;
  const entity = json.entities?.[qid];
  if (!entity || entity.missing) return null;

  const claims = entity.claims ?? {};

  // Collect Q-IDs that need label resolution (entity-valued properties)
  const qidsToResolve = new Set<string>();
  for (const pid of ["P21", "P27", "P106", "P17", "P170"]) {
    for (const snak of claims[pid] ?? []) {
      const val = snak.mainsnak?.datavalue?.value;
      if (val && typeof val === "object" && "id" in val) {
        qidsToResolve.add((val as { id: string }).id);
      }
    }
  }

  const labelMap =
    qidsToResolve.size > 0 ? await fetchEntityLabels([...qidsToResolve], lang) : {};

  const getEntityLabel = (pid: string): string | undefined => {
    const snak = claims[pid]?.[0]?.mainsnak;
    if (!snak) return undefined;
    const val = snak.datavalue?.value;
    if (val && typeof val === "object" && "id" in val) {
      return labelMap[(val as { id: string }).id];
    }
    return undefined;
  };

  const getAllEntityLabels = (pid: string): string[] => {
    return (claims[pid] ?? [])
      .map((snak) => {
        const val = snak.mainsnak?.datavalue?.value;
        if (val && typeof val === "object" && "id" in val) {
          return labelMap[(val as { id: string }).id];
        }
        return undefined;
      })
      .filter((v): v is string => Boolean(v));
  };

  const getTimeValue = (pid: string): string | undefined => {
    const snak = claims[pid]?.[0]?.mainsnak;
    if (!snak) return undefined;
    const val = snak.datavalue?.value;
    if (val && typeof val === "object" && "time" in val && "precision" in val) {
      return formatWikidataTime(
        (val as { time: string }).time,
        (val as { precision: number }).precision,
      );
    }
    return undefined;
  };

  const coordVal = claims["P625"]?.[0]?.mainsnak?.datavalue?.value;
  const coordinates =
    coordVal && typeof coordVal === "object" && "latitude" in coordVal
      ? {
          lat: (coordVal as { latitude: number; longitude: number }).latitude,
          lng: (coordVal as { latitude: number; longitude: number }).longitude,
        }
      : undefined;

  const label = entity.labels?.[lang]?.value ?? entity.labels?.["en"]?.value;
  const description =
    entity.descriptions?.[lang]?.value ?? entity.descriptions?.["en"]?.value;

  return {
    qid,
    label,
    description,
    born: getTimeValue("P569"),
    died: getTimeValue("P570"),
    founded: getTimeValue("P571"),
    dissolved: getTimeValue("P576"),
    coordinates,
    gender: getEntityLabel("P21"),
    nationality: getEntityLabel("P27"),
    occupation: getAllEntityLabels("P106"),
    country: getEntityLabel("P17"),
    creator: getEntityLabel("P170"),
  };
}

// ---------------------------------------------------------------------------

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
    "- guidelines/writing-style.md for the always-on writing and review contract of the book",
    "- optional chapters/<slug>/writing-style.md and drafts/<slug>/writing-style.md for chapter-specific overrides",
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
    "- research/wikipedia/ (flat per-entity snapshots with Wikidata structured data)",
    "- assets/ with mirrored image folders such as assets/characters/<slug>/primary.png and primary.md",
    "",
    "Rules:",
    "- keep structured facts in frontmatter and prose in the markdown body",
    "- write character, item, location, faction, secret, and timeline-event names as plain text in prose; do not hand-author markdown links to canon files because the reader resolves visible mentions automatically",
    "- use stable ids like character:lyra-vale or chapter:001-the-arrival",
    "- search canon before inventing facts",
    "- use summaries and evaluations as first-class context",
    "- always use guidelines/writing-style.md while writing or reviewing prose, and apply any chapter-specific writing-style.md on top when present",
    "- keep state snapshots manual: update chapter resume state_changes and run sync_story_state when continuity changes",
    "- do not reveal secrets before known_from or reveal_in",
  ].join("\n");
}

export async function searchWikipedia(query: string, lang: string, limit: number) {
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

export async function fetchWikipediaPage(title: string, lang: string) {
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
    wikibase_item?: string;
  };

  return {
    title: json.title,
    description: json.description,
    extract: json.extract ?? "",
    url:
      json.content_urls?.desktop?.page ??
      `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(json.title.replace(/ /g, "_"))}`,
    wikidataId: json.wikibase_item,
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
