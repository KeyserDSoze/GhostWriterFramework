import { beforeEach, describe, expect, it, vi } from "vitest";
import { readOutlineChapter, serializeOutlineBook, serializeOutlineChapter } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({ store: null as unknown, complete: vi.fn() }));

// The book's working copy is a store in memory: the same reads and commits the Synopsis page makes.
vi.mock("@/outline/outlineSource", async (original) => {
  const module = await original<typeof import("@/outline/outlineSource")>();
  return { ...module, browserOutlineSource: () => module.storeOutlineSource(mocks.store as never) };
});
vi.mock("@/assistant/router", () => ({ completeTextRouted: mocks.complete }));

import { BRAINSTORM_TOOL_IDS, appendBrainstormNotes, brainstormToolIds, runBrainstormTool, synopsisFindings, type BrainstormToolEnv } from "@/assistant/brainstorm/tools";
import { loadBrainstormContext } from "@/assistant/brainstorm/context";
import { brainstormLanguage, brainstormSystemPrompt } from "@/assistant/brainstorm/prompts";
import { MAX_BRAINSTORM_ROUNDS, parseBrainstormTurn, runBrainstormPrompt } from "@/assistant/brainstorm/runner";
import { copilotToolRegistry } from "@/assistant/tools/registry";
import { ensureBuiltinCopilotToolsRegistered } from "@/assistant/tools/builtinTools";
import type { BookStructure } from "@/types/book";
import { BRAINSTORMING_CAPABILITY, DEFAULT_SETTINGS, type AppSettings, type BookEntry } from "@/types/settings";

