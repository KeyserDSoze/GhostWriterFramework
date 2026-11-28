import { describe, expect, it } from "vitest";
import { OUTLINE_BOOK_FILE, createAutopilotState, parseMarkdown, serializeBibleThemes, serializeOutlineBook, type AutopilotState } from "narrarium-engine";
import { approveDesignChange, defaultDesignChapters, designApprovalOf, designBlockOf, designDraftOf, designModeBlockOf, designOfDraft, designPatchOf, designStatusOf, filledDesignFields, initialDesignMode, readDesignForm, sameDesign, type DesignForm } from "@/outline/designModel";
import { completionViewOf, defaultChosen, proposalsDecision, proposedLines, waitingOf } from "@/outline/completionModel";
import { composeBible, worldEntries } from "@/outline/bibleModel";

const at = new Date("2026-11-26T10:00:00.000Z");

function stateWith(patch: Partial<AutopilotState>): AutopilotState {
  return { ...createAutopilotState(at), ...patch };
}

describe("the design of an entry, as its card edits it", () => {
  it("keeps the lists as lines, sends every field (null for the empty ones), and tells a draft that says the same from one that does not", () => {
    const design = { goal: "Learn the truth", pov: ["Mira", "Orrin"], cliffhanger: true };
    const draft = designDraftOf(design);
    expect(draft).toEqual({ goal: "Learn the truth", pov: "Mira\nOrrin", cliffhanger: true });
    expect(sameDesign(draft, design)).toBe(true);
    expect(sameDesign({ ...draft, pov: "Mira\nOrrin\n\n" }, design)).toBe(true);
    expect(sameDesign({ ...draft, ending: "A door closes." }, design)).toBe(false);
    expect(sameDesign(undefined, design)).toBe(true);
    const patch = designPatchOf({ ...draft, events: "- One\n- Two", cliffhanger: false });
    expect(patch.events).toEqual(["One", "Two"]);
    expect(patch.cliffhanger).toBeNull();
    expect(patch.notes).toBeNull();
    expect(designOfDraft({ goal: "  x  ", scenes: "a\n\nb" })).toEqual({ goal: "x", scenes: ["a", "b"] });
    expect(filledDesignFields(design)).toBe(3);
    expect(filledDesignFields(undefined)).toBe(0);
  });
});

