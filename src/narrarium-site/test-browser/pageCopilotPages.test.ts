import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";
import { parseDirector, parseGhostwriter } from "narrarium-engine";

// The pages that work with the Copilot besides the simulated readers: what the Copilot sees of each (never a secret), and the batch each proposes, reviewed
// with the resulting state of everything on the page before anything is written.

const files = vi.hoisted(() => ({ store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore> }));
vi.mock("@/github/githubClient", async (importOriginal) => {
  const { RepositoryError } = await import("@/repository/repositoryError");
  return {
    ...(await importOriginal<typeof import("@/github/githubClient")>()),
    readFileWithSha: vi.fn(async (_token: string, _owner: string, _repo: string, _branch: string, path: string) => {
      const file = await files.store.read(path);
      if (!file) throw new RepositoryError(`${path} was not found.`, "not-found", "read", 404);
      return { content: file.content, sha: file.hash };
    }),
  };
});

import { parseAppRoute, type LoadedWriterContext } from "@/assistant/context";
import { loadPage, pageIdForPrompt, pageIdForRoute, pageIds } from "@/assistant/pages/registry";
import { ghostwriterFileContent, ghostwritersPage, planGhostwriterChanges } from "@/assistant/pages/ghostwriters";
import { directorPage } from "@/assistant/pages/director";
import { evaluationStylePage, parseEvaluationDoc, planEvaluationStyle, renderEvaluationDoc } from "@/assistant/pages/evaluationStyle";
import { canonPage, parseEntryFile, planCanonChanges, renderEntryFile, visibleFacts, writableCanonFields } from "@/assistant/pages/canon";
import { autopilotSettingsPage, autopilotSettingsText } from "@/assistant/pages/autopilotSettings";
import { assetsPage } from "@/assistant/pages/assets";
import { pageStateBlock } from "@/assistant/service";
import type { PageEnv } from "@/assistant/pages/types";
import type { BookStructure } from "@/types/book";
import { DEFAULT_SETTINGS, type AppSettings, type BookEntry } from "@/types/settings";

const BOOK = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, addedAt: "now" } as BookEntry;
const SETTINGS = { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language: "en" } } as AppSettings;

const MARA = [
  "---",
  "type: character",
  "id: character:mara",
  "name: Mara Vell",
  "# the harbor's pilot",
  "story_role: protagonist",
  "age: 34",
  "aliases:",
  "  - The Pilot",
  "secret_refs:",
  "  - secret:mara-sold-the-maps",
  "private_notes: She sold the maps in chapter 2.",
  "known_from: chapter:003-storm",
  "---",
  "",
  "A pilot who knows every rock of the harbor.",
  "",
].join("\n");

function structure(): BookStructure {
  return {
    title: "The Glass Harbor",
    language: "en",
    ghostwriter: "noir",
    ghostwriters: [{ slug: "noir", path: "ghostwriters/noir.md", name: "Noir" }, { slug: "lyric", path: "ghostwriters/lyric.md", name: "Lyric" }],
    chapters: [{ slug: "001-dawn", title: "Dawn", path: "chapters/001-dawn", imagePath: "assets/chapters/001-dawn/primary.png", paragraphs: [{ number: "001", title: "The quay", path: "chapters/001-dawn/001-the-quay.md" }] }],
    characters: [{ path: "characters/mara.md", sha: "x", size: 1, name: "Mara Vell" }, { path: "characters/ilan.md", sha: "y", size: 1, name: "Ilan" }],
    locations: [{ path: "locations/old-harbor.md", sha: "z", size: 1, name: "The Old Harbor" }],
    factions: [],
    items: [],
    secrets: [{ path: "secrets/mara-sold-the-maps.md", sha: "s", size: 1, name: "Mara sold the maps", knownFrom: "chapter:003-storm" }],
    timelines: [],
    readerPersonas: [],
    researchFiles: [],
    readerEvaluationFiles: [],
  } as unknown as BookStructure;
}

function context(pathname: string): LoadedWriterContext {
  return { route: parseAppRoute(pathname), book: BOOK, structure: structure(), chapter: null, paragraph: null, title: "Page", summary: "", availableFiles: [], relevantFiles: [], loadedFilePaths: [], noteTargetPath: null, branch: "main", branchReady: true } as unknown as LoadedWriterContext;
}

