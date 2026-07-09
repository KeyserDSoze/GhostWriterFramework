import type { ResearchProvider, ResearchProviderResult, ResearchResult, SearchOptions } from "./types";
import { DEPTH_CONFIG } from "./types";

interface GdeltArticle {
  url?: string;
  title?: string;
  domain?: string;
  seendate?: string;
  socialimage?: string;
  sourcecountry?: string;
  language?: string;
}

export class GdeltProvider implements ResearchProvider {
  readonly id = "gdelt" as const;
  readonly label = "GDELT";
  readonly intent = "news" as const;
  readonly requiresApiKey = false;
  readonly browserCompatible = true;

  isConfigured(): boolean { return true; }

  async search(query: string, options: SearchOptions): Promise<ResearchProviderResult> {
    const count = Math.min(20, DEPTH_CONFIG[options.depth].maxResultsPerQuery * 2);
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&format=json&maxrecords=${count}&sort=HybridRel`;
    try {
      const resp = await fetch(url, { signal: options.signal, headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error(`GDELT: ${resp.status}`);
      const data = await resp.json() as { articles?: GdeltArticle[] };
      const results: ResearchResult[] = (data.articles ?? []).filter((a) => a.url && a.title).slice(0, count).map((a, index) => ({
        id: `gdelt:${index}:${a.url}`,
        title: a.title ?? query,
        url: a.url ?? "",
        snippet: `${a.domain ?? ""}${a.sourcecountry ? ` · ${a.sourcecountry}` : ""}`.trim(),
        source: a.domain ?? "GDELT",
        provider: this.id,
        intent: this.intent,
        publishedAt: a.seendate,
        language: a.language,
        raw: a,
      }));
      return { provider: this.id, intent: this.intent, results };
    } catch (err) {
      return { provider: this.id, intent: this.intent, results: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
}