describe("the design run as the Studio reads it", () => {
  it("is none, active, ready or ended by the author, with its reviews and its policy", () => {
    expect(designStatusOf(null)).toEqual({ kind: "none" });
    const rounds = [{ round: 1, score: 7, verdict: "revise" as const, critical: 1, findings: 2, at: at.toISOString() }];
    expect(designStatusOf(stateWith({ design: { startedAt: at.toISOString(), chapters: 8, rounds, review: { maxRounds: 4, targetScore: 8.5 } } }))).toEqual({ kind: "active", startedAt: at.toISOString(), chapters: 8, rounds, maxRounds: 4, target: 8.5, mode: "plan" });
    expect(designStatusOf(stateWith({ design: { startedAt: at.toISOString(), chapters: 8, rounds, mode: "complete", completion: { chapters: [1], entries: {}, canon: [], readings: [] } } }))).toMatchObject({ kind: "active", mode: "complete" });
    const ready = designStatusOf(stateWith({ design: { startedAt: at.toISOString(), chapters: 8, rounds, endedAt: at.toISOString(), outcome: "plateau" } }));
    expect(ready).toMatchObject({ kind: "ready", outcome: "plateau", maxRounds: 3 });
    expect(designStatusOf(stateWith({ design: { startedAt: at.toISOString(), chapters: 8, rounds: [], endedAt: at.toISOString(), outcome: "author" } })).kind).toBe("ended");
  });

  it("cannot begin without a description, once the autopilot wrote a chapter, or on a personal server that does not design", () => {
    expect(designBlockOf({ description: " ", state: null })).toBe("description");
    const written = stateWith({ plan: { chapters: [{ number: 1, title: "One", slug: "001-one", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "writing", scenes: [{ number: 1, title: "S", goal: "", beats: [], characters: [], status: "written", revisions: 0 }] }], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false } });
    expect(designBlockOf({ description: "An idea.", state: written })).toBe("written");
    expect(designBlockOf({ description: "An idea.", state: null, serverWithoutDesign: true })).toBe("server");
    expect(designBlockOf({ description: "An idea.", state: null })).toBeNull();
    expect(designBlockOf({ description: "", state: null, authorChapters: 3 }), "the chapters of the author are enough to review and complete").toBeNull();
  });

  it("says which mode can run: Design the book needs the description, Review and complete the author's chapters and a server that knows it, and the one offered first is the one that fits", () => {
    const all = { mode: "complete" as const, reason: "written" as const, chapters: 3, written: [1, 2, 3], missing: [] };
    const some = { mode: "plan" as const, reason: "missing" as const, chapters: 3, written: [1], missing: [2, 3] };
    expect(designModeBlockOf("plan", { description: "", choice: all })).toBe("description");
    expect(designModeBlockOf("plan", { description: "An idea.", choice: all })).toBeNull();
    expect(designModeBlockOf("complete", { description: "", choice: { ...some, written: [] } })).toBe("chapters");
    expect(designModeBlockOf("complete", { description: "", choice: all, serverWithoutComplete: true })).toBe("server");
    expect(designModeBlockOf("complete", { description: "", choice: all })).toBeNull();
    expect(initialDesignMode(all, { description: "An idea." })).toBe("complete");
    expect(initialDesignMode(all, { description: "An idea.", serverWithoutComplete: true }), "the other, when the one that fits cannot run").toBe("plan");
    expect(initialDesignMode(some, { description: "An idea." })).toBe("plan");
    expect(initialDesignMode(some, { description: "" }), "without a description the author's chapters can still be reviewed").toBe("complete");
  });

  it("reads the dialog's form: the chapters from the entries the Synopsis has, the policy of the design, and the money cap", () => {
    const form: DesignForm = { chapters: "10", readers: true, target: "8,5", rounds: "4", readerRounds: "", campaignRounds: "", money: "2", tokens: "" };
    const reading = readDesignForm(form, 6);
    expect(reading.valid).toBe(true);
    expect(reading.input).toEqual({ chapters: 10, review: { targetScore: 8.5, maxRounds: 4 } });
    expect(reading.budgetLimit).toBe(2);
    expect(readDesignForm({ ...form, chapters: "4" }, 6).chaptersProblem).toBe("range");
    expect(readDesignForm({ ...form, chapters: "ten" }, 6).chaptersProblem).toBe("number");
    expect(readDesignForm({ ...form, target: "", rounds: "" }, 0).input.review).toBeNull();
    expect(defaultDesignChapters(0)).toBe(12);
    expect(defaultDesignChapters(7)).toBe(7);
    const complete = readDesignForm({ ...form, mode: "complete", chapters: "" }, 6);
    expect(complete.valid).toBe(true);
    expect(complete.chaptersProblem).toBeNull();
    expect(complete.input).toEqual({ mode: "complete", review: { targetScore: 8.5, maxRounds: 4 } });
  });
});

