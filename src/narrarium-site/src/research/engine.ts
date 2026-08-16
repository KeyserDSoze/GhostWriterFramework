// ─── Deep Research Engine ─────────────────────────────────────────────────────
// Orchestrates: LLM query generation → provider search router → synthesis → save.

import { stringify } from "yaml";
import type { AppSettings } from "@/types/settings";
import type { BookEntry } from "@/types/settings";
import { completeTextRouted } from "@/assistant/router";
import type { ChatCapability, ResearchIntent } from "@/types/settings";
import type { LlmMessage } from "@/assistant/llm";
import type { ResearchFrontmatter, ResearchResult, ResearchDepth, ResearchSourceMode } from "./types";
import { DEPTH_CONFIG } from "./types";
import { useCostsStore, bucketTotal, aggregateAll } from "@/costs/costsStore";
import { runResearchRouter } from "./ResearchRouter";
import { captureImmediateMutation, commitImmediateMutation, mergeManagedFrontmatter } from "@/assistant/immediateMutation";
import { resolveRepositoryHeadForMutation } from "@/repository/safeRepositoryMutation";
import { parseDocument } from "yaml";
import { currentRequest, untrustedData } from "@/assistant/promptTrust";
import { beginAccountScopedAiOperation } from "@/assistant/accountScopedOperation";

export interface RunDeepResearchInput {
  settings: AppSettings;
  book: BookEntry;
  branch: string;
  token: string;
  query: string;
  /** Legacy selector kept for compatibility; converted to intents when explicit intents are absent. */
  sourceMode?: ResearchSourceMode;
  depth: ResearchDepth;
  language: string;
  intents?: ResearchIntent[];
  relatedEntityId?: string;
  relatedEntityType?: string;
  overrideIntegrationId?: string;
  overrideModelName?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  expectedRemoteHeadSha?: string;
  accountScope: string | null;
}

export interface RunDeepResearchResult {
  path: string;
  slug: string;
  title: string;
  markdown: string;
  cost: number;
  providers: string[];
  providerUsage: ResearchFrontmatter["providerUsage"];
  intentsResolved: NonNullable<ResearchFrontmatter["intents"]>;
  unavailableSummary: string[];
}

function reportProgress(input: RunDeepResearchInput, message: string) {
  input.onProgress?.(message);
}

function normalizeSelectedIntents(input: RunDeepResearchInput): ResearchIntent[] {
  if (input.intents?.length) return input.intents;
  return input.sourceMode === "wikipedia" ? ["encyclopedia"] : ["auto"];
}

async function completeForResearch(
  input: RunDeepResearchInput,
  messages: LlmMessage[],
  capability: ChatCapability,
  options?: { signal?: AbortSignal; label?: string },
): Promise<string> {
  if (input.overrideIntegrationId && input.overrideModelName) {
    return await completeTextRouted(input.settings, messages, capability, {
      accountScope: input.accountScope,
      ...options,
      preferred: { integrationId: input.overrideIntegrationId, model: input.overrideModelName },
    });
  }
  return await completeTextRouted(input.settings, messages, capability, { ...options, accountScope: input.accountScope });
}

async function generateQueries(input: RunDeepResearchInput): Promise<string[]> {
  const maxQueries = DEPTH_CONFIG[input.depth].maxQueries;
  const selectedIntents = normalizeSelectedIntents(input).join(", ");
  const messages = [
    {
      role: "system" as const,
      content: [
        `You are a research assistant. Given a user research request, generate ${maxQueries} focused search queries`,
        `to find relevant information. The queries should cover different angles of the topic.`,
        `Respond with a JSON array of strings, nothing else. Example: ["query 1", "query 2"]`,
        `The active research intents are: ${selectedIntents}.`,
        `Language for queries: ${input.language}`,
      ].join(" "),
    },
    {
      role: "user" as const,
      content: `${currentRequest(`Generate ${maxQueries} search queries as a JSON array.`)}\n\n${untrustedData("user_content", input.query)}`,
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
  return [input.query];
}

async function synthesize(input: RunDeepResearchInput, results: ResearchResult[], providerSummary: string[]): Promise<{ title: string; markdown: string }> {
  const resultsText = results
    .map((r, i) => `[${i + 1}] **${r.title}**\nProvider: ${r.provider}\nURL: ${r.url}\n${r.body ?? r.snippet ?? ""}`)
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
        `- A final transparency note that mentions the providers actually used`,
        `Write in ${input.language}. Be thorough but concise.`,
      ].join(" "),
    },
    {
      role: "user" as const,
      content: `${currentRequest("Synthesize the collected research into the requested document.")}\n\n${untrustedData("user_content", `Original request: ${input.query}${entityContext}\nDepth: ${input.depth}`)}\n\n${untrustedData("metadata", providerSummary.join("\n"))}\n\n${untrustedData("external_content", resultsText)}`,
    },
  ];

  const markdown = await completeForResearch(input, messages, "deep-research", {
    signal: input.signal,
    label: "deep-research:synthesize",
  });

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

