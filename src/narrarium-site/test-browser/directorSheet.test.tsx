import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Outlet, Route, RouterProvider, Routes, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorProfile } from "narrarium-engine";

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

import { defaultDirector } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { DirectorPage } from "@/pages/DirectorPage";
import { formatCount } from "@/autopilot/format";
import { useDirtyNavigationGuard } from "@/hooks/useDirtyNavigationGuard";
import { useSaveStore } from "@/store/saveStore";
import type { BookEntry } from "@/types/settings";
import { chooseOption, optionNames, polyfillRadix } from "./helpers/radix";

type Language = "en" | "it";
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const structureIn = (language: string) => ({ title: "The Glass Harbor", language, chapters: [], readerPersonas: [], loadedBranch: "main" });
const director = (patch: Partial<DirectorProfile> = {}): DirectorProfile => ({ ...defaultDirector("en"), name: "Ada", ...patch });
const file = (profile: DirectorProfile, hash: string | null = "h1") => ({ profile, exists: hash !== null, hash });

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/director"]}>
      <Routes><Route path="/app/books/:bookId/director" element={<DirectorPage />} /></Routes>
    </MemoryRouter>
  );
}

const slider = (name: string) => screen.getByRole("slider", { name }) as HTMLInputElement;
const strictness = () => slider(t("director.strictness"));
const approval = () => slider(t("director.approvalScore"));
const saveButton = () => screen.getByRole("button", { name: t("director.save") }) as HTMLButtonElement;
const discardButton = () => screen.getByRole("button", { name: t("director.bar.discard") }) as HTMLButtonElement;
const bar = () => screen.getByRole("group", { name: t("director.bar.label") });
const preview = () => screen.getByRole("region", { name: t("director.preview.title") });

async function open(profile = director(), hash: string | null = "h1", language = "en") {
  mocks.structure = structureIn(language);
  mocks.load.mockResolvedValue(file(profile, hash));
  render(<Page />);
  await screen.findByDisplayValue(profile.name);
}

