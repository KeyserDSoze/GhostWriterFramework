import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: null as unknown,
  load: vi.fn(),
  save: vi.fn(),
  toast: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: mocks.reload }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/narrarium/director", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/narrarium/director")>()), loadDirectorProfile: mocks.load, saveDirectorProfile: mocks.save }));
vi.mock("@/narrarium/readerPanel", () => ({ loadReaderPersonas: async () => [] }));
vi.mock("@/autopilot/browserStore", () => ({ createBrowserBookStore: () => ({ list: async () => [], read: async () => null, commit: async () => ({}) }) }));

import { defaultDirector, parseDirector } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { DirectorPage } from "@/pages/DirectorPage";
import { triggerCurrentSave, useSaveStore } from "@/store/saveStore";
import type { BookEntry } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const STRUCTURE = { title: "The Glass Harbor", language: "en", chapters: [], readerPersonas: [], loadedBranch: "main" };

/** The director the engine reads from a file with a typo in it: the file as it says, with a warning for what it could not read. */
const TYPO = "---\nname: Ada\nautonomy: sometimes\nstrictness: 9\n---\nVision";
const BROKEN_YAML = "---\nname: Ada: the strict\nstrictness: 9\n---\nVision";
const withTypo = (raw = TYPO) => ({ profile: parseDirector(raw, "en"), exists: true, hash: "h1" });
const clean = () => ({ profile: { ...defaultDirector("en"), name: "Saved director" }, exists: true, hash: "h1" });

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/director"]}>
      <Routes><Route path="/app/books/:bookId/director" element={<DirectorPage />} /></Routes>
    </MemoryRouter>
  );
}

const nameField = () => screen.getByLabelText(t("director.name")) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: t("director.save") }) as HTMLButtonElement;
const notice = (count: number) => screen.getByRole("status", { name: t("profileFile.warningsTitle", { count }) });

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.book = { ...BOOK };
  mocks.structure = { ...STRUCTURE };
  mocks.load.mockReset().mockResolvedValue(withTypo());
  mocks.save.mockReset().mockResolvedValue({ hash: "h2" });
  mocks.toast.mockReset();
  mocks.reload.mockReset();
});

afterEach(() => {
  cleanup();
  useSaveStore.setState({ current: null });
  vi.restoreAllMocks();
});

describe("the director page, when director.md has problems", () => {
  it("shows what could not be read at the top of the form, in a status that does not interrupt", async () => {
    render(<Page />);
    await screen.findByDisplayValue("Ada");
    const warnings = notice(1);
    expect(warnings).toHaveTextContent("director.md: autonomy «sometimes» is not one of full, ask-on-critical, ask-always: ask-on-critical is used");
    expect(within(warnings).getAllByRole("listitem")).toHaveLength(1);
    expect(warnings).toHaveTextContent(t("profileFile.warningsBody"));
    expect(warnings.getAttribute("role")).toBe("status");
    expect(warnings.compareDocumentPosition(nameField()) & Node.DOCUMENT_POSITION_FOLLOWING, "above the first field").toBeTruthy();
  });

  it("says each problem on its own line, and how many there are", async () => {
    mocks.load.mockResolvedValue(withTypo("---\nname: Ada\nautonomy: sometimes\nstrictness: very\n---\nVision"));
    render(<Page />);
    await screen.findByDisplayValue("Ada");
    expect(within(notice(2)).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows the notice in Italian, with the problems as the engine wrote them", async () => {
    await i18n.changeLanguage("it");
    render(<Page />);
    await screen.findByDisplayValue("Ada");
    const warnings = notice(1);
    expect(warnings).toHaveTextContent("Questo file ha un problema");
    expect(warnings).toHaveTextContent("director.md: autonomy «sometimes» is not one of");
    await i18n.changeLanguage("en");
  });

  it("shows nothing for a file that is as it says", async () => {
    mocks.load.mockResolvedValue(clean());
    render(<Page />);
    await screen.findByDisplayValue("Saved director");
    expect(screen.queryByRole("status", { name: /problem/i })).not.toBeInTheDocument();
    expect(screen.queryByText(t("profileFile.warningsBody"))).not.toBeInTheDocument();
  });

  it("asks before saving over it, and saves nothing when the author says no", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Page />);
    await screen.findByDisplayValue("Ada");
    fireEvent.change(nameField(), { target: { value: "Ada Strict" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(t("profileFile.saveConfirm")));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(notice(1)).toBeInTheDocument();
    expect(nameField()).toHaveValue("Ada Strict");
    expect(saveButton()).toBeEnabled();
  });

  it("saves when the author says yes, and the notice goes with the problem it described", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Page />);
    await screen.findByDisplayValue("Ada");
    fireEvent.change(nameField(), { target: { value: "Ada Strict" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("status", { name: /problem/i })).not.toBeInTheDocument());

    // The file is now as the form says: the next save is not asked about.
    fireEvent.change(nameField(), { target: { value: "Ada Stricter" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("asks when the save comes from the shortcut or the menu, not only from the button", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Page />);
    await screen.findByDisplayValue("Ada");
    fireEvent.change(nameField(), { target: { value: "Ada Strict" } });
    await waitFor(() => expect(useSaveStore.getState().current?.dirty).toBe(true));
    expect(await triggerCurrentSave()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("asks before replacing a file whose YAML cannot be read, which would lose every key it holds", async () => {
    mocks.load.mockResolvedValue(withTypo(BROKEN_YAML));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Page />);
    await screen.findByRole("status", { name: t("profileFile.warningsTitle", { count: 1 }) });
    expect(screen.getByRole("status", { name: /problem/i })).toHaveTextContent("the frontmatter is not valid YAML");
    fireEvent.change(nameField(), { target: { value: "Another name" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not ask when the file is as it says", async () => {
    mocks.load.mockResolvedValue(clean());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Page />);
    await screen.findByDisplayValue("Saved director");
    fireEvent.change(nameField(), { target: { value: "My edit" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });
});
