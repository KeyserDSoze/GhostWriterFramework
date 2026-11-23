import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAiCallStore, AI_CALLS_FORMAT_VERSION } from "narrarium-engine";
import { CallsCopier } from "@/autopilot/calls/copies/copier";
import { classifyCopyFailure, CopyHttpError } from "@/autopilot/calls/copies/classify";
import { decodeTaskFile, encodeTaskFile, gunzipBytes, parseTaskFileText, readTaskForCopy, taskDayOf, taskFilePath, taskFileText } from "@/autopilot/calls/copies/format";
import { MemoryCopyLedger, MemoryCopyOutbox, LocalStorageCopyLedger } from "@/autopilot/calls/copies/stores";
import { startCopyScheduler } from "@/autopilot/calls/copies/scheduler";
import { DriveCopyTarget } from "@/autopilot/calls/copies/targets/drive";
import { GitHubCopyTarget } from "@/autopilot/calls/copies/targets/github";
import { OneDriveCopyTarget } from "@/autopilot/calls/copies/targets/onedrive";
import { COPY_LIMITS, CopyError, type CopyTarget, type CopyTargetKind } from "@/autopilot/calls/copies/types";
import { AccountCredentialError } from "@/account/connectionStore";
import { BOOK, FakeDrive, FakeGitHub, FakeGraph, days, seedTask } from "./aiCallCopiesKit";

const SCOPE_A = "google:account-a";
const decoder = new TextDecoder();

interface Rig {
  store: MemoryAiCallStore;
  outbox: MemoryCopyOutbox;
  ledger: MemoryCopyLedger;
  github: FakeGitHub;
  drive: FakeDrive;
  graph: FakeGraph;
  copier: CallsCopier;
  state: { scope: string | null; online: boolean; now: number; openFailure: unknown };
}

function rig(): Rig {
  const store = new MemoryAiCallStore();
  const outbox = new MemoryCopyOutbox();
  const ledger = new MemoryCopyLedger();
  const github = new FakeGitHub();
  const drive = new FakeDrive();
  const graph = new FakeGraph();
  const state = { scope: SCOPE_A as string | null, online: true, now: Date.parse("2026-11-23T10:00:00.000Z"), openFailure: null as unknown };
  const openTarget = async (bookId: string, kind: CopyTargetKind): Promise<CopyTarget> => {
    if (state.openFailure) throw state.openFailure;
    return kind === "github" ? new GitHubCopyTarget(github) : kind === "google-drive" ? new DriveCopyTarget(drive, bookId) : new OneDriveCopyTarget(graph, bookId);
  };
  const copier = new CallsCopier({ store: () => store, outbox, ledger, scope: () => state.scope, openTarget, now: () => state.now, online: () => state.online });
  return { store, outbox, ledger, github, drive, graph, copier, state };
}

let r: Rig;
const limits = JSON.parse(JSON.stringify(COPY_LIMITS)) as typeof COPY_LIMITS;
beforeEach(() => { r = rig(); });
afterEach(() => { for (const kind of Object.keys(limits) as CopyTargetKind[]) Object.assign(COPY_LIMITS[kind], limits[kind]); });

async function seed(count: number, from?: string) {
  const starts = days(count, from);
  for (let index = 0; index < count; index += 1) await seedTask(r.store, `activity_${String(index + 1).padStart(2, "0")}`, starts[index]);
}