describe("the proposals of Review and complete as the Studio reads them", () => {
  const run = at.toISOString();
  const entry = (number: number, patch: Record<string, unknown> = {}) => ({ number, path: `outline/chapters/00${number}.md`, title: `T${number}`, body: "Text", origin: "author" as const, contentDigest: "aaaaaaaaaaaaaaaa", intact: false, frontmatter: {}, ...patch });
  const state = () => stateWith({
    design: {
      startedAt: run, chapters: 3, rounds: [{ round: 1, score: 8, verdict: "approve", critical: 0, findings: 0, at: run }], endedAt: run, outcome: "target", mode: "complete",
      completion: {
        chapters: [1, 2, 3],
        entries: {
          1: { number: 1, title: "T1", digest: "aaaaaaaaaaaaaaaa", fields: [{ id: "f1-goal", key: "goal", value: "A goal.\nSecond line.", status: "waiting" }], findings: [{ id: "x1", source: "reader", severity: "minor", text: "Slow.", status: "waiting" }, { id: "x2", source: "director", severity: "major", text: "Weak.", status: "skipped" }] },
          2: { number: 2, title: "T2", digest: "bbbbbbbbbbbbbbbb", fields: [{ id: "f2-cliffhanger", key: "cliffhanger", value: false, status: "waiting" }], findings: [] },
          3: { number: 3, title: "T3", digest: "aaaaaaaaaaaaaaaa", fields: [], findings: [] },
        },
        canon: [{ id: "c-item-the-key", kind: "item", name: "The Key", description: "Opens the vault.", chapters: [2], status: "waiting" }],
        readings: [],
      },
    },
  });

  it("lists the chapters with a proposal, says which changed or are no longer the author's, and what waits", () => {
    const view = completionViewOf(state(), [entry(1), entry(2), entry(3)])!;
    expect(view.run).toBe(run);
    expect(view.active).toBe(false);
    expect(view.chapters.map((chapter) => [chapter.number, chapter.changed, chapter.gone])).toEqual([[1, false, false], [2, true, false]]);
    expect(view.waiting).toEqual(["f1-goal", "x1", "f2-cliffhanger", "c-item-the-key"]);
    expect(view.last?.score).toBe(8);
    expect(completionViewOf(state(), [entry(1, { intact: true }), entry(2)])!.chapters[0].gone).toBe(true);
    expect(completionViewOf(stateWith({}), [])).toBeNull();
  });

  it("chooses everything but the minor findings at first, and decides only for what waits", () => {
    const view = completionViewOf(state(), [entry(1), entry(2), entry(3)])!;
    const chosen = defaultChosen(view);
    expect([...chosen].sort()).toEqual(["c-item-the-key", "f1-goal", "f2-cliffhanger"]);
    expect(proposalsDecision(view, new Set([...chosen, "x2", "unknown"]))).toEqual({ run, apply: ["f1-goal", "f2-cliffhanger", "c-item-the-key"] });
    expect(waitingOf(view.chapters[0])).toEqual(["f1-goal", "x1"]);
    expect(proposedLines("A goal.\nSecond line.")).toEqual(["A goal.", "Second line."]);
    expect(proposedLines(["a", "b"])).toEqual(["a", "b"]);
    expect(proposedLines(false)).toEqual(["false"]);
    const decided = state();
    decided.design!.completion!.decided = { at: run, applied: 1, skipped: 2 };
    expect(completionViewOf(decided, [entry(1), entry(2)])!.waiting).toEqual([]);
  });
});

describe("the author's approval of a design", () => {
  it("is kept in outline/book.md beside the description, names the run it approves, and leaves the rest of the file as it was", () => {
    const file = serializeOutlineBook({ title: "Glass", body: "A harbor town built on glass.", origin: "author", frontmatter: { mood: "grey" } });
    const change = approveDesignChange({ content: file, hash: "h1" }, "2026-11-26T09:00:00.000Z", at);
    expect(change).toMatchObject({ path: OUTLINE_BOOK_FILE, expectedHash: "h1" });
    const document = parseMarkdown(change.content!);
    expect(document.body).toBe("A harbor town built on glass.");
    expect(document.frontmatter.mood).toBe("grey");
    expect(designApprovalOf(change.content!)).toEqual({ at: at.toISOString(), run: "2026-11-26T09:00:00.000Z" });
    expect(designApprovalOf(file)).toBeNull();
    const created = approveDesignChange(undefined, "run", at);
    expect(created.expectedHash).toBeNull();
    expect(designApprovalOf(created.content!)?.run).toBe("run");
    expect(() => approveDesignChange({ content: "---\ntitle: [broken\n---\n", hash: "h" }, "run", at)).toThrow();
  });
});