beforeAll(async () => {
  polyfillRadix();
  await loadAutopilotTranslations();
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

describe.each<Language>(["en", "it"])("the director as a character sheet (%s)", (language) => {
  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage(language); });
  });

  it("is headed by the director's name and what the director does", async () => {
    await open(director({ name: "Ada Ferri" }));
    expect(screen.getByRole("heading", { level: 1, name: "Ada Ferri" })).toBeInTheDocument();
    expect(screen.getByText(t("director.description"))).toBeInTheDocument();
    for (const section of ["identity", "judgement", "cares"]) expect(screen.getByRole("region", { name: t(`director.sections.${section}`) })).toBeInTheDocument();
  });

  it("sets strictness and the approval score with sliders that say their value in words, beside a field for the number", async () => {
    await open(director({ strictness: 7, approvalScore: 7 }));
    expect(strictness()).toHaveAttribute("aria-valuetext", t("director.strictnessValue", { value: formatCount(7), caption: t("director.scale.strict") }));
    expect(approval()).toHaveAttribute("aria-valuetext", t("director.approvalValue", { value: formatCount(7), caption: t("director.scale.medium") }));
    const captions = [t("director.scale.lenient"), t("director.scale.balanced"), t("director.scale.strict")];
    expect(captions).toEqual(language === "en" ? ["Lenient", "Balanced", "Strict"] : ["Indulgente", "Equilibrato", "Severo"]);
    for (const caption of captions) expect(screen.getAllByText(caption).length).toBeGreaterThan(0);
    const number = screen.getByRole("spinbutton", { name: t("director.asNumber", { label: t("director.approvalScore") }) }) as HTMLInputElement;
    expect(number).toHaveValue(7);
    fireEvent.change(number, { target: { value: "8.5" } });
    expect(approval()).toHaveValue("8.5");
    expect(approval()).toHaveAttribute("aria-valuetext", t("director.approvalValue", { value: formatCount(8.5), caption: t("director.scale.high") }));
  });

  it("moves the sliders with the keyboard: arrows by half a point, Page Up and Page Down by one, Home and End to the ends", async () => {
    await open(director({ strictness: 7 }));
    const range = strictness();
    fireEvent.keyDown(range, { key: "ArrowRight" });
    expect(range).toHaveValue("7.5");
    fireEvent.keyDown(range, { key: "ArrowDown" });
    fireEvent.keyDown(range, { key: "ArrowDown" });
    expect(range).toHaveValue("6.5");
    fireEvent.keyDown(range, { key: "PageUp" });
    expect(range).toHaveValue("7.5");
    fireEvent.keyDown(range, { key: "End" });
    expect(range).toHaveValue("10");
    fireEvent.keyDown(range, { key: "Home" });
    expect(range).toHaveValue("1");
    expect(range).toHaveAttribute("aria-valuetext", t("director.strictnessValue", { value: formatCount(1), caption: t("director.scale.lenient") }));
  });

  it("previews what the approval score does to a chapter, as the engine applies it", async () => {
    await open(director({ approvalScore: 8, maxReviewRounds: 2, autonomy: "ask-on-critical", strictness: 7 }));
    const region = preview();
    expect(within(region).getByText(t("director.preview.below", { score: formatCount(6.5), threshold: formatCount(8) }))).toBeInTheDocument();
    expect(within(region).getByText(t("director.preview.at", { threshold: formatCount(8) }))).toBeInTheDocument();
    expect(within(region).getByText(t("director.preview.rounds", { count: 2 }))).toBeInTheDocument();
    expect(within(region).getByText(t("director.preview.autonomy.ask-on-critical"))).toBeInTheDocument();
    expect(within(region).getByText(t("director.preview.strictness", { value: formatCount(7), caption: t("director.scale.strict") }))).toBeInTheDocument();
    expect(region.closest("[aria-live]")).toBeNull();

    fireEvent.change(approval(), { target: { value: "6" } });
    expect(within(region).getByText(t("director.preview.below", { score: formatCount(5.5), threshold: formatCount(6) }))).toBeInTheDocument();
    fireEvent.keyDown(approval(), { key: "Home" });
    expect(within(region).getByText(t("director.preview.none", { threshold: formatCount(1) }))).toBeInTheDocument();
  });

  it("chooses the review rounds and the autonomy among their values, each said in words", async () => {
    await open(director({ maxReviewRounds: 2, autonomy: "ask-on-critical" }));
    const rounds = screen.getByRole("radiogroup", { name: t("director.maxReviewRounds") });
    expect(within(rounds).getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(["1", "2", "3"]);
    fireEvent.click(within(rounds).getByRole("radio", { name: t("director.rounds", { count: 3 }) }));
    expect(within(preview()).getByText(t("director.preview.rounds", { count: 3 }))).toBeInTheDocument();
    const autonomy = screen.getByRole("radiogroup", { name: t("director.autonomy") });
    const always = within(autonomy).getByRole("radio", { name: t("director.autonomyOptions.ask-always") });
    expect(always).toHaveAccessibleDescription(t("director.autonomyHelp.ask-always"));
    fireEvent.click(always);
    expect(within(preview()).getByText(t("director.preview.autonomy.ask-always"))).toBeInTheDocument();
  });

  it("chooses the language among the ones the engine knows, the book's first, and says in which language the director writes", async () => {
    await open(director({ language: "en" }), "h1", "it");
    const field = screen.getByRole("combobox", { name: t("director.language") });
    const names = optionNames(field);
    expect(names[0]).toContain(t("director.languageBook"));
    expect(names.length).toBeGreaterThan(60);
    expect(names.some((name) => name.includes("русский"))).toBe(true);
    expect(screen.getByText(t("director.languageHint", { language: new Intl.DisplayNames([language], { type: "language" }).of("it") }))).toBeInTheDocument();
    chooseOption(field, /\(fr\)/);
    expect(screen.getByText(t("director.bar.unsaved"))).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining({ language: "fr" }) })));
  });
});

