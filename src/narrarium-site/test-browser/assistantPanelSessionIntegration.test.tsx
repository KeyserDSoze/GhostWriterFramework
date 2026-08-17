import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { AssistantPanel, diffRevertRevisionsMatch, speechRecognitionResultDelta } from "@/components/assistant/AssistantPanel";
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
vi.mock("@/assistant/context", async (original) => ({
  ...await original<typeof import("@/assistant/context")>(),
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
  context.load.mockReset().mockResolvedValue({ title: "Narrarium", summary: "", loadedFilePaths: [], availableFiles: [], route: { kind: "settings" } });
  service.run.mockImplementation(async (input) => {
    input.onText?.("streamed reply");
    return { id: "assistant-reply", role: "assistant", text: "streamed reply", action: {
      kind: "navigate", to: "/app/settings", toolId: "navigate", owner: "writer", repo: "novel", branch: "main",
      sourceRevision: "head", sourceRevisions: {}, generatedAt: new Date().toISOString(),
    } };
  });
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "writer-id", email: "writer@example.com", name: "Writer", picture: "" }, accessToken: "token", accessTokenExpiry: Date.now() + 60_000 });
  useAssistantStore.setState({ open: true, busy: false, sessions: [], sessionAccountIdentity: null, sessionsLoading: false, currentSession: createEmptyAssistantSession("Narrarium") });
});

afterEach(() => cleanup());

function RouteProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><span data-testid="pathname">{location.pathname}</span><button type="button" onClick={() => navigate("/app/settings")}>Exit secret route</button></>;
}

