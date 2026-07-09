import type { ResearchProvider, ResearchProviderResult, ResearchResult, SearchOptions } from "./types";
import { DEPTH_CONFIG } from "./types";

interface TavilyItem {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

export class TavilyProvider implements ResearchProvider {
  readonly id = "tavily" as const;
  readonly label = "Tavily";
  readonly intent = "internet" as const;
  readonly requiresApiKey = true;
  readonly browserCompatible = true;

  isConfigured(config: { apiKey?: string }): boolean { return Boolean(config.apiKey?.trim()); }

  async search(query: string, options: SearchOptions & { apiKey?: string }): Promise<ResearchProviderResult> {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) return { provider: this.id, intent: this.intent, results: [], error: "Tavily API key not configured" };
    const maxResults = DEPTH_CONFIG[options.depth].maxResultsPerQuery;
    try {
      const resp = await fetch("https://api.tavily.com/search", {
        method: "POST",
        signal: options.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, include_answer: false, include_raw_content: false, search_depth: options.depth === "high" ? "advanced" : "basic" }),
      });
      if (!resp.ok) throw new Error(`Tavily: ${resp.status}`);
      const data = await resp.json() as { results?: TavilyItem[] };
      const results: ResearchResult[] = (data.results ?? []).filter((item) => item.url && item.title).map((item, index) => ({
        id: `tavily:${index}:${item.url}`,
        title: item.title ?? query,
        url: item.url ?? "",
        snippet: item.content,
        source: new URL(item.url ?? "https://tavily.com").hostname,
        provider: this.id,
        intent: this.intent,
        publishedAt: item.published_date,
        raw: item,
      }));
      return { provider: this.id, intent: this.intent, results };
    } catch (err) {
      return { provider: this.id, intent: this.intent, results: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
}
