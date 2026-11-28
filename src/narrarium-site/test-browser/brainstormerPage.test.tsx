import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Outlet, Route, RouterProvider, Routes, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BookConflictError, brainstormerBoldnessBand, defaultBrainstormer, type BrainstormerProfile } from "narrarium-engine";

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
vi.mock("@/narrarium/brainstormer", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/narrarium/brainstormer")>()), loadBrainstormerProfile: mocks.load, saveBrainstormerProfile: mocks.save }));

import i18n from "@/i18n";
import { BrainstormerPage } from "@/pages/BrainstormerPage";
import { useDirtyNavigationGuard } from "@/hooks/useDirtyNavigationGuard";
import { useSaveStore } from "@/store/saveStore";
import type { BookEntry } from "@/types/settings";

// The Brainstormer as a character sheet: who it is, how bold it is, what it cares about and refuses, and its method. The design run of the autopilot reads it (`brainstormer.md`).

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const structureIn = (language: string) => ({ title: "The Glass Harbor", language, chapters: [], readerPersonas: [], loadedBranch: "main" });
const brainstormer = (patch: Partial<BrainstormerProfile> = {}): BrainstormerProfile => ({ ...defaultBrainstormer("en"), name: "Nora", ...patch });
const file = (profile: BrainstormerProfile, hash: string | null = "h1") => ({ profile, exists: hash !== null, hash });

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/brainstormer"]}>
      <Routes><Route path="/app/books/:bookId/brainstormer" element={<BrainstormerPage />} /></Routes>
    </MemoryRouter>
  );
}

const boldness = () => screen.getByRole("slider", { name: t("brainstormerPage.boldness.label") }) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: t("brainstormerPage.save") }) as HTMLButtonElement;
const discardButton = () => screen.getByRole("button", { name: t("brainstormerPage.bar.discard") }) as HTMLButtonElement;
const bar = () => screen.getByRole("group", { name: t("brainstormerPage.bar.label") });

async function open(profile = brainstormer(), hash: string | null = "h1", language = "en") {
  mocks.structure = structureIn(language);
  mocks.load.mockResolvedValue(file(profile, hash));
  render(<Page />);
  await screen.findByDisplayValue(profile.name);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.book = { ...BOOK };
  mocks.structure = structureIn("en");
  mocks.load.mockReset();
  mocks.save.mockReset().mockResolvedValue({ hash: "h2" });
  mocks.toast.mockReset();
  mocks.reload.mockReset();
});

afterEach(async () => {
  cleanup();
  useSaveStore.setState({ current: null });
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe.each(["en", "it"] as const)("the Brainstormer as a character sheet (%s)", (language) => {
  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage(language); });
  });

  it("is headed by its name and what it does, in the four sections of a sheet", async () => {
    await open(brainstormer({ name: "Nora Vance" }));
    expect(screen.getByRole("heading", { level: 1, name: "Nora Vance" })).toBeInTheDocument();
    expect(screen.getByText(t("brainstormerPage.description"))).toBeInTheDocument();
    for (const section of ["identity", "boldness", "cares", "method"]) expect(screen.getByRole("region", { name: t(`brainstormerPage.sections.${section}`) })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("brainstormerPage.open") })).toHaveAttribute("href", "/app/books/book-1/outline?tab=studio");
  });

  it("sets the boldness with a slider that says its value in words, which are the engine's four bands", async () => {
    await open(brainstormer({ boldness: 6 }));
    const slider = boldness();
    expect(slider).toHaveAttribute("aria-valuetext", t("brainstormerPage.boldness.value", { value: 6, caption: t("brainstormerPage.boldness.captions.balanced") }));
    expect(slider).toHaveAccessibleDescription(t("brainstormerPage.boldness.help"));
    for (const [value, band] of [[1, "prudent"], [3, "prudent"], [4, "balanced"], [7, "daring"], [8, "daring"], [9, "breaking"], [10, "breaking"]] as const) {
      expect(brainstormerBoldnessBand(value)).toBe(band);
      fireEvent.change(slider, { target: { value: String(value) } });
      expect(slider).toHaveAttribute("aria-valuetext", t("brainstormerPage.boldness.value", { value, caption: t(`brainstormerPage.boldness.captions.${band}`) }));
    }
    expect(screen.getByText(t("brainstormerPage.boldness.scale.low"))).toBeInTheDocument();
  });

  it("names every field, with its hint as its description", async () => {
    await open();
    for (const label of ["name", "language", "persona", "priorities", "avoid", "method"]) expect(screen.getByLabelText(t(`brainstormerPage.${label}`))).toBeInTheDocument();
    expect(screen.getByLabelText(t("brainstormerPage.language"))).toHaveAccessibleDescription(t("brainstormerPage.languageHint"));
    expect(screen.getByLabelText(t("brainstormerPage.persona"))).toHaveAccessibleDescription(t("brainstormerPage.personaHint"));
    expect(screen.getByLabelText(t("brainstormerPage.method"))).toHaveAccessibleDescription(t("brainstormerPage.methodHint"));
  });
});

