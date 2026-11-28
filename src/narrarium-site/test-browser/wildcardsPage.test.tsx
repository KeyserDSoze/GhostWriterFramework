import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: null as unknown,
  load: vi.fn(),
  capture: vi.fn(),
  commit: vi.fn(),
  commitMany: vi.fn(),
  saveSettings: vi.fn(),
  toast: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: mocks.reload }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/github/githubClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/github/githubClient")>()), loadFileContent: mocks.load }));
vi.mock("@/assistant/immediateMutation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/assistant/immediateMutation")>()), captureImmediateMutation: mocks.capture, commitImmediateMutation: mocks.commit, commitImmediateMutations: mocks.commitMany }));
vi.mock("@/drive/useSettings", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/drive/useSettings")>()), saveSettingsNow: mocks.saveSettings }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import "@/i18n/wildcards";
import { WildcardsPage } from "@/pages/WildcardsPage";
import { parseWildcard } from "narrarium-engine";
import { useSaveStore } from "@/store/saveStore";
import { useSettingsStore } from "@/store/settingsStore";
import { liveAccountWildcards } from "@/wildcards/accountWildcards";
import type { BookEntry } from "@/types/settings";

// The Wildcards page: the fourteen built-in wildcards and the author's own, turned on and off, created, changed, exported and imported, into the book or into
// the account. Every write goes through the book's working copy or the account's settings; nothing is read from GitHub but the book's own files.

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const POET_OFF = "---\ntype: wildcard\nid: wildcard:poet\nenabled: false\nmood: nocturnal\n---\n";

let files: Record<string, string>;

function structure() {
  const paths = Object.keys(files).filter((path) => path.startsWith("wildcards/"));
  return { title: "The Glass Harbor", language: "en", chapters: [], ghostwriters: [], readerPersonas: [], wildcards: paths.map((path) => ({ path, slug: path.slice(10, -3), name: path })), searchableFiles: [], loadedBranch: "main" };
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/wildcards"]}>
      <Routes><Route path="/app/books/:bookId/wildcards" element={<WildcardsPage />} /></Routes>
    </MemoryRouter>
  );
}

const list = () => screen.getByRole("list", { name: t("wildcards.list") });
const row = (name: string) => within(list()).getByRole("button", { name: new RegExp(`^${name}`) }).closest("li") as HTMLElement;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  files = { "wildcards/poet.md": POET_OFF };
  mocks.book = { ...BOOK };
  mocks.structure = structure();
  mocks.load.mockReset().mockImplementation(async (_token: string, _owner: string, _repo: string, path: string) => files[path] ?? null);
  mocks.capture.mockReset().mockImplementation(async (input: { path: string }) => ({ path: input.path, content: files[input.path] ?? null, sha: "sha", hash: "hash", remoteHeadSha: "head" }));
  mocks.commit.mockReset().mockImplementation(async (input: { snapshot: { path: string }; content: string }) => {
    files[input.snapshot.path] = input.content;
    return "commit";
  });
  mocks.commitMany.mockReset().mockImplementation(async (input: { snapshots: Array<{ snapshot: { path: string }; content: string | null }> }) => {
    for (const entry of input.snapshots) if (entry.content === null) delete files[entry.snapshot.path];
    return "commit";
  });
  mocks.reload.mockReset().mockImplementation(async () => { mocks.structure = structure(); });
  mocks.saveSettings.mockReset().mockResolvedValue(true);
  mocks.toast.mockReset();
  useSettingsStore.getState().patchSettings({ wildcards: undefined, ui: { ...useSettingsStore.getState().settings.ui, language: "en" } });
});

afterEach(() => {
  cleanup();
  useSaveStore.setState({ current: null });
  vi.restoreAllMocks();
});

