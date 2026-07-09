import type { AppSettings } from "@/types/settings";
import { providerById, providersForIntent } from "./providers";
import { fetchContentForResult } from "./ContentFetcher";
import { resolveResearchIntents } from "./IntentResolver";
import type { FetchedContent, ResearchIntent, ResearchProviderId, ResearchProviderUsage, ResearchResult, ResearchRoutableIntent } from "./types";
import { DEPTH_CONFIG } from "./types";

export interface ResearchRouterInput {
  settings: AppSettings;
  query: string;
  language: string;
  depth: "low" | "medium" | "high";
  intents: ResearchIntent[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ResearchRouterResult {
  intentsResolved: ResearchRoutableIntent[];
  results: ResearchResult[];
  fetched: FetchedContent[];
  providerUsage: ResearchProviderUsage[];
  unavailableIntents: ResearchRoutableIntent[];
}

function apiKeyForProvider(settings: AppSettings, provider: ResearchProviderId): string | undefined {
  if (provider === "brave") return settings.deepSearch.braveApiKey;
  if (provider === "tavily") return settings.deepSearch.tavilyApiKey;
  return undefined;
}

function configuredForIntent(settings: AppSettings, intent: ResearchRoutableIntent): boolean {
  if (intent !== "internet") return true;
  return Boolean(settings.deepSearch.braveApiKey.trim() || settings.deepSearch.tavilyApiKey.trim());
}

function providerOrder(settings: AppSettings, intent: ResearchRoutableIntent) {
  const route = settings.deepSearch.routes[intent];
  const ids = [...(route.primary ? [route.primary] : []), ...route.fallbacks];
  const unique: ResearchProviderId[] = [];
  for (const id of ids) if (!unique.includes(id)) unique.push(id);
  const explicit = unique.map((id) => providerById(id)).filter((provider): provider is NonNullable<ReturnType<typeof providerById>> => Boolean(provider));
  const fallback = providersForIntent(intent).filter((p) => !unique.includes(p.id));
  return [...explicit, ...fallback];
}

function dedupeResults(results: ResearchResult[]): ResearchResult[] {
  const seen = new Set<string>();
  const out: ResearchResult[] = [];
  for (const result of results) {
    const key = result.url.replace(/#.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

function scoreResult(result: ResearchResult): number {
  let score = result.score ?? 0;
  if (result.intent === "encyclopedia") score += 5;
  if (result.intent === "news") score += 4;
  if (result.provider === "wikipedia") score += 3;
  if (result.provider === "wikidata") score += 2;
  if (result.provider === "brave") score += 3;
  if (result.provider === "gdelt") score += 3;
  if (result.publishedAt) score += 1;
  return score;
}

function sortResults(results: ResearchResult[]): ResearchResult[] {
  return results.slice().sort((a, b) => scoreResult(b) - scoreResult(a));
}

export async function runResearchRouter(input: ResearchRouterInput): Promise<ResearchRouterResult> {
  const intentsResolved = resolveResearchIntents(input.query, input.intents);
  const unavailableIntents = intentsResolved.filter((intent) => !configuredForIntent(input.settings, intent));
  const effectiveIntents = intentsResolved.filter((intent) => configuredForIntent(input.settings, intent));
  const providerUsage: ResearchProviderUsage[] = [];
  let results: ResearchResult[] = [];

  for (const intent of effectiveIntents) {
    const providers = providerOrder(input.settings, intent);
    let fanout = 0;
    for (const provider of providers) {
      if (fanout >= DEPTH_CONFIG[input.depth].providerFanout) break;
      const apiKey = apiKeyForProvider(input.settings, provider.id);
      if (provider.requiresApiKey && !provider.isConfigured({ apiKey })) {
        providerUsage.push({ provider: provider.id, intent, ok: false, resultCount: 0, error: "not configured" });
        continue;
      }
      input.onProgress?.(`Searching ${provider.label}…`);
      const response = await provider.search(input.query, { depth: input.depth, language: input.language, intent, apiKey, signal: input.signal });
      providerUsage.push({ provider: provider.id, intent, ok: !response.error, resultCount: response.results.length, error: response.error });
      results.push(...response.results);
      fanout += 1;
    }
  }

  results = sortResults(dedupeResults(results));
  const fetched: FetchedContent[] = [];
  const fetchTop = DEPTH_CONFIG[input.depth].fetchTop;
  for (const result of results.slice(0, fetchTop)) {
    input.onProgress?.(`Reading ${result.source || result.provider}…`);
    const content = result.body?.trim()
      ? { url: result.url, title: result.title, text: result.body, status: "ok" as const, source: "direct" as const }
      : await fetchContentForResult(input.settings, result, input.signal);
    fetched.push(content);
    if (content.text?.trim()) result.body = content.text;
  }

  return { intentsResolved, results, fetched, providerUsage, unavailableIntents };
}
