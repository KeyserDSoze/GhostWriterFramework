// ─── DuckDuckGo Instant Answer Provider ──────────────────────────────────────
// Uses DuckDuckGo's Instant Answer API (?format=json&no_html=1&skip_disambig=1).
// This is a limited API (no organic SERP), but works from the browser without CORS.
// For richer results a Cloudflare Worker proxy would be needed.

import type { ResearchProvider, ResearchResult, SearchOptions } from "./types";
import { DEPTH_CONFIG } from "./types";

interface DdgResponse {
  Abstract?: string;
  AbstractURL?: string;
  AbstractSource?: string;
  AbstractText?: string;
  Heading?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
}

export class DuckDuckGoProvider implements ResearchProvider {
  readonly id = "duckduckgo";
  readonly label = "DuckDuckGo";
  // DuckDuckGo Instant Answer API supports CORS
  readonly browserCompatible = true;

  async search(query: string, options: SearchOptions): Promise<ResearchResult[]> {
    const limit = DEPTH_CONFIG[options.depth].maxResultsPerQuery;
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

    let data: DdgResponse;
    try {
      const resp = await fetch(url, { signal: options.signal });
      if (!resp.ok) return [];
      data = (await resp.json()) as DdgResponse;
    } catch {
      return [];
    }

    const results: ResearchResult[] = [];

    // Abstract (primary result)
    if (data.Abstract && data.AbstractURL) {
      results.push({
        title: data.Heading ?? query,
        url: data.AbstractURL,
        snippet: data.Abstract,
        body: data.AbstractText ?? data.Abstract,
        provider: "duckduckgo",
      });
    }

    // Related topics (up to limit - 1 more)
    const topics = data.RelatedTopics ?? [];
    for (const topic of topics) {
      if (results.length >= limit) break;
      // Flat topic
      if (topic.Text && topic.FirstURL) {
        results.push({ title: topic.Text.split(" - ")[0] ?? topic.Text, url: topic.FirstURL, snippet: topic.Text, provider: "duckduckgo" });
        continue;
      }
      // Nested group
      for (const sub of topic.Topics ?? []) {
        if (results.length >= limit) break;
        if (sub.Text && sub.FirstURL) {
          results.push({ title: sub.Text.split(" - ")[0] ?? sub.Text, url: sub.FirstURL, snippet: sub.Text, provider: "duckduckgo" });
        }
      }
    }

    return results.slice(0, limit);
  }
}
