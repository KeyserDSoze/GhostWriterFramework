/**
 * The difference between two texts word by word, for showing a change inside a paragraph (a line diff shows a whole paragraph as one changed line).
 * Pure: the words keep the white space that follows them. The pieces put together give back the new text exactly, and the old one up to the white space
 * of the words they share (which is the new text's).
 */

export type WordDiffType = "same" | "add" | "remove";

export interface WordDiffPart {
  type: WordDiffType;
  text: string;
}

/** More words than this on either side: the two texts are shown as a whole removed and a whole added (the table of the comparison would be too big). */
export const WORD_DIFF_LIMIT = 2500;

/** A word with the white space after it; white space at the start of the text is a piece of its own. */
function tokens(text: string): string[] {
  return text.match(/\s+|[^\s]+\s*/g) ?? [];
}

export function wordDiff(previous: string, next: string): WordDiffPart[] {
  if (previous === next) return previous ? [{ type: "same", text: previous }] : [];
  const left = tokens(previous);
  const right = tokens(next);
  if (left.length > WORD_DIFF_LIMIT || right.length > WORD_DIFF_LIMIT) {
    return [...(previous ? [{ type: "remove" as const, text: previous }] : []), ...(next ? [{ type: "add" as const, text: next }] : [])];
  }
  // Words are compared without their trailing white space, so that a word at the end of a line is the same word.
  const key = (token: string) => token.trimEnd();
  const table: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let a = left.length - 1; a >= 0; a -= 1) {
    for (let b = right.length - 1; b >= 0; b -= 1) {
      table[a][b] = key(left[a]) === key(right[b]) ? table[a + 1][b + 1] + 1 : Math.max(table[a + 1][b], table[a][b + 1]);
    }
  }
  const parts: WordDiffPart[] = [];
  const push = (type: WordDiffType, text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    if (key(left[a]) === key(right[b])) {
      // The same word: the text the new side has (its spacing is the new text's).
      push("same", right[b]);
      a += 1;
      b += 1;
    } else if (table[a + 1][b] >= table[a][b + 1]) {
      push("remove", left[a]);
      a += 1;
    } else {
      push("add", right[b]);
      b += 1;
    }
  }
  while (a < left.length) push("remove", left[a++]);
  while (b < right.length) push("add", right[b++]);
  return parts;
}

/** The text of the parts that are in the old text, or in the new one: what each side of a comparison reads as. */
export function wordDiffSide(parts: readonly WordDiffPart[], side: "previous" | "next"): string {
  return parts.filter((part) => part.type === "same" || part.type === (side === "previous" ? "remove" : "add")).map((part) => part.text).join("");
}
