import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedWriterContext } from "@/assistant/context";
import type { AppSettings, BookEntry } from "@/types/settings";

const mocks = vi.hoisted(() => ({
  completeTextRouted: vi.fn(),
  completeToolRouted: vi.fn(),
  resolveTaskCandidates: vi.fn(),
  readFileWithSha: vi.fn(),
  loadFileContent: vi.fn(),
  captureImmediateMutation: vi.fn(),
  commitImmediateMutation: vi.fn(),
  commitImmediateMutations: vi.fn(),
  resolveRepositoryHeadForMutation: vi.fn(),
  saveReaderPersona: vi.fn(),
}));

vi.mock("@/assistant/router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/assistant/router")>(),
  completeTextRouted: mocks.completeTextRouted,
  completeToolRouted: mocks.completeToolRouted,
  resolveTaskCandidates: mocks.resolveTaskCandidates,
}));

vi.mock("@/github/githubClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/github/githubClient")>(),
  readFileWithSha: mocks.readFileWithSha,
  loadFileContent: mocks.loadFileContent,
}));

vi.mock("@/assistant/immediateMutation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/assistant/immediateMutation")>(),
  captureImmediateMutation: mocks.captureImmediateMutation,
  commitImmediateMutation: mocks.commitImmediateMutation,
  commitImmediateMutations: mocks.commitImmediateMutations,
}));

vi.mock("@/repository/safeRepositoryMutation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/repository/safeRepositoryMutation")>(),
  resolveRepositoryHeadForMutation: mocks.resolveRepositoryHeadForMutation,
}));

vi.mock("@/narrarium/readerEvaluations", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/narrarium/readerEvaluations")>(),
  saveReaderPersona: mocks.saveReaderPersona,
  loadReaderPersonas: vi.fn(async () => []),
}));

import { slugCode } from "narrarium/slug";
import { runAssistantPrompt } from "@/assistant/service";
import { buildCanonEntityDocument } from "@/narrarium/canon";
import { RepositoryError } from "@/repository/repositoryError";

