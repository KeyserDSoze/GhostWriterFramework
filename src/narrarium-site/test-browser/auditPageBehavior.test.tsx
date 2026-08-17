import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditPage } from "@/pages/AuditPage";

const mocks = vi.hoisted(() => {
  const target = {
    scope: "book",
    bookId: "book-id",
    title: "Test Book",
    targetId: "book:book-id",
    reportPath: "audit/book.md",
    sourcePath: "book.md",
    href: "/app/books/book-id/audit",
    sourceHref: "/app/books/book-id",
  };
  return {
    location: { pathname: "/app/books/book-id/audit", search: "?action=run", hash: "", key: "nav-1", state: null },
    navigate: vi.fn(),
    reload: vi.fn(),
    toast: vi.fn(),
    loadAuditReport: vi.fn(),
    runAudit: vi.fn(),
    updateAuditFinding: vi.fn(),
    target,
  };
});

vi.mock("react-router-dom", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-router-dom")>(),
  useLocation: () => mocks.location,
  useNavigate: () => mocks.navigate,
  useParams: () => ({ bookId: "book-id" }),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main" }) }));
vi.mock("@/store/pageActionsStore", () => ({ useRegisterPageActions: () => undefined }));

vi.mock("@/store/settingsStore", () => ({
  useSettingsStore: () => ({
    settings: {
      ui: { language: "en" },
      aiIntegrations: [{ id: "ai", name: "AI", provider: "openai", apiKey: "key", chatModels: [{ id: "audit", name: "model", capabilities: ["audit"] }] }],
    },
  }),
}));

vi.mock("@/hooks/useBookStructure", () => ({
  useBookStructure: () => ({
    book: { id: "book-id", owner: "owner", repo: "repo", name: "Book", tokenIndex: null, bookToken: "token", addedAt: "2026-01-01T00:00:00.000Z" },
    structure: { title: "Test Book", chapters: [], loadedBranch: "main" },
    loading: false,
    error: "",
    reload: mocks.reload,
  }),
}));

vi.mock("@/narrarium/audit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/narrarium/audit")>(),
  resolveAuditTarget: () => mocks.target,
  loadAuditReport: mocks.loadAuditReport,
  runAudit: mocks.runAudit,
  updateAuditFinding: mocks.updateAuditFinding,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuditPage query execution", () => {
  it("never runs an audit from a crafted replayable query", async () => {
    mocks.location = { pathname: "/app/books/book-id/audit", search: "?action=run", hash: "", key: "nav-1", state: null };
    mocks.navigate.mockReset();
    mocks.reload.mockReset();
    mocks.toast.mockReset();
    mocks.loadAuditReport.mockReset().mockResolvedValue(null);
    mocks.runAudit.mockReset().mockResolvedValue({
      findings: [],
      stale: false,
      auditResult: "passed",
      executiveSummary: "No issues.",
      recommendedFixOrder: [],
      finalAssessment: "Passed.",
      passCount: 1,
      chunkCount: 1,
    });

    const view = render(<AuditPage />);
    await waitFor(() => expect(mocks.loadAuditReport).toHaveBeenCalledTimes(1));
    expect(mocks.runAudit).not.toHaveBeenCalled();

    view.rerender(<AuditPage />);
    expect(mocks.runAudit).not.toHaveBeenCalled();

    mocks.location = { ...mocks.location, key: "nav-2" };
    view.rerender(<AuditPage />);
    expect(mocks.runAudit).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("does not replace dirty notes when save and discard are declined", async () => {
    const report = {
      findings: [{
        id: "finding-1",
        severity: "high",
        certainty: "confirmed",
        category: "continuity",
        status: "open",
        description: "Mismatch",
        evidence: "Evidence",
        conflictExplanation: "Conflict",
        correctionSuggestion: "Fix",
        authorNote: "original",
        position: { textOffset: 0, excerpt: "Evidence" },
        structuredSourceRef: { path: "book.md", heading: "Story" },
      }],
      stale: false,
      auditResult: "failed",
      executiveSummary: "Issue.",
      recommendedFixOrder: [],
      finalAssessment: "Fix it.",
      passCount: 1,
      chunkCount: 1,
    };
    mocks.loadAuditReport.mockReset().mockResolvedValue(report);
    mocks.runAudit.mockReset();
    mocks.updateAuditFinding.mockReset();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(false);

    render(<AuditPage />);
    const note = await screen.findByDisplayValue("original");
    fireEvent.change(note, { target: { value: "unsaved" } });
    expect(screen.getByRole("button", { name: "audit.actions.openSource" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "audit.actions.rerun" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(mocks.updateAuditFinding).not.toHaveBeenCalled();
    expect(mocks.runAudit).not.toHaveBeenCalled();
    expect(note).toHaveValue("unsaved");
  });

  it("does not rerun or discard notes when the requested save fails", async () => {
    const report = {
      findings: [{
        id: "finding-1", severity: "high", certainty: "confirmed", category: "continuity", status: "open",
        description: "Mismatch", evidence: "Evidence", conflictExplanation: "Conflict", correctionSuggestion: "Fix", authorNote: "original",
        position: { textOffset: 0, excerpt: "Evidence" }, structuredSourceRef: { path: "book.md", heading: "Story" },
      }],
      stale: false, auditResult: "failed", executiveSummary: "Issue.", recommendedFixOrder: [], finalAssessment: "Fix it.", passCount: 1, chunkCount: 1,
    };
    mocks.loadAuditReport.mockReset().mockResolvedValue(report);
    mocks.runAudit.mockReset();
    mocks.updateAuditFinding.mockReset().mockRejectedValue(new Error("save failed"));
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);

    render(<AuditPage />);
    const note = await screen.findByDisplayValue("original");
    fireEvent.change(note, { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "audit.actions.rerun" }));

    await waitFor(() => expect(mocks.updateAuditFinding).toHaveBeenCalledOnce());
    expect(mocks.runAudit).not.toHaveBeenCalled();
    expect(note).toHaveValue("unsaved");
  });
});