describe("the language of a director that is not saved yet", () => {
  it("is the book's", async () => {
    await open(director({ language: "en" }), null, "de");
    expect(screen.getByRole("combobox", { name: t("director.language") })).toHaveTextContent(new Intl.DisplayNames(["en"], { type: "language" }).of("de")!);
  });

  it("keeps a value of the file the engine does not know, as it is written", async () => {
    await open(director({ language: "klingon" }));
    expect(screen.getByRole("combobox", { name: t("director.language") })).toHaveTextContent(t("director.languageUnknown", { value: "klingon" }));
    expect(screen.getByText(t("director.bar.saved"))).toBeInTheDocument();
  });
});

describe("the bar that saves the director", () => {
  it("says the director is saved, then that it has changes, which it saves or discards", async () => {
    await open(director({ approvalScore: 7 }));
    expect(within(bar()).getByRole("status")).toHaveTextContent(t("director.bar.saved"));
    expect(saveButton()).toBeDisabled();
    expect(discardButton()).toBeDisabled();

    fireEvent.change(approval(), { target: { value: "9" } });
    expect(within(bar()).getByRole("status")).toHaveTextContent(t("director.bar.unsaved"));
    expect(saveButton()).toBeEnabled();
    fireEvent.click(discardButton());
    expect(approval()).toHaveValue("7");
    expect(within(bar()).getByRole("status")).toHaveTextContent(t("director.bar.saved"));

    fireEvent.change(approval(), { target: { value: "9" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ expectedHash: "h1", profile: expect.objectContaining({ approvalScore: 9 }) })));
    await waitFor(() => expect(within(bar()).getByRole("status")).toHaveTextContent(t("director.bar.saved")));
    expect(discardButton()).toBeDisabled();
  });

  it("says when the director is only the defaults, which saving writes in the book", async () => {
    await open(director(), null);
    expect(within(bar()).getByRole("status")).toHaveTextContent(t("director.bar.defaults"));
    expect(saveButton()).toBeEnabled();
  });

  it("says in the bar why a save failed, and keeps the changes", async () => {
    mocks.save.mockRejectedValue(new Error("disk full"));
    await open(director({ approvalScore: 7 }));
    fireEvent.change(approval(), { target: { value: "9" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(within(bar()).getByRole("status")).toHaveTextContent(t("director.bar.failed", { reason: "disk full" })));
    expect(approval()).toHaveValue("9");
    expect(saveButton()).toBeEnabled();
  });

  it("stays at the bottom of the window, and gives the room it takes to the page and to the floating buttons", async () => {
    await open();
    expect(bar().className).toMatch(/\bfixed\b/);
    expect(bar().className).toMatch(/\bbottom-0\b/);
    expect(document.documentElement.style.getPropertyValue("--bottom-reserve")).not.toBe("");
  });
});

describe("leaving the director page with changes that are not saved", () => {
  function Guarded() {
    useDirtyNavigationGuard(t("common.unsavedNavigationConfirm"));
    return <><Link to="/app/books">Library</Link><Outlet /></>;
  }

  it("asks first, and stays when the author says no", async () => {
    mocks.structure = structureIn("en");
    mocks.load.mockResolvedValue(file(director({ approvalScore: 7 })));
    const router = createMemoryRouter([
      { path: "/", element: <Guarded />, children: [{ path: "app/books/:bookId/director", element: <DirectorPage /> }, { path: "app/books", element: <p>The library</p> }] },
    ], { initialEntries: ["/app/books/book-1/director"] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<RouterProvider router={router} />);
    await screen.findByDisplayValue("Ada");
    fireEvent.change(approval(), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("link", { name: "Library" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(t("common.unsavedNavigationConfirm")));
    expect(screen.queryByText("The library")).not.toBeInTheDocument();
    expect(approval()).toHaveValue("9");
    confirm.mockRestore();
  });
});
