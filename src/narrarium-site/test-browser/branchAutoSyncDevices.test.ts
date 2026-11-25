import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeGitServer } from "./helpers/fakeGitServer";

const github = vi.hoisted(() => ({ server: null as FakeGitServer | null }));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    get rest() { return github.server!.rest; }
    request = (route: string, params: Record<string, unknown>) => github.server!.request(route, params as never);
  },
}));

import { createFakeGitServer } from "./helpers/fakeGitServer";
import { runBookSyncCycle, type AutoSyncHost } from "@/branches/autoSync";
import { AUTOPILOT_LOCK_PREFIX, EDITING_LOCK_PREFIX, REPOSITORY_LOCK_PREFIX } from "@/branches/locks";
import { bookBranchMemory, chooseBranch, keepBranchInSync, recordBranchUse, withBookBranchMemory } from "@/branches/memory";
import { useBranchSyncStore } from "@/branches/syncStore";
import { forgetRun, rememberRun } from "@/autopilot/resume";
import { mergeLocalDeviceSettings } from "@/account/dataProjection";
import { resetLocalWorkspaceIdentityForTests } from "@/account/deviceIdentity";
import { parseAccountRepositoryFiles, serializeAccountRepository } from "@/account/serialization";
import { ACCOUNT_SYNC_SCHEMA_VERSION } from "@/account/types";
import { initialAccountManifest } from "@/account/vectorClock";
import { emptyCostsFile } from "@/costs/model";
import { getLocalFile, getLocalRepository, getLocalRepositoryStatusSnapshot, writeLocalTextScoped } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { ensureLocalBookStructure, syncFullRepository, RepositorySyncConflictError } from "@/repository/repositoryService";
import { createBranchFromWorkingCopy } from "@/repository/branchSync";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore, LOCAL_SETTINGS_SOURCE_SCHEMA_VERSION } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, LOCAL_BOOK_TOKEN, type AppSettings, type BookEntry } from "@/types/settings";

// Two devices of the same person (two local workspaces, each with its own working copies) and one GitHub: what the automatic sync does, request by request.

const BOOK_ID = "book-novel";
const TOKEN = "ghp_test_token";
const CHAPTER = "chapters/001-arrival/001-opening.md";
const FILES = {
  "book.md": "---\ntype: book\ntitle: Novel\n---\n",
  "chapters/001-arrival/chapter.md": "---\ntitle: Arrival\n---\n",
  [CHAPTER]: "The gate stood open.\n",
  "characters/ada.md": "---\nname: Ada\n---\n",
};

interface Device { identity: string; settings: AppSettings }

let server: FakeGitServer;
let clock = Date.parse("2026-11-24T10:00:00.000Z");
const book: BookEntry = { id: BOOK_ID, owner: "writer", repo: "novel", name: "Novel", tokenIndex: null, bookToken: TOKEN, addedAt: "2026-11-01T00:00:00.000Z" };

/** A new pair of devices for each test: the working copies of one test are not those of the next. */
let run = 0;
function device(name: string, branch = "main"): Device {
  return { identity: `workspace:${name}-${run}`, settings: { ...DEFAULT_SETTINGS, books: [{ ...book, activeBranch: branch, activeBranchAt: new Date(clock).toISOString() }] } };
}

let current: Device | null = null;
function on(next: Device): void {
  if (current) current.settings = useSettingsStore.getState().settings;
  current = next;
  // Each device is its own local workspace: its working copies are its own.
  localStorage.setItem("narrarium-local-workspace-id-v1", next.identity.replace(/^workspace:/, ""));
  resetLocalWorkspaceIdentityForTests();
  useSettingsStore.setState({ accountIdentity: next.identity, accountGeneration: 0, settings: next.settings });
  useBooksStore.setState({ structures: {}, workingBranches: {}, errors: {} });
  useBranchSyncStore.setState({ books: {} });
}

function host(extra: Partial<AutoSyncHost> = {}): AutoSyncHost & { updated: string[] } {
  const updated: string[] = [];
  return { now: () => clock, heldLocks: async () => new Set(), serverAutopilotRunning: () => false, branchUpdated: (_book, branch) => { updated.push(branch); }, updated, ...extra };
}

