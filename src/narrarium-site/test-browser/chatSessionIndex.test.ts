import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantStore, type AssistantSessionMeta } from "@/assistant/store";

const cloud = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/assistant/chatCloud", () => ({ listAssistantSessions: cloud.list }));

import { refreshAssistantSessionIndex, resetAssistantSessionIndex } from "@/assistant/sessionIndex";
import { resetAccountScopedState } from "@/auth/accountScope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function meta(id: string): AssistantSessionMeta {
  return { id, fileId: `file-${id}`, title: id, contextTitle: "Book", updatedAt: "2026-08-16T10:00:00Z", contentRevision: 1 };
}

describe("authoritative assistant session index", () => {
  beforeEach(() => {
    resetAssistantSessionIndex(null);
    useAssistantStore.setState({ sessions: [], sessionAccountIdentity: null, sessionsLoading: false });
    cloud.list.mockReset();
  });

  it("aborts and suppresses an out-of-order list from a previous account", async () => {
    const first = deferred<AssistantSessionMeta[]>();
    const second = deferred<AssistantSessionMeta[]>();
    let firstSignal: AbortSignal | undefined;
    cloud.list
      .mockImplementationOnce((_provider, _token, options) => { firstSignal = options.signal; return first.promise; })
      .mockImplementationOnce(() => second.promise);

    const firstRequest = refreshAssistantSessionIndex("google", "token-a", "google:a@example.com");
    const secondRequest = refreshAssistantSessionIndex("microsoft", "token-b", "microsoft:b@example.com");
    expect(firstSignal?.aborted).toBe(true);
    second.resolve([meta("second")]);
    await secondRequest;
    first.resolve([meta("first")]);
    await firstRequest;
    expect(useAssistantStore.getState().sessions.map((entry) => entry.id)).toEqual(["second"]);
    expect(useAssistantStore.getState().sessionAccountIdentity).toBe("microsoft:b@example.com");
  });

  it("account reset aborts the shared request and invalidates its generation and identity", async () => {
    const request = deferred<AssistantSessionMeta[]>();
    let signal: AbortSignal | undefined;
    cloud.list.mockImplementation((_provider, _token, options) => { signal = options.signal; return request.promise; });
    const pending = refreshAssistantSessionIndex("google", "token-a", "google:a@example.com");
    resetAccountScopedState();
    expect(signal?.aborted).toBe(true);
    expect(useAssistantStore.getState().sessionAccountIdentity).toBeNull();
    request.resolve([meta("stale")]);
    await pending;
    expect(useAssistantStore.getState().sessions).toEqual([]);
  });
});
