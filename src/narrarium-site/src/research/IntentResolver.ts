import type { ResearchIntent, ResearchRoutableIntent } from "./types";

const NEWS_HINTS = ["today", "news", "recent", "latest", "breaking", "oggi", "attual", "cronaca", "ultim", "recenti", "trend", "media"];
const ENCYCLOPEDIA_HINTS = ["who is", "what is", "when was", "history", "histor", "biography", "definition", "where is", "wik", "wikipedia", "date", "city of", "era", "impero", "babilonia", "enciclop", "storia", "biografia", "definiz", "luogo"];

export function resolveResearchIntents(query: string, selected: ResearchIntent[]): ResearchRoutableIntent[] {
  const unique = [...new Set(selected)];
  if (unique.length === 0 || unique.includes("auto")) return resolveAutoResearchIntents(query);
  return unique.filter((intent): intent is ResearchRoutableIntent => intent !== "auto");
}

export function resolveAutoResearchIntents(query: string): ResearchRoutableIntent[] {
  const lowered = query.toLowerCase();
  const isNews = NEWS_HINTS.some((hint) => lowered.includes(hint));
  const isEncyclopedia = ENCYCLOPEDIA_HINTS.some((hint) => lowered.includes(hint));
  if (isNews && isEncyclopedia) return ["news", "encyclopedia", "internet"];
  if (isNews) return ["news", "internet"];
  if (isEncyclopedia) return ["encyclopedia", "internet"];
  return ["encyclopedia", "internet", "news"];
}
