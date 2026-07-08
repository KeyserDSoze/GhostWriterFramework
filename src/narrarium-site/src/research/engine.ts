// ─── Deep Research Engine ─────────────────────────────────────────────────────
// Orchestrates: LLM query generation → provider search → LLM synthesis → save.

import { stringify } from "yaml";
import type { AppSettings } from "@/types/settings";
import type { BookEntry } from "@/types/settings";
import { completeText } from "@/assistant/llm";
import { completeTextRouted } from "@/assistant/router";
import { createOrUpdateTextFile } from "@/github/githubClient";
import { getProvidersForMode } from "./providers";
import type { ResearchFrontmatter, ResearchResult, ResearchSourceMode, ResearchDepth } from "./types";
import { DEPTH_CONFIG } from "./types";
import { useCostsStore, bucketTotal } from "@/costs/costsStore";
import { aggregateAll } from "@/costs/costsStore";
import type { ChatCapability } from "@/types/settings";
import type { LlmMessage } from "@/assistant/llm";

export interface RunDeepResearchInput {
  settings: AppSettings;
  book: BookEntry;
  branch: string;
  token: string;
  /** Original query / request from the user */
  query: string;
  sourceMode: ResearchSourceMode;
  depth: ResearchDepth;
  /** Target language for the final document (e.g. "it", "en") */
  language: string;
  /** Optional entity this research is about */
  relatedEntityId?: string;
  relatedEntityType?: string;
  /** Optional: bypass the router and use a specific integration+model */
  overrideIntegrationId?: string;
  overrideModelName?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface RunDeepResearchResult {
  path: string;
  slug: string;
  title: string;
  markdown: string;
  /** Cost in the user's pricing currency for this research run (0 if no pricing configured). */
  cost: number;
}

function reportProgress(input: RunDeepResearchInput, message: string) {
  input.onProgress?.(message);
}

/** Complete text with optional per-run LLM override, falling back to the router. */
async function completeForResearch(
  input: RunDeepResearchInput,
  messages: LlmMessage[],
  capability: ChatCapability,
  options?: { signal?: AbortSignal; label?: string },
): Promise<string> {
  if (input.overrideIntegrationId && input.overrideModelName) {
    const integration = (input.settings.aiIntegrations ?? []).find((i) => i.id === input.overrideIntegrationId);
    if (integration) {
      return await completeText(integration, messages, "writing", {
        modelName: input.overrideModelName,
        capability,
        signal: options?.signal,
        label: options?.label,
      });
    }
  }
  return await completeTextRouted(input.settings, messages, capability, options);
}

/** Ask the LLM to generate search queries for the given user request. */
async function generateQueries(input: RunDeepResearchInput): Promise<string[]> {
  const maxQueries = DEPTH_CONFIG[input.depth].maxQueries;
  const messages = [
    {
      role: "system" as const,
      content: [
        `You are a research assistant. Given a user research request, generate ${maxQueries} focused search queries`,
        `to find relevant information. The queries should cover different angles of the topic.`,
        `Respond with a JSON array of strings, nothing else. Example: ["query 1", "query 2"]`,
        `Queries should be effective for ${input.sourceMode === "wikipedia" ? "Wikipedia" : "web"} searches.`,
        `Language for queries: ${input.language}`,
      ].join(" "),
    },
    {
      role: "user" as const,
      content: `Research request: "${input.query}"\n\nGenerate ${maxQueries} search queries as a JSON array.`,
    },
  ];

  const raw = await completeForResearch(input, messages, "deep-research", {
    signal: input.signal,
    label: "deep-research:generate-queries",
  });

  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match?.[0] ?? raw) as unknown;
    if (Array.isArray(parsed)) {
      return (parsed as unknown[])
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .slice(0, maxQueries);
    }
  } catch {
    // fall through
  }

  // Fallback: use the original query
  return [input.query];
}