const book = { id: "book", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" } satisfies BookEntry;
const research = { path: "research/2026-11-21-research-0crj2m.md", slug: "2026-11-21-research-0crj2m", title: "2026-11-21-research-0crj2m", sha: "sha" };
const chapter = { slug: "001-chapter", title: "海辺の朝", path: "chapters/001-chapter", paragraphs: [], hasResume: false, hasEvaluation: false };
const structure = { title: "海辺の町", language: "ja", defaultBranch: "main", loadedBranch: "main", chapters: [chapter], characters: [], locations: [], factions: [], items: [], timelines: [], researchFiles: [research], readerEvaluationFiles: [] };
const context = {
  route: { kind: "book", bookId: "book" }, book, structure, chapter: null, paragraph: null, relevantFiles: [], availableFiles: [], loadedFilePaths: [],
  noteTargetPath: "notes.md", branch: "main", branchReady: true, title: "海辺の町", summary: "",
} as unknown as LoadedWriterContext;
const integration = { id: "ai", name: "AI", provider: "openai", apiKey: "key", chatModels: [{ id: "model", name: "model", capabilities: ["default", "create-from-research"] }] };
const settings = { ui: { language: "en" }, copilotTools: { toolOverrides: {} }, aiIntegrations: [integration] } as unknown as AppSettings;

function prompt(text: string) {
  return runAssistantPrompt({ prompt: text, context, settings, book, branch: "main", token: "token", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
}

const reader = (name: string) => JSON.stringify({ name, description: "A careful reader.", profile: "Reads slowly.", aspects: ["pacing"], preferredGenres: [], dislikedGenres: [], experienceLevel: "average", severity: 5, audienceAge: "adult", interests: [], appreciatedElements: [], frequentCriticisms: [], customPrompt: "" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTaskCandidates.mockReturnValue([{ integration, model: "model" }]);
  mocks.resolveRepositoryHeadForMutation.mockResolvedValue("head");
  mocks.saveReaderPersona.mockImplementation(async (input: { profile: { slug: string } }) => `personas/${input.profile.slug}.md`);
  mocks.captureImmediateMutation.mockImplementation(async (input: { path: string }) => ({ path: input.path, content: null, sha: "sha", hash: "hash", remoteHeadSha: "head" }));
  mocks.readFileWithSha.mockImplementation(async (_token: string, _owner: string, _repo: string, _branch: string, path: string) => {
    if (path === research.path) return { content: "---\ntitle: 罗马水道的建造\n---\n\nResearch text.", sha: "research-sha" };
    throw new RepositoryError("missing", "not-found", "read", 404);
  });
});

describe("the assistant creating a simulated reader with a name in any script", () => {
  async function created(name: string): Promise<{ slug: string; name: string }> {
    mocks.saveReaderPersona.mockClear();
    mocks.completeTextRouted.mockResolvedValue(reader(name));
    await prompt("create a simulated reader for people who like quiet stories");
    expect(mocks.saveReaderPersona).toHaveBeenCalledTimes(1);
    return (mocks.saveReaderPersona.mock.calls[0][0] as { profile: { slug: string; name: string } }).profile;
  }

  it("gives the reader a readable file name, always the same one for the same name", async () => {
    const seen = new Set<string>();
    for (const name of ["Тихая гавань", "Η μικρή πόλη", "李明", "海辺の朝", "الميناء"]) {
      const first = await created(name);
      expect(first.name).toBe(name);
      expect(first.slug, name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect((await created(name)).slug, `${name}: again`).toBe(first.slug);
      expect(seen.has(first.slug), `${name} is a new file`).toBe(false);
      seen.add(first.slug);
    }
    expect((await created("李明")).slug).toBe(`reader-${slugCode("李明")}`);
    expect((await created("Тихая гавань")).slug).toBe("tikhaya-gavan");
  });

  it("keeps the file names of Latin names", async () => {
    expect((await created("Night Reader")).slug).toBe("night-reader");
    expect((await created("The Clockmaker's Reader")).slug).toBe("the-clockmaker-s-reader");
    expect((await created("General  Reader!")).slug).toBe("general-reader");
  });

  it("reads the accents of a Latin name as the simulated readers page does, instead of dropping the letter", async () => {
    expect((await created("Lettore di Città")).slug).toBe("lettore-di-citta");
    expect((await created("Zoë D’Angelo")).slug).toBe("zoe-d-angelo");
  });
});

describe("the assistant proposing a canon file from a research document, with a name in any script", () => {
  async function proposed(kind: string, name: string) {
    mocks.completeTextRouted.mockResolvedValue(JSON.stringify({ name, title: name, body: `# ${name}\n\nBody.` }));
    const message = await prompt(`create a ${kind} from research/${research.slug}.md`);
    return message.action as { kind: string; label: string; entityKind: string; destinationPath: string };
  }

  it.each([
    ["character", "李明", "characters/character-0crj2m.md"],
    ["location", "Тихая гавань", "locations/tikhaya-gavan.md"],
    ["item", "古い鍵", `items/item-${slugCode("古い鍵")}.md`],
    ["faction", "الميناء", `factions/faction-${slugCode("الميناء")}.md`],
    ["secret", "Η μικρή πόλη", "secrets/i-mikri-poli.md"],
    ["location", "Città di sale", "locations/citta-di-sale.md"],
  ])("proposes the %s %s at the path the confirmation will create", async (kind, name, path) => {
    const action = await proposed(kind, name);
    expect(action).toMatchObject({ kind: "confirm-create-from-research", entityKind: kind, label: name, destinationPath: path });
    // The confirmation refuses to write when the document it builds is not at the path that was proposed.
    expect(buildCanonEntityDocument({ kind: kind as "character", label: name }).path).toBe(action.destinationPath);
  });
});
