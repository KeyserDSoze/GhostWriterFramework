import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { createEmptyAssistantSession, useAssistantStore } from "@/assistant/store";
import { useAuthStore } from "@/store/authStore";
import { useBooksStore } from "@/store/booksStore";
import { resetAssistantSessionIndex } from "@/assistant/sessionIndex";

// The Copilot says which page it works on first: on a page that has a contract with it, the line above the composer names the page, and the composer is
// described by it (with what it means), in English and in Italian. On any other page there is no such line.

vi.mock("@/assistant/service", () => ({ appendAssistantNote: vi.fn(), applyParagraphRewrite: vi.fn(), compactAssistantSession: vi.fn(async ({ session }) => session), runAssistantPrompt: vi.fn() }));
vi.mock("@/assistant/chatCloud", async (original) => ({ ...await original<typeof import("@/assistant/chatCloud")>(), listAssistantSessions: vi.fn(async () => []), saveAssistantSession: vi.fn(async () => ({ fileId: "f", revision: "r" })), loadAssistantSession: vi.fn(), deleteAssistantSession: vi.fn() }));
vi.mock("@/assistant/chatLocal", () => ({ listLocalChatSessions: vi.fn(async () => []), saveLocalChatSession: vi.fn(async () => undefined), loadLocalChatSession: vi.fn(), deleteLocalChatSession: vi.fn(async () => undefined) }));
vi.mock("@/assistant/context", async (original) => ({ ...await original<typeof import("@/assistant/context")>(), loadWriterContext: vi.fn(async () => ({ title: "Narrarium", summary: "", loadedFilePaths: [], availableFiles: [], route: { kind: "other", pathname: "/" } })) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false }) }));

beforeEach(async () => {
  resetAssistantSessionIndex(null);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "writer-id", email: "writer@example.com", name: "Writer", picture: "" }, accessToken: "token", accessTokenExpiry: Date.now() + 60_000 });
  useAssistantStore.setState({ open: true, busy: false, sessions: [], sessionAccountIdentity: null, sessionsLoading: false, currentSession: createEmptyAssistantSession("Narrarium") });
  await i18n.changeLanguage("en");
});

afterEach(() => cleanup());

function panelAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><AssistantPanel /></MemoryRouter>);
}

describe("the page the Copilot works on", () => {
  it("is named above the composer on the Simulated readers page, and describes the composer with what it means", async () => {
    panelAt("/app/books/book-1/simulated-readers");
    const scope = await screen.findByText("Working on: Simulated readers");
    const line = scope.closest("[data-copilot-scope]")!;
    expect(line).toHaveAttribute("data-copilot-scope", "readers");
    const composer = document.querySelector<HTMLTextAreaElement>("textarea[aria-describedby]");
    expect(line.querySelector(`#${CSS.escape(composer!.getAttribute("aria-describedby")!)}`)).not.toBeNull();
    expect(composer).toHaveAccessibleDescription("Working on: Simulated readers. Requests are about this page first; everything else the Copilot can do stays available.");
  });

  it("speaks Italian with an Italian app", async () => {
    await i18n.changeLanguage("it");
    panelAt("/app/books/book-1/simulated-readers");
    expect(await screen.findByText("Sto lavorando su: Lettori simulati")).toBeInTheDocument();
  });

  it("names every page that works with it, and the entry of the canon that is open", async () => {
    useBooksStore.setState({ structures: { "book-1": { characters: [{ path: "characters/mara.md", sha: "x", size: 1, name: "Mara Vell" }], locations: [], factions: [], items: [] } as never } });
    for (const [path, label] of [["ghostwriters", "Ghostwriters"], ["director", "Director"], ["evaluation-style", "Evaluation style"], ["autopilot/settings", "Autopilot configuration"], ["assets", "Assets"], ["canon/characters/mara", "Canon · Mara Vell"]]) {
      panelAt(`/app/books/book-1/${path}`);
      expect(await screen.findByText(`Working on: ${label}`)).toBeInTheDocument();
      cleanup();
    }
  });

  it("says nothing on a page without a contract, a secret's among them", async () => {
    for (const path of ["/app/settings", "/app/books/book-1/canon/secrets/the-lie", "/app/books/book-1/chapters/001-dawn"]) {
      panelAt(path);
      await screen.findByRole("dialog");
      expect(document.querySelector("[data-copilot-scope]")).toBeNull();
      expect(document.querySelector("textarea[aria-describedby]")).toBeNull();
      cleanup();
    }
  });
});
