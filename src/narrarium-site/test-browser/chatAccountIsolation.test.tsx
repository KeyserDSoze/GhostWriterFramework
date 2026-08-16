import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantChatsPage } from "@/pages/AssistantChatsPage";
import { useAuthStore, type AppUser } from "@/store/authStore";
import { useAssistantStore, type AssistantSession, type AssistantSessionMeta } from "@/assistant/store";
import { assistantSessionSaveQueue } from "@/assistant/sessionAutosave";

const cloud = vi.hoisted(() => ({
  list: vi.fn(),
  load: vi.fn(),
  remove: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/assistant/chatCloud", () => ({
  listAssistantSessions: cloud.list,
  loadAssistantSession: cloud.load,
  deleteAssistantSession: cloud.remove,
  saveAssistantSession: cloud.save,
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
  cloud.save.mockReset();
  useAssistantStore.setState({ open: false, busy: false, sessions: [], currentSession: null });
  assistantSessionSaveQueue.reset();
  useAuthStore.setState({ user: user("first@example.com"), accessToken: "first-token", accessTokenExpiry: Date.now() + 60_000 });
});

afterEach(() => cleanup());

describe("chat account isolation", () => {
  it("creates, opens, and atomically retires the active chat from the shared index", async () => {
    cloud.list.mockResolvedValue([meta("Open me")]);
    cloud.load.mockResolvedValue(loadedSession("Opened"));
    cloud.remove.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AssistantChatsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /open/i }));
    await waitFor(() => expect(useAssistantStore.getState().currentSession?.title).toBe("Opened"));
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(cloud.remove).toHaveBeenCalledOnce());
    expect(useAssistantStore.getState().currentSession).toBeNull();
    expect(useAssistantStore.getState().sessions).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: /new/i }));
    expect(useAssistantStore.getState().currentSession?.contextTitle).toBe("Narrarium");
    expect(useAssistantStore.getState().open).toBe(true);
  });

  it("reflects streamed text and action mutations from the shared session", async () => {
    cloud.list.mockResolvedValue([]);
    render(<AssistantChatsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /new/i }));
    const session = useAssistantStore.getState().currentSession!;
    act(() => useAssistantStore.getState().updateSession(session.id, (current) => ({ ...current, messages: [{ id: "reply", role: "assistant", text: "" }] })));
    act(() => useAssistantStore.getState().updateSessionMessage(session.id, "reply", { text: "streamed", action: { kind: "navigate", to: "/app/settings", toolId: "navigate", owner: "writer", repo: "novel", branch: "main", sourceRevision: "head", sourceRevisions: {}, generatedAt: new Date().toISOString() } }));
    expect(useAssistantStore.getState().currentSession?.messages[0]).toMatchObject({ text: "streamed", action: { kind: "navigate" } });
  });

  it("validates and migrates a cross-account archive with a colliding session identity", async () => {
    cloud.list.mockResolvedValue([meta("Existing")]);
    cloud.save.mockResolvedValue({ fileId: "imported-file", revision: "r1" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AssistantChatsPage />);
    await screen.findByText("Existing");
    const archive = {
      format: "narrarium-assistant-chat", version: 1, exportedAt: "2026-08-16T10:00:00.000Z",
      provider: { type: "microsoft", account: "other@example.com" }, cloud: { fileId: "source-file", revision: "old" },
      session: { ...loadedSession("Imported"), schemaVersion: 1, quarantinedActions: [], losslessSegments: [], archive: { summary: "", messageCount: 0, actions: [], attachments: [] } },
    };
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([JSON.stringify(archive)], "chat.json", { type: "application/json" })] } });
    await waitFor(() => expect(cloud.save).toHaveBeenCalledOnce());
    const imported = cloud.save.mock.calls[0][2];
    expect(imported.id).not.toBe("chat-1");
    expect(imported.fileId).toBeUndefined();
    expect(useAssistantStore.getState().sessions[0].fileId).toBe("imported-file");
  });

  it("rejects a tampered archive before upload or index publication", async () => {
    cloud.list.mockResolvedValue([]);
    render(<AssistantChatsPage />);
    const archive = {
      format: "narrarium-assistant-chat", version: 1, exportedAt: "2026-08-16T10:00:00.000Z",
      provider: { type: "google", account: "first@example.com" }, cloud: {}, completeness: { complete: true, missingRanges: [] },
      session: { ...loadedSession("Tampered"), schemaVersion: 1, quarantinedActions: [], losslessSegments: [{ format: "narrarium-assistant-chat-segment", version: 1, id: "segment", createdAt: "2026-08-16T10:00:00.000Z", messages: [{ id: "message", role: "user", text: "tampered" }], attachments: [] }], losslessArchive: { version: 1, head: { id: "segment", sha256: "0".repeat(64) }, segmentCount: 1, messageCount: 1, attachmentCount: 0, actionCount: 0, complete: true, missingRanges: [] }, archive: { summary: "", messageCount: 0, actions: [], attachments: [] } },
    };
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File([JSON.stringify(archive)], "tampered.json")] } });
    await waitFor(() => expect(cloud.save).not.toHaveBeenCalled());
    expect(useAssistantStore.getState().sessions).toEqual([]);
    expect(useAssistantStore.getState().currentSession).toBeNull();
  });

  it("ignores an import upload that completes after an account switch", async () => {
    const pending = deferred<{ fileId: string; revision: string }>();
    cloud.list.mockResolvedValue([]);
    cloud.save.mockReturnValue(pending.promise);
    render(<AssistantChatsPage />);
    const archive = { format: "narrarium-assistant-chat", version: 1, exportedAt: "2026-08-16T10:00:00.000Z", provider: { type: "google", account: "first@example.com" }, cloud: {}, session: { ...loadedSession("Imported"), schemaVersion: 1, quarantinedActions: [], archive: { summary: "", messageCount: 0, actions: [], attachments: [] } } };
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File([JSON.stringify(archive)], "chat.json")] } });
    await waitFor(() => expect(cloud.save).toHaveBeenCalledOnce());
    act(() => useAuthStore.getState().setAuth("second-token", user("second@example.com")));
    pending.resolve({ fileId: "old-account-file", revision: "r1" });
    await act(async () => { await pending.promise; });
    expect(useAssistantStore.getState().sessions).toEqual([]);
    expect(useAssistantStore.getState().currentSession).toBeNull();
  });

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
