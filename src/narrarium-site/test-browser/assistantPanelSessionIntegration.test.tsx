import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { createEmptyAssistantSession, useAssistantStore } from "@/assistant/store";
import { useAuthStore } from "@/store/authStore";
import { resetAssistantSessionIndex } from "@/assistant/sessionIndex";

const service = vi.hoisted(() => ({ run: vi.fn() }));
const context = vi.hoisted(() => ({ load: vi.fn() }));
const cloud = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), load: vi.fn(), remove: vi.fn() }));

vi.mock("@/assistant/service", () => ({
  appendAssistantNote: vi.fn(), applyParagraphRewrite: vi.fn(), compactAssistantSession: vi.fn(async ({ session }) => session),
  runAssistantPrompt: service.run,
}));
vi.mock("@/assistant/chatCloud", async (original) => ({
  ...await original<typeof import("@/assistant/chatCloud")>(),
  listAssistantSessions: cloud.list,
  saveAssistantSession: cloud.save,
  loadAssistantSession: cloud.load, deleteAssistantSession: cloud.remove,
}));
vi.mock("@/assistant/context", () => ({
  parseAppRoute: () => ({ kind: "settings" }),
  loadWriterContext: context.load,
}));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false }) }));

beforeEach(() => {
  resetAssistantSessionIndex(null);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
  cloud.list.mockResolvedValue([]);
  cloud.save.mockResolvedValue({ fileId: "saved-file", revision: "r1" });
  cloud.load.mockReset();
  cloud.remove.mockReset();
  context.load.mockReset().mockResolvedValue({ title: "Narrarium", summary: "", loadedFilePaths: [], availableFiles: [] });
  service.run.mockImplementation(async (input) => {
    input.onText?.("streamed reply");
    return { id: "assistant-reply", role: "assistant", text: "streamed reply", action: {
      kind: "navigate", to: "/app/settings", toolId: "navigate", owner: "writer", repo: "novel", branch: "main",
      sourceRevision: "head", sourceRevisions: {}, generatedAt: new Date().toISOString(),
    } };
  });
  useAuthStore.setState({ user: { provider: "google", email: "writer@example.com", name: "Writer", picture: "" }, accessToken: "token", accessTokenExpiry: Date.now() + 60_000 });
  useAssistantStore.setState({ open: true, busy: false, sessions: [], sessionAccountIdentity: null, sessionsLoading: false, currentSession: createEmptyAssistantSession("Narrarium") });
});

afterEach(() => cleanup());

describe("AssistantPanel shared session mutations", () => {
  it("creates a chat and records stream and action mutations in the authoritative session", async () => {
    render(<MemoryRouter initialEntries={["/app/settings"]}><AssistantPanel /></MemoryRouter>);
    const before = useAssistantStore.getState().currentSession!;
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Hello Copilot" } });
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    await waitFor(() => expect(service.run).toHaveBeenCalledOnce());
    await waitFor(() => expect(useAssistantStore.getState().currentSession?.messages.some((message) => message.action?.kind === "navigate")).toBe(true));
    const after = useAssistantStore.getState().currentSession!;
    expect(after.messages.map((message) => message.text)).toEqual(["Hello Copilot", "streamed reply"]);
    expect(after.contentRevision).toBeGreaterThan(before.contentRevision ?? 0);
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));

    fireEvent.click(screen.getByTitle("assistant.newChat"));
    await act(async () => {});
    expect(useAssistantStore.getState().currentSession?.id).not.toBe(after.id);
  });

  it("captures account scope before asynchronous context preparation", async () => {
    let release!: (value: unknown) => void;
    render(<MemoryRouter initialEntries={["/app/settings"]}><AssistantPanel /></MemoryRouter>);
    const textbox = await screen.findByRole("textbox");
    await waitFor(() => expect(context.load).toHaveBeenCalled());
    context.load.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    fireEvent.change(textbox, { target: { value: "Prepare context" } });
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    useAuthStore.setState({ user: { provider: "google", email: "second@example.com", name: "Second", picture: "" } });
    release({ title: "Narrarium", summary: "", loadedFilePaths: [], availableFiles: [] });

    await waitFor(() => expect(service.run).toHaveBeenCalledOnce());
    expect(service.run.mock.calls[0][0].accountScope).toBe("google:writer@example.com");
  });

  it("opens and deletes a saved session through Panel controls", async () => {
    const saved = { ...createEmptyAssistantSession("Saved"), id: "saved-session", fileId: "saved-file", revision: "r1" };
    cloud.list.mockResolvedValue([{ id: saved.id, fileId: saved.fileId, revision: saved.revision, title: saved.title, contextTitle: saved.contextTitle, updatedAt: saved.updatedAt }]);
    cloud.load.mockResolvedValue(saved);
    cloud.remove.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useAssistantStore.setState({ sessions: [], sessionAccountIdentity: null, currentSession: null });
    render(<MemoryRouter initialEntries={["/app/settings"]}><AssistantPanel /></MemoryRouter>);
    await waitFor(() => expect(cloud.list).toHaveBeenCalled());
    await waitFor(() => expect(useAssistantStore.getState().sessions[0]?.id).toBe(saved.id));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "assistant.tabHistory" }), { button: 0 });
    fireEvent.click(screen.getByRole("tab", { name: "assistant.tabHistory" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "assistant.tabHistory" })).toHaveAttribute("data-state", "active"));
    fireEvent.click(await screen.findByText(saved.title));
    await waitFor(() => expect(cloud.load).toHaveBeenCalledOnce());
    expect(useAssistantStore.getState().currentSession?.id).toBe(saved.id);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "assistant.tabHistory" }), { button: 0 });
    fireEvent.click(screen.getByRole("tab", { name: "assistant.tabHistory" }));
    fireEvent.click(await screen.findByTitle(`assistant.deleteChat`));
    await waitFor(() => expect(cloud.remove).toHaveBeenCalledOnce());
    expect(useAssistantStore.getState().currentSession).toBeNull();
  });
});
