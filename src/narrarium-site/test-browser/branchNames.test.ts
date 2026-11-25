import { describe, expect, it } from "vitest";
import { branchNameFromInput, branchNameProblem, suggestBranchName } from "@/branches/branchNames";

describe("names of branches", () => {
  it("accept what Git accepts for a branch, and say what is wrong with the rest", () => {
    for (const name of ["main", "draft/2026-11-24", "feature/the-new-ending", "dev-ada", "v1.2", "a/b/c"]) expect(branchNameProblem(name), name).toBeNull();
    expect(branchNameProblem("")).toBe("empty");
    expect(branchNameProblem("x".repeat(201))).toBe("too-long");
    expect(branchNameProblem("the new ending")).toBe("spaces");
    for (const name of ["a:b", "a~1", "a^", "what?", "a*", "a[1]", "a\\b", "a@{1}"]) expect(branchNameProblem(name), name).toBe("characters");
    for (const name of ["/a", "a/", "a//b", "-a"]) expect(branchNameProblem(name), name).toBe("slashes");
    for (const name of ["a..b", "a.", ".a", "a/.b"]) expect(branchNameProblem(name), name).toBe("dots");
    expect(branchNameProblem("a.lock")).toBe("lock");
    expect(branchNameProblem("a/b.lock/c")).toBe("lock");
    expect(branchNameProblem("HEAD")).toBe("reserved");
    expect(branchNameProblem("@")).toBe("reserved");
  });

  it("are made from a few words, keeping a name that already is one", () => {
    expect(branchNameFromInput("  draft/2026-11-24 ")).toBe("draft/2026-11-24");
    expect(branchNameFromInput("The new ending")).toBe("feature/the-new-ending");
    expect(branchNameFromInput("Un finale più cupo!")).toBe("feature/un-finale-piu-cupo");
    expect(branchNameFromInput("Draft/Act two")).toBe("draft/act-two");
    expect(branchNameFromInput("what? ... ")).toBe("feature/what");
    expect(branchNameFromInput("?!")).toBe("");
    expect(branchNameFromInput("")).toBe("");
    expect(branchNameProblem(branchNameFromInput(`${"long words ".repeat(20)}`))).toBeNull();
  });

  it("are suggested from the day, without taking a name a branch has", () => {
    const day = new Date(2026, 10, 24, 23, 30);
    expect(suggestBranchName(new Set(), day)).toBe("draft/2026-11-24");
    expect(suggestBranchName(new Set(["draft/2026-11-24"]), day)).toBe("draft/2026-11-24-2");
    expect(suggestBranchName(new Set(["draft/2026-11-24", "draft/2026-11-24-2"]), day)).toBe("draft/2026-11-24-3");
  });
});
