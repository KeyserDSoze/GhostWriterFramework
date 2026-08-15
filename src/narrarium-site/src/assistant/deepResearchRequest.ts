export type DeepResearchDepth = "low" | "medium" | "high";
export type DeepResearchIntent = "auto" | "news" | "encyclopedia" | "internet";

export function resolveDeepResearchRequest(prompt: string): { query: string; depth: DeepResearchDepth; intents: DeepResearchIntent[] } | null {
  const depth: DeepResearchDepth = /\b(deep research|high depth|ricerca approfondita|profondit[aà] alta)\b/i.test(prompt) ? "high" : /\b(quick research|brief research|low depth|ricerca rapida|ricerca breve|profondit[aà] bassa)\b/i.test(prompt) ? "low" : "medium";
  const intents: DeepResearchIntent[] = [];
  if (/\b(news|notizie|attualit[aà])\b/i.test(prompt)) intents.push("news");
  if (/\b(wikipedia|encyclopedia|enciclopedia)\b/i.test(prompt)) intents.push("encyclopedia");
  if (/\b(internet|web)\b/i.test(prompt)) intents.push("internet");
  const query = prompt.replace(/\b(run|start|conduct|perform|do|save|esegui|avvia|fai|conduci|una|un)\b/gi, " ").replace(/\b(deep research|quick research|brief research|ricerca approfondita|ricerca rapida|ricerca breve|research|ricerca)\b/gi, " ").replace(/\b(?:at|with)\s+(?:high|low|medium)\s+depth\b|\bprofondit[aà]\s+(?:alta|bassa|media)\b/gi, " ").replace(/\b(on|about|for|su|riguardo|circa|using|con)\b/gi, " ").replace(/\b(news|notizie|wikipedia|encyclopedia|enciclopedia|internet|web)\b/gi, " ").replace(/\s+/g, " ").replace(/^[\s:,-]+|[\s:,-]+$/g, "").trim();
  return query ? { query, depth, intents: intents.length ? [...new Set(intents)] : ["auto"] } : null;
}
