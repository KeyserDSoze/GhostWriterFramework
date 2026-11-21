import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: null as unknown,
  branch: "main",
  read: vi.fn(),
  loadContent: vi.fn(),
  createOrUpdate: vi.fn(),
  capture: vi.fn(),
  commit: vi.fn(),
  toast: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: mocks.reload }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: mocks.branch, ready: true, ensuring: false, error: null }) }));
vi.mock("@/github/githubClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/github/githubClient")>()),
  readFileWithSha: mocks.read,
  loadFileContent: mocks.loadContent,
  createOrUpdateTextFile: mocks.createOrUpdate,
}));
vi.mock("@/assistant/immediateMutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/assistant/immediateMutation")>()),
  captureImmediateMutation: mocks.capture,
  commitImmediateMutation: mocks.commit,
  commitImmediateMutations: vi.fn(),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { EvaluationStylePage } from "@/pages/EvaluationStylePage";
import { RepositoryError } from "@/repository/repositoryError";
import { EVALUATION_GUIDELINES_PATH } from "@/narrarium/defaultGuidelines";
import { useSaveStore } from "@/store/saveStore";
import type { BookEntry } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const STRUCTURE = { title: "The Glass Harbor", language: "en", chapters: [], readerPersonas: [], loadedBranch: "main" };

const doc = (body: string, criteria: Record<string, string> = { voice: "How distinct the narrative voice is." }) =>
  `---\ncriteria:\n${Object.entries(criteria).map(([key, description]) => `  ${key}:\n    description: ${description}`).join("\n")}\n---\n\n${body}\n`;

let files: Record<string, string | undefined>;

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/evaluation-style"]}>
      <Routes><Route path="/app/books/:bookId/evaluation-style" element={<EvaluationStylePage />} /></Routes>
    </MemoryRouter>
  );
}

const bodyField = () => screen.getByPlaceholderText(t("evaluationStyle.placeholder")) as HTMLTextAreaElement;
const saveButton = () => screen.getByRole("button", { name: t("common.save") }) as HTMLButtonElement;
const notFound = () => new RepositoryError("evaluation-guidelines.md was not found.", "not-found", "read", 404);

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  files = { [EVALUATION_GUIDELINES_PATH]: doc("Be rigorous.") };
  mocks.book = { ...BOOK };
  mocks.structure = { ...STRUCTURE };
  mocks.branch = "main";
  mocks.read.mockReset().mockImplementation(async (_token: string, _owner: string, _repo: string, _branch: string, path: string) => {
    if (files[path] === undefined) throw notFound();
    return { content: files[path], sha: `sha:${files[path]}` };
  });
  mocks.loadContent.mockReset().mockImplementation(async (_token: string, _owner: string, _repo: string, path: string) => {
    if (files[path] === undefined) throw notFound();
    return files[path];
  });
  mocks.createOrUpdate.mockReset().mockImplementation(async (_token: string, _owner: string, _repo: string, _branch: string, path: string, content: string) => {
    files[path] = content;
    return "sha";
  });
  mocks.capture.mockReset().mockImplementation(async (input: { path: string }) => ({ path: input.path, content: files[input.path] ?? null, sha: "sha", hash: "hash", remoteHeadSha: "head" }));
  mocks.commit.mockReset().mockImplementation(async (input: { snapshot: { path: string }; content: string }) => {
    files[input.snapshot.path] = input.content;
    return "commit";
  });
  mocks.toast.mockReset();
  mocks.reload.mockReset();
});

afterEach(() => {
  cleanup();
  useSaveStore.setState({ current: null });
});

