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


import { BIBLE_DECISIONS_FILE, captureDecision, parseMarkdown, readBibleDecisions, setDecisionStatus } from "narrarium-engine";
import { brainstormContextText } from "@/assistant/brainstorm/context";

// What Brainstorming does with the decisions of a book: it reads the locked ones (they are in its data and its instructions), it flags a proposal of the Synopsis that goes
// against one, and its tool «capture this decision» proposes the file of the log with the decisions open and the questions added: only the author locks.

const NOW = new Date("2026-11-28T08:00:00.000Z");
const locked = () => setDecisionStatus((captureDecision(null, { decision: "The vault is never opened before chapter 5.", reason: "The reveal depends on it.", chapters: [3], avoid: ["the vault is empty"] }, NOW) as { content: string }).content, "d-001", "locked")!;

beforeEach(() => {
  mocks.complete.mockReset();
});

describe("Brainstorming and the locked decisions of the book", () => {
  it("is told the locked decisions and the open questions in its data, and its instructions say they bind it and how to capture a decision", async () => {
    seed({ [BIBLE_DECISIONS_FILE]: locked().replace("\n---\n", "\nquestions:\n  - { id: q-001, question: Who sent the letter? }\n---\n") });
    const text = brainstormContextText((await env()).context);
    expect(text).toMatch(/LOCKED DECISIONS[\s\S]*d-001: The vault is never opened before chapter 5\. \(why: The reveal depends on it\.\) \[chapters 3\]/);
    expect(text).toMatch(/OPEN QUESTIONS[\s\S]*q-001: Who sent the letter\?/);
    const prompt = brainstormSystemPrompt("en");
    expect(prompt).toMatch(/LOCKED DECISIONS in the data are the author's and bind you/);
    expect(prompt).toMatch(/propose_bible_decisions/);
    seed();
    expect(brainstormContextText((await env()).context)).not.toMatch(/LOCKED DECISIONS|OPEN QUESTIONS/);
  });

  it("flags a proposal that touches what a locked decision covers, for the model and for the author, and proposes it all the same: the author is asked before it is applied", async () => {
    seed({ [BIBLE_DECISIONS_FILE]: locked() });
    const outcome = await runBrainstormTool({ tool: "propose_synopsis_edits", args: { edits: [{ kind: "update", number: 3, body: "Mira breaks the vault open at once." }] } }, await env());
    expect(outcome.kind).toBe("proposal");
    expect(outcome.text).toMatch(/WARNING: it goes against a locked decision[\s\S]*entry of chapter 3[\s\S]*d-001/);
    expect((outcome as { message: { text: string } }).message.text).toMatch(/You will be asked before it is applied\./);
    const clean = await runBrainstormTool({ tool: "propose_synopsis_edits", args: { edits: [{ kind: "update", number: 2, body: "The key is under the pier." }] } }, await env());
    expect(clean.kind).toBe("proposal");
    expect(clean.text).not.toMatch(/WARNING/);
    const italian = await runBrainstormTool({ tool: "propose_synopsis_edits", args: { edits: [{ kind: "update", number: 3, body: "Mira apre la volta." }] } }, { ...(await env()), italian: true });
    expect((italian as { message: { text: string } }).message.text).toMatch(/voce del capitolo 3[\s\S]*Prima di applicarla ti verrà chiesto\./);
  });

  it("captures what the author settled: a proposal of bible/decisions.md with the decisions OPEN and the questions added at the end of the log, nothing written, and no lock", async () => {
    seed({ [BIBLE_DECISIONS_FILE]: locked() });
    const outcome = await runBrainstormTool({ tool: "propose_bible_decisions", args: { decisions: [{ decision: "Mira is the narrator.", reason: "Chosen with the author.", chapters: [1, 2], avoid: ["Orrin narrates"] }], questions: [{ question: "Who sent the letter?", chapters: [5] }] } }, await env());
    expect(outcome.kind).toBe("proposal");
    const action = (outcome as { message: { action: { updates: Array<{ path: string; content: string }>; sourceRevisions: Record<string, string | null> } } }).message.action;
    expect(action.updates.map((update) => update.path)).toEqual([BIBLE_DECISIONS_FILE]);
    expect(action.sourceRevisions[BIBLE_DECISIONS_FILE]).toMatch(/^[0-9a-f]{64}$/);
    const log = readBibleDecisions(action.updates[0].content).value;
    expect(log.decisions.map((decision) => [decision.id, decision.status, decision.by])).toEqual([["d-001", "locked", "author"], ["d-002", "open", "brainstorming"]]);
    expect(log.decisions[1].chapters).toEqual([1, 2]);
    expect(log.questions.map((question) => [question.id, question.status, question.by, question.chapters])).toEqual([["q-001", "open", "brainstorming", [5]]]);
    expect(parseMarkdown(action.updates[0].content).frontmatter.type).toBe("bible");
    expect((mocks.store as MemoryBookStore).files.get(BIBLE_DECISIONS_FILE), "nothing is written").toBe(locked());
  });

  it("captures into a book that has no log yet, and refuses a call with nothing in it or when the author turned the edits of the Synopsis off", async () => {
    seed();
    const first = await runBrainstormTool({ tool: "propose_bible_decisions", args: { decisions: [{ decision: "The sea is never named." }] } }, await env());
    expect(first.kind).toBe("proposal");
    expect(((first as { message: { action: { sourceRevisions: Record<string, string | null> } } }).message.action.sourceRevisions)[BIBLE_DECISIONS_FILE]).toBeNull();
    const empty = await runBrainstormTool({ tool: "propose_bible_decisions", args: {} }, await env());
    expect(empty.kind).toBe("refused");
    expect(empty.text).toMatch(/Nothing to capture/);
    const settings = { ...DEFAULT_SETTINGS, copilotTools: { ...DEFAULT_SETTINGS.copilotTools, toolOverrides: { ...DEFAULT_SETTINGS.copilotTools?.toolOverrides, "edit-outline": { enabled: false } } } } as AppSettings;
    const refused = await runBrainstormTool({ tool: "propose_bible_decisions", args: { decisions: [{ decision: "x" }] } }, await env(settings));
    expect(refused.text).toContain("turned off");
  });
});