describe("the Bible composed from the book's files", () => {
  const files = [
    { path: "characters/mira-vale.md", content: "---\ntype: character\nname: Mira Vale\nstory_role: protagonist\narc: From silence to voice\ndesires:\n  - The truth\n---\n\n# Mira Vale\n\nA stubborn young glassmaker.", hash: "c1" },
    { path: "characters/orrin-hale.md", content: "---\ntype: character\nname: Orrin Hale\n---\n\n# Orrin Hale\n\nThe harbor master.", hash: "c2" },
    { path: "locations/glass-harbor.md", content: "---\ntype: location\nname: Glass Harbor\natmosphere: Cold light\n---\n\n# Glass Harbor\n\nA town of workshops.", hash: "l1" },
    { path: "items/the-ledger.md", content: "---\ntype: item\nname: The Ledger\nsignificance: It proves the lie\n---\n", hash: "i1" },
    { path: "secrets/the-wall.md", content: "---\ntype: secret\ntitle: The Wall Is Failing\nholders:\n  - character:orrin-hale\nclues:\n  - chapter: 1\n    note: Salt in the cellar\nlearned_by:\n  - character: character:mira-vale\n    chapter: 3\n---\n\n# The Wall Is Failing\n\nThe sea wall cracked years ago.", hash: "s1" },
    { path: "secrets/the-letter.md", content: "---\ntype: secret\ntitle: The Letter\n---\n\nNobody read it.", hash: "s2" },
    { path: "bible/themes.md", content: serializeBibleThemes({ themes: ["truth"], tone: "Tense" }), hash: "b1" },
    { path: "story-design.md", content: "---\ntype: note\n---\n\n# Story Design\n\nThree movements.", hash: "" },
  ];
  const entries = [
    { number: 1, path: "outline/chapters/001.md", title: "One", body: "", origin: "autopilot" as const, contentDigest: "", intact: true, frontmatter: {}, design: { goal: "g", pov: ["Mira"], events: ["e"], ending: "x", characters: ["Tobias"] } },
    { number: 2, path: "outline/chapters/002.md", title: "Two", body: "", origin: "autopilot" as const, contentDigest: "", intact: true, frontmatter: {}, design: { goal: "g", reveals: ["The Wall Is Failing"], pov: ["Mira"] } },
  ];
  const state = stateWith({ concept: { done: true, generated: true, secrets: [{ slug: "the-wall", title: "The Wall Is Failing", revealChapter: 2 }] } });

  it("reads the cast, the world, the secrets with their ledger and the reveal the plan gives them, and the findings of the checks", () => {
    const data = composeBible({ files, entries, state });
    expect(data.canon.characters.map((entry) => entry.name)).toEqual(["Mira Vale", "Orrin Hale"]);
    expect(data.canon.characters[0].facts).toEqual([{ key: "story_role", value: "protagonist" }, { key: "arc", value: "From silence to voice" }, { key: "desires", value: "The truth" }]);
    expect(data.canon.characters[0].summary).toBe("A stubborn young glassmaker.");
    expect(worldEntries(data)).toBe(2);
    expect(data.themes).toEqual({ themes: ["truth"], tone: "Tense", audience: "", notes: "" });
    expect(data.storyDesign).toContain("Three movements.");
    expect(data.secrets.map((secret) => [secret.slug, secret.revealChapter, secret.planned])).toEqual([["the-wall", 2, true], ["the-letter", undefined, false]]);
    expect(data.secrets[0].ledger.clues).toEqual([{ chapter: 1, note: "Salt in the cellar" }]);
    const codes = data.findings.map((finding) => `${finding.code}:${finding.chapter ?? finding.secret?.slug}`);
    expect(codes).toEqual(expect.arrayContaining(["reveal-missing:the-letter", "knowledge-before-learning:2", "unknown-character:1", "design-incomplete:2"]));
  });
});
