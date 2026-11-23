import { describe, expect, it } from "vitest";
import { BLOCK_CHARACTERS, TextBuffer, charactersOfBytes, utf8Bytes } from "@/components/autopilot/calls/textBuffer";
import { DEFAULT_METRICS, estimateHeight, metricsOf, offsetsOf, windowOf } from "@/components/autopilot/calls/textWindow";
import { tailBeyond } from "@/components/autopilot/calls/useCallText";

const line = (index: number) => `Line ${String(index).padStart(4, "0")} of the answer, long enough to be a line.\n`;

describe("the text of a pane, in blocks", () => {
  it("is cut in blocks that end after a line, and the blocks that are full never change as the text grows", () => {
    const buffer = new TextBuffer();
    const text = Array.from({ length: 400 }, (_, index) => line(index)).join("");
    for (let at = 0; at < text.length; at += 777) buffer.append(text.slice(at, at + 777));
    expect(buffer.text).toBe(text);
    expect(buffer.blocks.length).toBeGreaterThan(1);
    for (const block of buffer.blocks) expect(block.length).toBeLessThanOrEqual(BLOCK_CHARACTERS);
    for (const block of buffer.blocks.slice(0, -1)) expect(block.endsWith("\n")).toBe(true);
    const full = buffer.blocks.slice(0, -1);
    buffer.append(line(400));
    // The same strings: what draws them sees nothing new and draws nothing again.
    full.forEach((block, index) => expect(buffer.blocks[index]).toBe(block));
  });

  it("cuts a line longer than a block where the block is full, never inside a pair of surrogates", () => {
    const buffer = new TextBuffer();
    const long = `${"a".repeat(BLOCK_CHARACTERS - 1)}😀${"b".repeat(BLOCK_CHARACTERS)}`;
    buffer.append(long);
    expect(buffer.text).toBe(long);
    expect(buffer.blocks[0]).toHaveLength(BLOCK_CHARACTERS - 1);
    expect(buffer.blocks[1].startsWith("😀")).toBe(true);
  });

  it("counts its lines, characters and UTF-8 bytes as it grows", () => {
    const buffer = new TextBuffer();
    expect(buffer.lines).toBe(0);
    buffer.append("Città di vetro\n");
    buffer.append("🦊 e il faro");
    expect(buffer.lines).toBe(2);
    expect(buffer.characters).toBe("Città di vetro\n🦊 e il faro".length);
    expect(buffer.bytes).toBe(new TextEncoder().encode("Città di vetro\n🦊 e il faro").length);
    const generation = buffer.generation;
    buffer.clear();
    expect([buffer.lines, buffer.characters, buffer.bytes, buffer.blocks.length]).toEqual([0, 0, 0, 0]);
    expect(buffer.generation).toBe(generation + 1);
  });

  it("gives its first lines (what a collapsed message shows) and its last characters", () => {
    const buffer = new TextBuffer();
    buffer.append(Array.from({ length: 100 }, (_, index) => line(index)).join(""));
    const head = buffer.head(40, 100_000);
    expect(head.whole).toBe(false);
    expect(head.text.split("\n")).toHaveLength(40);
    expect(head.text.endsWith("of the answer, long enough to be a line.")).toBe(true);
    expect(buffer.head(40, 100).text).toHaveLength(100);
    expect(new TextBuffer().head(40, 100)).toEqual({ text: "", whole: true });
    const short = new TextBuffer();
    short.append("one\ntwo");
    expect(short.head(40, 100)).toEqual({ text: "one\ntwo", whole: true });
    expect(buffer.tail(12)).toBe("be a line.\n".padStart(12, " ").slice(-12));
  });

  it("counts UTF-8 bytes without encoding, and finds where a text read from an earlier byte becomes new", () => {
    for (const text of ["abc", "Città", "🦊🦊", "€", "a\u{10348}b"]) expect(utf8Bytes(text)).toBe(new TextEncoder().encode(text).length);
    expect(charactersOfBytes("àbc", 2)).toBe(1);
    expect(charactersOfBytes("🦊x", 4)).toBe(2);
    expect(charactersOfBytes("abc", 0)).toBe(0);
  });
});

