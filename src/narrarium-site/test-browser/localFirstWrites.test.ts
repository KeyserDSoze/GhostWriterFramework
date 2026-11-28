import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ai = vi.hoisted(() => ({ completeToolRouted: vi.fn() }));
vi.mock("@/assistant/router", async (importOriginal) => ({ ...await importOriginal<typeof import("@/assistant/router")>(), completeToolRouted: ai.completeToolRouted }));

import { localWorkspaceScope } from "@/account/deviceIdentity";
import { captureImmediateMutation, commitImmediateMutation } from "@/assistant/immediateMutation";
import { updateFile } from "@/github/githubClient";
import { loadAuditReport, runAudit, updateAuditFinding } from "@/narrarium/audit";
import { getLocalFile, getLocalRepositoryStatusSnapshot, listUnpushedLocalCommits } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { commitLocalChanges } from "@/repository/repositoryService";
import { commitAndPushTextFileMutation, resolveRepositoryHeadForMutation } from "@/repository/safeRepositoryMutation";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { blockNetwork, createLinkedBookClone, createLinkedBookWithoutCredential, createLocalOnlyBook, resetLocalWorkspace, type LocalFirstBook } from "./helpers/localFirst";

// Writes go to the working copy and wait there, as local commits, for the next sync: a book kept on this device never publishes, a linked book that cannot
// reach GitHub keeps the change, and nothing the author has not published yet blocks the next change.