const target = (branch: string) => ({ bookId: BOOK_ID, owner: "writer", repo: "novel", branch, accountIdentity: useSettingsStore.getState().accountIdentity! });
const bookNow = () => useSettingsStore.getState().settings.books[0];

async function open(branch: string): Promise<void> {
  await ensureLocalBookStructure({ bookId: BOOK_ID, book: bookNow(), token: TOKEN, accountIdentity: target(branch).accountIdentity, branch });
}

async function edit(branch: string, path: string, text: string): Promise<void> {
  const meta = await getLocalRepository("writer", "novel", branch, captureRepositoryOperationScope());
  await writeLocalTextScoped(meta!.id, path, text, captureRepositoryOperationScope());
}

async function status(branch: string) {
  return (await getLocalRepositoryStatusSnapshot("writer", "novel", branch, target(branch).accountIdentity))!;
}

async function localText(branch: string, path: string): Promise<string | undefined> {
  const meta = await getLocalRepository("writer", "novel", branch, captureRepositoryOperationScope());
  return (await getLocalFile(meta!.id, path, captureRepositoryOperationScope()))?.text;
}

/** This device chooses a branch (the switcher does the same), dated now. */
function choose(branch: string, createdHere = false): void {
  const settings = useSettingsStore.getState().settings;
  useSettingsStore.setState({ settings: { ...settings, ...chooseBranch(settings, settings.books[0], branch, new Date(clock).toISOString(), { createdHere }) } });
}

/** The account data of the current device, as another device reads it, adopted there (with its own branch fields kept) as the app does on loading. */
async function accountDataTo(next: Device): Promise<void> {
  const from = useSettingsStore.getState().settings;
  const serialized = await serializeAccountRepository({ dirty: true, manifest: initialAccountManifest("device"), data: { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings: from, costs: emptyCostsFile(), clipboard: [], chats: [] } });
  const remote = parseAccountRepositoryFiles(serialized.files).data.settings;
  on(next);
  useSettingsStore.getState().replaceSettingsFromTrustedLoad(mergeLocalDeviceSettings(next.settings, remote), { accountGeneration: 0, accountIdentity: next.identity, source: { kind: "local", schemaVersion: LOCAL_SETTINGS_SOURCE_SCHEMA_VERSION } });
}

