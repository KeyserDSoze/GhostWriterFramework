import { MemoryAiCallStore, type AiCallAttempt, type AiCallRecord, type AiCallTaskDraft } from "narrarium-engine";
import type { DriveCopyApi } from "@/autopilot/calls/copies/targets/drive";
import type { GitHubCopyApi } from "@/autopilot/calls/copies/targets/github";
import type { GraphCopyApi } from "@/autopilot/calls/copies/targets/onedrive";
import { CopyHttpError } from "@/autopilot/calls/copies/classify";

export const BOOK = "book-1";

export function recordOf(activityId: string, seq: number, startedAt: string, patch: Partial<AiCallRecord> = {}): AiCallRecord {
  const attempt = { index: 1, textAttempt: 1, text: { characters: 5, bytes: 5, storedBytes: 5, truncated: false }, provider: "openai", model: "gpt", integrationId: "i1", endpoint: "https://api.openai.com", stream: true, tools: false, firstByteMs: 10, durationMs: 100, outcome: "ok", finishReason: "stop", reasoningCharacters: null, usage: null, usageKnown: null, cost: null, costKnown: null, currency: null, transport: null, error: null, partialCharacters: null } as AiCallAttempt;
  return {
    formatVersion: 1, callId: `${activityId}-${String(seq).padStart(4, "0")}`, bookId: BOOK, accountScope: null, runId: "run_1", activityId, seq, stepAttempt: 1, task: "write", chapter: 1, scene: 1, label: "Write", capability: "autopilot", host: "browser",
    request: { system: { characters: 3, bytes: 3, storedBytes: 3, truncated: false }, user: { characters: 3, bytes: 3, storedBytes: 3, truncated: false }, images: 0, tool: null, toolSchemaHash: null, structured: false, maxOutputTokens: null, temperature: null },
    status: "ok", response: { text: null, partial: false }, attempts: [attempt], timing: { startedAt, firstTextAt: startedAt, endedAt: startedAt }, storedBytes: 6, dropped: null, ...patch,
  };
}

/** A finished task of one call in the store: its texts are «system of <id>», «user of <id>» and a response with a multi-byte character. */
export async function seedTask(store: MemoryAiCallStore, activityId: string, startedAt: string, patch: Partial<AiCallTaskDraft> = {}): Promise<void> {
  const record = recordOf(activityId, 1, startedAt);
  await store.saveTask({ bookId: BOOK, activityId, title: `Task ${activityId}`, kind: "write", chapter: 1, scene: null, status: "done", startedAt, endedAt: startedAt, ...patch });
  await store.begin({ record: { ...record, status: "running" }, system: `system of ${activityId}`, user: `user of ${activityId} — è` });
  await store.append(record.callId, 1, 0, `answer ${activityId} ✓`);
  await store.end(record.callId, { status: "ok", response: record.response, attempts: record.attempts, timing: record.timing, storedBytes: 6, dropped: null });
}