describe("the bar that saves the Brainstormer", () => {
  it("says it is saved, then that it has changes, which it saves with the version it read, or discards", async () => {
    await open(brainstormer({ boldness: 6 }));
    expect(within(bar()).getByRole("status")).toHaveTextContent(t("brainstormerPage.bar.saved"));
    expect(saveButton()).toBeDisabled();
    expect(discardButton()).toBeDisabled();

    fireEvent.change(boldness(), { target: { value: "9" } });
    expect(within(bar()).getByRole("status")).toHaveTextContent(t("brainstormerPage.bar.unsaved"));
    fireEvent.click(discardButton());
    expect(boldness()).toHaveValue("6");
    expect(within(bar()).getByRole("status")).toHaveTextContent(t("brainstormerPage.bar.saved"));

    fireEvent.change(boldness(), { target: { value: "9" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ expectedHash: "h1", profile: expect.objectContaining({ boldness: 9 }) })));
    await waitFor(() => expect(within(bar()).getByRole("status")).toHaveTextContent(t("brainstormerPage.bar.saved")));
    expect(mocks.toast).toHaveBeenCalledWith({ title: t("brainstormerPage.saved") });
    expect(mocks.reload).toHaveBeenCalled();
  });

  it("keeps the lists one line each, without the dashes an author may have typed, and saves them as lists", async () => {
    await open(brainstormer({ priorities: ["One"], avoid: [] }));
    fireEvent.change(screen.getByLabelText(t("brainstormerPage.priorities")), { target: { value: "- First\n* Second\n\n  Third  " } });
    fireEvent.change(screen.getByLabelText(t("brainstormerPage.avoid")), { target: { value: "Dream endings" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0][0].profile).toMatchObject({ priorities: ["First", "Second", "Third"], avoid: ["Dream endings"] });
  });

  it("says when it is only the defaults, which saving writes in the book", async () => {
    await open(brainstormer(), null);
    expect(within(bar()).getByRole("status")).toHaveTextContent(t("brainstormerPage.bar.defaults"));
    expect(screen.getByText(t("brainstormerPage.defaults"))).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it("does not save a Brainstormer with no name", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(t("brainstormerPage.name")), { target: { value: "  " } });
    expect(saveButton()).toBeDisabled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("says in the bar why a save failed, and keeps the changes", async () => {
    mocks.save.mockRejectedValue(new Error("disk full"));
    await open(brainstormer({ boldness: 6 }));
    fireEvent.change(boldness(), { target: { value: "9" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(within(bar()).getByRole("status")).toHaveTextContent(t("brainstormerPage.bar.failed", { reason: "disk full" })));
    expect(boldness()).toHaveValue("9");
    expect(saveButton()).toBeEnabled();
  });

  it("never saves over a file that changed elsewhere, and says so with the way to read it again", async () => {
    mocks.save.mockRejectedValue(new BookConflictError("brainstormer.md changed", "brainstormer.md"));
    await open(brainstormer({ boldness: 6 }));
    fireEvent.change(boldness(), { target: { value: "9" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(within(bar()).getByRole("status")).toHaveTextContent(t("brainstormerPage.bar.failed", { reason: t("brainstormerPage.bar.conflict") })));
    expect(screen.getByRole("button", { name: t("brainstormerPage.reload") })).toBeInTheDocument();
    expect(boldness()).toHaveValue("9");
  });

  it("asks before it saves a file it could not read as it is written: the file would be rewritten from the form", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await open(brainstormer({ boldness: 6, warnings: ["brainstormer.md: boldness «x» is not a number from 1 to 10: 6 is used"] }));
    expect(screen.getByText(/brainstormer\.md: boldness/)).toBeInTheDocument();
    fireEvent.change(boldness(), { target: { value: "9" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(mocks.save).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe("leaving the Brainstormer page with changes that are not saved", () => {
  function Guarded() {
    useDirtyNavigationGuard(t("common.unsavedNavigationConfirm"));
    return <><Link to="/app/books">Library</Link><Outlet /></>;
  }

  it("asks first, and stays when the author says no", async () => {
    mocks.structure = structureIn("en");
    mocks.load.mockResolvedValue(file(brainstormer({ boldness: 6 })));
    const router = createMemoryRouter([
      { path: "/", element: <Guarded />, children: [{ path: "app/books/:bookId/brainstormer", element: <BrainstormerPage /> }, { path: "app/books", element: <p>The library</p> }] },
    ], { initialEntries: ["/app/books/book-1/brainstormer"] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<RouterProvider router={router} />);
    await screen.findByDisplayValue("Nora");
    fireEvent.change(boldness(), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("link", { name: "Library" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(t("common.unsavedNavigationConfirm")));
    expect(screen.queryByText("The library")).not.toBeInTheDocument();
    confirm.mockRestore();
  });
});
