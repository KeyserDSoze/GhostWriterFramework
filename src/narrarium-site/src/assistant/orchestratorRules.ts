const NAVIGATION_VERBS = /\b(apri|apre|aprimi|vai|va'|vammi|portami|mostra|mostrami|naviga|open|go to|goto|show me|show|navigate|take me|jump to)\b/i;

export function isExplicitNavigationPrompt(prompt: string): boolean {
  return NAVIGATION_VERBS.test(prompt);
}
