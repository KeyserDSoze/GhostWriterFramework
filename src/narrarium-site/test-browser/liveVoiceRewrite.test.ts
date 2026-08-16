import { describe, expect, it, vi } from "vitest";
import { captureLiveVoiceRewriteSnapshot, generateLiveVoiceRewrite, persistLiveVoiceRewrite, resolveLiveVoiceRewrite, type LiveVoiceRewriteContext } from "@/assistant/liveVoiceRewrite";
import { bindReadAloudActionProvenance, readAloudReplaySource } from "@/assistant/planner";
import { parseAssistantSessionJson, serializeAssistantSession } from "@/assistant/sessionSchema";

const context = { sessionId: "session", pathname: "/app/books/book/chapters/001/paragraphs/1", bookId: "book", owner: "owner", repo: "repo", branch: "draft" };
const source = { bookId: "book", owner: "owner", repo: "repo", branch: "draft", path: "chapters/001/001.md", sourceHash: "hash", sourceContent: "First sentence. Second sentence.\n" };
const active = { ...context, path: source.path, sourceHash: source.sourceHash };

function snapshot() {
  return captureLiveVoiceRewriteSnapshot({
    active,
    sources: [source, source],
    from: 1,
    to: 1,
    original: "Second sentence.",
  });
}

async function proposal() {
  const captured = snapshot();
  if (!captured) throw new Error("snapshot failed");
  return (await generateLiveVoiceRewrite({
    snapshot: captured,
    generate: async () => "A stronger second sentence.",
    getActiveContext: () => active,
    split: (text) => [text],
  }))?.pending ?? null;
}

