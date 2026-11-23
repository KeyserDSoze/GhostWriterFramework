const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The sum, over the chapters `from` to `to` of a book (the first is chapter 1), of what each one adds to a prompt that grows by `slope` with every
 * chapter before it until it reaches `cap`: `min(cap, slope × (chapter − 1))`. It is how the story so far and the lists of the chapters grow: a prompt
 * carries the chapters before the one it is about, up to the limit the engine puts on that part of the prompt.
 *
 * Closed form: the chapters on the slope are summed as an arithmetic series, the ones at the cap are counted, so that a book of any length costs the same.
 * Chapters before the first add nothing. Anything that is not a finite number, a slope or a cap of nothing, or no chapter at all, gives 0.
 */
export function sumCappedRamp(slope: number, cap: number, from: number, to: number): number {
  if (!isNumber(slope) || !isNumber(cap) || !isNumber(from) || !isNumber(to)) return 0;
  if (slope <= 0 || cap <= 0) return 0;
  const first = Math.max(1, Math.ceil(from));
  const last = Math.floor(to);
  if (last < first) return 0;
  // The last chapter still on the slope: from the next one on, the prompt is at its cap (where the two meet the value is the same).
  const lastOnSlope = Math.floor(cap / slope) + 1;
  let total = 0;
  const slopeEnd = Math.min(last, lastOnSlope);
  if (first <= slopeEnd) total += (slope * (first - 1 + (slopeEnd - 1)) * (slopeEnd - first + 1)) / 2;
  const capStart = Math.max(first, lastOnSlope + 1);
  if (last >= capStart) total += cap * (last - capStart + 1);
  return total;
}

/**
 * What a list of `lines` chapters weighs in a prompt, as `layoutChapters` lays it out within a budget (`cap`): while every line fits (`line` each) the list is whole;
 * a list that does not fit keeps the first and the last five chapters and the thirty around the one it is about, `full` lines in all, and the other chapters
 * give up their summary and keep a title (`title` each), up to the budget. The levels that condense further (blocks of chapters) are not followed: the list is never
 * more than `cap`, which is where this stops.
 */
export function windowedList(lines: number, line: number, title: number, full: number, cap: number): number {
  if (![lines, line, title, full, cap].every(isNumber) || lines <= 0 || line <= 0 || cap <= 0) return 0;
  const whole = lines * line;
  if (whole <= cap) return whole;
  if (lines <= full) return cap;
  return Math.min(cap, full * line + (lines - full) * Math.max(0, title));
}

/** The sum of `windowedList` over the lists of `from` to `to` lines, in closed form: the lists that fit whole are an arithmetic series, the others a ramp that stops at the cap. */
export function sumWindowedList(from: number, to: number, line: number, title: number, full: number, cap: number): number {
  if (![from, to, line, title, full, cap].every(isNumber) || line <= 0 || cap <= 0) return 0;
  const first = Math.max(1, Math.ceil(from));
  const last = Math.floor(to);
  if (last < first) return 0;
  const lastWhole = Math.floor(cap / line);
  let total = 0;
  const wholeEnd = Math.min(last, lastWhole);
  if (first <= wholeEnd) total += (line * (first + wholeEnd) * (wholeEnd - first + 1)) / 2;
  // Lists that do not fit and are no longer than the lines kept whole are at the cap.
  const cappedStart = Math.max(first, lastWhole + 1);
  const cappedEnd = Math.min(last, Math.max(0, Math.floor(full)));
  if (cappedStart <= cappedEnd) total += cap * (cappedEnd - cappedStart + 1);
  // The others keep `full` lines and a title for each line more, up to the cap.
  const condensedStart = Math.max(cappedStart, Math.floor(full) + 1);
  if (condensedStart <= last) {
    const count = last - condensedStart + 1;
    const titleTokens = Math.max(0, title);
    const constant = full * (line - titleTokens);
    total += constant >= cap ? cap * count : constant * count + sumCappedRamp(titleTokens, cap - constant, condensedStart + 1, last + 1);
  }
  return total;
}
