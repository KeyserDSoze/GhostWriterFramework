import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { BookConflictError, defaultDirector } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { DirectorPage } from "@/pages/DirectorPage";
import { useSaveStore } from "@/store/saveStore";
import type { BookEntry } from "@/types/settings";

const t = (key: string) => i18n.t(key) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const STRUCTURE = { title: "The Glass Harbor", language: "en", chapters: [], readerPersonas: [], loadedBranch: "main" };

const director = (name: string) => ({ ...defaultDirector("en"), name });
const file = (name: string, hash: string | null) => ({ profile: director(name), exists: hash !== null, hash });

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/director"]}>
      <Routes><Route path="/app/books/:bookId/director" element={<DirectorPage />} /></Routes>
    </MemoryRouter>
  );
}

const nameField = () => screen.getByLabelText(t("director.name")) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: t("director.save") }) as HTMLButtonElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.book = { ...BOOK };
  mocks.structure = { ...STRUCTURE };
  mocks.load.mockReset().mockResolvedValue(file("Saved director", "h1"));
  mocks.save.mockReset().mockResolvedValue({ hash: "h2" });
  mocks.toast.mockReset();
  mocks.reload.mockReset();
});

afterEach(() => {
  cleanup();
  useSaveStore.setState({ current: null });
});

describe("the director page and the settings being reloaded", () => {
  it("keeps what the author typed when the settings are replaced and the book object changes", async () => {
    const view = render(<Page />);
    await screen.findByDisplayValue("Saved director");
    fireEvent.change(nameField(), { target: { value: "My edit" } });
    fireEvent.change(screen.getByLabelText(t("director.priorities")), { target: { value: "Pace\nVoice" } });

    for (let reload = 0; reload < 3; reload += 1) {
      mocks.book = { ...BOOK };
      view.rerender(<Page />);
      await act(async () => undefined);
    }
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(nameField()).toHaveValue("My edit");
    expect(screen.getByLabelText(t("director.priorities"))).toHaveValue("Pace\nVoice");
    expect(screen.queryByText(t("director.changedElsewhere"))).not.toBeInTheDocument();
  });

  it("keeps the edits and offers to reload when the file changed underneath", async () => {
    const view = render(<Page />);
    await screen.findByDisplayValue("Saved director");
    fireEvent.change(nameField(), { target: { value: "My edit" } });

    mocks.load.mockResolvedValue(file("Changed on another device", "h9"));
    mocks.structure = undefined;
    view.rerender(<Page />);
    mocks.structure = { ...STRUCTURE };
    view.rerender(<Page />);

    const notice = await screen.findByText(t("director.changedElsewhere"));
    expect(notice.closest("[role=alert]")).toBeInTheDocument();
    expect(nameField()).toHaveValue("My edit");

    fireEvent.click(screen.getByRole("button", { name: t("director.reloadFile") }));
    await waitFor(() => expect(nameField()).toHaveValue("Changed on another device"));
    expect(screen.queryByText(t("director.changedElsewhere"))).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("follows a newer file silently while the form has no unsaved edits", async () => {
    const view = render(<Page />);
    await screen.findByDisplayValue("Saved director");

    mocks.load.mockResolvedValue(file("Changed on another device", "h9"));
    mocks.structure = undefined;
    view.rerender(<Page />);
    mocks.structure = { ...STRUCTURE };
    view.rerender(<Page />);

    await waitFor(() => expect(nameField()).toHaveValue("Changed on another device"));
    expect(screen.queryByText(t("director.changedElsewhere"))).not.toBeInTheDocument();
  });

  it("shows another book's director when the page moves to another book", async () => {
    const view = render(<Page />);
    await screen.findByDisplayValue("Saved director");
    fireEvent.change(nameField(), { target: { value: "My edit" } });

    mocks.book = { ...BOOK, id: "book-2", repo: "book-2" };
    mocks.load.mockResolvedValue(file("Second book director", "k1"));
    view.rerender(<Page />);
    await waitFor(() => expect(nameField()).toHaveValue("Second book director"));
  });
});

describe("saving the director", () => {
  it("saves against the version that was loaded, then against the one it just saved", async () => {
    render(<Page />);
    await screen.findByDisplayValue("Saved director");
    fireEvent.change(nameField(), { target: { value: "My edit" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ branch: "main", expectedHash: "h1", profile: expect.objectContaining({ name: "My edit" }) }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("director.saved") }));

    fireEvent.change(nameField(), { target: { value: "Second edit" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ expectedHash: "h2" }));
  });

  it("expects the file to be absent when the page was opened before it existed", async () => {
    mocks.load.mockResolvedValue(file("Default director", null));
    render(<Page />);
    await screen.findByDisplayValue("Default director");
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ expectedHash: null }));
  });

  it("tells the author, and keeps the edits, when someone changed the file since the page was opened", async () => {
    mocks.save.mockRejectedValue(new BookConflictError("File changed since it was read: director.md"));
    render(<Page />);
    await screen.findByDisplayValue("Saved director");
    fireEvent.change(nameField(), { target: { value: "My edit" } });
    fireEvent.click(saveButton());

    await screen.findByText(t("director.changedElsewhere"));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("director.saveFailed"), description: t("director.changedElsewhere"), variant: "destructive" }));
    expect(nameField()).toHaveValue("My edit");
    expect(saveButton()).toBeEnabled();

    mocks.load.mockResolvedValue(file("Changed on another device", "h9"));
    fireEvent.click(screen.getByRole("button", { name: t("director.reloadFile") }));
    await waitFor(() => expect(nameField()).toHaveValue("Changed on another device"));
    expect(screen.queryByText(t("director.changedElsewhere"))).not.toBeInTheDocument();
  });

  it("still reports other save failures as they are", async () => {
    mocks.save.mockRejectedValue(new Error("disk full"));
    render(<Page />);
    await screen.findByDisplayValue("Saved director");
    fireEvent.change(nameField(), { target: { value: "My edit" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("director.saveFailed"), description: "Error: disk full" })));
    expect(screen.queryByText(t("director.changedElsewhere"))).not.toBeInTheDocument();
  });
});