beforeEach(() => {
  run += 1;
  localStorage.clear();
  current = null;
  clock += 3_600_000;
  server = createFakeGitServer({ files: FILES });
  github.server = server;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => server.fetch(input)));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("the branches follow the person from one device to another", () => {
  it("publishes a branch made on A, opens it on B as the last one used, brings the other one along cheaply, and carries each device's work to the other", async () => {
    const a = device("device-a");
    const b: Device = { identity: `workspace:device-b-${run}`, settings: { ...DEFAULT_SETTINGS, books: [] } };

    // A opens the book on main, then makes a branch for an idea: on this device first, from what it shows, and works on it.
    on(a);
    await open("main");
    choose("main");
    clock += 60_000;
    await createBranchFromWorkingCopy({ ...target("main"), newBranch: "draft/2026-11-24" });
    choose("draft/2026-11-24", true);
    await edit("draft/2026-11-24", CHAPTER, "The gate stood open, and Ada went in.\n");
    expect((await status("draft/2026-11-24")).meta.pendingBranch).toMatchObject({ base: "main", headSha: server.head("main") });
    expect(server.head("draft/2026-11-24")).toBeUndefined();

    // A's next cycle publishes it: GitHub gets the branch at the commit it started from, then its change, pushed like any other.
    const published = await runBookSyncCycle(BOOK_ID, "created", host());
    expect(published.branches["draft/2026-11-24"].outcome).toBe("published");
    // What the cycle did, for the menu of the pill: the branch published (with its change), main looked at and left as it was.
    expect(published.lastSummary).toEqual({ at: clock, pulledFiles: 0, pulled: 0, pushed: 0, published: 1, downloaded: 0, attention: 0 });
    expect(server.filesOf("draft/2026-11-24").get(CHAPTER)).toBe("The gate stood open, and Ada went in.\n");
    expect(server.history("draft/2026-11-24")).toEqual(["Update 001-opening.md", "Initial commit"]);
    expect((await status("draft/2026-11-24")).status).toMatchObject({ dirty: 0, ahead: 0 });
    expect((await status("draft/2026-11-24")).meta.pendingBranch).toBeUndefined();
    // main is left as it was: the new branch carried the change, not the branch it came from.
    expect(server.history("main")).toEqual(["Initial commit"]);
    expect(await localText("main", CHAPTER)).toBe("The gate stood open.\n");

    // B, a new device: the account data brings the memory, and B opens the branch A used last, which it downloads in full (nothing to reuse yet).
    server.reset();
    await accountDataTo(b);
    expect(bookNow()).toMatchObject({ activeBranch: "draft/2026-11-24", adoptedFrom: "" });
    await open("draft/2026-11-24");
    expect(server.count("blob.download")).toBe(Object.keys(FILES).length);

    // B's cycle brings main along (a branch the person worked on): only the one file that differs is downloaded, the others come from the copy here.
    server.reset();
    const onB = await runBookSyncCycle(BOOK_ID, "open", host());
    expect(onB.branches.main.outcome).toBe("downloaded");
    expect(server.count("blob.download")).toBe(1);
    expect(await localText("main", CHAPTER)).toBe("The gate stood open.\n");

    // B writes on the branch; GitHub did not move, so the next cycle pushes it.
    await edit("draft/2026-11-24", CHAPTER, "The gate stood open, and Ada went in. B was here.\n");
    clock += 120_000;
    expect((await runBookSyncCycle(BOOK_ID, "focus", host())).branches["draft/2026-11-24"].outcome).toBe("pushed");
    expect(server.filesOf("draft/2026-11-24").get(CHAPTER)).toContain("B was here.");

    // Back on A: its copy of the branch is clean, GitHub moved, so its next cycle pulls B's work, and the pages showing the branch read it again.
    on(a);
    clock += 120_000;
    const backOnA = host();
    useBooksStore.setState({ structures: { [BOOK_ID]: { loadedBranch: "draft/2026-11-24" } as never } });
    const pulledOnA = await runBookSyncCycle(BOOK_ID, "focus", backOnA);
    expect(pulledOnA.branches["draft/2026-11-24"]).toMatchObject({ outcome: "pulled", files: 1 });
    expect(pulledOnA.lastSummary).toMatchObject({ pulled: 1, pulledFiles: 1, attention: 0 });
    expect(await localText("draft/2026-11-24", CHAPTER)).toContain("B was here.");
    expect(backOnA.updated).toEqual(["draft/2026-11-24"]);
  });

  it("costs one conditional request when nothing changed: GitHub answers 304, and no branch is asked anything", async () => {
    on(device("device-a"));
    await open("main");
    choose("main");
    await runBookSyncCycle(BOOK_ID, "open", host());
    server.reset();
    const remaining = server.rate.remaining;
    clock += 120_000;
    const state = await runBookSyncCycle(BOOK_ID, "focus", host());
    expect(server.calls.map((call) => call.name)).toEqual(["branches.list"]);
    expect(server.calls[0].params.headers).toMatchObject({ "if-none-match": expect.stringMatching(/^W\//) });
    expect(server.rate.remaining).toBe(remaining);
    expect(state).toMatchObject({ status: "done", failures: 0, rateRemaining: remaining });
    expect(state.branches.main.outcome).toBe("synced");
  });

  it("asks nothing at all without a credential, offline, or when the mode is off", async () => {
    const a = device("device-a");
    on(a);
    await open("main");
    server.reset();
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, books: [{ ...bookNow(), bookToken: undefined }] } });
    expect(useSettingsStore.getState().settings.defaultGitHubToken).toBe("");
    await runBookSyncCycle(BOOK_ID, "manual", host());
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, books: [{ ...bookNow(), bookToken: LOCAL_BOOK_TOKEN }] } });
    await runBookSyncCycle(BOOK_ID, "manual", host());
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, books: [{ ...bookNow(), bookToken: TOKEN }] } });
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await runBookSyncCycle(BOOK_ID, "manual", host());
    online.mockRestore();
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, repository: { ...DEFAULT_SETTINGS.repository, autoSync: "off" } } });
    await runBookSyncCycle(BOOK_ID, "focus", host());
    expect(server.calls).toEqual([]);
    // The person can always ask.
    await runBookSyncCycle(BOOK_ID, "manual", host());
    expect(server.count("branches.list")).toBe(1);
  });
});

