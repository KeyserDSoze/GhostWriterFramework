import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { LEGACY_SYNC_BASE_PREFIX, SyncBaseError, forgetSyncBase, readSyncBase, resetSyncBaseForTests, writeSyncBase } from "@/autopilot/syncBase";
import { dropSyncBaseDatabase } from "./helpers/rawSyncBase";

const SERVER = "server-1";
const BOOK = "book-1";
const legacyKey = (server = SERVER, book = BOOK) => `${LEGACY_SYNC_BASE_PREFIX}${server}:${book}`;

const manifest = (entries: Record<string, string>) => new Map(Object.entries(entries));

/** The raw record, read without the module under test. */
async function rawRecords(): Promise<Array<{ key: string; files: Array<[string, string]> }>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("narrarium-autopilot-sync");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const tx = db.transaction("bases", "readonly");
    return await new Promise((resolve, reject) => {
      const request = tx.objectStore("bases").getAll();
      request.onsuccess = () => resolve(request.result as Array<{ key: string; files: Array<[string, string]> }>);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  localStorage.clear();
  await resetSyncBaseForTests();
  await dropSyncBaseDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the base of a sync lives in IndexedDB", () => {
  it("keeps one object per server and book, and gives back exactly what was written", async () => {
    await writeSyncBase(SERVER, BOOK, manifest({ "book.md": "h1", "chapters/001/001.md": "h2" }));
    await writeSyncBase(SERVER, "book-2", manifest({ "book.md": "h9" }));
    await writeSyncBase("server-2", BOOK, manifest({ "book.md": "h7" }));

    expect((await rawRecords()).map((record) => record.key).sort()).toEqual([`server-1:book-1`, `server-1:book-2`, `server-2:book-1`]);
    const { base, found } = await readSyncBase(SERVER, BOOK);
    expect(found).toBe(true);
    expect([...base.entries()]).toEqual([["book.md", "h1"], ["chapters/001/001.md", "h2"]]);
    expect((await readSyncBase("server-2", BOOK)).base.get("book.md")).toBe("h7");
    expect(localStorage.length).toBe(0);
  });

  it("is empty, and says so, when nothing was saved: that is a first sync", async () => {
    const { base, found } = await readSyncBase(SERVER, BOOK);
    expect(found).toBe(false);
    expect(base.size).toBe(0);
  });

  it("can forget the base of a book", async () => {
    await writeSyncBase(SERVER, BOOK, manifest({ "book.md": "h1" }));
    await forgetSyncBase(SERVER, BOOK);
    expect((await readSyncBase(SERVER, BOOK)).found).toBe(false);
  });

  it("keeps a path that looks like an object property", async () => {
    await writeSyncBase(SERVER, BOOK, new Map([["__proto__", "h1"], ["constructor", "h2"]]));
    const { base } = await readSyncBase(SERVER, BOOK);
    expect(base.get("__proto__")).toBe("h1");
    expect(base.get("constructor")).toBe("h2");
  });

  it("stores and reads back a book of thousands of files in one object", async () => {
    const files = new Map<string, string>();
    for (let index = 0; index < 12_000; index += 1) files.set(`chapters/${String(index).padStart(5, "0")}-chapter/001-scene.md`, `hash-${index}`);
    await writeSyncBase(SERVER, BOOK, files);
    expect(await rawRecords()).toHaveLength(1);
    const { base, found } = await readSyncBase(SERVER, BOOK);
    expect(found).toBe(true);
    expect(base.size).toBe(12_000);
    expect(base.get("chapters/11999-chapter/001-scene.md")).toBe("hash-11999");
  });
});

