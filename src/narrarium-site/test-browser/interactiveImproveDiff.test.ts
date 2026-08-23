import { describe, expect, it } from "vitest";
import { computeDiffChangeChunks } from "@/components/diff/DiffView";

describe("interactive improve diff", () => {
  it("groups adjacent removed and added lines into independently decidable changes", () => {
    const chunks = computeDiffChangeChunks("one\ntwo\nthree\nfour", "one\nTWO\nthree\nFOUR");
    expect(chunks).toEqual([
      { id: "change-0", oldStart: 1, oldText: "two", newText: "TWO" },
      { id: "change-1", oldStart: 3, oldText: "four", newText: "FOUR" },
    ]);
  });

  it("represents pure insertion and deletion chunks", () => {
    expect(computeDiffChangeChunks("one\nthree", "one\ntwo\nthree")[0]).toMatchObject({ oldText: "", newText: "two" });
    expect(computeDiffChangeChunks("one\ntwo\nthree", "one\nthree")[0]).toMatchObject({ oldText: "two", newText: "" });
  });
});
