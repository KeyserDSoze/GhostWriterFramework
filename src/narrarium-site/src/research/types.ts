// ─── Deep Research – shared types ────────────────────────────────────────────

export type ResearchSourceMode = "wikipedia" | "internet";
export type ResearchDepth = "low" | "medium" | "high";

/** Single normalised result from any provider. */
export interface ResearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Full page text when the provider fetched the body; undefined if only a snippet. */
  body?: string;
  /** Provider that returned this result. */
  provider: string;
}

/** Options passed to every provider search call. */
export interface SearchOptions {
  depth: ResearchDepth;
  /** Preferred language for results (e.g. "en", "it"). */
  language: string;
  signal?: AbortSignal;
}

/** Abstract interface every ResearchProvider must implement. */
export interface ResearchProvider {
  readonly id: string;
  readonly label: string;
  /** Whether this provider is usable from the browser (no CORS issues). */
  readonly browserCompatible: boolean;
  search(query: string, options: SearchOptions): Promise<ResearchResult[]>;
}

/** Depth → max results per query and max queries to generate. */
export const DEPTH_CONFIG: Record<ResearchDepth, { maxQueries: number; maxResultsPerQuery: number }> = {
  low: { maxQueries: 2, maxResultsPerQuery: 3 },
  medium: { maxQueries: 4, maxResultsPerQuery: 5 },
  high: { maxQueries: 6, maxResultsPerQuery: 8 },
};

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
  relatedEntityId?: string;
  relatedEntityType?: string;
  costEur?: number;
}