describe("the base saved in localStorage by earlier versions", () => {
  it("is read, written to the new place and then deleted, once", async () => {
    localStorage.setItem(legacyKey(), JSON.stringify([["book.md", "old-1"], ["plot.md", "old-2"]]));
    localStorage.setItem(legacyKey("server-1", "book-2"), JSON.stringify([["book.md", "other"]]));
    localStorage.setItem("narrarium-something-else", "keep me");

    const { base, found } = await readSyncBase(SERVER, BOOK);
    expect(found).toBe(true);
    expect(base.get("plot.md")).toBe("old-2");
    expect(localStorage.getItem(legacyKey())).toBeNull();
    expect(localStorage.getItem(legacyKey("server-1", "book-2"))).toBeNull();
    expect(localStorage.getItem("narrarium-something-else")).toBe("keep me");
    expect((await rawRecords()).map((record) => record.key).sort()).toEqual(["server-1:book-1", "server-1:book-2"]);

    // Once moved, the new place is the only one: a later change is not overwritten by the old key.
    await writeSyncBase(SERVER, BOOK, manifest({ "book.md": "new-1" }));
    expect((await readSyncBase(SERVER, BOOK)).base.get("book.md")).toBe("new-1");
  });

  it("does not let the old copy win over a base that was already saved in IndexedDB", async () => {
    await writeSyncBase(SERVER, BOOK, manifest({ "book.md": "new" }));
    localStorage.setItem(legacyKey(), JSON.stringify([["book.md", "old"]]));
    expect((await readSyncBase(SERVER, BOOK)).base.get("book.md")).toBe("new");
    expect(localStorage.getItem(legacyKey())).toBeNull();
  });

  it("is kept, and still used, when the new place cannot be written", async () => {
    localStorage.setItem(legacyKey(), JSON.stringify([["book.md", "old-1"]]));
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); });

    const { base, found } = await readSyncBase(SERVER, BOOK);
    expect(found).toBe(true);
    expect(base.get("book.md")).toBe("old-1");
    expect(localStorage.getItem(legacyKey())).not.toBeNull();
  });

  it("ignores a damaged old value instead of failing", async () => {
    localStorage.setItem(legacyKey(), "{not json");
    const { found, base } = await readSyncBase(SERVER, BOOK);
    expect(found).toBe(false);
    expect(base.size).toBe(0);
  });
});

describe("a base that cannot be saved", () => {
  it("raises a visible, translated error when the storage is full, and keeps the previous base", async () => {
    await writeSyncBase(SERVER, BOOK, manifest({ "book.md": "kept" }));
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); });

    const failure = await writeSyncBase(SERVER, BOOK, manifest({ "book.md": "lost" })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SyncBaseError);
    expect((failure as SyncBaseError).operation).toBe("write");
    expect((failure as SyncBaseError).message).toBe(i18n.t("autopilot.errors.baseSaveFailed"));
    expect((failure as SyncBaseError).message).not.toBe("autopilot.errors.baseSaveFailed");

    vi.restoreAllMocks();
    expect((await readSyncBase(SERVER, BOOK)).base.get("book.md")).toBe("kept");
  });

  it("writes all or nothing: a transaction that is cut short leaves the previous base as it was", async () => {
    await writeSyncBase(SERVER, BOOK, manifest({ "book.md": "kept", "plot.md": "kept-too" }));
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      const request = put.apply(this, args);
      this.transaction.abort();
      return request;
    });

    await expect(writeSyncBase(SERVER, BOOK, manifest({ "book.md": "half" }))).rejects.toBeInstanceOf(SyncBaseError);
    vi.restoreAllMocks();
    const { base } = await readSyncBase(SERVER, BOOK);
    expect([...base.entries()]).toEqual([["book.md", "kept"], ["plot.md", "kept-too"]]);
  });

  it("is explained in both languages", async () => {
    for (const lng of ["en", "it"]) {
      expect(i18n.exists("autopilot.errors.baseSaveFailed", { lng })).toBe(true);
      expect(i18n.exists("autopilot.errors.baseReadFailed", { lng })).toBe(true);
    }
    expect(i18n.t("autopilot.errors.baseSaveFailed", { lng: "it" })).not.toBe(i18n.t("autopilot.errors.baseSaveFailed", { lng: "en" }));
  });
});