export function days(count: number, from = "2026-11-10"): string[] {
  const start = Date.parse(`${from}T10:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => new Date(start + index * 24 * 3600_000).toISOString());
}

function hash(bytes: Uint8Array | string): string {
  const text = typeof bytes === "string" ? bytes : Array.from(bytes).join(",");
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) value = ((value << 5) + value + text.charCodeAt(index)) | 0;
  return `${(value >>> 0).toString(16)}-${text.length}`;
}

/** A repository on GitHub, in memory: blobs, trees (full path maps) and branches whose commits chain by parent. */
export class FakeGitHub implements GitHubCopyApi {
  private = true;
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Map<string, string>>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  branches = new Map<string, string>();
  repositoryReads = 0;
  failNext: unknown = null;
  async getRepository() { this.repositoryReads += 1; return { private: this.private }; }
  async getBranchHead(branch: string) {
    const commit = this.branches.get(branch);
    return commit ? { commitSha: commit, treeSha: this.commits.get(commit)!.tree } : null;
  }
  async createBlob(bytes: Uint8Array) {
    if (this.failNext) { const error = this.failNext; this.failNext = null; throw error; }
    const sha = `blob-${hash(bytes)}`; this.blobs.set(sha, bytes); return sha;
  }
  async createTree(base: string | null, entries: Array<{ path: string; blobSha: string }>) {
    const files = new Map(base ? this.trees.get(base) : []);
    for (const entry of entries) files.set(entry.path, entry.blobSha);
    const sha = `tree-${hash(JSON.stringify([...files].sort()))}`;
    this.trees.set(sha, files);
    return sha;
  }
  async createCommit(message: string, tree: string, parents: string[]) {
    const sha = `commit-${this.commits.size + 1}-${hash(tree + parents.join())}`;
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }
  async createBranch(branch: string, commit: string) { this.branches.set(branch, commit); }
  async updateBranch(branch: string, commit: string) {
    const current = this.branches.get(branch);
    if (!current) throw new CopyHttpError(404, "no branch");
    let walk: string | undefined = commit;
    while (walk && walk !== current) walk = this.commits.get(walk)?.parents[0];
    if (!walk) throw Object.assign(new Error("Update is not a fast forward"), { status: 422 });
    this.branches.set(branch, commit);
  }
  async deleteBranch(branch: string) { this.branches.delete(branch); }
  files(branch = "narrarium-ai-calls"): Map<string, Uint8Array> {
    const head = this.branches.get(branch);
    const out = new Map<string, Uint8Array>();
    if (!head) return out;
    for (const [path, blob] of this.trees.get(this.commits.get(head)!.tree) ?? []) out.set(path, this.blobs.get(blob)!);
    return out;
  }
  commitCount(branch = "narrarium-ai-calls"): number {
    let count = 0;
    let walk = this.branches.get(branch);
    while (walk) { count += 1; walk = this.commits.get(walk)?.parents[0]; }
    return count;
  }
}

/** A Drive app-data folder, in memory: folders by path, files by folder and name. */
export class FakeDrive implements DriveCopyApi {
  folders = new Map<string, string>();
  files = new Map<string, { name: string; folderId: string; bytes: Uint8Array }>();
  uploads = 0;
  failUploadAt: number | null = null;
  failWith: unknown = new CopyHttpError(500, "Drive error");
  async session<T>(run: () => Promise<T>) { return run(); }
  async findFolder(segments: string[]) { return this.folders.get(segments.join("/")) ?? null; }
  async ensureFolder(segments: string[]) {
    for (let index = 1; index <= segments.length; index += 1) {
      const key = segments.slice(0, index).join("/");
      if (!this.folders.has(key)) this.folders.set(key, `folder-${this.folders.size + 1}`);
    }
    return this.folders.get(segments.join("/"))!;
  }
  async fileExists(folderId: string, name: string) { return [...this.files.values()].some((file) => file.folderId === folderId && file.name === name); }
  async upload(folderId: string, name: string, bytes: Uint8Array) {
    this.uploads += 1;
    if (this.failUploadAt === this.uploads) throw this.failWith;
    this.files.set(`${folderId}/${name}`, { name, folderId, bytes });
  }
  async deleteItem(id: string) {
    const path = [...this.folders].find(([, value]) => value === id)?.[0];
    if (!path) return;
    for (const [key, value] of [...this.folders]) if (key === path || key.startsWith(`${path}/`)) {
      this.folders.delete(key);
      for (const [fileKey, file] of [...this.files]) if (file.folderId === value) this.files.delete(fileKey);
    }
  }
  paths(): string[] {
    const names = new Map([...this.folders].map(([path, id]) => [id, path]));
    return [...this.files.values()].map((file) => `${names.get(file.folderId)}/${file.name}`).sort();
  }
}

/** OneDrive's app folder, in memory: files by path. */
export class FakeGraph implements GraphCopyApi {
  files = new Map<string, Uint8Array>();
  prepared = 0;
  async session<T>(run: () => Promise<T>) { return run(); }
  async ensureAppFolder() { this.prepared += 1; }
  async exists(path: string) { return this.files.has(path); }
  async put(path: string, bytes: Uint8Array) { this.files.set(path, bytes); }
  async remove(path: string) { for (const key of [...this.files.keys()]) if (key === path || key.startsWith(`${path}/`)) this.files.delete(key); }
}
