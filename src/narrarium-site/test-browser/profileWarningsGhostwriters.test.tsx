import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: null as unknown,
  read: vi.fn(),
  capture: vi.fn(),
  commit: vi.fn(),
  toast: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: mocks.reload }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/github/githubClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/github/githubClient")>()), readFileWithSha: mocks.read }));
vi.mock("@/assistant/immediateMutation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/assistant/immediateMutation")>()), captureImmediateMutation: mocks.capture, commitImmediateMutation: mocks.commit, commitImmediateMutations: vi.fn() }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { GhostwritersPage } from "@/pages/GhostwritersPage";
import { emptyGhostwriter, serializeGhostwriter } from "@/narrarium/ghostwriter";
import { triggerCurrentSave, useSaveStore } from "@/store/saveStore";
import type { BookEntry } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const ENTRIES = [
  { slug: "night-owl", path: "ghostwriters/night-owl.md", name: "Night Owl" },
  { slug: "sunrise", path: "ghostwriters/sunrise.md", name: "Sunrise" },
];
const structure = () => ({ title: "The Glass Harbor", language: "en", chapters: [], ghostwriters: ENTRIES.map((entry) => ({ ...entry })), ghostwriter: "night-owl", searchableFiles: [], loadedBranch: "main" });

const HOT = "---\ntype: ghostwriter\nname: Night Owl\ntemperature: hot\ntone: Dark\n---\n\nWrite at night.\n";
const BROKEN_YAML = "---\nname: Night: Owl\ntone: Dark\n---\n\nWrite at night.\n";
const clean = (slug: string, name: string) => serializeGhostwriter({ slug, ...emptyGhostwriter(name) });

let files: Record<string, string>;

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/ghostwriters"]}>
      <Routes><Route path="/app/books/:bookId/ghostwriters" element={<GhostwritersPage />} /></Routes>
    </MemoryRouter>
  );
}

const nameField = (value: string) => screen.getByDisplayValue(value) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: t("common.save") }) as HTMLButtonElement;
const notice = (count: number) => screen.getByRole("status", { name: t("profileFile.warningsTitle", { count }) });

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  files = { "ghostwriters/night-owl.md": HOT, "ghostwriters/sunrise.md": clean("sunrise", "Sunrise") };
  mocks.book = { ...BOOK };
  mocks.structure = structure();
  mocks.read.mockReset().mockImplementation(async (_token: string, _owner: string, _repo: string, _branch: string, path: string) => ({ content: files[path], sha: `sha-${path}` }));
  mocks.capture.mockReset().mockImplementation(async (input: { path: string }) => ({ path: input.path, content: files[input.path] ?? null, sha: "sha", hash: "hash", remoteHeadSha: "head" }));
  mocks.commit.mockReset().mockResolvedValue("commit");
  mocks.toast.mockReset();
  mocks.reload.mockReset();
});

afterEach(() => {
  cleanup();
  useSaveStore.setState({ current: null });
  vi.restoreAllMocks();
});

describe("the ghostwriters page, when a profile file has problems", () => {
  it("shows what could not be read at the top of the form, in a status that does not interrupt", async () => {
    render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    const warnings = notice(1);
    expect(warnings).toHaveTextContent("ghostwriters/night-owl.md: temperature «hot» is not a number: 0.8 is used");
    expect(within(warnings).getAllByRole("listitem")).toHaveLength(1);
    expect(warnings).toHaveTextContent(t("profileFile.warningsBody"));
    expect(warnings.compareDocumentPosition(nameField("Night Owl")) & Node.DOCUMENT_POSITION_FOLLOWING, "above the first field").toBeTruthy();
  });

  it("is in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    expect(notice(1)).toHaveTextContent("Questo file ha un problema");
    await i18n.changeLanguage("en");
  });

  it("shows the notice of the profile that is open, and none for a profile that is fine", async () => {
    render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    expect(notice(1)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Sunrise/ }));
    await screen.findByDisplayValue("Sunrise");
    expect(screen.queryByRole("status", { name: /problem/i })).not.toBeInTheDocument();
  });

  it("asks before saving over it, and writes nothing when the author says no", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    fireEvent.change(nameField("Night Owl"), { target: { value: "My edit" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(t("profileFile.saveConfirm")));
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(notice(1)).toBeInTheDocument();
    expect(nameField("My edit")).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it("writes when the author says yes, and the notice goes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    fireEvent.change(nameField("Night Owl"), { target: { value: "My edit" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("status", { name: /problem/i })).not.toBeInTheDocument());
  });

  it("asks when the save comes from the shortcut or the menu", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    fireEvent.change(nameField("Night Owl"), { target: { value: "My edit" } });
    await waitFor(() => expect(useSaveStore.getState().current?.dirty).toBe(true));
    expect(await triggerCurrentSave()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("asks before replacing a file whose YAML cannot be read", async () => {
    files["ghostwriters/night-owl.md"] = BROKEN_YAML;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Page />);
    await screen.findByRole("status", { name: t("profileFile.warningsTitle", { count: 1 }) });
    expect(notice(1)).toHaveTextContent("ghostwriters/night-owl.md: the frontmatter is not valid YAML");
    fireEvent.change(screen.getByDisplayValue("night-owl"), { target: { value: "Another name" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("does not ask when the file is as it says", async () => {
    files["ghostwriters/night-owl.md"] = clean("night-owl", "Night Owl");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    fireEvent.change(nameField("Night Owl"), { target: { value: "My edit" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });
});
