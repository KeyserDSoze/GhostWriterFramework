import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
}));

describe("AuditPage query execution", () => {
  it("runs once per navigation key and allows a later identical run query", async () => {
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
    await waitFor(() => expect(mocks.runAudit).toHaveBeenCalledTimes(1));

    view.rerender(<AuditPage />);
    await waitFor(() => expect(mocks.runAudit).toHaveBeenCalledTimes(1));

    mocks.location = { ...mocks.location, key: "nav-2" };
    view.rerender(<AuditPage />);
    await waitFor(() => expect(mocks.runAudit).toHaveBeenCalledTimes(2));
  });
});
