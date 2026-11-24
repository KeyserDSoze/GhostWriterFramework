import { describe, expect, it } from "vitest";
import { LEGACY_READER_SECRET } from "@/readerAccess/contract";
import { allReaderPasswordValues, readerProtection, readerRecordsOf, readerRepositoryKey, reconcileReaderPasswords, takenReaderNames, withReaderRecords } from "@/readerAccess/model";
import type { ReaderPasswordRecord } from "@/types/settings";

const record = (number: number, patch: Partial<ReaderPasswordRecord> = {}): ReaderPasswordRecord => ({ id: `id-${number}`, label: `Reader ${number}`, value: `value-${number}-xxxxxx`, createdAt: "2026-11-25T10:00:00.000Z", secretName: `READER_PASSWORD_${String(number).padStart(3, "0")}`, status: "active", ...patch });
const name = (number: number) => `READER_PASSWORD_${String(number).padStart(3, "0")}`;

describe("the passwords kept for a repository", () => {
  it("are found by owner/repo whatever the case", () => {
    const settings = { readerAccess: { "me/book": [record(1)] } };
    expect(readerRepositoryKey("Me", "Book")).toBe("me/book");
    expect(readerRecordsOf(settings, "ME", "BOOK")).toEqual([record(1)]);
    expect(readerRecordsOf(settings, "me", "other")).toEqual([]);
    expect(readerRecordsOf({}, "me", "book")).toEqual([]);
  });

  it("leave out whatever has not the shape of a record, without touching it", () => {
    const stranger = { id: "x", label: "From a newer client", shape: 2 };
    const settings = { readerAccess: { "me/book": [record(1), stranger, { ...record(2), value: "" }, { ...record(3), secretName: "OTHER" }, { ...record(4), status: "weird" }, null] as never } };
    expect(readerRecordsOf(settings, "me", "book")).toEqual([record(1)]);
    const next = withReaderRecords(settings.readerAccess, "me", "book", [record(1), record(5)]);
    expect(next?.["me/book"]).toEqual(expect.arrayContaining([record(1), record(5), stranger]));
    expect(next?.["me/book"]).toContainEqual({ ...record(2), value: "" });
  });

  it("are replaced for one repository and left as they are for the others; an empty list removes the key", () => {
    const map = { "me/book": [record(1)], "me/other": [record(2)] };
    expect(withReaderRecords(map, "me", "book", [])).toEqual({ "me/other": [record(2)] });
    expect(withReaderRecords({ "me/book": [record(1)] }, "me", "book", [])).toBeUndefined();
    expect(withReaderRecords(undefined, "me", "book", [record(1)])).toEqual({ "me/book": [record(1)] });
    expect(map["me/book"]).toEqual([record(1)]);
  });

  it("are all listed, for the places that must hide them", () => {
    expect(allReaderPasswordValues({ readerAccess: { "a/b": [record(1), record(2)], "c/d": [record(3)] } }).sort()).toEqual(["value-1-xxxxxx", "value-2-xxxxxx", "value-3-xxxxxx"]);
    expect(allReaderPasswordValues({})).toEqual([]);
    expect(allReaderPasswordValues({ readerAccess: { "a/b": ["not a record", null, { value: 3 }] as never } })).toEqual([]);
  });
});

describe("the rows of the list, from what Narrarium keeps and what GitHub holds", () => {
  const remote = (secrets: string[] | null, listed: string[] | null) => ({ secrets, listed });
  const states = (rows: ReturnType<typeof reconcileReaderPasswords>) => rows.map((row) => [row.secretName, row.state]);

  it("a stored password that GitHub has and lists is active", () => {
    expect(states(reconcileReaderPasswords([record(1)], remote([name(1)], [name(1)])))).toEqual([[name(1), "active"]]);
  });

  it("an interrupted add is pending, an interrupted removal is removing, whatever GitHub holds", () => {
    expect(states(reconcileReaderPasswords([record(1, { status: "pending" }), record(2, { status: "removing" })], remote([name(2)], [])))).toEqual([[name(1), "pending"], [name(2), "removing"]]);
  });

  it("a stored password that GitHub lost (the secret deleted by hand, or the list edited) is out of sync", () => {
    expect(states(reconcileReaderPasswords([record(1), record(2)], remote([name(1)], [name(1), name(2)])))).toEqual([[name(1), "active"], [name(2), "out-of-sync"]]);
    expect(states(reconcileReaderPasswords([record(1)], remote([name(1)], [])))).toEqual([[name(1), "out-of-sync"]]);
  });

  it("a password on GitHub with no stored value can only be removed (unknown value), and a listed name with no secret is dangling", () => {
    expect(states(reconcileReaderPasswords([], remote([name(3)], [name(3)])))).toEqual([[name(3), "unknown-value"]]);
    expect(states(reconcileReaderPasswords([], remote([], [name(4)])))).toEqual([[name(4), "dangling"]]);
  });

  it("the older single secret is one more password, last in the list", () => {
    const rows = reconcileReaderPasswords([record(2)], remote([LEGACY_READER_SECRET, name(2)], [name(2)]));
    expect(states(rows)).toEqual([[name(2), "active"], [LEGACY_READER_SECRET, "legacy"]]);
    expect(rows[1].record).toBeUndefined();
  });

  it("ignores secrets that are not the reader's", () => {
    expect(reconcileReaderPasswords([], remote(["NPM_TOKEN", "AZURE_CLIENT"], []))).toEqual([]);
  });

  it("keeps stored passwords visible when GitHub could not be read, without claiming anything about it", () => {
    const rows = reconcileReaderPasswords([record(1)], remote(null, null));
    expect(rows).toEqual([{ secretName: name(1), state: "active", record: record(1), hasSecret: null, listed: null }]);
  });

  it("orders by number, however many digits", () => {
    const rows = reconcileReaderPasswords([record(10), record(2), record(1000)], remote([name(10), name(2), "READER_PASSWORD_1000"], [name(10), name(2), "READER_PASSWORD_1000"]));
    expect(rows.map((row) => row.secretName)).toEqual([name(2), name(10), "READER_PASSWORD_1000"]);
  });

  it("every name that is held anywhere is taken", () => {
    expect(takenReaderNames([record(1, { status: "removing" })], remote([name(2)], [name(3)])).sort()).toEqual([name(1), name(2), name(3)]);
    expect(takenReaderNames([record(1)], remote(null, null))).toEqual([name(1)]);
  });
});

describe("whether the published reader asks for a password", () => {
  it("does when the variable lists a secret that exists, or the older secret exists", () => {
    expect(readerProtection({ secrets: [name(1)], listed: [name(1)] })).toBe("protected");
    expect(readerProtection({ secrets: [LEGACY_READER_SECRET], listed: [] })).toBe("protected");
  });

  it("does not when nothing listed has a secret behind it", () => {
    expect(readerProtection({ secrets: [name(1)], listed: [] })).toBe("public");
    expect(readerProtection({ secrets: [], listed: [name(1)] })).toBe("public");
    expect(readerProtection({ secrets: [], listed: [] })).toBe("public");
  });

  it("claims nothing when GitHub could not be read", () => {
    expect(readerProtection({ secrets: null, listed: [] })).toBe("unknown");
    expect(readerProtection({ secrets: [], listed: null })).toBe("unknown");
  });
});
