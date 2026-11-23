/**
 * UTF-8 sizes and cuts of a JavaScript string, without encoding it: the recorder counts and cuts the text it receives in place. A lone surrogate
 * counts as the replacement character (three bytes), as `TextEncoder` writes it; a pair counts as four. Cuts never split a pair.
 */

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The UTF-8 bytes of `text` from index `from` to `to` (default: the end). */
export function utf8Length(text: string, from = 0, to = text.length): number {
  let bytes = 0;
  let index = from;
  while (index < to) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHigh(code) && index + 1 < to && isLow(text.charCodeAt(index + 1))) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    index += 1;
  }
  return bytes;
}

/**
 * The index where the longest run of whole characters from `from` that fits in `maxBytes` ends. It never splits a pair, so the text before
 * it is valid UTF-8 and exactly `utf8Length(text, from, index)` bytes long (at most `maxBytes`).
 */
export function cutHead(text: string, from: number, maxBytes: number): number {
  let bytes = 0;
  let index = from;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    let width: number;
    let units = 1;
    if (code < 0x80) width = 1;
    else if (code < 0x800) width = 2;
    else if (isHigh(code) && index + 1 < text.length && isLow(text.charCodeAt(index + 1))) {
      width = 4;
      units = 2;
    } else width = 3;
    if (bytes + width > maxBytes) break;
    bytes += width;
    index += units;
  }
  return index;
}

/**
 * The index where the longest run of whole characters at the end of `text` that fits in `maxBytes` starts: `text.slice(index)` is valid UTF-8
 * and at most `maxBytes` bytes long.
 */
export function suffixStart(text: string, maxBytes: number): number {
  let bytes = 0;
  let index = text.length;
  while (index > 0) {
    const code = text.charCodeAt(index - 1);
    let width: number;
    let units = 1;
    if (isLow(code) && index >= 2 && isHigh(text.charCodeAt(index - 2))) {
      width = 4;
      units = 2;
    } else if (code < 0x80) width = 1;
    else if (code < 0x800) width = 2;
    else width = 3;
    if (bytes + width > maxBytes) break;
    bytes += width;
    index -= units;
  }
  return index;
}

/** Whether the text ends with a high surrogate that a low one may still complete: the text is not cut there. */
export function endsWithHighSurrogate(text: string, end = text.length): boolean {
  return end > 0 && isHigh(text.charCodeAt(end - 1));
}
