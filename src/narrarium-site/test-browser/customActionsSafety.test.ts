import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings, type CustomAction } from "@/types/settings";
import type { BookStructure } from "@/types/book";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";

const { completeTextRouted, loadWriterContext } = vi.hoisted(() => ({ completeTextRouted: vi.fn(), loadWriterContext: vi.fn() }));

vi.mock("@/assistant/router", () => ({ completeTextRouted }));
vi.mock("@/assistant/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/assistant/context")>();
  return { ...actual, loadWriterContext };
});

import {
  assertFreshReplacementSource,
  assertCurrentCustomActionRecord,
  customActionRecordIdentity,
  customActionTargetIdentity,
  resolveCustomActionTarget,
  runCustomAction,
  SUPPORTED_CUSTOM_ACTION_ROUTE_KINDS,
} from "@/custom-actions/customActions";

function action(patch: Partial<CustomAction> = {}): CustomAction {
  return {
    id: "action-1",
    name: "Rewrite",
    prompt: "Rewrite this",
    capability: "default",
    targetTypes: ["book"],
    activation: "selection",
    injections: { includeBody: true, includeFrontmatter: false, includeContext: true, includeGhostwriter: false },
    outputMode: "replace",
    enabled: true,
    ...patch,
  };
}

function settings(current = action()): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    customActions: [current],
    books: [{ id: "book-1", owner: "owner", repo: "repo", name: "Book", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z" }],
  };
}

function input(current = action(), signal?: AbortSignal): Parameters<typeof runCustomAction>[0] {
  const appSettings = settings(current);
  return {
    accountScope: null,
    action: current,
    pathname: "/app/books/book-1",
    settings: appSettings,
    books: appSettings.books,
    structures: {},
    workingBranches: {},
    selection: "selected",
    selectionRange: { start: 7, end: 15 },
    editorBody: "before selected after",
    signal,
  };
}