const D = "0123456789abcdef";
const BOOK: BookEntry = { id: "book", owner: "", repo: "", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", localRepositoryId: "repo", activeBranch: "local:repo", addedAt: "2026-11-21T00:00:00.000Z" };
const scene = { number: 1, title: "A scene", goal: "", beats: [], characters: [], status: "reviewed", revisions: 0 };
const STATE = { options: { frozenEdits: "ask" }, plan: { approved: true, chapters: [
  { number: 1, title: "Arrival", slug: "001-arrival", summary: "Mira arrives.", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [scene], outlineDigest: D },
  { number: 2, title: "The key", slug: "002-the-key", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "planned", scenes: [], outlineDigest: D },
] } };

function structure(): BookStructure {
  return {
    title: "The Glass Harbor", description: "A harbor town built on glass hides a lie.", language: "en", owner: "", repo: "", defaultBranch: "main", loadedBranch: "main",
    chapters: [{ slug: "001-arrival", path: "chapters/001-arrival/", title: "Arrival", paragraphs: [{ number: "001", title: "Quay", path: "chapters/001-arrival/001-quay.md" }] }],
    characters: [{ path: "characters/mira.md", sha: "1", size: 1, name: "Mira" }], locations: [{ path: "locations/harbor.md", sha: "2", size: 1, name: "The Harbor" }], factions: [], items: [], timelines: [],
    secrets: [{ path: "secrets/the-lie.md", sha: "3", size: 1, name: "The lie" }],
    ghostwriters: [{ slug: "noir", path: "ghostwriters/noir.md", name: "Noir" }], readerPersonas: [], readerEvaluationFiles: [], operationManifestFiles: [], auditFiles: [], researchFiles: [],
  } as unknown as BookStructure;
}

function seed(extra: Record<string, string> = {}) {
  mocks.store = new MemoryBookStore({
    "outline/book.md": serializeOutlineBook({ body: "Mira finds the lie under the harbor.", origin: "author" }),
    "outline/chapters/001.md": serializeOutlineChapter({ number: 1, title: "Arrival", body: "Mira arrives at the glass harbor.", origin: "author" }),
    "outline/chapters/002.md": serializeOutlineChapter({ number: 2, title: "The key", body: "", origin: "author" }),
    "outline/chapters/003.md": serializeOutlineChapter({ number: 3, title: "The vault", body: "Mira opens the vault.", ghostwriter: "ghost-x", origin: "author" }),
    "chapters/001-arrival/chapter.md": "---\ntype: chapter\ntitle: Arrival\nsummary: Mira lands at the quay and meets the harbormaster.\n---\n",
    "chapters/001-arrival/001-quay.md": "---\ntype: paragraph\n---\n\nThe quay shone.\n",
    "characters/mira.md": "---\ntype: character\nname: Mira\n---\n\nA glassblower's daughter.\n",
    "secrets/the-lie.md": "---\ntype: secret\n---\n\nThe harbor is built on the drowned.\n",
    "autopilot/state.json": JSON.stringify(STATE),
    ...extra,
  });
}

async function env(settings: AppSettings = DEFAULT_SETTINGS): Promise<BrainstormToolEnv> {
  return { context: await loadBrainstormContext({ book: BOOK, branch: "main", structure: structure() }), settings, italian: false, now: () => new Date(2026, 10, 25, 10, 42) };
}

beforeEach(() => {
  seed();
  mocks.complete.mockReset();
});

describe("Brainstorming's registry", () => {
  it("has exactly its nine tools, none of the Copilot's, and the Copilot's registry has none of them", () => {
    expect(brainstormToolIds()).toEqual(["read_synopsis", "read_synopsis_entry", "read_chapter_summary", "read_canon_entry", "propose_synopsis_edits", "import_synopsis_text", "check_synopsis", "save_brainstorm_notes", "propose_bible_decisions"]);
    expect(brainstormToolIds()).toEqual([...BRAINSTORM_TOOL_IDS]);
    ensureBuiltinCopilotToolsRegistered();
    const copilot = copilotToolRegistry.list().map((tool) => tool.id);
    expect(copilot.length).toBeGreaterThan(20);
    for (const id of brainstormToolIds()) expect(copilotToolRegistry.get(id), id).toBeUndefined();
    for (const id of copilot) expect(brainstormToolIds() as string[]).not.toContain(id);
  });

  it.each([
    "multi-file-edit", "edit-outline", "rewrite-current-paragraph", "create-chapter", "create-paragraph", "write_chapter", "update_paragraph", "write_file",
    "edit_outline", "create-pull-request", "switch-branch", "delete-current-note", "navigate-app", "open-reader", "run-audit", "",
  ])("refuses «%s», which it does not have, and runs nothing", async (tool) => {
    const source = { files: vi.fn(), commit: vi.fn(), readState: vi.fn(), readFiles: vi.fn() };
    const context = { ...(await env()).context, source };
    const outcome = await runBrainstormTool({ tool, args: { number: 1, path: "chapters/001-arrival/001-quay.md", content: "x" } }, { ...(await env()), context });
    expect(outcome).toMatchObject({ kind: "refused", unknown: true, tool });
    for (const call of Object.values(source)) expect(call).not.toHaveBeenCalled();
  });

  it("refuses arguments that are not the tool's, and says what it takes", async () => {
    const outcome = await runBrainstormTool({ tool: "read_synopsis_entry", args: { number: "three", extra: true } }, await env());
    expect(outcome).toMatchObject({ kind: "refused", unknown: false });
    expect(outcome.text).toContain('{"number":N}');
  });
});

describe("Brainstorming's tools", () => {
  it("read the Synopsis, one entry with what the autopilot does if it changes, the summary of a written chapter and an entry of the canon", async () => {
    const tools = await env();
    const synopsis = await runBrainstormTool({ tool: "read_synopsis", args: { query: "vault" } }, tools);
    expect(synopsis.text).toContain("Chapter 3 — The vault");
    expect(synopsis.text).not.toContain("Chapter 1 — Arrival");
    const entry = await runBrainstormTool({ tool: "read_synopsis_entry", args: { number: 1 } }, tools);
    expect(entry.text).toContain("Mira arrives at the glass harbor.");
    expect(entry.text).toContain("approved");
    expect(entry.text).toContain("the autopilot will ask the author whether to rewrite it");
    const summary = await runBrainstormTool({ tool: "read_chapter_summary", args: { number: 1 } }, tools);
    expect(summary.text).toContain("Mira lands at the quay and meets the harbormaster.");
    expect(summary.text, "never the text of the chapter").not.toContain("The quay shone");
    expect((await runBrainstormTool({ tool: "read_chapter_summary", args: { number: 3 } }, tools)).text).toContain("not written yet");
    const canon = await runBrainstormTool({ tool: "read_canon_entry", args: { name: "mira" } }, tools);
    expect(canon.text).toContain("A glassblower's daughter.");
  });

  it("never reads a secret, nor a file outside the canon index", async () => {
    const tools = await env();
    for (const name of ["The lie", "secrets/the-lie.md", "chapters/001-arrival/001-quay.md"]) {
      const outcome = await runBrainstormTool({ tool: "read_canon_entry", args: { name } }, tools);
      expect(outcome.text, name).toContain("has no entry named");
      expect(outcome.text).not.toContain("drowned");
      expect(outcome.text).not.toContain("The quay shone");
    }
    expect(tools.context.canon.map((entry) => entry.section)).not.toContain("secrets");
  });

  it("propose a series of edits as the engine composes it, to apply where the Synopsis page saves, and write nothing", async () => {
    const tools = await env();
    const before = await (mocks.store as MemoryBookStore).list();
    const outcome = await runBrainstormTool({ tool: "propose_synopsis_edits", args: { summary: "The vault first.", edits: [{ kind: "move", from: 3, to: 2 }, { kind: "append", title: "The flood", body: "The harbor floods." }] } }, tools);
    expect(outcome.kind).toBe("proposal");
    if (outcome.kind !== "proposal") return;
    const action = outcome.message.action;
    expect(action).toMatchObject({ kind: "apply-file-updates", toolId: "edit-outline", bookId: "book", branch: "main" });
    if (action?.kind !== "apply-file-updates") return;
    expect(action.updates.map((update) => update.path)).toEqual(["outline/chapters/002.md", "outline/chapters/003.md", "outline/chapters/004.md"]);
    expect(action.updates[0].content).toContain("The vault");
    expect(action.updates[2].content).toContain("The flood");
    expect(outcome.message.text).toContain("The vault first.");
    expect(outcome.message.text).toContain("In the synopsis, chapter 3 «The vault» becomes chapter 2.");
    expect(await (mocks.store as MemoryBookStore).list(), "nothing is written").toEqual(before);
  });

  it("read the design of an entry, and propose a design field by field: the fields it does not give stay, and the check of the Synopsis says what a design lacks", async () => {
    seed({ "outline/chapters/003.md": serializeOutlineChapter({ number: 3, title: "The vault", body: "Mira opens the vault.", origin: "author", design: { goal: "Open the vault", ending: "The door slams.", pov: ["Mira"] } }) });
    const tools = await env();
    const entry = await runBrainstormTool({ tool: "read_synopsis_entry", args: { number: 3 } }, tools);
    expect(entry.text).toContain("Design:\nNarrative goal: Open the vault\nPoint of view: Mira\nEnding: The door slams.");
    const outcome = await runBrainstormTool({ tool: "propose_synopsis_edits", args: { summary: "A clue in the vault.", edits: [{ kind: "update", number: 3, design: { clues: ["A wet footprint"], events: "Mira picks the lock\nThe vault is empty", ending: null } }] } }, tools);
    expect(outcome.kind).toBe("proposal");
    if (outcome.kind !== "proposal" || outcome.message.action?.kind !== "apply-file-updates") return;
    const { entry: proposed } = await readOutlineChapter("outline/chapters/003.md", 3, outcome.message.action.updates[0].content);
    expect(proposed.design).toEqual({ goal: "Open the vault", pov: ["Mira"], events: ["Mira picks the lock", "The vault is empty"], clues: ["A wet footprint"] });
    expect(outcome.message.text).toContain("In the synopsis, chapter 3 «The vault» changes: design.");
    const findings = (await synopsisFindings(tools.context)).map((finding) => finding.en);
    expect(findings).toContain("The design of chapter 3 does not say: main events.");
  });

  it("propose nothing while the author keeps «Edit the Synopsis» off, and say so", async () => {
    const settings = { ...DEFAULT_SETTINGS, copilotTools: { ...DEFAULT_SETTINGS.copilotTools, toolOverrides: { ...DEFAULT_SETTINGS.copilotTools?.toolOverrides, "edit-outline": { enabled: false } } } } as AppSettings;
    const outcome = await runBrainstormTool({ tool: "propose_synopsis_edits", args: { edits: [{ kind: "remove", number: 3 }] } }, await env(settings));
    expect(outcome).toMatchObject({ kind: "refused", unknown: false });
    expect(outcome.text).toContain("turned off");
  });

  it("check the whole Synopsis: what the engine finds odd, the entries without text, a ghostwriter the book has not, a written chapter changed since the plan", async () => {
    const findings = await synopsisFindings((await env()).context);
    const text = findings.map((finding) => finding.en).join("\n");
    expect(text).toContain("Chapter 2 has no text");
    expect(text).toContain("«ghost-x»");
    expect(text).toContain("Chapter 1 is written and closed, and its entry changed since");
    const outcome = await runBrainstormTool({ tool: "check_synopsis", args: {} }, await env());
    expect(outcome).toMatchObject({ kind: "data", tool: "check_synopsis" });
    if (outcome.kind === "data") expect(outcome.note).toContain("Coherence check of the Synopsis");
  });

  it("propose to append the decisions to the notes of Brainstorming, a file of the outline that is never an entry", async () => {
    seed({ "outline/brainstorm.md": "# Brainstorming\n\n## 2026-11-20 09:00\n\n- Earlier.\n" });
    const tools = await env();
    expect(tools.context.synopsis.outline.warnings.map((warning) => warning.path)).not.toContain("outline/brainstorm.md");
    const outcome = await runBrainstormTool({ tool: "save_brainstorm_notes", args: { title: "The vault first", notes: "- Chapter 3 comes before the key." } }, tools);
    expect(outcome.kind).toBe("proposal");
    if (outcome.kind !== "proposal" || outcome.message.action?.kind !== "apply-file-updates") return;
    const [update] = outcome.message.action.updates;
    expect(update.path).toBe("outline/brainstorm.md");
    expect(update.content).toBe("# Brainstorming\n\n## 2026-11-20 09:00\n\n- Earlier.\n\n## 2026-11-25 10:42 · The vault first\n\n- Chapter 3 comes before the key.\n");
    expect(outcome.message.action.sourceRevisions["outline/brainstorm.md"]).toBe(tools.context.synopsis.files.get("outline/brainstorm.md")!.hash);
    expect(appendBrainstormNotes("", { title: "", notes: "- One.", at: new Date(2026, 0, 2, 3, 4) })).toBe("# Brainstorming\n\n## 2026-01-02 03:04\n\n- One.\n");
  });
});

describe("Brainstorming's instructions", () => {
  it("follow the language of the book, else the app's", () => {
    expect(brainstormLanguage("it", "en")).toBe("it");
    expect(brainstormLanguage("it-IT", "en")).toBe("it");
    expect(brainstormLanguage("Italiano", "en")).toBe("it");
    expect(brainstormLanguage("en", "it")).toBe("en");
    expect(brainstormLanguage("fr", "it")).toBe("en");
    expect(brainstormLanguage("", "it")).toBe("it");
    expect(brainstormLanguage("", "en")).toBe("en");
    expect(brainstormSystemPrompt("it")).toMatch(/^Sei Brainstorming/);
    expect(brainstormSystemPrompt("en")).toMatch(/^You are Brainstorming/);
    for (const word of ["premessa", "archi", "ritmo", "posta in gioco", "struttura"]) expect(brainstormSystemPrompt("it")).toContain(word);
    for (const word of ["premise", "arcs", "pacing", "stakes", "structure"]) expect(brainstormSystemPrompt("en")).toContain(word);
  });

  it("list exactly its tools, in both languages", () => {
    for (const language of ["en", "it"] as const) {
      const listed = [...brainstormSystemPrompt(language).matchAll(/^- ([a-z_]+) [{]/gm)].map((match) => match[1]);
      expect(listed).toEqual(brainstormToolIds());
    }
  });
});

describe("Brainstorming's turn", () => {
  const settings = { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language: "en" as const } };
  const ask = (prompt: string) => runBrainstormPrompt({ prompt, settings, book: BOOK, branch: "main", structure: structure(), history: [], accountScope: "workspace:test" });

  it("reads what the model asks for, refuses what it does not have, and ends with the proposal for the author", async () => {
    mocks.complete
      .mockResolvedValueOnce(JSON.stringify({ reply: "Let me read chapter 3.", calls: [{ tool: "read_synopsis_entry", args: { number: 3 } }, { tool: "multi-file-edit", args: { updates: [] } }] }))
      .mockResolvedValueOnce("```json\n" + JSON.stringify({ reply: "Open with the vault: the key then answers a question.", calls: [{ tool: "propose_synopsis_edits", args: { summary: "The vault first.", edits: [{ kind: "move", from: 3, to: 2 }] } }] }) + "\n```");
    const message = await ask("Move the vault earlier");
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    for (const call of mocks.complete.mock.calls) {
      expect(call[2], "Brainstorming's own task of the AI router").toBe("brainstorming");
      expect(call[2]).toBe(BRAINSTORMING_CAPABILITY);
      expect(call[3]).toMatchObject({ label: "brainstorming", accountScope: "workspace:test" });
    }
    const second = mocks.complete.mock.calls[1][1].map((entry: { content: string | Array<{ text?: string }> }) => (typeof entry.content === "string" ? entry.content : entry.content.map((part) => part.text ?? "").join(""))).join("\n");
    expect(second).toContain("TOOL RESULTS");
    expect(second).toContain("Mira opens the vault.");
    expect(second).toContain("multi-file-edit (refused)");
    expect(message.text).toContain("Open with the vault");
    expect(message.text).toContain("«multi-file-edit»");
    expect(message.action).toMatchObject({ kind: "apply-file-updates", toolId: "edit-outline" });
  });

  it("answers in plain words a model that does not write JSON, and calls nothing", async () => {
    mocks.complete.mockResolvedValueOnce("Raise the stakes in the middle: the harbor could crack.");
    const message = await ask("What is missing?");
    expect(message.text).toBe("Raise the stakes in the middle: the harbor could crack.");
    expect(message.action).toBeUndefined();
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it("stops after its last round, which is told to answer with no calls", async () => {
    mocks.complete.mockResolvedValue(JSON.stringify({ reply: "Still reading.", calls: [{ tool: "read_synopsis", args: {} }] }));
    const message = await ask("Read everything");
    expect(mocks.complete).toHaveBeenCalledTimes(MAX_BRAINSTORM_ROUNDS);
    expect(mocks.complete.mock.calls[mocks.complete.mock.calls.length - 1][1][0].content).toContain("This is your last turn");
    expect(message.text).toContain("Still reading.");
  });

  it("parses the model's answer wherever it put its JSON", () => {
    expect(parseBrainstormTurn('Sure! {"reply":"Hi","calls":[]} Bye')).toEqual({ reply: "Hi", calls: [] });
    expect(parseBrainstormTurn('{"calls":[{"tool":"check_synopsis"}]}')).toEqual({ reply: "", calls: [{ tool: "check_synopsis", args: {} }] });
    expect(parseBrainstormTurn("not json at all")).toEqual({ reply: "not json at all", calls: [] });
  });
});