describe("the file of a task", () => {
  it("is written and read back with every text of the task, in any language", async () => {
    await seedTask(r.store, "activity_1", "2026-11-20T10:05:09.000Z");
    const built = (await readTaskForCopy(r.store, BOOK, "activity_1"))!;
    const bytes = await encodeTaskFile(built);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1f, 0x8b]);
    const read = await decodeTaskFile(bytes);
    expect(read.formatVersion).toBe(AI_CALLS_FORMAT_VERSION);
    expect(read.newer).toBe(false);
    expect(read.header).toMatchObject({ bookId: BOOK, activityId: "activity_1", title: "Task activity_1", status: "done" });
    expect(read.calls).toHaveLength(1);
    expect(read.calls[0].record.callId).toBe("activity_1-0001");
    expect(read.calls[0].system).toBe("system of activity_1");
    expect(read.calls[0].user).toBe("user of activity_1 — è");
    expect(read.calls[0].responses).toEqual([{ attempt: 1, text: "answer activity_1 ✓" }]);
  });

  it("is NDJSON: one task line and then one line per call, readable without the app", async () => {
    await seedTask(r.store, "activity_1", "2026-11-20T10:05:09.000Z");
    const built = (await readTaskForCopy(r.store, BOOK, "activity_1"))!;
    const lines = decoder.decode(await gunzipBytes(await encodeTaskFile(built))).trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(["task", "call"]);
    expect(lines[0]).toMatchObject({ type: "task", formatVersion: 1, header: { activityId: "activity_1" } });
    expect(Object.keys(lines[1]).sort()).toEqual(["record", "responses", "system", "type", "user"]);
  });

  it("has the same name wherever it is copied, from the task alone, and the same bytes when written twice", async () => {
    await seedTask(r.store, "activity_9", "2026-11-20T10:05:09.000Z");
    const built = (await readTaskForCopy(r.store, BOOK, "activity_9"))!;
    expect(taskFilePath(built.header)).toBe("2026/11/20/100509-activity_9.ndjson.gz");
    expect(taskDayOf("2026-01-02T23:59:59.000Z")).toBe("2026/01/02");
    expect(await encodeTaskFile(built)).toEqual(await encodeTaskFile(built));
  });

  it("is read tolerantly: unknown lines are skipped, a newer version is kept and flagged, and a file that is not a task is refused", async () => {
    const text = `${JSON.stringify({ type: "task", formatVersion: 99, header: { activityId: "a" } })}\n${JSON.stringify({ type: "mystery" })}\n${JSON.stringify({ type: "call", record: { callId: "a-0001" }, system: "s", user: "u", responses: [{ attempt: 2, text: "t" }, { attempt: "x" }] })}\n`;
    const read = parseTaskFileText(text);
    expect(read.newer).toBe(true);
    expect(read.calls).toEqual([{ record: { callId: "a-0001" }, system: "s", user: "u", responses: [{ attempt: 2, text: "t" }] }]);
    expect(() => parseTaskFileText(`${JSON.stringify({ type: "call" })}\n`)).toThrow(/not a task file/);
    expect(taskFileText({ header: read.header, calls: [] }).endsWith("\n")).toBe(true);
  });

  it("is not made for a task that is still running", async () => {
    await seedTask(r.store, "activity_1", "2026-11-20T10:00:00.000Z", { status: "running", endedAt: null });
    expect(await readTaskForCopy(r.store, BOOK, "activity_1")).toBeNull();
  });
});

