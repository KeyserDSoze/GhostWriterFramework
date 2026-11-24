import { describe, expect, it } from "vitest";
import { READER_PASSWORD_MAX, READER_PASSWORD_MIN, generateReaderPassword, readerPasswordBits, readerPasswordProblem, readerPasswordStrength } from "@/readerAccess/passwords";

describe("generating a password", () => {
  it("makes five groups of five look-alike-free symbols", () => {
    const password = generateReaderPassword();
    expect(password).toMatch(/^(?:[A-HJ-NP-Za-km-z2-9]{5}-){4}[A-HJ-NP-Za-km-z2-9]{5}$/);
    expect(readerPasswordProblem(password)).toBeNull();
    expect(readerPasswordStrength(password)).toBe("strong");
  });

  it("never repeats itself over many draws", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateReaderPassword()));
    expect(seen.size).toBe(500);
  });

  it("uses every symbol the same number of times when the random bytes cycle evenly (no bias)", () => {
    let next = 0;
    const counts = new Map<string, number>();
    const sequential = (array: Uint8Array) => { for (let index = 0; index < array.length; index += 1) array[index] = next++ % 256; return array; };
    for (let draw = 0; draw < 570; draw += 1) for (const symbol of generateReaderPassword(sequential).replace(/-/g, "")) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    expect(counts.size).toBe(57);
    const values = [...counts.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(Math.ceil(values[0] * 0.1));
  });

  it("throws away random bytes that would skew the result", () => {
    // 255 is past the last whole multiple of 57 under 256 (228): it must be skipped, so with a source that only gives 255 then 0 the symbol is the first one.
    const bytes = [255, 0];
    let index = 0;
    const source = (array: Uint8Array) => { array[0] = bytes[index % 2]; index += 1; return array; };
    expect(generateReaderPassword(source).startsWith("AAAAA-")).toBe(true);
  });
});

describe("a typed password", () => {
  it("is refused when empty, too short or too long, or when it starts or ends with a space", () => {
    expect(readerPasswordProblem("")).toBe("empty");
    expect(readerPasswordProblem("a".repeat(READER_PASSWORD_MIN - 1))).toBe("too-short");
    expect(readerPasswordProblem("a".repeat(READER_PASSWORD_MAX + 1))).toBe("too-long");
    expect(readerPasswordProblem(" abcdefghij")).toBe("edge-space");
    expect(readerPasswordProblem("abcdefghij\n")).toBe("edge-space");
  });

  it("is accepted with spaces inside, and at the limits", () => {
    expect(readerPasswordProblem("a b c d e f")).toBeNull();
    expect(readerPasswordProblem("a".repeat(READER_PASSWORD_MIN))).toBeNull();
    expect(readerPasswordProblem("a".repeat(READER_PASSWORD_MAX))).toBeNull();
  });

  it("is weak when short or repetitive, fair when middling, strong when long and varied", () => {
    expect(readerPasswordStrength("password")).toBe("weak");
    expect(readerPasswordStrength("aaaaaaaaaaaaaaaaaaaa")).toBe("weak");
    expect(readerPasswordStrength("Tr0ub4dor")).toBe("weak");
    expect(readerPasswordStrength("Sunflower77")).toBe("fair");
    expect(readerPasswordStrength("c0rrect-Horse-battery-Staple-77")).toBe("strong");
    expect(readerPasswordBits("")).toBe(0);
    expect(readerPasswordBits("abcdefgh")).toBeLessThan(readerPasswordBits("abcdefghABCDEFGH12345678!!"));
  });
});