describe("the automatic sync never overwrites, never forces, never merges by itself", () => {
  it("leaves a branch that changed on GitHub and here as it is, says so, and lets the existing sync ask about the conflict", async () => {
    on(device("device-a"));
    await open("main");
    choose("main");
    await edit("main", CHAPTER, "Mine: the gate was shut.\n");
    const theirs = server.commitOn("main", { [CHAPTER]: "Theirs: the gate was gone.\n" });
    server.reset();
    const state = await runBookSyncCycle(BOOK_ID, "open", host());
    expect(state.branches.main).toMatchObject({ outcome: "diverged", remoteHeadSha: theirs });
    expect(state.lastSummary).toMatchObject({ attention: 1, pushed: 0, pulled: 0 });
    expect(server.calls.filter((call) => call.name.startsWith("git.create") || call.name === "git.updateRef")).toEqual([]);
    expect(server.head("main")).toBe(theirs);
    expect(await localText("main", CHAPTER)).toBe("Mine: the gate was shut.\n");
    expect((await status("main")).meta.remoteStatus).toBe("changed");
    await expect(syncFullRepository({ ...target("main"), token: TOKEN })).rejects.toBeInstanceOf(RepositorySyncConflictError);
    expect(await localText("main", CHAPTER)).toBe("Mine: the gate was shut.\n");
  });

  it("follows a new head with the same files without touching anything, then pushes as if GitHub had not moved", async () => {
    on(device("device-a"));
    await open("main");
    choose("main");
    await edit("main", "characters/ada.md", "---\nname: Ada Lovelace\n---\n");
    const sameFiles = server.commitOn("main", {}, "Empty merge");
    const state = await runBookSyncCycle(BOOK_ID, "open", host());
    expect(state.branches.main.outcome).toBe("pushed");
    expect(server.history("main")).toEqual(["Update ada.md", "Empty merge", "Initial commit"]);
    expect(server.filesOf("main").get(CHAPTER)).toBe("The gate stood open.\n");
    expect(sameFiles).not.toBe(server.head("main"));
  });

  it("does not recreate a branch GitHub no longer has, and does not publish over a branch of the same name with another history", async () => {
    on(device("device-a"));
    await open("main");
    choose("main");
    server.createBranch("old-idea");
    await open("old-idea");
    choose("old-idea");
    server.deleteBranch("old-idea");
    expect((await runBookSyncCycle(BOOK_ID, "manual", host())).branches["old-idea"].outcome).toBe("gone");
    expect(server.head("old-idea")).toBeUndefined();

    choose("main");
    await createBranchFromWorkingCopy({ ...target("main"), newBranch: "shared-name" });
    choose("shared-name", true);
    server.createBranch("shared-name");
    server.commitOn("shared-name", { [CHAPTER]: "Someone else's idea.\n" });
    const before = server.head("shared-name");
    expect((await runBookSyncCycle(BOOK_ID, "manual", host())).branches["shared-name"].outcome).toBe("name-taken");
    expect(server.head("shared-name")).toBe(before);
    expect((await status("shared-name")).meta.pendingBranch).toBeDefined();
  });
});