describe("where a pane stands", () => {
  it("estimates a block by its lines and how they wrap, a line break at its end adding nothing", () => {
    const metrics = { lineHeight: 20, perLine: 10 };
    expect(estimateHeight("", metrics)).toBe(0);
    expect(estimateHeight("short\n", metrics)).toBe(20);
    expect(estimateHeight("short\n\n", metrics)).toBe(40);
    expect(estimateHeight(`${"x".repeat(25)}\nend`, metrics)).toBe(80);
    expect(estimateHeight(`${"x".repeat(25)}\nend`, { lineHeight: 20, perLine: Number.POSITIVE_INFINITY })).toBe(40);
    expect(metricsOf(0, 0, 0, true, false)).toEqual(DEFAULT_METRICS);
    expect(metricsOf(600, 16, 24, true, false)).toEqual({ lineHeight: 24, perLine: 75 });
    expect(metricsOf(600, 12, 20, false, true).perLine).toBe(Number.POSITIVE_INFINITY);
  });

  it("draws the blocks in sight and a screen of them above and below, and keeps the room of the others", () => {
    const offsets = offsetsOf(Array.from({ length: 1000 }, () => 100));
    expect(windowOf(offsets, 0, 300, 300)).toEqual({ start: 0, end: 6, before: 0, after: 99_400 });
    const middle = windowOf(offsets, 50_000, 300, 300);
    expect(middle.start).toBe(497);
    expect(middle.end).toBe(506);
    expect(middle.before + (middle.end - middle.start) * 100 + middle.after).toBe(100_000);
    const end = windowOf(offsets, 99_700, 300, 300);
    expect(end).toMatchObject({ end: 1000, after: 0 });
    expect(windowOf(offsetsOf([]), 0, 300, 300)).toEqual({ start: 0, end: 0, before: 0, after: 0 });
  });
});

describe("the tail of the live events after what the record keeps", () => {
  const sentence = (index: number) => `The keeper climbed the stairs counting the steps under his breath (${index}). `;
  const whole = Array.from({ length: 40 }, (_, index) => sentence(index)).join("");
  const tailOf = (total: number) => whole.slice(Math.max(0, total - 700), total);

  it("goes on where the record ends, by the lengths of both, even in a text that says the same words again and again", () => {
    for (const [kept, total] of [[1000, 1256], [1500, 1600], [2000, 2000], [300, 700]]) {
      expect(tailBeyond(whole.slice(0, kept).slice(-48), kept, tailOf(total), total)).toBe(whole.slice(kept, total));
    }
  });

  it("is the whole tail before the record has anything, and nothing when the record is further behind than the tail reaches", () => {
    expect(tailBeyond("", 0, tailOf(900), 900)).toBe(tailOf(900));
    expect(tailBeyond(whole.slice(0, 100).slice(-48), 100, tailOf(2000), 2000)).toBe("");
    expect(tailBeyond("anything", 10, "", 0)).toBe("");
  });

  it("is looked for in the tail when the lengths do not line up (a key taken out of the record), and only when it is there once", () => {
    const text = "Line one of a text that has no repeats in it at all, none whatsoever. And then the words go on and on to the end.";
    const keptEnd = "of a text that has no repeats in it at all, none whatsoever.";
    expect(tailBeyond(keptEnd, 5, text, 5000)).toBe(" And then the words go on and on to the end.");
    // The end of the record more than once in the tail: where it goes on cannot be told.
    const same = "the same words again and again, ".repeat(60);
    expect(tailBeyond(same.slice(0, 1000).slice(-48), 3, same.slice(900, 1600), 1600)).toBe("");
  });
});