describe("live-voice persistent rewrites", () => {
  it("accepts only the provenance-bound source and returns the persistent content", async () => {
    const pending = await proposal();
    expect(pending).not.toBeNull();
    expect(resolveLiveVoiceRewrite(pending, "accept", { ...context, path: source.path, sourceHash: source.sourceHash })).toEqual({
      pending: null,
      content: "First sentence. A stronger second sentence.\n",
    });
  });

  it("discards the proposal when playback switches source", async () => {
    expect(resolveLiveVoiceRewrite(await proposal(), "source-switch")).toEqual({ pending: null });
  });

  it("fails closed when provenance changes before acceptance", async () => {
    expect(resolveLiveVoiceRewrite(await proposal(), "accept", { ...context, path: source.path, sourceHash: "changed" })).toEqual({ pending: null, conflict: true });
  });

  it("rejects without producing source content", async () => {
    expect(resolveLiveVoiceRewrite(await proposal(), "reject")).toEqual({ pending: null });
  });

  it("discards an interrupted proposal without producing source content", async () => {
    expect(resolveLiveVoiceRewrite(await proposal(), "interrupt")).toEqual({ pending: null });
  });

  it.each([
    ["book", { bookId: "other" }],
    ["session", { sessionId: "other" }],
    ["branch", { branch: "other" }],
    ["source", { path: "chapters/002/001.md", sourceHash: "other" }],
  ])("panel generation discards a result after an active %s switch", async (_label, change) => {
    const captured = snapshot();
    if (!captured) throw new Error("snapshot failed");
    let current: LiveVoiceRewriteContext = active;
    let finish!: (value: string) => void;
    const generation = generateLiveVoiceRewrite({
      snapshot: captured,
      generate: () => new Promise<string>((resolve) => { finish = resolve; }),
      getActiveContext: () => current,
      split: (text) => [text],
    });
    current = { ...active, ...change };
    finish("Changed sentence.");
    await expect(generation).resolves.toBeNull();
  });

  it("persistence aborts when active panel context switches while the source read is in flight", async () => {
    const pending = await proposal();
    if (!pending) throw new Error("proposal failed");
    let current: LiveVoiceRewriteContext = active;
    let finishRead!: (value: string) => void;
    const persist = vi.fn(async () => undefined);
    const controller = new AbortController();
    const operation = persistLiveVoiceRewrite({
      pending,
      signal: controller.signal,
      getActiveContext: () => current,
      readSource: () => new Promise<string>((resolve) => { finishRead = resolve; }),
      hashText: async () => source.sourceHash,
      preparePersistence: async () => "head",
      persist,
    });
    current = { ...active, bookId: "other" };
    finishRead(source.sourceContent);
    await expect(operation).resolves.toEqual({ status: "conflict" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("persistence rejects a pathname-only paragraph switch while the source read is in flight", async () => {
    const pending = await proposal();
    if (!pending) throw new Error("proposal failed");
    const controller = new AbortController();
    let current: LiveVoiceRewriteContext = active;
    let finishRead!: (value: string) => void;
    const persist = vi.fn(async () => undefined);
    const operation = persistLiveVoiceRewrite({
      pending,
      signal: controller.signal,
      getActiveContext: () => current,
      readSource: () => new Promise<string>((resolve) => { finishRead = resolve; }),
      hashText: async () => source.sourceHash,
      preparePersistence: async () => "head",
      persist,
    });
    current = { ...active, pathname: "/app/books/book/chapters/001/paragraphs/2" };
    finishRead(source.sourceContent);
    await expect(operation).resolves.toEqual({ status: "conflict" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("persistence rechecks panel context after repository preflight", async () => {
    const pending = await proposal();
    if (!pending) throw new Error("proposal failed");
    let current: LiveVoiceRewriteContext = active;
    let finishPreflight!: (value: string) => void;
    const persist = vi.fn(async () => undefined);
    const controller = new AbortController();
    const operation = persistLiveVoiceRewrite({
      pending,
      signal: controller.signal,
      getActiveContext: () => current,
      readSource: async () => source.sourceContent,
      hashText: async () => source.sourceHash,
      preparePersistence: () => new Promise<string>((resolve) => { finishPreflight = resolve; }),
      persist,
    });
    await vi.waitFor(() => expect(finishPreflight).toBeTypeOf("function"));
    current = { ...active, sessionId: "other" };
    finishPreflight("head");
    await expect(operation).resolves.toEqual({ status: "conflict" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("persistence writes the bound content and expected hash when context stays active", async () => {
    const pending = await proposal();
    if (!pending) throw new Error("proposal failed");
    const persist = vi.fn(async () => undefined);
    const controller = new AbortController();
    await expect(persistLiveVoiceRewrite({
      pending,
      signal: controller.signal,
      getActiveContext: () => active,
      readSource: async () => source.sourceContent,
      hashText: async () => source.sourceHash,
      preparePersistence: async () => "source-head",
      persist,
    })).resolves.toEqual({ status: "applied", content: pending.nextContent });
    expect(persist).toHaveBeenCalledWith("source-head", pending.nextContent, source.sourceHash, controller.signal);
  });

  it.each(["source-read", "preflight"] as const)("interrupt during %s prevents persistence", async (stage) => {
    const pending = await proposal();
    if (!pending) throw new Error("proposal failed");
    const controller = new AbortController();
    let finish!: (value: string) => void;
    const persist = vi.fn(async () => undefined);
    const operation = persistLiveVoiceRewrite({
      pending,
      signal: controller.signal,
      getActiveContext: () => active,
      readSource: stage === "source-read" ? () => new Promise<string>((resolve) => { finish = resolve; }) : async () => source.sourceContent,
      hashText: async () => source.sourceHash,
      preparePersistence: stage === "preflight" ? () => new Promise<string>((resolve) => { finish = resolve; }) : async () => "head",
      persist,
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    controller.abort();
    finish(stage === "source-read" ? source.sourceContent : "head");
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("passes interruption ownership into the write", async () => {
    const pending = await proposal();
    if (!pending) throw new Error("proposal failed");
    const controller = new AbortController();
    const persist = vi.fn(async (_head: string, _content: string, _hash: string, signal: AbortSignal) => signal.throwIfAborted());
    await persistLiveVoiceRewrite({
      pending,
      signal: controller.signal,
      getActiveContext: () => active,
      readSource: async () => source.sourceContent,
      hashText: async () => source.sourceHash,
      preparePersistence: async () => "head",
      persist,
    });
    expect(persist).toHaveBeenCalledWith("head", pending.nextContent, source.sourceHash, controller.signal);
  });

  it("invalidates generation after a pathname-only context switch", async () => {
    const captured = snapshot();
    if (!captured) throw new Error("snapshot failed");
    let current: LiveVoiceRewriteContext = active;
    let finish!: (value: string) => void;
    const generation = generateLiveVoiceRewrite({ snapshot: captured, generate: () => new Promise((resolve) => { finish = resolve; }), getActiveContext: () => current, split: (text) => [text] });
    current = { ...active, pathname: "/app/books/book/chapters/001/paragraphs/2" };
    finish("Changed sentence.");
    await expect(generation).resolves.toBeNull();
  });

  it("replay requires complete captured provenance and survives a session round trip", () => {
    const action = bindReadAloudActionProvenance({ kind: "read-aloud", bookId: "source-book", title: "One", paths: [source.path] }, {
      owner: "owner", repo: "repo", branch: "source-branch", sourceRevisions: { [source.path]: source.sourceHash }, generatedAt: "2026-08-15T10:00:00.000Z",
    });
    const session = { schemaVersion: 1 as const, id: "session", title: "Read", contextTitle: "Book", updatedAt: "2026-08-15T10:00:00.000Z", messages: [{ id: "message", role: "assistant" as const, text: "Reading", action }], attachments: [], archive: { summary: "", messageCount: 0, actions: [], attachments: [] }, compactSummary: "", compactedMessageCount: 0, quarantinedActions: [] };
    const restored = parseAssistantSessionJson(serializeAssistantSession(session));
    expect(restored.quarantinedActions).toEqual([]);
    expect(restored.messages[0].action).toEqual(action);
    expect(readAloudReplaySource(restored.messages[0].action as typeof action)).toEqual({ bookId: "source-book", owner: "owner", repo: "repo", branch: "source-branch" });
    expect(readAloudReplaySource({ kind: "read-aloud", bookId: "source-book", title: "One", paths: [source.path] })).toBeNull();
  });
});
