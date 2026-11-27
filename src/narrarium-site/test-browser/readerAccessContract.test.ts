import { describe, expect, it } from "vitest";
import { LEGACY_READER_SECRET, READER_PASSWORDS_VARIABLE, READER_SECRET_PREFIX, READER_WORKFLOW_FILE, READER_WORKFLOW_PATH, isReaderSecretName, readerSecretName, readerSecretNumber } from "@/readerAccess/contract";
import { PAGES_WORKFLOW_PATH } from "@/github/bookRepository";
import { LEGACY_READER_PASSWORD_SECRET, PAGES_WORKFLOW_FILE, PAGES_WORKFLOW_PATH as PACKAGE_WORKFLOW_PATH, READER_PASSWORD_SECRET_PREFIX, READER_PASSWORD_SECRETS_VARIABLE, formatReaderPasswordSecretNames, parseReaderPasswordSecretNames } from "narrarium-astro-reader/github-pages";
import { allocateReaderSecretName } from "@/readerAccess/operations";

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

describe("the names written out in the contract", () => {
  it("are the reader package's own: a rename there breaks this test", () => {
    expect(READER_WORKFLOW_PATH).toBe(PACKAGE_WORKFLOW_PATH);
    expect(READER_WORKFLOW_FILE).toBe(PAGES_WORKFLOW_FILE);
    expect(READER_PASSWORDS_VARIABLE).toBe(READER_PASSWORD_SECRETS_VARIABLE);
    expect(READER_SECRET_PREFIX).toBe(READER_PASSWORD_SECRET_PREFIX);
    expect(LEGACY_READER_SECRET).toBe(LEGACY_READER_PASSWORD_SECRET);
  });
});

describe("the variable that lists the secrets", () => {
  it("is read and written by the reader package: the same list the build reads", () => {
    expect(parseReaderPasswordSecretNames("READER_PASSWORD_002, READER_PASSWORD_001,,READER_PASSWORD_002 ").names).toEqual(["READER_PASSWORD_002", "READER_PASSWORD_001"]);
    expect(formatReaderPasswordSecretNames(["READER_PASSWORD_001", "READER_PASSWORD_002"])).toBe("READER_PASSWORD_001,READER_PASSWORD_002");
    expect(formatReaderPasswordSecretNames([])).toBe("");
  });
});

describe("the name for a new password", () => {
  const names = (...numbers: number[]) => numbers.map(readerSecretName);

  it("is the first free slot of the workflow: the workflow passes READER_PASSWORD_001 to READER_PASSWORD_024 to the build and no other name", () => {
    expect(allocateReaderSecretName([])).toBe("READER_PASSWORD_001");
    expect(allocateReaderSecretName(names(1, 2, 3))).toBe("READER_PASSWORD_004");
    expect(allocateReaderSecretName(names(2, 3))).toBe("READER_PASSWORD_001");
    expect(allocateReaderSecretName(names(1, 3))).toBe("READER_PASSWORD_002");
  });

  it("does not take a slot that is held anywhere (listed, a secret, or kept in Narrarium), and gives a removed password's slot back", () => {
    expect(allocateReaderSecretName([...names(1), ...names(2), ...names(3)])).toBe("READER_PASSWORD_004");
    expect(allocateReaderSecretName([...names(1, 2), ...names(4)])).toBe("READER_PASSWORD_003");
  });

  it("is not confused by the older secret, by names that are not reader secrets, or by a number past the slots", () => {
    expect(allocateReaderSecretName([LEGACY_READER_SECRET, "SOMETHING_ELSE", "READER_PASSWORD_abc", "READER_PASSWORD_030"])).toBe("READER_PASSWORD_001");
  });

  it("has no name when all 24 slots are used: the password is not added", () => {
    expect(allocateReaderSecretName(Array.from({ length: 23 }, (_, index) => readerSecretName(index + 1)))).toBe("READER_PASSWORD_024");
    expect(() => allocateReaderSecretName(Array.from({ length: 24 }, (_, index) => readerSecretName(index + 1)))).toThrow(/slot failed \(slots-full\)/);
  });
});
