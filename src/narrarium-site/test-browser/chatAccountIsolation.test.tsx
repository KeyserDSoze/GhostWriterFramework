import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantChatsPage } from "@/pages/AssistantChatsPage";
import { useAuthStore, type AppUser } from "@/store/authStore";
import { useAssistantStore, type AssistantSession, type AssistantSessionMeta } from "@/assistant/store";

const cloud = vi.hoisted(() => ({
  list: vi.fn(),
  load: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/assistant/chatCloud", () => ({
  listAssistantSessions: cloud.list,
  loadAssistantSession: cloud.load,
  deleteAssistantSession: cloud.remove,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function user(email: string): AppUser {
  return { provider: "google", email, name: email, picture: "" };
}

function meta(title: string): AssistantSessionMeta {
  return { id: "chat-1", fileId: "file-1", title, contextTitle: "Book", updatedAt: "2026-08-15T10:00:00Z" };
}

function loadedSession(title: string): AssistantSession {
  return { ...meta(title), messages: [], attachments: [], compactSummary: "", compactedMessageCount: 0 };
}

beforeEach(() => {
  cloud.list.mockReset();
  cloud.load.mockReset();
  cloud.remove.mockReset();
  useAssistantStore.setState({ open: false, busy: false, sessions: [], currentSession: null });
  useAuthStore.setState({ user: user("first@example.com"), accessToken: "first-token", accessTokenExpiry: Date.now() + 60_000 });
});

afterEach(() => cleanup());

describe("chat account isolation", () => {
  it("clears page-local history and aborts an in-flight history request on account switch", async () => {
    const secondList = deferred<AssistantSessionMeta[]>();
    let firstSignal: AbortSignal | undefined;
    cloud.list
      .mockImplementationOnce(async (_provider, _token, options) => {
        firstSignal = options.signal;
        return [meta("First account chat")];
      })
      .mockImplementationOnce(() => secondList.promise);

    render(<AssistantChatsPage />);
    expect(await screen.findByText("First account chat")).toBeInTheDocument();

    act(() => useAuthStore.getState().setAuth("second-token", user("second@example.com")));
    expect(firstSignal?.aborted).toBe(true);
    expect(screen.queryByText("First account chat")).not.toBeInTheDocument();
    secondList.resolve([]);
  });

  it("aborts and ignores a late chat download after logout", async () => {
    const pendingLoad = deferred<AssistantSession>();
    let loadSignal: AbortSignal | undefined;
    cloud.list.mockResolvedValue([meta("Open me")]);
    cloud.load.mockImplementation((_provider, _token, _fileId, signal) => {
      loadSignal = signal;
      return pendingLoad.promise;
    });

    render(<AssistantChatsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /open/i }));
    await waitFor(() => expect(cloud.load).toHaveBeenCalledOnce());
    act(() => useAuthStore.getState().clearAuth());
    expect(loadSignal?.aborted).toBe(true);
    pendingLoad.resolve(loadedSession("Old account session"));
    await act(async () => { await Promise.resolve(); });
    expect(useAssistantStore.getState().currentSession).toBeNull();
    expect(screen.queryByText("Open me")).not.toBeInTheDocument();
  });
});
