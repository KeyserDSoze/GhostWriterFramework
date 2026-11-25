import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeGitServer } from "./helpers/fakeGitServer";

const github = vi.hoisted(() => ({ server: null as FakeGitServer | null }));
const hooks = vi.hoisted(() => ({ beforePush: null as null | (() => Promise<unknown>) }));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    get rest() { return github.server!.rest; }
    request = (route: string, params: Record<string, unknown>) => github.server!.request(route, params as never);
  },
}));
// The moment the race needs: the automatic sync gets the working copy between the Copilot's local commit and its own push.
vi.mock("@/repository/repositoryService", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/repository/repositoryService")>();
  return { ...original, pushLocalCommits: async (input: Parameters<typeof original.pushLocalCommits>[0]) => { await hooks.beforePush?.(); return original.pushLocalCommits(input); } };
});

import { createFakeGitServer } from "./helpers/fakeGitServer";
import { resetLocalWorkspaceIdentityForTests } from "@/account/deviceIdentity";
import { getLocalFile, getLocalRepository, getLocalRepositoryStatusSnapshot, listUnpushedLocalCommits } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { ensureLocalBookStructure } from "@/repository/repositoryService";
import { autoSyncBranch } from "@/repository/branchSync";
import { commitAndPushTextFileMutation } from "@/repository/safeRepositoryMutation";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const TOKEN = "ghp_copilot";
const PATH = "notes/gate.md";
let run = 0;

beforeEach(() => {
  run += 1;
  localStorage.clear();
  localStorage.setItem("narrarium-local-workspace-id-v1", `copilot-${run}`);
  resetLocalWorkspaceIdentityForTests();
  github.server = createFakeGitServer({ files: { "book.md": "---\ntype: book\n---\n", [PATH]: "# The gate\n" } });
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => github.server!.fetch(input)));
});
afterEach(() => { hooks.beforePush = null; vi.unstubAllGlobals(); });

it("a Copilot change that the automatic sync published in the meantime is kept, and the Copilot is told it landed", async () => {
  const identity = `workspace:copilot-${run}`;
  const book: BookEntry = { id: "book-copilot", owner: "writer", repo: "novel", name: "Novel", tokenIndex: null, bookToken: TOKEN, activeBranch: "main", addedAt: "2026-11-01T00:00:00.000Z" };
  useSettingsStore.setState({ accountIdentity: identity, accountGeneration: 0, settings: { ...DEFAULT_SETTINGS, books: [book] } });
  await ensureLocalBookStructure({ bookId: book.id, book, token: TOKEN, accountIdentity: identity, branch: "main" });
  const local = await getLocalRepository("writer", "novel", "main", captureRepositoryOperationScope());
  const before = await getLocalFile(local!.id, PATH, captureRepositoryOperationScope());
  hooks.beforePush = async () => {
    hooks.beforePush = null;
    const result = await autoSyncBranch({ bookId: book.id, owner: "writer", repo: "novel", branch: "main", accountIdentity: identity, token: TOKEN, listedHeadSha: github.server!.head("main")!, mayPush: true, mayPull: true });
    expect(result.outcome).toBe("pushed");
  };

  const applied = await commitAndPushTextFileMutation({ token: TOKEN, book, branch: "main", expectedRemoteHeadSha: local!.remoteHeadSha, message: "Apply 1 Copilot file update", mutations: [{ path: PATH, content: "# The gate\n\nIt was open.\n", expectedCurrentHash: before!.currentHash }] });

  expect(applied.commitSha).toBe(github.server!.head("main"));
  expect(github.server!.filesOf("main").get(PATH)).toBe("# The gate\n\nIt was open.\n");
  expect(github.server!.history("main")).toEqual(["Apply 1 Copilot file update", "Initial commit"]);
  expect((await getLocalFile(local!.id, PATH, captureRepositoryOperationScope()))?.text).toBe("# The gate\n\nIt was open.\n");
  expect(await listUnpushedLocalCommits(local!.id)).toEqual([]);
  expect((await getLocalRepositoryStatusSnapshot("writer", "novel", "main", identity))?.status).toMatchObject({ dirty: 0, ahead: 0 });
});