describe("copying to each target", () => {
  it("GitHub: a dedicated orphan branch, files under calls/, one commit per batch, readable back", async () => {
    await seed(3);
    await r.copier.scan(BOOK, "github");
    await r.copier.run(BOOK, "github");

    const files = r.github.files();
    expect([...files.keys()].sort()).toEqual([
      "calls/2026/11/10/100000-activity_01.ndjson.gz",
      "calls/2026/11/11/100000-activity_02.ndjson.gz",
      "calls/2026/11/12/100000-activity_03.ndjson.gz",
    ]);
    expect(r.github.commitCount()).toBe(1);
    const first = r.github.commits.get(r.github.branches.get("narrarium-ai-calls")!)!;
    expect(first.parents).toEqual([]);
    expect(first.message).toBe("AI calls: 3 tasks");
    expect([...r.github.branches.keys()]).toEqual(["narrarium-ai-calls"]);
    const back = await decodeTaskFile(files.get("calls/2026/11/11/100000-activity_02.ndjson.gz")!);
    expect(back.calls[0].responses[0].text).toBe("answer activity_02 ✓");
    expect(await r.outbox.list()).toEqual([]);
    const status = await r.copier.status(BOOK, "github");
    expect(status).toMatchObject({ waiting: 0, error: null, copiedTasks: 3, warning: null, copiedUpTo: "2026-11-12T10:00:00.000Z", capBytes: 512 * 1024 * 1024 });
    expect(status.bytes).toBeGreaterThan(0);
  });

  it("GitHub: the next batch is a new commit over the same branch, never a rewrite", async () => {
    await seed(2);
    await r.copier.scan(BOOK, "github");
    await r.copier.run(BOOK, "github");
    await seedTask(r.store, "activity_99", "2026-11-20T10:00:00.000Z");
    await r.copier.scan(BOOK, "github");
    await r.copier.run(BOOK, "github");
    expect(r.github.commitCount()).toBe(2);
    expect(r.github.files().size).toBe(3);
  });

  it("GitHub: a large batch is split into several commits", async () => {
    await seed(45);
    await r.copier.scan(BOOK, "github");
    await r.copier.run(BOOK, "github");
    expect(r.github.files().size).toBe(45);
    expect(r.github.commitCount()).toBe(2);
  });

  it("Google Drive: ai-calls/<book>/YYYY/MM/DD/<file> in the app-data folder", async () => {
    await seed(2);
    await r.copier.scan(BOOK, "google-drive");
    await r.copier.run(BOOK, "google-drive");
    expect(r.drive.paths()).toEqual([
      `ai-calls/${BOOK}/2026/11/10/100000-activity_01.ndjson.gz`,
      `ai-calls/${BOOK}/2026/11/11/100000-activity_02.ndjson.gz`,
    ]);
    expect(await r.outbox.list()).toEqual([]);
  });

  it("OneDrive: Apps/Narrarium/ai-calls/<book>/YYYY/MM/DD/<file>, after the app folder and its marker are made", async () => {
    await seed(2);
    await r.copier.scan(BOOK, "onedrive");
    await r.copier.run(BOOK, "onedrive");
    expect([...r.graph.files.keys()].sort()).toEqual([
      `Apps/Narrarium/ai-calls/${BOOK}/2026/11/10/100000-activity_01.ndjson.gz`,
      `Apps/Narrarium/ai-calls/${BOOK}/2026/11/11/100000-activity_02.ndjson.gz`,
    ]);
    expect(r.graph.prepared).toBeGreaterThan(0);
  });

  it("only finished tasks are copied, and a task pruned from the store is dropped from the outbox", async () => {
    await seedTask(r.store, "activity_done", "2026-11-20T10:00:00.000Z");
    await seedTask(r.store, "activity_live", "2026-11-21T10:00:00.000Z", { status: "running", endedAt: null });
    expect(await r.copier.scan(BOOK, "google-drive")).toBe(1);
    await r.outbox.put({ bookId: BOOK, taskId: "activity_gone", target: "google-drive", attempts: 0, nextAt: 0, error: null, scope: SCOPE_A });
    await r.copier.run(BOOK, "google-drive");
    expect(r.drive.paths()).toHaveLength(1);
    expect(await r.outbox.list()).toEqual([]);
  });
});

describe("idempotence", () => {
  it("a task already copied is never copied twice: not by a second run, a second scan or an enqueue", async () => {
    await seed(2);
    await r.copier.scan(BOOK, "google-drive");
    await r.copier.run(BOOK, "google-drive");
    expect(r.drive.uploads).toBe(2);
    expect(await r.copier.scan(BOOK, "google-drive")).toBe(0);
    await r.copier.enqueue(BOOK, "google-drive", "activity_01");
    expect(await r.outbox.list()).toEqual([]);
    await r.copier.run(BOOK, "google-drive");
    expect(r.drive.uploads).toBe(2);
  });

  it("when the ledger is lost the name still says it is there: Drive and OneDrive skip it, and GitHub's tree does not change", async () => {
    await seed(2);
    for (const kind of ["google-drive", "onedrive", "github"] as const) {
      await r.copier.scan(BOOK, kind);
      await r.copier.run(BOOK, kind);
      await r.ledger.clear(BOOK, kind, SCOPE_A);
      await r.copier.scan(BOOK, kind);
      await r.copier.run(BOOK, kind);
    }
    expect(r.drive.uploads).toBe(2);
    expect(r.graph.files.size).toBe(2);
    expect(r.github.commitCount()).toBe(1);
  });
});

