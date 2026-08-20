import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureImmediateMutation, commitImmediateMutations } = vi.hoisted(() => ({
  captureImmediateMutation: vi.fn(),
  commitImmediateMutations: vi.fn(),
}));

vi.mock("@/assistant/immediateMutation", () => ({ captureImmediateMutation, commitImmediateMutations }));

import { ensureDefaultGhostwriter } from "@/narrarium/defaultGhostwriter";

const book = { id: "book", owner: "owner", repo: "repo", name: "Book", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z" } as const;
const structure = {
  title: "Book",
  description: "",
  language: "it",
  owner: "owner",
  repo: "repo",
  defaultBranch: "main",
  loadedBranch: "main",
  chapters: [], characters: [], locations: [], factions: [], items: [], timelines: [], secrets: [],
  ghostwriters: [], readerPersonas: [], readerEvaluationFiles: [], operationManifestFiles: [], auditFiles: [], researchFiles: [], notesFiles: [],
} as any;

describe("default ghostwriter provisioning", () => {
  beforeEach(() => {
    captureImmediateMutation.mockReset();
    commitImmediateMutations.mockReset().mockResolvedValue("next-head");
  });

  it("creates and selects the default profile in one repository mutation", async () => {
    captureImmediateMutation
      .mockResolvedValueOnce({ path: "book.md", content: "---\ntype: book\nid: book\ntitle: Book\ncustom: keep\n---\n\nDescription\n", hash: "book-hash", sha: "book-sha", remoteHeadSha: "head" })
      .mockResolvedValueOnce({ path: "ghostwriters/default.md", content: null, hash: null, sha: null, remoteHeadSha: "head" });

    await expect(ensureDefaultGhostwriter({ token: "token", book, branch: "main", structure })).resolves.toBe(true);

    expect(captureImmediateMutation).toHaveBeenNthCalledWith(2, expect.objectContaining({ path: "ghostwriters/default.md", remoteHeadSha: "head" }));
    const mutation = commitImmediateMutations.mock.calls[0][0];
    expect(mutation.snapshots).toHaveLength(2);
    expect(mutation.snapshots[0].content).toContain("writing_style:");
    expect(mutation.snapshots[0].content).toContain("punctuation_style:");
    expect(mutation.snapshots[1].content).toContain("ghostwriter: default");
    expect(mutation.snapshots[1].content).toContain("custom: keep");
    expect(mutation.snapshots[1].content).toContain("Description");
  });

  it("selects an existing default profile without rewriting it", async () => {
    captureImmediateMutation.mockResolvedValueOnce({ path: "book.md", content: "---\ntype: book\nid: book\ntitle: Book\n---\n", hash: "book-hash", sha: "book-sha", remoteHeadSha: "head" });
    const existing = { ...structure, ghostwriters: [{ slug: "default", path: "ghostwriters/default.md", name: "Default" }] };

    await expect(ensureDefaultGhostwriter({ token: "token", book, branch: "main", structure: existing })).resolves.toBe(true);

    expect(captureImmediateMutation).toHaveBeenCalledTimes(1);
    expect(commitImmediateMutations.mock.calls[0][0].snapshots).toHaveLength(1);
  });

  it("removes standalone legacy style files instead of importing them", async () => {
    const current = {
      ...structure,
      ghostwriter: "default",
      ghostwriters: [{ slug: "default", path: "ghostwriters/default.md", name: "Default" }],
      searchableFiles: [
        { path: "writing-style.md", role: "repository text" },
        { path: "punctuation-style.md", role: "repository text" },
        { path: "chapters/001-start/writing-style.md", role: "chapter or paragraph" },
      ],
    };
    captureImmediateMutation
      .mockResolvedValueOnce({ path: "book.md", content: "---\ntype: book\nid: book\ntitle: Book\nghostwriter: default\n---\n", hash: "book-hash", sha: "book-sha", remoteHeadSha: "head" })
      .mockImplementation(async ({ path }: { path: string }) => ({ path, content: "legacy", hash: `${path}-hash`, sha: `${path}-sha`, remoteHeadSha: "head" }));

    await expect(ensureDefaultGhostwriter({ token: "token", book, branch: "main", structure: current })).resolves.toBe(true);

    const mutation = commitImmediateMutations.mock.calls[0][0];
    expect(mutation.snapshots.map((entry: { snapshot: { path: string }; content: string | null }) => [entry.snapshot.path, entry.content])).toEqual([
      ["writing-style.md", null],
      ["punctuation-style.md", null],
      ["chapters/001-start/writing-style.md", null],
    ]);
  });

  it("does nothing when a valid selected ghostwriter and default profile exist", async () => {
    const current = { ...structure, ghostwriter: "custom", ghostwriters: [{ slug: "default", path: "ghostwriters/default.md", name: "Default" }, { slug: "custom", path: "ghostwriters/custom.md", name: "Custom" }] };
    await expect(ensureDefaultGhostwriter({ token: "token", book, branch: "main", structure: current })).resolves.toBe(false);
    expect(captureImmediateMutation).not.toHaveBeenCalled();
    expect(commitImmediateMutations).not.toHaveBeenCalled();
  });

  it("refuses to rewrite malformed book frontmatter", async () => {
    captureImmediateMutation.mockResolvedValueOnce({ path: "book.md", content: "---\ntitle: Broken\n", hash: "book-hash", sha: "book-sha", remoteHeadSha: "head" });

    await expect(ensureDefaultGhostwriter({ token: "token", book, branch: "main", structure })).rejects.toThrow("Invalid book.md frontmatter");
    expect(commitImmediateMutations).not.toHaveBeenCalled();
  });
});
