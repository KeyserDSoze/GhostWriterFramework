import type { ResearchProvider, ResearchProviderResult, ResearchResult, SearchOptions } from "./types";
import { DEPTH_CONFIG } from "./types";

interface BraveItem {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string;
  language?: string;
}

export class BraveSearchProvider implements ResearchProvider {
  readonly id = "brave" as const;
  readonly label = "Brave Search";
  readonly intent = "internet" as const;
  readonly requiresApiKey = true;
  readonly browserCompatible = true;

  isConfigured(config: { apiKey?: string }): boolean { return Boolean(config.apiKey?.trim()); }

  async search(query: string, options: SearchOptions & { apiKey?: string }): Promise<ResearchProviderResult> {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) return { provider: this.id, intent: this.intent, results: [], error: "Brave API key not configured" };
    const lang = options.language.split("-")[0].toLowerCase() || "en";
    const country = lang === "it" ? "IT" : "US";
    const count = DEPTH_CONFIG[options.depth].maxResultsPerQuery;
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&country=${country}&search_lang=${lang}`;
    try {
      const resp = await fetch(url, {
        signal: options.signal,
        headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
      });
      if (!resp.ok) throw new Error(`Brave: ${resp.status}`);
      const data = await resp.json() as { web?: { results?: BraveItem[] } };
      const results: ResearchResult[] = (data.web?.results ?? []).filter((item) => item.url && item.title).map((item, index) => ({
        id: `brave:${index}:${item.url}`,
        title: item.title ?? query,
        url: item.url ?? "",
        snippet: item.description,
        source: new URL(item.url ?? "https://search.brave.com").hostname,
        provider: this.id,
        intent: this.intent,
        publishedAt: item.page_age,
        language: item.language,
        raw: item,
      }));
      return { provider: this.id, intent: this.intent, results };
    } catch (err) {
      return { provider: this.id, intent: this.intent, results: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
}
