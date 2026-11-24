import { describe, expect, it } from "vitest";
import { LEGACY_READER_SECRET, READER_PASSWORDS_VARIABLE, READER_WORKFLOW_FILE, READER_WORKFLOW_PATH, allocateReaderSecretName, formatReaderVariable, isReaderSecretName, parseReaderVariable, readerSecretName, readerSecretNumber } from "@/readerAccess/contract";
import { PAGES_WORKFLOW_PATH } from "@/github/bookRepository";

describe("the names the site and the reader's workflow agree on", () => {
  it("are the ones in the plan", () => {
    expect(READER_WORKFLOW_PATH).toBe(".github/workflows/deploy-reader-pages.yml");
    expect(READER_WORKFLOW_PATH.endsWith(`/${READER_WORKFLOW_FILE}`)).toBe(true);
    expect(PAGES_WORKFLOW_PATH).toBe(READER_WORKFLOW_PATH);
    expect(READER_PASSWORDS_VARIABLE).toBe("READER_PASSWORD_SECRETS");
    expect(LEGACY_READER_SECRET).toBe("NARRARIUM_READER_PASSWORD");
  });

  it("number the secrets with zero padding", () => {
    expect(readerSecretName(1)).toBe("READER_PASSWORD_001");
    expect(readerSecretName(42)).toBe("READER_PASSWORD_042");
    expect(readerSecretName(1000)).toBe("READER_PASSWORD_1000");
    expect(() => readerSecretName(0)).toThrow(RangeError);
    expect(() => readerSecretName(1.5)).toThrow(RangeError);
    expect(readerSecretNumber("READER_PASSWORD_007")).toBe(7);
    expect(readerSecretNumber("READER_PASSWORD_1000")).toBe(1000);
    for (const other of [LEGACY_READER_SECRET, "READER_PASSWORD_", "READER_PASSWORD_7", "READER_PASSWORD_00A", "reader_password_001", "X_READER_PASSWORD_001"]) expect(readerSecretNumber(other)).toBeNull();
    expect(isReaderSecretName("READER_PASSWORD_003")).toBe(true);
    expect(isReaderSecretName(LEGACY_READER_SECRET)).toBe(false);
  });
});

describe("the variable that lists the secrets", () => {
  it("is read as a comma list: trimmed, without empty entries or repeats, in the order it has", () => {
    expect(parseReaderVariable("READER_PASSWORD_002, READER_PASSWORD_001,,READER_PASSWORD_002 ")).toEqual(["READER_PASSWORD_002", "READER_PASSWORD_001"]);
    expect(parseReaderVariable("")).toEqual([]);
    expect(parseReaderVariable(null)).toEqual([]);
    expect(parseReaderVariable(undefined)).toEqual([]);
  });

  it("is written in number order with no repeats, and an empty list has no value", () => {
    expect(formatReaderVariable(["READER_PASSWORD_010", "READER_PASSWORD_002", "READER_PASSWORD_002", "READER_PASSWORD_001"])).toBe("READER_PASSWORD_001,READER_PASSWORD_002,READER_PASSWORD_010");
    expect(formatReaderVariable([])).toBe("");
  });
});

describe("the name for a new password", () => {
  const names = (...numbers: number[]) => numbers.map(readerSecretName);

  it("is the first number nothing holds", () => {
    expect(allocateReaderSecretName([])).toBe("READER_PASSWORD_001");
    expect(allocateReaderSecretName(names(1, 2, 3))).toBe("READER_PASSWORD_004");
    expect(allocateReaderSecretName(names(2, 3))).toBe("READER_PASSWORD_001");
    expect(allocateReaderSecretName(names(1, 3))).toBe("READER_PASSWORD_002");
  });

  it("never reuses a name that is still taken, wherever it is held (listed, a secret, or kept in Narrarium)", () => {
    const listed = names(1);
    const secrets = names(2);
    const stored = names(3);
    expect(allocateReaderSecretName([...listed, ...secrets, ...stored])).toBe("READER_PASSWORD_004");
  });

  it("reuses a number only once nothing holds it any more", () => {
    expect(allocateReaderSecretName(names(1, 2, 3))).toBe("READER_PASSWORD_004");
    expect(allocateReaderSecretName(names(1, 3))).toBe("READER_PASSWORD_002");
  });

  it("is not confused by the older secret or by names that are not reader secrets", () => {
    expect(allocateReaderSecretName([LEGACY_READER_SECRET, "SOMETHING_ELSE", "READER_PASSWORD_abc"])).toBe("READER_PASSWORD_001");
  });

  it("goes past 999 without breaking", () => {
    expect(allocateReaderSecretName(Array.from({ length: 999 }, (_, index) => readerSecretName(index + 1)))).toBe("READER_PASSWORD_1000");
  });
});
