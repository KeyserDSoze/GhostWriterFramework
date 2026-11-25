import { describe, expect, it } from "vitest";
import { MAX_KNOWN_BRANCHES, adoptRememberedBranches, bookAutoSyncMode, bookBranchMemory, branchMemoryKey, defaultAutoSyncMode, mergeBranchMemories, recordBranchUse, recordOpenedBranch, rememberedBranchToAdopt, revertAdoptedBranch, settleAdoptedBranch } from "@/branches/memory";
import { chooseBranch, forgetBranch, keepBranchInSync, labelBranch, setBookAutoSync } from "@/branches/memoryEdits";
import { DEFAULT_SETTINGS, type AppSettings, type BookBranchMemory, type BookEntry } from "@/types/settings";

const T1 = "2026-11-20T10:00:00.000Z";
const T2 = "2026-11-21T10:00:00.000Z";
const T3 = "2026-11-22T10:00:00.000Z";

const book: BookEntry = { id: "book-1", owner: "Writer", repo: "Novel", name: "Novel", tokenIndex: null, activeBranch: "dev-writer", addedAt: T1 };
const localBook: BookEntry = { id: "book-2", storageMode: "local-only", localRepositoryId: "local-2", owner: "", repo: "", name: "Here", tokenIndex: null, activeBranch: "local:local-2", addedAt: T1 };

function settingsWith(memory?: BookBranchMemory, books: BookEntry[] = [book]): AppSettings {
  return { ...DEFAULT_SETTINGS, books, ...(memory ? { branchMemory: { "writer/novel": memory } } : {}) };
}