describe("the Wildcards page", () => {
  it("lists the fourteen built-in wildcards with their group and where they come from; the book's file turned the Poet off", async () => {
    render(<Page />);
    await waitFor(() => expect(within(list()).getAllByRole("listitem")).toHaveLength(14));
    expect(screen.getByRole("heading", { level: 1, name: t("wildcards.title") })).toBeInTheDocument();
    const poet = row("The Poet");
    expect(within(poet).getByText(t("wildcards.source.book"))).toBeInTheDocument();
    expect(within(poet).getByRole("switch", { name: /The Poet/ })).not.toBeChecked();
    expect(within(row("The Subversive")).getByText(t("wildcards.source.builtin"))).toBeInTheDocument();
    expect(within(row("The Subversive")).getByRole("switch")).toBeChecked();
    // The scope and the filters are toggle buttons that say which one is on.
    expect(screen.getByRole("button", { name: t("wildcards.scope.book") })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: t("wildcards.filters.sentinel") }));
    expect(within(list()).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("button", { name: t("wildcards.filters.sentinel") })).toHaveAttribute("aria-pressed", "true");
    // Only the book's own files were read.
    expect(mocks.load.mock.calls.map((call) => call[3])).toEqual(["wildcards/poet.md"]);
  });

  it("turns a built-in wildcard off in the book with a file of its own, and back on keeping the keys of its file", async () => {
    render(<Page />);
    await waitFor(() => expect(within(list()).getAllByRole("listitem")).toHaveLength(14));
    fireEvent.click(within(row("The Naive")).getByRole("switch"));
    await waitFor(() => expect(files["wildcards/naive.md"]).toBeDefined());
    expect(parseWildcard("naive", files["wildcards/naive.md"])).toMatchObject({ id: "wildcard:naive", enabled: false, name: "The Naive", group: "provocateur" });
    fireEvent.click(within(row("The Poet")).getByRole("switch"));
    await waitFor(() => expect(parseWildcard("poet", files["wildcards/poet.md"]).enabled).toBe(true));
    expect(files["wildcards/poet.md"]).toMatch(/mood: nocturnal/);
  });

  it("restores a built-in wildcard by removing the book's file", async () => {
    render(<Page />);
    await waitFor(() => expect(within(list()).getAllByRole("listitem")).toHaveLength(14));
    fireEvent.click(within(row("The Poet")).getByRole("button", { name: /^The Poet/ }));
    fireEvent.click(await screen.findByRole("button", { name: t("wildcards.reset") }));
    await waitFor(() => expect(files["wildcards/poet.md"]).toBeUndefined());
  });

  it("creates a wildcard of the author's own in the account, for every book, and it is listed as the account's", async () => {
    render(<Page />);
    await waitFor(() => expect(within(list()).getAllByRole("listitem")).toHaveLength(14));
    fireEvent.click(screen.getByRole("button", { name: t("wildcards.scope.account") }));
    await waitFor(() => expect(screen.getByRole("button", { name: t("wildcards.scope.account") })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByText(t("wildcards.scope.accountHint"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("wildcards.new") }));
    fireEvent.change(await screen.findByLabelText(t("wildcards.fields.name")), { target: { value: "The Hacker" } });
    fireEvent.change(screen.getByLabelText(t("wildcards.fields.mandate")), { target: { value: "Finds the exploit in every plot." } });
    fireEvent.change(screen.getByLabelText(t("wildcards.fields.audacity", { value: 6 })), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText(t("wildcards.fields.prompt")), { target: { value: "Think like an attacker." } });
    // A provocateur cannot know the secrets as the author does: the choice is there, and off.
    expect(screen.getByLabelText(t("wildcards.fields.secrets"))).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalled());
    const [entry] = liveAccountWildcards(useSettingsStore.getState().settings.wildcards);
    expect(entry.slug).toBe("the-hacker");
    expect(parseWildcard(entry.slug, entry.text)).toMatchObject({ name: "The Hacker", audacity: 9, mandate: "Finds the exploit in every plot.", body: "Think like an attacker.", group: "provocateur" });
    await waitFor(() => expect(within(row("The Hacker")).getByText(t("wildcards.source.account"))).toBeInTheDocument());
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("exports a wildcard as its file and imports files into the book", async () => {
    const created: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => { created.push(blob as Blob); return "blob:wildcard"; });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<Page />);
    await waitFor(() => expect(within(list()).getAllByRole("listitem")).toHaveLength(14));
    fireEvent.click(within(row("The Twist Engineer")).getByRole("button", { name: /^The Twist Engineer/ }));
    fireEvent.click(await screen.findByRole("button", { name: t("wildcards.export") }));
    expect(click).toHaveBeenCalled();
    expect(await created[0].text()).toMatch(/^---\ntype: wildcard\nid: wildcard:twist-engineer\n/);

    const lawyer = new File(["---\ntype: wildcard\nid: wildcard:custom:lawyer\nname: The Lawyer\ngroup: sentinel\ndomain: maritime law\n---\n\nRead as a maritime lawyer.\n"], "lawyer.wildcard.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText(t("wildcards.importLabel")), { target: { files: [lawyer] } });
    await waitFor(() => expect(files["wildcards/lawyer.md"]).toBeDefined());
    expect(parseWildcard("lawyer", files["wildcards/lawyer.md"])).toMatchObject({ id: "wildcard:custom:lawyer", group: "sentinel", domain: "maritime law" });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("wildcards.imported", { count: 1 }) })));
  });

  it("refuses a file too large to be a wildcard, and says which", async () => {
    render(<Page />);
    await waitFor(() => expect(within(list()).getAllByRole("listitem")).toHaveLength(14));
    const huge = new File(["x".repeat(70 * 1024)], "huge.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText(t("wildcards.importLabel")), { target: { files: [huge] } });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive", title: expect.stringContaining("huge.md") })));
    expect(Object.keys(files)).toEqual(["wildcards/poet.md"]);
  });
});
