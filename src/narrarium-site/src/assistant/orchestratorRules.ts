const NAVIGATION_VERBS = /\b(apri|apre|aprimi|vai|va'|vammi|portami|mostra|mostrami|naviga|open|go to|goto|show me|show|navigate|take me|jump to)\b/i;

export function isExplicitNavigationPrompt(prompt: string): boolean {
  return NAVIGATION_VERBS.test(prompt);
}

/** Match a tool keyword as a complete token or phrase, never as a substring. */
export function matchesToolKeyword(prompt: string, keyword: string): boolean {
  const normalized = keyword.trim().toLocaleLowerCase();
  if (!normalized) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, "iu").test(prompt);
}