beforeEach(async () => {
  await resetLocalWorkspace();
  ai.completeToolRouted.mockReset().mockResolvedValue({
    output: {
      findings: [{ description: "The gate is open and closed at once.", evidence: "Describe the book here.", category: "continuity", severity: "medium", certainty: "probable", structuredSourceRef: { path: "book.md" } }],
      executiveSummary: "One continuity issue.",
      recommendedFixOrder: [],
      finalAssessment: "Review the gate.",
      auditResult: "needs-review",
      missingContext: [],
    },
    metadata: { requestId: "request", task: "audit", provider: "openai", integrationId: "ai", model: "model", inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
  });
});
afterEach(() => vi.unstubAllGlobals());

/** The author saved a change and synced a book kept on this device: one local commit, which it can never push. */
async function withOneLocalCommit(local: LocalFirstBook): Promise<void> {
  const current = await getLocalFile(local.meta.id, "ideas.md", captureRepositoryOperationScope());
  await updateFile(local.token, local.book.owner, local.book.repo, local.branch, "ideas.md", current!.currentHash, `${current!.text}\n- A gate.\n`, "Edit ideas");
  await commitLocalChanges({ bookId: local.book.id, owner: local.book.owner, repo: local.book.repo, branch: local.branch, accountIdentity: localWorkspaceScope() }, "Save local book changes");
}

describe("an audit of a book kept on this device", () => {
  it("runs, saves and updates its report in the working copy, next to a local commit, without GitHub", async () => {
    const network = blockNetwork();
    const local = await createLocalOnlyBook();
    await withOneLocalCommit(local);
    const target = { scope: "book" as const, bookId: local.book.id };

    const report = await runAudit({ accountScope: localWorkspaceScope(), token: local.token, book: local.book, branch: local.branch, structure: local.structure, settings: DEFAULT_SETTINGS, target });
    expect(report.findings).toHaveLength(1);
    const loaded = await loadAuditReport({ token: local.token, book: local.book, branch: local.branch, structure: local.structure, target });
    expect(loaded?.findings.map((finding) => finding.id)).toEqual(report.findings.map((finding) => finding.id));

    const updated = await updateAuditFinding({ token: local.token, book: local.book, branch: local.branch, structure: local.structure, target, findingId: report.findings[0].id, status: "resolved", authorNote: "Fixed in chapter two." });
    expect(updated.findings[0]).toMatchObject({ status: "resolved", authorNote: "Fixed in chapter two." });

    // The report is a file of the book like any other: it waits in the one local commit the topbar counts.
    const status = await getLocalRepositoryStatusSnapshot(local.book.owner, local.book.repo, local.branch, localWorkspaceScope());
    expect(status?.status).toMatchObject({ ahead: 1, dirty: 0 });
    const [commit] = await listUnpushedLocalCommits(local.meta.id);
    expect(commit.files.map((file) => file.path)).toEqual(expect.arrayContaining(["audit/book.md", "ideas.md"]));
    expect(network.requests).toEqual([]);
  });

  it("starts a change while other edits are not committed yet", async () => {
    const network = blockNetwork();
    const local = await createLocalOnlyBook();
    const current = await getLocalFile(local.meta.id, "ideas.md", captureRepositoryOperationScope());
    await updateFile(local.token, local.book.owner, local.book.repo, local.branch, "ideas.md", current!.currentHash, "dirty", "Edit ideas");

    const head = await resolveRepositoryHeadForMutation({ token: local.token, book: local.book, branch: local.branch });
    expect(head).toBe(local.meta.remoteHeadSha);
    const snapshot = await captureImmediateMutation({ token: local.token, book: local.book, branch: local.branch, path: "plot.md" });
    await commitImmediateMutation({ token: local.token, book: local.book, branch: local.branch, snapshot, content: "# Plot\n", message: "Update plot.md" });
    expect((await getLocalFile(local.meta.id, "plot.md", captureRepositoryOperationScope()))?.text).toBe("# Plot\n");
    expect(network.requests).toEqual([]);
  });
});

describe("a change the Copilot applies", () => {
  it("stays a local commit in a book that has no remote", async () => {
    const network = blockNetwork();
    const local = await createLocalOnlyBook();
    await withOneLocalCommit(local);

    const result = await commitAndPushTextFileMutation({ token: local.token, book: local.book, branch: local.branch, expectedRemoteHeadSha: local.meta.remoteHeadSha, message: "Apply 1 Copilot file update", mutations: [{ path: "notes/gate.md", content: "# The gate\n", expectedCurrentHash: null }] });

    expect(result.mode).toBe("local");
    expect((await getLocalFile(local.meta.id, "notes/gate.md", captureRepositoryOperationScope()))?.text).toBe("# The gate\n");
    expect((await listUnpushedLocalCommits(local.meta.id))[0].files.map((file) => file.path)).toEqual(expect.arrayContaining(["ideas.md", "notes/gate.md"]));
    expect(network.requests).toEqual([]);
  });

  it("waits for the next sync while the browser is offline", async () => {
    const network = blockNetwork();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const linked = await createLinkedBookClone({ token: "ghp_real_token", files: [{ path: "book.md", content: "# Book\n" }] });
    const before = await getLocalFile(linked.meta.id, "book.md", captureRepositoryOperationScope());

    const result = await commitAndPushTextFileMutation({ token: linked.token, book: linked.book, branch: linked.branch, expectedRemoteHeadSha: "remote-head", message: "Apply 1 Copilot file update", mutations: [{ path: "book.md", content: "# Book, revised\n", expectedCurrentHash: before!.currentHash }] });

    expect(result.mode).toBe("local");
    expect(await listUnpushedLocalCommits(linked.meta.id)).toHaveLength(1);
    expect(network.requests).toEqual([]);
  });

  it("keeps the change when GitHub cannot be reached, for the next sync", async () => {
    const network = blockNetwork();
    const linked = await createLinkedBookClone({ token: "ghp_real_token", files: [{ path: "book.md", content: "# Book\n" }] });
    const before = await getLocalFile(linked.meta.id, "book.md", captureRepositoryOperationScope());

    const result = await commitAndPushTextFileMutation({ token: linked.token, book: linked.book, branch: linked.branch, expectedRemoteHeadSha: "remote-head", message: "Apply 1 Copilot file update", mutations: [{ path: "book.md", content: "# Book, revised\n", expectedCurrentHash: before!.currentHash }] });

    expect(result.mode).toBe("local");
    expect(network.github().length).toBeGreaterThan(0);
    expect((await getLocalFile(linked.meta.id, "book.md", captureRepositoryOperationScope()))?.text).toBe("# Book, revised\n");
    expect((await getLocalRepositoryStatusSnapshot(linked.book.owner, linked.book.repo, linked.branch, localWorkspaceScope()))?.status.ahead).toBe(1);
  });

  it("applies it together with edits the author has not committed, and keeps everything on this device while GitHub cannot be reached", async () => {
    const network = blockNetwork();
    const linked = await createLinkedBookClone({ token: "ghp_real_token", files: [{ path: "book.md", content: "# Book\n" }, { path: "plot.md", content: "# Plot\n" }] });
    const plot = await getLocalFile(linked.meta.id, "plot.md", captureRepositoryOperationScope());
    await updateFile(linked.token, linked.book.owner, linked.book.repo, linked.branch, "plot.md", plot!.currentHash, "# Plot, edited\n", "Edit plot");
    const book = await getLocalFile(linked.meta.id, "book.md", captureRepositoryOperationScope());

    const result = await commitAndPushTextFileMutation({ token: linked.token, book: linked.book, branch: linked.branch, expectedRemoteHeadSha: "remote-head", message: "Apply 1 Copilot file update", mutations: [{ path: "book.md", content: "# Book, revised\n", expectedCurrentHash: book!.currentHash }] });

    // Not a refusal («The local working copy must be clean…», issue #124): applied, saved here, and the sync that tried to send it found no GitHub.
    expect(result.delivery).toEqual({ kind: "saved", reason: "unreachable", earlier: 1 });
    expect((await getLocalFile(linked.meta.id, "book.md", captureRepositoryOperationScope()))?.text).toBe("# Book, revised\n");
    expect((await getLocalFile(linked.meta.id, "plot.md", captureRepositoryOperationScope()))?.text).toBe("# Plot, edited\n");
    expect(network.github().length).toBeGreaterThan(0);
  });
});

describe("a GitHub book without a credential", () => {
  const files = [
    { path: "book.md", content: "---\ntype: book\nid: book\ntitle: Linked\n---\n\nDescribe the book here.\n" },
    { path: "ideas.md", content: "# Ideas\n" },
  ];

  it("runs, saves and updates an audit in the working copy, next to a local commit, without GitHub", async () => {
    const network = blockNetwork();
    const linked = await createLinkedBookWithoutCredential({ files });
    await withOneLocalCommit(linked);
    const target = { scope: "book" as const, bookId: linked.book.id };

    const report = await runAudit({ accountScope: localWorkspaceScope(), token: linked.token, book: linked.book, branch: linked.branch, structure: linked.structure, settings: DEFAULT_SETTINGS, target });
    const updated = await updateAuditFinding({ token: linked.token, book: linked.book, branch: linked.branch, structure: linked.structure, target, findingId: report.findings[0].id, status: "resolved", authorNote: "Fixed." });

    expect(updated.findings[0]).toMatchObject({ status: "resolved", authorNote: "Fixed." });
    // Saved as the local commits a sync publishes once GitHub is connected.
    expect((await getLocalRepositoryStatusSnapshot(linked.book.owner, linked.book.repo, linked.branch, localWorkspaceScope()))?.status).toMatchObject({ ahead: 1, dirty: 0 });
    expect((await listUnpushedLocalCommits(linked.meta.id))[0].files.map((file) => file.path)).toEqual(expect.arrayContaining(["audit/book.md", "ideas.md"]));
    expect(network.requests).toEqual([]);
  });

  it("keeps a change the Copilot applies as a local commit, next to the ones before", async () => {
    const network = blockNetwork();
    const linked = await createLinkedBookWithoutCredential({ files });
    await withOneLocalCommit(linked);

    const result = await commitAndPushTextFileMutation({ token: linked.token, book: linked.book, branch: linked.branch, expectedRemoteHeadSha: "remote-head", message: "Apply 1 Copilot file update", mutations: [{ path: "notes/gate.md", content: "# The gate\n", expectedCurrentHash: null }] });

    expect(result.mode).toBe("local");
    expect((await getLocalFile(linked.meta.id, "notes/gate.md", captureRepositoryOperationScope()))?.text).toBe("# The gate\n");
    expect((await listUnpushedLocalCommits(linked.meta.id))[0].files.map((file) => file.path)).toEqual(expect.arrayContaining(["ideas.md", "notes/gate.md"]));
    expect(network.requests).toEqual([]);
  });
});

describe("a credential GitHub refuses (revoked, expired)", () => {
  it("keeps the change of the Copilot as a local commit, and the next change is not sent to GitHub at all", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, headers: { "content-type": "application/json" } });
    }));
    const linked = await createLinkedBookClone({ token: "ghp_revoked_for_copilot", files: [{ path: "book.md", content: "# Book\n" }] });
    const before = await getLocalFile(linked.meta.id, "book.md", captureRepositoryOperationScope());

    const first = await commitAndPushTextFileMutation({ token: linked.token, book: linked.book, branch: linked.branch, expectedRemoteHeadSha: "remote-head", message: "Apply 1 Copilot file update", mutations: [{ path: "book.md", content: "# Book, revised\n", expectedCurrentHash: before!.currentHash }] });
    expect(first.mode).toBe("local");
    expect((await getLocalFile(linked.meta.id, "book.md", captureRepositoryOperationScope()))?.text).toBe("# Book, revised\n");
    const refused = requests.length;
    expect(refused).toBeGreaterThan(0);

    const second = await commitAndPushTextFileMutation({ token: linked.token, book: linked.book, branch: linked.branch, expectedRemoteHeadSha: "remote-head", message: "Apply 1 Copilot file update", mutations: [{ path: "notes/gate.md", content: "# The gate\n", expectedCurrentHash: null }] });
    expect(second.mode).toBe("local");
    // Both wait in the local commit of the book, for the sync once GitHub accepts a credential.
    expect((await listUnpushedLocalCommits(linked.meta.id))[0].files.map((file) => file.path)).toEqual(expect.arrayContaining(["book.md", "notes/gate.md"]));
    expect(requests).toHaveLength(refused);
  });
});
