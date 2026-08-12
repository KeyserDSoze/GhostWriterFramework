export function isEditorialReviewPrompt(prompt: string): boolean {
  return /\b(review|critique|feedback|editorial|analy[sz]e|valuta|reviewa|come\s+ti\s+sembra|che\s+ne\s+pensi|ti\s+piace|impressione)\b/i.test(prompt);
}