describe("the automatic sync makes way", () => {
  async function prepared() {
    on(device("device-a"));
    await open("main");
    choose("main");
    server.createBranch("other");
    await open("other");
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: { ...settings, ...withBookBranchMemory(settings, book, (memory) => recordBranchUse(memory, "other", new Date(clock).toISOString())) } });
    server.commitOn("main", { [CHAPTER]: "New on main.\n" });
    server.commitOn("other", { [CHAPTER]: "New on other.\n" });
    server.reset();
  }

  it("to the browser autopilot running the book: nothing is synced, not even listed", async () => {
    await prepared();
    const state = await runBookSyncCycle(BOOK_ID, "manual", host({ heldLocks: async () => new Set([`${AUTOPILOT_LOCK_PREFIX}${BOOK_ID}`]) }));
    expect(state.status).toBe("autopilot");
    expect(server.calls).toEqual([]);
  });

  it("to a browser autopilot this browser will resume by itself after a reload: nothing is synced in the window before the run is re-created, as during the run", async () => {
    await prepared();
    const scope = target("main").accountIdentity;
    // The intent the runtime keeps from the start of a run until it ends, is paused or stopped: after a reload it is there before the lock is held again.
    rememberRun({ bookId: BOOK_ID, scope, since: new Date(clock).toISOString(), step: "Write the scene" });
    let state = await runBookSyncCycle(BOOK_ID, "open", host());
    expect(state.status).toBe("autopilot");
    expect(server.calls).toEqual([]);
    expect(await localText("main", CHAPTER)).toBe("The gate stood open.\n");
    // The run of another account in this browser is not this book's run here.
    forgetRun(scope, BOOK_ID);
    rememberRun({ bookId: BOOK_ID, scope: "workspace:another-account", since: new Date(clock).toISOString() });
    state = await runBookSyncCycle(BOOK_ID, "manual", host());
    expect(state.status).toBe("done");
    expect(state.branches.main.outcome).toBe("pulled");
  });

  it("again once the run ended, or the author paused or stopped it (its intent is gone)", async () => {
    await prepared();
    const scope = target("main").accountIdentity;
    rememberRun({ bookId: BOOK_ID, scope, since: new Date(clock).toISOString() });
    expect((await runBookSyncCycle(BOOK_ID, "manual", host())).status).toBe("autopilot");
    forgetRun(scope, BOOK_ID);
    const state = await runBookSyncCycle(BOOK_ID, "manual", host());
    expect(state.branches.main.outcome).toBe("pulled");
    expect(state.branches.other.outcome).toBe("pulled");
  });

  it("to a change that holds a working copy, and to unsaved edits of the branch on the screen, whose pull waits while the other branch is pulled", async () => {
    await prepared();
    const otherCopy = await getLocalRepository("writer", "novel", "other", captureRepositoryOperationScope());
    let state = await runBookSyncCycle(BOOK_ID, "manual", host({ heldLocks: async () => new Set([`${REPOSITORY_LOCK_PREFIX}${otherCopy!.id}`, `${EDITING_LOCK_PREFIX}${BOOK_ID}`]) }));
    expect(state.branches.main.outcome).toBe("held");
    expect(state.branches.other.outcome).toBe("busy");
    expect(await localText("main", CHAPTER)).toBe("The gate stood open.\n");
    state = await runBookSyncCycle(BOOK_ID, "manual", host({ heldLocks: async () => new Set([`${EDITING_LOCK_PREFIX}${BOOK_ID}`]) }));
    expect(state.branches.other.outcome).toBe("pulled");
    expect(await localText("other", CHAPTER)).toBe("New on other.\n");
    expect(await localText("main", CHAPTER)).toBe("The gate stood open.\n");
  });

  it("to the autopilot of the personal server: it pulls, and never races its pushes", async () => {
    await prepared();
    await edit("other", "characters/ada.md", "Edited while the server writes.\n");
    const state = await runBookSyncCycle(BOOK_ID, "manual", host({ serverAutopilotRunning: () => true }));
    expect(state.branches.main.outcome).toBe("pulled");
    expect(state.branches.other.outcome).toBe("diverged");
    server.commitOn("main", {}, "noop");
    await edit("main", "characters/ada.md", "Local while the server runs.\n");
    clock += 120_000;
    const next = await runBookSyncCycle(BOOK_ID, "manual", host({ serverAutopilotRunning: () => true }));
    expect(next.branches.main.outcome).toBe("held");
    expect(server.count("git.updateRef")).toBe(0);
  });
});

