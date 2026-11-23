import test from "node:test";
import assert from "node:assert/strict";

// The module is not part of the public API (the estimate's own arithmetic): it is read from the build, and when it is not there each test fails on its own.
const math = await import("../dist/autopilot/estimate-math.js").catch(() => ({}));
const { sumCappedRamp, sumWindowedList, windowedList } = math;

// The sum, for the chapters from `from` to `to` (the first of a book is 1), of what each adds to a prompt that grows by `slope` with every chapter before it
// until it reaches `cap`: min(cap, slope × (chapter − 1)). The estimate needs it for the story so far and for the lists of the chapters, which a prompt
// carries up to a limit, and needs it without walking the chapters of a book of five thousand.
function brute(slope, cap, from, to) {
  let total = 0;
  for (let chapter = from; chapter <= to; chapter += 1) total += Math.min(cap, Math.max(0, slope * (chapter - 1)));
  return total;
}

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${message ?? ""} ${actual} is not ${expected}`);

test("the sum of a ramp that stops at a cap is the sum of the chapters, whatever the slope, the cap and the chapters", () => {
  const slopes = [0.5, 1, 2.4, 3.7, 55, 75];
  const caps = [0.25, 1, 10, 900, 1166.5, 4000];
  const spans = [[1, 1], [1, 2], [1, 10], [1, 300], [5, 40], [13, 13], [13, 14], [2, 1000], [40, 40], [41, 300], [1, 4000]];
  let checked = 0;
  for (const slope of slopes) {
    for (const cap of caps) {
      for (const [from, to] of spans) {
        close(sumCappedRamp(slope, cap, from, to), brute(slope, cap, from, to), `slope ${slope}, cap ${cap}, chapters ${from} to ${to}:`);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 6 * 6 * 11);
});

test("the ramp starts at nothing: the first chapter carries nothing of the chapters before it", () => {
  assert.equal(sumCappedRamp(75, 900, 1, 1), 0);
  assert.equal(sumCappedRamp(75, 900, 2, 2), 75);
  assert.equal(sumCappedRamp(75, 900, 13, 13), 900, "twelve chapters of 75 words are the 900 of the cap");
  assert.equal(sumCappedRamp(75, 900, 12, 12), 825);
  assert.equal(sumCappedRamp(75, 900, 14, 14), 900, "and from there on it is the cap");
  assert.equal(sumCappedRamp(75, 900, 1, 13), 75 * (0 + 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12));
});

test("a ramp that is reached is flat after it: the sum of a long book is a few steps, not a walk through it", () => {
  assert.equal(sumCappedRamp(75, 900, 1, 5000), 75 * 78 + (5000 - 13) * 900);
  assert.equal(sumCappedRamp(75, 900, 1, 1e12), 75 * 78 + (1e12 - 13) * 900, "a book of a trillion chapters is the same arithmetic");
  assert.equal(sumCappedRamp(75, 900, 100, 1e12), (1e12 - 100 + 1) * 900, "from a chapter after the cap, only the cap");
  const start = performance.now();
  for (let count = 0; count < 20_000; count += 1) sumCappedRamp(75, 900, 1 + (count % 7), 100_000);
  assert.ok(performance.now() - start < 1000, "twenty thousand sums over a hundred thousand chapters");
});

test("the sums of two spans that follow each other are the sum of both", () => {
  for (const [slope, cap] of [[75, 900], [55, 4000], [3.7, 1166.5]]) {
    for (const [from, middle, to] of [[1, 10, 30], [1, 12, 13], [3, 100, 500], [20, 20, 21]]) {
      close(sumCappedRamp(slope, cap, from, middle) + sumCappedRamp(slope, cap, middle + 1, to), sumCappedRamp(slope, cap, from, to), `${slope}/${cap} ${from}-${middle}-${to}`);
    }
  }
});

test("a sum over no chapters, a slope or a cap of nothing, or numbers that are not numbers, is nothing", () => {
  assert.equal(sumCappedRamp(75, 900, 5, 4), 0, "no chapters");
  assert.equal(sumCappedRamp(75, 900, 10, 1), 0);
  assert.equal(sumCappedRamp(0, 900, 1, 100), 0, "a prompt that does not grow");
  assert.equal(sumCappedRamp(75, 0, 1, 100), 0, "a cap of nothing");
  assert.equal(sumCappedRamp(-75, 900, 1, 100), 0, "a slope that goes down is no ramp");
  assert.equal(sumCappedRamp(75, -900, 1, 100), 0);
  for (const garbage of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, "75", {}, []]) {
    assert.equal(sumCappedRamp(garbage, 900, 1, 100), 0, `slope ${String(garbage)}`);
    assert.equal(sumCappedRamp(75, garbage, 1, 100), 0, `cap ${String(garbage)}`);
    assert.equal(sumCappedRamp(75, 900, garbage, 100), 0, `from ${String(garbage)}`);
    assert.equal(sumCappedRamp(75, 900, 1, garbage), 0, `to ${String(garbage)}`);
  }
});

test("chapters before the first of a book add nothing, and the sum never goes down as the book grows or the slope steepens", () => {
  close(sumCappedRamp(75, 900, 0, 5), brute(75, 900, 1, 5), "from the chapter 0");
  close(sumCappedRamp(75, 900, -10, 5), brute(75, 900, 1, 5), "from a chapter before the first");
  let last = 0;
  for (let chapters = 1; chapters <= 60; chapters += 1) {
    const sum = sumCappedRamp(75, 900, 1, chapters);
    assert.ok(sum >= last, `${chapters} chapters`);
    last = sum;
  }
  let steeper = 0;
  for (const slope of [1, 5, 20, 75, 300, 1000]) {
    const sum = sumCappedRamp(slope, 900, 1, 40);
    assert.ok(sum >= steeper, `slope ${slope}`);
    steeper = sum;
  }
  assert.equal(sumCappedRamp(75, 900, 1, 40) <= 40 * 900, true, "never more than the cap for every chapter");
});

// ─── The lists of chapters a prompt carries ─────────────────────────────────

// The list of the chapters before the one a prompt is about, as `layoutChapters` lays it out: whole while it fits its budget; when it does not, the first and the last
// five chapters and the thirty around the chapter keep a line each (`full` lines in all), and the others keep their titles.
function bruteList(from, to, line, title, full, cap) {
  let total = 0;
  for (let lines = Math.max(1, from); lines <= to; lines += 1) total += windowedList(lines, line, title, full, cap);
  return total;
}

test("a list of chapters is whole while it fits, and condensed to its full lines and a title for each of the others when it does not", () => {
  const line = 82.5;
  const title = 9;
  const full = 36;
  const cap = 6000;
  assert.equal(windowedList(0, line, title, full, cap), 0);
  assert.equal(windowedList(1, line, title, full, cap), line);
  assert.equal(windowedList(72, line, title, full, cap), 72 * line, "72 lines of 82.5 tokens are 5940: it fits");
  assert.equal(windowedList(73, line, title, full, cap), full * line + 37 * title, "73 are 6022 and do not: the first and the last lines are whole and the others titles");
  assert.ok(windowedList(73, line, title, full, cap) < windowedList(72, line, title, full, cap), "a list that is condensed is shorter than the one that was just whole");
  assert.equal(windowedList(200, line, title, full, cap), full * line + 164 * title);
  assert.equal(windowedList(100_000, line, title, full, cap), cap, "and never longer than its budget");
  for (const garbage of [Number.NaN, undefined, null, "5", Number.POSITIVE_INFINITY]) assert.equal(windowedList(garbage, line, title, full, cap), 0, String(garbage));
});

test("the sum of the lists of the chapters of a book is the sum of the lists, whatever the book, the budget and the lines", () => {
  const settings = [[82.5, 9, 36, 6000], [30, 5, 36, 6000], [82.5, 9, 36, 200], [82.5, 9, 3, 1000], [10, 9, 36, 100_000], [82.5, 82.5, 36, 6000]];
  const spans = [[1, 1], [1, 72], [1, 73], [60, 90], [73, 500], [1, 5000], [2, 36], [37, 37], [100, 100]];
  for (const [line, title, full, cap] of settings) {
    for (const [from, to] of spans) close(sumWindowedList(from, to, line, title, full, cap), bruteList(from, to, line, title, full, cap), `${line}/${title}/${full}/${cap}, lists of ${from} to ${to}:`);
  }
  assert.equal(sumWindowedList(5, 4, 82.5, 9, 36, 6000), 0);
  assert.equal(sumWindowedList(1, 1e12, 82.5, 9, 36, 1000) > 0, true, "a book of any length is a few steps");
  for (const garbage of [Number.NaN, undefined, null, "5", {}]) assert.equal(sumWindowedList(1, garbage, 82.5, 9, 36, 6000), 0, String(garbage));
});
