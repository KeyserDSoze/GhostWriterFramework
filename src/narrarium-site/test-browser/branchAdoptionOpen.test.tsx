import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import type { BookStructure } from "@/types/book";

const repository = vi.hoisted(() => ({
  ensureLocalBookStructure: vi.fn(),
  getExistingLocalBookStructure: vi.fn(),
  invalidateRepositoryEnsureOperations: vi.fn(),
  latestCompleteLocalBookStructure: vi.fn(),
}));
const saved = vi.hoisted(() => vi.fn(async () => true));
const toasts = vi.hoisted(() => vi.fn());

vi.mock("@/repository/repositoryService", () => repository);
vi.mock("@/narrarium/defaultGhostwriter", () => ({ ensureDefaultGhostwriter: vi.fn(async () => false) }));
vi.mock("@/drive/useSettings", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/drive/useSettings")>()), saveSettingsNow: saved }));
vi.mock("@/components/ui/use-toast", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/components/ui/use-toast")>()), toast: toasts }));

import i18n from "@/i18n";
import { resetBookStructureLoadCoordinator, useBookStructure } from "@/hooks/useBookStructure";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";

const T1 = "2026-11-20T10:00:00.000Z";
const T2 = "2026-11-21T10:00:00.000Z";
/** As `adoptRememberedBranches` leaves it: on the branch chosen last on another device, with the one it had. */
const adopted: BookEntry = { id: "adopting-book", owner: "writer", repo: "novel", name: "Novel", tokenIndex: null, bookToken: "ghp_device_b", activeBranch: "feature/ending", activeBranchAt: T2, adoptedFrom: "main", addedAt: T1 };

function structure(branch: string): BookStructure {
  return { title: "Novel", description: "", owner: "writer", repo: "novel", defaultBranch: "main", loadedBranch: branch, chapters: [], characters: [], locations: [], factions: [], items: [], timelines: [], secrets: [], ghostwriters: [], readerPersonas: [] } as unknown as BookStructure;
}

function Probe() {
  const { structure: loaded } = useBookStructure(adopted.id);
  return <p data-testid="branch">{loaded?.loadedBranch ?? ""}</p>;
}

function bookNow(): BookEntry {
  return useSettingsStore.getState().settings.books.find((entry) => entry.id === adopted.id)!;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  resetBookStructureLoadCoordinator();
  useBooksStore.setState({ structures: {}, errors: {}, workingBranches: {}, loadingIds: new Set(), activeStructureOperations: {}, cloneProgress: {}, structureGenerations: {} });
  repository.latestCompleteLocalBookStructure.mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("a book that takes the branch chosen last on another device", () => {
  it("opens it from the copy on this device, keeps it as this device's branch, and says which branch opened and why", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [adopted] } });
    repository.getExistingLocalBookStructure.mockImplementation(async (_id: string, _owner: string, _repo: string, branch: string) => ({ meta: { cloneComplete: true }, structure: structure(branch) }));
    const view = render(<Probe />);
    await waitFor(() => expect(view.getByTestId("branch").textContent).toBe("feature/ending"));
    await waitFor(() => expect(bookNow().adoptedFrom).toBeUndefined());
    expect(bookNow()).toMatchObject({ activeBranch: "feature/ending", activeBranchAt: T2 });
    expect(saved).toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledWith({ title: "Opened the branch feature/ending", description: "It is the branch you worked on last, on another device. This device was on main." });
  });

  it("goes back to the branch it had when GitHub no longer has it, and says so instead of failing", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [adopted] } });
    repository.getExistingLocalBookStructure.mockImplementation(async (_id: string, _owner: string, _repo: string, branch: string) => branch === "main" ? { meta: { cloneComplete: true }, structure: structure("main") } : null);
    repository.ensureLocalBookStructure.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    const view = render(<Probe />);
    await waitFor(() => expect(view.getByTestId("branch").textContent).toBe("main"));
    expect(bookNow()).toMatchObject({ activeBranch: "main", activeBranchAt: T2 });
    expect(bookNow().adoptedFrom).toBeUndefined();
    expect(useBooksStore.getState().errors[adopted.id]).toBeUndefined();
    expect(toasts).toHaveBeenCalledWith({ title: "The branch feature/ending was not opened", description: "feature/ending, the branch you worked on last on another device, is not on GitHub (or not yet): this book stays on main." });
  });

  it("goes back without GitHub when that branch is not on this device, in Italian too", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [{ ...adopted, bookToken: undefined, adoptedFrom: "" }] } });
    repository.getExistingLocalBookStructure.mockImplementation(async (_id: string, _owner: string, _repo: string, branch: string) => branch === "dev-ada" ? { meta: { cloneComplete: true }, structure: structure("dev-ada") } : null);
    repository.latestCompleteLocalBookStructure.mockResolvedValue({ meta: { branch: "dev-ada", cloneComplete: true }, structure: structure("dev-ada") });
    const view = render(<Probe />);
    await waitFor(() => expect(bookNow().adoptedFrom).toBeUndefined());
    expect(bookNow().activeBranch).toBeUndefined();
    expect(repository.ensureLocalBookStructure).not.toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledWith({ title: "Il ramo feature/ending non è stato aperto", description: "feature/ending, il ramo su cui hai lavorato per ultimo su un altro dispositivo, non è su questo dispositivo, e per scaricarlo serve GitHub: il libro resta dov’era (il tuo ramo personale)." });
    await waitFor(() => expect(view.getByTestId("branch").textContent).toBe("dev-ada"));
  });
});
