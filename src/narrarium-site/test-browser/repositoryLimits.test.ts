import "fake-indexeddb/auto";
import { afterEach, expect, test, vi } from "vitest";
import {
  REPOSITORY_TEXT_FILE_LIMIT_BYTES,
  REPOSITORY_BINARY_FILE_LIMIT_BYTES,
  REPOSITORY_MUTATION_LIMIT_BYTES,
  RepositoryByteMeter,
  RepositoryLimitExceededError,
  assertRepositoryFileBytes,
  utf8Bytes,
} from "@/repository/repositoryLimits";
import { fetchRepositoryBlobBytes } from "@/repository/repositoryBlobTransport";
import { getLocalFile, putLocalRepository, removeLocalRepository, writeLocalTextScoped } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import { repositoryErrorDescription } from "@/repository/repositoryError";
import { loadFileContent } from "@/github/githubClient";

const identity = "google:repository-limits";
let repoId = "";
useAuthStore.setState({ user: { provider: "google", providerAccountId: "repository-limits", name: "Limits", email: "limits@example.com", picture: "" } });

afterEach(async () => {
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope()).catch(() => undefined);
  repoId = "";
});

test("counts UTF-8 bytes and accepts exactly the text limit", () => {
  expect(utf8Bytes("a€")).toBe(4);
  expect(() => assertRepositoryFileBytes("text", REPOSITORY_TEXT_FILE_LIMIT_BYTES)).not.toThrow();
  expect(() => assertRepositoryFileBytes("text", REPOSITORY_TEXT_FILE_LIMIT_BYTES + 1)).toThrow(RepositoryLimitExceededError);
});

test("bounds binary files and aggregate operations at limit plus one", () => {
  expect(() => assertRepositoryFileBytes("binary", REPOSITORY_BINARY_FILE_LIMIT_BYTES)).not.toThrow();
  expect(() => assertRepositoryFileBytes("binary", REPOSITORY_BINARY_FILE_LIMIT_BYTES + 1)).toThrow(RepositoryLimitExceededError);
  const productionMeter = new RepositoryByteMeter("mutation");
  expect(productionMeter.add("binary", REPOSITORY_MUTATION_LIMIT_BYTES, REPOSITORY_MUTATION_LIMIT_BYTES)).toBe(REPOSITORY_MUTATION_LIMIT_BYTES);
  expect(() => productionMeter.add("binary", 1, 1)).toThrow(RepositoryLimitExceededError);
  const meter = new RepositoryByteMeter("mutation", 10);
  expect(meter.add("binary", 6, 6)).toBe(6);
  expect(meter.add("binary", 4, 4)).toBe(10);
  expect(() => meter.add("binary", 1, 1)).toThrow(RepositoryLimitExceededError);
});

test("rejects oversized local text before replacing the existing edit", async () => {
  const scope = captureRepositoryOperationScope();
  const meta = await putLocalRepository({ bookId: "limits-book", owner: "owner", repo: "limits", branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), cloneComplete: true, cloneStatus: "complete" }, scope);
  repoId = meta.id;
  const atLimit = "a".repeat(REPOSITORY_TEXT_FILE_LIMIT_BYTES);
  await writeLocalTextScoped(repoId, "chapters/001/001.md", atLimit, scope);
  await expect(writeLocalTextScoped(repoId, "chapters/001/001.md", `${atLimit}b`, scope)).rejects.toBeInstanceOf(RepositoryLimitExceededError);
  expect((await getLocalFile(repoId, "chapters/001/001.md", scope))?.text).toBe(atLimit);
});

test("stops a streamed remote response even when Content-Length is absent", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("123")); controller.enqueue(new TextEncoder().encode("45")); controller.close(); } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { headers: { "content-type": "application/octet-stream" } })));
  const meter = new RepositoryByteMeter("transfer", 4);
  await expect(fetchRepositoryBlobBytes({ token: "token", owner: "owner", repo: "repo", path: "asset.bin", sha: "sha", kind: "binary", meter })).rejects.toBeInstanceOf(RepositoryLimitExceededError);
  expect(meter.measuredBytes).toBe(3);
  vi.unstubAllGlobals();
});

test("does not trust a forged low Content-Length", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("12345")); controller.close(); } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { headers: { "content-type": "application/octet-stream", "content-length": "1" } })));
  const meter = new RepositoryByteMeter("transfer", 4);
  await expect(fetchRepositoryBlobBytes({ token: "token", owner: "owner", repo: "repo", path: "asset.bin", sha: "sha", kind: "binary", meter })).rejects.toBeInstanceOf(RepositoryLimitExceededError);
  vi.unstubAllGlobals();
});

test("bounds the streamed Contents JSON envelope before parsing", async () => {
  const oversizedEnvelope = new TextEncoder().encode(`{"content":"${"a".repeat(3 * 1024 * 1024)}","sha":"sha"}`);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(oversizedEnvelope); controller.close(); } }), { headers: { "content-type": "application/json" } })));
  await expect(loadFileContent("token", "owner", "repo", "book.md", "main")).rejects.toBeInstanceOf(RepositoryLimitExceededError);
  vi.unstubAllGlobals();
});

test("reports measured and allowed sizes without exposing content", () => {
  const error = new RepositoryLimitExceededError("file", "text", 3072, 2048);
  const description = repositoryErrorDescription(error, (_key, options) => `${options?.measured}/${options?.allowed}`);
  expect(description).toBe("3.0 KiB/2.0 KiB");
  expect(description).not.toContain("manuscript");
});
