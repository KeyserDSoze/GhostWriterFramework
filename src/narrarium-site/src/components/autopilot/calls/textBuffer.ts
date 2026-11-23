/**
 * The text of a pane of the task view, kept whole in memory and cut in blocks that the pane draws only near where the reader is. A response reaches
 * megabytes: the text is never drawn whole, and the blocks that are full never change, so that what is drawn of them is never drawn again.
 */

/** The most characters of one block. A block ends after a line when it can, so that a line is not cut between two blocks. */
export const BLOCK_CHARACTERS = 2048;

/** A block ends after the last line that fits in it, unless that line ends before this much of the block: a longer line is cut where the block is full. */
const SHORTEST_CUT = BLOCK_CHARACTERS / 4;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The UTF-8 bytes of a string, counted without encoding it. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHigh(code) && index + 1 < text.length && isLow(text.charCodeAt(index + 1))) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** How many characters (UTF-16 units) of `text` its first `bytes` UTF-8 bytes are: where a text read from an earlier byte starts to be new. */
export function charactersOfBytes(text: string, bytes: number): number {
  let seen = 0;
  let index = 0;
  while (index < text.length && seen < bytes) {
    const code = text.charCodeAt(index);
    if (code < 0x80) seen += 1;
    else if (code < 0x800) seen += 2;
    else if (isHigh(code) && index + 1 < text.length && isLow(text.charCodeAt(index + 1))) {
      seen += 4;
      index += 1;
    } else seen += 3;
    index += 1;
  }
  return index;
}

/** Where to end a block of `text` that is longer than `limit`: after its last line break past a quarter of it, or at the limit, never inside a pair of surrogates. */
function cutOf(text: string, limit: number): number {
  const lineEnd = text.lastIndexOf("\n", limit - 1);
  if (lineEnd + 1 >= SHORTEST_CUT) return lineEnd + 1;
  return isHigh(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
}

function countLineBreaks(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) count += 1;
  return count;
}

/** A text kept in blocks, with its counts kept as it grows: lines, characters (UTF-16 units, as the page counts them) and UTF-8 bytes. */
export class TextBuffer {
  private parts: string[] = [];
  private breaks = 0;
  characters = 0;
  bytes = 0;
  /** Changes every time the text does: what draws it compares it. */
  version = 0;
  /** Changes when the text starts again (`clear`, `replace`): what was measured of its blocks no longer holds. */
  generation = 0;

  /** The blocks, in order. Every block but the last is full and never changes. */
  get blocks(): readonly string[] {
    return this.parts;
  }

  /** Its lines: none for an empty text, and one more than its line breaks otherwise. */
  get lines(): number {
    return this.characters === 0 ? 0 : this.breaks + 1;
  }

  /** The whole text (to copy it, or to read it as JSON once it is whole). */
  get text(): string {
    return this.parts.join("");
  }

  /** Adds `text` at the end. Only the last block changes, and the blocks it fills are added after it. */
  append(text: string): void {
    if (!text) return;
    this.breaks += countLineBreaks(text);
    this.characters += text.length;
    this.bytes += utf8Bytes(text);
    let last = this.parts.length > 0 ? (this.parts.pop() as string) + text : text;
    while (last.length > BLOCK_CHARACTERS) {
      const cut = cutOf(last, BLOCK_CHARACTERS);
      this.parts.push(last.slice(0, cut));
      last = last.slice(cut);
    }
    if (last) this.parts.push(last);
    this.version += 1;
  }

  /** Empties it (a text that starts again). */
  clear(): void {
    if (this.characters === 0 && this.parts.length === 0) return;
    this.parts = [];
    this.breaks = 0;
    this.characters = 0;
    this.bytes = 0;
    this.version += 1;
    this.generation += 1;
  }

  /** Puts `text` in place of what it holds. */
  replace(text: string): void {
    this.clear();
    this.append(text);
  }

  /** Its last `count` characters at most (fewer when it is shorter). */
  tail(count: number): string {
    let out = "";
    for (let index = this.parts.length - 1; index >= 0 && out.length < count; index -= 1) out = this.parts[index] + out;
    return out.length > count ? out.slice(out.length - count) : out;
  }

  /** Its first `lines` lines, and at most `characters` characters of them: what a collapsed pane shows. `whole` says when that is all of it. */
  head(lines: number, characters: number): { text: string; whole: boolean } {
    let out = "";
    let breaks = 0;
    for (const part of this.parts) {
      let index = 0;
      while (index < part.length) {
        const next = part.indexOf("\n", index);
        if (next < 0) {
          out += part.slice(index);
          index = part.length;
        } else {
          breaks += 1;
          if (breaks >= lines) {
            out += part.slice(index, next);
            return { text: out.length > characters ? out.slice(0, characters) : out, whole: false };
          }
          out += part.slice(index, next + 1);
          index = next + 1;
        }
        if (out.length > characters) return { text: out.slice(0, characters), whole: false };
      }
    }
    return { text: out, whole: true };
  }
}
