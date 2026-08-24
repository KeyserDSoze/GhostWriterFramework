import { describe, expect, it } from "vitest";
import { computeDiffChangeChunks, mergeDiffChangeChunks } from "@/components/diff/DiffView";

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

  it("merges independent original and proposed decisions", () => {
    const previous = "one\ntwo\nthree\nfour";
    const chunks = computeDiffChangeChunks(previous, "one\nTWO\nthree\nFOUR");
    expect(mergeDiffChangeChunks(previous, chunks, { "change-0": "proposed", "change-1": "original" })).toBe("one\nTWO\nthree\nfour");
  });

  it("accepts regenerated proposals when applying all", () => {
    const previous = "one\ntwo\nthree";
    const chunks = computeDiffChangeChunks(previous, "one\nTWO\nthree");
    chunks[0].newText = "A better two";
    expect(mergeDiffChangeChunks(previous, chunks, { "change-0": "pending" }, "proposed")).toBe("one\nA better two\nthree");
  });
});