describe("AssistantPanel shared session mutations", () => {
  it("names the dialog and chat log and closes with Escape", async () => {
    render(<MemoryRouter initialEntries={["/app/settings"]}><AssistantPanel /></MemoryRouter>);
    expect(await screen.findByRole("dialog", { name: "assistant.title" })).toHaveAccessibleDescription("assistant.copilotDialogDescription");
    const log = screen.getByRole("log", { name: "assistant.chatLog" });
    expect(log).toHaveAttribute("aria-live", "polite");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(useAssistantStore.getState().open).toBe(false));
  });

  it("keeps Live Voice controls in a scrollable responsive region", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
    render(<MemoryRouter initialEntries={["/app/settings"]}><AssistantPanel /></MemoryRouter>);
    fireEvent.click((await screen.findByRole("dialog", { name: "assistant.title" })).querySelector<HTMLButtonElement>('[title="assistant.liveVoice"]')!);
    const dialog = screen.getByRole("dialog", { name: "assistant.liveVoice" });
    expect(dialog).toHaveAccessibleDescription("assistant.voiceDialogDescription");
    expect(screen.getByTestId("live-voice-scroll")).toHaveClass("overflow-y-auto");
    expect(screen.getByRole("button", { name: "assistant.talk" })).toBeInTheDocument();
  });

  it("gives attachment removal a localized filename label", async () => {
    const session = createEmptyAssistantSession("Narrarium");
    session.attachments = [{ id: "attachment", name: "chapter.md", mimeType: "text/markdown", kind: "text", textContent: "Text", sizeBytes: 4 }];
    useAssistantStore.setState({ currentSession: session });
    render(<MemoryRouter initialEntries={["/app/settings"]}><AssistantPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "assistant.removeAttachment" }));
    expect(useAssistantStore.getState().currentSession?.attachments).toHaveLength(0);
  });

  it("processes only newly reported browser speech results", () => {
    const result = (text: string) => Object.assign([{ transcript: text }], { isFinal: true });
    expect(speechRecognitionResultDelta([result("Hello"), result("world")], 1)).toEqual({ all: "Hello world", delta: "world", hasFinal: true });
  });

  it("rejects a revert when either confirmed branch revision changed", () => {
    const pending = { sourceHash: "source-1", destinationHash: "destination-1" };
    expect(diffRevertRevisionsMatch(pending, "source-1", "destination-1")).toBe(true);
    expect(diffRevertRevisionsMatch(pending, "source-2", "destination-1")).toBe(false);
    expect(diffRevertRevisionsMatch(pending, "source-1", "destination-2")).toBe(false);
  });

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
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "second-id", email: "second@example.com", name: "Second", picture: "" } });
    release({ title: "Narrarium", summary: "", loadedFilePaths: [], availableFiles: [], route: { kind: "settings" } });

    await waitFor(() => expect(service.run).toHaveBeenCalledOnce());
    expect(service.run.mock.calls[0][0].accountScope).toBe("google:writer-id");
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

  it("clears secret-bearing history when switching sessions on a lower-access route", async () => {
    render(<MemoryRouter initialEntries={["/app/settings"]}><AssistantPanel /></MemoryRouter>);
    const secret = createEmptyAssistantSession("Secret");
    secret.sensitiveSecretPaths = ["secrets/truth.md"];
    secret.messages = [{ id: "secret-message", role: "assistant", text: "Hidden truth" }];
    secret.compactSummary = "Hidden summary";
    secret.archive = { summary: "Hidden summary", messageCount: 1, actions: [], attachments: [] };
    secret.losslessSegments = [{ format: "narrarium-assistant-chat-segment", version: 1, id: "secret-segment", createdAt: new Date().toISOString(), messages: [{ id: "archived-secret", role: "assistant", text: "Archived truth" }], attachments: [] }];

    act(() => useAssistantStore.getState().setCurrentSession(secret));

    await waitFor(() => expect(useAssistantStore.getState().currentSession?.sensitiveSecretPaths).toEqual([]));
    const cleared = useAssistantStore.getState().currentSession!;
    expect(cleared.messages.map((message) => message.text).join(" ")).not.toContain("Hidden truth");
    expect(cleared.compactSummary).toBe("");
    expect(cleared.archive?.summary).toBe("");
    expect(cleared.losslessSegments).toEqual([]);
  });

  it("aborts a delayed secret request on route exit and discards late text and actions", async () => {
    let release!: () => void;
    let requestSignal!: AbortSignal;
    context.load.mockResolvedValue({
      title: "Secret",
      summary: "Author-only secret",
      loadedFilePaths: ["secrets/truth.md"],
      availableFiles: [],
      route: { kind: "canon", bookId: "book", section: "secrets", slug: "truth" },
      book: null,
      structure: null,
      chapter: null,
      paragraph: null,
      noteTargetPath: null,
      branch: "main",
      branchReady: true,
    });
    service.run.mockImplementationOnce((input) => new Promise((resolve) => {
      requestSignal = input.signal;
      release = () => {
        input.onText?.("late hidden truth");
        resolve({ id: "late-secret", role: "assistant", text: "late hidden truth", action: {
          kind: "navigate", to: "/app/costs", toolId: "navigate", owner: "writer", repo: "novel", branch: "main",
          sourceRevision: "head", sourceRevisions: {}, generatedAt: new Date().toISOString(),
        } });
      };
    }));

    render(<MemoryRouter initialEntries={["/app/books/book/canon/secrets/truth"]}><RouteProbe /><AssistantPanel /></MemoryRouter>);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Tell me the hidden truth" } });
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    await waitFor(() => expect(service.run).toHaveBeenCalledOnce());
    expect(useAssistantStore.getState().currentSession?.sensitiveSecretPaths).toEqual(["secrets/truth.md"]);

    fireEvent.click(screen.getByText("Exit secret route"));
    await waitFor(() => expect(requestSignal.aborted).toBe(true));
    await waitFor(() => expect(useAssistantStore.getState().currentSession?.sensitiveSecretPaths).toEqual([]));
    act(() => release());
    await act(async () => {});

    expect(screen.getByTestId("pathname")).toHaveTextContent("/app/settings");
    expect(useAssistantStore.getState().currentSession?.messages.some((message) => message.text.includes("late hidden truth") || message.action)).toBe(false);
  });
});