describe("offline, tokens and retries", () => {
  it("waits while offline, says how many tasks wait, and copies them when the device is back", async () => {
    await seed(3);
    await r.copier.scan(BOOK, "google-drive");
    r.state.online = false;
    await r.copier.run(BOOK, "google-drive");
    expect(r.drive.uploads).toBe(0);
    expect(await r.copier.status(BOOK, "google-drive")).toMatchObject({ waiting: 3, offline: true });
    r.state.online = true;
    await r.copier.run(BOOK, "google-drive");
    expect(r.drive.uploads).toBe(3);
    expect(await r.copier.status(BOOK, "google-drive")).toMatchObject({ waiting: 0, offline: false });
  });

  it("a network failure queues the tasks with a growing wait, and a forced run (back online) does not wait", async () => {
    await seed(2);
    await r.copier.scan(BOOK, "google-drive");
    r.drive.failUploadAt = 1;
    r.drive.failWith = new TypeError("Failed to fetch");
    await r.copier.run(BOOK, "google-drive");
    let items = await r.outbox.list();
    expect(items.map((item) => [item.attempts, item.error])).toEqual([[1, "offline"], [1, "offline"]]);
    expect(items[0].nextAt).toBe(r.state.now + 30_000);

    await r.copier.run(BOOK, "google-drive");
    expect(r.drive.uploads).toBe(1);
    r.drive.failUploadAt = 2;
    await r.copier.run(BOOK, "google-drive", { force: true });
    items = await r.outbox.list();
    expect(items.map((item) => item.attempts)).toEqual([2, 2]);
    expect(items[0].nextAt).toBe(r.state.now + 60_000);

    r.drive.failUploadAt = null;
    await r.copier.run(BOOK, "google-drive", { force: true });
    expect(await r.outbox.list()).toEqual([]);
    expect(r.drive.paths()).toHaveLength(2);
  });

  it("a sign-in that must be renewed holds the tasks as «reconnect», and they go on once the token is renewed", async () => {
    await seed(2);
    await r.copier.scan(BOOK, "onedrive");
    r.state.openFailure = Object.assign(new Error("timed_out: See https://aka.ms/msal.js.errors#timed_out for details"), { errorCode: "timed_out" });
    await r.copier.run(BOOK, "onedrive");
    expect(await r.copier.status(BOOK, "onedrive")).toMatchObject({ waiting: 2, error: "reconnect" });
    expect(r.graph.files.size).toBe(0);

    r.state.openFailure = null;
    await r.copier.run(BOOK, "onedrive");
    expect(r.graph.files.size).toBe(0);
    await r.copier.run(BOOK, "onedrive", { force: true });
    expect(r.graph.files.size).toBe(2);
    expect(await r.copier.status(BOOK, "onedrive")).toMatchObject({ waiting: 0, error: null });
  });

  it("the wait grows up to an hour and respects what the service asked", async () => {
    await seed(1);
    await r.copier.scan(BOOK, "github");
    r.github.failNext = Object.assign(new Error("API rate limit exceeded"), { status: 429, response: { headers: { "retry-after": "120" } } });
    r.github.failNext = new CopyHttpError(429, "slow down", 120_000);
    await r.copier.run(BOOK, "github");
    const [item] = await r.outbox.list();
    expect(item.error).toBe("rate-limited");
    expect(item.nextAt).toBe(r.state.now + 120_000);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      r.github.failNext = new CopyHttpError(500, "boom");
      await r.copier.run(BOOK, "github", { force: true });
    }
    expect((await r.outbox.list())[0].nextAt).toBe(r.state.now + 3_600_000);
  });

  it("a failing store never raises into the caller", async () => {
    await seed(1);
    await r.copier.scan(BOOK, "google-drive");
    r.store.readTask = async () => { throw new Error("IndexedDB is unavailable"); };
    await expect(r.copier.run(BOOK, "google-drive")).resolves.toBeUndefined();
    expect((await r.outbox.list())[0]).toMatchObject({ attempts: 1, error: "failed" });
  });
});

describe("a public repository", () => {
  it("is refused before anything is written, said as such, and nothing is created", async () => {
    await seed(2);
    r.github.private = false;
    await r.copier.scan(BOOK, "github");
    await r.copier.run(BOOK, "github");
    expect(r.github.branches.size).toBe(0);
    expect(r.github.blobs.size).toBe(0);
    expect(await r.copier.status(BOOK, "github")).toMatchObject({ waiting: 2, error: "public-repository" });
    expect(await r.copier.check(BOOK, "github")).toBe("public-repository");
  });

  it("is looked at again on each batch: one made public in between stops the next commit", async () => {
    await seed(45);
    await r.copier.scan(BOOK, "github");
    const original = r.github.createCommit.bind(r.github);
    r.github.createCommit = async (...args) => { const sha = await original(...args); r.github.private = false; return sha; };
    await r.copier.run(BOOK, "github");
    expect(r.github.commitCount()).toBe(1);
    expect(r.github.files().size).toBe(25);
    expect(await r.copier.status(BOOK, "github")).toMatchObject({ waiting: 20, error: "public-repository" });
  });

  it("copies resume once the repository is private again", async () => {
    await seed(1);
    r.github.private = false;
    await r.copier.scan(BOOK, "github");
    await r.copier.run(BOOK, "github");
    r.github.private = true;
    await r.copier.run(BOOK, "github", { force: true });
    expect(r.github.files().size).toBe(1);
  });
});

