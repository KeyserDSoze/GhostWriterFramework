import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import type { BookStructure } from "@/types/book";

const repository = vi.hoisted(() => ({
  ensureLocalBookStructure: vi.fn(),
  fetchRemoteStatus: vi.fn(),
  getExistingLocalBookStructure: vi.fn(),
  invalidateRepositoryEnsureOperations: vi.fn(),
  pullRemoteChanges: vi.fn(),
  verifyAndRepairLocalRepository: vi.fn(),
}));

vi.mock("@/repository/repositoryService", () => repository);
vi.mock("@/github/branchResolution", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/github/branchResolution")>();
  return { ...original, ensureAuthoritativePersonalBranch: vi.fn() };
});

import { resetAccountScopedState } from "@/auth/accountScope";
import { resetBookStructureLoadCoordinator, useBookStructure } from "@/hooks/useBookStructure";
import { useAuthStore } from "@/store/authStore";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";

const book: BookEntry = {
  id: "single-flight-book",
  owner: "owner",
  repo: "repo",
  name: "Book",
  tokenIndex: null,
  bookToken: "token",
  activeBranch: "test2",
  addedAt: "2026-01-01T00:00:00.000Z",
};

const userA = { provider: "google" as const, providerAccountId: "subject-a", name: "Writer A", email: "writer-a@example.test", picture: "" };
const userB = { provider: "google" as const, providerAccountId: "subject-b", name: "Writer B", email: "writer-b@example.test", picture: "" };

function structure(title = "Local book"): BookStructure {
  return {
    title,
    description: "",
    owner: book.owner,
    repo: book.repo,
    defaultBranch: "main",
    loadedBranch: "test2",
    chapters: [],
    characters: [],
    locations: [],
    factions: [],
    items: [],
    timelines: [],
    secrets: [],
    ghostwriters: [],
    readerPersonas: [],
    readerEvaluationFiles: [],
    operationManifestFiles: [],
    auditFiles: [],
    researchFiles: [],
    notesFiles: [],
  };
}

function Consumer({ index, onReload }: { index: number; onReload?: (reload: () => void) => void }) {
  const result = useBookStructure(book.id);
  onReload?.(result.reload);
  return <div data-testid={`consumer-${index}`}>{result.loading ? "loading" : result.structure?.title ?? result.error ?? "empty"}</div>;
}

function Consumers({ count = 20, onReload }: { count?: number; onReload?: (reload: () => void) => void }) {
  return <>{Array.from({ length: count }, (_, index) => <Consumer key={index} index={index} onReload={onReload} />)}</>;
}

beforeEach(() => {
  const structureLoadEpoch = resetBookStructureLoadCoordinator();
  repository.ensureLocalBookStructure.mockReset();
  repository.fetchRemoteStatus.mockReset().mockResolvedValue({ changed: false, remoteHeadSha: "remote" });
  repository.getExistingLocalBookStructure.mockReset();
  repository.pullRemoteChanges.mockReset();
  repository.verifyAndRepairLocalRepository.mockReset();
  useAuthStore.setState({
    user: userA,
  });
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, books: [book], repository: { ...DEFAULT_SETTINGS.repository, autoFetchOnOpen: true } },
  });
  useBooksStore.setState({
    structures: {},
    loadingIds: new Set(),
    activeStructureOperations: {},
    errors: {},
    workingBranches: {},
    cloneProgress: {},
    structureGenerations: {},
    structureLoadEpoch,
  });
});

afterEach(cleanup);