describe("which branches, and how many requests", () => {
  it("takes for the current branch the one the asking tab shows, even when this tab's settings know an older choice", async () => {
    on(device("device-a"));
    await open("main");
    choose("main");
    server.createBranch("draft");
    await open("draft");
    await edit("draft", CHAPTER, "Shown in another tab.\n");
    await edit("main", CHAPTER, "Not the branch on the screen.\n");
    server.commitOn("main", { "book.md": "moved" });
    const state = await runBookSyncCycle(BOOK_ID, "switch", host({ heldLocks: async () => new Set([`${EDITING_LOCK_PREFIX}${BOOK_ID}`]) }), { branch: "draft" });
    expect(state.branches.draft.outcome).toBe("pushed");
    // main is one of the branches brought along: its own work waits for the person, GitHub having moved.
    expect(state.branches.main.outcome).toBe("diverged");
    expect(await localText("main", CHAPTER)).toBe("Not the branch on the screen.\n");
  });

  it("brings along the four most recent branches the person worked on, plus the pinned ones, never the excluded ones", async () => {
    on(device("device-a"));
    await open("main");
    choose("main");
    let settings = useSettingsStore.getState().settings;
    for (let index = 1; index <= 7; index += 1) {
      server.createBranch(`b${index}`);
      settings = { ...settings, ...withBookBranchMemory(settings, book, (memory) => recordBranchUse(memory, `b${index}`, new Date(clock - (10 - index) * 60_000).toISOString())) };
    }
    settings = { ...settings, ...withBookBranchMemory(settings, book, (memory) => keepBranchInSync(keepBranchInSync(memory, "b1", true, new Date(clock).toISOString()), "b7", false, new Date(clock).toISOString())) };
    useSettingsStore.setState({ settings });
    const state = await runBookSyncCycle(BOOK_ID, "manual", host());
    expect(Object.keys(state.branches).sort()).toEqual(["b1", "b3", "b4", "b5", "b6", "main"]);
    expect(Object.entries(state.branches).filter(([name]) => name !== "main").every(([, value]) => value.outcome === "downloaded")).toBe(true);
    expect(bookBranchMemory(useSettingsStore.getState().settings, book)?.knownBranches).toHaveLength(8);
  });

  it("syncs the current branch only when the hour is running out, and nothing until the reset when it has run out", async () => {
    on(device("device-a"));
    await open("main");
    choose("main");
    server.createBranch("other");
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: { ...settings, ...withBookBranchMemory(settings, book, (memory) => recordBranchUse(memory, "other", new Date(clock).toISOString())) } });
    server.rate.remaining = 300;
    let state = await runBookSyncCycle(BOOK_ID, "manual", host());
    expect(Object.keys(state.branches)).toEqual(["main"]);
    server.rate.remaining = 20;
    server.commitOn("main", { [CHAPTER]: "Later.\n" });
    state = await runBookSyncCycle(BOOK_ID, "manual", host());
    expect(state.pausedUntil).toBe(server.rate.reset * 1000);
    expect(await localText("main", CHAPTER)).toBe("The gate stood open.\n");
    server.reset();
    clock += 120_000;
    await runBookSyncCycle(BOOK_ID, "focus", host());
    expect(server.calls).toEqual([]);
  });

  it("waits longer after each failure, and the person can still sync at once", async () => {
    on(device("device-a"));
    await open("main");
    choose("main");
    const failing = vi.spyOn(server, "request").mockRejectedValue(Object.assign(new Error("Server Error"), { status: 502, response: { status: 502, headers: {} } }));
    const first = await runBookSyncCycle(BOOK_ID, "open", host());
    expect(first).toMatchObject({ status: "failed", errorKind: "service-unavailable", failures: 1, pausedUntil: clock + 120_000, lastSummary: { failed: "service-unavailable" } });
    clock += 60_000;
    await runBookSyncCycle(BOOK_ID, "focus", host());
    expect(failing).toHaveBeenCalledTimes(1);
    const again = await runBookSyncCycle(BOOK_ID, "manual", host());
    expect(again).toMatchObject({ failures: 2, pausedUntil: clock + 240_000 });
    failing.mockRestore();
    expect((await runBookSyncCycle(BOOK_ID, "manual", host())).failures).toBe(0);
  });
});
