import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: null as unknown,
  branch: "main",
  read: vi.fn(),
  capture: vi.fn(),
  commit: vi.fn(),
  toast: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: mocks.reload }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: mocks.branch, ready: true, ensuring: false, error: null }) }));
vi.mock("@/github/githubClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/github/githubClient")>()), readFileWithSha: mocks.read }));
vi.mock("@/assistant/immediateMutation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/assistant/immediateMutation")>()), captureImmediateMutation: mocks.capture, commitImmediateMutation: mocks.commit, commitImmediateMutations: vi.fn() }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { GhostwritersPage } from "@/pages/GhostwritersPage";
import { emptyGhostwriter, serializeGhostwriter } from "@/narrarium/ghostwriter";
import { useSaveStore } from "@/store/saveStore";
import type { BookEntry } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };

const ENTRIES = [
  { slug: "night-owl", path: "ghostwriters/night-owl.md", name: "Night Owl" },
  { slug: "sunrise", path: "ghostwriters/sunrise.md", name: "Sunrise" },
];
const structure = () => ({ title: "The Glass Harbor", language: "en", chapters: [], ghostwriters: ENTRIES.map((entry) => ({ ...entry })), ghostwriter: "night-owl", searchableFiles: [], loadedBranch: "main" });
const profileFile = (slug: string, name: string) => serializeGhostwriter({ slug, ...emptyGhostwriter(name) });

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

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  files = { "ghostwriters/night-owl.md": profileFile("night-owl", "Night Owl"), "ghostwriters/sunrise.md": profileFile("sunrise", "Sunrise") };
  mocks.book = { ...BOOK };
  mocks.structure = structure();
  mocks.branch = "main";
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

describe("the ghostwriters page and the settings being reloaded", () => {
  it("keeps what the author typed when the settings are replaced or the book structure is reloaded", async () => {
    const view = render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    fireEvent.change(nameField("Night Owl"), { target: { value: "My edit" } });

    for (let reload = 0; reload < 3; reload += 1) {
      mocks.book = { ...BOOK };
      mocks.structure = structure();
      view.rerender(<Page />);
      await act(async () => undefined);
    }
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(nameField("My edit")).toBeInTheDocument();
    expect(screen.queryByText(t("ghostwriters.changedElsewhere"))).not.toBeInTheDocument();
  });

  it("keeps the edits and offers to reload when the file changed underneath", async () => {
    const view = render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    fireEvent.change(nameField("Night Owl"), { target: { value: "My edit" } });

    files["ghostwriters/night-owl.md"] = profileFile("night-owl", "Changed on another device");
    mocks.branch = "dev-writer";
    view.rerender(<Page />);

    const notice = await screen.findByText(t("ghostwriters.changedElsewhere"));
    expect(notice.closest("[role=alert]")).toBeInTheDocument();
    expect(nameField("My edit")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t("ghostwriters.reloadFile") }));
    await waitFor(() => expect(nameField("Changed on another device")).toBeInTheDocument());
    expect(screen.queryByText(t("ghostwriters.changedElsewhere"))).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("follows a newer file silently while the form has no unsaved edits", async () => {
    const view = render(<Page />);
    await screen.findByDisplayValue("Night Owl");

    files["ghostwriters/night-owl.md"] = profileFile("night-owl", "Changed on another device");
    mocks.branch = "dev-writer";
    view.rerender(<Page />);

    await waitFor(() => expect(nameField("Changed on another device")).toBeInTheDocument());
    expect(screen.queryByText(t("ghostwriters.changedElsewhere"))).not.toBeInTheDocument();
  });

  it("opens another ghostwriter, replacing the form, once leaving the edited one is confirmed", async () => {
    render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    fireEvent.change(nameField("Night Owl"), { target: { value: "My edit" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    fireEvent.click(screen.getByRole("button", { name: /Sunrise/ }));
    await waitFor(() => expect(nameField("Sunrise")).toBeInTheDocument());
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("shows the ghostwriter that was selected last, whatever order the files arrive in", async () => {
    const pending: Record<string, (value: { content: string; sha: string }) => void> = {};
    mocks.read.mockImplementation((_token: string, _owner: string, _repo: string, _branch: string, path: string) => new Promise((resolve) => { pending[path] = resolve; }));
    render(<Page />);
    await waitFor(() => expect(pending["ghostwriters/night-owl.md"]).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: /Sunrise/ }));
    await waitFor(() => expect(pending["ghostwriters/sunrise.md"]).toBeDefined());
    await act(async () => { pending["ghostwriters/sunrise.md"]({ content: files["ghostwriters/sunrise.md"], sha: "s2" }); });
    await screen.findByDisplayValue("Sunrise");
    await act(async () => { pending["ghostwriters/night-owl.md"]({ content: files["ghostwriters/night-owl.md"], sha: "s1" }); });
    expect(nameField("Sunrise")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Night Owl")).not.toBeInTheDocument();
  });
});

describe("saving a ghostwriter", () => {
  it("saves while the file is still the version that was loaded", async () => {
    render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    fireEvent.change(nameField("Night Owl"), { target: { value: "My edit" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
    expect(mocks.commit.mock.calls[0][0].content).toContain("name: My edit");
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("common.saved") }));

    // The file now holds what was just saved: the next save is based on it.
    files["ghostwriters/night-owl.md"] = mocks.commit.mock.calls[0][0].content;
    fireEvent.change(nameField("My edit"), { target: { value: "Second edit" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(2));
  });

  it("refuses to overwrite a change made after the page was opened, keeps the edits and tells the author", async () => {
    render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    fireEvent.change(nameField("Night Owl"), { target: { value: "My edit" } });
    files["ghostwriters/night-owl.md"] = profileFile("night-owl", "Changed on another device");

    fireEvent.click(saveButton());
    await screen.findByText(t("ghostwriters.changedElsewhere"));
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("ghostwriters.saveFailed"), description: t("ghostwriters.changedElsewhere"), variant: "destructive" }));
    expect(nameField("My edit")).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: t("ghostwriters.reloadFile") }));
    await waitFor(() => expect(nameField("Changed on another device")).toBeInTheDocument());
  });
});
