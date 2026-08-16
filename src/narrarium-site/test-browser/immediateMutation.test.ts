import { beforeEach, describe, expect, test, vi } from "vitest";
import { captureImmediateMutation, commitImmediateMutation, mergeManagedFrontmatter } from "@/assistant/immediateMutation";

const github = vi.hoisted(() => ({ readFileWithSha: vi.fn(), isGitHubFileNotFoundError: vi.fn() }));
const safe = vi.hoisted(() => ({
  resolveRepositoryHeadForMutation: vi.fn(),
  sha256Text: vi.fn(),
  commitAndPushTextFileMutation: vi.fn(),
}));

vi.mock("@/github/githubClient", () => github);
vi.mock("@/repository/safeRepositoryMutation", () => safe);

const book = { id: "book", owner: "owner", repo: "repo" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  safe.resolveRepositoryHeadForMutation.mockResolvedValue("source-head");
  safe.sha256Text.mockResolvedValue("source-hash");
  github.readFileWithSha.mockResolvedValue({ sha: "source-sha", content: "old" });
});

describe.each(["plot", "resume", "evaluation", "note", "reader", "structured file"])("%s immediate mutation", () => {
  test("requires the captured source hash and head at the final write", async () => {
    const snapshot = await captureImmediateMutation({ token: "token", book, branch: "main", path: "target.md" });
    const signal = new AbortController().signal;
    safe.commitAndPushTextFileMutation.mockResolvedValue({ commitSha: "next-head", mode: "remote" });

    await commitImmediateMutation({ token: "token", book, branch: "main", snapshot, content: "new", message: "Update", signal });

    expect(safe.commitAndPushTextFileMutation).toHaveBeenCalledWith({
      token: "token",
      book,
      branch: "main",
      expectedRemoteHeadSha: "source-head",
      message: "Update",
      mutations: [{ path: "target.md", content: "new", expectedCurrentHash: "source-hash" }],
      signal,
    });
  });

  test("does not hide a concurrent-edit conflict", async () => {
    const conflict = new Error("The remote branch changed before the operation could be saved.");
    safe.commitAndPushTextFileMutation.mockRejectedValue(conflict);

    await expect(commitImmediateMutation({
      token: "token",
      book,
      branch: "main",
      snapshot: { path: "target.md", content: "old", sha: "source-sha", hash: "source-hash", remoteHeadSha: "source-head" },
      content: "generated",
      message: "Update",
    })).rejects.toBe(conflict);
  });
});

test("rechecks abort immediately before mutation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(commitImmediateMutation({
    token: "token",
    book,
    branch: "main",
    snapshot: { path: "plot.md", content: "old", sha: "sha", hash: "hash", remoteHeadSha: "head" },
    content: "new",
    message: "Update",
    signal: controller.signal,
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(safe.commitAndPushTextFileMutation).not.toHaveBeenCalled();
});

test("preserves custom frontmatter while schema-owned fields are replaced", () => {
  expect(mergeManagedFrontmatter(
    { type: "old", title: "Old", custom: { keep: true }, tags: ["manual"] },
    { type: "plot", title: "Plot" },
    ["type", "title"],
  )).toEqual({ custom: { keep: true }, tags: ["manual"], type: "plot", title: "Plot" });
});