describe("the archive cap", () => {
  it("Drive: the oldest day-folders are deleted first to make room, and a deleted task is not copied again", async () => {
    await seed(4);
    await r.copier.scan(BOOK, "google-drive");
    await r.copier.run(BOOK, "google-drive");
    const first = await r.copier.status(BOOK, "google-drive");
    const perTask = Math.round(first.bytes / 4);
    COPY_LIMITS["google-drive"].archiveBytes = perTask * 5;
    await seedTask(r.store, "activity_a", "2026-11-20T10:00:00.000Z");
    await seedTask(r.store, "activity_b", "2026-11-21T10:00:00.000Z");
    await r.copier.scan(BOOK, "google-drive");
    await r.copier.run(BOOK, "google-drive");

    const paths = r.drive.paths();
    expect(paths.some((path) => path.includes("2026/11/10"))).toBe(false);
    expect(paths.some((path) => path.includes("2026/11/21"))).toBe(true);
    const status = await r.copier.status(BOOK, "google-drive");
    expect(status.trimmedDays).toBeGreaterThanOrEqual(1);
    expect(status.bytes).toBeLessThanOrEqual(perTask * 5 + 200);
    expect(await r.copier.scan(BOOK, "google-drive")).toBe(0);
  });

  it("OneDrive trims the same way", async () => {
    await seed(3);
    await r.copier.scan(BOOK, "onedrive");
    await r.copier.run(BOOK, "onedrive");
    const perTask = Math.round((await r.copier.status(BOOK, "onedrive")).bytes / 3);
    COPY_LIMITS.onedrive.archiveBytes = perTask * 3;
    await seedTask(r.store, "activity_new", "2026-11-22T10:00:00.000Z");
    await r.copier.scan(BOOK, "onedrive");
    await r.copier.run(BOOK, "onedrive");
    expect([...r.graph.files.keys()].some((path) => path.includes("2026/11/10"))).toBe(false);
    expect([...r.graph.files.keys()].some((path) => path.includes("2026/11/22"))).toBe(true);
  });

  it("GitHub: a full archive stops copying with a warning, and history is never rewritten", async () => {
    await seed(2);
    await r.copier.scan(BOOK, "github");
    await r.copier.run(BOOK, "github");
    const head = r.github.branches.get("narrarium-ai-calls");
    COPY_LIMITS.github.archiveBytes = (await r.copier.status(BOOK, "github")).bytes + 10;
    await seedTask(r.store, "activity_late", "2026-11-22T10:00:00.000Z");
    await r.copier.scan(BOOK, "github");
    await r.copier.run(BOOK, "github");

    expect(r.github.branches.get("narrarium-ai-calls")).toBe(head);
    expect(r.github.files().size).toBe(2);
    expect(await r.outbox.list()).toEqual([]);
    expect(await r.copier.status(BOOK, "github")).toMatchObject({ warning: "archive-full", waiting: 0 });
    await seedTask(r.store, "activity_later", "2026-11-23T10:00:00.000Z");
    expect(await r.copier.scan(BOOK, "github")).toBe(0);
    await r.copier.enqueue(BOOK, "github", "activity_later");
    expect(await r.outbox.list()).toEqual([]);
  });

  it("a task over the file limit of the target is skipped, once, and the rest is copied", async () => {
    await seed(2);
    COPY_LIMITS["google-drive"].maxFileBytes = 1;
    await r.copier.scan(BOOK, "google-drive");
    await r.copier.run(BOOK, "google-drive");
    expect(r.drive.uploads).toBe(0);
    expect(await r.outbox.list()).toEqual([]);
    expect(await r.copier.scan(BOOK, "google-drive")).toBe(0);
  });
});