/** Synthesize collected results into a structured research document. */
async function synthesize(input: RunDeepResearchInput, results: ResearchResult[]): Promise<{ title: string; markdown: string }> {
  const resultsText = results
    .map((r, i) => `[${i + 1}] **${r.title}**\nURL: ${r.url}\n${r.body ?? r.snippet}`)
    .join("\n\n---\n\n");

  const entityContext = input.relatedEntityId
    ? `\nThis research is related to the entity: ${input.relatedEntityType ?? "entity"} "${input.relatedEntityId}".`
    : "";

  const messages = [
    {
      role: "system" as const,
      content: [
        `You are a research assistant for a book author. Synthesize the following research results into`,
        `a well-structured Markdown document in ${input.language}.`,
        `The document must include:`,
        `- A clear title (H1)`,
        `- A brief summary paragraph`,
        `- Main findings organized in sections`,
        `- A "Sources" section listing the URLs`,
        `- A "Narrative Notes" section with suggestions for how this research could be used in the book`,
        `Write in ${input.language}. Be thorough but concise.`,
      ].join(" "),
    },
    {
      role: "user" as const,
      content: `Original research request: "${input.query}"${entityContext}\n\nDepth: ${input.depth}\n\nCollected sources:\n\n${resultsText}`,
    },
  ];

  const markdown = await completeForResearch(input, messages, "deep-research", {
    signal: input.signal,
    label: "deep-research:synthesize",
  });

  // Extract the title from the first H1 in the response
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? input.query;

  return { title, markdown };
}

function slugifyResearch(query: string): string {
  return query
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase()
    .slice(0, 60);
}

function renderResearchFile(frontmatter: ResearchFrontmatter, body: string): string {
  const fm = stringify(frontmatter as unknown as Record<string, unknown>).trimEnd();
  return `---\n${fm}\n---\n\n${body.replace(/^\n+/, "")}\n`;
}

/** Main entry point: run the full deep research pipeline and save the result. */
export async function runDeepResearch(input: RunDeepResearchInput): Promise<RunDeepResearchResult> {
  const costBefore = bucketTotal(aggregateAll(useCostsStore.getState().file));

  reportProgress(input, "Generating search queries…");
  const queries = await generateQueries(input);

  const providers = getProvidersForMode(input.sourceMode);
  const allResults: ResearchResult[] = [];
  const usedProviders = new Set<string>();

  for (const query of queries) {
    if (input.signal?.aborted) throw new Error("Aborted");
    reportProgress(input, `Searching: "${query}"`);
    for (const provider of providers) {
      try {
        const results = await provider.search(query, {
          depth: input.depth,
          language: input.language,
          signal: input.signal,
        });
        for (const r of results) {
          if (!allResults.some((existing) => existing.url === r.url)) {
            allResults.push(r);
            usedProviders.add(r.provider);
          }
        }
      } catch {
        // Provider failed – continue with others
      }
    }
  }

  if (allResults.length === 0) {
    throw new Error("No results found. Try a different query or source mode.");
  }

  reportProgress(input, `Synthesizing ${allResults.length} results…`);
  const { title, markdown: body } = await synthesize(input, allResults);

  const costAfter = bucketTotal(aggregateAll(useCostsStore.getState().file));
  const costDelta = Math.max(0, costAfter - costBefore);

  const now = new Date().toISOString();
  const datePrefix = now.slice(0, 10);
  const slug = `${datePrefix}-${slugifyResearch(input.query)}`;
  const path = `research/${slug}.md`;

  const frontmatter: ResearchFrontmatter = {
    id: `research:${slug}`,
    title,
    createdAt: now,
    updatedAt: now,
    query: input.query,
    sourceMode: input.sourceMode,
    depth: input.depth,
    language: input.language,
    providers: Array.from(usedProviders),
    costEur: costDelta,
    ...(input.relatedEntityId ? { relatedEntityId: input.relatedEntityId } : {}),
    ...(input.relatedEntityType ? { relatedEntityType: input.relatedEntityType } : {}),
  };

  const fullMarkdown = renderResearchFile(frontmatter, body);

  reportProgress(input, "Saving research document…");
  await createOrUpdateTextFile(
    input.token,
    input.book.owner,
    input.book.repo,
    input.branch,
    path,
    fullMarkdown,
    `Add research: ${title}`,
  );

  return { path, slug, title, markdown: fullMarkdown, cost: costDelta };
}