describe("the memory of the branches of a book", () => {
  it("is kept per repository, whatever the case of its name", () => {
    expect(branchMemoryKey("Writer", "Novel")).toBe("writer/novel");
    const memory = recordBranchUse(undefined, "main", T1, { current: true });
    expect(bookBranchMemory(settingsWith(memory), { owner: "WRITER", repo: "novel" })).toBe(memory);
    expect(bookBranchMemory(settingsWith(memory), localBook)).toBeUndefined();
  });

  it("records a branch chosen, the newest first, and makes it the working branch only when chosen", () => {
    const first = recordBranchUse(undefined, "main", T1, { current: true });
    const opened = recordBranchUse(first, "draft/old", T2);
    const chosen = recordBranchUse(opened, "feature/ending", T3, { current: true, createdHere: true });
    expect(opened).toMatchObject({ lastWorkingBranch: "main", lastWorkingAt: T1, updatedAt: T2 });
    expect(chosen).toMatchObject({ lastWorkingBranch: "feature/ending", lastWorkingAt: T3, updatedAt: T3 });
    expect(chosen.knownBranches.map((entry) => entry.name)).toEqual(["feature/ending", "draft/old", "main"]);
    expect(chosen.knownBranches[0]).toEqual({ name: "feature/ending", lastUsedAt: T3, createdHere: true });
    // Using it again keeps what the person said of it.
    const labelled = labelBranch(chosen, "feature/ending", "  The   new ending ", T3);
    expect(recordBranchUse(labelled, "feature/ending", T3).knownBranches[0]).toEqual({ name: "feature/ending", lastUsedAt: T3, createdHere: true, label: "The new ending" });
  });

  it("keeps at most the newest branches, and never drops the working branch", () => {
    let memory = recordBranchUse(undefined, "oldest-current", "2020-01-01T00:00:00.000Z", { current: true });
    for (let index = 0; index < MAX_KNOWN_BRANCHES + 5; index += 1) memory = recordBranchUse(memory, `b-${index}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString());
    expect(memory.knownBranches).toHaveLength(MAX_KNOWN_BRANCHES);
    expect(memory.knownBranches.map((entry) => entry.name)).toContain("oldest-current");
    expect(memory.knownBranches.map((entry) => entry.name)).not.toContain("b-0");
  });

  it("forgets, labels and pins branches in the memory alone", () => {
    const memory = recordBranchUse(recordBranchUse(undefined, "main", T1, { current: true }), "draft/a", T2);
    expect(forgetBranch(memory, "draft/a", T3)).toEqual({ lastWorkingBranch: "main", lastWorkingAt: T1, knownBranches: [{ name: "main", lastUsedAt: T1 }], updatedAt: T3 });
    // Forgetting the working branch leaves no working branch to open elsewhere.
    expect(forgetBranch(memory, "main", T3)).toEqual({ knownBranches: [{ name: "draft/a", lastUsedAt: T2 }], updatedAt: T3 });
    expect(labelBranch(memory, "draft/a", "draft/a", T3).knownBranches.find((entry) => entry.name === "draft/a")).toEqual({ name: "draft/a", lastUsedAt: T2 });
    expect(labelBranch(memory, "draft/a", "x".repeat(80), T3).knownBranches.find((entry) => entry.name === "draft/a")?.label).toHaveLength(60);
    const pinned = keepBranchInSync(memory, "draft/a", true, T3);
    expect(pinned.knownBranches.find((entry) => entry.name === "draft/a")).toEqual({ name: "draft/a", lastUsedAt: T2, sync: true });
    expect(keepBranchInSync(pinned, "draft/a", undefined, T3).knownBranches.find((entry) => entry.name === "draft/a")).toEqual({ name: "draft/a", lastUsedAt: T2 });
  });

  it("has an automatic sync per book over the default of the settings, which older settings set from their switches", () => {
    expect(defaultAutoSyncMode(DEFAULT_SETTINGS.repository)).toBe("open-focus");
    expect(defaultAutoSyncMode({ ...DEFAULT_SETTINGS.repository, autoFetchIntervalMinutes: 10 })).toBe("periodic");
    expect(defaultAutoSyncMode({ ...DEFAULT_SETTINGS.repository, autoFetchIntervalMinutes: 10, autoSync: "off" })).toBe("off");
    const memory = setBookAutoSync(recordBranchUse(undefined, "main", T1), "periodic", T2);
    expect(bookAutoSyncMode(settingsWith(memory), book)).toBe("periodic");
    expect(bookAutoSyncMode(settingsWith(setBookAutoSync(memory, undefined, T3)), book)).toBe("open-focus");
    expect(bookAutoSyncMode({ ...settingsWith(), repository: { ...DEFAULT_SETTINGS.repository, autoSync: "off" } }, book)).toBe("off");
  });
});

describe("two copies of the memory that both changed", () => {
  it("keep, for each book, the record changed last, and every book either copy has", () => {
    const older = { "writer/novel": recordBranchUse(undefined, "draft/a", T1, { current: true }), "writer/other": recordBranchUse(undefined, "main", T1) };
    const newer = { "writer/novel": recordBranchUse(undefined, "draft/b", T2, { current: true }) };
    expect(mergeBranchMemories(older, newer)).toEqual({ "writer/novel": newer["writer/novel"], "writer/other": older["writer/other"] });
    expect(mergeBranchMemories(newer, older)).toEqual({ "writer/novel": newer["writer/novel"], "writer/other": older["writer/other"] });
    expect(mergeBranchMemories(undefined, undefined)).toBeUndefined();
  });
});

describe("the branch chosen last on another device", () => {
  const remembered = recordBranchUse(undefined, "feature/ending", T2, { current: true });

  it("is taken by a device whose own choice is older, or that never chose", () => {
    expect(rememberedBranchToAdopt({ ...book, activeBranchAt: T1 }, remembered)).toBe("feature/ending");
    expect(rememberedBranchToAdopt({ ...book, activeBranch: undefined }, remembered)).toBe("feature/ending");
    expect(rememberedBranchToAdopt({ ...book, activeBranchAt: T3 }, remembered)).toBeNull();
    expect(rememberedBranchToAdopt({ ...book, activeBranch: "feature/ending" }, remembered)).toBeNull();
    expect(rememberedBranchToAdopt(localBook, remembered)).toBeNull();
    expect(rememberedBranchToAdopt(book, recordBranchUse(undefined, "x", T1))).toBeNull();
  });

  it("is taken by every book but the one on the screen, remembering the branch each had", () => {
    const second: BookEntry = { ...book, id: "book-3", activeBranch: undefined };
    const settings = { ...settingsWith(remembered, [book, second, localBook]) };
    const adopted = adoptRememberedBranches(settings, { except: "book-3" });
    expect(adopted.books[0]).toMatchObject({ activeBranch: "feature/ending", activeBranchAt: T2, adoptedFrom: "dev-writer" });
    expect(adopted.books[1]).toBe(second);
    expect(adopted.books[2]).toBe(localBook);
    expect(adoptRememberedBranches(settings, { only: "book-3" }).books[1]).toMatchObject({ activeBranch: "feature/ending", adoptedFrom: "" });
    // Nothing to take: the same settings object, so nothing is rendered or saved again.
    expect(adoptRememberedBranches(adopted, { except: "book-3" })).toBe(adopted);
  });

  it("stays when it opened, and gives the book back its branch when it could not", () => {
    const adopted = adoptRememberedBranches(settingsWith(remembered)).books[0];
    expect(settleAdoptedBranch(adopted)).toEqual({ ...book, activeBranch: "feature/ending", activeBranchAt: T2 });
    expect(revertAdoptedBranch(adopted)).toEqual({ ...book, activeBranch: "dev-writer", activeBranchAt: T2 });
    // The personal branch again, and no new try until another choice is made.
    const fromAuto = adoptRememberedBranches(settingsWith(remembered, [{ ...book, activeBranch: undefined }])).books[0];
    const reverted = revertAdoptedBranch(fromAuto);
    expect(reverted.activeBranch).toBeUndefined();
    expect(rememberedBranchToAdopt(reverted, remembered)).toBeNull();
  });

  it("is this device's own choice when this device makes it: the same instant on both sides, so neither moves the other", () => {
    const settings = settingsWith(recordBranchUse(undefined, "main", T1, { current: true }));
    const patch = chooseBranch(settings, { ...book, adoptedFrom: "main" }, "draft/x", T3, { createdHere: true });
    const next = { ...settings, ...patch };
    expect(next.books[0]).toEqual({ ...book, activeBranch: "draft/x", activeBranchAt: T3 });
    expect(bookBranchMemory(next, book)).toMatchObject({ lastWorkingBranch: "draft/x", lastWorkingAt: T3, knownBranches: [{ name: "draft/x", lastUsedAt: T3, createdHere: true }, { name: "main", lastUsedAt: T1 }] });
    expect(rememberedBranchToAdopt(next.books[0], bookBranchMemory(next, book))).toBeNull();
  });

  it("learns of a branch opened here for the first time, without taking it back from itself", () => {
    const settings = settingsWith(undefined, [{ ...book, activeBranch: undefined }]);
    const patch = recordOpenedBranch(settings, settings.books[0], "dev-writer", T2)!;
    const next = { ...settings, ...patch };
    expect(bookBranchMemory(next, book)).toEqual({ lastWorkingBranch: "dev-writer", lastWorkingAt: T2, knownBranches: [{ name: "dev-writer", lastUsedAt: T2 }], updatedAt: T2 });
    expect(next.books[0].activeBranchAt).toBe(T2);
    expect(rememberedBranchToAdopt(next.books[0], bookBranchMemory(next, book))).toBeNull();
    expect(recordOpenedBranch(next, next.books[0], "dev-writer", T3)).toBeNull();
    // Another branch opened later is known, and the working branch stays the one chosen.
    const later = { ...next, ...recordOpenedBranch(next, next.books[0], "main", T3)! };
    expect(bookBranchMemory(later, book)).toMatchObject({ lastWorkingBranch: "dev-writer", knownBranches: [{ name: "main" }, { name: "dev-writer" }] });
    expect(recordOpenedBranch(settings, localBook, "local:local-2", T2)).toBeNull();
  });
});
