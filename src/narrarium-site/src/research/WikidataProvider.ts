import type { ResearchProvider, ResearchProviderResult, ResearchResult, SearchOptions } from "./types";
import { DEPTH_CONFIG } from "./types";

interface WikidataSearchItem {
  id: string;
  label?: string;
  description?: string;
  concepturi?: string;
}

function wikidataLang(language: string): string {
  const base = language.split("-")[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(base) ? base : "en";
}

export class WikidataProvider implements ResearchProvider {
  readonly id = "wikidata" as const;
  readonly label = "Wikidata";
  readonly intent = "encyclopedia" as const;
  readonly requiresApiKey = false;
  readonly browserCompatible = true;

  isConfigured(): boolean { return true; }

  async search(query: string, options: SearchOptions): Promise<ResearchProviderResult> {
    const lang = wikidataLang(options.language);
    const limit = DEPTH_CONFIG[options.depth].maxResultsPerQuery;
    const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=${encodeURIComponent(lang)}&uselang=${encodeURIComponent(lang)}&limit=${limit}&format=json&origin=*`;
    try {
      const resp = await fetch(url, { signal: options.signal, headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error(`Wikidata: ${resp.status}`);
      const data = await resp.json() as { search?: WikidataSearchItem[] };
      const results: ResearchResult[] = (data.search ?? []).map((item) => ({
        id: `wikidata:${item.id}`,
        title: item.label ?? item.id,
        url: item.concepturi ?? `https://www.wikidata.org/wiki/${item.id}`,
        snippet: item.description,
        source: "Wikidata",
        provider: this.id,
        intent: this.intent,
        language: lang,
        raw: item,
      }));
      return { provider: this.id, intent: this.intent, results };
    } catch (err) {
      return { provider: this.id, intent: this.intent, results: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
}
