import { beforeEach, expect, test, vi } from "vitest";
import { buildParagraphScriptArtifact } from "@/narrarium/workspace";

const git = vi.hoisted(() => ({ getRef: vi.fn(), getTree: vi.fn(), getCommit: vi.fn(), createTree: vi.fn(), createCommit: vi.fn(), updateRef: vi.fn() }));
vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git }; } }));
vi.mock("@/repository/localRepository", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/repository/localRepository")>(),
  getLocalRepository: vi.fn().mockResolvedValue(null),
}));

import { commitCanonicalScriptMutation } from "@/narrarium/scriptLedger";
import { sha256Text } from "@/repository/safeRepositoryMutation";

const chapterPath = "chapters/001-one/chapter.md";
const chapter = "---\ntype: chapter\nid: chapter:001-one\nnumber: 1\ntitle: One\n---\n";
const artifact = buildParagraphScriptArtifact({ chapterSlug: "001-one", number: 1, title: "Opening", paragraphSlug: "001-opening" });
let current = new Map<string, string>();
let createdTree: Array<{ path: string; content?: string; sha?: string | null }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  current = new Map([[chapterPath, chapter]]);
  createdTree = [];
  git.getRef.mockResolvedValue({ data: { object: { sha: "head" } } });
  git.getTree.mockImplementation(async () => ({ data: { truncated: false, tree: [...current.keys()].map((path) => ({ path, type: "blob" })) } }));
  git.getCommit.mockResolvedValue({ data: { tree: { sha: "base-tree" } } });
  git.createTree.mockImplementation(async ({ tree }: { tree: typeof createdTree }) => { createdTree = tree; return { data: { sha: "next-tree" } }; });
  git.createCommit.mockResolvedValue({ data: { sha: "next-head" } });
  git.updateRef.mockResolvedValue({});
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const marker = "/contents/";
    const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
    const content = current.get(path);
    if (content === undefined) return { ok: false, status: 404, headers: new Headers(), json: async () => ({ message: "Not Found" }) };
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ type: "file", content: btoa(content), sha: `sha-${path}` }) };
  }));
});

test.each([
  ["create", null, artifact.content, null],
  ["update", artifact.content, artifact.content.replace("Define the scene goal", "Reach the gate"), "write"],
  ["delete", artifact.content, null, "delete"],
] as const)("remote canonical %s persists script and ledger in one generated tree", async (_name, previous, next, expectedKind) => {
  if (previous !== null) current.set(artifact.path, previous);
  const result = await commitCanonicalScriptMutation({
    token: "token",
    book: { id: "book", owner: "owner", repo: "repo" } as any,
    branch: "main",
    expectedRemoteHeadSha: "head",
    message: "Mutate script",
    mutations: [{ path: artifact.path, content: next, expectedCurrentHash: previous === null ? null : await sha256Text(previous) }],
  });

  expect(result).toMatchObject({ changed: true, mode: "remote", commitSha: "next-head" });
  expect(result.changedPaths).toEqual([artifact.path, "state/script-ledger.md"]);
  const scriptMutation = createdTree.find((entry) => entry.path === artifact.path);
  if (expectedKind === "delete") expect(scriptMutation?.sha).toBeNull();
  else expect(scriptMutation?.content).toBe(next);
  expect(createdTree.find((entry) => entry.path === "state/script-ledger.md")?.content).toContain("# Script Ledger");
});
