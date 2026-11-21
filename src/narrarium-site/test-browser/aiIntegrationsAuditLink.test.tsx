import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
    location: { pathname: "/app/books/book-id/audit", search: "", hash: "", key: "nav-1", state: null },
    navigate: vi.fn(),
    toast: vi.fn(),
    settings: {} as unknown,
    target,
  };
});

vi.mock("react-router-dom", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-router-dom")>(),
  useLocation: () => mocks.location,
  useNavigate: () => mocks.navigate,
  useParams: () => ({ bookId: "book-id" }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main" }) }));
vi.mock("@/store/pageActionsStore", () => ({ useRegisterPageActions: () => undefined }));
vi.mock("@/store/settingsStore", () => ({ useSettingsStore: () => ({ settings: mocks.settings }) }));
vi.mock("@/hooks/useBookStructure", () => ({
  useBookStructure: () => ({
    book: { id: "book-id", owner: "owner", repo: "repo", name: "Book", tokenIndex: null, bookToken: "token", addedAt: "2026-01-01T00:00:00.000Z" },
    structure: { title: "Test Book", chapters: [], loadedBranch: "main" },
    loading: false,
    error: "",
    reload: vi.fn(),
  }),
}));
vi.mock("@/narrarium/audit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/narrarium/audit")>(),
  resolveAuditTarget: () => mocks.target,
  loadAuditReport: async () => null,
}));

import i18n from "@/i18n";
import { AuditPage } from "@/pages/AuditPage";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const t = (key: string) => i18n.t(key) as string;
const AI = { id: "ai", name: "AI", provider: "openai", apiKey: "key", chatModels: [{ id: "audit", name: "model", capabilities: ["audit"] }] };

async function open(language: Language, aiIntegrations: unknown[]) {
  await i18n.changeLanguage(language);
  mocks.navigate.mockReset();
  mocks.settings = { ui: { language }, aiIntegrations };
  render(<AuditPage />);
}

vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => i18n.changeLanguage("en"));

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("the Audit page without an executable model", () => {
  it.each(LANGUAGES)("opens AI Integrations from the missing-model alert (%s)", async (language) => {
    await open(language, []);
    const alert = screen.getByText(t("audit.missingModel")).closest('[role="alert"]') as HTMLElement;
    const action = Array.from(alert.querySelectorAll("button")).find((button) => button.textContent === t("audit.actions.openAiIntegrations"))!;
    expect(action).toBeDefined();
    expect(action.textContent).toContain(t("settingsSection.aiIntegrationsTitle"));
    fireEvent.click(action);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith("/app/settings/ai-integrations");
  });

  it("shows no alert when an integration can run the Audit task", async () => {
    await open("en", [AI]);
    expect(screen.queryByText(t("audit.missingModel"))).not.toBeInTheDocument();
  });
});