describe("the account fence", () => {
  it("drops what was queued under another account, never copying it", async () => {
    await seed(2);
    await r.copier.scan(BOOK, "google-drive");
    r.state.scope = "google:account-b";
    await r.copier.run(BOOK, "google-drive");
    expect(r.drive.uploads).toBe(0);
    expect(await r.outbox.list()).toEqual([]);
    expect(await r.copier.status(BOOK, "google-drive")).toMatchObject({ waiting: 0, copiedTasks: 0 });
  });

  it("keeps a ledger for each account, so another account's copies are not taken for its own", async () => {
    await seed(1);
    await r.copier.scan(BOOK, "google-drive");
    await r.copier.run(BOOK, "google-drive");
    r.state.scope = "google:account-b";
    expect(await r.copier.scan(BOOK, "google-drive")).toBe(1);
  });

  it("stops writing when the account changes in the middle of a run", async () => {
    await seed(45);
    await r.copier.scan(BOOK, "github");
    const original = r.github.createCommit.bind(r.github);
    r.github.createCommit = async (...args) => { const sha = await original(...args); r.state.scope = "google:account-b"; return sha; };
    await r.copier.run(BOOK, "github");
    expect(r.github.commitCount()).toBe(1);
    expect(await r.outbox.list()).toEqual([]);
  });
});

describe("a target that fails in the middle of a batch", () => {
  it("keeps what landed, queues the rest with the failure, and finishes without duplicates on the retry", async () => {
    await seed(5);
    await r.copier.scan(BOOK, "google-drive");
    r.drive.failUploadAt = 3;
    await r.copier.run(BOOK, "google-drive");
    expect(r.drive.paths()).toHaveLength(2);
    const waiting = await r.outbox.list();
    expect(waiting).toHaveLength(3);
    expect(waiting.every((item) => item.error === "failed" && item.attempts === 1)).toBe(true);
    expect(await r.copier.status(BOOK, "google-drive")).toMatchObject({ copiedTasks: 2, waiting: 3, error: "failed" });

    r.drive.failUploadAt = null;
    await r.copier.run(BOOK, "google-drive", { force: true });
    expect(r.drive.paths()).toHaveLength(5);
    expect(new Set(r.drive.paths()).size).toBe(5);
    expect(await r.outbox.list()).toEqual([]);
  });

  it("GitHub writes a batch as one commit: all of it or none", async () => {
    await seed(3);
    await r.copier.scan(BOOK, "github");
    r.github.failNext = new CopyHttpError(502, "bad gateway");
    await r.copier.run(BOOK, "github");
    expect(r.github.branches.size).toBe(0);
    expect(await r.outbox.list()).toHaveLength(3);
    await r.copier.run(BOOK, "github", { force: true });
    expect(r.github.files().size).toBe(3);
  });
});

describe("deleting the copies", () => {
  it("removes the archive from the target and forgets it, and nothing else is touched", async () => {
    await seed(2);
    await r.copier.scan(BOOK, "google-drive");
    await r.copier.run(BOOK, "google-drive");
    await r.copier.scan(BOOK, "github");
    await r.copier.run(BOOK, "github");
    await r.copier.deleteCopies(BOOK, "google-drive");
    expect(r.drive.paths()).toEqual([]);
    expect(await r.copier.status(BOOK, "google-drive")).toMatchObject({ copiedTasks: 0, bytes: 0, waiting: 0 });
    expect(r.github.files().size).toBe(2);
    expect(r.github.branches.size).toBe(1);
    await r.copier.deleteCopies(BOOK, "github");
    expect(r.github.branches.size).toBe(0);
  });

  it("forgetting a target (the author chose another) empties its outbox but leaves the copies where they are", async () => {
    await seed(2);
    await r.copier.scan(BOOK, "onedrive");
    await r.copier.forget(BOOK, "onedrive");
    expect(await r.outbox.list()).toEqual([]);
  });
});

