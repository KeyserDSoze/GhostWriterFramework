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
vi.mock("@/narrarium/readerEvaluations", () => ({
  loadReaderPersonas: (...args: unknown[]) => mocks.load(...args),
  saveReaderPersona: (...args: unknown[]) => mocks.save(...args),
  deleteReaderPersonaOverride: vi.fn(),
  findOrphanReaderEvaluationPaths: () => [],
}));

import { mergeReaderPersonas, parseReaderPersona } from "narrarium-engine";
import i18n from "@/i18n";
import { ReaderPersonasPage } from "@/pages/ReaderPersonasPage";
import { triggerCurrentSave, useSaveStore } from "@/store/saveStore";
import type { BookEntry } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const STRUCTURE = { title: "The Glass Harbor", language: "en", chapters: [], readerPersonas: [], auditFiles: [], loadedBranch: "main" };

const MAYBE = "---\ntype: reader-persona\nid: reader:custom:night-reader\nname: Night Reader\nenabled: maybe\nseverity: 6\n---\nReads at night.";
const CALM = "---\ntype: reader-persona\nid: reader:custom:calm-reader\nname: Calm Reader\nenabled: true\nseverity: 4\n---\nReads calmly.";
const BROKEN_YAML = "---\nid: reader:custom:night-reader\nname: Night: Reader\n---\nReads at night.";

const profiles = (nightReader = MAYBE) => mergeReaderPersonas("en", [parseReaderPersona("night-reader", nightReader), parseReaderPersona("calm-reader", CALM)]);

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/simulated-readers"]}>
      <Routes><Route path="/app/books/:bookId/simulated-readers" element={<ReaderPersonasPage />} /></Routes>
    </MemoryRouter>
  );
}

const notice = (count: number) => screen.getByRole("status", { name: t("profileFile.warningsTitle", { count }) });
const saveButton = () => screen.getByRole("button", { name: t("common.save") }) as HTMLButtonElement;
/** The button of a reader in the list: its name starts with the reader's, unlike the "Move up: …" buttons next to it. */
const card = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name}`) });
const openReader = async (name: string) => {
  fireEvent.click(await card(name));
  await screen.findByRole("heading", { name });
};

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.book = { ...BOOK };
  mocks.structure = { ...STRUCTURE };
  mocks.load.mockReset().mockImplementation(async () => profiles());
  mocks.save.mockReset().mockResolvedValue("personas/night-reader.md");
  mocks.toast.mockReset();
  mocks.reload.mockReset();
});

afterEach(() => {
  cleanup();
  useSaveStore.setState({ current: null });
  vi.restoreAllMocks();
});

describe("the simulated readers page, when a reader file has problems", () => {
  it("shows what could not be read at the top of that reader's form, in a status that does not interrupt", async () => {
    render(<Page />);
    await openReader("Night Reader");
    const warnings = notice(1);
    expect(warnings).toHaveTextContent("personas/night-reader.md: enabled «maybe» is neither yes nor no: yes is used");
    expect(within(warnings).getAllByRole("listitem")).toHaveLength(1);
    expect(warnings).toHaveTextContent(t("profileFile.warningsBody"));
    expect(warnings.compareDocumentPosition(screen.getByDisplayValue("Night Reader")) & Node.DOCUMENT_POSITION_FOLLOWING, "above the first field").toBeTruthy();
  });

  it("shows nothing for a reader that is fine, and the notice is gone when another reader is opened", async () => {
    render(<Page />);
    await openReader("Night Reader");
    expect(notice(1)).toBeInTheDocument();
    await openReader("Calm Reader");
    expect(screen.queryByRole("status", { name: /problem/i })).not.toBeInTheDocument();
  });

  it("is in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    render(<Page />);
    await openReader("Night Reader");
    expect(notice(1)).toHaveTextContent("Questo file ha un problema");
    await i18n.changeLanguage("en");
  });

  it("marks the reader in the list with words, so a file that needs correcting is found without opening each one", async () => {
    render(<Page />);
    const night = await card("Night Reader");
    expect(within(night).getByText(t("readerPersonas.hasProblems"))).toBeInTheDocument();
    const calm = await card("Calm Reader");
    expect(within(calm).queryByText(t("readerPersonas.hasProblems"))).not.toBeInTheDocument();
  });

  it("asks before saving over it, and writes nothing when the author says no", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Page />);
    await openReader("Night Reader");
    fireEvent.change(screen.getByDisplayValue("Night Reader"), { target: { value: "Night Reader II" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(t("profileFile.saveConfirm")));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(notice(1)).toBeInTheDocument();
  });

  it("writes when the author says yes, and the notice goes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Page />);
    await openReader("Night Reader");
    fireEvent.change(screen.getByDisplayValue("Night Reader"), { target: { value: "Night Reader II" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0][0].profile.name).toBe("Night Reader II");
    await waitFor(() => expect(screen.queryByRole("status", { name: /problem/i })).not.toBeInTheDocument());
    expect(within(await card("Night Reader II")).queryByText(t("readerPersonas.hasProblems"))).not.toBeInTheDocument();
  });

  it("asks when the save comes from the shortcut or the menu", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Page />);
    await openReader("Night Reader");
    fireEvent.change(screen.getByDisplayValue("Night Reader"), { target: { value: "Night Reader II" } });
    await waitFor(() => expect(useSaveStore.getState().current?.dirty).toBe(true));
    expect(await triggerCurrentSave()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("asks before switching the reader on or off, which writes the whole file, and leaves the switch as it was when the author says no", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Page />);
    const night = (await card("Night Reader")).parentElement as HTMLElement;
    const toggle = within(night).getByRole("switch");
    const before = toggle.getAttribute("aria-checked");
    fireEvent.click(toggle);
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(t("profileFile.saveConfirm")));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(within(night).getByRole("switch").getAttribute("aria-checked")).toBe(before);
  });

  it("switches it when the author says yes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Page />);
    const night = (await card("Night Reader")).parentElement as HTMLElement;
    const before = within(night).getByRole("switch").getAttribute("aria-checked");
    fireEvent.click(within(night).getByRole("switch"));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0][0].profile.enabled).toBe(before !== "true");
  });

  it("asks before replacing a file whose YAML cannot be read", async () => {
    mocks.load.mockImplementation(async () => profiles(BROKEN_YAML));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Page />);
    fireEvent.click(await card("night-reader"));
    await screen.findByRole("status", { name: t("profileFile.warningsTitle", { count: 1 }) });
    expect(notice(1)).toHaveTextContent("personas/night-reader.md: the frontmatter is not valid YAML");
    fireEvent.change(screen.getByDisplayValue("night-reader"), { target: { value: "Night Reader" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not ask when the file is as it says", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Page />);
    await openReader("Calm Reader");
    fireEvent.change(screen.getByDisplayValue("Calm Reader"), { target: { value: "Calm Reader II" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });
});