describe("useBookStructure shared operation coordinator", () => {
  it("serves 20 StrictMode consumers from one local load and one optional fetch", async () => {
    repository.getExistingLocalBookStructure.mockResolvedValue({ meta: { cloneComplete: true }, structure: structure() });

    render(<StrictMode><Consumers /></StrictMode>);

    await waitFor(() => expect(screen.getByTestId("consumer-0")).toHaveTextContent("Local book"));
    expect(screen.getByTestId("consumer-19")).toHaveTextContent("Local book");
    expect(repository.getExistingLocalBookStructure).toHaveBeenCalledOnce();
    expect(repository.ensureLocalBookStructure).not.toHaveBeenCalled();
    expect(repository.fetchRemoteStatus).toHaveBeenCalledOnce();
  });

  it("performs one clone workflow when no local clone exists", async () => {
    repository.getExistingLocalBookStructure.mockResolvedValue(null);
    repository.ensureLocalBookStructure.mockResolvedValue({ meta: {}, structure: structure("Cloned book"), cloned: true });

    render(<StrictMode><Consumers /></StrictMode>);

    await waitFor(() => expect(screen.getByTestId("consumer-0")).toHaveTextContent("Cloned book"));
    expect(repository.getExistingLocalBookStructure).toHaveBeenCalledOnce();
    expect(repository.ensureLocalBookStructure).toHaveBeenCalledOnce();
    expect(repository.fetchRemoteStatus).toHaveBeenCalledOnce();
  });

  it("does no repository work when the branch is already loaded or unrelated settings change", async () => {
    useBooksStore.setState({ structures: { [book.id]: structure("Already loaded") } });
    const view = render(<StrictMode><Consumers /></StrictMode>);
    expect(screen.getByTestId("consumer-0")).toHaveTextContent("Already loaded");

    act(() => useSettingsStore.setState((state) => ({ settings: { ...state.settings, ui: { ...state.settings.ui, theme: state.settings.ui.theme === "dark" ? "light" : "dark" } } })));
    view.rerender(<StrictMode><Consumers /></StrictMode>);

    await act(async () => Promise.resolve());
    expect(repository.getExistingLocalBookStructure).not.toHaveBeenCalled();
    expect(repository.ensureLocalBookStructure).not.toHaveBeenCalled();
    expect(repository.fetchRemoteStatus).not.toHaveBeenCalled();
  });

  it("prevents a delayed old generation from clearing a newer load", async () => {
    let resolveOld!: (value: { meta: { cloneComplete: boolean }; structure: BookStructure }) => void;
    let resolveNew!: (value: { meta: { cloneComplete: boolean }; structure: BookStructure }) => void;
    repository.getExistingLocalBookStructure
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveNew = resolve; }));
    let reload = () => undefined;
    render(<Consumers count={1} onReload={(value) => { reload = value; }} />);
    await waitFor(() => expect(repository.getExistingLocalBookStructure).toHaveBeenCalledOnce());

    act(() => reload());
    await waitFor(() => expect(repository.getExistingLocalBookStructure).toHaveBeenCalledTimes(2));
    await act(async () => resolveOld({ meta: { cloneComplete: true }, structure: structure("Old") }));
    expect(screen.getByTestId("consumer-0")).toHaveTextContent("loading");

    await act(async () => resolveNew({ meta: { cloneComplete: true }, structure: structure("New") }));
    await waitFor(() => expect(screen.getByTestId("consumer-0")).toHaveTextContent("New"));
    expect(useBooksStore.getState().loadingIds.has(book.id)).toBe(false);
  });

  it("does not reuse or accept a paused operation after A to B to A account resets", async () => {
    let resolveOldA!: (value: { meta: { cloneComplete: boolean }; structure: BookStructure }) => void;
    let resolveNewA!: (value: { meta: { cloneComplete: boolean }; structure: BookStructure }) => void;
    repository.getExistingLocalBookStructure
      .mockReturnValueOnce(new Promise((resolve) => { resolveOldA = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveNewA = resolve; }));
    render(<Consumers count={1} />);
    await waitFor(() => expect(repository.getExistingLocalBookStructure).toHaveBeenCalledOnce());

    act(() => {
      useAuthStore.setState({ user: userB });
      resetAccountScopedState();
      useAuthStore.setState({ user: userA });
      resetAccountScopedState();
      useSettingsStore.setState({
        settings: { ...DEFAULT_SETTINGS, books: [book], repository: { ...DEFAULT_SETTINGS.repository, autoFetchOnOpen: true } },
      });
    });
    await waitFor(() => expect(repository.getExistingLocalBookStructure).toHaveBeenCalledTimes(2));
    expect(useBooksStore.getState().loadingIds.has(book.id)).toBe(true);

    await act(async () => resolveOldA({ meta: { cloneComplete: true }, structure: structure("Stale A") }));
    expect(screen.getByTestId("consumer-0")).toHaveTextContent("loading");
    expect(useBooksStore.getState().structures[book.id]).toBeUndefined();
    expect(useBooksStore.getState().loadingIds.has(book.id)).toBe(true);

    await act(async () => resolveNewA({ meta: { cloneComplete: true }, structure: structure("Current A") }));
    await waitFor(() => expect(screen.getByTestId("consumer-0")).toHaveTextContent("Current A"));
    expect(repository.getExistingLocalBookStructure).toHaveBeenCalledTimes(2);
    expect(useBooksStore.getState().loadingIds.has(book.id)).toBe(false);
  });
});
