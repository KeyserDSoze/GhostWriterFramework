import "fake-indexeddb/auto";
import { afterEach, expect, test, vi } from "vitest";

const octokit = vi.hoisted(() => ({
  getRepo: vi.fn(),
  getRef: vi.fn(),
  getCommit: vi.fn(),
  getTree: vi.fn(),
  getBlob: vi.fn(),
  createBlob: vi.fn(),
  createTree: vi.fn(),
  createCommit: vi.fn(),
  updateRef: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git: octokit, repos: { get: octokit.getRepo } }; } }));
vi.mock("@/repository/repositoryBlobTransport", () => ({
  fetchRepositoryBlobBytes: vi.fn(async (input: { owner: string; repo: string; sha: string; kind: "text" | "binary"; meter: { add: (kind: "text" | "binary", size: number) => void } }) => {
    const blob = await octokit.getBlob({ owner: input.owner, repo: input.repo, file_sha: input.sha });
    const bytes = new TextEncoder().encode(decodeURIComponent(escape(atob(blob.data.content))));
    input.meter.add(input.kind, bytes.byteLength);
    return bytes;
  }),
}));

import {
  deleteLocalRecoverySnapshot,
  getLocalFile as getLocalFileScoped,
  listDirtyLocalFiles,
  listLocalRecoverySnapshots,
  listUnpushedLocalCommits,
  mutateLocalTextFilesAndCreateCommitAtomically,
  putLocalRepository,
  removeLocalRepository,
} from "@/repository/localRepository";
import { putCleanLocalFile, writeLocalText } from "./helpers/localRepositorySeed";
import { RepositorySyncConflictError, syncFullRepository } from "@/repository/repositoryService";
import { useAuthStore } from "@/store/authStore";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { annotationsChapterPath, deleteAnnotation, emptyChapterAnnotations, liveAnnotations, parseChapterAnnotations, serializeChapterAnnotations, upsertAnnotation } from "@/annotations/format";
import type { Annotation } from "@/annotations/model";

let repoId = "";
const identity = "google:sub-writer";
const target = { bookId: "book", owner: "owner", repo: "repo", branch: "main", accountIdentity: identity };
const user = { provider: "google" as const, providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" };
useAuthStore.setState({ user });
const getLocalFile = (path: string) => getLocalFileScoped(repoId, path, captureRepositoryOperationScope());
const base64 = (text: string) => btoa(unescape(encodeURIComponent(text)));

afterEach(async () => {
  vi.clearAllMocks();
  useAuthStore.setState({ user });
  if (repoId) for (const recovery of await listLocalRecoverySnapshots(repoId, identity)) await deleteLocalRecoverySnapshot(recovery.id, captureRepositoryOperationScope());
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

const CHAPTER = "001-the-gate";
const PATH = annotationsChapterPath(CHAPTER);

function annotation(id: string, patch: Partial<Annotation> = {}): Annotation {
  return {
    id, chapter: CHAPTER, paragraph: "001-opening", quote: "old steel", prefix: "the color of ", suffix: ".", offset: 40, tag: "rewrite", comment: "",
    status: "open", createdAt: "2026-11-25T10:00:00.000Z", updatedAt: "2026-11-25T10:00:00.000Z", createdOnDevice: "d-1", ...patch,
  };
}
const textOf = (...annotations: Annotation[]) => serializeChapterAnnotations(annotations.reduce(upsertAnnotation, emptyChapterAnnotations(CHAPTER)));

async function setup() {
  const meta = await putLocalRepository({ ...target, defaultBranch: "main", remoteHeadSha: "base-head", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
  repoId = meta.id;
}

function remote(files: Record<string, { sha: string; text: string }>) {
  // The head is read by the sync, again by its push, and once more after the push.
  octokit.getRef.mockResolvedValueOnce({ data: { object: { sha: "remote-head" } } }).mockResolvedValueOnce({ data: { object: { sha: "remote-head" } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `${commit_sha}-tree` } } }));
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: Object.entries(files).map(([path, file]) => ({ type: "blob", path, sha: file.sha })) } });
  octokit.getBlob.mockImplementation(async ({ file_sha }: { file_sha: string }) => {
    const file = Object.values(files).find((entry) => entry.sha === file_sha);
    return { data: { encoding: "base64", content: base64(file?.text ?? "") } };
  });
  const pushed = new Map<string, string>();
  octokit.createBlob.mockImplementation(async ({ content, encoding }: { content: string; encoding: string }) => {
    const sha = `pushed-${pushed.size}`;
    pushed.set(sha, encoding === "utf-8" ? content : decodeURIComponent(escape(atob(content))));
    return { data: { sha } };
  });
  octokit.createTree.mockResolvedValue({ data: { sha: "pushed-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "pushed-head" } });
  octokit.updateRef.mockResolvedValue({ data: {} });
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "pushed-head" } } });
  return pushed;
}

