// ─── Deep Research – shared types ────────────────────────────────────────────

// Legacy source mode kept for backward compatibility with saved research files.
export type ResearchSourceMode = "wikipedia" | "internet";
export type ResearchDepth = "low" | "medium" | "high";

export type ResearchIntent = "auto" | "news" | "encyclopedia" | "internet";
export type ResearchRoutableIntent = Exclude<ResearchIntent, "auto">;
export type ResearchProviderId = "gdelt" | "wikipedia" | "wikidata" | "brave" | "duckduckgo_instant" | "tavily";

export interface ResearchSearchInput {
  query: string;
  depth: ResearchDepth;
  language: string;
  intents: ResearchIntent[];
  signal?: AbortSignal;
}

/** Single normalised result from any provider. */
export interface ResearchResult {
  id: string;
  title: string;
  url: string;
  snippet?: string;
  source: string;
  provider: string;
  intent: ResearchIntent;
  publishedAt?: string;
  language?: string;
  score?: number;
  raw?: unknown;
  /** Full page text when the provider or fetcher resolved it. */
  body?: string;
}

export interface ResearchProviderResult {
  provider: ResearchProviderId;
  intent: ResearchRoutableIntent;
  results: ResearchResult[];
  error?: string;
}

export interface FetchedContent {
  url: string;
  finalUrl?: string;
  title?: string;
  text?: string;
  status: "ok" | "cors_failed" | "proxy_failed" | "blocked" | "error";
  source: "direct" | "cloudflare_proxy";
  error?: string;
}

/** Options passed to every provider search call. */
export interface SearchOptions {
  depth: ResearchDepth;
  /** Preferred language for results (e.g. "en", "it"). */
  language: string;
  intent: ResearchRoutableIntent;
  signal?: AbortSignal;
}

/** Abstract interface every ResearchProvider must implement. */
export interface ResearchProvider {
  readonly id: ResearchProviderId;
  readonly label: string;
  readonly intent: ResearchRoutableIntent;
  readonly requiresApiKey: boolean;
  /** Whether this provider is usable from the browser (no CORS issues). */
  readonly browserCompatible: boolean;
  isConfigured(config: { apiKey?: string }): boolean;
  search(query: string, options: SearchOptions & { apiKey?: string }): Promise<ResearchProviderResult>;
}

/** Depth → max results per query and max queries to generate. */
export const DEPTH_CONFIG: Record<ResearchDepth, { maxQueries: number; maxResultsPerQuery: number; fetchTop: number; providerFanout: number }> = {
  low: { maxQueries: 2, maxResultsPerQuery: 3, fetchTop: 2, providerFanout: 1 },
  medium: { maxQueries: 4, maxResultsPerQuery: 5, fetchTop: 4, providerFanout: 2 },
  high: { maxQueries: 6, maxResultsPerQuery: 8, fetchTop: 6, providerFanout: 3 },
};

export interface ResearchProviderUsage {
  provider: ResearchProviderId;
  intent: ResearchRoutableIntent;
  ok: boolean;
  resultCount: number;
  error?: string;
}

/** Front Matter stored in every research/*.md file. */
export interface ResearchFrontmatter {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  query: string;
  sourceMode: ResearchSourceMode;
  depth: ResearchDepth;
  language: string;
  providers: string[];
  intents?: ResearchIntent[];
  providerUsage?: ResearchProviderUsage[];
  relatedEntityId?: string;
  relatedEntityType?: string;
  costEur?: number;
}