describe("custom action execution safety", () => {
  beforeEach(() => {
    completeTextRouted.mockReset().mockResolvedValue("replacement");
    loadWriterContext.mockReset().mockResolvedValue({ summary: "summary", relevantFiles: [{ path: "book.md", content: "before selected after" }, { path: "plot.md", content: "plot" }] });
  });

  it("defines every supported route explicitly", () => {
    expect(SUPPORTED_CUSTOM_ACTION_ROUTE_KINDS).toEqual([
      "book", "reader", "research", "research-detail", "book-settings", "chapter", "chapter-workspace", "paragraph", "paragraph-workspace", "canon",
    ]);
  });

  it.each([
    ["book", "/app/books/book-1", "book", "book.md"],
    ["reader", "/app/books/book-1/reader", "book", "book.md"],
    ["research", "/app/books/book-1/research", "book", "book.md"],
    ["research-detail", "/app/books/book-1/research/source", "book", "book.md"],
    ["book-settings", "/app/books/book-1/settings", "book", "book.md"],
    ["chapter", "/app/books/book-1/chapters/001-start", "chapter", "chapters/001-start/chapter.md"],
    ["chapter draft", "/app/books/book-1/chapters/001-start/workspace/draft", "chapter", "drafts/001-start/chapter.md"],
    ["chapter resume", "/app/books/book-1/chapters/001-start/workspace/resume", "chapter", "resumes/chapters/001-start.md"],
    ["chapter evaluation", "/app/books/book-1/chapters/001-start/workspace/evaluation", "chapter", "evaluations/chapters/001-start.md"],
    ["paragraph", "/app/books/book-1/chapters/001-start/paragraphs/001", "paragraph", "chapters/001-start/001-one.md"],
    ["paragraph draft", "/app/books/book-1/chapters/001-start/paragraphs/001/workspace/draft", "paragraph", "drafts/001-start/001-one.md"],
    ["paragraph script", "/app/books/book-1/chapters/001-start/paragraphs/001/workspace/script", "paragraph", "scripts/001-start/001-one.md"],
    ["paragraph evaluation", "/app/books/book-1/chapters/001-start/paragraphs/001/workspace/evaluation", "paragraph", "evaluations/paragraphs/001-start/001-one.md"],
    ["canon", "/app/books/book-1/canon/characters/aria", "character", "characters/aria.md"],
  ])("resolves the supported %s route", (_name, pathname, type, filePath) => {
    const appSettings = settings();
    const target = resolveCustomActionTarget({ pathname, settings: appSettings, books: appSettings.books, structures: routeStructures(), workingBranches: { "book-1": "main" } });
    expect(target).toMatchObject({ type, filePath, branch: "main" });
  });

  it.each([
    ["app home", "/app"],
    ["unsupported book page", "/app/books/book-1/dashboard"],
    ["unknown chapter workspace", "/app/books/book-1/chapters/001-start/workspace/unknown"],
    ["unknown paragraph workspace", "/app/books/book-1/chapters/001-start/paragraphs/001/workspace/unknown"],
    ["unknown canon section", "/app/books/book-1/canon/unknown/entry"],
    ["missing chapter", "/app/books/book-1/chapters/missing"],
    ["missing book", "/app/books/missing"],
  ])("rejects the unsupported %s route", (_name, pathname) => {
    const appSettings = settings();
    expect(resolveCustomActionTarget({ pathname, settings: appSettings, books: appSettings.books, structures: routeStructures(), workingBranches: { "book-1": "main" } })).toBeNull();
  });

  it("revalidates the current action record before executing", async () => {
    const invoked = action();
    const current = action({ enabled: false });
    await expect(runCustomAction({ ...input(current), action: invoked })).rejects.toThrow("no longer available");
    expect(completeTextRouted).not.toHaveBeenCalled();
  });

  it("injects selection once, non-selected body once, and excludes the target from context", async () => {
    await runCustomAction(input());
    const messages = completeTextRouted.mock.calls[0][1] as Array<{ content: string }>;
    const prompt = messages[1].content;
    expect(prompt.match(/selected/g)).toHaveLength(1);
    expect(prompt).toContain("BODY (EXCLUDING TEXT TO PROCESS):\nbefore  after");
    expect(prompt).toContain("FILE: plot.md");
    expect(prompt).not.toContain("FILE: book.md");
  });

  it("keeps context disjoint from body and ghostwriter injections", async () => {
    loadWriterContext.mockResolvedValue({
      summary: "summary",
      relevantFiles: [
        { path: "book.md", content: "body" },
        { path: "ghostwriters/default.md", content: "ghostwriter" },
        { path: "plot.md", content: "plot" },
      ],
    });
    const current = action({ injections: { includeBody: false, includeFrontmatter: false, includeContext: true, includeGhostwriter: false } });
    const data = input(current);
    data.structures = { "book-1": { title: "Book", ghostwriters: [{ slug: "default", path: "ghostwriters/default.md", name: "Default" }], chapters: [] } as unknown as BookStructure };
    await runCustomAction(data);
    const prompt = (completeTextRouted.mock.calls[0][1] as Array<{ content: string }>)[1].content;
    expect(prompt).toContain("FILE: plot.md");
    expect(prompt).not.toMatch(/FILE: (book\.md|ghostwriters\/default\.md)/);
  });

  it("rejects unknown workspace kinds without falling back to source prose", () => {
    const appSettings = settings();
    const chapter = { slug: "001-start", title: "Start", path: "chapters/001-start", paragraphs: [{ number: "001", title: "One", path: "chapters/001-start/001.md" }] };
    const structures = { "book-1": { title: "Book", chapters: [chapter] } as never };
    expect(resolveCustomActionTarget({ pathname: "/app/books/book-1/chapters/001-start/workspace/unknown", settings: appSettings, books: appSettings.books, structures, workingBranches: {} })).toBeNull();
    expect(resolveCustomActionTarget({ pathname: "/app/books/book-1/chapters/001-start/paragraphs/001/workspace/unknown", settings: appSettings, books: appSettings.books, structures, workingBranches: {} })).toBeNull();
  });

  it("resolves canonical chapter and paragraph draft paths when draftPath is absent", () => {
    const appSettings = settings();
    const chapter = { slug: "001-start", title: "Start", path: "chapters/001-start", paragraphs: [{ number: "001", title: "One", path: "chapters/001-start/001-one.md" }] };
    const structures = { "book-1": { title: "Book", chapters: [chapter] } as never };
    expect(resolveCustomActionTarget({ pathname: "/app/books/book-1/chapters/001-start/workspace/draft", settings: appSettings, books: appSettings.books, structures, workingBranches: {} })?.filePath).toBe("drafts/001-start/chapter.md");
    expect(resolveCustomActionTarget({ pathname: "/app/books/book-1/chapters/001-start/paragraphs/001/workspace/draft", settings: appSettings, books: appSettings.books, structures, workingBranches: {} })?.filePath).toBe("drafts/001-start/001-one.md");
  });

  it("snapshots every action field and detects apply-time configuration drift", () => {
    const original = action();
    const identity = customActionRecordIdentity(original);
    expect(() => assertCurrentCustomActionRecord({ ...original }, identity)).not.toThrow();
    expect(() => assertCurrentCustomActionRecord({ ...original, activation: "element" }, identity)).toThrow("changed while it was running");
    expect(() => assertCurrentCustomActionRecord({ ...original, prompt: "Changed" }, identity)).toThrow("changed while it was running");
    expect(() => assertCurrentCustomActionRecord({ ...original, targetTypes: ["chapter"] }, identity)).toThrow("changed while it was running");
    expect(() => assertCurrentCustomActionRecord({ ...original, injections: { ...original.injections, includeContext: false } }, identity)).toThrow("changed while it was running");
  });

  it("rejects action and target drift before generation starts", async () => {
    const original = action();
    const changedAction = action({ prompt: "Changed" });
    const changed = input(changedAction);
    changed.action = original;
    changed.expectedActionIdentity = customActionRecordIdentity(original);
    await expect(runCustomAction(changed)).rejects.toThrow("changed while it was running");

    const targetChanged = input(original);
    targetChanged.expectedTargetIdentity = "different-target";
    await expect(runCustomAction(targetChanged)).rejects.toThrow("target changed before generation");
    expect(completeTextRouted).not.toHaveBeenCalled();
  });

  it("rejects a live target or branch change immediately before execution", async () => {
    const current = action();
    const data = input(current);
    data.getCurrentBookState = () => ({ structures: {}, workingBranches: { "book-1": "changed" } });
    await expect(runCustomAction(data)).rejects.toThrow("target changed");
    expect(completeTextRouted).not.toHaveBeenCalled();
  });

  it("binds target identity to repository coordinates and the full structure revision", async () => {
    const current = action();
    const data = input(current);
    data.structures = routeStructures();
    data.workingBranches = { "book-1": "main" };
    let settingsReads = 0;
    data.getCurrentSettings = () => settingsReads++ === 0
      ? data.settings
      : { ...data.settings, books: [{ ...data.settings.books[0]!, owner: "replacement-owner", repo: "replacement-repo" }] };
    data.getCurrentBookState = () => ({ structures: routeStructures(), workingBranches: { "book-1": "main" } });
    await expect(runCustomAction(data)).rejects.toThrow("target changed");

    const structureData = input(current);
    structureData.structures = routeStructures();
    structureData.workingBranches = { "book-1": "main" };
    const changedStructures = routeStructures();
    changedStructures["book-1"] = { ...changedStructures["book-1"]!, description: "Changed structure revision" };
    structureData.getCurrentBookState = () => ({ structures: changedStructures, workingBranches: { "book-1": "main" } });
    await expect(runCustomAction(structureData)).rejects.toThrow("target changed");
  });

  it("passes cancellation through the LLM and rejects a late result", async () => {
    let resolve!: (value: string) => void;
    completeTextRouted.mockImplementation((_settings, _messages, _capability, options) => new Promise<string>((done) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      resolve = done;
    }));
    const controller = new AbortController();
    const pending = runCustomAction(input(action(), controller.signal));
    await vi.waitFor(() => expect(completeTextRouted).toHaveBeenCalled());
    controller.abort();
    resolve("late");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts before dispatch when the account changes during repository context preparation", async () => {
    setFallbackAcknowledgementAccountScope("google:first@example.com");
    const pending = input();
    pending.accountScope = "google:first@example.com";
    loadWriterContext.mockImplementationOnce(async () => {
      setFallbackAcknowledgementAccountScope("google:second@example.com");
      return { summary: "prepared", relevantFiles: [] };
    });

    await expect(runCustomAction(pending)).rejects.toMatchObject({ name: "AbortError" });
    expect(completeTextRouted).not.toHaveBeenCalled();
  });

  it("rejects changed content and stale source ranges before replacement", () => {
    expect(() => assertFreshReplacementSource({ currentValue: "changed", sourceValue: "original", selection: "x", range: { start: 0, end: 1 }, activation: "selection" })).toThrow("source text changed");
    expect(() => assertFreshReplacementSource({ currentValue: "original", sourceValue: "original", selection: "x", range: { start: 0, end: 1 }, activation: "selection" })).toThrow("source range is stale");
    expect(() => assertFreshReplacementSource({ currentValue: "x original", sourceValue: "x original", selection: "x", range: { start: 0, end: 1 }, activation: "selection" })).not.toThrow();
  });
});

function routeStructures(): Record<string, BookStructure> {
  return {
    "book-1": {
      title: "Book",
      description: "Description",
      owner: "owner",
      repo: "repo",
      defaultBranch: "main",
      loadedBranch: "main",
      chapters: [{
        slug: "001-start",
        title: "Start",
        path: "chapters/001-start",
        paragraphs: [{ number: "001", title: "One", path: "chapters/001-start/001-one.md" }],
        hasResume: true,
        hasEvaluation: true,
      }],
      characters: [], locations: [], factions: [], items: [], timelines: [], secrets: [], ghostwriters: [], readerPersonas: [], readerEvaluationFiles: [], operationManifestFiles: [], auditFiles: [], researchFiles: [], notesFiles: [],
    },
  };
}