test("annotations made on two devices in the same chapter merge in the sync: no conflict, and the merge is published", async () => {
  await setup();
  const base = textOf(annotation("a-1"));
  await putCleanLocalFile({ repoId, path: PATH, kind: "text", text: base, baseSha: "annotations-base", size: base.length });
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "plot", baseSha: "plot-base", size: 4 });
  // This device: a new annotation, committed (as the reader saves it).
  const local = await getLocalFile(PATH);
  await mutateLocalTextFilesAndCreateCommitAtomically(repoId, captureRepositoryOperationScope(), "Annotate", [{ path: PATH, content: textOf(annotation("a-1"), annotation("a-2", { comment: "mine" })), expectedCurrentHash: local!.currentHash }]);
  // The other device: another annotation, and the first one marked handled later on.
  const theirs = textOf(annotation("a-1", { status: "handled", updatedAt: "2026-11-25T12:00:00.000Z" }), annotation("a-3", { comment: "theirs" }));
  const pushed = remote({ [PATH]: { sha: "annotations-remote", text: theirs }, "plot.md": { sha: "plot-base", text: "plot" } });

  const result = await syncFullRepository({ ...target, token: "token" });
  expect(result).toMatchObject({ pushed: 1 });

  const file = await getLocalFile(PATH);
  const parsed = parseChapterAnnotations(file!.text!, CHAPTER);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(liveAnnotations(parsed.file).map((entry) => [entry.id, entry.status, entry.comment])).toEqual([
    ["a-1", "handled", ""],
    ["a-2", "open", "mine"],
    ["a-3", "open", "theirs"],
  ]);
  expect(file).toMatchObject({ status: "clean", baseSha: "pushed-0" });
  expect([...pushed.values()]).toEqual([file!.text]);
  expect(octokit.createTree).toHaveBeenCalledWith(expect.objectContaining({ base_tree: "remote-head-tree", tree: [{ path: PATH, mode: "100644", type: "blob", sha: "pushed-0" }] }));
  expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
  expect(await listDirtyLocalFiles(repoId)).toEqual([]);
  // What this device had before the sync is in the recovery snapshot, as for every sync with unpublished work.
  expect((await listLocalRecoverySnapshots(repoId, identity))[0].files.find((entry) => entry.path === PATH)?.text).toContain("mine");
});

test("a deletion on one device and an edit made before it on the other: the annotation stays deleted", async () => {
  await setup();
  const base = textOf(annotation("a-1"), annotation("a-2"));
  await putCleanLocalFile({ repoId, path: PATH, kind: "text", text: base, baseSha: "annotations-base", size: base.length });
  const parsedBase = parseChapterAnnotations(base, CHAPTER);
  if (!parsedBase.ok) throw new Error(parsedBase.error);
  await writeLocalText(repoId, PATH, serializeChapterAnnotations(deleteAnnotation(parsedBase.file, "a-2", "2026-11-25T13:00:00.000Z")));
  remote({ [PATH]: { sha: "annotations-remote", text: textOf(annotation("a-1"), annotation("a-2", { comment: "edited earlier", updatedAt: "2026-11-25T12:00:00.000Z" })) } });

  await syncFullRepository({ ...target, token: "token" });
  const parsed = parseChapterAnnotations((await getLocalFile(PATH))!.text!, CHAPTER);
  expect(parsed.ok && liveAnnotations(parsed.file).map((entry) => entry.id)).toEqual(["a-1"]);
});

test("a file of annotations that cannot be read on one side is left to the author, like any other conflict", async () => {
  await setup();
  const base = textOf(annotation("a-1"));
  await putCleanLocalFile({ repoId, path: PATH, kind: "text", text: base, baseSha: "annotations-base", size: base.length });
  await writeLocalText(repoId, PATH, "annotations: [broken by hand");
  remote({ [PATH]: { sha: "annotations-remote", text: textOf(annotation("a-1"), annotation("a-9")) } });

  await expect(syncFullRepository({ ...target, token: "token" })).rejects.toBeInstanceOf(RepositorySyncConflictError);
  expect(await getLocalFile(PATH)).toMatchObject({ text: "annotations: [broken by hand", status: "modified" });
  expect(octokit.createTree).not.toHaveBeenCalled();
});

test("other files changed on both sides are still a conflict for the author", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "annotations/notes.yml", kind: "text", text: "a: 1", baseSha: "notes-base", size: 4 });
  await writeLocalText(repoId, "annotations/notes.yml", "a: 2");
  remote({ "annotations/notes.yml": { sha: "notes-remote", text: "a: 3" } });
  await expect(syncFullRepository({ ...target, token: "token" })).rejects.toBeInstanceOf(RepositorySyncConflictError);
});