describe("classifying a failure", () => {
  it.each([
    [new AccountCredentialError("onedrive", "expired", "timed_out"), "reconnect"],
    [Object.assign(new Error("x"), { errorCode: "monitor_window_timeout" }), "reconnect"],
    [new CopyHttpError(401, "Unauthorized"), "reconnect"],
    [new CopyHttpError(403, "API rate limit exceeded for user"), "rate-limited"],
    [new CopyHttpError(403, "Resource not accessible by integration"), "unavailable"],
    [new CopyHttpError(404, "Not Found"), "unavailable"],
    [new CopyHttpError(429, "Too many requests", 5000), "rate-limited"],
    [new CopyHttpError(503, "Service unavailable"), "failed"],
    [new TypeError("Failed to fetch"), "offline"],
    [new Error("boom"), "failed"],
    [new CopyError("public-repository"), "public-repository"],
  ])("%#: %s", (error, code) => {
    expect(classifyCopyFailure(error, true).code).toBe(code);
  });

  it("is offline when the device says so, whatever the message", () => {
    expect(classifyCopyFailure(new Error("boom"), false).code).toBe("offline");
    expect(classifyCopyFailure(new CopyHttpError(429, "x", 5000), true).retryAfterMs).toBe(5000);
  });
});

describe("the ledger in localStorage", () => {
  it("keeps the state per account, book and target, and survives a reload", async () => {
    const ledger = new LocalStorageCopyLedger(window.localStorage);
    const state = await ledger.read(BOOK, "github", SCOPE_A);
    state.copied.a = ["2026/11/10", 10];
    state.bytes = 10;
    await ledger.write(BOOK, "github", SCOPE_A, state);
    expect((await new LocalStorageCopyLedger(window.localStorage).read(BOOK, "github", SCOPE_A)).bytes).toBe(10);
    expect((await ledger.read(BOOK, "github", "other")).bytes).toBe(0);
    expect((await ledger.read(BOOK, "onedrive", SCOPE_A)).bytes).toBe(0);
    await ledger.clear(BOOK, "github", SCOPE_A);
    expect((await ledger.read(BOOK, "github", SCOPE_A)).bytes).toBe(0);
    window.localStorage.setItem("narrarium.aiCallCopies.v1.x", "{");
    expect((await ledger.read(BOOK, "github", "x")).bytes).toBe(0);
  });
});

describe("the scheduler", () => {
  it("copies a task when it finishes, when the device is back online and when a token is renewed", async () => {
    await seed(1);
    const events = new EventTarget();
    let renewed: () => void = () => undefined;
    const scheduler = startCopyScheduler({
      copier: r.copier,
      targets: () => [{ bookId: BOOK, kind: "google-drive" }],
      events,
      subscribeTokenRefresh: (listener) => { renewed = listener; return () => undefined; },
      intervalMs: 3_600_000,
    });
    await scheduler.kick();
    expect(r.drive.uploads).toBe(1);

    await seedTask(r.store, "activity_new", "2026-11-22T10:00:00.000Z");
    await scheduler.taskFinished(BOOK, "activity_new");
    expect(r.drive.uploads).toBe(2);

    await seedTask(r.store, "activity_offline", "2026-11-23T10:00:00.000Z");
    r.state.online = false;
    await scheduler.taskFinished(BOOK, "activity_offline");
    expect(r.drive.uploads).toBe(2);
    r.state.online = true;
    events.dispatchEvent(new Event("online"));
    await scheduler.kick();
    expect(r.drive.uploads).toBe(3);

    r.state.openFailure = new AccountCredentialError("google-drive", "expired");
    await seedTask(r.store, "activity_signin", "2026-11-24T10:00:00.000Z");
    await scheduler.taskFinished(BOOK, "activity_signin");
    expect(r.drive.uploads).toBe(3);
    r.state.openFailure = null;
    renewed();
    await scheduler.kick({ force: true });
    expect(r.drive.uploads).toBe(4);
    scheduler.stop();
    await seedTask(r.store, "activity_after", "2026-11-25T10:00:00.000Z");
    await scheduler.taskFinished(BOOK, "activity_after");
    expect(r.drive.uploads).toBe(4);
  });

  it("copies only the books that have a target", async () => {
    await seed(1);
    const scheduler = startCopyScheduler({ copier: r.copier, targets: () => [], intervalMs: 3_600_000 });
    await scheduler.taskFinished(BOOK, "activity_01");
    await scheduler.kick();
    expect(r.drive.uploads + r.graph.files.size + r.github.blobs.size).toBe(0);
    scheduler.stop();
  });
});