export async function runDeepResearch(input: RunDeepResearchInput): Promise<RunDeepResearchResult> {
  const operation = beginAccountScopedAiOperation(input.signal, input.accountScope);
  operation.signal.throwIfAborted();
  input = { ...input, signal: operation.signal, accountScope: operation.accountScope };
  try {
  const expectedRemoteHeadSha = input.expectedRemoteHeadSha ?? await resolveRepositoryHeadForMutation(input);
  const costBefore = bucketTotal(aggregateAll(useCostsStore.getState().file));

  reportProgress(input, "Generating search queries…");
  const queries = await generateQueries(input);

  const combinedResults: ResearchResult[] = [];
  const providerUsage: NonNullable<ResearchFrontmatter["providerUsage"]> = [];
  let intentsResolved: NonNullable<ResearchFrontmatter["intents"]> = [];
  const unavailableSummary = new Set<string>();

  for (const query of queries) {
    if (input.signal?.aborted) throw new Error("Aborted");
    reportProgress(input, `Searching: "${query}"`);
    const routed = await runResearchRouter({
      settings: input.settings,
      query,
      language: input.language,
      depth: input.depth,
      intents: normalizeSelectedIntents(input),
      signal: input.signal,
      onProgress: input.onProgress,
    });
    intentsResolved = [...new Set([...intentsResolved, ...routed.intentsResolved])];
    routed.results.forEach((result) => combinedResults.push(result));
    routed.providerUsage.forEach((usage) => providerUsage.push(usage));
    routed.unavailableIntents.forEach((intent) => unavailableSummary.add(intent));
  }

  const deduped = combinedResults.filter((result, index, arr) => arr.findIndex((entry) => entry.url === result.url) === index);
  if (deduped.length === 0) throw new Error("No results found. Try a different query or intent.");

  const providerSummary = buildProviderSummary(providerUsage, unavailableSummary);
  reportProgress(input, `Synthesizing ${deduped.length} results…`);
  const { title, markdown: body } = await synthesize(input, deduped, providerSummary);

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
    sourceMode: (intentsResolved.length === 1 && intentsResolved[0] === "encyclopedia") ? "wikipedia" : "internet",
    depth: input.depth,
    language: input.language,
    providers: [...new Set(providerUsage.filter((p) => p.ok && p.resultCount > 0).map((p) => p.provider))],
    intents: normalizeSelectedIntents(input),
    providerUsage,
    costEur: costDelta,
    ...(input.relatedEntityId ? { relatedEntityId: input.relatedEntityId } : {}),
    ...(input.relatedEntityType ? { relatedEntityType: input.relatedEntityType } : {}),
  };

  const snapshot = await captureImmediateMutation({ token: input.token, book: input.book, branch: input.branch, path, remoteHeadSha: expectedRemoteHeadSha });
  const existingMatch = snapshot.content ? /^---\r?\n([\s\S]*?)\r?\n---/.exec(snapshot.content) : null;
  const existingFrontmatter = existingMatch ? ((parseDocument(existingMatch[1]).toJSON() as Record<string, unknown>) ?? {}) : {};
  if (typeof existingFrontmatter.createdAt === "string") frontmatter.createdAt = existingFrontmatter.createdAt;
  const mergedFrontmatter = mergeManagedFrontmatter(existingFrontmatter, frontmatter as unknown as Record<string, unknown>, [...Object.keys(frontmatter), "relatedEntityId", "relatedEntityType"]);
  const fullMarkdown = `---\n${stringify(mergedFrontmatter).trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}\n`;
  reportProgress(input, "Saving research document…");
  await commitImmediateMutation({ token: input.token, book: input.book, branch: input.branch, snapshot, content: fullMarkdown, message: `${snapshot.content ? "Update" : "Add"} research: ${title}`, signal: input.signal });

  return { path, slug, title, markdown: fullMarkdown, cost: costDelta, providers: frontmatter.providers, providerUsage, intentsResolved, unavailableSummary: [...unavailableSummary] };
  } finally {
    operation.dispose();
  }
}

function buildProviderSummary(providerUsage: NonNullable<ResearchFrontmatter["providerUsage"]>, unavailableIntents: Set<string>): string[] {
  const lines: string[] = [];
  const byIntent = new Map<string, string[]>();
  for (const usage of providerUsage) {
    const line = usage.ok ? `${usage.provider}: ${usage.resultCount} result(s)` : `${usage.provider}: failed (${usage.error ?? "unknown error"})`;
    byIntent.set(usage.intent, [...(byIntent.get(usage.intent) ?? []), line]);
  }
  for (const [intent, entries] of byIntent) lines.push(`${intent}: ${entries.join(", ")}`);
  for (const intent of unavailableIntents) lines.push(`${intent}: unavailable`);
  return lines;
}
