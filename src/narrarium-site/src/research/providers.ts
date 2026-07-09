// ─── Research Provider Registry ──────────────────────────────────────────────

import { BraveSearchProvider } from "./BraveSearchProvider";
import { DuckDuckGoInstantAnswerProvider } from "./DuckDuckGoProvider";
import { GdeltProvider } from "./GdeltProvider";
import { TavilyProvider } from "./TavilyProvider";
import type { ResearchProvider, ResearchProviderId, ResearchRoutableIntent } from "./types";
import { WikipediaProvider } from "./WikipediaProvider";
import { WikidataProvider } from "./WikidataProvider";

const providers: ResearchProvider[] = [
  new GdeltProvider(),
  new WikipediaProvider(),
  new WikidataProvider(),
  new BraveSearchProvider(),
  new TavilyProvider(),
  new DuckDuckGoInstantAnswerProvider(),
];

export const RESEARCH_PROVIDERS: Record<ResearchProviderId, ResearchProvider> = Object.fromEntries(
  providers.map((provider) => [provider.id, provider]),
) as Record<ResearchProviderId, ResearchProvider>;

export function providerById(id: ResearchProviderId): ResearchProvider | undefined {
  return RESEARCH_PROVIDERS[id];
}

export function providersForIntent(intent: ResearchRoutableIntent): ResearchProvider[] {
  return providers.filter((provider) => provider.intent === intent);
}

export function allResearchProviders(): ResearchProvider[] {
  return providers.slice();
}
