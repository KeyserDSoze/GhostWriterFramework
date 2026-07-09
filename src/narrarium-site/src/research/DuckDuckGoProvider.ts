// ─── DuckDuckGo Instant Answer Provider ──────────────────────────────────────
// Weak fallback only. This does NOT return an organic SERP.

import type { ResearchProvider, ResearchProviderResult, ResearchResult, SearchOptions } from "./types";
import { DEPTH_CONFIG } from "./types";

interface DdgResponse {
  Abstract?: string;
  AbstractURL?: string;
  AbstractSource?: string;
  AbstractText?: string;
  Heading?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
}

export class DuckDuckGoInstantAnswerProvider implements ResearchProvider {
  readonly id = "duckduckgo_instant" as const;
  readonly label = "DuckDuckGo Instant Answer";
  readonly intent = "internet" as const;
  readonly requiresApiKey = false;
  readonly browserCompatible = true;

  isConfigured(): boolean { return true; }

  async search(query: string, options: SearchOptions): Promise<ResearchProviderResult> {
    const limit = DEPTH_CONFIG[options.depth].maxResultsPerQuery;
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    try {
      const resp = await fetch(url, { signal: options.signal });
      if (!resp.ok) throw new Error(`DuckDuckGo: ${resp.status}`);
      const data = (await resp.json()) as DdgResponse;
      const results: ResearchResult[] = [];
      if (data.Abstract && data.AbstractURL) {
        results.push({
          id: `duck:${data.AbstractURL}`,
          title: data.Heading ?? query,
          url: data.AbstractURL,
          snippet: data.Abstract,
          body: data.AbstractText ?? data.Abstract,
          source: data.AbstractSource ?? "DuckDuckGo",
          provider: this.id,
          intent: this.intent,
          raw: data,
        });
      }
      for (const topic of data.RelatedTopics ?? []) {
        if (results.length >= limit) break;
        if (topic.Text && topic.FirstURL) {
          results.push({ id: `duck:${topic.FirstURL}`, title: topic.Text.split(" - ")[0] ?? topic.Text, url: topic.FirstURL, snippet: topic.Text, source: "DuckDuckGo", provider: this.id, intent: this.intent, raw: topic });
          continue;
        }
        for (const sub of topic.Topics ?? []) {
          if (results.length >= limit) break;
          if (sub.Text && sub.FirstURL) results.push({ id: `duck:${sub.FirstURL}`, title: sub.Text.split(" - ")[0] ?? sub.Text, url: sub.FirstURL, snippet: sub.Text, source: "DuckDuckGo", provider: this.id, intent: this.intent, raw: sub });
        }
      }
      return { provider: this.id, intent: this.intent, results: results.slice(0, limit) };
    } catch (err) {
      return { provider: this.id, intent: this.intent, results: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
}