function env(pathname: string, patch: Partial<PageEnv> = {}): PageEnv {
  const loaded = context(pathname);
  return { settings: SETTINGS, book: BOOK, branch: "main", token: "local", structure: loaded.structure!, context: loaded, prompt: "x", italian: false, view: null, accountScope: null, ...patch };
}

beforeEach(() => {
  files.store = new MemoryBookStore({
    "ghostwriters/noir.md": "---\ntype: ghostwriter\nid: ghostwriter:noir\nname: Noir\ntone: dry and dark\npov_default: first person\nmood_board: rain\n---\n\nShort sentences.\n",
    "ghostwriters/lyric.md": "---\ntype: ghostwriter\nid: ghostwriter:lyric\nname: Lyric\ntone: warm\n---\n\nLong breaths.\n",
    "characters/mara.md": MARA,
    "characters/ilan.md": "---\ntype: character\nid: character:ilan\nname: Ilan\n---\n\nA fisherman.\n",
    "locations/old-harbor.md": "---\ntype: location\nid: location:old-harbor\nname: The Old Harbor\n---\n\nStone and fog.\n",
    "secrets/mara-sold-the-maps.md": "---\ntype: secret\nid: secret:mara-sold-the-maps\nname: Mara sold the maps\n---\n\nShe sold them to the Guild.\n",
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the pages of a book that work with the Copilot", () => {
  it("are found from the address: ghostwriters, director, evaluation style, autopilot configuration, assets, and the canon but its secrets and its timeline", () => {
    expect(pageIds()).toEqual(["readers", "ghostwriters", "director", "evaluation-style", "autopilot-settings", "canon", "assets"]);
    expect(pageIdForRoute(parseAppRoute("/app/books/book-1/ghostwriters"))).toBe("ghostwriters");
    expect(pageIdForRoute(parseAppRoute("/app/books/book-1/director"))).toBe("director");
    expect(pageIdForRoute(parseAppRoute("/app/books/book-1/evaluation-style"))).toBe("evaluation-style");
    expect(pageIdForRoute(parseAppRoute("/app/books/book-1/autopilot/settings"))).toBe("autopilot-settings");
    expect(pageIdForRoute(parseAppRoute("/app/books/book-1/assets"))).toBe("assets");
    for (const section of ["characters", "locations", "factions", "items"]) expect(pageIdForRoute(parseAppRoute(`/app/books/book-1/canon/${section}/someone`))).toBe("canon");
    expect(pageIdForRoute(parseAppRoute("/app/books/book-1/canon/secrets/mara-sold-the-maps"))).toBeNull();
    expect(pageIdForRoute(parseAppRoute("/app/books/book-1/canon/timelines/the-storm"))).toBeNull();
  });

  it("know a request about them by its words, the page the author is on first", () => {
    expect(pageIdForPrompt("crea un ghostwriter noir")).toBe("ghostwriters");
    expect(pageIdForPrompt("make the director stricter")).toBe("director");
    expect(pageIdForPrompt("aggiungi un criterio sul ritmo")).toBe("evaluation-style");
    expect(pageIdForPrompt("cambia l'età del personaggio")).toBe("canon");
    expect(pageIdForPrompt("give the reader of the director more weight", "director")).toBe("director");
    expect(pageIdForPrompt("evaluate this chapter")).toBeNull();
  });
});

describe("the Ghostwriters page", () => {
  it("lets the Copilot see every ghostwriter with its voice, the book's default first named, and what the page has open", async () => {
    const state = await ghostwritersPage.state(env("/app/books/book-1/ghostwriters", { view: { selected: "lyric" } }));
    expect(state).toContain("Ghostwriters: 2; the book's default is Noir.");
    expect(state).toContain("On the page now: selected: Lyric (lyric).");
    expect(state).toContain("- Noir · noir · the book's default · dry and dark; POV first person");
  });

  it("plans a batch with every ghostwriter's resulting state, and never removes the book's default nor its last", async () => {
    const entries = [
      { path: "ghostwriters/noir.md", profile: parseGhostwriter("noir", (await files.store.read("ghostwriters/noir.md"))!.content) },
      { path: "ghostwriters/lyric.md", profile: parseGhostwriter("lyric", (await files.store.read("ghostwriters/lyric.md"))!.content) },
    ];
    const plan = planGhostwriterChanges(entries, { create: [{ name: "Gothic", tone: "ornate" }], update: [{ ghostwriter: "Lyric", set: { tone: "warm and slow", avoid: ["clichés"] } }], remove: ["Noir"] }, "noir");
    expect(plan.rows.map((row) => [row.name, row.change, row.fields ?? []])).toEqual([["Gothic", "created", []], ["Lyric", "edited", ["tone", "avoid"]], ["Noir", "unchanged", []]]);
    expect(plan.problems).toEqual(["«Noir» is the book's default ghostwriter: it is never removed."]);
    expect(plan.write.map((entry) => entry.path)).toEqual(["ghostwriters/lyric.md", "ghostwriters/gothic.md"]);
    const lonely = planGhostwriterChanges(entries.slice(1), { remove: ["lyric"] }, "noir");
    expect(lonely.remove).toEqual([]);
    expect(lonely.problems).toEqual(["«Lyric» is the book's last ghostwriter: it is never removed."]);
    const removal = planGhostwriterChanges(entries, { remove: ["lyric"] }, "noir");
    expect(removal.rows.find((row) => row.id === "lyric")?.change).toBe("removed");
  });

  it("does not remove a ghostwriter that still writes a chapter, nor edit one whose file the engine cannot read whole", async () => {
    await files.store.commit([{ path: "chapters/001-dawn/chapter.md", content: "---\ntype: chapter\ntitle: Dawn\nghostwriter: lyric\n---\n" }, { path: "ghostwriters/lyric.md", content: "---\nname: Lyric\ntemperature: hot\n---\n" }], "seed");
    const used = env("/app/books/book-1/ghostwriters");
    used.structure = { ...used.structure, searchableFiles: [{ path: "chapters/001-dawn/chapter.md", sha: "c", size: 1, role: "chapter" }] } as BookStructure;
    const tool = ghostwritersPage.tools.find((entry) => entry.id === "propose_ghostwriter_changes")!;
    const removal = await tool.run({ remove: ["Lyric"] } as never, used);
    expect(removal).toMatchObject({ kind: "refused" });
    expect(removal.text).toContain("«Lyric» still writes the book, a chapter, a scene, a draft or a script: it is not removed.");
    const edit = await tool.run({ update: [{ ghostwriter: "Lyric", set: { tone: "cold" } }] } as never, used);
    expect(edit.text).toContain("«Lyric» has problems its page shows");
  });

  it("writes a ghostwriter's file with what the profile says over the keys only the author's file has", () => {
    const profile = parseGhostwriter("noir", "---\nname: Noir\ntone: dry\nmood_board: rain\n---\n\nShort.\n");
    const written = ghostwriterFileContent({ ...profile, tone: "drier" }, "---\nname: Noir\ntone: dry\nmood_board: rain\n---\n\nShort.\n");
    expect(written).toContain("mood_board: rain");
    expect(written).toContain("tone: drier");
    expect(parseGhostwriter("noir", written).tone).toBe("drier");
  });

  it("proposes the batch for the author to apply: one change of the files, the removals included", async () => {
    const outcome = await ghostwritersPage.tools.find((tool) => tool.id === "propose_ghostwriter_changes")!.run({ create: [{ name: "Gothic", tone: "ornate" }], remove: ["Lyric"] } as never, env("/app/books/book-1/ghostwriters"));
    expect(outcome.kind).toBe("proposal");
    const message = (outcome as { message: { text: string; action: { toolId: string; updates: Array<{ path: string; content: string | null }>; review: { page: string } } } }).message;
    expect(message.text).toBe("Proposed changes to the ghostwriters: 1 created, 1 removed. Nothing changes until you apply the proposal.");
    expect(message.action.toolId).toBe("edit-page");
    expect(message.action.review.page).toBe("ghostwriters");
    expect(message.action.updates.map((update) => [update.path, update.content === null])).toEqual([["ghostwriters/gothic.md", false], ["ghostwriters/lyric.md", true]]);
    expect([...files.store.files.keys()]).not.toContain("ghostwriters/gothic.md");
  });
});

describe("the Director page", () => {
  it("lets the Copilot see the director, the default one while the book has none", async () => {
    expect(await directorPage.state(env("/app/books/book-1/director"))).toContain("(the default: the book has no director.md yet)");
  });

  it("proposes the fields to change, each before and after, as the engine will read them back", async () => {
    const tool = directorPage.tools.find((entry) => entry.id === "propose_director_changes")!;
    const outcome = await tool.run({ set: { strictness: 9, redLines: ["No deus ex machina"], autonomy: "ask-always" } } as never, env("/app/books/book-1/director", { italian: true }));
    const message = (outcome as { message: { text: string; action: { updates: Array<{ path: string; content: string }>; review: { rows: Array<{ id: string; change: string; from?: string; to?: string }> } } } }).message;
    expect(message.text).toBe("Modifiche proposte al direttore: 3 modificati. Nulla cambia finché non applichi la proposta.");
    expect(message.action.review.rows.filter((row) => row.change === "edited").map((row) => [row.id, row.from, row.to])).toEqual([["autonomy", "ask-on-critical", "ask-always"], ["strictness", "7", "9"], ["redLines", expect.any(String), "No deus ex machina"]]);
    expect(parseDirector(message.action.updates[0].content, "en")).toMatchObject({ strictness: 9, autonomy: "ask-always", redLines: ["No deus ex machina"] });
    const same = await tool.run({ set: { strictness: 7 } } as never, env("/app/books/book-1/director"));
    expect(same).toMatchObject({ kind: "refused" });
  });
});

describe("the Evaluation style page", () => {
  it("plans criteria added, changed and removed and a new method, each in a row", () => {
    const doc = parseEvaluationDoc("---\nlanguage: en\ncriteria:\n  prose:\n    description: Clear prose\n  pacing:\n    description: Scenes move\n---\n\nBe fair.\n");
    const plan = planEvaluationStyle(doc, { add: [{ name: "Dialogue voice", description: "Each voice is distinct" }], update: [{ name: "prose", description: "Clear, concrete prose" }], remove: ["pacing"], method: "Be strict." });
    expect(plan.rows.map((row) => [row.id, row.change])).toEqual([["dialogue_voice", "created"], ["prose", "edited"], ["@method", "edited"], ["pacing", "removed"]]);
    const written = parseEvaluationDoc(renderEvaluationDoc(plan.doc));
    expect(written.criteria).toEqual([{ key: "prose", description: "Clear, concrete prose" }, { key: "dialogue_voice", description: "Each voice is distinct" }]);
    expect(written.frontmatter.language).toBe("en");
    expect(written.body).toBe("Be strict.");
    expect(planEvaluationStyle(doc, { remove: ["voice"] }).problems).toEqual(["No criterion is called «voice»."]);
  });

  it("lets the Copilot see the defaults while the book has no evaluation style", async () => {
    expect(await evaluationStylePage.state(env("/app/books/book-1/evaluation-style"))).toMatch(/^Evaluation style \(the defaults: the book has no evaluation-guidelines\.md yet\): \d+ criteria\./);
  });
});

describe("the page of an entry of the canon", () => {
  it("never shows the Copilot what points to a secret or the author's private notes, nor lists the secrets", async () => {
    const page = await loadPage({ context: context("/app/books/book-1/canon/characters/mara"), settings: SETTINGS, book: BOOK, branch: "main", token: "local", prompt: "make her older", accountScope: null });
    expect(page?.id).toBe("canon");
    for (const text of [page!.state, pageStateBlock({ page } as never)]) {
      expect(text).toContain("character «Mara Vell» (characters/mara.md)");
      expect(text).toContain("- story_role: protagonist");
      expect(text).toContain("The other characters: Ilan.");
      expect(text).not.toMatch(/secret_refs|mara-sold-the-maps|private_notes|sold the maps|known_from|chapter:003-storm/);
    }
    expect(visibleFacts({ type: "character", id: "x", name: "Mara", secret_refs: ["a"], private_notes: "b", reveal_in: "c", known_from: "d", age: 3 })).toEqual({ name: "Mara", age: 3 });
    const read = await canonPage.tools.find((tool) => tool.id === "read_canon_entry")!.run({ name: "Mara sold the maps" } as never, env("/app/books/book-1/canon/characters/mara"));
    expect(read.text).toContain("No character, location, faction or item is called «Mara sold the maps»");
    expect(read.text).not.toContain("Guild");
  });

  it("sets only the fields of the entry's kind, never its name nor a secret one, and keeps the rest of the file as the author wrote it", () => {
    expect(writableCanonFields("character").has("age")).toBe(true);
    for (const key of ["name", "type", "id", "secret_refs", "private_notes", "reveal_in", "known_from"]) expect(writableCanonFields("character").has(key)).toBe(false);
    const file = parseEntryFile(MARA);
    const plan = planCanonChanges("character", file, { set: { age: "35", aliases: null, occupation: "harbor pilot", secret_refs: [], name: "Mara", mood: "x" }, body: "A pilot who knows every rock." });
    expect(plan.problems).toEqual(["«secret_refs» is not changed by the Copilot.", "«name» is not changed by the Copilot.", "«mood» is not a field of a character."]);
    expect(plan.rows.filter((row) => row.change !== "unchanged").map((row) => [row.id, row.change])).toEqual([["occupation", "created"], ["age", "edited"], ["@body", "edited"], ["aliases", "removed"]]);
    expect(plan.rows.map((row) => row.id)).not.toContain("secret_refs");
    const written = renderEntryFile(MARA, plan.file);
    expect(written).toContain("# the harbor's pilot");
    expect(written).toContain("secret_refs:\n  - secret:mara-sold-the-maps");
    expect(written).toContain("private_notes: She sold the maps in chapter 2.");
    expect(written).not.toContain("The Pilot");
    expect(parseEntryFile(written)).toMatchObject({ frontmatter: { age: 35, occupation: "harbor pilot", name: "Mara Vell" }, body: "A pilot who knows every rock." });
  });
});

describe("a file the Copilot cannot read whole", () => {
  it("is never written over: the author corrects it on its page first", async () => {
    await files.store.commit([{ path: "evaluation-guidelines.md", content: "---\ncriteria: [prose\n---\n\nBe fair.\n" }, { path: "characters/ilan.md", content: "---\nname: Ilan\nage: [\n---\n\nA fisherman.\n" }], "seed");
    const style = await evaluationStylePage.tools.find((tool) => tool.id === "propose_evaluation_style_changes")!.run({ method: "Be strict." } as never, env("/app/books/book-1/evaluation-style"));
    expect(style).toMatchObject({ kind: "refused" });
    expect(style.text).toContain("evaluation-guidelines.md has a frontmatter that cannot be read");
    const entry = await canonPage.tools.find((tool) => tool.id === "propose_canon_entry_changes")!.run({ entry: "Ilan", set: { age: "40" } } as never, env("/app/books/book-1/canon/characters/mara"));
    expect(entry).toMatchObject({ kind: "refused" });
    expect(entry.text).toContain("characters/ilan.md has a frontmatter that cannot be read");
  });
});

describe("the pages the Copilot reads but does not change", () => {
  it("shows the autopilot's settings and the Synopsis brief, never its plan nor its concept", () => {
    const text = autopilotSettingsText(JSON.stringify({ status: "paused", phase: "writing", rules: [{ text: "Never kill Ilan" }], options: { approvalScore: 8, budgets: { maxCostUsd: 5 }, readers: ["critical"] }, plan: { chapters: ["The twist: Mara sold the maps"] }, concept: { secrets: ["Mara sold the maps"] } }), "---\ngenre: noir\naudience: adult\nwords_per_scene: 1200\n---\n");
    expect(text).toContain("Autopilot: paused, phase writing; 1 permanent rule.");
    expect(text).toContain("- approvalScore: 8");
    expect(text).toContain("- budgets.maxCostUsd: 5");
    expect(text).toContain("Brief of the Synopsis: genre noir; audience adult");
    expect(text).not.toMatch(/Mara sold the maps|Never kill Ilan/);
    expect(autopilotSettingsPage.tools.map((tool) => tool.id)).toEqual(["read_autopilot_settings"]);
  });

  it("lists the images of the book, the missing ones and what the page filters", async () => {
    const state = await assetsPage.state(env("/app/books/book-1/assets", { view: { filter: "missing" } }));
    expect(state).toContain("Images: 1 of 3 made (2 missing); the cover is missing.");
    expect(state).toContain("On the page now: filter: missing.");
    expect(state).toContain("- chapter · Dawn · image");
    expect(state).toContain("- paragraph · Dawn / The quay · no image");
    expect(assetsPage.tools.map((tool) => tool.id)).toEqual(["read_assets"]);
  });
});
