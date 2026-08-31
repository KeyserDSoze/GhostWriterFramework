import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantChatsPage } from "@/pages/AssistantChatsPage";
import { createEmptyAssistantSession, useAssistantStore, type AssistantSession, type AssistantSessionMeta } from "@/assistant/store";
import { useAuthStore } from "@/store/authStore";

const local = vi.hoisted(() => ({ list: vi.fn(), load: vi.fn(), remove: vi.fn(), save: vi.fn() }));

vi.mock("@/assistant/chatLocal", () => ({
  listLocalChatSessions: local.list,
  loadLocalChatSession: local.load,
  deleteLocalChatSession: local.remove,
  saveLocalChatSession: local.save,
}));

function meta(title: string, id = "chat-1"): AssistantSessionMeta {
  return { id, fileId: id, title, contextTitle: "Book", updatedAt: "2026-08-15T10:00:00Z" };
}

function loadedSession(title: string, id = "chat-1"): AssistantSession {
  return { ...createEmptyAssistantSession("Book"), ...meta(title, id), title };
}

beforeEach(() => {
  local.list.mockReset().mockResolvedValue([]);
  local.load.mockReset();
  local.remove.mockReset().mockResolvedValue(undefined);
  local.save.mockReset().mockResolvedValue(undefined);
  useAssistantStore.setState({ open: false, busy: false, sessions: [], sessionAccountIdentity: null, sessionsLoading: false, currentSession: null });
  useAuthStore.getState().clearAuth();
});

afterEach(() => cleanup());

describe("local chat workspace", () => {
  it("creates, opens, and deletes a durable local chat without an account", async () => {
    local.list.mockResolvedValue([meta("Open me")]);
    local.load.mockResolvedValue(loadedSession("Opened"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AssistantChatsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /open/i }));
    await waitFor(() => expect(local.load).toHaveBeenCalledWith("chat-1"));
    expect(useAssistantStore.getState().currentSession?.title).toBe("Opened");
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(local.remove).toHaveBeenCalledWith("chat-1"));
    expect(useAssistantStore.getState().currentSession).toBeNull();
  });

  it("keeps local history when a provider session changes or logs out", async () => {
    local.list.mockResolvedValue([meta("Local chat")]);
    render(<AssistantChatsPage />);
    expect(await screen.findByText("Local chat")).toBeInTheDocument();
    act(() => useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub", name: "Writer", email: "writer@example.test", picture: "" }, accessToken: "token" }));
    act(() => useAuthStore.getState().clearAuth());
    expect(screen.getByText("Local chat")).toBeInTheDocument();
  });

  it("publishes streamed text and actions through the shared in-memory session", async () => {
    render(<AssistantChatsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /new/i }));
    const session = useAssistantStore.getState().currentSession!;
    act(() => useAssistantStore.getState().updateSession(session.id, (current) => ({ ...current, messages: [{ id: "reply", role: "assistant", text: "" }] })));
    act(() => useAssistantStore.getState().updateSessionMessage(session.id, "reply", { text: "streamed", action: { kind: "navigate", to: "/app/settings" } }));
    expect(useAssistantStore.getState().currentSession?.messages[0]).toMatchObject({ text: "streamed", action: { kind: "navigate" } });
  });

  it("validates and saves an imported archive under a collision-free local identity", async () => {
    local.list.mockResolvedValue([meta("Existing")]);
    render(<AssistantChatsPage />);
    await screen.findByText("Existing");
    const session = loadedSession("Imported");
    session.losslessSegments = [];
    session.losslessArchive = { version: 1, segmentCount: 0, messageCount: 0, attachmentCount: 0, actionCount: 0, complete: true, missingRanges: [] };
    const archive = { format: "narrarium-assistant-chat", version: 1, exportedAt: "2026-08-16T10:00:00.000Z", provider: { type: "local", account: "workspace" }, cloud: {}, origin: { provider: "local", account: "workspace" }, completeness: { complete: true, missingRanges: [] }, session };
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File([JSON.stringify(archive)], "chat.json", { type: "application/json" })] } });
    await waitFor(() => expect(local.save).toHaveBeenCalledOnce());
    expect((local.save.mock.calls[0][0] as AssistantSession).id).not.toBe("chat-1");
  });
});
