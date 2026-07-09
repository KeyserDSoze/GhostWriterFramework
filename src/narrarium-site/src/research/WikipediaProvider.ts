// ─── Wikipedia Research Provider ─────────────────────────────────────────────
// Uses the public Wikipedia REST API – no auth, no CORS issues from the browser.

import type { ResearchProvider, ResearchProviderResult, ResearchResult, SearchOptions } from "./types";
import { DEPTH_CONFIG } from "./types";

interface WikiSearchResult {
  title: string;
  excerpt: string;
  description?: string;
  key: string;
}

interface WikiSummary {
  title: string;
  extract: string;
  content_urls?: { desktop?: { page?: string } };
}

function wikiLang(language: string): string {
  const supported = ["en", "it", "de", "fr", "es", "pt", "nl", "pl", "ru", "ja", "zh"];
  const base = language.split("-")[0].toLowerCase();
  return supported.includes(base) ? base : "en";
}

async function searchWikipedia(
  query: string,
  lang: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ResearchResult[]> {
  const url = `https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${limit}`;
  const resp = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!resp.ok) return [];
  const data = (await resp.json()) as { pages?: WikiSearchResult[] };
  const pages = data.pages ?? [];

  return await Promise.all(
    pages.slice(0, limit).map(async (page, index): Promise<ResearchResult> => {
      try {
        const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`;
        const summaryResp = await fetch(summaryUrl, { signal, headers: { Accept: "application/json" } });
        if (summaryResp.ok) {
          const summary = (await summaryResp.json()) as WikiSummary;
          return {
            id: `wikipedia:${lang}:${page.key}`,
            title: summary.title,
            url: summary.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.key)}`,
            snippet: page.excerpt ?? page.description ?? "",
            body: summary.extract,
            source: `Wikipedia (${lang})`,
            provider: "wikipedia",
            intent: "encyclopedia",
            language: lang,
            raw: summary,
          };
        }
      } catch {
        // fall through to basic result
      }
      return {
        id: `wikipedia:${lang}:${index}:${page.key}`,
        title: page.title,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.key)}`,
        snippet: page.excerpt ?? page.description ?? "",
        source: `Wikipedia (${lang})`,
        provider: "wikipedia",
        intent: "encyclopedia",
        language: lang,
        raw: page,
      };
    }),
  );
}

export class WikipediaProvider implements ResearchProvider {
  readonly id = "wikipedia" as const;
  readonly label = "Wikipedia";
  readonly intent = "encyclopedia" as const;
  readonly requiresApiKey = false;
  readonly browserCompatible = true;

  isConfigured(): boolean { return true; }

  async search(query: string, options: SearchOptions): Promise<ResearchProviderResult> {
    const lang = wikiLang(options.language);
    const limit = DEPTH_CONFIG[options.depth].maxResultsPerQuery;
    const results: ResearchResult[] = [];
    try {
      const primary = await searchWikipedia(query, lang, limit, options.signal);
      results.push(...primary);
      if (lang !== "en" && results.length < 2) {
        const fallback = await searchWikipedia(query, "en", Math.max(1, limit - results.length), options.signal);
        results.push(...fallback);
      }
      return { provider: this.id, intent: this.intent, results };
    } catch (err) {
      return { provider: this.id, intent: this.intent, results, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
