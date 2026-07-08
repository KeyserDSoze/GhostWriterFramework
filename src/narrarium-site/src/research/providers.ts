// ─── Research Provider Registry ──────────────────────────────────────────────

import type { ResearchProvider, ResearchSourceMode } from "./types";
import { WikipediaProvider } from "./WikipediaProvider";
import { DuckDuckGoProvider } from "./DuckDuckGoProvider";

const _wikipedia = new WikipediaProvider();
const _duckduckgo = new DuckDuckGoProvider();

/** All registered providers, keyed by id. */
export const RESEARCH_PROVIDERS: Record<string, ResearchProvider> = {
  wikipedia: _wikipedia,
  duckduckgo: _duckduckgo,
};

/** Return the ordered list of providers for a given source mode. */
export function getProvidersForMode(mode: ResearchSourceMode): ResearchProvider[] {
  if (mode === "wikipedia") return [_wikipedia];
  // internet: DuckDuckGo first; extensible by adding more providers here
  return [_duckduckgo];
}