describe("the evaluation style page and the settings being reloaded", () => {
  it("keeps what the author typed when the settings are replaced and the book object changes", async () => {
    const view = render(<Page />);
    await screen.findByDisplayValue("Be rigorous.");
    fireEvent.change(bodyField(), { target: { value: "My own rules." } });

    for (let reload = 0; reload < 3; reload += 1) {
      mocks.book = { ...BOOK };
      view.rerender(<Page />);
      await act(async () => undefined);
    }
    expect(mocks.read.mock.calls.length + mocks.loadContent.mock.calls.length).toBe(1);
    expect(bodyField()).toHaveValue("My own rules.");
    expect(screen.queryByText(t("evaluationStyle.changedElsewhere"))).not.toBeInTheDocument();
  });

  it("keeps the edits and offers to reload when the file changed underneath", async () => {
    const view = render(<Page />);
    await screen.findByDisplayValue("Be rigorous.");
    fireEvent.change(bodyField(), { target: { value: "My own rules." } });

    files[EVALUATION_GUIDELINES_PATH] = doc("Changed on another device.");
    mocks.branch = "dev-writer";
    view.rerender(<Page />);

    const notice = await screen.findByText(t("evaluationStyle.changedElsewhere"));
    expect(notice.closest("[role=alert]")).toBeInTheDocument();
    expect(bodyField()).toHaveValue("My own rules.");

    fireEvent.click(screen.getByRole("button", { name: t("evaluationStyle.reloadFile") }));
    await waitFor(() => expect(bodyField().value.trim()).toBe("Changed on another device."));
    expect(screen.queryByText(t("evaluationStyle.changedElsewhere"))).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("keeps edits made to a criterion too", async () => {
    const view = render(<Page />);
    await screen.findByDisplayValue("How distinct the narrative voice is.");
    fireEvent.change(screen.getByDisplayValue("How distinct the narrative voice is."), { target: { value: "My definition of voice." } });

    files[EVALUATION_GUIDELINES_PATH] = doc("Be rigorous.", { voice: "Changed elsewhere." });
    mocks.branch = "dev-writer";
    view.rerender(<Page />);

    await screen.findByText(t("evaluationStyle.changedElsewhere"));
    expect(screen.getByDisplayValue("My definition of voice.")).toBeInTheDocument();
  });

  it("follows a newer file silently while the form has no unsaved edits", async () => {
    const view = render(<Page />);
    await screen.findByDisplayValue("Be rigorous.");

    files[EVALUATION_GUIDELINES_PATH] = doc("Changed on another device.");
    mocks.branch = "dev-writer";
    view.rerender(<Page />);

    await waitFor(() => expect(bodyField().value.trim()).toBe("Changed on another device."));
    expect(screen.queryByText(t("evaluationStyle.changedElsewhere"))).not.toBeInTheDocument();
  });

  it("shows another book's guidelines when the page moves to another book", async () => {
    const view = render(<Page />);
    await screen.findByDisplayValue("Be rigorous.");
    fireEvent.change(bodyField(), { target: { value: "My own rules." } });

    mocks.book = { ...BOOK, id: "book-2", repo: "book-2" };
    files[EVALUATION_GUIDELINES_PATH] = doc("The second book's rules.");
    view.rerender(<Page />);
    await waitFor(() => expect(bodyField().value.trim()).toBe("The second book's rules."));
  });
});

describe("saving the evaluation style", () => {
  it("saves while the file is still the version that was loaded, then again on top of what it just saved", async () => {
    render(<Page />);
    await screen.findByDisplayValue("Be rigorous.");
    fireEvent.change(bodyField(), { target: { value: "My own rules." } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
    expect(mocks.commit.mock.calls[0][0].content).toContain("My own rules.");
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("common.saved") }));
    expect(mocks.createOrUpdate).not.toHaveBeenCalled();

    fireEvent.change(bodyField(), { target: { value: "Second edit." } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(2));
    expect(mocks.commit.mock.calls[1][0].content).toContain("Second edit.");
  });

  it("refuses to overwrite a change made after the page was opened, keeps the edits and tells the author", async () => {
    render(<Page />);
    await screen.findByDisplayValue("Be rigorous.");
    fireEvent.change(bodyField(), { target: { value: "My own rules." } });
    files[EVALUATION_GUIDELINES_PATH] = doc("Changed on another device.");

    fireEvent.click(saveButton());
    await screen.findByText(t("evaluationStyle.changedElsewhere"));
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.createOrUpdate).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("common.saveFailed"), description: t("evaluationStyle.changedElsewhere"), variant: "destructive" }));
    expect(bodyField()).toHaveValue("My own rules.");
    expect(saveButton()).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: t("evaluationStyle.reloadFile") }));
    await waitFor(() => expect(bodyField().value.trim()).toBe("Changed on another device."));
  });

  it("creates the file from the defaults when the book has none yet", async () => {
    files[EVALUATION_GUIDELINES_PATH] = undefined;
    render(<Page />);
    await waitFor(() => expect(bodyField().value.length).toBeGreaterThan(20));
    expect(saveButton()).toBeEnabled();

    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
    expect(mocks.capture).toHaveBeenCalled();
  });

  it("does not offer to save defaults over a file it could not read", async () => {
    mocks.read.mockRejectedValue(new Error("The network is down."));
    mocks.loadContent.mockRejectedValue(new Error("The network is down."));
    render(<Page />);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("evaluationStyle.loadFailed"), variant: "destructive" })));
    expect(saveButton()).toBeDisabled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.createOrUpdate).not.toHaveBeenCalled();
  });

  it("still reports other save failures as they are", async () => {
    mocks.commit.mockRejectedValue(new Error("disk full"));
    render(<Page />);
    await screen.findByDisplayValue("Be rigorous.");
    fireEvent.change(bodyField(), { target: { value: "My own rules." } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("common.saveFailed"), description: "Error: disk full" })));
    expect(screen.queryByText(t("evaluationStyle.changedElsewhere"))).not.toBeInTheDocument();
  });
});

describe("the texts of the evaluation style safeguards", () => {
  it.each(["en", "it"])("exist in %s", (lng) => {
    for (const key of ["changedElsewhere", "reloadFile", "loadFailed"]) {
      expect(i18n.exists(`evaluationStyle.${key}`, { lng }), key).toBe(true);
    }
    expect(i18n.t("evaluationStyle.changedElsewhere", { lng: "it" })).not.toBe(i18n.t("evaluationStyle.changedElsewhere", { lng: "en" }));
  });
});
